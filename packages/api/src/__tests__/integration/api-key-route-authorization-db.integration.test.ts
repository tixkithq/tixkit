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
import { ClerkAuthService, createAuthMiddleware } from '../../auth/clerk.js';
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
  const userId = `usr_ak_${suffix}`;

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
    await db
      .insertInto('user_profiles')
      .values({
        id: userId,
        tenant_id: tenantId,
        clerk_user_id: `clerk_${userId}`,
        email: `${userId}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organization_members')
      .values(
        [organizationId, siblingOrganizationId].map((memberOrganizationId, index) => ({
          id: `mem_ak_${index}_${suffix}`,
          tenant_id: tenantId,
          organization_id: memberOrganizationId,
          user_id: userId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    await db
      .insertInto('permission_grants')
      .values(
        [
          { permission: 'developers.write' as const, scopeId: organizationId },
          { permission: 'events.read' as const, scopeId: organizationId },
          { permission: 'events.read' as const, scopeId: siblingOrganizationId },
        ].map(({ permission, scopeId }, index) => ({
          id: `pg_ak_${index}_${suffix}`,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: userId,
          permission,
          scope_type: 'organization',
          scope_id: scopeId,
          created_at: now,
          updated_at: now,
        })),
      )
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
        id: userId,
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

  async function authenticatedRouteApp() {
    const app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('onRequest', createAuthMiddleware(new ClerkAuthService('test_secret', db)));
    registerErrorHandler(app);
    await app.register(developerRoutes);
    return app;
  }

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('idempotency_records')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db
        .deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db.deleteFrom('api_keys').where('tenant_id', 'in', [tenantId, otherTenantId]).execute();
      await db.deleteFrom('events').where('id', '=', siblingEventId).execute();
      await db.deleteFrom('brands').where('id', '=', siblingBrandId).execute();
      await db.deleteFrom('permission_grants').where('principal_id', '=', userId).execute();
      await db.deleteFrom('organization_members').where('user_id', '=', userId).execute();
      await db.deleteFrom('user_profiles').where('id', '=', userId).execute();
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

    const organizationApp = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
    });
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

  it('does not compose developers.write in one organization with unrelated grants in another', async () => {
    const siblingKey = await new ApiKeyRepository(db).create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Mixed grant sibling ${suffix}`,
      scopes: ['events.read'],
    });
    const siblingKeyId = siblingKey.record.id as string;
    const app = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
      scopes: ['developers.write', 'events.read'],
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/api-keys?organizationId=${siblingOrganizationId}`,
    });
    expect(listed.statusCode).toBe(404);

    const createdName = `Mixed grant denied ${suffix}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { 'idempotency-key': `api-key-mixed-grant-${suffix}` },
      payload: {
        organizationId: siblingOrganizationId,
        name: createdName,
        scopes: ['events.read'],
      },
    });
    expect(created.statusCode).toBe(404);

    const revoked = await app.inject({ method: 'DELETE', url: `/api-keys/${siblingKeyId}` });
    expect(revoked.statusCode).toBe(404);
    expect(
      await db
        .selectFrom('api_keys')
        .select('revoked_at')
        .where('id', '=', siblingKeyId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    expect(
      await db
        .selectFrom('api_keys')
        .select('id')
        .where('name', '=', createdName)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('resource_id', '=', siblingKeyId)
        .executeTakeFirst(),
    ).toBeUndefined();
    await app.close();
  });

  it('denies recursive lifecycle access through real API-key authentication', async () => {
    const repository = new ApiKeyRepository(db);
    const issuer = await repository.create({
      tenantId,
      organizationId,
      name: `Recursive issuer ${suffix}`,
      scopes: ['developers.write', 'events.read'],
    });
    const target = await repository.create({
      tenantId,
      organizationId,
      name: `Recursive target ${suffix}`,
      scopes: ['events.read'],
    });
    const targetId = target.record.id as string;
    const issuerId = issuer.record.id as string;
    const app = await authenticatedRouteApp();
    const authorization = { authorization: `Bearer ${issuer.apiKey}` };

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api-keys', headers: authorization }),
      app.inject({
        method: 'POST',
        url: '/api-keys',
        headers: {
          ...authorization,
          'idempotency-key': `api-key-recursive-auth-${suffix}`,
        },
        payload: {
          organizationId,
          name: `Recursive denied ${suffix}`,
          scopes: ['events.read'],
        },
      }),
      app.inject({ method: 'DELETE', url: `/api-keys/${targetId}`, headers: authorization }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403]);
    expect(
      await db
        .selectFrom('api_keys')
        .select('revoked_at')
        .where('id', '=', targetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    expect(
      await db
        .selectFrom('api_keys')
        .select('id')
        .where('name', '=', `Recursive denied ${suffix}`)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(
      await db
        .selectFrom('idempotency_records')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('key', 'like', 'api-key:create:%')
        .execute(),
    ).toEqual([]);

    await repository.revokeScoped({ id: issuerId, tenantId, organizationId });
    const revoked = await app.inject({ method: 'GET', url: '/api-keys', headers: authorization });
    expect(revoked.statusCode).toBe(401);
    const expired = await repository.create({
      tenantId,
      organizationId,
      name: `Expired recursive issuer ${suffix}`,
      scopes: ['developers.write'],
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const expiredResponse = await app.inject({
      method: 'GET',
      url: '/api-keys',
      headers: { authorization: `Bearer ${expired.apiKey}` },
    });
    expect(expiredResponse.statusCode).toBe(401);
    await app.close();
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
        headers: { 'idempotency-key': `api-key-denial-${testCase.label}-${suffix}` },
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
        principal: { tenantId: otherTenantId, organizationIds: [otherOrganizationId] },
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

  it('denies stale brand-bound keys after a concurrent organization reassignment', async () => {
    const { record } = await new ApiKeyRepository(db).create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Moved brand key ${suffix}`,
      scopes: ['events.read'],
      brandIds: [siblingBrandId],
    });
    const keyId = record.id as string;
    await db
      .updateTable('permission_grants')
      .set({ scope_type: 'brand', scope_id: siblingBrandId, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', userId)
      .where('permission', '=', 'developers.write')
      .execute();
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
    const app = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
      brandIds: [siblingBrandId],
    });
    const request = app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });
    release.resolve();
    await mutation;
    const response = await request;

    expect(response.statusCode).toBe(404);
    expect(
      await db
        .selectFrom('api_keys')
        .select('revoked_at')
        .where('id', '=', keyId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ revoked_at: null });
    await db
      .updateTable('brands')
      .set({ organization_id: siblingOrganizationId, updated_at: new Date() })
      .where('id', '=', siblingBrandId)
      .execute();
    await db
      .updateTable('permission_grants')
      .set({ scope_type: 'organization', scope_id: organizationId, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', userId)
      .where('permission', '=', 'developers.write')
      .execute();
    await app.close();
  });

  it('denies stale event-bound keys after the event changes organization', async () => {
    const { record } = await new ApiKeyRepository(db).create({
      tenantId,
      organizationId: siblingOrganizationId,
      name: `Moved event key ${suffix}`,
      scopes: ['events.read'],
      eventIds: [siblingEventId],
    });
    const keyId = record.id as string;
    await db
      .updateTable('permission_grants')
      .set({ scope_type: 'brand', scope_id: siblingBrandId, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', userId)
      .where('permission', '=', 'developers.write')
      .execute();
    await db
      .updateTable('events')
      .set({ organization_id: organizationId, updated_at: new Date() })
      .where('id', '=', siblingEventId)
      .execute();
    const app = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
      brandIds: [siblingBrandId],
    });
    try {
      const listed = await app.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${siblingOrganizationId}`,
      });
      expect(listed.statusCode).toBe(200);
      expect(
        (listed.json() as { items: Array<{ id: string }> }).items.map((item) => item.id),
      ).not.toContain(keyId);
      const revoked = await app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });
      expect(revoked.statusCode).toBe(404);
      expect(
        await db
          .selectFrom('api_keys')
          .select('revoked_at')
          .where('id', '=', keyId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ revoked_at: null });
    } finally {
      await app.close();
      await db
        .updateTable('events')
        .set({ organization_id: siblingOrganizationId, updated_at: new Date() })
        .where('id', '=', siblingEventId)
        .execute();
      await db
        .updateTable('permission_grants')
        .set({ scope_type: 'organization', scope_id: organizationId, updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', userId)
        .where('permission', '=', 'developers.write')
        .execute();
    }
  });

  it('creates exactly one key for concurrent retries without persisting the one-time secret', async () => {
    const app = await routeApp();
    const name = `Idempotent create ${suffix}`;
    const request = {
      method: 'POST' as const,
      url: '/api-keys',
      headers: { 'idempotency-key': `api-key-concurrent-create-${suffix}` },
      payload: { organizationId, name, scopes: ['events.read'] },
    };

    const responses = await Promise.all([app.inject(request), app.inject(request)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const created = responses.find((response) => response.statusCode === 201)!;
    const replay = responses.find((response) => response.statusCode === 409)!;
    const rawSecret = created.json().apiKey as string;
    const apiKeyId = created.json().id as string;
    expect(rawSecret).toMatch(/^tk_[a-f0-9]{64}$/u);
    expect(replay.json()).toMatchObject({
      error: {
        code: 'API_KEY_SECRET_NOT_REPLAYABLE',
        details: { apiKeyId },
      },
    });
    expect(replay.body).not.toContain(rawSecret);
    const changed = await app.inject({
      ...request,
      payload: { ...request.payload, name: `${name} changed` },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(changed.json().error.details).not.toHaveProperty('apiKeyId');

    const persisted = await db
      .selectFrom('api_keys')
      .selectAll()
      .where('name', '=', name)
      .execute();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.hashed_key).toBe(createHash('sha256').update(rawSecret).digest('hex'));
    expect(JSON.stringify(persisted)).not.toContain(rawSecret);
    const auditRows = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', '=', apiKeyId)
      .where('action', '=', 'api_key.created')
      .execute();
    expect(auditRows).toHaveLength(1);
    expect(JSON.stringify(auditRows)).not.toContain(rawSecret);
    const idempotencyRows = await db
      .selectFrom('idempotency_records')
      .select(['response_status', 'response_body'])
      .where('tenant_id', '=', tenantId)
      .where('key', 'like', 'api-key:create:%')
      .execute();
    expect(idempotencyRows.some((row) => row.response_status === 409)).toBe(true);
    expect(JSON.stringify(idempotencyRows)).not.toContain(rawSecret);
    await app.close();
  });

  it('returns a continuation when scoped filtering reaches its raw scan budget', async () => {
    const prefix = `key_!page_${suffix}_`;
    const now = new Date('2026-07-20T15:00:00.000Z');
    const rows = Array.from({ length: 501 }, (_, index) => {
      const id = `${prefix}${String(index).padStart(4, '0')}`;
      return {
        id,
        tenant_id: tenantId,
        organization_id: siblingOrganizationId,
        name: `Unscoped pagination ${index}`,
        key_prefix: `tk_pg_${String(index).padStart(6, '0')}`,
        hashed_key: createHash('sha256').update(id).digest('hex'),
        scopes: JSON.stringify(['events.read']),
        brand_ids: null as string | null,
        event_ids: null,
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        created_at: now,
        updated_at: now,
      };
    });
    const authorizedId = `${prefix}zzzz`;
    rows.push({
      ...rows[0]!,
      id: authorizedId,
      name: 'Authorized pagination result',
      key_prefix: 'tk_pg_allowed',
      hashed_key: createHash('sha256').update(authorizedId).digest('hex'),
      brand_ids: JSON.stringify([siblingBrandId]),
    });
    await db.insertInto('api_keys').values(rows).execute();
    await db
      .updateTable('permission_grants')
      .set({ scope_type: 'brand', scope_id: siblingBrandId, updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', userId)
      .where('permission', '=', 'developers.write')
      .execute();

    const app = await routeApp({
      organizationIds: [organizationId, siblingOrganizationId],
      brandIds: [siblingBrandId],
    });
    try {
      const first = await app.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${siblingOrganizationId}&limit=50`,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ items: [], hasMore: true });
      const opaqueCursor = first.json().nextCursor as string;
      expect(opaqueCursor).toMatch(/^aksc1\./u);
      expect(opaqueCursor).not.toContain(`${prefix}0499`);
      expect(first.body).not.toContain(`${prefix}0499`);
      const tamperedParts = opaqueCursor.split('.');
      const encryptedPart = tamperedParts[2]!;
      tamperedParts[2] = `${encryptedPart.startsWith('a') ? 'b' : 'a'}${encryptedPart.slice(1)}`;
      const tamperedCursor = tamperedParts.join('.');

      const tampered = await app.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${siblingOrganizationId}&limit=50&cursor=${tamperedCursor}`,
      });
      expect(tampered.statusCode).toBe(400);
      const rebound = await app.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${organizationId}&limit=50&cursor=${opaqueCursor}`,
      });
      expect(rebound.statusCode).toBe(400);
      const foreignApp = await routeApp({
        tenantId: otherTenantId,
        organizationIds: [otherOrganizationId],
      });
      const crossTenant = await foreignApp.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${siblingOrganizationId}&limit=50&cursor=${opaqueCursor}`,
      });
      expect(crossTenant.statusCode).toBe(400);
      await foreignApp.close();

      const second = await app.inject({
        method: 'GET',
        url: `/api-keys?organizationId=${siblingOrganizationId}&limit=50&cursor=${opaqueCursor}`,
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toMatchObject({ hasMore: false, nextCursor: null });
      const secondIds = second.json().items.map((item: { id: string }) => item.id) as string[];
      expect(secondIds).toContain(authorizedId);
      expect(secondIds.filter((id) => id.startsWith(prefix))).toEqual([authorizedId]);
    } finally {
      await app.close();
      await db
        .updateTable('permission_grants')
        .set({ scope_type: 'organization', scope_id: organizationId, updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', userId)
        .where('permission', '=', 'developers.write')
        .execute();
    }
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
      headers: { 'idempotency-key': `api-key-brand-move-${suffix}` },
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
      headers: { 'idempotency-key': `api-key-audit-rollback-${suffix}` },
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
