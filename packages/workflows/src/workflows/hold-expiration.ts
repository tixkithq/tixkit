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

export async function holdExpirationWorkflow(): Promise<void> {
  // This is a long-running workflow that periodically expires stale holds
  while (true) {
    await expireStaleHoldsActivity();
    await expireStaleSessionsActivity();
    await sleep('60 seconds');
  }
}
