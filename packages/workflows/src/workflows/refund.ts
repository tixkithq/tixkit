import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  processRefundActivity,
  updateLedgerActivity,
  voidTicketsActivity,
  restoreInventoryActivity,
  notifyRefundActivity,
} = proxyActivities<{
  processRefundActivity(input: { orderId: string; amountCents: number; reason: string; idempotencyKey?: string; nonce: string }): Promise<WorkflowActivityResult<{ providerRefundId: string; status: string }>>;
  updateLedgerActivity(input: { orderId: string; refundAmountCents: number; providerRefundId: string }): Promise<WorkflowActivityResult<{ balanced: boolean }>>;
  voidTicketsActivity(input: { orderId: string; amountCents: number; isFullRefund: boolean; providerRefundId?: string }): Promise<WorkflowActivityResult<{ voidedCount: number; voidedTicketIds: string[] }>>;
  restoreInventoryActivity(input: { orderId: string; amountCents: number; isFullRefund: boolean; providerRefundId?: string; voidedTicketIds?: string[] }): Promise<WorkflowActivityResult<{ restored: number }>>;
  notifyRefundActivity(input: { orderId: string; toEmail: string; tenantId: string; brandId: string; providerRefundId?: string }): Promise<WorkflowActivityResult<{ notified: boolean; jobId?: string }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

export type RefundWorkflowInput = {
  version: number;
  orderId: string;
  amountCents: number;
  reason: string;
  buyerEmail: string;
  voidTickets: boolean;
  restoreInventory?: boolean;
  idempotencyKey?: string;
  tenantId?: string;
  brandId?: string;
  orderTotalCents?: number;
  alreadyRefundedCents?: number;
  nonce: string;
};

export async function refundWorkflow(input: RefundWorkflowInput): Promise<{ status: string }> {
  // Determine if this is a full refund (amount covers remaining refundable balance).
  const orderTotal = input.orderTotalCents;
  const alreadyRefunded = input.alreadyRefundedCents ?? 0;
  const refundableBalance = orderTotal === undefined ? undefined : orderTotal - alreadyRefunded;
  const isFullRefund = refundableBalance !== undefined && input.amountCents >= refundableBalance;

  // Step 1: Process refund with provider
  const refundResult = await processRefundActivity({
    orderId: input.orderId,
    amountCents: input.amountCents,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    nonce: input.nonce,
  });

  if (!refundResult.ok) {
    return { status: 'failed' };
  }

  // Step 2: Update ledger
  await updateLedgerActivity({
    orderId: input.orderId,
    refundAmountCents: input.amountCents,
    providerRefundId: refundResult.value.providerRefundId,
  });

  // Step 3: Void tickets if configured (proportional to refund amount)
  let voidedTicketIds: string[] = [];
  if (input.voidTickets) {
    const voidResult = await voidTicketsActivity({
      orderId: input.orderId,
      amountCents: input.amountCents,
      isFullRefund,
      providerRefundId: refundResult.value.providerRefundId,
    });
    if (voidResult.ok) {
      voidedTicketIds = voidResult.value.voidedTicketIds;
    }
  }

  // Step 3b: Restore inventory only when explicitly configured (proportional)
  if (input.restoreInventory) {
    await restoreInventoryActivity({
      orderId: input.orderId,
      amountCents: input.amountCents,
      isFullRefund,
      providerRefundId: refundResult.value.providerRefundId,
      voidedTicketIds,
    });
  }

  // Step 4: Notify buyer
  await notifyRefundActivity({
    orderId: input.orderId,
    toEmail: input.buyerEmail,
    tenantId: input.tenantId ?? '',
    brandId: input.brandId ?? '',
    providerRefundId: refundResult.ok ? refundResult.value.providerRefundId : undefined,
  });

  return { status: 'completed' };
}
