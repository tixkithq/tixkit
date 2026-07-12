import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PortableExportsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('portable_export_sequences')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('next_sequence', 'bigint', (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('portable_export_sequences_pk', ['tenant_id', 'organization_id'])
      .addForeignKeyConstraint('portable_export_sequences_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'portable_export_sequences_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createTable('portable_export_jobs')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('export_sequence', 'bigint', (column) => column.notNull())
      .addColumn('mode', 'varchar(24)', (column) => column.notNull())
      .addColumn('status', 'varchar(24)', (column) => column.notNull())
      .addColumn('bundle_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('source_change_cursor', 'varchar(128)', (column) => column.notNull())
      .addColumn('manifest_sha256', 'varchar(64)')
      .addColumn('artifact_sha256', 'varchar(64)')
      .addColumn('artifact_bytes', 'bigint')
      .addColumn('requested_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('error_code', 'varchar(128)')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('completed_at', timestampType())
      .addForeignKeyConstraint('portable_export_jobs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'portable_export_jobs_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('portable_export_jobs_idempotency_unique', [
        'tenant_id',
        'organization_id',
        'idempotency_key',
      ])
      .addUniqueConstraint('portable_export_jobs_sequence_unique', [
        'tenant_id',
        'organization_id',
        'export_sequence',
      ])
      .addUniqueConstraint('portable_export_jobs_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .execute();
    await db.schema
      .createIndex('portable_export_jobs_scope_status_idx')
      .on('portable_export_jobs')
      .columns(['tenant_id', 'organization_id', 'status', 'created_at'])
      .execute();

    await db.schema
      .createTable('portable_export_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('export_job_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('manifest_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('artifact_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('artifact_bytes', 'bigint', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('portable_export_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'portable_export_events_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'portable_export_events_job_fk',
        ['tenant_id', 'organization_id', 'export_job_id'],
        'portable_export_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('portable_export_events_job_unique', ['export_job_id'])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger portable_export_events_no_update before update on portable_export_events
        for each row signal sqlstate '45000' set message_text = 'portable export events are immutable'`.execute(
        db,
      );
      await sql`create trigger portable_export_events_no_delete before delete on portable_export_events
        for each row signal sqlstate '45000' set message_text = 'portable export events are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger portable_export_events_immutable on portable_export_events
        instead of update, delete as throw 51000, 'portable export events are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create function reject_portable_export_event_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable export events are immutable'; end $$`.execute(db);
      await sql`create trigger portable_export_events_immutable before update or delete on portable_export_events
        for each row execute function reject_portable_export_event_mutation()`.execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_export_events').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_portable_export_event_mutation()`.execute(db);
    await db.schema.dropTable('portable_export_jobs').execute();
    await db.schema.dropTable('portable_export_sequences').execute();
  },
};
