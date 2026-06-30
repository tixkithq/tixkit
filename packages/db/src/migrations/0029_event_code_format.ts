import { sql } from 'kysely';
import type { ColumnDataType, Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

function jsonType(): ColumnDataType | Expression<unknown> {
  if (isMysql()) return 'json';
  if (isMssql()) return sql`nvarchar(max)`;

  return 'jsonb';
}

export const EventCodeFormatMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('events').addColumn('code_format', jsonType()).execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('events').dropColumn('code_format').execute();
  },
};
