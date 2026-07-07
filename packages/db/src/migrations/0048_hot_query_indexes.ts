import type { Migration } from 'kysely/migration';

/**
 * Composite indexes for public checkout, hosted event pages, and report/date filters.
 *
 * These complement the earlier single-column FK indexes and table-query indexes
 * with the multi-column predicates used by public reads and reporting routes.
 */
export const HotQueryIndexesMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createIndex('idx_content_documents_event_channel_status_locale')
      .on('content_documents')
      .columns(['event_id', 'channel', 'status', 'locale'])
      .execute();

    await db.schema
      .createIndex('idx_event_pages_event_locale_default')
      .on('event_pages')
      .columns(['event_id', 'locale', 'is_default'])
      .execute();

    await db.schema
      .createIndex('idx_questions_event_status_sort')
      .on('questions')
      .columns(['event_id', 'status', 'sort_order', 'id'])
      .execute();

    await db.schema
      .createIndex('idx_checkout_sessions_tenant_event_status')
      .on('checkout_sessions')
      .columns(['tenant_id', 'event_id', 'status'])
      .execute();

    await db.schema
      .createIndex('idx_refunds_order_status_created')
      .on('refunds')
      .columns(['order_id', 'status', 'created_at'])
      .execute();

    await db.schema
      .createIndex('idx_orders_report_event_status_created')
      .on('orders')
      .columns(['tenant_id', 'event_id', 'status', 'created_at', 'id'])
      .execute();

    await db.schema
      .createIndex('idx_order_line_items_order_ticket')
      .on('order_line_items')
      .columns(['order_id', 'ticket_type_id'])
      .execute();

    await db.schema
      .createIndex('idx_order_tax_snapshots_order_rule')
      .on('order_tax_snapshots')
      .columns(['order_id', 'tax_rule_name', 'rate'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('idx_order_tax_snapshots_order_rule')
      .on('order_tax_snapshots')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_order_line_items_order_ticket')
      .on('order_line_items')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_orders_report_event_status_created')
      .on('orders')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_refunds_order_status_created')
      .on('refunds')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_checkout_sessions_tenant_event_status')
      .on('checkout_sessions')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_questions_event_status_sort')
      .on('questions')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_event_pages_event_locale_default')
      .on('event_pages')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_content_documents_event_channel_status_locale')
      .on('content_documents')
      .ifExists()
      .execute();
  },
};
