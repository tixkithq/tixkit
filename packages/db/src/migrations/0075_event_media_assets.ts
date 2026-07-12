import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const EventMediaAssetsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('upload_artifacts')
      .addColumn('completion_owner_token', 'varchar(64)')
      .addColumn('completion_started_at', timestampType())
      .execute();
    await db.schema
      .alterTable('upload_artifacts')
      .addUniqueConstraint('upload_artifacts_event_media_scope_unique', [
        'tenant_id',
        'organization_id',
        'brand_id',
        'event_id',
        'id',
      ])
      .execute();
    await db.schema
      .createTable('event_media_assets')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('brand_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('event_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('upload_artifact_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('role', 'varchar(32)', (column) => column.notNull())
      .addColumn('width', 'integer', (column) => column.notNull())
      .addColumn('height', 'integer', (column) => column.notNull())
      .addColumn('format', 'varchar(16)', (column) => column.notNull())
      .addColumn('checksum_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('size_bytes', 'bigint', (column) => column.notNull())
      .addColumn('focal_x', sql`decimal(6,5)`, (column) => column.notNull())
      .addColumn('focal_y', sql`decimal(6,5)`, (column) => column.notNull())
      .addColumn('alt_text', 'varchar(500)', (column) => column.notNull())
      .addColumn('created_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'event_media_assets_event_scope_fk',
        ['tenant_id', 'organization_id', 'brand_id', 'event_id'],
        'events',
        ['tenant_id', 'organization_id', 'brand_id', 'id'],
      )
      .addForeignKeyConstraint(
        'event_media_assets_upload_scope_fk',
        ['tenant_id', 'organization_id', 'brand_id', 'event_id', 'upload_artifact_id'],
        'upload_artifacts',
        ['tenant_id', 'organization_id', 'brand_id', 'event_id', 'id'],
      )
      .addUniqueConstraint('event_media_assets_event_role_unique', [
        'tenant_id',
        'organization_id',
        'brand_id',
        'event_id',
        'role',
      ])
      .execute();
    await db.schema
      .createIndex('event_media_assets_scope_idx')
      .on('event_media_assets')
      .columns(['tenant_id', 'organization_id', 'brand_id', 'event_id'])
      .execute();
    await db.schema
      .createTable('event_media_renditions')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('asset_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('variant', 'varchar(32)', (column) => column.notNull())
      .addColumn('width', 'integer', (column) => column.notNull())
      .addColumn('height', 'integer', (column) => column.notNull())
      .addColumn('format', 'varchar(16)', (column) => column.notNull())
      .addColumn('content_type', 'varchar(64)', (column) => column.notNull())
      .addColumn('bucket', 'varchar(255)', (column) => column.notNull())
      .addColumn('object_key', 'varchar(1024)', (column) => column.notNull())
      .addColumn('checksum_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('size_bytes', 'bigint', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'event_media_renditions_asset_fk',
        ['asset_id'],
        'event_media_assets',
        ['id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addUniqueConstraint('event_media_renditions_variant_unique', ['asset_id', 'variant'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('event_media_renditions').execute();
    await db.schema.dropTable('event_media_assets').execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`alter table upload_artifacts drop index upload_artifacts_event_media_scope_unique`.execute(
        db,
      );
    } else {
      await db.schema
        .alterTable('upload_artifacts')
        .dropConstraint('upload_artifacts_event_media_scope_unique')
        .execute();
    }
    await db.schema
      .alterTable('upload_artifacts')
      .dropColumn('completion_started_at')
      .dropColumn('completion_owner_token')
      .execute();
  },
};
