import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, OrderRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { InventoryService } from '../../services/inventory.js';
import { PricingEngine } from '../../services/pricing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type TemporalStartInput = {
  checkoutSessionId: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  currency: string;
  amountCents: number;
  salesChannel?: 'online' | 'box_office';
  operatorId?: string;
  tenderType?: 'comp' | 'cash' | 'manual_card';
};

const RUN_ID = ulid().slice(-10).toLowerCase();
const TENANT_ID = `tnt_pos_${RUN_ID}`;
const ORG_ID = `org_pos_${RUN_ID}`;
const BRAND_ID = `brd_pos_${RUN_ID}`;
const EVENT_ID = `evt_pos_${RUN_ID}`;
const OPERATOR_ID = `usr_pos_${RUN_ID}`;

let db: Database;
let app: FastifyInstance;
let inventoryService: InventoryService;
let previousDbDriver: string | undefined;
let finalizedOrderCount = 0;

function makePrincipal(): Principal {
  return {
    type: 'user',
    id: OPERATOR_ID,
    tenantId: TENANT_ID,
    organizationIds: [ORG_ID],
    brandIds: [BRAND_ID],
    eventIds: [EVENT_ID],
    scopes: ['events.read', 'orders.read', 'orders.write'],
  };
}

async function seedTenantGraph(database: Database): Promise<void> {
  const now = new Date();
  await database.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: TENANT_ID,
        name: `POS DB ${RUN_ID}`,
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
        name: `POS DB ${RUN_ID}`,
        slug: `pos-db-${RUN_ID}`,
        clerk_organization_id: null,
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
        name: `POS DB ${RUN_ID}`,
        slug: `pos-db-${RUN_ID}`,
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
        slug: `pos-db-${RUN_ID}`,
        title: 'POS DB Event',
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date(now.getTime() + 86_400_000),
        ends_at: null,
        visibility: 'private',
        seo: JSON.stringify({}),
        capacity: null,
        cover_image_url: null,
        external_url: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

async function cleanupAll(database: Database): Promise<void> {
  const sessions = await database
    .selectFrom('checkout_sessions')
    .select('id')
    .where('tenant_id', '=', TENANT_ID)
    .execute();
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length > 0) {
    await database
      .deleteFrom('checkout_holds')
      .where('checkout_session_id', 'in', sessionIds)
      .execute();
  }

  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('checkout_sessions').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function resetMutableState(database: Database): Promise<void> {
  const sessions = await database
    .selectFrom('checkout_sessions')
    .select('id')
    .where('tenant_id', '=', TENANT_ID)
    .execute();
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length > 0) {
    await database
      .deleteFrom('checkout_holds')
      .where('checkout_session_id', 'in', sessionIds)
      .execute();
  }

  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('checkout_sessions').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  finalizedOrderCount = 0;
}

async function createPool(database: Database, capacity: number): Promise<string> {
  const poolId = `pool_pos_${ulid().slice(-10).toLowerCase()}`;
  await database
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: EVENT_ID,
      name: `POS Pool ${poolId}`,
      total_capacity: capacity,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: 300,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return poolId;
}

async function createTicketType(
  database: Database,
  poolId: string,
  priceCents: number,
): Promise<string> {
  const ticketTypeId = `tt_pos_${ulid().slice(-10).toLowerCase()}`;
  await database
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: EVENT_ID,
      name: `POS Ticket ${ticketTypeId}`,
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: priceCents,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return ticketTypeId;
}

async function setupRouteApp(database: Database): Promise<FastifyInstance> {
  const routeApp = Fastify();
  const pricingEngine = new PricingEngine();
  inventoryService = new InventoryService(database);
  routeApp.decorate('context', {
    db: database,
    pricingEngine,
    inventoryService,
    qrService: {},
    authService: {
      isLocalDevMode: vi.fn(() => true),
      authenticateLocalDev: vi.fn(async () => ({
        principal: makePrincipal(),
      })),
    },
    temporalClient: {
      startCheckoutSession: async (input: TemporalStartInput) => {
        await inventoryService.convertHoldsForSession(input.checkoutSessionId);
        finalizedOrderCount += 1;
        const order = await new OrderRepository(database).create({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          brandId: input.brandId,
          eventId: input.eventId,
          checkoutSessionId: input.checkoutSessionId,
          orderNumber: `TK-POS-${RUN_ID}-${finalizedOrderCount}`,
          status: 'paid',
          currency: input.currency,
          subtotalCents: input.amountCents,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: input.amountCents,
          buyerEmail: `buyer-${finalizedOrderCount}@example.com`,
          salesChannel: input.salesChannel,
          operatorId: input.operatorId,
          tenderType: input.tenderType,
        });
        await database
          .updateTable('checkout_sessions')
          .set({ status: 'completed', order_id: order.id, updated_at: new Date() })
          .where('id', '=', input.checkoutSessionId)
          .execute();
        return {
          workflowId: `checkout-session:${input.checkoutSessionId}`,
          result: async () => ({ status: 'completed' as const, orderId: order.id }),
        };
      },
    },
  } as unknown as AppContext);
  registerErrorHandler(routeApp);
  await routeApp.register(checkoutRoutes);
  return routeApp;
}

describeWithIntegrationDatabase(
  `box-office order route DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDbDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await cleanupAll(db).catch(() => undefined);
      await seedTenantGraph(db);
      app = await setupRouteApp(db);
    }, 120_000);

    afterAll(async () => {
      await app.close();
      await cleanupAll(db);
      await db.destroy();
      restoreDatabaseDriver(previousDbDriver);
    }, 120_000);

    beforeEach(async () => {
      await resetMutableState(db);
    });

    it('persists an authenticated manual-card POS order with real DB idempotency and inventory conversion', async () => {
      const poolId = await createPool(db, 3);
      const ticketTypeId = await createTicketType(db, poolId, 2500);
      const payload = {
        tenderType: 'manual_card',
        amountCents: 2500,
        buyer: { email: 'manual-db@example.com', firstName: 'Manual', lastName: 'Buyer' },
        items: [{ ticketTypeId, quantity: 1 }],
      };

      const first = await app.inject({
        method: 'POST',
        url: `/events/${EVENT_ID}/box-office/orders`,
        headers: { 'Idempotency-Key': `pos_db_manual_${RUN_ID}` },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `/events/${EVENT_ID}/box-office/orders`,
        headers: { 'Idempotency-Key': `pos_db_manual_${RUN_ID}` },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(finalizedOrderCount).toBe(1);

      const orders = await db
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        sales_channel: 'box_office',
        operator_id: OPERATOR_ID,
        tender_type: 'manual_card',
        total_cents: 2500,
      });

      const pool = await db
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(Number(pool.sold_count)).toBe(1);

      const activeHolds = await db
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('inventory_pool_id', '=', poolId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      expect(Number(activeHolds.count)).toBe(0);
    });

    it('prevents oversell when concurrent POS cash orders exceed capacity', async () => {
      const capacity = 2;
      const burst = 6;
      const poolId = await createPool(db, capacity);
      const ticketTypeId = await createTicketType(db, poolId, 1000);
      const responses = await Promise.all(
        Array.from({ length: burst }, (_, index) =>
          app.inject({
            method: 'POST',
            url: `/events/${EVENT_ID}/box-office/orders`,
            headers: { 'Idempotency-Key': `pos_db_burst_${RUN_ID}_${index}` },
            payload: {
              tenderType: 'cash',
              amountCents: 1000,
              buyer: { email: `cash-${index}@example.com` },
              items: [{ ticketTypeId, quantity: 1 }],
            },
          }),
        ),
      );

      const successes = responses.filter((response) => response.statusCode === 201);
      const failures = responses.filter((response) => response.statusCode !== 201);
      expect(successes).toHaveLength(capacity);
      expect(failures).toHaveLength(burst - capacity);
      expect(failures.every((response) => response.statusCode < 500)).toBe(true);

      const pool = await db
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(Number(pool.sold_count)).toBe(capacity);

      const held = await db
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('inventory_pool_id', '=', poolId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      expect(Number(held.count)).toBe(0);

      const orderCount = await db
        .selectFrom('orders')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', TENANT_ID)
        .where('sales_channel', '=', 'box_office')
        .executeTakeFirstOrThrow();
      expect(Number(orderCount.count)).toBe(capacity);
    });
  },
);
