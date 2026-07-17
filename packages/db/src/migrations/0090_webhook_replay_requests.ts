import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const WebhookReplayRequestsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('webhook_events')
      .addUniqueConstraint('webhook_events_replay_scope_unique', [
        'tenant_id',
        'organization_id',
        'id',
      ])
      .execute();
    await db.schema
      .createTable('webhook_replay_requests')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('tenant_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('organization_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('event_id', 'varchar(32)', (column) => column.notNull())
      .addColumn('idempotency_key_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('request_sha256', 'varchar(64)', (column) => column.notNull())
      .addColumn('endpoint_ids_json', 'text', (column) => column.notNull())
      .addColumn('response_json', 'text', (column) => column.notNull())
      .addColumn('status', 'varchar(16)', (column) => column.notNull())
      .addColumn('created_at', timestampType(), (column) =>
        column.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
      )
      .addColumn('completed_at', timestampType())
      .addUniqueConstraint('webhook_replay_requests_key_unique', [
        'tenant_id',
        'idempotency_key_sha256',
      ])
      .addCheckConstraint(
        'webhook_replay_requests_status_valid',
        sql`status in ('prepared', 'completed')`,
      )
      .addForeignKeyConstraint('webhook_replay_requests_tenant_fk', ['tenant_id'], 'tenants', [
        'id',
      ])
      .addForeignKeyConstraint(
        'webhook_replay_requests_organization_fk',
        ['tenant_id', 'organization_id'],
        'organizations',
        ['tenant_id', 'id'],
      )
      .addForeignKeyConstraint(
        'webhook_replay_requests_event_fk',
        ['tenant_id', 'organization_id', 'event_id'],
        'webhook_events',
        ['tenant_id', 'organization_id', 'id'],
      )
      .execute();

    await db.schema
      .createIndex('webhook_replay_requests_event_created_idx')
      .on('webhook_replay_requests')
      .columns(['tenant_id', 'event_id', 'created_at'])
      .execute();
  },

  async down(db): Promise<void> {
    const existing = await db
      .selectFrom('webhook_replay_requests')
      .select('id')
      .limit(1)
      .executeTakeFirst();
    if (existing) {
      throw new Error(
        'Cannot roll back webhook replay requests while durable replay evidence exists',
      );
    }
    await db.schema.dropTable('webhook_replay_requests').execute();
    await db.schema
      .alterTable('webhook_events')
      .dropConstraint('webhook_events_replay_scope_unique')
      .execute();
  },
};
