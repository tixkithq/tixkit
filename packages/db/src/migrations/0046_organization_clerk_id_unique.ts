import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

async function clerkOrganizationIndexExists(db: Kysely<unknown>): Promise<boolean> {
  const indexName = 'uniq_organizations_clerk_organization_id';

  if (isMssql()) {
    const result = await sql<{ exists: number }>`
      select 1 as [exists]
      from sys.indexes
      where name = ${indexName}
    `.execute(db);
    return result.rows.length > 0;
  }

  if (isMysql()) {
    const result = await sql<{ exists: number }>`
      select 1 as \`exists\`
      from information_schema.statistics
      where table_schema = database()
        and table_name = 'organizations'
        and index_name = ${indexName}
      limit 1
    `.execute(db);
    return result.rows.length > 0;
  }

  const result = await sql<{ exists: boolean }>`
    select exists (
      select 1
      from pg_indexes
      where schemaname = current_schema()
        and tablename = 'organizations'
        and indexname = ${indexName}
    ) as exists
  `.execute(db);
  return result.rows[0]?.exists === true;
}

async function assertNoDuplicateClerkOrganizationIds(db: Kysely<unknown>): Promise<void> {
  const result = isMssql()
    ? await sql<{ clerk_organization_id: string }>`
        select top 1 clerk_organization_id
        from organizations
        where clerk_organization_id is not null
        group by clerk_organization_id
        having count(*) > 1
      `.execute(db)
    : await sql<{ clerk_organization_id: string }>`
        select clerk_organization_id
        from organizations
        where clerk_organization_id is not null
        group by clerk_organization_id
        having count(*) > 1
        limit 1
      `.execute(db);

  const duplicate = result.rows[0]?.clerk_organization_id;
  if (duplicate) {
    throw new Error(
      `Cannot create unique Clerk organization index; duplicate clerk_organization_id exists: ${duplicate}`,
    );
  }
}

async function createUniqueClerkOrganizationIndex(db: Kysely<unknown>): Promise<void> {
  if (await clerkOrganizationIndexExists(db)) return;

  if (isMssql()) {
    await sql`
      create unique index uniq_organizations_clerk_organization_id
      on organizations (clerk_organization_id)
      where clerk_organization_id is not null
    `.execute(db);
    return;
  }

  await db.schema
    .createIndex('uniq_organizations_clerk_organization_id')
    .on('organizations')
    .columns(['clerk_organization_id'])
    .unique()
    .execute();
}

export const OrganizationClerkIdUniqueMigration: Migration = {
  async up(db): Promise<void> {
    await assertNoDuplicateClerkOrganizationIds(db);
    await createUniqueClerkOrganizationIndex(db);
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('uniq_organizations_clerk_organization_id')
      .on('organizations')
      .ifExists()
      .execute();
  },
};
