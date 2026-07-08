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

export const EventFeePassThroughMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'events', 'pass_fees_to_buyer'))) {
        await sql`
          alter table events
            add column pass_fees_to_buyer boolean not null default false
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('events', 'pass_fees_to_buyer') is null
          alter table events
            add pass_fees_to_buyer bit not null
            constraint events_pass_fees_to_buyer_default default 0;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        add column if not exists pass_fees_to_buyer boolean not null default false
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlColumnExists(db, 'events', 'pass_fees_to_buyer')) {
        await sql`alter table events drop column pass_fees_to_buyer`.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1 from sys.default_constraints where name = 'events_pass_fees_to_buyer_default'
        )
          alter table events drop constraint events_pass_fees_to_buyer_default;
        if col_length('events', 'pass_fees_to_buyer') is not null
          alter table events drop column pass_fees_to_buyer;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        drop column if exists pass_fees_to_buyer
    `.execute(db);
  },
};
