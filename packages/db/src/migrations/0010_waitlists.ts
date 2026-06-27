import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function timestampType(): ColumnDataType {
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

export const WaitlistsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('events')
      .addColumn('waitlist_auto_offer_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
      .addColumn('waitlist_offer_ttl_minutes', 'integer', (col) => col.notNull().defaultTo(1440))
      .execute();

    await db.schema
      .createTable('waitlist_entries')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('buyer_email', varchar(320), (col) => col.notNull())
      .addColumn('buyer_first_name', varchar(128))
      .addColumn('buyer_last_name', varchar(128))
      .addColumn('buyer_phone', varchar(64))
      .addColumn('quantity', 'integer', (col) => col.notNull())
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('joined'))
      .addColumn('offer_expires_at', timestampType())
      .addColumn('claim_token_hash', varchar(128))
      .addColumn('offered_at', timestampType())
      .addColumn('claimed_at', timestampType())
      .addColumn('cancelled_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('waitlist_entries_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('waitlist_entries_org_fk', ['organization_id'], 'organizations', ['id'])
      .addForeignKeyConstraint('waitlist_entries_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('waitlist_entries_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('waitlist_entries_ticket_type_fk', ['ticket_type_id'], 'ticket_types', ['id'])
      .execute();

    await db.schema.createIndex('idx_waitlist_entries_event').on('waitlist_entries').columns(['event_id', 'created_at']).execute();
    await db.schema.createIndex('idx_waitlist_entries_ticket_status').on('waitlist_entries').columns(['ticket_type_id', 'status', 'created_at']).execute();
    await db.schema.createIndex('idx_waitlist_entries_claim_token').on('waitlist_entries').column('claim_token_hash').unique().execute();
    await db.schema.createIndex('idx_waitlist_entries_buyer').on('waitlist_entries').columns(['ticket_type_id', 'buyer_email', 'status']).execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('waitlist_entries').ifExists().execute();
    await db.schema
      .alterTable('events')
      .dropColumn('waitlist_offer_ttl_minutes')
      .dropColumn('waitlist_auto_offer_enabled')
      .execute();
  },
};
