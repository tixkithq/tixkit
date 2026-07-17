import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  OrganizationRepository,
  PaymentAccountCleanupCommandRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0) {
  it.skip('provider account cleanup commands (PostgreSQL/MySQL URLs are not configured)', () => {});
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe.sequential.each(driverCases)(
  'provider account cleanup commands: $driver',
  ({ driver, url }) => {
    let db: Database;
    let previousDriver: string | undefined;
    let tenantId: string;
    let organizationId: string;

    beforeAll(async () => {
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await truncateAllData(db);
      const tenant = await new TenantRepository(db).create({ name: `Cleanup ${driver}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Cleanup ${driver}`,
        slug: `provider-cleanup-${driver}`,
      });
      tenantId = tenant.id;
      organizationId = organization.id;
    }, 60_000);

    afterAll(async () => {
      await db?.destroy();
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
    });

    function enqueueInput(providerAccountId: string) {
      const idempotencyKey = `stripe-connect-cleanup:${tenantId}:${organizationId}:${providerAccountId}`;
      return {
        tenantId,
        organizationId,
        provider: 'stripe_connect',
        providerAccountId,
        idempotencyKey,
        reason: 'concurrent_refresh_loser',
        now: new Date('2026-07-17T12:00:00.000Z'),
      };
    }

    it('idempotently enqueues one hash-bound command without persisting the raw key', async () => {
      const repository = new PaymentAccountCleanupCommandRepository(db);
      const input = enqueueInput('acct_loser_1');
      const first = await repository.enqueue(input);
      const replay = await repository.enqueue(input);

      expect(replay.id).toBe(first.id);
      expect(first.status).toBe('pending');
      expect(first.idempotency_key_sha256).toBe(digest(input.idempotencyKey));
      expect(JSON.stringify(first)).not.toContain(input.idempotencyKey);
      expect(first.provider_account_identity_sha256).toMatch(/^[0-9a-f]{64}$/u);
      await expect(repository.enqueue({ ...input, reason: 'different_reason' })).rejects.toThrow(
        'PROVIDER_ACCOUNT_CLEANUP_IDEMPOTENCY_CONFLICT',
      );
    });

    it('allows one concurrent claimant and increments attempts exactly once', async () => {
      const repository = new PaymentAccountCleanupCommandRepository(db);
      const command = await repository.enqueue(enqueueInput('acct_loser_2'));
      const now = new Date('2026-07-17T12:00:01.000Z');
      const claimed = await Promise.all([
        repository.claimNext({
          now,
          leaseToken: 'lease_worker_a_0001',
          leaseExpiresAt: new Date('2026-07-17T12:01:01.000Z'),
        }),
        repository.claimNext({
          now,
          leaseToken: 'lease_worker_b_0001',
          leaseExpiresAt: new Date('2026-07-17T12:01:01.000Z'),
        }),
      ]);
      const winners = claimed.filter((row) => row !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ id: command.id, attempts: 1, status: 'processing' });
      expect(new Set(winners.map((row) => row?.lease_token)).size).toBe(1);
    });

    it('recovers an expired lease and fences stale or wrong tokens', async () => {
      const repository = new PaymentAccountCleanupCommandRepository(db);
      const command = await repository.enqueue(enqueueInput('acct_loser_3'));
      const first = await repository.claimNext({
        now: new Date('2026-07-17T12:00:01.000Z'),
        leaseToken: 'lease_expired_0001',
        leaseExpiresAt: new Date('2026-07-17T12:00:02.000Z'),
      });
      expect(first).toMatchObject({ id: command.id, attempts: 1 });
      const recovered = await repository.claimNext({
        now: new Date('2026-07-17T12:00:03.000Z'),
        leaseToken: 'lease_recovered_001',
        leaseExpiresAt: new Date('2026-07-17T12:01:03.000Z'),
      });
      expect(recovered).toMatchObject({ id: command.id, attempts: 2 });
      expect(
        await repository.markSucceeded({
          id: command.id,
          leaseToken: 'lease_expired_0001',
          now: new Date('2026-07-17T12:00:04.000Z'),
        }),
      ).toBe(false);
      await expect(
        repository.reschedule({
          id: command.id,
          leaseToken: 'lease_recovered_001',
          errorKind: 'provider_unavailable',
          lastError: 'Account acct_sensitive failed with sk_live_not-a-real-secret',
          now: new Date('2026-07-17T12:00:04.000Z'),
          availableAt: new Date('2026-07-17T12:05:00.000Z'),
        }),
      ).rejects.toThrow('PROVIDER_ACCOUNT_CLEANUP_ERROR_MESSAGE_INVALID');
      expect(
        await repository.reschedule({
          id: command.id,
          leaseToken: 'lease_recovered_001',
          errorKind: 'provider_unavailable',
          lastError: 'provider_unavailable:unknown',
          now: new Date('2026-07-17T12:00:04.000Z'),
          availableAt: new Date('2026-07-17T12:05:00.000Z'),
        }),
      ).toBe(true);
      await expect(
        repository.findByProviderAccount({
          tenantId,
          organizationId,
          provider: 'stripe_connect',
          providerAccountId: 'acct_loser_3',
        }),
      ).resolves.toMatchObject({
        status: 'pending',
        attempts: 2,
        lease_token: null,
        last_error_kind: 'provider_unavailable',
        last_error_message: 'provider_unavailable:unknown',
      });
    });

    it('persists fenced success and manual-review terminal states', async () => {
      const repository = new PaymentAccountCleanupCommandRepository(db);
      const succeeded = await repository.enqueue(enqueueInput('acct_loser_4'));
      await repository.claimNext({
        now: new Date('2026-07-17T12:00:01.000Z'),
        leaseToken: 'lease_succeeded_001',
        leaseExpiresAt: new Date('2026-07-17T12:01:01.000Z'),
      });
      expect(
        await repository.markSucceeded({
          id: succeeded.id,
          leaseToken: 'lease_succeeded_001',
          now: new Date('2026-07-17T12:00:02.000Z'),
        }),
      ).toBe(true);

      const manual = await repository.enqueue(enqueueInput('acct_loser_5'));
      await repository.claimNext({
        now: new Date('2026-07-17T12:00:03.000Z'),
        leaseToken: 'lease_manual_review1',
        leaseExpiresAt: new Date('2026-07-17T12:01:03.000Z'),
      });
      expect(
        await repository.markManualReview({
          id: manual.id,
          leaseToken: 'lease_manual_review1',
          errorKind: 'provider_refused',
          lastError: 'provider_refused:rejected',
          now: new Date('2026-07-17T12:00:04.000Z'),
        }),
      ).toBe(true);
      await expect(
        repository.findById({ tenantId, organizationId, id: succeeded.id }),
      ).resolves.toMatchObject({
        status: 'succeeded',
        completed_at: new Date('2026-07-17T12:00:02.000Z'),
        last_error_kind: null,
      });
      await expect(
        repository.findById({ tenantId, organizationId, id: manual.id }),
      ).resolves.toMatchObject({
        status: 'manual_review',
        completed_at: new Date('2026-07-17T12:00:04.000Z'),
        last_error_kind: 'provider_refused',
      });
      await expect(
        repository.claimNext({
          now: new Date('2026-07-17T12:10:00.000Z'),
          leaseToken: 'lease_terminal_none1',
          leaseExpiresAt: new Date('2026-07-17T12:11:00.000Z'),
        }),
      ).resolves.toBeUndefined();
    });
  },
);
