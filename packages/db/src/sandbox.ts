import type { Database } from './client.js';

export const SANDBOX_ENVIRONMENT_ID = 'sandbox_primary';
export const SANDBOX_FIXTURE_VERSION = 1;

export type SandboxEnvironment = {
  epoch: string;
  taskQueue: string;
  fixtureVersion: number;
  resetAt: Date;
};

export async function readSandboxEnvironment(db: Database): Promise<SandboxEnvironment | null> {
  const row = await db
    .selectFrom('sandbox_environments')
    .select(['epoch', 'task_queue', 'fixture_version', 'reset_at'])
    .where('id', '=', SANDBOX_ENVIRONMENT_ID)
    .executeTakeFirst();
  return row
    ? {
        epoch: row.epoch,
        taskQueue: row.task_queue,
        fixtureVersion: row.fixture_version,
        resetAt: row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at),
      }
    : null;
}

export async function writeSandboxEnvironment(
  db: Database,
  input: SandboxEnvironment,
): Promise<void> {
  const values = {
    epoch: input.epoch,
    task_queue: input.taskQueue,
    fixture_version: input.fixtureVersion,
    reset_at: input.resetAt,
  };
  const updated = await db
    .updateTable('sandbox_environments')
    .set(values)
    .where('id', '=', SANDBOX_ENVIRONMENT_ID)
    .executeTakeFirst();
  if (updated.numUpdatedRows > 0n) return;
  await db
    .insertInto('sandbox_environments')
    .values({
      id: SANDBOX_ENVIRONMENT_ID,
      epoch: input.epoch,
      task_queue: input.taskQueue,
      fixture_version: input.fixtureVersion,
      reset_at: input.resetAt,
    })
    .execute();
}

export async function assertSandboxRuntimeBinding(
  db: Database,
  input: { runtimeMode?: string; epoch?: string; taskQueues: readonly string[] },
): Promise<void> {
  const environment = await readSandboxEnvironment(db);
  if (environment && input.runtimeMode !== 'sandbox')
    throw new Error('Sandbox database requires TIXKIT_RUNTIME_MODE=sandbox.');
  if (input.runtimeMode !== 'sandbox') return;
  if (!input.epoch) throw new Error('Sandbox runtime requires TIXKIT_SANDBOX_EPOCH.');
  if (!environment) throw new Error('Sandbox environment marker is missing.');
  if (environment.epoch !== input.epoch)
    throw new Error('Sandbox runtime epoch does not match the database epoch.');
  if (!input.taskQueues.length || input.taskQueues.some((queue) => queue !== environment.taskQueue))
    throw new Error('Sandbox Temporal task queue does not match the database epoch.');
}
