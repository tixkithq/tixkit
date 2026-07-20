import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AttendeeRepository,
  CheckoutSessionRepository,
  createDb,
  OrderRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type Catalog = Readonly<{
  brandId: string;
  eventId: string;
  organizationId: string;
  poolId: string;
  tenantId: string;
  ticketTypeId: string;
}>;

describeWithIntegrationDatabase('attendee list route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_att_list_a_${suffix}`;
  const tenantB = `tnt_att_list_b_${suffix}`;
  const catalogA: Catalog = {
    tenantId: tenantA,
    organizationId: `org_att_list_a_${suffix}`,
    brandId: `brd_att_list_a_${suffix}`,
    eventId: `evt_att_list_a_${suffix}`,
    poolId: `pool_att_list_a_${suffix}`,
    ticketTypeId: `tt_att_list_a_${suffix}`,
  };
  const catalogAScoped: Catalog = {
    tenantId: tenantA,
    organizationId: `org_att_list_scope_${suffix}`,
    brandId: `brd_att_list_scope_${suffix}`,
    eventId: `evt_att_list_scope_${suffix}`,
    poolId: `pool_att_list_scope_${suffix}`,
    ticketTypeId: `tt_att_list_scope_${suffix}`,
  };
  const catalogB: Catalog = {
    tenantId: tenantB,
    organizationId: `org_att_list_b_${suffix}`,
    brandId: `brd_att_list_b_${suffix}`,
    eventId: `evt_att_list_b_${suffix}`,
    poolId: `pool_att_list_b_${suffix}`,
    ticketTypeId: `tt_att_list_b_${suffix}`,
  };
  const catalogs = [catalogA, catalogAScoped, catalogB] as const;
  const attendeeIds: string[] = [];
  const orderIds: string[] = [];
  const checkoutIds: string[] = [];
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_att_list_${suffix}`,
    tenantId: tenantA,
    organizationIds: [catalogA.organizationId, catalogB.organizationId],
    brandIds: [],
    scopes: ['attendees.read'],
  };

  async function seedTenant(id: string): Promise<void> {
    const now = new Date('2026-07-20T08:00:00.000Z');
    await db
      .insertInto('tenants')
      .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function seedCatalog(catalog: Catalog, title: string): Promise<void> {
    const now = new Date('2026-07-20T08:00:00.000Z');
    await db
      .insertInto('organizations')
      .values({
        id: catalog.organizationId,
        tenant_id: catalog.tenantId,
        name: title,
        slug: `${catalog.organizationId}-slug`,
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
        id: catalog.brandId,
        tenant_id: catalog.tenantId,
        organization_id: catalog.organizationId,
        name: title,
        slug: `${catalog.brandId}-slug`,
        status: 'active',
        theme: '{}',
        support_url: null,
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
        id: catalog.eventId,
        tenant_id: catalog.tenantId,
        organization_id: catalog.organizationId,
        brand_id: catalog.brandId,
        slug: `${catalog.eventId}-slug`,
        title,
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date('2027-01-01T18:00:00.000Z'),
        ends_at: null,
        venue: null,
        visibility: 'private',
        seo: '{}',
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
        id: catalog.poolId,
        event_id: catalog.eventId,
        name: `${title} inventory`,
        total_capacity: 20,
        reserved_count: 0,
        sold_count: 2,
        hold_ttl_seconds: 300,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('ticket_types')
      .values({
        id: catalog.ticketTypeId,
        event_id: catalog.eventId,
        name: `${title} ticket`,
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
        inventory_pool_id: catalog.poolId,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        event_occurrence_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedAttendee(
    catalog: Catalog,
    email: string,
    status: 'confirmed' | 'refunded',
    checkedIn: boolean,
    createdAt: Date,
  ): Promise<string> {
    const checkout = await new CheckoutSessionRepository(db).create({
      tenantId: catalog.tenantId,
      eventId: catalog.eventId,
      brandId: catalog.brandId,
      currency: 'USD',
      cart: { items: [{ ticketTypeId: catalog.ticketTypeId, quantity: 1 }] },
      buyer: { email },
      quote: { totalCents: 2500 },
      expiresAt: new Date('2027-01-01T17:00:00.000Z'),
      idempotencyKey: `att-list-${email}`,
    });
    checkoutIds.push(checkout.id);
    const order = await new OrderRepository(db).create({
      tenantId: catalog.tenantId,
      organizationId: catalog.organizationId,
      brandId: catalog.brandId,
      eventId: catalog.eventId,
      checkoutSessionId: checkout.id,
      orderNumber: `ATT-${ulid()}`,
      status: 'paid',
      currency: 'USD',
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
      buyerEmail: email,
    });
    orderIds.push(order.id);
    const attendee = await new AttendeeRepository(db).create({
      tenantId: catalog.tenantId,
      orderId: order.id,
      eventId: catalog.eventId,
      ticketTypeId: catalog.ticketTypeId,
      firstName: email.split('@')[0],
      lastName: 'Fixture',
      email,
    });
    attendeeIds.push(attendee.id);
    await db
      .updateTable('attendees')
      .set({
        status,
        checked_in_at: checkedIn ? new Date('2026-07-20T12:00:00.000Z') : null,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .where('id', '=', attendee.id)
      .execute();
    return attendee.id;
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await seedTenant(tenantA);
    await seedTenant(tenantB);
    await seedCatalog(catalogA, 'Authorized Event');
    await seedCatalog(catalogAScoped, 'Scoped Event');
    await seedCatalog(catalogB, 'Foreign Event');
    const tied = new Date('2026-07-20T10:00:00.000Z');
    await seedAttendee(catalogA, `confirmed-${suffix}@example.test`, 'confirmed', false, tied);
    await seedAttendee(catalogA, `refunded-${suffix}@example.test`, 'refunded', false, tied);
    await seedAttendee(
      catalogAScoped,
      `scoped-${suffix}@example.test`,
      'confirmed',
      true,
      new Date('2026-07-20T11:00:00.000Z'),
    );
    await seedAttendee(
      catalogB,
      `foreign-${suffix}@example.test`,
      'confirmed',
      true,
      new Date('2026-07-20T12:00:00.000Z'),
    );

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(checkInRoutes);
    await app.ready();
  });

  beforeEach(() => {
    principal = basePrincipal;
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    if (app) await attempt(() => app.close());
    if (db) {
      await attempt(() => db.deleteFrom('attendees').where('id', 'in', attendeeIds).execute());
      await attempt(() => db.deleteFrom('orders').where('id', 'in', orderIds).execute());
      await attempt(() =>
        db.deleteFrom('checkout_sessions').where('id', 'in', checkoutIds).execute(),
      );
      for (const catalog of catalogs) {
        await attempt(() =>
          db.deleteFrom('ticket_types').where('id', '=', catalog.ticketTypeId).execute(),
        );
        await attempt(() =>
          db.deleteFrom('inventory_pools').where('id', '=', catalog.poolId).execute(),
        );
        await attempt(() => db.deleteFrom('events').where('id', '=', catalog.eventId).execute());
        await attempt(() => db.deleteFrom('brands').where('id', '=', catalog.brandId).execute());
        await attempt(() =>
          db.deleteFrom('organizations').where('id', '=', catalog.organizationId).execute(),
        );
      }
      for (const tenantId of [tenantA, tenantB]) {
        await attempt(() => db.deleteFrom('tenants').where('id', '=', tenantId).execute());
      }
      await attempt(() => db.destroy());
    }
    restoreDatabaseDriver(previousDriver);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean attendee fixtures');
  });

  it('returns only authorized organization attendees with scoped enrichment and facets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/attendees?includeTotal=true&includeFacets=true',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(response.json().items.map((item: { eventTitle: string }) => item.eventTitle)).toEqual([
      'Authorized Event',
      'Authorized Event',
    ]);
    expect(
      response.json().items.map((item: { ticketTypeName: string }) => item.ticketTypeName),
    ).toEqual(['Authorized Event ticket', 'Authorized Event ticket']);
    expect(response.json().total).toBe(2);
    expect(response.body).not.toContain('Scoped Event');
    expect(response.body).not.toContain('Foreign Event');
    const statuses = response.json().facets.status.rows as Array<{ total: number; value: string }>;
    expect(statuses).toEqual(
      expect.arrayContaining([
        { value: 'confirmed', total: 1 },
        { value: 'refunded', total: 1 },
      ]),
    );
  });

  it('intersects brand and event principal scopes without leaking other attendees', async () => {
    for (const scopedPrincipal of [
      { ...basePrincipal, brandIds: [catalogA.brandId, catalogB.brandId] },
      { ...basePrincipal, eventIds: [catalogA.eventId, catalogB.eventId] },
    ]) {
      principal = scopedPrincipal;
      const response = await app.inject({ method: 'GET', url: '/attendees?includeTotal=true' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items).toHaveLength(2);
      expect(response.json().total).toBe(2);
      expect(response.body).not.toContain(`scoped-${suffix}@example.test`);
      expect(response.body).not.toContain(`foreign-${suffix}@example.test`);
    }
  });

  it('returns an empty page for cross-tenant selectors and conceals unscoped local selectors', async () => {
    const foreign = await app.inject({
      method: 'GET',
      url: `/attendees?organizationId=${catalogB.organizationId}&brandId=${catalogB.brandId}&includeTotal=true`,
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().items).toEqual([]);
    expect(foreign.json().total).toBe(0);
    expect(foreign.body).not.toContain(`foreign-${suffix}@example.test`);

    const deniedOrganization = await app.inject({
      method: 'GET',
      url: `/attendees?organizationId=${catalogAScoped.organizationId}`,
    });
    expect(deniedOrganization.statusCode, deniedOrganization.body).toBe(404);
    expect(deniedOrganization.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    principal = { ...basePrincipal, brandIds: [catalogA.brandId, catalogB.brandId] };
    const deniedBrand = await app.inject({
      method: 'GET',
      url: `/attendees?brandId=${catalogAScoped.brandId}`,
    });
    expect(deniedBrand.statusCode, deniedBrand.body).toBe(404);
    expect(deniedBrand.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(deniedOrganization.body).not.toContain(`scoped-${suffix}@example.test`);
    expect(deniedBrand.body).not.toContain(`scoped-${suffix}@example.test`);
  });

  it('denies missing permission before returning attendee data', async () => {
    principal = { ...basePrincipal, scopes: [] };
    const response = await app.inject({ method: 'GET', url: '/attendees' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(`confirmed-${suffix}@example.test`);
  });

  it('accepts real attendee statuses and parses hostile queries before empty-scope returns', async () => {
    const confirmed = await app.inject({
      method: 'GET',
      url: '/attendees?status=confirmed&includeTotal=true',
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().items).toHaveLength(1);
    expect(confirmed.json().filterTotal).toBe(1);

    principal = { ...basePrincipal, organizationIds: [] };
    for (const url of ['/attendees?badField=1', '/attendees?status=active']) {
      const invalid = await app.inject({ method: 'GET', url });
      expect(invalid.statusCode, invalid.body).toBe(400);
      expect(invalid.body).not.toContain(`confirmed-${suffix}@example.test`);
    }

    const empty = await app.inject({
      method: 'GET',
      url: '/attendees?includeFacets=true&sort=createdAt:asc',
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({
      items: [],
      facets: {
        checkInStatus: { rows: [] },
        status: { rows: [] },
      },
      applied: {
        filters: {},
        sort: [{ direction: 'asc', field: 'createdAt' }],
      },
    });
    expect(empty.json()).not.toHaveProperty('total');
    expect(empty.json()).not.toHaveProperty('filterTotal');
  });

  it('uses the primary-key tie-breaker for complete non-overlapping cursor pages', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/attendees?sort=createdAt:asc&limit=1&includeTotal=true',
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: 'GET',
      url: `/attendees?sort=createdAt:asc&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
    expect(second.json().nextCursor).toBeUndefined();
    expect([first.json().items[0].id, second.json().items[0].id].sort()).toEqual(
      attendeeIds.slice(0, 2).sort(),
    );
  });

  it('applies search before pagination and excludes foreign matching values', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/attendees?search=${encodeURIComponent(`confirmed-${suffix}`)}&limit=1&includeTotal=true`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].email).toBe(`confirmed-${suffix}@example.test`);
    expect(response.json().filterTotal).toBe(1);
    expect(response.json().nextCursor).toBeUndefined();
  });
});
