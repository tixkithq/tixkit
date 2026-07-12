import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function booleanType(): ColumnDataType | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`bit` : 'boolean';
}

export const AgentExecutionMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('agent_approvals')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('plan_sha256', 'varchar(64)')
      .addColumn('approver_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('approver_permission_snapshot', 'text', (column) => column.notNull())
      .addColumn('policy_version', 'bigint', (column) => column.notNull())
      .addColumn('approved_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('consumed_at', timestampType())
      .addColumn('consumed_execution_id', 'varchar(64)')
      .addForeignKeyConstraint('agent_approvals_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addUniqueConstraint('agent_approvals_tenant_id_unique', ['tenant_id', 'id'])
      .execute();
    await db.schema
      .createIndex('agent_approvals_action_idx')
      .on('agent_approvals')
      .columns(['tenant_id', 'action_digest'])
      .execute();

    await db.schema
      .createTable('agent_executions')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('delegation_grant_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('approval_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('state', 'varchar(20)', (column) => column.notNull())
      .addColumn('resource_version', 'bigint', (column) => column.notNull())
      .addColumn('policy_version', 'bigint', (column) => column.notNull())
      .addColumn('fence_token', 'bigint', (column) => column.notNull())
      .addColumn('lease_owner', 'varchar(64)')
      .addColumn('lease_expires_at', timestampType())
      .addColumn('result', 'text')
      .addColumn('failure_code', 'varchar(64)')
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_executions_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_executions_approval_fk',
        ['tenant_id', 'approval_id'],
        'agent_approvals',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_executions_tenant_id_unique', ['tenant_id', 'id'])
      .addUniqueConstraint('agent_executions_idempotency_unique', ['tenant_id', 'idempotency_key'])
      .execute();

    await db.schema
      .createTable('agent_audit_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('execution_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('delegation_grant_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('plan_sha256', 'varchar(64)')
      .addColumn('approval_id', 'varchar(64)')
      .addColumn('phase', 'varchar(20)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('resource_version', 'bigint', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addColumn('reason_codes', 'text', (column) => column.notNull())
      .addColumn('immutable', booleanType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_audit_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_audit_events_execution_fk',
        ['tenant_id', 'execution_id'],
        'agent_executions',
        ['tenant_id', 'id'],
      )
      .execute();
    await db.schema
      .createIndex('agent_audit_events_execution_idx')
      .on('agent_audit_events')
      .columns(['tenant_id', 'execution_id', 'occurred_at'])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger agent_audit_events_no_update before update on agent_audit_events
        for each row signal sqlstate '45000' set message_text = 'agent audit events are immutable'`.execute(db);
      await sql`create trigger agent_audit_events_no_delete before delete on agent_audit_events
        for each row signal sqlstate '45000' set message_text = 'agent audit events are immutable'`.execute(db);
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger agent_audit_events_immutable on agent_audit_events
        instead of update, delete as throw 51000, 'agent audit events are immutable', 1`.execute(db);
    } else {
      await sql`create function reject_agent_audit_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent audit events are immutable'; end $$`.execute(db);
      await sql`create trigger agent_audit_events_immutable before update or delete on agent_audit_events
        for each row execute function reject_agent_audit_mutation()`.execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('agent_audit_events').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_audit_mutation()`.execute(db);
    await db.schema.dropTable('agent_executions').execute();
    await db.schema.dropTable('agent_approvals').execute();
  },
};
