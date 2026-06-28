import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  reconcilePaymentActivity,
  reconcileRefundActivity,
  reconcileDisputeActivity,
  emitDomainEventActivity,
  markProviderEventProcessedActivity,
} = proxyActivities<{
  reconcilePaymentActivity(input: {
    providerEventId: string;
    provider: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  reconcileRefundActivity(input: {
    providerEventId: string;
    provider: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  reconcileDisputeActivity(input: {
    providerEventId: string;
    provider: string;
    data: Record<string, unknown>;
  }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  emitDomainEventActivity(input: {
    orderId: string;
    eventType: string;
  }): Promise<WorkflowActivityResult<{ emitted: boolean }>>;
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

type ReconciliationResult = WorkflowActivityResult<{ orderId?: string; status: string }>;

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

  // Emit domain event if order was affected
  if (result.value.orderId) {
    const domainEventResult = await emitDomainEventActivity({
      orderId: result.value.orderId,
      eventType: input.eventType,
    });
    if (!domainEventResult.ok) {
      if (domainEventResult.retryable) {
        throw new Error(
          `Payment reconciliation domain event failed (${domainEventResult.errorCode}): ${domainEventResult.message}`,
        );
      }
      return { status: 'failed' };
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
