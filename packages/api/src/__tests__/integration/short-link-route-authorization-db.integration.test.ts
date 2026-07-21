import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { shortLinkRoutes } from '../../routes/modules/short-links.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { SHORT_LINK_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const listContract = SHORT_LINK_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.method === 'GET' && contract.path === '/short-links',
);
const clicksContract = SHORT_LINK_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.method === 'GET' && contract.path === '/short-links/{id}/clicks',
);
const createContract = SHORT_LINK_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.method === 'POST' && contract.path === '/short-links',
);
if (!listContract || !clicksContract || !createContract) {
  throw new Error('Missing short-link authorization contracts');
}

describeWithIntegrationDatabase(
  `short-link route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let previousDriver: string | undefined;
    let activePrincipal: Principal;

    const suffix = ulid().slice(-6).toLowerCase();
    const tenantA = `tnt_sl_a_${suffix}`;
    const tenantB = `tnt_sl_b_${suffix}`;
    const organizationA = `org_sl_a_${suffix}`;
    const organizationOther = `org_sl_o_${suffix}`;
    const organizationB = `org_sl_b_${suffix}`;
    const brandA = `brd_sl_a_${suffix}`;
    const brandSibling = `brd_sl_s_${suffix}`;
    const brandOther = `brd_sl_o_${suffix}`;
    const brandB = `brd_sl_b_${suffix}`;
    const linkA = `slk_sl_a_${suffix}`;
    const linkSibling = `slk_sl_s_${suffix}`;
    const linkOther = `slk_sl_o_${suffix}`;
    const linkForeign = `slk_sl_f_${suffix}`;
    const linkLegacy = `slk_sl_l_${suffix}`;
    const linkCorrupt = `slk_sl_c_${suffix}`;
    const fixtureLinkIds = [linkA, linkSibling, linkOther, linkForeign, linkLegacy, linkCorrupt];
    const fixtureClickIds = [
      `clk_sl_a1_${suffix}`,
      `clk_sl_a2_${suffix}`,
      `clk_sl_x_${suffix}`,
      `clk_sl_o_${suffix}`,
      `clk_sl_f_${suffix}`,
    ];
    const createdSlugs: string[] = [];
    const secretA = `https://organizer.example/private-${suffix}?token=alpha`;
    const secretSibling = `https://sibling-brand.example/private-${suffix}?token=sibling`;
    const secretOther = `https://other.example/private-${suffix}?token=other`;
    const secretForeign = `https://foreign.example/private-${suffix}?token=foreign`;
    const secretLegacy = `https://legacy.example/private-${suffix}?token=legacy`;
    const secretCorrupt = `https://corrupt.example/private-${suffix}?token=corrupt`;

    function principal(overrides: Partial<Principal> = {}): Principal {
      return {
        type: 'user',
        id: `usr_sl_${suffix}`,
        tenantId: tenantA,
        organizationIds: [organizationA],
        brandIds: [brandA],
        scopes: ['messages.write'],
        ...overrides,
      };
    }

    async function insertTenant(id: string): Promise<void> {
      const now = new Date();
      await db
        .insertInto('tenants')
        .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
        .execute();
    }

    async function insertOrganization(id: string, tenantId: string): Promise<void> {
      const now = new Date();
      await db
        .insertInto('organizations')
        .values({
          id,
          tenant_id: tenantId,
          name: id,
          slug: `${id}-slug`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertBrand(
      id: string,
      tenantId: string,
      organizationId: string,
    ): Promise<void> {
      const now = new Date();
      await db
        .insertInto('brands')
        .values({
          id,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: id,
          slug: `${id}-slug`,
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

    async function insertLink(input: {
      id: string;
      tenantId: string;
      brandId: string | null;
      slug: string;
      destinationUrl: string;
      createdAt: Date;
    }): Promise<void> {
      await db
        .insertInto('short_links')
        .values({
          id: input.id,
          tenant_id: input.tenantId,
          brand_id: input.brandId,
          slug: input.slug,
          destination_url: input.destinationUrl,
          utm_params: null,
          clicks: 0,
          expires_at: null,
          created_at: input.createdAt,
          updated_at: input.createdAt,
        })
        .execute();
    }

    async function insertClick(
      id: string,
      shortLinkId: string,
      tenantId: string,
      dayBucket: string,
    ): Promise<void> {
      await db
        .insertInto('link_clicks')
        .values({
          id,
          short_link_id: shortLinkId,
          tenant_id: tenantId,
          day_bucket: dayBucket,
          created_at: new Date(`${dayBucket}T12:00:00.000Z`),
        })
        .execute();
    }

    async function seedFixture(): Promise<void> {
      await insertTenant(tenantA);
      await insertTenant(tenantB);
      await insertOrganization(organizationA, tenantA);
      await insertOrganization(organizationOther, tenantA);
      await insertOrganization(organizationB, tenantB);
      await insertBrand(brandA, tenantA, organizationA);
      await insertBrand(brandSibling, tenantA, organizationA);
      await insertBrand(brandOther, tenantA, organizationOther);
      await insertBrand(brandB, tenantB, organizationB);
      await insertLink({
        id: linkA,
        tenantId: tenantA,
        brandId: brandA,
        slug: `sa${suffix}`,
        destinationUrl: secretA,
        createdAt: new Date('2026-07-20T14:00:00.000Z'),
      });
      await insertLink({
        id: linkSibling,
        tenantId: tenantA,
        brandId: brandSibling,
        slug: `ssb${suffix}`,
        destinationUrl: secretSibling,
        createdAt: new Date('2026-07-20T13:30:00.000Z'),
      });
      await insertLink({
        id: linkOther,
        tenantId: tenantA,
        brandId: brandOther,
        slug: `so${suffix}`,
        destinationUrl: secretOther,
        createdAt: new Date('2026-07-20T13:00:00.000Z'),
      });
      await insertLink({
        id: linkLegacy,
        tenantId: tenantA,
        brandId: null,
        slug: `sl${suffix}`,
        destinationUrl: secretLegacy,
        createdAt: new Date('2026-07-20T12:00:00.000Z'),
      });
      await insertLink({
        id: linkForeign,
        tenantId: tenantB,
        brandId: brandB,
        slug: `sf${suffix}`,
        destinationUrl: secretForeign,
        createdAt: new Date('2026-07-20T11:00:00.000Z'),
      });
      // No short_links.brand_id FK exists, so retain an adversarial ownership-corrupt row.
      await insertLink({
        id: linkCorrupt,
        tenantId: tenantA,
        brandId: brandB,
        slug: `scx${suffix}`,
        destinationUrl: secretCorrupt,
        createdAt: new Date('2026-07-20T10:00:00.000Z'),
      });
      await insertClick(fixtureClickIds[0]!, linkA, tenantA, '2026-07-19');
      await insertClick(fixtureClickIds[1]!, linkA, tenantA, '2026-07-20');
      // Deliberately inconsistent tenant attribution proves the aggregate filters by tenant.
      await insertClick(fixtureClickIds[2]!, linkA, tenantB, '2026-07-20');
      await insertClick(fixtureClickIds[3]!, linkOther, tenantA, '2026-07-20');
      await insertClick(fixtureClickIds[4]!, linkForeign, tenantB, '2026-07-20');
    }

    async function cleanupFixture(): Promise<void> {
      if (!db) return;
      if (createdSlugs.length > 0) {
        const created = await db
          .selectFrom('short_links')
          .select('id')
          .where('slug', 'in', createdSlugs)
          .execute();
        const ids = created.map((row) => row.id);
        if (ids.length > 0) {
          await db.deleteFrom('link_clicks').where('short_link_id', 'in', ids).execute();
          await db.deleteFrom('short_links').where('id', 'in', ids).execute();
        }
      }
      await db.deleteFrom('link_clicks').where('id', 'in', fixtureClickIds).execute();
      await db.deleteFrom('short_links').where('id', 'in', fixtureLinkIds).execute();
      await db
        .deleteFrom('brands')
        .where('id', 'in', [brandA, brandSibling, brandOther, brandB])
        .execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationOther, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
    }

    async function snapshot(): Promise<unknown> {
      const [links, clicks] = await Promise.all([
        db
          .selectFrom('short_links')
          .selectAll()
          .where('id', 'in', fixtureLinkIds)
          .orderBy('id')
          .execute(),
        db
          .selectFrom('link_clicks')
          .selectAll()
          .where('id', 'in', fixtureClickIds)
          .orderBy('id')
          .execute(),
      ]);
      return { links, clicks };
    }

    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await seedFixture();
      activePrincipal = principal();
      app = Fastify({ logger: false });
      app.decorate('context', { db } as unknown as AppContext);
      app.addHook('preHandler', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(shortLinkRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(() => {
      activePrincipal = principal();
    });

    afterAll(async () => {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (db) await cleanupFixture();
        } finally {
          if (db) await db.destroy();
          restoreDatabaseDriver(previousDriver);
        }
      }
    }, 120_000);

    it('binds the executable matrix to all three short-link contracts', () => {
      expect(Object.isFrozen(SHORT_LINK_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)).toBe(true);
      expect(createContract).toMatchObject({
        method: 'POST',
        path: '/short-links',
        deniedBoundaries: ['tenant', 'organization', 'brand'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
        policyDeniedBoundaries: ['event'],
        persistenceSource: 'short-link-route-authorization-db.integration.test.ts',
        sideEffectAssertions: ['persistence'],
      });
      expect(listContract).toMatchObject({
        method: 'GET',
        path: '/short-links',
        deniedBoundaries: [],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
        policyDeniedBoundaries: ['event'],
        sideEffectAssertions: [],
      });
      expect(clicksContract).toMatchObject({
        method: 'GET',
        path: '/short-links/{id}/clicks',
        deniedBoundaries: ['tenant', 'organization', 'brand'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
        policyDeniedBoundaries: ['event'],
        sideEffectAssertions: [],
      });
    });

    it.each(['user', 'api_key'] as const)(
      'lists only exact organization and brand rows for an authorized %s principal',
      async (type) => {
        activePrincipal = principal({ type });
        const before = await snapshot();
        const response = await app.inject({ method: listContract.method, url: '/short-links' });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().links).toEqual([
          expect.objectContaining({ id: linkA, destinationUrl: secretA }),
        ]);
        expect(response.body).not.toContain(secretOther);
        expect(response.body).not.toContain(secretSibling);
        expect(response.body).not.toContain(secretLegacy);
        expect(response.body).not.toContain(secretForeign);
        expect(response.body).not.toContain(secretCorrupt);
        expect(await snapshot()).toEqual(before);
      },
    );

    it('limits an organization-wide user to brands owned by the claimed organization', async () => {
      activePrincipal = principal({ brandIds: undefined });
      const before = await snapshot();
      const response = await app.inject({ method: 'GET', url: '/short-links' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().links).toEqual([
        expect.objectContaining({ id: linkA, destinationUrl: secretA }),
        expect.objectContaining({ id: linkSibling, destinationUrl: secretSibling }),
      ]);
      expect(response.body).not.toContain(secretOther);
      expect(response.body).not.toContain(secretLegacy);
      expect(response.body).not.toContain(secretForeign);
      expect(response.body).not.toContain(secretCorrupt);
      expect(await snapshot()).toEqual(before);
    });

    it('lists every same-tenant row, including legacy unbranded links, for system principals', async () => {
      activePrincipal = principal({
        type: 'system',
        id: `sys_sl_${suffix}`,
        organizationIds: [],
        brandIds: undefined,
      });
      const before = await snapshot();
      const response = await app.inject({ method: 'GET', url: '/short-links' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().links.map((link: { id: string }) => link.id)).toEqual([
        linkA,
        linkSibling,
        linkOther,
        linkLegacy,
      ]);
      expect(response.body).not.toContain(secretForeign);
      expect(response.body).not.toContain(secretCorrupt);
      expect(await snapshot()).toEqual(before);
    });

    it('returns an empty list for a non-system principal with no organization access', async () => {
      activePrincipal = principal({ organizationIds: [], brandIds: undefined });
      const before = await snapshot();
      const response = await app.inject({ method: 'GET', url: '/short-links' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ links: [] });
      expect(response.body).not.toContain('token=');
      expect(await snapshot()).toEqual(before);
    });

    it('fails list reads closed before disclosure for event scope and missing permission', async () => {
      const before = await snapshot();
      activePrincipal = principal({ eventIds: [`evt_sl_${suffix}`] });
      const eventScoped = await app.inject({ method: 'GET', url: '/short-links' });
      activePrincipal = principal({ scopes: [] });
      const noPermission = await app.inject({ method: 'GET', url: '/short-links' });
      expect(eventScoped.statusCode).toBe(403);
      expect(noPermission.statusCode).toBe(403);
      expect(eventScoped.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(noPermission.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(eventScoped.body).not.toContain('token=');
      expect(noPermission.body).not.toContain('token=');
      expect(await snapshot()).toEqual(before);
    });

    it.each(['user', 'api_key'] as const)(
      'aggregates only exact-tenant clicks for an authorized %s principal with database parity',
      async (type) => {
        activePrincipal = principal({ type });
        const before = await snapshot();
        const response = await app.inject({
          method: clicksContract.method,
          url: `/short-links/${linkA}/clicks`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
          id: linkA,
          totalClicks: 2,
          byDay: { '2026-07-19': 1, '2026-07-20': 1 },
        });
        expect(await snapshot()).toEqual(before);
      },
    );

    it('allows a system principal to read a tenant-bound legacy aggregate', async () => {
      activePrincipal = principal({
        type: 'system',
        id: `sys_sl_${suffix}`,
        organizationIds: [],
        brandIds: undefined,
      });
      const before = await snapshot();
      const response = await app.inject({
        method: 'GET',
        url: `/short-links/${linkLegacy}/clicks`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: linkLegacy, totalClicks: 0, byDay: {} });
      expect(await snapshot()).toEqual(before);
    });

    it('makes inaccessible, legacy, foreign, and unknown click resources indistinguishable', async () => {
      const before = await snapshot();
      const missing = `slk_sl_m_${suffix}`;
      const ids = [linkSibling, linkOther, linkLegacy, linkForeign, linkCorrupt, missing];
      const responses = [];
      for (const id of ids) {
        responses.push(await app.inject({ method: 'GET', url: `/short-links/${id}/clicks` }));
      }
      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        const requestedId = ids[responses.indexOf(response)]!;
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `ShortLink not found: ${requestedId}`,
            details: { resource: 'ShortLink', id: requestedId },
          },
        });
        expect(response.body).not.toContain('token=');
        expect(response.body).not.toContain(secretOther);
        expect(response.body).not.toContain(secretSibling);
        expect(response.body).not.toContain(secretLegacy);
        expect(response.body).not.toContain(secretForeign);
        expect(response.body).not.toContain(secretCorrupt);
        expect(response.body).not.toContain(organizationOther);
        expect(response.body).not.toContain(brandOther);
        expect(response.body).not.toContain(brandSibling);
      }
      expect(await snapshot()).toEqual(before);
    });

    it('fails click reads closed for event scope and missing permission without disclosing destination', async () => {
      const before = await snapshot();
      activePrincipal = principal({ eventIds: [`evt_sl_${suffix}`] });
      const eventScoped = await app.inject({ method: 'GET', url: `/short-links/${linkA}/clicks` });
      activePrincipal = principal({ scopes: [] });
      const noPermission = await app.inject({ method: 'GET', url: `/short-links/${linkA}/clicks` });
      expect(eventScoped.statusCode).toBe(403);
      expect(noPermission.statusCode).toBe(403);
      expect(eventScoped.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(noPermission.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(eventScoped.body).not.toContain(secretA);
      expect(noPermission.body).not.toContain(secretA);
      expect(await snapshot()).toEqual(before);
    });

    it.each(['user', 'api_key'] as const)(
      'creates a brand-backed link for an exact authorized %s principal',
      async (type) => {
        activePrincipal = principal({ type });
        const slug = `sc${type === 'user' ? 'u' : 'k'}${suffix}`;
        createdSlugs.push(slug);
        const response = await app.inject({
          method: createContract.method,
          url: '/short-links',
          payload: { destinationUrl: `https://create.example/${suffix}`, slug, brandId: brandA },
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          slug,
          destinationUrl: `https://create.example/${suffix}`,
        });
        const persisted = await db
          .selectFrom('short_links')
          .select(['tenant_id', 'brand_id', 'destination_url'])
          .where('slug', '=', slug)
          .executeTakeFirstOrThrow();
        expect(persisted).toEqual({
          tenant_id: tenantA,
          brand_id: brandA,
          destination_url: `https://create.example/${suffix}`,
        });
      },
    );

    it('allows a system principal to create a tenant-bound legacy unbranded link', async () => {
      activePrincipal = principal({
        type: 'system',
        id: `sys_sl_${suffix}`,
        organizationIds: [],
        brandIds: undefined,
      });
      const slug = `ss${suffix}`;
      createdSlugs.push(slug);
      const response = await app.inject({
        method: 'POST',
        url: '/short-links',
        payload: { destinationUrl: `https://system.example/${suffix}`, slug },
      });
      expect(response.statusCode, response.body).toBe(200);
      const persisted = await db
        .selectFrom('short_links')
        .select(['tenant_id', 'brand_id'])
        .where('slug', '=', slug)
        .executeTakeFirstOrThrow();
      expect(persisted).toEqual({ tenant_id: tenantA, brand_id: null });
    });

    it('denies brandless, cross-scope, event-scoped, and permissionless creates without mutation', async () => {
      const cases: Array<{
        principal: Principal;
        brandId?: string;
        secret: string;
        expectedStatus: 403 | 404;
        expectedCode: 'FORBIDDEN' | 'NOT_FOUND';
      }> = [
        {
          principal: principal(),
          secret: `brandless-${suffix}`,
          expectedStatus: 403,
          expectedCode: 'FORBIDDEN',
        },
        {
          principal: principal(),
          brandId: brandOther,
          secret: `other-organization-${suffix}`,
          expectedStatus: 404,
          expectedCode: 'NOT_FOUND',
        },
        {
          principal: principal(),
          brandId: brandB,
          secret: `foreign-tenant-${suffix}`,
          expectedStatus: 404,
          expectedCode: 'NOT_FOUND',
        },
        {
          principal: principal({ brandIds: [brandSibling] }),
          brandId: brandA,
          secret: `wrong-brand-${suffix}`,
          expectedStatus: 404,
          expectedCode: 'NOT_FOUND',
        },
        {
          principal: principal({ eventIds: [`evt_sl_${suffix}`] }),
          brandId: brandA,
          secret: `event-scope-${suffix}`,
          expectedStatus: 403,
          expectedCode: 'FORBIDDEN',
        },
        {
          principal: principal({ scopes: [] }),
          brandId: brandA,
          secret: `permission-${suffix}`,
          expectedStatus: 403,
          expectedCode: 'FORBIDDEN',
        },
      ];
      const before = await snapshot();
      for (const [index, testCase] of cases.entries()) {
        activePrincipal = testCase.principal;
        const slug = `sd${index}${suffix}`;
        const response = await app.inject({
          method: 'POST',
          url: '/short-links',
          payload: {
            destinationUrl: `https://denied.example/${testCase.secret}?token=${testCase.secret}`,
            slug,
            ...(testCase.brandId ? { brandId: testCase.brandId } : {}),
          },
        });
        expect(response.statusCode, response.body).toBe(testCase.expectedStatus);
        expect(response.json()).toMatchObject({ error: { code: testCase.expectedCode } });
        expect(response.body).not.toContain(testCase.secret);
        expect(response.body).not.toContain(organizationOther);
        expect(
          await db
            .selectFrom('short_links')
            .select('id')
            .where('slug', '=', slug)
            .executeTakeFirst(),
        ).toBeUndefined();
      }
      expect(await snapshot()).toEqual(before);
    });
  },
);
