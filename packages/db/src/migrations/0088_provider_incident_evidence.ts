import { createHash } from 'node:crypto';
import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function grantId(organizationId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`${organizationId}\0${userId}\0provider_incidents.read`)
    .digest('hex')
    .slice(0, 24);
  return `pg_provider_incident_${digest}`;
}

export const ProviderIncidentEvidenceMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('provider_incident_evidence')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('provider', 'varchar(64)', (column) => column.notNull())
      .addColumn('operation', 'varchar(96)', (column) => column.notNull())
      .addColumn('correlation_sha256', 'varchar(71)', (column) => column.notNull())
      .addColumn('key_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('iv_b64', 'varchar(32)', (column) => column.notNull())
      .addColumn('tag_b64', 'varchar(32)', (column) => column.notNull())
      .addColumn('ciphertext_b64', 'varchar(512)', (column) => column.notNull())
      .addColumn('captured_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('provider_incident_evidence_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'provider_incident_evidence_organization_scope_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
        (constraint) => constraint.onDelete('cascade'),
      )
      .addUniqueConstraint('provider_incident_evidence_dedupe_unique', [
        'tenant_id',
        'organization_id',
        'provider',
        'operation',
        'correlation_sha256',
      ])
      .execute();

    const privilegedMembers = await sql<{
      tenant_id: string;
      organization_id: string;
      user_id: string;
    }>`
      select tenant_id, organization_id, user_id
      from organization_members
      where role in ('owner', 'admin')
        and accepted_at is not null
    `.execute(db);
    for (const member of privilegedMembers.rows) {
      const existing = await sql<{ count: number | string | bigint }>`
        select count(*) as count
        from permission_grants
        where tenant_id = ${member.tenant_id}
          and principal_type = 'user'
          and principal_id = ${member.user_id}
          and permission = 'provider_incidents.read'
          and scope_type = 'organization'
          and scope_id = ${member.organization_id}
      `.execute(db);
      if (Number(existing.rows[0]?.count ?? 0) > 0) continue;
      await sql`
        insert into permission_grants (
          id, tenant_id, principal_type, principal_id, permission, scope_type, scope_id, created_at, updated_at
        ) values (
          ${grantId(member.organization_id, member.user_id)},
          ${member.tenant_id},
          'user',
          ${member.user_id},
          'provider_incidents.read',
          'organization',
          ${member.organization_id},
          current_timestamp,
          current_timestamp
        )
      `.execute(db);
    }

    await db.schema
      .createIndex('provider_incident_evidence_scope_expiry_idx')
      .on('provider_incident_evidence')
      .columns(['tenant_id', 'organization_id', 'expires_at', 'id'])
      .execute();
    await db.schema
      .createIndex('provider_incident_evidence_correlation_idx')
      .on('provider_incident_evidence')
      .columns(['tenant_id', 'correlation_sha256', 'captured_at'])
      .execute();
  },

  async down(db): Promise<void> {
    await sql`
      delete from permission_grants
      where permission = 'provider_incidents.read'
        and id like 'pg_provider_incident_%'
    `.execute(db);
    await db.schema.dropTable('provider_incident_evidence').execute();
  },
};
