import type { Migration } from 'kysely/migration';
import type { ColumnDataType } from 'kysely';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const EventCurrencyMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('events').addColumn('currency', varchar(3), (col) => col.notNull().defaultTo('USD')).execute();
  },
  async down(db): Promise<void> {
    await db.schema.alterTable('events').dropColumn('currency').execute();
  },
};
