import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, ImportRepository, type Database } from '@tixkit/db';
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
import {
  MIGRATION_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  MIGRATION_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  PORTABLE_REBINDING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
} from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration job read route authorization matrix', () => {
  let app: FastifyInstance;
  let connectionDb: Database;
  let db: Database;
  let rollbackTransaction: (() => Promise<void>) | undefined;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_mread_a_${suffix}`;
  const tenantB = `tnt_mread_b_${suffix}`;
  const organizationA = `org_mread_a_${suffix}`;
  const organizationAScoped = `org_mread_scope_${suffix}`;
  const organizationB = `org_mread_b_${suffix}`;
  let jobA: string;
  let jobAScoped: string;
  let jobB: string;
  let mappingA: string;
  let mappingAScoped: string;
  let mappingB: string;
  let portableJobA: string;
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_mread_${suffix}`,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    scopes: ['migrations.read'],
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

  async function createJob(
    tenantId: string,
    organizationId: string,
    label: string,
  ): Promise<string> {
    const job = await new ImportRepository(db).createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: 'rfc4180-v1',
      mode: 'dry-run',
      idempotencyKey: `mread-${label}-${suffix}`,
      requestedBy: basePrincipal.id,
      configuration: { label },
    });
    return job.id;
  }

  async function createMapping(
    tenantId: string,
    organizationId: string,
    label: string,
  ): Promise<string> {
    const mapping = await new ImportRepository(db).saveMapping({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      name: `Mapping ${label}`,
      entityType: 'event',
      mapping: { title: `${label}_title` },
      createdBy: basePrincipal.id,
    });
    return mapping.id;
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    connectionDb = createDb(integrationDatabaseUrl());
    const transaction = await connectionDb.startTransaction().execute();
    db = transaction;
    rollbackTransaction = async () => {
      await transaction.rollback().execute();
    };
    await insertTenant(tenantA, 'Migration read tenant A');
    await insertTenant(tenantB, 'Migration read tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration read organization A');
    await insertOrganization(organizationAScoped, tenantA, 'Migration read scoped organization');
    await insertOrganization(organizationB, tenantB, 'Migration read organization B');
    jobA = await createJob(tenantA, organizationA, 'authorized');
    jobAScoped = await createJob(tenantA, organizationAScoped, 'scoped');
    jobB = await createJob(tenantB, organizationB, 'foreign');
    mappingA = await createMapping(tenantA, organizationA, 'authorized');
    mappingAScoped = await createMapping(tenantA, organizationAScoped, 'scoped');
    mappingB = await createMapping(tenantB, organizationB, 'foreign');
    portableJobA = (
      await new ImportRepository(db).createJob({
        tenantId: tenantA,
        organizationId: organizationA,
        sourceSystem: 'tixkit-portable',
        adapterVersion: 'tixkit-portable-bundle-v1',
        mode: 'dry-run',
        idempotencyKey: `mread-portable-${suffix}`,
        requestedBy: basePrincipal.id,
        configuration: { sourceMode: 'official-export', artifactIds: ['upl_mread_fixture'] },
      })
    ).id;
    await new ImportRepository(db).recordPortablePreflight({
      tenantId: tenantA,
      organizationId: organizationA,
      jobId: portableJobA,
      operationId: `op_mread_${suffix}`,
      bundleId: `bundle_mread_${suffix}`,
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      sourceDeploymentId: `source_mread_${suffix}`,
      sourceChangeCursor: `cursor_mread_${suffix}`,
      destinationId: `destination_mread_${suffix}`,
      manifestJson: '{}',
      preflightJson: '{}',
      expectedCounts: '{}',
      expectedAssets: '[]',
      requiredRebindings: '[]',
    });

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
        if (rollbackTransaction) await attempt(rollbackTransaction);
      } finally {
        try {
          if (connectionDb) await attempt(() => connectionDb.destroy());
        } finally {
          restoreDatabaseDriver(previousDriver);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up migration read fixtures');
    }
  });

  function invoke(path: string, jobId: string, organizationId?: string) {
    const route = path.replace('{jobId}', jobId);
    return app.inject({
      method: 'GET',
      url: organizationId ? `${route}?organizationId=${organizationId}` : route,
    });
  }

  it.each(MIGRATION_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns only the authorized job projection for $path',
    async (contract) => {
      const response = await invoke(contract.path, jobA);

      expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
      if (contract.operationId === 'getMigrationJob') {
        expect(response.json()).toMatchObject({
          id: jobA,
          tenant_id: tenantA,
          organization_id: organizationA,
          configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          credentialConfigured: false,
          summary: null,
        });
        expect(response.json()).not.toHaveProperty('configuration');
      } else if (contract.operationId === 'assessMigrationRollback') {
        expect(response.json()).toEqual({ eligible: true, mode: 'cancel', blockers: [] });
      } else {
        expect(response.json()).toEqual({ items: [] });
      }
      expect(response.body).not.toContain(jobAScoped);
      expect(response.body).not.toContain(jobB);
    },
  );

  it.each(MIGRATION_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'denies every protected $path boundary without job disclosure',
    async (contract) => {
      const cases: Array<{
        principal: Principal;
        jobId: string;
        organizationId?: string;
        status: 403 | 404;
        code: 'FORBIDDEN' | 'NOT_FOUND';
      }> = [
        {
          principal: { ...basePrincipal, scopes: ['migrations.write'] },
          jobId: jobA,
          status: 403,
          code: 'FORBIDDEN',
        },
        {
          principal: { ...basePrincipal, brandIds: [`brd_mread_${suffix}`] },
          jobId: jobA,
          status: 403,
          code: 'FORBIDDEN',
        },
        {
          principal: { ...basePrincipal, eventIds: [`evt_mread_${suffix}`] },
          jobId: jobA,
          status: 403,
          code: 'FORBIDDEN',
        },
        {
          principal: basePrincipal,
          jobId: jobAScoped,
          status: 404,
          code: 'NOT_FOUND',
        },
        {
          principal: basePrincipal,
          jobId: jobB,
          organizationId: organizationB,
          status: 404,
          code: 'NOT_FOUND',
        },
      ];

      for (const denial of cases) {
        principal = denial.principal;

        const response = await invoke(contract.path, denial.jobId, denial.organizationId);

        expect(response.statusCode, response.body).toBe(denial.status);
        expect(response.json()).toMatchObject({ error: { code: denial.code } });
        for (const protectedJobId of [jobA, jobAScoped, jobB]) {
          if (protectedJobId !== denial.jobId) {
            expect(response.body).not.toContain(protectedJobId);
          }
        }
        expect(response.body).not.toContain(organizationA);
        expect(response.body).not.toContain(organizationAScoped);
        expect(response.body).not.toContain(organizationB);
      }
    },
  );

  it.each(MIGRATION_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns only the authorized migration collection for $path',
    async (contract) => {
      const url =
        contract.operationId === 'listMigrationMappings'
          ? `${contract.path}?organizationId=${organizationA}`
          : contract.path;

      const response = await app.inject({ method: contract.method, url });

      expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
      const body = response.json();
      if (contract.operationId === 'listMigrationJobs') {
        expect(body.items).toHaveLength(2);
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: jobA }),
            expect.objectContaining({ id: portableJobA, source_system: 'tixkit-portable' }),
          ]),
        );
        const authorizedJob = body.items.find((item: { id: string }) => item.id === jobA);
        expect(authorizedJob).toMatchObject({
          id: jobA,
          tenant_id: tenantA,
          organization_id: organizationA,
          configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          credentialConfigured: false,
        });
        expect(authorizedJob).not.toHaveProperty('configuration');
      } else {
        expect(body.items).toHaveLength(1);
        expect(body.items[0]).toMatchObject({
          id: mappingA,
          tenant_id: tenantA,
          organization_id: organizationA,
          mapping: { title: 'authorized_title' },
        });
      }
      for (const marker of [jobAScoped, jobB, mappingAScoped, mappingB]) {
        expect(response.body).not.toContain(marker);
      }
    },
  );

  it.each(MIGRATION_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'enforces every $path denial and filtered-collection boundary',
    async (contract) => {
      const cases: Array<{
        principal: Principal;
        organizationId: string;
        status: 200 | 403 | 404;
        code?: 'FORBIDDEN' | 'NOT_FOUND';
      }> = [
        {
          principal: { ...basePrincipal, scopes: ['migrations.write'] },
          organizationId: organizationA,
          status: 403,
          code: 'FORBIDDEN',
        },
        {
          principal: { ...basePrincipal, brandIds: [`brd_mread_${suffix}`] },
          organizationId: organizationA,
          status: 403,
          code: 'FORBIDDEN',
        },
        {
          principal: { ...basePrincipal, eventIds: [`evt_mread_${suffix}`] },
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
          status: 200,
        },
      ];

      for (const denial of cases) {
        principal = denial.principal;
        const url = `${contract.path}?organizationId=${denial.organizationId}`;

        const response = await app.inject({ method: contract.method, url });

        expect(response.statusCode, response.body).toBe(denial.status);
        if (denial.code) {
          expect(response.json()).toMatchObject({ error: { code: denial.code } });
        } else {
          expect(response.json()).toEqual({ items: [] });
        }
        for (const marker of [jobA, jobAScoped, jobB, mappingA, mappingAScoped, mappingB]) {
          expect(response.body).not.toContain(marker);
        }
      }
    },
  );

  it('returns the exact empty portable rebinding status for the authorized job', async () => {
    const contract = PORTABLE_REBINDING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;

    const response = await invoke(contract.path, portableJobA);

    expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
    expect(response.json()).toEqual({ required: [], completed: [], complete: true });
    for (const marker of [jobA, jobAScoped, jobB, organizationAScoped, organizationB]) {
      expect(response.body).not.toContain(marker);
    }
  });

  it('denies every portable rebinding read boundary before status disclosure', async () => {
    const contract = PORTABLE_REBINDING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const cases: Array<{
      principal: Principal;
      jobId: string;
      organizationId?: string;
      status: 403 | 404;
      code: 'FORBIDDEN' | 'NOT_FOUND';
    }> = [
      {
        principal: { ...basePrincipal, scopes: ['migrations.write'] },
        jobId: portableJobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, brandIds: [`brd_mread_${suffix}`] },
        jobId: portableJobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mread_${suffix}`] },
        jobId: portableJobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: basePrincipal,
        jobId: jobAScoped,
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        principal: basePrincipal,
        jobId: jobB,
        organizationId: organizationB,
        status: 404,
        code: 'NOT_FOUND',
      },
    ];

    for (const denial of cases) {
      principal = denial.principal;

      const response = await invoke(contract.path, denial.jobId, denial.organizationId);

      expect(response.statusCode, response.body).toBe(denial.status);
      expect(response.json()).toMatchObject({ error: { code: denial.code } });
      expect(response.body).not.toContain(portableJobA);
      expect(response.body).not.toContain(organizationA);
      expect(response.body).not.toContain(organizationAScoped);
      expect(response.body).not.toContain(organizationB);
    }
  });
});
