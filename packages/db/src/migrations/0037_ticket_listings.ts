import type { ColumnDataType } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'timestamp';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function nowDefault() {
  return isMysql() || isMssql() ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const TicketListingsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('ticket_listings')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_id', varchar(32), (col) => col.notNull())
      .addColumn('seller_id', varchar(64), (col) => col.notNull())
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('listed'))
      .addColumn('price_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('face_value_cents', 'bigint', (col) => col.notNull())
      .addColumn('sold_to_id', varchar(64))
      .addColumn('active_listing_key', varchar(64), (col) => col.notNull())
      .addColumn('expires_at', timestampType())
      .addColumn('sold_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('ticket_listings_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('ticket_listings_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('ticket_listings_ticket_fk', ['ticket_id'], 'tickets', ['id'])
      .addUniqueConstraint('ticket_listings_active_unique', ['tenant_id', 'active_listing_key'])
      .addCheckConstraint(
        'ticket_listings_status_valid',
        sql`status in ('listed', 'delisted', 'sold', 'expired')`,
      )
      .addCheckConstraint('ticket_listings_price_nonnegative', sql`price_cents >= 0`)
      .addCheckConstraint('ticket_listings_face_value_nonnegative', sql`face_value_cents >= 0`)
      .execute();

    await db.schema
      .createIndex('idx_ticket_listings_event_status')
      .on('ticket_listings')
      .columns(['tenant_id', 'event_id', 'status', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_ticket_listings_ticket')
      .on('ticket_listings')
      .columns(['tenant_id', 'ticket_id', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_ticket_listings_seller')
      .on('ticket_listings')
      .columns(['tenant_id', 'seller_id', 'created_at'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_ticket_listings_seller')
      .on('ticket_listings')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_ticket_listings_ticket')
      .on('ticket_listings')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_ticket_listings_event_status')
      .on('ticket_listings')
      .ifExists()
      .execute();
    await db.schema.dropTable('ticket_listings').ifExists().execute();
  },
};
