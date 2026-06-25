import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  proxyActivities,
  startChild,
} from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';
import { WEBHOOK_DELIVERY_WORKFLOW_VERSION } from '../shared/types.js';
import { webhookDeliveryWorkflow } from './webhook-delivery.js';

const {
  createPaymentIntentActivity,
  finalizeOrderActivity,
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
  }): Promise<WorkflowActivityResult<{ providerIntentId: string; clientSecret?: string }>>;
  finalizeOrderActivity(input: {
    checkoutSessionId: string;
    tenantId: string;
    paymentIntentId?: string;
    affiliateCode?: string;
  }): Promise<WorkflowActivityResult<{ orderId: string }>>;
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
  releaseHoldActivity(input: { holdId?: string; checkoutSessionId?: string }): Promise<WorkflowActivityResult<{ released: boolean }>>;
  emitWebhookEventActivity(input: {
    tenantId: string;
    organizationId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<
    WorkflowActivityResult<{
      eventId: string;
      deliveries: { endpointId: string; eventId: string; secret: string; url: string }[];
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
  holdId: string;
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
                payload: { orderId, eventId: input.eventId, checkoutSessionId: input.checkoutSessionId },
                secret: delivery.secret,
                maxAttempts: 5,
              },
            ],
          }),
        ),
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
    await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
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
      await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
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
    await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
    state = { status: 'failed', holdId: input.holdId, error: paymentResult.message };
    return { status: 'failed' };
  }

  paymentIntentId = paymentResult.value.providerIntentId;
  const clientSecret = paymentResult.value.clientSecret;
  state = { status: 'payment_pending', holdId: input.holdId, paymentIntentId, clientSecret };

  const paymentTimeout = '10 minutes';
  const gotPayment = await condition(
    () => paymentSucceeded || paymentError !== undefined || cancelled,
    paymentTimeout,
  );

  if (cancelled) {
    await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
    state = { status: 'cancelled', holdId: input.holdId, paymentIntentId, clientSecret };
    return { status: 'cancelled' };
  }

  if (paymentError) {
    await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
    state = { status: 'failed', holdId: input.holdId, paymentIntentId, clientSecret, error: paymentError };
    return { status: 'failed' };
  }

  if (!gotPayment) {
    await releaseHoldActivity({ checkoutSessionId: input.checkoutSessionId });
    state = { status: 'failed', holdId: input.holdId, paymentIntentId, clientSecret, error: 'Payment timeout' };
    return { status: 'failed' };
  }

  const finalizeResult = await finalizeOrderActivity({
    checkoutSessionId: input.checkoutSessionId,
    tenantId: input.tenantId,
    paymentIntentId,
    affiliateCode: input.affiliateCode,
  });

  if (!finalizeResult.ok) {
    state = { status: 'failed', holdId: input.holdId, paymentIntentId, clientSecret, error: finalizeResult.message };
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
