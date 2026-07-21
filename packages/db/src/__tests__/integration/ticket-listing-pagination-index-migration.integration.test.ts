import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, TixkitMigrationProvider } from '../../migrate.js';
import { TicketListingPaginationIndexMigration } from '../../migrations/0098_ticket_listing_pagination_index.js';

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
      'Ticket-listing index proof requires a sibling database ending in _migration_test',
    );
  }
}

async function indexColumns(db: Database, indexName: string): Promise<string[]> {
  if (driver === 'mysql') {
    const result = await sql<{ columnName: string }>`
      select column_name as columnName
      from information_schema.statistics
      where table_schema = database()
        and table_name = 'ticket_listings'
        and index_name = ${indexName}
      order by seq_in_index
    `.execute(db);
    return result.rows.map((row) => row.columnName);
  }
  const result = await sql<{ indexdef: string }>`
    select indexdef
    from pg_indexes
    where schemaname = current_schema()
      and tablename = 'ticket_listings'
      and indexname = ${indexName}
  `.execute(db);
  const definition = result.rows[0]?.indexdef;
  if (!definition) return [];
  const columns = definition.match(/\(([^)]+)\)/)?.[1] ?? '';
  return columns.split(',').map((column) => column.trim().replaceAll('"', ''));
}

async function expectIndexState(db: Database, present: boolean): Promise<void> {
  await expect(indexColumns(db, 'idx_ticket_listings_event_id')).resolves.toEqual(
    present ? ['tenant_id', 'event_id', 'id'] : [],
  );
  await expect(indexColumns(db, 'idx_ticket_listings_event_status')).resolves.toEqual([
    'tenant_id',
    'event_id',
    'status',
    'created_at',
  ]);
}

async function expectMysqlIndexUsable(db: Database): Promise<void> {
  if (driver !== 'mysql') return;
  const result = await sql<Record<string, unknown>>`
    explain format=json
    select *
    from ticket_listings force index (idx_ticket_listings_event_id)
    where tenant_id = 'ten_listing_cursor'
      and event_id = 'evt_listing_cursor'
      and id > 'lst_cursor'
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
    if (node.key === 'idx_ticket_listings_event_id') return node;
    for (const child of Object.values(node)) {
      const selected = findSelectedIndex(child);
      if (selected) return selected;
    }
    return undefined;
  }

  const selected = findSelectedIndex(plan);
  expect(selected, 'MySQL did not select idx_ticket_listings_event_id').toBeDefined();
  expect(selected?.used_key_parts).toEqual(['tenant_id', 'event_id', 'id']);
}

async function createIndex(db: Database, columns: string[]): Promise<void> {
  await db.schema
    .createIndex('idx_ticket_listings_event_id')
    .on('ticket_listings')
    .columns(columns)
    .execute();
}

async function dropIndex(db: Database): Promise<void> {
  if (driver === 'mysql') {
    await db.schema.dropIndex('idx_ticket_listings_event_id').on('ticket_listings').execute();
    return;
  }
  await db.schema.dropIndex('idx_ticket_listings_event_id').execute();
}

(enabled ? describe.sequential : describe.skip)(
  `ticket-listing pagination index migration parity (real ${driver ?? 'database'})`,
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
            ? 'DATABASE_URL_MYSQL_MIGRATION_TEST is required for MySQL ticket-listing index proof'
            : 'DATABASE_URL_MIGRATION_TEST is required for PostgreSQL ticket-listing index proof',
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
      }).migrateTo('0097_product_catalog_pagination_indexes');
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
        throw new AggregateError(failures, 'Ticket-listing index migration-test cleanup failed');
      }
    }, 120_000);

    it('upgrades, rejects drift, rolls back, repairs partial states, and reapplies', async () => {
      await expectIndexState(db, false);

      const migration = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0098_ticket_listing_pagination_index');
      expect(migration.error).toBeUndefined();
      expect(migration.results?.at(-1)).toMatchObject({
        migrationName: '0098_ticket_listing_pagination_index',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);
      await expectMysqlIndexUsable(db);

      await TicketListingPaginationIndexMigration.up(db);
      await expectIndexState(db, true);

      await dropIndex(db);
      await createIndex(db, ['tenant_id', 'event_id']);
      await expect(TicketListingPaginationIndexMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [tenant_id, event_id, id]',
      );
      await expect(TicketListingPaginationIndexMigration.down!(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [tenant_id, event_id, id]',
      );
      await dropIndex(db);
      await createIndex(db, ['tenant_id', 'event_id', 'id']);

      if (driver === 'mysql') {
        await sql`
          alter table ticket_listings alter index idx_ticket_listings_event_id invisible
        `.execute(db);
      } else {
        await dropIndex(db);
        await sql`
          create index idx_ticket_listings_event_id
          on ticket_listings(tenant_id, event_id, id)
          where id <> ''
        `.execute(db);
      }
      await expect(TicketListingPaginationIndexMigration.up(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [tenant_id, event_id, id]',
      );
      await expect(TicketListingPaginationIndexMigration.down!(db)).rejects.toThrow(
        'expected an ordinary visible valid B-tree on [tenant_id, event_id, id]',
      );
      if (driver === 'mysql') {
        await sql`
          alter table ticket_listings alter index idx_ticket_listings_event_id visible
        `.execute(db);
      } else {
        await dropIndex(db);
        await createIndex(db, ['tenant_id', 'event_id', 'id']);
      }
      await expectIndexState(db, true);

      const rollback = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0097_product_catalog_pagination_indexes');
      expect(rollback.error).toBeUndefined();
      expect(rollback.results?.at(-1)).toMatchObject({
        migrationName: '0098_ticket_listing_pagination_index',
        direction: 'Down',
        status: 'Success',
      });
      await expectIndexState(db, false);
      await TicketListingPaginationIndexMigration.down!(db);
      await expectIndexState(db, false);

      await createIndex(db, ['tenant_id', 'event_id', 'id']);
      const recordRecoveredUp = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0098_ticket_listing_pagination_index');
      expect(recordRecoveredUp.error).toBeUndefined();
      expect(recordRecoveredUp.results?.at(-1)).toMatchObject({
        migrationName: '0098_ticket_listing_pagination_index',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);

      await dropIndex(db);
      await TicketListingPaginationIndexMigration.down!(db);
      const recordRecoveredDown = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0097_product_catalog_pagination_indexes');
      expect(recordRecoveredDown.error).toBeUndefined();
      expect(recordRecoveredDown.results?.at(-1)).toMatchObject({
        migrationName: '0098_ticket_listing_pagination_index',
        direction: 'Down',
        status: 'Success',
      });
      await expectIndexState(db, false);

      const finalReapply = await new Migrator({
        db,
        provider: new TixkitMigrationProvider(),
      }).migrateTo('0098_ticket_listing_pagination_index');
      expect(finalReapply.error).toBeUndefined();
      expect(finalReapply.results?.at(-1)).toMatchObject({
        migrationName: '0098_ticket_listing_pagination_index',
        direction: 'Up',
        status: 'Success',
      });
      await expectIndexState(db, true);
      await expectMysqlIndexUsable(db);
    }, 120_000);
  },
);
