import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function sha256Check(column: 'provider_account_identity_sha256' | 'idempotency_key_sha256') {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`${sql.ref(column)} regexp '^[0-9a-f]{64}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`len(${sql.ref(column)}) = 64
      and ${sql.ref(column)} collate Latin1_General_100_BIN2 not like '%[^0-9a-f]%'`;
  }
  return sql`${sql.ref(column)} ~ '^[0-9a-f]{64}$'`;
}

function safeKindCheck(column: 'reason' | 'last_error_kind') {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`${sql.ref(column)} is null or ${sql.ref(column)} regexp '^[a-z][a-z0-9_.-]{0,63}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`${sql.ref(column)} is null or (
      len(${sql.ref(column)}) between 1 and 64
      and ${sql.ref(column)} collate Latin1_General_100_BIN2 not like '%[^a-z0-9_.-]%'
      and left(${sql.ref(column)}, 1) between 'a' and 'z'
    )`;
  }
  return sql`${sql.ref(column)} is null or ${sql.ref(column)} ~ '^[a-z][a-z0-9_.-]{0,63}$'`;
}

function safeErrorMessageCheck() {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`last_error_message is null or last_error_message regexp '^[a-z][a-z0-9_.-]{0,63}:[a-z][a-z0-9_.-]{0,63}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`last_error_message is null or (
      len(last_error_message) between 3 and 129
      and last_error_message collate Latin1_General_100_BIN2 not like '%[^a-z0-9_.:-]%'
      and left(last_error_message, 1) between 'a' and 'z'
      and charindex(':', last_error_message) between 2 and 65
      and charindex(':', last_error_message, charindex(':', last_error_message) + 1) = 0
    )`;
  }
  return sql`last_error_message is null or last_error_message ~ '^[a-z][a-z0-9_.-]{0,63}:[a-z][a-z0-9_.-]{0,63}$'`;
}

export const ProviderAccountCleanupCommandsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('provider_account_cleanup_commands')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('provider', 'varchar(64)', (column) => column.notNull())
      .addColumn('provider_account_id', 'varchar(255)', (column) => column.notNull())
      .addColumn('provider_account_identity_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('idempotency_key_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('reason', 'varchar(64)', (column) => column.notNull())
      .addColumn('status', 'varchar(24)', (column) => column.notNull())
      .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
      .addColumn('available_at', timestampType(), (column) => column.notNull())
      .addColumn('lease_token', 'varchar(128)')
      .addColumn('lease_expires_at', timestampType())
      .addColumn('last_error_kind', 'varchar(64)')
      .addColumn('last_error_message', 'varchar(500)')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addColumn('completed_at', timestampType())
      .addUniqueConstraint('provider_account_cleanup_identity_unique', [
        'provider_account_identity_sha256',
      ])
      .addUniqueConstraint('provider_account_cleanup_idempotency_unique', [
        'tenant_id',
        'organization_id',
        'idempotency_key_sha256',
      ])
      .addCheckConstraint(
        'provider_account_cleanup_identity_sha256',
        sha256Check('provider_account_identity_sha256'),
      )
      .addCheckConstraint(
        'provider_account_cleanup_idempotency_sha256',
        sha256Check('idempotency_key_sha256'),
      )
      .addCheckConstraint(
        'provider_account_cleanup_status_valid',
        sql`status in ('pending', 'processing', 'succeeded', 'manual_review')`,
      )
      .addCheckConstraint('provider_account_cleanup_attempts_nonnegative', sql`attempts >= 0`)
      .addCheckConstraint('provider_account_cleanup_reason_safe', safeKindCheck('reason'))
      .addCheckConstraint(
        'provider_account_cleanup_error_kind_safe',
        safeKindCheck('last_error_kind'),
      )
      .addCheckConstraint('provider_account_cleanup_error_message_safe', safeErrorMessageCheck())
      .addCheckConstraint(
        'provider_account_cleanup_error_consistent',
        sql`(last_error_kind is null and last_error_message is null)
          or (last_error_kind is not null and last_error_message is not null)`,
      )
      .addCheckConstraint(
        'provider_account_cleanup_lease_consistent',
        sql`(status = 'processing' and lease_token is not null and lease_expires_at is not null)
          or (status <> 'processing' and lease_token is null and lease_expires_at is null)`,
      )
      .addCheckConstraint(
        'provider_account_cleanup_completion_consistent',
        sql`(status in ('succeeded', 'manual_review') and completed_at is not null)
          or (status in ('pending', 'processing') and completed_at is null)`,
      )
      .addCheckConstraint(
        'provider_account_cleanup_success_has_no_error',
        sql`status <> 'succeeded' or (last_error_kind is null and last_error_message is null)`,
      )
      .addForeignKeyConstraint('provider_account_cleanup_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'provider_account_cleanup_organization_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createIndex('provider_account_cleanup_due_idx')
      .on('provider_account_cleanup_commands')
      .columns(['status', 'available_at', 'lease_expires_at', 'created_at'])
      .execute();
    await db.schema
      .createIndex('provider_account_cleanup_scope_idx')
      .on('provider_account_cleanup_commands')
      .columns(['tenant_id', 'organization_id', 'created_at'])
      .execute();
  },

  async down(): Promise<void> {
    // PostgreSQL transactional DDL and MySQL implicit-commit DDL cannot share a
    // portable check-then-drop exclusion that prevents a concurrent enqueue.
    // Retain durable cleanup evidence on every engine; replacement/removal must
    // use a separately reviewed archival migration with an explicit cutover.
    throw new Error(
      'Provider account cleanup commands are irreversible without an archival migration',
    );
  },
};
