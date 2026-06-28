import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  proxyActivities,
  startChild,
  patched,
} from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';
import { WEBHOOK_DELIVERY_WORKFLOW_VERSION } from '../shared/types.js';
import { webhookDeliveryWorkflow } from './webhook-delivery.js';

const {
  createPaymentIntentActivity,
  finalizeOrderActivity,
  compensateOrphanPaymentActivity,
  sendConfirmationEmailActivity,
  issueTicketsActivity,
  releaseHoldActivity,
  emitWebhookEventActivity,
} = proxyActivities<{
  createPaymentIntentActivity(input: {
    checkoutSessionId: string;
    tenantId: string;
    brandId: string;
    amountCents: number;
    currency: string;
    description?: string;
    feeCents?: number;
  }): Promise<
    WorkflowActivityResult<{ providerIntentId: string; clientSecret?: string; provider?: string }>
  >;
  finalizeOrderActivity(input: {
    checkoutSessionId: string;
    tenantId: string;
    paymentIntentId?: string;
    affiliateCode?: string;
  }): Promise<WorkflowActivityResult<{ orderId: string }>>;
  compensateOrphanPaymentActivity(input: {
    checkoutSessionId: string;
    tenantId: string;
    provider?: string;
    providerIntentId?: string;
    amountCents?: number;
    currency?: string;
    reason: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): Promise<
    WorkflowActivityResult<{
      status: 'succeeded' | 'failed' | 'manual_review' | 'already_ordered';
      action: 'cancel' | 'refund' | 'local_noop';
      compensationId?: string;
      providerCompensationId?: string;
    }>
  >;
  sendConfirmationEmailActivity(input: {
    orderId: string;
    toEmail: string;
    tenantId: string;
    brandId: string;
  }): Promise<WorkflowActivityResult<{ jobId?: string; status: 'queued' | 'skipped' }>>;
  issueTicketsActivity(input: {
    orderId: string;
    toEmail: string;
    tenantId: string;
    brandId: string;
  }): Promise<WorkflowActivityResult<{ issued: number; jobId?: string }>>;
  releaseHoldActivity(input: {
    holdId?: string;
    checkoutSessionId?: string;
    checkoutSessionStatus?: 'cancelled' | 'expired';
  }): Promise<WorkflowActivityResult<{ released: boolean }>>;
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
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '1 second',
    backoffCoefficient: 2,
  },
});

export const paymentSucceededSignal = defineSignal<[string]>('paymentSucceeded');
export const paymentFailedSignal = defineSignal<[string]>('paymentFailed');
export const cancelCheckoutSignal = defineSignal('cancelCheckout');

export const getCheckoutStateQuery = defineQuery<CheckoutState>('getCheckoutState');

export type CheckoutState = {
  status: 'hold_placed' | 'payment_pending' | 'completed' | 'failed' | 'cancelled';
  holdId?: string;
  paymentIntentId?: string;
  clientSecret?: string;
  orderId?: string;
  error?: string;
};

export type CheckoutSessionWorkflowInput = {
  version: number;
  checkoutSessionId: string;
  tenantId: string;
  organizationId: string;
  eventId: string;
  brandId: string;
  holdId?: string;
  currency: string;
  amountCents: number;
  feeCents: number;
  buyerEmail: string;
  isFreeOrder: boolean;
  affiliateCode?: string;
};

export async function checkoutSessionWorkflow(
  input: CheckoutSessionWorkflowInput,
): Promise<{ orderId?: string; status: string }> {
  let state: CheckoutState = { status: 'hold_placed', holdId: input.holdId };
  let paymentIntentId: string | undefined;
  let paymentProvider: string | undefined;
  let paymentSucceeded = false;
  let paymentError: string | undefined;
  let cancelled = false;

  async function emitOrderWebhook(orderId: string) {
    const emitResult = await emitWebhookEventActivity({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      eventType: 'order.paid',
      payload: { orderId, eventId: input.eventId, checkoutSessionId: input.checkoutSessionId },
    });
    if (emitResult.ok && emitResult.value.deliveries.length > 0) {
      await Promise.all(
        emitResult.value.deliveries.map((delivery) =>
          startChild(webhookDeliveryWorkflow, {
            workflowId: `webhook-delivery:${delivery.eventId}:${delivery.endpointId}`,
            args: [
              {
                version: WEBHOOK_DELIVERY_WORKFLOW_VERSION,
                endpointId: delivery.endpointId,
                eventId: delivery.eventId,
                payload: {
                  orderId,
                  eventId: input.eventId,
                  checkoutSessionId: input.checkoutSessionId,
                },
                maxAttempts: 5,
              },
            ],
          }),
        ),
      );
    }
  }

  async function compensateOrphanPayment(compensationInput: {
    provider?: string;
    providerIntentId?: string;
    reason: string;
    source: string;
    metadata?: Record<string, unknown>;
  }) {
    const compensationResult = await compensateOrphanPaymentActivity({
      checkoutSessionId: input.checkoutSessionId,
      tenantId: input.tenantId,
      provider: compensationInput.provider,
      providerIntentId: compensationInput.providerIntentId,
      amountCents: input.amountCents,
      currency: input.currency,
      reason: compensationInput.reason,
      source: compensationInput.source,
      metadata: compensationInput.metadata,
    });
    if (!compensationResult.ok) {
      throw new Error(
        `Orphan payment compensation failed (${compensationResult.errorCode}): ${compensationResult.message}`,
      );
    }
    if (
      !['succeeded', 'already_ordered'].includes(compensationResult.value.status) &&
      patched('checkout-block-incomplete-orphan-compensation-v1')
    ) {
      throw new Error(
        `Orphan payment compensation blocked with status ${compensationResult.value.status}`,
      );
    }
  }

  async function releaseCheckoutHold(releaseInput: {
    holdId?: string;
    checkoutSessionId?: string;
    checkoutSessionStatus?: 'cancelled' | 'expired';
  }) {
    const releaseResult = await releaseHoldActivity(releaseInput);
    if (!releaseResult.ok) {
      throw new Error(
        `Checkout hold release failed (${releaseResult.errorCode}): ${releaseResult.message}`,
      );
    }
  }

  setHandler(paymentSucceededSignal, (providerIntentId: string) => {
    paymentIntentId = providerIntentId;
    paymentSucceeded = true;
  });

  setHandler(paymentFailedSignal, (errorMessage: string) => {
    paymentError = errorMessage;
  });

  setHandler(cancelCheckoutSignal, () => {
    cancelled = true;
  });

  setHandler(getCheckoutStateQuery, () => state);

  if (cancelled) {
    await releaseCheckoutHold({ checkoutSessionId: input.checkoutSessionId });
    state = { status: 'cancelled', holdId: input.holdId };
    return { status: 'cancelled' };
  }

  if (input.isFreeOrder) {
    const finalizeResult = await finalizeOrderActivity({
      checkoutSessionId: input.checkoutSessionId,
      tenantId: input.tenantId,
      affiliateCode: input.affiliateCode,
    });

    if (!finalizeResult.ok) {
      await releaseCheckoutHold({ checkoutSessionId: input.checkoutSessionId });
      state = { status: 'failed', holdId: input.holdId, error: finalizeResult.message };
      return { status: 'failed' };
    }

    await sendConfirmationEmailActivity({
      orderId: finalizeResult.value.orderId,
      toEmail: input.buyerEmail,
      tenantId: input.tenantId,
      brandId: input.brandId,
    });

    await issueTicketsActivity({
      orderId: finalizeResult.value.orderId,
      toEmail: input.buyerEmail,
      tenantId: input.tenantId,
      brandId: input.brandId,
    });

    await emitOrderWebhook(finalizeResult.value.orderId);

    state = { status: 'completed', holdId: input.holdId, orderId: finalizeResult.value.orderId };
    return { orderId: finalizeResult.value.orderId, status: 'completed' };
  }

  const paymentResult = await createPaymentIntentActivity({
    checkoutSessionId: input.checkoutSessionId,
    tenantId: input.tenantId,
    brandId: input.brandId,
    amountCents: input.amountCents,
    currency: input.currency,
    description: `Event tickets - ${input.eventId}`,
    feeCents: input.feeCents,
  });

  if (!paymentResult.ok) {
    await releaseCheckoutHold({
      checkoutSessionId: input.checkoutSessionId,
      checkoutSessionStatus: 'expired',
    });
    state = { status: 'failed', holdId: input.holdId, error: paymentResult.message };
    return { status: 'failed' };
  }

  paymentIntentId = paymentResult.value.providerIntentId;
  paymentProvider = paymentResult.value.provider;
  const clientSecret = paymentResult.value.clientSecret;
  state = { status: 'payment_pending', holdId: input.holdId, paymentIntentId, clientSecret };
  if (paymentIntentId.startsWith('pi_capture_')) {
    paymentSucceeded = true;
  }

  const paymentTimeout = '10 minutes';
  const gotPayment = await condition(
    () => paymentSucceeded || paymentError !== undefined || cancelled,
    paymentTimeout,
  );

  if (cancelled) {
    await compensateOrphanPayment({
      provider: paymentProvider,
      providerIntentId: paymentIntentId,
      reason: 'Checkout was cancelled before payment completion',
      source: 'checkout_cancelled',
      metadata: { eventId: input.eventId, brandId: input.brandId },
    });
    await releaseCheckoutHold({
      checkoutSessionId: input.checkoutSessionId,
      checkoutSessionStatus: 'cancelled',
    });
    state = { status: 'cancelled', holdId: input.holdId, paymentIntentId, clientSecret };
    return { status: 'cancelled' };
  }

  if (paymentError) {
    await compensateOrphanPayment({
      provider: paymentProvider,
      providerIntentId: paymentIntentId,
      reason: paymentError,
      source: 'checkout_payment_failed',
      metadata: { eventId: input.eventId, brandId: input.brandId },
    });
    await releaseCheckoutHold({
      checkoutSessionId: input.checkoutSessionId,
      checkoutSessionStatus: 'expired',
    });
    state = {
      status: 'failed',
      holdId: input.holdId,
      paymentIntentId,
      clientSecret,
      error: paymentError,
    };
    return { status: 'failed' };
  }

  if (!gotPayment) {
    await compensateOrphanPayment({
      provider: paymentProvider,
      providerIntentId: paymentIntentId,
      reason: paymentSucceeded
        ? 'Payment succeeded after checkout timeout'
        : 'Payment timed out before checkout completion',
      source: paymentSucceeded ? 'checkout_timeout_race' : 'checkout_payment_timeout',
      metadata: { eventId: input.eventId, brandId: input.brandId },
    });
    await releaseCheckoutHold({
      checkoutSessionId: input.checkoutSessionId,
      checkoutSessionStatus: 'expired',
    });
    state = {
      status: 'failed',
      holdId: input.holdId,
      paymentIntentId,
      clientSecret,
      error: 'Payment timeout',
    };
    return { status: 'failed' };
  }

  const finalizeResult = await finalizeOrderActivity({
    checkoutSessionId: input.checkoutSessionId,
    tenantId: input.tenantId,
    paymentIntentId,
    affiliateCode: input.affiliateCode,
  });

  if (!finalizeResult.ok) {
    await compensateOrphanPayment({
      provider: paymentProvider,
      providerIntentId: paymentIntentId,
      reason: finalizeResult.message,
      source: 'checkout_finalize_failed',
      metadata: {
        eventId: input.eventId,
        brandId: input.brandId,
        errorCode: finalizeResult.errorCode,
      },
    });
    await releaseCheckoutHold({
      checkoutSessionId: input.checkoutSessionId,
      checkoutSessionStatus: 'expired',
    });
    state = {
      status: 'failed',
      holdId: input.holdId,
      paymentIntentId,
      clientSecret,
      error: finalizeResult.message,
    };
    return { status: 'failed' };
  }

  await sendConfirmationEmailActivity({
    orderId: finalizeResult.value.orderId,
    toEmail: input.buyerEmail,
    tenantId: input.tenantId,
    brandId: input.brandId,
  });

  await issueTicketsActivity({
    orderId: finalizeResult.value.orderId,
    toEmail: input.buyerEmail,
    tenantId: input.tenantId,
    brandId: input.brandId,
  });

  await emitOrderWebhook(finalizeResult.value.orderId);

  state = {
    status: 'completed',
    holdId: input.holdId,
    paymentIntentId,
    clientSecret,
    orderId: finalizeResult.value.orderId,
  };
  return { orderId: finalizeResult.value.orderId, status: 'completed' };
}
