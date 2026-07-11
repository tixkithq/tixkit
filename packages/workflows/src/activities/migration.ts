/**
 * The migration worker deliberately depends on this narrow port instead of domain
 * repositories. The API/bootstrap layer registers the concrete tenant-scoped
 * implementation, while workflow tests can install an in-memory implementation.
 */
export type MigrationCommitStage =
  | 'organizations_brands'
  | 'venues'
  | 'events_occurrences'
  | 'inventory_pools'
  | 'ticket_types_products'
  | 'questions'
  | 'discounts_access_codes'
  | 'buyers_attendees'
  | 'historical_orders'
  | 'tickets'
  | 'historical_payments_refunds'
  | 'check_in_history';

export const MIGRATION_COMMIT_STAGES: readonly MigrationCommitStage[] = [
  'organizations_brands',
  'venues',
  'events_occurrences',
  'inventory_pools',
  'ticket_types_products',
  'questions',
  'discounts_access_codes',
  'buyers_attendees',
  'historical_orders',
  'tickets',
  'historical_payments_refunds',
  'check_in_history',
] as const;

export type MigrationSideEffectPolicy = {
  fulfillment: 'suppressed';
  notifications: 'suppressed';
  webhooks: 'suppressed';
  providerSuccessEvents: 'suppressed';
  financialRecords: 'historical_snapshots_only';
};

export const MIGRATION_SIDE_EFFECT_POLICY: MigrationSideEffectPolicy = Object.freeze({
  fulfillment: 'suppressed',
  notifications: 'suppressed',
  webhooks: 'suppressed',
  providerSuccessEvents: 'suppressed',
  financialRecords: 'historical_snapshots_only',
});

export type MigrationActivityContext = {
  tenantId: string;
  organizationId: string;
  jobId: string;
  sideEffects: MigrationSideEffectPolicy;
};

export type MigrationStageResult = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
  nextCursor?: string;
  complete: boolean;
};

export type MigrationRollbackAssessment =
  | { eligible: true; mode: 'pre_activation'; entityCount: number }
  | {
      eligible: false;
      mode: 'corrective_plan';
      reasons: string[];
      correctivePlanId: string;
    };

export interface MigrationActivityService {
  beginCommit(context: MigrationActivityContext): Promise<void>;
  processStage(
    context: MigrationActivityContext,
    input: {
      stage: MigrationCommitStage;
      cursor?: string;
      claimOwner: string;
      chunkSize: number;
    },
  ): Promise<MigrationStageResult>;
  recordProgress(
    context: MigrationActivityContext,
    progress: MigrationWorkflowProgress,
  ): Promise<void>;
  markPaused(
    context: MigrationActivityContext,
    paused: boolean,
    lifecycleSequence: number,
  ): Promise<void>;
  cancelCommit(context: MigrationActivityContext): Promise<void>;
  reconcile(context: MigrationActivityContext): Promise<{ repaired: number; unresolved: number }>;
  assessRollback(context: MigrationActivityContext): Promise<MigrationRollbackAssessment>;
  executeRollback(
    context: MigrationActivityContext,
    assessment: Extract<MigrationRollbackAssessment, { eligible: true }>,
  ): Promise<{ deleted: number }>;
  completeCommit(context: MigrationActivityContext): Promise<void>;
  failCommit(context: MigrationActivityContext, failure: MigrationFailure): Promise<void>;
}

export type MigrationFailure = {
  stage?: MigrationCommitStage;
  code: string;
  message: string;
};

export type MigrationWorkflowProgress = {
  stage?: MigrationCommitStage;
  stageIndex: number;
  stageCount: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
};

let migrationService: MigrationActivityService | undefined;

export function registerMigrationActivityService(
  implementation: MigrationActivityService,
): () => void {
  migrationService = implementation;
  return () => {
    if (migrationService === implementation) migrationService = undefined;
  };
}

function getMigrationService(): MigrationActivityService {
  if (!migrationService) {
    throw new Error('MIGRATION_ACTIVITY_SERVICE_UNAVAILABLE');
  }
  return migrationService;
}

function context(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): MigrationActivityContext {
  if (!input.tenantId || !input.organizationId || !input.jobId)
    throw new Error('MIGRATION_SCOPE_REQUIRED');
  return {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
  };
}

export async function beginMigrationCommitActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<void> {
  await getMigrationService().beginCommit(context(input));
}

export async function processMigrationStageActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
  stage: MigrationCommitStage;
  cursor?: string;
  claimOwner: string;
  chunkSize: number;
}): Promise<MigrationStageResult> {
  if (!MIGRATION_COMMIT_STAGES.includes(input.stage)) throw new Error('MIGRATION_STAGE_INVALID');
  if (!Number.isInteger(input.chunkSize) || input.chunkSize < 1 || input.chunkSize > 10_000) {
    throw new Error('MIGRATION_CHUNK_SIZE_INVALID');
  }
  return getMigrationService().processStage(context(input), {
    stage: input.stage,
    cursor: input.cursor,
    claimOwner: input.claimOwner,
    chunkSize: input.chunkSize,
  });
}

export async function recordMigrationProgressActivity(
  input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
  } & MigrationWorkflowProgress,
): Promise<void> {
  const { tenantId, organizationId, jobId, ...progress } = input;
  await getMigrationService().recordProgress(
    context({ tenantId, organizationId, jobId }),
    progress,
  );
}

export async function setMigrationPausedActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
  paused: boolean;
  lifecycleSequence: number;
}): Promise<void> {
  await getMigrationService().markPaused(context(input), input.paused, input.lifecycleSequence);
}

export async function cancelMigrationCommitActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<void> {
  await getMigrationService().cancelCommit(context(input));
}

export async function reconcileMigrationActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<{ repaired: number; unresolved: number }> {
  return getMigrationService().reconcile(context(input));
}

export async function assessMigrationRollbackActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<MigrationRollbackAssessment> {
  return getMigrationService().assessRollback(context(input));
}

export async function executeMigrationRollbackActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
  assessment: Extract<MigrationRollbackAssessment, { eligible: true }>;
}): Promise<{ deleted: number }> {
  return getMigrationService().executeRollback(context(input), input.assessment);
}

export async function completeMigrationCommitActivity(input: {
  tenantId: string;
  organizationId: string;
  jobId: string;
}): Promise<void> {
  await getMigrationService().completeCommit(context(input));
}

export async function failMigrationCommitActivity(
  input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
  } & MigrationFailure,
): Promise<void> {
  const { tenantId, organizationId, jobId, ...failure } = input;
  await getMigrationService().failCommit(context({ tenantId, organizationId, jobId }), failure);
}
