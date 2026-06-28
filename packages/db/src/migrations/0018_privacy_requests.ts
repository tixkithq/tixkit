import type { ColumnDataType } from 'kysely';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function timestampType(): ColumnDataType {
  return isMysql() ? 'timestamp' : 'timestamptz';
}

function nowDefault() {
  return sql`CURRENT_TIMESTAMP`;
}

function jsonType(): ColumnDataType {
  return isMysql() ? 'json' : 'jsonb';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const PrivacyRequestsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('audit_logs')
      .addColumn('organization_id', varchar(32))
      .addColumn('brand_id', varchar(32))
      .addColumn('request_id', varchar(64))
      .execute();

    await db.schema
      .createIndex('idx_audit_logs_scope')
      .on('audit_logs')
      .columns(['tenant_id', 'organization_id', 'brand_id', 'created_at'])
      .execute();

    await db.schema
      .createTable('privacy_requests')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('brand_id', varchar(32))
      .addColumn('request_type', varchar(32), (col) => col.notNull())
      .addColumn('subject_type', varchar(32), (col) => col.notNull())
      .addColumn('subject_id', varchar(64))
      .addColumn('subject_email', varchar(320))
      .addColumn('status', varchar(32), (col) => col.notNull().defaultTo('pending'))
      .addColumn('requested_by', varchar(255), (col) => col.notNull())
      .addColumn('result', jsonType())
      .addColumn('error', varchar(2048))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('completed_at', timestampType())
      .addForeignKeyConstraint('privacy_requests_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'privacy_requests_organization_fk',
        ['organization_id'],
        'organizations',
        ['id'],
      )
      .addForeignKeyConstraint('privacy_requests_brand_fk', ['brand_id'], 'brands', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_privacy_requests_scope')
      .on('privacy_requests')
      .columns(['tenant_id', 'organization_id', 'brand_id', 'created_at'])
      .execute();

    await db.schema
      .createIndex('idx_privacy_requests_subject')
      .on('privacy_requests')
      .columns(['tenant_id', 'subject_type', 'subject_email'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_privacy_requests_subject').ifExists().execute();
    await db.schema.dropIndex('idx_privacy_requests_scope').ifExists().execute();
    await db.schema.dropTable('privacy_requests').ifExists().execute();
    await db.schema.dropIndex('idx_audit_logs_scope').ifExists().execute();
    await db.schema.alterTable('audit_logs').dropColumn('request_id').execute();
    await db.schema.alterTable('audit_logs').dropColumn('brand_id').execute();
    await db.schema.alterTable('audit_logs').dropColumn('organization_id').execute();
  },
};
