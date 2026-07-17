import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  ApiKeyRepository,
  AuditLogRepository,
  BrandRepository,
  createDb,
  EventRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('API key route authorization persistence', () => {
  let db: Database;
  let previousDriver: string | undefined;
  const suffix = Math.random().toString(16).slice(2, 10);
  const tenantId = `tnt_ak_${suffix}`;
  const otherTenantId = `tnt_ak_other_${suffix}`;
  const organizationId = `org_ak_${suffix}`;
  const otherOrganizationId = `org_ak_other_${suffix}`;
  const siblingOrganizationId = `org_ak_sibling_${suffix}`;
  let siblingBrandId: string;
  let siblingEventId: string;

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values([
        {
          id: tenantId,
          name: `API key authorization ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherTenantId,
          name: `API key authorization other ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organizations')
      .values([
        {
          id: organizationId,
          tenant_id: tenantId,
          name: `API key authorization ${suffix}`,
          slug: `api-key-auth-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherOrganizationId,
          tenant_id: otherTenantId,
          name: `API key authorization other ${suffix}`,
          slug: `api-key-auth-other-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: `API key authorization sibling ${suffix}`,
          slug: `api-key-auth-sibling-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    siblingBrandId = (
      await new BrandRepository(db).create({
        tenantId,
        organizationId: siblingOrganizationId,
        name: `API key sibling brand ${suffix}`,
        slug: `api-key-sibling-${suffix}`,
      })
    ).id;
    siblingEventId = (
      await new EventRepository(db).create({
        tenantId,
        organizationId: siblingOrganizationId,
        brandId: siblingBrandId,
        slug: `api-key-sibling-event-${suffix}`,
        title: `API key sibling event ${suffix}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-02T18:00:00.000Z'),
        endsAt: new Date('2027-01-02T22:00:00.000Z'),
        venue: { name: 'API key authorization hall' },
      })
    ).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function routeApp(principalOverrides: Partial<Principal> = {}) {
    const app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = {
        type: 'user',
        id: `usr_ak_${suffix}`,
        tenantId,
        organizationIds: [organizationId],
        scopes: ['developers.write', 'events.read'],
        ...principalOverrides,
      } satisfies Principal;
    });
    registerErrorHandler(app);
    await app.register(developerRoutes);
    return app;
  }

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db.deleteFrom('api_keys').where('tenant_id', 'in', [tenantId, otherTenantId]).execute();
      await db.deleteFrom('events').where('id', '=', siblingEventId).execute();
      await db.deleteFrom('brands').where('id', '=', siblingBrandId).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationId, otherOrganizationId, siblingOrganizationId])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantId, otherTenantId]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('binds creation and active revocation to the exact tenant and organization', async () => {
    const repository = new ApiKeyRepository(db);
    const { apiKey, record } = await repository.create({
      tenantId,
      organizationId,
      name: 'Authorization proof',
      scopes: ['events.read'],
    });
    const id = record.id as string;
    const persisted = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(persisted).toMatchObject({
      id,
      tenant_id: tenantId,
      organization_id: organizationId,
      revoked_at: null,
    });
    expect(persisted.hashed_key).toBe(createHash('sha256').update(apiKey).digest('hex'));
    expect(JSON.stringify(persisted)).not.toContain(apiKey);

    await expect(
      repository.revokeScoped({ id, tenantId: otherTenantId, organizationId }),
    ).resolves.toBe(0);
    await expect(
      repository.revokeScoped({ id, tenantId, organizationId: otherOrganizationId }),
    ).resolves.toBe(0);
    expect(
      await db.selectFrom('api_keys').select('revoked_at').where('id', '=', id).executeTakeFirst(),
    ).toEqual({ revoked_at: null });

    await expect(repository.revokeScoped({ id, tenantId, organizationId })).resolves.toBe(1);
    await expect(repository.revokeScoped({ id, tenantId, organizationId })).resolves.toBe(0);
    expect(
      await db.selectFrom('api_keys').select('revoked_at').where('id', '=', id).executeTakeFirst(),
    ).toEqual({ revoked_at: expect.any(Date) });
  });

  it('lists only authorized organization keys and denies permission or organization drift', async () => {
    const repository = new ApiKeyRepository(db);
    const authorized = await repository.create({
      tenantId,
      organizationId,
      name: `Authorized list ${suffix}`,
      scopes: ['events.read'],
    });
    const sibling = await repository.create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Sibling list ${suffix}`,
      scopes: ['events.read'],
    });
    const foreign = await repository.create({
      tenantId: otherTenantId,
      organizationId: otherOrganizationId,
      name: `Foreign list ${suffix}`,
      scopes: ['events.read'],
    });
    const ids = [authorized.record.id, sibling.record.id, foreign.record.id] as string[];
    const rowsBefore = await db
      .selectFrom('api_keys')
      .select(['id', 'tenant_id', 'organization_id', 'revoked_at'])
      .where('id', 'in', ids)
      .orderBy('id', 'asc')
      .execute();

    const authorizedApp = await routeApp();
    const authorizedResponse = await authorizedApp.inject({
      method: 'GET',
      url: `/api-keys?organizationId=${organizationId}`,
    });
    expect(authorizedResponse.statusCode).toBe(200);
    const authorizedItems = authorizedResponse.json().items as Array<{
      id: string;
      organizationId: string;
    }>;
    expect(authorizedItems).toContainEqual(
      expect.objectContaining({ id: authorized.record.id, organizationId }),
    );
    expect(authorizedItems.map((item) => item.id)).not.toContain(sibling.record.id);
    expect(authorizedItems.map((item) => item.id)).not.toContain(foreign.record.id);
    expect(authorizedItems.every((item) => item.organizationId === organizationId)).toBe(true);
    expect(authorizedResponse.body).not.toContain('hashed_key');
    expect(authorizedResponse.body).not.toContain(authorized.apiKey);
    expect(authorizedResponse.body).not.toContain(sibling.apiKey);
    expect(authorizedResponse.body).not.toContain(foreign.apiKey);
    await authorizedApp.close();

    const permissionApp = await routeApp({ scopes: ['events.read'] });
    const permissionResponse = await permissionApp.inject({ method: 'GET', url: '/api-keys' });
    expect(permissionResponse.statusCode).toBe(403);
    expect(permissionResponse.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await permissionApp.close();

    const organizationApp = await routeApp();
    const organizationResponse = await organizationApp.inject({
      method: 'GET',
      url: `/api-keys?organizationId=${siblingOrganizationId}`,
    });
    expect(organizationResponse.statusCode).toBe(404);
    expect(organizationResponse.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await organizationApp.close();

    expect(
      await db
        .selectFrom('api_keys')
        .select(['id', 'tenant_id', 'organization_id', 'revoked_at'])
        .where('id', 'in', ids)
        .orderBy('id', 'asc')
        .execute(),
    ).toEqual(rowsBefore);
  });

  it('persists no key or audit mutation for every declared HTTP denial boundary', async () => {
    const repository = new ApiKeyRepository(db);
    const primaryKey = await repository.create({
      tenantId,
      organizationId,
      name: `Denied revoke primary ${suffix}`,
      scopes: ['events.read'],
    });
    const brandKey = await repository.create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Denied revoke brand ${suffix}`,
      scopes: ['events.read'],
      brandIds: [siblingBrandId],
    });
    const eventKey = await repository.create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Denied revoke event ${suffix}`,
      scopes: ['events.read'],
      eventIds: [siblingEventId],
    });
    const primaryRecord = primaryKey.record as { id: string };
    const brandRecord = brandKey.record as { id: string };
    const eventRecord = eventKey.record as { id: string };
    const createCases: Array<{
      expectedStatus: number;
      label: string;
      payload: {
        brandIds?: string[];
        eventIds?: string[];
        name: string;
        organizationId: string;
        scopes: ['events.read'];
      };
      principal: Partial<Principal>;
    }> = [
      {
        expectedStatus: 403,
        label: 'permission',
        payload: {
          organizationId,
          name: `Denied create permission ${suffix}`,
          scopes: ['events.read'],
        },
        principal: { scopes: ['events.read'] },
      },
      {
        expectedStatus: 404,
        label: 'organization',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create organization ${suffix}`,
          scopes: ['events.read'],
        },
        principal: {},
      },
      {
        expectedStatus: 404,
        label: 'brand',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create brand ${suffix}`,
          scopes: ['events.read'],
          brandIds: [siblingBrandId],
        },
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          brandIds: [`brand_unrelated_${suffix}`],
        },
      },
      {
        expectedStatus: 404,
        label: 'event',
        payload: {
          organizationId: siblingOrganizationId,
          name: `Denied create event ${suffix}`,
          scopes: ['events.read'],
          eventIds: [siblingEventId],
        },
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          eventIds: [`event_unrelated_${suffix}`],
        },
      },
    ];
    const keyCountBefore = await db
      .selectFrom('api_keys')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const auditCountBefore = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', 'in', [tenantId, otherTenantId])
      .executeTakeFirstOrThrow();

    for (const testCase of createCases) {
      const app = await routeApp(testCase.principal);
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        payload: testCase.payload,
      });
      expect(response.statusCode, `${testCase.label}: ${response.body}`).toBe(
        testCase.expectedStatus,
      );
      await app.close();
    }

    const revokeCases: Array<{
      expectedStatus: number;
      keyId: string;
      label: string;
      principal: Partial<Principal>;
    }> = [
      {
        expectedStatus: 403,
        keyId: primaryRecord.id,
        label: 'permission',
        principal: { scopes: ['events.read'] },
      },
      {
        expectedStatus: 404,
        keyId: primaryRecord.id,
        label: 'tenant',
        principal: { type: 'system', tenantId: otherTenantId, organizationIds: [] },
      },
      {
        expectedStatus: 404,
        keyId: primaryRecord.id,
        label: 'organization',
        principal: { organizationIds: [siblingOrganizationId] },
      },
      {
        expectedStatus: 404,
        keyId: brandRecord.id,
        label: 'brand',
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          brandIds: [`brand_unrelated_${suffix}`],
        },
      },
      {
        expectedStatus: 404,
        keyId: eventRecord.id,
        label: 'event',
        principal: {
          organizationIds: [organizationId, siblingOrganizationId],
          eventIds: [`event_unrelated_${suffix}`],
        },
      },
    ];

    for (const testCase of revokeCases) {
      const app = await routeApp(testCase.principal);
      const response = await app.inject({ method: 'DELETE', url: `/api-keys/${testCase.keyId}` });
      expect(response.statusCode, `${testCase.label}: ${response.body}`).toBe(
        testCase.expectedStatus,
      );
      await app.close();
    }

    const keyCountAfter = await db
      .selectFrom('api_keys')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const auditCountAfter = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', 'in', [tenantId, otherTenantId])
      .executeTakeFirstOrThrow();
    expect(Number(keyCountAfter.count)).toBe(Number(keyCountBefore.count));
    expect(Number(auditCountAfter.count)).toBe(Number(auditCountBefore.count));
    const persistedKeys = await db
      .selectFrom('api_keys')
      .select(['id', 'revoked_at'])
      .where('id', 'in', [primaryRecord.id, brandRecord.id, eventRecord.id])
      .orderBy('id', 'asc')
      .execute();
    expect(persistedKeys).toHaveLength(3);
    expect(persistedKeys.every((key) => key.revoked_at === null)).toBe(true);
  });

  it('allows exactly one concurrent HTTP revocation and writes exactly one audit record', async () => {
    const { record } = await new ApiKeyRepository(db).create({
      tenantId,
      organizationId,
      name: `Concurrent revoke ${suffix}`,
      scopes: ['events.read'],
    });
    const persisted = record as { id: string };
    const app = await routeApp();

    const responses = await Promise.all([
      app.inject({ method: 'DELETE', url: `/api-keys/${persisted.id}` }),
      app.inject({ method: 'DELETE', url: `/api-keys/${persisted.id}` }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 404]);
    expect(
      await db
        .selectFrom('api_keys')
        .select('revoked_at')
        .where('id', '=', persisted.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: expect.any(Date) });
    const revokeAuditCount = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('resource_id', '=', persisted.id)
      .where('action', '=', 'api_key.revoked')
      .executeTakeFirstOrThrow();
    expect(Number(revokeAuditCount.count)).toBe(1);
    await app.close();
  });

  it('revalidates the exact brand organization after a concurrent committed change', async () => {
    const locked = deferred();
    const release = deferred();
    const mutation = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('brands')
        .select('id')
        .where('id', '=', siblingBrandId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
      await transaction
        .updateTable('brands')
        .set({ organization_id: organizationId, updated_at: new Date() })
        .where('id', '=', siblingBrandId)
        .execute();
    });
    await locked.promise;
    const app = await routeApp({ organizationIds: [organizationId, siblingOrganizationId] });
    const name = `Concurrent brand move ${suffix}`;
    const request = app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: {
        organizationId: siblingOrganizationId,
        name,
        scopes: ['events.read'],
        brandIds: [siblingBrandId],
      },
    });
    release.resolve();
    await mutation;
    const response = await request;

    expect(response.statusCode).toBe(404);
    expect(
      await db.selectFrom('api_keys').select('id').where('name', '=', name).executeTakeFirst(),
    ).toBeUndefined();
    await db
      .updateTable('brands')
      .set({ organization_id: siblingOrganizationId, updated_at: new Date() })
      .where('id', '=', siblingBrandId)
      .execute();
    await app.close();
  });

  it('rolls back creation when the required audit insert fails', async () => {
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    const app = await routeApp();
    const name = `Audit rollback create ${suffix}`;
    const response = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: { organizationId, name, scopes: ['events.read'] },
    });

    expect(response.statusCode).toBe(500);
    const remaining = await db
      .selectFrom('api_keys')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('name', '=', name)
      .executeTakeFirstOrThrow();
    expect(Number(remaining.count)).toBe(0);
    await app.close();
  });

  it('rolls back revocation when the required audit insert fails', async () => {
    const repository = new ApiKeyRepository(db);
    const { record } = await repository.create({
      tenantId,
      organizationId,
      name: `Audit rollback revoke ${suffix}`,
      scopes: ['events.read'],
    });
    const id = record.id as string;
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    const app = await routeApp();
    const response = await app.inject({ method: 'DELETE', url: `/api-keys/${id}` });

    expect(response.statusCode).toBe(500);
    expect(
      await db.selectFrom('api_keys').select('revoked_at').where('id', '=', id).executeTakeFirst(),
    ).toEqual({ revoked_at: null });
    await app.close();
  });
});
