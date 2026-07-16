import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ApiKeyRepository, AuditLogRepository, createDb, type Database } from '@tixkit/db';
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
      ])
      .execute();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function routeApp() {
    const app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = {
        type: 'user',
        id: `usr_ak_${suffix}`,
        tenantId,
        organizationIds: [organizationId],
        scopes: ['developers.write', 'events.read'],
      } satisfies Principal;
    });
    registerErrorHandler(app);
    await app.register(developerRoutes);
    return app;
  }

  afterAll(async () => {
    if (db) {
      await db.deleteFrom('api_keys').where('tenant_id', 'in', [tenantId, otherTenantId]).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationId, otherOrganizationId])
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
