import { sql, type ColumnDataType, type Expression } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType | Expression<unknown> {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? sql`datetime(3)` : 'timestamptz';
}

export const AgentPlansMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('agent_plans')
      .addColumn('id', 'varchar(64)', (column) => column.notNull())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('agent_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('delegation_grant_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('protocol_version', 'varchar(32)', (column) => column.notNull())
      .addColumn('plan_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('plan_json', 'text', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('expires_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('agent_plans_pk', ['tenant_id', 'id'])
      .addForeignKeyConstraint('agent_plans_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addForeignKeyConstraint(
        'agent_plans_principal_fk',
        ['tenant_id', 'agent_principal_id'],
        'agent_principals',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'agent_plans_delegation_fk',
        ['tenant_id', 'delegation_grant_id'],
        'agent_delegations',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_plans_idempotency_unique', [
        'tenant_id',
        'agent_principal_id',
        'idempotency_key',
      ])
      .execute();
    await db.schema
      .createIndex('agent_plans_sponsor_idx')
      .on('agent_plans')
      .columns(['tenant_id', 'sponsor_principal_id', 'created_at'])
      .execute();

    await db.schema
      .createTable('agent_plan_actions')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('plan_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('step_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('action_digest', 'varchar(64)', (column) => column.notNull())
      .addColumn('ordinal', 'integer', (column) => column.notNull())
      .addPrimaryKeyConstraint('agent_plan_actions_pk', ['tenant_id', 'plan_id', 'step_id'])
      .addUniqueConstraint('agent_plan_actions_action_unique', ['tenant_id', 'action_id'])
      .addForeignKeyConstraint(
        'agent_plan_actions_plan_fk',
        ['tenant_id', 'plan_id'],
        'agent_plans',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'agent_plan_actions_action_fk',
        ['tenant_id', 'action_id'],
        'agent_actions',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createTable('agent_plan_states')
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('plan_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('state_version', 'bigint', (column) => column.notNull())
      .addColumn('status', 'varchar(32)', (column) => column.notNull())
      .addColumn('state_json', 'text', (column) => column.notNull())
      .addColumn('state_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('agent_plan_states_pk', ['tenant_id', 'plan_id'])
      .addForeignKeyConstraint(
        'agent_plan_states_plan_fk',
        ['tenant_id', 'plan_id'],
        'agent_plans',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createTable('agent_plan_state_events')
      .addColumn('id', 'varchar(64)', (column) => column.notNull())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('plan_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('previous_state_version', 'bigint')
      .addColumn('next_state_version', 'bigint', (column) => column.notNull())
      .addColumn('previous_state_sha256', 'varchar(64)')
      .addColumn('next_state_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('previous_state_json', 'text')
      .addColumn('next_state_json', 'text', (column) => column.notNull())
      .addColumn('actor_type', 'varchar(32)', (column) => column.notNull())
      .addColumn('actor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('actor_authorization_json', 'text', (column) => column.notNull())
      .addColumn('actor_authorization_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('reason_code', 'varchar(64)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addPrimaryKeyConstraint('agent_plan_state_events_pk', ['tenant_id', 'id'])
      .addForeignKeyConstraint(
        'agent_plan_state_events_plan_fk',
        ['tenant_id', 'plan_id'],
        'agent_plans',
        ['tenant_id', 'id'],
      )
      .addUniqueConstraint('agent_plan_state_events_idempotency_unique', [
        'tenant_id',
        'actor_principal_id',
        'idempotency_key',
      ])
      .execute();

    await db.schema
      .createIndex('agent_executions_approval_unique')
      .unique()
      .on('agent_executions')
      .columns(['tenant_id', 'approval_id'])
      .execute();
    await db.schema
      .createIndex('agent_plan_state_events_plan_idx')
      .on('agent_plan_state_events')
      .columns(['tenant_id', 'plan_id', 'next_state_version'])
      .execute();

    if (process.env.DB_DRIVER === 'mysql') {
      for (const table of ['agent_plans', 'agent_plan_actions', 'agent_plan_state_events']) {
        await sql
          .raw(`create trigger ${table}_no_update before update on ${table}
          for each row signal sqlstate '45000' set message_text = '${table} is immutable'`)
          .execute(db);
        await sql
          .raw(`create trigger ${table}_no_delete before delete on ${table}
          for each row signal sqlstate '45000' set message_text = '${table} is immutable'`)
          .execute(db);
      }
    } else if (process.env.DB_DRIVER === 'mssql') {
      for (const table of ['agent_plans', 'agent_plan_actions', 'agent_plan_state_events'])
        await sql
          .raw(
            `create trigger ${table}_immutable on ${table} instead of update, delete as
             throw 51000, '${table} is immutable', 1`,
          )
          .execute(db);
    } else {
      await sql`create function reject_agent_plan_immutable_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent plan record is immutable'; end $$`.execute(db);
      for (const table of ['agent_plans', 'agent_plan_actions', 'agent_plan_state_events'])
        await sql
          .raw(
            `create trigger ${table}_immutable before update or delete on ${table}
             for each row execute function reject_agent_plan_immutable_mutation()`,
          )
          .execute(db);
    }
  },

  async down(db): Promise<void> {
    const populated = await db
      .selectFrom('agent_plans')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    if (Number(populated?.count ?? 0) > 0)
      throw new Error('agent plan rollback refused: immutable plan history exists');
    if (process.env.DB_DRIVER === 'mysql') {
      const index = await sql<{ count: number }>`select count(*) as count
        from information_schema.statistics
        where table_schema = database()
          and table_name = 'agent_executions'
          and index_name = 'agent_executions_approval_unique'`.execute(db);
      if (Number(index.rows[0]?.count ?? 0) > 0) {
        const supportingIndex = await sql<{ count: number }>`select count(*) as count
          from information_schema.statistics
          where table_schema = database()
            and table_name = 'agent_executions'
            and index_name = 'agent_executions_approval_idx'`.execute(db);
        if (Number(supportingIndex.rows[0]?.count ?? 0) === 0)
          await db.schema
            .createIndex('agent_executions_approval_idx')
            .on('agent_executions')
            .columns(['tenant_id', 'approval_id'])
            .execute();
        await db.schema
          .dropIndex('agent_executions_approval_unique')
          .on('agent_executions')
          .execute();
      }
    } else if (process.env.DB_DRIVER === 'mssql')
      await db.schema
        .dropIndex('agent_executions_approval_unique')
        .on('agent_executions')
        .ifExists()
        .execute();
    else await sql`drop index if exists agent_executions_approval_unique`.execute(db);
    await db.schema.dropTable('agent_plan_state_events').execute();
    await db.schema.dropTable('agent_plan_states').execute();
    await db.schema.dropTable('agent_plan_actions').execute();
    await db.schema.dropTable('agent_plans').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_plan_immutable_mutation()`.execute(db);
  },
};
