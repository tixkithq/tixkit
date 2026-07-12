import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const AgentMemoryMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('agent_memory_entries')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('scope_type', 'varchar(20)', (column) => column.notNull())
      .addColumn('scope_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('purpose', 'varchar(40)', (column) => column.notNull())
      .addColumn('memory_key', 'varchar(64)', (column) => column.notNull())
      .addColumn('content', 'text', (column) => column.notNull())
      .addColumn('content_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('resource_binding_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('provenance', 'text', (column) => column.notNull())
      .addColumn('version', 'bigint', (column) => column.notNull())
      .addColumn('retention_expires_at', timestampType(), (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) => column.notNull())
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_memory_entries_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addUniqueConstraint('agent_memory_namespace_key_unique', [
        'tenant_id',
        'sponsor_principal_id',
        'scope_type',
        'scope_id',
        'purpose',
        'memory_key',
      ])
      .execute();
    await db.schema
      .createIndex('agent_memory_retention_idx')
      .on('agent_memory_entries')
      .columns(['retention_expires_at', 'tenant_id'])
      .execute();

    await db.schema
      .createTable('agent_memory_events')
      .addColumn('id', 'varchar(64)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('sponsor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('scope_type', 'varchar(20)', (column) => column.notNull())
      .addColumn('scope_id', 'varchar(128)', (column) => column.notNull())
      .addColumn('purpose', 'varchar(40)', (column) => column.notNull())
      .addColumn('entry_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('actor_type', 'varchar(20)', (column) => column.notNull())
      .addColumn('actor_principal_id', 'varchar(64)', (column) => column.notNull())
      .addColumn('delegation_id', 'varchar(64)')
      .addColumn('use_id', 'varchar(64)')
      .addColumn('authorization_sha256', 'varchar(64)')
      .addColumn('operation', 'varchar(20)', (column) => column.notNull())
      .addColumn('previous_sha256', 'varchar(64)')
      .addColumn('new_sha256', 'varchar(64)')
      .addColumn('reason_code', 'varchar(64)', (column) => column.notNull())
      .addColumn('idempotency_key', 'varchar(255)', (column) => column.notNull())
      .addColumn('request_fingerprint', 'varchar(64)', (column) => column.notNull())
      .addColumn('outcome', 'varchar(20)', (column) => column.notNull())
      .addColumn('occurred_at', timestampType(), (column) => column.notNull())
      .addForeignKeyConstraint('agent_memory_events_tenant_fk', ['tenant_id'], 'tenants', ['id'])
      .addUniqueConstraint('agent_memory_events_idempotency_unique', [
        'tenant_id',
        'idempotency_key',
      ])
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      await sql`create trigger agent_memory_events_no_update before update on agent_memory_events
        for each row signal sqlstate '45000' set message_text = 'agent memory events are immutable'`.execute(
        db,
      );
      await sql`create trigger agent_memory_events_no_delete before delete on agent_memory_events
        for each row signal sqlstate '45000' set message_text = 'agent memory events are immutable'`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await sql`create trigger agent_memory_events_immutable on agent_memory_events
        instead of update, delete as throw 51000, 'agent memory events are immutable', 1`.execute(
        db,
      );
    } else {
      await sql`create function reject_agent_memory_event_mutation() returns trigger language plpgsql as $$
        begin raise exception 'agent memory events are immutable'; end $$`.execute(db);
      await sql`create trigger agent_memory_events_immutable before update or delete on agent_memory_events
        for each row execute function reject_agent_memory_event_mutation()`.execute(db);
    }
  },
  async down(db): Promise<void> {
    await db.schema.dropTable('agent_memory_events').execute();
    if (process.env.DB_DRIVER !== 'mysql' && process.env.DB_DRIVER !== 'mssql')
      await sql`drop function reject_agent_memory_event_mutation()`.execute(db);
    await db.schema.dropTable('agent_memory_entries').execute();
  },
};
