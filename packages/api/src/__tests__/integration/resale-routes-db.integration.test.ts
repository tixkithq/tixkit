import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { QrService } from '../../services/qr.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const RUN_ID = ulid().slice(-10).toLowerCase();
const TENANT_ID = `tnt_resale_${RUN_ID}`;
const ORG_ID = `org_resale_${RUN_ID}`;
const BRAND_ID = `brd_resale_${RUN_ID}`;
const EVENT_ID = `evt_resale_${RUN_ID}`;
const SELLER_ID = `usr_resale_${RUN_ID}`;
const POOL_ID = `pool_resale_${RUN_ID}`;
const TICKET_TYPE_ID = `tt_resale_${RUN_ID}`;
const CHECKOUT_SESSION_ID = `chk_resale_${RUN_ID}`;
const ORDER_ID = `ord_resale_${RUN_ID}`;
const ATTENDEE_ID = `att_resale_${RUN_ID}`;
const TICKET_ID = `tkt_resale_${RUN_ID}`;
const WALLET_PASS_ID = `wps_resale_${RUN_ID}`;

let db: Database;
let app: FastifyInstance;
let previousDbDriver: string | undefined;

function makePrincipal(): Principal {
  return {
    type: 'user',
    id: SELLER_ID,
    tenantId: TENANT_ID,
    organizationIds: [ORG_ID],
    brandIds: [BRAND_ID],
    eventIds: [EVENT_ID],
    scopes: ['events.read', 'tickets.write'],
  };
}

async function setupRouteApp(database: Database): Promise<FastifyInstance> {
  const routeApp = Fastify();
  routeApp.decorate('context', {
    db: database,
    pricingEngine: {},
    inventoryService: {},
    qrService: new QrService('resale-db-test-secret'),
    authService: {
      isLocalDevMode: vi.fn(() => true),
      authenticateLocalDev: vi.fn(async () => ({ principal: makePrincipal() })),
    },
    temporalClient: {},
  } as unknown as AppContext);
  registerErrorHandler(routeApp);
  routeApp.addHook('onRequest', async (request) => {
    request.principal = makePrincipal();
  });
  await routeApp.register(ticketingRoutes);
  await routeApp.register(checkoutRoutes);
  return routeApp;
}

async function seedTenantGraph(database: Database): Promise<void> {
  const now = new Date();
  await database.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: TENANT_ID,
        name: `Resale DB ${RUN_ID}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('organizations')
      .values({
        id: ORG_ID,
        tenant_id: TENANT_ID,
        name: `Resale DB ${RUN_ID}`,
        slug: `resale-db-${RUN_ID}`,
        clerk_organization_id: null,
        box_office_settings: JSON.stringify({
          enabled: true,
          allowedTenderTypes: ['cash', 'manual_card', 'comp'],
          requireBuyerEmail: false,
          receiptMode: 'email',
        }),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('brands')
      .values({
        id: BRAND_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        name: `Resale DB ${RUN_ID}`,
        slug: `resale-db-${RUN_ID}`,
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
        id: EVENT_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        brand_id: BRAND_ID,
        slug: `resale-db-${RUN_ID}`,
        title: 'Resale DB Event',
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date(now.getTime() + 86_400_000),
        ends_at: null,
        venue: null,
        visibility: 'private',
        seo: JSON.stringify({}),
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
    await trx
      .insertInto('inventory_pools')
      .values({
        id: POOL_ID,
        event_id: EVENT_ID,
        name: 'Resale DB Pool',
        total_capacity: 5,
        reserved_count: 0,
        sold_count: 1,
        hold_ttl_seconds: 300,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('ticket_types')
      .values({
        id: TICKET_TYPE_ID,
        event_id: EVENT_ID,
        name: 'Resale DB Ticket',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        price_cents: 5000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: POOL_ID,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('checkout_sessions')
      .values({
        id: CHECKOUT_SESSION_ID,
        tenant_id: TENANT_ID,
        event_id: EVENT_ID,
        brand_id: BRAND_ID,
        status: 'completed',
        hold_id: null,
        currency: 'USD',
        cart: JSON.stringify({ items: [{ ticketTypeId: TICKET_TYPE_ID, quantity: 1 }] }),
        buyer: JSON.stringify({ email: 'resale-buyer@example.com' }),
        quote: JSON.stringify({ totalCents: 5000 }),
        payment_intent_id: null,
        order_id: ORDER_ID,
        success_url: null,
        cancel_url: null,
        expires_at: new Date(now.getTime() + 86_400_000),
        idempotency_key: `chk_${RUN_ID}`,
        client_token: `client_${RUN_ID}`,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('orders')
      .values({
        id: ORDER_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        brand_id: BRAND_ID,
        event_id: EVENT_ID,
        checkout_session_id: CHECKOUT_SESSION_ID,
        order_number: `TK-RESALE-${RUN_ID}`,
        status: 'paid',
        currency: 'USD',
        subtotal_cents: 5000,
        discount_cents: 0,
        tax_cents: 0,
        fee_cents: 0,
        total_cents: 5000,
        buyer_email: 'resale-buyer@example.com',
        buyer_first_name: 'Resale',
        buyer_last_name: 'Seller',
        buyer_phone: null,
        payment_intent_id: null,
        payment_provider: null,
        sales_channel: 'online',
        operator_id: null,
        tender_type: null,
        paid_at: now,
        refunded_at: null,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('attendees')
      .values({
        id: ATTENDEE_ID,
        tenant_id: TENANT_ID,
        order_id: ORDER_ID,
        event_id: EVENT_ID,
        event_occurrence_id: null,
        ticket_type_id: TICKET_TYPE_ID,
        ticket_id: TICKET_ID,
        first_name: 'Resale',
        last_name: 'Seller',
        email: 'resale-buyer@example.com',
        phone: null,
        status: 'confirmed',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('tickets')
      .values({
        id: TICKET_ID,
        tenant_id: TENANT_ID,
        order_id: ORDER_ID,
        attendee_id: ATTENDEE_ID,
        event_id: EVENT_ID,
        event_occurrence_id: null,
        ticket_type_id: TICKET_TYPE_ID,
        status: 'valid',
        code: `RESALE-${RUN_ID}`,
        qr_payload: `resale-payload-${RUN_ID}`,
        qr_hash: `resale-hash-${RUN_ID}`,
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: WALLET_PASS_ID,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('wallet_passes')
      .values({
        id: WALLET_PASS_ID,
        tenant_id: TENANT_ID,
        ticket_id: TICKET_ID,
        provider: 'apple',
        pass_url: `https://wallet.example/${RUN_ID}`,
        serial_number: `serial-${RUN_ID}`,
        status: 'active',
        metadata: JSON.stringify({}),
        revoked_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

async function cleanupAll(database: Database): Promise<void> {
  await database.deleteFrom('ticket_listings').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('wallet_passes').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('tickets').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('attendees').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('order_timeline_events').where('order_id', '=', ORDER_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('checkout_sessions').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function resetListings(database: Database): Promise<void> {
  await database.deleteFrom('ticket_listings').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('order_timeline_events').where('order_id', '=', ORDER_ID).execute();
  await database
    .deleteFrom('wallet_passes')
    .where('tenant_id', '=', TENANT_ID)
    .where('ticket_id', '!=', TICKET_ID)
    .execute();
  await database
    .deleteFrom('tickets')
    .where('tenant_id', '=', TENANT_ID)
    .where('id', '!=', TICKET_ID)
    .execute();
  await database
    .deleteFrom('attendees')
    .where('tenant_id', '=', TENANT_ID)
    .where('id', '!=', ATTENDEE_ID)
    .execute();
  await database
    .updateTable('tickets')
    .set({
      status: 'valid',
      transferred_to_email: null,
      transferred_at: null,
      wallet_pass_id: WALLET_PASS_ID,
      updated_at: new Date(),
    })
    .where('id', '=', TICKET_ID)
    .execute();
  await database
    .updateTable('attendees')
    .set({
      ticket_id: TICKET_ID,
      status: 'confirmed',
      checked_in_at: null,
      check_in_device_id: null,
      updated_at: new Date(),
    })
    .where('id', '=', ATTENDEE_ID)
    .execute();
  await database
    .updateTable('wallet_passes')
    .set({ status: 'active', revoked_at: null, updated_at: new Date() })
    .where('id', '=', WALLET_PASS_ID)
    .execute();
  await database
    .updateTable('events')
    .set({
      resale_enabled: true,
      resale_max_multiplier: 1.2,
      resale_max_absolute_cents: null,
      updated_at: new Date(),
    })
    .where('id', '=', EVENT_ID)
    .execute();
}

describeWithIntegrationDatabase(
  `resale listing route DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDbDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await cleanupAll(db).catch(() => undefined);
      await seedTenantGraph(db);
      app = await setupRouteApp(db);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      if (db) {
        await cleanupAll(db);
        await db.destroy();
      }
      restoreDatabaseDriver(previousDbDriver);
    }, 120_000);

    beforeEach(async () => {
      await resetListings(db);
    });

    it('creates, replays, lists, and delists a capped resale listing with real DB idempotency', async () => {
      const payload = { priceCents: 5500 };
      const idempotencyKey = `resale_db_${RUN_ID}`;
      const first = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': idempotencyKey },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': idempotencyKey },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const rows = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticket_id: TICKET_ID,
        status: 'listed',
        active_listing_key: TICKET_ID,
      });
      expect(Number(rows[0].price_cents)).toBe(5500);

      const duplicate = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_duplicate_${RUN_ID}` },
        payload,
      });
      expect(duplicate.statusCode).toBe(400);

      const list = await app.inject({
        method: 'GET',
        url: `/events/${EVENT_ID}/resale-listings`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);

      const listingId = first.json().id as string;
      const delist = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/delist`,
        headers: { 'Idempotency-Key': `resale_db_delist_${RUN_ID}` },
      });
      expect(delist.statusCode).toBe(200);
      expect(delist.json()).toMatchObject({ id: listingId, status: 'delisted' });

      const delisted = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(delisted.status).toBe('delisted');
      expect(delisted.active_listing_key).toBe(listingId);
    });

    it('lets a checkout-session owner create and replay a buyer resale listing', async () => {
      const payload = { priceCents: 5500 };
      const missingToken = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
        headers: { 'Idempotency-Key': `buyer_resale_missing_${RUN_ID}` },
        payload,
      });
      expect(missingToken.statusCode).toBe(400);

      const first = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
        headers: {
          'X-Checkout-Session-Token': `client_${RUN_ID}`,
          'Idempotency-Key': `buyer_resale_${RUN_ID}`,
        },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
        headers: {
          'X-Checkout-Session-Token': `client_${RUN_ID}`,
          'Idempotency-Key': `buyer_resale_${RUN_ID}`,
        },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({
        ticketId: TICKET_ID,
        sellerId: ORDER_ID,
        status: 'listed',
        priceCents: 5500,
        faceValueCents: 5000,
      });

      const rows = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticket_id: TICKET_ID,
        seller_id: ORDER_ID,
        active_listing_key: TICKET_ID,
      });

      const walletTickets = await app.inject({
        method: 'GET',
        url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/wallet-passes`,
        headers: { 'X-Checkout-Session-Token': `client_${RUN_ID}` },
      });
      expect(walletTickets.statusCode).toBe(200);
      expect(walletTickets.json().tickets).toEqual([
        expect.objectContaining({
          ticketId: TICKET_ID,
          ticketCode: `RESALE-${RUN_ID}`,
          faceValueCents: 5000,
          currency: 'USD',
          resaleEnabled: true,
          resaleMaxPriceCents: 6000,
          activeResaleListing: expect.objectContaining({
            id: first.json().id,
            status: 'listed',
            priceCents: 5500,
          }),
        }),
      ]);
    });

    it('completes a listed resale once and replays buyer ticket issuance', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_complete_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode).toBe(201);
      const listingId = listed.json().id as string;
      const payload = {
        buyerId: `usr_resale_buyer_${RUN_ID}`,
        buyerEmail: `buyer-${RUN_ID}@example.com`,
        buyerFirstName: 'Resale',
        buyerLastName: 'Buyer',
        externalPaymentReference: `stripe_pi_${RUN_ID}`,
      };
      const first = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
        headers: { 'Idempotency-Key': `resale_db_complete_${RUN_ID}` },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
        headers: { 'Idempotency-Key': `resale_db_complete_${RUN_ID}` },
        payload,
      });

      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());

      const body = first.json();
      expect(body.listing).toMatchObject({
        id: listingId,
        status: 'sold',
        soldToId: payload.buyerId,
      });
      expect(body.sellerTicket).toMatchObject({
        id: TICKET_ID,
        status: 'transferred',
        transferredToEmail: payload.buyerEmail,
      });
      expect(body.buyerTicket).toMatchObject({
        status: 'valid',
        attendeeId: body.buyerAttendee.id,
        eventId: EVENT_ID,
        ticketTypeId: TICKET_TYPE_ID,
      });
      expect(body.buyerAttendee).toMatchObject({
        email: payload.buyerEmail,
        status: 'confirmed',
        ticketId: body.buyerTicket.id,
      });

      const qr = new QrService('resale-db-test-secret').getQrPayload(body.buyerTicket.qrPayload);
      expect(qr).toMatchObject({ valid: true, ticketId: body.buyerTicket.id });

      const rows = await db
        .selectFrom('tickets')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(rows.filter((row) => row.id === TICKET_ID)).toHaveLength(1);
      expect(rows.filter((row) => row.status === 'valid')).toHaveLength(1);

      const walletPass = await db
        .selectFrom('wallet_passes')
        .selectAll()
        .where('id', '=', WALLET_PASS_ID)
        .executeTakeFirstOrThrow();
      expect(walletPass.status).toBe('revoked');
      expect(walletPass.revoked_at).toBeTruthy();

      const timeline = await db
        .selectFrom('order_timeline_events')
        .selectAll()
        .where('order_id', '=', ORDER_ID)
        .where('type', '=', 'ticket.resale_completed')
        .execute();
      expect(timeline).toHaveLength(1);

      const duplicate = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
        headers: { 'Idempotency-Key': `resale_db_complete_again_${RUN_ID}` },
        payload: {
          ...payload,
          buyerId: `usr_resale_buyer_again_${RUN_ID}`,
          buyerEmail: `buyer-again-${RUN_ID}@example.com`,
        },
      });
      expect(duplicate.statusCode).toBe(400);
    });

    it('enforces persisted resale policy before inserting a listing', async () => {
      await db
        .updateTable('events')
        .set({ resale_max_multiplier: 1, updated_at: new Date() })
        .where('id', '=', EVENT_ID)
        .execute();

      const rejected = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_cap_${RUN_ID}` },
        payload: { priceCents: 5001 },
      });
      expect(rejected.statusCode).toBe(400);

      const rows = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(rows).toHaveLength(0);
    });
  },
);
