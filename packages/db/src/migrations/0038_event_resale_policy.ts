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

export const EventResalePolicyMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'events', 'resale_enabled'))) {
        await sql`
          alter table events
            add column resale_enabled boolean not null default false
        `.execute(db);
      }
      if (!(await mysqlColumnExists(db, 'events', 'resale_max_multiplier'))) {
        await sql`
          alter table events
            add column resale_max_multiplier double not null default 1
        `.execute(db);
      }
      if (!(await mysqlColumnExists(db, 'events', 'resale_max_absolute_cents'))) {
        await sql`
          alter table events
            add column resale_max_absolute_cents bigint null
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('events', 'resale_enabled') is null
          alter table events
            add resale_enabled bit not null
            constraint events_resale_enabled_default default 0;
        if col_length('events', 'resale_max_multiplier') is null
          alter table events
            add resale_max_multiplier float not null
            constraint events_resale_max_multiplier_default default 1;
        if col_length('events', 'resale_max_absolute_cents') is null
          alter table events
            add resale_max_absolute_cents bigint null;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        add column if not exists resale_enabled boolean not null default false,
        add column if not exists resale_max_multiplier double precision not null default 1,
        add column if not exists resale_max_absolute_cents bigint null
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlColumnExists(db, 'events', 'resale_max_absolute_cents')) {
        await sql`alter table events drop column resale_max_absolute_cents`.execute(db);
      }
      if (await mysqlColumnExists(db, 'events', 'resale_max_multiplier')) {
        await sql`alter table events drop column resale_max_multiplier`.execute(db);
      }
      if (await mysqlColumnExists(db, 'events', 'resale_enabled')) {
        await sql`alter table events drop column resale_enabled`.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1 from sys.default_constraints where name = 'events_resale_enabled_default'
        )
          alter table events drop constraint events_resale_enabled_default;
        if exists (
          select 1 from sys.default_constraints where name = 'events_resale_max_multiplier_default'
        )
          alter table events drop constraint events_resale_max_multiplier_default;
        if col_length('events', 'resale_max_absolute_cents') is not null
          alter table events drop column resale_max_absolute_cents;
        if col_length('events', 'resale_max_multiplier') is not null
          alter table events drop column resale_max_multiplier;
        if col_length('events', 'resale_enabled') is not null
          alter table events drop column resale_enabled;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        drop column if exists resale_max_absolute_cents,
        drop column if exists resale_max_multiplier,
        drop column if exists resale_enabled
    `.execute(db);
  },
};
