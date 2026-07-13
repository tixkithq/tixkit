import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PortableImportCutoverProofsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('portable_import_cutover_proofs')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('key_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('nonce', 'varchar(128)', (column) => column.notNull())
      .addColumn('receipt_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('proof_json', 'text', (column) => column.notNull())
      .addColumn('validated_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('validated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_cutover_proofs_preflight_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'portable_import_preflights',
        ['tenant_id', 'organization_id', 'import_job_id'],
      )
      .addUniqueConstraint('portable_import_cutover_proofs_nonce_unique', ['key_id', 'nonce'])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql
        .raw(`create trigger portable_import_cutover_proofs_no_update before update on portable_import_cutover_proofs
          for each row signal sqlstate '45000' set message_text = 'portable import cutover proof is immutable'`)
        .execute(db);
      await sql
        .raw(`create trigger portable_import_cutover_proofs_no_delete before delete on portable_import_cutover_proofs
          for each row signal sqlstate '45000' set message_text = 'portable import cutover proof is immutable'`)
        .execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql
        .raw(`create trigger portable_import_cutover_proofs_immutable on portable_import_cutover_proofs
          instead of update, delete as throw 51000, 'portable import cutover proof is immutable', 1`)
        .execute(db);
    } else {
      await sql`create function reject_portable_import_cutover_proof_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable import cutover proof is immutable'; end $$`.execute(db);
      await sql
        .raw(`create trigger portable_import_cutover_proofs_immutable before update or delete on portable_import_cutover_proofs
          for each row execute function reject_portable_import_cutover_proof_mutation()`)
        .execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_import_cutover_proofs').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_portable_import_cutover_proof_mutation()`.execute(db);
  },
};
