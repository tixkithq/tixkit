import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import type { WorkflowHandleWithStartDetails } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_COMMIT_STAGES, type MigrationCommitStage } from '../activities/migration.js';
import { migrationCommitWorkflow } from '../workflows/migration.js';

const temporalAddress = process.env.TEMPORAL_ADDRESS;
const describeWithTemporal = temporalAddress ? describe : describe.skip;

describeWithTemporal('migration workflow on Temporal', () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createFromExistingServer({
      address: temporalAddress!,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
  });

  afterAll(async () => {
    await environment?.teardown();
  });

  it('retries a transient stage, preserves dependency order, and replays durable history', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const taskQueue = `migration-temporal-proof-${suffix}`;
    const workflowId = `migration-temporal-proof:${suffix}`;
    const stageCalls: MigrationCommitStage[] = [];
    const attempts = new Map<MigrationCommitStage, number>();
    let began = 0;
    let reconciled = 0;
    let completed = 0;
    let failed = 0;
    const workflowsPath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue,
      workflowsPath,
      activities: {
        async beginMigrationCommitActivity() {
          began += 1;
        },
        async processMigrationStageActivity(input: { stage: MigrationCommitStage }) {
          const attempt = Context.current().info.attempt;
          attempts.set(input.stage, attempt);
          if (input.stage === MIGRATION_COMMIT_STAGES[0] && attempt === 1) {
            throw new Error('TRANSIENT_FIRST_STAGE_FAILURE');
          }
          stageCalls.push(input.stage);
          return {
            processed: 1,
            created: 1,
            updated: 0,
            skipped: 0,
            conflicts: 0,
            failed: 0,
            complete: true,
          };
        },
        async recordMigrationProgressActivity() {},
        async setMigrationPausedActivity() {},
        async cancelMigrationCommitActivity() {},
        async reconcileMigrationActivity() {
          reconciled += 1;
          return { repaired: 0, unresolved: 0 };
        },
        async assessMigrationRollbackActivity() {
          return {
            eligible: false as const,
            mode: 'corrective_plan' as const,
            reasons: ['not requested'],
            correctivePlanId: 'plan_not_requested',
          };
        },
        async executeMigrationRollbackActivity() {
          return { deleted: 0 };
        },
        async completeMigrationCommitActivity() {
          completed += 1;
        },
        async failMigrationCommitActivity() {
          failed += 1;
        },
      },
    });
    let handle: WorkflowHandleWithStartDetails<typeof migrationCommitWorkflow> | undefined;
    let workerRan = false;
    let cleanupError: unknown;
    try {
      const startedHandle = await environment.client.workflow.start(migrationCommitWorkflow, {
        taskQueue,
        workflowId,
        workflowExecutionTimeout: '30 seconds',
        args: [
          {
            version: 1,
            tenantId: 'tenant_temporal_proof',
            organizationId: 'organization_temporal_proof',
            jobId: `job_temporal_proof_${suffix}`,
            chunkSize: 100,
          },
        ],
      });
      handle = startedHandle;
      workerRan = true;
      const result = await worker.runUntil(() => startedHandle.result(), {
        promiseCompletionTimeout: '30 seconds',
      });
      expect(result).toMatchObject({
        status: 'completed',
        reconciliation: { repaired: 0, unresolved: 0 },
        progress: {
          stageCount: MIGRATION_COMMIT_STAGES.length,
          processed: MIGRATION_COMMIT_STAGES.length,
          created: MIGRATION_COMMIT_STAGES.length,
          failed: 0,
        },
      });
      expect(began).toBe(1);
      expect(attempts.get(MIGRATION_COMMIT_STAGES[0]!)).toBe(2);
      expect(stageCalls).toEqual(MIGRATION_COMMIT_STAGES);
      expect(reconciled).toBe(1);
      expect(completed).toBe(1);
      expect(failed).toBe(0);
      const history = await startedHandle.fetchHistory();
      await expect(
        Worker.runReplayHistory({ workflowsPath }, history, workflowId),
      ).resolves.toBeUndefined();
    } finally {
      try {
        await environment.connection.workflowService.deleteWorkflowExecution({
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          workflowExecution: {
            workflowId,
            ...(handle ? { runId: handle.firstExecutionRunId } : {}),
          },
        });
      } catch (error) {
        if (handle) cleanupError = error;
      } finally {
        if (!workerRan) await worker.runUntil(Promise.resolve());
      }
    }
    if (cleanupError) throw cleanupError;
  }, 45_000);
});
