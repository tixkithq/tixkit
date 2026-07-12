import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PortableImportCommitAuthorizationsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('portable_import_commit_authorizations')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('approval_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('approval_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('input_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('rebindings_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('authorized_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('authorized_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_commit_authorizations_approval_fk',
        ['tenant_id', 'organization_id', 'import_job_id', 'approval_id'],
        'portable_import_approvals',
        ['tenant_id', 'organization_id', 'import_job_id', 'id'],
      )
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql
        .raw(`create trigger portable_import_commit_authorizations_no_update before update on portable_import_commit_authorizations
          for each row signal sqlstate '45000' set message_text = 'portable import commit authorization is immutable'`)
        .execute(db);
      await sql
        .raw(`create trigger portable_import_commit_authorizations_no_delete before delete on portable_import_commit_authorizations
          for each row signal sqlstate '45000' set message_text = 'portable import commit authorization is immutable'`)
        .execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql
        .raw(`create trigger portable_import_commit_authorizations_immutable on portable_import_commit_authorizations
          instead of update, delete as throw 51000, 'portable import commit authorization is immutable', 1`)
        .execute(db);
    } else {
      await sql`create function reject_portable_import_commit_authorization_mutation() returns trigger language plpgsql as $$
        begin raise exception 'portable import commit authorization is immutable'; end $$`.execute(
        db,
      );
      await sql
        .raw(`create trigger portable_import_commit_authorizations_immutable before update or delete on portable_import_commit_authorizations
          for each row execute function reject_portable_import_commit_authorization_mutation()`)
        .execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_import_commit_authorizations').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_portable_import_commit_authorization_mutation()`.execute(db);
  },
};
