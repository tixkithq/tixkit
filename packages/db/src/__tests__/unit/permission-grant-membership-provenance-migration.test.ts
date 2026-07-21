import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { PermissionGrantMembershipProvenanceMigration } from '../../migrations/0095_permission_grant_membership_provenance.js';

describe('PermissionGrantMembershipProvenanceMigration', () => {
  it('is registered immediately before the current additive index migration', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();
    expect(Object.keys(migrations).at(-1)).toBe('0097_product_catalog_pagination_indexes');
    expect(migrations['0095_permission_grant_membership_provenance']).toBe(
      PermissionGrantMembershipProvenanceMigration,
    );
  });

  it('refuses to discard authorization provenance during rollback', async () => {
    await expect(PermissionGrantMembershipProvenanceMigration.down!({} as never)).rejects.toThrow(
      'irreversible without an audited grant migration',
    );
  });
});
