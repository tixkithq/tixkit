import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

function sha256Check() {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`external_reference_sha256 is null or external_reference_sha256 regexp '^[0-9a-f]{64}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`external_reference_sha256 is null or (
      len(external_reference_sha256) = 64
      and external_reference_sha256 collate Latin1_General_100_BIN2 not like '%[^0-9a-f]%'
    )`;
  }
  return sql`external_reference_sha256 is null or external_reference_sha256 ~ '^[0-9a-f]{64}$'`;
}

export const ResaleSettlementsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('ticket_listings')
      .addColumn('seller_terms_version', 'varchar(64)')
      .addColumn('settlement_model', 'varchar(32)')
      .addColumn('refund_model', 'varchar(32)')
      .execute();

    await db.schema
      .createTable('resale_settlements')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('listing_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('brand_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('event_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('seller_order_id', 'varchar(32)')
      .addColumn('buyer_order_id', 'varchar(32)')
      .addColumn('seller_ticket_id', 'varchar(32)')
      .addColumn('buyer_ticket_id', 'varchar(32)')
      .addColumn('currency', 'varchar(3)', (column) => column.notNull())
      .addColumn('gross_cents', 'bigint')
      .addColumn('fee_cents', 'bigint')
      .addColumn('payable_cents', 'bigint')
      .addColumn('paid_cents', 'bigint')
      .addColumn('reversed_cents', 'bigint')
      .addColumn('recovery_cents', 'bigint')
      .addColumn('state', 'varchar(32)', (column) => column.notNull())
      .addColumn('terms_version', 'varchar(64)')
      .addColumn('version', 'bigint', (column) => column.notNull().defaultTo(1))
      .addColumn('created_at', timestampType(), (column) =>
        column.notNull().defaultTo(nowDefault()),
      )
      .addColumn('updated_at', timestampType(), (column) =>
        column.notNull().defaultTo(nowDefault()),
      )
      .addUniqueConstraint('resale_settlements_listing_unique', ['listing_id'])
      .addUniqueConstraint('resale_settlements_tenant_id_unique', ['tenant_id', 'id'])
      .addCheckConstraint(
        'resale_settlements_state_valid',
        sql`state in ('pending', 'paid', 'reversed', 'recovery_required', 'review_required')`,
      )
      .addCheckConstraint(
        'resale_settlements_money_nonnegative',
        sql`(gross_cents is null or gross_cents >= 0)
          and (fee_cents is null or fee_cents >= 0)
          and (payable_cents is null or payable_cents >= 0)
          and (paid_cents is null or paid_cents >= 0)
          and (reversed_cents is null or reversed_cents >= 0)
          and (recovery_cents is null or recovery_cents >= 0)`,
      )
      .addCheckConstraint(
        'resale_settlements_runtime_money_consistent',
        sql`state = 'review_required' or (
          gross_cents is not null and fee_cents is not null and payable_cents is not null
          and paid_cents is not null and reversed_cents is not null and recovery_cents is not null
          and gross_cents = fee_cents + payable_cents
          and paid_cents <= payable_cents and reversed_cents <= payable_cents
          and recovery_cents <= reversed_cents
        )`,
      )
      .addCheckConstraint(
        'resale_settlements_state_money_consistent',
        sql`state = 'review_required' or (
          (state = 'pending' and paid_cents = 0 and reversed_cents = 0 and recovery_cents = 0)
          or (state = 'paid' and paid_cents = payable_cents and reversed_cents = 0 and recovery_cents = 0)
          or (state = 'reversed' and paid_cents = 0 and reversed_cents = payable_cents and recovery_cents = 0)
          or (state = 'recovery_required' and paid_cents = payable_cents and reversed_cents > 0 and recovery_cents = reversed_cents)
        )`,
      )
      .addForeignKeyConstraint('resale_settlements_listing_fk', ['listing_id'], 'ticket_listings', [
        'id',
      ])
      .addForeignKeyConstraint('resale_settlements_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'resale_settlements_organization_fk',
        ['organization_id'],
        'organizations',
        ['id'],
      )
      .addForeignKeyConstraint('resale_settlements_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('resale_settlements_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint(
        'resale_settlements_seller_order_fk',
        ['seller_order_id'],
        'orders',
        ['id'],
      )
      .addForeignKeyConstraint('resale_settlements_buyer_order_fk', ['buyer_order_id'], 'orders', [
        'id',
      ])
      .addForeignKeyConstraint(
        'resale_settlements_seller_ticket_fk',
        ['seller_ticket_id'],
        'tickets',
        ['id'],
      )
      .addForeignKeyConstraint(
        'resale_settlements_buyer_ticket_fk',
        ['buyer_ticket_id'],
        'tickets',
        ['id'],
      )
      .execute();

    await db.schema
      .createTable('resale_settlement_entries')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('settlement_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('kind', 'varchar(32)', (column) => column.notNull())
      .addColumn('amount_cents', 'bigint', (column) => column.notNull())
      .addColumn('currency', 'varchar(3)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(128)', (column) => column.notNull())
      .addColumn('actor_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('method', 'varchar(64)', (column) => column.notNull())
      .addColumn('external_reference_sha256', 'varchar(64)')
      .addColumn('reason', 'varchar(512)')
      .addColumn('created_at', timestampType(), (column) =>
        column.notNull().defaultTo(nowDefault()),
      )
      .addUniqueConstraint('resale_settlement_entries_idempotency_unique', [
        'settlement_id',
        'idempotency_key',
      ])
      .addCheckConstraint(
        'resale_settlement_entries_kind_valid',
        sql`kind in ('payable_accrued', 'payout_recorded', 'payable_reversed', 'recovery_required')`,
      )
      .addCheckConstraint('resale_settlement_entries_amount_positive', sql`amount_cents > 0`)
      .addCheckConstraint('resale_settlement_entries_reference_sha256', sha256Check())
      .addForeignKeyConstraint(
        'resale_settlement_entries_settlement_fk',
        ['tenant_id', 'settlement_id'],
        'resale_settlements',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint('resale_settlement_entries_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .execute();

    await db.schema
      .createIndex('resale_settlements_scope_state_idx')
      .on('resale_settlements')
      .columns(['tenant_id', 'organization_id', 'event_id', 'state', 'updated_at'])
      .execute();
    await db.schema
      .createIndex('resale_settlement_entries_settlement_created_idx')
      .on('resale_settlement_entries')
      .columns(['tenant_id', 'settlement_id', 'created_at', 'id'])
      .execute();

    await sql`
      insert into resale_settlements (
        id, listing_id, tenant_id, organization_id, brand_id, event_id,
        seller_order_id, seller_ticket_id, currency, gross_cents,
        state, terms_version, version, created_at, updated_at
      )
      select
        l.id, l.id, l.tenant_id,
        e.organization_id, e.brand_id, l.event_id, t.order_id, l.ticket_id,
        l.currency, l.price_cents, 'review_required', null, 1,
        coalesce(l.sold_at, l.updated_at), l.updated_at
      from ticket_listings l
      join events e on e.id = l.event_id and e.tenant_id = l.tenant_id
      join tickets t on t.id = l.ticket_id and t.tenant_id = l.tenant_id
      where l.status = 'sold'
    `.execute(db);

    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger resale_settlement_entries_no_update before update on resale_settlement_entries
        for each row signal sqlstate '45000' set message_text = 'resale settlement entries are immutable'`.execute(
        db,
      );
      await sql`create trigger resale_settlement_entries_no_delete before delete on resale_settlement_entries
        for each row signal sqlstate '45000' set message_text = 'resale settlement entries are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger resale_settlement_entries_immutable on resale_settlement_entries
        instead of update, delete as throw 51000, 'resale settlement entries are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create or replace function reject_resale_settlement_entry_mutation() returns trigger language plpgsql as $$
        begin raise exception 'resale settlement entries are immutable'; end $$`.execute(db);
      await sql`create trigger resale_settlement_entries_immutable before update or delete on resale_settlement_entries
        for each row execute function reject_resale_settlement_entry_mutation()`.execute(db);
    }
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('resale_settlement_entries').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql') {
      await sql`drop function if exists reject_resale_settlement_entry_mutation()`.execute(db);
    }
    await db.schema.dropTable('resale_settlements').execute();
    await db.schema
      .alterTable('ticket_listings')
      .dropColumn('refund_model')
      .dropColumn('settlement_model')
      .dropColumn('seller_terms_version')
      .execute();
  },
};
