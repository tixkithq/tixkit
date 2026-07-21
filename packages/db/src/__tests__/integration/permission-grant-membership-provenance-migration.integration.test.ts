import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { PermissionGrantMembershipProvenanceMigration } from '../../migrations/0095_permission_grant_membership_provenance.js';
import {
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
  UserProfileRepository,
} from '../../repositories/index.js';

const driver =
  process.env.DB_INTEGRATION_DRIVER === 'mysql'
    ? 'mysql'
    : process.env.DB_INTEGRATION_DRIVER === 'postgres' || process.env.DATABASE_URL
      ? 'postgres'
      : undefined;
const primaryUrl =
  driver === 'mysql'
    ? process.env.DATABASE_URL_MYSQL
    : driver === 'postgres'
      ? process.env.DATABASE_URL
      : undefined;
const migrationTestUrl =
  driver === 'mysql'
    ? process.env.DATABASE_URL_MYSQL_MIGRATION_TEST
    : driver === 'postgres'
      ? process.env.DATABASE_URL_MIGRATION_TEST
      : undefined;
const enabled = Boolean(primaryUrl && migrationTestUrl);

function assertDedicatedMigrationDatabase(primary: string, dedicated: string): void {
  const primaryDatabase = new URL(primary);
  const dedicatedDatabase = new URL(dedicated);
  if (
    primaryDatabase.protocol !== dedicatedDatabase.protocol ||
    primaryDatabase.hostname !== dedicatedDatabase.hostname ||
    primaryDatabase.port !== dedicatedDatabase.port ||
    primaryDatabase.pathname === dedicatedDatabase.pathname ||
    !dedicatedDatabase.pathname.endsWith('_migration_test')
  ) {
    throw new Error(
      'Membership-provenance migration proof requires a sibling database ending in _migration_test',
    );
  }
}

(enabled ? describe.sequential : describe.skip)(
  'permission-grant membership-provenance migration parity',
  () => {
    let db: Database;
    let previousDriver: string | undefined;

    beforeAll(async () => {
      assertDedicatedMigrationDatabase(primaryUrl!, migrationTestUrl!);
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver!;
      db = createDb(migrationTestUrl!);
    });

    beforeEach(async () => {
      await dropAllTables(db);
      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0094_provider_account_cleanup_commands');
      expect(migration.error).toBeUndefined();
      expect(migration.results?.at(-1)).toMatchObject({
        migrationName: '0094_provider_account_cleanup_commands',
        direction: 'Up',
        status: 'Success',
      });
    }, 120_000);

    afterAll(async () => {
      try {
        if (db) await dropAllTables(db);
      } finally {
        if (db) await db.destroy();
        if (previousDriver === undefined) delete process.env.DB_DRIVER;
        else process.env.DB_DRIVER = previousDriver;
      }
    });

    it('backfills exact organization grants and quarantines unknowable legacy scoped grants', async () => {
      const suffix = `${driver}_${Date.now()}`;
      const tenant = await new TenantRepository(db).create({ name: `Provenance ${suffix}` });
      const foreignTenant = await new TenantRepository(db).create({
        name: `Foreign provenance ${suffix}`,
      });
      const sourceOrganization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Source ${suffix}`,
        slug: `source-${suffix}`,
      });
      const destinationOrganization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Destination ${suffix}`,
        slug: `destination-${suffix}`,
      });
      const foreignOrganization = await new OrganizationRepository(db).create({
        tenantId: foreignTenant.id,
        name: `Foreign ${suffix}`,
        slug: `foreign-${suffix}`,
      });
      const movedBrand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: destinationOrganization.id,
        name: `Moved brand ${suffix}`,
        slug: `moved-brand-${suffix}`,
      });
      const movedEvent = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: destinationOrganization.id,
        brandId: movedBrand.id,
        slug: `moved-event-${suffix}`,
        title: 'Moved legacy event',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T00:00:00.000Z'),
      });
      const user = await new UserProfileRepository(db).create({
        tenantId: tenant.id,
        clerkUserId: `clerk-${suffix}`,
        email: `${suffix}@example.test`,
      });
      const foreignUser = await new UserProfileRepository(db).create({
        tenantId: foreignTenant.id,
        clerkUserId: `foreign-clerk-${suffix}`,
        email: `foreign-${suffix}@example.test`,
      });
      const now = new Date();
      const sourceMemberId = `mem_src_${Date.now()}`;
      const foreignMemberId = `mem_for_${Date.now()}`;
      await db
        .insertInto('organization_members')
        .values([
          {
            id: sourceMemberId,
            tenant_id: tenant.id,
            organization_id: sourceOrganization.id,
            user_id: user.id,
            role: 'admin',
            invited_at: now,
            accepted_at: now,
            created_at: now,
            updated_at: now,
          },
          {
            id: foreignMemberId,
            tenant_id: foreignTenant.id,
            organization_id: foreignOrganization.id,
            user_id: foreignUser.id,
            role: 'admin',
            invited_at: now,
            accepted_at: now,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();

      const exactOrganizationGrantId = `pg_org_${Date.now()}`;
      const movedBrandGrantId = `pg_brd_${Date.now()}`;
      const movedEventGrantId = `pg_evt_${Date.now()}`;
      const unmatchedOrganizationGrantId = `pg_unm_${Date.now()}`;
      const machineGrantId = `pg_key_${Date.now()}`;
      await db
        .insertInto('permission_grants')
        .values([
          {
            id: exactOrganizationGrantId,
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: user.id,
            permission: 'settings.write',
            scope_type: 'organization',
            scope_id: sourceOrganization.id,
            created_at: now,
            updated_at: now,
          },
          {
            id: movedBrandGrantId,
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: user.id,
            permission: 'events.write',
            scope_type: 'brand',
            scope_id: movedBrand.id,
            created_at: now,
            updated_at: now,
          },
          {
            id: movedEventGrantId,
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: user.id,
            permission: 'checkins.write',
            scope_type: 'event',
            scope_id: movedEvent.id,
            created_at: now,
            updated_at: now,
          },
          {
            id: unmatchedOrganizationGrantId,
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: user.id,
            permission: 'settings.write',
            scope_type: 'organization',
            scope_id: destinationOrganization.id,
            created_at: now,
            updated_at: now,
          },
          {
            id: machineGrantId,
            tenant_id: tenant.id,
            principal_type: 'api_key',
            principal_id: 'key_legacy',
            permission: 'events.read',
            scope_type: 'brand',
            scope_id: movedBrand.id,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();

      await PermissionGrantMembershipProvenanceMigration.up(db);

      expect(
        await db
          .selectFrom('permission_grants')
          .select(['id', 'organization_member_id'])
          .orderBy('id')
          .execute(),
      ).toEqual(
        [
          { id: machineGrantId, organization_member_id: null },
          { id: exactOrganizationGrantId, organization_member_id: sourceMemberId },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      expect(
        await db
          .selectFrom('permission_grant_provenance_quarantine')
          .select(['id', 'quarantine_reason'])
          .orderBy('id')
          .execute(),
      ).toEqual(
        [
          {
            id: movedBrandGrantId,
            quarantine_reason: 'legacy_scoped_grant_provenance_ambiguous',
          },
          {
            id: movedEventGrantId,
            quarantine_reason: 'legacy_scoped_grant_provenance_ambiguous',
          },
          {
            id: unmatchedOrganizationGrantId,
            quarantine_reason: 'legacy_organization_membership_missing',
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );

      await expect(
        db
          .insertInto('permission_grants')
          .values({
            id: `pg_bad_${Date.now()}`,
            tenant_id: tenant.id,
            principal_type: 'user',
            principal_id: user.id,
            permission: 'settings.write',
            scope_type: 'organization',
            scope_id: sourceOrganization.id,
            organization_member_id: foreignMemberId,
            created_at: now,
            updated_at: now,
          })
          .execute(),
      ).rejects.toThrow();

      await db.deleteFrom('organization_members').where('id', '=', sourceMemberId).execute();
      expect(
        await db
          .selectFrom('permission_grants')
          .select('id')
          .where('id', '=', exactOrganizationGrantId)
          .execute(),
      ).toEqual([]);
      await expect(PermissionGrantMembershipProvenanceMigration.down!(db)).rejects.toThrow(
        'irreversible without an audited grant migration',
      );
    }, 120_000);
  },
);
