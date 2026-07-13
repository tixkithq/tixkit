import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const MediaObjectCleanupJobsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('media_object_cleanup_jobs')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('bucket', 'varchar(255)', (column) => column.notNull())
      .addColumn('object_key', 'varchar(1024)', (column) => column.notNull())
      .addColumn('cleanup_identity_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('checksum_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('reason', 'varchar(64)', (column) => column.notNull())
      .addColumn('status', 'varchar(32)', (column) => column.notNull())
      .addColumn('attempts', 'integer', (column) => column.notNull())
      .addColumn('available_at', timestampType(), (column) => column.notNull())
      .addColumn('last_error', 'varchar(1000)')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addUniqueConstraint('media_object_cleanup_object_unique', ['cleanup_identity_sha256'])
      .addForeignKeyConstraint('media_object_cleanup_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'media_object_cleanup_org_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();
    await db.schema
      .createIndex('media_object_cleanup_pending_idx')
      .on('media_object_cleanup_jobs')
      .columns(['status', 'available_at'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('media_object_cleanup_jobs').execute();
  },
};
