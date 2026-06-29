import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const OrderSalesChannelMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('orders')
      .addColumn('sales_channel', varchar(32), (col) => col.notNull().defaultTo('online'))
      .addColumn('operator_id', varchar(64))
      .addColumn('tender_type', varchar(32))
      .execute();

    await db.schema
      .alterTable('orders')
      .addCheckConstraint(
        'orders_sales_channel_valid',
        sql`sales_channel in ('online', 'box_office')`,
      )
      .execute();

    await db.schema
      .alterTable('orders')
      .addCheckConstraint(
        'orders_tender_type_valid',
        sql`tender_type is null or tender_type in ('comp', 'cash', 'manual_card')`,
      )
      .execute();

    await db.schema
      .alterTable('orders')
      .addCheckConstraint(
        'orders_box_office_attribution_required',
        sql`sales_channel <> 'box_office' or (operator_id is not null and tender_type is not null)`,
      )
      .execute();

    await db.schema
      .createIndex('idx_orders_sales_channel')
      .on('orders')
      .columns(['tenant_id', 'sales_channel'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_orders_sales_channel').on('orders').ifExists().execute();
    await db.schema
      .alterTable('orders')
      .dropConstraint('orders_box_office_attribution_required')
      .execute();
    await db.schema.alterTable('orders').dropConstraint('orders_tender_type_valid').execute();
    await db.schema.alterTable('orders').dropConstraint('orders_sales_channel_valid').execute();
    await db.schema
      .alterTable('orders')
      .dropColumn('tender_type')
      .dropColumn('operator_id')
      .dropColumn('sales_channel')
      .execute();
  },
};
