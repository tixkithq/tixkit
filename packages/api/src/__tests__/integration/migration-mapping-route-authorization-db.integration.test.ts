import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { MIGRATION_MAPPING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration mapping write authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mmap_${suffix}`;
  const tenantA = `tnt_mmap_a_${suffix}`;
  const tenantB = `tnt_mmap_b_${suffix}`;
  const organizationA = `org_mmap_a_${suffix}`;
  const organizationAScoped = `org_mmap_scope_${suffix}`;
  const organizationB = `org_mmap_b_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    scopes: ['migrations.write'],
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

  function requestBody(organizationId: string, name: string) {
    return {
      organizationId,
      sourceSystem: 'generic-csv',
      name,
      entityType: 'event',
      mapping: { title: 'source.title', tags: ['source.category', 'source.genre'] },
    };
  }

  async function snapshot() {
    const mappings = await db
      .selectFrom('import_mappings')
      .selectAll()
      .where('created_by', '=', actorId)
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'migration_mapping.created')
      .orderBy('id')
      .execute();
    return { mappings, audits };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration mapping tenant A');
    await insertTenant(tenantB, 'Migration mapping tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration mapping organization A');
    await insertOrganization(organizationAScoped, tenantA, 'Migration mapping scoped organization');
    await insertOrganization(organizationB, tenantB, 'Migration mapping organization B');

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    await app.ready();
  });

  beforeEach(() => {
    principal = basePrincipal;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('actor_id', '=', actorId)
        .where('action', '=', 'migration_mapping.created')
        .execute();
      await db.deleteFrom('import_mappings').where('created_by', '=', actorId).execute();
      for (const id of [organizationA, organizationAScoped, organizationB]) {
        await db.deleteFrom('organizations').where('id', '=', id).execute();
      }
      for (const id of [tenantA, tenantB]) {
        await db.deleteFrom('tenants').where('id', '=', id).execute();
      }
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('creates the exact authorized mapping and audit atomically', async () => {
    const contract = MIGRATION_MAPPING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const before = await snapshot();

    const response = await app.inject({
      method: contract.method,
      url: contract.path,
      payload: requestBody(organizationA, `Authorized ${suffix}`),
    });

    expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
    expect(response.json()).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      source_system: 'generic-csv',
      entity_type: 'event',
      mapping: { title: 'source.title', tags: ['source.category', 'source.genre'] },
      created_by: actorId,
    });
    const after = await snapshot();
    expect(after.mappings).toHaveLength(before.mappings.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.audits.at(-1)).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_type: 'user',
      actor_id: actorId,
      action: 'migration_mapping.created',
      resource_type: 'MigrationMapping',
      resource_id: response.json<{ id: string }>().id,
    });
  });

  it('rolls mapping persistence back when the required audit fails', async () => {
    const before = await snapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/migration-mappings',
      payload: requestBody(organizationA, `Audit failure ${suffix}`),
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it('denies every mapping-write boundary without persistence or audit effects', async () => {
    const contract = MIGRATION_MAPPING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const cases: Array<{
      principal: Principal;
      organizationId: string;
      status: 403 | 404;
      code: 'FORBIDDEN' | 'NOT_FOUND';
    }> = [
      {
        principal: { ...basePrincipal, scopes: ['migrations.read'] },
        organizationId: organizationA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, brandIds: [`brd_mmap_${suffix}`] },
        organizationId: organizationA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mmap_${suffix}`] },
        organizationId: organizationA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: basePrincipal,
        organizationId: organizationAScoped,
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        principal: basePrincipal,
        organizationId: organizationB,
        status: 404,
        code: 'NOT_FOUND',
      },
    ];

    for (const [index, denial] of cases.entries()) {
      principal = denial.principal;
      const before = await snapshot();

      const response = await app.inject({
        method: contract.method,
        url: contract.path,
        payload: requestBody(denial.organizationId, `Denied ${index} ${suffix}`),
      });

      expect(response.statusCode, response.body).toBe(denial.status);
      expect(response.json()).toMatchObject({ error: { code: denial.code } });
      expect(response.body).not.toContain(tenantA);
      expect(response.body).not.toContain(tenantB);
      expect(await snapshot()).toEqual(before);
    }
  });
});
