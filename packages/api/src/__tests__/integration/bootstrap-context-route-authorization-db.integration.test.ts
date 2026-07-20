import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Permission, Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type Catalog = Readonly<{
  brandId: string;
  brandName: string;
  organizationId: string;
  organizationName: string;
  tenantId: string;
}>;

type BootstrapOrganization = Readonly<{
  boxOfficeSettings?: unknown;
  id: string;
  name: string;
}>;

type BootstrapBrand = Readonly<{
  domains: ReadonlyArray<Readonly<{ domain: string }>>;
  id: string;
  name: string;
  paymentAccountId?: string;
  theme: Record<string, unknown>;
  whiteLabel: boolean;
}>;

describeWithIntegrationDatabase('bootstrap context route authorization DB parity', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-8).toLowerCase();
  const tenantA = `tnt_bca_${suffix}`;
  const tenantB = `tnt_bcb_${suffix}`;
  const mixedUserId = `usr_bcm_${suffix}`;
  const brandUserId = `usr_bcb_${suffix}`;
  const doorUserId = `usr_bcd_${suffix}`;

  const settingsCatalog: Catalog = {
    tenantId: tenantA,
    organizationId: `org_bcs_${suffix}`,
    organizationName: 'Settings organization',
    brandId: `brd_bcs_${suffix}`,
    brandName: 'Settings brand',
  };
  const operationsCatalog: Catalog = {
    tenantId: tenantA,
    organizationId: `org_bco_${suffix}`,
    organizationName: 'Operations organization',
    brandId: `brd_bco_${suffix}`,
    brandName: 'Authorized operations brand',
  };
  const operationsSiblingCatalog: Catalog = {
    ...operationsCatalog,
    brandId: `brd_bcx_${suffix}`,
    brandName: 'Denied sibling brand',
  };
  const doorCatalog: Catalog = {
    tenantId: tenantA,
    organizationId: `org_bcd_${suffix}`,
    organizationName: 'Door organization',
    brandId: `brd_bcd_${suffix}`,
    brandName: 'Door event brand',
  };
  const membershipOnlyCatalog: Catalog = {
    tenantId: tenantA,
    organizationId: `org_bcm_${suffix}`,
    organizationName: 'Membership only organization',
    brandId: `brd_bcm_${suffix}`,
    brandName: 'Membership only brand',
  };
  const foreignCatalog: Catalog = {
    tenantId: tenantB,
    organizationId: `org_bcf_${suffix}`,
    organizationName: 'Foreign organization',
    brandId: `brd_bcf_${suffix}`,
    brandName: 'Foreign brand',
  };
  const catalogs = [
    settingsCatalog,
    operationsCatalog,
    operationsSiblingCatalog,
    doorCatalog,
    membershipOnlyCatalog,
    foreignCatalog,
  ] as const;
  const organizationCatalogs = [
    settingsCatalog,
    operationsCatalog,
    doorCatalog,
    membershipOnlyCatalog,
    foreignCatalog,
  ] as const;
  const doorEventId = `evt_bcd_${suffix}`;
  const operationsEventId = `evt_bco_${suffix}`;
  const memberIds: string[] = [];
  const grantIds: string[] = [];
  const domainIds: string[] = [];

  const baseMixedPrincipal: Principal = {
    type: 'user',
    id: mixedUserId,
    tenantId: tenantA,
    organizationIds: [
      settingsCatalog.organizationId,
      operationsCatalog.organizationId,
      membershipOnlyCatalog.organizationId,
      foreignCatalog.organizationId,
    ],
    brandIds: [],
    scopes: ['settings.write', 'events.write'],
  };

  async function seedTenant(id: string): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await db
      .insertInto('tenants')
      .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function seedOrganization(catalog: Catalog): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await db
      .insertInto('organizations')
      .values({
        id: catalog.organizationId,
        tenant_id: catalog.tenantId,
        name: catalog.organizationName,
        slug: `${catalog.organizationId}-slug`,
        clerk_organization_id: null,
        box_office_settings: JSON.stringify({
          enabled: true,
          allowedTenderTypes: ['cash'],
          requireBuyerEmail: true,
          receiptMode: 'email',
        }),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedBrand(catalog: Catalog): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await db
      .insertInto('brands')
      .values({
        id: catalog.brandId,
        tenant_id: catalog.tenantId,
        organization_id: catalog.organizationId,
        name: catalog.brandName,
        slug: `${catalog.brandId}-slug`,
        status: 'active',
        theme: JSON.stringify({ primaryColor: '#123456' }),
        support_url: null,
        legal_urls: '{}',
        white_label: true,
        payment_account_id: `pay_${catalog.brandId}`,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedUser(id: string, tenantId: string): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await db
      .insertInto('user_profiles')
      .values({
        id,
        tenant_id: tenantId,
        clerk_user_id: `clerk_${id}`,
        email: `${id}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedMember(
    userId: string,
    catalog: Catalog,
    role: 'admin' | 'organizer' | 'door_staff',
  ): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const id = `mem_${ulid()}`;
    memberIds.push(id);
    await db
      .insertInto('organization_members')
      .values({
        id,
        tenant_id: catalog.tenantId,
        organization_id: catalog.organizationId,
        user_id: userId,
        role,
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedGrant(
    userId: string,
    tenantId: string,
    permission: Permission,
    scopeType: 'organization' | 'brand' | 'event',
    scopeId: string,
  ): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const id = `pgr_${ulid()}`;
    grantIds.push(id);
    await db
      .insertInto('permission_grants')
      .values({
        id,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: userId,
        permission,
        scope_type: scopeType,
        scope_id: scopeId,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function seedEvent(id: string, catalog: Catalog): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await db
      .insertInto('events')
      .values({
        id,
        tenant_id: catalog.tenantId,
        organization_id: catalog.organizationId,
        brand_id: catalog.brandId,
        slug: `${id}-slug`,
        title: `${catalog.brandName} event`,
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
  }

  async function seedDomain(catalog: Catalog): Promise<void> {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const id = `dom_${ulid()}`;
    domainIds.push(id);
    await db
      .insertInto('brand_domains')
      .values({
        id,
        brand_id: catalog.brandId,
        domain: `${catalog.brandId}.example.test`,
        is_primary: true,
        is_verified: true,
        verification_token: null,
        ssl_status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  function organizations(body: { organizations: BootstrapOrganization[] }) {
    return new Map(body.organizations.map((organization) => [organization.id, organization]));
  }

  function brands(body: { brands: BootstrapBrand[] }) {
    return new Map(body.brands.map((brand) => [brand.id, brand]));
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await seedTenant(tenantA);
    await seedTenant(tenantB);
    for (const catalog of organizationCatalogs) await seedOrganization(catalog);
    for (const catalog of catalogs) await seedBrand(catalog);
    await seedEvent(doorEventId, doorCatalog);
    await seedEvent(operationsEventId, operationsCatalog);
    await seedDomain(settingsCatalog);
    await seedDomain(operationsCatalog);
    await seedDomain(operationsSiblingCatalog);
    await seedDomain(doorCatalog);

    await seedUser(mixedUserId, tenantA);
    await seedUser(brandUserId, tenantA);
    await seedUser(doorUserId, tenantA);

    await seedMember(mixedUserId, settingsCatalog, 'admin');
    await seedMember(mixedUserId, operationsCatalog, 'organizer');
    await seedMember(mixedUserId, membershipOnlyCatalog, 'organizer');
    await seedGrant(
      mixedUserId,
      tenantA,
      'settings.write',
      'organization',
      settingsCatalog.organizationId,
    );
    await seedGrant(
      mixedUserId,
      tenantA,
      'events.write',
      'organization',
      operationsCatalog.organizationId,
    );
    await seedGrant(
      mixedUserId,
      tenantB,
      'settings.write',
      'organization',
      foreignCatalog.organizationId,
    );

    await seedMember(brandUserId, operationsCatalog, 'organizer');
    await seedGrant(brandUserId, tenantA, 'events.write', 'brand', operationsCatalog.brandId);

    await seedMember(doorUserId, doorCatalog, 'door_staff');
    for (const permission of [
      'events.read',
      'attendees.read',
      'checkins.read',
      'checkins.write',
    ] as const) {
      await seedGrant(doorUserId, tenantA, permission, 'event', doorEventId);
    }

    principal = baseMixedPrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(tenantRoutes);
    await app.ready();
  }, 120_000);

  beforeEach(() => {
    principal = baseMixedPrincipal;
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
      if (grantIds.length > 0) {
        await attempt(() =>
          db.deleteFrom('permission_grants').where('id', 'in', grantIds).execute(),
        );
      }
      if (memberIds.length > 0) {
        await attempt(() =>
          db.deleteFrom('organization_members').where('id', 'in', memberIds).execute(),
        );
      }
      for (const id of domainIds) {
        await attempt(() => db.deleteFrom('brand_domains').where('id', '=', id).execute());
      }
      for (const id of [doorEventId, operationsEventId]) {
        await attempt(() => db.deleteFrom('events').where('id', '=', id).execute());
      }
      for (const catalog of catalogs) {
        await attempt(() => db.deleteFrom('brands').where('id', '=', catalog.brandId).execute());
      }
      for (const catalog of organizationCatalogs) {
        await attempt(() =>
          db.deleteFrom('organizations').where('id', '=', catalog.organizationId).execute(),
        );
      }
      for (const id of [mixedUserId, brandUserId, doorUserId]) {
        await attempt(() => db.deleteFrom('user_profiles').where('id', '=', id).execute());
      }
      for (const id of [tenantA, tenantB]) {
        await attempt(() => db.deleteFrom('tenants').where('id', '=', id).execute());
      }
      await attempt(() => db.destroy());
    }
    restoreDatabaseDriver(previousDriver);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean bootstrap fixtures');
  }, 120_000);

  it('intersects membership and organization grants with per-row settings minimization', async () => {
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json() as {
      brands: BootstrapBrand[];
      organizations: BootstrapOrganization[];
    };
    expect(body.organizations.map(({ id }) => id).sort()).toEqual(
      [settingsCatalog.organizationId, operationsCatalog.organizationId].sort(),
    );
    expect(body.brands.map(({ id }) => id).sort()).toEqual(
      [settingsCatalog.brandId, operationsCatalog.brandId, operationsSiblingCatalog.brandId].sort(),
    );

    const organizationById = organizations(body);
    expect(organizationById.get(settingsCatalog.organizationId)).toHaveProperty(
      'boxOfficeSettings',
    );
    expect(organizationById.get(operationsCatalog.organizationId)).not.toHaveProperty(
      'boxOfficeSettings',
    );

    const brandById = brands(body);
    expect(brandById.get(settingsCatalog.brandId)).toMatchObject({
      theme: { primaryColor: '#123456' },
      whiteLabel: true,
    });
    expect(brandById.get(settingsCatalog.brandId)?.domains).toHaveLength(1);
    for (const brandId of [operationsCatalog.brandId, operationsSiblingCatalog.brandId]) {
      expect(brandById.get(brandId)).toMatchObject({ domains: [], theme: {}, whiteLabel: false });
      expect(brandById.get(brandId)).not.toHaveProperty('paymentAccountId');
    }
    expect(response.body).not.toContain(membershipOnlyCatalog.organizationName);
    expect(response.body).not.toContain(foreignCatalog.organizationName);
  });

  it('honors an exact brand grant without exposing its sibling', async () => {
    principal = {
      type: 'user',
      id: brandUserId,
      tenantId: tenantA,
      organizationIds: [operationsCatalog.organizationId],
      brandIds: [operationsCatalog.brandId],
      scopes: ['events.write'],
    };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().organizations.map(({ id }: { id: string }) => id)).toEqual([
      operationsCatalog.organizationId,
    ]);
    expect(response.json().brands.map(({ id }: { id: string }) => id)).toEqual([
      operationsCatalog.brandId,
    ]);
    expect(response.body).not.toContain(operationsSiblingCatalog.brandName);
  });

  it('derives the exact brand for a door-only event grant', async () => {
    principal = {
      type: 'user',
      id: doorUserId,
      tenantId: tenantA,
      organizationIds: [doorCatalog.organizationId],
      brandIds: [],
      eventIds: [doorEventId],
      scopes: ['events.read', 'attendees.read', 'checkins.read', 'checkins.write'],
    };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().organizations.map(({ id }: { id: string }) => id)).toEqual([
      doorCatalog.organizationId,
    ]);
    expect(response.json().brands.map(({ id }: { id: string }) => id)).toEqual([
      doorCatalog.brandId,
    ]);
    expect(response.json().brands[0]).toMatchObject({ domains: [], theme: {}, whiteLabel: false });
  });

  it('does not trust cross-tenant organization or brand selectors', async () => {
    principal = {
      ...baseMixedPrincipal,
      organizationIds: [foreignCatalog.organizationId],
      brandIds: [foreignCatalog.brandId],
    };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ brands: [], organizations: [] });
    expect(response.body).not.toContain(foreignCatalog.organizationName);
    expect(response.body).not.toContain(foreignCatalog.brandName);
  });

  it('denies a principal without a dashboard permission', async () => {
    principal = { ...baseMixedPrincipal, scopes: [] };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('denies non-door event-scoped dashboard access', async () => {
    principal = {
      type: 'user',
      id: brandUserId,
      tenantId: tenantA,
      organizationIds: [operationsCatalog.organizationId],
      brandIds: [operationsCatalog.brandId],
      eventIds: [operationsEventId],
      scopes: ['events.read'],
    };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('keeps brand-restricted settings API keys detailed only on the exact brand', async () => {
    principal = {
      type: 'api_key',
      id: `key_bca_${suffix}`,
      tenantId: tenantA,
      organizationIds: [operationsCatalog.organizationId],
      brandIds: [operationsCatalog.brandId],
      scopes: ['settings.write'],
    };
    const response = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().organizations.map(({ id }: { id: string }) => id)).toEqual([
      operationsCatalog.organizationId,
    ]);
    expect(response.json().brands.map(({ id }: { id: string }) => id)).toEqual([
      operationsCatalog.brandId,
    ]);
    expect(response.body).not.toContain(operationsSiblingCatalog.brandName);
    expect(response.json().organizations[0]).not.toHaveProperty('boxOfficeSettings');
    expect(response.json().brands[0]).toMatchObject({
      domains: [{ domain: `${operationsCatalog.brandId}.example.test` }],
      paymentAccountId: `pay_${operationsCatalog.brandId}`,
      theme: { primaryColor: '#123456' },
      whiteLabel: true,
    });
    expect(response.body).not.toContain(`${operationsSiblingCatalog.brandId}.example.test`);
    expect(response.body).not.toContain(`pay_${operationsSiblingCatalog.brandId}`);
  });
});
