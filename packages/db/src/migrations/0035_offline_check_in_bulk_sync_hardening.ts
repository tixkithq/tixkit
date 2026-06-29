import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function addColumns(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (isMysql()) {
    await sql`
      alter table offline_check_in_sync_jobs
        add column if not exists attempt_count integer not null default 0,
        add column if not exists lease_owner varchar(255),
        add column if not exists leased_until timestamp null,
        add column if not exists next_attempt_at timestamp null,
        add column if not exists last_attempted_at timestamp null,
        add column if not exists last_heartbeat_at timestamp null,
        add column if not exists processing_started_at timestamp null,
        add column if not exists processing_completed_at timestamp null,
        add column if not exists processing_duration_ms bigint not null default 0,
        add column if not exists transaction_duration_ms bigint not null default 0,
        add column if not exists lock_wait_ms bigint not null default 0,
        add column if not exists scan_log_insert_duration_ms bigint not null default 0,
        add column if not exists ticket_update_duration_ms bigint not null default 0,
        add column if not exists attendee_update_duration_ms bigint not null default 0,
        add column if not exists rows_processed bigint not null default 0,
        add column if not exists clock_warning_count bigint not null default 0
    `.execute(db);
    await sql`
      alter table offline_check_in_sync_chunks
        add column if not exists clock_warning_count bigint not null default 0,
        modify column payload json null
    `.execute(db);
    await sql`
      create index if not exists idx_offline_sync_jobs_worker_ready
      on offline_check_in_sync_jobs (status, next_attempt_at, leased_until, updated_at)
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      if col_length('offline_check_in_sync_jobs', 'attempt_count') is null
        alter table offline_check_in_sync_jobs add attempt_count integer not null default 0;
      if col_length('offline_check_in_sync_jobs', 'lease_owner') is null
        alter table offline_check_in_sync_jobs add lease_owner varchar(255) null;
      if col_length('offline_check_in_sync_jobs', 'leased_until') is null
        alter table offline_check_in_sync_jobs add leased_until datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'next_attempt_at') is null
        alter table offline_check_in_sync_jobs add next_attempt_at datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'last_attempted_at') is null
        alter table offline_check_in_sync_jobs add last_attempted_at datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'last_heartbeat_at') is null
        alter table offline_check_in_sync_jobs add last_heartbeat_at datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'processing_started_at') is null
        alter table offline_check_in_sync_jobs add processing_started_at datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'processing_completed_at') is null
        alter table offline_check_in_sync_jobs add processing_completed_at datetime2 null;
      if col_length('offline_check_in_sync_jobs', 'processing_duration_ms') is null
        alter table offline_check_in_sync_jobs add processing_duration_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'transaction_duration_ms') is null
        alter table offline_check_in_sync_jobs add transaction_duration_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'lock_wait_ms') is null
        alter table offline_check_in_sync_jobs add lock_wait_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'scan_log_insert_duration_ms') is null
        alter table offline_check_in_sync_jobs add scan_log_insert_duration_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'ticket_update_duration_ms') is null
        alter table offline_check_in_sync_jobs add ticket_update_duration_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'attendee_update_duration_ms') is null
        alter table offline_check_in_sync_jobs add attendee_update_duration_ms bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'rows_processed') is null
        alter table offline_check_in_sync_jobs add rows_processed bigint not null default 0;
      if col_length('offline_check_in_sync_jobs', 'clock_warning_count') is null
        alter table offline_check_in_sync_jobs add clock_warning_count bigint not null default 0;
      if col_length('offline_check_in_sync_chunks', 'clock_warning_count') is null
        alter table offline_check_in_sync_chunks add clock_warning_count bigint not null default 0;
      alter table offline_check_in_sync_chunks alter column payload nvarchar(max) null;
      if not exists (select 1 from sys.indexes where name = 'idx_offline_sync_jobs_worker_ready')
        create index idx_offline_sync_jobs_worker_ready
        on offline_check_in_sync_jobs (status, next_attempt_at, leased_until, updated_at);
    `.execute(db);
    return;
  }

  await sql`
    alter table offline_check_in_sync_jobs
      add column if not exists attempt_count integer not null default 0,
      add column if not exists lease_owner varchar(255),
      add column if not exists leased_until timestamptz,
      add column if not exists next_attempt_at timestamptz,
      add column if not exists last_attempted_at timestamptz,
      add column if not exists last_heartbeat_at timestamptz,
      add column if not exists processing_started_at timestamptz,
      add column if not exists processing_completed_at timestamptz,
      add column if not exists processing_duration_ms bigint not null default 0,
      add column if not exists transaction_duration_ms bigint not null default 0,
      add column if not exists lock_wait_ms bigint not null default 0,
      add column if not exists scan_log_insert_duration_ms bigint not null default 0,
      add column if not exists ticket_update_duration_ms bigint not null default 0,
      add column if not exists attendee_update_duration_ms bigint not null default 0,
      add column if not exists rows_processed bigint not null default 0,
      add column if not exists clock_warning_count bigint not null default 0
  `.execute(db);
  await sql`
    alter table offline_check_in_sync_chunks
      add column if not exists clock_warning_count bigint not null default 0,
      alter column payload drop not null
  `.execute(db);
  await sql`
    create index if not exists idx_offline_sync_jobs_worker_ready
    on offline_check_in_sync_jobs (status, next_attempt_at, leased_until, updated_at)
  `.execute(db);
}

async function dropColumns(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (isMysql()) {
    await sql`drop index idx_offline_sync_jobs_worker_ready on offline_check_in_sync_jobs`.execute(
      db,
    );
    await sql`
      alter table offline_check_in_sync_chunks
        drop column clock_warning_count
    `.execute(db);
    await sql`
      alter table offline_check_in_sync_jobs
        drop column attempt_count,
        drop column lease_owner,
        drop column leased_until,
        drop column next_attempt_at,
        drop column last_attempted_at,
        drop column last_heartbeat_at,
        drop column processing_started_at,
        drop column processing_completed_at,
        drop column processing_duration_ms,
        drop column transaction_duration_ms,
        drop column lock_wait_ms,
        drop column scan_log_insert_duration_ms,
        drop column ticket_update_duration_ms,
        drop column attendee_update_duration_ms,
        drop column rows_processed,
        drop column clock_warning_count
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      if exists (select 1 from sys.indexes where name = 'idx_offline_sync_jobs_worker_ready')
        drop index idx_offline_sync_jobs_worker_ready on offline_check_in_sync_jobs;
    `.execute(db);
    return;
  }

  await sql`drop index if exists idx_offline_sync_jobs_worker_ready`.execute(db);
  await sql`
    alter table offline_check_in_sync_chunks
      drop column if exists clock_warning_count
  `.execute(db);
  await sql`
    alter table offline_check_in_sync_jobs
      drop column if exists attempt_count,
      drop column if exists lease_owner,
      drop column if exists leased_until,
      drop column if exists next_attempt_at,
      drop column if exists last_attempted_at,
      drop column if exists last_heartbeat_at,
      drop column if exists processing_started_at,
      drop column if exists processing_completed_at,
      drop column if exists processing_duration_ms,
      drop column if exists transaction_duration_ms,
      drop column if exists lock_wait_ms,
      drop column if exists scan_log_insert_duration_ms,
      drop column if exists ticket_update_duration_ms,
      drop column if exists attendee_update_duration_ms,
      drop column if exists rows_processed,
      drop column if exists clock_warning_count
  `.execute(db);
}

export const OfflineCheckInBulkSyncHardeningMigration: Migration = {
  async up(db): Promise<void> {
    await addColumns(db);
  },

  async down(db): Promise<void> {
    await dropColumns(db);
  },
};
