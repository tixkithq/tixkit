import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';
import { createHash } from 'node:crypto';
import { isOrganizationSystemRole, permissionsForRole } from '@tixkit/domain';

export function seedPermissionGrantId(input: {
  organizationId: string;
  userId: string;
  permission: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.organizationId}\0${input.userId}\0${input.permission}`)
    .digest('hex')
    .slice(0, 24);
  return `pg_seed_${digest}`;
}

/**
 * Backfill organization-scoped permission grants for members that currently
 * have a role string but no grants (pre-matrix invites).
 *
 * Members that already have any grants are left untouched so custom grants
 * and dev full-permission seeds are preserved.
 */
export const RolePermissionGrantsSeedMigration: Migration = {
  async up(db): Promise<void> {
    const members = await sql<{
      user_id: string;
      tenant_id: string;
      organization_id: string;
      role: string;
    }>`
      select m.user_id, m.tenant_id, m.organization_id, m.role
      from organization_members m
    `.execute(db);

    for (const member of members.rows) {
      if (!isOrganizationSystemRole(member.role)) continue;
      // Treat any grant scoped to a resource in this membership's organization
      // as intentional configuration. Never broaden brand/event grants to the
      // entire organization during the legacy-role backfill.
      const existing = await sql<{ count: number | string | bigint }>`
        select count(*) as count
        from permission_grants pg
        where pg.tenant_id = ${member.tenant_id}
          and pg.principal_type = 'user'
          and pg.principal_id = ${member.user_id}
          and (
            (pg.scope_type = 'organization' and pg.scope_id = ${member.organization_id})
            or (
              pg.scope_type = 'brand'
              and pg.scope_id in (
                select b.id from brands b
                where b.tenant_id = ${member.tenant_id}
                  and b.organization_id = ${member.organization_id}
              )
            )
            or (
              pg.scope_type = 'event'
              and pg.scope_id in (
                select e.id from events e
                where e.tenant_id = ${member.tenant_id}
                  and e.organization_id = ${member.organization_id}
              )
            )
          )
      `.execute(db);

      if (Number(existing.rows[0]?.count ?? 0) > 0) continue;

      const permissions = permissionsForRole(member.role);
      for (const permission of permissions) {
        const id = seedPermissionGrantId({
          organizationId: member.organization_id,
          userId: member.user_id,
          permission,
        });
        await sql`
          insert into permission_grants (
            id, tenant_id, principal_type, principal_id, permission, scope_type, scope_id, created_at, updated_at
          ) values (
            ${id},
            ${member.tenant_id},
            'user',
            ${member.user_id},
            ${permission},
            'organization',
            ${member.organization_id},
            current_timestamp,
            current_timestamp
          )
        `.execute(db);
      }
    }
  },

  async down(): Promise<void> {
    // Non-destructive: do not delete grants that may now be relied upon.
  },
};
