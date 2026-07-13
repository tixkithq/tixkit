import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';
import { createHash } from 'node:crypto';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

async function indexExists(
  db: Parameters<NonNullable<Migration['up']>>[0],
  indexName: string,
): Promise<boolean> {
  if (process.env.DB_DRIVER === 'mysql') {
    const result = await sql<{ present: number }>`
      select 1 as present from information_schema.statistics
      where table_schema = database()
        and table_name = 'portable_import_lineage_checkpoints'
        and index_name = ${indexName}
      limit 1
    `.execute(db);
    return result.rows.length > 0;
  }
  if (process.env.DB_DRIVER === 'mssql') {
    const result = await sql<{ present: number }>`
      select 1 as present from sys.indexes
      where object_id = object_id('portable_import_lineage_checkpoints')
        and name = ${indexName}
    `.execute(db);
    return result.rows.length > 0;
  }
  const result = await sql<{ present: number }>`
    select 1 as present from pg_indexes
    where schemaname = current_schema()
      and tablename = 'portable_import_lineage_checkpoints'
      and indexname = ${indexName}
    limit 1
  `.execute(db);
  return result.rows.length > 0;
}

export const PortableImportLineageCheckpointsMigration: Migration = {
  async up(db): Promise<void> {
    const tables = await db.introspection.getTables();
    const existing = tables.find(({ name }) => name === 'portable_import_lineage_checkpoints');
    if (!existing)
      await db.schema
        .createTable('portable_import_lineage_checkpoints')
        .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
        .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
        .addColumn('destination_id', 'varchar(200)', (column) => column.notNull())
        .addColumn('source_deployment_id', 'varchar(200)', (column) => column.notNull())
        .addColumn('source_tenant_id', 'varchar(200)', (column) => column.notNull())
        .addColumn('source_organization_id', 'varchar(200)', (column) => column.notNull())
        .addColumn('scope_sha256', 'varchar(64)', (column) => column.notNull())
        .addColumn('last_bundle_id', 'varchar(128)', (column) => column.notNull())
        .addColumn('last_manifest_sha256', 'varchar(64)', (column) => column.notNull())
        .addColumn('last_change_cursor', 'varchar(200)', (column) => column.notNull())
        .addColumn('last_export_sequence', 'integer', (column) => column.notNull())
        .addColumn('last_import_job_id', 'varchar(64)', (column) => column.notNull())
        .addColumn('cutover_frozen_at', timestampType())
        .addColumn('activated_at', timestampType(), (column) => column.notNull())
        .addColumn('created_at', timestampType(), (column) => column.notNull())
        .addColumn('updated_at', timestampType(), (column) => column.notNull())
        .addForeignKeyConstraint('portable_import_lineage_tenant_fk', ['tenant_id'], 'tenants', [
          'id',
        ])
        .addForeignKeyConstraint(
          'portable_import_lineage_organization_fk',
          ['tenant_id', 'organization_id'],
          'organizations',
          ['tenant_id', 'id'],
        )
        .addForeignKeyConstraint(
          'portable_import_lineage_job_fk',
          ['tenant_id', 'organization_id', 'last_import_job_id'],
          'import_jobs',
          ['tenant_id', 'organization_id', 'id'],
        )
        .addUniqueConstraint('portable_import_lineage_scope_hash_unique', [
          'tenant_id',
          'organization_id',
          'scope_sha256',
        ])
        .execute();
    const lineageTable = (await db.introspection.getTables()).find(
      ({ name }) => name === 'portable_import_lineage_checkpoints',
    );
    if (!lineageTable?.columns.some(({ name }) => name === 'scope_sha256')) {
      await db.schema
        .alterTable('portable_import_lineage_checkpoints')
        .addColumn('scope_sha256', 'varchar(64)')
        .execute();
      const rows = await sql<{
        id: string;
        tenant_id: string;
        organization_id: string;
        destination_id: string;
        source_deployment_id: string;
        source_tenant_id: string;
        source_organization_id: string;
      }>`select id, tenant_id, organization_id, destination_id, source_deployment_id,
        source_tenant_id, source_organization_id
        from portable_import_lineage_checkpoints`.execute(db);
      for (const row of rows.rows) {
        const scopeSha256 = createHash('sha256')
          .update(
            [
              row.tenant_id,
              row.organization_id,
              row.destination_id,
              row.source_deployment_id,
              row.source_tenant_id,
              row.source_organization_id,
            ].join('\0'),
          )
          .digest('hex');
        await sql`update portable_import_lineage_checkpoints
          set scope_sha256 = ${scopeSha256} where id = ${row.id}`.execute(db);
      }
      await db.schema
        .alterTable('portable_import_lineage_checkpoints')
        .alterColumn('scope_sha256', (column) => column.setNotNull())
        .execute();
    }
    if (!(await indexExists(db, 'portable_import_lineage_scope_hash_unique')))
      await db.schema
        .createIndex('portable_import_lineage_scope_hash_unique')
        .on('portable_import_lineage_checkpoints')
        .columns(['tenant_id', 'organization_id', 'scope_sha256'])
        .unique()
        .execute();
    if (!(await indexExists(db, 'portable_import_lineage_source_idx')))
      await db.schema
        .createIndex('portable_import_lineage_source_idx')
        .on('portable_import_lineage_checkpoints')
        .columns(['tenant_id', 'organization_id', 'source_deployment_id', 'last_export_sequence'])
        .execute();
  },

  async down(db): Promise<void> {
    const tables = await db.introspection.getTables();
    if (!tables.some(({ name }) => name === 'portable_import_lineage_checkpoints')) return;
    const mysql = process.env.DB_DRIVER === 'mysql';
    try {
      if (mysql) await sql`lock tables portable_import_lineage_checkpoints write`.execute(db);
      else if (process.env.DB_DRIVER === 'mssql')
        await sql`select top 0 id from portable_import_lineage_checkpoints with (tablockx, holdlock)`.execute(
          db,
        );
      else
        await sql`lock table portable_import_lineage_checkpoints in access exclusive mode`.execute(
          db,
        );
      const row = await db
        .selectFrom('portable_import_lineage_checkpoints')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(row.count) > 0)
        throw new Error('PORTABLE_IMPORT_LINEAGE_ROLLBACK_REQUIRES_EMPTY_TABLE');
      if (mysql) await sql`drop table portable_import_lineage_checkpoints`.execute(db);
      else await db.schema.dropTable('portable_import_lineage_checkpoints').execute();
    } finally {
      if (mysql) await sql`unlock tables`.execute(db).catch(() => undefined);
    }
  },
};
