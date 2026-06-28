import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { createDb, type Database } from '@tixkit/db';
import { createPaymentIntentActivity } from '../activities/checkout.js';
import { processRefundActivity } from '../activities/refund.js';

const runProviderTests = process.env.RUN_STRIPE_PROVIDER_TESTS === '1';
const describeProvider = runProviderTests ? describe : describe.skip;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for Stripe provider validation`);
  return value;
}

function idSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 14);
}

type ProviderSeedIds = {
  suffix: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  inventoryPoolId: string;
  ticketTypeId: string;
  holdId: string;
  checkoutSessionId: string;
  orderId: string;
};

function makeSeedIds(): ProviderSeedIds {
  const suffix = idSuffix();
  return {
    suffix,
    tenantId: `tnt_sp_${suffix}`.slice(0, 32),
    organizationId: `org_sp_${suffix}`.slice(0, 32),
    brandId: `brd_sp_${suffix}`.slice(0, 32),
    eventId: `evt_sp_${suffix}`.slice(0, 32),
    inventoryPoolId: `inv_sp_${suffix}`.slice(0, 32),
    ticketTypeId: `tt_sp_${suffix}`.slice(0, 32),
    holdId: `hld_sp_${suffix}`.slice(0, 32),
    checkoutSessionId: `cks_sp_${suffix}`.slice(0, 32),
    orderId: `ord_sp_${suffix}`.slice(0, 32),
  };
}

async function seedProviderCheckout(db: Database, ids: ProviderSeedIds) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60_000);

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: ids.tenantId,
        name: `Stripe provider ${ids.suffix}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('organizations')
      .values({
        id: ids.organizationId,
        tenant_id: ids.tenantId,
        name: `Stripe provider ${ids.suffix}`,
        slug: `stripe-provider-${ids.suffix}`,
        clerk_organization_id: null,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('brands')
      .values({
        id: ids.brandId,
        tenant_id: ids.tenantId,
        organization_id: ids.organizationId,
        name: `Stripe provider ${ids.suffix}`,
        slug: `stripe-provider-${ids.suffix}`,
        status: 'active',
        theme: JSON.stringify({}),
        email_identity_id: null,
        sms_identity_id: null,
        payment_account_id: null,
        support_url: null,
        legal_urls: JSON.stringify({}),
        white_label: false,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('events')
      .values({
        id: ids.eventId,
        tenant_id: ids.tenantId,
        organization_id: ids.organizationId,
        brand_id: ids.brandId,
        slug: `stripe-provider-${ids.suffix}`,
        title: `Stripe provider ${ids.suffix}`,
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date(now.getTime() + 24 * 60 * 60_000),
        ends_at: null,
        venue: null,
        visibility: 'public',
        seo: JSON.stringify({}),
        capacity: null,
        cover_image_url: null,
        external_url: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('inventory_pools')
      .values({
        id: ids.inventoryPoolId,
        event_id: ids.eventId,
        name: 'Stripe provider pool',
        total_capacity: 10,
        reserved_count: 1,
        sold_count: 0,
        hold_ttl_seconds: 900,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('ticket_types')
      .values({
        id: ids.ticketTypeId,
        event_id: ids.eventId,
        name: 'Stripe Provider Admission',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 100,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 1,
        inventory_pool_id: ids.inventoryPoolId,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('checkout_holds')
      .values({
        id: ids.holdId,
        inventory_pool_id: ids.inventoryPoolId,
        checkout_session_id: ids.checkoutSessionId,
        ticket_type_id: ids.ticketTypeId,
        quantity: 1,
        expires_at: expiresAt,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('checkout_sessions')
      .values({
        id: ids.checkoutSessionId,
        tenant_id: ids.tenantId,
        event_id: ids.eventId,
        brand_id: ids.brandId,
        status: 'pending_payment',
        hold_id: ids.holdId,
        currency: 'USD',
        cart: JSON.stringify({ items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }] }),
        buyer: JSON.stringify({
          email: `stripe-provider+${ids.suffix}@example.com`,
          firstName: 'Stripe',
          lastName: 'Buyer',
        }),
        quote: JSON.stringify({
          subtotalCents: 100,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 100,
          currency: 'USD',
        }),
        payment_intent_id: null,
        order_id: null,
        success_url: null,
        cancel_url: null,
        expires_at: expiresAt,
        idempotency_key: `stripe-provider-${ids.suffix}`,
        client_token: `stripe-provider-token-${ids.suffix}`,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

async function createPaidOrderForProviderIntent(
  db: Database,
  ids: ProviderSeedIds,
  paymentIntentId: string,
) {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('orders')
      .values({
        id: ids.orderId,
        tenant_id: ids.tenantId,
        organization_id: ids.organizationId,
        brand_id: ids.brandId,
        event_id: ids.eventId,
        checkout_session_id: ids.checkoutSessionId,
        order_number: `TK-SP-${ids.suffix}`.slice(0, 50),
        status: 'paid',
        currency: 'USD',
        subtotal_cents: 100,
        discount_cents: 0,
        tax_cents: 0,
        fee_cents: 0,
        total_cents: 100,
        refunded_cents: 0,
        buyer_email: `stripe-provider+${ids.suffix}@example.com`,
        buyer_first_name: 'Stripe',
        buyer_last_name: 'Buyer',
        buyer_phone: null,
        payment_intent_id: paymentIntentId,
        payment_provider: 'stripe',
        paid_at: now,
        refunded_at: null,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .updateTable('payment_intents')
      .set({ order_id: ids.orderId, status: 'succeeded', updated_at: now })
      .where('id', '=', paymentIntentId)
      .execute();

    await trx
      .updateTable('checkout_sessions')
      .set({ status: 'completed', order_id: ids.orderId, updated_at: now })
      .where('id', '=', ids.checkoutSessionId)
      .execute();
  });
}

async function cleanupProviderRows(db: Database, ids: ProviderSeedIds) {
  await db.deleteFrom('order_timeline_events').where('order_id', '=', ids.orderId).execute();
  await db.deleteFrom('refunds').where('order_id', '=', ids.orderId).execute();
  await db
    .deleteFrom('payment_intents')
    .where('checkout_session_id', '=', ids.checkoutSessionId)
    .execute();
  await db.deleteFrom('orders').where('id', '=', ids.orderId).execute();
  await db.deleteFrom('checkout_sessions').where('id', '=', ids.checkoutSessionId).execute();
  await db.deleteFrom('checkout_holds').where('id', '=', ids.holdId).execute();
  await db.deleteFrom('ticket_types').where('id', '=', ids.ticketTypeId).execute();
  await db.deleteFrom('inventory_pools').where('id', '=', ids.inventoryPoolId).execute();
  await db.deleteFrom('events').where('id', '=', ids.eventId).execute();
  await db.deleteFrom('brands').where('id', '=', ids.brandId).execute();
  await db.deleteFrom('organizations').where('id', '=', ids.organizationId).execute();
  await db.deleteFrom('tenants').where('id', '=', ids.tenantId).execute();
}

describeProvider('Stripe provider validation', () => {
  let db: Database;
  let stripe: Stripe;
  let ids: ProviderSeedIds;
  let providerIntentId: string | undefined;
  let providerRefundSucceeded = false;

  beforeAll(() => {
    requiredEnv('DATABASE_URL');
    requiredEnv('STRIPE_SECRET_KEY');
    stripe = new Stripe(requiredEnv('STRIPE_SECRET_KEY'));
  });

  afterEach(async () => {
    if (providerIntentId && !providerRefundSucceeded) {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(providerIntentId);
        if (paymentIntent.status === 'succeeded') {
          await stripe.refunds.create(
            { payment_intent: providerIntentId },
            { idempotencyKey: `tixkit-provider-cleanup-${ids.suffix}` },
          );
        } else if (paymentIntent.status !== 'canceled') {
          await stripe.paymentIntents.cancel(providerIntentId);
        }
      } catch {
        // Best-effort provider cleanup. The test assertions report primary failures.
      }
    }

    if (db) {
      await cleanupProviderRows(db, ids).catch(() => undefined);
      await db.destroy();
    }
    providerIntentId = undefined;
    providerRefundSucceeded = false;
  });

  it('creates, confirms, and refunds a real Stripe test-mode PaymentIntent through workflow activities', async () => {
    ids = makeSeedIds();
    db = createDb();
    await seedProviderCheckout(db, ids);

    const paymentResult = await createPaymentIntentActivity({
      checkoutSessionId: ids.checkoutSessionId,
      tenantId: ids.tenantId,
      brandId: ids.brandId,
      amountCents: 100,
      currency: 'USD',
      description: 'Tixkit provider validation',
    });

    expect(paymentResult.ok).toBe(true);
    if (!paymentResult.ok) throw new Error(paymentResult.message);
    providerIntentId = paymentResult.value.providerIntentId;
    expect(providerIntentId).toMatch(/^pi_/);
    expect(paymentResult.value.clientSecret).toEqual(expect.any(String));

    const paymentIntentRow = await db
      .selectFrom('payment_intents')
      .select([
        'id',
        'provider',
        'provider_intent_id',
        'amount_cents',
        'currency',
        'payment_account_id',
      ])
      .where('checkout_session_id', '=', ids.checkoutSessionId)
      .executeTakeFirstOrThrow();
    expect(paymentIntentRow).toMatchObject({
      provider: 'stripe',
      provider_intent_id: providerIntentId,
      amount_cents: '100',
      currency: 'USD',
      payment_account_id: null,
    });

    const confirmed = await stripe.paymentIntents.confirm(
      providerIntentId,
      {
        payment_method: 'pm_card_visa',
        return_url: 'https://example.com/tixkit-provider-validation',
      },
      { idempotencyKey: `tixkit-provider-confirm-${ids.suffix}` },
    );
    expect(confirmed.status).toBe('succeeded');

    await createPaidOrderForProviderIntent(db, ids, paymentIntentRow.id);

    const refundResult = await processRefundActivity({
      orderId: ids.orderId,
      amountCents: 100,
      reason: 'Provider validation',
      idempotencyKey: `tixkit-provider-refund-${ids.suffix}`,
      nonce: ids.suffix,
    });

    expect(refundResult.ok).toBe(true);
    if (!refundResult.ok) throw new Error(refundResult.message);
    providerRefundSucceeded = true;
    expect(refundResult.value).toMatchObject({
      providerRefundId: expect.stringMatching(/^re_/),
      status: 'succeeded',
    });

    const [refundRow, orderRow] = await Promise.all([
      db
        .selectFrom('refunds')
        .select(['provider', 'provider_refund_id', 'amount_cents', 'status'])
        .where('order_id', '=', ids.orderId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('orders')
        .select(['status', 'refunded_cents', 'refunded_at'])
        .where('id', '=', ids.orderId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(refundRow).toMatchObject({
      provider: 'stripe',
      provider_refund_id: refundResult.value.providerRefundId,
      amount_cents: '100',
      status: 'succeeded',
    });
    expect(orderRow.status).toBe('refunded');
    expect(orderRow.refunded_cents).toBe('100');
    expect(orderRow.refunded_at).toBeInstanceOf(Date);
  }, 60_000);
});
