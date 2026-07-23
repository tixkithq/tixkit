import type { FastifyPluginAsync } from 'fastify';
import { PassThrough } from 'node:stream';
import { Redis } from 'ioredis';
import { GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ClerkAuthService } from '../../auth/clerk.js';
import { EventRepository, type Database } from '@tixkit/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type Permission,
  type Principal,
} from '@tixkit/domain';
import { ulid } from 'ulid';
import { createExportSchema, parseBody } from '../../http/schemas.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import { config } from '../../config/index.js';
import { writeSseEvent } from '../../services/sse.js';
import { redactErrorFields } from '@tixkit/shared';
import { resolveEventSalesReport } from '../../services/event-sales-report.js';

const exportEventChannel = (exportId: string) => `tixkit:export-job:${exportId}:events`;
const DEFAULT_REPORTING_CACHE_TTL_MS = 30_000;
const MIN_REPORTING_CACHE_TTL_MS = 15_000;
const MAX_REPORTING_CACHE_TTL_MS = 60_000;
const MAX_REPORTING_CACHE_ENTRIES = 512;

type ReportingCacheEntry = {
  expiresAt: number;
  value: unknown;
};

function reportingCacheTtlMs(): number {
  const raw = process.env.REPORTING_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_REPORTING_CACHE_TTL_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REPORTING_CACHE_TTL_MS;
  if (parsed === 0) return 0;
  return Math.min(MAX_REPORTING_CACHE_TTL_MS, Math.max(MIN_REPORTING_CACHE_TTL_MS, parsed));
}

function createReportingCacheKey(input: {
  route: string;
  tenantId: string;
  eventId: string;
  organizationId?: string;
  brandId?: string;
  from?: Date;
  to?: Date;
}): string {
  return JSON.stringify({
    route: input.route,
    tenantId: input.tenantId,
    eventId: input.eventId,
    organizationId: input.organizationId ?? null,
    brandId: input.brandId ?? null,
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
  });
}

function readReportingCache(
  cache: Map<string, ReportingCacheEntry>,
  key: string,
  now: number,
): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeReportingCache(
  cache: Map<string, ReportingCacheEntry>,
  key: string,
  value: unknown,
  ttlMs: number,
  now: number,
) {
  if (ttlMs <= 0) return;
  cache.set(key, { value, expiresAt: now + ttlMs });

  if (cache.size <= MAX_REPORTING_CACHE_ENTRIES) return;
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= now || cache.size > MAX_REPORTING_CACHE_ENTRIES) {
      cache.delete(entryKey);
    }
    if (cache.size <= MAX_REPORTING_CACHE_ENTRIES) return;
  }
}

function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

function parseDateFilterBoundary(value: string, boundary: 'start' | 'end'): Date {
  let date: Date;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date = new Date(boundary === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)) {
      return date;
    }
  } else {
    date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  throw new ValidationError(`${boundary === 'start' ? 'from' : 'to'} must be a valid date`);
}

function getEventReportScope(event: Record<string, unknown>) {
  return {
    organizationId: typeof event.organization_id === 'string' ? event.organization_id : undefined,
    brandId: typeof event.brand_id === 'string' ? event.brand_id : undefined,
  };
}

function isValidExportFileUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function exportDownloadUrl(exportId: unknown): string | undefined {
  return typeof exportId === 'string' && exportId.length > 0
    ? `/v1/exports/${exportId}/download`
    : undefined;
}

function exportStorageConfig(): { bucket: string; s3Config: S3ClientConfig } {
  const bucket = process.env.S3_EXPORT_BUCKET ?? process.env.S3_BUCKET ?? 'tixkit-exports';
  const region = process.env.S3_EXPORT_REGION ?? process.env.S3_REGION ?? 'us-east-1';
  const s3Config: S3ClientConfig = { region };
  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint) {
    s3Config.endpoint = endpoint;
    s3Config.forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';
  }

  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? config.s3AccessKeyId;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? config.s3SecretAccessKey;
  if (accessKeyId && secretAccessKey) {
    s3Config.credentials = { accessKeyId, secretAccessKey };
  }

  return { bucket, s3Config };
}

async function createScopedExportDownloadUrl(row: Record<string, unknown>): Promise<string> {
  const { bucket, s3Config } = exportStorageConfig();
  const key = `exports/${String(row.id)}.${String(row.format)}`;
  return getSignedUrl(new S3Client(s3Config), new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 900,
  });
}

function requireReportEventAccess(
  principal: Principal,
  event: Record<string, unknown>,
  eventId: string,
) {
  try {
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(
      principal,
      event.organization_id as string | undefined,
    );
    ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
    ClerkAuthService.requireEventScope(principal, eventId);
  } catch (error) {
    if (error instanceof NotFoundError) throw new NotFoundError('Event', eventId);
    throw error;
  }
}

function requireUnscopedOrganizationReportPrincipal(principal: Principal) {
  if (principal.type === 'system') return;

  const hasBrandScope = Array.isArray(principal.brandIds) && principal.brandIds.length > 0;
  const hasEventScope = Array.isArray(principal.eventIds) && principal.eventIds.length > 0;
  if (hasBrandScope || hasEventScope) {
    throw new ValidationError('Resource-scoped principals cannot access organization-wide reports');
  }
}

const EXPORT_TYPE_PERMISSIONS: Record<string, Permission> = {
  attendees: 'attendees.read',
  orders: 'orders.read',
  sales: 'orders.read',
  tax: 'orders.read',
  tickets: 'checkins.read',
  scan_logs: 'checkins.read',
};

function requireExportTypePermission(principal: Principal, type: string) {
  const permission = EXPORT_TYPE_PERMISSIONS[type];
  if (!permission) {
    throw new ValidationError(`Unsupported export type: ${type}`);
  }
  ClerkAuthService.requirePermission(principal, permission);
}

export const reportingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const reportCache = new Map<string, ReportingCacheEntry>();
  const reportCacheTtlMs = reportingCacheTtlMs();

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const loadScopedExportJob = async (principal: Principal, exportId: string) => {
    const exportJob = await db
      .selectFrom('export_jobs')
      .selectAll()
      .where('id', '=', exportId)
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();
    if (!exportJob) throw new NotFoundError('ExportJob', exportId);

    if (!exportJob.event_id && principal.type !== 'system') {
      throw new NotFoundError('ExportJob', exportId);
    }

    if (exportJob.event_id) {
      // Do not use the general event repository here: export-job authorization must not
      // disclose a foreign event, organization, or brand through an error message.
      const event = await db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', exportJob.event_id)
        .where('tenant_id', '=', principal.tenantId)
        .executeTakeFirst();
      if (!event) throw new NotFoundError('ExportJob', exportId);
      try {
        requireReportEventAccess(principal, event, exportJob.event_id);
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundError('ExportJob', exportId);
        throw error;
      }
    }

    requireExportTypePermission(principal, exportJob.type);
    return exportJob;
  };

  app.get('/events/:eventId/reports/sales', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };
    const query = request.query as Record<string, unknown>;
    const from =
      typeof query.from === 'string' ? parseDateFilterBoundary(query.from, 'start') : undefined;
    const to = typeof query.to === 'string' ? parseDateFilterBoundary(query.to, 'end') : undefined;
    if (from && to && from > to) throw new ValidationError('from must not be after to');

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);
    const eventScope = getEventReportScope(event);
    const cacheKey = createReportingCacheKey({
      route: 'event-sales',
      tenantId: principal.tenantId,
      eventId,
      organizationId: eventScope.organizationId,
      brandId: eventScope.brandId,
      from,
      to,
    });
    const now = Date.now();
    const cached = readReportingCache(reportCache, cacheKey, now);
    if (cached) return cached;

    const report = await resolveEventSalesReport(db, {
      tenantId: principal.tenantId,
      eventId,
      organizationId: eventScope.organizationId,
      brandId: eventScope.brandId,
      eventCurrency: typeof event.currency === 'string' ? event.currency : undefined,
      from,
      to,
      observedAt: new Date(now),
    });
    writeReportingCache(reportCache, cacheKey, report, reportCacheTtlMs, now);
    return report;
  });

  app.get('/events/:eventId/reports/tax', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { eventId } = request.params as { eventId: string };

    const event = await loadEvent(eventId);
    requireReportEventAccess(principal, event, eventId);
    const eventScope = getEventReportScope(event);

    const query = request.query as Record<string, unknown>;
    const from =
      typeof query.from === 'string' ? parseDateFilterBoundary(query.from, 'start') : undefined;
    const to = typeof query.to === 'string' ? parseDateFilterBoundary(query.to, 'end') : undefined;
    if (from && to && from > to) throw new ValidationError('from must not be after to');

    // Aggregate tax snapshots via SQL join instead of materializing all order rows.
    let taxSnapshotQuery = db
      .selectFrom('order_tax_snapshots')
      .innerJoin('orders', 'order_tax_snapshots.order_id', 'orders.id')
      .select(({ fn }) => [
        'order_tax_snapshots.tax_rule_name',
        'order_tax_snapshots.rate',
        fn.sum<number>('order_tax_snapshots.taxable_amount_cents').as('taxable_amount_cents'),
        fn.sum<number>('order_tax_snapshots.tax_cents').as('tax_cents'),
      ])
      .where('orders.event_id', '=', eventId)
      .where('orders.tenant_id', '=', principal.tenantId)
      .where('orders.is_test', '=', false)
      .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (eventScope.organizationId)
      taxSnapshotQuery = taxSnapshotQuery.where(
        'orders.organization_id',
        '=',
        eventScope.organizationId,
      );
    if (eventScope.brandId)
      taxSnapshotQuery = taxSnapshotQuery.where('orders.brand_id', '=', eventScope.brandId);
    if (from) taxSnapshotQuery = taxSnapshotQuery.where('orders.created_at', '>=', from);
    if (to) taxSnapshotQuery = taxSnapshotQuery.where('orders.created_at', '<=', to);
    const taxSnapshotRows = await taxSnapshotQuery
      .groupBy(['order_tax_snapshots.tax_rule_name', 'order_tax_snapshots.rate'])
      .execute();

    // Fallback: aggregate line items via SQL join if no tax snapshots exist.
    let lineItemQuery = db
      .selectFrom('order_line_items')
      .innerJoin('orders', 'order_line_items.order_id', 'orders.id')
      .select(({ fn }) => [
        fn.sum<number>('order_line_items.subtotal_cents').as('subtotal_cents'),
        fn.sum<number>('order_line_items.discount_cents').as('discount_cents'),
        fn.sum<number>('order_line_items.tax_cents').as('tax_cents'),
      ])
      .where('orders.event_id', '=', eventId)
      .where('orders.tenant_id', '=', principal.tenantId)
      .where('orders.is_test', '=', false)
      .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (eventScope.organizationId)
      lineItemQuery = lineItemQuery.where('orders.organization_id', '=', eventScope.organizationId);
    if (eventScope.brandId)
      lineItemQuery = lineItemQuery.where('orders.brand_id', '=', eventScope.brandId);
    if (from) lineItemQuery = lineItemQuery.where('orders.created_at', '>=', from);
    if (to) lineItemQuery = lineItemQuery.where('orders.created_at', '<=', to);
    const lineItemAgg =
      taxSnapshotRows.length === 0 ? await lineItemQuery.executeTakeFirst() : undefined;

    const totalTax =
      taxSnapshotRows.length > 0
        ? taxSnapshotRows.reduce((sum, r) => sum + Number(r.tax_cents), 0)
        : Number(lineItemAgg?.tax_cents ?? 0);
    const taxableBase =
      taxSnapshotRows.length > 0
        ? taxSnapshotRows.reduce((sum, r) => sum + Number(r.taxable_amount_cents), 0)
        : Number(lineItemAgg?.subtotal_cents ?? 0) - Number(lineItemAgg?.discount_cents ?? 0);

    // Fetch currency from a single scoped order row.
    let currencyQuery = db
      .selectFrom('orders')
      .select('currency')
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .where('is_test', '=', false)
      .where('status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (eventScope.organizationId)
      currencyQuery = currencyQuery.where('organization_id', '=', eventScope.organizationId);
    if (eventScope.brandId)
      currencyQuery = currencyQuery.where('brand_id', '=', eventScope.brandId);
    if (from) currencyQuery = currencyQuery.where('created_at', '>=', from);
    if (to) currencyQuery = currencyQuery.where('created_at', '<=', to);
    const currencyRow = await currencyQuery
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    const taxRules = await db
      .selectFrom('tax_rules')
      .select(['name', 'rate'])
      .where('event_id', '=', eventId)
      .execute();
    const soleRule = taxRules.length === 1 ? taxRules[0] : undefined;
    const breakdown =
      taxSnapshotRows.length > 0
        ? taxSnapshotRows.map((r) => ({
            taxRuleName: String(r.tax_rule_name),
            rate: Number(r.rate),
            taxableAmountCents: Number(r.taxable_amount_cents),
            taxCollectedCents: Number(r.tax_cents),
          }))
        : totalTax > 0 || taxableBase > 0
          ? [
              {
                taxRuleName: soleRule?.name ?? 'Actual collected tax',
                rate: soleRule ? Number(soleRule.rate) : null,
                taxableAmountCents: taxableBase,
                taxCollectedCents: totalTax,
              },
            ]
          : [];

    return {
      eventId,
      currency: currencyRow?.currency ?? event.currency ?? 'USD',
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
      .where('tenant_id', '=', principal.tenantId)
      .where('event_id', '=', eventId)
      .where('status', 'in', ['confirmed', 'checked_in'])
      .executeTakeFirst();
    const totalAttendees = Number(totalAttendeesRow?.count ?? 0);

    const checkedInRow = await db
      .selectFrom('tickets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tenant_id', '=', principal.tenantId)
      .where('event_id', '=', eventId)
      .where('status', '=', 'checked_in')
      .executeTakeFirst();
    const checkedIn = Number(checkedInRow?.count ?? 0);
    const notCheckedIn = Math.max(0, totalAttendees - checkedIn);

    // Breakdown by ticket type.
    const ticketTypes = await db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', '=', eventId)
      .execute();
    const breakdownByTicketType = await Promise.all(
      ticketTypes.map(async (tt) => {
        const [totalRow, checkedInTypeRow] = await Promise.all([
          db
            .selectFrom('tickets')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('tenant_id', '=', principal.tenantId)
            .where('event_id', '=', eventId)
            .where('ticket_type_id', '=', tt.id)
            .where('status', 'in', ['valid', 'checked_in'])
            .executeTakeFirst(),
          db
            .selectFrom('tickets')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('tenant_id', '=', principal.tenantId)
            .where('event_id', '=', eventId)
            .where('ticket_type_id', '=', tt.id)
            .where('status', '=', 'checked_in')
            .executeTakeFirst(),
        ]);
        return {
          ticketTypeId: tt.id,
          ticketTypeName: tt.name,
          total: Number(totalRow?.count ?? 0),
          checkedIn: Number(checkedInTypeRow?.count ?? 0),
        };
      }),
    );

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
    const eventScope = getEventReportScope(event);

    // Get all discount codes for the event.
    const discountCodes = await db
      .selectFrom('discount_codes')
      .select(['id', 'code', 'uses_count'])
      .where('event_id', '=', eventId)
      .execute();

    // Compute exact discount amount and revenue by joining with checkout_sessions
    // to extract the discount code actually used for each paid order.
    let eventOrdersQuery = db
      .selectFrom('orders')
      .innerJoin('checkout_sessions', 'orders.checkout_session_id', 'checkout_sessions.id')
      .select([
        'orders.id',
        'orders.total_cents',
        'orders.refunded_cents',
        'orders.discount_cents',
        'checkout_sessions.cart as cart',
      ])
      .where('orders.event_id', '=', eventId)
      .where('orders.tenant_id', '=', principal.tenantId)
      .where('checkout_sessions.tenant_id', '=', principal.tenantId)
      .where('checkout_sessions.event_id', '=', eventId)
      .where('orders.is_test', '=', false)
      .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (eventScope.organizationId)
      eventOrdersQuery = eventOrdersQuery.where(
        'orders.organization_id',
        '=',
        eventScope.organizationId,
      );
    if (eventScope.brandId) {
      eventOrdersQuery = eventOrdersQuery
        .where('orders.brand_id', '=', eventScope.brandId)
        .where('checkout_sessions.brand_id', '=', eventScope.brandId);
    }
    const eventOrders = await eventOrdersQuery.execute();

    const codeSummaries: Record<string, { code: string; usesCount: number }> = {};
    const codeStats: Record<
      string,
      { discountAmountCents: number; revenueAttributedCents: number }
    > = {};
    for (const dc of discountCodes) {
      const code = normalizeDiscountCode(dc.code);
      codeSummaries[code] ??= { code, usesCount: 0 };
      codeSummaries[code].usesCount += Number(dc.uses_count);
      codeStats[code] ??= {
        discountAmountCents: 0,
        revenueAttributedCents: 0,
      };
    }

    for (const order of eventOrders) {
      if (order.cart) {
        try {
          const cart = typeof order.cart === 'string' ? JSON.parse(order.cart) : order.cart;
          const discountCode =
            typeof cart?.discountCode === 'string'
              ? normalizeDiscountCode(cart.discountCode)
              : undefined;
          if (discountCode && codeStats[discountCode]) {
            codeStats[discountCode].discountAmountCents += Number(order.discount_cents);
            codeStats[discountCode].revenueAttributedCents += Math.max(
              0,
              Number(order.total_cents) - Number(order.refunded_cents),
            );
          }
        } catch {
          // Ignore unparseable cart
        }
      }
    }

    const discountCodesReport = Object.values(codeSummaries).map((summary) => {
      const stats = codeStats[summary.code] || {
        discountAmountCents: 0,
        revenueAttributedCents: 0,
      };
      return {
        code: summary.code,
        usesCount: summary.usesCount,
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
    const eventScope = getEventReportScope(event);

    // Count checkout sessions and completed orders for conversion funnel.
    let sessionsQuery = db
      .selectFrom('checkout_sessions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .where('is_test', '=', false);
    if (eventScope.brandId)
      sessionsQuery = sessionsQuery.where('brand_id', '=', eventScope.brandId);
    const sessionsRow = await sessionsQuery.executeTakeFirst();

    let completedQuery = db
      .selectFrom('checkout_sessions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId)
      .where('is_test', '=', false)
      .where('status', '=', 'completed');
    if (eventScope.brandId)
      completedQuery = completedQuery.where('brand_id', '=', eventScope.brandId);
    const completedRow = await completedQuery.executeTakeFirst();

    let widgetViewsQuery = db
      .selectFrom('widget_impressions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('event_id', '=', eventId)
      .where('tenant_id', '=', principal.tenantId);
    if (eventScope.organizationId)
      widgetViewsQuery = widgetViewsQuery.where('organization_id', '=', eventScope.organizationId);
    if (eventScope.brandId)
      widgetViewsQuery = widgetViewsQuery.where('brand_id', '=', eventScope.brandId);
    const widgetViewsRow = await widgetViewsQuery.executeTakeFirst();
    const checkoutStarted = Number(sessionsRow?.count ?? 0);
    const checkoutCompleted = Number(completedRow?.count ?? 0);
    const widgetViews = Number(widgetViewsRow?.count ?? 0);
    const conversionRate =
      widgetViews > 0
        ? checkoutCompleted / widgetViews
        : checkoutStarted > 0
          ? checkoutCompleted / checkoutStarted
          : 0;

    return {
      eventId,
      widgetViews,
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
    requireUnscopedOrganizationReportPrincipal(principal);

    // Single join query instead of N+1 per-affiliate queries.
    const rows = await db
      .selectFrom('affiliates')
      .leftJoin('attributions', 'attributions.affiliate_id', 'affiliates.id')
      .leftJoin('orders', (join) =>
        join
          .onRef('orders.id', '=', 'attributions.order_id')
          .on('orders.tenant_id', '=', principal.tenantId)
          .on('orders.organization_id', '=', organizationId),
      )
      .select([
        'affiliates.id as affiliateId',
        'affiliates.code',
        'affiliates.name',
        'orders.id as orderId',
        'orders.total_cents',
        'orders.refunded_cents',
        'attributions.commission_cents',
      ])
      .where('affiliates.tenant_id', '=', principal.tenantId)
      .where('affiliates.organization_id', '=', organizationId)
      .execute();

    const affiliateMap = new Map<
      string,
      {
        affiliateId: string;
        code: string;
        name: string;
        attributedOrderIds: Set<string>;
        revenueAttributedCents: number;
        commissionCents: number;
      }
    >();

    for (const row of rows) {
      const aff = affiliateMap.get(row.affiliateId) ?? {
        affiliateId: row.affiliateId,
        code: row.code,
        name: row.name,
        attributedOrderIds: new Set<string>(),
        revenueAttributedCents: 0,
        commissionCents: 0,
      };
      if (row.orderId && !aff.attributedOrderIds.has(row.orderId)) {
        aff.attributedOrderIds.add(row.orderId);
        aff.revenueAttributedCents += Math.max(
          0,
          Number(row.total_cents ?? 0) - Number(row.refunded_cents ?? 0),
        );
        aff.commissionCents += Number(row.commission_cents ?? 0);
      }
      affiliateMap.set(row.affiliateId, aff);
    }

    const affiliatesReport = Array.from(affiliateMap.values()).map((aff) => ({
      affiliateId: aff.affiliateId,
      code: aff.code,
      name: aff.name,
      referralsCount: aff.attributedOrderIds.size,
      revenueAttributedCents: aff.revenueAttributedCents,
      commissionCents: aff.commissionCents,
    }));

    return { organizationId, affiliates: affiliatesReport };
  });

  app.post('/exports', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const body = parseBody(createExportSchema, request.body);
    requireExportTypePermission(principal, body.type);

    if (!body.eventId && principal.type !== 'system') {
      throw new ValidationError('eventId is required for export creation');
    }

    // Require Idempotency-Key for exports to prevent duplicate workflows.
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for exports');
    }

    if (body.eventId) {
      const event = await loadEvent(body.eventId);
      try {
        requireReportEventAccess(principal, event, body.eventId);
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundError('Event', body.eventId);
        throw error;
      }
    }

    const requestHash = hashRequest({
      type: body.type,
      format: body.format,
      eventId: body.eventId,
      filters: body.filters,
    });
    const exportId = `exp_${hashRequest({
      tenantId: principal.tenantId,
      idempotencyKey,
      requestHash,
    }).slice(0, 26)}`;

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash,
      },
      async () => {
        const createdAt = new Date();

        const existingExport = await db
          .selectFrom('export_jobs')
          .selectAll()
          .where('id', '=', exportId)
          .where('tenant_id', '=', principal.tenantId)
          .executeTakeFirst();

        if (!existingExport) {
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
        }

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

  app.get('/exports/:exportId/events', { compress: false }, async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { exportId } = request.params as { exportId: string };

    const exportJob = await loadScopedExportJob(principal, exportId);
    const lastEventIdHeader = request.headers['last-event-id'];
    let lastSentEventId = typeof lastEventIdHeader === 'string' ? lastEventIdHeader : undefined;
    const stream = new PassThrough();
    let ended = false;
    let subscriber: InstanceType<typeof Redis> | undefined;
    let replayInFlight: Promise<void> | undefined;
    let replayQueued = false;
    const sendEvent = (event: string, data: unknown, id?: string) =>
      ended ? Promise.resolve(false) : writeSseEvent(stream, event, data, id);
    const closeStream = () => {
      if (ended) return;
      ended = true;
      subscriber?.disconnect();
      if (!stream.destroyed && !stream.writableEnded) stream.end();
    };
    const replayEventsOnce = async () => {
      const events = await loadExportJobEvents(db, principal.tenantId, exportId, lastSentEventId);
      for (const event of events) {
        const payload = parseExportEventPayload(event.payload);
        if (!(await sendEvent('export', payload, event.id))) break;
        lastSentEventId = event.id;
        if (isTerminalExportStatus(payload.status)) {
          closeStream();
          break;
        }
      }
      return events.length;
    };
    const replayEvents = async () => {
      if (replayInFlight) {
        replayQueued = true;
        await replayInFlight;
        return 0;
      }
      let replayed = 0;
      replayInFlight = (async () => {
        do {
          replayQueued = false;
          replayed += await replayEventsOnce();
        } while (replayQueued && !ended);
      })();
      try {
        await replayInFlight;
        return replayed;
      } finally {
        replayInFlight = undefined;
      }
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
    if (replayedCount === 0 && (!lastSentEventId || isTerminalExportStatus(exportJob.status))) {
      await sendEvent('export', serializeExportJob(exportJob));
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
          await sendEvent('export', serializeExportJob(latestExportJob));
        }
      } catch (err) {
        request.log.error({ err: redactErrorFields(err), exportId }, 'Export status stream failed');
        await sendEvent('error', {
          code: 'EXPORT_STREAM_FAILED',
          message: 'Export status stream failed',
        });
      } finally {
        closeStream();
      }
    })();
  });

  app.get('/exports/:exportId/download', { compress: false }, async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'reports.read');
    const { exportId } = request.params as { exportId: string };

    const exportJob = await loadScopedExportJob(principal, exportId);

    if (exportJob.status !== 'completed' || !isValidExportFileUrl(exportJob.file_url)) {
      throw new ConflictError('Export is not ready for download');
    }

    return reply.redirect(await createScopedExportDownloadUrl(exportJob));
  });
};

function serializeExportJob(row: Record<string, unknown>) {
  const status = String(row.status);
  const downloadUrl =
    status === 'completed' && isValidExportFileUrl(row.file_url)
      ? exportDownloadUrl(row.id)
      : undefined;
  return {
    exportId: row.id,
    eventId: row.event_id ?? undefined,
    type: row.type,
    format: row.format,
    status,
    downloadUrl,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function isTerminalExportStatus(status: unknown) {
  return status === 'completed' || status === 'failed';
}

function parseExportEventPayload(payload: unknown) {
  const parsed =
    typeof payload === 'string'
      ? (JSON.parse(payload) as Record<string, unknown>)
      : (payload as Record<string, unknown>);
  const {
    fileUrl: _fileUrl,
    file_url: _fileUrlSnake,
    download_url: _downloadUrlSnake,
    ...sanitized
  } = parsed;
  if (sanitized.status === 'completed') {
    const downloadUrl = exportDownloadUrl(sanitized.exportId ?? sanitized.export_id);
    if (downloadUrl) sanitized.downloadUrl = downloadUrl;
  } else {
    delete sanitized.downloadUrl;
    delete sanitized.download_url;
  }
  return sanitized;
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

async function createExportEventSubscriber(exportId: string, onEvent: () => Promise<void>) {
  if (config.nodeEnv === 'test') return undefined;
  const subscriber = new Redis(config.redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  subscriber.on('error', () => undefined);
  subscriber.on('message', (_channel: string, _message: string) => {
    void onEvent().catch(() => undefined);
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
