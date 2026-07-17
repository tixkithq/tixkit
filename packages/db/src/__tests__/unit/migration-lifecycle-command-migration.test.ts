import { describe, expect, it, vi } from 'vitest';
import { MigrationLifecycleCommandsMigration } from '../../migrations/0091_migration_lifecycle_commands.js';
import { MigrationLifecycleCommandOutcomesMigration } from '../../migrations/0092_migration_lifecycle_command_outcomes.js';
import { PaymentAccountRefreshGenerationMigration } from '../../migrations/0093_payment_account_refresh_generation.js';

function selectResult(value: { id: string; maintenance?: number } | undefined) {
  const executeTakeFirst = vi.fn(async () => value);
  const query = {
    select: vi.fn(() => query),
    selectAll: vi.fn(() => query),
    where: vi.fn(() => query),
    forUpdate: vi.fn(() => query),
    limit: vi.fn(() => query),
    executeTakeFirst,
  };
  return query;
}

function rollbackDb(input: {
  command?: { id: string };
  versionedJob?: { id: string };
  refreshClaim?: { id: string };
  missingRefreshControl?: boolean;
}) {
  const dropTableExecute = vi.fn(async () => undefined);
  const alterExecute = vi.fn(async () => undefined);
  const maintenanceUpdates: number[] = [];
  const db = {
    selectFrom: vi.fn((table: string) => {
      if (table === 'migration_lifecycle_commands') return selectResult(input.command);
      if (table === 'payment_accounts') return selectResult(input.refreshClaim);
      if (table === 'payment_account_refresh_control') {
        return selectResult(
          input.missingRefreshControl ? undefined : { id: 'singleton', maintenance: 0 },
        );
      }
      return selectResult(input.versionedJob);
    }),
    updateTable: vi.fn(() => ({
      set: vi.fn((values: { maintenance: number }) => {
        maintenanceUpdates.push(values.maintenance);
        const update = {
          where: vi.fn(() => update),
          execute: vi.fn(async () => undefined),
        };
        return update;
      }),
    })),
    schema: {
      dropTable: vi.fn(() => ({ execute: dropTableExecute })),
      alterTable: vi.fn(() => ({
        dropConstraint: vi.fn(() => ({ execute: alterExecute })),
        dropColumn: vi.fn(() => ({ execute: alterExecute })),
      })),
    },
    transaction: vi.fn(() => ({
      execute: vi.fn(async (callback: (trx: unknown) => Promise<unknown>) => callback(db)),
    })),
  };
  return {
    dropTableExecute,
    alterExecute,
    maintenanceUpdates,
    db,
  };
}

describe('MigrationLifecycleCommandsMigration rollback safety', () => {
  it.each([{ command: { id: 'mlc_existing' } }, { versionedJob: { id: 'imp_versioned' } }])(
    'refuses to erase durable lifecycle evidence',
    async (input) => {
      const fixture = rollbackDb(input);
      await expect(MigrationLifecycleCommandsMigration.down!(fixture.db as never)).rejects.toThrow(
        'Cannot roll back migration lifecycle commands while durable lifecycle evidence exists',
      );
      expect(fixture.dropTableExecute).not.toHaveBeenCalled();
    },
  );

  it('drops lifecycle storage only when no durable evidence exists', async () => {
    const fixture = rollbackDb({});
    await expect(
      MigrationLifecycleCommandsMigration.down!(fixture.db as never),
    ).resolves.toBeUndefined();
    expect(fixture.dropTableExecute).toHaveBeenCalledTimes(1);
  });
});

describe('MigrationLifecycleCommandOutcomesMigration rollback safety', () => {
  it('refuses to erase durable command completion evidence', async () => {
    const fixture = rollbackDb({ command: { id: 'mlc_completed' } });
    await expect(
      MigrationLifecycleCommandOutcomesMigration.down!(fixture.db as never),
    ).rejects.toThrow(
      'Cannot roll back migration lifecycle command outcomes while durable evidence exists',
    );
    expect(fixture.alterExecute).not.toHaveBeenCalled();
  });

  it('drops the completion marker only when no durable outcome exists', async () => {
    const fixture = rollbackDb({});
    await expect(
      MigrationLifecycleCommandOutcomesMigration.down!(fixture.db as never),
    ).resolves.toBeUndefined();
    expect(fixture.alterExecute).toHaveBeenCalledTimes(2);
  });
});

describe('PaymentAccountRefreshGenerationMigration rollback safety', () => {
  it('refuses to erase durable refresh claims', async () => {
    const fixture = rollbackDb({ refreshClaim: { id: 'pa_claimed' } });
    await expect(
      PaymentAccountRefreshGenerationMigration.down!(fixture.db as never),
    ).rejects.toThrow(
      'Cannot roll back payment account refresh generations while durable claims exist',
    );
    expect(fixture.maintenanceUpdates).toEqual([1, 0]);
    expect(fixture.alterExecute).not.toHaveBeenCalled();
  });

  it('drops the generation only when no durable refresh claim exists', async () => {
    const fixture = rollbackDb({});
    await expect(
      PaymentAccountRefreshGenerationMigration.down!(fixture.db as never),
    ).resolves.toBeUndefined();
    expect(fixture.maintenanceUpdates).toEqual([1]);
    expect(fixture.alterExecute).toHaveBeenCalledTimes(2);
    expect(fixture.dropTableExecute).toHaveBeenCalledTimes(1);
  });

  it('fails closed before DDL when the maintenance control is missing', async () => {
    const fixture = rollbackDb({ missingRefreshControl: true });
    await expect(
      PaymentAccountRefreshGenerationMigration.down!(fixture.db as never),
    ).rejects.toThrow('Payment account refresh maintenance control is missing');
    expect(fixture.maintenanceUpdates).toEqual([]);
    expect(fixture.alterExecute).not.toHaveBeenCalled();
  });
});
