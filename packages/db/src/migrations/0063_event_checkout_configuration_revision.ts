import type { Kysely } from 'kysely';

export const EventCheckoutConfigurationRevisionMigration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .alterTable('events')
      .addColumn('checkout_configuration_updated_at', 'timestamp')
      .execute();
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.alterTable('events').dropColumn('checkout_configuration_updated_at').execute();
  },
};
