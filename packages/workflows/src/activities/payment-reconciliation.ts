import { createDb } from '@gatekit/db';
import { PaymentIntentRepository, OrderRepository, RefundRepository } from '@gatekit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

export async function reconcilePaymentActivity(input: {
  providerEventId: string;
  provider: string;
  eventType: string;
  data: Record<string, unknown>;
}): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>> {
  const db = createDb();
  try {
    const paymentIntent = input.data as {
      id: string;
      status: string;
      amount?: number;
      metadata?: Record<string, string>;
    };
    const providerIntentId = paymentIntent.id;

    const piRepo = new PaymentIntentRepository(db);
    const orderRepo = new OrderRepository(db);
    const dbPi = await piRepo.findByProviderIntentId(providerIntentId);
    if (!dbPi) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

	    await piRepo.update(dbPi.id, { status: paymentIntent.status });

	    if (dbPi.order_id) {
	      const order = await orderRepo.findById(dbPi.order_id);
	      if (order && isSuccessfulPaymentEvent(input.eventType, paymentIntent.status) && order.status !== 'paid') {
	        await orderRepo.update(dbPi.order_id, { status: 'paid', paid_at: new Date() });
	        await orderRepo.addTimelineEvent(dbPi.order_id, 'order.paid', 'Payment confirmed via Stripe');
	        return okResult({ orderId: dbPi.order_id, status: 'paid' });
	      }
	      if (order && isFailedPaymentEvent(input.eventType, paymentIntent.status)) {
	        await orderRepo.addTimelineEvent(dbPi.order_id, 'payment.failed', 'Payment failed via Stripe');
	      }
	      return okResult({ orderId: dbPi.order_id, status: paymentIntent.status });
	    }

    return okResult({ orderId: undefined, status: paymentIntent.status });
  } catch (err) {
    return errResult('PAYMENT_RECONCILE_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
	  } finally {
	    await db.destroy();
	  }
	}

function isSuccessfulPaymentEvent(eventType: string, status: string): boolean {
  return (
    eventType === 'payment_intent.succeeded' ||
    eventType === 'charge.succeeded' ||
    status === 'succeeded'
  );
}

function isFailedPaymentEvent(eventType: string, status: string): boolean {
  return (
    eventType === 'payment_intent.payment_failed' ||
    eventType === 'payment_intent.canceled' ||
    status === 'requires_payment_method' ||
    status === 'canceled'
  );
}

export async function reconcileRefundActivity(input: {
  providerEventId: string;
  provider: string;
  data: Record<string, unknown>;
}): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>> {
  const db = createDb();
  try {
    const refundOrCharge = input.data as {
      id: string;
      payment_intent?: string | { id: string } | null;
      amount?: number;
      amount_refunded?: number;
      refund_id?: string;
    };

    const piRepo = new PaymentIntentRepository(db);
    const orderRepo = new OrderRepository(db);
    const refundRepo = new RefundRepository(db);

    const providerIntentId =
      typeof refundOrCharge.payment_intent === 'string'
        ? refundOrCharge.payment_intent
        : refundOrCharge.payment_intent?.id;
    if (!providerIntentId) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    const dbPi = await piRepo.findByProviderIntentId(providerIntentId);
    if (!dbPi?.order_id) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    const order = await orderRepo.findById(dbPi.order_id);
    if (!order) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    const existingRefunds = await refundRepo.findByOrder(order.id);
    const isCumulativeChargeRefund =
      refundOrCharge.amount === undefined && refundOrCharge.amount_refunded !== undefined;
    const existingRefunded = existingRefunds.reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
    const refundAmount = isCumulativeChargeRefund
      ? Math.max(0, (refundOrCharge.amount_refunded ?? 0) - existingRefunded)
      : refundOrCharge.amount ?? 0;
    if (refundAmount <= 0) {
      const reconciledRefunded = Math.min(Number(order.total_cents), existingRefunded);
      if (reconciledRefunded > 0 && reconciledRefunded !== Number(order.refunded_cents)) {
        const reconciledStatus =
          reconciledRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
        await orderRepo.update(order.id, {
          refunded_cents: reconciledRefunded,
          status: reconciledStatus,
          refunded_at: new Date(),
        });
        return okResult({ orderId: order.id, status: reconciledStatus });
      }
      return okResult({ orderId: order.id, status: order.status });
    }
    const providerRefundId = isCumulativeChargeRefund
      ? `${refundOrCharge.id}:${refundOrCharge.amount_refunded}`
      : refundOrCharge.refund_id ?? refundOrCharge.id;
    let createdRefund = false;
    if (!existingRefunds.some((r) => r.provider_refund_id === providerRefundId)) {
      await refundRepo.create({
        tenantId: order.tenant_id,
        orderId: order.id,
        paymentIntentId: dbPi.id,
        provider: 'stripe',
        providerRefundId,
        amountCents: refundAmount,
        currency: order.currency,
        reason: 'Stripe webhook',
      });
      createdRefund = true;
    }

    const allRefunds = await refundRepo.findByOrder(order.id);
    const newRefunded = Math.min(
      Number(order.total_cents),
      allRefunds.reduce((sum, refund) => sum + Number(refund.amount_cents), 0),
    );
    const newStatus = newRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
    await orderRepo.update(order.id, {
      refunded_cents: newRefunded,
      status: newStatus,
      refunded_at: new Date(),
    });
    if (createdRefund) {
      await orderRepo.addTimelineEvent(order.id, 'order.refunded', `Refunded ${refundAmount} cents via Stripe`);
    }

    return okResult({ orderId: order.id, status: newStatus });
  } catch (err) {
    return errResult('REFUND_RECONCILE_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

export async function reconcileDisputeActivity(input: {
  providerEventId: string;
  provider: string;
  data: Record<string, unknown>;
}): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>> {
  const db = createDb();
  try {
    const dispute = input.data as {
      id: string;
      payment_intent?: string | { id: string } | null;
      amount?: number;
      status?: string;
      reason?: string;
    };

    const providerIntentId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : dispute.payment_intent?.id;
    if (!providerIntentId) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    const piRepo = new PaymentIntentRepository(db);
    const orderRepo = new OrderRepository(db);
    const dbPi = await piRepo.findByProviderIntentId(providerIntentId);
    if (!dbPi?.order_id) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    const order = await orderRepo.findById(dbPi.order_id);
    if (!order) {
      return okResult({ orderId: undefined, status: 'noop' });
    }

    // Set order status to disputed and add a timeline event.
    await orderRepo.update(order.id, { status: 'disputed' });
    await orderRepo.addTimelineEvent(
      order.id,
      'order.disputed',
      `Dispute opened: ${dispute.reason ?? 'unknown reason'} (${dispute.status ?? 'open'})`,
      { disputeId: dispute.id, providerDisputeId: dispute.id, amount: dispute.amount },
    );

    return okResult({ orderId: order.id, status: 'disputed' });
  } catch (err) {
    return errResult('DISPUTE_RECONCILE_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

export async function emitDomainEventActivity(input: {
  orderId: string;
  eventType: string;
}): Promise<WorkflowActivityResult<{ emitted: boolean }>> {
  // Domain events are emitted via webhook delivery workflows started from the
  // checkout workflow (emitWebhookEventActivity + startChild webhookDeliveryWorkflow).
  // This activity is a no-op kept for workflow compatibility; webhook emission
  // is handled at the workflow orchestration layer.
  void input;
  return okResult({ emitted: true });
}
