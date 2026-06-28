import type { ColumnDataType, Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function booleanType(): ColumnDataType {
  return 'boolean';
}

function jsonType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb';
}

async function getExistingColumns(db: Kysely<unknown>, tableName: string): Promise<Set<string>> {
  const tables = await db.introspection.getTables();
  const table = tables.find((t) => t.name === tableName);
  return new Set((table?.columns ?? []).map((c) => c.name));
}

export const PaymentAccountCapabilitiesMigration: Migration = {
  async up(db): Promise<void> {
    const existing = await getExistingColumns(db, 'payment_accounts');

    if (!existing.has('details_submitted')) {
      await db.schema
        .alterTable('payment_accounts')
        .addColumn('details_submitted', booleanType(), (col) => col.notNull().defaultTo(false))
        .execute();
    }
    if (!existing.has('charges_enabled')) {
      await db.schema
        .alterTable('payment_accounts')
        .addColumn('charges_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
        .execute();
    }
    if (!existing.has('payouts_enabled')) {
      await db.schema
        .alterTable('payment_accounts')
        .addColumn('payouts_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
        .execute();
    }
    if (!existing.has('requirements')) {
      await db.schema
        .alterTable('payment_accounts')
        .addColumn('requirements', jsonType())
        .execute();
    }
    if (!existing.has('disabled_reason')) {
      await db.schema
        .alterTable('payment_accounts')
        .addColumn('disabled_reason', 'varchar(255)')
        .execute();
    }
  },

  async down(db): Promise<void> {
    const existing = await getExistingColumns(db, 'payment_accounts');

    if (existing.has('disabled_reason')) {
      await db.schema.alterTable('payment_accounts').dropColumn('disabled_reason').execute();
    }
    if (existing.has('requirements')) {
      await db.schema.alterTable('payment_accounts').dropColumn('requirements').execute();
    }
    if (existing.has('payouts_enabled')) {
      await db.schema.alterTable('payment_accounts').dropColumn('payouts_enabled').execute();
    }
    if (existing.has('charges_enabled')) {
      await db.schema.alterTable('payment_accounts').dropColumn('charges_enabled').execute();
    }
    if (existing.has('details_submitted')) {
      await db.schema.alterTable('payment_accounts').dropColumn('details_submitted').execute();
    }
  },
};
