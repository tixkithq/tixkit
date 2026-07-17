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
import { MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration job write authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mjwrite_${suffix}`;
  const tenantA = `tnt_mjwrite_a_${suffix}`;
  const tenantB = `tnt_mjwrite_b_${suffix}`;
  const organizationA = `org_mjwrite_a_${suffix}`;
  const organizationAScoped = `org_mjwrite_scope_${suffix}`;
  const organizationB = `org_mjwrite_b_${suffix}`;
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

  function requestBody(organizationId: string) {
    return {
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: 'rfc4180-v1',
      mode: 'dry-run',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'generic-csv',
        artifactIds: [`upl_mjwrite_${suffix}`],
      },
    };
  }

  async function snapshot() {
    const jobs = await db
      .selectFrom('import_jobs')
      .selectAll()
      .where('requested_by', '=', actorId)
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'migration_job.created')
      .orderBy('id')
      .execute();
    return { jobs, audits };
  }

  function forceConcurrentMissingPrechecks(): void {
    const original = ImportRepository.prototype.findJobByIdempotencyKey;
    let missingPrechecks = 0;
    let release!: () => void;
    const bothMissing = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(ImportRepository.prototype, 'findJobByIdempotencyKey').mockImplementation(
      async function (this: ImportRepository, tenantId, organizationId, idempotencyKey) {
        const result = await original.call(this, tenantId, organizationId, idempotencyKey);
        if (result || missingPrechecks >= 2) return result;
        missingPrechecks += 1;
        if (missingPrechecks === 2) release();
        await bothMissing;
        return result;
      },
    );
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration job write tenant A');
    await insertTenant(tenantB, 'Migration job write tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration job write organization A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Migration job write scoped organization',
    );
    await insertOrganization(organizationB, tenantB, 'Migration job write organization B');

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
        .where('action', '=', 'migration_job.created')
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

  it('creates the exact authorized job and audit atomically', async () => {
    const contract = MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const before = await snapshot();

    const response = await app.inject({
      method: contract.method,
      url: contract.path,
      headers: { 'idempotency-key': `authorized-${suffix}` },
      payload: requestBody(organizationA),
    });

    expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
    expect(response.json()).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      source_system: 'generic-csv',
      adapter_version: 'rfc4180-v1',
      mode: 'dry-run',
      status: 'pending',
      requested_by: actorId,
      configurationHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      credentialConfigured: false,
    });
    expect(response.json()).not.toHaveProperty('configuration');
    const after = await snapshot();
    expect(after.jobs).toHaveLength(before.jobs.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.audits.at(-1)).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_type: 'user',
      actor_id: actorId,
      action: 'migration_job.created',
      resource_type: 'MigrationJob',
      resource_id: response.json<{ id: string }>().id,
    });

    const replay = await app.inject({
      method: contract.method,
      url: contract.path,
      headers: { 'idempotency-key': `authorized-${suffix}` },
      payload: requestBody(organizationA),
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(response.json());
    expect(await snapshot()).toEqual(after);

    const conflict = await app.inject({
      method: contract.method,
      url: contract.path,
      headers: { 'idempotency-key': `authorized-${suffix}` },
      payload: { ...requestBody(organizationA), mode: 'commit' },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await snapshot()).toEqual(after);
  });

  it('rejects missing and oversized idempotency keys without effects', async () => {
    for (const headers of [{}, { 'idempotency-key': 'x'.repeat(256) }]) {
      const before = await snapshot();
      const response = await app.inject({
        method: 'POST',
        url: '/migration-jobs',
        headers,
        payload: requestBody(organizationA),
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('resolves concurrent identical and conflicting key races exactly once', async () => {
    const identicalBefore = await snapshot();
    forceConcurrentMissingPrechecks();
    const identical = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/migration-jobs',
          headers: { 'idempotency-key': `concurrent-identical-${suffix}` },
          payload: requestBody(organizationA),
        }),
      ),
    );
    expect(identical.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    expect(identical[0]!.json()).toEqual(identical[1]!.json());
    const identicalAfter = await snapshot();
    expect(identicalAfter.jobs).toHaveLength(identicalBefore.jobs.length + 1);
    expect(identicalAfter.audits).toHaveLength(identicalBefore.audits.length + 1);

    vi.restoreAllMocks();
    const conflictingBefore = identicalAfter;
    forceConcurrentMissingPrechecks();
    const conflicting = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/migration-jobs',
        headers: { 'idempotency-key': `concurrent-conflict-${suffix}` },
        payload: requestBody(organizationA),
      }),
      app.inject({
        method: 'POST',
        url: '/migration-jobs',
        headers: { 'idempotency-key': `concurrent-conflict-${suffix}` },
        payload: { ...requestBody(organizationA), mode: 'commit' },
      }),
    ]);
    expect(conflicting.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    expect(conflicting.find(({ statusCode }) => statusCode === 409)!.json()).toMatchObject({
      error: { code: 'CONFLICT' },
    });
    const conflictingAfter = await snapshot();
    expect(conflictingAfter.jobs).toHaveLength(conflictingBefore.jobs.length + 1);
    expect(conflictingAfter.audits).toHaveLength(conflictingBefore.audits.length + 1);
    expect(conflictingAfter.audits.at(-1)?.resource_id).toBe(
      conflicting.find(({ statusCode }) => statusCode === 201)!.json<{ id: string }>().id,
    );
    const winningJob = conflictingAfter.jobs.at(-1)!;
    const auditSummary = conflictingAfter.audits.at(-1)!.diff_summary;
    expect(
      typeof auditSummary === 'string' ? JSON.parse(auditSummary) : auditSummary,
    ).toMatchObject({
      sourceSystem: winningJob.source_system,
      mode: winningJob.mode,
    });
  });

  it('rolls job persistence back when the required audit fails', async () => {
    const before = await snapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/migration-jobs',
      headers: { 'idempotency-key': `audit-failure-${suffix}` },
      payload: requestBody(organizationA),
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it('denies every job-write boundary without persistence or audit effects', async () => {
    const contract = MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
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
        principal: { ...basePrincipal, brandIds: [`brd_mjwrite_${suffix}`] },
        organizationId: organizationA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mjwrite_${suffix}`] },
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
        headers: { 'idempotency-key': `denied-${index}-${suffix}` },
        payload: requestBody(denial.organizationId),
      });

      expect(response.statusCode, response.body).toBe(denial.status);
      expect(response.json()).toMatchObject({ error: { code: denial.code } });
      expect(response.body).not.toContain(tenantA);
      expect(response.body).not.toContain(tenantB);
      expect(await snapshot()).toEqual(before);
    }
  });
});
