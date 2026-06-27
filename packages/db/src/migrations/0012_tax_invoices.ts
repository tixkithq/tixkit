import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function timestampType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function jsonType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

export const TaxInvoicesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('order_tax_snapshots')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('order_id', varchar(32), (col) => col.notNull())
      .addColumn('order_line_item_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('tax_rule_id', varchar(32))
      .addColumn('tax_rule_name', varchar(255), (col) => col.notNull())
      .addColumn('rate', 'integer', (col) => col.notNull())
      .addColumn('type', varchar(32), (col) => col.notNull())
      .addColumn('applied_to', varchar(32), (col) => col.notNull())
      .addColumn('jurisdiction_country', varchar(2))
      .addColumn('jurisdiction_region', varchar(64))
      .addColumn('taxable_amount_cents', 'integer', (col) => col.notNull())
      .addColumn('tax_cents', 'integer', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('inclusive', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('provider', varchar(32), (col) => col.notNull().defaultTo('tixkit_rules'))
      .addColumn('provider_calculation_id', varchar(128))
      .addColumn('metadata', jsonType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('order_tax_snapshots_order_fk', ['order_id'], 'orders', ['id'])
      .addForeignKeyConstraint('order_tax_snapshots_line_fk', ['order_line_item_id'], 'order_line_items', ['id'])
      .addForeignKeyConstraint('order_tax_snapshots_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema.createIndex('idx_order_tax_snapshots_order').on('order_tax_snapshots').column('order_id').execute();
    await db.schema.createIndex('idx_order_tax_snapshots_event').on('order_tax_snapshots').columns(['event_id', 'created_at']).execute();

    await db.schema
      .createTable('invoices')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('order_id', varchar(32), (col) => col.notNull().unique())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('invoice_number', varchar(64), (col) => col.notNull().unique())
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('issued'))
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('subtotal_cents', 'integer', (col) => col.notNull())
      .addColumn('discount_cents', 'integer', (col) => col.notNull())
      .addColumn('tax_cents', 'integer', (col) => col.notNull())
      .addColumn('fee_cents', 'integer', (col) => col.notNull())
      .addColumn('total_cents', 'integer', (col) => col.notNull())
      .addColumn('refunded_cents', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('buyer_email', varchar(320), (col) => col.notNull())
      .addColumn('buyer_name', varchar(255))
      .addColumn('buyer_tax_id', varchar(128))
      .addColumn('seller_name', varchar(255), (col) => col.notNull())
      .addColumn('seller_tax_id', varchar(128))
      .addColumn('reverse_charge', 'boolean', (col) => col.notNull().defaultTo(false))
      .addColumn('issued_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('voided_at', timestampType())
      .addColumn('metadata', jsonType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('invoices_order_fk', ['order_id'], 'orders', ['id'])
      .addForeignKeyConstraint('invoices_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('invoices_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema.createIndex('idx_invoices_tenant').on('invoices').columns(['tenant_id', 'issued_at']).execute();
    await db.schema.createIndex('idx_invoices_event').on('invoices').columns(['event_id', 'issued_at']).execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_invoices_event').ifExists().execute();
    await db.schema.dropIndex('idx_invoices_tenant').ifExists().execute();
    await db.schema.dropTable('invoices').ifExists().execute();
    await db.schema.dropIndex('idx_order_tax_snapshots_event').ifExists().execute();
    await db.schema.dropIndex('idx_order_tax_snapshots_order').ifExists().execute();
    await db.schema.dropTable('order_tax_snapshots').ifExists().execute();
  },
};
