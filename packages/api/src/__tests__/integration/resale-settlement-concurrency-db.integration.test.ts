import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  AttendeeRepository,
  CheckoutSessionRepository,
  createDb,
  OrderRepository,
  ResaleSettlementRepository,
  TicketListingRepository,
  TicketRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const TERMS_VERSION = '2026-07-16';
const TERMS_ACCEPTANCE = {
  accepted: true,
  termsVersion: TERMS_VERSION,
  settlementModel: 'organizer_managed',
  refundModel: 'manual_coordinated_resolution',
} as const;
const PAYABLE_CENTS = 2_160;

describeWithIntegrationDatabase('resale settlement HTTP concurrency persistence', () => {
  const driver = integrationDatabaseDriver();
  const runId = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_rsc_${runId}`;
  const organizationId = `org_rsc_${runId}`;
  const brandId = `brd_rsc_${runId}`;
  const eventId = `evt_rsc_${runId}`;
  const poolId = `pool_rsc_${runId}`;
  const ticketTypeId = `tt_rsc_${runId}`;
  const principalId = `usr_rsc_${runId}`;
  let db: Database;
  let app: FastifyInstance;
  let previousDriver: string | undefined;

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: principalId,
      tenantId,
      organizationIds: [organizationId],
      brandIds: [brandId],
      eventIds: [eventId],
      scopes: ['orders.read', 'billing.write'],
      ...overrides,
    };
  }

  async function buildApp(activePrincipal: Principal): Promise<FastifyInstance> {
    const routeApp = Fastify({ logger: false });
    routeApp.decorate('context', { db } as AppContext);
    routeApp.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(routeApp);
    await routeApp.register(ticketingRoutes);
    return routeApp;
  }

  async function createFixture(label: string) {
    async function createOrderWithTicket(role: 'seller' | 'buyer') {
      const suffix = `${label}_${role}`;
      const checkout = await new CheckoutSessionRepository(db).create({
        tenantId,
        eventId,
        brandId,
        currency: 'USD',
        cart: { items: [{ ticketTypeId, quantity: 1 }] },
        buyer: { email: `${suffix}@example.test` },
        quote: { totalCents: 2_500 },
        expiresAt: new Date('2027-01-01T17:00:00.000Z'),
        idempotencyKey: `rsc-${driver}-${runId}-${suffix}`,
      });
      const order = await new OrderRepository(db).create({
        tenantId,
        organizationId,
        brandId,
        eventId,
        checkoutSessionId: checkout.id,
        orderNumber: `RSC-${runId}-${suffix}`,
        status: 'paid',
        currency: 'USD',
        subtotalCents: 2_500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 2_500,
        buyerEmail: `${suffix}@example.test`,
      });
      const attendee = await new AttendeeRepository(db).create({
        tenantId,
        orderId: order.id,
        eventId,
        ticketTypeId,
        email: `${suffix}@example.test`,
      });
      const ticket = await new TicketRepository(db).create({
        tenantId,
        orderId: order.id,
        attendeeId: attendee.id,
        eventId,
        ticketTypeId,
        code: `RSC-${runId}-${suffix}`,
        qrPayload: `rsc-payload-${runId}-${suffix}`,
        qrHash: `rsc-hash-${runId}-${suffix}`,
      });
      return { order, ticket };
    }

    const seller = await createOrderWithTicket('seller');
    const buyer = await createOrderWithTicket('buyer');
    const listingRepository = new TicketListingRepository(db);
    const listing = await listingRepository.create({
      tenantId,
      eventId,
      ticketId: seller.ticket.id,
      sellerId: seller.order.id,
      priceCents: 2_400,
      currency: 'USD',
      faceValueCents: 2_500,
      termsAcceptance: TERMS_ACCEPTANCE,
    });
    await listingRepository.markSold(listing.id, buyer.order.id);
    const scope = { tenantId, organizationId, brandId, eventId, listingId: listing.id };
    const settlement = await db.transaction().execute(async (transaction) =>
      new ResaleSettlementRepository(transaction).createAndAccrue({
        ...scope,
        sellerOrderId: seller.order.id,
        buyerOrderId: buyer.order.id,
        sellerTicketId: seller.ticket.id,
        buyerTicketId: buyer.ticket.id,
        currency: 'USD',
        grossCents: 2_400,
        feeCents: 240,
        payableCents: PAYABLE_CENTS,
        termsVersion: TERMS_VERSION,
        evidence: {
          idempotencyKey: `rsc-accrual-${runId}-${label}`,
          actorId: 'system:checkout',
          method: 'checkout_workflow',
        },
      }),
    );
    return { listing, settlement, scope };
  }

  function payoutRequest(
    listingId: string,
    key: string,
    reference: string,
    amount = PAYABLE_CENTS,
  ) {
    return app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': key },
      payload: {
        amountCents: amount,
        currency: 'USD',
        expectedVersion: 1,
        method: 'bank_transfer',
        externalReference: reference,
      },
    });
  }

  function reversalRequest(listingId: string, key: string, reason: string) {
    return app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/reversals`,
      headers: { 'idempotency-key': key },
      payload: {
        amountCents: PAYABLE_CENTS,
        currency: 'USD',
        expectedVersion: 1,
        method: 'accounting_adjustment',
        reason,
      },
    });
  }

  async function persisted(listingId: string) {
    const settlement = await db
      .selectFrom('resale_settlements')
      .selectAll()
      .where('listing_id', '=', listingId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const entries = await db
      .selectFrom('resale_settlement_entries')
      .selectAll()
      .where('settlement_id', '=', settlement.id)
      .orderBy('created_at', 'asc')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', settlement.id)
      .execute();
    return { settlement, entries, audits };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: `RSC ${driver} ${runId}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organizations')
      .values({
        id: organizationId,
        tenant_id: tenantId,
        name: `RSC ${driver} organization ${runId}`,
        slug: `rsc-${driver}-${runId}`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('brands')
      .values({
        id: brandId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: `RSC ${driver} brand ${runId}`,
        slug: `rsc-${driver}-${runId}`,
        status: 'active',
        theme: '{}',
        legal_urls: '{}',
        white_label: false,
        payment_account_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('events')
      .values({
        id: eventId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        slug: `rsc-${driver}-${runId}`,
        title: 'Resale settlement concurrency',
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date('2027-01-01T18:00:00.000Z'),
        ends_at: null,
        venue: null,
        visibility: 'public',
        seo: '{}',
        capacity: null,
        cover_image_url: null,
        external_url: null,
        resale_enabled: true,
        resale_max_multiplier: 1.2,
        resale_max_absolute_cents: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('inventory_pools')
      .values({
        id: poolId,
        event_id: eventId,
        name: 'General admission',
        total_capacity: 20,
        reserved_count: 0,
        sold_count: 10,
        hold_ttl_seconds: 300,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('ticket_types')
      .values({
        id: ticketTypeId,
        event_id: eventId,
        name: 'GA',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 2_500,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: poolId,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    app = await buildApp(principal());
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
      await db?.destroy();
    } finally {
      restoreDatabaseDriver(previousDriver);
    }
  }, 120_000);

  it('serializes exact concurrent payout replay into one entry and audit', async () => {
    const fixture = await createFixture('payout_replay');
    const key = `payout-replay-${runId}`;
    const reference = `provider-payout-${runId}`;
    const responses = await Promise.all([
      payoutRequest(fixture.listing.id, key, reference),
      payoutRequest(fixture.listing.id, key, reference),
    ]);
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    const state = await persisted(fixture.listing.id);
    expect(state.settlement).toMatchObject({ state: 'paid', version: 2 });
    expect(Number(state.settlement.paid_cents)).toBe(PAYABLE_CENTS);
    expect(state.entries.filter(({ kind }) => kind === 'payout_recorded')).toHaveLength(1);
    expect(
      state.audits.filter(({ action }) => action === 'resale.settlement.payout_recorded'),
    ).toHaveLength(1);
    const serialized = JSON.stringify({ entries: state.entries, audits: state.audits });
    expect(serialized).toContain(createHash('sha256').update(reference).digest('hex'));
    expect(serialized).not.toContain(reference);
  });

  it('allows exactly one divergent concurrent payout and preserves money/version invariants', async () => {
    const fixture = await createFixture('payout_conflict');
    const responses = await Promise.all([
      payoutRequest(fixture.listing.id, `payout-a-${runId}`, `provider-a-${runId}`),
      payoutRequest(fixture.listing.id, `payout-b-${runId}`, `provider-b-${runId}`),
    ]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    expect(responses.find(({ statusCode }) => statusCode === 409)?.json().error.code).toBe(
      'CONFLICT',
    );
    const state = await persisted(fixture.listing.id);
    expect(state.settlement).toMatchObject({ state: 'paid', version: 2 });
    expect(Number(state.settlement.paid_cents)).toBe(PAYABLE_CENTS);
    expect(state.entries.filter(({ kind }) => kind === 'payout_recorded')).toHaveLength(1);
    expect(
      state.audits.filter(({ action }) => action === 'resale.settlement.payout_recorded'),
    ).toHaveLength(1);
  });

  it('allows exactly one concurrent payout or reversal and leaves a coherent terminal state', async () => {
    const fixture = await createFixture('mixed_conflict');
    const [payout, reversal] = await Promise.all([
      payoutRequest(fixture.listing.id, `mixed-payout-${runId}`, `mixed-provider-${runId}`),
      reversalRequest(fixture.listing.id, `mixed-reversal-${runId}`, 'Concurrent buyer refund'),
    ]);
    expect([payout.statusCode, reversal.statusCode].sort()).toEqual([200, 409]);
    const conflict = payout.statusCode === 409 ? payout : reversal;
    expect(conflict.json().error.code).toBe('CONFLICT');
    const state = await persisted(fixture.listing.id);
    expect(Number(state.settlement.version)).toBe(2);
    expect(state.entries).toHaveLength(2);
    expect(state.audits).toHaveLength(1);
    if (state.settlement.state === 'paid') {
      expect(Number(state.settlement.paid_cents)).toBe(PAYABLE_CENTS);
      expect(Number(state.settlement.reversed_cents)).toBe(0);
    } else {
      expect(state.settlement.state).toBe('reversed');
      expect(Number(state.settlement.paid_cents)).toBe(0);
      expect(Number(state.settlement.reversed_cents)).toBe(PAYABLE_CENTS);
    }
  });

  it('serializes exact concurrent reversal replay and rejects divergent reversal', async () => {
    const replayFixture = await createFixture('reversal_replay');
    const replayKey = `reversal-replay-${runId}`;
    const reason = 'Organizer coordinated buyer refund';
    const replayResponses = await Promise.all([
      reversalRequest(replayFixture.listing.id, replayKey, reason),
      reversalRequest(replayFixture.listing.id, replayKey, reason),
    ]);
    expect(replayResponses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    const replayState = await persisted(replayFixture.listing.id);
    expect(replayState.settlement).toMatchObject({ state: 'reversed', version: 2 });
    expect(Number(replayState.settlement.reversed_cents)).toBe(PAYABLE_CENTS);
    expect(replayState.entries.filter(({ kind }) => kind === 'payable_reversed')).toHaveLength(1);
    expect(
      replayState.audits.filter(({ action }) => action === 'resale.settlement.reversal_recorded'),
    ).toHaveLength(1);

    const conflictFixture = await createFixture('reversal_conflict');
    const conflictResponses = await Promise.all([
      reversalRequest(conflictFixture.listing.id, `reversal-a-${runId}`, 'Resolution A'),
      reversalRequest(conflictFixture.listing.id, `reversal-b-${runId}`, 'Resolution B'),
    ]);
    expect(conflictResponses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const conflictState = await persisted(conflictFixture.listing.id);
    expect(conflictState.settlement).toMatchObject({ state: 'reversed', version: 2 });
    expect(conflictState.entries.filter(({ kind }) => kind === 'payable_reversed')).toHaveLength(1);
    expect(
      conflictState.audits.filter(({ action }) => action === 'resale.settlement.reversal_recorded'),
    ).toHaveLength(1);
  });

  it('conceals the settlement from a cross-tenant principal before mutation', async () => {
    const fixture = await createFixture('scope_denial');
    const deniedApp = await buildApp(
      principal({
        tenantId: `tnt_other_${runId}`,
        organizationIds: [],
        brandIds: [],
        eventIds: [],
      }),
    );
    try {
      const denied = await deniedApp.inject({
        method: 'POST',
        url: `/ticket-listings/${fixture.listing.id}/settlement/payouts`,
        headers: { 'idempotency-key': `denied-${runId}` },
        payload: {
          amountCents: PAYABLE_CENTS,
          currency: 'USD',
          expectedVersion: 1,
          method: 'bank_transfer',
          externalReference: `denied-reference-${runId}`,
        },
      });
      expect(denied.statusCode).toBe(404);
      const state = await persisted(fixture.listing.id);
      expect(state.settlement).toMatchObject({ state: 'pending', version: 1 });
      expect(state.entries).toHaveLength(1);
      expect(state.audits).toHaveLength(0);
    } finally {
      await deniedApp.close();
    }
  });
});
