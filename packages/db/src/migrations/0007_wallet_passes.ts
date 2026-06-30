import { sql } from 'kysely';
import type { ColumnDataType, Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function textType(): ColumnDataType | Expression<unknown> {
  if (process.env.DB_DRIVER === 'mssql') return sql`nvarchar(max)`;

  return 'text';
}

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2' as ColumnDataType;

  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function jsonType(): ColumnDataType | Expression<unknown> {
  if (process.env.DB_DRIVER === 'mssql') return sql`nvarchar(max)`;

  return process.env.DB_DRIVER === 'mysql' ? 'json' : 'jsonb';
}

function nowDefault() {
  return process.env.DB_DRIVER === 'mysql' || process.env.DB_DRIVER === 'mssql'
    ? sql`CURRENT_TIMESTAMP`
    : sql`now()`;
}

export const WalletPassesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('wallet_passes')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('ticket_id', varchar(32), (col) => col.notNull())
      .addColumn('provider', varchar(20), (col) => col.notNull())
      .addColumn('status', varchar(20), (col) => col.notNull().defaultTo('active'))
      .addColumn('serial_number', varchar(128), (col) => col.notNull())
      .addColumn('pass_url', textType(), (col) => col.notNull())
      .addColumn('access_token_hash', varchar(128))
      .addColumn('content_type', varchar(100))
      .addColumn('artifact_base64', textType())
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('wallet_passes_ticket_provider_unique', ['ticket_id', 'provider'])
      .addForeignKeyConstraint('wallet_passes_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('wallet_passes_ticket_fk', ['ticket_id'], 'tickets', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_wallet_passes_tenant')
      .on('wallet_passes')
      .columns(['tenant_id'])
      .execute();
    await db.schema
      .createIndex('idx_wallet_passes_ticket')
      .on('wallet_passes')
      .columns(['ticket_id'])
      .execute();
    await db.schema
      .createIndex('idx_wallet_passes_status')
      .on('wallet_passes')
      .columns(['status'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('wallet_passes').ifExists().execute();
  },
};
