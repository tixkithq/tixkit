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

  it('continues on a replacement worker after the first worker drains between activities', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const taskQueue = `migration-worker-restart-proof-${suffix}`;
    const workflowId = `migration-worker-restart-proof:${suffix}`;
    const workflowsPath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
    let releaseBegin!: () => void;
    let markBeginStarted!: () => void;
    let firstBeginCalls = 0;
    let firstBeginCompletions = 0;
    let firstStageCalls = 0;
    const beginRelease = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    const beginStarted = new Promise<void>((resolve) => {
      markBeginStarted = resolve;
    });
    const firstWorker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue,
      workflowsPath,
      shutdownGraceTime: '5 seconds',
      maxCachedWorkflows: 0,
      activities: {
        async beginMigrationCommitActivity() {
          firstBeginCalls += 1;
          markBeginStarted();
          await beginRelease;
          firstBeginCompletions += 1;
        },
        async processMigrationStageActivity() {
          firstStageCalls += 1;
          throw new Error('DRAINED_WORKER_MUST_NOT_PROCESS_A_STAGE');
        },
        async recordMigrationProgressActivity() {},
        async setMigrationPausedActivity() {},
        async cancelMigrationCommitActivity() {},
        async reconcileMigrationActivity() {
          throw new Error('DRAINED_WORKER_MUST_NOT_RECONCILE');
        },
        async assessMigrationRollbackActivity() {
          throw new Error('DRAINED_WORKER_MUST_NOT_ASSESS_ROLLBACK');
        },
        async executeMigrationRollbackActivity() {
          throw new Error('DRAINED_WORKER_MUST_NOT_ROLL_BACK');
        },
        async completeMigrationCommitActivity() {
          throw new Error('DRAINED_WORKER_MUST_NOT_COMPLETE');
        },
        async failMigrationCommitActivity() {
          throw new Error('DRAINED_WORKER_MUST_NOT_RECORD_FAILURE');
        },
      },
    });
    let handle: WorkflowHandleWithStartDetails<typeof migrationCommitWorkflow> | undefined;
    let firstWorkerRun: Promise<void> | undefined;
    let replacementWorker: Worker | undefined;
    let replacementWorkerRan = false;
    let cleanupError: unknown;
    try {
      handle = await environment.client.workflow.start(migrationCommitWorkflow, {
        taskQueue,
        workflowId,
        workflowExecutionTimeout: '30 seconds',
        args: [
          {
            version: 1,
            tenantId: 'tenant_worker_restart_proof',
            organizationId: 'organization_worker_restart_proof',
            jobId: `job_worker_restart_proof_${suffix}`,
            chunkSize: 100,
          },
        ],
      });
      firstWorkerRun = firstWorker.run();
      let beginTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          beginStarted,
          new Promise<never>((_, reject) => {
            beginTimeout = setTimeout(
              () => reject(new Error('FIRST_WORKER_DID_NOT_START_BEGIN_ACTIVITY')),
              10_000,
            );
          }),
        ]);
      } finally {
        if (beginTimeout) clearTimeout(beginTimeout);
      }
      firstWorker.shutdown();
      releaseBegin();
      await firstWorkerRun;
      expect(firstBeginCalls).toBe(1);
      expect(firstBeginCompletions).toBe(1);
      expect(firstStageCalls).toBe(0);

      const stageCalls: MigrationCommitStage[] = [];
      let replacementBeginCalls = 0;
      replacementWorker = await Worker.create({
        connection: environment.nativeConnection,
        namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
        taskQueue,
        workflowsPath,
        activities: {
          async beginMigrationCommitActivity() {
            replacementBeginCalls += 1;
          },
          async processMigrationStageActivity(input: { stage: MigrationCommitStage }) {
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
          async completeMigrationCommitActivity() {},
          async failMigrationCommitActivity() {},
        },
      });
      replacementWorkerRan = true;
      const result = await replacementWorker.runUntil(() => handle!.result(), {
        promiseCompletionTimeout: '5 seconds',
      });
      expect(result.status).toBe('completed');
      expect(result.progress.processed).toBe(MIGRATION_COMMIT_STAGES.length);
      expect(firstBeginCalls).toBe(1);
      expect(firstBeginCompletions).toBe(1);
      expect(firstStageCalls).toBe(0);
      expect(replacementBeginCalls).toBe(0);
      expect(stageCalls).toEqual(MIGRATION_COMMIT_STAGES);
    } finally {
      releaseBegin();
      try {
        if (firstWorker.getState() === 'INITIALIZED') {
          await firstWorker.runUntil(Promise.resolve());
        } else if (firstWorker.getState() === 'RUNNING') {
          firstWorker.shutdown();
        }
        if (firstWorkerRun) await firstWorkerRun;
      } catch (error) {
        cleanupError = error;
      }
      try {
        if (replacementWorker && !replacementWorkerRan) {
          await replacementWorker.runUntil(Promise.resolve());
        }
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await environment.connection.workflowService.deleteWorkflowExecution({
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          workflowExecution: {
            workflowId,
            ...(handle ? { runId: handle.firstExecutionRunId } : {}),
          },
        });
      } catch (error) {
        if (handle) cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
  }, 45_000);
});
