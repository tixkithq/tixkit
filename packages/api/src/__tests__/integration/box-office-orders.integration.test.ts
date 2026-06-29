import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { PricingEngine } from '../../services/pricing.js';
import { InventoryService } from '../../services/inventory.js';
import { QrService } from '../../services/qr.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { ulid } from 'ulid';

let db: Database;
let previousDbDriver: string | undefined;

type SeedIds = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  poolId: string;
  ticketTypeId: string;
};

function makeId(prefix: string): string {
  return `${prefix}_pos_${ulid().slice(-10)}`;
}

function makePrincipal(ids: SeedIds, overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_box_office_operator',
    tenantId: ids.tenantId,
    organizationIds: [ids.organizationId],
    brandIds: [ids.brandId],
    eventIds: [ids.eventId],
    scopes: ['orders.read', 'orders.write', 'events.read'],
    ...overrides,
  };
}

async function setupApp(principal: Principal) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('context', {
    db,
    pricingEngine: new PricingEngine(),
    inventoryService: new InventoryService(db),
    qrService: new QrService('box-office-test-secret'),
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(orderRoutes);
  return app;
}

async function seedBoxOfficeEvent(capacity = 10): Promise<SeedIds> {
  const ids: SeedIds = {
    tenantId: makeId('tnt'),
    organizationId: makeId('org'),
    brandId: makeId('brd'),
    eventId: makeId('evt'),
    poolId: makeId('inv'),
    ticketTypeId: makeId('tt'),
  };
  const now = new Date();
  await db
    .insertInto('tenants')
    .values({
      id: ids.tenantId,
      name: 'Box Office Tenant',
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: ids.organizationId,
      tenant_id: ids.tenantId,
      name: 'Box Office Org',
      slug: `pos-${ulid().toLowerCase()}`,
      clerk_organization_id: null,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: ids.brandId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      name: 'Box Office Brand',
      slug: `pos-${ulid().toLowerCase()}`,
      status: 'active',
      theme: JSON.stringify({}),
      legal_urls: JSON.stringify({}),
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('events')
    .values({
      id: ids.eventId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      brand_id: ids.brandId,
      slug: `pos-${ulid().toLowerCase()}`,
      title: 'Box Office Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date(Date.now() + 86_400_000),
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
  await db
    .insertInto('inventory_pools')
    .values({
      id: ids.poolId,
      event_id: ids.eventId,
      name: 'Door Inventory',
      total_capacity: capacity,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: 300,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values({
      id: ids.ticketTypeId,
      event_id: ids.eventId,
      name: 'General Admission',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 2500,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: ids.poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return ids;
}

async function cleanupSeededData(): Promise<void> {
  const sessions = await db
    .selectFrom('checkout_sessions')
    .select(['id'])
    .where('idempotency_key', 'like', 'pos_%')
    .execute();
  const orders = await db
    .selectFrom('orders')
    .select(['id'])
    .where('operator_id', '=', 'usr_box_office_operator')
    .execute();
  for (const order of orders) {
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('order_timeline_events').where('order_id', '=', order.id).execute();
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('tickets').where('order_id', '=', order.id).execute();
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('attendees').where('order_id', '=', order.id).execute();
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('order_tax_snapshots').where('order_id', '=', order.id).execute();
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('order_line_items').where('order_id', '=', order.id).execute();
    // eslint-disable-next-line no-await-in-loop -- FK cleanup must remove each order's child rows before deleting the order row.
    await db.deleteFrom('orders').where('id', '=', order.id).execute();
  }
  for (const session of sessions) {
    // eslint-disable-next-line no-await-in-loop -- checkout holds must be removed before their POS checkout sessions.
    await db.deleteFrom('checkout_holds').where('checkout_session_id', '=', session.id).execute();
  }
  await db.deleteFrom('checkout_sessions').where('idempotency_key', 'like', 'pos_%').execute();
  await db.deleteFrom('idempotency_records').where('key', 'like', 'pos_%').execute();
  await db.deleteFrom('ticket_types').where('id', 'like', 'tt_pos_%').execute();
  await db.deleteFrom('inventory_pools').where('id', 'like', 'inv_pos_%').execute();
  await db.deleteFrom('events').where('id', 'like', 'evt_pos_%').execute();
  await db.deleteFrom('brands').where('id', 'like', 'brd_pos_%').execute();
  await db.deleteFrom('organizations').where('id', 'like', 'org_pos_%').execute();
  await db.deleteFrom('tenants').where('id', 'like', 'tnt_pos_%').execute();
}

describeWithIntegrationDatabase('box-office order route', () => {
  beforeAll(async () => {
    previousDbDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
  });

  beforeEach(async () => {
    await cleanupSeededData();
  });

  afterEach(async () => {
    await cleanupSeededData();
  });

  afterAll(async () => {
    await db.destroy();
    restoreDatabaseDriver(previousDbDriver);
  });

  it('creates a cash box-office order with issued QR tickets and operator attribution', async () => {
    const ids = await seedBoxOfficeEvent();
    const app = await setupApp(makePrincipal(ids));

    const response = await app.inject({
      method: 'POST',
      url: `/events/${ids.eventId}/box-office/orders`,
      headers: { 'idempotency-key': 'pos_cash_1' },
      payload: {
        tenderType: 'cash',
        amountCents: 2500,
        buyer: { email: 'door@example.test', firstName: 'Door', lastName: 'Buyer' },
        items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.order.salesChannel).toBe('box_office');
    expect(body.order.operatorId).toBe('usr_box_office_operator');
    expect(body.order.tenderType).toBe('cash');
    expect(body.order.totalCents).toBe(2500);
    expect(body.order.lineItems).toHaveLength(1);
    expect(body.order.attendees).toHaveLength(1);
    expect(body.tickets).toHaveLength(1);
    expect(body.tickets[0].qrPayload).toEqual(expect.any(String));
    expect(new QrService('box-office-test-secret').getQrPayload(body.tickets[0].qrPayload)).toMatchObject({
      ticketId: body.tickets[0].id,
      valid: true,
    });

    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', ids.poolId)
      .executeTakeFirstOrThrow();
    expect(Number(pool.sold_count)).toBe(1);
    await app.close();
  });

  it('replays the same idempotency key without creating duplicate tickets', async () => {
    const ids = await seedBoxOfficeEvent();
    const app = await setupApp(makePrincipal(ids));
    const payload = {
      tenderType: 'cash',
      amountCents: 2500,
      items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
    };

    const first = await app.inject({
      method: 'POST',
      url: `/events/${ids.eventId}/box-office/orders`,
      headers: { 'idempotency-key': 'pos_replay_1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/events/${ids.eventId}/box-office/orders`,
      headers: { 'idempotency-key': 'pos_replay_1' },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().order.id).toBe(first.json().order.id);
    const tickets = await db
      .selectFrom('tickets')
      .selectAll()
      .where('order_id', '=', first.json().order.id)
      .execute();
    expect(tickets).toHaveLength(1);
    await app.close();
  });

  it('rejects tender amount mismatches before reserving inventory', async () => {
    const ids = await seedBoxOfficeEvent();
    const app = await setupApp(makePrincipal(ids));

    const response = await app.inject({
      method: 'POST',
      url: `/events/${ids.eventId}/box-office/orders`,
      headers: { 'idempotency-key': 'pos_mismatch_1' },
      payload: {
        tenderType: 'cash',
        amountCents: 2400,
        items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    const holds = await db
      .selectFrom('checkout_holds')
      .selectAll()
      .where('checkout_session_id', 'like', 'cs_%')
      .execute();
    expect(holds).toHaveLength(0);
    await app.close();
  });

  it('denies operators outside the event tenant and scope', async () => {
    const ids = await seedBoxOfficeEvent();
    const app = await setupApp(
      makePrincipal(ids, {
        tenantId: makeId('tnt'),
        organizationIds: [makeId('org')],
        brandIds: [makeId('brd')],
        eventIds: [makeId('evt')],
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: `/events/${ids.eventId}/box-office/orders`,
      headers: { 'idempotency-key': 'pos_tenant_denied_1' },
      payload: {
        tenderType: 'cash',
        amountCents: 2500,
        items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
      },
    });

    expect([403, 404]).toContain(response.statusCode);
    await app.close();
  });

  it('prevents oversell under simultaneous box-office sales', async () => {
    const ids = await seedBoxOfficeEvent(1);
    const app = await setupApp(makePrincipal(ids));
    const request = (key: string) =>
      app.inject({
        method: 'POST',
        url: `/events/${ids.eventId}/box-office/orders`,
        headers: { 'idempotency-key': key },
        payload: {
          tenderType: 'cash',
          amountCents: 2500,
          items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
        },
      });

    const responses = await Promise.all([request('pos_race_1'), request('pos_race_2')]);
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode !== 201)).toHaveLength(1);

    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', ids.poolId)
      .executeTakeFirstOrThrow();
    expect(Number(pool.sold_count)).toBe(1);
    await app.close();
  });
});
