import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import {
  MIGRATION_COMMIT_STAGES,
  type MigrationCommitStage,
  type MigrationFailure,
  type MigrationRollbackAssessment,
  type MigrationStageResult,
  type MigrationWorkflowProgress,
} from '../activities/migration.js';

const activities = proxyActivities<{
  beginMigrationCommitActivity(input: ScopedInput): Promise<void>;
  processMigrationStageActivity(
    input: ScopedInput & {
      stage: MigrationCommitStage;
      cursor?: string;
      claimOwner: string;
      chunkSize: number;
    },
  ): Promise<MigrationStageResult>;
  recordMigrationProgressActivity(input: ScopedInput & MigrationWorkflowProgress): Promise<void>;
  setMigrationPausedActivity(
    input: ScopedInput & { paused: boolean; lifecycleSequence: number },
  ): Promise<void>;
  cancelMigrationCommitActivity(input: ScopedInput): Promise<void>;
  reconcileMigrationActivity(input: ScopedInput): Promise<{ repaired: number; unresolved: number }>;
  assessMigrationRollbackActivity(input: ScopedInput): Promise<MigrationRollbackAssessment>;
  executeMigrationRollbackActivity(
    input: ScopedInput & {
      assessment: Extract<MigrationRollbackAssessment, { eligible: true }>;
    },
  ): Promise<{ deleted: number }>;
  completeMigrationCommitActivity(input: ScopedInput): Promise<void>;
  failMigrationCommitActivity(input: ScopedInput & MigrationFailure): Promise<void>;
}>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: {
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
    maximumAttempts: 5,
  },
});

type ScopedInput = { tenantId: string; organizationId: string; jobId: string };

export const pauseMigrationSignal = defineSignal('pauseMigration');
export const resumeMigrationSignal = defineSignal('resumeMigration');
export const cancelMigrationSignal = defineSignal('cancelMigration');
export const reconcileMigrationSignal = defineSignal('reconcileMigration');
export const requestMigrationRollbackSignal = defineSignal('requestMigrationRollback');
export const getMigrationStateQuery = defineQuery<MigrationWorkflowState>('getMigrationState');

export type MigrationWorkflowInput = ScopedInput & {
  version: number;
  chunkSize?: number;
};

export type MigrationWorkflowStatus =
  | 'committing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'reconciling'
  | 'rolling_back'
  | 'rollback_refused'
  | 'rolled_back'
  | 'completed'
  | 'failed';

export type MigrationWorkflowState = MigrationWorkflowProgress & {
  status: MigrationWorkflowStatus;
  cancellationRequested: boolean;
  reconciliationRequested: boolean;
  rollbackRequested: boolean;
  rollback?: MigrationRollbackAssessment;
  error?: MigrationFailure;
};

export type MigrationWorkflowResult = {
  status: MigrationWorkflowStatus;
  progress: MigrationWorkflowProgress;
  rollback?: MigrationRollbackAssessment;
  reconciliation?: { repaired: number; unresolved: number };
};

export type MigrationRollbackWorkflowInput = ScopedInput & { version: number };

export async function migrationRollbackWorkflow(input: MigrationRollbackWorkflowInput): Promise<{
  status: 'rollback_refused' | 'rolled_back';
  assessment: MigrationRollbackAssessment;
  deleted?: number;
}> {
  if (input.version !== 1)
    throw new Error(`Unsupported migration rollback workflow version ${input.version}`);
  if (!input.tenantId || !input.organizationId || !input.jobId)
    throw new Error('Migration tenantId, organizationId and jobId are required');
  const scope = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
  };
  const assessment = await activities.assessMigrationRollbackActivity(scope);
  if (!assessment.eligible) return { status: 'rollback_refused', assessment };
  const result = await activities.executeMigrationRollbackActivity({ ...scope, assessment });
  return { status: 'rolled_back', assessment, deleted: result.deleted };
}

function addResult(progress: MigrationWorkflowProgress, result: MigrationStageResult): void {
  progress.processed += result.processed;
  progress.created += result.created;
  progress.updated += result.updated;
  progress.skipped += result.skipped;
  progress.conflicts += result.conflicts;
  progress.failed += result.failed;
}

function failureFrom(error: unknown, stage?: MigrationCommitStage): MigrationFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    stage,
    code: 'MIGRATION_COMMIT_FAILED',
    message: message.slice(0, 1_000),
  };
}

export async function migrationCommitWorkflow(
  input: MigrationWorkflowInput,
): Promise<MigrationWorkflowResult> {
  if (input.version !== 1)
    throw new Error(`Unsupported migration workflow version ${input.version}`);
  if (!input.tenantId || !input.organizationId || !input.jobId)
    throw new Error('Migration tenantId, organizationId and jobId are required');
  const chunkSize = input.chunkSize ?? 500;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 10_000) {
    throw new Error('Migration chunkSize must be between 1 and 10000');
  }

  const scope = {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
  };
  let paused = false;
  let pausePersisted = false;
  let lifecycleSequence = 0;
  const state: MigrationWorkflowState = {
    status: 'committing',
    cancellationRequested: false,
    reconciliationRequested: false,
    rollbackRequested: false,
    stageIndex: 0,
    stageCount: MIGRATION_COMMIT_STAGES.length,
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
  };

  setHandler(pauseMigrationSignal, () => {
    lifecycleSequence += 1;
    paused = true;
    state.status = 'paused';
  });
  setHandler(resumeMigrationSignal, () => {
    lifecycleSequence += 1;
    paused = false;
    state.status = 'committing';
  });
  setHandler(cancelMigrationSignal, () => {
    state.cancellationRequested = true;
    state.status = 'cancelling';
  });
  setHandler(reconcileMigrationSignal, () => {
    state.reconciliationRequested = true;
  });
  setHandler(requestMigrationRollbackSignal, () => {
    state.rollbackRequested = true;
  });
  setHandler(getMigrationStateQuery, () => state);

  try {
    await activities.beginMigrationCommitActivity(scope);
    // Dependency stages and chunks must commit serially so a child cannot be
    // observed before its external-ID dependency mapping is durable.
    /* eslint-disable no-await-in-loop -- durable dependency and cursor ordering is intentional. */
    for (let stageIndex = 0; stageIndex < MIGRATION_COMMIT_STAGES.length; stageIndex += 1) {
      const stage = MIGRATION_COMMIT_STAGES[stageIndex]!;
      state.stage = stage;
      state.stageIndex = stageIndex;
      let cursor: string | undefined;
      let complete = false;

      while (!complete) {
        if (paused) {
          if (!pausePersisted) {
            await activities.setMigrationPausedActivity({
              ...scope,
              paused: true,
              lifecycleSequence,
            });
            pausePersisted = true;
          }
          await condition(() => !paused || state.cancellationRequested);
        }
        if (pausePersisted && !paused) {
          await activities.setMigrationPausedActivity({
            ...scope,
            paused: false,
            lifecycleSequence,
          });
          pausePersisted = false;
        }
        if (state.cancellationRequested) {
          await activities.cancelMigrationCommitActivity(scope);
          state.status = 'cancelled';
          return { status: state.status, progress: state };
        }

        const result = await activities.processMigrationStageActivity({
          ...scope,
          stage,
          cursor,
          claimOwner: `${input.jobId}:${stage}:${cursor ?? 'initial'}`,
          chunkSize,
        });
        addResult(state, result);
        cursor = result.nextCursor;
        complete = result.complete;
        if (!complete && !cursor)
          throw new Error(`Migration stage ${stage} did not advance cursor`);
        await activities.recordMigrationProgressActivity({
          ...scope,
          ...state,
        });
      }
    }
    /* eslint-enable no-await-in-loop */

    state.status = 'reconciling';
    const reconciliation = await activities.reconcileMigrationActivity(scope);
    if (reconciliation.unresolved > 0) {
      throw new Error(`Migration reconciliation has ${reconciliation.unresolved} unresolved items`);
    }

    if (state.rollbackRequested) {
      state.status = 'rolling_back';
      const assessment = await activities.assessMigrationRollbackActivity(scope);
      state.rollback = assessment;
      if (!assessment.eligible) {
        state.status = 'rollback_refused';
        return {
          status: state.status,
          progress: state,
          rollback: assessment,
          reconciliation,
        };
      }
      await activities.executeMigrationRollbackActivity({
        ...scope,
        assessment,
      });
      state.status = 'rolled_back';
      return {
        status: state.status,
        progress: state,
        rollback: assessment,
        reconciliation,
      };
    }

    await activities.completeMigrationCommitActivity(scope);
    state.status = 'completed';
    return { status: state.status, progress: state, reconciliation };
  } catch (error) {
    const failure = failureFrom(error, state.stage);
    state.status = 'failed';
    state.error = failure;
    await activities.failMigrationCommitActivity({ ...scope, ...failure });
    throw error;
  }
}
