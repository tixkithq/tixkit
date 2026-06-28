import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessRuleRepository,
  EventRepository,
  TicketTypeRepository,
  BrandRepository,
  ProductRepository,
  EventOccurrenceRepository,
} from '@tixkit/db';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import type { AccessRuleRecord } from '@tixkit/domain';
import {
  parseJsonValue,
  serializeEventOccurrenceStatus,
  serializeMarketingIntegration,
} from '../../http/contracts.js';
import { parseBody } from '../../http/schemas.js';
import { ulid } from 'ulid';

function firstQueryParam(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

function normalizeHost(value: unknown): string {
  const host = firstQueryParam(value).trim();
  if (!host) return '';
  if (host.includes('://') || /[\s,/?#]/.test(host)) return '';
  try {
    const url = new URL(`https://${host}`);
    if (url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return '';
    }
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isPubliclyReadableEvent(event: { status: string; visibility?: string | null }): boolean {
  return event.status === 'published' && event.visibility !== 'private';
}

function boolValue(value: unknown): boolean {
  return value === true || value === 1;
}

function parseRequestedProducts(value: unknown): string[] {
  return firstQueryParam(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseTicketTypeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
  ];
}

const widgetImpressionSchema = z
  .object({
    visitorId: z.string().min(8).max(128).optional(),
    instanceId: z.string().min(1).max(128).optional(),
    trackingId: z.string().min(1).max(255).optional(),
    affiliateCode: z.string().min(1).max(128).optional(),
    host: z.string().min(1).max(255).optional(),
    pageUrl: z.string().min(1).max(2048).optional(),
    referrer: z.string().min(1).max(2048).optional(),
  })
  .strict();

function toDate(value?: Date | string | null): Date | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function hashWidgetVisitor(input: {
  eventId: string;
  visitorId?: string;
  ip?: string;
  userAgent?: string;
  date: string;
}): string {
  const secret = process.env.WIDGET_IMPRESSION_HASH_SECRET?.trim();
  const visitorMaterial =
    input.visitorId ?? `${input.ip ?? 'unknown'}|${input.userAgent ?? 'unknown'}`;
  return createHash('sha256')
    .update(
      [secret ?? 'local-widget-impression-secret', input.eventId, input.date, visitorMaterial].join(
        '|',
      ),
    )
    .digest('hex');
}

function isDuplicateInsert(error: unknown): boolean {
  const record = error as { code?: string; errno?: number; message?: string };
  return (
    record.code === '23505' ||
    record.code === 'ER_DUP_ENTRY' ||
    record.errno === 1062 ||
    /duplicate|unique/i.test(record.message ?? '')
  );
}

function accessRuleUnlocks(
  rule: AccessRuleRecord,
  input: { accessCode?: string; buyerEmail?: string; now: Date },
): boolean {
  const expiresAt = toDate(rule.expiresAt);
  if (expiresAt && input.now > expiresAt) return false;
  if (rule.maxUses != null && rule.usesCount >= rule.maxUses) return false;
  if (rule.type === 'allowlist') {
    return (
      Boolean(input.buyerEmail) && rule.value.toLowerCase() === input.buyerEmail!.toLowerCase()
    );
  }
  return Boolean(input.accessCode) && rule.value === input.accessCode;
}

/**
 * Public, unauthenticated buyer-facing routes. Only published events and
 * publicly-visible ticket types are exposed. Hidden ticket types are excluded
 * from listings but remain purchasable through the checkout API via direct
 * links (their IDs).
 */
export const publicRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const inventoryService = app.context.inventoryService;

  app.get('/public/events/:eventId', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
    const marketingIntegrations = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
    return {
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description,
      status: event.status,
      timezone: event.timezone,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      venue: parseJsonValue(event.venue, null),
      brandId: event.brand_id,
      marketingIntegrations: marketingIntegrations.map((row) =>
        serializeMarketingIntegration(row, { public: true }),
      ),
    };
  });

  app.get('/public/events/by-slug/:slug', async (request) => {
    const { slug } = request.params as { slug: string };
    const host = normalizeHost((request.query as { host?: unknown }).host);
    if (!host) throw new NotFoundError('Event', slug);

    const brandDomain = await db
      .selectFrom('brand_domains')
      .selectAll()
      .where('domain', '=', host)
      .where('is_verified', '=', true)
      .where('ssl_status', '=', 'active')
      .executeTakeFirst();
    if (
      !brandDomain ||
      !boolValue(brandDomain.is_verified) ||
      brandDomain.ssl_status !== 'active'
    ) {
      throw new NotFoundError('Event', slug);
    }

    const brand = await db
      .selectFrom('brands')
      .selectAll()
      .where('id', '=', brandDomain.brand_id)
      .executeTakeFirst();
    if (!brand || !boolValue(brand.white_label)) throw new NotFoundError('Event', slug);

    const event = await new EventRepository(db).findByBrandSlug(brandDomain.brand_id as string, slug);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', slug);

    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', event.tenant_id)
      .executeTakeFirst();
    if (!tenant || tenant.plan === 'free') throw new NotFoundError('Event', slug);

    const marketingIntegrations = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('event_id', '=', event.id)
      .where('status', '=', 'active')
      .execute();
    return {
      id: event.id,
      slug: event.slug,
      title: event.title,
      description: event.description,
      status: event.status,
      timezone: event.timezone,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      venue: parseJsonValue(event.venue, null),
      brandId: event.brand_id,
      marketingIntegrations: marketingIntegrations.map((row) =>
        serializeMarketingIntegration(row, { public: true }),
      ),
    };
  });

  app.get('/public/events/:eventId/marketing-integrations', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
    const rows = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('status', '=', 'active')
      .execute();
    return {
      items: rows.map((row) => serializeMarketingIntegration(row, { public: true })),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.get('/public/events/:eventId/occurrences', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);

    const occurrences = await new EventOccurrenceRepository(db).findByEvent(eventId);
    return {
      items: occurrences
        .flatMap((occurrence) => {
          const status = serializeEventOccurrenceStatus(occurrence.status);
          if (status !== 'scheduled') return [];
          return [
            {
              id: occurrence.id,
              eventId: occurrence.event_id,
              title: occurrence.title,
              startsAt: occurrence.starts_at,
              endsAt: occurrence.ends_at,
              timezone: occurrence.timezone,
              venue: parseJsonValue(occurrence.venue, null),
              capacity: occurrence.capacity,
              sortOrder: occurrence.sort_order,
              status,
            },
          ];
        }),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.post('/public/events/:eventId/widget-impressions', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(widgetImpressionSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
    if (
      !process.env.WIDGET_IMPRESSION_HASH_SECRET?.trim() &&
      process.env.NODE_ENV === 'production'
    ) {
      return reply.status(503).send({
        error: {
          code: 'WIDGET_IMPRESSION_HASH_NOT_CONFIGURED',
          message: 'Widget impression hashing is not configured',
        },
      });
    }

    const impressionDate = new Date().toISOString().slice(0, 10);
    const visitorHash = hashWidgetVisitor({
      eventId,
      visitorId: body.visitorId,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      date: impressionDate,
    });

    try {
      await db
        .insertInto('widget_impressions')
        .values({
          id: `wim_${ulid()}`,
          tenant_id: event.tenant_id,
          organization_id: event.organization_id,
          brand_id: event.brand_id,
          event_id: event.id,
          visitor_hash: visitorHash,
          impression_date: impressionDate,
          source: 'widget',
          tracking_id: body.trackingId ?? null,
          affiliate_code: body.affiliateCode ?? null,
          host: body.host ?? null,
          page_url: body.pageUrl ?? null,
          referrer: body.referrer ?? null,
          created_at: new Date(),
        })
        .execute();
    } catch (error) {
      if (!isDuplicateInsert(error)) throw error;
      return reply.status(200).send({ tracked: false, deduped: true });
    }

    return reply.status(201).send({ tracked: true, deduped: false });
  });

  app.get('/public/brands/:brandId', async (request) => {
    const { brandId } = request.params as { brandId: string };
    const brand = await new BrandRepository(db).findById(brandId);
    if (!brand) throw new NotFoundError('Brand', brandId);
    return {
      id: brand.id,
      name: brand.name,
      slug: brand.slug,
      status: brand.status,
      theme: parseJsonValue(brand.theme, {}),
      supportUrl: brand.support_url ?? undefined,
      legalUrls: parseJsonValue(brand.legal_urls, {}),
      whiteLabel: brand.white_label,
    };
  });

  app.get('/public/events/:eventId/availability', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const requestedProducts = parseRequestedProducts(
      (request.query as { products?: unknown }).products,
    );
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);

    const ttRepo = new TicketTypeRepository(db);
    // Public listings include public ticket types. Explicit product filters may
    // also reveal hidden ticket IDs for direct-link/widget purchase flows.
    const ticketTypes = await ttRepo.findPublicOrRequestedByEvent(eventId, requestedProducts);
    const products = await new ProductRepository(db).findByEvent(eventId);

    const results: Record<string, unknown>[] = await Promise.all(
      ticketTypes.map(async (tt) => {
        const availability = await inventoryService.getAvailability(tt.inventory_pool_id);
        return {
          ticketTypeId: tt.id,
          eventOccurrenceId: tt.event_occurrence_id ?? undefined,
          name: tt.name,
          kind: tt.kind,
          priceCents: Number(tt.price_cents),
          currency: tt.currency,
          minimumPriceCents: tt.minimum_price_cents ? Number(tt.minimum_price_cents) : undefined,
          minPerOrder: tt.min_per_order,
          maxPerOrder: tt.max_per_order,
          available: availability.available,
          status: availability.available > 0 ? tt.status : 'sold_out',
          requiresAccessCode: tt.requires_access_code,
          accessCodeHint: tt.access_code_hint ?? undefined,
          description: tt.description ?? undefined,
          salesStartAt: tt.sales_start_at,
          salesEndAt: tt.sales_end_at,
        };
      }),
    );
    const now = new Date();
    for (const product of products) {
      const availableFrom = toDate(product.available_from);
      const availableUntil = toDate(product.available_until);
      const unavailable =
        product.status !== 'active' ||
        (availableFrom && now < availableFrom) ||
        (availableUntil && now > availableUntil);
      if (unavailable) continue;
      results.push({
        type: 'product',
        productId: product.id,
        name: product.name,
        kind: 'product',
        priceCents: Number(product.price_cents),
        currency: product.currency,
        minPerOrder: 1,
        maxPerOrder: product.max_per_order,
        available: product.max_per_order,
        status: product.status,
        requiresAccessCode: false,
        description: product.description ?? undefined,
        salesStartAt: product.available_from,
        salesEndAt: product.available_until,
      });
    }
    return results;
  });

  app.post(
    '/public/events/:eventId/access-code',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request) => {
            const { eventId } = request.params as { eventId?: string };
            return `${request.ip}:${eventId ?? 'unknown'}`;
          },
        },
      },
    },
    async (request) => {
      const { eventId } = request.params as { eventId: string };
      const body = (request.body ?? {}) as {
        ticketTypeIds?: unknown;
        accessCode?: unknown;
        buyerEmail?: unknown;
      };
      const ticketTypeIds = parseTicketTypeIds(body.ticketTypeIds);
      const accessCode = typeof body.accessCode === 'string' ? body.accessCode.trim() : undefined;
      const buyerEmail = typeof body.buyerEmail === 'string' ? body.buyerEmail.trim() : undefined;

      if (ticketTypeIds.length === 0) {
        throw new ValidationError('At least one ticket type is required');
      }
      if (!accessCode && !buyerEmail) {
        throw new ValidationError('Access code or buyer email is required');
      }

      const event = await new EventRepository(db).findById(eventId);
      if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);

      const ticketTypes = await db
        .selectFrom('ticket_types')
        .selectAll()
        .where('event_id', '=', eventId)
        .where('id', 'in', ticketTypeIds)
        .where('status', 'in', ['active', 'sold_out'])
        .execute();

      if (ticketTypes.length !== ticketTypeIds.length) {
        throw new ValidationError('One or more ticket types are not available for this event');
      }

      const now = new Date();
      const accessRules = await new AccessRuleRepository(db).findByTicketTypes(ticketTypeIds);
      const unlockedTicketTypeIds: string[] = [];
      for (const ticketType of ticketTypes) {
        const rules = accessRules
          .filter((rule) => rule.ticket_type_id === ticketType.id)
          .map((rule) => ({
            type: rule.type as AccessRuleRecord['type'],
            value: rule.value,
            maxUses: rule.max_uses,
            usesCount: rule.uses_count,
            expiresAt: rule.expires_at,
          }));
        const unlocked = rules.some((rule) =>
          accessRuleUnlocks(rule, { accessCode, buyerEmail, now }),
        );
        if (unlocked) {
          unlockedTicketTypeIds.push(ticketType.id);
        }
      }

      if (unlockedTicketTypeIds.length === 0) {
        throw new ValidationError('Access code is not valid for these tickets');
      }

      return { valid: true, ticketTypeIds: unlockedTicketTypeIds };
    },
  );

  app.get('/public/events/:eventId/questions', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);

    const questions = await db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('sort_order', 'asc')
      .execute();

    const serialized = questions
      .filter((q) => !isHiddenQuestion(q))
      .map((q) => ({
        id: q.id,
        eventId: q.event_id,
        ticketTypeId: q.ticket_type_id ?? undefined,
        type: q.type,
        label: q.label,
        description: q.description ?? undefined,
        required: q.required,
        appliesTo: q.applies_to,
        options: parseJsonValue<string[] | undefined>(q.options, undefined),
        placeholder: q.placeholder ?? undefined,
        isConsentField: q.is_consent_field,
        consentText: q.consent_text ?? undefined,
        consentVersion: q.consent_version ?? undefined,
        conditionalVisibility: parseJsonValue(q.conditional_visibility, undefined),
        sortOrder: q.sort_order,
      }));

    return {
      buyerQuestions: serialized
        .filter((q) => q.appliesTo === 'buyer' || q.appliesTo === 'both')
        .map((q) => Object.assign({}, q, { appliesTo: 'buyer' as const })),
      attendeeQuestions: serialized
        .filter((q) => q.appliesTo === 'attendee' || q.appliesTo === 'both')
        .map((q) => Object.assign({}, q, { appliesTo: 'attendee' as const })),
    };
  });
};

function isHiddenQuestion(row: Record<string, unknown>): boolean {
  return (
    row.status === 'hidden' ||
    row.status === 'deleted' ||
    row.is_hidden === true ||
    row.hidden_at != null ||
    row.deleted_at != null
  );
}
