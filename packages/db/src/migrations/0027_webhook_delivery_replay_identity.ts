import type { Migration } from 'kysely/migration';

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

    await db.schema
      .dropIndex('uniq_webhook_deliveries_attempt_identity')
      .on('webhook_deliveries')
      .ifExists()
      .execute();
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

    await db.schema
      .dropIndex('uniq_webhook_deliveries_delivery_identity')
      .on('webhook_deliveries')
      .ifExists()
      .execute();

    await db.schema.alterTable('webhook_deliveries').dropColumn('delivery_key').execute();

    await db.schema
      .createIndex('uniq_webhook_deliveries_attempt_identity')
      .on('webhook_deliveries')
      .columns(['event_id', 'requested_endpoint_id', 'attempt'])
      .unique()
      .execute();
  },
};
