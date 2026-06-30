import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import { runMigrations } from '@tixkit/db/migrate';
import { OrderRepository, PaymentIntentRepository, RefundRepository } from '@tixkit/db';
import { ulid } from 'ulid';
import {
  reconcilePaymentActivity,
  reconcileRefundActivity,
} from '../activities/payment-reconciliation.js';
import { processRefundActivity, updateLedgerActivity } from '../activities/refund.js';

type IntegrationDriver = 'postgres' | 'mysql';

type SeedIds = {
  suffix: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  checkoutSessionId: string;
  orderId: string;
  providerIntentId: string;
};

const driver: IntegrationDriver =
  process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
const databaseUrl =
  driver === 'mysql' ? (process.env.DATABASE_URL_MYSQL ?? '') : (process.env.DATABASE_URL ?? '');
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function idSuffix(): string {
  return ulid().slice(-10).toLowerCase();
}

function seedIds(): SeedIds {
  const suffix = idSuffix();
  return {
    suffix,
    tenantId: `tnt_mp_${suffix}`,
    organizationId: `org_mp_${suffix}`,
    brandId: `brd_mp_${suffix}`,
    eventId: `evt_mp_${suffix}`,
    checkoutSessionId: `cs_mp_${suffix}`,
    orderId: `ord_mp_${suffix}`,
    providerIntentId: `pi_mp_${suffix}`,
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  return JSON.parse(value) as Record<string, unknown>;
}

async function seedPaidOrder(
  db: Database,
  input: { status?: string; totalCents?: number } = {},
): Promise<SeedIds> {
  const ids = seedIds();
  const now = new Date();
  const totalCents = input.totalCents ?? 10_000;
  const orderStatus = input.status ?? 'paid';

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: ids.tenantId,
        name: `MySQL parity ${ids.suffix}`,
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
        name: `MySQL parity ${ids.suffix}`,
        slug: `mysql-parity-${ids.suffix}`,
        clerk_organization_id: null,
        status: 'active',
        box_office_settings: JSON.stringify({
          enabled: false,
          allowedTenderTypes: ['cash', 'card', 'comp'],
          requireBuyerEmail: false,
          receiptMode: 'email',
        }),
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
        name: `MySQL parity ${ids.suffix}`,
        slug: `mysql-parity-${ids.suffix}`,
        status: 'active',
        theme: JSON.stringify({}),
        legal_urls: JSON.stringify({}),
        white_label: false,
        payment_account_id: null,
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
        slug: `mysql-parity-${ids.suffix}`,
        title: 'MySQL parity event',
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date(now.getTime() + 86_400_000),
        ends_at: null,
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
      .insertInto('checkout_sessions')
      .values({
        id: ids.checkoutSessionId,
        tenant_id: ids.tenantId,
        event_id: ids.eventId,
        brand_id: ids.brandId,
        status: 'completed',
        hold_id: `hld_mp_${ids.suffix}`,
        currency: 'USD',
        cart: JSON.stringify({ items: [] }),
        buyer: JSON.stringify({ email: `buyer-${ids.suffix}@example.com` }),
        quote: JSON.stringify({
          subtotalCents: totalCents,
          discountCents: 0,
          taxCents: 700,
          feeCents: 300,
          totalCents,
        }),
        expires_at: new Date(now.getTime() + 300_000),
        idempotency_key: `ik_mp_${ids.suffix}`,
        success_url: null,
        cancel_url: null,
        order_id: null,
        client_token: `tok_mp_${ids.suffix}`,
        payment_intent_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('orders')
      .values({
        id: ids.orderId,
        tenant_id: ids.tenantId,
        organization_id: ids.organizationId,
        brand_id: ids.brandId,
        event_id: ids.eventId,
        checkout_session_id: ids.checkoutSessionId,
        order_number: `TK-MP-${ids.suffix}`,
        status: orderStatus,
        currency: 'USD',
        subtotal_cents: totalCents - 1_000,
        discount_cents: 0,
        tax_cents: 700,
        fee_cents: 300,
        total_cents: totalCents,
        refunded_cents: 0,
        buyer_email: `buyer-${ids.suffix}@example.com`,
        buyer_first_name: 'MySQL',
        buyer_last_name: 'Parity',
        buyer_phone: null,
        payment_intent_id: null,
        payment_provider: 'stripe',
        paid_at: orderStatus === 'paid' ? now : null,
        refunded_at: null,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  const paymentIntent = await new PaymentIntentRepository(db).create({
    tenantId: ids.tenantId,
    checkoutSessionId: ids.checkoutSessionId,
    provider: 'stripe',
    providerIntentId: ids.providerIntentId,
    amountCents: totalCents,
    currency: 'USD',
    status: orderStatus === 'paid' ? 'succeeded' : 'requires_confirmation',
    orderId: ids.orderId,
  });

  await db
    .updateTable('orders')
    .set({ payment_intent_id: paymentIntent.id })
    .where('id', '=', ids.orderId)
    .execute();
  await db
    .updateTable('checkout_sessions')
    .set({ payment_intent_id: paymentIntent.id, order_id: ids.orderId })
    .where('id', '=', ids.checkoutSessionId)
    .execute();

  return ids;
}

async function cleanupTenant(db: Database, tenantId: string): Promise<void> {
  const orders = await db
    .selectFrom('orders')
    .select('id')
    .where('tenant_id', '=', tenantId)
    .execute();
  const orderIds = orders.map((order) => order.id);

  if (orderIds.length > 0) {
    await db.deleteFrom('order_timeline_events').where('order_id', 'in', orderIds).execute();
    await db.deleteFrom('order_line_items').where('order_id', 'in', orderIds).execute();
    await db.deleteFrom('refunds').where('order_id', 'in', orderIds).execute();
  }

  await db.deleteFrom('payment_events').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('payment_intents').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('orders').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('checkout_sessions').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('events').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('brands').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('organizations').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
}

describeWithDatabase(`workflow payment/refund Tier 1 parity (real ${driver})`, () => {
  let db: Database;
  const seededTenantIds = new Set<string>();
  const previousDriver = process.env.DB_DRIVER;
  const previousStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    delete process.env.STRIPE_SECRET_KEY;
    await runMigrations(databaseUrl);
    db = createDb(databaseUrl);
  }, 120_000);

  afterEach(async () => {
    await Promise.all([...seededTenantIds].map((tenantId) => cleanupTenant(db, tenantId)));
    seededTenantIds.clear();
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    if (previousDriver === undefined) {
      delete process.env.DB_DRIVER;
    } else {
      process.env.DB_DRIVER = previousDriver;
    }
    if (previousStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = previousStripeSecretKey;
    }
  }, 60_000);

  it('reconciles a provider success event into a paid order exactly once', async () => {
    const ids = await seedPaidOrder(db, { status: 'pending_payment' });
    seededTenantIds.add(ids.tenantId);

    const firstResult = await reconcilePaymentActivity({
      providerEventId: `evt_pay_${ids.suffix}`,
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: ids.providerIntentId, status: 'succeeded' },
    });
    const replayResult = await reconcilePaymentActivity({
      providerEventId: `evt_pay_replay_${ids.suffix}`,
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: ids.providerIntentId, status: 'succeeded' },
    });

    expect(firstResult).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'paid' },
    });
    expect(replayResult).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'succeeded' },
    });

    const order = await new OrderRepository(db).findById(ids.orderId);
    const paymentIntent = await new PaymentIntentRepository(db).findByProviderIntentId(
      ids.providerIntentId,
    );
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);

    expect(order?.status).toBe('paid');
    expect(paymentIntent?.status).toBe('succeeded');
    expect(timeline.filter((event) => event.type === 'order.paid')).toHaveLength(1);
  });

  it('reconciles refund webhooks without double-counting provider replays', async () => {
    const ids = await seedPaidOrder(db);
    seededTenantIds.add(ids.tenantId);
    const providerRefundId = `re_mp_${ids.suffix}`;

    const firstResult = await reconcileRefundActivity({
      providerEventId: `evt_ref_${ids.suffix}`,
      provider: 'stripe',
      eventType: 'refund.created',
      data: { id: providerRefundId, payment_intent: ids.providerIntentId, amount: 3_000 },
    });
    const replayResult = await reconcileRefundActivity({
      providerEventId: `evt_ref_replay_${ids.suffix}`,
      provider: 'stripe',
      eventType: 'refund.created',
      data: { id: providerRefundId, payment_intent: ids.providerIntentId, amount: 3_000 },
    });

    expect(firstResult).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'partially_refunded' },
    });
    expect(replayResult).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'partially_refunded' },
    });

    const order = await new OrderRepository(db).findById(ids.orderId);
    const refunds = await new RefundRepository(db).findByOrder(ids.orderId);
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);

    expect(Number(order?.refunded_cents)).toBe(3_000);
    expect(order?.status).toBe('partially_refunded');
    expect(refunds).toHaveLength(1);
    expect(refunds[0].provider_refund_id).toBe(providerRefundId);
    expect(timeline.filter((event) => event.type === 'order.refunded')).toHaveLength(1);
  });

  it('keeps refund processing and ledger updates idempotent and balanced', async () => {
    const ids = await seedPaidOrder(db);
    seededTenantIds.add(ids.tenantId);

    const firstRefund = await processRefundActivity({
      orderId: ids.orderId,
      amountCents: 2_500,
      reason: 'Customer request',
      idempotencyKey: `refund-key-${ids.suffix}`,
      nonce: `nonce-${ids.suffix}`,
    });
    const replayRefund = await processRefundActivity({
      orderId: ids.orderId,
      amountCents: 2_500,
      reason: 'Customer request',
      idempotencyKey: `refund-key-${ids.suffix}`,
      nonce: `nonce-${ids.suffix}`,
    });

    expect(firstRefund).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(replayRefund).toEqual(firstRefund);

    const providerRefundId = firstRefund.ok ? firstRefund.value.providerRefundId : '';
    const firstLedger = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 2_500,
      providerRefundId,
    });
    const replayLedger = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 2_500,
      providerRefundId,
    });

    expect(firstLedger).toEqual({ ok: true, value: { balanced: true } });
    expect(replayLedger).toEqual({ ok: true, value: { balanced: true } });

    const order = await new OrderRepository(db).findById(ids.orderId);
    const refunds = await new RefundRepository(db).findByOrder(ids.orderId);
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);
    const ledgerEvents = timeline.filter((event) => event.type === 'ledger.refund');

    expect(Number(order?.refunded_cents)).toBe(2_500);
    expect(refunds).toHaveLength(1);
    expect(ledgerEvents).toHaveLength(1);
    expect(parseMetadata(ledgerEvents[0].metadata)).toMatchObject({
      providerRefundId,
      balanced: true,
      refundCents: 2_500,
    });
  });
});
