import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

async function dropConstraintIfPresent(
  db: Parameters<NonNullable<Migration['down']>>[0],
  table: string,
  constraint: string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_]+$/.test(constraint)) {
    throw new Error('Unsafe migration constraint identifier');
  }
  if (process.env.DB_DRIVER === 'mysql') {
    const existing = await sql<{ count: number }>`
      select count(*) as count
      from information_schema.table_constraints
      where constraint_schema = database()
        and table_name = ${table}
        and constraint_name = ${constraint}
    `.execute(db);
    if (Number(existing.rows[0]?.count ?? 0) === 0) return;
  } else if (process.env.DB_DRIVER !== 'mssql') {
    await sql.raw(`alter table "${table}" drop constraint if exists "${constraint}"`).execute(db);
    return;
  }
  await db.schema.alterTable(table).dropConstraint(constraint).execute();
}

async function dropColumnIfPresent(
  db: Parameters<NonNullable<Migration['down']>>[0],
  table: string,
  column: string,
): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(table) || !/^[a-z0-9_]+$/.test(column)) {
    throw new Error('Unsafe migration column identifier');
  }
  if (process.env.DB_DRIVER === 'mysql') {
    const existing = await sql<{ count: number }>`
      select count(*) as count
      from information_schema.columns
      where table_schema = database()
        and table_name = ${table}
        and column_name = ${column}
    `.execute(db);
    if (Number(existing.rows[0]?.count ?? 0) === 0) return;
  } else if (process.env.DB_DRIVER !== 'mssql') {
    await sql.raw(`alter table "${table}" drop column if exists "${column}"`).execute(db);
    return;
  }
  await db.schema.alterTable(table).dropColumn(column).execute();
}

export const MigrationDomainSupportMigration: Migration = {
  async up(db) {
    await db.schema
      .alterTable('orders')
      .addUniqueConstraint('orders_migration_scope_unique', ['tenant_id', 'organization_id', 'id'])
      .execute();
    await db.schema
      .alterTable('tickets')
      .addUniqueConstraint('tickets_migration_tenant_scope_unique', ['tenant_id', 'id'])
      .execute();
    await db.schema
      .createTable('venues')
      .addColumn('id', 'varchar(64)', (c) => c.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('organization_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('name', 'varchar(255)', (c) => c.notNull())
      .addColumn('address', 'text')
      .addColumn('timezone', 'varchar(100)')
      .addColumn('created_at', timestampType(), (c) => c.notNull())
      .addColumn('updated_at', timestampType(), (c) => c.notNull())
      .addForeignKeyConstraint('venues_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'venues_org_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();
    await db.schema
      .createTable('buyers')
      .addColumn('id', 'varchar(64)', (c) => c.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('organization_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('email', 'varchar(320)', (c) => c.notNull())
      .addColumn('first_name', 'varchar(255)')
      .addColumn('last_name', 'varchar(255)')
      .addColumn('phone', 'varchar(100)')
      .addColumn('created_at', timestampType(), (c) => c.notNull())
      .addColumn('updated_at', timestampType(), (c) => c.notNull())
      .addForeignKeyConstraint('buyers_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'buyers_org_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();
    await db.schema
      .createTable('historical_financial_snapshots')
      .addColumn('id', 'varchar(64)', (c) => c.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('organization_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('order_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('kind', 'varchar(30)', (c) => c.notNull())
      .addColumn('amount_minor', 'bigint', (c) => c.notNull())
      .addColumn('currency', 'varchar(3)', (c) => c.notNull())
      .addColumn('provider_reference', 'varchar(500)')
      .addColumn('occurred_at', timestampType(), (c) => c.notNull())
      .addColumn('provenance', 'text', (c) => c.notNull())
      .addColumn('reconciliation_status', 'varchar(30)', (c) => c.notNull())
      .addColumn('created_at', timestampType(), (c) => c.notNull())
      .addForeignKeyConstraint('historical_financial_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'historical_financial_org_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'historical_financial_order_scope_fk',
        ['tenant_id', 'organization_id', 'order_id'],
        'orders',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();
    await db.schema
      .createTable('historical_check_ins')
      .addColumn('id', 'varchar(64)', (c) => c.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('organization_id', 'varchar(32)', (c) => c.notNull())
      .addColumn('ticket_id', 'varchar(64)', (c) => c.notNull())
      .addColumn('occurred_at', timestampType(), (c) => c.notNull())
      .addColumn('result', 'varchar(50)', (c) => c.notNull())
      .addColumn('provenance', 'text', (c) => c.notNull())
      .addColumn('created_at', timestampType(), (c) => c.notNull())
      .addForeignKeyConstraint('historical_checkin_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'historical_checkin_org_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'historical_checkin_ticket_tenant_scope_fk',
        ['tenant_id', 'ticket_id'],
        'tickets',
        ['tenant_id', 'id'],
      )
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`alter table attendees modify column order_id varchar(64) null`.execute(db);
    } else {
      await db.schema
        .alterTable('attendees')
        .alterColumn('order_id', (c) => c.dropNotNull())
        .execute();
    }
    await db.schema.alterTable('events').addColumn('venue_id', 'varchar(64)').execute();
    await db.schema.alterTable('event_occurrences').addColumn('venue_id', 'varchar(64)').execute();
    await db.schema
      .alterTable('events')
      .addForeignKeyConstraint('events_venue_fk', ['venue_id'], 'venues', ['id'])
      .execute();
    await db.schema
      .alterTable('event_occurrences')
      .addForeignKeyConstraint('occurrences_venue_fk', ['venue_id'], 'venues', ['id'])
      .execute();
    await db.schema
      .createIndex('idx_venues_import_scope')
      .on('venues')
      .columns(['tenant_id', 'organization_id'])
      .execute();
    await db.schema
      .createIndex('idx_buyers_import_scope')
      .on('buyers')
      .columns(['tenant_id', 'organization_id', 'email'])
      .execute();
    await db.schema
      .createIndex('idx_historical_financial_import_scope')
      .on('historical_financial_snapshots')
      .columns(['tenant_id', 'organization_id', 'order_id'])
      .execute();
    await db.schema
      .createIndex('idx_historical_checkins_import_scope')
      .on('historical_check_ins')
      .columns(['tenant_id', 'organization_id', 'ticket_id'])
      .execute();
  },
  async down(db) {
    await dropConstraintIfPresent(db, 'event_occurrences', 'occurrences_venue_fk');
    await dropConstraintIfPresent(db, 'events', 'events_venue_fk');
    await dropColumnIfPresent(db, 'event_occurrences', 'venue_id');
    await dropColumnIfPresent(db, 'events', 'venue_id');
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`alter table attendees modify column order_id varchar(64) not null`.execute(db);
    } else {
      await db.schema
        .alterTable('attendees')
        .alterColumn('order_id', (c) => c.setNotNull())
        .execute();
    }
    for (const table of [
      'historical_check_ins',
      'historical_financial_snapshots',
      'buyers',
      'venues',
    ] as const) {
      await db.schema.dropTable(table).ifExists().execute();
    }
    await dropConstraintIfPresent(db, 'tickets', 'tickets_migration_tenant_scope_unique');
    await dropConstraintIfPresent(db, 'orders', 'orders_migration_scope_unique');
  },
};
