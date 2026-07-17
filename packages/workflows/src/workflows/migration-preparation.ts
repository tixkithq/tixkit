import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  MigrationPreparationChunk,
  MigrationPreparationInput,
} from '../activities/migration-preparation.js';
import {
  createMigrationLifecycleCommandGate,
  type MigrationLifecycleSignalCommand,
} from './migration-lifecycle.js';

const activities = proxyActivities<{
  prepareMigrationChunkActivity(
    input: MigrationPreparationInput,
  ): Promise<MigrationPreparationChunk>;
  pauseMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand?: MigrationLifecycleSignalCommand;
    },
  ): Promise<void>;
  resumeMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand: MigrationLifecycleSignalCommand;
    },
  ): Promise<void>;
  cancelMigrationPreparationActivity(
    input: Omit<MigrationPreparationInput, 'chunkSize'> & {
      lifecycleCommand?: MigrationLifecycleSignalCommand;
    },
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
  lifecycle: ReturnType<ReturnType<typeof createMigrationLifecycleCommandGate>['snapshot']> & {
    invalidCommand: boolean;
  };
};

export const pauseMigrationPreparationSignal = defineSignal<[MigrationLifecycleSignalCommand]>(
  'pauseMigrationPreparation',
);
export const resumeMigrationPreparationSignal = defineSignal<[MigrationLifecycleSignalCommand]>(
  'resumeMigrationPreparation',
);
export const cancelMigrationPreparationSignal = defineSignal<[MigrationLifecycleSignalCommand]>(
  'cancelMigrationPreparation',
);

export async function migrationPreparationWorkflow(
  input: MigrationPreparationWorkflowInput,
): Promise<MigrationPreparationWorkflowResult> {
  if (![1, 2].includes(input.version))
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
  let legacyLifecycleSequence = 0;
  let invalidCommand = false;
  let pauseCommand: MigrationLifecycleSignalCommand | undefined;
  let resumeCommand: MigrationLifecycleSignalCommand | undefined;
  let cancelCommand: MigrationLifecycleSignalCommand | undefined;
  const commandGate = createMigrationLifecycleCommandGate();
  const lifecycle = () => ({ ...commandGate.snapshot(), invalidCommand });
  const accept = (
    action: 'pause' | 'resume' | 'cancel',
    raw: MigrationLifecycleSignalCommand | undefined,
  ): MigrationLifecycleSignalCommand | undefined => {
    if (input.version === 1 && raw === undefined) {
      legacyLifecycleSequence += 1;
      return undefined;
    }
    try {
      const decision = commandGate.accept(action, raw);
      return decision.status === 'accepted' ? decision.command : undefined;
    } catch {
      invalidCommand = true;
      return undefined;
    }
  };
  setHandler(pauseMigrationPreparationSignal, (raw?: MigrationLifecycleSignalCommand) => {
    const command = accept('pause', raw);
    if (input.version === 2 && !command) return;
    pauseCommand = command;
    paused = true;
  });
  setHandler(resumeMigrationPreparationSignal, (raw?: MigrationLifecycleSignalCommand) => {
    const command = accept('resume', raw);
    if (input.version === 2 && !command) return;
    resumeCommand = command;
    paused = false;
  });
  setHandler(cancelMigrationPreparationSignal, (raw?: MigrationLifecycleSignalCommand) => {
    const command = accept('cancel', raw);
    if (input.version === 2 && !command) return;
    cancelCommand = command;
    cancelled = true;
  });
  try {
    for (;;) {
      if (cancelled) {
        await activities.cancelMigrationPreparationActivity({
          ...scope,
          ...(cancelCommand ? { lifecycleCommand: cancelCommand } : {}),
        });
        return { status: 'cancelled', processed, lifecycle: lifecycle() };
      }
      if (paused) {
        await activities.pauseMigrationPreparationActivity({
          ...scope,
          ...(pauseCommand ? { lifecycleCommand: pauseCommand } : {}),
        });
        pauseCommand = undefined;
        await condition(() => !paused || cancelled);
        continue;
      }
      if (resumeCommand) {
        await activities.resumeMigrationPreparationActivity({
          ...scope,
          lifecycleCommand: resumeCommand,
        });
        resumeCommand = undefined;
      }
      const result = await activities.prepareMigrationChunkActivity({
        ...scope,
        chunkSize,
      });
      processed += result.processed;
      if (result.completed) return { status: 'prepared', processed, lifecycle: lifecycle() };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Migration preparation failed';
    await activities.failMigrationPreparationActivity({ ...scope, message });
    return { status: 'failed', processed, lifecycle: lifecycle() };
  }
}
