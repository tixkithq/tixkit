import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import { OrderRepository, AuditLogRepository, PaymentCompensationRepository } from '@tixkit/db';
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
    const { status, checkoutSessionId } = request.query as {
      status?: string;
      checkoutSessionId?: string;
    };
    const repo = new PaymentCompensationRepository(db);
    const rows = await repo.listForTenant({
      tenantId: principal.tenantId,
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
    const pagination = parsePagination(request.query);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }
    let query = db
      .selectFrom('orders')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);

    const { organizationId, eventId } = request.query as {
      organizationId?: string;
      eventId?: string;
    };
    if (organizationId) {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
      query = query.where('organization_id', '=', organizationId);
    }
    if (eventId) {
      query = query.where('event_id', '=', eventId);
    }
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.brandIds && principal.brandIds.length > 0) {
      query = query.where('brand_id', 'in', principal.brandIds);
    }
    if (principal.eventIds && principal.eventIds.length > 0) {
      query = query.where('event_id', 'in', principal.eventIds);
    }
    if (principal.type !== 'system') {
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeOrder(row)),
      pagination.limit,
    );
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

    const [lineItems, timeline, attendees, refunds, checkoutSession, invoice, taxSnapshots] =
      await Promise.all([
        repo.getLineItems(orderId),
        repo.getTimeline(orderId),
        db.selectFrom('attendees').selectAll().where('order_id', '=', orderId).execute(),
        db
          .selectFrom('refunds')
          .selectAll()
          .where('order_id', '=', orderId)
          .orderBy('created_at', 'asc')
          .execute(),
        order.checkout_session_id
          ? db
              .selectFrom('checkout_sessions')
              .selectAll()
              .where('id', '=', order.checkout_session_id)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
        db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
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
      ...serializeOrder(order),
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
      db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_line_items').selectAll().where('order_id', '=', orderId).execute(),
      db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
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
      db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_line_items').selectAll().where('order_id', '=', orderId).execute(),
      db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
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

  app.post('/orders/:orderId/cancel', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.write');
    const { orderId } = request.params as { orderId: string };
    const repo = new OrderRepository(db);
    const order = await repo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    if (order.status === 'paid' || order.status === 'partially_refunded') {
      throw new ValidationError('Cannot cancel a paid order. Use refund instead.');
    }

    const updated = await repo.update(orderId, { status: 'cancelled', cancelled_at: new Date() });
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
    return serializeOrder(updated);
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

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          orderId,
          amountCents: refundAmount,
          reason: body.reason,
          voidTickets: body.voidTickets ?? true,
          restoreInventory: body.restoreInventory ?? false,
        }),
      },
      async () => {
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
