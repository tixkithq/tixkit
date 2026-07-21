import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

async function backfillMembershipProvenance(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (process.env.DB_DRIVER === 'mssql') {
    await sql`
      update pg
      set organization_member_id = membership.id
      from permission_grants pg
      outer apply (
        select top 1 om.id
        from organization_members om
        where om.tenant_id = pg.tenant_id
          and om.user_id = pg.principal_id
          and om.organization_id = pg.scope_id
        order by om.created_at, om.id
      ) membership
      where pg.principal_type = 'user'
        and pg.scope_type = 'organization'
    `.execute(db);
    return;
  }

  await sql`
    update permission_grants pg
    set organization_member_id = (
      select om.id
      from organization_members om
      where om.tenant_id = pg.tenant_id
        and om.user_id = pg.principal_id
        and om.organization_id = pg.scope_id
      order by om.created_at, om.id
      limit 1
    )
    where pg.principal_type = 'user'
      and pg.scope_type = 'organization'
  `.execute(db);
}

async function quarantineAmbiguousLegacyGrants(db: Parameters<Migration['up']>[0]): Promise<void> {
  await sql`
    insert into permission_grant_provenance_quarantine (
      id,
      tenant_id,
      principal_type,
      principal_id,
      permission,
      scope_type,
      scope_id,
      original_created_at,
      original_updated_at,
      quarantine_reason,
      quarantined_at
    )
    select
      pg.id,
      pg.tenant_id,
      pg.principal_type,
      pg.principal_id,
      pg.permission,
      pg.scope_type,
      pg.scope_id,
      pg.created_at,
      pg.updated_at,
      case
        when pg.scope_type in ('brand', 'event')
          then 'legacy_scoped_grant_provenance_ambiguous'
        else 'legacy_organization_membership_missing'
      end,
      current_timestamp
    from permission_grants pg
    where pg.principal_type = 'user'
      and (
        pg.scope_type in ('brand', 'event')
        or (pg.scope_type = 'organization' and pg.organization_member_id is null)
      )
  `.execute(db);
  await sql`
    delete from permission_grants
    where id in (select id from permission_grant_provenance_quarantine)
  `.execute(db);
}

export const PermissionGrantMembershipProvenanceMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('permission_grants')
      .addColumn('organization_member_id', 'varchar(32)')
      .execute();
    await db.schema
      .createTable('permission_grant_provenance_quarantine')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('principal_type', 'varchar(50)', (column) => column.notNull())
      .addColumn('principal_id', 'varchar(255)', (column) => column.notNull())
      .addColumn('permission', 'varchar(100)', (column) => column.notNull())
      .addColumn('scope_type', 'varchar(50)', (column) => column.notNull())
      .addColumn('scope_id', 'varchar(32)')
      .addColumn('original_created_at', timestampType(), (column) => column.notNull())
      .addColumn('original_updated_at', timestampType(), (column) => column.notNull())
      .addColumn('quarantine_reason', 'varchar(100)', (column) => column.notNull())
      .addColumn('quarantined_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('permission_grant_quarantine_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .execute();
    await backfillMembershipProvenance(db);
    await quarantineAmbiguousLegacyGrants(db);
    await db.schema
      .createIndex('organization_members_tenant_id_unique')
      .on('organization_members')
      .columns(['tenant_id', 'id'])
      .unique()
      .execute();
    await db.schema
      .alterTable('permission_grants')
      .addForeignKeyConstraint(
        'permission_grants_membership_fk',
        ['tenant_id', 'organization_member_id'],
        'organization_members',
        ['tenant_id', 'id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .execute();
    await db.schema
      .createIndex('permission_grants_membership_idx')
      .on('permission_grants')
      .columns(['tenant_id', 'organization_member_id'])
      .execute();
  },

  async down(): Promise<void> {
    throw new Error(
      'Permission-grant membership provenance is irreversible without an audited grant migration',
    );
  },
};
