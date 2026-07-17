import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  ImportRepository,
  OrganizationRepository,
  TenantRepository,
  type ImportJobStatus,
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
  it.skip('migration lifecycle command integration (database URLs are not configured)', () => {});
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe.sequential.each(driverCases)(
  'migration lifecycle commands: $driver',
  ({ driver, url }) => {
    let db: Database;
    let previousDriver: string | undefined;
    let tenantId: string;
    let organizationId: string;
    let jobId: string;

    beforeAll(async () => {
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await truncateAllData(db);
      const tenant = await new TenantRepository(db).create({ name: `Lifecycle ${driver}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Lifecycle ${driver}`,
        slug: `migration-lifecycle-${driver}`,
      });
      const job = await new ImportRepository(db).createJob({
        tenantId: tenant.id,
        organizationId: organization.id,
        sourceSystem: 'generic-csv',
        adapterVersion: '1',
        mode: 'commit',
        idempotencyKey: `lifecycle-job-${driver}`,
        requestedBy: 'usr_lifecycle',
      });
      tenantId = tenant.id;
      organizationId = organization.id;
      jobId = job.id;
    }, 60_000);

    afterAll(async () => {
      await db?.destroy();
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
    });

    function commandInput(input: {
      key: string;
      fingerprint?: string;
      expectedLifecycleVersion?: number;
      action?: 'pause' | 'resume' | 'cancel' | 'rollback';
      dispatchKind?: 'none' | 'preparation-signal' | 'commit-signal' | 'rollback-start';
      expectedJobStatus?: ImportJobStatus;
      actorId?: string;
      auditCorrelationId?: string;
      now?: Date;
    }) {
      return {
        tenantId,
        organizationId,
        jobId,
        action: input.action ?? ('pause' as const),
        dispatchKind: input.dispatchKind ?? ('preparation-signal' as const),
        idempotencyKeySha256: digest(input.key),
        requestFingerprint: digest(input.fingerprint ?? `${input.key}:request`),
        expectedJobStatus: input.expectedJobStatus ?? ('pending' as const),
        expectedLifecycleVersion: input.expectedLifecycleVersion ?? 0,
        actorId: input.actorId ?? 'usr_lifecycle',
        auditCorrelationId: input.auditCorrelationId ?? `audit-${digest(input.key).slice(0, 16)}`,
        now: input.now,
      };
    }

    async function reserve(input: ReturnType<typeof commandInput>) {
      return db
        .transaction()
        .execute((transaction) =>
          new ImportRepository(transaction).reserveMigrationLifecycleCommand(input),
        );
    }

    it('replays an exact digest without advancing version and rejects fingerprint conflict', async () => {
      const rawKey = 'raw-key-must-never-be-stored';
      const input = commandInput({ key: rawKey });
      const first = await reserve(input);
      const replay = await reserve(input);
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.command.id).toBe(first.command.id);
      expect(
        (await new ImportRepository(db).findJob(tenantId, organizationId, jobId))
          ?.lifecycle_version,
      ).toBe(1);
      expect(JSON.stringify(replay.command)).not.toContain(rawKey);

      await expect(
        reserve(commandInput({ key: rawKey, fingerprint: 'different-request' })),
      ).rejects.toThrow('MIGRATION_LIFECYCLE_IDEMPOTENCY_CONFLICT');
      expect(
        await new ImportRepository(db).listMigrationLifecycleCommands({
          tenantId,
          organizationId,
          jobId,
        }),
      ).toHaveLength(1);
    });

    it('allows one concurrent CAS winner and preserves strict lifecycle order', async () => {
      const reservationTime = new Date('2026-07-17T12:00:00.000Z');
      const attempts = await Promise.allSettled([
        reserve(commandInput({ key: 'concurrent-a', now: reservationTime })),
        reserve(commandInput({ key: 'concurrent-b', now: reservationTime })),
      ]);
      expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
      const first = attempts.find(({ status }) => status === 'fulfilled');
      if (!first || first.status !== 'fulfilled') throw new Error('missing lifecycle winner');
      await expect(
        reserve(
          commandInput({
            key: 'premature-second',
            expectedLifecycleVersion: 1,
            now: reservationTime,
          }),
        ),
      ).rejects.toThrow('MIGRATION_LIFECYCLE_PREDECESSOR_INCOMPLETE');

      const repository = new ImportRepository(db);
      const claimedFirst = await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-a',
        limit: 10,
        leaseMs: 30_000,
        now: new Date('2026-07-17T12:00:00.000Z'),
      });
      expect(claimedFirst.map(({ lifecycle_sequence }) => lifecycle_sequence)).toEqual([1]);
      expect(
        await repository.markMigrationLifecycleCommandDispatched({
          tenantId,
          organizationId,
          commandId: first.value.command.id,
          workerId: 'worker-a',
          now: new Date('2026-07-17T12:00:01.000Z'),
        }),
      ).toBe(true);
      await db.transaction().execute((transaction) =>
        new ImportRepository(transaction).persistMigrationLifecycleCommandOutcome({
          tenantId,
          organizationId,
          jobId,
          commandId: first.value.command.id,
          lifecycleSequence: 1,
          outcome: 'paused',
          now: new Date('2026-07-17T12:00:01.500Z'),
        }),
      );
      const second = await reserve(
        commandInput({
          key: 'ordered-second',
          expectedLifecycleVersion: 1,
          action: 'resume',
          dispatchKind: 'preparation-signal',
          expectedJobStatus: 'paused',
          now: new Date('2026-07-17T12:00:01.750Z'),
        }),
      );
      expect(second.command.lifecycle_sequence).toBe(2);
      const claimedSecond = await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-b',
        limit: 10,
        leaseMs: 30_000,
        now: new Date('2026-07-17T12:00:02.000Z'),
      });
      expect(claimedSecond.map(({ lifecycle_sequence }) => lifecycle_sequence)).toEqual([2]);
    });

    it('recovers an expired lease and rejects stale worker completion', async () => {
      const command = await reserve(
        commandInput({ key: 'lease-recovery', now: new Date('2026-07-17T12:00:00.000Z') }),
      );
      const repository = new ImportRepository(db);
      const first = await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-old',
        leaseMs: 1_000,
        now: new Date('2026-07-17T12:00:00.000Z'),
      });
      expect(first[0]?.attempts).toBe(1);
      const recovered = await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-new',
        leaseMs: 30_000,
        now: new Date('2026-07-17T12:00:02.000Z'),
      });
      expect(recovered[0]?.id).toBe(command.command.id);
      expect(recovered[0]?.attempts).toBe(2);
      expect(
        await repository.markMigrationLifecycleCommandDispatched({
          tenantId,
          organizationId,
          commandId: command.command.id,
          workerId: 'worker-old',
          now: new Date('2026-07-17T12:00:03.000Z'),
        }),
      ).toBe(false);
      expect(
        await repository.rescheduleMigrationLifecycleCommand({
          tenantId,
          organizationId,
          commandId: command.command.id,
          workerId: 'worker-new',
          errorCode: 'TEMPORAL_UNAVAILABLE',
          now: new Date('2026-07-17T12:00:03.000Z'),
          nextAttemptAt: new Date('2026-07-17T12:01:00.000Z'),
        }),
      ).toBe(true);
      expect(
        (
          await repository.findMigrationLifecycleCommand({
            tenantId,
            organizationId,
            commandId: command.command.id,
          })
        )?.last_error_code,
      ).toBe('TEMPORAL_UNAVAILABLE');
    });

    it('enforces exact tenant and organization scope for every helper', async () => {
      const command = await reserve(commandInput({ key: 'scope' }));
      const otherOrganization = await new OrganizationRepository(db).create({
        tenantId,
        name: `Other lifecycle ${driver}`,
        slug: `other-migration-lifecycle-${driver}`,
      });
      const repository = new ImportRepository(db);
      await expect(
        repository.findMigrationLifecycleCommand({
          tenantId,
          organizationId: otherOrganization.id,
          commandId: command.command.id,
        }),
      ).resolves.toBeUndefined();
      await expect(
        repository.listMigrationLifecycleCommands({
          tenantId,
          organizationId: otherOrganization.id,
          jobId,
        }),
      ).resolves.toEqual([]);
      expect(
        await repository.markMigrationLifecycleCommandDispatched({
          tenantId,
          organizationId: otherOrganization.id,
          commandId: command.command.id,
          workerId: 'wrong-scope',
        }),
      ).toBe(false);
    });

    it('fences every descendant behind a permanently failed predecessor', async () => {
      const now = new Date('2026-07-17T12:00:00.000Z');
      const first = await reserve(commandInput({ key: 'failed-predecessor', now }));
      const repository = new ImportRepository(db);
      await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-failed',
        leaseMs: 30_000,
        now,
      });
      expect(
        await repository.markMigrationLifecycleCommandFailed({
          tenantId,
          organizationId,
          commandId: first.command.id,
          workerId: 'worker-failed',
          errorCode: 'TEMPORAL_UNAVAILABLE',
          now: new Date('2026-07-17T12:00:01.000Z'),
        }),
      ).toBe(true);
      await expect(
        reserve(
          commandInput({
            key: 'blocked-descendant',
            expectedLifecycleVersion: 1,
            now: new Date('2026-07-17T12:00:02.000Z'),
          }),
        ),
      ).rejects.toThrow('MIGRATION_LIFECYCLE_PREDECESSOR_INCOMPLETE');
      expect(
        await repository.claimDueMigrationLifecycleCommands({
          workerId: 'worker-descendant',
          leaseMs: 30_000,
          now: new Date('2026-07-17T12:00:03.000Z'),
        }),
      ).toEqual([]);
    });

    it('persists local cancel and its correlated outcome atomically', async () => {
      const input = commandInput({
        key: 'local-cancel',
        action: 'cancel',
        dispatchKind: 'none',
        actorId: 'usr_cancel',
        auditCorrelationId: 'audit-cancel-1',
      });
      const outcome = await db.transaction().execute(async (transaction) => {
        const repository = new ImportRepository(transaction);
        const reserved = await repository.reserveMigrationLifecycleCommand(input);
        return repository.persistMigrationLifecycleCommandOutcome({
          tenantId,
          organizationId,
          jobId,
          commandId: reserved.command.id,
          lifecycleSequence: reserved.command.lifecycle_sequence,
          outcome: 'cancelled',
        });
      });
      expect(outcome.job.status).toBe('cancelled');
      expect(outcome.command).toMatchObject({
        status: 'dispatched',
        completed_at: expect.any(Date),
      });
      expect(JSON.parse(outcome.event.data ?? '{}')).toMatchObject({
        actorId: 'usr_cancel',
        auditCorrelationId: 'audit-cancel-1',
        outcome: 'cancelled',
      });

      const replay = await db.transaction().execute((transaction) =>
        new ImportRepository(transaction).persistMigrationLifecycleCommandOutcome({
          tenantId,
          organizationId,
          jobId,
          commandId: outcome.command.id,
          lifecycleSequence: outcome.command.lifecycle_sequence,
          outcome: 'cancelled',
        }),
      );
      expect(replay.event.id).toBe(outcome.event.id);
    });

    it('rolls back reservation and local outcome with the caller transaction', async () => {
      await expect(
        db.transaction().execute(async (transaction) => {
          const repository = new ImportRepository(transaction);
          const reserved = await repository.reserveMigrationLifecycleCommand(
            commandInput({ key: 'cancel-rollback', action: 'cancel', dispatchKind: 'none' }),
          );
          await repository.persistMigrationLifecycleCommandOutcome({
            tenantId,
            organizationId,
            jobId,
            commandId: reserved.command.id,
            lifecycleSequence: reserved.command.lifecycle_sequence,
            outcome: 'cancelled',
          });
          throw new Error('FORCED_AUDIT_FAILURE');
        }),
      ).rejects.toThrow('FORCED_AUDIT_FAILURE');
      expect(
        (await new ImportRepository(db).findJob(tenantId, organizationId, jobId))?.status,
      ).toBe('pending');
      expect(
        await new ImportRepository(db).listMigrationLifecycleCommands({
          tenantId,
          organizationId,
          jobId,
        }),
      ).toEqual([]);
    });

    it('rejects unredacted retry errors without persisting them', async () => {
      const command = await reserve(commandInput({ key: 'redaction' }));
      const repository = new ImportRepository(db);
      await repository.claimDueMigrationLifecycleCommands({
        workerId: 'worker-redaction',
        leaseMs: 30_000,
        now: new Date('2026-07-17T12:00:00.000Z'),
      });
      const rawError = 'provider said secret=sk_test_sensitive';
      await expect(
        repository.rescheduleMigrationLifecycleCommand({
          tenantId,
          organizationId,
          commandId: command.command.id,
          workerId: 'worker-redaction',
          errorCode: rawError,
          now: new Date('2026-07-17T12:00:01.000Z'),
          nextAttemptAt: new Date('2026-07-17T12:01:00.000Z'),
        }),
      ).rejects.toThrow('MIGRATION_LIFECYCLE_ERROR_CODE_INVALID');
      const stored = await repository.findMigrationLifecycleCommand({
        tenantId,
        organizationId,
        commandId: command.command.id,
      });
      expect(stored?.last_error_code).toBeNull();
      expect(JSON.stringify(stored)).not.toContain(rawError);
    });
  },
);
