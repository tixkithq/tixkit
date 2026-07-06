import type { Migration } from 'kysely/migration';

/**
 * Indexes for admin table query filtering and cursor pagination.
 *
 * These composite indexes support the TBL-021 Kysely table query helper:
 * - Default sort by created_at desc with id tie-breaker
 * - Filter by event_id, status, organization_id
 * - Text search on buyer_email
 *
 * See TBL-022 in the implementation plan.
 */
export const TableQueryIndexesMigration: Migration = {
  async up(db): Promise<void> {
    // Orders: default sort + cursor pagination
    await db.schema
      .createIndex('idx_orders_tenant_created_id')
      .on('orders')
      .columns(['tenant_id', 'created_at', 'id'])
      .execute();

    // Orders: filter by event + sort
    await db.schema
      .createIndex('idx_orders_tenant_event_created_id')
      .on('orders')
      .columns(['tenant_id', 'event_id', 'created_at', 'id'])
      .execute();

    // Orders: filter by status + sort
    await db.schema
      .createIndex('idx_orders_tenant_status_created_id')
      .on('orders')
      .columns(['tenant_id', 'status', 'created_at', 'id'])
      .execute();

    // Orders: buyer email search
    await db.schema
      .createIndex('idx_orders_tenant_buyer_email')
      .on('orders')
      .columns(['tenant_id', 'buyer_email'])
      .execute();

    // Attendees: filter by event + sort
    await db.schema
      .createIndex('idx_attendees_tenant_event_created_id')
      .on('attendees')
      .columns(['tenant_id', 'event_id', 'created_at', 'id'])
      .execute();

    // Attendees: filter by event + status
    await db.schema
      .createIndex('idx_attendees_tenant_event_status')
      .on('attendees')
      .columns(['tenant_id', 'event_id', 'status'])
      .execute();

    // Audit logs: filter by org + sort
    await db.schema
      .createIndex('idx_audit_logs_tenant_org_created_id')
      .on('audit_logs')
      .columns(['tenant_id', 'organization_id', 'created_at', 'id'])
      .execute();

    // Privacy requests: filter by status + sort
    await db.schema
      .createIndex('idx_privacy_requests_tenant_status_created_id')
      .on('privacy_requests')
      .columns(['tenant_id', 'status', 'created_at', 'id'])
      .execute();

    // Webhook deliveries: filter by endpoint + status + sort
    await db.schema
      .createIndex('idx_webhook_deliveries_endpoint_status_created_id')
      .on('webhook_deliveries')
      .columns(['requested_endpoint_id', 'status', 'created_at', 'id'])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropIndex('idx_orders_tenant_created_id').on('orders').ifExists().execute();
    await db.schema.dropIndex('idx_orders_tenant_event_created_id').on('orders').ifExists().execute();
    await db.schema.dropIndex('idx_orders_tenant_status_created_id').on('orders').ifExists().execute();
    await db.schema.dropIndex('idx_orders_tenant_buyer_email').on('orders').ifExists().execute();
    await db.schema.dropIndex('idx_attendees_tenant_event_created_id').on('attendees').ifExists().execute();
    await db.schema.dropIndex('idx_attendees_tenant_event_status').on('attendees').ifExists().execute();
    await db.schema.dropIndex('idx_audit_logs_tenant_org_created_id').on('audit_logs').ifExists().execute();
    await db.schema
      .dropIndex('idx_privacy_requests_tenant_status_created_id')
      .on('privacy_requests')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('idx_webhook_deliveries_endpoint_status_created_id')
      .on('webhook_deliveries')
      .ifExists()
      .execute();
  },
};
