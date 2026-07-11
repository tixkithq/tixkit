import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  handlers: new Map<string, () => void>(),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () =>
    new Proxy(
      {},
      {
        get:
          (_target, property: string) =>
          (...args: any[]) =>
            state.activities[property]?.(...args),
      },
    ),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (name: string, handler: () => void) => state.handlers.set(name, handler),
  condition: async (predicate: () => boolean) => {
    if (!predicate()) throw new Error('test condition was not released');
  },
}));

const { migrationCommitWorkflow, migrationRollbackWorkflow } =
  await import('../workflows/migration.js');
const { migrationPreparationWorkflow } = await import('../workflows/migration-preparation.js');
const { MIGRATION_COMMIT_STAGES } = await import('../activities/migration.js');

function installDefaults() {
  const calls: string[] = [];
  state.activities = {
    beginMigrationCommitActivity: vi.fn(async () => undefined),
    processMigrationStageActivity: vi.fn(async ({ stage }: { stage: string }) => {
      calls.push(stage);
      return {
        processed: 1,
        created: 1,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        complete: true,
      };
    }),
    recordMigrationProgressActivity: vi.fn(async () => undefined),
    setMigrationPausedActivity: vi.fn(async () => undefined),
    cancelMigrationCommitActivity: vi.fn(async () => undefined),
    reconcileMigrationActivity: vi.fn(async () => ({
      repaired: 0,
      unresolved: 0,
    })),
    assessMigrationRollbackActivity: vi.fn(async () => ({
      eligible: false,
      mode: 'corrective_plan',
      reasons: ['new scan activity'],
      correctivePlanId: 'plan_1',
    })),
    executeMigrationRollbackActivity: vi.fn(async () => ({ deleted: 0 })),
    completeMigrationCommitActivity: vi.fn(async () => undefined),
    failMigrationCommitActivity: vi.fn(async () => undefined),
  };
  return calls;
}

beforeEach(() => {
  state.handlers.clear();
  installDefaults();
});

describe('migration preparation workflow', () => {
  it('continues exact durable cursors until preparation is complete', async () => {
    let calls = 0;
    state.activities.prepareMigrationChunkActivity = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { processed: 100, completed: false } : { processed: 1, completed: true };
    });
    state.activities.pauseMigrationPreparationActivity = vi.fn(async () => undefined);
    state.activities.cancelMigrationPreparationActivity = vi.fn(async () => undefined);
    state.activities.failMigrationPreparationActivity = vi.fn(async () => undefined);
    const result = await migrationPreparationWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'imp_1',
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ status: 'prepared', processed: 101 });
  });

  it('cancels between chunks without acquiring another page', async () => {
    state.activities.prepareMigrationChunkActivity = vi.fn(async () => {
      state.handlers.get('cancelMigrationPreparation')?.();
      return { processed: 1, completed: false, cursor: 'next' };
    });
    state.activities.cancelMigrationPreparationActivity = vi.fn(async () => undefined);
    state.activities.failMigrationPreparationActivity = vi.fn(async () => undefined);
    const result = await migrationPreparationWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'imp_1',
    });
    expect(result.status).toBe('cancelled');
    expect(state.activities.prepareMigrationChunkActivity).toHaveBeenCalledOnce();
    expect(state.activities.cancelMigrationPreparationActivity).toHaveBeenCalledOnce();
  });
});

describe('migration commit workflow', () => {
  it('processes every domain stage in the required dependency order', async () => {
    const calls = installDefaults();
    const result = await migrationCommitWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'import_1',
      chunkSize: 100,
    });

    expect(calls).toEqual(MIGRATION_COMMIT_STAGES);
    expect(result.status).toBe('completed');
    expect(result.progress.created).toBe(MIGRATION_COMMIT_STAGES.length);
    expect(state.activities.completeMigrationCommitActivity).toHaveBeenCalledOnce();
  });

  it('cancels durably between chunks and never advances to a dependent stage', async () => {
    const processed: string[] = [];
    state.activities.processMigrationStageActivity = vi.fn(async ({ stage }: { stage: string }) => {
      processed.push(stage);
      state.handlers.get('cancelMigration')?.();
      return {
        processed: 1,
        created: 1,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        complete: false,
        nextCursor: 'row_2',
      };
    });

    const result = await migrationCommitWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'import_1',
    });

    expect(result.status).toBe('cancelled');
    expect(processed).toEqual(['organizations_brands']);
    expect(state.activities.cancelMigrationCommitActivity).toHaveBeenCalledOnce();
    expect(state.activities.completeMigrationCommitActivity).not.toHaveBeenCalled();
  });

  it('advances an exact-size chunk with a distinct durable claim owner', async () => {
    const owners: string[] = [];
    let first = true;
    state.activities.processMigrationStageActivity = vi.fn(
      async ({ claimOwner }: { claimOwner: string }) => {
        owners.push(claimOwner);
        if (first) {
          first = false;
          return {
            processed: 500,
            created: 500,
            updated: 0,
            skipped: 0,
            conflicts: 0,
            failed: 0,
            complete: false,
            nextCursor: 'row_500',
          };
        }
        return {
          processed: 0,
          created: 0,
          updated: 0,
          skipped: 0,
          conflicts: 0,
          failed: 0,
          complete: true,
        };
      },
    );
    await migrationCommitWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'import_1',
      chunkSize: 500,
    });
    expect(owners.slice(0, 2)).toEqual([
      'import_1:organizations_brands:initial',
      'import_1:organizations_brands:row_500',
    ]);
  });

  it('fails closed on destructive rollback when live activity makes it ineligible', async () => {
    let signalled = false;
    state.activities.processMigrationStageActivity = vi.fn(async () => {
      if (!signalled) {
        signalled = true;
        state.handlers.get('requestMigrationRollback')?.();
      }
      return {
        processed: 1,
        created: 1,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        complete: true,
      };
    });

    const result = await migrationCommitWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'import_1',
    });

    expect(result.status).toBe('rollback_refused');
    expect(result.rollback).toMatchObject({
      eligible: false,
      correctivePlanId: 'plan_1',
    });
    expect(state.activities.executeMigrationRollbackActivity).not.toHaveBeenCalled();
    expect(state.activities.completeMigrationCommitActivity).not.toHaveBeenCalled();
  });

  it('records terminal failure without hiding the retry-exhausted error', async () => {
    state.activities.processMigrationStageActivity = vi.fn(async () => {
      throw new Error('row commit exhausted retries');
    });

    await expect(
      migrationCommitWorkflow({
        version: 1,
        tenantId: 'tenant_1',
        organizationId: 'org_1',
        jobId: 'import_1',
      }),
    ).rejects.toThrow('row commit exhausted retries');
    expect(state.activities.failMigrationCommitActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        jobId: 'import_1',
        stage: 'organizations_brands',
        code: 'MIGRATION_COMMIT_FAILED',
      }),
    );
  });

  it('requires reconciliation to report zero unresolved rows before completion', async () => {
    state.activities.reconcileMigrationActivity = vi.fn(async () => ({
      repaired: 1,
      unresolved: 1,
    }));
    await expect(
      migrationCommitWorkflow({
        version: 1,
        tenantId: 'tenant_1',
        organizationId: 'org_1',
        jobId: 'import_1',
      }),
    ).rejects.toThrow('reconciliation has 1 unresolved items');
    expect(state.activities.completeMigrationCommitActivity).not.toHaveBeenCalled();
  });

  it('runs post-commit rollback as a distinct deterministic workflow', async () => {
    state.activities.assessMigrationRollbackActivity = vi.fn(async () => ({
      eligible: true,
      mode: 'pre_activation',
      entityCount: 2,
    }));
    state.activities.executeMigrationRollbackActivity = vi.fn(async () => ({
      deleted: 2,
    }));
    const result = await migrationRollbackWorkflow({
      version: 1,
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'import_1',
    });
    expect(result).toMatchObject({ status: 'rolled_back', deleted: 2 });
    expect(state.activities.executeMigrationRollbackActivity).toHaveBeenCalledOnce();
  });
});
