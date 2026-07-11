import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Migrator } from 'kysely/migration';
import { createDb, type Database } from '../../client.js';
import { TixkitMigrationProvider } from '../../migrate.js';

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

  beforeAll(() => {
    process.env.DB_DRIVER = driver!;
    db = createDb(url!);
    migrator = new Migrator({ db, provider: new TixkitMigrationProvider() });
  });

  afterAll(async () => {
    await db?.destroy();
  });

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
