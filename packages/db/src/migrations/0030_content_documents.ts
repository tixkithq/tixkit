import type { ColumnDataType } from 'kysely';
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

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const ContentDocumentsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('content_documents')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32))
      .addColumn('channel', varchar(32), (col) => col.notNull())
      .addColumn('key', varchar(128), (col) => col.notNull())
      .addColumn('name', varchar(160), (col) => col.notNull())
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('draft'))
      .addColumn('locale', varchar(16), (col) => col.notNull().defaultTo('en'))
      .addColumn('current_draft_version_id', varchar(32))
      .addColumn('published_version_id', varchar(32))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('content_documents_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('content_documents_org_fk', ['organization_id'], 'organizations', [
        'id',
      ])
      .addForeignKeyConstraint('content_documents_brand_fk', ['brand_id'], 'brands', ['id'])
      .addForeignKeyConstraint('content_documents_event_fk', ['event_id'], 'events', ['id'])
      .addUniqueConstraint('content_documents_scope_key_unique', [
        'tenant_id',
        'brand_id',
        'event_id',
        'channel',
        'key',
        'locale',
      ])
      .execute();

    await db.schema
      .createIndex('idx_content_documents_tenant_channel')
      .on('content_documents')
      .columns(['tenant_id', 'channel'])
      .execute();

    await db.schema
      .createTable('content_document_versions')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('document_id', varchar(32), (col) => col.notNull())
      .addColumn('version_number', 'integer', (col) => col.notNull())
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('draft'))
      .addColumn('schema_version', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('subject', varchar(256))
      .addColumn('preview_text', varchar(512))
      .addColumn('content_json', 'text', (col) => col.notNull())
      .addColumn('rendered_html', 'text')
      .addColumn('rendered_text', 'text')
      .addColumn('variables', 'text', (col) => col.notNull())
      .addColumn('validation', 'text', (col) => col.notNull())
      .addColumn('created_by', varchar(64), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('published_at', timestampType())
      .addForeignKeyConstraint(
        'content_document_versions_document_fk',
        ['document_id'],
        'content_documents',
        ['id'],
      )
      .addUniqueConstraint('content_document_versions_number_unique', [
        'document_id',
        'version_number',
      ])
      .execute();

    await db.schema
      .createIndex('idx_content_document_versions_document_status')
      .on('content_document_versions')
      .columns(['document_id', 'status'])
      .execute();

    await db.schema
      .createTable('content_assets')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('document_id', varchar(32), (col) => col.notNull())
      .addColumn('version_id', varchar(32))
      .addColumn('storage_key', varchar(512), (col) => col.notNull())
      .addColumn('content_type', varchar(128), (col) => col.notNull())
      .addColumn('bytes', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint('content_assets_document_fk', ['document_id'], 'content_documents', [
        'id',
      ])
      .addForeignKeyConstraint(
        'content_assets_version_fk',
        ['version_id'],
        'content_document_versions',
        ['id'],
      )
      .execute();

    await db.schema
      .createTable('content_render_artifacts')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('document_id', varchar(32), (col) => col.notNull())
      .addColumn('version_id', varchar(32), (col) => col.notNull())
      .addColumn('channel', varchar(32), (col) => col.notNull())
      .addColumn('output_type', varchar(32), (col) => col.notNull())
      .addColumn('artifact_ref', varchar(512), (col) => col.notNull())
      .addColumn('checksum', varchar(128), (col) => col.notNull())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'content_render_artifacts_document_fk',
        ['document_id'],
        'content_documents',
        ['id'],
      )
      .addForeignKeyConstraint(
        'content_render_artifacts_version_fk',
        ['version_id'],
        'content_document_versions',
        ['id'],
      )
      .execute();

    await db.schema
      .createTable('content_test_sends')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('document_id', varchar(32), (col) => col.notNull())
      .addColumn('version_id', varchar(32), (col) => col.notNull())
      .addColumn('channel', varchar(32), (col) => col.notNull())
      .addColumn('recipient', varchar(256), (col) => col.notNull())
      .addColumn('status', varchar(32), (col) => col.notNull())
      .addColumn('rendered_subject', varchar(256))
      .addColumn('rendered_html', 'text')
      .addColumn('rendered_text', 'text')
      .addColumn('error', 'text')
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'content_test_sends_document_fk',
        ['document_id'],
        'content_documents',
        ['id'],
      )
      .addForeignKeyConstraint(
        'content_test_sends_version_fk',
        ['version_id'],
        'content_document_versions',
        ['id'],
      )
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('content_test_sends').ifExists().execute();
    await db.schema.dropTable('content_render_artifacts').ifExists().execute();
    await db.schema.dropTable('content_assets').ifExists().execute();
    await db.schema
      .dropIndex('idx_content_document_versions_document_status')
      .on('content_document_versions')
      .ifExists()
      .execute();
    await db.schema.dropTable('content_document_versions').ifExists().execute();
    await db.schema
      .dropIndex('idx_content_documents_tenant_channel')
      .on('content_documents')
      .ifExists()
      .execute();
    await db.schema.dropTable('content_documents').ifExists().execute();
  },
};
