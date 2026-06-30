import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2' as ColumnDataType;

  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' || process.env.DB_DRIVER === 'mssql'
    ? sql`CURRENT_TIMESTAMP`
    : sql`now()`;
}

export const WidgetImpressionsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('widget_impressions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('visitor_hash', varchar(128), (col) => col.notNull())
      .addColumn('impression_date', varchar(10), (col) => col.notNull())
      .addColumn('source', varchar(32), (col) => col.notNull().defaultTo('widget'))
      .addColumn('tracking_id', varchar(255))
      .addColumn('affiliate_code', varchar(128))
      .addColumn('host', varchar(255))
      .addColumn('page_url', varchar(2048))
      .addColumn('referrer', varchar(2048))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('widget_impressions_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('widget_impressions_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .addForeignKeyConstraint('widget_impressions_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('widget_impressions_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_widget_impressions_event_visitor_date')
      .on('widget_impressions')
      .columns(['event_id', 'visitor_hash', 'impression_date'])
      .unique()
      .execute();
    await db.schema
      .createIndex('idx_widget_impressions_event_created')
      .on('widget_impressions')
      .columns(['event_id', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_widget_impressions_tenant')
      .on('widget_impressions')
      .columns(['tenant_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('widget_impressions').ifExists().execute();
  },
};
