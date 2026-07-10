import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccessRuleRepository,
  EventRepository,
  TicketListingRepository,
  BrandRepository,
  EventOccurrenceRepository,
  type Database,
} from '@tixkit/db';
import { accessRuleMatches, NotFoundError, ValidationError } from '@tixkit/domain';
import type { AccessRuleRecord, Question } from '@tixkit/domain';
import {
  parseJsonValue,
  serializeBrandTheme,
  serializeEventOccurrence,
  serializeEventOccurrenceStatus,
  serializeMarketingIntegration,
  serializeResalePolicy,
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
    if (
      url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
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

function parsePublicPageParams(query: { cursor?: unknown; limit?: unknown }): {
  cursor?: string;
  limit: number;
} {
  const cursor = firstQueryParam(query.cursor).trim() || undefined;
  const rawLimit = Number.parseInt(firstQueryParam(query.limit), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 50;
  return { cursor, limit };
}

function normalizeAnalyticsUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
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

export type PublicEventRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  timezone: string;
  starts_at: Date | string;
  ends_at: Date | string | null;
  venue: string | null;
  visibility: string | null;
  cover_image_url?: string | null;
  minimum_age: number | null;
  resale_enabled?: boolean | number;
  resale_max_multiplier?: number;
  resale_max_absolute_cents?: number | null;
  public_revision?: Date | string | null;
};

export type PublicAvailabilityItem = Record<string, unknown>;

type PublicAvailabilityMetadata = {
  ticketTypes: Array<Record<string, any>>;
  products: Array<Record<string, any>>;
};

type PublicAvailabilityMetadataCacheEntry = {
  expiresAt: number;
  value: PublicAvailabilityMetadata;
};

export type PublicAvailabilityMetadataCache = Map<string, PublicAvailabilityMetadataCacheEntry>;

const DEFAULT_PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS = 60_000;
const MAX_PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS = 300_000;
const MAX_PUBLIC_AVAILABILITY_METADATA_CACHE_ENTRIES = 512;

export function createPublicAvailabilityMetadataCache(): PublicAvailabilityMetadataCache {
  return new Map();
}

function publicAvailabilityMetadataCacheTtlMs(): number {
  const raw = process.env.PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS;
  if (!raw) return DEFAULT_PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS;
  return Math.min(Math.max(parsed, 0), MAX_PUBLIC_AVAILABILITY_METADATA_CACHE_TTL_MS);
}

function publicAvailabilityMetadataCacheKey(eventId: string, requested: readonly string[]): string {
  // eslint-disable-next-line unicorn/no-array-sort -- API targets ES2022; sort a copy to preserve caller data.
  return JSON.stringify({ eventId, requested: [...requested].sort() });
}

function clonePublicAvailabilityMetadata(
  value: PublicAvailabilityMetadata,
): PublicAvailabilityMetadata {
  return {
    ticketTypes: value.ticketTypes.map((row) => ({ ...row })),
    products: value.products.map((row) => ({ ...row })),
  };
}

function rememberPublicAvailabilityMetadata(
  cache: PublicAvailabilityMetadataCache,
  key: string,
  value: PublicAvailabilityMetadata,
  expiresAt: number,
): void {
  cache.set(key, { expiresAt, value: clonePublicAvailabilityMetadata(value) });
  while (cache.size > MAX_PUBLIC_AVAILABILITY_METADATA_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    cache.delete(oldestKey);
  }
}

export async function loadPublicEventById(db: Database, eventId: string): Promise<PublicEventRow> {
  const event = await db
    .selectFrom('events')
    .select([
      'id',
      'tenant_id',
      'organization_id',
      'brand_id',
      'slug',
      'title',
      'description',
      'status',
      'timezone',
      'starts_at',
      'ends_at',
      'venue',
      'visibility',
      'cover_image_url',
      'minimum_age',
      'resale_enabled',
      'resale_max_multiplier',
      'resale_max_absolute_cents',
      'public_revision',
    ])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', eventId);
  return event as PublicEventRow;
}

export async function loadPublicMarketingIntegrations(db: Database, eventId: string) {
  return db
    .selectFrom('marketing_integrations')
    .select(['provider', 'config', 'consent_required', 'status'])
    .where('event_id', '=', eventId)
    .where('status', '=', 'active')
    .execute();
}

export function serializePublicEvent(
  event: PublicEventRow,
  marketingIntegrations: Record<string, unknown>[],
) {
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
    coverImageUrl: event.cover_image_url ?? undefined,
    minimumAge: event.minimum_age,
    marketingIntegrations: marketingIntegrations.map((row) =>
      serializeMarketingIntegration(row, { public: true }),
    ),
  };
}

async function loadPublicAvailabilityMetadata(
  db: Database,
  eventId: string,
  requested: readonly string[],
  cache?: PublicAvailabilityMetadataCache,
): Promise<PublicAvailabilityMetadata> {
  const ttlMs = publicAvailabilityMetadataCacheTtlMs();
  const key = cache && ttlMs > 0 ? publicAvailabilityMetadataCacheKey(eventId, requested) : null;
  const now = Date.now();
  if (cache && key) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return clonePublicAvailabilityMetadata(cached.value);
    if (cached) cache.delete(key);
  }

  let ticketTypeQuery = db
    .selectFrom('ticket_types')
    .select([
      'id',
      'event_occurrence_id',
      'name',
      'description',
      'kind',
      'status',
      'visibility',
      'currency',
      'price_cents',
      'minimum_price_cents',
      'sales_start_at',
      'sales_end_at',
      'min_per_order',
      'max_per_order',
      'inventory_pool_id',
      'requires_access_code',
      'access_code_hint',
    ])
    .where('event_id', '=', eventId)
    .where('status', 'in', ['active', 'sold_out']);

  ticketTypeQuery =
    requested.length > 0
      ? ticketTypeQuery.where((eb) =>
          eb.or([eb('visibility', '=', 'public'), eb('id', 'in', requested)]),
        )
      : ticketTypeQuery.where('visibility', '=', 'public');

  const [ticketTypes, products] = await Promise.all([
    ticketTypeQuery.orderBy('sort_order', 'asc').orderBy('id', 'asc').execute(),
    db
      .selectFrom('products')
      .select([
        'id',
        'name',
        'description',
        'price_cents',
        'currency',
        'max_per_order',
        'available_from',
        'available_until',
        'status',
      ])
      .where('event_id', '=', eventId)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute(),
  ]);
  const metadata = {
    ticketTypes: ticketTypes.map((row) => Object.assign({}, row)),
    products: products.map((row) => Object.assign({}, row)),
  };
  if (cache && key) rememberPublicAvailabilityMetadata(cache, key, metadata, now + ttlMs);
  return clonePublicAvailabilityMetadata(metadata);
}

export async function loadPublicAvailability(
  db: Database,
  inventoryService: {
    getAvailabilityBatch: (inventoryPoolIds: readonly string[]) => Promise<Map<string, any>>;
    getOccurrenceAvailabilityBatch: (occurrenceIds: readonly string[]) => Promise<Map<string, any>>;
  },
  eventId: string,
  requestedProducts: string[],
  metadataCache?: PublicAvailabilityMetadataCache,
): Promise<PublicAvailabilityItem[]> {
  const requested = [...new Set(requestedProducts.filter(Boolean))];
  const { ticketTypes, products } = await loadPublicAvailabilityMetadata(
    db,
    eventId,
    requested,
    metadataCache,
  );

  const inventoryPoolIds = [...new Set(ticketTypes.map((tt) => tt.inventory_pool_id))];
  const occurrenceIds = [
    ...new Set(
      ticketTypes
        .map((tt) => tt.event_occurrence_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const [availabilityByPool, availabilityByOccurrence] = await Promise.all([
    inventoryService.getAvailabilityBatch(inventoryPoolIds),
    inventoryService.getOccurrenceAvailabilityBatch(occurrenceIds),
  ]);

  const results: PublicAvailabilityItem[] = ticketTypes.map((tt) => {
    const availability = availabilityByPool.get(tt.inventory_pool_id) ?? {
      total: 0,
      sold: 0,
      reserved: 0,
      available: 0,
    };
    const occurrenceAvailability = tt.event_occurrence_id
      ? availabilityByOccurrence.get(tt.event_occurrence_id)
      : undefined;
    const available =
      occurrenceAvailability?.available === null || occurrenceAvailability === undefined
        ? availability.available
        : Math.min(availability.available, occurrenceAvailability.available);
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
      available,
      status: available > 0 ? tt.status : 'sold_out',
      requiresAccessCode: tt.requires_access_code,
      accessCodeHint: tt.access_code_hint ?? undefined,
      description: tt.description ?? undefined,
      salesStartAt: tt.sales_start_at,
      salesEndAt: tt.sales_end_at,
    };
  });
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
}

export async function loadPublicCheckoutQuestions(db: Database, eventId: string) {
  const questions = await db
    .selectFrom('questions')
    .select([
      'id',
      'event_id',
      'ticket_type_id',
      'type',
      'label',
      'description',
      'required',
      'applies_to',
      'options',
      'placeholder',
      'is_consent_field',
      'consent_text',
      'consent_version',
      'validation_pattern',
      'conditional_visibility',
      'sort_order',
      'status',
      'is_hidden',
      'hidden_at',
      'deleted_at',
    ])
    .where('event_id', '=', eventId)
    .orderBy('sort_order', 'asc')
    .execute();

  const visibleQuestions = questions.filter((q) => !isHiddenQuestion(q));
  const visibleQuestionIds = new Set(visibleQuestions.map((q) => String(q.id)));
  const serialized = visibleQuestions.map((q) => ({
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
    validationPattern: q.validation_pattern ?? undefined,
    conditionalVisibility: parseQuestionConditionalVisibility(
      q.conditional_visibility,
      visibleQuestionIds,
    ),
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
}

async function loadPublicResaleListingById(db: Database, event: PublicEventRow, listingId: string) {
  if (!serializeResalePolicy(event).enabled) return null;

  const now = new Date();
  const listing = await db
    .selectFrom('ticket_listings')
    .innerJoin('tickets', 'tickets.id', 'ticket_listings.ticket_id')
    .innerJoin('ticket_types', 'ticket_types.id', 'tickets.ticket_type_id')
    .select([
      'ticket_listings.id as id',
      'ticket_listings.event_id as event_id',
      'ticket_types.id as ticket_type_id',
      'ticket_types.name as ticket_type_name',
      'tickets.event_occurrence_id as event_occurrence_id',
      'ticket_listings.status as status',
      'ticket_listings.price_cents as price_cents',
      'ticket_listings.currency as currency',
      'ticket_listings.face_value_cents as face_value_cents',
      'ticket_listings.expires_at as expires_at',
      'ticket_listings.created_at as created_at',
      'ticket_listings.updated_at as updated_at',
    ])
    .where('ticket_listings.tenant_id', '=', event.tenant_id)
    .where('ticket_listings.event_id', '=', event.id)
    .where('ticket_listings.id', '=', listingId)
    .where('ticket_listings.status', '=', 'listed')
    .where((eb) =>
      eb.or([
        eb('ticket_listings.expires_at', 'is', null),
        eb('ticket_listings.expires_at', '>', now),
      ]),
    )
    .where((eb) =>
      eb.or([
        eb('ticket_listings.reserved_checkout_session_id', 'is', null),
        eb('ticket_listings.reserved_until', 'is', null),
        eb('ticket_listings.reserved_until', '<=', now),
      ]),
    )
    .executeTakeFirst();
  if (!listing) return null;
  return {
    id: listing.id,
    eventId: listing.event_id,
    ticketTypeId: listing.ticket_type_id,
    ticketTypeName: listing.ticket_type_name,
    eventOccurrenceId: listing.event_occurrence_id ?? undefined,
    status: listing.status,
    priceCents: Number(listing.price_cents),
    currency: listing.currency,
    faceValueCents: Number(listing.face_value_cents),
    expiresAt: listing.expires_at ?? undefined,
    createdAt: listing.created_at,
    updatedAt: listing.updated_at,
  };
}

export async function loadPublicResaleListings(
  db: Database,
  event: PublicEventRow,
  page: { cursor?: string; limit: number },
) {
  if (!serializeResalePolicy(event).enabled) {
    return { items: [], nextCursor: null, hasMore: false };
  }

  const listings = await new TicketListingRepository(db).findPublicAvailableByEvent({
    tenantId: event.tenant_id,
    eventId: event.id,
    limit: page.limit + 1,
    cursor: page.cursor,
  });
  const listed = listings.slice(0, page.limit);
  const ticketIds = [...new Set(listed.map((listing) => String(listing.ticket_id)))];
  const rows =
    ticketIds.length > 0
      ? await db
          .selectFrom('tickets')
          .innerJoin('ticket_types', 'ticket_types.id', 'tickets.ticket_type_id')
          .select([
            'tickets.id as ticket_id',
            'ticket_types.id as ticket_type_id',
            'ticket_types.name as ticket_type_name',
            'tickets.event_occurrence_id as event_occurrence_id',
          ])
          .where('tickets.tenant_id', '=', event.tenant_id)
          .where('tickets.id', 'in', ticketIds)
          .execute()
      : [];
  const ticketTypeByTicket = new Map(rows.map((row) => [row.ticket_id, row]));

  return {
    items: listed.map((listing) => {
      const ticketType = ticketTypeByTicket.get(listing.ticket_id);
      return {
        id: listing.id,
        eventId: listing.event_id,
        ticketTypeId: ticketType?.ticket_type_id,
        ticketTypeName: ticketType?.ticket_type_name,
        eventOccurrenceId: ticketType?.event_occurrence_id ?? undefined,
        status: listing.status,
        priceCents: Number(listing.price_cents),
        currency: listing.currency,
        faceValueCents: Number(listing.face_value_cents),
        expiresAt: listing.expires_at ?? undefined,
        createdAt: listing.created_at,
        updatedAt: listing.updated_at,
      };
    }),
    nextCursor: listings.length > page.limit ? listed.at(-1)?.id : null,
    hasMore: listings.length > page.limit,
  };
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
  const availabilityMetadataCache = createPublicAvailabilityMetadataCache();

  app.get('/public/events/:eventId', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await loadPublicEventById(db, eventId);
    const marketingIntegrations = await loadPublicMarketingIntegrations(db, eventId);
    return serializePublicEvent(event, marketingIntegrations);
  });

  app.get('/public/events/by-slug/:slug', async (request) => {
    const { slug } = request.params as { slug: string };
    const host = normalizeHost((request.query as { host?: unknown }).host);
    if (!host) throw new NotFoundError('Event', slug);

    const brandDomain = await db
      .selectFrom('brand_domains')
      .select(['brand_id', 'is_verified', 'ssl_status'])
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
      .select(['id', 'white_label'])
      .where('id', '=', brandDomain.brand_id)
      .executeTakeFirst();
    if (!brand || !boolValue(brand.white_label)) throw new NotFoundError('Event', slug);

    const event = await new EventRepository(db).findByBrandSlug(
      brandDomain.brand_id as string,
      slug,
    );
    if (!event || !isPubliclyReadableEvent(event)) throw new NotFoundError('Event', slug);

    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'plan'])
      .where('id', '=', event.tenant_id)
      .executeTakeFirst();
    if (!tenant || tenant.plan === 'free') throw new NotFoundError('Event', slug);

    const marketingIntegrations = await db
      .selectFrom('marketing_integrations')
      .select(['provider', 'config', 'consent_required', 'status'])
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
      minimumAge: event.minimum_age ?? null,
      marketingIntegrations: marketingIntegrations.map((row) =>
        serializeMarketingIntegration(row, { public: true }),
      ),
    };
  });

  app.get('/public/events/:eventId/marketing-integrations', async (request) => {
    const { eventId } = request.params as { eventId: string };
    await loadPublicEventById(db, eventId);
    const rows = await loadPublicMarketingIntegrations(db, eventId);
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
      items: occurrences.flatMap((occurrence) => {
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
          host: normalizeHost(body.host) || null,
          page_url: normalizeAnalyticsUrl(body.pageUrl),
          referrer: normalizeAnalyticsUrl(body.referrer),
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
      theme: serializeBrandTheme(brand.theme),
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
    await loadPublicEventById(db, eventId);
    return loadPublicAvailability(
      db,
      inventoryService,
      eventId,
      requestedProducts,
      availabilityMetadataCache,
    );
  });

  app.get('/public/events/:eventId/bootstrap', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const query = request.query as { products?: unknown; resaleListingId?: unknown };
    const requestedProducts = parseRequestedProducts(query.products);
    const resaleListingId = firstQueryParam(query.resaleListingId).trim() || undefined;
    const event = await loadPublicEventById(db, eventId);
    const [marketingIntegrations, availability, questions, resaleListing, occurrences] =
      await Promise.all([
        loadPublicMarketingIntegrations(db, eventId),
        loadPublicAvailability(
          db,
          inventoryService,
          eventId,
          requestedProducts,
          availabilityMetadataCache,
        ),
        loadPublicCheckoutQuestions(db, eventId),
        resaleListingId
          ? loadPublicResaleListingById(db, event, resaleListingId)
          : Promise.resolve(null),
        new EventOccurrenceRepository(db).findByEvent(eventId),
      ]);
    return {
      event: serializePublicEvent(event, marketingIntegrations),
      availability,
      questions,
      resaleListing,
      occurrences: occurrences.flatMap((occurrence) =>
        serializeEventOccurrenceStatus(occurrence.status) === 'scheduled'
          ? [serializeEventOccurrence(occurrence as unknown as Record<string, unknown>)]
          : [],
      ),
    };
  });

  app.get('/public/events/:eventId/resale-listings', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const page = parsePublicPageParams(request.query as { cursor?: unknown; limit?: unknown });
    const event = await loadPublicEventById(db, eventId);
    return loadPublicResaleListings(db, event, page);
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
        .select(['id'])
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
          accessRuleMatches(rule, { accessCode, buyerEmail, now }),
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

  app.get('/public/events/:eventId/revision', async (request) => {
    const { eventId } = request.params as { eventId: string };
    const event = await loadPublicEventById(db, eventId);
    if (event.public_revision) {
      return {
        revision:
          event.public_revision instanceof Date
            ? event.public_revision.toISOString()
            : String(event.public_revision),
      };
    }

    const [eventRow, questionRow, ticketTypeRow, eventPageRow, occurrenceRow] = await Promise.all([
      db.selectFrom('events').select('updated_at').where('id', '=', eventId).executeTakeFirst(),
      db
        .selectFrom('questions')
        .select(db.fn.max('updated_at').as('max_updated'))
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
      db
        .selectFrom('ticket_types')
        .select(db.fn.max('updated_at').as('max_updated'))
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
      db
        .selectFrom('event_pages')
        .select(db.fn.max('updated_at').as('max_updated'))
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
      db
        .selectFrom('event_occurrences')
        .select(db.fn.max('updated_at').as('max_updated'))
        .where('event_id', '=', eventId)
        .executeTakeFirst(),
    ]);

    const candidates = [
      eventRow?.updated_at,
      questionRow?.max_updated,
      ticketTypeRow?.max_updated,
      eventPageRow?.max_updated,
      occurrenceRow?.max_updated,
    ]
      .filter((v) => v != null)
      .map((v) => (v instanceof Date ? v.toISOString() : String(v)));

    // eslint-disable-next-line unicorn/no-array-sort -- API targets ES2022 and this array is local.
    return { revision: candidates.length > 0 ? candidates.sort().at(-1)! : null };
  });

  app.get('/public/events/:eventId/questions', async (request) => {
    const { eventId } = request.params as { eventId: string };
    await loadPublicEventById(db, eventId);
    return loadPublicCheckoutQuestions(db, eventId);
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

function parseQuestionConditionalVisibility(
  value: unknown,
  visibleQuestionIds: ReadonlySet<string>,
): Question['conditionalVisibility'] | undefined {
  const parsed = parseJsonValue<unknown>(value, undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const condition = parsed as Record<string, unknown>;
  if (
    typeof condition.field !== 'string' ||
    typeof condition.operator !== 'string' ||
    typeof condition.value !== 'string'
  ) {
    return undefined;
  }
  if (
    condition.operator !== 'equals' &&
    condition.operator !== 'not_equals' &&
    condition.operator !== 'contains'
  ) {
    return undefined;
  }
  if (!visibleQuestionIds.has(condition.field)) return undefined;

  return {
    field: condition.field,
    operator: condition.operator,
    value: condition.value,
  };
}
