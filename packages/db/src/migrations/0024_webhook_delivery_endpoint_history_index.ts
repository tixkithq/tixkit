import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function requestedEndpointColumnExists(db: Parameters<Migration['up']>[0]): Promise<boolean> {
  if (isMysql()) {
    const result = await sql<{ column_name: string }>`
      select column_name
      from information_schema.columns
      where table_schema = database()
        and table_name = 'webhook_deliveries'
        and column_name = 'requested_endpoint_id'
      limit 1
    `.execute(db);

    return result.rows.length > 0;
  }

  if (isMssql()) {
    const result = await sql<{ column_name: string }>`
      select top 1 column_name
      from information_schema.columns
      where table_schema = schema_name()
        and table_name = 'webhook_deliveries'
        and column_name = 'requested_endpoint_id'
    `.execute(db);

    return result.rows.length > 0;
  }

  const result = await sql<{ column_name: string }>`
    select column_name
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'webhook_deliveries'
      and column_name = 'requested_endpoint_id'
    limit 1
  `.execute(db);

  return result.rows.length > 0;
}

async function ensureRequestedEndpointColumn(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (await requestedEndpointColumnExists(db)) return;

  if (isMysql()) {
    await sql`alter table webhook_deliveries add column requested_endpoint_id varchar(32) null`.execute(
      db,
    );
    await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
    await sql`alter table webhook_deliveries modify requested_endpoint_id varchar(32) not null`.execute(
      db,
    );
    return;
  }

  if (isMssql()) {
    await sql`alter table webhook_deliveries add requested_endpoint_id varchar(32) null`.execute(
      db,
    );
    await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
    await sql`alter table webhook_deliveries alter column requested_endpoint_id varchar(32) not null`.execute(
      db,
    );
    return;
  }

  await sql`alter table webhook_deliveries add column requested_endpoint_id varchar(32)`.execute(
    db,
  );
  await sql`update webhook_deliveries set requested_endpoint_id = endpoint_id`.execute(db);
  await sql`alter table webhook_deliveries alter column requested_endpoint_id set not null`.execute(
    db,
  );
}

export const WebhookDeliveryEndpointHistoryIndexMigration: Migration = {
  async up(db): Promise<void> {
    await ensureRequestedEndpointColumn(db);

    await db.schema
      .createIndex('idx_webhook_deliveries_requested_endpoint_history')
      .on('webhook_deliveries')
      .columns(['requested_endpoint_id', 'created_at', 'id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_webhook_deliveries_requested_endpoint_history')
      .on('webhook_deliveries')
      .ifExists()
      .execute();
  },
};
