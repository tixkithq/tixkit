import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
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
