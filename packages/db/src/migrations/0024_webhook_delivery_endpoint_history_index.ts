import type { Migration } from 'kysely/migration';

export const WebhookDeliveryEndpointHistoryIndexMigration: Migration = {
  async up(db): Promise<void> {
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
