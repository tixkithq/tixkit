import { ulid } from 'ulid';
import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PaymentAccountCleanupCommandRepository } from '@tixkit/db';
import {
  ProviderOperationError,
  StripeSdkGateway,
  type StripeGateway,
} from '@tixkit/provider-clients';
import { errResult, okResult, type WorkflowActivityResult } from '../shared/types.js';
import { paymentProviderTelemetry } from '../observability.js';
import { getActivityDb, getActivityProviderClientRuntime } from './activity-clients.js';

// A maintenance activity has a 60-second start-to-close deadline and each
// contained Stripe call has a 20-second provider deadline. Two sequential
// claims leave bounded time to fence both outcomes in the database.
const CLEANUP_BATCH_LIMIT = 2;
const CLEANUP_LEASE_MS = 45_000;
const CLEANUP_MAX_ATTEMPTS = 5;
const CLEANUP_INITIAL_BACKOFF_MS = 30_000;
const CLEANUP_MAX_BACKOFF_MS = 15 * 60_000;
const CLEANUP_MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const CLEANUP_ACTIVITY_BUDGET_MS = 55_000;
const CLEANUP_PROVIDER_AND_PERSISTENCE_RESERVE_MS = 25_000;

type CleanupCommand = {
  id: string;
  tenant_id: string;
  organization_id: string;
  provider: string;
  provider_account_id: string;
  idempotency_key_sha256: string;
  attempts: number;
};

type CleanupRepository = {
  claimNext(input: {
    now: Date;
    leaseToken: string;
    leaseExpiresAt: Date;
  }): Promise<CleanupCommand | undefined>;
  markSucceeded(input: { id: string; leaseToken: string; now: Date }): Promise<boolean>;
  reschedule(input: {
    id: string;
    leaseToken: string;
    availableAt: Date;
    errorKind: string;
    lastError: string;
    now: Date;
  }): Promise<boolean>;
  markManualReview(input: {
    id: string;
    leaseToken: string;
    errorKind: string;
    lastError: string;
    now: Date;
  }): Promise<boolean>;
};

type CleanupGatewayFactory = (command: CleanupCommand) => StripeGateway | undefined;

type CleanupFailure = {
  errorKind: string;
  lastError: string;
  retryable: boolean;
  retryAfterMs?: number;
};

class CleanupCommandError extends Error {
  constructor(public readonly failure: CleanupFailure) {
    super(failure.lastError);
  }
}

function cleanupFailure(error: unknown): CleanupFailure {
  if (error instanceof CleanupCommandError) return error.failure;
  if (error instanceof ProviderOperationError) {
    return {
      errorKind: error.kind,
      lastError: `${error.kind}:${error.deliveryState}`,
      retryable: error.retryable,
      ...(error.details.retryAfterMs !== undefined &&
      Number.isFinite(error.details.retryAfterMs) &&
      error.details.retryAfterMs >= 0
        ? {
            retryAfterMs: Math.min(
              Math.max(0, error.details.retryAfterMs),
              CLEANUP_MAX_RETRY_AFTER_MS,
            ),
          }
        : {}),
    };
  }
  return { errorKind: 'unknown', lastError: 'unknown:unknown', retryable: true };
}

function cleanupIdempotencyKey(command: CleanupCommand): string {
  const key = `stripe-connect-cleanup:${command.tenant_id}:${command.organization_id}:${command.provider_account_id}`;
  const actual = Buffer.from(createHash('sha256').update(key).digest('hex'), 'utf8');
  const expected = Buffer.from(command.idempotency_key_sha256, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new CleanupCommandError({
      errorKind: 'identity_mismatch',
      lastError: 'identity_mismatch:not_sent',
      retryable: false,
    });
  }
  return key;
}

function retryDelayMs(attempts: number, retryAfterMs = 0): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  const backoff = Math.min(CLEANUP_INITIAL_BACKOFF_MS * 2 ** exponent, CLEANUP_MAX_BACKOFF_MS);
  return Math.max(backoff, retryAfterMs);
}

export async function processProviderAccountCleanupBatch(input: {
  repository: CleanupRepository;
  gatewayFactory: CleanupGatewayFactory;
  now?: () => Date;
  createLeaseToken?: () => string;
  monotonicNowMs?: () => number;
  limit?: number;
}): Promise<{ completed: number; retried: number; manualReview: number }> {
  const now = input.now ?? (() => new Date());
  const createLeaseToken = input.createLeaseToken ?? (() => `pacl_${ulid()}`);
  const monotonicNowMs = input.monotonicNowMs ?? (() => performance.now());
  const batchStartedAt = monotonicNowMs();
  const limit = Math.max(1, Math.min(input.limit ?? CLEANUP_BATCH_LIMIT, CLEANUP_BATCH_LIMIT));
  let completed = 0;
  let retried = 0;
  let manualReview = 0;

  for (let index = 0; index < limit; index += 1) {
    const claimTime = now();
    const leaseToken = createLeaseToken();
    // eslint-disable-next-line no-await-in-loop -- each exclusive claim is completed before another command is leased.
    const command = await input.repository.claimNext({
      now: claimTime,
      leaseToken,
      leaseExpiresAt: new Date(claimTime.getTime() + CLEANUP_LEASE_MS),
    });
    if (!command) break;

    try {
      const elapsedMs = Math.max(0, monotonicNowMs() - batchStartedAt);
      if (elapsedMs + CLEANUP_PROVIDER_AND_PERSISTENCE_RESERVE_MS > CLEANUP_ACTIVITY_BUDGET_MS) {
        throw new CleanupCommandError({
          errorKind: 'batch_budget',
          lastError: 'batch_budget:not_sent',
          retryable: true,
        });
      }
      const gateway = input.gatewayFactory(command);
      if (!gateway) {
        throw new CleanupCommandError({
          errorKind: 'configuration',
          lastError: 'configuration:not_sent',
          retryable: true,
        });
      }
      if (command.provider !== 'stripe_connect') {
        throw new CleanupCommandError({
          errorKind: 'unsupported_provider',
          lastError: 'unsupported_provider:not_sent',
          retryable: false,
        });
      }
      // eslint-disable-next-line no-await-in-loop -- provider cleanup concurrency is intentionally bounded to one per maintenance claim loop.
      await gateway.deleteConnectAccount(
        command.provider_account_id,
        cleanupIdempotencyKey(command),
      );
      // eslint-disable-next-line no-await-in-loop -- provider completion must be durably fenced by the exact lease before the next claim.
      const persisted = await input.repository.markSucceeded({
        id: command.id,
        leaseToken,
        now: now(),
      });
      if (!persisted) throw new Error('Provider cleanup lease was lost after provider completion');
      completed += 1;
    } catch (error) {
      const failure = cleanupFailure(error);
      const completionTime = now();
      if (!failure.retryable || command.attempts >= CLEANUP_MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop -- terminal evidence is fenced before the next cleanup claim.
        const persisted = await input.repository.markManualReview({
          id: command.id,
          leaseToken,
          errorKind: failure.errorKind,
          lastError: failure.lastError,
          now: completionTime,
        });
        if (!persisted) {
          // eslint-disable-next-line preserve-caught-error -- provider errors can contain request IDs or raw diagnostics; only normalized failure evidence may cross Temporal.
          throw new Error('Provider cleanup lease was lost before manual review', {
            cause: new CleanupCommandError(failure),
          });
        }
        manualReview += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop -- retry scheduling is fenced before the next cleanup claim.
        const persisted = await input.repository.reschedule({
          id: command.id,
          leaseToken,
          availableAt: new Date(
            completionTime.getTime() + retryDelayMs(command.attempts, failure.retryAfterMs),
          ),
          errorKind: failure.errorKind,
          lastError: failure.lastError,
          now: completionTime,
        });
        if (!persisted) {
          // eslint-disable-next-line preserve-caught-error -- provider errors can contain request IDs or raw diagnostics; only normalized failure evidence may cross Temporal.
          throw new Error('Provider cleanup lease was lost before retry scheduling', {
            cause: new CleanupCommandError(failure),
          });
        }
        retried += 1;
      }
    }
  }

  return { completed, retried, manualReview };
}

export async function processProviderAccountCleanupActivity(): Promise<
  WorkflowActivityResult<{ completed: number; retried: number; manualReview: number }>
> {
  try {
    const repository = new PaymentAccountCleanupCommandRepository(getActivityDb());
    const stripeSecretKey =
      process.env.TIXKIT_RUNTIME_MODE === 'sandbox' ? undefined : process.env.STRIPE_SECRET_KEY;
    const incidentRuntime = getActivityProviderClientRuntime();
    return okResult(
      await processProviderAccountCleanupBatch({
        repository,
        gatewayFactory(command) {
          if (!stripeSecretKey) return undefined;
          return new StripeSdkGateway(stripeSecretKey, {
            onTelemetry: paymentProviderTelemetry,
            onExactRequestId: incidentRuntime.onExactRequestId,
            incidentScope: {
              tenantId: command.tenant_id,
              organizationId: command.organization_id,
            },
          });
        },
      }),
    );
  } catch {
    return errResult(
      'PROVIDER_ACCOUNT_CLEANUP_FAILED',
      'Provider account cleanup infrastructure failed',
      true,
    );
  }
}
