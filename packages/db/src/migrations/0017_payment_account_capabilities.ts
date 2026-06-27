import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function booleanType(): ColumnDataType {
  return 'boolean';
}

function jsonType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb';
}

export const PaymentAccountCapabilitiesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('payment_accounts')
      .addColumn('details_submitted', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('charges_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('payouts_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('requirements', jsonType())
      .addColumn('disabled_reason', 'varchar(255)')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('payment_accounts').dropColumn('disabled_reason').execute();
    await db.schema.alterTable('payment_accounts').dropColumn('requirements').execute();
    await db.schema.alterTable('payment_accounts').dropColumn('payouts_enabled').execute();
    await db.schema.alterTable('payment_accounts').dropColumn('charges_enabled').execute();
    await db.schema.alterTable('payment_accounts').dropColumn('details_submitted').execute();
  },
};
