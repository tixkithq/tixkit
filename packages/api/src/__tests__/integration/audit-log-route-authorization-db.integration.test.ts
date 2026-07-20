import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { privacyRoutes } from '../../routes/modules/privacy.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('audit log route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_audit_a_${suffix}`;
  const tenantB = `tnt_audit_b_${suffix}`;
  const organizationA = `org_audit_a_${suffix}`;
  const organizationAScoped = `org_audit_scope_${suffix}`;
  const organizationB = `org_audit_b_${suffix}`;
  const brandA = `brd_audit_a_${suffix}`;
  const brandAOther = `brd_audit_other_${suffix}`;
  const brandAScoped = `brd_audit_scope_${suffix}`;
  const brandB = `brd_audit_b_${suffix}`;
  const auditOrg = `audit_org_${suffix}`;
  const auditBrand = `audit_brand_${suffix}`;
  const auditBrandOther = `audit_brand_other_${suffix}`;
  const auditScoped = `audit_scope_${suffix}`;
  const auditForeign = `audit_foreign_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_audit_${suffix}`,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    brandIds: [],
    scopes: ['settings.write'],
  };

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

  async function insertBrand(id: string, tenantId: string, organizationId: string): Promise<void> {
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

  async function insertAudit(
    id: string,
    tenantId: string,
    organizationId: string,
    brandId: string | null,
    createdAt: Date,
  ): Promise<void> {
    await db
      .insertInto('audit_logs')
      .values({
        id,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        actor_type: 'user',
        actor_id: `actor_${id}`,
        action: id === auditBrand ? 'event.updated' : 'privacy.export.requested',
        resource_type: 'AuthorizationFixture',
        resource_id: id,
        diff_summary: JSON.stringify({ marker: id }),
        request_id: `request_${id}`,
        ip: '192.0.2.1',
        user_agent: `fixture/${id}`,
        created_at: createdAt,
      })
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertOrganization(organizationA, tenantA);
    await insertOrganization(organizationAScoped, tenantA);
    await insertOrganization(organizationB, tenantB);
    await insertBrand(brandA, tenantA, organizationA);
    await insertBrand(brandAOther, tenantA, organizationA);
    await insertBrand(brandAScoped, tenantA, organizationAScoped);
    await insertBrand(brandB, tenantB, organizationB);
    await insertAudit(auditOrg, tenantA, organizationA, null, new Date('2026-07-20T10:00:00Z'));
    await insertAudit(auditBrand, tenantA, organizationA, brandA, new Date('2026-07-20T11:00:00Z'));
    await insertAudit(
      auditBrandOther,
      tenantA,
      organizationA,
      brandAOther,
      new Date('2026-07-20T12:00:00Z'),
    );
    await insertAudit(
      auditScoped,
      tenantA,
      organizationAScoped,
      brandAScoped,
      new Date('2026-07-20T13:00:00Z'),
    );
    await insertAudit(
      auditForeign,
      tenantB,
      organizationB,
      brandB,
      new Date('2026-07-20T14:00:00Z'),
    );

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(privacyRoutes);
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
          .deleteFrom('audit_logs')
          .where('id', 'in', [auditOrg, auditBrand, auditBrandOther, auditScoped, auditForeign])
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
      await attempt(() => db.destroy());
    }
    restoreDatabaseDriver(previousDriver);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean audit fixtures');
  });

  it('returns only the principal tenant and organization rows for an organization-wide principal', async () => {
    const response = await app.inject({ method: 'GET', url: '/audit-logs?includeTotal=true' });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([
      auditBrandOther,
      auditBrand,
      auditOrg,
    ]);
    expect(body.total).toBe(3);
    expect(response.body).not.toContain(auditScoped);
    expect(response.body).not.toContain(auditForeign);
  });

  it('restricts brand principals to exact brand rows and excludes organization-wide rows', async () => {
    principal = { ...basePrincipal, brandIds: [brandA, brandB] };
    const response = await app.inject({ method: 'GET', url: '/audit-logs?includeTotal=true' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([auditBrand]);
    expect(response.json().total).toBe(1);
    expect(response.body).not.toContain(auditOrg);
    expect(response.body).not.toContain(auditForeign);
  });

  it('returns an empty page for a cross-tenant selector without disclosing the foreign row', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/audit-logs?organizationId=${organizationB}&brandId=${brandB}&includeTotal=true`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual([]);
    expect(response.json().total).toBe(0);
    expect(response.body).not.toContain(auditForeign);
  });

  it('denies missing permission and event-scoped principals before reading audit rows', async () => {
    for (const deniedPrincipal of [
      { ...basePrincipal, scopes: [] },
      { ...basePrincipal, eventIds: [`evt_audit_${suffix}`] },
    ]) {
      principal = deniedPrincipal;
      const response = await app.inject({ method: 'GET', url: '/audit-logs' });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(response.body).not.toContain(auditBrand);
    }
  });

  it('conceals same-tenant organizations and brands outside the principal scope', async () => {
    for (const url of [
      `/audit-logs?organizationId=${organizationAScoped}`,
      `/audit-logs?brandId=${brandAOther}`,
    ]) {
      principal = { ...basePrincipal, brandIds: [brandA] };
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(response.body).not.toContain(`actor_${auditScoped}`);
      expect(response.body).not.toContain(auditBrandOther);
    }
  });

  it('keeps cursor pages, facets, totals and filters inside the authorized scope', async () => {
    const firstPage = await app.inject({
      method: 'GET',
      url: '/audit-logs?sort=createdAt:asc&limit=1&includeTotal=true&includeFacets=true',
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    expect(firstPage.json().total).toBe(3);
    const actionRows = firstPage.json().facets.action.rows as Array<{
      total: number;
      value: string;
    }>;
    expect(actionRows).toEqual(
      expect.arrayContaining([
        { value: 'event.updated', total: 1 },
        { value: 'privacy.export.requested', total: 2 },
      ]),
    );
    expect(firstPage.body).not.toContain(auditForeign);
    expect(firstPage.body).not.toContain(auditScoped);

    const secondPage = await app.inject({
      method: 'GET',
      url: `/audit-logs?sort=createdAt:asc&limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json().items).toHaveLength(1);
    expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
    expect(secondPage.body).not.toContain(auditForeign);
    expect(secondPage.body).not.toContain(auditScoped);

    const filtered = await app.inject({
      method: 'GET',
      url: `/audit-logs?action=event.updated&sort=createdAt:asc&limit=1&includeTotal=true&includeFacets=true`,
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((item: { id: string }) => item.id)).toEqual([auditBrand]);
    expect(filtered.json().total).toBe(3);
    expect(filtered.json().filterTotal).toBe(1);
    expect(filtered.body).not.toContain(auditForeign);
  });

  it('rejects unknown and unsortable table parameters and treats SQL-shaped actions as data', async () => {
    for (const url of ['/audit-logs?unknown=1', '/audit-logs?sort=actorId:asc']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).not.toContain(auditBrand);
    }
    const hostile = await app.inject({
      method: 'GET',
      url: `/audit-logs?action=${encodeURIComponent("' OR 1=1 --")}&includeTotal=true`,
    });
    expect(hostile.statusCode, hostile.body).toBe(200);
    expect(hostile.json().items).toEqual([]);
    expect(hostile.json().total).toBe(3);
    expect(hostile.json().filterTotal).toBe(0);
  });
});
