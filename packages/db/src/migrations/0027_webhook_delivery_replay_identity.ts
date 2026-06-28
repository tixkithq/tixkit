import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function ignoreMissingIndex(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const record = error as {
      code?: string;
      errno?: number | string;
      message?: string;
    };
    const message = record.message ?? '';
    if (
      record.code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
      record.errno === 1091 ||
      record.errno === '1091' ||
      /does not exist|check that column\/key exists/i.test(message)
    ) {
      return;
    }
    throw error;
  }
}

async function dropWebhookDeliveriesIndex(db: Kysely<unknown>, indexName: string): Promise<void> {
  if (isMysql()) {
    await ignoreMissingIndex(() =>
      sql`alter table webhook_deliveries drop index ${sql.id(indexName)}`
        .execute(db)
        .then(() => undefined),
    );
    return;
  }

  if (isMssql()) {
    await db.schema.dropIndex(indexName).on('webhook_deliveries').ifExists().execute();
    return;
  }

  await sql`drop index if exists ${sql.id(indexName)}`.execute(db);
}

export const WebhookDeliveryReplayIdentityMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('webhook_deliveries')
      .addColumn('delivery_key', 'varchar(128)', (col) => col.notNull().defaultTo('live'))
      .execute();

    await db.schema
      .createIndex('uniq_webhook_deliveries_delivery_identity')
      .on('webhook_deliveries')
      .columns(['event_id', 'requested_endpoint_id', 'attempt', 'delivery_key'])
      .unique()
      .execute();

    await dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_attempt_identity');
  },

  async down(db): Promise<void> {
    const replayRow = await db
      .selectFrom('webhook_deliveries')
      .select('id')
      .where('delivery_key', '!=', 'live')
      .limit(1)
      .executeTakeFirst();

    if (replayRow) {
      throw new Error(
        'Cannot roll back webhook delivery replay identity while replay deliveries exist',
      );
    }

    await dropWebhookDeliveriesIndex(db, 'uniq_webhook_deliveries_delivery_identity');

    await db.schema.alterTable('webhook_deliveries').dropColumn('delivery_key').execute();

    await db.schema
      .createIndex('uniq_webhook_deliveries_attempt_identity')
      .on('webhook_deliveries')
      .columns(['event_id', 'requested_endpoint_id', 'attempt'])
      .unique()
      .execute();
  },
};
