/**
 * Client-side table schema definitions.
 *
 * These mirror the server-owned schemas in `packages/api/src/routes/modules/`.
 * They define which columns are filterable, sortable, faceted, and how filters
 * map to flat URL query params.
 */

import { col, defineTable, type TableSchema } from '@tixkit/admin-table-core';

const ORDER_STATUS_PRESETS = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;

const SALES_CHANNEL_OPTIONS = ['online', 'box_office'] as const;

const PAYMENT_PROVIDER_OPTIONS = ['stripe', 'free', 'manual'] as const;

export const ordersTableSchema: TableSchema = defineTable('orders', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.enum('eventId', []).facet(),
    col.status('status', ORDER_STATUS_PRESETS).sortable().facet(),
    col.enum('salesChannel', SALES_CHANNEL_OPTIONS).facet(),
    col.enum('paymentProvider', PAYMENT_PROVIDER_OPTIONS).facet(),
    col.boolean('refundState').facet(),
    col.money('totalCents').filterable().facet(),
    col.dateTime('createdAt').sortable().filterable().facet(),
    col.text('buyerEmail').filterable().paramAlias('search'),
  ],
});

const ATTENDEE_STATUS_PRESETS = ['active', 'cancelled', 'refunded', 'transferred'] as const;

const CHECK_IN_STATUS_PRESETS = ['checked_in', 'not_checked_in', 'revoked'] as const;

export const attendeesTableSchema: TableSchema = defineTable('attendees', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.enum('eventId', []).facet(),
    col.status('status', ATTENDEE_STATUS_PRESETS).sortable().facet(),
    col.enum('checkInStatus', CHECK_IN_STATUS_PRESETS).facet(),
    col.dateTime('createdAt').sortable().filterable().facet(),
    col.dateTime('checkedInAt').filterable(),
  ],
});

export const auditLogTableSchema: TableSchema = defineTable('audit_logs', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.enum('action', []).facet(),
    col.enum('resourceType', []).facet(),
    col.text('actorId').filterable(),
    col.dateTime('createdAt').sortable().filterable().facet(),
  ],
});

const PRIVACY_REQUEST_STATUS_PRESETS = ['pending', 'processing', 'completed', 'failed'] as const;

export const privacyRequestTableSchema: TableSchema = defineTable('privacy_requests', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.enum('requestType', ['export', 'erasure']).facet(),
    col.status('status', PRIVACY_REQUEST_STATUS_PRESETS).sortable().facet(),
    col.enum('subjectType', ['buyer', 'attendee']).facet(),
    col.dateTime('createdAt').sortable().filterable().facet(),
    col.dateTime('completedAt').filterable(),
  ],
});

const EVENT_STATUS_PRESETS = ['draft', 'published', 'paused', 'archived'] as const;

export const eventsTableSchema: TableSchema = defineTable('events', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.status('status', EVENT_STATUS_PRESETS).sortable().facet(),
    col.text('title').filterable().paramAlias('search'),
    col.dateTime('startsAt').sortable().filterable().facet(),
    col.dateTime('createdAt').sortable().filterable().facet(),
  ],
});
