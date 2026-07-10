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

export const EventPublicRevisionMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'events', 'public_revision'))) {
        await sql`
          alter table events
            add column public_revision timestamp null
        `.execute(db);
      }
      await sql`
        update events
        set public_revision = updated_at
        where public_revision is null
      `.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('events', 'public_revision') is null
          alter table events add public_revision datetime2 null;
      `.execute(db);
      await sql`
        update events
        set public_revision = updated_at
        where public_revision is null;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        add column if not exists public_revision timestamp null
    `.execute(db);
    await sql`
      update events
      set public_revision = updated_at
      where public_revision is null
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlColumnExists(db, 'events', 'public_revision')) {
        await sql`alter table events drop column public_revision`.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('events', 'public_revision') is not null
          alter table events drop column public_revision;
      `.execute(db);
      return;
    }

    await sql`
      alter table events
        drop column if exists public_revision
    `.execute(db);
  },
};
