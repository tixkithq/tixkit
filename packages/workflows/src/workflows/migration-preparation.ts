import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  MigrationPreparationChunk,
  MigrationPreparationInput,
} from '../activities/migration-preparation.js';

const activities = proxyActivities<{
  prepareMigrationChunkActivity(
    input: MigrationPreparationInput,
  ): Promise<MigrationPreparationChunk>;
  pauseMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'>,
  ): Promise<void>;
  cancelMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'>,
  ): Promise<void>;
  failMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & { message: string },
  ): Promise<void>;
}>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 6,
  },
});

type Scope = { tenantId: string; organizationId: string; jobId: string };

export type MigrationPreparationWorkflowInput = Scope & {
  version: number;
  chunkSize?: number;
};

export type MigrationPreparationWorkflowResult = {
  status: 'prepared' | 'cancelled' | 'failed';
  processed: number;
};

export const pauseMigrationPreparationSignal = defineSignal('pauseMigrationPreparation');
export const resumeMigrationPreparationSignal = defineSignal('resumeMigrationPreparation');
export const cancelMigrationPreparationSignal = defineSignal('cancelMigrationPreparation');

export async function migrationPreparationWorkflow(
  input: MigrationPreparationWorkflowInput,
): Promise<MigrationPreparationWorkflowResult> {
  if (input.version !== 1)
    throw new Error(`Unsupported migration preparation version ${input.version}`);
  const scope = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
  };
  const chunkSize = input.chunkSize ?? 100;
  let paused = false;
  let cancelled = false;
  let processed = 0;
  setHandler(pauseMigrationPreparationSignal, () => {
    paused = true;
  });
  setHandler(resumeMigrationPreparationSignal, () => {
    paused = false;
  });
  setHandler(cancelMigrationPreparationSignal, () => {
    cancelled = true;
  });
  try {
    for (;;) {
      if (cancelled) {
        await activities.cancelMigrationPreparationActivity(scope);
        return { status: 'cancelled', processed };
      }
      if (paused) {
        await activities.pauseMigrationPreparationActivity(scope);
        await condition(() => !paused || cancelled);
        continue;
      }
      const result = await activities.prepareMigrationChunkActivity({
        ...scope,
        chunkSize,
      });
      processed += result.processed;
      if (result.completed) return { status: 'prepared', processed };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Migration preparation failed';
    await activities.failMigrationPreparationActivity({ ...scope, message });
    return { status: 'failed', processed };
  }
}
