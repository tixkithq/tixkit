import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import { runMigrations } from '@tixkit/db/migrate';
import { OrderRepository, PaymentIntentRepository, RefundRepository } from '@tixkit/db';
import { ulid } from 'ulid';
import {
  reconcilePaymentActivity,
  reconcileRefundActivity,
} from '../activities/payment-reconciliation.js';
import {
  processRefundActivity,
  restoreInventoryActivity,
  updateLedgerActivity,
} from '../activities/refund.js';

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
  input: {
    status?: string;
    totalCents?: number;
    paymentProvider?: string;
  } = {},
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
        payment_provider: input.paymentProvider ?? 'stripe',
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
    provider: input.paymentProvider ?? 'stripe',
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
  const previousRuntimeMode = process.env.TIXKIT_RUNTIME_MODE;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.TIXKIT_RUNTIME_MODE = 'sandbox';
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
    if (previousRuntimeMode === undefined) {
      delete process.env.TIXKIT_RUNTIME_MODE;
    } else {
      process.env.TIXKIT_RUNTIME_MODE = previousRuntimeMode;
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

    expect(firstResult, JSON.stringify(firstResult)).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'paid' },
    });
    expect(replayResult, JSON.stringify(replayResult)).toMatchObject({
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
      data: {
        id: providerRefundId,
        payment_intent: ids.providerIntentId,
        amount: 3_000,
      },
    });
    const replayResult = await reconcileRefundActivity({
      providerEventId: `evt_ref_replay_${ids.suffix}`,
      provider: 'stripe',
      eventType: 'refund.created',
      data: {
        id: providerRefundId,
        payment_intent: ids.providerIntentId,
        amount: 3_000,
      },
    });

    expect(firstResult, JSON.stringify(firstResult)).toMatchObject({
      ok: true,
      value: { orderId: ids.orderId, status: 'partially_refunded' },
    });
    expect(replayResult, JSON.stringify(replayResult)).toMatchObject({
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
    const ids = await seedPaidOrder(db, {
      paymentProvider: 'stripe_capture',
    });
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

    expect(firstRefund).toMatchObject({
      ok: true,
      value: { status: 'succeeded' },
    });
    expect(replayRefund).toEqual(firstRefund);

    const providerRefundId = firstRefund.ok ? firstRefund.value.providerRefundId : '';
    const [firstLedger, replayLedger] = await Promise.all([
      updateLedgerActivity({
        orderId: ids.orderId,
        refundAmountCents: 2_500,
        providerRefundId,
      }),
      updateLedgerActivity({
        orderId: ids.orderId,
        refundAmountCents: 2_500,
        providerRefundId,
      }),
    ]);

    expect(firstLedger).toEqual({ ok: true, value: { balanced: true } });
    expect(replayLedger).toEqual({ ok: true, value: { balanced: true } });

    const order = await new OrderRepository(db).findById(ids.orderId);
    const refunds = await new RefundRepository(db).findByOrder(ids.orderId);
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);
    const ledgerEvents = timeline.filter((event) => event.type === 'ledger.refund');

    expect(Number(order?.refunded_cents)).toBe(2_500);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      provider: 'stripe_capture',
      provider_refund_id: `local-refund:${ids.orderId}:nonce-${ids.suffix}`,
      request_idempotency_key: `refund-key-${ids.suffix}:nonce-${ids.suffix}`,
      request_nonce: `nonce-${ids.suffix}`,
      status: 'succeeded',
    });
    expect(ledgerEvents).toHaveLength(1);
    expect(parseMetadata(ledgerEvents[0].metadata)).toMatchObject({
      providerRefundId,
      provider: 'stripe_capture',
      requestIdempotencyKey: `refund-key-${ids.suffix}:nonce-${ids.suffix}`,
      requestNonce: `nonce-${ids.suffix}`,
      balanced: true,
      refundCents: 2_500,
    });
  });

  it('fails closed on malformed persisted ledger history without appending an event', async () => {
    const ids = await seedPaidOrder(db, { paymentProvider: 'stripe_capture' });
    seededTenantIds.add(ids.tenantId);
    const nonce = `malformed-${ids.suffix}`;
    const requestKey = `refund-malformed-${ids.suffix}`;
    const refund = await processRefundActivity({
      orderId: ids.orderId,
      amountCents: 2_500,
      reason: 'Malformed ledger parity proof',
      idempotencyKey: requestKey,
      nonce,
    });
    expect(refund).toEqual({
      ok: true,
      value: {
        providerRefundId: `local-refund:${ids.orderId}:${nonce}`,
        status: 'succeeded',
      },
    });
    const providerRefundId = refund.ok ? refund.value.providerRefundId : '';
    await db
      .insertInto('order_timeline_events')
      .values({
        id: `ote_mp_${ids.suffix}`,
        order_id: ids.orderId,
        type: 'ledger.refund',
        description: 'Malformed prior ledger parity fixture',
        metadata: JSON.stringify({
          providerRefundId,
          provider: 'stripe_capture',
          requestIdempotencyKey: `${requestKey}:${nonce}`,
          requestNonce: nonce,
          refundReservationStatus: 'succeeded',
          currency: 'USD',
          grossRefundCents: 2_325,
          taxRefundCents: -1,
          feeRefundCents: 75,
          refundCents: 2_500,
          netRevenueDeltaCents: -2_326,
          entries: [
            { account: 'refunds', direction: 'debit', amountCents: 2_500 },
            { account: 'cash', direction: 'credit', amountCents: 2_500 },
          ],
          balanced: true,
        }),
        actor_id: null,
        created_at: new Date(),
      })
      .execute();
    const timelineBefore = await new OrderRepository(db).getTimeline(ids.orderId);

    const result = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 2_500,
      providerRefundId,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'REFUND_LEDGER_HISTORY_INVALID',
      message: 'Persisted refund ledger history is malformed or inconsistent',
      retryable: false,
    });
    const timelineAfter = await new OrderRepository(db).getTimeline(ids.orderId);
    expect(timelineAfter).toEqual(timelineBefore);
    expect(timelineAfter.filter((event) => event.type === 'ledger.refund')).toHaveLength(1);
  });

  it('upgrades exact legacy webhook refund and ledger evidence before another partial refund', async () => {
    const ids = await seedPaidOrder(db, { paymentProvider: 'stripe_capture' });
    seededTenantIds.add(ids.tenantId);
    const legacyProviderRefundId = `re_legacy_${ids.suffix}`;
    const legacyRefund = await new RefundRepository(db).create({
      tenantId: ids.tenantId,
      orderId: ids.orderId,
      provider: 'stripe',
      providerRefundId: legacyProviderRefundId,
      amountCents: 4_000,
      currency: 'USD',
      reason: 'Stripe webhook',
      status: 'succeeded',
    });
    await db
      .updateTable('refunds')
      .set({
        metadata: JSON.stringify({
          voidedTicketIds: [],
          inventoryRestored: true,
          inventoryRestoredCount: 0,
          inventoryRestoredByTicketType: {},
        }),
      })
      .where('id', '=', legacyRefund.id)
      .execute();
    await db
      .updateTable('orders')
      .set({ refunded_cents: 4_000, status: 'partially_refunded', refunded_at: new Date() })
      .where('id', '=', ids.orderId)
      .execute();
    await db
      .insertInto('order_timeline_events')
      .values({
        id: `ote_lg_${ids.suffix}`,
        order_id: ids.orderId,
        type: 'ledger.refund',
        description: 'Legacy HEAD refund ledger',
        metadata: JSON.stringify({
          providerRefundId: legacyProviderRefundId,
          currency: 'USD',
          grossRefundCents: 3_600,
          taxRefundCents: 280,
          feeRefundCents: 120,
          refundCents: 4_000,
          netRevenueDeltaCents: -3_720,
          entries: [
            { account: 'refunds', direction: 'debit', amountCents: 4_000 },
            { account: 'cash', direction: 'credit', amountCents: 4_000 },
          ],
          balanced: true,
        }),
        actor_id: null,
        created_at: new Date(),
      })
      .execute();

    const nonce = `upgrade-${ids.suffix}`;
    const requestKey = `refund-upgrade-${ids.suffix}`;
    const nextRefund = await processRefundActivity({
      orderId: ids.orderId,
      amountCents: 6_000,
      reason: 'Post-upgrade partial',
      idempotencyKey: requestKey,
      nonce,
    });
    expect(nextRefund).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    const nextProviderRefundId = nextRefund.ok ? nextRefund.value.providerRefundId : '';
    const firstLedger = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 6_000,
      providerRefundId: nextProviderRefundId,
    });
    const replayLedger = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 6_000,
      providerRefundId: nextProviderRefundId,
    });
    expect(firstLedger).toEqual({ ok: true, value: { balanced: true } });
    expect(replayLedger).toEqual(firstLedger);

    const persistedLegacyRefund = await db
      .selectFrom('refunds')
      .selectAll()
      .where('id', '=', legacyRefund.id)
      .executeTakeFirstOrThrow();
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);
    const ledgers = timeline
      .filter((event) => event.type === 'ledger.refund')
      .map((event) => parseMetadata(event.metadata));
    expect(persistedLegacyRefund.request_idempotency_key).toBe(
      `provider:stripe:${legacyProviderRefundId}`,
    );
    expect(persistedLegacyRefund.request_nonce).toBe(`legacy-webhook-v1:${legacyRefund.id}`);
    expect(parseMetadata(persistedLegacyRefund.metadata)).toMatchObject({
      voidedTicketIds: [],
      inventoryRestored: true,
      inventoryRestoredCount: 0,
      inventoryRestoredByTicketType: {},
      refundReservationStatus: 'succeeded',
      stripeRefundId: legacyProviderRefundId,
      stripeIdempotencyKey: `provider:stripe:${legacyProviderRefundId}`,
      refundNonce: `legacy-webhook-v1:${legacyRefund.id}`,
      ledgerNormalizationVersion: 'legacy-head-refund-ledger-v1',
    });
    const restored = await restoreInventoryActivity({
      orderId: ids.orderId,
      amountCents: 4_000,
      isFullRefund: false,
      providerRefundId: legacyProviderRefundId,
      voidedTicketIds: [],
    });
    expect(restored).toEqual({ ok: true, value: { restored: 0 } });
    const afterRestore = await db
      .selectFrom('refunds')
      .select(['metadata'])
      .where('id', '=', legacyRefund.id)
      .executeTakeFirstOrThrow();
    expect(afterRestore.metadata).toEqual(persistedLegacyRefund.metadata);
    expect(ledgers).toHaveLength(2);
    expect(ledgers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRefundId: legacyProviderRefundId,
          provider: 'stripe',
          requestNonce: `legacy-webhook-v1:${legacyRefund.id}`,
          normalizationVersion: 'legacy-head-refund-ledger-v1',
        }),
        expect.objectContaining({ providerRefundId: nextProviderRefundId }),
      ]),
    );
    expect(ledgers.reduce((sum, metadata) => sum + Number(metadata.refundCents), 0)).toBe(10_000);
    expect(ledgers.reduce((sum, metadata) => sum + Number(metadata.taxRefundCents), 0)).toBe(700);
    expect(ledgers.reduce((sum, metadata) => sum + Number(metadata.feeRefundCents), 0)).toBe(300);
  });

  it('serializes concurrent partial-refund ledgers and rejects conflicting sources', async () => {
    const ids = await seedPaidOrder(db, {
      paymentProvider: 'stripe_capture',
    });
    seededTenantIds.add(ids.tenantId);
    const firstNonce = `partial-a-${ids.suffix}`;
    const secondNonce = `partial-b-${ids.suffix}`;
    const firstKey = `refund-a-${ids.suffix}`;
    const secondKey = `refund-b-${ids.suffix}`;

    const refunds = await Promise.all([
      processRefundActivity({
        orderId: ids.orderId,
        amountCents: 5_001,
        reason: 'First partial',
        idempotencyKey: firstKey,
        nonce: firstNonce,
      }),
      processRefundActivity({
        orderId: ids.orderId,
        amountCents: 4_999,
        reason: 'Second partial',
        idempotencyKey: secondKey,
        nonce: secondNonce,
      }),
    ]);
    expect(refunds).toEqual([
      {
        ok: true,
        value: {
          providerRefundId: `local-refund:${ids.orderId}:${firstNonce}`,
          status: 'succeeded',
        },
      },
      {
        ok: true,
        value: {
          providerRefundId: `local-refund:${ids.orderId}:${secondNonce}`,
          status: 'succeeded',
        },
      },
    ]);

    const firstProviderRefundId = refunds[0].ok ? refunds[0].value.providerRefundId : '';
    const secondProviderRefundId = refunds[1].ok ? refunds[1].value.providerRefundId : '';
    const ledgerResults = await Promise.all([
      updateLedgerActivity({
        orderId: ids.orderId,
        refundAmountCents: 5_001,
        providerRefundId: firstProviderRefundId,
      }),
      updateLedgerActivity({
        orderId: ids.orderId,
        refundAmountCents: 4_999,
        providerRefundId: secondProviderRefundId,
      }),
      updateLedgerActivity({
        orderId: ids.orderId,
        refundAmountCents: 5_001,
        providerRefundId: firstProviderRefundId,
      }),
    ]);
    expect(ledgerResults).toEqual([
      { ok: true, value: { balanced: true } },
      { ok: true, value: { balanced: true } },
      { ok: true, value: { balanced: true } },
    ]);

    const amountConflict = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 5_000,
      providerRefundId: firstProviderRefundId,
    });
    const sourceConflict = await updateLedgerActivity({
      orderId: ids.orderId,
      refundAmountCents: 1,
      providerRefundId: `local-refund:another-order:${firstNonce}`,
    });
    expect(amountConflict).toEqual({
      ok: false,
      errorCode: 'REFUND_LEDGER_AMOUNT_CONFLICT',
      message: 'Ledger refund amount does not match the persisted provider refund',
      retryable: false,
    });
    expect(sourceConflict).toEqual({
      ok: false,
      errorCode: 'REFUND_LEDGER_SOURCE_INVALID',
      message: 'Ledger entries require a persisted succeeded refund for the same order',
      retryable: false,
    });

    const order = await new OrderRepository(db).findById(ids.orderId);
    const persistedRefunds = await new RefundRepository(db).findByOrder(ids.orderId);
    const timeline = await new OrderRepository(db).getTimeline(ids.orderId);
    const ledgerMetadata = timeline
      .filter((event) => event.type === 'ledger.refund')
      .map((event) => parseMetadata(event.metadata));

    expect(Number(order?.refunded_cents)).toBe(10_000);
    expect(order?.status).toBe('refunded');
    expect(persistedRefunds).toHaveLength(2);
    expect(persistedRefunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'stripe_capture',
          provider_refund_id: firstProviderRefundId,
          request_idempotency_key: `${firstKey}:${firstNonce}`,
          request_nonce: firstNonce,
          status: 'succeeded',
        }),
        expect.objectContaining({
          provider: 'stripe_capture',
          provider_refund_id: secondProviderRefundId,
          request_idempotency_key: `${secondKey}:${secondNonce}`,
          request_nonce: secondNonce,
          status: 'succeeded',
        }),
      ]),
    );
    expect(
      persistedRefunds.map((refund) => Number(refund.amount_cents)).sort((a, b) => a - b),
    ).toEqual([4_999, 5_001]);
    expect(ledgerMetadata).toHaveLength(2);
    expect(ledgerMetadata.reduce((sum, metadata) => sum + Number(metadata.refundCents), 0)).toBe(
      10_000,
    );
    expect(ledgerMetadata.reduce((sum, metadata) => sum + Number(metadata.taxRefundCents), 0)).toBe(
      700,
    );
    expect(ledgerMetadata.reduce((sum, metadata) => sum + Number(metadata.feeRefundCents), 0)).toBe(
      300,
    );
    expect(ledgerMetadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRefundId: firstProviderRefundId,
          provider: 'stripe_capture',
          requestIdempotencyKey: `${firstKey}:${firstNonce}`,
          requestNonce: firstNonce,
          balanced: true,
        }),
        expect.objectContaining({
          providerRefundId: secondProviderRefundId,
          provider: 'stripe_capture',
          requestIdempotencyKey: `${secondKey}:${secondNonce}`,
          requestNonce: secondNonce,
          balanced: true,
        }),
      ]),
    );
  });
});
