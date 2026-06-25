import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { expireStaleHoldsActivity, expireStaleSessionsActivity } = proxyActivities<{
  expireStaleHoldsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>>;
  expireStaleSessionsActivity(): Promise<WorkflowActivityResult<{ expiredCount: number }>>;
}>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export type HoldExpirationWorkflowInput = {
  version: number;
  tickIntervalSeconds?: number;
};

export async function holdExpirationWorkflow(input: HoldExpirationWorkflowInput): Promise<void> {
  // Version is accepted for contract consistency with other workflows. The value
  // is intentionally not branched on so replays stay deterministic across versions;
  // future schema changes should introduce new versions and gated migrations instead.
  const tickIntervalSeconds = input.tickIntervalSeconds ?? 60;
  // This is a long-running workflow that periodically expires stale holds
  while (true) {
    await expireStaleHoldsActivity();
    await expireStaleSessionsActivity();
    await sleep(`${tickIntervalSeconds} seconds`);
  }
}
