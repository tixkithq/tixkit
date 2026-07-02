import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function mysqlColumnExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ column_exists: number }>`
    select count(*) as column_exists
    from information_schema.columns
    where table_schema = database()
      and table_name = ${tableName}
      and column_name = ${columnName}
  `.execute(db);
  return Number(result.rows[0]?.column_exists ?? 0) > 0;
}

async function mysqlIndexExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  indexName: string,
): Promise<boolean> {
  const result = await sql<{ index_exists: number }>`
    select count(*) as index_exists
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${tableName}
      and index_name = ${indexName}
  `.execute(db);
  return Number(result.rows[0]?.index_exists ?? 0) > 0;
}

export const CheckoutHoldOccurrencesMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'checkout_holds', 'event_occurrence_id'))) {
        await sql`
          alter table checkout_holds
            add column event_occurrence_id varchar(32) null
        `.execute(db);
      }
      if (!(await mysqlIndexExists(db, 'checkout_holds', 'idx_checkout_holds_occurrence'))) {
        await sql`
          create index idx_checkout_holds_occurrence
          on checkout_holds (event_occurrence_id, status, expires_at)
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('checkout_holds', 'event_occurrence_id') is null
          alter table checkout_holds add event_occurrence_id varchar(32) null;
        if not exists (
          select 1 from sys.indexes where name = 'idx_checkout_holds_occurrence'
        )
          create index idx_checkout_holds_occurrence
          on checkout_holds (event_occurrence_id, status, expires_at);
      `.execute(db);
      return;
    }

    await sql`
      alter table checkout_holds
        add column if not exists event_occurrence_id varchar(32) null
    `.execute(db);
    await sql`
      create index if not exists idx_checkout_holds_occurrence
      on checkout_holds (event_occurrence_id, status, expires_at)
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlIndexExists(db, 'checkout_holds', 'idx_checkout_holds_occurrence')) {
        await sql`drop index idx_checkout_holds_occurrence on checkout_holds`.execute(db);
      }
      if (await mysqlColumnExists(db, 'checkout_holds', 'event_occurrence_id')) {
        await sql`alter table checkout_holds drop column event_occurrence_id`.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1 from sys.indexes where name = 'idx_checkout_holds_occurrence'
        )
          drop index idx_checkout_holds_occurrence on checkout_holds;
        if col_length('checkout_holds', 'event_occurrence_id') is not null
          alter table checkout_holds drop column event_occurrence_id;
      `.execute(db);
      return;
    }

    await sql`drop index if exists idx_checkout_holds_occurrence`.execute(db);
    await sql`
      alter table checkout_holds
        drop column if exists event_occurrence_id
    `.execute(db);
  },
};
