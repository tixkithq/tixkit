import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
];
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver
    ? allDriverCases.filter((entry) => entry.driver === requestedDriver)
    : allDriverCases
).filter((entry) => entry.url.length > 0);

if (driverCases.length === 0) {
  it.skip('test cleanup control-row integration (skipped: no PostgreSQL/MySQL URL)', () => {});
}

describe.sequential.each(driverCases)('test cleanup control rows: $driver', ({ driver, url }) => {
  let db: Database;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('restores the payment-account refresh singleton after destructive row cleanup', async () => {
    await db
      .updateTable('payment_account_refresh_control')
      .set({ maintenance: 1, updated_at: new Date() })
      .where('id', '=', 'singleton')
      .execute();

    await truncateAllData(db);

    await expect(
      db
        .selectFrom('payment_account_refresh_control')
        .select(['id', 'maintenance'])
        .where('id', '=', 'singleton')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ id: 'singleton', maintenance: 0 });
  });
});
