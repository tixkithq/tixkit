import type { FastifyPluginAsync } from 'fastify';
import { PassThrough } from 'node:stream';
import { Redis } from 'ioredis';
import { ClerkAuthService } from '../../auth/clerk.js';
import { EventRepository, type Database } from '@gatekit/db';
import { NotFoundError, ValidationError, type Principal } from '@gatekit/domain';
import { ulid } from 'ulid';
import { createExportSchema, parseBody } from '../../http/schemas.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import { config } from '../../config/index.js';

const exportEventChannel = (exportId: string) => `gatekit:export-job:${exportId}:events`;

export const reportingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const requireReportEventAccess = (principal: Principal, event: Record<string, unknown>, eventId: string) => {
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
    ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
    ClerkAuthService.requireEventScope(principal, eventId);
  };

  const loadScopedExportJob = async (principal: Principal, exportId: string) => {
    const exportJob = await db
      .selectFrom('export_jobs')
      .selectAll()
      .where('id', '=', exportId)
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();
    if (!exportJob) throw new NotFoundError('ExportJob', exportId);

    if (exportJob.event_id) {
      const event = await loadEvent(exportJob.event_id);
      requireReportEventAccess(principal, event, exportJob.event_id);
    }

    return exportJob;
  };

  app.get('/events/:eventId/reports/sales', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };
    const query = request.query as Record<string, unknown>;
    const from = typeof query.from === 'string' ? new Date(query.from) : undefined;
    const to = typeof query.to === 'string' ? new Date(query.to) : undefined;

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);

    let orderQuery = db
      .selectFrom('orders')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
      .orderBy('created_at', 'asc');
    if (from) orderQuery = orderQuery.where('created_at', '>=', from);
    if (to) orderQuery = orderQuery.where('created_at', '<=', to);

    const orders = await orderQuery.execute();

    const orderIds = orders.map((order) => order.id);
    let refundQuery = db
      .selectFrom('refunds')
      .innerJoin('orders', 'refunds.order_id', 'orders.id')
      .select(['refunds.amount_cents'])
      .where('orders.event_id', '=', eventId)
      .where('orders.tenant_id', '=', principal.tenantId)
      .where('refunds.status', '=', 'succeeded');
    if (from) refundQuery = refundQuery.where('refunds.created_at', '>=', from);
    if (to) refundQuery = refundQuery.where('refunds.created_at', '<=', to);
    const refundRows = await refundQuery.execute();

    const grossSales = orders.reduce((sum, o) => sum + Number(o.total_cents), 0);
    const refunds = refundRows.reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
    const netRevenue = grossSales - refunds;
    const feesCollected = orders.reduce((sum, o) => sum + Number(o.fee_cents), 0);
    const taxCollected = orders.reduce((sum, o) => sum + Number(o.tax_cents), 0);

    // Prefer ticket rows so refunded/voided tickets are excluded. Fall back to
    // line items for older fixture data that does not materialize tickets.
    const activeTicketsRow = await db
      .selectFrom('tickets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('status', 'in', ['valid', 'checked_in'])
      .executeTakeFirst();
    const activeTicketsSold = Number(activeTicketsRow?.count ?? 0);
    const lineItemRows =
      activeTicketsSold > 0 || orderIds.length === 0
        ? []
        : await db
            .selectFrom('order_line_items')
            .select(['quantity'])
            .where('order_id', 'in', orderIds)
            .execute();
    const ticketsSold = activeTicketsSold > 0 ? activeTicketsSold : lineItemRows.reduce((sum, row) => sum + Number(row.quantity), 0);

    const allOrdersRow = await db
      .selectFrom('orders')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();
    const totalOrdersCount = Number(allOrdersRow?.count ?? 0);
    const paidOrders = orders.length;

    const checkInsRow = await db
      .selectFrom('tickets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('status', '=', 'checked_in')
      .executeTakeFirst();

    return {
      eventId,
      currency: orders[0]?.currency ?? event.currency ?? 'USD',
      grossSalesCents: grossSales,
      netRevenueCents: netRevenue,
      refundsCents: refunds,
      feesCents: feesCollected,
      taxCents: taxCollected,
      ticketsSold,
      checkIns: Number(checkInsRow?.count ?? 0),
      ordersCount: totalOrdersCount,
      paidOrdersCount: paidOrders,
      range: {
        from: from?.toISOString() ?? (orders.length > 0 ? orders[0].created_at.toISOString() : new Date().toISOString()),
        to: to?.toISOString() ?? (orders.length > 0 ? orders[orders.length - 1].created_at.toISOString() : new Date().toISOString()),
      },
    };
  });

  app.get('/events/:eventId/reports/tax', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);

    const query = request.query as Record<string, unknown>;
    const from = typeof query.from === 'string' ? new Date(query.from) : undefined;
    const to = typeof query.to === 'string' ? new Date(query.to) : undefined;

    let orderQuery = db
      .selectFrom('orders')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (from) orderQuery = orderQuery.where('created_at', '>=', from);
    if (to) orderQuery = orderQuery.where('created_at', '<=', to);
    const orders = await orderQuery.execute();

    // Line items store the actual tax snapshot but not tax_rule_id. Report one
    // actual bucket instead of redistributing collected tax across configured
    // rules, which would fabricate per-rule precision. If the event has a
    // single configured rule, the aggregate can be attributed to that rule.
    const orderIds = orders.map((o) => o.id);
    const lineItems =
      orderIds.length === 0
        ? []
        : await db
            .selectFrom('order_line_items')
            .select(['subtotal_cents', 'discount_cents', 'tax_cents'])
            .where('order_id', 'in', orderIds)
            .execute();

    const totalTax = lineItems.reduce((sum, li) => sum + Number(li.tax_cents), 0);
    const taxableBase = lineItems.reduce(
      (sum, li) => sum + Number(li.subtotal_cents) - Number(li.discount_cents),
      0,
    );
    const taxRules = await db
      .selectFrom('tax_rules')
      .select(['name', 'rate'])
      .where('event_id', '=', eventId)
      .execute();
    const soleRule = taxRules.length === 1 ? taxRules[0] : undefined;
    const breakdown = totalTax > 0 || taxableBase > 0
      ? [{
          taxRuleName: soleRule?.name ?? 'Actual collected tax',
          rate: soleRule ? Number(soleRule.rate) : null,
          taxableAmountCents: taxableBase,
          taxCollectedCents: totalTax,
        }]
      : [];

    return {
      eventId,
      currency: orders[0]?.currency ?? event.currency ?? 'USD',
      totalTaxCollectedCents: totalTax,
      breakdown,
    };
  });

  app.get('/events/:eventId/reports/attendance', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);

    const totalAttendeesRow = await db
      .selectFrom('attendees')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('status', 'in', ['confirmed', 'checked_in'])
      .executeTakeFirst();
    const totalAttendees = Number(totalAttendeesRow?.count ?? 0);

    const checkedInRow = await db
      .selectFrom('tickets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('status', '=', 'checked_in')
      .executeTakeFirst();
    const checkedIn = Number(checkedInRow?.count ?? 0);
    const notCheckedIn = Math.max(0, totalAttendees - checkedIn);

    // Breakdown by ticket type.
    const ticketTypes = await db.selectFrom('ticket_types').selectAll().where('event_id', '=', eventId).execute();
    const breakdownByTicketType = [];
    for (const tt of ticketTypes) {
      const totalRow = await db
        .selectFrom('tickets')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('event_id', '=', eventId)
        .where('ticket_type_id', '=', tt.id)
        .where('status', 'in', ['valid', 'checked_in'])
        .executeTakeFirst();
      const checkedInTypeRow = await db
        .selectFrom('tickets')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('event_id', '=', eventId)
        .where('ticket_type_id', '=', tt.id)
        .where('status', '=', 'checked_in')
        .executeTakeFirst();
      breakdownByTicketType.push({
        ticketTypeId: tt.id,
        ticketTypeName: tt.name,
        total: Number(totalRow?.count ?? 0),
        checkedIn: Number(checkedInTypeRow?.count ?? 0),
      });
    }

    return {
      eventId,
      totalAttendees,
      checkedIn,
      notCheckedIn,
      checkInRate: totalAttendees > 0 ? checkedIn / totalAttendees : 0,
      breakdownByTicketType,
    };
  });

  app.get('/events/:eventId/reports/promo', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);

    // Get all discount codes for the event.
    const discountCodes = await db.selectFrom('discount_codes').selectAll().where('event_id', '=', eventId).execute();

    // Compute exact discount amount and revenue by joining with checkout_sessions
    // to extract the discount code actually used for each paid order.
    const eventOrders = await db
      .selectFrom('orders')
      .innerJoin('checkout_sessions', 'orders.checkout_session_id', 'checkout_sessions.id')
      .select([
        'orders.id',
        'orders.total_cents',
        'orders.discount_cents',
        'checkout_sessions.cart as cart',
      ])
      .where('orders.event_id', '=', eventId)
      .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded'])
      .execute();

    const codeStats: Record<string, { discountAmountCents: number; revenueAttributedCents: number }> = {};
    for (const dc of discountCodes) {
      codeStats[dc.code] = { discountAmountCents: 0, revenueAttributedCents: 0 };
    }

    for (const order of eventOrders) {
      if (order.cart) {
        try {
          const cart = typeof order.cart === 'string' ? JSON.parse(order.cart) : order.cart;
          const discountCode = cart?.discountCode;
          if (discountCode && codeStats[discountCode]) {
            codeStats[discountCode].discountAmountCents += Number(order.discount_cents);
            codeStats[discountCode].revenueAttributedCents += Number(order.total_cents);
          }
        } catch (e) {
          // Ignore unparseable cart
        }
      }
    }

    const discountCodesReport = discountCodes.map((dc) => {
      const stats = codeStats[dc.code] || { discountAmountCents: 0, revenueAttributedCents: 0 };
      return {
        code: dc.code,
        usesCount: Number(dc.uses_count),
        discountAmountCents: stats.discountAmountCents,
        revenueAttributedCents: stats.revenueAttributedCents,
      };
    });

    return { eventId, discountCodes: discountCodesReport };
  });

  app.get('/events/:eventId/reports/conversion', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);

    // Count checkout sessions and completed orders for conversion funnel.
    const sessionsRow = await db
      .selectFrom('checkout_sessions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    const completedRow = await db
      .selectFrom('checkout_sessions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('status', '=', 'completed')
      .executeTakeFirst();
    const checkoutStarted = Number(sessionsRow?.count ?? 0);
    const checkoutCompleted = Number(completedRow?.count ?? 0);
    const conversionRate = checkoutStarted > 0 ? checkoutCompleted / checkoutStarted : 0;

    return {
      eventId,
      widgetViews: null,
      checkoutStarted,
      checkoutCompleted,
      conversionRate,
    };
  });

  app.get('/organizations/:organizationId/reports/affiliate', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { organizationId } = request.params as { organizationId: string };
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const affiliates = await db
      .selectFrom('affiliates')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .where('organization_id', '=', organizationId)
      .execute();
    const affiliatesReport = [];
    for (const aff of affiliates) {
      const attributions = await db
        .selectFrom('attributions')
        .selectAll()
        .where('affiliate_id', '=', aff.id)
        .execute();
      const referralsCount = attributions.length;
      // Compute real revenue by joining attributions with orders.
      const orderIds = attributions.map((a) => a.order_id);
      const attributedOrders =
        orderIds.length === 0
          ? []
          : await db
              .selectFrom('orders')
              .select(['total_cents', 'refunded_cents'])
              .where('id', 'in', orderIds)
              .where('tenant_id', '=', principal.tenantId)
              .where('organization_id', '=', organizationId)
              .execute();
      const revenueAttributedCents = attributedOrders.reduce(
        (sum, o) => sum + Number(o.total_cents) - Number(o.refunded_cents),
        0,
      );
      const commissionCents = attributions.reduce((sum, a) => sum + Number(a.commission_cents), 0);
      affiliatesReport.push({
        affiliateId: aff.id,
        code: aff.code,
        name: aff.name,
        referralsCount,
        revenueAttributedCents,
        commissionCents,
      });
    }

    return { organizationId, affiliates: affiliatesReport };
  });

  app.post('/exports', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const body = parseBody(createExportSchema, request.body);

    // Require Idempotency-Key for exports to prevent duplicate workflows.
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for exports');
    }

    if (body.eventId) {
      const event = await loadEvent(body.eventId);
      requireReportEventAccess(principal, event, body.eventId);
    }

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ type: body.type, format: body.format, eventId: body.eventId, filters: body.filters }),
      },
      async () => {
        // Start the Temporal ExportWorkflow
        const exportId = `exp_${ulid()}`;
        const createdAt = new Date();

        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto('export_jobs')
            .values({
              id: exportId,
              tenant_id: principal.tenantId,
              event_id: body.eventId ?? null,
              type: body.type,
              format: body.format,
              status: 'pending',
              file_url: null,
              requested_by: principal.id,
              filters: body.filters ? JSON.stringify(body.filters) : null,
              created_at: createdAt,
              completed_at: null,
            })
            .execute();

          await trx
            .insertInto('export_job_events')
            .values({
              id: `eev_${ulid()}`,
              tenant_id: principal.tenantId,
              export_job_id: exportId,
              status: 'pending',
              payload: JSON.stringify({
                exportId,
                eventId: body.eventId,
                type: body.type,
                format: body.format,
                status: 'pending',
                createdAt,
              }),
              created_at: createdAt,
            })
            .execute();
        });

        await app.context.temporalClient.startExport({
          exportId,
          type: body.type,
          format: body.format,
          requestedBy: principal.id,
          tenantId: principal.tenantId,
        });

        return { status: 202, body: { exportId, status: 'pending' } };
      },
    );

    return reply.status(result.status).send(result.body);
  });

  app.get('/exports/:exportId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { exportId } = request.params as { exportId: string };

    const exportJob = await loadScopedExportJob(principal, exportId);

    return serializeExportJob(exportJob);
  });

  app.get('/exports/:exportId/events', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { exportId } = request.params as { exportId: string };

    const exportJob = await loadScopedExportJob(principal, exportId);
    const lastEventIdHeader = request.headers['last-event-id'];
    let lastSentEventId = typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined;
    const stream = new PassThrough();
    let ended = false;
    let subscriber: InstanceType<typeof Redis> | undefined;
    const sendEvent = (event: string, data: unknown, id?: string) => {
      if (ended || stream.destroyed || stream.writableEnded) return;
      if (id) stream.write(`id: ${id}\n`);
      stream.write(`event: ${event}\n`);
      stream.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const closeStream = () => {
      if (ended) return;
      ended = true;
      subscriber?.disconnect();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    };
    const replayEvents = async () => {
      const events = await loadExportJobEvents(db, principal.tenantId, exportId, lastSentEventId);
      for (const event of events) {
        const payload = parseExportEventPayload(event.payload);
        sendEvent('export', payload, event.id);
        lastSentEventId = event.id;
        if (isTerminalExportStatus(payload.status)) {
          closeStream();
          break;
        }
      }
      return events.length;
    };

    request.raw.on('close', () => {
      closeStream();
    });

    reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('Connection', 'keep-alive')
      .send(stream);

    if (!isTerminalExportStatus(exportJob.status)) {
      subscriber = await createExportEventSubscriber(exportId, async () => {
        await replayEvents();
      });
    }

    const replayedCount = await replayEvents();
    if (replayedCount === 0 && !lastSentEventId) {
      sendEvent('export', serializeExportJob(exportJob));
    }
    if (isTerminalExportStatus(exportJob.status)) {
      closeStream();
      return;
    }

    void (async () => {
      try {
        await app.context.temporalClient.waitForExport(exportId);
        const replayedTerminalEvents = await replayEvents();
        if (replayedTerminalEvents === 0) {
          const latestExportJob = await loadScopedExportJob(principal, exportId);
          sendEvent('export', serializeExportJob(latestExportJob));
        }
      } catch (err) {
        sendEvent('error', {
          code: 'EXPORT_STREAM_FAILED',
          message: err instanceof Error ? err.message : 'Export status stream failed',
        });
      } finally {
        closeStream();
      }
    })();
  });

  app.get('/exports/:exportId/download', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { exportId } = request.params as { exportId: string };

    const exportJob = await loadScopedExportJob(principal, exportId);

    if (exportJob.status !== 'completed' || !exportJob.file_url) {
      throw new ValidationError('Export is not ready for download');
    }

    return reply.redirect(exportJob.file_url);
  });
};

function serializeExportJob(row: Record<string, unknown>) {
  const status = String(row.status);
  const fileUrl = typeof row.file_url === 'string' && status === 'completed'
    ? row.file_url
    : undefined;
  return {
    exportId: row.id,
    eventId: row.event_id ?? undefined,
    type: row.type,
    format: row.format,
    status,
    fileUrl,
    downloadUrl: fileUrl ? `/v1/exports/${row.id}/download` : undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function isTerminalExportStatus(status: unknown) {
  return status === 'completed' || status === 'failed';
}

function parseExportEventPayload(payload: unknown) {
  if (typeof payload === 'string') {
    return JSON.parse(payload) as Record<string, unknown>;
  }
  return payload as Record<string, unknown>;
}

async function loadExportJobEvents(
  db: Database,
  tenantId: string,
  exportId: string,
  afterEventId?: string,
) {
  let query = db
    .selectFrom('export_job_events')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('export_job_id', '=', exportId)
    .orderBy('id', 'asc');
  if (afterEventId) {
    query = query.where('id', '>', afterEventId);
  }
  return query.execute();
}

async function createExportEventSubscriber(
  exportId: string,
  onEvent: () => Promise<void>,
) {
  if (config.nodeEnv === 'test') return undefined;
  const subscriber = new Redis(config.redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  subscriber.on('error', () => undefined);
  subscriber.on('message', (_channel: string, _message: string) => {
    void onEvent();
  });
  try {
    await subscriber.connect();
    await subscriber.subscribe(exportEventChannel(exportId));
    return subscriber;
  } catch {
    subscriber.disconnect();
    return undefined;
  }
}
