import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { AffiliateReportIndexesMigration } from '../../migrations/0100_affiliate_report_indexes.js';

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

const indexes = [
  ['affiliates', 'idx_affiliates_tenant_organization_id', ['tenant_id', 'organization_id', 'id']],
  ['attributions', 'idx_attributions_affiliate_order_id', ['affiliate_id', 'order_id']],
] as const;

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
    throw new Error('Affiliate-report index proof requires a sibling _migration_test database');
  }
}

async function indexColumns(db: Database, tableName: string, indexName: string): Promise<string[]> {
  if (driver === 'mysql') {
    const result = await sql<{ columnName: string }>`
      select column_name as columnName
      from information_schema.statistics
      where table_schema = database()
        and table_name = ${tableName}
        and index_name = ${indexName}
      order by seq_in_index
    `.execute(db);
    return result.rows.map((row) => row.columnName);
  }
  const result = await sql<{ indexdef: string }>`
    select indexdef
    from pg_indexes
    where schemaname = current_schema()
      and tablename = ${tableName}
      and indexname = ${indexName}
  `.execute(db);
  const definition = result.rows[0]?.indexdef;
  if (!definition) return [];
  const columns = definition.match(/\(([^)]+)\)/)?.[1] ?? '';
  return columns.split(',').map((column) => column.trim().replaceAll('"', ''));
}

async function expectIndexState(db: Database, present: boolean): Promise<void> {
  for (const [tableName, indexName, columns] of indexes) {
    await expect(indexColumns(db, tableName, indexName)).resolves.toEqual(present ? columns : []);
  }
}

async function expectQueryPlan(db: Database): Promise<void> {
  if (driver === 'mysql') {
    const result = await sql<Record<string, unknown>>`
      explain
      select a.id, t.order_id
      from affiliates a force index (idx_affiliates_tenant_organization_id)
      left join attributions t force index (idx_attributions_affiliate_order_id)
        on t.affiliate_id = a.id
      left join orders o on o.id = t.order_id
      where a.tenant_id = 'tnt_affiliate_index'
        and a.organization_id = 'org_affiliate_index'
      order by a.id
    `.execute(db);
    const rows = result.rows as Array<{ key?: string | null }>;
    expect(rows.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        'idx_affiliates_tenant_organization_id',
        'idx_attributions_affiliate_order_id',
      ]),
    );
    return;
  }

  await db.connection().execute(async (connection) => {
    await sql`set enable_seqscan = off`.execute(connection);
    const result = await sql<Record<string, unknown>>`
      explain
      select a.id, t.order_id
      from affiliates a
      left join attributions t on t.affiliate_id = a.id
      left join orders o on o.id = t.order_id
      where a.tenant_id = 'tnt_affiliate_index'
        and a.organization_id = 'org_affiliate_index'
      order by a.id
    `.execute(connection);
    const plan = result.rows
      .map(
        (row) =>
          Object.values(row).find((value): value is string => typeof value === 'string') ?? '',
      )
      .join('\n');
    expect(plan).toContain('idx_affiliates_tenant_organization_id');
    expect(plan).toContain('idx_attributions_affiliate_order_id');
  });
}

(enabled ? describe.sequential : describe.skip)(
  `affiliate-report index migration parity (real ${driver ?? 'database'})`,
  () => {
    let db: Database;
    let previousDriver: string | undefined;

    beforeAll(async () => {
      assertDedicatedMigrationDatabase(primaryUrl!, migrationTestUrl!);
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver!;
      db = createDb(migrationTestUrl!);
      await dropAllTables(db);
      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0099_ticket_type_batch_hot_path_indexes');
      expect(migration.error).toBeUndefined();
    }, 120_000);

    afterAll(async () => {
      try {
        if (db) await dropAllTables(db);
      } finally {
        await db?.destroy();
        if (previousDriver === undefined) delete process.env.DB_DRIVER;
        else process.env.DB_DRIVER = previousDriver;
      }
    }, 120_000);

    it('creates usable exact indexes, rolls them back, and safely reapplies them', async () => {
      await expectIndexState(db, false);
      const migrator = new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      });
      const up = await migrator.migrateTo('0100_affiliate_report_indexes');
      expect(up.error).toBeUndefined();
      expect(up.results?.at(-1)).toMatchObject({
        migrationName: '0100_affiliate_report_indexes',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);
      await expectQueryPlan(db);
      await AffiliateReportIndexesMigration.up(db);

      const down = await migrator.migrateTo('0099_ticket_type_batch_hot_path_indexes');
      expect(down.error).toBeUndefined();
      await expectIndexState(db, false);
      await AffiliateReportIndexesMigration.down!(db);

      await AffiliateReportIndexesMigration.up(db);
      await expectIndexState(db, true);
      await expectQueryPlan(db);
    });
  },
);
