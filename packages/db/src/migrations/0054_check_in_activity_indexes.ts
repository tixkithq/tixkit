import type { Migration } from 'kysely/migration';

export const CheckInActivityIndexesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_scan_logs_activity_cursor')
      .on('scan_logs')
      .columns(['tenant_id', 'check_in_list_id', 'id'])
      .execute();
    await db.schema
      .createIndex('idx_scan_logs_activity_outcome')
      .on('scan_logs')
      .columns(['tenant_id', 'check_in_list_id', 'outcome'])
      .execute();
    await db.schema
      .createIndex('idx_tickets_check_in_summary')
      .on('tickets')
      .columns(['tenant_id', 'event_id', 'ticket_type_id', 'event_occurrence_id', 'status'])
      .execute();
  },
  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_tickets_check_in_summary').on('tickets').ifExists().execute();
    await db.schema
      .dropIndex('idx_scan_logs_activity_outcome')
      .on('scan_logs')
      .ifExists()
      .execute();
    await db.schema.dropIndex('idx_scan_logs_activity_cursor').on('scan_logs').ifExists().execute();
  },
};
