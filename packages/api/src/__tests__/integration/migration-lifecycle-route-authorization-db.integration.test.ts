import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, ImportRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import { dispatchMigrationLifecycleCommands } from '../../services/migration-lifecycle-dispatcher.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { MIGRATION_LIFECYCLE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration lifecycle route authorization and dispatch', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let activePrincipal: Principal;
  let rejectTemporal = false;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mlifecycle_${suffix}`;
  const tenantA = `tnt_mlifecycle_a_${suffix}`;
  const tenantB = `tnt_mlifecycle_b_${suffix}`;
  const organizationA = `org_mlifecycle_a_${suffix}`;
  const organizationScoped = `org_mlifecycle_scope_${suffix}`;
  const organizationB = `org_mlifecycle_b_${suffix}`;
  const temporalCalls: Array<Record<string, unknown>> = [];
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA],
    scopes: ['migrations.commit', 'migrations.rollback'],
  };

  const temporalClient = {
    async signalMigrationPreparation(
      tenantId: string,
      organizationId: string,
      jobId: string,
      action: 'pause' | 'resume' | 'cancel',
      command: { commandId: string; lifecycleSequence: number },
    ) {
      temporalCalls.push({
        kind: 'preparation-signal',
        tenantId,
        organizationId,
        jobId,
        action,
        command,
      });
      if (rejectTemporal)
        throw Object.assign(new Error('injected Temporal outage'), { code: 'UNAVAILABLE' });
    },
    async signalMigration(
      tenantId: string,
      organizationId: string,
      jobId: string,
      action: 'pause' | 'resume' | 'cancel' | 'rollback',
      command: { commandId: string; lifecycleSequence: number },
    ) {
      temporalCalls.push({
        kind: 'commit-signal',
        tenantId,
        organizationId,
        jobId,
        action,
        command,
      });
      if (rejectTemporal)
        throw Object.assign(new Error('injected Temporal outage'), { code: 'UNAVAILABLE' });
    },
    async startMigrationRollback(input: {
      tenantId: string;
      organizationId: string;
      jobId: string;
      commandId: string;
      lifecycleSequence: number;
    }) {
      temporalCalls.push({ kind: 'rollback-start', ...input });
      if (rejectTemporal)
        throw Object.assign(new Error('injected Temporal outage'), { code: 'UNAVAILABLE' });
      return {
        workflowId: `migration-rollback:${input.tenantId}:${input.organizationId}:${input.jobId}`,
      };
    },
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
        box_office_settings: JSON.stringify({ enabled: false }),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function createJob(
    organizationId: string,
    tenantId: string,
    status: 'pending' | 'preparing' | 'committing' | 'committed',
  ): Promise<string> {
    const job = await new ImportRepository(db).createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: '1',
      mode: 'commit',
      idempotencyKey: `mlifecycle-${status}-${ulid()}`,
      requestedBy: actorId,
    });
    if (status !== 'pending') {
      await db.updateTable('import_jobs').set({ status }).where('id', '=', job.id).execute();
    }
    return job.id;
  }

  async function createPausedJob(
    organizationId = organizationA,
    tenantId = tenantA,
  ): Promise<string> {
    const jobId = await createJob(organizationId, tenantId, 'committing');
    const now = new Date('2026-07-17T12:00:00.000Z');
    const reserved = await db.transaction().execute((transaction) =>
      new ImportRepository(transaction).reserveMigrationLifecycleCommand({
        tenantId,
        organizationId,
        jobId,
        action: 'pause',
        dispatchKind: 'commit-signal',
        idempotencyKeySha256: 'a'.repeat(64),
        requestFingerprint: 'b'.repeat(64),
        expectedJobStatus: 'committing',
        expectedLifecycleVersion: 0,
        actorId,
        auditCorrelationId: `fixture-${jobId}`,
        now,
      }),
    );
    await db
      .updateTable('migration_lifecycle_commands')
      .set({ status: 'dispatched', dispatched_at: now, updated_at: now })
      .where('id', '=', reserved.command.id)
      .execute();
    await db.transaction().execute((transaction) =>
      new ImportRepository(transaction).persistMigrationLifecycleCommandOutcome({
        tenantId,
        organizationId,
        jobId,
        commandId: reserved.command.id,
        lifecycleSequence: 1,
        outcome: 'paused',
        now,
      }),
    );
    return jobId;
  }

  async function snapshot(jobIds: string[]) {
    const jobs = await db
      .selectFrom('import_jobs')
      .selectAll()
      .where('id', 'in', jobIds)
      .orderBy('id')
      .execute();
    const commands = await db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('import_job_id', 'in', jobIds)
      .orderBy('import_job_id')
      .orderBy('lifecycle_sequence')
      .execute();
    const events = await db
      .selectFrom('import_job_events')
      .selectAll()
      .where('import_job_id', 'in', jobIds)
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('resource_id', 'in', jobIds)
      .orderBy('id')
      .execute();
    return { jobs, commands, events, audits };
  }

  function invoke(
    jobId: string,
    action: 'pause' | 'resume' | 'cancel' | 'rollback',
    key: string,
    organizationId?: string,
  ) {
    return app.inject({
      method: 'POST',
      url: `/migration-jobs/${jobId}/${action}${organizationId ? `?organizationId=${organizationId}` : ''}`,
      headers: {
        'idempotency-key': key,
        ...(action === 'rollback' ? { 'x-tixkit-confirmation': `rollback:${jobId}` } : {}),
      },
      payload: {},
    });
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration lifecycle tenant A');
    await insertTenant(tenantB, 'Migration lifecycle tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration lifecycle organization A');
    await insertOrganization(
      organizationScoped,
      tenantA,
      'Migration lifecycle scoped organization',
    );
    await insertOrganization(organizationB, tenantB, 'Migration lifecycle organization B');
    activePrincipal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db, temporalClient } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    await app.ready();
  });

  beforeEach(() => {
    activePrincipal = basePrincipal;
    temporalCalls.length = 0;
    rejectTemporal = false;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (db) {
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('atomically cancels a local job, audits once, and exactly replays the command', async () => {
    const jobId = await createJob(organizationA, tenantA, 'pending');
    const first = await invoke(jobId, 'cancel', 'cancel-once');
    expect(first.statusCode, first.body).toBe(202);
    const replay = await invoke(jobId, 'cancel', 'cancel-once');
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(temporalCalls).toEqual([]);
    const state = await snapshot([jobId]);
    expect(state.jobs[0]).toMatchObject({ status: 'cancelled', lifecycle_version: 1 });
    expect(state.commands).toHaveLength(1);
    expect(state.commands[0]).toMatchObject({
      action: 'cancel',
      dispatch_kind: 'none',
      status: 'dispatched',
      lifecycle_sequence: 1,
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ type: 'migration.lifecycle.cancelled' });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: 'migration_job.cancel_requested' });
  });

  it('rolls back the local command, outcome, transition, and audit together', async () => {
    const jobId = await createJob(organizationA, tenantA, 'pending');
    const before = await snapshot([jobId]);
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected audit failure'),
    );
    const response = await invoke(jobId, 'cancel', 'cancel-audit-failure');
    expect(response.statusCode, response.body).toBe(500);
    await expect(snapshot([jobId])).resolves.toEqual(before);
    expect(temporalCalls).toEqual([]);
  });

  it('durably dispatches exact commands and recovers a provider outage without losing intent', async () => {
    const jobId = await createJob(organizationA, tenantA, 'preparing');
    const response = await invoke(jobId, 'pause', 'pause-durable');
    expect(response.statusCode, response.body).toBe(202);
    const accepted = response.json<{ commandId: string; lifecycleSequence: number }>();
    expect(temporalCalls).toEqual([]);
    rejectTemporal = true;
    const firstDispatch = await dispatchMigrationLifecycleCommands({
      db,
      temporalClient,
      workerId: `worker-fail-${suffix}`,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(firstDispatch.retried).toBeGreaterThanOrEqual(1);
    let state = await snapshot([jobId]);
    expect(state.commands[0]).toMatchObject({
      id: accepted.commandId,
      status: 'pending',
      attempts: 1,
      last_error_code: 'TEMPORAL_UNAVAILABLE',
    });
    expect(state.audits).toHaveLength(1);
    rejectTemporal = false;
    const secondDispatch = await dispatchMigrationLifecycleCommands({
      db,
      temporalClient,
      workerId: `worker-recover-${suffix}`,
      now: new Date('2030-01-01T00:00:01.000Z'),
    });
    expect(secondDispatch.dispatched).toBeGreaterThanOrEqual(1);
    state = await snapshot([jobId]);
    expect(state.commands[0]).toMatchObject({ status: 'dispatched', attempts: 2 });
    expect(temporalCalls.filter(({ jobId: calledJobId }) => calledJobId === jobId)).toEqual([
      {
        kind: 'preparation-signal',
        tenantId: tenantA,
        organizationId: organizationA,
        jobId,
        action: 'pause',
        command: { commandId: accepted.commandId, lifecycleSequence: 1 },
      },
      {
        kind: 'preparation-signal',
        tenantId: tenantA,
        organizationId: organizationA,
        jobId,
        action: 'pause',
        command: { commandId: accepted.commandId, lifecycleSequence: 1 },
      },
    ]);
  });

  it('routes resume through the workflow lane bound by the accepted pause command', async () => {
    const jobId = await createPausedJob();
    const response = await invoke(jobId, 'resume', 'resume-commit-lane');
    expect(response.statusCode, response.body).toBe(202);
    const accepted = response.json<{ commandId: string }>();
    await dispatchMigrationLifecycleCommands({
      db,
      temporalClient,
      workerId: `worker-resume-${suffix}`,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(temporalCalls.filter(({ jobId: calledJobId }) => calledJobId === jobId)).toEqual([
      {
        kind: 'commit-signal',
        tenantId: tenantA,
        organizationId: organizationA,
        jobId,
        action: 'resume',
        command: { commandId: accepted.commandId, lifecycleSequence: 2 },
      },
    ]);
  });

  it('denies every lifecycle action boundary without commands, audits, events, or dispatch', async () => {
    expect(
      MIGRATION_LIFECYCLE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map(
        ({ operationId }) => operationId,
      ),
    ).toEqual([
      'pauseMigrationJob',
      'resumeMigrationJob',
      'cancelMigrationJob',
      'rollbackMigrationJob',
    ]);
    const jobs = {
      pause: await createJob(organizationA, tenantA, 'preparing'),
      resume: await createPausedJob(),
      cancel: await createJob(organizationA, tenantA, 'pending'),
      rollback: await createJob(organizationA, tenantA, 'committed'),
    } as const;
    const scopedJob = await createJob(organizationScoped, tenantA, 'pending');
    const foreignJob = await createJob(organizationB, tenantB, 'pending');
    for (const [action, jobId] of Object.entries(jobs) as Array<
      ['pause' | 'resume' | 'cancel' | 'rollback', string]
    >) {
      const cases: Array<{
        principal: Principal;
        jobId: string;
        organizationId?: string;
        status: 403 | 404;
      }> = [
        { principal: { ...basePrincipal, scopes: [] }, jobId, status: 403 },
        { principal: { ...basePrincipal, brandIds: [`brd_${suffix}`] }, jobId, status: 403 },
        { principal: { ...basePrincipal, eventIds: [`evt_${suffix}`] }, jobId, status: 403 },
        { principal: basePrincipal, jobId: scopedJob, status: 404 },
        { principal: basePrincipal, jobId: foreignJob, organizationId: organizationB, status: 404 },
      ];
      for (const denial of cases) {
        activePrincipal = denial.principal;
        const relevantIds = [jobId, scopedJob, foreignJob];
        const before = await snapshot(relevantIds);
        const response = await invoke(
          denial.jobId,
          action,
          `deny-${action}-${denial.status}-${ulid()}`,
          denial.organizationId,
        );
        expect(response.statusCode, response.body).toBe(denial.status);
        await expect(snapshot(relevantIds)).resolves.toEqual(before);
        expect(temporalCalls).toEqual([]);
      }
    }
  });
});
