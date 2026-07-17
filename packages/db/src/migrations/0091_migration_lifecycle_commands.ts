import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function sha256Check(column: 'idempotency_key_sha256' | 'request_fingerprint') {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`${sql.ref(column)} regexp '^[0-9a-f]{64}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`len(${sql.ref(column)}) = 64
      and ${sql.ref(column)} collate Latin1_General_100_BIN2 not like '%[^0-9a-f]%'`;
  }
  return sql`${sql.ref(column)} ~ '^[0-9a-f]{64}$'`;
}

function safeErrorCodeCheck() {
  if (process.env.DB_DRIVER === 'mysql') {
    return sql`last_error_code is null or last_error_code regexp '^[A-Z][A-Z0-9_]{0,63}$'`;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    return sql`last_error_code is null or (
      len(last_error_code) between 1 and 64
      and last_error_code collate Latin1_General_100_BIN2 not like '%[^A-Z0-9_]%'
      and left(last_error_code, 1) between 'A' and 'Z'
    )`;
  }
  return sql`last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'`;
}

export const MigrationLifecycleCommandsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('import_jobs')
      .addColumn('lifecycle_version', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable('import_jobs')
      .addCheckConstraint('import_jobs_lifecycle_version_nonnegative', sql`lifecycle_version >= 0`)
      .execute();

    await db.schema
      .createTable('migration_lifecycle_commands')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action', 'varchar(16)', (column) => column.notNull())
      .addColumn('dispatch_kind', 'varchar(24)', (column) => column.notNull())
      .addColumn('idempotency_key_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('expected_job_status', 'varchar(40)', (column) => column.notNull())
      .addColumn('lifecycle_sequence', 'integer', (column) => column.notNull())
      .addColumn('status', 'varchar(16)', (column) => column.notNull())
      .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
      .addColumn('next_attempt_at', timestampType(), (column) =>
        column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn('lease_owner', 'varchar(128)')
      .addColumn('lease_expires_at', timestampType())
      .addColumn('last_error_code', 'varchar(64)')
      .addColumn('actor_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('audit_correlation_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) =>
        column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn('updated_at', timestampType(), (column) =>
        column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn('dispatched_at', timestampType())
      .addUniqueConstraint('migration_lifecycle_commands_idempotency_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'idempotency_key_sha256',
      ])
      .addUniqueConstraint('migration_lifecycle_commands_sequence_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'lifecycle_sequence',
      ])
      .addCheckConstraint(
        'migration_lifecycle_commands_action_valid',
        sql`action in ('pause', 'resume', 'cancel', 'rollback')`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_dispatch_kind_valid',
        sql`dispatch_kind in ('none', 'preparation-signal', 'commit-signal', 'rollback-start')`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_status_valid',
        sql`status in ('pending', 'dispatching', 'dispatched', 'failed')`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_expected_status_valid',
        sql`expected_job_status in (
          'pending', 'preparing', 'prepared', 'discovering', 'extracting', 'normalizing',
          'validating', 'ready', 'committing', 'committed', 'activated', 'paused',
          'cancelling', 'cancelled', 'failed', 'rolling-back', 'rolled-back'
        )`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_sequence_positive',
        sql`lifecycle_sequence > 0`,
      )
      .addCheckConstraint('migration_lifecycle_commands_attempts_nonnegative', sql`attempts >= 0`)
      .addCheckConstraint(
        'migration_lifecycle_commands_lease_consistent',
        sql`(status = 'dispatching' and lease_owner is not null and lease_expires_at is not null)
          or (status <> 'dispatching' and lease_owner is null and lease_expires_at is null)`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_dispatch_consistent',
        sql`(dispatch_kind = 'none' and action = 'cancel')
          or (dispatch_kind = 'rollback-start' and action = 'rollback')
          or (dispatch_kind in ('preparation-signal', 'commit-signal') and action <> 'rollback')`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_dispatched_at_consistent',
        sql`(status = 'dispatched' and dispatched_at is not null)
          or (status <> 'dispatched' and dispatched_at is null)`,
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_idempotency_sha256',
        sha256Check('idempotency_key_sha256'),
      )
      .addCheckConstraint(
        'migration_lifecycle_commands_request_fingerprint_sha256',
        sha256Check('request_fingerprint'),
      )
      .addCheckConstraint('migration_lifecycle_commands_error_code_safe', safeErrorCodeCheck())
      .addForeignKeyConstraint('migration_lifecycle_commands_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'migration_lifecycle_commands_organization_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'migration_lifecycle_commands_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();

    await db.schema
      .createIndex('migration_lifecycle_commands_due_idx')
      .on('migration_lifecycle_commands')
      .columns(['status', 'next_attempt_at', 'lease_expires_at', 'created_at'])
      .execute();
    await db.schema
      .createIndex('migration_lifecycle_commands_job_idx')
      .on('migration_lifecycle_commands')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'lifecycle_sequence'])
      .execute();
  },

  async down(db): Promise<void> {
    const command = await db
      .selectFrom('migration_lifecycle_commands')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    const versionedJob = await db
      .selectFrom('import_jobs')
      .select('id')
      .where('lifecycle_version', '>', 0)
      .limit(1)
      .executeTakeFirst();
    if (command || versionedJob) {
      throw new Error(
        'Cannot roll back migration lifecycle commands while durable lifecycle evidence exists',
      );
    }
    await db.schema.dropTable('migration_lifecycle_commands').execute();
    await db.schema
      .alterTable('import_jobs')
      .dropConstraint('import_jobs_lifecycle_version_nonnegative')
      .execute();
    await db.schema.alterTable('import_jobs').dropColumn('lifecycle_version').execute();
  },
};
