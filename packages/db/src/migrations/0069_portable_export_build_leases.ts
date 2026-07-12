import { sql, type ColumnDataType, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  let result: { rows: Array<{ count: number | string | bigint }> };
  if (process.env.DB_DRIVER === 'mysql') {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from information_schema.columns
      where table_schema = database() and table_name = ${table} and column_name = ${column}`.execute(
      db,
    );
  } else if (process.env.DB_DRIVER === 'mssql') {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from sys.columns join sys.tables on sys.columns.object_id = sys.tables.object_id
      where sys.tables.name = ${table} and sys.columns.name = ${column}`.execute(db);
  } else {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} and column_name = ${column}`.execute(
      db,
    );
  }
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function triggerExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  let result: { rows: Array<{ count: number | string | bigint }> };
  if (process.env.DB_DRIVER === 'mysql') {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from information_schema.triggers
      where trigger_schema = database() and trigger_name = ${name}`.execute(db);
  } else if (process.env.DB_DRIVER === 'mssql') {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from sys.triggers where name = ${name}`.execute(db);
  } else {
    result = await sql<{ count: number | string | bigint }>`select count(*) as count
      from pg_trigger where tgname = ${name} and not tgisinternal`.execute(db);
  }
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function dropImmutabilityTriggers(db: Kysely<unknown>): Promise<void> {
  if (process.env.DB_DRIVER === 'mysql') {
    if (await triggerExists(db, 'portable_export_events_no_update'))
      await sql`drop trigger portable_export_events_no_update`.execute(db);
    if (await triggerExists(db, 'portable_export_events_no_delete'))
      await sql`drop trigger portable_export_events_no_delete`.execute(db);
  } else if (await triggerExists(db, 'portable_export_events_immutable')) {
    if (process.env.DB_DRIVER === 'mssql')
      await sql`drop trigger portable_export_events_immutable`.execute(db);
    else
      await sql`drop trigger portable_export_events_immutable on portable_export_events`.execute(
        db,
      );
  }
}

async function createMissingImmutabilityTriggers(db: Kysely<unknown>): Promise<void> {
  if (process.env.DB_DRIVER === 'mysql') {
    if (!(await triggerExists(db, 'portable_export_events_no_update')))
      await sql`create trigger portable_export_events_no_update before update on portable_export_events
        for each row signal sqlstate '45000' set message_text = 'portable export events are immutable'`.execute(
        db,
      );
    if (!(await triggerExists(db, 'portable_export_events_no_delete')))
      await sql`create trigger portable_export_events_no_delete before delete on portable_export_events
        for each row signal sqlstate '45000' set message_text = 'portable export events are immutable'`.execute(
        db,
      );
  } else if (!(await triggerExists(db, 'portable_export_events_immutable'))) {
    if (process.env.DB_DRIVER === 'mssql')
      await sql`create trigger portable_export_events_immutable on portable_export_events
        instead of update, delete as throw 51000, 'portable export events are immutable', 1`.execute(
        db,
      );
    else
      await sql`create trigger portable_export_events_immutable before update or delete on portable_export_events
        for each row execute function reject_portable_export_event_mutation()`.execute(db);
  }
}

async function setJobCursorNullable(db: Kysely<unknown>, nullable: boolean): Promise<void> {
  if (process.env.DB_DRIVER === 'mysql') {
    if (nullable)
      await sql`alter table portable_export_jobs modify column source_change_cursor varchar(128) null`.execute(
        db,
      );
    else
      await sql`alter table portable_export_jobs modify column source_change_cursor varchar(128) not null`.execute(
        db,
      );
  } else if (process.env.DB_DRIVER === 'mssql') {
    if (nullable)
      await sql`alter table portable_export_jobs alter column source_change_cursor varchar(128) null`.execute(
        db,
      );
    else
      await sql`alter table portable_export_jobs alter column source_change_cursor varchar(128) not null`.execute(
        db,
      );
  } else if (nullable) {
    await sql`alter table portable_export_jobs alter column source_change_cursor drop not null`.execute(
      db,
    );
  } else {
    await sql`alter table portable_export_jobs alter column source_change_cursor set not null`.execute(
      db,
    );
  }
}

async function setEventEvidenceNotNull(db: Kysely<unknown>): Promise<void> {
  if (process.env.DB_DRIVER === 'mysql') {
    await sql`alter table portable_export_events
      modify column bundle_id varchar(128) not null,
      modify column export_sequence bigint not null,
      modify column source_change_cursor varchar(128) not null`.execute(db);
  } else if (process.env.DB_DRIVER === 'mssql') {
    await sql`alter table portable_export_events alter column bundle_id varchar(128) not null`.execute(
      db,
    );
    await sql`alter table portable_export_events alter column export_sequence bigint not null`.execute(
      db,
    );
    await sql`alter table portable_export_events alter column source_change_cursor varchar(128) not null`.execute(
      db,
    );
  } else {
    await sql`alter table portable_export_events
      alter column bundle_id set not null,
      alter column export_sequence set not null,
      alter column source_change_cursor set not null`.execute(db);
  }
}

async function addColumnIfMissing(
  db: Kysely<unknown>,
  table: 'portable_export_jobs' | 'portable_export_events',
  column: string,
  type: ColumnDataType,
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  await db.schema.alterTable(table).addColumn(column, type).execute();
}

async function dropColumnIfPresent(
  db: Kysely<unknown>,
  table: 'portable_export_jobs' | 'portable_export_events',
  column: string,
): Promise<void> {
  if (!(await columnExists(db, table, column))) return;
  await db.schema.alterTable(table).dropColumn(column).execute();
}

export const PortableExportBuildLeasesMigration: Migration = {
  async up(db): Promise<void> {
    await dropImmutabilityTriggers(db);
    try {
      await setJobCursorNullable(db, true);
      await addColumnIfMissing(db, 'portable_export_jobs', 'build_owner_sha256', 'varchar(64)');
      await addColumnIfMissing(
        db,
        'portable_export_jobs',
        'build_lease_expires_at',
        timestampType(),
      );
      await addColumnIfMissing(db, 'portable_export_events', 'bundle_id', 'varchar(128)');
      await addColumnIfMissing(db, 'portable_export_events', 'export_sequence', 'bigint');
      await addColumnIfMissing(
        db,
        'portable_export_events',
        'source_change_cursor',
        'varchar(128)',
      );
      await sql`update portable_export_events
        set bundle_id = (select portable_export_jobs.bundle_id from portable_export_jobs where portable_export_jobs.id = portable_export_events.export_job_id),
            export_sequence = (select portable_export_jobs.export_sequence from portable_export_jobs where portable_export_jobs.id = portable_export_events.export_job_id),
            source_change_cursor = (select portable_export_jobs.source_change_cursor from portable_export_jobs where portable_export_jobs.id = portable_export_events.export_job_id)
        where bundle_id is null or export_sequence is null or source_change_cursor is null`.execute(
        db,
      );
      await setEventEvidenceNotNull(db);
    } finally {
      await createMissingImmutabilityTriggers(db);
    }
  },

  async down(db): Promise<void> {
    await dropImmutabilityTriggers(db);
    try {
      await dropColumnIfPresent(db, 'portable_export_events', 'source_change_cursor');
      await dropColumnIfPresent(db, 'portable_export_events', 'export_sequence');
      await dropColumnIfPresent(db, 'portable_export_events', 'bundle_id');
      await sql`update portable_export_jobs set source_change_cursor = 'legacy:rollback' where source_change_cursor is null`.execute(
        db,
      );
      await dropColumnIfPresent(db, 'portable_export_jobs', 'build_lease_expires_at');
      await dropColumnIfPresent(db, 'portable_export_jobs', 'build_owner_sha256');
      await setJobCursorNullable(db, false);
    } finally {
      await createMissingImmutabilityTriggers(db);
    }
  },
};
