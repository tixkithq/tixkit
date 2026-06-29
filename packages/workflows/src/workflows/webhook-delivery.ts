import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { deliverWebhookActivity } = proxyActivities<{
  deliverWebhookActivity(input: {
    apiVersion?: string;
    endpointId: string;
    eventId: string;
    eventType?: string;
    replayNonce?: string;
    payload: string;
    attempt: number;
    finalAttempt: boolean;
  }): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 1,
  },
});

const WEBHOOK_IN_PROGRESS_RECHECK_LIMIT = 12;

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
  let inProgressRechecks = 0;

  for (let attempt = 1; attempt <= input.maxAttempts; ) {
    // eslint-disable-next-line no-await-in-loop -- webhook retries must observe each attempt result before deciding whether to back off or dead-letter.
    const result = await deliverWebhookActivity({
      apiVersion: input.apiVersion,
      endpointId: input.endpointId,
      eventId: input.eventId,
      eventType: input.eventType,
      ...(input.replayNonce ? { replayNonce: input.replayNonce } : {}),
      payload: payloadStr,
      attempt,
      finalAttempt: attempt === input.maxAttempts,
    });

    if (result.ok && result.value.statusCode >= 200 && result.value.statusCode < 300) {
      return { status: 'delivered' };
    }

    if (!result.ok && !result.retryable) {
      return { status: 'dead_lettered' };
    }

    if (!result.ok && result.errorCode === 'WEBHOOK_DELIVERY_IN_PROGRESS') {
      inProgressRechecks += 1;
      if (inProgressRechecks > WEBHOOK_IN_PROGRESS_RECHECK_LIMIT) {
        throw new Error(
          `Webhook delivery attempt remained in progress (${result.errorCode}): ${result.message}`,
        );
      }
      // eslint-disable-next-line no-await-in-loop -- rechecking an active lease must not advance the logical webhook attempt.
      await sleep('5 seconds');
      continue;
    }

    inProgressRechecks = 0;
    if (attempt < input.maxAttempts) {
      // Exponential backoff: 5s, 10s, 20s, 40s...
      // eslint-disable-next-line no-await-in-loop -- retry backoff is intentionally sequential in workflow history.
      await sleep(`${5 * Math.pow(2, attempt - 1)} seconds`);
      attempt += 1;
    } else if (!result.ok && result.retryable) {
      throw new Error(
        `Webhook delivery final attempt remained retryable (${result.errorCode}): ${result.message}`,
      );
    } else {
      attempt += 1;
    }
  }

  return { status: 'dead_lettered' };
}
