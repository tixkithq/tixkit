import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('OAuth application route authorization persistence', () => {
  let db: Database;
  let previousDriver: string | undefined;
  const suffix = Math.random().toString(16).slice(2, 10);
  const tenantId = `tnt_oa_${suffix}`;
  const otherTenantId = `tnt_oa_other_${suffix}`;
  const organizationId = `org_oa_${suffix}`;
  const siblingOrganizationId = `org_oa_sibling_${suffix}`;
  const otherOrganizationId = `org_oa_other_${suffix}`;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values([
        {
          id: tenantId,
          name: `OAuth application authorization ${suffix}`,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherTenantId,
          name: `OAuth application authorization other ${suffix}`,
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
          name: `OAuth application authorization ${suffix}`,
          slug: `oauth-application-auth-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: `OAuth application authorization sibling ${suffix}`,
          slug: `oauth-application-auth-sibling-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: otherOrganizationId,
          tenant_id: otherTenantId,
          name: `OAuth application authorization other ${suffix}`,
          slug: `oauth-application-auth-other-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db
        .deleteFrom('oauth_applications')
        .where('tenant_id', 'in', [tenantId, otherTenantId])
        .execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationId, siblingOrganizationId, otherOrganizationId])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantId, otherTenantId]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  function principal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: `usr_oa_${suffix}`,
      tenantId,
      organizationIds: [organizationId],
      scopes: ['developers.write', 'events.read'],
      ...overrides,
    };
  }

  async function routeApp(actor: Principal = principal()) {
    const app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = actor;
    });
    registerErrorHandler(app);
    await app.register(developerRoutes);
    return app;
  }

  async function seedApplication(input: {
    id: string;
    organizationId?: string;
    tenantId?: string;
  }) {
    const createdAt = new Date();
    await db
      .insertInto('oauth_applications')
      .values({
        id: input.id,
        tenant_id: input.tenantId ?? tenantId,
        organization_id: input.organizationId ?? organizationId,
        name: `Seeded ${input.id}`,
        client_id: `tk_oauth_${input.id}`,
        client_secret_hash: 'a'.repeat(64),
        redirect_uris: JSON.stringify(['https://example.com/oauth/callback']),
        scopes: JSON.stringify(['events.read']),
        subject_type: 'resource_owner',
        agent_principal_id: null,
        status: 'active',
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute();
  }

  const createPayload = (name: string, targetOrganizationId = organizationId) => ({
    organizationId: targetOrganizationId,
    name,
    redirectUris: ['https://example.com/oauth/callback'],
    scopes: ['events.read'],
  });

  it('persists no application or audit mutation for permission, policy, tenant, or organization denial', async () => {
    const localId = `oapp_oa_local_${suffix}`;
    const siblingId = `oapp_oa_sibling_${suffix}`;
    const foreignId = `oapp_oa_foreign_${suffix}`;
    await seedApplication({ id: localId });
    await seedApplication({ id: siblingId, organizationId: siblingOrganizationId });
    await seedApplication({
      id: foreignId,
      organizationId: otherOrganizationId,
      tenantId: otherTenantId,
    });
    const applicationCountBefore = await db
      .selectFrom('oauth_applications')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('id', 'in', [localId, siblingId, foreignId])
      .executeTakeFirstOrThrow();
    const auditCountBefore = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', 'in', [tenantId, otherTenantId])
      .executeTakeFirstOrThrow();
    const cases: Array<{
      actor: Principal;
      method: 'DELETE' | 'POST';
      payload?: ReturnType<typeof createPayload>;
      status: 403 | 404;
      url: string;
    }> = [
      {
        actor: principal({ scopes: ['events.read'] }),
        method: 'POST',
        payload: createPayload(`Denied permission create ${suffix}`),
        status: 403,
        url: '/oauth-applications',
      },
      {
        actor: principal({ brandIds: [`brd_oa_${suffix}`] }),
        method: 'POST',
        payload: createPayload(`Denied scoped create ${suffix}`),
        status: 403,
        url: '/oauth-applications',
      },
      {
        actor: principal({ organizationIds: [organizationId] }),
        method: 'POST',
        payload: createPayload(`Denied organization create ${suffix}`, siblingOrganizationId),
        status: 404,
        url: '/oauth-applications',
      },
      {
        actor: principal({ scopes: ['events.read'] }),
        method: 'DELETE',
        status: 403,
        url: `/oauth-applications/${localId}`,
      },
      {
        actor: principal({ eventIds: [`evt_oa_${suffix}`] }),
        method: 'DELETE',
        status: 403,
        url: `/oauth-applications/${localId}`,
      },
      {
        actor: principal({ organizationIds: [organizationId] }),
        method: 'DELETE',
        status: 404,
        url: `/oauth-applications/${siblingId}`,
      },
      {
        actor: principal(),
        method: 'DELETE',
        status: 404,
        url: `/oauth-applications/${foreignId}`,
      },
    ];

    for (const testCase of cases) {
      const app = await routeApp(testCase.actor);
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        ...(testCase.payload ? { payload: testCase.payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(testCase.status);
      expect(response.json()).toMatchObject({
        error: { code: testCase.status === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
      });
      await app.close();
    }

    expect(
      Number(
        (
          await db
            .selectFrom('oauth_applications')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('id', 'in', [localId, siblingId, foreignId])
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(Number(applicationCountBefore.count));
    expect(
      Number(
        (
          await db
            .selectFrom('audit_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', 'in', [tenantId, otherTenantId])
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(Number(auditCountBefore.count));
    const rows = await db
      .selectFrom('oauth_applications')
      .select(['id', 'status'])
      .where('id', 'in', [localId, siblingId, foreignId])
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'active')).toBe(true);
  });

  it('creates and revokes through exact scoped transactions without putting secrets in audit', async () => {
    const app = await routeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/oauth-applications',
      payload: createPayload(`Authorized lifecycle ${suffix}`),
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { clientSecret: string; id: string };
    const persisted = await db
      .selectFrom('oauth_applications')
      .selectAll()
      .where('id', '=', body.id)
      .executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      tenant_id: tenantId,
      organization_id: organizationId,
      subject_type: 'resource_owner',
      status: 'active',
    });
    expect(persisted.client_secret_hash).not.toBe(body.clientSecret);
    expect(JSON.stringify(persisted)).not.toContain(body.clientSecret);
    const createAudit = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_id', '=', body.id)
      .where('action', '=', 'oauth_app.created')
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(createAudit)).not.toContain(body.clientSecret);
    expect(JSON.stringify(createAudit)).not.toContain(persisted.client_secret_hash);

    const revoked = await app.inject({ method: 'DELETE', url: `/oauth-applications/${body.id}` });
    expect(revoked.statusCode, revoked.body).toBe(204);
    expect(
      await db
        .selectFrom('oauth_applications')
        .select('status')
        .where('id', '=', body.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked' });
    expect(
      Number(
        (
          await db
            .selectFrom('audit_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('resource_id', '=', body.id)
            .where('action', '=', 'oauth_app.revoked')
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(1);
    await app.close();
  });

  it('rolls back creation and revocation when fail-closed audit persistence fails', async () => {
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    const createName = `Audit rollback create ${suffix}`;
    const createApp = await routeApp();
    const create = await createApp.inject({
      method: 'POST',
      url: '/oauth-applications',
      payload: createPayload(createName),
    });
    expect(create.statusCode).toBe(500);
    expect(
      Number(
        (
          await db
            .selectFrom('oauth_applications')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('name', '=', createName)
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(0);
    await createApp.close();

    const revokeId = `oapp_oa_rollback_${suffix}`;
    await seedApplication({ id: revokeId });
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    const revokeApp = await routeApp();
    const revoke = await revokeApp.inject({
      method: 'DELETE',
      url: `/oauth-applications/${revokeId}`,
    });
    expect(revoke.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('oauth_applications')
        .select('status')
        .where('id', '=', revokeId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'active' });
    await revokeApp.close();
  });

  it('allows exactly one concurrent active-state revocation and one audit winner', async () => {
    const concurrentId = `oapp_oa_concurrent_${suffix}`;
    await seedApplication({ id: concurrentId });
    const app = await routeApp();
    const responses = await Promise.all([
      app.inject({ method: 'DELETE', url: `/oauth-applications/${concurrentId}` }),
      app.inject({ method: 'DELETE', url: `/oauth-applications/${concurrentId}` }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 404]);
    expect(
      await db
        .selectFrom('oauth_applications')
        .select('status')
        .where('id', '=', concurrentId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'revoked' });
    expect(
      Number(
        (
          await db
            .selectFrom('audit_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('resource_id', '=', concurrentId)
            .where('action', '=', 'oauth_app.revoked')
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(1);
    await app.close();
  });
});
