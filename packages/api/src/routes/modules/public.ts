import type { FastifyPluginAsync } from 'fastify';
import { AccessRuleRepository, EventRepository, TicketTypeRepository, BrandRepository } from '@gatekit/db';
import { NotFoundError, ValidationError } from '@gatekit/domain';
import type { AccessRuleRecord } from '@gatekit/domain';
import { parseJsonValue } from '../../http/contracts.js';

function firstQueryParam(value: unknown): string {
  return Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '';
}

function parseRequestedProducts(value: unknown): string[] {
  return firstQueryParam(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseTicketTypeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
}

function toDate(value?: Date | string | null): Date | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

function accessRuleUnlocks(
  rule: AccessRuleRecord,
  input: { accessCode?: string; buyerEmail?: string; now: Date },
): boolean {
  const expiresAt = toDate(rule.expiresAt);
  if (expiresAt && input.now > expiresAt) return false;
  if (rule.maxUses != null && rule.usesCount >= rule.maxUses) return false;
  if (rule.type === 'allowlist') {
    return Boolean(input.buyerEmail) && rule.value.toLowerCase() === input.buyerEmail!.toLowerCase();
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
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);
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
    };
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
    const requestedProducts = parseRequestedProducts((request.query as { products?: unknown }).products);
    const event = await new EventRepository(db).findById(eventId);
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);

    const ttRepo = new TicketTypeRepository(db);
    // Public listings include public ticket types. Explicit product filters may
    // also reveal hidden ticket IDs for direct-link/widget purchase flows.
    const ticketTypes = await ttRepo.findPublicOrRequestedByEvent(eventId, requestedProducts);

    const results = [];
    for (const tt of ticketTypes) {
      const availability = await inventoryService.getAvailability(tt.inventory_pool_id);
      results.push({
        ticketTypeId: tt.id,
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
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);

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
      const unlocked = rules.some((rule) => accessRuleUnlocks(rule, { accessCode, buyerEmail, now }));
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
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);

    const questions = await db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('sort_order', 'asc')
      .execute();

    const serialized = questions.filter((q) => !isHiddenQuestion(q)).map((q) => ({
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
        .map((q) => ({ ...q, appliesTo: 'buyer' as const })),
      attendeeQuestions: serialized
        .filter((q) => q.appliesTo === 'attendee' || q.appliesTo === 'both')
        .map((q) => ({ ...q, appliesTo: 'attendee' as const })),
    };
  });
};

function isHiddenQuestion(row: Record<string, unknown>): boolean {
  return row.status === 'hidden' ||
    row.status === 'deleted' ||
    row.is_hidden === true ||
    row.hidden_at != null ||
    row.deleted_at != null;
}
