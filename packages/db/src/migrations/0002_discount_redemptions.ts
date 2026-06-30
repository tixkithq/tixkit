import type { Migration } from 'kysely/migration';
import type { ColumnDataType } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../client.js';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'timestamp';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

export const DiscountRedemptionsMigration: Migration = {
  async up(db: Database): Promise<void> {
    await db.schema
      .createTable('discount_redemptions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('discount_code_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32))
      .addColumn('tenant_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('discount_redemptions_session_unique', ['checkout_session_id'])
      .addForeignKeyConstraint(
        'discount_redemptions_code_fk',
        ['discount_code_id'],
        'discount_codes',
        ['id'],
      )
      .addForeignKeyConstraint('discount_redemptions_event_fk', ['event_id'], 'events', ['id'])
      .execute();
  },
  async down(db: Database): Promise<void> {
    await db.schema.dropTable('discount_redemptions').ifExists().execute();
  },
};
