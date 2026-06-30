import { proxyActivities, sleep, startChild } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';
import { WEBHOOK_DELIVERY_WORKFLOW_VERSION, webhookDeliveryWorkflowId } from '../shared/types.js';
import { webhookDeliveryWorkflow } from './webhook-delivery.js';

type ReconciledOrderWebhookEvent = {
  tenantId: string;
  organizationId: string;
  eventId: string;
  orderId: string;
  checkoutSessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
};

type ReconciliationActivityValue = {
  orderId?: string;
  status: string;
  webhookEvent?: ReconciledOrderWebhookEvent;
};

const {
  reconcilePaymentActivity,
  reconcileRefundActivity,
  reconcileDisputeActivity,
  emitWebhookEventActivity,
  markProviderEventProcessedActivity,
} = proxyActivities<{
  reconcilePaymentActivity(input: {
    providerEventId: string;
    provider: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<ReconciliationActivityValue>>;
  reconcileRefundActivity(input: {
    providerEventId: string;
    provider: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<ReconciliationActivityValue>>;
  reconcileDisputeActivity(input: {
    providerEventId: string;
    provider: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<ReconciliationActivityValue>>;
  emitWebhookEventActivity(input: {
    tenantId: string;
    organizationId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<
    WorkflowActivityResult<{
      eventId: string;
      deliveries: { endpointId: string; eventId: string; url: string }[];
    }>
  >;
  markProviderEventProcessedActivity(input: {
    provider: string;
    providerEventId: string;
  }): Promise<WorkflowActivityResult<{ processed: boolean }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

export type PaymentReconciliationWorkflowInput = {
  version: number;
  providerEventId: string;
  provider: string;
  eventType: string;
  data: Record<string, unknown>;
};

type ReconciliationResult = WorkflowActivityResult<ReconciliationActivityValue>;

const PAYMENT_RECONCILIATION_BOUNDED_RETRY_VERSION = 2;
const RECONCILIATION_MAX_ATTEMPTS = 5;
const RECONCILIATION_RETRY_DELAY = '5 seconds';
const CLOSEABLE_COMPENSATION_STATUSES = new Set([
  'compensated:succeeded',
  'compensated:already_ordered',
]);

async function runReconciliationActivity(
  input: PaymentReconciliationWorkflowInput,
): Promise<ReconciliationResult> {
  if (input.eventType.includes('refund')) {
    return reconcileRefundActivity({
      providerEventId: input.providerEventId,
      provider: input.provider,
      eventType: input.eventType,
      data: input.data,
    });
  }

  if (input.eventType.includes('dispute')) {
    return reconcileDisputeActivity({
      providerEventId: input.providerEventId,
      provider: input.provider,
      data: input.data,
    });
  }

  return reconcilePaymentActivity({
    providerEventId: input.providerEventId,
    provider: input.provider,
    eventType: input.eventType,
    data: input.data,
  });
}

async function reconcileWithBoundedRetry(
  input: PaymentReconciliationWorkflowInput,
): Promise<ReconciliationResult> {
  let attempt = 1;

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- retries must be sequential and durable.
    const result = await runReconciliationActivity(input);
    if (result.ok || !result.retryable) {
      return result;
    }

    if (attempt >= RECONCILIATION_MAX_ATTEMPTS) {
      throw new Error(
        `Payment reconciliation failed (${result.errorCode}): ${result.message} (attempts exhausted after ${attempt} attempts)`,
      );
    }

    // eslint-disable-next-line no-await-in-loop -- Temporal sleep records the retry boundary.
    await sleep(RECONCILIATION_RETRY_DELAY);
    attempt += 1;
  }
}

export async function paymentReconciliationWorkflow(
  input: PaymentReconciliationWorkflowInput,
): Promise<{ status: string }> {
  const result =
    input.version >= PAYMENT_RECONCILIATION_BOUNDED_RETRY_VERSION
      ? await reconcileWithBoundedRetry(input)
      : await runReconciliationActivity(input);

  if (!result.ok) {
    if (result.retryable) {
      throw new Error(`Payment reconciliation failed (${result.errorCode}): ${result.message}`);
    }
    return { status: 'failed' };
  }

  if (
    result.value.status.startsWith('compensated:') &&
    !CLOSEABLE_COMPENSATION_STATUSES.has(result.value.status)
  ) {
    throw new Error(
      `Payment reconciliation compensation blocked with status ${result.value.status}`,
    );
  }

  if (result.value.webhookEvent) {
    const webhookEvent = result.value.webhookEvent;
    const webhookEventResult = await emitWebhookEventActivity({
      tenantId: webhookEvent.tenantId,
      organizationId: webhookEvent.organizationId,
      eventType: webhookEvent.eventType,
      payload: webhookEvent.payload,
    });
    if (!webhookEventResult.ok) {
      if (webhookEventResult.retryable) {
        throw new Error(
          `Payment reconciliation webhook event failed (${webhookEventResult.errorCode}): ${webhookEventResult.message}`,
        );
      }
      return { status: 'failed' };
    }

    if (webhookEventResult.value.deliveries.length > 0) {
      await Promise.all(
        webhookEventResult.value.deliveries.map((delivery) =>
          startChild(webhookDeliveryWorkflow, {
            workflowId: webhookDeliveryWorkflowId(delivery.eventId, delivery.endpointId),
            args: [
              {
                version: WEBHOOK_DELIVERY_WORKFLOW_VERSION,
                endpointId: delivery.endpointId,
                eventId: delivery.eventId,
                eventType: webhookEvent.eventType,
                payload: webhookEvent.payload,
                maxAttempts: 5,
              },
            ],
          }),
        ),
      );
    }
  }

  const markProcessedResult = await markProviderEventProcessedActivity({
    provider: input.provider,
    providerEventId: input.providerEventId,
  });
  if (!markProcessedResult.ok) {
    if (markProcessedResult.retryable) {
      throw new Error(
        `Payment provider event mark-processed failed (${markProcessedResult.errorCode}): ${markProcessedResult.message}`,
      );
    }
    return { status: 'failed' };
  }

  return { status: result.value.status };
}
