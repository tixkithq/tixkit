import { createDb } from '@tixkit/db';
import {
  CheckoutSessionRepository,
  PaymentIntentRepository,
  OrderRepository,
  RefundRepository,
  PaymentEventRepository,
} from '@tixkit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import { compensateOrphanPaymentActivity } from './checkout.js';

async function findPaymentIntentForProviderEvent(
  repo: PaymentIntentRepository,
  provider: string,
  providerIntentId: string,
) {
  const exact = await repo.findByProviderAndIntentId(provider, providerIntentId);
  if (exact) return exact;

  if (provider === 'stripe') {
    return repo.findByProviderAndIntentId('stripe_connect', providerIntentId);
  }

  return undefined;
}

function checkoutSessionCanStillFinalize(session: { status: string; expires_at: Date | string }): boolean {
  if (!['open', 'pending_payment'].includes(session.status)) return false;
  return new Date(session.expires_at).getTime() > Date.now();
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function objectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return undefined;
}

function providerIntentIdForPaymentEvent(
  eventType: string,
  payload: { id?: unknown; payment_intent?: unknown },
): string | undefined {
  if (eventType.startsWith('charge.')) return objectId(payload.payment_intent);
  return objectId(payload.id);
}

export async function reconcilePaymentActivity(input: {
  providerEventId: string;
  provider: string;
  eventType: string;
  data: Record<string, unknown>;
}): Promise<WorkflowActivityResult<{ orderId?: string; status: string }>> {
  const db = createDb();
  try {
    const paymentIntent = input.data as {
      id?: string;
      payment_intent?: unknown;
      status: string;
      amount?: number;
      amount_received?: number;
      currency?: string;
      metadata?: Record<string, string>;
    };
    const providerIntentId = providerIntentIdForPaymentEvent(input.eventType, paymentIntent);
    const successfulPaymentEvent = isSuccessfulPaymentEvent(input.eventType, paymentIntent.status);
    if (!providerIntentId) {
      return errResult(
        'PAYMENT_INTENT_ID_MISSING',
        `Provider event ${input.providerEventId} did not include a payment intent id`,
        false,
      );
    }

    const piRepo = new PaymentIntentRepository(db);
    const orderRepo = new OrderRepository(db);
    const checkoutSessionRepo = new CheckoutSessionRepository(db);
    const dbPi = await findPaymentIntentForProviderEvent(piRepo, input.provider, providerIntentId);
    if (!dbPi) {
      if (successfulPaymentEvent) {
        const metadata = stringRecord(paymentIntent.metadata);
        const checkoutSessionId = metadata?.checkoutSessionId;
        if (!checkoutSessionId) {
          return errResult(
            'PAYMENT_INTENT_NOT_FOUND',
            `No local payment intent found for successful provider event ${input.providerEventId}`,
            false,
          );
        }

        const checkoutSession = await checkoutSessionRepo.findById(checkoutSessionId);
        if (checkoutSession && checkoutSessionCanStillFinalize(checkoutSession)) {
          return errResult(
            'ORDER_NOT_FINALIZED_YET',
            'Checkout session is still finalizing for this successful payment',
            true,
          );
        }
        if (!checkoutSession) {
          return errResult(
            'CHECKOUT_SESSION_NOT_FOUND',
            `Checkout session ${checkoutSessionId} was not found for successful provider event ${input.providerEventId}`,
            false,
          );
        }

        const compensation = await compensateOrphanPaymentActivity({
          checkoutSessionId,
          tenantId: checkoutSession.tenant_id,
          provider: input.provider,
          providerIntentId,
          amountCents: Number(paymentIntent.amount_received ?? paymentIntent.amount ?? 0),
          currency: String(paymentIntent.currency ?? checkoutSession.currency ?? 'USD').toUpperCase(),
          reason: 'Successful provider payment has no durable local payment intent attached',
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          providerStatus: paymentIntent.status,
          source: 'payment_reconciliation_missing_payment_intent',
          metadata: { checkoutSessionId },
        });
        if (!compensation.ok) {
          return errResult(compensation.errorCode, compensation.message, compensation.retryable);
        }
        return okResult({ orderId: undefined, status: `compensated:${compensation.value.status}` });
      }
      return okResult({ orderId: undefined, status: 'noop' });
    }

    await piRepo.update(dbPi.id, { status: paymentIntent.status });

    if (dbPi.order_id) {
      const order = await orderRepo.findById(dbPi.order_id);
      if (
        order &&
        isSuccessfulPaymentEvent(input.eventType, paymentIntent.status) &&
        isPayableOrderStatus(String(order.status))
      ) {
        await orderRepo.update(dbPi.order_id, { status: 'paid', paid_at: new Date() });
        await orderRepo.addTimelineEvent(
          dbPi.order_id,
          'order.paid',
          'Payment confirmed via Stripe',
        );
        return okResult({ orderId: dbPi.order_id, status: 'paid' });
      }
      if (order && isFailedPaymentEvent(input.eventType, paymentIntent.status)) {
        await orderRepo.addTimelineEvent(
          dbPi.order_id,
          'payment.failed',
          'Payment failed via Stripe',
        );
      }
      return okResult({ orderId: dbPi.order_id, status: paymentIntent.status });
    }

    if (successfulPaymentEvent) {
      const checkoutSession = dbPi.checkout_session_id
        ? await checkoutSessionRepo.findById(dbPi.checkout_session_id)
        : undefined;
      if (checkoutSession && checkoutSessionCanStillFinalize(checkoutSession)) {
        return errResult(
          'ORDER_NOT_FINALIZED_YET',
          'Checkout session is still finalizing for this successful payment',
          true,
        );
      }

      const compensation = await compensateOrphanPaymentActivity({
        checkoutSessionId: dbPi.checkout_session_id,
        tenantId: dbPi.tenant_id,
        provider: dbPi.provider,
        providerIntentId: dbPi.provider_intent_id,
        amountCents: Number(dbPi.amount_cents),
        currency: dbPi.currency,
        reason: 'Successful provider payment has no durable order attached',
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        providerStatus: paymentIntent.status,
        source: 'payment_reconciliation',
      });
      if (!compensation.ok) {
        return errResult(compensation.errorCode, compensation.message, compensation.retryable);
      }
      return okResult({ orderId: undefined, status: `compensated:${compensation.value.status}` });
    }

    return okResult({ orderId: undefined, status: paymentIntent.status });
  } catch (err) {
    return errResult(
      'PAYMENT_RECONCILE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
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

function isPayableOrderStatus(status: string): boolean {
  return status === 'pending_payment';
}

function isFailedPaymentEvent(eventType: string, status: string): boolean {
  return (
    eventType === 'payment_intent.payment_failed' ||
    eventType === 'payment_intent.canceled' ||
    status === 'requires_payment_method' ||
    status === 'canceled'
  );
}

function isSuccessfulRefundEvent(eventType: string, status: string | undefined): boolean {
  if (
    eventType.includes('refund') &&
    (eventType.includes('failed') ||
      eventType.includes('canceled') ||
      eventType.includes('cancelled'))
  ) {
    return false;
  }
  return status === undefined || status === 'succeeded';
}

function sumSucceededRefunds(
  refunds: Array<{ amount_cents: number | string | bigint; status?: string }>,
): number {
  return refunds.reduce(
    (sum, refund) => (refund.status === 'succeeded' ? sum + Number(refund.amount_cents) : sum),
    0,
  );
}

async function updateRefundReconciliationState(
  db: ReturnType<typeof createDb>,
  orderRepo: InstanceType<typeof OrderRepository>,
  order: { id: string; total_cents: number | string | bigint },
  refundedCents: number,
): Promise<string> {
  const reconciledRefunded = Math.min(Number(order.total_cents), refundedCents);
  const reconciledStatus =
    reconciledRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';

  await orderRepo.update(order.id, {
    refunded_cents: reconciledRefunded,
    status: reconciledStatus,
    refunded_at: new Date(),
  });
  await db
    .updateTable('invoices')
    .set({ refunded_cents: reconciledRefunded, updated_at: new Date() })
    .where('order_id', '=', order.id)
    .execute();

  return reconciledStatus;
}

export async function reconcileRefundActivity(input: {
  providerEventId: string;
  provider: string;
  eventType: string;
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
      status?: string;
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

    const dbPi = await findPaymentIntentForProviderEvent(piRepo, input.provider, providerIntentId);
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
    if (isCumulativeChargeRefund) {
      const aggregateRefunded = Math.max(0, refundOrCharge.amount_refunded ?? 0);
      const reconciledRefunded = Math.min(Number(order.total_cents), aggregateRefunded);
      const reconciledStatus =
        reconciledRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
      if (
        reconciledRefunded > 0 &&
        (reconciledRefunded !== Number(order.refunded_cents) || reconciledStatus !== order.status)
      ) {
        const status = await updateRefundReconciliationState(
          db,
          orderRepo,
          order,
          reconciledRefunded,
        );
        return okResult({ orderId: order.id, status });
      }
      return okResult({ orderId: order.id, status: order.status });
    }

    if (!isSuccessfulRefundEvent(input.eventType, refundOrCharge.status)) {
      return okResult({ orderId: order.id, status: order.status });
    }

    const existingRefunded = sumSucceededRefunds(existingRefunds);
    const refundAmount = refundOrCharge.amount ?? 0;
    if (refundAmount <= 0) {
      const reconciledRefunded = Math.min(Number(order.total_cents), existingRefunded);
      const reconciledStatus =
        reconciledRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
      if (
        reconciledRefunded > 0 &&
        (reconciledRefunded !== Number(order.refunded_cents) || reconciledStatus !== order.status)
      ) {
        const status = await updateRefundReconciliationState(
          db,
          orderRepo,
          order,
          reconciledRefunded,
        );
        return okResult({ orderId: order.id, status });
      }
      return okResult({ orderId: order.id, status: order.status });
    }
    const providerRefundId = refundOrCharge.refund_id ?? refundOrCharge.id;
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
        status: 'succeeded',
      });
      createdRefund = true;
    }

    const allRefunds = await refundRepo.findByOrder(order.id);
    const newRefunded = Math.min(
      Number(order.total_cents),
      sumSucceededRefunds(allRefunds),
    );
    const newStatus = await updateRefundReconciliationState(db, orderRepo, order, newRefunded);
    if (createdRefund) {
      await orderRepo.addTimelineEvent(
        order.id,
        'order.refunded',
        `Refunded ${refundAmount} cents via Stripe`,
      );
    }

    return okResult({ orderId: order.id, status: newStatus });
  } catch (err) {
    return errResult(
      'REFUND_RECONCILE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
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
    const dbPi = await findPaymentIntentForProviderEvent(piRepo, input.provider, providerIntentId);
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
    return errResult(
      'DISPUTE_RECONCILE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
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

export async function markProviderEventProcessedActivity(input: {
  provider: string;
  providerEventId: string;
}): Promise<WorkflowActivityResult<{ processed: boolean }>> {
  const db = createDb();
  try {
    const eventRepo = new PaymentEventRepository(db);
    await eventRepo.markProcessedByProviderEventId(input.provider, input.providerEventId);
    return okResult({ processed: true });
  } catch (err) {
    return errResult(
      'PROVIDER_EVENT_MARK_PROCESSED_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}
