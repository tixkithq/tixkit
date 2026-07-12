import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

const immutableTables = [
  'portable_import_approvals',
  'portable_import_approval_revocations',
] as const;

async function ensureMysqlReceiptScopeIndex(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (process.env.DB_DRIVER !== 'mysql') return;
  const result = await sql<{ count: number | string | bigint }>`select count(*) as count
    from information_schema.statistics
    where table_schema = database()
      and table_name = 'portable_import_dry_run_receipts'
      and index_name = 'portable_import_receipts_scope_job_fk_idx'`.execute(db);
  if (Number(result.rows[0]?.count ?? 0) === 0)
    await db.schema
      .createIndex('portable_import_receipts_scope_job_fk_idx')
      .on('portable_import_dry_run_receipts')
      .columns(['tenant_id', 'organization_id', 'import_job_id'])
      .execute();
}

export const PortableImportApprovalsMigration: Migration = {
  async up(db): Promise<void> {
    await ensureMysqlReceiptScopeIndex(db);
    await db.schema
      .alterTable('portable_import_dry_run_receipts')
      .addUniqueConstraint('portable_import_receipts_scope_job_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
      ])
      .execute();
    await db.schema
      .createTable('portable_import_approvals')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('operation_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('manifest_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('artifact_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('input_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('receipt_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('approval_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('approved_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('idempotency_key_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_approvals_receipt_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'portable_import_dry_run_receipts',
        ['tenant_id', 'organization_id', 'import_job_id'],
      )
      .addUniqueConstraint('portable_import_approvals_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'id',
      ])
      .addUniqueConstraint('portable_import_approvals_digest_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'approval_digest',
      ])
      .addUniqueConstraint('portable_import_approvals_idempotency_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'idempotency_key_sha256',
      ])
      .execute();
    await db.schema
      .createIndex('portable_import_approvals_job_expiry_idx')
      .on('portable_import_approvals')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'expires_at'])
      .execute();
    await db.schema
      .createTable('portable_import_approval_revocations')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('approval_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('revoked_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('reason', 'varchar(500)')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_approval_revocations_approval_fk',
        ['tenant_id', 'organization_id', 'import_job_id', 'approval_id'],
        'portable_import_approvals',
        ['tenant_id', 'organization_id', 'import_job_id', 'id'],
      )
      .addUniqueConstraint('portable_import_approval_revocations_approval_unique', ['approval_id'])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      for (const table of immutableTables) {
        await sql
          .raw(`create trigger ${table}_no_update before update on ${table}
            for each row signal sqlstate '45000' set message_text = 'portable import approval evidence is immutable'`)
          .execute(db);
        await sql
          .raw(`create trigger ${table}_no_delete before delete on ${table}
            for each row signal sqlstate '45000' set message_text = 'portable import approval evidence is immutable'`)
          .execute(db);
      }
    } else if (process.env.DB_DRIVER === 'mssql') {
      for (const table of immutableTables) {
        await sql
          .raw(`create trigger ${table}_immutable on ${table}
            instead of update, delete as throw 51000, 'portable import approval evidence is immutable', 1`)
          .execute(db);
      }
    } else {
      await sql`create function reject_portable_import_approval_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable import approval evidence is immutable'; end $$`.execute(db);
      for (const table of immutableTables) {
        await sql
          .raw(`create trigger ${table}_immutable before update or delete on ${table}
            for each row execute function reject_portable_import_approval_mutation()`)
          .execute(db);
      }
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_import_approval_revocations').execute();
    await db.schema.dropTable('portable_import_approvals').execute();
    await ensureMysqlReceiptScopeIndex(db);
    await db.schema
      .alterTable('portable_import_dry_run_receipts')
      .dropConstraint('portable_import_receipts_scope_job_unique')
      .execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_portable_import_approval_mutation()`.execute(db);
  },
};
