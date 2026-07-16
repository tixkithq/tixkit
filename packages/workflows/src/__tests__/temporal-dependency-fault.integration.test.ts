import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import { MIGRATION_COMMIT_STAGES, type MigrationCommitStage } from '../activities/migration.js';
import { migrationCommitWorkflow } from '../workflows/migration.js';

const metricsPath = process.env.TEMPORAL_FAULT_METRICS_PATH;
const describeFault = metricsPath ? describe : describe.skip;
const workflowCount = Number.parseInt(process.env.TEMPORAL_FAULT_WORKFLOW_COUNT ?? '0', 10);
const readyPath = process.env.TEMPORAL_FAULT_READY_PATH;
const startPath = process.env.TEMPORAL_FAULT_START_PATH;
const recoveryPath = process.env.TEMPORAL_FAULT_RECOVERY_PATH;
const faultNonce = process.env.TEMPORAL_FAULT_NONCE;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((entry) => JSON.parse(canonical(entry))));
  if (value && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, JSON.parse(canonical(entry))]),
      ),
    );
  }
  return JSON.stringify(value);
}

type FaultMarker = { token: string; nonce: string; sequence: number; observedAt: string };

function markerBytes(marker: FaultMarker): string {
  return `${JSON.stringify(marker)}\n`;
}

async function waitForMarker(
  file: string,
  token: string,
  sequence: number,
): Promise<{ marker: FaultMarker; bytes: string }> {
  const deadline = Date.now() + 90_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('TEMPORAL_FAULT_START_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stat = lstatSync(file);
  expect(stat.isFile()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  expect(stat.mode & 0o777).toBe(0o600);
  const bytes = readFileSync(file, 'utf8');
  const marker = JSON.parse(bytes) as FaultMarker;
  expect(Object.keys(marker).sort()).toEqual(['nonce', 'observedAt', 'sequence', 'token']);
  expect(marker).toMatchObject({ token, nonce: faultNonce, sequence });
  expect(Number.isFinite(Date.parse(marker.observedAt))).toBe(true);
  expect(bytes).toBe(markerBytes(marker));
  return { marker, bytes };
}

describeFault('Temporal service dependency fault', () => {
  it('recovers concurrent durable workflows with ordered idempotent effects and replayable histories', async () => {
    expect(workflowCount).toBe(16);
    expect(readyPath).toBeTruthy();
    expect(startPath).toBeTruthy();
    expect(recoveryPath).toBeTruthy();
    expect(faultNonce).toMatch(/^[a-f0-9]{64}$/);
    const environment = await TestWorkflowEnvironment.createFromExistingServer({
      address: process.env.TEMPORAL_ADDRESS!,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const taskQueue = `temporal-fault-${suffix}`;
    const workflowsPath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
    const logicalEffects = new Map<string, Set<string>>();
    const attempts = new Map<string, number>();
    const stageOrder = new Map<string, MigrationCommitStage[]>();
    let readyEffects = 0;
    let readyMarker: FaultMarker | undefined;
    let startObservation: { marker: FaultMarker; bytes: string } | undefined;
    let recoveryObservation: { marker: FaultMarker; bytes: string } | undefined;
    let recoveryPromise: Promise<{ marker: FaultMarker; bytes: string }> | undefined;

    const record = (jobId: string, effect: string): boolean => {
      attempts.set(jobId, (attempts.get(jobId) ?? 0) + 1);
      const effects = logicalEffects.get(jobId) ?? new Set<string>();
      logicalEffects.set(jobId, effects);
      if (effects.has(effect)) return false;
      effects.add(effect);
      return true;
    };

    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue,
      workflowsPath,
      maxCachedWorkflows: 0,
      activities: {
        async beginMigrationCommitActivity(input: { jobId: string }) {
          Context.current();
          if (record(input.jobId, 'begin')) {
            readyEffects += 1;
            if (readyEffects === workflowCount) {
              readyMarker = {
                token: 'workload-ready-v1',
                nonce: faultNonce!,
                sequence: 1,
                observedAt: new Date().toISOString(),
              };
              writeFileSync(readyPath!, markerBytes(readyMarker), {
                flag: 'wx',
                mode: 0o600,
              });
            }
          }
          startObservation ??= await waitForMarker(startPath!, 'fault-start-v1', 2);
        },
        async processMigrationStageActivity(input: { jobId: string; stage: MigrationCommitStage }) {
          if (record(input.jobId, `stage:${input.stage}`)) {
            const order = stageOrder.get(input.jobId) ?? [];
            order.push(input.stage);
            stageOrder.set(input.jobId, order);
          }
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
        async recordMigrationProgressActivity(input: {
          jobId: string;
          stage: MigrationCommitStage;
        }) {
          record(input.jobId, `progress:${input.stage}`);
        },
        async setMigrationPausedActivity(input: { jobId: string }) {
          record(input.jobId, 'unexpected:pause');
        },
        async cancelMigrationCommitActivity(input: { jobId: string }) {
          record(input.jobId, 'unexpected:cancel');
        },
        async reconcileMigrationActivity(input: { jobId: string }) {
          record(input.jobId, 'reconcile');
          return { repaired: 0, unresolved: 0 };
        },
        async assessMigrationRollbackActivity(input: { jobId: string }) {
          record(input.jobId, 'unexpected:assess-rollback');
          return {
            eligible: false as const,
            mode: 'corrective_plan' as const,
            reasons: ['not requested'],
            correctivePlanId: 'not_requested',
          };
        },
        async executeMigrationRollbackActivity(input: { jobId: string }) {
          record(input.jobId, 'unexpected:rollback');
          return { deleted: 0 };
        },
        async completeMigrationCommitActivity(input: { jobId: string }) {
          recoveryPromise ??= waitForMarker(recoveryPath!, 'recovery-ready-v1', 3);
          recoveryObservation ??= await recoveryPromise;
          record(input.jobId, 'complete');
        },
        async failMigrationCommitActivity(input: { jobId: string }) {
          record(input.jobId, 'unexpected:failure');
        },
      },
    });

    const workerRun = worker.run();
    const handles = await Promise.all(
      Array.from({ length: workflowCount }, (_, index) =>
        environment.client.workflow.start(migrationCommitWorkflow, {
          taskQueue,
          workflowId: `temporal-fault:${suffix}:${index}`,
          workflowExecutionTimeout: '3 minutes',
          args: [
            {
              version: 1,
              tenantId: 'tenant_temporal_fault',
              organizationId: 'organization_temporal_fault',
              jobId: `job_temporal_fault_${suffix}_${index}`,
              chunkSize: 100,
            },
          ],
        }),
      ),
    );

    const workflowEvidence: Array<Record<string, unknown>> = [];
    let cleanupError: unknown;
    try {
      const results = await Promise.all(handles.map((handle) => handle.result()));
      expect(readyMarker).toBeDefined();
      expect(startObservation).toBeDefined();
      expect(recoveryObservation).toBeDefined();
      for (const [index, handle] of handles.entries()) {
        const result = results[index]!;
        expect(result.status).toBe('completed');
        const jobId = `job_temporal_fault_${suffix}_${index}`;
        expect(stageOrder.get(jobId)).toEqual(MIGRATION_COMMIT_STAGES);
        const effects = logicalEffects.get(jobId)!;
        expect([...effects].some((effect) => effect.startsWith('unexpected:'))).toBe(false);
        const history = await handle.fetchHistory();
        await expect(
          Worker.runReplayHistory({ workflowsPath }, history, handle.workflowId),
        ).resolves.toBeUndefined();
        workflowEvidence.push({
          workflowIdSha256: sha256(handle.workflowId),
          runIdSha256: sha256(handle.firstExecutionRunId),
          status: result.status,
          stageOrderSha256: sha256(canonical(MIGRATION_COMMIT_STAGES)),
          activityAttempts: attempts.get(jobId),
          logicalEffects: effects.size,
          reconciliationEffects: effects.has('reconcile') ? 1 : 0,
          completionEffects: effects.has('complete') ? 1 : 0,
          failureEffects: effects.has('unexpected:failure') ? 1 : 0,
          historySha256: sha256(canonical(history)),
          replayVerified: true,
        });
      }
      const expectedLogicalEffectsPerWorkflow = 3 + MIGRATION_COMMIT_STAGES.length * 2;
      expect(
        workflowEvidence.every(
          (entry) => entry.logicalEffects === expectedLogicalEffectsPerWorkflow,
        ),
      ).toBe(true);
      writeFileSync(
        metricsPath!,
        `${JSON.stringify(
          {
            schemaVersion: 'tixkit-temporal-fault-raw-v1',
            namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
            taskQueueSha256: sha256(taskQueue),
            workflowCount,
            completedCount: workflowCount,
            failedCount: 0,
            openCount: 0,
            timedOutCount: 0,
            cancelledCount: 0,
            terminatedCount: 0,
            expectedLogicalEffectsPerWorkflow,
            protocol: {
              nonceSha256: sha256(faultNonce!),
              readyMarkerSha256: sha256(markerBytes(readyMarker!)),
              startMarkerSha256: sha256(startObservation!.bytes),
              recoveryMarkerSha256: sha256(recoveryObservation!.bytes),
              readyObservedAt: readyMarker!.observedAt,
              startObservedAt: startObservation!.marker.observedAt,
              recoveryObservedAt: recoveryObservation!.marker.observedAt,
              sequence: ['workload-ready', 'fault-start', 'recovery-ready', 'workload-complete'],
            },
            workflows: workflowEvidence,
          },
          null,
          2,
        )}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    } finally {
      worker.shutdown();
      await workerRun;
      for (const handle of handles) {
        try {
          await environment.connection.workflowService.deleteWorkflowExecution({
            namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
            workflowExecution: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId },
          });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      await environment.teardown();
    }
    if (cleanupError) throw cleanupError;
  }, 210_000);
});
