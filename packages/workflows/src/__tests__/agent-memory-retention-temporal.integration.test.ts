import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import type { WorkflowHandleWithStartDetails } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { okResult } from '../shared/types.js';
import { executeProviderHttp } from '@tixkit/provider-clients';
import { holdExpirationWorkflow } from '../workflows/hold-expiration.js';

const temporalAddress = process.env.TEMPORAL_ADDRESS;
const describeWithTemporal = temporalAddress ? describe : describe.skip;

describeWithTemporal('agent memory retention on Temporal', () => {
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

  it('retries a failed retention activity and replays the successful durable history', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const taskQueue = `agent-memory-retention-proof-${suffix}`;
    const workflowId = `agent-memory-retention-proof:${suffix}`;
    const attempts: number[] = [];
    const exactProviderRequestId = `req_temporal_local_${suffix}`;
    const capturedRequestIds: string[] = [];
    const workflowsPath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue,
      workflowsPath,
      activities: {
        async expireStaleHoldsActivity() {
          return okResult({ expiredCount: 0 });
        },
        async expireStaleSessionsActivity() {
          return okResult({ expiredCount: 0 });
        },
        async processWaitlistOffersActivity() {
          return okResult({ expiredCount: 0, offeredCount: 0, queuedEmailCount: 0 });
        },
        async recoverQueuedMessageHandoffsActivity() {
          return okResult({ recoveredEmailCount: 0, recoveredSmsCount: 0 });
        },
        async enforcePrivacyRetentionActivity() {
          return okResult({ inspectedCount: 0, repairedCount: 0, skippedCount: 0 });
        },
        async cleanupMigrationMediaObjectsActivity() {
          return okResult({ completed: 0, retained: 0, failed: 0 });
        },
        async eraseExpiredAgentMemoryActivity() {
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          if (attempt === 1) throw new Error('TRANSIENT_AGENT_MEMORY_RETENTION_FAILURE');
          return { erasedCount: 1 };
        },
        async eraseExpiredProviderIncidentEvidenceActivity() {
          await executeProviderHttp({
            dependency: 'temporal-provider-proof',
            operation: 'read-safe-proof',
            method: 'GET',
            url: 'https://provider.test/proof',
            incidentScope: { tenantId: 'tenant_01', organizationId: 'org_01' },
            onExactRequestId: (event) => {
              capturedRequestIds.push(event.exactRequestId);
            },
            fetch: async () =>
              Response.json({ ok: true }, { headers: { 'request-id': exactProviderRequestId } }),
            parse: (value) => value as { ok: boolean },
          });
          return { erasedCount: 0 };
        },
      },
    });
    let handle: WorkflowHandleWithStartDetails<typeof holdExpirationWorkflow> | undefined;
    try {
      handle = await environment.client.workflow.start(holdExpirationWorkflow, {
        taskQueue,
        workflowId,
        workflowExecutionTimeout: '30 seconds',
        args: [{ maxIterations: 1 }],
      });
      await worker.runUntil(() => handle!.result(), { promiseCompletionTimeout: '30 seconds' });
      expect(attempts).toEqual([1, 2]);
      const history = await handle.fetchHistory();
      expect(capturedRequestIds).toEqual([exactProviderRequestId]);
      expect(JSON.stringify(history)).not.toContain(exactProviderRequestId);
      await expect(
        Worker.runReplayHistory({ workflowsPath }, history, workflowId),
      ).resolves.toBeUndefined();
    } finally {
      await environment.connection.workflowService.deleteWorkflowExecution({
        namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
        workflowExecution: {
          workflowId,
          ...(handle ? { runId: handle.firstExecutionRunId } : {}),
        },
      });
    }
  });
});
