import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function booleanType(): ColumnDataType | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`bit` : 'boolean';
}

export const AgentIdentityMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('agent_principals')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('kind', 'varchar(32)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('capabilities', 'text', (column) => column.notNull())
      .addColumn('maximum_autonomy', 'varchar(32)', (column) => column.notNull())
      .addColumn('protocol_version', 'varchar(32)', (column) => column.notNull())
      .addColumn('state', 'varchar(20)', (column) => column.notNull())
      .addColumn('registered_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_principals_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addUniqueConstraint('agent_principals_tenant_id_unique', ['tenant_id', 'id'])
      .execute();

    await db.schema
      .createTable('agent_delegations')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('capabilities', 'text', (column) => column.notNull())
      .addColumn('resource_scopes', 'text', (column) => column.notNull())
      .addColumn('permission_snapshot', 'text', (column) => column.notNull())
      .addColumn('issued_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addColumn('revoked_at', timestampType())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_delegations_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_delegations_principal_fk',
        ['tenant_id', 'agent_principal_id'],
        'agent_principals',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_delegations_tenant_id_unique', ['tenant_id', 'id'])
      .execute();
    await db.schema
      .createIndex('agent_delegations_principal_idx')
      .on('agent_delegations')
      .columns(['tenant_id', 'agent_principal_id', 'revoked_at'])
      .execute();

    await db.schema
      .createTable('agent_action_policies')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action_kind', 'varchar(64)', (column) => column.notNull())
      .addColumn('allowed', booleanType(), (column) => column.notNull())
      .addColumn('risk_allowed', booleanType(), (column) => column.notNull())
      .addColumn('policy_version', 'bigint', (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('agent_action_policies_pk', ['tenant_id', 'action_kind'])
      .addForeignKeyConstraint('agent_action_policies_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .execute();

    await db.schema
      .createTable('agent_action_effects')
      .addColumn('execution_id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('resource_type', 'varchar(64)', (column) => column.notNull())
      .addColumn('resource_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('operation', 'varchar(128)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('expected_policy_version', 'bigint', (column) => column.notNull())
      .addColumn('expected_resource_version', 'bigint', (column) => column.notNull())
      .addColumn('effect_fence_token', 'bigint', (column) => column.notNull())
      .addColumn('result', 'text', (column) => column.notNull())
      .addColumn('result_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint(
        'agent_action_effects_execution_fk',
        ['tenant_id', 'execution_id'],
        'agent_executions',
        ['tenant_id', 'id'],
      )
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger agent_action_effects_no_update before update on agent_action_effects
        for each row signal sqlstate '45000' set message_text = 'agent action effects are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_action_effects_no_delete before delete on agent_action_effects
        for each row signal sqlstate '45000' set message_text = 'agent action effects are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger agent_action_effects_immutable on agent_action_effects
        instead of update, delete as throw 51000, 'agent action effects are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create function reject_agent_action_effect_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent action effects are immutable'; end $$`.execute(db);
      await sql`create trigger agent_action_effects_immutable before update or delete on agent_action_effects
        for each row execute function reject_agent_action_effect_mutation()`.execute(db);
    }

    await db.schema
      .createTable('agent_control_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('actor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('target_type', 'varchar(32)', (column) => column.notNull())
      .addColumn('target_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('operation', 'varchar(32)', (column) => column.notNull())
      .addColumn('previous_state_sha256', 'varchar(64)')
      .addColumn('new_state_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('reason_code', 'varchar(64)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('actor_authorization_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('outcome', 'varchar(20)', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_control_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addUniqueConstraint('agent_control_events_idempotency_unique', [
        'tenant_id',
        'idempotency_key',
      ])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger agent_control_events_no_update before update on agent_control_events
        for each row signal sqlstate '45000' set message_text = 'agent control events are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_control_events_no_delete before delete on agent_control_events
        for each row signal sqlstate '45000' set message_text = 'agent control events are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger agent_control_events_immutable on agent_control_events
        instead of update, delete as throw 51000, 'agent control events are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create function reject_agent_control_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent control events are immutable'; end $$`.execute(db);
      await sql`create trigger agent_control_events_immutable before update or delete on agent_control_events
        for each row execute function reject_agent_control_mutation()`.execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('agent_control_events').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql') {
      await sql`drop function reject_agent_control_mutation()`.execute(db);
    }
    await db.schema.dropTable('agent_action_effects').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_action_effect_mutation()`.execute(db);
    await db.schema.dropTable('agent_action_policies').execute();
    await db.schema.dropTable('agent_delegations').execute();
    await db.schema.dropTable('agent_principals').execute();
  },
};
