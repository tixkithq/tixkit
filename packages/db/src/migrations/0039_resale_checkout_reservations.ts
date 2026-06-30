import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function mysqlColumnExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ column_exists: number }>`
    select count(*) as column_exists
    from information_schema.columns
    where table_schema = database()
      and table_name = ${tableName}
      and column_name = ${columnName}
  `.execute(db);
  return Number(result.rows[0]?.column_exists ?? 0) > 0;
}

async function mysqlIndexExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  indexName: string,
): Promise<boolean> {
  const result = await sql<{ index_exists: number }>`
    select count(*) as index_exists
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${tableName}
      and index_name = ${indexName}
  `.execute(db);
  return Number(result.rows[0]?.index_exists ?? 0) > 0;
}

export const ResaleCheckoutReservationsMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'ticket_listings', 'reserved_checkout_session_id'))) {
        await sql`
          alter table ticket_listings
            add column reserved_checkout_session_id varchar(32) null
        `.execute(db);
      }
      if (!(await mysqlColumnExists(db, 'ticket_listings', 'reserved_until'))) {
        await sql`
          alter table ticket_listings
            add column reserved_until timestamp null
        `.execute(db);
      }
      if (!(await mysqlColumnExists(db, 'order_line_items', 'resale_listing_id'))) {
        await sql`
          alter table order_line_items
            add column resale_listing_id varchar(32) null
        `.execute(db);
      }
    } else if (isMssql()) {
      await sql`
        if col_length('ticket_listings', 'reserved_checkout_session_id') is null
          alter table ticket_listings add reserved_checkout_session_id varchar(32) null;
        if col_length('ticket_listings', 'reserved_until') is null
          alter table ticket_listings add reserved_until datetime2 null;
        if col_length('order_line_items', 'resale_listing_id') is null
          alter table order_line_items add resale_listing_id varchar(32) null;
      `.execute(db);
    } else {
      await sql`
        alter table ticket_listings
          add column if not exists reserved_checkout_session_id varchar(32) null,
          add column if not exists reserved_until timestamptz null
      `.execute(db);
      await sql`
        alter table order_line_items
          add column if not exists resale_listing_id varchar(32) null
      `.execute(db);
    }

    if (isMysql()) {
      if (!(await mysqlIndexExists(db, 'ticket_listings', 'idx_ticket_listings_reservation'))) {
        await sql`
          create index idx_ticket_listings_reservation
          on ticket_listings (tenant_id, reserved_checkout_session_id, reserved_until)
        `.execute(db);
      }
      if (!(await mysqlIndexExists(db, 'order_line_items', 'idx_order_line_items_resale_listing'))) {
        await sql`
          create index idx_order_line_items_resale_listing
          on order_line_items (resale_listing_id)
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if not exists (
          select 1 from sys.indexes where name = 'idx_ticket_listings_reservation'
        )
          create index idx_ticket_listings_reservation
          on ticket_listings (tenant_id, reserved_checkout_session_id, reserved_until);
        if not exists (
          select 1 from sys.indexes where name = 'idx_order_line_items_resale_listing'
        )
          create index idx_order_line_items_resale_listing
          on order_line_items (resale_listing_id);
      `.execute(db);
      return;
    }

    await sql`
      create index if not exists idx_ticket_listings_reservation
      on ticket_listings (tenant_id, reserved_checkout_session_id, reserved_until)
    `.execute(db);
    await sql`
      create index if not exists idx_order_line_items_resale_listing
      on order_line_items (resale_listing_id)
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlIndexExists(db, 'order_line_items', 'idx_order_line_items_resale_listing')) {
        await sql`drop index idx_order_line_items_resale_listing on order_line_items`.execute(db);
      }
      if (await mysqlIndexExists(db, 'ticket_listings', 'idx_ticket_listings_reservation')) {
        await sql`drop index idx_ticket_listings_reservation on ticket_listings`.execute(db);
      }
      if (await mysqlColumnExists(db, 'order_line_items', 'resale_listing_id')) {
        await sql`alter table order_line_items drop column resale_listing_id`.execute(db);
      }
      if (await mysqlColumnExists(db, 'ticket_listings', 'reserved_until')) {
        await sql`alter table ticket_listings drop column reserved_until`.execute(db);
      }
      if (await mysqlColumnExists(db, 'ticket_listings', 'reserved_checkout_session_id')) {
        await sql`alter table ticket_listings drop column reserved_checkout_session_id`.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1 from sys.indexes where name = 'idx_order_line_items_resale_listing'
        )
          drop index idx_order_line_items_resale_listing on order_line_items;
        if exists (
          select 1 from sys.indexes where name = 'idx_ticket_listings_reservation'
        )
          drop index idx_ticket_listings_reservation on ticket_listings;
        if col_length('order_line_items', 'resale_listing_id') is not null
          alter table order_line_items drop column resale_listing_id;
        if col_length('ticket_listings', 'reserved_until') is not null
          alter table ticket_listings drop column reserved_until;
        if col_length('ticket_listings', 'reserved_checkout_session_id') is not null
          alter table ticket_listings drop column reserved_checkout_session_id;
      `.execute(db);
      return;
    }

    await sql`drop index if exists idx_order_line_items_resale_listing`.execute(db);
    await sql`drop index if exists idx_ticket_listings_reservation`.execute(db);
    await sql`
      alter table order_line_items
        drop column if exists resale_listing_id
    `.execute(db);
    await sql`
      alter table ticket_listings
        drop column if exists reserved_until,
        drop column if exists reserved_checkout_session_id
    `.execute(db);
  },
};
