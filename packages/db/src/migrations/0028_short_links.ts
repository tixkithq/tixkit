import type { ColumnDataType } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function timestampType(): ColumnDataType {
  return isMysql() ? 'timestamp' : 'timestamptz';
}

function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function integerType(): ColumnDataType {
  return isMysql() ? 'integer' : 'integer';
}

export const ShortLinksMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('short_links')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32))
      .addColumn('slug', varchar(32), (col) => col.notNull())
      .addColumn('destination_url', varchar(2048), (col) => col.notNull())
      .addColumn('utm_params', varchar(1024))
      .addColumn('clicks', integerType(), (col) => col.notNull().defaultTo(0))
      .addColumn('expires_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('short_links_slug_unique', ['slug'])
      .addForeignKeyConstraint('short_links_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_short_links_slug')
      .on('short_links')
      .columns(['slug'])
      .execute();

    await db.schema
      .createTable('link_clicks')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('short_link_id', varchar(32), (col) => col.notNull())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('day_bucket', varchar(10), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('link_clicks_short_link_fk', ['short_link_id'], 'short_links', [
        'id',
      ])
      .execute();

    await db.schema
      .createIndex('idx_link_clicks_link_day')
      .on('link_clicks')
      .columns(['short_link_id', 'day_bucket'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_link_clicks_link_day').on('link_clicks').ifExists().execute();
    await db.schema.dropTable('link_clicks').ifExists().execute();
    await db.schema.dropIndex('idx_short_links_slug').on('short_links').ifExists().execute();
    await db.schema.dropTable('short_links').ifExists().execute();
  },
};
