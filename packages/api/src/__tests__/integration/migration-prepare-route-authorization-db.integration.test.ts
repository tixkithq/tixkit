import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, ImportRepository, type Database } from '@tixkit/db';
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
import { MIGRATION_PREPARE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration prepare authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let rejectTemporalStart = false;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mprep_${suffix}`;
  const tenantA = `tnt_mprep_a_${suffix}`;
  const tenantB = `tnt_mprep_b_${suffix}`;
  const organizationA = `org_mprep_a_${suffix}`;
  const organizationAScoped = `org_mprep_scope_${suffix}`;
  const organizationB = `org_mprep_b_${suffix}`;
  let jobA: string;
  let jobAScoped: string;
  let jobB: string;
  let jobPaused: string;
  const starts: Array<{ tenantId: string; organizationId: string; jobId: string }> = [];
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

  async function createJob(tenantId: string, organizationId: string, label: string) {
    return (
      await new ImportRepository(db).createJob({
        tenantId,
        organizationId,
        sourceSystem: 'pretix',
        adapterVersion: 'pretix-api-v1',
        mode: 'dry-run',
        idempotencyKey: `mprep-${label}-${suffix}`,
        requestedBy: actorId,
        configuration: {
          sourceMode: 'official-api',
          sourceSystem: 'pretix',
          organizerSlug: 'fixture-organizer',
          eventSlugs: ['fixture-event'],
        },
      })
    ).id;
  }

  async function snapshot() {
    const jobs = await db
      .selectFrom('import_jobs')
      .selectAll()
      .where('id', 'in', [jobA, jobAScoped, jobB, jobPaused])
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'migration_job.prepare_requested')
      .orderBy('id')
      .execute();
    return { jobs, audits };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration prepare tenant A');
    await insertTenant(tenantB, 'Migration prepare tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration prepare organization A');
    await insertOrganization(organizationAScoped, tenantA, 'Migration prepare scoped organization');
    await insertOrganization(organizationB, tenantB, 'Migration prepare organization B');
    jobA = await createJob(tenantA, organizationA, 'authorized');
    jobAScoped = await createJob(tenantA, organizationAScoped, 'scoped');
    jobB = await createJob(tenantB, organizationB, 'foreign');
    jobPaused = await createJob(tenantA, organizationA, 'paused');
    await db
      .updateTable('import_jobs')
      .set({ status: 'paused' })
      .where('id', '=', jobPaused)
      .execute();

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      temporalClient: {
        startMigrationPreparation: async (input: {
          tenantId: string;
          organizationId: string;
          jobId: string;
        }) => {
          starts.push(input);
          if (rejectTemporalStart) throw new Error('injected Temporal start failure');
          return {
            workflowId: `migration-prepare:${input.tenantId}:${input.organizationId}:${input.jobId}`,
          };
        },
      },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    await app.ready();
  });

  beforeEach(() => {
    principal = basePrincipal;
    rejectTemporalStart = false;
    starts.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('actor_id', '=', actorId)
        .where('action', '=', 'migration_job.prepare_requested')
        .execute();
      await db.deleteFrom('import_jobs').where('requested_by', '=', actorId).execute();
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

  function invoke(jobId: string, organizationId?: string) {
    return app.inject({
      method: 'POST',
      url: `/migration-jobs/${jobId}/prepare${organizationId ? `?organizationId=${organizationId}` : ''}`,
      payload: {},
    });
  }

  it('records the exact request audit before starting the authorized workflow', async () => {
    const before = await snapshot();
    const response = await invoke(jobA);
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ jobId: jobA, status: 'preparing' });
    expect(starts).toEqual([{ tenantId: tenantA, organizationId: organizationA, jobId: jobA }]);
    const after = await snapshot();
    expect(after.jobs).toEqual(before.jobs);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.audits.at(-1)).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_id: actorId,
      action: 'migration_job.prepare_requested',
      resource_type: 'MigrationJob',
      resource_id: jobA,
    });
  });

  it('fails closed before workflow dispatch when the required audit fails', async () => {
    const before = await snapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected prepare audit failure'),
    );
    const response = await invoke(jobA);
    expect(response.statusCode, response.body).toBe(500);
    expect(starts).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('retains the truthful request audit when Temporal startup fails', async () => {
    const before = await snapshot();
    rejectTemporalStart = true;
    const response = await invoke(jobA);
    expect(response.statusCode, response.body).toBe(500);
    expect(starts).toEqual([{ tenantId: tenantA, organizationId: organizationA, jobId: jobA }]);
    const after = await snapshot();
    expect(after.jobs).toEqual(before.jobs);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.audits.at(-1)).toMatchObject({ resource_id: jobA });
  });

  it('directs paused preparation jobs to the resume route without effects', async () => {
    const before = await snapshot();
    const response = await invoke(jobPaused);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(starts).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('denies every prepare boundary before audit or workflow effects', async () => {
    const contract = MIGRATION_PREPARE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const cases: Array<{
      principal: Principal;
      jobId: string;
      organizationId?: string;
      status: 403 | 404;
      code: 'FORBIDDEN' | 'NOT_FOUND';
    }> = [
      {
        principal: { ...basePrincipal, scopes: ['migrations.read'] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, brandIds: [`brd_mprep_${suffix}`] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mprep_${suffix}`] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      { principal: basePrincipal, jobId: jobAScoped, status: 404, code: 'NOT_FOUND' },
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
      const before = await snapshot();
      const response = await invoke(denial.jobId, denial.organizationId);
      expect(response.statusCode, response.body).toBe(denial.status);
      expect(response.json()).toMatchObject({ error: { code: denial.code } });
      expect(starts).toEqual([]);
      expect(await snapshot()).toEqual(before);
    }
    expect(contract.operationId).toBe('prepareMigrationJob');
  });
});
