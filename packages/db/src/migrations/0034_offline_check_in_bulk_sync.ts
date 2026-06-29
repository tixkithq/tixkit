import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';
import { sql } from 'kysely';

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
  return isMysql() || isMssql() ? sql`CURRENT_TIMESTAMP` : sql`now()`;
}

function jsonType(): ColumnDataType {
  if (isMysql()) return 'json';
  if (isMssql()) return 'nvarchar(max)' as ColumnDataType;

  return 'jsonb';
}

function textType(): ColumnDataType {
  return 'text';
}

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const OfflineCheckInBulkSyncMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('offline_check_in_sync_jobs')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('event_id', varchar(32), (col) => col.notNull())
      .addColumn('check_in_list_id', varchar(32), (col) => col.notNull())
      .addColumn('device_id', varchar(32), (col) => col.notNull())
      .addColumn('requested_by_principal_id', varchar(255), (col) => col.notNull())
      .addColumn('total_chunks', 'integer', (col) => col.notNull())
      .addColumn('total_scans', 'integer')
      .addColumn('chunks_received', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('chunks_processed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('accepted_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('duplicate_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('invalid_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('sample_errors', jsonType(), (col) => col.notNull())
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('pending'))
      .addColumn('failure_message', textType())
      .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('lease_owner', varchar(255))
      .addColumn('leased_until', timestampType())
      .addColumn('next_attempt_at', timestampType())
      .addColumn('last_attempted_at', timestampType())
      .addColumn('last_heartbeat_at', timestampType())
      .addColumn('processing_started_at', timestampType())
      .addColumn('processing_completed_at', timestampType())
      .addColumn('processing_duration_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('transaction_duration_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('lock_wait_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('scan_log_insert_duration_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('ticket_update_duration_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('attendee_update_duration_ms', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('rows_processed', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('clock_warning_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('completed_at', timestampType())
      .addForeignKeyConstraint('offline_sync_jobs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('offline_sync_jobs_event_fk', ['event_id'], 'events', ['id'])
      .addForeignKeyConstraint(
        'offline_sync_jobs_list_fk',
        ['check_in_list_id'],
        'check_in_lists',
        ['id'],
      )
      .execute();

    await db.schema
      .createTable('offline_check_in_sync_chunks')
      .addColumn('id', varchar(32), (col) => col.primaryKey())
      .addColumn('tenant_id', varchar(32), (col) => col.notNull())
      .addColumn('job_id', varchar(32), (col) => col.notNull())
      .addColumn('sequence', 'integer', (col) => col.notNull())
      .addColumn('scan_count', 'integer', (col) => col.notNull())
      .addColumn('payload_hash', varchar(255), (col) => col.notNull())
      .addColumn('payload', jsonType())
      .addColumn('accepted_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('duplicate_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('invalid_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('sample_errors', jsonType(), (col) => col.notNull())
      .addColumn('clock_warning_count', 'bigint', (col) => col.notNull().defaultTo(0))
      .addColumn('status', varchar(50), (col) => col.notNull().defaultTo('uploaded'))
      .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('failure_message', textType())
      .addColumn('locked_at', timestampType())
      .addColumn('processed_at', timestampType())
      .addColumn('created_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addColumn('updated_at', timestampType(), (col) => col.notNull().defaultTo(nowDefault()))
      .addUniqueConstraint('offline_sync_chunks_job_sequence_unique', ['job_id', 'sequence'])
      .addForeignKeyConstraint('offline_sync_chunks_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint('offline_sync_chunks_job_fk', ['job_id'], 'offline_check_in_sync_jobs', [
        'id',
      ])
      .execute();

    await db.schema
      .createIndex('idx_offline_sync_jobs_scope')
      .on('offline_check_in_sync_jobs')
      .columns(['tenant_id', 'event_id', 'check_in_list_id', 'created_at'])
      .execute();

    await db.schema
      .createIndex('idx_offline_sync_jobs_status')
      .on('offline_check_in_sync_jobs')
      .columns(['tenant_id', 'status', 'updated_at'])
      .execute();

    await db.schema
      .createIndex('idx_offline_sync_jobs_worker_ready')
      .on('offline_check_in_sync_jobs')
      .columns(['status', 'next_attempt_at', 'leased_until', 'updated_at'])
      .execute();

    await db.schema
      .createIndex('idx_offline_sync_chunks_job_status')
      .on('offline_check_in_sync_chunks')
      .columns(['job_id', 'status', 'sequence'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_offline_sync_chunks_job_status')
      .on('offline_check_in_sync_chunks')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_offline_sync_jobs_status')
      .on('offline_check_in_sync_jobs')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_offline_sync_jobs_worker_ready')
      .on('offline_check_in_sync_jobs')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_offline_sync_jobs_scope')
      .on('offline_check_in_sync_jobs')
      .ifExists()
      .execute();
    await db.schema.dropTable('offline_check_in_sync_chunks').ifExists().execute();
    await db.schema.dropTable('offline_check_in_sync_jobs').ifExists().execute();
  },
};
