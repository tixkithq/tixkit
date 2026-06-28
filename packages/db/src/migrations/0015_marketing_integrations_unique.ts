import type { Migration } from 'kysely/migration';

export const MarketingIntegrationsUniqueMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('uniq_marketing_integrations_event_provider')
      .on('marketing_integrations')
      .columns(['event_id', 'provider'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('uniq_marketing_integrations_event_provider').ifExists().execute();
  },
};
