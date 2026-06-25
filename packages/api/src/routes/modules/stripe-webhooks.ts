import type { FastifyPluginAsync } from 'fastify';
import Stripe from 'stripe';
import { PaymentEventRepository, type Database } from '@gatekit/db';

export const stripeWebhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const temporalClient = app.context.temporalClient;
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

  app.post('/', async (request, reply) => {
    if (!webhookSecret) {
      return reply.status(503).send({
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Stripe webhook secret is not configured',
          requestId: request.id,
        },
      });
    }
    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.status(400).send({ error: { code: 'MISSING_RAW_BODY', message: 'Raw body is required for signature verification' } });
    }
    const signature = request.headers['stripe-signature'] as string;

    if (!signature) {
      return reply.status(400).send({ error: 'Missing Stripe signature' });
    }

    let event: Stripe.Event;
    try {
      const stripe = new Stripe(stripeSecretKey || 'sk_test_gatekit_unconfigured');
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: { code: 'WEBHOOK_SIGNATURE_INVALID', message } });
    }

    // Store the event before processing. If a previous attempt stored the
    // provider event but failed before marking it processed, replay must retry
    // reconciliation instead of treating it as a completed duplicate.
    const eventRepo = new PaymentEventRepository(db);
    let storedEvent = await eventRepo.findByProviderEventId('stripe', event.id);

    if (storedEvent?.processed_at) {
      return reply.status(200).send({ received: true, duplicate: true });
    }

    if (!storedEvent) {
      const tenantId = await resolveStripeEventTenantId(db, event);
      try {
        storedEvent = await eventRepo.create({
          tenantId,
          provider: 'stripe',
          providerEventId: event.id,
          eventType: event.type,
          rawPayload: event as unknown as Record<string, unknown>,
          idempotencyKey: event.id,
        });
      } catch (err) {
        storedEvent = await eventRepo.findByProviderEventId('stripe', event.id);
        if (!storedEvent) throw err;
        if (storedEvent.processed_at) {
          return reply.status(200).send({ received: true, duplicate: true });
        }
      }
    }

    // Start the durable reconciliation workflow; never process provider state in
    // the request handler. Reconciliation expects the inner Stripe object
    // (PaymentIntent, Charge, etc.), not the whole event envelope.
    await temporalClient.startPaymentReconciliation({
      providerEventId: event.id,
      provider: 'stripe',
      eventType: event.type,
      data: (event.data?.object ?? {}) as unknown as Record<string, unknown>,
    });

    // Signal the checkout workflow for payment lifecycle events so it can finalize or fail.
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const checkoutSessionId = paymentIntent.metadata?.checkoutSessionId;
      if (checkoutSessionId) {
        try {
          if (event.type === 'payment_intent.succeeded') {
            await temporalClient.signalPaymentSucceeded(checkoutSessionId, paymentIntent.id);
          } else {
            await temporalClient.signalPaymentFailed(checkoutSessionId, paymentIntent.last_payment_error?.message ?? 'Payment failed');
          }
        } catch {
          // If the checkout workflow is no longer running, the reconciliation workflow will still reconcile DB state.
        }
      }
    }

    // Mark only after durable reconciliation has been accepted. Stripe can
    // safely replay unprocessed rows if this final update fails.
    await eventRepo.markProcessed(storedEvent.id);

    return reply.status(200).send({ received: true, duplicate: false });
  });
};

async function resolveStripeEventTenantId(
  db: Database,
  event: Stripe.Event,
): Promise<string | null> {
  const object = event.data?.object as {
    id?: string;
    payment_intent?: string | null;
    metadata?: Record<string, string>;
  };
  const checkoutSessionId = object.metadata?.checkoutSessionId;
  if (checkoutSessionId) {
    const session = await db
      .selectFrom('checkout_sessions')
      .select(['tenant_id'])
      .where('id', '=', checkoutSessionId)
      .executeTakeFirst();
    if (session) return session.tenant_id;
  }

  // Resolve tenant via the connected account (Stripe Connect).
  const stripeAccount = (event as unknown as { account?: string }).account;
  if (stripeAccount) {
    const paymentAccount = await db
      .selectFrom('payment_accounts')
      .select(['tenant_id'])
      .where('provider_account_id', '=', stripeAccount)
      .executeTakeFirst();
    if (paymentAccount?.tenant_id) return paymentAccount.tenant_id;
  }

  const providerIntentId =
    typeof object.payment_intent === 'string'
      ? object.payment_intent
      : event.type.startsWith('payment_intent.')
        ? object.id
        : undefined;
  if (!providerIntentId) return null;

  const paymentIntent = await db
    .selectFrom('payment_intents')
    .select(['tenant_id'])
    .where('provider_intent_id', '=', providerIntentId)
    .executeTakeFirst();
  return paymentIntent?.tenant_id ?? null;
}
