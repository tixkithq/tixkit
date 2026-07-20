import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { eventRoutes } from '../../routes/modules/events.js';
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
  tenantId: string;
}>;

describeWithIntegrationDatabase('event list route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_evt_list_a_${suffix}`;
  const tenantB = `tnt_evt_list_b_${suffix}`;
  const catalogA: Catalog = {
    tenantId: tenantA,
    organizationId: `org_evt_list_a_${suffix}`,
    brandId: `brd_evt_list_a_${suffix}`,
    eventId: `evt_evt_list_a_${suffix}`,
  };
  const catalogATied: Catalog = {
    ...catalogA,
    eventId: `evt_evt_list_tied_${suffix}`,
  };
  const catalogAScoped: Catalog = {
    tenantId: tenantA,
    organizationId: `org_evt_list_scope_${suffix}`,
    brandId: `brd_evt_list_scope_${suffix}`,
    eventId: `evt_evt_list_scope_${suffix}`,
  };
  const catalogB: Catalog = {
    tenantId: tenantB,
    organizationId: `org_evt_list_b_${suffix}`,
    brandId: `brd_evt_list_b_${suffix}`,
    eventId: `evt_evt_list_b_${suffix}`,
  };
  const catalogs = [catalogA, catalogATied, catalogAScoped, catalogB] as const;
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_evt_list_${suffix}`,
    tenantId: tenantA,
    organizationIds: [catalogA.organizationId, catalogB.organizationId],
    brandIds: [],
    scopes: ['events.read'],
  };

  async function seedTenant(id: string): Promise<void> {
    const now = new Date('2026-07-20T08:00:00.000Z');
    await db
      .insertInto('tenants')
      .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function seedOrganizationAndBrand(catalog: Catalog, name: string): Promise<void> {
    const now = new Date('2026-07-20T08:00:00.000Z');
    await db
      .insertInto('organizations')
      .values({
        id: catalog.organizationId,
        tenant_id: catalog.tenantId,
        name,
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
        name,
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
  }

  async function seedEvent(
    catalog: Catalog,
    title: string,
    status: 'draft' | 'published',
    createdAt: Date,
  ): Promise<void> {
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
        status,
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
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await seedTenant(tenantA);
    await seedTenant(tenantB);
    await seedOrganizationAndBrand(catalogA, 'Authorized Workspace');
    await seedOrganizationAndBrand(catalogAScoped, 'Scoped Workspace');
    await seedOrganizationAndBrand(catalogB, 'Foreign Workspace');
    const tied = new Date('2026-07-20T10:00:00.000Z');
    await seedEvent(catalogA, `Authorized Alpha ${suffix}`, 'published', tied);
    await db
      .updateTable('events')
      .set({
        minimum_age: 21,
        version: 7,
        last_setup_section: 'details',
        cover_image_alt: `Accessible cover ${suffix}`,
        seo_use_cover_image: true,
      })
      .where('id', '=', catalogA.eventId)
      .execute();
    await seedEvent(catalogATied, `Authorized Beta ${suffix}`, 'draft', tied);
    await seedEvent(
      catalogAScoped,
      `Scoped Event ${suffix}`,
      'published',
      new Date('2026-07-20T11:00:00.000Z'),
    );
    await seedEvent(
      catalogB,
      `Foreign Event ${suffix}`,
      'published',
      new Date('2026-07-20T12:00:00.000Z'),
    );

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
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
      await attempt(() =>
        db
          .deleteFrom('events')
          .where(
            'id',
            'in',
            catalogs.map((catalog) => catalog.eventId),
          )
          .execute(),
      );
      for (const catalog of [catalogA, catalogAScoped, catalogB]) {
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
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean event-list fixtures');
  });

  it('returns only authorized organization events with scoped totals and facets', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/events?includeTotal=true&includeFacets=true',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(2);
    expect(response.json().total).toBe(2);
    expect(
      response.json().items.find((event: { id: string }) => event.id === catalogA.eventId),
    ).toMatchObject({
      minimumAge: 21,
      version: 7,
      lastSetupSection: 'details',
      coverImageAlt: `Accessible cover ${suffix}`,
      seoUseCoverImage: true,
    });
    expect(response.body).not.toContain(`Scoped Event ${suffix}`);
    expect(response.body).not.toContain(`Foreign Event ${suffix}`);
    expect(response.json().facets.status.rows).toEqual(
      expect.arrayContaining([
        { value: 'draft', total: 1 },
        { value: 'published', total: 1 },
      ]),
    );
  });

  it('intersects brand and event principal scopes without leaking other events', async () => {
    for (const scopedPrincipal of [
      { ...basePrincipal, brandIds: [catalogA.brandId, catalogB.brandId] },
      { ...basePrincipal, eventIds: [catalogA.eventId, catalogB.eventId] },
    ]) {
      principal = scopedPrincipal;
      const response = await app.inject({ method: 'GET', url: '/events?includeTotal=true' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items).toHaveLength(scopedPrincipal.eventIds ? 1 : 2);
      expect(response.body).not.toContain(`Scoped Event ${suffix}`);
      expect(response.body).not.toContain(`Foreign Event ${suffix}`);
    }
  });

  it('returns an empty page for cross-tenant selectors and conceals local denied selectors', async () => {
    const foreign = await app.inject({
      method: 'GET',
      url: `/events?organizationId=${catalogB.organizationId}&brandId=${catalogB.brandId}&includeTotal=true`,
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().items).toEqual([]);
    expect(foreign.json().total).toBe(0);
    expect(foreign.body).not.toContain(`Foreign Event ${suffix}`);

    const deniedOrganization = await app.inject({
      method: 'GET',
      url: `/events?organizationId=${catalogAScoped.organizationId}`,
    });
    expect(deniedOrganization.statusCode, deniedOrganization.body).toBe(404);
    expect(deniedOrganization.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    principal = { ...basePrincipal, brandIds: [catalogA.brandId, catalogB.brandId] };
    const deniedBrand = await app.inject({
      method: 'GET',
      url: `/events?brandId=${catalogAScoped.brandId}`,
    });
    expect(deniedBrand.statusCode, deniedBrand.body).toBe(404);
    expect(deniedBrand.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('denies missing permission before returning event data', async () => {
    principal = { ...basePrincipal, scopes: [] };
    const response = await app.inject({ method: 'GET', url: '/events' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(`Authorized Alpha ${suffix}`);
  });

  it('parses strict filters before empty scope and preserves the table envelope', async () => {
    const published = await app.inject({
      method: 'GET',
      url: '/events?status=published&includeTotal=true',
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().items).toHaveLength(1);
    expect(published.json().filterTotal).toBe(1);

    principal = { ...basePrincipal, organizationIds: [] };
    const invalid = await app.inject({ method: 'GET', url: '/events?unknown=1' });
    expect(invalid.statusCode, invalid.body).toBe(400);

    const empty = await app.inject({
      method: 'GET',
      url: '/events?includeFacets=true&sort=createdAt:asc',
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({
      items: [],
      facets: { status: { rows: [] } },
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
      url: '/events?sort=createdAt:asc&limit=1&includeTotal=true',
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().items).toHaveLength(1);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: 'GET',
      url: `/events?sort=createdAt:asc&limit=1&cursor=${encodeURIComponent(first.json().nextCursor)}`,
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
    expect(second.json().nextCursor).toBeUndefined();
    expect([first.json().items[0].id, second.json().items[0].id].sort()).toEqual(
      [catalogA.eventId, catalogATied.eventId].sort(),
    );
  });

  it('applies title search before pagination and excludes foreign matches', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/events?search=${encodeURIComponent(`Alpha ${suffix}`)}&limit=1&includeTotal=true`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0].id).toBe(catalogA.eventId);
    expect(response.json().filterTotal).toBe(1);
    expect(response.json().nextCursor).toBeUndefined();
  });
});
