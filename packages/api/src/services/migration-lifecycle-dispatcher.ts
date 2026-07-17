import { ImportRepository, type Database } from '@tixkit/db';

export type MigrationLifecycleTemporalDispatcher = {
  signalMigrationPreparation(
    tenantId: string,
    organizationId: string,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel',
    command: { commandId: string; lifecycleSequence: number },
  ): Promise<void>;
  signalMigration(
    tenantId: string,
    organizationId: string,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel' | 'rollback',
    command: { commandId: string; lifecycleSequence: number },
  ): Promise<void>;
  startMigrationRollback(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    commandId: string;
    lifecycleSequence: number;
  }): Promise<unknown>;
};

function dispatchErrorCode(error: unknown): string {
  const candidate = error as {
    name?: string;
    code?: string;
    cause?: { name?: string; code?: string };
  };
  const name = candidate.name ?? candidate.cause?.name;
  const code = candidate.code ?? candidate.cause?.code;
  if (name === 'WorkflowNotFoundError' || code === 'NOT_FOUND') {
    return 'TEMPORAL_WORKFLOW_NOT_FOUND';
  }
  if (name === 'ServiceError' || code === 'UNAVAILABLE' || code === 'DEADLINE_EXCEEDED') {
    return 'TEMPORAL_UNAVAILABLE';
  }
  return 'MIGRATION_LIFECYCLE_DISPATCH_FAILED';
}

export async function dispatchMigrationLifecycleCommands(input: {
  db: Database;
  temporalClient: MigrationLifecycleTemporalDispatcher;
  workerId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
  maximumAttempts?: number;
}) {
  const repository = new ImportRepository(input.db);
  const now = input.now ?? new Date();
  const maximumAttempts = input.maximumAttempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 32) {
    throw new Error('MIGRATION_LIFECYCLE_MAXIMUM_ATTEMPTS_INVALID');
  }
  const commands = await repository.claimDueMigrationLifecycleCommands({
    workerId: input.workerId,
    limit: input.limit,
    leaseMs: input.leaseMs ?? 30_000,
    now,
  });
  let dispatched = 0;
  let retried = 0;
  let failed = 0;
  for (const command of commands) {
    const lifecycleCommand = {
      commandId: command.id,
      lifecycleSequence: command.lifecycle_sequence,
    };
    try {
      if (command.dispatch_kind === 'preparation-signal') {
        if (!['pause', 'resume', 'cancel'].includes(command.action)) {
          throw new Error('MIGRATION_LIFECYCLE_DISPATCH_KIND_INVALID');
        }
        await input.temporalClient.signalMigrationPreparation(
          command.tenant_id,
          command.organization_id,
          command.import_job_id,
          command.action as 'pause' | 'resume' | 'cancel',
          lifecycleCommand,
        );
      } else if (command.dispatch_kind === 'commit-signal') {
        await input.temporalClient.signalMigration(
          command.tenant_id,
          command.organization_id,
          command.import_job_id,
          command.action as 'pause' | 'resume' | 'cancel' | 'rollback',
          lifecycleCommand,
        );
      } else if (command.dispatch_kind === 'rollback-start') {
        if (command.action !== 'rollback') {
          throw new Error('MIGRATION_LIFECYCLE_DISPATCH_KIND_INVALID');
        }
        await input.temporalClient.startMigrationRollback({
          tenantId: command.tenant_id,
          organizationId: command.organization_id,
          jobId: command.import_job_id,
          ...lifecycleCommand,
        });
      } else {
        throw new Error('MIGRATION_LIFECYCLE_LOCAL_COMMAND_PENDING');
      }
      if (
        !(await repository.markMigrationLifecycleCommandDispatched({
          tenantId: command.tenant_id,
          organizationId: command.organization_id,
          commandId: command.id,
          workerId: input.workerId,
          now,
        }))
      ) {
        throw new Error('MIGRATION_LIFECYCLE_DISPATCH_LEASE_LOST');
      }
      dispatched += 1;
    } catch (error) {
      const errorCode = dispatchErrorCode(error);
      if (Number(command.attempts) >= maximumAttempts) {
        if (
          await repository.markMigrationLifecycleCommandFailed({
            tenantId: command.tenant_id,
            organizationId: command.organization_id,
            commandId: command.id,
            workerId: input.workerId,
            errorCode,
            now,
          })
        ) {
          failed += 1;
        }
      } else {
        const delayMs = Math.min(60_000, 500 * 2 ** Math.max(Number(command.attempts) - 1, 0));
        if (
          await repository.rescheduleMigrationLifecycleCommand({
            tenantId: command.tenant_id,
            organizationId: command.organization_id,
            commandId: command.id,
            workerId: input.workerId,
            errorCode,
            nextAttemptAt: new Date(now.getTime() + delayMs),
            now,
          })
        ) {
          retried += 1;
        }
      }
    }
  }
  return Object.freeze({ claimed: commands.length, dispatched, retried, failed });
}

export function startMigrationLifecycleDispatcher(input: {
  db: Database;
  temporalClient: MigrationLifecycleTemporalDispatcher;
  workerId: string;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = input.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
    throw new Error('MIGRATION_LIFECYCLE_DISPATCH_INTERVAL_INVALID');
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<unknown> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };
  const run = () => {
    if (stopped || active) return;
    active = dispatchMigrationLifecycleCommands(input)
      .catch((error) => input.onError?.(error))
      .finally(() => {
        active = undefined;
        schedule();
      });
  };
  run();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
  };
}
