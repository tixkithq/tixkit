import type { Migration } from 'kysely/migration';

export const ScanLogsTicketIndexMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_scan_logs_ticket')
      .on('scan_logs')
      .columns(['ticket_id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_scan_logs_ticket').on('scan_logs').ifExists().execute();
  },
};
