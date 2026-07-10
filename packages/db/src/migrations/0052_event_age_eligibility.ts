import type { Migration } from 'kysely/migration';

export const EventAgeEligibilityMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('events').addColumn('minimum_age', 'integer').execute();
    await db.schema.alterTable('orders').addColumn('buyer_date_of_birth', 'varchar(10)').execute();
    await db.schema.alterTable('attendees').addColumn('date_of_birth', 'varchar(10)').execute();
  },

  async down(db): Promise<void> {
    await db.schema.alterTable('attendees').dropColumn('date_of_birth').execute();
    await db.schema.alterTable('orders').dropColumn('buyer_date_of_birth').execute();
    await db.schema.alterTable('events').dropColumn('minimum_age').execute();
  },
};
