import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ProviderOperationError, type StripeGateway } from '@tixkit/provider-clients';
import { processProviderAccountCleanupBatch } from '../activities/provider-account-cleanup.js';

const tenantId = 'tnt_cleanup';
const organizationId = 'org_cleanup';
const providerAccountId = 'acct_cleanup';
const idempotencyKey = `stripe-connect-cleanup:${tenantId}:${organizationId}:${providerAccountId}`;

function command(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pacc_1',
    tenant_id: tenantId,
    organization_id: organizationId,
    provider: 'stripe_connect',
    provider_account_id: providerAccountId,
    idempotency_key_sha256: createHash('sha256').update(idempotencyKey).digest('hex'),
    attempts: 1,
    ...overrides,
  };
}

function repository(commands = [command()]) {
  const queue = [...commands];
  return {
    claimNext: vi.fn(async () => queue.shift()),
    markSucceeded: vi.fn(async () => true),
    reschedule: vi.fn(async () => true),
    markManualReview: vi.fn(async () => true),
  };
}

function gateway(deleteConnectAccount = vi.fn(async () => undefined)): StripeGateway {
  return {
    createPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(),
    cancelPaymentIntent: vi.fn(),
    createRefund: vi.fn(),
    createConnectAccount: vi.fn(),
    retrieveConnectAccount: vi.fn(),
    deleteConnectAccount,
    createAccountLink: vi.fn(),
  } as unknown as StripeGateway;
}

describe('provider account cleanup activity', () => {
  it('deletes with the digest-bound stable idempotency key and durably completes the lease', async () => {
    const repo = repository();
    const deleteConnectAccount = vi.fn(async () => undefined);

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => gateway(deleteConnectAccount),
        createLeaseToken: () => 'lease_1',
        now: () => new Date('2026-07-17T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ completed: 1, retried: 0, manualReview: 0 });

    expect(deleteConnectAccount).toHaveBeenCalledWith(providerAccountId, idempotencyKey);
    expect(repo.markSucceeded).toHaveBeenCalledWith({
      id: 'pacc_1',
      leaseToken: 'lease_1',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
  });

  it('reschedules retryable failures using the greater exponential or Retry-After delay', async () => {
    const repo = repository();
    const providerError = new ProviderOperationError(
      'rate limited',
      'stripe',
      'connect-account.delete',
      'rate-limit',
      true,
      'rejected',
      true,
      { retryAfterMs: 90_000 },
    );

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => gateway(vi.fn(async () => Promise.reject(providerError))),
        createLeaseToken: () => 'lease_1',
        now: () => new Date('2026-07-17T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ completed: 0, retried: 1, manualReview: 0 });

    expect(repo.reschedule).toHaveBeenCalledWith({
      id: 'pacc_1',
      leaseToken: 'lease_1',
      availableAt: new Date('2026-07-17T00:01:30.000Z'),
      errorKind: 'rate-limit',
      lastError: 'rate-limit:rejected',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
  });

  it('records terminal manual review for permanent failures and exhausted retries', async () => {
    const permanentRepo = repository();
    const permanent = new ProviderOperationError(
      'invalid account',
      'stripe',
      'connect-account.delete',
      'validation',
      false,
      'rejected',
      true,
    );
    const exhaustedRepo = repository([command({ attempts: 5 })]);
    const retryable = new ProviderOperationError(
      'timeout',
      'stripe',
      'connect-account.delete',
      'timeout',
      true,
      'unknown',
      false,
    );

    await processProviderAccountCleanupBatch({
      repository: permanentRepo,
      gatewayFactory: () => gateway(vi.fn(async () => Promise.reject(permanent))),
      createLeaseToken: () => 'lease_permanent',
    });
    await processProviderAccountCleanupBatch({
      repository: exhaustedRepo,
      gatewayFactory: () => gateway(vi.fn(async () => Promise.reject(retryable))),
      createLeaseToken: () => 'lease_exhausted',
    });

    expect(permanentRepo.markManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: 'validation', lastError: 'validation:rejected' }),
    );
    expect(exhaustedRepo.markManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: 'timeout', lastError: 'timeout:unknown' }),
    );
  });

  it('fails closed before provider execution when the persisted idempotency digest drifts', async () => {
    const repo = repository([command({ idempotency_key_sha256: '0'.repeat(64) })]);
    const deleteConnectAccount = vi.fn(async () => undefined);

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => gateway(deleteConnectAccount),
        createLeaseToken: () => 'lease_1',
      }),
    ).resolves.toEqual({ completed: 0, retried: 0, manualReview: 1 });

    expect(deleteConnectAccount).not.toHaveBeenCalled();
    expect(repo.markManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'identity_mismatch',
        lastError: 'identity_mismatch:not_sent',
      }),
    );
  });

  it('retries missing runtime configuration without exposing command details', async () => {
    const repo = repository();

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => undefined,
        createLeaseToken: () => 'lease_1',
      }),
    ).resolves.toEqual({ completed: 0, retried: 1, manualReview: 0 });

    expect(repo.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: 'configuration',
        lastError: 'configuration:not_sent',
      }),
    );
  });

  it('caps each maintenance tick at two sequential provider deadlines', async () => {
    const repo = repository([
      command({ id: 'pacc_1', provider_account_id: 'acct_cleanup' }),
      command({
        id: 'pacc_2',
        provider_account_id: 'acct_cleanup_2',
        idempotency_key_sha256: createHash('sha256')
          .update(`stripe-connect-cleanup:${tenantId}:${organizationId}:acct_cleanup_2`)
          .digest('hex'),
      }),
      command({
        id: 'pacc_3',
        provider_account_id: 'acct_cleanup_3',
        idempotency_key_sha256: createHash('sha256')
          .update(`stripe-connect-cleanup:${tenantId}:${organizationId}:acct_cleanup_3`)
          .digest('hex'),
      }),
    ]);

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => gateway(),
        limit: 20,
      }),
    ).resolves.toEqual({ completed: 2, retried: 0, manualReview: 0 });

    expect(repo.claimNext).toHaveBeenCalledTimes(2);
    expect(repo.markSucceeded).toHaveBeenCalledTimes(2);
  });

  it('reschedules without network when the remaining monotonic batch budget cannot fit provider and persistence deadlines', async () => {
    const repo = repository([
      command({ id: 'pacc_1' }),
      command({
        id: 'pacc_2',
        provider_account_id: 'acct_cleanup_2',
        idempotency_key_sha256: createHash('sha256')
          .update(`stripe-connect-cleanup:${tenantId}:${organizationId}:acct_cleanup_2`)
          .digest('hex'),
      }),
    ]);
    const deleteConnectAccount = vi.fn(async () => undefined);
    const monotonicTimes = [0, 0, 30_001];

    await expect(
      processProviderAccountCleanupBatch({
        repository: repo,
        gatewayFactory: () => gateway(deleteConnectAccount),
        createLeaseToken: () => 'lease_budget_001',
        monotonicNowMs: () => monotonicTimes.shift() ?? 30_001,
        now: () => new Date('2026-07-17T00:00:00.000Z'),
      }),
    ).resolves.toEqual({ completed: 1, retried: 1, manualReview: 0 });

    expect(deleteConnectAccount).toHaveBeenCalledTimes(1);
    expect(repo.reschedule).toHaveBeenCalledWith({
      id: 'pacc_2',
      leaseToken: 'lease_budget_001',
      availableAt: new Date('2026-07-17T00:00:30.000Z'),
      errorKind: 'batch_budget',
      lastError: 'batch_budget:not_sent',
      now: new Date('2026-07-17T00:00:00.000Z'),
    });
  });
});
