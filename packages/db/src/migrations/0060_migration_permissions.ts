import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

const MIGRATION_PERMISSIONS = [
  'migrations.read',
  'migrations.write',
  'migrations.commit',
  'migrations.rollback',
] as const;

function grantId(organizationId: string, userId: string, permission: string): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${userId}\0${permission}`)
    .digest('hex')
    .slice(0, 24);
  return `pg_migration_${digest}`;
}

export const MigrationPermissionsMigration: Migration = {
  async up(db): Promise<void> {
    const members = await sql<{
      tenant_id: string;
      organization_id: string;
      user_id: string;
    }>`
      select tenant_id, organization_id, user_id
      from organization_members
      where role in ('owner', 'admin')
    `.execute(db);

    for (const member of members.rows) {
      for (const permission of MIGRATION_PERMISSIONS) {
        const existing = await sql<{ count: number | string | bigint }>`
          select count(*) as count
          from permission_grants
          where tenant_id = ${member.tenant_id}
            and principal_type = 'user'
            and principal_id = ${member.user_id}
            and permission = ${permission}
            and scope_type = 'organization'
            and scope_id = ${member.organization_id}
        `.execute(db);
        if (Number(existing.rows[0]?.count ?? 0) > 0) continue;
        await sql`
          insert into permission_grants (
            id, tenant_id, principal_type, principal_id, permission,
            scope_type, scope_id, created_at, updated_at
          ) values (
            ${grantId(member.organization_id, member.user_id, permission)},
            ${member.tenant_id}, 'user', ${member.user_id}, ${permission},
            'organization', ${member.organization_id}, current_timestamp, current_timestamp
          )
        `.execute(db);
      }
    }
  },

  async down(): Promise<void> {
    // Permission grants can become operational dependencies. Rollback is non-destructive.
  },
};
