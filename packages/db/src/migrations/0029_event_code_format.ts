import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function jsonType(): ColumnDataType {
  return isMysql() ? 'json' : 'jsonb';
}

export const EventCodeFormatMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('events')
      .addColumn('code_format', jsonType())
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('events').dropColumn('code_format').execute();
  },
};
