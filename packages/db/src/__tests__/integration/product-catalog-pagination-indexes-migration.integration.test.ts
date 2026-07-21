import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { ProductCatalogPaginationIndexesMigration } from '../../migrations/0097_product_catalog_pagination_indexes.js';

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
      'Product-catalog index proof requires a sibling database ending in _migration_test',
    );
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

const resources = [
  {
    tableName: 'product_categories',
    indexName: 'idx_product_categories_event_id',
    cursor: 'pcat_cursor',
  },
  { tableName: 'products', indexName: 'idx_products_event_id', cursor: 'prd_cursor' },
] as const;

async function expectIndexState(db: Database, present: boolean): Promise<void> {
  for (const resource of resources) {
    await expect(indexColumns(db, resource.tableName, resource.indexName)).resolves.toEqual(
      present ? ['event_id', 'id'] : [],
    );
  }
  if (driver === 'mysql') {
    await expect(
      indexColumns(db, 'product_categories', 'product_categories_event_fk'),
    ).resolves.toEqual(present ? [] : ['event_id']);
    await expect(indexColumns(db, 'products', 'products_event_fk')).resolves.toEqual(
      present ? [] : ['event_id'],
    );
    await expect(indexColumns(db, 'products', 'products_category_fk')).resolves.toEqual([
      'category_id',
    ]);
  }
}

async function expectMysqlIndexUsable(
  db: Database,
  resource: (typeof resources)[number],
): Promise<void> {
  if (driver !== 'mysql') return;
  const result = await sql<Record<string, unknown>>`
    explain format=json
    select *
    from ${sql.table(resource.tableName)} force index (${sql.raw(resource.indexName)})
    where event_id = 'evt_product_cursor_index'
      and id > ${resource.cursor}
    order by id asc
    limit 51
  `.execute(db);
  const rawPlan = Object.values(result.rows[0] ?? {})[0];
  const plan = typeof rawPlan === 'string' ? (JSON.parse(rawPlan) as unknown) : rawPlan;

  function findSelectedIndex(value: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(value)) {
      for (const child of value) {
        const selected = findSelectedIndex(child);
        if (selected) return selected;
      }
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const node = value as Record<string, unknown>;
    if (node.key === resource.indexName) return node;
    for (const child of Object.values(node)) {
      const selected = findSelectedIndex(child);
      if (selected) return selected;
    }
    return undefined;
  }

  const selected = findSelectedIndex(plan);
  expect(selected, `MySQL did not select ${resource.indexName}`).toBeDefined();
  expect(selected?.used_key_parts).toEqual(['event_id', 'id']);
}

async function createIndex(
  db: Database,
  tableName: string,
  indexName: string,
  columns: string[],
): Promise<void> {
  await db.schema.createIndex(indexName).on(tableName).columns(columns).execute();
}

async function dropIndex(db: Database, tableName: string, indexName: string): Promise<void> {
  if (driver === 'mysql') {
    await db.schema.dropIndex(indexName).on(tableName).execute();
    return;
  }
  await db.schema.dropIndex(indexName).execute();
}

(enabled ? describe.sequential : describe.skip)(
  `product-catalog pagination index migration parity (real ${driver ?? 'database'})`,
  () => {
    let db: Database;
    let lockDb: Database;
    let lockLifetime: Promise<void> | undefined;
    let releaseLock: (() => void) | undefined;
    let previousDriver: string | undefined;

    beforeAll(async () => {
      if (!migrationTestUrl) {
        throw new Error(
          driver === 'mysql'
            ? 'DATABASE_URL_MYSQL_MIGRATION_TEST is required for MySQL product-index proof'
            : 'DATABASE_URL_MIGRATION_TEST is required for PostgreSQL product-index proof',
        );
      }
      assertDedicatedMigrationDatabase(primaryUrl!, migrationTestUrl);
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver!;
      db = createDb(migrationTestUrl);
      lockDb = createDb(migrationTestUrl);
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
            select get_lock('tixkit-migration-test-database', 30) as acquired
          `.execute(connection);
          if (Number(acquired.rows[0]?.acquired) !== 1) {
            throw new Error('Timed out acquiring the shared MySQL migration-test lock');
          }
        } else {
          await sql`select pg_advisory_lock(hashtext('tixkit-migration-test-database'))`.execute(
            connection,
          );
        }
        lockReady?.();
        await hold;
        if (driver === 'mysql') {
          await sql`select release_lock('tixkit-migration-test-database')`.execute(connection);
        } else {
          await sql`select pg_advisory_unlock(hashtext('tixkit-migration-test-database'))`.execute(
            connection,
          );
        }
      });
      await Promise.race([ready, lockLifetime]);
      await dropAllTables(db);
      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0096_event_resource_pagination_indexes');
      expect(migration.error).toBeUndefined();
    }, 120_000);

    afterAll(async () => {
      let dropFailure: unknown;
      try {
        if (db) await dropAllTables(db);
      } catch (error) {
        dropFailure = error;
      }
      releaseLock?.();
      const cleanup = await Promise.allSettled([lockLifetime, db?.destroy(), lockDb?.destroy()]);
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
      const failures = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (dropFailure !== undefined) failures.unshift(dropFailure);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Product-index migration-test cleanup failed');
      }
    }, 120_000);

    it('upgrades, rejects drift, rolls back, repairs partial states, and reapplies', async () => {
      await expectIndexState(db, false);

      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0097_product_catalog_pagination_indexes');
      expect(migration.error).toBeUndefined();
      expect(migration.results?.at(-1)).toMatchObject({
        migrationName: '0097_product_catalog_pagination_indexes',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);
      for (const resource of resources) await expectMysqlIndexUsable(db, resource);

      await ProductCatalogPaginationIndexesMigration.up(db);
      await expectIndexState(db, true);

      if (driver === 'mysql') {
        await createIndex(db, 'products', 'products_event_fk', ['event_id', 'id']);
        await expect(ProductCatalogPaginationIndexesMigration.up(db)).rejects.toThrow(
          'expected an ordinary visible valid B-tree on [event_id]',
        );
        await expect(indexColumns(db, 'products', 'idx_products_event_id')).resolves.toEqual([
          'event_id',
          'id',
        ]);
        await expect(
          indexColumns(db, 'product_categories', 'idx_product_categories_event_id'),
        ).resolves.toEqual(['event_id', 'id']);
        await dropIndex(db, 'products', 'products_event_fk');
      }

      if (driver === 'mysql') {
        await createIndex(db, 'products', 'products_event_fk', ['event_id']);
      }
      await dropIndex(db, 'products', 'idx_products_event_id');
      await createIndex(db, 'products', 'idx_products_event_id', ['event_id']);
      await expect(ProductCatalogPaginationIndexesMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [event_id, id]',
      );
      await dropIndex(db, 'products', 'idx_products_event_id');
      await createIndex(db, 'products', 'idx_products_event_id', ['event_id', 'id']);

      if (driver === 'mysql') {
        await sql`alter table products alter index idx_products_event_id invisible`.execute(db);
      } else {
        await dropIndex(db, 'products', 'idx_products_event_id');
        await sql`
          create index idx_products_event_id on products(event_id, id) where id <> ''
        `.execute(db);
      }
      await expect(ProductCatalogPaginationIndexesMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [event_id, id]',
      );
      if (driver === 'mysql') {
        await sql`alter table products alter index idx_products_event_id visible`.execute(db);
      } else {
        await dropIndex(db, 'products', 'idx_products_event_id');
        await createIndex(db, 'products', 'idx_products_event_id', ['event_id', 'id']);
      }
      await ProductCatalogPaginationIndexesMigration.up(db);
      await expectIndexState(db, true);

      const rollback = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0096_event_resource_pagination_indexes');
      expect(rollback.error).toBeUndefined();
      expect(rollback.results?.at(-1)).toMatchObject({
        migrationName: '0097_product_catalog_pagination_indexes',
        direction: 'Down',
        status: 'Success',
      });
      await expectIndexState(db, false);
      await ProductCatalogPaginationIndexesMigration.down!(db);
      await expectIndexState(db, false);

      await createIndex(db, 'products', 'idx_products_event_id', ['event_id', 'id']);
      await ProductCatalogPaginationIndexesMigration.up(db);
      await expectIndexState(db, true);
      const recordRecoveredUp = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0097_product_catalog_pagination_indexes');
      expect(recordRecoveredUp.error).toBeUndefined();
      await expectIndexState(db, true);

      const preparePartialDown = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0096_event_resource_pagination_indexes');
      expect(preparePartialDown.error).toBeUndefined();
      await ProductCatalogPaginationIndexesMigration.up(db);
      if (driver === 'mysql') {
        await createIndex(db, 'products', 'products_event_fk', ['event_id']);
      }
      await dropIndex(db, 'products', 'idx_products_event_id');
      await ProductCatalogPaginationIndexesMigration.down!(db);
      await expectIndexState(db, false);

      const finalReapply = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0097_product_catalog_pagination_indexes');
      expect(finalReapply.error).toBeUndefined();
      expect(finalReapply.results?.at(-1)).toMatchObject({
        migrationName: '0097_product_catalog_pagination_indexes',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);
    }, 120_000);
  },
);
