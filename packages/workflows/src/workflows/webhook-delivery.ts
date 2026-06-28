import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { deliverWebhookActivity } = proxyActivities<{
  deliverWebhookActivity(input: {
    apiVersion?: string;
    endpointId: string;
    eventId: string;
    eventType?: string;
    payload: string;
    attempt: number;
    finalAttempt: boolean;
  }): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export type WebhookDeliveryWorkflowInput = {
  version: number;
  apiVersion?: string;
  endpointId: string;
  eventId: string;
  eventType?: string;
  replayNonce?: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
};

export async function webhookDeliveryWorkflow(
  input: WebhookDeliveryWorkflowInput,
): Promise<{ status: string }> {
  const payloadStr = JSON.stringify(input.payload);

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- webhook retries must observe each attempt result before deciding whether to back off or dead-letter.
    const result = await deliverWebhookActivity({
      apiVersion: input.apiVersion,
      endpointId: input.endpointId,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: payloadStr,
      attempt,
      finalAttempt: attempt === input.maxAttempts,
    });

    if (result.ok && result.value.statusCode >= 200 && result.value.statusCode < 300) {
      return { status: 'delivered' };
    }

    if (attempt < input.maxAttempts) {
      // Exponential backoff: 5s, 10s, 20s, 40s...
      // eslint-disable-next-line no-await-in-loop -- retry backoff is intentionally sequential in workflow history.
      await sleep(`${5 * Math.pow(2, attempt - 1)} seconds`);
    }
  }

  return { status: 'dead_lettered' };
}
