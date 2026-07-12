import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PortableImportRebindingsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('portable_import_approvals')
      .addColumn('rebindings_sha256', 'varchar(64)', (column) =>
        column
          .notNull()
          .defaultTo('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'),
      )
      .execute();
    await db.schema
      .createTable('portable_destination_resources')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('kind', 'varchar(64)', (column) => column.notNull())
      .addColumn('resource_id', 'varchar(200)', (column) => column.notNull())
      .addColumn('registered_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('revoked_at', timestampType())
      .addForeignKeyConstraint(
        'portable_destination_resources_organization_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('portable_destination_resources_scope_unique', [
        'tenant_id',
        'organization_id',
        'kind',
        'resource_id',
      ])
      .execute();
    await db.schema
      .createTable('portable_import_rebindings')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('portable_id', 'varchar(200)', (column) => column.notNull())
      .addColumn('kind', 'varchar(64)', (column) => column.notNull())
      .addColumn('destination_reference', 'varchar(500)', (column) => column.notNull())
      .addColumn('provenance_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('bound_by', 'varchar(128)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'portable_import_rebindings_preflight_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'portable_import_preflights',
        ['tenant_id', 'organization_id', 'import_job_id'],
      )
      .addForeignKeyConstraint(
        'portable_import_rebindings_destination_fk',
        ['tenant_id', 'organization_id', 'kind', 'destination_reference'],
        'portable_destination_resources',
        ['tenant_id', 'organization_id', 'kind', 'resource_id'],
      )
      .addUniqueConstraint('portable_import_rebindings_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'id',
      ])
      .addUniqueConstraint('portable_import_rebindings_portable_id_unique', [
        'tenant_id',
        'organization_id',
        'import_job_id',
        'portable_id',
      ])
      .execute();
    await db.schema
      .createIndex('portable_import_rebindings_job_idx')
      .on('portable_import_rebindings')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'portable_id'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('portable_import_rebindings').execute();
    await db.schema.dropTable('portable_destination_resources').execute();
    await db.schema
      .alterTable('portable_import_approvals')
      .dropColumn('rebindings_sha256')
      .execute();
  },
};
