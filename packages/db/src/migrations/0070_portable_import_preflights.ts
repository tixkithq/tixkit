import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PortableImportPreflightsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('portable_import_preflights')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('operation_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('bundle_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('manifest_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('artifact_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('source_deployment_id', 'varchar(200)', (column) => column.notNull())
      .addColumn('source_change_cursor', 'varchar(200)', (column) => column.notNull())
      .addColumn('destination_id', 'varchar(200)', (column) => column.notNull())
      .addColumn('manifest_json', 'text', (column) => column.notNull())
      .addColumn('preflight_json', 'text', (column) => column.notNull())
      .addColumn('expected_counts', 'text', (column) => column.notNull())
      .addColumn('expected_assets', 'text', (column) => column.notNull())
      .addColumn('required_rebindings', 'text', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_preflights_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('portable_import_preflights_operation_unique', [
        'tenant_id',
        'organization_id',
        'operation_id',
      ])
      .addUniqueConstraint('portable_import_preflights_scope_job_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
      ])
      .execute();
    await db.schema
      .createTable('portable_import_dry_run_receipts')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('operation_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('manifest_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('input_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('receipt_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('receipt_json', 'text', (column) => column.notNull())
      .addColumn('created_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_dry_run_receipts_preflight_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'portable_import_preflights',
        ['tenant_id', 'organization_id', 'import_job_id'],
      )
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      for (const table of ['portable_import_preflights', 'portable_import_dry_run_receipts']) {
        await sql
          .raw(`create trigger ${table}_no_update before update on ${table}
          for each row signal sqlstate '45000' set message_text = 'portable import control evidence is immutable'`)
          .execute(db);
        await sql
          .raw(`create trigger ${table}_no_delete before delete on ${table}
          for each row signal sqlstate '45000' set message_text = 'portable import control evidence is immutable'`)
          .execute(db);
      }
    } else if (process.env.DB_DRIVER === 'mssql') {
      for (const table of ['portable_import_preflights', 'portable_import_dry_run_receipts']) {
        await sql
          .raw(`create trigger ${table}_immutable on ${table}
          instead of update, delete as throw 51000, 'portable import control evidence is immutable', 1`)
          .execute(db);
      }
    } else {
      await sql`create function reject_portable_import_control_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable import control evidence is immutable'; end $$`.execute(db);
      for (const table of ['portable_import_preflights', 'portable_import_dry_run_receipts']) {
        await sql
          .raw(`create trigger ${table}_immutable before update or delete on ${table}
          for each row execute function reject_portable_import_control_mutation()`)
          .execute(db);
      }
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_import_dry_run_receipts').execute();
    await db.schema.dropTable('portable_import_preflights').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_portable_import_control_mutation()`.execute(db);
  },
};
