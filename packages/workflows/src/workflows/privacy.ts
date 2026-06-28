import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { processPrivacyRequestActivity } = proxyActivities<{
  processPrivacyRequestActivity(input: {
    requestId: string;
  }): Promise<WorkflowActivityResult<{ requestId: string; status: string }>>;
}>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

export type PrivacyRequestWorkflowInput = {
  version: number;
  requestId: string;
};

export async function privacyRequestWorkflow(
  input: PrivacyRequestWorkflowInput,
): Promise<{ status: string }> {
  const result = await processPrivacyRequestActivity({ requestId: input.requestId });
  return { status: result.ok ? result.value.status : 'failed' };
}
