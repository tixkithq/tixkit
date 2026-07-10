import type { Migration } from 'kysely/migration';

export const CheckoutHoldCapacityIndexMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_checkout_holds_pool_status_expires_quantity')
      .on('checkout_holds')
      .columns(['inventory_pool_id', 'status', 'expires_at', 'quantity'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_checkout_holds_pool_status_expires_quantity')
      .on('checkout_holds')
      .ifExists()
      .execute();
  },
};
