import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function booleanType(): ColumnDataType | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`bit` : 'boolean';
}

function falseDefault(): boolean | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`0` : false;
}

export const ImportPlatformMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('organizations')
      .addUniqueConstraint('organizations_import_scope_unique', ['tenant_id', 'id'])
      .execute();
    await db.schema
      .createTable('import_jobs')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_system', 'varchar(100)', (column) => column.notNull())
      .addColumn('adapter_version', 'varchar(50)', (column) => column.notNull())
      .addColumn('mode', 'varchar(20)', (column) => column.notNull())
      .addColumn('status', 'varchar(40)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('requested_by', 'varchar(32)', (column) => column.notNull())
      .addColumn('configuration', 'text')
      .addColumn('summary', 'text')
      .addColumn('error_code', 'varchar(100)')
      .addColumn('error_message', 'text')
      .addColumn('started_at', timestampType())
      .addColumn('completed_at', timestampType())
      .addColumn('activated_at', timestampType())
      .addColumn('cancelled_at', timestampType())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_jobs_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_jobs_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('import_jobs_scope_id_unique', ['tenant_id', 'organization_id', 'id'])
      .addUniqueConstraint('import_jobs_tenant_idempotency_unique', [
        'tenant_id',
        'organization_id',
        'idempotency_key',
      ])
      .execute();

    await db.schema
      .createTable('migration_credentials')
      .addColumn('id', 'varchar(160)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_system', 'varchar(100)', (column) => column.notNull())
      .addColumn('secret_reference', 'varchar(1000)', (column) => column.notNull())
      .addColumn('status', 'varchar(20)', (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addColumn('created_by', 'varchar(32)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('migration_credentials_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'migration_credentials_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createTable('import_job_files')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('object_key', 'varchar(500)', (column) => column.notNull())
      .addColumn('original_name', 'varchar(500)', (column) => column.notNull())
      .addColumn('media_type', 'varchar(255)', (column) => column.notNull())
      .addColumn('byte_size', 'bigint', (column) => column.notNull())
      .addColumn('sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('status', 'varchar(40)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_job_files_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_job_files_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_job_files_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('import_job_files_job_object_unique', ['import_job_id', 'object_key'])
      .addUniqueConstraint('import_job_files_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .execute();

    await db.schema
      .createTable('import_job_rows')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_file_id', 'varchar(32)')
      .addColumn('entity_type', 'varchar(100)', (column) => column.notNull())
      .addColumn('external_id', 'varchar(500)')
      .addColumn('row_number', 'integer', (column) => column.notNull())
      .addColumn('status', 'varchar(40)', (column) => column.notNull())
      .addColumn('claim_owner', 'varchar(255)')
      .addColumn('claim_attempt', 'integer', (column) => column.notNull().defaultTo(0))
      .addColumn('claim_expires_at', timestampType())
      .addColumn('severity', 'varchar(20)')
      .addColumn('source_data', 'text', (column) => column.notNull())
      .addColumn('normalized_data', 'text')
      .addColumn('tixkit_id', 'varchar(64)')
      .addColumn('created_entity', booleanType(), (column) =>
        column.notNull().defaultTo(falseDefault()),
      )
      .addColumn('domain_activity_at', timestampType())
      .addColumn('rollback_blocked_reason', 'text')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_job_rows_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_job_rows_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_job_rows_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_job_rows_file_fk',
        ['tenant_id', 'organization_id', 'import_job_file_id'],
        'import_job_files',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('import_job_rows_job_entity_row_unique', [
        'import_job_id',
        'entity_type',
        'row_number',
      ])
      .addUniqueConstraint('import_job_rows_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .execute();

    await db.schema
      .createTable('import_job_events')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('sequence', 'integer', (column) => column.notNull())
      .addColumn('event_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('type', 'varchar(100)', (column) => column.notNull())
      .addColumn('severity', 'varchar(20)', (column) => column.notNull())
      .addColumn('message', 'text', (column) => column.notNull())
      .addColumn('data', 'text')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_job_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_job_events_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_job_events_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('import_job_events_job_sequence_unique', ['import_job_id', 'sequence'])
      .addUniqueConstraint('import_job_events_job_key_unique', ['import_job_id', 'event_key'])
      .execute();

    await db.schema
      .createTable('import_mappings')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_system', 'varchar(100)', (column) => column.notNull())
      .addColumn('name', 'varchar(255)', (column) => column.notNull())
      .addColumn('entity_type', 'varchar(100)', (column) => column.notNull())
      .addColumn('mapping', 'text', (column) => column.notNull())
      .addColumn('version', 'integer', (column) => column.notNull())
      .addColumn('created_by', 'varchar(32)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_mappings_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_mappings_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('import_mappings_tenant_source_name_unique', [
        'tenant_id',
        'organization_id',
        'source_system',
        'name',
      ])
      .execute();

    await db.schema
      .createTable('external_references')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_system', 'varchar(100)', (column) => column.notNull())
      .addColumn('entity_type', 'varchar(100)', (column) => column.notNull())
      .addColumn('external_id', 'varchar(500)', (column) => column.notNull())
      .addColumn('tixkit_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('created_by_import_job_id', 'varchar(32)')
      .addColumn('last_seen_import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_provenance', 'text')
      .addColumn('rollback_blocked_at', timestampType())
      .addColumn('rollback_blocked_reason', 'text')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('external_references_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'external_references_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'external_references_created_job_fk',
        ['tenant_id', 'organization_id', 'created_by_import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'external_references_last_job_fk',
        ['tenant_id', 'organization_id', 'last_seen_import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('external_references_identity_unique', [
        'tenant_id',
        'source_system',
        'entity_type',
        'external_id',
      ])
      .execute();

    await db.schema
      .createTable('import_conflicts')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('import_job_row_id', 'varchar(32)')
      .addColumn('code', 'varchar(100)', (column) => column.notNull())
      .addColumn('severity', 'varchar(20)', (column) => column.notNull())
      .addColumn('entity_type', 'varchar(100)', (column) => column.notNull())
      .addColumn('external_id', 'varchar(500)')
      .addColumn('message', 'text', (column) => column.notNull())
      .addColumn('details', 'text')
      .addColumn('resolution', 'text')
      .addColumn('resolved_at', timestampType())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('import_conflicts_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'import_conflicts_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_conflicts_job_fk',
        ['tenant_id', 'organization_id', 'import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'import_conflicts_row_fk',
        ['tenant_id', 'organization_id', 'import_job_row_id'],
        'import_job_rows',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();

    await db.schema
      .createTable('imported_domain_entities')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('created_by_import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('last_seen_import_job_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('source_system', 'varchar(100)', (column) => column.notNull())
      .addColumn('entity_type', 'varchar(100)', (column) => column.notNull())
      .addColumn('source_external_id', 'varchar(500)', (column) => column.notNull())
      .addColumn('attributes', 'text', (column) => column.notNull())
      .addColumn('financial_snapshot', 'text')
      .addColumn('source_provenance', 'text', (column) => column.notNull())
      .addColumn('canonical_hash', 'varchar(64)', (column) => column.notNull())
      .addColumn('side_effects_suppressed', booleanType(), (column) =>
        column.notNull().defaultTo(falseDefault()),
      )
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('imported_entities_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'imported_entities_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('imported_entities_scope_id_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .addForeignKeyConstraint(
        'imported_entities_created_job_fk',
        ['tenant_id', 'organization_id', 'created_by_import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'imported_entities_last_job_fk',
        ['tenant_id', 'organization_id', 'last_seen_import_job_id'],
        'import_jobs',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addUniqueConstraint('imported_entities_source_identity_unique', [
        'tenant_id',
        'organization_id',
        'source_system',
        'entity_type',
        'source_external_id',
      ])
      .execute();

    await db.schema
      .createTable('imported_entity_dependencies')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('entity_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('depends_on_entity_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('imported_entity_dependencies_pk', [
        'tenant_id',
        'organization_id',
        'entity_id',
        'depends_on_entity_id',
      ])
      .addForeignKeyConstraint('imported_entity_dependencies_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'imported_entity_dependencies_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'imported_entity_dependencies_entity_fk',
        ['tenant_id', 'organization_id', 'entity_id'],
        'imported_domain_entities',
        ['tenant_id', 'organization_id', 'id'],
      )
      .addForeignKeyConstraint(
        'imported_entity_dependencies_parent_fk',
        ['tenant_id', 'organization_id', 'depends_on_entity_id'],
        'imported_domain_entities',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();

    await db.schema
      .createIndex('idx_import_jobs_tenant_status')
      .on('import_jobs')
      .columns(['tenant_id', 'organization_id', 'status', 'created_at'])
      .execute();
    await db.schema
      .createIndex('idx_migration_credentials_scope_source')
      .on('migration_credentials')
      .columns(['tenant_id', 'organization_id', 'source_system', 'status', 'expires_at'])
      .execute();
    await db.schema
      .createIndex('idx_import_job_files_job')
      .on('import_job_files')
      .columns(['tenant_id', 'organization_id', 'import_job_id'])
      .execute();
    await db.schema
      .createIndex('idx_import_job_rows_job_status')
      .on('import_job_rows')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'status'])
      .execute();
    await db.schema
      .createIndex('idx_import_job_events_replay')
      .on('import_job_events')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'sequence'])
      .execute();
    await db.schema
      .createIndex('idx_external_references_tixkit')
      .on('external_references')
      .columns(['tenant_id', 'organization_id', 'entity_type', 'tixkit_id'])
      .execute();
    await db.schema
      .createIndex('idx_import_conflicts_job')
      .on('import_conflicts')
      .columns(['tenant_id', 'organization_id', 'import_job_id', 'severity'])
      .execute();
    await db.schema
      .createIndex('idx_imported_entity_dependencies_parent')
      .on('imported_entity_dependencies')
      .columns(['tenant_id', 'organization_id', 'depends_on_entity_id'])
      .execute();
  },

  async down(db): Promise<void> {
    for (const table of [
      'imported_entity_dependencies',
      'imported_domain_entities',
      'import_conflicts',
      'external_references',
      'import_mappings',
      'import_job_events',
      'import_job_rows',
      'import_job_files',
      'migration_credentials',
      'import_jobs',
    ] as const) {
      await db.schema.dropTable(table).ifExists().execute();
    }
    await db.schema
      .alterTable('organizations')
      .dropConstraint('organizations_import_scope_unique')
      .execute();
  },
};
