import { describe, expect, it, vi } from 'vitest';
import { MigrationLifecycleCommandsMigration } from '../../migrations/0091_migration_lifecycle_commands.js';
import { MigrationLifecycleCommandOutcomesMigration } from '../../migrations/0092_migration_lifecycle_command_outcomes.js';

function selectResult(value: { id: string } | undefined) {
  const executeTakeFirst = vi.fn(async () => value);
  return {
    select: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({ executeTakeFirst })),
      })),
      limit: vi.fn(() => ({ executeTakeFirst })),
    })),
  };
}

function rollbackDb(input: { command?: { id: string }; versionedJob?: { id: string } }) {
  const dropTableExecute = vi.fn(async () => undefined);
  const alterExecute = vi.fn(async () => undefined);
  return {
    dropTableExecute,
    alterExecute,
    db: {
      selectFrom: vi.fn((table: string) =>
        table === 'migration_lifecycle_commands'
          ? selectResult(input.command)
          : selectResult(input.versionedJob),
      ),
      schema: {
        dropTable: vi.fn(() => ({ execute: dropTableExecute })),
        alterTable: vi.fn(() => ({
          dropConstraint: vi.fn(() => ({ execute: alterExecute })),
          dropColumn: vi.fn(() => ({ execute: alterExecute })),
        })),
      },
    },
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
