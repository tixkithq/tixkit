import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

function booleanType(): ColumnDataType | Expression<unknown> {
  return process.env.DB_DRIVER === 'mssql' ? sql`bit` : 'boolean';
}

export const AgentActionsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('agent_actions')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('delegation_grant_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_kind', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_json', 'text', (column) => column.notNull())
      .addColumn('resource_type', 'varchar(64)', (column) => column.notNull())
      .addColumn('resource_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('resource_version', 'bigint', (column) => column.notNull())
      .addColumn('policy_version', 'bigint', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('authorization_snapshot_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('authorization_reasons', 'text', (column) => column.notNull())
      .addColumn('dry_run_json', 'text', (column) => column.notNull())
      .addColumn('eligible_for_approval', booleanType(), (column) => column.notNull())
      .addColumn('prepared_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_actions_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_actions_principal_fk',
        ['tenant_id', 'agent_principal_id'],
        'agent_principals',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'agent_actions_delegation_fk',
        ['tenant_id', 'delegation_grant_id'],
        'agent_delegations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_actions_tenant_id_unique', ['tenant_id', 'id'])
      .addUniqueConstraint('agent_actions_idempotency_unique', [
        'tenant_id',
        'agent_principal_id',
        'idempotency_key',
      ])
      .execute();
    await db.schema
      .createIndex('agent_actions_resource_idx')
      .on('agent_actions')
      .columns(['tenant_id', 'resource_type', 'resource_id', 'prepared_at'])
      .execute();

    await db.schema.alterTable('agent_approvals').addColumn('action_id', 'varchar(64)').execute();
    await db.schema
      .alterTable('agent_approvals')
      .addForeignKeyConstraint(
        'agent_approvals_action_fk',
        ['tenant_id', 'action_id'],
        'agent_actions',
        ['tenant_id', 'id'],
      )
      .execute();
    await db.schema
      .createIndex('agent_approvals_action_id_idx')
      .on('agent_approvals')
      .columns(['tenant_id', 'action_id'])
      .execute();

    await db.schema
      .createTable('agent_action_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('action_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('actor_type', 'varchar(32)', (column) => column.notNull())
      .addColumn('actor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('phase', 'varchar(32)', (column) => column.notNull())
      .addColumn('approval_id', 'varchar(64)')
      .addColumn('execution_id', 'varchar(64)')
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('authorization_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('outcome', 'varchar(32)', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_action_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_action_events_action_fk',
        ['tenant_id', 'action_id'],
        'agent_actions',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_action_events_idempotency_unique', [
        'tenant_id',
        'actor_principal_id',
        'phase',
        'idempotency_key',
      ])
      .execute();
    await db.schema
      .createIndex('agent_action_events_action_idx')
      .on('agent_action_events')
      .columns(['tenant_id', 'action_id', 'occurred_at'])
      .execute();

    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger agent_actions_no_update before update on agent_actions
        for each row signal sqlstate '45000' set message_text = 'agent actions are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_actions_no_delete before delete on agent_actions
        for each row signal sqlstate '45000' set message_text = 'agent actions are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_action_events_no_update before update on agent_action_events
        for each row signal sqlstate '45000' set message_text = 'agent action events are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_action_events_no_delete before delete on agent_action_events
        for each row signal sqlstate '45000' set message_text = 'agent action events are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger agent_actions_immutable on agent_actions
        instead of update, delete as throw 51000, 'agent actions are immutable', 1`.execute(db);
      await sql`create trigger agent_action_events_immutable on agent_action_events
        instead of update, delete as throw 51000, 'agent action events are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create function reject_agent_action_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent actions are immutable'; end $$`.execute(db);
      await sql`create trigger agent_actions_immutable before update or delete on agent_actions
        for each row execute function reject_agent_action_mutation()`.execute(db);
      await sql`create function reject_agent_action_event_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent action events are immutable'; end $$`.execute(db);
      await sql`create trigger agent_action_events_immutable before update or delete on agent_action_events
        for each row execute function reject_agent_action_event_mutation()`.execute(db);
    }
    await db
      .updateTable('agent_principals')
      .set({ protocol_version: '2026-07-22' })
      .where('protocol_version', '=', '2026-07-11')
      .execute();
  },

  async down(db): Promise<void> {
    await db
      .updateTable('agent_principals')
      .set({ protocol_version: '2026-07-11' })
      .where('protocol_version', '=', '2026-07-22')
      .execute();
    await db.schema.dropTable('agent_action_events').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_action_event_mutation()`.execute(db);
    await db.schema
      .alterTable('agent_approvals')
      .dropConstraint('agent_approvals_action_fk')
      .execute();
    if (process.env.DB_DRIVER === 'mysql' || process.env.DB_DRIVER === 'mssql') {
      await db.schema
        .dropIndex('agent_approvals_action_id_idx')
        .on('agent_approvals')
        .ifExists()
        .execute();
    } else {
      await sql`drop index if exists agent_approvals_action_id_idx`.execute(db);
    }
    await db.schema.alterTable('agent_approvals').dropColumn('action_id').execute();
    await db.schema.dropTable('agent_actions').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_action_mutation()`.execute(db);
  },
};
