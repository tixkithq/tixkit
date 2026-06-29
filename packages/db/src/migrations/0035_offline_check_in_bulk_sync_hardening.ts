import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

async function mysqlColumnExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ column_exists: number }>`
    select count(*) as column_exists
    from information_schema.columns
    where table_schema = database()
      and table_name = ${tableName}
      and column_name = ${columnName}
  `.execute(db);
  return Number(result.rows[0]?.column_exists ?? 0) > 0;
}

async function mysqlIndexExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  indexName: string,
): Promise<boolean> {
  const result = await sql<{ index_exists: number }>`
    select count(*) as index_exists
    from information_schema.statistics
    where table_schema = database()
      and table_name = ${tableName}
      and index_name = ${indexName}
  `.execute(db);
  return Number(result.rows[0]?.index_exists ?? 0) > 0;
}

async function addMysqlColumnIfMissing(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  if (await mysqlColumnExists(db, tableName, columnName)) return;
  await sql
    .raw(
      `alter table ${quoteMysqlIdentifier(tableName)} add column ${quoteMysqlIdentifier(columnName)} ${definition}`,
    )
    .execute(db);
}

async function dropMysqlColumnIfExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
): Promise<void> {
  if (!(await mysqlColumnExists(db, tableName, columnName))) return;
  await sql
    .raw(
      `alter table ${quoteMysqlIdentifier(tableName)} drop column ${quoteMysqlIdentifier(columnName)}`,
    )
    .execute(db);
}

async function addColumns(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (isMysql()) {
    const jobColumns: Array<[string, string]> = [
      ['attempt_count', 'integer not null default 0'],
      ['lease_owner', 'varchar(255)'],
      ['leased_until', 'timestamp null'],
      ['next_attempt_at', 'timestamp null'],
      ['last_attempted_at', 'timestamp null'],
      ['last_heartbeat_at', 'timestamp null'],
      ['processing_started_at', 'timestamp null'],
      ['processing_completed_at', 'timestamp null'],
      ['processing_duration_ms', 'bigint not null default 0'],
      ['transaction_duration_ms', 'bigint not null default 0'],
      ['lock_wait_ms', 'bigint not null default 0'],
      ['scan_log_insert_duration_ms', 'bigint not null default 0'],
      ['ticket_update_duration_ms', 'bigint not null default 0'],
      ['attendee_update_duration_ms', 'bigint not null default 0'],
      ['rows_processed', 'bigint not null default 0'],
      ['clock_warning_count', 'bigint not null default 0'],
    ];
    for (const [columnName, definition] of jobColumns) {
      // eslint-disable-next-line no-await-in-loop -- schema changes must run in deterministic order.
      await addMysqlColumnIfMissing(db, 'offline_check_in_sync_jobs', columnName, definition);
    }
    await addMysqlColumnIfMissing(
      db,
      'offline_check_in_sync_chunks',
      'clock_warning_count',
      'bigint not null default 0',
    );
    await sql`
      alter table offline_check_in_sync_chunks
        modify column payload json null
    `.execute(db);
    if (
      !(await mysqlIndexExists(
        db,
        'offline_check_in_sync_jobs',
        'idx_offline_sync_jobs_worker_ready',
      ))
    ) {
      await sql`
        create index idx_offline_sync_jobs_worker_ready
        on offline_check_in_sync_jobs (status, next_attempt_at, leased_until, updated_at)
      `.execute(db);
    }
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
    if (
      await mysqlIndexExists(db, 'offline_check_in_sync_jobs', 'idx_offline_sync_jobs_worker_ready')
    ) {
      await sql`drop index idx_offline_sync_jobs_worker_ready on offline_check_in_sync_jobs`.execute(
        db,
      );
    }
    await dropMysqlColumnIfExists(db, 'offline_check_in_sync_chunks', 'clock_warning_count');
    const jobColumns = [
      'attempt_count',
      'lease_owner',
      'leased_until',
      'next_attempt_at',
      'last_attempted_at',
      'last_heartbeat_at',
      'processing_started_at',
      'processing_completed_at',
      'processing_duration_ms',
      'transaction_duration_ms',
      'lock_wait_ms',
      'scan_log_insert_duration_ms',
      'ticket_update_duration_ms',
      'attendee_update_duration_ms',
      'rows_processed',
      'clock_warning_count',
    ];
    for (const columnName of jobColumns) {
      // eslint-disable-next-line no-await-in-loop -- rollback drops columns in the reverse migration's defined order.
      await dropMysqlColumnIfExists(db, 'offline_check_in_sync_jobs', columnName);
    }
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
