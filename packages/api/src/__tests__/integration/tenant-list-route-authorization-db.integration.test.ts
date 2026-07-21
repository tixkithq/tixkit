import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('tenant list route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_list_a_${suffix}`;
  const tenantB = `tnt_list_b_${suffix}`;
  const organizationA = `org_list_a_${suffix}`;
  const organizationAScoped = `org_list_scope_${suffix}`;
  const organizationB = `org_list_b_${suffix}`;
  const brandA = `brd_list_a_${suffix}`;
  const brandAOther = `brd_list_a_other_${suffix}`;
  const brandAScoped = `brd_list_scope_${suffix}`;
  const brandB = `brd_list_b_${suffix}`;
  const domainA = `dom_list_a_${suffix}`;
  const domainAOther = `dom_list_a_other_${suffix}`;
  const domainAScoped = `dom_list_scope_${suffix}`;
  const domainB = `dom_list_b_${suffix}`;
  const senderIdentityA = `bsi_list_a_${suffix}`;
  const senderIdentityAOther = `bsi_list_other_${suffix}`;
  const senderIdentityCrossTenant = `bsi_list_cross_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_list_${suffix}`,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    brandIds: [brandA, brandB],
    scopes: ['settings.write'],
  };

  async function insertTenant(id: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('organizations')
      .values({
        id,
        tenant_id: tenantId,
        name,
        slug: `${id}-slug`,
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
  }

  async function insertBrand(
    id: string,
    tenantId: string,
    organizationId: string,
    name: string,
  ): Promise<void> {
    const now = new Date();
    await db
      .insertInto('brands')
      .values({
        id,
        tenant_id: tenantId,
        organization_id: organizationId,
        name,
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

  async function insertDomain(id: string, brandId: string, domain: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('brand_domains')
      .values({
        id,
        brand_id: brandId,
        domain,
        is_primary: true,
        is_verified: true,
        verification_token: `token-${id}`,
        ssl_status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function insertSenderIdentity(
    id: string,
    tenantId: string,
    brandId: string,
    email: string,
  ): Promise<void> {
    const now = new Date('2026-07-21T00:00:00.000Z');
    await db
      .insertInto('brand_sender_identities')
      .values({
        id,
        tenant_id: tenantId,
        brand_id: brandId,
        email,
        name: id,
        reply_to_email: null,
        verified: true,
        verified_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function senderIdentitySnapshot(): Promise<unknown[]> {
    return db
      .selectFrom('brand_sender_identities')
      .selectAll()
      .where('id', 'in', [senderIdentityA, senderIdentityAOther, senderIdentityCrossTenant])
      .orderBy('id', 'asc')
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'List tenant A');
    await insertTenant(tenantB, 'List tenant B');
    await insertOrganization(organizationA, tenantA, 'List organization A');
    await insertOrganization(organizationAScoped, tenantA, 'List scoped organization');
    await insertOrganization(organizationB, tenantB, 'List organization B');
    await insertBrand(brandA, tenantA, organizationA, 'List brand A');
    await insertBrand(brandAOther, tenantA, organizationA, 'List brand A other');
    await insertBrand(brandAScoped, tenantA, organizationAScoped, 'List scoped brand');
    await insertBrand(brandB, tenantB, organizationB, 'List brand B');
    await insertDomain(domainA, brandA, `allowed-${suffix}.example.test`);
    await insertDomain(domainAOther, brandAOther, `other-${suffix}.example.test`);
    await insertDomain(domainAScoped, brandAScoped, `scoped-${suffix}.example.test`);
    await insertDomain(domainB, brandB, `foreign-${suffix}.example.test`);
    await insertSenderIdentity(senderIdentityA, tenantA, brandA, `allowed-${suffix}@example.test`);
    await insertSenderIdentity(
      senderIdentityAOther,
      tenantA,
      brandAOther,
      `sibling-${suffix}@example.test`,
    );
    await insertSenderIdentity(
      senderIdentityCrossTenant,
      tenantB,
      brandA,
      `cross-tenant-${suffix}@example.test`,
    );

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(tenantRoutes);
    await app.ready();
  });

  beforeEach(() => {
    principal = basePrincipal;
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => Promise<unknown>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    try {
      if (app) await attempt(() => app.close());
    } finally {
      try {
        if (db) {
          await attempt(() =>
            db
              .deleteFrom('brand_sender_identities')
              .where('id', 'in', [senderIdentityA, senderIdentityAOther, senderIdentityCrossTenant])
              .execute(),
          );
          await attempt(() =>
            db
              .deleteFrom('brand_domains')
              .where('id', 'in', [domainA, domainAOther, domainAScoped, domainB])
              .execute(),
          );
          for (const id of [brandA, brandAOther, brandAScoped, brandB]) {
            await attempt(() => db.deleteFrom('brands').where('id', '=', id).execute());
          }
          for (const id of [organizationA, organizationAScoped, organizationB]) {
            await attempt(() => db.deleteFrom('organizations').where('id', '=', id).execute());
          }
          for (const id of [tenantA, tenantB]) {
            await attempt(() => db.deleteFrom('tenants').where('id', '=', id).execute());
          }
        }
      } finally {
        try {
          if (db) await attempt(() => db.destroy());
        } finally {
          restoreDatabaseDriver(previousDriver);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up tenant list fixtures');
    }
  });

  it('returns only explicitly scoped organizations from the principal tenant', async () => {
    const response = await app.inject({ method: 'GET', url: '/organizations' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((organization: { id: string }) => organization.id)).toEqual([
      organizationA,
    ]);
    expect(response.body).not.toContain(organizationAScoped);
    expect(response.body).not.toContain(organizationB);
  });

  it('denies organization listing without settings.write', async () => {
    principal = { ...basePrincipal, scopes: [] };

    const response = await app.inject({ method: 'GET', url: '/organizations' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(organizationA);
  });

  it('does not trust cross-tenant organization selectors', async () => {
    principal = { ...basePrincipal, organizationIds: [organizationB] };

    const response = await app.inject({ method: 'GET', url: '/organizations' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('returns only explicitly scoped brands and their matching domains', async () => {
    const response = await app.inject({ method: 'GET', url: '/brands' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((brand: { id: string }) => brand.id)).toEqual([brandA]);
    expect(response.json()[0].domains.map((domain: { id: string }) => domain.id)).toEqual([
      domainA,
    ]);
    expect(response.body).not.toContain(brandAScoped);
    expect(response.body).not.toContain(brandAOther);
    expect(response.body).not.toContain(brandB);
    expect(response.body).not.toContain(domainAScoped);
    expect(response.body).not.toContain(domainAOther);
    expect(response.body).not.toContain(domainB);
  });

  it('denies brand listing without settings.write', async () => {
    principal = { ...basePrincipal, scopes: [] };

    const response = await app.inject({ method: 'GET', url: '/brands' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(brandA);
  });

  it('denies event-scoped principals before brand or domain disclosure', async () => {
    principal = { ...basePrincipal, eventIds: [`evt_list_${suffix}`] };

    const response = await app.inject({ method: 'GET', url: '/brands' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(brandA);
    expect(response.body).not.toContain(domainA);
  });

  it('does not trust cross-tenant organization or brand selectors', async () => {
    principal = {
      ...basePrincipal,
      organizationIds: [organizationB],
      brandIds: [brandB],
    };

    const response = await app.inject({ method: 'GET', url: '/brands' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it.each([
    ['settings.write', ['settings.write']],
    ['messages.write', ['messages.write']],
  ] as const)(
    'returns only the exact tenant and brand sender identities with %s',
    async (_permission, scopes) => {
      principal = { ...basePrincipal, scopes: [...scopes] };

      const response = await app.inject({
        method: 'GET',
        url: `/brands/${brandA}/email-sender-identities`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          id: senderIdentityA,
          tenantId: tenantA,
          brandId: brandA,
          email: `allowed-${suffix}@example.test`,
          verified: true,
        }),
      ]);
      expect(response.body).not.toContain(senderIdentityAOther);
      expect(response.body).not.toContain(senderIdentityCrossTenant);
    },
  );

  it('denies sender identity reads without either allowed permission', async () => {
    principal = { ...basePrincipal, scopes: [] };
    const before = await senderIdentitySnapshot();

    const response = await app.inject({
      method: 'GET',
      url: `/brands/${brandA}/email-sender-identities`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(senderIdentityA);
    expect(await senderIdentitySnapshot()).toEqual(before);
  });

  it('denies event-scoped sender identity reads before disclosure', async () => {
    principal = { ...basePrincipal, eventIds: [`evt_list_${suffix}`] };
    const before = await senderIdentitySnapshot();

    const response = await app.inject({
      method: 'GET',
      url: `/brands/${brandA}/email-sender-identities`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.body).not.toContain(senderIdentityA);
    expect(await senderIdentitySnapshot()).toEqual(before);
  });

  it.each([
    [
      'tenant',
      () => ({ ...basePrincipal, organizationIds: [organizationB], brandIds: [brandB] }),
      () => brandB,
    ],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationAScoped] }),
      () => brandA,
    ],
    ['brand', () => ({ ...basePrincipal, brandIds: [brandAOther] }), () => brandA],
  ] as const)(
    'denies %s-scoped sender identity reads',
    async (_boundary, makePrincipal, brandId) => {
      principal = makePrincipal();
      const before = await senderIdentitySnapshot();

      const response = await app.inject({
        method: 'GET',
        url: `/brands/${brandId()}/email-sender-identities`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(response.body).not.toContain(senderIdentityA);
      expect(response.body).not.toContain(senderIdentityCrossTenant);
      expect(await senderIdentitySnapshot()).toEqual(before);
    },
  );

  it('makes unknown and foreign sender-identity resources indistinguishable', async () => {
    const before = await senderIdentitySnapshot();
    const [unknown, foreign] = await Promise.all([
      app.inject({
        method: 'GET',
        url: `/brands/brd_missing_${suffix}/email-sender-identities`,
      }),
      app.inject({
        method: 'GET',
        url: `/brands/${brandB}/email-sender-identities`,
      }),
    ]);

    expect(unknown.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(foreign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(unknown.body).not.toContain(senderIdentityA);
    expect(foreign.body).not.toContain(senderIdentityCrossTenant);
    expect(await senderIdentitySnapshot()).toEqual(before);
  });
});
