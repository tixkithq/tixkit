import type { FastifyPluginAsync } from 'fastify';
import Stripe from 'stripe';
import { PaymentEventRepository, type Database } from '@tixkit/db';

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
      return reply.status(400).send({
        error: {
          code: 'MISSING_RAW_BODY',
          message: 'Raw body is required for signature verification',
        },
      });
    }
    const signature = request.headers['stripe-signature'] as string;

    if (!signature) {
      return reply.status(400).send({ error: 'Missing Stripe signature' });
    }

    let event: Stripe.Event;
    try {
      const stripe = new Stripe(stripeSecretKey || 'sk_test_tixkit_unconfigured');
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

    // Signal trusted checkout payment lifecycle events before reconciliation can
    // mark this provider event processed. If the signal fails, Stripe retry must
    // return here and retry the missing checkout signal instead of hitting the
    // processed-event duplicate guard.
    if (
      event.type === 'payment_intent.succeeded' ||
      event.type === 'payment_intent.payment_failed'
    ) {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const checkoutSessionId = paymentIntent.metadata?.checkoutSessionId;
      if (checkoutSessionId) {
        const isTrustedCheckoutPaymentIntent = await validateStripeCheckoutPaymentIntent(
          db,
          event,
          paymentIntent,
          checkoutSessionId,
        );
        if (isTrustedCheckoutPaymentIntent) {
          try {
            if (event.type === 'payment_intent.succeeded') {
              await temporalClient.signalPaymentSucceeded(checkoutSessionId, paymentIntent.id);
            } else {
              await temporalClient.signalPaymentFailed(
                checkoutSessionId,
                paymentIntent.last_payment_error?.message ?? 'Payment failed',
              );
            }
          } catch (err) {
            const message =
              err instanceof Error ? err.message : 'Failed to signal checkout workflow';
            return reply.status(503).send({
              error: {
                code: 'CHECKOUT_PAYMENT_SIGNAL_FAILED',
                message,
                requestId: request.id,
              },
            });
          }
        }
      }
    }

    if (event.type === 'account.updated') {
      await syncStripeConnectAccount(db, event.data.object as Stripe.Account);
      await eventRepo.markProcessed(storedEvent.id);
    } else {
      // Start the durable reconciliation workflow; never process payment state in
      // the request handler. Reconciliation expects the inner Stripe object
      // (PaymentIntent, Charge, etc.), not the whole event envelope.
      await temporalClient.startPaymentReconciliation({
        providerEventId: event.id,
        provider: 'stripe',
        eventType: event.type,
        data: (event.data?.object ?? {}) as unknown as Record<string, unknown>,
      });
    }

    return reply.status(200).send({ received: true, duplicate: false });
  });
};

async function validateStripeCheckoutPaymentIntent(
  db: Database,
  event: Stripe.Event,
  paymentIntent: Stripe.PaymentIntent,
  checkoutSessionId: string,
): Promise<boolean> {
  if (
    !paymentIntent.id ||
    typeof paymentIntent.amount !== 'number' ||
    typeof paymentIntent.currency !== 'string'
  ) {
    return false;
  }

  const checkoutSession = await db
    .selectFrom('checkout_sessions')
    .select(['id', 'tenant_id'])
    .where('id', '=', checkoutSessionId)
    .executeTakeFirst();
  if (!checkoutSession) return false;

  const storedPaymentIntent = await db
    .selectFrom('payment_intents')
    .select([
      'id',
      'tenant_id',
      'checkout_session_id',
      'provider_intent_id',
      'amount_cents',
      'currency',
      'payment_account_id',
    ])
    .where('provider_intent_id', '=', paymentIntent.id)
    .where('checkout_session_id', '=', checkoutSessionId)
    .executeTakeFirst();
  if (!storedPaymentIntent) return false;

  const paymentIntentMatchesSession =
    storedPaymentIntent.tenant_id === checkoutSession.tenant_id &&
    storedPaymentIntent.checkout_session_id === checkoutSession.id &&
    storedPaymentIntent.provider_intent_id === paymentIntent.id &&
    Number(storedPaymentIntent.amount_cents) === paymentIntent.amount &&
    String(storedPaymentIntent.currency).toUpperCase() === paymentIntent.currency.toUpperCase();
  if (!paymentIntentMatchesSession) return false;

  const stripeAccount = (event as unknown as { account?: string }).account;
  if (!stripeAccount) return true;

  const paymentAccountId = storedPaymentIntent.payment_account_id;
  if (!paymentAccountId) return false;

  const paymentAccount = await db
    .selectFrom('payment_accounts')
    .select(['provider_account_id'])
    .where('id', '=', paymentAccountId)
    .executeTakeFirst();

  return paymentAccount?.provider_account_id === stripeAccount;
}

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
  const accountObjectId =
    event.type === 'account.updated' && typeof object.id === 'string' ? object.id : undefined;
  const connectedAccountId = stripeAccount ?? accountObjectId;
  if (connectedAccountId) {
    const paymentAccount = await db
      .selectFrom('payment_accounts')
      .select(['tenant_id'])
      .where('provider', '=', 'stripe_connect')
      .where('provider_account_id', '=', connectedAccountId)
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

function stripeAccountStatus(account: Stripe.Account): 'active' | 'pending' | 'restricted' {
  if (account.charges_enabled && account.payouts_enabled) return 'active';
  if ((account.requirements?.disabled_reason ?? null) !== null) return 'restricted';
  return 'pending';
}

async function syncStripeConnectAccount(db: Database, account: Stripe.Account): Promise<void> {
  if (!account.id) return;
  await db
    .updateTable('payment_accounts')
    .set({
      status: stripeAccountStatus(account),
      default_currency: account.default_currency?.toUpperCase() ?? 'USD',
      details_submitted: Boolean(account.details_submitted),
      charges_enabled: Boolean(account.charges_enabled),
      payouts_enabled: Boolean(account.payouts_enabled),
      requirements: JSON.stringify(account.requirements ?? {}),
      disabled_reason: account.requirements?.disabled_reason ?? null,
      updated_at: new Date(),
    })
    .where('provider', '=', 'stripe_connect')
    .where('provider_account_id', '=', account.id)
    .execute();
}
