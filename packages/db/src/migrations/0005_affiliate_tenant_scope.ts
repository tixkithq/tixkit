import { sql } from 'kysely';
import type { ColumnDataType, Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

function isMysql() {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql() {
  return process.env.DB_DRIVER === 'mssql';
}

async function columnExists(
  db: Kysely<Record<string, unknown>>,
  columnName: string,
): Promise<boolean> {
  if (isMssql()) {
    const result = await sql<{ column_name: string }>`
      select top 1 column_name
      from information_schema.columns
      where table_schema = schema_name()
        and table_name = 'affiliates'
        and column_name = ${columnName}
    `.execute(db);

    return result.rows.length > 0;
  }

  const result = isMysql()
    ? await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = database()
          and table_name = 'affiliates'
          and column_name = ${columnName}
        limit 1
      `.execute(db)
    : await sql<{ column_name: string }>`
        select column_name
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'affiliates'
          and column_name = ${columnName}
        limit 1
      `.execute(db);

  return result.rows.length > 0;
}

async function backfillTenantId(db: Kysely<Record<string, unknown>>): Promise<void> {
  if (isMysql()) {
    await sql`
      update affiliates
      join organizations on organizations.id = affiliates.organization_id
      set affiliates.tenant_id = organizations.tenant_id
      where affiliates.tenant_id is null
    `.execute(db);
    return;
  }

  await sql`
    update affiliates
    set tenant_id = organizations.tenant_id
    from organizations
    where affiliates.organization_id = organizations.id
      and affiliates.tenant_id is null
  `.execute(db);
}

export const AffiliateTenantScopeMigration: Migration = {
  async up(db): Promise<void> {
    if (!(await columnExists(db, 'tenant_id'))) {
      await db.schema.alterTable('affiliates').addColumn('tenant_id', varchar(32)).execute();
    }

    await backfillTenantId(db);
  },
  async down(db): Promise<void> {
    if (await columnExists(db, 'tenant_id')) {
      await db.schema.alterTable('affiliates').dropColumn('tenant_id').execute();
    }
  },
};
