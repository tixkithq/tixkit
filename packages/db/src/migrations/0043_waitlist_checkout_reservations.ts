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

export const WaitlistCheckoutReservationsMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'waitlist_entries', 'reserved_checkout_session_id'))) {
        await sql`
          alter table waitlist_entries
            add column reserved_checkout_session_id varchar(32) null
        `.execute(db);
      }
      if (!(await mysqlColumnExists(db, 'waitlist_entries', 'reserved_until'))) {
        await sql`
          alter table waitlist_entries
            add column reserved_until timestamp null
        `.execute(db);
      }
      if (!(await mysqlIndexExists(db, 'waitlist_entries', 'idx_waitlist_entries_reservation'))) {
        await sql`
          create index idx_waitlist_entries_reservation
          on waitlist_entries (tenant_id, reserved_checkout_session_id, reserved_until)
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('waitlist_entries', 'reserved_checkout_session_id') is null
          alter table waitlist_entries add reserved_checkout_session_id varchar(32) null;
        if col_length('waitlist_entries', 'reserved_until') is null
          alter table waitlist_entries add reserved_until datetime2 null;
        if not exists (
          select 1 from sys.indexes where name = 'idx_waitlist_entries_reservation'
        )
          create index idx_waitlist_entries_reservation
          on waitlist_entries (tenant_id, reserved_checkout_session_id, reserved_until);
      `.execute(db);
      return;
    }

    await sql`
      alter table waitlist_entries
        add column if not exists reserved_checkout_session_id varchar(32) null,
        add column if not exists reserved_until timestamptz null
    `.execute(db);
    await sql`
      create index if not exists idx_waitlist_entries_reservation
      on waitlist_entries (tenant_id, reserved_checkout_session_id, reserved_until)
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlIndexExists(db, 'waitlist_entries', 'idx_waitlist_entries_reservation')) {
        await sql`drop index idx_waitlist_entries_reservation on waitlist_entries`.execute(db);
      }
      if (await mysqlColumnExists(db, 'waitlist_entries', 'reserved_until')) {
        await sql`alter table waitlist_entries drop column reserved_until`.execute(db);
      }
      if (await mysqlColumnExists(db, 'waitlist_entries', 'reserved_checkout_session_id')) {
        await sql`
          alter table waitlist_entries drop column reserved_checkout_session_id
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1 from sys.indexes where name = 'idx_waitlist_entries_reservation'
        )
          drop index idx_waitlist_entries_reservation on waitlist_entries;
        if col_length('waitlist_entries', 'reserved_until') is not null
          alter table waitlist_entries drop column reserved_until;
        if col_length('waitlist_entries', 'reserved_checkout_session_id') is not null
          alter table waitlist_entries drop column reserved_checkout_session_id;
      `.execute(db);
      return;
    }

    await sql`drop index if exists idx_waitlist_entries_reservation`.execute(db);
    await sql`
      alter table waitlist_entries
        drop column if exists reserved_until,
        drop column if exists reserved_checkout_session_id
    `.execute(db);
  },
};
