import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { deliverWebhookActivity } = proxyActivities<{
  deliverWebhookActivity(input: { endpointId: string; eventId: string; payload: string; secret: string; attempt: number }): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>>;
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
  endpointId: string;
  eventId: string;
  payload: Record<string, unknown>;
  secret: string;
  maxAttempts: number;
};

export async function webhookDeliveryWorkflow(input: WebhookDeliveryWorkflowInput): Promise<{ status: string }> {
  const payloadStr = JSON.stringify(input.payload);

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const result = await deliverWebhookActivity({
      endpointId: input.endpointId,
      eventId: input.eventId,
      payload: payloadStr,
      secret: input.secret,
      attempt,
    });

    if (result.ok && result.value.statusCode >= 200 && result.value.statusCode < 300) {
      return { status: 'delivered' };
    }

    if (attempt < input.maxAttempts) {
      // Exponential backoff: 5s, 10s, 20s, 40s...
      await sleep(`${5 * Math.pow(2, attempt - 1)} seconds`);
    }
  }

  return { status: 'dead_lettered' };
}
