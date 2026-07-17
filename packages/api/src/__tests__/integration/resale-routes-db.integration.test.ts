import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, TicketListingRepository, TicketRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { publicRoutes } from '../../routes/modules/public.js';
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
const OTHER_BRAND_ID = `brd_resale_other_${RUN_ID}`;
const EVENT_ID = `evt_resale_${RUN_ID}`;
const SELLER_ID = `usr_resale_${RUN_ID}`;
const POOL_ID = `pool_resale_${RUN_ID}`;
const TICKET_TYPE_ID = `tt_resale_${RUN_ID}`;
const CHECKOUT_SESSION_ID = `chk_resale_${RUN_ID}`;
const ORDER_ID = `ord_resale_${RUN_ID}`;
const ATTENDEE_ID = `att_resale_${RUN_ID}`;
const TICKET_ID = `tkt_resale_${RUN_ID}`;
const WALLET_PASS_ID = `wps_resale_${RUN_ID}`;
const OTHER_TENANT_ID = `tnt_resale_other_${RUN_ID}`;

let db: Database;
let app: FastifyInstance;
let previousDbDriver: string | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function isNowaitLockError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { cause?: unknown; code?: unknown; errno?: unknown };
    if (record.code === '55P03' || record.code === 'ER_LOCK_NOWAIT' || record.errno === 3572) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function waitForEventWriteLock(database: Database, eventId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- NOWAIT polling proves the production writer owns the event lock.
      await database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', eventId)
          .forUpdate()
          .noWait()
          .executeTakeFirstOrThrow();
      });
    } catch (error) {
      if (isNowaitLockError(error)) return;
      throw error;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded wait for the production writer to acquire the lock.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for event ${eventId} write lock`);
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: SELLER_ID,
    tenantId: TENANT_ID,
    organizationIds: [ORG_ID],
    brandIds: [BRAND_ID],
    eventIds: [EVENT_ID],
    scopes: ['attendees.write', 'events.read', 'events.write', 'tickets.write'],
    ...overrides,
  };
}

async function setupRouteApp(
  database: Database,
  principal: Principal = makePrincipal(),
): Promise<FastifyInstance> {
  const routeApp = Fastify();
  routeApp.decorate('context', {
    db: database,
    pricingEngine: {},
    inventoryService: {},
    qrService: new QrService('resale-db-test-secret'),
    authService: {
      isLocalDevMode: vi.fn(() => true),
      authenticateLocalDev: vi.fn(async () => ({ principal })),
    },
    temporalClient: {},
  } as unknown as AppContext);
  registerErrorHandler(routeApp);
  routeApp.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await routeApp.register(ticketingRoutes);
  await routeApp.register(checkInRoutes);
  await routeApp.register(eventRoutes);
  await routeApp.register(publicRoutes);
  await routeApp.register(checkoutRoutes);
  return routeApp;
}

async function expectNoIdempotencyRecords(keys: string[]): Promise<void> {
  expect(
    await db
      .selectFrom('idempotency_records')
      .select('key')
      .where('tenant_id', '=', TENANT_ID)
      .where('key', 'in', keys)
      .execute(),
  ).toEqual([]);
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
      .insertInto('brands')
      .values({
        id: OTHER_BRAND_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        name: `Resale DB Other ${RUN_ID}`,
        slug: `resale-db-other-${RUN_ID}`,
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
        visibility: 'public',
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
  await database
    .deleteFrom('checkout_sessions')
    .where('tenant_id', '=', TENANT_ID)
    .where('id', '!=', CHECKOUT_SESSION_ID)
    .execute();
  await database.deleteFrom('wallet_passes').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('tickets').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('attendees').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('order_timeline_events').where('order_id', '=', ORDER_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('checkout_sessions').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('questions').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', 'in', [BRAND_ID, OTHER_BRAND_ID]).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function resetListings(database: Database): Promise<void> {
  await database.deleteFrom('ticket_listings').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('questions').where('event_id', '=', EVENT_ID).execute();
  await database
    .deleteFrom('checkout_sessions')
    .where('tenant_id', '=', TENANT_ID)
    .where('id', '!=', CHECKOUT_SESSION_ID)
    .execute();
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
      event_occurrence_id: null,
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
      organization_id: ORG_ID,
      brand_id: BRAND_ID,
      minimum_age: null,
      resale_enabled: true,
      resale_max_multiplier: 1.2,
      resale_max_absolute_cents: null,
      updated_at: new Date(),
    })
    .where('id', '=', EVENT_ID)
    .execute();
  await database
    .updateTable('ticket_types')
    .set({ price_cents: 5000, currency: 'USD', updated_at: new Date() })
    .where('id', '=', TICKET_TYPE_ID)
    .execute();
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values];
  for (let index = 1; index < sorted.length; index++) {
    const value = sorted[index] ?? 0;
    let previous = index - 1;
    while (previous >= 0 && (sorted[previous] ?? 0) > value) {
      sorted[previous + 1] = sorted[previous] ?? 0;
      previous--;
    }
    sorted[previous + 1] = value;
  }
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
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
        seller_id: ORDER_ID,
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

    it('denies every staff create, delist and transfer boundary without persistence', async () => {
      const denialPrincipals: Array<{
        expectedStatus: number;
        label: string;
        principal: Principal;
      }> = [
        {
          expectedStatus: 403,
          label: 'permission',
          principal: makePrincipal({ scopes: ['events.read'] }),
        },
        {
          expectedStatus: 404,
          label: 'tenant',
          principal: makePrincipal({ tenantId: OTHER_TENANT_ID }),
        },
        {
          expectedStatus: 404,
          label: 'organization',
          principal: makePrincipal({ organizationIds: [`org_resale_other_${RUN_ID}`] }),
        },
        {
          expectedStatus: 404,
          label: 'brand',
          principal: makePrincipal({ brandIds: [`brd_resale_other_${RUN_ID}`] }),
        },
        {
          expectedStatus: 404,
          label: 'event',
          principal: makePrincipal({ eventIds: [`evt_resale_other_${RUN_ID}`] }),
        },
      ];
      for (const denial of denialPrincipals) {
        await resetListings(db);
        const deniedApp = await setupRouteApp(db, denial.principal);
        const transferIdempotencyKey = `resale_auth_transfer_${denial.label}_${RUN_ID}`;
        const deniedTransfer = await deniedApp.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/transfer`,
          headers: { 'Idempotency-Key': transferIdempotencyKey },
          payload: { toEmail: `denied-${denial.label}-${RUN_ID}@example.com` },
        });
        expect(deniedTransfer.statusCode, `${denial.label}: ${deniedTransfer.body}`).toBe(
          denial.expectedStatus,
        );
        const createIdempotencyKey = `resale_auth_create_${denial.label}_${RUN_ID}`;
        const deniedCreate = await deniedApp.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/resale-listings`,
          headers: { 'Idempotency-Key': createIdempotencyKey },
          payload: { priceCents: 5500 },
        });
        expect(deniedCreate.statusCode, `${denial.label}: ${deniedCreate.body}`).toBe(
          denial.expectedStatus,
        );
        expect(
          await db
            .selectFrom('idempotency_records')
            .select('id')
            .where('key', 'in', [createIdempotencyKey, transferIdempotencyKey])
            .execute(),
        ).toEqual([]);
        expect(
          await db
            .selectFrom('ticket_listings')
            .select('id')
            .where('tenant_id', '=', TENANT_ID)
            .execute(),
        ).toEqual([]);

        const listed = await app.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/resale-listings`,
          headers: { 'Idempotency-Key': `resale_auth_seed_${denial.label}_${RUN_ID}` },
          payload: { priceCents: 5500 },
        });
        expect(listed.statusCode, listed.body).toBe(201);
        const listingId = listed.json().id as string;
        const idempotencyKey = `resale_auth_delist_${denial.label}_${RUN_ID}`;
        const response = await deniedApp.inject({
          method: 'POST',
          url: `/ticket-listings/${listingId}/delist`,
          headers: { 'Idempotency-Key': idempotencyKey },
        });

        expect(response.statusCode, `${denial.label}: ${response.body}`).toBe(
          denial.expectedStatus,
        );
        expect(
          await db
            .selectFrom('idempotency_records')
            .select('id')
            .where('key', '=', idempotencyKey)
            .execute(),
        ).toEqual([]);
        expect(
          await db
            .selectFrom('ticket_listings')
            .select(['id', 'status', 'sold_to_id'])
            .where('tenant_id', '=', TENANT_ID)
            .execute(),
        ).toEqual([{ id: listingId, status: 'listed', sold_to_id: null }]);
        expect(
          await db
            .selectFrom('tickets')
            .select(['id', 'status'])
            .where('tenant_id', '=', TENANT_ID)
            .orderBy('id', 'asc')
            .execute(),
        ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
        expect(
          await db
            .selectFrom('attendees')
            .select('id')
            .where('tenant_id', '=', TENANT_ID)
            .execute(),
        ).toEqual([{ id: ATTENDEE_ID }]);
        expect(
          await db
            .selectFrom('wallet_passes')
            .select(['id', 'status'])
            .where('id', '=', WALLET_PASS_ID)
            .execute(),
        ).toEqual([{ id: WALLET_PASS_ID, status: 'active' }]);
        expect(
          await db
            .selectFrom('order_timeline_events')
            .select('id')
            .where('order_id', '=', ORDER_ID)
            .execute(),
        ).toEqual([]);
        await deniedApp.close();
      }
    });

    it('revalidates the locked event scope before staff delisting', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_scope_race_seed_delist_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode, listed.body).toBe(201);
      const listingId = listed.json().id as string;
      const mutationEntered = deferred();
      const releaseMutation = deferred();
      const mutation = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', EVENT_ID)
          .forUpdate()
          .executeTakeFirstOrThrow();
        mutationEntered.resolve();
        await releaseMutation.promise;
        await transaction
          .updateTable('events')
          .set({ brand_id: OTHER_BRAND_ID, updated_at: new Date() })
          .where('id', '=', EVENT_ID)
          .execute();
      });
      await mutationEntered.promise;

      const idempotencyKey = `resale_scope_race_delist_${RUN_ID}`;
      const request = app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/delist`,
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      let reservationObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- this bounded poll proves preflight authorization completed before releasing the event lock.
        const reservation = await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', '=', idempotencyKey)
          .executeTakeFirst();
        if (reservation) {
          reservationObserved = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for the in-flight request to reserve its idempotency key.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reservationObserved).toBe(true);
      releaseMutation.resolve();
      await mutation;
      const response = await request;

      expect(response.statusCode, response.body).toBe(404);
      expect(
        await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('key', '=', idempotencyKey)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['id', 'status', 'sold_to_id'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: listingId, status: 'listed', sold_to_id: null }]);
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .orderBy('id', 'asc')
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('id')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([]);
    });

    it('fails closed for live or malformed checkout reservations before staff delisting', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_reservation_states_seed_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode, listed.body).toBe(201);
      const listingId = listed.json().id as string;
      const reservationStates = [
        {
          label: 'missing expiry',
          reserved_checkout_session_id: `chk_reservation_${RUN_ID}`,
          reserved_until: null,
        },
        {
          label: 'missing checkout session',
          reserved_checkout_session_id: null,
          reserved_until: new Date(Date.now() + 60_000),
        },
        {
          label: 'live reservation',
          reserved_checkout_session_id: `chk_reservation_${RUN_ID}`,
          reserved_until: new Date(Date.now() + 60_000),
        },
      ];

      for (const [index, reservation] of reservationStates.entries()) {
        await db
          .updateTable('ticket_listings')
          .set({
            reserved_checkout_session_id: reservation.reserved_checkout_session_id,
            reserved_until: reservation.reserved_until,
            updated_at: new Date(),
          })
          .where('id', '=', listingId)
          .execute();
        const response = await app.inject({
          method: 'POST',
          url: `/ticket-listings/${listingId}/delist`,
          headers: { 'Idempotency-Key': `resale_reservation_state_${index}_${RUN_ID}` },
        });
        expect(response.statusCode, `${reservation.label}: ${response.body}`).toBe(400);
        expect(
          await db
            .selectFrom('ticket_listings')
            .select('status')
            .where('id', '=', listingId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'listed' });
      }

      await db
        .updateTable('ticket_listings')
        .set({
          reserved_checkout_session_id: `chk_expired_${RUN_ID}`,
          reserved_until: new Date(Date.now() - 60_000),
          updated_at: new Date(),
        })
        .where('id', '=', listingId)
        .execute();
      const delisted = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/delist`,
        headers: { 'Idempotency-Key': `resale_expired_reservation_${RUN_ID}` },
      });
      expect(delisted.statusCode, delisted.body).toBe(200);
      await expect(
        new TicketListingRepository(db).reserveForCheckout({
          tenantId: TENANT_ID,
          listingId,
          checkoutSessionId: CHECKOUT_SESSION_ID,
          reservedUntil: new Date(Date.now() + 60_000),
        }),
      ).resolves.toBeUndefined();
    });

    it('preserves a checkout reservation that commits while staff delisting waits', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_reservation_race_seed_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode, listed.body).toBe(201);
      const listingId = listed.json().id as string;
      const reservationEntered = deferred();
      const releaseReservation = deferred();
      const reservation = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('ticket_listings')
          .select('id')
          .where('id', '=', listingId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('ticket_listings')
          .set({
            reserved_checkout_session_id: CHECKOUT_SESSION_ID,
            reserved_until: new Date(Date.now() + 60_000),
            updated_at: new Date(),
          })
          .where('id', '=', listingId)
          .execute();
        reservationEntered.resolve();
        await releaseReservation.promise;
      });
      await reservationEntered.promise;
      const idempotencyKey = `resale_reservation_race_delist_${RUN_ID}`;
      const request = app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/delist`,
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      let reservationObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded polling proves the staff request reached its mutation boundary.
        const record = await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', '=', idempotencyKey)
          .executeTakeFirst();
        if (record) {
          reservationObserved = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for the staff request to reserve its idempotency key.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reservationObserved).toBe(true);
      releaseReservation.resolve();
      await reservation;
      const response = await request;

      expect(response.statusCode, response.body).toBe(400);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['status', 'reserved_checkout_session_id'])
          .where('id', '=', listingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'listed', reserved_checkout_session_id: CHECKOUT_SESSION_ID });
    });

    it('exposes public resale listings without seller or tenant internals', async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_public_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(create.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: `/public/events/${EVENT_ID}/resale-listings`,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([
        expect.objectContaining({
          id: create.json().id,
          eventId: EVENT_ID,
          ticketTypeId: TICKET_TYPE_ID,
          ticketTypeName: 'Resale DB Ticket',
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
        }),
      ]);
      expect(list.json().items[0]).not.toHaveProperty('sellerId');
      expect(list.json().items[0]).not.toHaveProperty('tenantId');
      expect(list.json().items[0]).not.toHaveProperty('ticketId');
    });

    it('paginates public resale listings after filtering unavailable rows in the database', async () => {
      const secondTicketId = `tkt_resale_${RUN_ID}_2`;
      await db
        .insertInto('tickets')
        .values({
          id: secondTicketId,
          tenant_id: TENANT_ID,
          order_id: ORDER_ID,
          attendee_id: ATTENDEE_ID,
          event_id: EVENT_ID,
          event_occurrence_id: null,
          ticket_type_id: TICKET_TYPE_ID,
          status: 'valid',
          code: `RESALE-${RUN_ID}-2`,
          qr_payload: `resale-payload-${RUN_ID}-2`,
          qr_hash: `resale-hash-${RUN_ID}-2`,
          transferred_to_email: null,
          transferred_at: null,
          checked_in_at: null,
          checked_in_by_device_id: null,
          wallet_pass_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();

      const firstListing = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_page_first_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      const secondListing = await app.inject({
        method: 'POST',
        url: `/tickets/${secondTicketId}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_page_second_${RUN_ID}` },
        payload: { priceCents: 5600 },
      });
      expect(firstListing.statusCode).toBe(201);
      expect(secondListing.statusCode).toBe(201);

      const firstPage = await app.inject({
        method: 'GET',
        url: `/public/events/${EVENT_ID}/resale-listings?limit=1`,
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json().items).toHaveLength(1);
      expect(firstPage.json()).toMatchObject({ hasMore: true });
      expect(firstPage.json().nextCursor).toEqual(firstPage.json().items[0].id);

      const secondPage = await app.inject({
        method: 'GET',
        url: `/public/events/${EVENT_ID}/resale-listings?limit=1&cursor=${encodeURIComponent(
          firstPage.json().nextCursor,
        )}`,
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json().items).toHaveLength(1);
      expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
      expect(secondPage.json()).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('reserves a public resale listing when creating a checkout session and rejects racing buyers', async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_checkout_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(create.statusCode).toBe(201);
      const listingId = create.json().id as string;

      const payload = {
        eventId: EVENT_ID,
        items: [{ resaleListingId: listingId, quantity: 1 }],
        buyer: { email: 'resale-public-buyer@example.com', firstName: 'Public', lastName: 'Buyer' },
      };
      const first = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_checkout_${RUN_ID}` },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_checkout_${RUN_ID}` },
        payload,
      });
      const racingBuyer = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_checkout_race_${RUN_ID}` },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(racingBuyer.statusCode).toBe(400);
      expect(first.json().quote).toMatchObject({
        subtotalCents: 5500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5500,
      });
      expect(first.json().quote.lineItems).toEqual([
        expect.objectContaining({
          type: 'resale',
          resaleListingId: listingId,
          ticketTypeId: TICKET_TYPE_ID,
          quantity: 1,
          unitPriceCents: 5500,
        }),
      ]);

      const reserved = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(reserved.reserved_checkout_session_id).toBe(first.json().id);
      expect(reserved.reserved_until).toBeTruthy();

      const publicList = await app.inject({
        method: 'GET',
        url: `/public/events/${EVENT_ID}/resale-listings`,
      });
      expect(publicList.statusCode).toBe(200);
      expect(publicList.json().items).toHaveLength(0);
    });

    it('retains the resale occurrence when revalidating age eligibility', async () => {
      const occurrenceId = `occ_resale_age_${RUN_ID}`;
      const now = new Date();
      await db
        .insertInto('event_occurrences')
        .values({
          id: occurrenceId,
          event_id: EVENT_ID,
          title: 'Future performance',
          starts_at: new Date('2028-07-10T18:00:00.000Z'),
          ends_at: new Date('2028-07-10T21:00:00.000Z'),
          timezone: 'UTC',
          venue: null,
          capacity: null,
          sort_order: 0,
          status: 'scheduled',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .updateTable('events')
        .set({ minimum_age: 18, starts_at: new Date('2026-07-10T18:00:00.000Z') })
        .where('id', '=', EVENT_ID)
        .execute();
      await db
        .updateTable('tickets')
        .set({ event_occurrence_id: occurrenceId })
        .where('id', '=', TICKET_ID)
        .execute();

      try {
        const createListing = await app.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/resale-listings`,
          headers: { 'Idempotency-Key': `resale_db_age_listing_${RUN_ID}` },
          payload: { priceCents: 5500 },
        });
        expect(createListing.statusCode).toBe(201);
        const checkout = await app.inject({
          method: 'POST',
          url: '/checkout/sessions',
          headers: { 'Idempotency-Key': `resale_db_age_checkout_${RUN_ID}` },
          payload: {
            eventId: EVENT_ID,
            items: [{ resaleListingId: createListing.json().id, quantity: 1 }],
            buyer: { email: 'future-buyer@example.test', dateOfBirth: '2009-07-10' },
          },
        });
        expect(checkout.statusCode).toBe(201);
        const update = await app.inject({
          method: 'PATCH',
          url: `/checkout/sessions/${checkout.json().id}`,
          headers: { 'X-Checkout-Session-Token': checkout.json().clientToken },
          payload: { buyer: { firstName: 'Future' } },
        });
        expect(update.statusCode).toBe(200);
      } finally {
        await db
          .updateTable('tickets')
          .set({ event_occurrence_id: null })
          .where('id', '=', TICKET_ID)
          .execute();
        await db
          .updateTable('events')
          .set({ minimum_age: null, starts_at: new Date(Date.now() + 86_400_000) })
          .where('id', '=', EVENT_ID)
          .execute();
        await db.deleteFrom('event_occurrences').where('id', '=', occurrenceId).execute();
      }
    });

    it('rejects a resale checkout when a required buyer question is missing', async () => {
      const questionId = `q_resale_required_${RUN_ID}`;
      const now = new Date();
      await db
        .insertInto('questions')
        .values({
          id: questionId,
          event_id: EVENT_ID,
          ticket_type_id: null,
          type: 'text',
          label: 'Legal buyer name',
          description: null,
          required: true,
          applies_to: 'buyer',
          options: null,
          placeholder: null,
          validation_pattern: null,
          conditional_visibility: null,
          status: 'active',
          is_hidden: false,
          hidden_at: null,
          deleted_at: null,
          sort_order: 0,
          is_consent_field: false,
          consent_text: null,
          consent_version: null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      const create = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_required_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(create.statusCode).toBe(201);
      const listingId = create.json().id as string;

      const missing = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_required_checkout_${RUN_ID}` },
        payload: {
          eventId: EVENT_ID,
          items: [{ resaleListingId: listingId, quantity: 1 }],
          buyer: {
            email: 'resale-required-buyer@example.com',
            firstName: 'Required',
            lastName: 'Buyer',
          },
        },
      });

      expect(missing.statusCode).toBe(400);
      expect(JSON.stringify(missing.json())).toContain('Buyer question validation failed');

      const sessions = await db
        .selectFrom('checkout_sessions')
        .select('id')
        .where('tenant_id', '=', TENANT_ID)
        .where('id', '!=', CHECKOUT_SESSION_ID)
        .execute();
      expect(sessions).toHaveLength(0);

      const listing = await db
        .selectFrom('ticket_listings')
        .select(['reserved_checkout_session_id', 'reserved_until'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(listing.reserved_checkout_session_id).toBeNull();
      expect(listing.reserved_until).toBeNull();
    });

    it('normalizes resale buyer consent answers and skips hidden buyer answers', async () => {
      const consentQuestionId = `q_resale_consent_${RUN_ID}`;
      const hiddenQuestionId = `q_resale_hidden_${RUN_ID}`;
      const now = new Date();
      await db
        .insertInto('questions')
        .values([
          {
            id: consentQuestionId,
            event_id: EVENT_ID,
            ticket_type_id: null,
            type: 'waiver',
            label: 'Resale waiver',
            description: null,
            required: true,
            applies_to: 'buyer',
            options: null,
            placeholder: null,
            validation_pattern: null,
            conditional_visibility: null,
            status: 'active',
            is_hidden: false,
            hidden_at: null,
            deleted_at: null,
            sort_order: 0,
            is_consent_field: true,
            consent_text: 'I accept the resale purchase terms.',
            consent_version: 'resale-v2',
            created_at: now,
            updated_at: now,
          },
          {
            id: hiddenQuestionId,
            event_id: EVENT_ID,
            ticket_type_id: null,
            type: 'text',
            label: 'Hidden resale prompt',
            description: null,
            required: true,
            applies_to: 'buyer',
            options: null,
            placeholder: null,
            validation_pattern: null,
            conditional_visibility: null,
            status: 'hidden',
            is_hidden: true,
            hidden_at: now,
            deleted_at: null,
            sort_order: 1,
            is_consent_field: false,
            consent_text: null,
            consent_version: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();

      const create = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_consent_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(create.statusCode).toBe(201);
      const listingId = create.json().id as string;

      const checkout = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_consent_checkout_${RUN_ID}` },
        payload: {
          eventId: EVENT_ID,
          items: [{ resaleListingId: listingId, quantity: 1 }],
          buyer: {
            email: 'resale-consent-buyer@example.com',
            firstName: 'Consent',
            lastName: 'Buyer',
          },
          buyerFields: {
            [consentQuestionId]: true,
            [hiddenQuestionId]: 'do not persist',
          },
        },
      });

      expect(checkout.statusCode).toBe(201);
      const storedSession = await db
        .selectFrom('checkout_sessions')
        .select('cart')
        .where('id', '=', checkout.json().id)
        .executeTakeFirstOrThrow();
      const cart = (
        typeof storedSession.cart === 'string' ? JSON.parse(storedSession.cart) : storedSession.cart
      ) as { buyerFields: Record<string, unknown> };
      expect(cart.buyerFields[consentQuestionId]).toEqual({
        accepted: true,
        consentText: 'I accept the resale purchase terms.',
        consentVersion: 'resale-v2',
        consentedAt: expect.any(String),
      });
      expect(cart.buyerFields[hiddenQuestionId]).toBeUndefined();
    });

    it('rejects staff-created resale checkout when the buyer is the original ticket owner', async () => {
      const create = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_self_checkout_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(create.statusCode).toBe(201);
      expect(create.json()).toMatchObject({ sellerId: ORDER_ID });

      const selfPurchase = await app.inject({
        method: 'POST',
        url: '/checkout/sessions',
        headers: { 'Idempotency-Key': `resale_db_self_checkout_${RUN_ID}` },
        payload: {
          eventId: EVENT_ID,
          items: [{ resaleListingId: create.json().id, quantity: 1 }],
          buyer: {
            email: 'RESALE-BUYER@example.com',
            firstName: 'Resale',
            lastName: 'Seller',
          },
        },
      });

      expect(selfPurchase.statusCode).toBe(400);
      expect(JSON.stringify(selfPurchase.json())).toContain(
        'Buyer cannot purchase their own resale listing',
      );
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

    it('allows only one buyer resale listing under concurrent create attempts', async () => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          app.inject({
            method: 'POST',
            url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
            headers: {
              'X-Checkout-Session-Token': `client_${RUN_ID}`,
              'Idempotency-Key': `buyer_resale_race_${RUN_ID}_${index}`,
            },
            payload: { priceCents: 5500 },
          }),
        ),
      );

      const statuses = attempts.map((response) => response.statusCode);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 400)).toHaveLength(7);

      const listings = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(listings).toHaveLength(1);
      expect(listings[0]).toMatchObject({
        ticket_id: TICKET_ID,
        status: 'listed',
        active_listing_key: TICKET_ID,
      });
    });

    it('transfers an unlisted ticket with atomic recipient, wallet and timeline state', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/transfer`,
        headers: { 'Idempotency-Key': `resale_transfer_control_${RUN_ID}` },
        payload: { toEmail: `control-${RUN_ID}@example.com` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .orderBy('id', 'asc')
          .execute(),
      ).toEqual(
        [
          { id: TICKET_ID, status: 'transferred' },
          { id: response.json().id, status: 'valid' },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toHaveLength(2);
      expect(
        await db
          .selectFrom('wallet_passes')
          .select(['id', 'status'])
          .where('id', '=', WALLET_PASS_ID)
          .execute(),
      ).toEqual([{ id: WALLET_PASS_ID, status: 'revoked' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('type')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([{ type: 'ticket.transferred' }]);
    });

    it('rejects a direct ticket transfer while an active resale listing exists', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_transfer_guard_seed_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode, listed.body).toBe(201);

      const transferred = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/transfer`,
        headers: { 'Idempotency-Key': `resale_transfer_guard_${RUN_ID}` },
        payload: { toEmail: `recipient-${RUN_ID}@example.com` },
      });
      expect(transferred.statusCode, transferred.body).toBe(400);
      const replay = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/transfer`,
        headers: { 'Idempotency-Key': `resale_transfer_guard_${RUN_ID}` },
        payload: { toEmail: `recipient-${RUN_ID}@example.com` },
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Ticket ${TICKET_ID} has an active resale listing`,
        },
      });
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: listed.json().id, status: 'listed' }]);
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toEqual([{ id: ATTENDEE_ID }]);
      expect(
        await db
          .selectFrom('wallet_passes')
          .select(['id', 'status'])
          .where('id', '=', WALLET_PASS_ID)
          .execute(),
      ).toEqual([{ id: WALLET_PASS_ID, status: 'active' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('id')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([]);
    });

    it('rejects a direct transfer after a concurrent listing creation commits', async () => {
      const listingEntered = deferred();
      const releaseListing = deferred();
      const listing = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', EVENT_ID)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await new TicketRepository(transaction).findByIdForUpdate(TICKET_ID);
        const created = await new TicketListingRepository(transaction).create({
          tenantId: TENANT_ID,
          eventId: EVENT_ID,
          ticketId: TICKET_ID,
          sellerId: ORDER_ID,
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
        });
        listingEntered.resolve();
        await releaseListing.promise;
        return created;
      });
      await listingEntered.promise;

      const idempotencyKey = `resale_listing_race_transfer_${RUN_ID}`;
      const transfer = app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/transfer`,
        headers: { 'Idempotency-Key': idempotencyKey },
        payload: { toEmail: `loser-${RUN_ID}@example.com` },
      });
      let reservationObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded polling proves transfer reached idempotency before the listing lock is released.
        const reservation = await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', '=', idempotencyKey)
          .executeTakeFirst();
        if (reservation) {
          reservationObserved = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for the in-flight transfer to reserve its key.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reservationObserved).toBe(true);
      releaseListing.resolve();
      const [created, response] = await Promise.all([listing, transfer]);

      expect(response.statusCode, response.body).toBe(400);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: created.id, status: 'listed' }]);
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toEqual([{ id: ATTENDEE_ID }]);
      expect(
        await db
          .selectFrom('wallet_passes')
          .select(['id', 'status'])
          .where('id', '=', WALLET_PASS_ID)
          .execute(),
      ).toEqual([{ id: WALLET_PASS_ID, status: 'active' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('id')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([]);
    });

    it('rejects staff and buyer listing creation after a concurrent transfer commits', async () => {
      const transferEntered = deferred();
      const releaseTransfer = deferred();
      const transfer = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', EVENT_ID)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const ticketRepo = new TicketRepository(transaction);
        await ticketRepo.findByIdForUpdate(TICKET_ID);
        await ticketRepo.transferIfValid(TICKET_ID, `winner-${RUN_ID}@example.com`, new Date());
        transferEntered.resolve();
        await releaseTransfer.promise;
      });
      await transferEntered.promise;

      const requests = [
        app.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/resale-listings`,
          headers: { 'Idempotency-Key': `resale_transfer_race_staff_${RUN_ID}` },
          payload: { priceCents: 5500 },
        }),
        app.inject({
          method: 'POST',
          url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
          headers: {
            'X-Checkout-Session-Token': `client_${RUN_ID}`,
            'Idempotency-Key': `resale_transfer_race_buyer_${RUN_ID}`,
          },
          payload: { priceCents: 5500 },
        }),
      ];
      let reservationsObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded polling proves both listing requests reached the serialized mutation boundary.
        const reservations = await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', 'in', [
            `resale_transfer_race_staff_${RUN_ID}`,
            `resale_transfer_race_buyer_${RUN_ID}`,
          ])
          .execute();
        if (reservations.length === 2) {
          reservationsObserved = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for both in-flight requests to reserve their keys.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reservationsObserved).toBe(true);
      releaseTransfer.resolve();
      await transfer;
      const responses = await Promise.all(requests);

      expect(responses.map((response) => response.statusCode)).toEqual([400, 400]);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'transferred' }]);
      expect(
        await db
          .selectFrom('idempotency_records')
          .select(['key', 'status', 'response_status'])
          .where('tenant_id', '=', TENANT_ID)
          .where('key', 'in', [
            `resale_transfer_race_staff_${RUN_ID}`,
            `resale_transfer_race_buyer_${RUN_ID}`,
          ])
          .orderBy('key', 'asc')
          .execute(),
      ).toEqual([
        {
          key: `resale_transfer_race_buyer_${RUN_ID}`,
          status: 'completed',
          response_status: 400,
        },
        {
          key: `resale_transfer_race_staff_${RUN_ID}`,
          status: 'completed',
          response_status: 400,
        },
      ]);
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toEqual([{ id: ATTENDEE_ID }]);
      expect(
        await db
          .selectFrom('wallet_passes')
          .select(['id', 'status'])
          .where('id', '=', WALLET_PASS_ID)
          .execute(),
      ).toEqual([{ id: WALLET_PASS_ID, status: 'active' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('id')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([]);
    });

    it.each([
      { label: 'single', path: `/ticket-types/${TICKET_TYPE_ID}`, payload: { priceCents: 4000 } },
      {
        label: 'batch',
        path: `/ticket-types/${TICKET_TYPE_ID}/batch`,
        payload: { ticketType: { priceCents: 4000 } },
      },
    ])(
      'serializes $label ticket-type pricing writes before listing policy reads',
      async ({ label, path, payload }) => {
        const typeLockEntered = deferred();
        const releaseTypeLock = deferred();
        const typeBlocker = db.transaction().execute(async (transaction) => {
          await transaction
            .selectFrom('ticket_types')
            .select('id')
            .where('id', '=', TICKET_TYPE_ID)
            .forUpdate()
            .executeTakeFirstOrThrow();
          typeLockEntered.resolve();
          await releaseTypeLock.promise;
        });
        await typeLockEntered.promise;

        const writer = app.inject({ method: 'PATCH', url: path, payload });
        await waitForEventWriteLock(db, EVENT_ID);
        const keys = [
          `resale_price_${label}_staff_${RUN_ID}`,
          `resale_price_${label}_buyer_${RUN_ID}`,
        ];
        const requests = [
          app.inject({
            method: 'POST',
            url: `/tickets/${TICKET_ID}/resale-listings`,
            headers: { 'Idempotency-Key': keys[0] },
            payload: { priceCents: 5500 },
          }),
          app.inject({
            method: 'POST',
            url: `/checkout/sessions/${CHECKOUT_SESSION_ID}/tickets/${TICKET_ID}/resale-listing`,
            headers: {
              'X-Checkout-Session-Token': `client_${RUN_ID}`,
              'Idempotency-Key': keys[1],
            },
            payload: { priceCents: 5500 },
          }),
        ];
        let reservationsObserved = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- proves both listing requests wait behind the production writer.
          const reservations = await db
            .selectFrom('idempotency_records')
            .select('id')
            .where('tenant_id', '=', TENANT_ID)
            .where('key', 'in', keys)
            .execute();
          if (reservations.length === 2) {
            reservationsObserved = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop -- bounded wait for both reservations.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        releaseTypeLock.resolve();
        await typeBlocker;
        const [writerResponse, responses] = await Promise.all([writer, Promise.all(requests)]);

        expect(reservationsObserved).toBe(true);
        expect(writerResponse.statusCode, writerResponse.body).toBe(200);
        expect(responses.map((response) => response.statusCode)).toEqual([400, 400]);
        expect(
          await db
            .selectFrom('ticket_listings')
            .select('id')
            .where('tenant_id', '=', TENANT_ID)
            .execute(),
        ).toEqual([]);
      },
    );

    it('revalidates a stricter event age policy after the transfer preflight', async () => {
      const policyLocked = deferred();
      const releasePolicy = deferred();
      const policyChange = db.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('events')
          .select('id')
          .where('id', '=', EVENT_ID)
          .forUpdate()
          .executeTakeFirstOrThrow();
        policyLocked.resolve();
        await releasePolicy.promise;
        await transaction
          .updateTable('events')
          .set({ minimum_age: 18, updated_at: new Date() })
          .where('id', '=', EVENT_ID)
          .execute();
      });
      await policyLocked.promise;

      const idempotencyKey = `resale_transfer_age_race_${RUN_ID}`;
      const transfer = app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/transfer`,
        headers: { 'Idempotency-Key': idempotencyKey },
        payload: { toEmail: `age-race-${RUN_ID}@example.com` },
      });
      let reservationObserved = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded polling proves preflight used the old policy before the committed change.
        const reservation = await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', '=', idempotencyKey)
          .executeTakeFirst();
        if (reservation) {
          reservationObserved = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- wait for the transfer to reach its transaction boundary.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(reservationObserved).toBe(true);
      releasePolicy.resolve();
      await policyChange;
      const response = await transfer;

      expect(response.statusCode, response.body).toBe(400);
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toEqual([{ id: ATTENDEE_ID }]);
    });

    it('revalidates the locked occurrence after a concurrent schedule change commits', async () => {
      const occurrenceId = `occ_transfer_race_${RUN_ID}`;
      const now = new Date();
      await db
        .insertInto('event_occurrences')
        .values({
          id: occurrenceId,
          event_id: EVENT_ID,
          title: 'Transfer eligibility',
          starts_at: new Date('2030-07-10T18:00:00.000Z'),
          ends_at: new Date('2030-07-10T21:00:00.000Z'),
          timezone: 'UTC',
          venue: null,
          capacity: null,
          sort_order: 0,
          status: 'scheduled',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .updateTable('events')
        .set({ minimum_age: 18, updated_at: now })
        .where('id', '=', EVENT_ID)
        .execute();
      await db
        .updateTable('tickets')
        .set({ event_occurrence_id: occurrenceId, updated_at: now })
        .where('id', '=', TICKET_ID)
        .execute();

      try {
        const occurrenceLockEntered = deferred();
        const releaseOccurrenceLock = deferred();
        const occurrenceBlocker = db.transaction().execute(async (transaction) => {
          await transaction
            .selectFrom('event_occurrences')
            .select('id')
            .where('id', '=', occurrenceId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          occurrenceLockEntered.resolve();
          await releaseOccurrenceLock.promise;
        });
        await occurrenceLockEntered.promise;

        const writer = app.inject({
          method: 'PATCH',
          url: `/events/${EVENT_ID}/occurrences/${occurrenceId}`,
          payload: {
            startsAt: '2028-07-10T18:00:00.000Z',
            endsAt: '2028-07-10T21:00:00.000Z',
          },
        });
        await waitForEventWriteLock(db, EVENT_ID);

        const idempotencyKey = `resale_transfer_occurrence_race_${RUN_ID}`;
        const transfer = app.inject({
          method: 'POST',
          url: `/tickets/${TICKET_ID}/transfer`,
          headers: { 'Idempotency-Key': idempotencyKey },
          payload: {
            toEmail: `occurrence-race-${RUN_ID}@example.com`,
            dateOfBirth: '2011-07-10',
          },
        });
        let reservationObserved = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop -- proves preflight completed against the old occurrence.
          const reservation = await db
            .selectFrom('idempotency_records')
            .select('id')
            .where('tenant_id', '=', TENANT_ID)
            .where('key', '=', idempotencyKey)
            .executeTakeFirst();
          if (reservation) {
            reservationObserved = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop -- bounded wait for the transfer reservation.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        releaseOccurrenceLock.resolve();
        await occurrenceBlocker;
        const writerResponse = await writer;
        expect(reservationObserved).toBe(true);
        expect(writerResponse.statusCode, writerResponse.body).toBe(200);
        const response = await transfer;

        expect(response.statusCode, response.body).toBe(400);
        expect(
          await db
            .selectFrom('tickets')
            .select(['id', 'status'])
            .where('tenant_id', '=', TENANT_ID)
            .execute(),
        ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      } finally {
        await db
          .updateTable('tickets')
          .set({ event_occurrence_id: null, updated_at: new Date() })
          .where('id', '=', TICKET_ID)
          .execute();
        await db.deleteFrom('event_occurrences').where('id', '=', occurrenceId).execute();
      }
    });

    it('retires arbitrary provider-delegated completion without mutating resale state', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_complete_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode).toBe(201);
      const listingId = listed.json().id as string;
      const deniedApp = await setupRouteApp(db, makePrincipal({ scopes: ['events.read'] }));
      const denied = await deniedApp.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
        payload: { externalPaymentReference: `untrusted_${RUN_ID}` },
      });
      await deniedApp.close();
      expect(denied.statusCode).toBe(403);

      const payload = {
        buyerId: `usr_resale_buyer_${RUN_ID}`,
        buyerEmail: `buyer-${RUN_ID}@example.com`,
        buyerFirstName: 'Resale',
        buyerLastName: 'Buyer',
        externalPaymentReference: `stripe_pi_${RUN_ID}`,
        buyerDateOfBirth: '1990-01-01',
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
      const malformed = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
      });

      expect(first.statusCode).toBe(410);
      expect(replay.statusCode).toBe(410);
      expect(malformed.statusCode).toBe(410);
      expect(first.headers.deprecation).toBe('@1784160000');
      expect(first.headers.link).toBe('</v1/checkout/sessions>; rel="successor-version"');
      expect(first.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      expect(replay.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      expect(malformed.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      await expectNoIdempotencyRecords([`resale_db_complete_${RUN_ID}`]);
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['id', 'status', 'sold_to_id'])
          .where('id', '=', listingId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ id: listingId, status: 'listed', sold_to_id: null });
      expect(
        await db
          .selectFrom('tickets')
          .select(['id', 'status'])
          .where('tenant_id', '=', TENANT_ID)
          .execute(),
      ).toEqual([{ id: TICKET_ID, status: 'valid' }]);
      expect(
        await db.selectFrom('attendees').select('id').where('tenant_id', '=', TENANT_ID).execute(),
      ).toEqual([{ id: ATTENDEE_ID }]);
      expect(
        await db
          .selectFrom('wallet_passes')
          .select(['id', 'status'])
          .where('id', '=', WALLET_PASS_ID)
          .execute(),
      ).toEqual([{ id: WALLET_PASS_ID, status: 'active' }]);
      expect(
        await db
          .selectFrom('order_timeline_events')
          .select('id')
          .where('order_id', '=', ORDER_ID)
          .execute(),
      ).toEqual([]);
    });

    it('rejects every concurrent legacy completion attempt without mutating resale state', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_complete_race_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode).toBe(201);
      const listingId = listed.json().id as string;

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          app.inject({
            method: 'POST',
            url: `/ticket-listings/${listingId}/complete`,
            headers: { 'Idempotency-Key': `resale_db_complete_race_${RUN_ID}_${index}` },
            payload: {
              buyerId: `usr_resale_race_${RUN_ID}_${index}`,
              buyerEmail: `buyer-race-${index}-${RUN_ID}@example.com`,
              buyerFirstName: 'Race',
              buyerLastName: `Buyer ${index}`,
              externalPaymentReference: `stripe_pi_race_${RUN_ID}_${index}`,
              buyerDateOfBirth: '1990-01-01',
            },
          }),
        ),
      );

      const statuses = attempts.map((response) => response.statusCode);
      expect(statuses).toEqual(Array.from({ length: 8 }, () => 410));
      for (const response of attempts) {
        expect(response.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      }
      await expectNoIdempotencyRecords(
        Array.from({ length: 8 }, (_, index) => `resale_db_complete_race_${RUN_ID}_${index}`),
      );

      const persistedListing = await db
        .selectFrom('ticket_listings')
        .select(['id', 'status', 'sold_to_id'])
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(persistedListing).toEqual({ id: listingId, status: 'listed', sold_to_id: null });

      const tickets = await db
        .selectFrom('tickets')
        .select(['id', 'status'])
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(tickets).toEqual([{ id: TICKET_ID, status: 'valid' }]);

      const attendees = await db
        .selectFrom('attendees')
        .select('id')
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(attendees).toEqual([{ id: ATTENDEE_ID }]);

      const walletPass = await db
        .selectFrom('wallet_passes')
        .select(['id', 'status'])
        .where('id', '=', WALLET_PASS_ID)
        .executeTakeFirstOrThrow();
      expect(walletPass).toEqual({ id: WALLET_PASS_ID, status: 'active' });

      const timeline = await db
        .selectFrom('order_timeline_events')
        .selectAll()
        .where('order_id', '=', ORDER_ID)
        .where('type', '=', 'ticket.resale_completed')
        .execute();
      expect(timeline).toHaveLength(0);
    });

    it('does not let the retired completion route mutate an expired resale listing', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_expired_listing_${RUN_ID}` },
        payload: { priceCents: 5500, expiresAt: '2020-01-01T00:00:00.000Z' },
      });
      expect(listed.statusCode).toBe(201);
      const listingId = listed.json().id as string;

      const expired = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/complete`,
        headers: { 'Idempotency-Key': `resale_db_expired_complete_${RUN_ID}` },
        payload: {
          buyerId: `usr_resale_expired_${RUN_ID}`,
          buyerEmail: `buyer-expired-${RUN_ID}@example.com`,
          buyerFirstName: 'Expired',
          buyerLastName: 'Buyer',
          externalPaymentReference: `stripe_pi_expired_${RUN_ID}`,
          buyerDateOfBirth: '1990-01-01',
        },
      });
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      await expectNoIdempotencyRecords([`resale_db_expired_complete_${RUN_ID}`]);

      const row = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('id', '=', listingId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        status: 'listed',
        sold_to_id: null,
        active_listing_key: TICKET_ID,
      });

      const tickets = await db
        .selectFrom('tickets')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        id: TICKET_ID,
        status: 'valid',
        transferred_to_email: null,
      });

      const attendees = await db
        .selectFrom('attendees')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(attendees).toHaveLength(1);

      const walletPass = await db
        .selectFrom('wallet_passes')
        .selectAll()
        .where('id', '=', WALLET_PASS_ID)
        .executeTakeFirstOrThrow();
      expect(walletPass).toMatchObject({ status: 'active', revoked_at: null });

      const timeline = await db
        .selectFrom('order_timeline_events')
        .selectAll()
        .where('order_id', '=', ORDER_ID)
        .where('type', '=', 'ticket.resale_completed')
        .execute();
      expect(timeline).toHaveLength(0);
    });

    it('keeps resale discovery stable while rejecting legacy completion under bounded mixed load', async () => {
      const listed = await app.inject({
        method: 'POST',
        url: `/tickets/${TICKET_ID}/resale-listings`,
        headers: { 'Idempotency-Key': `resale_db_load_listing_${RUN_ID}` },
        payload: { priceCents: 5500 },
      });
      expect(listed.statusCode).toBe(201);
      const listingId = listed.json().id as string;

      const readCount = 80;
      const completionCount = 16;
      const startedAt = performance.now();
      const readDurations: number[] = [];

      const reads = Array.from({ length: readCount }, async (_, index) => {
        const readStartedAt = performance.now();
        const response = await app.inject({
          method: 'GET',
          url: `/events/${EVENT_ID}/resale-listings?limit=10&cursor=load-${index}`,
        });
        readDurations.push(performance.now() - readStartedAt);
        return response;
      });
      const completions = Array.from({ length: completionCount }, (_, index) =>
        app.inject({
          method: 'POST',
          url: `/ticket-listings/${listingId}/complete`,
          headers: { 'Idempotency-Key': `resale_db_load_complete_${RUN_ID}_${index}` },
          payload: {
            buyerId: `usr_resale_load_${RUN_ID}_${index}`,
            buyerEmail: `buyer-load-${index}-${RUN_ID}@example.com`,
            buyerFirstName: 'Load',
            buyerLastName: `Buyer ${index}`,
            externalPaymentReference: `stripe_pi_load_${RUN_ID}_${index}`,
            buyerDateOfBirth: '1990-01-01',
          },
        }),
      );

      const [readResponses, completionResponses] = await Promise.all([
        Promise.all(reads),
        Promise.all(completions),
      ]);
      const durationMs = performance.now() - startedAt;

      expect(readResponses).toHaveLength(readCount);
      expect(readResponses.every((response) => response.statusCode === 200)).toBe(true);
      for (const response of readResponses) {
        const body = response.json();
        expect(body.items.length).toBeLessThanOrEqual(1);
        for (const item of body.items) {
          expect(item).toMatchObject({
            id: listingId,
            eventId: EVENT_ID,
            ticketId: TICKET_ID,
          });
          expect(item.status).toBe('listed');
        }
      }

      const completionStatuses = completionResponses.map((response) => response.statusCode);
      expect(completionStatuses).toEqual(Array.from({ length: completionCount }, () => 410));
      for (const response of completionResponses) {
        expect(response.json().error).toMatchObject({ code: 'RESALE_COMPLETION_RETIRED' });
      }
      await expectNoIdempotencyRecords(
        Array.from(
          { length: completionCount },
          (_, index) => `resale_db_load_complete_${RUN_ID}_${index}`,
        ),
      );
      expect(percentile(readDurations, 0.95)).toBeLessThan(2_500);
      expect(durationMs).toBeLessThan(15_000);

      const listings = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(listings).toHaveLength(1);
      expect(listings[0]).toMatchObject({
        id: listingId,
        status: 'listed',
        active_listing_key: TICKET_ID,
      });

      const tickets = await db
        .selectFrom('tickets')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({ id: TICKET_ID, status: 'valid' });

      const attendees = await db
        .selectFrom('attendees')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(attendees).toHaveLength(1);
      expect(attendees[0]).toMatchObject({ id: ATTENDEE_ID, status: 'confirmed' });

      const timeline = await db
        .selectFrom('order_timeline_events')
        .selectAll()
        .where('order_id', '=', ORDER_ID)
        .where('type', '=', 'ticket.resale_completed')
        .execute();
      expect(timeline).toHaveLength(0);
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
