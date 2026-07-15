import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator } from 'kysely/migration';
import { createDb, type Database } from '../../client.js';
import { runMigrations, TixkitMigrationProvider } from '../../migrate.js';
import {
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
} from '../../repositories/index.js';

const driver = process.env.DB_INTEGRATION_DRIVER;
const url =
  driver === 'mysql'
    ? process.env.DATABASE_URL_MYSQL
    : driver === 'postgres'
      ? process.env.DATABASE_URL
      : undefined;
const enabled = Boolean(url);

(enabled ? describe.sequential : describe.skip)('0057 readiness migration rollback parity', () => {
  let db: Database;
  let migrator: Migrator;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver!;
    await runMigrations(url!);
    db = createDb(url!);
    migrator = new Migrator({ db, provider: new TixkitMigrationProvider() });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('backfills existing rows when 0063 and 0064 are rolled down and reapplied', async () => {
    const migrationNames = Object.keys(await new TixkitMigrationProvider().getMigrations());
    const migration64Index = migrationNames.indexOf('0064_organization_event_defaults');
    const migrationsToRemove = migrationNames.slice(migration64Index).toReversed();
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

    let migrationsDown = 0;
    try {
      for (const expectedName of [
        ...migrationsToRemove,
        '0063_event_checkout_configuration_revision',
      ]) {
        const down = await migrator.migrateDown();
        expect(down.error).toBeUndefined();
        expect(down.results?.at(-1)).toMatchObject({
          migrationName: expectedName,
          status: 'Success',
          direction: 'Down',
        });
        migrationsDown += 1;
      }

      const downTables = await db.introspection.getTables();
      expect(
        downTables.find((table) => table.name === 'organizations')?.columns.map((c) => c.name),
      ).not.toContain('event_defaults');
      expect(
        downTables.find((table) => table.name === 'events')?.columns.map((c) => c.name),
      ).not.toContain('checkout_configuration_updated_at');

      for (const expectedName of [
        '0063_event_checkout_configuration_revision',
        ...migrationsToRemove.toReversed(),
      ]) {
        const up = await migrator.migrateUp();
        expect(up.error).toBeUndefined();
        expect(up.results?.at(-1)).toMatchObject({
          migrationName: expectedName,
          status: 'Success',
          direction: 'Up',
        });
        migrationsDown -= 1;
      }

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
    } finally {
      while (migrationsDown > 0) {
        await migrator.migrateUp();
        migrationsDown -= 1;
      }
    }
  }, 120_000);

  it('removes and restores every readiness schema surface', async () => {
    let migrationsDown = 0;
    try {
      let readinessRemoved = false;
      while (!readinessRemoved) {
        const down = await migrator.migrateDown();
        expect(down.error).toBeUndefined();
        const result = down.results?.at(-1);
        expect(result).toMatchObject({ status: 'Success', direction: 'Down' });
        migrationsDown += 1;
        readinessRemoved = result?.migrationName === '0057_event_onboarding_readiness';
      }

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

      let readinessRestored = false;
      while (migrationsDown > 0) {
        const up = await migrator.migrateUp();
        expect(up.error).toBeUndefined();
        const result = up.results?.at(-1);
        expect(result).toMatchObject({ status: 'Success', direction: 'Up' });
        readinessRestored ||= result?.migrationName === '0057_event_onboarding_readiness';
        migrationsDown -= 1;
      }
      expect(readinessRestored).toBe(true);
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
    } finally {
      while (migrationsDown > 0) {
        await migrator.migrateUp();
        migrationsDown -= 1;
      }
    }
  }, 120_000);
});
