import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  OrderRepository,
  AuditLogRepository,
  PaymentCompensationRepository,
  executeTableQuery,
} from '@tixkit/db';
import {
  col,
  defineTable,
  paramsToQuery,
  type AdminTableQuery,
  type AdminTablePage,
} from '@tixkit/admin-table-core';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import {
  pageEnvelope,
  parsePagination,
  serializeOrder,
  serializeOrderLineItem,
  serializeAttendee,
  serializeRefund,
  serializeInvoice,
  serializeTaxSnapshot,
  serializeTimelineEvent,
  parseJsonValue,
} from '../../http/contracts.js';
import { refundSchema, parseBody } from '../../http/schemas.js';

// ---------------------------------------------------------------------------
// Orders table schema (server-owned, defines allowed filter/sort/sheet fields)
// ---------------------------------------------------------------------------

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

const ordersTableSchema = defineTable('orders', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.enum('eventId', []).serverField('event_id').facet(),
    col.status('status', ORDER_STATUS_PRESETS).serverField('status').sortable().facet(),
    col.enum('salesChannel', SALES_CHANNEL_OPTIONS).serverField('sales_channel').facet(),
    col.enum('paymentProvider', PAYMENT_PROVIDER_OPTIONS).serverField('payment_provider').facet(),
    col.boolean('refundState').serverField('refunded_cents').facet(),
    col.money('totalCents').serverField('total_cents').filterable().facet(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
    col.text('buyerEmail').serverField('buyer_email').filterable().paramAlias('search'),
  ],
});

const orderListColumns = [
  'id',
  'tenant_id',
  'organization_id',
  'brand_id',
  'event_id',
  'checkout_session_id',
  'order_number',
  'status',
  'currency',
  'subtotal_cents',
  'discount_cents',
  'tax_cents',
  'fee_cents',
  'total_cents',
  'refunded_cents',
  'buyer_email',
  'buyer_first_name',
  'buyer_last_name',
  'buyer_phone',
  'payment_intent_id',
  'payment_provider',
  'sales_channel',
  'operator_id',
  'tender_type',
  'paid_at',
  'refunded_at',
  'cancelled_at',
  'created_at',
  'updated_at',
] as const;

const orderDetailAttendeeColumns = [
  'id',
  'tenant_id',
  'order_id',
  'event_id',
  'ticket_type_id',
  'event_occurrence_id',
  'ticket_id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'status',
  'custom_answers',
  'checked_in_at',
  'check_in_device_id',
  'created_at',
  'updated_at',
] as const;

const orderDetailRefundColumns = [
  'id',
  'tenant_id',
  'order_id',
  'payment_intent_id',
  'provider',
  'provider_refund_id',
  'amount_cents',
  'currency',
  'status',
  'reason',
  'metadata',
  'created_at',
  'updated_at',
] as const;

const orderInvoiceColumns = [
  'id',
  'order_id',
  'tenant_id',
  'organization_id',
  'brand_id',
  'event_id',
  'invoice_number',
  'status',
  'currency',
  'subtotal_cents',
  'discount_cents',
  'tax_cents',
  'fee_cents',
  'total_cents',
  'refunded_cents',
  'buyer_email',
  'buyer_name',
  'buyer_tax_id',
  'seller_name',
  'seller_tax_id',
  'reverse_charge',
  'issued_at',
  'voided_at',
  'metadata',
  'created_at',
  'updated_at',
] as const;

const orderLineItemColumns = [
  'id',
  'order_id',
  'ticket_type_id',
  'event_occurrence_id',
  'product_id',
  'resale_listing_id',
  'attendee_id',
  'description',
  'quantity',
  'unit_price_cents',
  'subtotal_cents',
  'discount_cents',
  'tax_cents',
  'fee_cents',
  'total_cents',
  'currency',
  'created_at',
  'updated_at',
] as const;

const orderTaxSnapshotColumns = [
  'id',
  'order_id',
  'order_line_item_id',
  'event_id',
  'tax_rule_id',
  'tax_rule_name',
  'rate',
  'type',
  'applied_to',
  'jurisdiction_country',
  'jurisdiction_region',
  'taxable_amount_cents',
  'tax_cents',
  'currency',
  'inclusive',
  'provider',
  'provider_calculation_id',
  'metadata',
  'created_at',
] as const;

function parseStrictTableQuery(
  schema: Parameters<typeof paramsToQuery>[0],
  params: URLSearchParams,
): AdminTableQuery {
  const { query, rejected } = paramsToQuery(schema, params);
  if (rejected.length > 0) {
    throw new ValidationError(`Invalid table query parameters: ${rejected.join(', ')}`, {
      rejected,
    });
  }
  return query;
}

function serializePaymentCompensation(row: {
  id: string;
  tenant_id: string;
  checkout_session_id: string;
  payment_intent_id: string | null;
  provider: string;
  provider_intent_id: string;
  amount_cents: number;
  currency: string;
  action: string;
  status: string;
  provider_compensation_id: string | null;
  attempts: number;
  reason: string;
  last_error: string | null;
  metadata: string;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    checkoutSessionId: row.checkout_session_id,
    paymentIntentId: row.payment_intent_id,
    provider: row.provider,
    providerIntentId: row.provider_intent_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    action: row.action,
    status: row.status,
    providerCompensationId: row.provider_compensation_id,
    attempts: row.attempts,
    reason: row.reason,
    lastError: row.last_error,
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/payment-compensations', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const pagination = parsePagination(request.query);
    const { status, checkoutSessionId, organizationId, brandId } = request.query as {
      status?: string;
      checkoutSessionId?: string;
      organizationId?: string;
      brandId?: string;
    };
    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    if (brandId) ClerkAuthService.requireBrandScope(principal, brandId);
    const repo = new PaymentCompensationRepository(db);
    const rows = await repo.listForTenant({
      tenantId: principal.tenantId,
      organizationIds: organizationId
        ? [organizationId]
        : principal.type === 'system'
          ? undefined
          : principal.organizationIds,
      brandIds: brandId ? [brandId] : principal.brandIds,
      eventIds: principal.eventIds,
      status,
      checkoutSessionId,
      limit: pagination.limit,
      cursor: pagination.cursor,
    });
    return pageEnvelope(
      rows.map((row) => serializePaymentCompensation(row)),
      pagination.limit,
    );
  });

  app.get('/orders', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');

    const rawQuery = request.query as Record<string, string | undefined>;
    const { organizationId, brandId } = rawQuery;

    // Permission scope checks for explicit org/brand params
    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    if (brandId) ClerkAuthService.requireBrandScope(principal, brandId);

    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return {
        items: [],
        nextCursor: undefined,
        total: 0,
        filterTotal: 0,
      } as AdminTablePage<unknown>;
    }

    // Build scope: tenant + principal org/brand/event restrictions + explicit org/brand
    const scope: Record<string, string | string[]> = {};
    if (organizationId) {
      scope.organization_id = organizationId;
    } else if (principal.type !== 'system') {
      scope.organization_id = principal.organizationIds;
    }
    if (brandId) {
      scope.brand_id = brandId;
    } else if (principal.brandIds && principal.brandIds.length > 0) {
      scope.brand_id = principal.brandIds;
    }
    if (principal.eventIds && principal.eventIds.length > 0) {
      scope.event_id = principal.eventIds;
    }

    // Parse flat query params into AdminTableQuery using the server-owned schema
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(rawQuery)) {
      if (value !== undefined && key !== 'organizationId' && key !== 'brandId') {
        searchParams.set(key, value);
      }
    }
    const tableQuery = parseStrictTableQuery(ordersTableSchema, searchParams);

    // Execute the table query with custom refundState filter and facet
    const result = await executeTableQuery(
      db,
      {
        tableName: 'orders',
        schema: ordersTableSchema,
        tenantId: principal.tenantId,
        scope,
        serialize: serializeOrder,
        selectFields: orderListColumns,
        strictValidation: true,
        customFilters: {
          refundState: (q, value) => {
            if (value.type === 'boolean') {
              return value.value
                ? q.where('refunded_cents', '>', 0)
                : q.where('refunded_cents', '=', 0);
            }
            return q;
          },
        },
        customFacets: {
          refundState: async (q) => {
            const refundCounts = (await q
              .select([
                sql`case when refunded_cents > 0 then true else false end`.as('is_refunded'),
                sql`count(*)`.as('total'),
              ])
              .groupBy('is_refunded')
              .execute()) as Array<{ is_refunded: boolean; total: number }>;
            return {
              rows: refundCounts.map((r) => ({ value: r.is_refunded, total: Number(r.total) })),
            };
          },
        },
      },
      tableQuery,
    );

    // Fetch event titles for the current page items (separate from the table query)
    const eventIds = [
      ...new Set(result.items.map((o) => (o as Record<string, unknown>).eventId).filter(Boolean)),
    ] as string[];
    const eventTitles = new Map<string, string>();
    if (eventIds.length > 0) {
      const events = await db
        .selectFrom('events')
        .select(['id', 'title'])
        .where('id', 'in', eventIds)
        .execute();
      for (const event of events) {
        eventTitles.set(event.id, event.title);
      }
    }

    // Enrich items with event titles
    const items = result.items.map((item) => {
      const order = item as Record<string, unknown>;
      return {
        ...order,
        eventTitle: eventTitles.get(order.eventId as string) ?? '',
      };
    });

    return {
      ...result,
      items,
    } as AdminTablePage<unknown>;
  });

  app.get('/orders/:orderId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const repo = new OrderRepository(db);
    const order = await repo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const [
      lineItems,
      timeline,
      attendees,
      refunds,
      checkoutSession,
      invoice,
      taxSnapshots,
      eventData,
    ] = await Promise.all([
      repo.getLineItems(orderId),
      repo.getTimeline(orderId),
      db
        .selectFrom('attendees')
        .select(orderDetailAttendeeColumns)
        .where('order_id', '=', orderId)
        .execute(),
      db
        .selectFrom('refunds')
        .select(orderDetailRefundColumns)
        .where('order_id', '=', orderId)
        .orderBy('created_at', 'asc')
        .execute(),
      order.checkout_session_id
        ? db
            .selectFrom('checkout_sessions')
            .select(['cart'])
            .where('id', '=', order.checkout_session_id)
            .executeTakeFirst()
        : Promise.resolve(undefined),
      db
        .selectFrom('invoices')
        .select(orderInvoiceColumns)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
      db
        .selectFrom('order_tax_snapshots')
        .select(orderTaxSnapshotColumns)
        .where('order_id', '=', orderId)
        .execute(),
      db.selectFrom('events').select('title').where('id', '=', order.event_id).executeTakeFirst(),
    ]);
    const cart = parseJsonValue(checkoutSession?.cart, {}) as Record<string, unknown>;
    const buyerFields =
      cart.buyerFields && typeof cart.buyerFields === 'object'
        ? (cart.buyerFields as Record<string, unknown>)
        : {};
    const attendeeFields =
      cart.attendeeFields && typeof cart.attendeeFields === 'object'
        ? (cart.attendeeFields as Record<string, unknown>)
        : {};
    const consentSnapshots = Object.fromEntries(
      Object.entries(buyerFields).filter(([, answer]) => {
        return Boolean(
          answer &&
          typeof answer === 'object' &&
          'consentText' in answer &&
          'consentVersion' in answer,
        );
      }),
    );

    return {
      ...serializeOrder({ ...order, event_title: eventData?.title }),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      attendees: attendees.map((row) => serializeAttendee(row)),
      invoice: invoice ? serializeInvoice(invoice) : undefined,
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
      checkoutAnswers: {
        buyerFields,
        attendeeFields,
      },
      consentSnapshots,
      refunds: refunds.map((row) => serializeRefund(row)),
      timeline: timeline.map((row) => serializeTimelineEvent(row)),
      deliveryStatus: {
        email: order.buyer_email ? 'pending' : 'not_applicable',
        tickets: attendees.length > 0 ? 'issued' : 'not_issued',
      },
    };
  });

  app.get('/orders/:orderId/invoice', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const order = await new OrderRepository(db).findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const [invoice, lineItems, taxSnapshots] = await Promise.all([
      db
        .selectFrom('invoices')
        .select(orderInvoiceColumns)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
      db
        .selectFrom('order_line_items')
        .select(orderLineItemColumns)
        .where('order_id', '=', orderId)
        .execute(),
      db
        .selectFrom('order_tax_snapshots')
        .select(orderTaxSnapshotColumns)
        .where('order_id', '=', orderId)
        .execute(),
    ]);
    if (!invoice) throw new NotFoundError('Invoice', orderId);
    return {
      invoice: serializeInvoice(invoice),
      order: serializeOrder(order),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
    };
  });

  app.get('/orders/:orderId/invoice/download', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const order = await new OrderRepository(db).findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);
    const [invoice, lineItems, taxSnapshots] = await Promise.all([
      db
        .selectFrom('invoices')
        .select(orderInvoiceColumns)
        .where('order_id', '=', orderId)
        .executeTakeFirst(),
      db
        .selectFrom('order_line_items')
        .select(orderLineItemColumns)
        .where('order_id', '=', orderId)
        .execute(),
      db
        .selectFrom('order_tax_snapshots')
        .select(orderTaxSnapshotColumns)
        .where('order_id', '=', orderId)
        .execute(),
    ]);
    if (!invoice) throw new NotFoundError('Invoice', orderId);
    const body = {
      invoice: serializeInvoice(invoice),
      order: serializeOrder(order),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
    };
    const filename = `${invoice.invoice_number}.json`;
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(JSON.stringify(body));
  });

  app.post('/orders/:orderId/cancel', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.write');
    const { orderId } = request.params as { orderId: string };
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for order cancellation');
    }
    const repo = new OrderRepository(db);
    const order = await repo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ orderId, action: 'cancel' }),
      },
      async () => {
        if (order.status === 'cancelled') {
          return { status: 200, body: serializeOrder(order) };
        }
        if (order.status === 'paid' || order.status === 'partially_refunded') {
          throw new ValidationError('Cannot cancel a paid order. Use refund instead.');
        }

        const updated = await repo.update(orderId, {
          status: 'cancelled',
          cancelled_at: new Date(),
        });
        await repo.addTimelineEvent(
          orderId,
          'order.cancelled',
          'Order cancelled',
          undefined,
          principal.id,
        );
        await writeAuditLog(new AuditLogRepository(db), request, principal, {
          action: 'order.cancelled',
          organizationId: order.organization_id,
          brandId: order.brand_id,
          resourceType: 'Order',
          resourceId: orderId,
        });
        return { status: 200, body: serializeOrder(updated) };
      },
    );

    return reply.status(result.status).send(result.body);
  });

  app.post('/orders/:orderId/refunds', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'refunds.write');
    const { orderId } = request.params as { orderId: string };
    const body = parseBody(refundSchema, request.body);
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      throw new ValidationError('Refund reason is required');
    }

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for refunds');
    }

    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          orderId,
          amountCents: body.amountCents ?? null,
          reason: body.reason,
          voidTickets: body.voidTickets ?? true,
          restoreInventory: body.restoreInventory ?? false,
        }),
      },
      async () => {
        if (order.status !== 'paid' && order.status !== 'partially_refunded') {
          throw new ValidationError('Order is not in a refundable state');
        }

        const refundAmount =
          body.amountCents ?? Number(order.total_cents) - Number(order.refunded_cents);
        const alreadyRefunded = Number(order.refunded_cents);

        if (refundAmount <= 0) {
          throw new ValidationError('Refund amount must be positive');
        }
        if (alreadyRefunded + refundAmount > Number(order.total_cents)) {
          throw new ValidationError('Refund amount exceeds order total');
        }

        await app.context.temporalClient.startRefund({
          orderId: order.id,
          amountCents: refundAmount,
          reason: body.reason,
          buyerEmail: order.buyer_email,
          voidTickets: body.voidTickets ?? true,
          restoreInventory: body.restoreInventory ?? false,
          idempotencyKey,
          tenantId: order.tenant_id,
          brandId: order.brand_id,
          orderTotalCents: Number(order.total_cents),
          alreadyRefundedCents: alreadyRefunded,
          nonce: idempotencyKey,
        });

        await writeAuditLog(new AuditLogRepository(db), request, principal, {
          action: 'order.refund.requested',
          organizationId: order.organization_id,
          brandId: order.brand_id,
          resourceType: 'Order',
          resourceId: orderId,
          diffSummary: { amountCents: refundAmount, reason: body.reason },
        });

        return {
          status: 202,
          body: { orderId, refundAmount, status: 'pending', message: 'Refund workflow started' },
        };
      },
    );

    return reply.status(result.status).send(result.body);
  });
};
