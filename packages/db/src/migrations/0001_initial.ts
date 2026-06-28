import type { Migration } from 'kysely/migration';
import type { ColumnDataType } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../client.js';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function timestampType(): ColumnDataType {
  return isMysql() ? 'timestamp' : 'timestamptz';
}

// Server-side default so the database, not the migration process clock, stamps
// rows. Works on both PostgreSQL (timestamptz) and MySQL (timestamp).
function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

function jsonType(): ColumnDataType {
  return isMysql() ? 'json' : 'jsonb';
}

function textType(): ColumnDataType {
  return 'text';
}

function booleanType(): ColumnDataType {
  return 'boolean';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const InitialMigration: Migration = {
  async up(db: Database): Promise<void> {
    // Tenants
    await db.schema
      .createTable('tenants')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('plan', varchar(50), (col) => col.notNull().defaultTo('free'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Organizations
    await db.schema
      .createTable('organizations')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('slug', varchar(255), (col) => col.notNull())
      .addColumn('clerk_organization_id', varchar(255))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('organizations_slug_tenant_unique', ['tenant_id', 'slug'])
      .addForeignKeyConstraint('organizations_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Brands
    await db.schema
      .createTable('brands')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('slug', varchar(255), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('draft'))
      .addColumn('theme', jsonType(), (col) => col.notNull())
      .addColumn('email_identity_id', varchar(32))
      .addColumn('sms_identity_id', varchar(32))
      .addColumn('payment_account_id', varchar(32))
      .addColumn('support_url', varchar(2048))
      .addColumn('legal_urls', jsonType(), (col) => col.notNull())
      .addColumn('white_label', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('brands_slug_tenant_unique', ['tenant_id', 'slug'])
      .addForeignKeyConstraint('brands_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('brands_organization_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .execute();

    // Brand Domains
    await db.schema
      .createTable('brand_domains')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('domain', varchar(255), (col) => col.notNull())
      .addColumn('is_primary', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('is_verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('verification_token', varchar(255))
      .addColumn('ssl_status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('brand_domains_domain_unique', ['domain'])
      .addForeignKeyConstraint('brand_domains_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // User Profiles
    await db.schema
      .createTable('user_profiles')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('clerk_user_id', varchar(255), (col) => col.notNull())
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('first_name', varchar(255))
      .addColumn('last_name', varchar(255))
      .addColumn('avatar_url', varchar(2048))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('last_seen_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('user_profiles_clerk_tenant_unique', ['tenant_id', 'clerk_user_id'])
      .addForeignKeyConstraint('user_profiles_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Clerk Identity Links
    await db.schema
      .createTable('clerk_identity_links')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('clerk_user_id', varchar(255), (col) => col.notNull())
      .addColumn('tixkit_user_id', varchar(32), (col) => col.notNull())
      .addColumn('clerk_organization_id', varchar(255))
      .addColumn('tixkit_organization_id', varchar(32))
      .addColumn('last_synced_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('clerk_identity_links_clerk_unique', ['clerk_user_id'])
      .execute();

    // Organization Members
    await db.schema
      .createTable('organization_members')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('user_id', varchar(32), (col) => col.notNull())
      .addColumn('role', varchar(100), (col) => col.notNull())
      .addColumn('invited_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('accepted_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('organization_members_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'organization_members_org_fk',
        ['organization_id'],
        'organizations',
        ['id'],
      )
      .addForeignKeyConstraint('organization_members_user_fk', ['user_id'], 'user_profiles', ['id'])
      .execute();

    // Roles
    await db.schema
      .createTable('roles')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(100), (col) => col.notNull())
      .addColumn('permissions', jsonType(), (col) => col.notNull())
      .addColumn('is_system', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('roles_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Permission Grants
    await db.schema
      .createTable('permission_grants')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('principal_type', varchar(50), (col) => col.notNull())
      .addColumn('principal_id', varchar(255), (col) => col.notNull())
      .addColumn('permission', varchar(100), (col) => col.notNull())
      .addColumn('scope_type', varchar(50), (col) => col.notNull())
      .addColumn('scope_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // API Keys
    await db.schema
      .createTable('api_keys')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('key_prefix', varchar(20), (col) => col.notNull())
      .addColumn('hashed_key', varchar(255), (col) => col.notNull())
      .addColumn('scopes', jsonType(), (col) => col.notNull())
      .addColumn('brand_ids', jsonType())
      .addColumn('event_ids', jsonType())
      .addColumn('last_used_at', timestampType())
      .addColumn('expires_at', timestampType())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('api_keys_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('api_keys_org_fk', ['organization_id'], 'organizations', ['id'])
      .execute();

    // Scanner Devices
    await db.schema
      .createTable('scanner_devices')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('device_id', varchar(255), (col) => col.notNull())
      .addColumn('hashed_secret', varchar(255), (col) => col.notNull())
      .addColumn('event_ids', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('last_seen_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('scanner_devices_device_id_unique', ['device_id'])
      .addForeignKeyConstraint('scanner_devices_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('scanner_devices_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .execute();

    // Audit Logs
    await db.schema
      .createTable('audit_logs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('actor_type', varchar(50), (col) => col.notNull())
      .addColumn('actor_id', varchar(255), (col) => col.notNull())
      .addColumn('action', varchar(255), (col) => col.notNull())
      .addColumn('resource_type', varchar(100), (col) => col.notNull())
      .addColumn('resource_id', varchar(32), (col) => col.notNull())
      .addColumn('diff_summary', jsonType())
      .addColumn('ip', varchar(45))
      .addColumn('user_agent', varchar(512))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('audit_logs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Events
    await db.schema
      .createTable('events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('slug', varchar(255), (col) => col.notNull())
      .addColumn('title', varchar(500), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('draft'))
      .addColumn('currency', varchar(3), (col) => col.notNull().defaultTo('USD'))
      .addColumn('timezone', varchar(100), (col) => col.notNull())
      .addColumn('starts_at', timestampType(), (col) => col.notNull())
      .addColumn('ends_at', timestampType())
      .addColumn('venue', jsonType())
      .addColumn('visibility', varchar(50), (col) => col.notNull().defaultTo('public'))
      .addColumn('seo', jsonType(), (col) => col.notNull())
      .addColumn('capacity', 'integer')
      .addColumn('cover_image_url', varchar(2048))
      .addColumn('external_url', varchar(2048))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('events_slug_tenant_unique', ['tenant_id', 'slug'])
      .addForeignKeyConstraint('events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('events_organization_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .addForeignKeyConstraint('events_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // Event Pages
    await db.schema
      .createTable('event_pages')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('locale', varchar(10), (col) => col.notNull())
      .addColumn('title', varchar(500), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('content_html', textType())
      .addColumn('is_default', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('event_pages_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Inventory Pools
    await db.schema
      .createTable('inventory_pools')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('total_capacity', 'integer', (col) => col.notNull())
      .addColumn('reserved_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('sold_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('hold_ttl_seconds', 'integer', (col) => col.notNull().defaultTo(600))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('inventory_pools_capacity_nonnegative', sql`total_capacity >= 0`)
      .addCheckConstraint(
        'inventory_pools_counts_nonnegative',
        sql`reserved_count >= 0 and sold_count >= 0`,
      )
      .addCheckConstraint(
        'inventory_pools_counts_within_capacity',
        sql`reserved_count <= total_capacity and sold_count <= total_capacity`,
      )
      .addForeignKeyConstraint('inventory_pools_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Ticket Types
    await db.schema
      .createTable('ticket_types')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('kind', varchar(50), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('draft'))
      .addColumn('visibility', varchar(50), (col) => col.notNull().defaultTo('public'))
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('price_cents', 'bigint', (col) => col.notNull())
      .addColumn('minimum_price_cents', 'bigint')
      .addColumn('sales_start_at', timestampType())
      .addColumn('sales_end_at', timestampType())
      .addColumn('min_per_order', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('max_per_order', 'integer', (col) => col.notNull().defaultTo(10))
      .addColumn('inventory_pool_id', varchar(32), (col) => col.notNull())
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('requires_access_code', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('access_code_hint', varchar(255))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('ticket_types_price_nonnegative', sql`price_cents >= 0`)
      .addCheckConstraint(
        'ticket_types_order_bounds_valid',
        sql`min_per_order >= 1 and max_per_order >= min_per_order`,
      )
      .addForeignKeyConstraint('ticket_types_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint(
        'ticket_types_inventory_pool_fk',
        ['inventory_pool_id'],
        'inventory_pools',
        ['id'],
      )
      .execute();

    // Checkout Holds
    await db.schema
      .createTable('checkout_holds')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('inventory_pool_id', varchar(32), (col) => col.notNull())
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('quantity', 'integer', (col) => col.notNull())
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('checkout_holds_quantity_positive', sql`quantity > 0`)
      .addForeignKeyConstraint('checkout_holds_pool_fk', ['inventory_pool_id'], 'inventory_pools', [
        'id',
      ])
      .addForeignKeyConstraint(
        'checkout_holds_ticket_type_fk',
        ['ticket_type_id'],
        'ticket_types',
        ['id'],
      )
      .execute();

    // Checkout Sessions
    await db.schema
      .createTable('checkout_sessions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('open'))
      .addColumn('hold_id', varchar(32), (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('cart', jsonType(), (col) => col.notNull())
      .addColumn('buyer', jsonType(), (col) => col.notNull())
      .addColumn('quote', jsonType(), (col) => col.notNull())
      .addColumn('payment_intent_id', varchar(32))
      .addColumn('order_id', varchar(32))
      .addColumn('success_url', varchar(2048))
      .addColumn('cancel_url', varchar(2048))
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('idempotency_key', varchar(255), (col) => col.notNull())
      .addColumn('client_token', varchar(255), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('checkout_sessions_idempotency_unique', ['tenant_id', 'idempotency_key'])
      .addUniqueConstraint('checkout_sessions_client_token_unique', ['client_token'])
      .addForeignKeyConstraint('checkout_sessions_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('checkout_sessions_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('checkout_sessions_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // Orders
    await db.schema
      .createTable('orders')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('order_number', varchar(50), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('draft'))
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('subtotal_cents', 'bigint', (col) => col.notNull())
      .addColumn('discount_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('tax_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('fee_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('total_cents', 'bigint', (col) => col.notNull())
      .addColumn('refunded_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('buyer_email', varchar(255), (col) => col.notNull())
      .addColumn('buyer_first_name', varchar(255))
      .addColumn('buyer_last_name', varchar(255))
      .addColumn('buyer_phone', varchar(50))
      .addColumn('payment_intent_id', varchar(32))
      .addColumn('payment_provider', varchar(50))
      .addColumn('paid_at', timestampType())
      .addColumn('refunded_at', timestampType())
      .addColumn('cancelled_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('orders_order_number_unique', ['order_number'])
      // One order per checkout session: the backstop that makes order
      // finalization idempotent under activity retries / duplicate webhooks.
      .addUniqueConstraint('orders_checkout_session_unique', ['checkout_session_id'])
      .addCheckConstraint(
        'orders_money_nonnegative',
        sql`subtotal_cents >= 0 and discount_cents >= 0 and tax_cents >= 0 and fee_cents >= 0 and total_cents >= 0 and refunded_cents >= 0`,
      )
      .addForeignKeyConstraint('orders_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('orders_organization_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .addForeignKeyConstraint('orders_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('orders_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint(
        'orders_checkout_session_fk',
        ['checkout_session_id'],
        'checkout_sessions',
        ['id'],
      )
      .execute();

    // Order Line Items
    await db.schema
      .createTable('order_line_items')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('order_id', varchar(32), (col) =>
        col.notNull().references('orders.id').onDelete('cascade'),
      )
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('attendee_id', varchar(32))
      .addColumn('description', varchar(500), (col) => col.notNull())
      .addColumn('quantity', 'integer', (col) => col.notNull())
      .addColumn('unit_price_cents', 'bigint', (col) => col.notNull())
      .addColumn('subtotal_cents', 'bigint', (col) => col.notNull())
      .addColumn('discount_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('tax_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('fee_cents', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('total_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('order_line_items_quantity_positive', sql`quantity > 0`)
      .addCheckConstraint(
        'order_line_items_money_nonnegative',
        sql`unit_price_cents >= 0 and subtotal_cents >= 0 and discount_cents >= 0 and tax_cents >= 0 and fee_cents >= 0 and total_cents >= 0`,
      )
      .addForeignKeyConstraint(
        'order_line_items_ticket_type_fk',
        ['ticket_type_id'],
        'ticket_types',
        ['id'],
      )
      .execute();

    // Attendees
    await db.schema
      .createTable('attendees')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32), (col) =>
        col.notNull().references('orders.id').onDelete('cascade'),
      )
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_id', varchar(32))
      .addColumn('first_name', varchar(255))
      .addColumn('last_name', varchar(255))
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('phone', varchar(50))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('custom_answers', jsonType())
      .addColumn('checked_in_at', timestampType())
      .addColumn('check_in_device_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('attendees_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('attendees_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('attendees_ticket_type_fk', ['ticket_type_id'], 'ticket_types', [
        'id',
      ])
      .execute();

    // Order Timeline Events
    await db.schema
      .createTable('order_timeline_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('order_id', varchar(32), (col) => col.notNull())
      .addColumn('type', varchar(100), (col) => col.notNull())
      .addColumn('description', varchar(500), (col) => col.notNull())
      .addColumn('metadata', jsonType())
      .addColumn('actor_id', varchar(255))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('timeline_order_fk', ['order_id'], 'orders', ['id'])
      .execute();

    // Tickets
    await db.schema
      .createTable('tickets')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32), (col) => col.notNull())
      .addColumn('attendee_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('valid'))
      .addColumn('code', varchar(50), (col) => col.notNull())
      .addColumn('qr_payload', textType(), (col) => col.notNull())
      .addColumn('qr_hash', varchar(255), (col) => col.notNull())
      .addColumn('transferred_to_email', varchar(255))
      .addColumn('transferred_at', timestampType())
      .addColumn('checked_in_at', timestampType())
      .addColumn('checked_in_by_device_id', varchar(32))
      .addColumn('wallet_pass_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('tickets_code_unique', ['code'])
      .addUniqueConstraint('tickets_qr_hash_unique', ['qr_hash'])
      .addForeignKeyConstraint('tickets_order_fk', ['order_id'], 'orders', ['id'])
      .addForeignKeyConstraint('tickets_attendee_fk', ['attendee_id'], 'attendees', ['id'])
      .addForeignKeyConstraint('tickets_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('tickets_ticket_type_fk', ['ticket_type_id'], 'ticket_types', ['id'])
      .execute();

    // Ticket Secrets
    await db.schema
      .createTable('ticket_secrets')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('ticket_id', varchar(32), (col) => col.notNull())
      .addColumn('key_id', varchar(100), (col) => col.notNull())
      .addColumn('encrypted_secret', textType(), (col) => col.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('ticket_secrets_ticket_fk', ['ticket_id'], 'tickets', ['id'])
      .execute();

    // Check-in Lists
    await db.schema
      .createTable('check_in_lists')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('ticket_type_ids', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('check_in_lists_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Scan Logs
    await db.schema
      .createTable('scan_logs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('check_in_list_id', varchar(32), (col) => col.notNull())
      .addColumn('device_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_id', varchar(32))
      .addColumn('qr_hash', varchar(255), (col) => col.notNull())
      .addColumn('outcome', varchar(50), (col) => col.notNull())
      .addColumn('scanned_at', timestampType(), (col) => col.notNull())
      .addColumn('synced_at', timestampType())
      .addColumn('offline', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('metadata', jsonType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('scan_logs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('scan_logs_list_fk', ['check_in_list_id'], 'check_in_lists', ['id'])
      .addForeignKeyConstraint('scan_logs_ticket_fk', ['ticket_id'], 'tickets', ['id'])
      .execute();

    // Payment Intents
    await db.schema
      .createTable('payment_intents')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32))
      .addColumn('checkout_session_id', varchar(32), (col) => col.notNull())
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_intent_id', varchar(255), (col) => col.notNull())
      .addColumn('amount_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull())
      .addColumn('client_secret', varchar(255))
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('payment_account_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('payment_intents_provider_intent_unique', [
        'provider',
        'provider_intent_id',
      ])
      .addCheckConstraint('payment_intents_amount_nonnegative', sql`amount_cents >= 0`)
      .addForeignKeyConstraint('payment_intents_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'payment_intents_session_fk',
        ['checkout_session_id'],
        'checkout_sessions',
        ['id'],
      )
      .addForeignKeyConstraint('payment_intents_order_fk', ['order_id'], 'orders', ['id'])
      .execute();

    // Refunds
    await db.schema
      .createTable('refunds')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('order_id', varchar(32), (col) => col.notNull())
      .addColumn('payment_intent_id', varchar(32))
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_refund_id', varchar(255), (col) => col.notNull())
      .addColumn('amount_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('reason', textType(), (col) => col.notNull())
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('refunds_amount_positive', sql`amount_cents > 0`)
      .addForeignKeyConstraint('refunds_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('refunds_order_fk', ['order_id'], 'orders', ['id'])
      .addForeignKeyConstraint('refunds_pi_fk', ['payment_intent_id'], 'payment_intents', ['id'])
      .addUniqueConstraint('refunds_provider_refund_unique', ['provider', 'provider_refund_id'])
      .execute();

    // Payment Events
    await db.schema
      .createTable('payment_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32))
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_event_id', varchar(255), (col) => col.notNull())
      .addColumn('event_type', varchar(100), (col) => col.notNull())
      .addColumn('raw_payload', jsonType(), (col) => col.notNull())
      .addColumn('processed_at', timestampType())
      .addColumn('idempotency_key', varchar(255), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('payment_events_provider_event_unique', [
        'provider',
        'provider_event_id',
      ])
      .addForeignKeyConstraint('payment_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Discount Codes
    await db.schema
      .createTable('discount_codes')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('code', varchar(100), (col) => col.notNull())
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('value', 'integer', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('max_uses', 'integer', (col) => col.notNull())
      .addColumn('uses_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('valid_from', timestampType())
      .addColumn('valid_until', timestampType())
      .addColumn('min_order_cents', 'bigint')
      .addColumn('max_discount_cents', 'bigint')
      .addColumn('ticket_type_ids', jsonType())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('discount_codes_event_code_unique', ['event_id', 'code'])
      .addCheckConstraint('discount_codes_value_nonnegative', sql`value >= 0`)
      .addCheckConstraint(
        'discount_codes_usage_bounds_valid',
        sql`max_uses >= 0 and uses_count >= 0 and uses_count <= max_uses`,
      )
      .addCheckConstraint(
        'discount_codes_order_bounds_nonnegative',
        sql`(min_order_cents is null or min_order_cents >= 0) and (max_discount_cents is null or max_discount_cents >= 0)`,
      )
      .addForeignKeyConstraint('discount_codes_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Tax Rules
    await db.schema
      .createTable('tax_rules')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('rate', 'integer', (col) => col.notNull())
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('applied_to', varchar(50), (col) => col.notNull())
      .addColumn('countries', jsonType())
      .addColumn('regions', jsonType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('tax_rules_rate_nonnegative', sql`rate >= 0`)
      .addForeignKeyConstraint('tax_rules_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Fee Rules
    await db.schema
      .createTable('fee_rules')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('value', 'integer', (col) => col.notNull())
      .addColumn('applied_to', varchar(50), (col) => col.notNull())
      .addColumn('absorb_into_price', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('fee_rules_value_nonnegative', sql`value >= 0`)
      .addForeignKeyConstraint('fee_rules_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Product Categories
    await db.schema
      .createTable('product_categories')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('product_categories_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    // Products
    await db.schema
      .createTable('products')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('price_cents', 'bigint', (col) => col.notNull())
      .addColumn('currency', varchar(3), (col) => col.notNull())
      .addColumn('category_id', varchar(32))
      .addColumn('max_per_order', 'integer', (col) => col.notNull().defaultTo(10))
      .addColumn('available_from', timestampType())
      .addColumn('available_until', timestampType())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint('products_price_nonnegative', sql`price_cents >= 0`)
      .addCheckConstraint('products_max_per_order_positive', sql`max_per_order >= 1`)
      .addForeignKeyConstraint('products_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('products_category_fk', ['category_id'], 'product_categories', [
        'id',
      ])
      .execute();

    // Access Rules
    await db.schema
      .createTable('access_rules')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('ticket_type_id', varchar(32), (col) => col.notNull())
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('value', varchar(255), (col) => col.notNull())
      .addColumn('max_uses', 'integer')
      .addColumn('uses_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('expires_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addCheckConstraint(
        'access_rules_usage_bounds_valid',
        sql`uses_count >= 0 and (max_uses is null or (max_uses >= 0 and uses_count <= max_uses))`,
      )
      .addForeignKeyConstraint('access_rules_ticket_type_fk', ['ticket_type_id'], 'ticket_types', [
        'id',
      ])
      .execute();

    // Questions
    await db.schema
      .createTable('questions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_type_id', varchar(32))
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('label', varchar(500), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('required', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('applies_to', varchar(50), (col) => col.notNull().defaultTo('attendee'))
      .addColumn('options', jsonType())
      .addColumn('placeholder', varchar(255))
      .addColumn('validation_pattern', varchar(500))
      .addColumn('conditional_visibility', jsonType())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('is_hidden', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('hidden_at', timestampType())
      .addColumn('deleted_at', timestampType())
      .addColumn('sort_order', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_consent_field', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('consent_text', textType())
      .addColumn('consent_version', varchar(50))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('questions_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint('questions_ticket_type_fk', ['ticket_type_id'], 'ticket_types', [
        'id',
      ])
      .execute();

    // Webhook Endpoints
    await db.schema
      .createTable('webhook_endpoints')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('url', varchar(2048), (col) => col.notNull())
      .addColumn('secret', varchar(255), (col) => col.notNull())
      .addColumn('events', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('description', textType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('webhook_endpoints_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('webhook_endpoints_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .execute();

    // Webhook Events
    await db.schema
      .createTable('webhook_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('type', varchar(100), (col) => col.notNull())
      .addColumn('payload', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('webhook_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('webhook_events_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .execute();

    // Webhook Deliveries
    await db.schema
      .createTable('webhook_deliveries')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('endpoint_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('attempt', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('status_code', 'integer')
      .addColumn('response', textType())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('delivered_at', timestampType())
      .addColumn('next_retry_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'webhook_deliveries_endpoint_fk',
        ['endpoint_id'],
        'webhook_endpoints',
        ['id'],
      )
      .addForeignKeyConstraint('webhook_deliveries_event_fk', ['event_id'], 'webhook_events', [
        'id',
      ])
      .execute();

    // Idempotency Records
    await db.schema
      .createTable('idempotency_records')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('key', varchar(255), (col) => col.notNull())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('request_hash', varchar(255), (col) => col.notNull())
      .addColumn('response_status', 'integer', (col) => col.notNull())
      .addColumn('response_body', textType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('completed'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addUniqueConstraint('idempotency_records_key_tenant_unique', ['key', 'tenant_id'])
      .execute();

    // Affiliates
    await db.schema
      .createTable('affiliates')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('code', varchar(100), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('commission_percentage', 'integer', (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Attributions
    await db.schema
      .createTable('attributions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('order_id', varchar(32), (col) => col.notNull())
      .addColumn('affiliate_id', varchar(32), (col) => col.notNull())
      .addColumn('affiliate_code', varchar(100), (col) => col.notNull())
      .addColumn('commission_cents', 'bigint', (col) => col.notNull())
      .addColumn('attributed_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Notification Templates
    await db.schema
      .createTable('notification_templates')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32))
      .addColumn('key', varchar(100), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('description', textType())
      .addColumn('category', varchar(50), (col) => col.notNull())
      .addColumn('variables', jsonType(), (col) => col.notNull())
      .addColumn('current_version_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('notification_templates_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('notification_templates_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // Notification Template Versions
    await db.schema
      .createTable('notification_template_versions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('template_id', varchar(32), (col) => col.notNull())
      .addColumn('version', 'integer', (col) => col.notNull())
      .addColumn('subject_template', textType(), (col) => col.notNull())
      .addColumn('html_template', textType(), (col) => col.notNull())
      .addColumn('text_template', textType())
      .addColumn('locale', varchar(10), (col) => col.notNull().defaultTo('en'))
      .addColumn('is_default', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('published_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'notification_template_versions_template_fk',
        ['template_id'],
        'notification_templates',
        ['id'],
      )
      .execute();

    // Email Jobs
    await db.schema
      .createTable('email_jobs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('template_key', varchar(100), (col) => col.notNull())
      .addColumn('template_version_id', varchar(32), (col) => col.notNull())
      .addColumn('to_email', varchar(255), (col) => col.notNull())
      .addColumn('to_name', varchar(255))
      .addColumn('variables', jsonType(), (col) => col.notNull())
      .addColumn('provider_route_id', varchar(32), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('queued'))
      .addColumn('priority', varchar(50), (col) => col.notNull().defaultTo('normal'))
      .addColumn('scheduled_at', timestampType())
      .addColumn('idempotency_key', varchar(255), (col) => col.notNull())
      .addColumn('workflow_id', varchar(255))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('email_jobs_idempotency_unique', ['tenant_id', 'idempotency_key'])
      .addForeignKeyConstraint('email_jobs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('email_jobs_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint(
        'email_jobs_template_version_fk',
        ['template_version_id'],
        'notification_template_versions',
        ['id'],
      )
      .execute();

    // Email Deliveries
    await db.schema
      .createTable('email_deliveries')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('job_id', varchar(32), (col) => col.notNull())
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_message_id', varchar(255))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('queued'))
      .addColumn('attempted_providers', jsonType(), (col) => col.notNull())
      .addColumn('accepted_provider', varchar(50))
      .addColumn('sent_at', timestampType())
      .addColumn('delivered_at', timestampType())
      .addColumn('bounced_at', timestampType())
      .addColumn('bounce_reason', textType())
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('email_deliveries_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('email_deliveries_job_fk', ['job_id'], 'email_jobs', ['id'])
      .execute();

    // Email Suppressions
    await db.schema
      .createTable('email_suppressions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('reason', varchar(50), (col) => col.notNull())
      .addColumn('bounce_type', varchar(50))
      .addColumn('source', varchar(255), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('email_suppressions_tenant_email_unique', ['tenant_id', 'email'])
      .execute();

    // Email Provider Routes
    await db.schema
      .createTable('email_provider_routes')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('provider_type', varchar(50), (col) => col.notNull())
      .addColumn('credentials_ref', varchar(255), (col) => col.notNull())
      .addColumn('sender_domain', varchar(255), (col) => col.notNull())
      .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_fallback', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('rate_limit_per_hour', 'integer')
      .addColumn('allowed_categories', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('smoke_send_verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('email_provider_routes_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('email_provider_routes_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // Brand Sender Identities
    await db.schema
      .createTable('brand_sender_identities')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('reply_to_email', varchar(255))
      .addColumn('verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('verified_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // SMS Sender Identities
    await db.schema
      .createTable('sms_sender_identities')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('sender', varchar(100), (col) => col.notNull())
      .addColumn('kind', varchar(50), (col) => col.notNull())
      .addColumn('provider_type', varchar(50), (col) => col.notNull())
      .addColumn('provider_sender_id', varchar(255))
      .addColumn('verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('verified_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('sms_sender_identities_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('sms_sender_identities_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    // SMS Provider Routes
    await db.schema
      .createTable('sms_provider_routes')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('provider_type', varchar(50), (col) => col.notNull())
      .addColumn('credentials_ref', varchar(255), (col) => col.notNull())
      .addColumn('sender_identity_id', varchar(32), (col) => col.notNull())
      .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('is_fallback', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('rate_limit_per_hour', 'integer')
      .addColumn('allowed_categories', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('smoke_send_verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('webhook_url', varchar(2048))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('sms_provider_routes_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('sms_provider_routes_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint(
        'sms_provider_routes_sender_fk',
        ['sender_identity_id'],
        'sms_sender_identities',
        ['id'],
      )
      .execute();

    // SMS Jobs
    await db.schema
      .createTable('sms_jobs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('to_phone', varchar(50), (col) => col.notNull())
      .addColumn('body', textType(), (col) => col.notNull())
      .addColumn('template_key', varchar(100))
      .addColumn('variables', jsonType(), (col) => col.notNull())
      .addColumn('provider_route_id', varchar(32), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('queued'))
      .addColumn('priority', varchar(50), (col) => col.notNull().defaultTo('normal'))
      .addColumn('scheduled_at', timestampType())
      .addColumn('idempotency_key', varchar(255), (col) => col.notNull())
      .addColumn('workflow_id', varchar(255))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('sms_jobs_idempotency_unique', ['tenant_id', 'idempotency_key'])
      .addForeignKeyConstraint('sms_jobs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('sms_jobs_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint(
        'sms_jobs_provider_route_fk',
        ['provider_route_id'],
        'sms_provider_routes',
        ['id'],
      )
      .execute();

    // SMS Deliveries
    await db.schema
      .createTable('sms_deliveries')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('job_id', varchar(32), (col) => col.notNull())
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_message_id', varchar(255))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('queued'))
      .addColumn('attempted_providers', jsonType(), (col) => col.notNull())
      .addColumn('accepted_provider', varchar(50))
      .addColumn('sent_at', timestampType())
      .addColumn('delivered_at', timestampType())
      .addColumn('failed_at', timestampType())
      .addColumn('failure_reason', textType())
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('sms_deliveries_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('sms_deliveries_job_fk', ['job_id'], 'sms_jobs', ['id'])
      .execute();

    // SMS Provider Events
    await db.schema
      .createTable('sms_provider_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32))
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_event_id', varchar(255), (col) => col.notNull())
      .addColumn('event_type', varchar(100), (col) => col.notNull())
      .addColumn('provider_message_id', varchar(255))
      .addColumn('raw_payload', jsonType(), (col) => col.notNull())
      .addColumn('processed_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('sms_provider_events_provider_event_unique', [
        'provider',
        'provider_event_id',
      ])
      .addForeignKeyConstraint('sms_provider_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    // Message Consent
    await db.schema
      .createTable('message_consents')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('attendee_id', varchar(32), (col) => col.notNull())
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('phone', varchar(50))
      .addColumn('email_opt_in', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('sms_opt_in', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('consent_text', textType(), (col) => col.notNull())
      .addColumn('consent_version', varchar(50), (col) => col.notNull())
      .addColumn('consented_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Export Jobs
    await db.schema
      .createTable('export_jobs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32))
      .addColumn('type', varchar(50), (col) => col.notNull())
      .addColumn('format', varchar(10), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('file_url', varchar(2048))
      .addColumn('requested_by', varchar(32), (col) => col.notNull())
      .addColumn('filters', jsonType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('completed_at', timestampType())
      .execute();

    await db.schema
      .createTable('export_job_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('export_job_id', varchar(32), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull())
      .addColumn('payload', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('export_job_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('export_job_events_job_fk', ['export_job_id'], 'export_jobs', ['id'])
      .execute();

    // Payment Accounts
    await db.schema
      .createTable('payment_accounts')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_account_id', varchar(255), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('default_currency', varchar(3), (col) => col.notNull().defaultTo('USD'))
      .addColumn('details_submitted', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('charges_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('payouts_enabled', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('requirements', jsonType())
      .addColumn('disabled_reason', varchar(255))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Deferred foreign keys: these reference tables created later in the
    // migration, so they are added via ALTER TABLE after both sides exist.
    // NOTE: orders.payment_intent_id is intentionally NOT a FK to avoid a
    // circular dependency with payment_intents.order_id -> orders.id.
    // Referential integrity is enforced via payment_intents.order_id.
    await db.schema
      .alterTable('payment_intents')
      .addForeignKeyConstraint(
        'payment_intents_payment_account_fk',
        ['payment_account_id'],
        'payment_accounts',
        ['id'],
      )
      .execute();

    // Sender Identities
    await db.schema
      .createTable('sender_identities')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('email', varchar(255), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('verified', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('provider_type', varchar(50), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .execute();

    // Feature Flags
    await db.schema
      .createTable('feature_flags')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('key', varchar(100), (col) => col.notNull())
      .addColumn('enabled', booleanType(), (col) => col.notNull().defaultTo(false))
      .addColumn('config', jsonType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('feature_flags_tenant_key_unique', ['tenant_id', 'key'])
      .execute();

    // Create indexes
    await db.schema
      .createIndex('idx_organizations_tenant')
      .on('organizations')
      .columns(['tenant_id'])
      .execute();
    await db.schema.createIndex('idx_brands_tenant').on('brands').columns(['tenant_id']).execute();
    await db.schema
      .createIndex('idx_brands_org')
      .on('brands')
      .columns(['organization_id'])
      .execute();
    await db.schema.createIndex('idx_events_tenant').on('events').columns(['tenant_id']).execute();
    await db.schema
      .createIndex('idx_events_org')
      .on('events')
      .columns(['organization_id'])
      .execute();
    await db.schema.createIndex('idx_events_brand').on('events').columns(['brand_id']).execute();
    await db.schema.createIndex('idx_events_status').on('events').columns(['status']).execute();
    await db.schema
      .createIndex('idx_ticket_types_event')
      .on('ticket_types')
      .columns(['event_id'])
      .execute();
    await db.schema
      .createIndex('idx_inventory_pools_event')
      .on('inventory_pools')
      .columns(['event_id'])
      .execute();
    await db.schema
      .createIndex('idx_checkout_sessions_event')
      .on('checkout_sessions')
      .columns(['event_id'])
      .execute();
    await db.schema
      .createIndex('idx_checkout_sessions_status')
      .on('checkout_sessions')
      .columns(['status'])
      .execute();
    await db.schema.createIndex('idx_orders_event').on('orders').columns(['event_id']).execute();
    await db.schema.createIndex('idx_orders_status').on('orders').columns(['status']).execute();
    await db.schema.createIndex('idx_orders_tenant').on('orders').columns(['tenant_id']).execute();
    await db.schema
      .createIndex('idx_attendees_event')
      .on('attendees')
      .columns(['event_id'])
      .execute();
    await db.schema
      .createIndex('idx_attendees_order')
      .on('attendees')
      .columns(['order_id'])
      .execute();
    await db.schema.createIndex('idx_tickets_event').on('tickets').columns(['event_id']).execute();
    await db.schema.createIndex('idx_tickets_order').on('tickets').columns(['order_id']).execute();
    await db.schema
      .createIndex('idx_tickets_attendee')
      .on('tickets')
      .columns(['attendee_id'])
      .execute();
    await db.schema
      .createIndex('idx_checkout_holds_pool')
      .on('checkout_holds')
      .columns(['inventory_pool_id'])
      .execute();
    await db.schema
      .createIndex('idx_checkout_holds_status')
      .on('checkout_holds')
      .columns(['status'])
      .execute();
    await db.schema
      .createIndex('idx_checkout_holds_expires')
      .on('checkout_holds')
      .columns(['expires_at'])
      .execute();
    await db.schema
      .createIndex('idx_scan_logs_list')
      .on('scan_logs')
      .columns(['check_in_list_id'])
      .execute();
    await db.schema
      .createIndex('idx_payment_events_idem')
      .on('payment_events')
      .columns(['idempotency_key'])
      .execute();
    await db.schema
      .createIndex('idx_audit_logs_tenant')
      .on('audit_logs')
      .columns(['tenant_id'])
      .execute();
    await db.schema
      .createIndex('idx_audit_logs_resource')
      .on('audit_logs')
      .columns(['resource_id'])
      .execute();
    await db.schema
      .createIndex('idx_export_jobs_tenant')
      .on('export_jobs')
      .columns(['tenant_id'])
      .execute();
    await db.schema
      .createIndex('idx_export_job_events_replay')
      .on('export_job_events')
      .columns(['tenant_id', 'export_job_id', 'id'])
      .execute();

    // OAuth Applications
    await db.schema
      .createTable('oauth_applications')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('name', varchar(255), (col) => col.notNull())
      .addColumn('client_id', varchar(100), (col) => col.notNull())
      .addColumn('client_secret_hash', varchar(255), (col) => col.notNull())
      .addColumn('redirect_uris', jsonType(), (col) => col.notNull())
      .addColumn('scopes', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('oauth_applications_client_id_unique', ['client_id'])
      .addForeignKeyConstraint('oauth_applications_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('oauth_applications_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .execute();
  },

  async down(db: Database): Promise<void> {
    const tables = [
      'oauth_applications',
      'feature_flags',
      'sender_identities',
      'payment_accounts',
      'export_job_events',
      'export_jobs',
      'message_consents',
      'sms_provider_events',
      'sms_deliveries',
      'sms_jobs',
      'sms_provider_routes',
      'sms_sender_identities',
      'brand_sender_identities',
      'email_provider_routes',
      'email_suppressions',
      'email_deliveries',
      'email_jobs',
      'notification_template_versions',
      'notification_templates',
      'attributions',
      'affiliates',
      'idempotency_records',
      'webhook_deliveries',
      'webhook_events',
      'webhook_endpoints',
      'questions',
      'access_rules',
      'products',
      'product_categories',
      'fee_rules',
      'tax_rules',
      'discount_codes',
      'discount_redemptions',
      'payment_events',
      'refunds',
      'payment_intents',
      'scan_logs',
      'check_in_lists',
      'ticket_secrets',
      'tickets',
      'order_timeline_events',
      'attendees',
      'order_line_items',
      'orders',
      'checkout_sessions',
      'checkout_holds',
      'ticket_types',
      'inventory_pools',
      'event_pages',
      'events',
      'audit_logs',
      'scanner_devices',
      'api_keys',
      'permission_grants',
      'roles',
      'organization_members',
      'clerk_identity_links',
      'user_profiles',
      'brand_domains',
      'brands',
      'organizations',
      'tenants',
    ];

    // Drop tables in multiple passes so foreign-key dependency ordering
    // (including deferred/cross-dialect FKs) does not abort cleanup. Each
    // drop is independent; tables that cannot be dropped due to a remaining
    // FK reference are retried in the next pass once their dependents are
    // gone. Works on both PostgreSQL and MySQL without CASCADE.
    let remaining = [...tables];
    for (let pass = 0; pass < tables.length && remaining.length > 0; pass++) {
      const next: string[] = [];
      for (const table of remaining) {
        try {
          // eslint-disable-next-line no-await-in-loop -- down migration retries ordered drops so FK-dependent tables can be removed in later passes.
          await db.schema.dropTable(table).ifExists().execute();
        } catch {
          next.push(table);
        }
      }
      remaining = next;
    }
  },
};
