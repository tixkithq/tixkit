import { describe, expect, it, vi } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { ProviderAccountCleanupCommandsMigration } from '../../migrations/0094_provider_account_cleanup_commands.js';

describe('ProviderAccountCleanupCommandsMigration', () => {
  it('remains registered immediately before membership provenance', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();
    expect(Object.keys(migrations).at(-3)).toBe('0094_provider_account_cleanup_commands');
    expect(migrations['0094_provider_account_cleanup_commands']).toBe(
      ProviderAccountCleanupCommandsMigration,
    );
  });

  it('is unconditionally irreversible so concurrent enqueue can never race a table drop', async () => {
    const db = {
      selectFrom: vi.fn(),
      schema: { dropTable: vi.fn() },
    };
    await expect(ProviderAccountCleanupCommandsMigration.down!(db as never)).rejects.toThrow(
      'irreversible without an archival migration',
    );
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.schema.dropTable).not.toHaveBeenCalled();
  });

  it('refuses rollback even when a caller claims cleanup storage is empty', async () => {
    await expect(ProviderAccountCleanupCommandsMigration.down!({} as never)).rejects.toThrow(
      'Provider account cleanup commands are irreversible without an archival migration',
    );
  });
});
