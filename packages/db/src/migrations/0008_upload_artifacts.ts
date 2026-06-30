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

export const UploadArtifactsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('upload_artifacts')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32))
      .addColumn('brand_id', varchar(32))
      .addColumn('event_id', varchar(32))
      .addColumn('created_by_user_id', varchar(32))
      .addColumn('purpose', varchar(50), (col) => col.notNull())
      .addColumn('status', varchar(30), (col) => col.notNull().defaultTo('pending'))
      .addColumn('scan_status', varchar(30), (col) => col.notNull().defaultTo('pending'))
      .addColumn('scan_result', textType())
      .addColumn('bucket', varchar(255), (col) => col.notNull())
      .addColumn('object_key', varchar(1024), (col) => col.notNull())
      .addColumn('file_name', varchar(255), (col) => col.notNull())
      .addColumn('content_type', varchar(255), (col) => col.notNull())
      .addColumn('size_bytes', 'integer', (col) => col.notNull())
      .addColumn('checksum_sha256', varchar(128))
      .addColumn('client_token_hash', varchar(128))
      .addColumn('metadata', jsonType(), (col) => col.notNull())
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('upload_artifacts_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('upload_artifacts_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .addForeignKeyConstraint('upload_artifacts_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('upload_artifacts_event_fk', ['event_id'], 'events', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_upload_artifacts_tenant')
      .on('upload_artifacts')
      .columns(['tenant_id'])
      .execute();
    await db.schema
      .createIndex('idx_upload_artifacts_event')
      .on('upload_artifacts')
      .columns(['event_id'])
      .execute();
    await db.schema
      .createIndex('idx_upload_artifacts_brand')
      .on('upload_artifacts')
      .columns(['brand_id'])
      .execute();
    await db.schema
      .createIndex('idx_upload_artifacts_status')
      .on('upload_artifacts')
      .columns(['status'])
      .execute();
    await db.schema
      .createIndex('idx_upload_artifacts_status_expires')
      .on('upload_artifacts')
      .columns(['status', 'expires_at'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('upload_artifacts').ifExists().execute();
  },
};
