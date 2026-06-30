import { sql } from 'kysely';
import type { ColumnDataType, Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

function timestampType(): ColumnDataType {
  if (isMysql()) return 'datetime';
  if (isMssql()) return 'datetime2' as ColumnDataType;

  return 'timestamptz';
}

function nowDefault() {
  return isMysql() || isMssql() ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

function jsonType(): ColumnDataType | Expression<unknown> {
  if (isMssql()) return sql`nvarchar(max)`;

  return 'json';
}

export const OAuthGrantsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('oauth_authorization_codes')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('oauth_application_id', varchar(32), (col) => col.notNull())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('user_id', varchar(32))
      .addColumn('code_hash', varchar(64), (col) => col.notNull().unique())
      .addColumn('redirect_uri', varchar(2048), (col) => col.notNull())
      .addColumn('scopes', jsonType(), (col) => col.notNull())
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('consumed_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'oauth_codes_app_fk',
        ['oauth_application_id'],
        'oauth_applications',
        ['id'],
      )
      .addForeignKeyConstraint('oauth_codes_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_oauth_codes_app')
      .on('oauth_authorization_codes')
      .column('oauth_application_id')
      .execute();

    await db.schema
      .createTable('oauth_refresh_tokens')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('oauth_application_id', varchar(32), (col) => col.notNull())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('token_hash', varchar(64), (col) => col.notNull().unique())
      .addColumn('scopes', jsonType(), (col) => col.notNull())
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'oauth_refresh_app_fk',
        ['oauth_application_id'],
        'oauth_applications',
        ['id'],
      )
      .addForeignKeyConstraint('oauth_refresh_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_oauth_refresh_app')
      .on('oauth_refresh_tokens')
      .column('oauth_application_id')
      .execute();

    await db.schema
      .createTable('oauth_access_tokens')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('oauth_application_id', varchar(32), (col) => col.notNull())
      .addColumn('refresh_token_id', varchar(32))
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('organization_id', varchar(32), (col) => col.notNull())
      .addColumn('token_hash', varchar(64), (col) => col.notNull().unique())
      .addColumn('scopes', jsonType(), (col) => col.notNull())
      .addColumn('expires_at', timestampType(), (col) => col.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addForeignKeyConstraint(
        'oauth_access_app_fk',
        ['oauth_application_id'],
        'oauth_applications',
        ['id'],
      )
      .addForeignKeyConstraint(
        'oauth_access_refresh_fk',
        ['refresh_token_id'],
        'oauth_refresh_tokens',
        ['id'],
      )
      .addForeignKeyConstraint('oauth_access_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createIndex('idx_oauth_access_app')
      .on('oauth_access_tokens')
      .column('oauth_application_id')
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_oauth_access_app')
      .on('oauth_access_tokens')
      .ifExists()
      .execute();
    await db.schema.dropTable('oauth_access_tokens').ifExists().execute();
    await db.schema
      .dropIndex('idx_oauth_refresh_app')
      .on('oauth_refresh_tokens')
      .ifExists()
      .execute();
    await db.schema.dropTable('oauth_refresh_tokens').ifExists().execute();
    await db.schema
      .dropIndex('idx_oauth_codes_app')
      .on('oauth_authorization_codes')
      .ifExists()
      .execute();
    await db.schema.dropTable('oauth_authorization_codes').ifExists().execute();
  },
};
