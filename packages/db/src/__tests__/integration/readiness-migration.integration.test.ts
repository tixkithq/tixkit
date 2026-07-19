import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { EventOnboardingReadinessMigration } from '../../migrations/0057_event_onboarding_readiness.js';
import { EventCheckoutConfigurationRevisionMigration } from '../../migrations/0063_event_checkout_configuration_revision.js';
import { OrganizationEventDefaultsMigration } from '../../migrations/0064_organization_event_defaults.js';
import {
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
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
const enabled = Boolean(primaryUrl);

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
      'Migration rollback tests require an explicit sibling database ending in _migration_test',
    );
  }
}

(enabled ? describe.sequential : describe.skip)('readiness migration rollback parity', () => {
  let db: Database;
  let migrationDb: Kysely<unknown>;
  let lockDb: Database;
  let releaseLock: (() => void) | undefined;
  let lockLifetime: Promise<void> | undefined;

  beforeAll(async () => {
    if (!migrationTestUrl) {
      throw new Error(
        driver === 'mysql'
          ? 'DATABASE_URL_MYSQL_MIGRATION_TEST is required for MySQL rollback proof'
          : 'DATABASE_URL_MIGRATION_TEST is required for PostgreSQL rollback proof',
      );
    }
    assertDedicatedMigrationDatabase(primaryUrl!, migrationTestUrl!);
    process.env.DB_DRIVER = driver!;
    db = createDb(migrationTestUrl!);
    migrationDb = db as unknown as Kysely<unknown>;
    lockDb = createDb(migrationTestUrl!);
    let lockReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      lockReady = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    lockLifetime = lockDb.connection().execute(async (connection) => {
      if (driver === 'mysql') {
        const acquired = await sql<{ acquired: number | string }>`
          select get_lock('tixkit-readiness-migration-test', 30) as acquired
        `.execute(connection);
        if (Number(acquired.rows[0]?.acquired) !== 1)
          throw new Error('Timed out acquiring the MySQL migration-test lock');
      } else {
        await sql`select pg_advisory_lock(hashtext('tixkit-readiness-migration-test'))`.execute(
          connection,
        );
      }
      lockReady?.();
      await hold;
      if (driver === 'mysql') {
        await sql`select release_lock('tixkit-readiness-migration-test')`.execute(connection);
      } else {
        await sql`select pg_advisory_unlock(hashtext('tixkit-readiness-migration-test'))`.execute(
          connection,
        );
      }
    });
    await Promise.race([ready, lockLifetime]);
  });

  beforeEach(async () => {
    await dropAllTables(db);
  });

  afterAll(async () => {
    releaseLock?.();
    const cleanup = await Promise.allSettled([lockLifetime, db?.destroy(), lockDb?.destroy()]);
    const failures = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Migration-test cleanup failed');
  });

  it('backfills existing rows when 0063 and 0064 are rolled down and reapplied', async () => {
    const migration = await new Migrator({
      db,
      provider: new TixkitMigrationProvider(),
    }).migrateTo('0064_organization_event_defaults');
    expect(migration.error).toBeUndefined();
    expect(migration.results?.at(-1)).toMatchObject({
      migrationName: '0064_organization_event_defaults',
      status: 'Success',
      direction: 'Up',
    });
    const suffix = `${driver}_${Date.now()}`;
    const tenant = await new TenantRepository(db).create({ name: `Migration ${suffix}` });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Migration ${suffix}`,
      slug: `migration-${suffix}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      name: `Migration ${suffix}`,
      slug: `migration-${suffix}`,
    });
    const event = await new EventRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `migration-${suffix}`,
      title: 'Migration compatibility event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
    });

    await OrganizationEventDefaultsMigration.down(migrationDb);
    await EventCheckoutConfigurationRevisionMigration.down(migrationDb);

    const downTables = await db.introspection.getTables();
    expect(
      downTables.find((table) => table.name === 'organizations')?.columns.map((c) => c.name),
    ).not.toContain('event_defaults');
    expect(
      downTables.find((table) => table.name === 'events')?.columns.map((c) => c.name),
    ).not.toContain('checkout_configuration_updated_at');

    await EventCheckoutConfigurationRevisionMigration.up(migrationDb);
    await OrganizationEventDefaultsMigration.up(migrationDb);

    const restoredOrganization = await db
      .selectFrom('organizations')
      .select('event_defaults')
      .where('id', '=', organization.id)
      .executeTakeFirstOrThrow();
    const restoredEvent = await db
      .selectFrom('events')
      .select('checkout_configuration_updated_at')
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(restoredOrganization.event_defaults)).toEqual({});
    expect(restoredEvent.checkout_configuration_updated_at).toBeNull();
  }, 120_000);

  it('removes and restores every 0057 readiness schema surface', async () => {
    const migration = await new Migrator({
      db,
      provider: new TixkitMigrationProvider(),
    }).migrateTo('0057_event_onboarding_readiness');
    expect(migration.error).toBeUndefined();
    expect(migration.results?.at(-1)).toMatchObject({
      migrationName: '0057_event_onboarding_readiness',
      status: 'Success',
      direction: 'Up',
    });
    const migrateDown = EventOnboardingReadinessMigration.down;
    if (!migrateDown) throw new Error('Migration 0057 must retain its rollback implementation');
    await migrateDown(db);

    const afterDown = await db.introspection.getTables();
    expect(afterDown.some((table) => table.name === 'event_readiness_acknowledgements')).toBe(
      false,
    );
    const downEventColumns = afterDown
      .find((table) => table.name === 'events')
      ?.columns.map((column) => column.name);
    expect(downEventColumns).not.toContain('version');
    expect(downEventColumns).not.toContain('last_setup_section');
    expect(downEventColumns).not.toContain('cover_image_alt');
    expect(downEventColumns).not.toContain('seo_use_cover_image');
    expect(
      afterDown.find((table) => table.name === 'orders')?.columns.map((column) => column.name),
    ).not.toContain('is_test');
    expect(
      afterDown
        .find((table) => table.name === 'checkout_sessions')
        ?.columns.map((column) => column.name),
    ).not.toContain('is_test');

    await EventOnboardingReadinessMigration.up(migrationDb);
    const afterUp = await db.introspection.getTables();
    expect(afterUp.some((table) => table.name === 'event_readiness_acknowledgements')).toBe(true);
    const upEventColumns = afterUp
      .find((table) => table.name === 'events')
      ?.columns.map((column) => column.name);
    expect(upEventColumns).toEqual(
      expect.arrayContaining([
        'version',
        'last_setup_section',
        'cover_image_alt',
        'seo_use_cover_image',
      ]),
    );
    expect(
      afterUp.find((table) => table.name === 'orders')?.columns.map((column) => column.name),
    ).toContain('is_test');
    expect(
      afterUp
        .find((table) => table.name === 'checkout_sessions')
        ?.columns.map((column) => column.name),
    ).toContain('is_test');
  }, 120_000);
});
