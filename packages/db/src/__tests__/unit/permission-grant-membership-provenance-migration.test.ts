import { describe, expect, it } from 'vitest';
import { TixkitMigrationProvider } from '../../migrate.js';
import { PermissionGrantMembershipProvenanceMigration } from '../../migrations/0095_permission_grant_membership_provenance.js';

describe('PermissionGrantMembershipProvenanceMigration', () => {
  it('remains registered before the current additive index migrations', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();
    expect(Object.keys(migrations).at(-1)).toBe('0100_affiliate_report_indexes');
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
