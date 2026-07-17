import { createHash } from 'node:crypto';
import { ImportRepository, type Database } from '@tixkit/db';

export type MigrationLifecycleAction = 'pause' | 'resume' | 'cancel' | 'rollback';

const allowedStatuses: Readonly<Record<MigrationLifecycleAction, readonly string[]>> = {
  pause: ['preparing', 'committing'],
  resume: ['paused'],
  cancel: ['pending', 'prepared', 'ready', 'preparing', 'committing', 'paused'],
  rollback: ['committed', 'failed'],
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function retryableDatabaseError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    number?: number;
    errno?: number;
    cause?: { code?: string; number?: number; errno?: number };
  };
  const code = candidate.code ?? candidate.cause?.code;
  const number = candidate.number ?? candidate.cause?.number;
  const errno = candidate.errno ?? candidate.cause?.errno;
  return (
    code === '40001' ||
    code === '40P01' ||
    code === '23505' ||
    code === 'ER_LOCK_DEADLOCK' ||
    code === 'ER_LOCK_WAIT_TIMEOUT' ||
    code === 'ER_DUP_ENTRY' ||
    errno === 1213 ||
    errno === 1205 ||
    errno === 1062 ||
    number === 2601 ||
    number === 2627
  );
}

export function requireMigrationLifecycleIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error('MIGRATION_LIFECYCLE_IDEMPOTENCY_KEY_INVALID');
  }
  return value;
}

export async function reserveMigrationLifecycleAction(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  action: MigrationLifecycleAction;
  idempotencyKey: string;
  actorId: string;
  auditCorrelationId: string;
  onReserved: (input: {
    db: Database;
    command: Awaited<ReturnType<ImportRepository['reserveMigrationLifecycleCommand']>>['command'];
  }) => Promise<void>;
  now?: Date;
}) {
  const idempotencyKey = requireMigrationLifecycleIdempotencyKey(input.idempotencyKey);
  const idempotencyKeySha256 = sha256(idempotencyKey);
  const requestFingerprint = sha256(
    JSON.stringify({
      action: input.action,
      actorId: input.actorId,
      jobId: input.jobId,
      organizationId: input.organizationId,
      tenantId: input.tenantId,
    }),
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await input.db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (transaction) => {
          const transactionDb = transaction as Database;
          const repository = new ImportRepository(transactionDb);
          const job = await repository.findJobForUpdate(
            input.tenantId,
            input.organizationId,
            input.jobId,
          );
          if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
          const existing = await repository.findMigrationLifecycleCommandByIdempotency({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            idempotencyKeySha256,
          });
          if (existing) {
            const replay = await repository.reserveMigrationLifecycleCommand({
              tenantId: input.tenantId,
              organizationId: input.organizationId,
              jobId: input.jobId,
              action: input.action,
              dispatchKind: existing.dispatch_kind,
              idempotencyKeySha256,
              requestFingerprint,
              expectedJobStatus: existing.expected_job_status as never,
              expectedLifecycleVersion: existing.lifecycle_sequence - 1,
              actorId: input.actorId,
              auditCorrelationId: existing.audit_correlation_id,
              now: input.now,
            });
            return { created: false, command: replay.command, localCompleted: false };
          }
          if (!allowedStatuses[input.action].includes(job.status)) {
            throw new Error('MIGRATION_LIFECYCLE_STATUS_CONFLICT');
          }
          let pausedDispatchKind: 'preparation-signal' | 'commit-signal' | undefined;
          if (job.status === 'paused') {
            const commands = await repository.listMigrationLifecycleCommands({
              tenantId: input.tenantId,
              organizationId: input.organizationId,
              jobId: input.jobId,
              limit: 500,
            });
            for (let index = commands.length - 1; index >= 0; index -= 1) {
              const command = commands[index];
              if (
                command?.action === 'pause' &&
                command.status === 'dispatched' &&
                command.completed_at !== null &&
                (command.dispatch_kind === 'preparation-signal' ||
                  command.dispatch_kind === 'commit-signal')
              ) {
                pausedDispatchKind = command.dispatch_kind;
                break;
              }
            }
            if (!pausedDispatchKind) {
              throw new Error('MIGRATION_LIFECYCLE_PAUSED_PHASE_UNKNOWN');
            }
          }
          const preparationAction =
            job.status === 'preparing' ||
            (job.status === 'paused' && pausedDispatchKind === 'preparation-signal');
          const localCancel =
            input.action === 'cancel' && ['pending', 'prepared', 'ready'].includes(job.status);
          const dispatchKind = localCancel
            ? ('none' as const)
            : input.action === 'rollback'
              ? ('rollback-start' as const)
              : preparationAction
                ? ('preparation-signal' as const)
                : ('commit-signal' as const);
          const reserved = await repository.reserveMigrationLifecycleCommand({
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            action: input.action,
            dispatchKind,
            idempotencyKeySha256,
            requestFingerprint,
            expectedJobStatus: job.status as never,
            expectedLifecycleVersion: Number(job.lifecycle_version),
            actorId: input.actorId,
            auditCorrelationId: input.auditCorrelationId,
            now: input.now,
          });
          if (!reserved.created)
            return { created: false, command: reserved.command, localCompleted: false };
          if (localCancel) {
            await repository.persistMigrationLifecycleCommandOutcome({
              tenantId: input.tenantId,
              organizationId: input.organizationId,
              jobId: input.jobId,
              commandId: reserved.command.id,
              lifecycleSequence: reserved.command.lifecycle_sequence,
              outcome: 'cancelled',
              now: input.now,
            });
          }
          await input.onReserved({ db: transactionDb, command: reserved.command });
          return { created: true, command: reserved.command, localCompleted: localCancel };
        });
    } catch (error) {
      if (!retryableDatabaseError(error) || attempt === 4) throw error;
    }
  }
  throw new Error('MIGRATION_LIFECYCLE_RESERVATION_RETRY_EXHAUSTED');
}
