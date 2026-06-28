import { sql } from 'kysely';
import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'datetime';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function jsonType(): ColumnDataType {
  if (isMysql()) return 'json';
  if (isMssql()) return 'nvarchar(max)' as ColumnDataType;

  return 'jsonb';
}

function booleanType(): ColumnDataType {
  if (isMssql()) return 'bit' as ColumnDataType;
  return 'boolean';
}

function nowDefault() {
  return isMysql() || isMssql() ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

function trueDefault() {
  return isMssql() ? sql`1` : true;
}

export const MarketingIntegrationsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('marketing_integrations')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32))
      .addColumn('provider', varchar(32), (col) => col.notNull())
      .addColumn('config', jsonType(), (col) => col.notNull())
      .addColumn('consent_required', booleanType(), (col) =>
        col.notNull().defaultTo(trueDefault()),
      )
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('active'))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('marketing_integrations_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('marketing_integrations_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('marketing_integrations_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_marketing_integrations_event')
      .on('marketing_integrations')
      .columns(['event_id', 'status'])
      .execute();
    await db.schema
      .createIndex('idx_marketing_integrations_brand')
      .on('marketing_integrations')
      .columns(['brand_id', 'status'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_marketing_integrations_brand')
      .on('marketing_integrations')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_marketing_integrations_event')
      .on('marketing_integrations')
      .ifExists()
      .execute();
    await db.schema.dropTable('marketing_integrations').ifExists().execute();
  },
};
