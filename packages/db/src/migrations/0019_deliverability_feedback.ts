import type { ColumnDataType, Expression } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'timestamp';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

function jsonType(): ColumnDataType | Expression<unknown> {
  if (isMysql()) return 'json';
  if (isMssql()) return sql`nvarchar(max)`;

  return 'jsonb';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const DeliverabilityFeedbackMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('email_provider_events')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32))
      .addColumn('provider', varchar(50), (col) => col.notNull())
      .addColumn('provider_event_id', varchar(255), (col) => col.notNull())
      .addColumn('event_type', varchar(100), (col) => col.notNull())
      .addColumn('provider_message_id', varchar(255))
      .addColumn('email', varchar(255))
      .addColumn('raw_payload', jsonType(), (col) => col.notNull())
      .addColumn('processed_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('email_provider_events_provider_event_unique', [
        'provider',
        'provider_event_id',
      ])
      .addForeignKeyConstraint('email_provider_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_email_provider_events_message')
      .on('email_provider_events')
      .columns(['tenant_id', 'provider_message_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_email_provider_events_message')
      .on('email_provider_events')
      .ifExists()
      .execute();
    await db.schema.dropTable('email_provider_events').ifExists().execute();
  },
};
