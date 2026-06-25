import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { reconcilePaymentActivity, reconcileRefundActivity, reconcileDisputeActivity, emitDomainEventActivity } = proxyActivities<{
  reconcilePaymentActivity(input: { providerEventId: string; provider: string; eventType: string; data: Record<string, unknown> }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  reconcileRefundActivity(input: { providerEventId: string; provider: string; data: Record<string, unknown> }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  reconcileDisputeActivity(input: { providerEventId: string; provider: string; data: Record<string, unknown> }): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>>;
  emitDomainEventActivity(input: { orderId: string; eventType: string }): Promise<WorkflowActivityResult<{ emitted: boolean }>>;
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

export async function paymentReconciliationWorkflow(input: PaymentReconciliationWorkflowInput): Promise<{ status: string }> {
  let result;

  if (input.eventType.includes('refund')) {
    result = await reconcileRefundActivity({
      providerEventId: input.providerEventId,
      provider: input.provider,
      data: input.data,
    });
  } else if (input.eventType.includes('dispute')) {
    result = await reconcileDisputeActivity({
      providerEventId: input.providerEventId,
      provider: input.provider,
      data: input.data,
    });
  } else {
    result = await reconcilePaymentActivity({
      providerEventId: input.providerEventId,
      provider: input.provider,
      eventType: input.eventType,
      data: input.data,
    });
  }

  if (!result.ok) {
    return { status: 'failed' };
  }

  // Emit domain event if order was affected
  if (result.value.orderId) {
    await emitDomainEventActivity({
      orderId: result.value.orderId,
      eventType: input.eventType,
    });
  }

  return { status: result.value.status };
}
