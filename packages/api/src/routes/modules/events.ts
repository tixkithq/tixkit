import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  BrandRepository,
  EventRepository,
  EventOccurrenceRepository,
  InventoryPoolRepository,
  TicketTypeRepository,
  FeeRuleRepository,
  AuditLogRepository,
  executeTableQuery,
} from '@tixkit/db';
import {
  col,
  defineTable,
  paramsToQuery,
  type AdminTableQuery,
  type AdminTablePage,
} from '@tixkit/admin-table-core';
import { ConflictError, NotFoundError, ValidationError } from '@tixkit/domain';
import { SCANNER_CONTRACT_VERSION, DEFAULT_CODE_FORMAT } from '@tixkit/domain';
import type { CodeFormat } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  hasSafeMarketingIntegrationConfig,
  isPublicMarketingPixelUrl,
  serializeEvent,
  serializeEventOccurrence,
  serializeMarketingIntegration,
} from '../../http/contracts.js';
import {
  createEventOccurrenceSchema,
  createEventSchema,
  parseBody,
  updateEventFeePolicySchema,
  updateEventCodeFormatSchema,
  updateEventOccurrenceSchema,
  updateEventSchema,
} from '../../http/schemas.js';
import { ReadinessService, resolvePaymentMode } from '../../services/readiness.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';
import { publishEvent } from '../../services/event-publication.js';
import { EventUpdateService, projectEventUpdateFields } from '../../services/event-update.js';
import { loadEventMediaThumbnails } from '../../services/event-media.js';

const marketingIntegrationStatusSchema = z.enum(['active', 'disabled']).default('active');
const onboardingTelemetrySchema = z
  .object({
    stage: z.enum([
      'onboarding_started',
      'starting_point_selected',
      'preset_creation',
      'recovery',
      'autosave_failure',
      'stale_version_conflict',
    ]),
    outcome: z.enum([
      'started',
      'blank',
      'free',
      'paid',
      'donation',
      'multiple',
      'duplicate',
      'attempted',
      'completed',
      'failed',
    ]),
    reasonCode: z.enum(['none', 'request_failed', 'stale_event_version']).default('none'),
  })
  .strict();
const venueInputSchema = z
  .object({
    organizationId: z.string().min(1),
    name: z.string().trim().min(1).max(255),
    address: z
      .object({
        address: z.string().max(500).optional(),
        city: z.string().max(255).optional(),
        region: z.string().max(255).optional(),
        postalCode: z.string().max(40).optional(),
        country: z.string().length(2).optional(),
      })
      .strict(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .strict();
const venueUpdateSchema = venueInputSchema.omit({ organizationId: true }).partial().strict();

function requireVenueIdempotencyKey(headers: Record<string, unknown>): string {
  const value = headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new ValidationError(
      'Idempotency-Key header is required for saved venue creation and must contain 1-128 printable characters',
    );
  }
  return value;
}

function serializeVenue(row: Record<string, unknown>) {
  let address: unknown = {};
  try {
    address = typeof row.address === 'string' ? JSON.parse(row.address) : (row.address ?? {});
  } catch {
    address = {};
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    address,
    timezone: row.timezone ?? undefined,
    createdAt: new Date(row.created_at as Date | string).toISOString(),
    updatedAt: new Date(row.updated_at as Date | string).toISOString(),
  };
}
const setupSectionSchema = z
  .object({
    section: z.enum(['basics', 'schedule', 'sales', 'media', 'marketing-fields']),
  })
  .strict();
const duplicateEventSchema = z
  .object({
    startsAt: z.string().datetime(),
    title: z.string().min(1).max(200).optional(),
    copy: z
      .object({
        basicsVenue: z.boolean().default(true),
        ticketTypes: z.boolean().default(true),
        products: z.boolean().default(true),
        checkoutQuestions: z.boolean().default(true),
        feeResalePolicies: z.boolean().default(true),
        eventPageContent: z.boolean().default(true),
        lifecycleContent: z.boolean().default(true),
        marketingIntegrations: z.boolean().default(true),
        mediaAssets: z.boolean().default(true),
      })
      .strict(),
  })
  .strict();
const marketingIntegrationConsentSchema = z.boolean().default(true);
const marketingIntegrationSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('ga4'),
      config: z
        .object({
          measurementId: z.string().min(1, 'measurementId is required for GA4 integrations'),
        })
        .strict(),
      consentRequired: marketingIntegrationConsentSchema,
      status: marketingIntegrationStatusSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal('meta_pixel'),
      config: z
        .object({
          pixelId: z.string().min(1, 'pixelId is required for Meta Pixel integrations'),
        })
        .strict(),
      consentRequired: marketingIntegrationConsentSchema,
      status: marketingIntegrationStatusSchema,
    })
    .strict(),
  z
    .object({
      provider: z.literal('generic_tag'),
      config: z
        .object({
          pixelUrl: z
            .string()
            .url('pixelUrl must be a valid URL')
            .refine(isPublicMarketingPixelUrl, {
              message: 'pixelUrl must use https without credentials, query, or fragment',
            }),
        })
        .strict(),
      consentRequired: marketingIntegrationConsentSchema,
      status: marketingIntegrationStatusSchema,
    })
    .strict(),
]);

const mssqlDuplicateInsertErrorNumbers = new Set([2601, 2627]);
const marketingIntegrationEventProviderConstraint = 'uniq_marketing_integrations_event_provider';
const marketingIntegrationEventProviderSqliteColumns =
  'marketing_integrations.event_id, marketing_integrations.provider';

function getErrorNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function isVenueForeignKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: string;
    number?: string | number;
    originalError?: { number?: string | number };
    cause?: {
      code?: string;
      number?: string | number;
      originalError?: { number?: string | number };
    };
  };
  const code = record.code ?? record.cause?.code;
  const number =
    getErrorNumber(record.number) ??
    getErrorNumber(record.originalError?.number) ??
    getErrorNumber(record.cause?.number) ??
    getErrorNumber(record.cause?.originalError?.number);
  return (
    code === '23503' ||
    code === 'ER_ROW_IS_REFERENCED_2' ||
    code === 'ER_NO_REFERENCED_ROW_2' ||
    number === 547
  );
}

function isMarketingIntegrationEventProviderDuplicateInsert(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: string;
    constraint?: string;
    errno?: string | number;
    index?: string;
    message?: string;
    number?: string | number;
    originalError?: { number?: string | number };
  };
  const mssqlNumber = getErrorNumber(record.number) ?? getErrorNumber(record.originalError?.number);
  const message = record.message ?? '';
  const namesEventProviderConstraint =
    record.constraint === marketingIntegrationEventProviderConstraint ||
    record.index === marketingIntegrationEventProviderConstraint ||
    message.includes(marketingIntegrationEventProviderConstraint);
  const namesSqliteEventProviderColumns =
    message.includes(marketingIntegrationEventProviderSqliteColumns) ||
    (message.includes('marketing_integrations') &&
      message.includes('event_id') &&
      message.includes('provider'));

  if (record.code === 'SQLITE_CONSTRAINT_UNIQUE') return namesSqliteEventProviderColumns;
  if (record.code === '23505') return namesEventProviderConstraint;
  if (record.code === 'ER_DUP_ENTRY' || record.errno === 1062 || record.errno === '1062') {
    return namesEventProviderConstraint;
  }
  if (
    record.code === 'EREQUEST' &&
    mssqlNumber !== undefined &&
    mssqlDuplicateInsertErrorNumbers.has(mssqlNumber)
  ) {
    return namesEventProviderConstraint;
  }
  return false;
}

/**
 * Batch-compute sales stats (gross sales, tickets sold, check-ins) for a set
 * of event IDs. Returns a map of event_id -> stats that can be merged into
 * event rows before serialization.
 */
async function computeEventStats(
  db: import('@tixkit/db').Database,
  tenantId: string,
  eventIds: string[],
): Promise<Map<string, { gross_sales_cents: number; tickets_sold: number; check_ins: number }>> {
  if (eventIds.length === 0) return new Map();

  const [salesRows, ticketRows, checkInRows] = await Promise.all([
    db
      .selectFrom('orders')
      .select(({ fn }) => ['event_id', fn.sum<number>('total_cents').as('gross_sales_cents')])
      .where('tenant_id', '=', tenantId)
      .where('event_id', 'in', eventIds)
      .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
      .where('is_test', '=', false)
      .groupBy('event_id')
      .execute(),
    db
      .selectFrom('tickets')
      .select(({ fn }) => ['event_id', fn.countAll<number>().as('tickets_sold')])
      .where('tenant_id', '=', tenantId)
      .where('event_id', 'in', eventIds)
      .where('status', 'in', ['valid', 'checked_in'])
      .groupBy('event_id')
      .execute(),
    db
      .selectFrom('tickets')
      .select(({ fn }) => ['event_id', fn.countAll<number>().as('check_ins')])
      .where('tenant_id', '=', tenantId)
      .where('event_id', 'in', eventIds)
      .where('status', '=', 'checked_in')
      .groupBy('event_id')
      .execute(),
  ]);

  const stats = new Map<
    string,
    { gross_sales_cents: number; tickets_sold: number; check_ins: number }
  >();
  for (const id of eventIds) {
    stats.set(id, { gross_sales_cents: 0, tickets_sold: 0, check_ins: 0 });
  }
  for (const row of salesRows) {
    const entry = stats.get(row.event_id as string);
    if (entry) entry.gross_sales_cents = Number(row.gross_sales_cents ?? 0);
  }
  for (const row of ticketRows) {
    const entry = stats.get(row.event_id as string);
    if (entry) entry.tickets_sold = Number(row.tickets_sold ?? 0);
  }
  for (const row of checkInRows) {
    const entry = stats.get(row.event_id as string);
    if (entry) entry.check_ins = Number(row.check_ins ?? 0);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Events table schema (server-owned)
// ---------------------------------------------------------------------------

const EVENT_STATUS_PRESETS = ['draft', 'published', 'paused', 'archived'] as const;

const eventsTableSchema = defineTable('events', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.status('status', EVENT_STATUS_PRESETS).serverField('status').sortable().facet(),
    col.text('title').serverField('title').filterable(),
    col.dateTime('startsAt').serverField('starts_at').sortable().filterable().facet(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
  ],
});

const eventListColumns = [
  'id',
  'tenant_id',
  'organization_id',
  'brand_id',
  'slug',
  'title',
  'description',
  'status',
  'currency',
  'timezone',
  'starts_at',
  'ends_at',
  'venue',
  'visibility',
  'seo',
  'capacity',
  'cover_image_url',
  'external_url',
  'resale_enabled',
  'resale_max_multiplier',
  'resale_max_absolute_cents',
  'created_at',
  'updated_at',
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

type FeeRuleRow = {
  id: string;
  event_id: string;
  name: string;
  type: string;
  value: number;
  applied_to: string;
  absorb_into_price?: boolean | number | null;
  created_at?: Date | string;
  updated_at?: Date | string;
};

type EventFeePolicyRow = {
  pass_fees_to_buyer?: boolean | number | null;
  version?: number | null;
};

function serializeDate(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : undefined;
}

function boolValue(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function eventCodeFormat(value: unknown): CodeFormat {
  if (value === null || value === undefined) return DEFAULT_CODE_FORMAT;
  if (typeof value === 'string') return JSON.parse(value) as CodeFormat;
  if (typeof value === 'object' && !Array.isArray(value)) return value as CodeFormat;
  throw new Error('Persisted event code format is invalid');
}

function duplicatedIntegrationConfig(provider: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const config = value as Record<string, unknown>;
  if (provider === 'ga4' && typeof config.measurementId === 'string')
    return { measurementId: config.measurementId };
  if (provider === 'meta_pixel' && typeof config.pixelId === 'string')
    return { pixelId: config.pixelId };
  if (provider === 'generic_tag' && typeof config.pixelUrl === 'string')
    return { pixelUrl: config.pixelUrl };
  return {};
}

function serializeFeePolicy(eventId: string, event: EventFeePolicyRow, rows: FeeRuleRow[]) {
  return {
    eventId,
    eventVersion: Number(event.version ?? 1),
    passFeesToBuyer: boolValue(event.pass_fees_to_buyer),
    rules: rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      name: row.name,
      type: row.type,
      value: Number(row.value),
      appliedTo: row.applied_to,
      absorbIntoPrice: Boolean(row.absorb_into_price),
      createdAt: serializeDate(row.created_at),
      updatedAt: serializeDate(row.updated_at),
    })),
  };
}

function feePolicyAuditProjection(event: EventFeePolicyRow, rows: FeeRuleRow[]) {
  const rules = rows
    .map((row) => ({
      name: row.name,
      type: row.type,
      value: Number(row.value),
      appliedTo: row.applied_to,
      absorbIntoPrice: boolValue(row.absorb_into_price),
    }))
    .sort((left, right) =>
      JSON.stringify([
        left.name,
        left.type,
        left.value,
        left.appliedTo,
        left.absorbIntoPrice,
      ]).localeCompare(
        JSON.stringify([
          right.name,
          right.type,
          right.value,
          right.appliedTo,
          right.absorbIntoPrice,
        ]),
      ),
    );
  return {
    passFeesToBuyer: boolValue(event.pass_fees_to_buyer),
    rules,
  };
}

function sortFeeRuleRows(rows: FeeRuleRow[]): FeeRuleRow[] {
  return [...rows].sort((left, right) => {
    const createdOrder = (serializeDate(left.created_at) ?? '').localeCompare(
      serializeDate(right.created_at) ?? '',
    );
    return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
  });
}

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.post('/onboarding-events', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const body = parseBody(onboardingTelemetrySchema, request.body);
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: body.stage,
      outcome: body.outcome,
      reason_code: body.reasonCode,
    });
    return reply.status(204).send();
  });

  app.get('/venues', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const organizationId = String(
      (request.query as { organizationId?: string }).organizationId ?? '',
    );
    ClerkAuthService.requireOrganizationScope(principal, organizationId);
    const rows = await app.context.db
      .selectFrom('venues')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .execute();
    return rows.map((row) => serializeVenue(row as unknown as Record<string, unknown>));
  });

  app.post('/venues', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const body = parseBody(venueInputSchema, request.body);
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    const idempotencyKey = requireVenueIdempotencyKey(request.headers);
    const result = await withIdempotency(
      app.context.db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ organizationId: body.organizationId, body }),
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND'],
      },
      async ({ completeInTransaction }) => {
        let responseBody: ReturnType<typeof serializeVenue> | undefined;
        await app.context.db.transaction().execute(async (transaction) => {
          const organization = await transaction
            .selectFrom('organizations')
            .selectAll()
            .where('id', '=', body.organizationId)
            .forUpdate()
            .executeTakeFirst();
          if (!organization) throw new NotFoundError('Organization', body.organizationId);
          ClerkAuthService.requireResourceTenant(
            principal,
            organization,
            'Organization',
            body.organizationId,
          );
          ClerkAuthService.requireOrganizationScope(principal, body.organizationId);

          const now = new Date();
          const values = {
            id: `ven_${ulid()}`,
            tenant_id: principal.tenantId,
            organization_id: body.organizationId,
            name: body.name,
            address: JSON.stringify(body.address),
            timezone: body.timezone ?? null,
            created_at: now,
            updated_at: now,
          };
          await transaction.insertInto('venues').values(values).execute();
          responseBody = serializeVenue(values);
          await completeInTransaction(transaction, { status: 201, body: responseBody });
        });
        if (!responseBody) throw new Error('Saved venue transaction did not produce a response');
        return { status: 201, body: responseBody };
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.patch('/venues/:venueId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { venueId } = request.params as { venueId: string };
    const body = parseBody(venueUpdateSchema, request.body);
    const existing = await app.context.db
      .selectFrom('venues')
      .selectAll()
      .where('id', '=', venueId)
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();
    if (!existing) throw new NotFoundError('Venue', venueId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    const updated = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.address !== undefined ? { address: JSON.stringify(body.address) } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      updated_at: new Date(),
    };
    await app.context.db
      .updateTable('venues')
      .set(updated)
      .where('id', '=', venueId)
      .where('tenant_id', '=', principal.tenantId)
      .where('organization_id', '=', existing.organization_id)
      .execute();
    return serializeVenue({ ...existing, ...updated });
  });

  app.delete('/venues/:venueId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { venueId } = request.params as { venueId: string };
    const venue = await app.context.db
      .selectFrom('venues')
      .selectAll()
      .where('id', '=', venueId)
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();
    if (!venue) throw new NotFoundError('Venue', venueId);
    ClerkAuthService.requireOrganizationScope(principal, venue.organization_id);
    try {
      const deleted = await app.context.db.transaction().execute(async (trx) => {
        const organization = await trx
          .selectFrom('organizations')
          .select('event_defaults')
          .where('id', '=', venue.organization_id)
          .where('tenant_id', '=', principal.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const lockedVenue = await trx
          .selectFrom('venues')
          .select('id')
          .where('id', '=', venueId)
          .where('tenant_id', '=', principal.tenantId)
          .where('organization_id', '=', venue.organization_id)
          .forUpdate()
          .executeTakeFirst();
        if (!lockedVenue) return false;
        const [eventReference, occurrenceReference] = await Promise.all([
          trx.selectFrom('events').select('id').where('venue_id', '=', venueId).executeTakeFirst(),
          trx
            .selectFrom('event_occurrences')
            .select('id')
            .where('venue_id', '=', venueId)
            .executeTakeFirst(),
        ]);
        let defaultVenueId: string | undefined;
        try {
          defaultVenueId = JSON.parse(organization.event_defaults ?? '{}').defaultVenueId;
        } catch {
          defaultVenueId = undefined;
        }
        if (eventReference || occurrenceReference || defaultVenueId === venueId) return false;
        await trx
          .deleteFrom('venues')
          .where('id', '=', venueId)
          .where('tenant_id', '=', principal.tenantId)
          .where('organization_id', '=', venue.organization_id)
          .execute();
        return true;
      });
      if (deleted) return reply.status(204).send();
    } catch (error) {
      if (!isVenueForeignKeyError(error)) throw error;
    }
    return reply.status(409).send({
      error: {
        code: 'venue_in_use',
        message: 'Remove this venue from event drafts and workspace defaults before deleting it',
        requestId: request.id,
      },
    });
  });

  const db = app.context.db;
  const audit = () => new AuditLogRepository(db);
  const createReadinessService =
    app.context.readinessServiceFactory ??
    ((database: typeof db) => new ReadinessService(database, resolvePaymentMode()));

  app.post('/events', async (request, reply) => {
    const creationStartedAt = performance.now();
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const body = parseBody(createEventSchema, request.body);
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);
    ClerkAuthService.requireBrandScope(principal, body.brandId);
    const brand = await new BrandRepository(db).findById(body.brandId);
    if (!brand) throw new NotFoundError('Brand', body.brandId);
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', body.brandId);
    ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
    if (brand.organization_id !== body.organizationId) {
      throw new NotFoundError('Brand', body.brandId);
    }
    const savedVenue = body.venueId
      ? await db
          .selectFrom('venues')
          .selectAll()
          .where('id', '=', body.venueId)
          .where('tenant_id', '=', principal.tenantId)
          .where('organization_id', '=', body.organizationId)
          .executeTakeFirst()
      : undefined;
    if (body.venueId && !savedVenue) throw new NotFoundError('Venue', body.venueId);
    const venueSnapshot = savedVenue
      ? { name: savedVenue.name, ...JSON.parse(savedVenue.address ?? '{}') }
      : body.venue;

    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : undefined;
    if (body.startingPoint !== 'blank' && !idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required for preset event creation');
    }
    const createEvent = async () => {
      const repo = new EventRepository(db);
      if (!(await repo.isSlugAvailable(body.brandId, body.slug))) {
        throw new ValidationError('Event slug is already in use');
      }
      const event = await db.transaction().execute(async (trx) => {
        const txDb = trx as typeof db;
        const created = await new EventRepository(txDb).create({
          tenantId: principal.tenantId,
          organizationId: body.organizationId,
          brandId: body.brandId,
          slug: body.slug,
          title: body.title,
          description: body.description,
          currency: body.currency,
          timezone: body.timezone,
          startsAt: new Date(body.startsAt),
          endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
          venue: venueSnapshot as Record<string, unknown> | undefined,
          visibility: body.visibility,
          seo: body.seo as Record<string, unknown> | undefined,
          capacity: body.capacity,
          minimumAge: body.minimumAge,
          externalUrl: body.externalUrl,
        });
        if (savedVenue) {
          await txDb
            .updateTable('events')
            .set({ venue_id: savedVenue.id })
            .where('id', '=', created.id)
            .execute();
        }
        if (body.startingPoint === 'multiple') {
          const startsAt = new Date(body.startsAt);
          await new EventOccurrenceRepository(txDb).create({
            eventId: created.id,
            title: body.title,
            startsAt,
            endsAt: body.endsAt ? new Date(body.endsAt) : new Date(startsAt.getTime() + 7_200_000),
            timezone: body.timezone,
            venue: venueSnapshot as Record<string, unknown> | undefined,
            capacity: body.capacity,
          });
        } else if (body.startingPoint !== 'blank') {
          const pool = await new InventoryPoolRepository(txDb).create({
            eventId: created.id,
            name: 'Admission inventory',
            totalCapacity: body.capacity ?? 100,
            holdTtlSeconds: 900,
          });
          await new TicketTypeRepository(txDb).create({
            eventId: created.id,
            name:
              body.startingPoint === 'free'
                ? 'RSVP'
                : body.startingPoint === 'paid'
                  ? 'General admission'
                  : 'Donation',
            kind: body.startingPoint,
            currency: body.currency,
            priceCents: body.startingPoint === 'paid' ? 2500 : 0,
            minimumPriceCents: body.startingPoint === 'donation' ? 0 : undefined,
            inventoryPoolId: pool.id,
            minPerOrder: 1,
            maxPerOrder: 10,
          });
        }
        if (body.startingPoint !== 'blank') {
          await app.context.eventPresetCheckpoint?.({
            stage: 'after_preset_applied',
            eventId: created.id,
            startingPoint: body.startingPoint,
          });
        }
        await writeAuditLog(new AuditLogRepository(txDb), request, principal, {
          action: 'event.created',
          organizationId: body.organizationId,
          brandId: body.brandId,
          resourceType: 'Event',
          resourceId: created.id,
          diffSummary: { slug: body.slug, title: body.title },
        });
        if (idempotencyKey) {
          await txDb
            .updateTable('idempotency_records')
            .set({
              response_status: 201,
              response_body: JSON.stringify(serializeEvent(created)),
              status: 'completed',
            })
            .where('key', '=', idempotencyKey)
            .where('tenant_id', '=', principal.tenantId)
            .execute();
        }
        return created;
      });
      app.observability?.metrics.metrics.onboardingEvents?.inc({
        stage: 'first_draft',
        outcome: 'completed',
        reason_code: 'none',
      });
      if (body.startingPoint !== 'blank') {
        app.observability?.metrics.metrics.onboardingEvents?.inc({
          stage: 'starting_point_applied',
          outcome: 'completed',
          reason_code: 'none',
        });
      }
      if (['free', 'paid', 'donation'].includes(body.startingPoint)) {
        app.observability?.metrics.metrics.onboardingEvents?.inc({
          stage: 'first_ticket',
          outcome: 'completed',
          reason_code: 'none',
        });
        app.observability?.metrics.metrics.onboardingMilestoneDuration?.observe(
          { milestone: 'first_ticket' },
          Math.max(0, (performance.now() - creationStartedAt) / 1000),
        );
      }
      app.observability?.metrics.metrics.onboardingMilestoneDuration?.observe(
        { milestone: 'first_draft' },
        Math.max(0, (performance.now() - creationStartedAt) / 1000),
      );
      return { status: 201, body: serializeEvent(event) };
    };

    let result;
    try {
      result = idempotencyKey
        ? await withIdempotency(
            db,
            {
              key: idempotencyKey,
              tenantId: principal.tenantId,
              requestHash: hashRequest({
                organizationId: body.organizationId,
                brandId: body.brandId,
                body,
              }),
            },
            createEvent,
          )
        : await createEvent();
    } catch (error) {
      if (body.venueId && isVenueForeignKeyError(error)) {
        throw new NotFoundError('Venue', body.venueId);
      }
      throw error;
    }
    return reply.status(result.status).send(result.body);
  });

  app.get('/events', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');

    const rawQuery = request.query as Record<string, string | undefined>;
    const { organizationId, brandId } = rawQuery;

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
      scope.id = principal.eventIds;
    }

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(rawQuery)) {
      if (value !== undefined && key !== 'organizationId' && key !== 'brandId') {
        searchParams.set(key, value);
      }
    }
    const tableQuery = parseStrictTableQuery(eventsTableSchema, searchParams);

    const result = await executeTableQuery(
      db,
      {
        tableName: 'events',
        schema: eventsTableSchema,
        tenantId: principal.tenantId,
        scope,
        serialize: serializeEvent,
        selectFields: eventListColumns,
      },
      tableQuery,
    );

    // Enrich with event stats and optimized organizer thumbnails in bounded bulk queries.
    const eventIds = result.items.map((e) => (e as Record<string, unknown>).id as string);
    if (eventIds.length > 0) {
      const [stats, thumbnails] = await Promise.all([
        computeEventStats(db, principal.tenantId, eventIds),
        loadEventMediaThumbnails(db, {
          tenantId: principal.tenantId,
          eventIds,
        }),
      ]);
      const enrichedItems = result.items.map((item) => {
        const event = item as Record<string, unknown>;
        const stat = stats.get(event.id as string);
        return {
          ...event,
          ...(stat
            ? {
                grossSalesCents: stat.gross_sales_cents,
                ticketsSold: stat.tickets_sold,
                checkIns: stat.check_ins,
              }
            : {}),
          thumbnail: thumbnails.get(event.id as string) ?? null,
        };
      });
      return { ...result, items: enrichedItems } as AdminTablePage<unknown>;
    }

    return result as AdminTablePage<unknown>;
  });

  app.get('/events/:eventId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const event = await repo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const [stats, thumbnails] = await Promise.all([
      computeEventStats(db, principal.tenantId, [eventId]),
      loadEventMediaThumbnails(db, {
        tenantId: principal.tenantId,
        eventIds: [eventId],
      }),
    ]);
    return {
      ...serializeEvent({ ...event, ...stats.get(eventId) }),
      thumbnail: thumbnails.get(eventId) ?? null,
    };
  });

  app.get('/events/:eventId/operational-health', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const [webhooks, exports] = await Promise.all([
      db
        .selectFrom('webhook_deliveries')
        .innerJoin('webhook_endpoints', 'webhook_endpoints.id', 'webhook_deliveries.endpoint_id')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('webhook_endpoints.tenant_id', '=', event.tenant_id)
        .where('webhook_endpoints.organization_id', '=', event.organization_id)
        .where('webhook_deliveries.status', 'in', ['failed', 'dead_lettered'])
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('export_jobs')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', event.tenant_id)
        .where('event_id', '=', eventId)
        .where('status', '=', 'failed')
        .executeTakeFirstOrThrow(),
    ]);
    return {
      eventId,
      organizationFailedWebhookDeliveries: Number(webhooks.count),
      failedExports: Number(exports.count),
      checkedAt: new Date().toISOString(),
    };
  });

  app.put('/events/:eventId/setup-section', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(setupSectionSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await db
      .updateTable('events')
      .set({ last_setup_section: body.section, updated_at: new Date() })
      .where('id', '=', eventId)
      .where('tenant_id', '=', event.tenant_id)
      .where('organization_id', '=', event.organization_id)
      .where('brand_id', '=', event.brand_id)
      .execute();
    await writeAuditLog(audit(), request, principal, {
      action: 'event.setup_section.update',
      resourceType: 'event',
      resourceId: eventId,
      organizationId: event.organization_id,
      brandId: event.brand_id,
      diffSummary: { section: body.section },
    });
    return { eventId, section: body.section };
  });

  app.get('/events/:eventId/occurrences', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const event = await repo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const rows = await new EventOccurrenceRepository(db).findByEvent(eventId);
    return { items: rows.map(serializeEventOccurrence) };
  });

  app.post('/events/:eventId/occurrences', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createEventOccurrenceSchema, request.body);
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (endsAt <= startsAt) {
      throw new ValidationError('Occurrence end time must be after start time');
    }
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.eventOccurrenceCheckpoint?.({
      stage: 'before_transaction',
      operation: 'create',
      eventId,
    });

    const occurrence = await db.transaction().execute(async (transaction) => {
      const currentEvent = await transaction
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentEvent) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, currentEvent, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, currentEvent.organization_id);
      ClerkAuthService.requireBrandScope(principal, currentEvent.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      const created = await new EventOccurrenceRepository(transaction).create({
        eventId,
        title: body.title,
        startsAt,
        endsAt,
        timezone: body.timezone,
        venue: body.venue as Record<string, unknown> | null | undefined,
        capacity: body.capacity,
        sortOrder: body.sortOrder,
        status: body.status,
      });
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'event_occurrence.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'EventOccurrence',
          resourceId: created.id,
          diffSummary: { eventId, after: serializeEventOccurrence(created) },
        },
        { failClosed: true },
      );
      return created;
    });
    return reply.status(201).send(serializeEventOccurrence(occurrence));
  });

  app.patch('/events/:eventId/occurrences/:occurrenceId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, occurrenceId } = request.params as {
      eventId: string;
      occurrenceId: string;
    };
    const body = parseBody(updateEventOccurrenceSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.eventOccurrenceCheckpoint?.({
      stage: 'before_transaction',
      operation: 'update',
      eventId,
      occurrenceId,
    });

    return db.transaction().execute(async (transaction) => {
      const currentEvent = await transaction
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentEvent) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, currentEvent, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, currentEvent.organization_id);
      ClerkAuthService.requireBrandScope(principal, currentEvent.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);

      const existing = await transaction
        .selectFrom('event_occurrences')
        .selectAll()
        .where('id', '=', occurrenceId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing || existing.event_id !== eventId) {
        throw new NotFoundError('EventOccurrence', occurrenceId);
      }
      const startsAt = body.startsAt ? new Date(body.startsAt) : new Date(existing.starts_at);
      const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(existing.ends_at);
      if (endsAt <= startsAt) {
        throw new ValidationError('Occurrence end time must be after start time');
      }

      const updateData: Record<string, unknown> = {};
      if (body.title !== undefined) updateData.title = body.title;
      if (body.startsAt !== undefined) updateData.starts_at = startsAt;
      if (body.endsAt !== undefined) updateData.ends_at = endsAt;
      if (body.timezone !== undefined) updateData.timezone = body.timezone;
      if (body.venue !== undefined)
        updateData.venue = body.venue ? JSON.stringify(body.venue) : null;
      if (body.capacity !== undefined) updateData.capacity = body.capacity;
      if (body.sortOrder !== undefined) updateData.sort_order = body.sortOrder;
      if (body.status !== undefined) updateData.status = body.status;

      const updated = await new EventOccurrenceRepository(transaction).update(
        occurrenceId,
        updateData,
      );
      const serialized = serializeEventOccurrence(updated);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'event_occurrence.updated',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'EventOccurrence',
          resourceId: occurrenceId,
          diffSummary: {
            eventId,
            before: serializeEventOccurrence(existing),
            after: serialized,
          },
        },
        { failClosed: true },
      );
      return serialized;
    });
  });

  app.patch('/events/:eventId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(updateEventSchema, request.body);

    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    let result;
    try {
      const service = new EventUpdateService(db);
      const resolved = await service.resolvePatch({
        tenantId: principal.tenantId,
        eventId,
        patch: body,
      });
      await app.context.eventUpdateCheckpoint?.({ stage: 'before_transaction', eventId });
      result = await db.transaction().execute(async (transaction) => {
        const applied = await service.applyResolvedPatchInTransaction(
          transaction,
          resolved,
          (current) => {
            ClerkAuthService.requireResourceTenant(principal, current, 'Event', eventId);
            ClerkAuthService.requireOrganizationScope(principal, current.organization_id);
            ClerkAuthService.requireBrandScope(principal, current.brand_id);
            ClerkAuthService.requireEventScope(principal, eventId);
          },
        );
        if (!applied.applied) return applied;
        await writeAuditLog(
          new AuditLogRepository(transaction as typeof db),
          request,
          principal,
          {
            action: 'event.updated',
            organizationId: applied.previousEvent.organization_id,
            brandId: applied.previousEvent.brand_id,
            resourceType: 'Event',
            resourceId: eventId,
            diffSummary: {
              fields: resolved.requestedFields,
              before: projectEventUpdateFields(applied.previousEvent, resolved.requestedFields),
              after: projectEventUpdateFields(applied.event, resolved.requestedFields),
              previousVersion: resolved.expectedVersion,
              newVersion: Number(applied.event.version),
            },
          },
          { failClosed: true },
        );
        return applied;
      });
    } catch (error) {
      if (body.venueId && isVenueForeignKeyError(error)) {
        throw new NotFoundError('Venue', body.venueId);
      }
      throw error;
    }
    if (!result.applied) {
      return reply.status(409).send({
        error: {
          code: 'stale_event_version',
          message: 'The event was changed in another session',
          details: {
            expectedVersion: body.expectedVersion,
            currentVersion: result.currentVersion,
          },
          requestId: request.id,
        },
      });
    }
    return serializeEvent(result.event);
  });

  app.get('/events/:eventId/fee-policy', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const rows = sortFeeRuleRows(
      (await new FeeRuleRepository(db).findByEvent(eventId)) as FeeRuleRow[],
    );
    return serializeFeePolicy(eventId, event as EventFeePolicyRow, rows as FeeRuleRow[]);
  });

  app.put('/events/:eventId/fee-policy', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(updateEventFeePolicySchema, request.body);
    const repo = new EventRepository(db);
    const event = await repo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    await app.context.eventFeePolicyCheckpoint?.({ stage: 'before_transaction', eventId });
    const transactionResult = await db.transaction().execute(async (trx) => {
      const transactionEventRepository = new EventRepository(trx as typeof db);
      const lockedEvent = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!lockedEvent) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, lockedEvent, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, lockedEvent.organization_id);
      ClerkAuthService.requireBrandScope(principal, lockedEvent.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      if (Number(lockedEvent.version) !== body.expectedVersion) return null;
      const beforeRows = await new FeeRuleRepository(trx as typeof db).findByEvent(eventId);
      const updated = await transactionEventRepository.updateIfVersion(
        eventId,
        body.expectedVersion,
        {
          pass_fees_to_buyer: body.passFeesToBuyer,
          checkout_configuration_updated_at: new Date(),
        } as Record<string, unknown>,
      );
      if (!updated) return null;
      await trx.deleteFrom('fee_rules').where('event_id', '=', eventId).execute();
      if (body.rules.length > 0) {
        const now = new Date();
        await trx
          .insertInto('fee_rules')
          .values(
            body.rules.map((rule) => ({
              id: `fee_${ulid()}`,
              event_id: eventId,
              name: rule.name,
              type: rule.type,
              value: rule.value,
              applied_to: rule.appliedTo,
              absorb_into_price: !body.passFeesToBuyer,
              created_at: now,
              updated_at: now,
            })),
          )
          .execute();
      }
      const feeRows = sortFeeRuleRows(
        (await new FeeRuleRepository(trx as typeof db).findByEvent(eventId)) as FeeRuleRow[],
      );
      await writeAuditLog(
        new AuditLogRepository(trx as typeof db),
        request,
        principal,
        {
          action: 'event.fee_policy_updated',
          organizationId: lockedEvent.organization_id,
          brandId: lockedEvent.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: {
            before: feePolicyAuditProjection(lockedEvent, beforeRows as FeeRuleRow[]),
            after: feePolicyAuditProjection(updated, feeRows as FeeRuleRow[]),
            previousVersion: Number(lockedEvent.version),
            newVersion: Number(updated.version),
          },
        },
        { failClosed: true },
      );
      return { rows: feeRows, updatedEvent: updated };
    });
    if (!transactionResult) {
      const current = await repo.findById(eventId);
      return reply.status(409).send({
        error: {
          code: 'stale_event_version',
          message: 'The event fee policy changed in another session',
          details: {
            expectedVersion: body.expectedVersion,
            currentVersion: Number(current?.version ?? body.expectedVersion),
          },
          requestId: request.id,
        },
      });
    }
    const { rows, updatedEvent } = transactionResult;

    return serializeFeePolicy(
      eventId,
      (updatedEvent ?? event) as EventFeePolicyRow,
      rows as FeeRuleRow[],
    );
  });

  app.get('/events/:eventId/marketing-integrations', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const rows = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('tenant_id', '=', event.tenant_id)
      .where('organization_id', '=', event.organization_id)
      .where('brand_id', '=', event.brand_id)
      .where('event_id', '=', eventId)
      .execute();
    return {
      items: rows
        .filter((row) => hasSafeMarketingIntegrationConfig(row.provider, row.config))
        .map((row) => serializeMarketingIntegration(row)),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.put('/events/:eventId/marketing-integrations/:provider', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, provider } = request.params as {
      eventId: string;
      provider: string;
    };
    const body = parseBody(marketingIntegrationSchema, {
      ...(request.body as Record<string, unknown>),
      provider,
    });
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.marketingIntegrationCheckpoint?.({
      stage: 'before_transaction',
      eventId,
      provider: body.provider,
    });

    const executeUpsert = () =>
      db.transaction().execute(async (transaction) => {
        const currentEvent = await transaction
          .selectFrom('events')
          .selectAll()
          .where('id', '=', eventId)
          .forUpdate()
          .executeTakeFirst();
        if (!currentEvent) throw new NotFoundError('Event', eventId);
        ClerkAuthService.requireResourceTenant(principal, currentEvent, 'Event', eventId);
        ClerkAuthService.requireOrganizationScope(principal, currentEvent.organization_id);
        ClerkAuthService.requireBrandScope(principal, currentEvent.brand_id);
        ClerkAuthService.requireEventScope(principal, eventId);

        const existing = await transaction
          .selectFrom('marketing_integrations')
          .selectAll()
          .where('tenant_id', '=', currentEvent.tenant_id)
          .where('organization_id', '=', currentEvent.organization_id)
          .where('brand_id', '=', currentEvent.brand_id)
          .where('event_id', '=', eventId)
          .where('provider', '=', body.provider)
          .forUpdate()
          .executeTakeFirst();
        const now = new Date();
        const saved = existing
          ? {
              ...existing,
              config: JSON.stringify(body.config),
              consent_required: body.consentRequired,
              status: body.status,
              updated_at: now,
            }
          : {
              id: `mkt_${ulid()}`,
              tenant_id: currentEvent.tenant_id,
              organization_id: currentEvent.organization_id,
              brand_id: currentEvent.brand_id,
              event_id: eventId,
              provider: body.provider,
              config: JSON.stringify(body.config),
              consent_required: body.consentRequired,
              status: body.status,
              created_at: now,
              updated_at: now,
            };
        if (existing) {
          await transaction
            .updateTable('marketing_integrations')
            .set({
              config: saved.config,
              consent_required: saved.consent_required,
              status: saved.status,
              updated_at: now,
            })
            .where('id', '=', existing.id)
            .where('tenant_id', '=', currentEvent.tenant_id)
            .where('organization_id', '=', currentEvent.organization_id)
            .where('brand_id', '=', currentEvent.brand_id)
            .where('event_id', '=', eventId)
            .where('provider', '=', body.provider)
            .execute();
        } else {
          await transaction.insertInto('marketing_integrations').values(saved).execute();
        }

        const persisted = await transaction
          .selectFrom('marketing_integrations')
          .selectAll()
          .where('id', '=', saved.id)
          .where('tenant_id', '=', currentEvent.tenant_id)
          .where('organization_id', '=', currentEvent.organization_id)
          .where('brand_id', '=', currentEvent.brand_id)
          .where('event_id', '=', eventId)
          .where('provider', '=', body.provider)
          .executeTakeFirst();
        if (!persisted) throw new NotFoundError('MarketingIntegration', saved.id);
        const updatedEvent = await new EventRepository(transaction).update(eventId, {});
        const serialized = serializeMarketingIntegration(persisted);
        await writeAuditLog(
          new AuditLogRepository(transaction),
          request,
          principal,
          {
            action: 'event.marketing_integration.upserted',
            organizationId: currentEvent.organization_id,
            brandId: currentEvent.brand_id,
            resourceType: 'MarketingIntegration',
            resourceId: persisted.id,
            diffSummary: {
              eventId,
              provider: body.provider,
              before: existing ? serializeMarketingIntegration(existing) : null,
              after: serialized,
              previousVersion: Number(currentEvent.version),
              newVersion: Number(updatedEvent.version),
            },
          },
          { failClosed: true },
        );
        return serialized;
      });

    try {
      return await executeUpsert();
    } catch (error) {
      if (!isMarketingIntegrationEventProviderDuplicateInsert(error)) throw error;
      return executeUpsert();
    }
  });

  app.post('/events/:eventId/duplicate', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(duplicateEventSchema, request.body);
    if (body.copy.checkoutQuestions && !body.copy.ticketTypes)
      throw new ValidationError(
        'ticketTypes must be copied with checkoutQuestions to preserve ticket scope',
      );
    if (body.copy.ticketTypes && !body.copy.basicsVenue)
      throw new ValidationError(
        'basicsVenue must be copied with ticketTypes to preserve occurrence scope',
      );
    const authorizedSource = await new EventRepository(db).findById(eventId);
    if (!authorizedSource) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, authorizedSource, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, authorizedSource.organization_id);
    ClerkAuthService.requireBrandScope(principal, authorizedSource.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.eventDuplicationCheckpoint?.({
      stage: 'after_authorization',
      sourceEventId: eventId,
    });
    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey =
      typeof rawIdempotencyKey === 'string' ? rawIdempotencyKey.trim() : undefined;
    if (!idempotencyKey) {
      throw new ValidationError('Idempotency-Key header is required for event duplication');
    }
    const requestedStart = new Date(body.startsAt);
    const duplicateEvent = async () => {
      const duplicated = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          const events = new EventRepository(trx as typeof db);
          const source = await trx
            .selectFrom('events')
            .selectAll()
            .where('id', '=', eventId)
            .forUpdate()
            .executeTakeFirst();
          if (!source) throw new NotFoundError('Event', eventId);
          ClerkAuthService.requireResourceTenant(principal, source, 'Event', eventId);
          ClerkAuthService.requireOrganizationScope(principal, source.organization_id);
          ClerkAuthService.requireBrandScope(principal, source.brand_id);
          ClerkAuthService.requireEventScope(principal, eventId);
          const shiftMs = requestedStart.getTime() - new Date(source.starts_at).getTime();
          const shifted = (value: Date | string | null) =>
            value === null ? null : new Date(new Date(value).getTime() + shiftMs);
          const created = await events.create({
            tenantId: source.tenant_id,
            organizationId: source.organization_id,
            brandId: source.brand_id,
            slug: `${source.slug}-copy-${ulid().slice(-8).toLowerCase()}`,
            title: body.title?.trim() || `${source.title} copy`,
            description: body.copy.basicsVenue ? (source.description ?? undefined) : undefined,
            currency: source.currency,
            timezone: source.timezone,
            startsAt: requestedStart,
            endsAt: shifted(source.ends_at) ?? undefined,
            venue:
              body.copy.basicsVenue && source.venue
                ? typeof source.venue === 'string'
                  ? JSON.parse(source.venue)
                  : source.venue
                : undefined,
            visibility: source.visibility,
            capacity: body.copy.basicsVenue ? (source.capacity ?? undefined) : undefined,
            minimumAge: body.copy.basicsVenue ? (source.minimum_age ?? undefined) : undefined,
          });
          if (body.copy.basicsVenue || body.copy.feeResalePolicies) {
            await events.update(created.id, {
              cover_image_alt: null,
              seo_use_cover_image: false,
              pass_fees_to_buyer: body.copy.feeResalePolicies ? source.pass_fees_to_buyer : false,
              resale_enabled: body.copy.feeResalePolicies ? source.resale_enabled : false,
              resale_max_multiplier: body.copy.feeResalePolicies ? source.resale_max_multiplier : 1,
              resale_max_absolute_cents: body.copy.feeResalePolicies
                ? source.resale_max_absolute_cents
                : null,
            });
          }
          const now = new Date();
          const occurrenceMap = new Map<string, string>();
          if (body.copy.basicsVenue) {
            const occurrences = await trx
              .selectFrom('event_occurrences')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            for (const occurrence of occurrences) {
              const id = `occ_${ulid()}`;
              occurrenceMap.set(occurrence.id, id);
              await trx
                .insertInto('event_occurrences')
                .values({
                  ...occurrence,
                  id,
                  event_id: created.id,
                  starts_at: shifted(occurrence.starts_at)!,
                  ends_at: shifted(occurrence.ends_at)!,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
            }
          }
          const ticketMap = new Map<string, string>();
          if (body.copy.ticketTypes) {
            const pools = await trx
              .selectFrom('inventory_pools')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            const poolMap = new Map<string, string>();
            for (const pool of pools) {
              const id = `inv_${ulid()}`;
              poolMap.set(pool.id, id);
              await trx
                .insertInto('inventory_pools')
                .values({
                  id,
                  event_id: created.id,
                  name: pool.name,
                  total_capacity: pool.total_capacity,
                  hold_ttl_seconds: pool.hold_ttl_seconds,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
            }
            const tickets = await trx
              .selectFrom('ticket_types')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            for (const ticket of tickets) {
              const id = `tt_${ulid()}`;
              ticketMap.set(ticket.id, id);
              await trx
                .insertInto('ticket_types')
                .values({
                  ...ticket,
                  id,
                  event_id: created.id,
                  status: ticket.status === 'draft' ? 'draft' : 'active',
                  requires_access_code: false,
                  access_code_hint: null,
                  inventory_pool_id: poolMap.get(ticket.inventory_pool_id)!,
                  event_occurrence_id: ticket.event_occurrence_id
                    ? (occurrenceMap.get(ticket.event_occurrence_id) ?? null)
                    : null,
                  sales_start_at: shifted(ticket.sales_start_at),
                  sales_end_at: shifted(ticket.sales_end_at),
                  created_at: now,
                  updated_at: now,
                })
                .execute();
            }
          }
          if (body.copy.products) {
            const categories = await trx
              .selectFrom('product_categories')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            const categoryMap = new Map<string, string>();
            for (const category of categories) {
              const id = `pcat_${ulid()}`;
              categoryMap.set(category.id, id);
              await trx
                .insertInto('product_categories')
                .values({
                  ...category,
                  id,
                  event_id: created.id,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
            }
            const products = await trx
              .selectFrom('products')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            for (const product of products)
              await trx
                .insertInto('products')
                .values({
                  ...product,
                  id: `prod_${ulid()}`,
                  event_id: created.id,
                  category_id: product.category_id
                    ? (categoryMap.get(product.category_id) ?? null)
                    : null,
                  available_from: shifted(product.available_from),
                  available_until: shifted(product.available_until),
                  created_at: now,
                  updated_at: now,
                })
                .execute();
          }
          if (body.copy.checkoutQuestions) {
            const questions = await trx
              .selectFrom('questions')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            for (const question of questions)
              await trx
                .insertInto('questions')
                .values({
                  ...question,
                  id: `q_${ulid()}`,
                  event_id: created.id,
                  ticket_type_id: question.ticket_type_id
                    ? (ticketMap.get(question.ticket_type_id) ?? null)
                    : null,
                  status: question.status,
                  is_hidden: question.is_hidden,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
          }
          if (body.copy.feeResalePolicies) {
            const rules = await trx
              .selectFrom('fee_rules')
              .selectAll()
              .where('event_id', '=', eventId)
              .execute();
            for (const rule of rules)
              await trx
                .insertInto('fee_rules')
                .values({
                  ...rule,
                  id: `fee_${ulid()}`,
                  event_id: created.id,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
          }
          if (body.copy.marketingIntegrations) {
            const integrations = await trx
              .selectFrom('marketing_integrations')
              .selectAll()
              .where('tenant_id', '=', source.tenant_id)
              .where('organization_id', '=', source.organization_id)
              .where('brand_id', '=', source.brand_id)
              .where('event_id', '=', eventId)
              .execute();
            for (const integration of integrations) {
              let config: unknown = {};
              try {
                config = duplicatedIntegrationConfig(
                  integration.provider,
                  typeof integration.config === 'string'
                    ? JSON.parse(integration.config)
                    : integration.config,
                );
              } catch {
                config = {};
              }
              await trx
                .insertInto('marketing_integrations')
                .values({
                  ...integration,
                  id: `mkt_${ulid()}`,
                  event_id: created.id,
                  config: JSON.stringify(config),
                  created_at: now,
                  updated_at: now,
                })
                .execute();
            }
          }
          if (body.copy.eventPageContent || body.copy.lifecycleContent) {
            const documents = await trx
              .selectFrom('content_documents')
              .selectAll()
              .where('tenant_id', '=', source.tenant_id)
              .where('organization_id', '=', source.organization_id)
              .where('brand_id', '=', source.brand_id)
              .where('event_id', '=', eventId)
              .execute();
            for (const document of documents.filter((item) =>
              item.channel === 'event_page'
                ? body.copy.eventPageContent
                : body.copy.lifecycleContent,
            )) {
              const documentId = `cdoc_${ulid()}`;
              await trx
                .insertInto('content_documents')
                .values({
                  ...document,
                  id: documentId,
                  event_id: created.id,
                  status: 'draft',
                  current_draft_version_id: null,
                  published_version_id: null,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
              const versions = await trx
                .selectFrom('content_document_versions')
                .selectAll()
                .where('document_id', '=', document.id)
                .orderBy('version_number')
                .execute();
              const sourceVersion =
                versions.find((version) => version.id === document.current_draft_version_id) ??
                versions.find((version) => version.id === document.published_version_id) ??
                versions.at(-1);
              let draftVersionId: string | null = null;
              if (sourceVersion) {
                const id = `cver_${ulid()}`;
                draftVersionId = id;
                await trx
                  .insertInto('content_document_versions')
                  .values({
                    ...sourceVersion,
                    id,
                    document_id: documentId,
                    version_number: 1,
                    status: 'draft',
                    created_by: principal.id,
                    created_at: now,
                    published_at: null,
                  })
                  .execute();
              }
              await trx
                .updateTable('content_documents')
                .set({
                  current_draft_version_id: draftVersionId,
                  published_version_id: null,
                })
                .where('id', '=', documentId)
                .execute();
            }
          }
          if (body.copy.mediaAssets) {
            const mediaAssets = await trx
              .selectFrom('event_media_assets')
              .selectAll()
              .where('tenant_id', '=', source.tenant_id)
              .where('organization_id', '=', source.organization_id)
              .where('brand_id', '=', source.brand_id)
              .where('event_id', '=', eventId)
              .execute();
            for (const mediaAsset of mediaAssets) {
              const sourceUpload = await trx
                .selectFrom('upload_artifacts')
                .selectAll()
                .where('id', '=', mediaAsset.upload_artifact_id)
                .where('tenant_id', '=', source.tenant_id)
                .where('organization_id', '=', source.organization_id)
                .where('brand_id', '=', source.brand_id)
                .where('event_id', '=', eventId)
                .executeTakeFirstOrThrow();
              const uploadArtifactId = `upl_${ulid()}`;
              await trx
                .insertInto('upload_artifacts')
                .values({
                  ...sourceUpload,
                  id: uploadArtifactId,
                  event_id: created.id,
                  client_token_hash: null,
                  consumed_by_checkout_session_id: null,
                  consumed_at: null,
                  completion_owner_token: null,
                  completion_started_at: null,
                  metadata:
                    typeof sourceUpload.metadata === 'string'
                      ? sourceUpload.metadata
                      : JSON.stringify(sourceUpload.metadata),
                  created_at: now,
                  updated_at: now,
                })
                .execute();
              const assetId = `ema_${ulid()}`;
              await trx
                .insertInto('event_media_assets')
                .values({
                  ...mediaAsset,
                  id: assetId,
                  event_id: created.id,
                  upload_artifact_id: uploadArtifactId,
                  created_by: principal.id,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
              const renditions = await trx
                .selectFrom('event_media_renditions')
                .selectAll()
                .where('asset_id', '=', mediaAsset.id)
                .execute();
              if (renditions.length > 0)
                await trx
                  .insertInto('event_media_renditions')
                  .values(
                    renditions.map((rendition) => ({
                      ...rendition,
                      id: `emr_${ulid()}`,
                      asset_id: assetId,
                      created_at: now,
                    })),
                  )
                  .execute();
            }
          }
          const result = (await events.findById(created.id))!;
          await writeAuditLog(
            new AuditLogRepository(trx as typeof db),
            request,
            principal,
            {
              action: 'event.duplicated',
              organizationId: source.organization_id,
              brandId: source.brand_id,
              resourceType: 'Event',
              resourceId: result.id,
              diffSummary: { sourceEventId: eventId, copied: body.copy },
            },
            { failClosed: true },
          );
          await app.context.eventDuplicationCheckpoint?.({
            stage: 'after_children_copied',
            sourceEventId: eventId,
            duplicatedEventId: created.id,
          });
          await trx
            .updateTable('idempotency_records')
            .set({
              response_status: 201,
              response_body: JSON.stringify(serializeEvent(result)),
              status: 'completed',
            })
            .where('key', '=', idempotencyKey)
            .where('tenant_id', '=', principal.tenantId)
            .execute();
          return result;
        });
      return { status: 201, body: serializeEvent(duplicated) };
    };
    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ sourceEventId: eventId, body }),
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND'],
      },
      duplicateEvent,
    );
    return reply.status(result.status).send(result.body);
  });

  app.post('/events/:eventId/publish', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: 'publish',
      outcome: 'attempted',
      reason_code: 'none',
    });
    if (existing.status === 'published') return serializeEvent(existing);
    if (existing.status === 'archived') {
      return reply.status(409).send({
        error: {
          code: 'event_archived',
          message: 'Archived events cannot be published',
          requestId: request.id,
        },
      });
    }
    let publishResult;
    try {
      publishResult = await db
        .transaction()
        .setIsolationLevel('serializable')
        .execute((trx) =>
          publishEvent(trx, createReadinessService(trx as typeof db), {
            tenantId: principal.tenantId,
            eventId,
            permissions: new Set(principal.scopes),
            authorizeEvent: (event) => {
              ClerkAuthService.requireResourceTenant(principal, event, 'Event', event.id);
              ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
              ClerkAuthService.requireBrandScope(principal, event.brand_id);
              ClerkAuthService.requireEventScope(principal, event.id);
            },
            onPublished: ({ event, published }) =>
              writeAuditLog(
                new AuditLogRepository(trx as typeof db),
                request,
                principal,
                {
                  action: 'event.published',
                  organizationId: event.organization_id,
                  brandId: event.brand_id,
                  resourceType: 'Event',
                  resourceId: event.id,
                  diffSummary: {
                    previousStatus: event.status,
                    newStatus: published.status,
                    previousVersion: Number(event.version),
                    newVersion: Number(published.version),
                  },
                },
                { failClosed: true },
              ),
          }),
        );
    } catch (error) {
      const databaseError = error as {
        code?: string;
        errno?: number;
        cause?: { code?: string; errno?: number };
      };
      const code = databaseError.code ?? databaseError.cause?.code;
      const errno = databaseError.errno ?? databaseError.cause?.errno;
      if (code !== '40001' && code !== 'ER_LOCK_DEADLOCK' && errno !== 1213) throw error;
      const current = await repo.findById(eventId);
      return reply.status(409).send({
        error: {
          code: 'stale_event_version',
          message: 'The event changed while publish readiness was being checked',
          details: {
            expectedVersion: Number(existing.version),
            currentVersion: Number(current?.version ?? existing.version),
          },
          requestId: request.id,
        },
      });
    }
    if (publishResult.kind === 'not_found') throw new NotFoundError('Event', eventId);
    if (publishResult.kind === 'already_published') return serializeEvent(publishResult.event);
    if (publishResult.kind === 'archived') {
      return reply.status(409).send({
        error: {
          code: 'event_archived',
          message: 'Archived events cannot be published',
          requestId: request.id,
        },
      });
    }
    const readiness = publishResult.readiness;
    if (!readiness.launchable) {
      for (const reasonCode of new Set(
        readiness.requiredBlockers.flatMap((step) => step.reasonCodes),
      )) {
        app.observability?.metrics.metrics.onboardingEvents?.inc({
          stage: 'publish_preflight',
          outcome: 'blocked',
          reason_code: reasonCode,
        });
      }
      request.log.warn(
        {
          eventId,
          blockerCodes: readiness.requiredBlockers.flatMap((step) => step.reasonCodes),
        },
        'Event publish blocked by launch readiness',
      );
      return reply.status(409).send({
        error: {
          code: 'launch_readiness_failed',
          message: 'Event launch readiness checks failed',
          details: {
            requiredBlockers: readiness.requiredBlockers,
            recommendedWarnings: readiness.recommendedWarnings,
          },
          requestId: request.id,
        },
      });
    }
    if (publishResult.kind === 'stale') {
      const current = await repo.findById(eventId);
      return reply.status(409).send({
        error: {
          code: 'stale_event_version',
          message: 'The event changed while publish readiness was being checked',
          details: {
            expectedVersion: readiness.eventVersion,
            currentVersion: Number(current?.version ?? readiness.eventVersion),
          },
          requestId: request.id,
        },
      });
    }
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: 'publish',
      outcome: 'completed',
      reason_code: 'none',
    });
    if (readiness.steps?.find((step) => step.id === 'preview_review')?.status === 'complete') {
      app.observability?.metrics.metrics.onboardingEvents?.inc({
        stage: 'preview_to_publish',
        outcome: 'converted',
        reason_code: 'none',
      });
    }
    app.observability?.metrics.metrics.onboardingMilestoneDuration?.observe(
      { milestone: 'publish' },
      Math.max(0, (Date.now() - new Date(existing.created_at).getTime()) / 1000),
    );
    return serializeEvent(publishResult.published!);
  });

  app.post('/events/:eventId/pause', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const result = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, locked, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, locked.organization_id);
      ClerkAuthService.requireBrandScope(principal, locked.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      if (locked.status === 'paused') return locked;
      if (locked.status !== 'published') {
        throw new ConflictError('Only published events can be paused', {
          currentStatus: locked.status,
          requestedStatus: 'paused',
        });
      }
      const updated = await new EventRepository(trx as typeof db).updateStatus(eventId, 'paused');
      await writeAuditLog(
        new AuditLogRepository(trx as typeof db),
        request,
        principal,
        {
          action: 'event.paused',
          organizationId: locked.organization_id,
          brandId: locked.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: { previousStatus: locked.status, newStatus: 'paused' },
        },
        { failClosed: true },
      );
      return updated;
    });
    return serializeEvent(result);
  });

  app.post('/events/:eventId/archive', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const result = await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, locked, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, locked.organization_id);
      ClerkAuthService.requireBrandScope(principal, locked.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      if (locked.status === 'archived') return locked;
      const updated = await new EventRepository(trx as typeof db).updateStatus(eventId, 'archived');
      await writeAuditLog(
        new AuditLogRepository(trx as typeof db),
        request,
        principal,
        {
          action: 'event.archived',
          organizationId: locked.organization_id,
          brandId: locked.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: { previousStatus: locked.status, newStatus: 'archived' },
        },
        { failClosed: true },
      );
      return updated;
    });
    return serializeEvent(result);
  });

  // C-079: configurable scanning-code format + scanner contract version.
  app.get('/events/:eventId/code-format', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const config = eventCodeFormat(existing.code_format);
    return {
      eventId,
      codeFormat: config,
      scannerContractVersion: SCANNER_CONTRACT_VERSION,
    };
  });

  app.put('/events/:eventId/code-format', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(updateEventCodeFormatSchema, request.body ?? {});
    const symbology = body.symbology ?? DEFAULT_CODE_FORMAT.symbology;
    const payloadFormat = body.payloadFormat ?? DEFAULT_CODE_FORMAT.payloadFormat;
    const config: CodeFormat = {
      symbology,
      payloadFormat,
    };
    if (body.rotating) {
      config.rotating = {
        timeStepSeconds: body.rotating.timeStepSeconds,
        toleranceWindows: body.rotating.toleranceWindows,
        digits: body.rotating.digits,
      };
    }
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.eventCodeFormatCheckpoint?.({ stage: 'before_transaction', eventId });
    await db.transaction().execute(async (trx) => {
      const locked = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, locked, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, locked.organization_id);
      ClerkAuthService.requireBrandScope(principal, locked.brand_id);
      ClerkAuthService.requireEventScope(principal, eventId);
      const updated = await new EventRepository(trx as typeof db).update(eventId, {
        code_format: JSON.stringify(config),
      } as Record<string, unknown>);
      await writeAuditLog(
        new AuditLogRepository(trx as typeof db),
        request,
        principal,
        {
          action: 'event.code_format_updated',
          organizationId: locked.organization_id,
          brandId: locked.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: {
            before: eventCodeFormat(locked.code_format),
            after: eventCodeFormat(updated.code_format),
            previousVersion: Number(locked.version),
            newVersion: Number(updated.version),
          },
        },
        { failClosed: true },
      );
    });
    return {
      eventId,
      codeFormat: config,
      scannerContractVersion: SCANNER_CONTRACT_VERSION,
    };
  });
};
