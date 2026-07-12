import { ImportRepository, type Database } from '@tixkit/db';
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  assertHistoricalFinancialEntity,
  type MigrationCredentialResolver,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import type {
  MigrationActivityContext,
  MigrationActivityService,
  MigrationCommitStage,
  MigrationFailure,
  MigrationRollbackAssessment,
  MigrationStageResult,
  MigrationWorkflowProgress,
} from './migration.js';

export type MigrationCommitOutcome = {
  disposition: 'created' | 'updated' | 'skipped' | 'conflict';
  tixkitId?: string;
};

export interface MigrationDomainCommitter {
  assessUntouched(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    tixkitId: string;
  }): Promise<{ eligible: boolean; reason?: string }>;
  commit(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    entity: NormalizedMigrationEntity;
    sideEffects: MigrationActivityContext['sideEffects'];
  }): Promise<MigrationCommitOutcome>;
  deleteUntouched(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    tixkitId: string;
  }): Promise<boolean>;
}

export type MigrationCommitterRegistry = ReadonlyMap<MigrationEntityType, MigrationDomainCommitter>;

const STAGE_ENTITIES: Record<MigrationCommitStage, readonly MigrationEntityType[]> = {
  organizations_brands: ['organization', 'brand'],
  venues: ['venue'],
  events_occurrences: ['event', 'occurrence'],
  inventory_pools: ['inventory-pool'],
  ticket_types_products: ['ticket-type', 'product'],
  questions: ['question'],
  discounts_access_codes: ['discount', 'access-code'],
  buyers_attendees: ['buyer', 'attendee'],
  historical_orders: ['historical-order'],
  tickets: ['ticket'],
  historical_payments_refunds: ['historical-payment', 'historical-refund'],
  check_in_history: ['check-in'],
};

export function assertMigrationCommittersRegistered(registry: MigrationCommitterRegistry): void {
  const missing = MIGRATION_ENTITY_DEPENDENCY_ORDER.filter((type) => !registry.has(type));
  if (missing.length > 0) {
    throw new Error(`MIGRATION_COMMITTERS_MISSING:${missing.join(',')}`);
  }
}

function parseEntity(serialized: string | null): NormalizedMigrationEntity {
  if (!serialized) throw new Error('MIGRATION_NORMALIZED_DATA_REQUIRED');
  const parsed = JSON.parse(serialized) as NormalizedMigrationEntity;
  if (!parsed || typeof parsed !== 'object' || !parsed.entityType || !parsed.externalId) {
    throw new Error('MIGRATION_NORMALIZED_DATA_INVALID');
  }
  assertHistoricalFinancialEntity(parsed);
  return parsed;
}

function summary(progress: MigrationWorkflowProgress): MigrationWorkflowProgress {
  return { ...progress };
}

async function listAllCreatedRows(repository: ImportRepository, context: MigrationActivityContext) {
  const rows: Awaited<ReturnType<ImportRepository['listRows']>> = [];
  for (let offset = 0; ; offset += 5_000) {
    const page = await repository.listRows({
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      jobId: context.jobId,
      statuses: ['created'],
      limit: 5_000,
      offset,
    });
    rows.push(...page);
    if (page.length < 5_000) return rows;
  }
}

export function createRepositoryMigrationActivityService(
  db: Database,
  committers: MigrationCommitterRegistry,
  credentialResolver?: MigrationCredentialResolver,
): MigrationActivityService {
  assertMigrationCommittersRegistered(committers);
  const repository = new ImportRepository(db);
  const claimedStatus = 'committing';

  return {
    async beginCommit(context) {
      const pendingJob = await repository.findJob(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (!pendingJob) throw new Error('MIGRATION_JOB_NOT_FOUND');
      if (pendingJob.source_system === 'tixkit-portable') {
        throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_UNAVAILABLE');
      }
      const configuration = pendingJob.configuration
        ? (JSON.parse(pendingJob.configuration) as Record<string, unknown>)
        : {};
      if (typeof configuration.credentialId === 'string') {
        try {
          if (!credentialResolver) throw new Error('resolver unavailable');
          const credential = await repository.findActiveCredential({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            credentialId: configuration.credentialId,
            sourceSystem: pendingJob.source_system,
          });
          if (!credential) throw new Error('credential inactive');
          const resolved = await credentialResolver.resolve(
            {
              id: credential.id,
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              sourceSystem: pendingJob.source_system,
              secretReference: credential.secret_reference,
              expiresAt: credential.expires_at.toISOString(),
            },
            {},
          );
          if (
            !resolved.material ||
            !Number.isFinite(Date.parse(resolved.expiresAt)) ||
            Date.parse(resolved.expiresAt) <= Date.now()
          )
            throw new Error('credential expired');
          void resolved.material;
        } catch {
          throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
        }
      }
      await repository.beginCommit({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'commit:begin',
        type: 'commit.begin',
        severity: 'info',
        message: 'Migration commit started.',
      });
    },

    async processStage(context, input): Promise<MigrationStageResult> {
      const entityTypes = STAGE_ENTITIES[input.stage];
      const job = await repository.findJob(context.tenantId, context.organizationId, context.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      if (job.mode !== 'commit') throw new Error('MIGRATION_DRY_RUN_CANNOT_COMMIT');
      if (job.status !== 'committing')
        throw new Error(`MIGRATION_JOB_NOT_COMMITTING:${job.status}`);
      const rows = await repository.claimRows({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        entityTypes: [...entityTypes],
        fromStatus: 'validated',
        claimStatus: claimedStatus,
        ownerToken: input.claimOwner,
        leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        limit: input.chunkSize,
      });
      const result: MigrationStageResult = {
        processed: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        complete: rows.length < input.chunkSize,
        ...(rows.length === input.chunkSize ? { nextCursor: rows.at(-1)!.id } : {}),
      };

      /* eslint-disable no-await-in-loop -- row commits and claim outcomes are intentionally ordered for idempotent recovery. */
      for (const row of rows) {
        const entity = parseEntity(row.normalized_data);
        if (!entityTypes.includes(entity.entityType)) {
          throw new Error(`MIGRATION_STAGE_ENTITY_MISMATCH:${entity.entityType}`);
        }
        const committer = committers.get(entity.entityType);
        if (!committer) throw new Error(`MIGRATION_COMMITTER_MISSING:${entity.entityType}`);
        try {
          const outcome = await committer.commit({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            entity,
            sideEffects: context.sideEffects,
          });
          if (
            (outcome.disposition === 'created' || outcome.disposition === 'updated') &&
            !outcome.tixkitId
          ) {
            throw new Error(`MIGRATION_COMMIT_RESULT_ID_REQUIRED:${row.id}`);
          }
          let completed: boolean;
          if (outcome.disposition !== 'conflict' && outcome.tixkitId && row.external_id) {
            await repository.completeRowWithExternalReference({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              rowId: row.id,
              claimedStatus,
              ownerToken: input.claimOwner,
              outcome: outcome.disposition,
              sourceSystem: job.source_system,
              entityType: entity.entityType,
              externalId: row.external_id,
              tixkitId: outcome.tixkitId,
              createdEntity: outcome.disposition === 'created',
              provenance: entity,
            });
            completed = true;
          } else {
            completed = await repository.completeRow({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              rowId: row.id,
              claimedStatus,
              ownerToken: input.claimOwner,
              outcome: outcome.disposition,
              tixkitId: outcome.tixkitId,
              createdEntity: outcome.disposition === 'created',
            });
          }
          if (!completed) throw new Error(`MIGRATION_ROW_CLAIM_LOST:${row.id}`);
          if (outcome.disposition === 'conflict') result.conflicts += 1;
          else result[outcome.disposition] += 1;
        } catch (error) {
          await repository.completeRow({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            rowId: row.id,
            claimedStatus,
            ownerToken: input.claimOwner,
            outcome: 'failed',
            severity: 'error',
            rollbackBlockedReason:
              error instanceof Error ? error.message.slice(0, 500) : 'Commit failed',
          });
          result.failed += 1;
          throw error;
        } finally {
          result.processed += 1;
        }
      }
      /* eslint-enable no-await-in-loop */
      return result;
    },

    async recordProgress(context, progress) {
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['committing'],
        to: 'committing',
        summary: summary(progress),
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:progress:${progress.stage ?? 'none'}:${progress.processed}`,
        type: 'commit.progress',
        severity: progress.failed > 0 || progress.conflicts > 0 ? 'warning' : 'info',
        message: `Migration processed ${progress.processed} rows.`,
        data: summary(progress),
      });
    },

    async markPaused(context, paused, lifecycleSequence) {
      const changed = await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: paused ? ['committing'] : ['paused'],
        to: paused ? 'paused' : 'committing',
      });
      if (!changed) throw new Error('MIGRATION_PAUSE_TRANSITION_REJECTED');
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:${paused ? 'pause' : 'resume'}:${lifecycleSequence}`,
        type: paused ? 'commit.paused' : 'commit.resumed',
        severity: 'info',
        message: paused ? 'Migration commit paused.' : 'Migration commit resumed.',
      });
    },

    async cancelCommit(context) {
      await repository.requestCancellation(context.tenantId, context.organizationId, context.jobId);
      await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      const changed = await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['cancelling'],
        to: 'cancelled',
      });
      if (!changed) throw new Error('MIGRATION_CANCEL_TRANSITION_REJECTED');
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'commit:cancelled',
        type: 'commit.cancelled',
        severity: 'warning',
        message: 'Migration commit cancelled.',
      });
    },

    async reconcile(context) {
      const rows: Awaited<ReturnType<ImportRepository['listRowsForReconciliation']>> = [];
      for (let offset = 0; ; offset += 5_000) {
        const page = await repository.listRowsForReconciliation(
          context.tenantId,
          context.organizationId,
          context.jobId,
          5_000,
          offset,
        );
        rows.push(...page);
        if (page.length < 5_000) break;
      }
      const repaired = await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:reconcile:${repaired}:${rows.length}`,
        type: 'commit.reconciled',
        severity: rows.length > 0 ? 'error' : 'info',
        message:
          rows.length > 0
            ? `Migration reconciliation found ${rows.length} unresolved rows.`
            : 'Migration reconciliation completed with no unresolved rows.',
        data: { repaired, unresolved: rows.length },
      });
      return {
        repaired,
        unresolved: rows.length,
      };
    },

    async assessRollback(context): Promise<MigrationRollbackAssessment> {
      const eligibility = await repository.getRollbackEligibility(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (eligibility.eligible) {
        const rows = await listAllCreatedRows(repository, context);
        const reasons: string[] = [];
        for (const row of rows) {
          if (!row.tixkit_id) {
            reasons.push(`Missing canonical ID for ${row.id}`);
            continue;
          }
          const committer = committers.get(row.entity_type as MigrationEntityType);
          if (!committer) {
            reasons.push(`Missing committer for ${row.entity_type}`);
            continue;
          }
          const probe = await committer.assessUntouched({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            tixkitId: row.tixkit_id,
          });
          if (!probe.eligible)
            reasons.push(
              probe.reason ?? `Authoritative activity on ${row.entity_type}:${row.tixkit_id}`,
            );
        }
        if (reasons.length > 0)
          return {
            eligible: false,
            mode: 'corrective_plan',
            reasons,
            correctivePlanId: `corrective-plan:${context.jobId}`,
          };
        return {
          eligible: true,
          mode: 'pre_activation',
          entityCount: rows.length,
        };
      }
      const job = await repository.findJob(context.tenantId, context.organizationId, context.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      const mappings = await repository.listMappings(
        context.tenantId,
        context.organizationId,
        job.source_system,
      );
      return {
        eligible: false,
        mode: 'corrective_plan',
        reasons: eligibility.blockers.map((blocker) => blocker.reason),
        correctivePlanId: (
          await repository.appendIdempotentEvent({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            eventKey: 'rollback:corrective-plan',
            type: 'rollback.corrective-plan',
            severity: 'warning',
            message: 'Destructive rollback was refused; follow the persisted corrective plan.',
            data: {
              immutable: true,
              blockers: eligibility.blockers,
              impactedEntities: eligibility.blockers.map((blocker) => ({
                entityType: blocker.entityType,
                tixkitId: blocker.tixkitId,
              })),
              impactedMappings: mappings.map((mapping) => ({
                id: mapping.id,
                entityType: mapping.entity_type,
                name: mapping.name,
                version: mapping.version,
              })),
              safeActions: [
                'Keep imported entities inactive while reconciling source mappings.',
                'Apply tenant-scoped corrective edits or additive mappings.',
                'Record compensating historical snapshots instead of provider events.',
                'Re-run rollback assessment only after every blocker is independently resolved.',
              ],
            },
          })
        ).id,
      };
    },

    async executeRollback(context, assessment) {
      const eligibility = await repository.getRollbackEligibility(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (!eligibility.eligible || eligibility.mode !== 'delete-created') {
        throw new Error('MIGRATION_ROLLBACK_NO_LONGER_ELIGIBLE');
      }
      const rows = await listAllCreatedRows(repository, context);
      rows.sort(
        (left, right) =>
          MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf(right.entity_type as MigrationEntityType) -
          MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf(left.entity_type as MigrationEntityType),
      );
      if (rows.length > assessment.entityCount) throw new Error('MIGRATION_ROLLBACK_SET_CHANGED');
      let deleted = 0;
      /* eslint-disable no-await-in-loop -- rollback rechecks and deletes one entity at a time to fail closed on new activity. */
      for (const row of rows) {
        if (!row.tixkit_id) throw new Error(`MIGRATION_ROLLBACK_ID_MISSING:${row.id}`);
        const committer = committers.get(row.entity_type as MigrationEntityType);
        if (!committer) throw new Error(`MIGRATION_COMMITTER_MISSING:${row.entity_type}`);
        if (
          !(await committer.deleteUntouched({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            tixkitId: row.tixkit_id,
          }))
        )
          throw new Error(`MIGRATION_ROLLBACK_DELETE_REFUSED:${row.id}`);
        deleted += 1;
      }
      /* eslint-enable no-await-in-loop */
      await repository.deleteRollbackMetadata(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['rolling-back', 'committed', 'failed'],
        to: 'rolled-back',
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'rollback:completed',
        type: 'rollback.completed',
        severity: 'info',
        message: `Migration rollback deleted ${deleted} untouched entities.`,
        data: { deleted },
      });
      return { deleted };
    },

    async completeCommit(context) {
      const changed = await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['committing'],
        to: 'committed',
      });
      if (!changed) throw new Error('MIGRATION_COMPLETE_TRANSITION_REJECTED');
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'commit:completed',
        type: 'commit.completed',
        severity: 'info',
        message: 'Migration commit completed.',
      });
    },

    async failCommit(context, failure: MigrationFailure) {
      await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['committing', 'paused', 'rolling-back'],
        to: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:failed:${failure.stage ?? 'none'}:${failure.code}`,
        type: 'commit.failed',
        severity: 'fatal',
        message: failure.message,
        data: { stage: failure.stage, code: failure.code },
      });
    },
  };
}
