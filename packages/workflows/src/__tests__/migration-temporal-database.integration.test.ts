import { fileURLToPath } from 'node:url';
import type { WorkflowHandleWithStartDetails } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  createDb,
  ImportRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  type Database,
} from '@tixkit/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assessMigrationRollbackActivity,
  beginMigrationCommitActivity,
  cancelMigrationCommitActivity,
  completeMigrationCommitActivity,
  executeMigrationRollbackActivity,
  failMigrationCommitActivity,
  MIGRATION_COMMIT_STAGES,
  processMigrationStageActivity,
  reconcileMigrationActivity,
  recordMigrationProgressActivity,
  registerMigrationActivityService,
  setMigrationPausedActivity,
} from '../activities/migration.js';
import { createProductionMigrationCommitters } from '../activities/migration-domain-committers.js';
import { createRepositoryMigrationActivityService } from '../activities/migration-repository-service.js';
import { migrationCommitWorkflow } from '../workflows/migration.js';

const temporalAddress = process.env.TEMPORAL_ADDRESS;
const integrationDriver = process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
const databaseUrl =
  integrationDriver === 'mysql'
    ? (process.env.DATABASE_URL_MYSQL ?? '')
    : (process.env.DATABASE_URL ?? '');
const describeLiveDatabase = temporalAddress && databaseUrl ? describe.sequential : describe.skip;
const originalDbDriver = process.env.DB_DRIVER;

const productionMigrationActivities = {
  beginMigrationCommitActivity,
  processMigrationStageActivity,
  recordMigrationProgressActivity,
  setMigrationPausedActivity,
  cancelMigrationCommitActivity,
  reconcileMigrationActivity,
  assessMigrationRollbackActivity,
  executeMigrationRollbackActivity,
  completeMigrationCommitActivity,
  failMigrationCommitActivity,
};

describeLiveDatabase('migration workflow with production database activities', () => {
  let db: Database;
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    process.env.DB_DRIVER = integrationDriver;
    await runMigrations(databaseUrl);
    db = createDb(databaseUrl);
    environment = await TestWorkflowEnvironment.createFromExistingServer({
      address: temporalAddress!,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
  });

  afterAll(async () => {
    try {
      const cleanup = await Promise.allSettled([environment?.teardown(), db?.destroy()]);
      const failures = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0)
        throw new AggregateError(failures, 'Temporal database cleanup failed');
    } finally {
      if (originalDbDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = originalDbDriver;
    }
  });

  it('persists the exact generic zero-row migration lifecycle', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tenantId = (
      await new TenantRepository(db).create({ name: `Temporal database proof ${suffix}` })
    ).id;
    const organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Temporal database organization ${suffix}`,
        slug: `temporal-database-${suffix}`,
      })
    ).id;
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: `temporal-database-${suffix}`,
      requestedBy: 'temporal-database-proof',
    });
    await repository.transitionJob({
      tenantId,
      organizationId,
      jobId: job.id,
      from: ['pending'],
      to: 'ready',
    });
    const selectedSideEffectCounts = () =>
      Promise.all([
        db
          .selectFrom('payment_events')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', tenantId)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('webhook_deliveries as delivery')
          .innerJoin('webhook_events as event', 'event.id', 'delivery.event_id')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event.tenant_id', '=', tenantId)
          .where('event.organization_id', '=', organizationId)
          .executeTakeFirstOrThrow(),
      ]);
    const sideEffectCountsBefore = await selectedSideEffectCounts();
    const taskQueue = `migration-database-proof-${suffix}`;
    const workflowId = `migration-database-proof:${suffix}`;
    const workflowsPath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue,
      workflowsPath,
      activities: productionMigrationActivities,
      maxCachedWorkflows: 0,
    });
    let handle: WorkflowHandleWithStartDetails<typeof migrationCommitWorkflow> | undefined;
    let workerRan = false;
    let unregisterService: (() => void) | undefined;
    let cleanupError: unknown;
    try {
      unregisterService = registerMigrationActivityService(
        createRepositoryMigrationActivityService(db, createProductionMigrationCommitters(db)),
      );
      handle = await environment.client.workflow.start(migrationCommitWorkflow, {
        taskQueue,
        workflowId,
        workflowExecutionTimeout: '30 seconds',
        args: [{ version: 1, tenantId, organizationId, jobId: job.id, chunkSize: 2 }],
      });
      workerRan = true;
      const result = await worker.runUntil(() => handle!.result(), {
        promiseCompletionTimeout: '5 seconds',
      });
      expect(result).toMatchObject({
        status: 'completed',
        progress: { processed: 0, created: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0 },
        reconciliation: { repaired: 0, unresolved: 0 },
      });
      const persistedJob = await repository.findJob(tenantId, organizationId, job.id);
      expect(persistedJob?.status).toBe('committed');
      expect(JSON.parse(persistedJob!.summary!)).toMatchObject({
        ...result.progress,
        status: 'completed',
        stageIndex: MIGRATION_COMMIT_STAGES.length,
        stageCount: MIGRATION_COMMIT_STAGES.length,
      });
      expect(JSON.parse(persistedJob!.summary!)).not.toHaveProperty('stage');
      const events = await repository.listEvents(tenantId, organizationId, job.id);
      expect(events.map((event) => event.sequence)).toEqual(
        events.map((_event, index) => index + 1),
      );
      expect(events.map((event) => event.type)).toEqual([
        'commit.begin',
        ...MIGRATION_COMMIT_STAGES.map(() => 'commit.progress'),
        'commit.reconciled',
        'commit.completed',
      ]);
      const progress = events
        .filter((event) => event.type === 'commit.progress')
        .map(
          (event) =>
            JSON.parse(event.data!) as { stage: string; stageIndex: number; stageCount: number },
        );
      expect(progress.map((event) => event.stage)).toEqual(MIGRATION_COMMIT_STAGES);
      expect(progress.map((event) => event.stageIndex)).toEqual(
        MIGRATION_COMMIT_STAGES.map((_stage, index) => index),
      );
      expect(progress.every((event) => event.stageCount === MIGRATION_COMMIT_STAGES.length)).toBe(
        true,
      );
      const sideEffectCountsAfter = await selectedSideEffectCounts();
      expect(sideEffectCountsAfter.map((row) => Number(row.count))).toEqual(
        sideEffectCountsBefore.map((row) => Number(row.count)),
      );
    } finally {
      try {
        unregisterService?.();
      } catch (error) {
        cleanupError = error;
      }
      try {
        if (!workerRan) await worker.runUntil(Promise.resolve());
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        await environment.connection.workflowService.deleteWorkflowExecution({
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          workflowExecution: {
            workflowId,
            ...(handle ? { runId: handle.firstExecutionRunId } : {}),
          },
        });
      } catch (error) {
        if (handle) cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
  }, 45_000);
});
