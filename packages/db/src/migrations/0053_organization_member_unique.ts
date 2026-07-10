import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function assertNoDuplicateMembers(db: Kysely<unknown>): Promise<void> {
  const result = isMssql()
    ? await sql<{ tenant_id: string; organization_id: string; user_id: string }>`
        select top 1 tenant_id, organization_id, user_id
        from organization_members
        group by tenant_id, organization_id, user_id
        having count(*) > 1
      `.execute(db)
    : await sql<{ tenant_id: string; organization_id: string; user_id: string }>`
        select tenant_id, organization_id, user_id
        from organization_members
        group by tenant_id, organization_id, user_id
        having count(*) > 1
        limit 1
      `.execute(db);
  const duplicate = result.rows[0];
  if (duplicate) {
    throw new Error(
      `Cannot enforce unique organization membership; duplicate exists for tenant ${duplicate.tenant_id}, organization ${duplicate.organization_id}, user ${duplicate.user_id}`,
    );
  }
}

export const OrganizationMemberUniqueMigration: Migration = {
  async up(db): Promise<void> {
    await assertNoDuplicateMembers(db);
    await db.schema
      .createIndex('organization_members_tenant_org_user_unique')
      .on('organization_members')
      .columns(['tenant_id', 'organization_id', 'user_id'])
      .unique()
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema
      .dropIndex('organization_members_tenant_org_user_unique')
      .on('organization_members')
      .ifExists()
      .execute();
  },
};
