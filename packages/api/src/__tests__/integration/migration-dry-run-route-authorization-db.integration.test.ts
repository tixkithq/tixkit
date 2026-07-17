import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, ImportRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import { stablePortableControlHash } from '../../services/portable-import-control.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { MIGRATION_DRY_RUN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration dry-run authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mdry_${suffix}`;
  const tenantA = `tnt_mdry_a_${suffix}`;
  const tenantB = `tnt_mdry_b_${suffix}`;
  const organizationA = `org_mdry_a_${suffix}`;
  const organizationAScoped = `org_mdry_scope_${suffix}`;
  const organizationB = `org_mdry_b_${suffix}`;
  let jobA: string;
  let jobAuditFailure: string;
  let jobRace: string;
  let jobAScoped: string;
  let jobB: string;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    scopes: ['migrations.write'],
  };

  function configurationFor(label: string) {
    return {
      sourceMode: 'official-export',
      sourceSystem: 'generic-csv',
      artifactIds: [`upl_mdry_${label}_${suffix}`],
    };
  }

  function sourceDataFor(label: string) {
    return { id: `event-${label}`, title: `Event ${label}` };
  }

  function normalizedDataFor(label: string) {
    return {
      entityType: 'event',
      externalId: `event-${label}`,
      sourcePosition: `${label}.csv:2`,
      attributes: { title: `Event ${label}`, currency: 'USD', timezone: 'UTC' },
    };
  }

  function parseStoredJson(value: unknown): unknown {
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

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

  async function createPreparedJob(tenantId: string, organizationId: string, label: string) {
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: 'rfc4180-v1',
      mode: 'commit',
      idempotencyKey: `mdry-${label}-${suffix}`,
      requestedBy: actorId,
      configuration: configurationFor(label),
    });
    await repository.addRows(tenantId, organizationId, job.id, [
      {
        entityType: 'event',
        externalId: `event-${label}`,
        rowNumber: 1,
        sourceData: sourceDataFor(label),
        normalizedData: normalizedDataFor(label),
        status: 'validated',
      },
    ]);
    await db
      .updateTable('import_jobs')
      .set({ status: 'prepared' })
      .where('id', '=', job.id)
      .execute();
    return job.id;
  }

  async function snapshot() {
    const jobs = await db
      .selectFrom('import_jobs')
      .selectAll()
      .where('id', 'in', [jobA, jobAuditFailure, jobRace, jobAScoped, jobB])
      .orderBy('id')
      .execute();
    const rows = await db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('import_job_id', 'in', [jobA, jobAuditFailure, jobRace, jobAScoped, jobB])
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', 'in', ['migration_job.dry_run_completed', 'migration_job.dry_run_failed'])
      .orderBy('id')
      .execute();
    return { jobs, rows, audits };
  }

  function forceConcurrentPreparedReads(jobId: string): void {
    const original = ImportRepository.prototype.findJob;
    let preparedReads = 0;
    let release!: () => void;
    const bothPrepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ImportRepository.prototype, 'findJob').mockImplementation(
      async function (this: ImportRepository, tenantId, organizationId, candidateJobId) {
        const result = await original.call(this, tenantId, organizationId, candidateJobId);
        if (candidateJobId !== jobId || result?.status !== 'prepared' || preparedReads >= 2) {
          return result;
        }
        preparedReads += 1;
        if (preparedReads === 2) release();
        await bothPrepared;
        return result;
      },
    );
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration dry-run tenant A');
    await insertTenant(tenantB, 'Migration dry-run tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration dry-run organization A');
    await insertOrganization(organizationAScoped, tenantA, 'Migration dry-run scoped organization');
    await insertOrganization(organizationB, tenantB, 'Migration dry-run organization B');
    jobA = await createPreparedJob(tenantA, organizationA, 'authorized');
    jobAuditFailure = await createPreparedJob(tenantA, organizationA, 'audit');
    jobRace = await createPreparedJob(tenantA, organizationA, 'race');
    jobAScoped = await createPreparedJob(tenantA, organizationAScoped, 'scoped');
    jobB = await createPreparedJob(tenantB, organizationB, 'foreign');

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
        .where('action', 'in', ['migration_job.dry_run_completed', 'migration_job.dry_run_failed'])
        .execute();
      await db
        .deleteFrom('import_job_rows')
        .where('import_job_id', 'in', [jobA, jobAuditFailure, jobRace, jobAScoped, jobB])
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
      url: `/migration-jobs/${jobId}/dry-run${organizationId ? `?organizationId=${organizationId}` : ''}`,
      payload: {},
    });
  }

  it('atomically persists the accepted dry-run summary, ready state and audit', async () => {
    const before = await snapshot();
    const persistedRow = before.rows.find(({ import_job_id: jobId }) => jobId === jobA)!;
    const expectedInputHash = stablePortableControlHash({
      configuration: configurationFor('authorized'),
      files: [],
      mappings: [],
      rows: [
        {
          id: persistedRow.id,
          source: stablePortableControlHash(sourceDataFor('authorized')),
          normalized: stablePortableControlHash(normalizedDataFor('authorized')),
        },
      ],
    });
    const expectedConfigurationHash = stablePortableControlHash(configurationFor('authorized'));
    const response = await invoke(jobA);
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json();
    expect(payload).toMatchObject({
      status: 'ready',
      domainWrites: 0,
      report: {
        accepted: true,
        inputHash: expectedInputHash,
        configurationHash: expectedConfigurationHash,
      },
    });
    const after = await snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    const persistedJob = after.jobs.find(({ id }) => id === jobA)!;
    expect(persistedJob).toMatchObject({ status: 'ready' });
    expect(parseStoredJson(persistedJob.summary)).toEqual(payload.report);
    expect(after.audits.at(-1)).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_id: actorId,
      action: 'migration_job.dry_run_completed',
      resource_id: jobA,
    });
  });

  it('rolls the summary and state back when the required audit fails', async () => {
    const before = await snapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected dry-run audit failure'),
    );
    const response = await invoke(jobAuditFailure);
    expect(response.statusCode, response.body).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it('allows exactly one concurrent dry-run finalization winner', async () => {
    const before = await snapshot();
    forceConcurrentPreparedReads(jobRace);
    const responses = await Promise.all([invoke(jobRace), invoke(jobRace)]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find(({ statusCode }) => statusCode === 200)!;
    const loser = responses.find(({ statusCode }) => statusCode === 409)!;
    expect(loser.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    const after = await snapshot();
    expect(after.rows).toEqual(before.rows);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    const persistedJob = after.jobs.find(({ id }) => id === jobRace)!;
    expect(persistedJob).toMatchObject({ status: 'ready' });
    expect(parseStoredJson(persistedJob.summary)).toEqual(winner.json().report);
  });

  it('denies every dry-run boundary before summary or audit effects', async () => {
    const contract = MIGRATION_DRY_RUN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const cases: Array<{
      principal: Principal;
      jobId: string;
      organizationId?: string;
      status: 403 | 404;
      code: 'FORBIDDEN' | 'NOT_FOUND';
    }> = [
      {
        principal: { ...basePrincipal, scopes: ['migrations.read'] },
        jobId: jobAuditFailure,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, brandIds: [`brd_mdry_${suffix}`] },
        jobId: jobAuditFailure,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mdry_${suffix}`] },
        jobId: jobAuditFailure,
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
      expect(await snapshot()).toEqual(before);
    }
    expect(contract.operationId).toBe('runMigrationDryRun');
  });
});
