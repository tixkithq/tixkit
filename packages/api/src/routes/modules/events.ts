import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  BrandRepository,
  EventRepository,
  EventOccurrenceRepository,
  AuditLogRepository,
  executeTableQuery,
} from '@tixkit/db';
import {
  col,
  defineTable,
  paramsToQuery,
  type AdminTablePage,
} from '@tixkit/admin-table-core';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import { SCANNER_CONTRACT_VERSION, DEFAULT_CODE_FORMAT } from '@tixkit/domain';
import type { CodeFormat } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  serializeEvent,
  serializeEventOccurrence,
  serializeMarketingIntegration,
} from '../../http/contracts.js';
import {
  createEventOccurrenceSchema,
  createEventSchema,
  parseBody,
  updateEventOccurrenceSchema,
  updateEventSchema,
} from '../../http/schemas.js';

const marketingIntegrationSchema = z
  .object({
    provider: z.enum(['ga4', 'meta_pixel', 'generic_tag']),
    config: z.record(z.string(), z.unknown()),
    consentRequired: z.boolean().default(true),
    status: z.enum(['active', 'disabled']).default('active'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'ga4' && typeof value.config.measurementId !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'measurementId'],
        message: 'measurementId is required for GA4 integrations',
      });
    }
    if (value.provider === 'meta_pixel' && typeof value.config.pixelId !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'pixelId'],
        message: 'pixelId is required for Meta Pixel integrations',
      });
    }
    if (value.provider === 'generic_tag') {
      const pixelUrl = value.config.pixelUrl;
      if (typeof pixelUrl !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'pixelUrl'],
          message: 'pixelUrl is required for generic tag integrations',
        });
        return;
      }
      try {
        const parsed = new URL(pixelUrl);
        if (parsed.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['config', 'pixelUrl'],
            message: 'pixelUrl must use https',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['config', 'pixelUrl'],
          message: 'pixelUrl must be a valid URL',
        });
      }
    }
  });

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
      .select(({ fn }) => [
        'event_id',
        fn.sum<number>('total_cents').as('gross_sales_cents'),
      ])
      .where('tenant_id', '=', tenantId)
      .where('event_id', 'in', eventIds)
      .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
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

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const audit = () => new AuditLogRepository(db);

  app.post('/events', async (request, reply) => {
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

    const repo = new EventRepository(db);
    if (!(await repo.isSlugAvailable(body.brandId, body.slug))) {
      throw new ValidationError('Event slug is already in use');
    }
    const event = await repo.create({
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
      venue: body.venue as Record<string, unknown> | undefined,
      visibility: body.visibility,
      seo: body.seo as Record<string, unknown> | undefined,
      capacity: body.capacity,
      coverImageUrl: body.coverImageUrl,
      externalUrl: body.externalUrl,
    });

    await writeAuditLog(audit(), request, principal, {
      action: 'event.created',
      organizationId: body.organizationId,
      brandId: body.brandId,
      resourceType: 'Event',
      resourceId: event.id,
      diffSummary: { slug: body.slug, title: body.title },
    });

    return reply.status(201).send(serializeEvent(event));
  });

  app.get('/events', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');

    const rawQuery = request.query as Record<string, string | undefined>;
    const { organizationId, brandId } = rawQuery;

    if (organizationId) ClerkAuthService.requireOrganizationScope(principal, organizationId);
    if (brandId) ClerkAuthService.requireBrandScope(principal, brandId);

    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return { items: [], nextCursor: undefined, total: 0, filterTotal: 0 } as AdminTablePage<unknown>;
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
    const { query: tableQuery } = paramsToQuery(eventsTableSchema, searchParams);

    const result = await executeTableQuery(db, {
      tableName: 'events',
      schema: eventsTableSchema,
      tenantId: principal.tenantId,
      scope,
      serialize: serializeEvent,
    }, tableQuery);

    // Enrich with event stats
    const eventIds = result.items.map((e) => (e as Record<string, unknown>).id as string);
    if (eventIds.length > 0) {
      const stats = await computeEventStats(db, principal.tenantId, eventIds);
      const enrichedItems = result.items.map((item) => {
        const event = item as Record<string, unknown>;
        const stat = stats.get(event.id as string);
        if (!stat) return event;
        return {
          ...event,
          grossSalesCents: stat.gross_sales_cents,
          ticketsSold: stat.tickets_sold,
          checkIns: stat.check_ins,
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
    const stats = await computeEventStats(db, principal.tenantId, [eventId]);
    return serializeEvent({ ...event, ...stats.get(eventId) });
  });

  app.get('/events/:eventId/occurrences', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
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

    const occurrence = await new EventOccurrenceRepository(db).create({
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
    await writeAuditLog(audit(), request, principal, {
      action: 'event_occurrence.created',
      organizationId: event.organization_id,
      brandId: event.brand_id,
      resourceType: 'EventOccurrence',
      resourceId: occurrence.id,
      diffSummary: { eventId, title: body.title },
    });
    return reply.status(201).send(serializeEventOccurrence(occurrence));
  });

  app.patch('/events/:eventId/occurrences/:occurrenceId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, occurrenceId } = request.params as { eventId: string; occurrenceId: string };
    const body = parseBody(updateEventOccurrenceSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const repo = new EventOccurrenceRepository(db);
    const existing = await repo.findById(occurrenceId);
    if (!existing || existing.event_id !== eventId)
      throw new NotFoundError('EventOccurrence', occurrenceId);

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
    if (body.venue !== undefined) updateData.venue = body.venue ? JSON.stringify(body.venue) : null;
    if (body.capacity !== undefined) updateData.capacity = body.capacity;
    if (body.sortOrder !== undefined) updateData.sort_order = body.sortOrder;
    if (body.status !== undefined) updateData.status = body.status;

    return serializeEventOccurrence(await repo.update(occurrenceId, updateData));
  });

  app.patch('/events/:eventId', async (request) => {
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

    if (body.status !== undefined) {
      throw new ValidationError(
        'Use the dedicated publish, pause, or archive endpoint to change event status',
      );
    }

    const updateData: Record<string, unknown> = {};
    if (body.title !== undefined) updateData.title = body.title;
    if (body.slug !== undefined) {
      if (!(await repo.isSlugAvailable(existing.brand_id, body.slug, eventId))) {
        throw new ValidationError('Event slug is already in use');
      }
      updateData.slug = body.slug;
    }
    if (body.description !== undefined) updateData.description = body.description;
    if (body.currency !== undefined) updateData.currency = body.currency;
    if (body.timezone !== undefined) updateData.timezone = body.timezone;
    if (body.startsAt !== undefined) updateData.starts_at = new Date(body.startsAt);
    if (body.endsAt !== undefined) updateData.ends_at = body.endsAt ? new Date(body.endsAt) : null;
    if (body.venue !== undefined) updateData.venue = body.venue ? JSON.stringify(body.venue) : null;
    if (body.visibility !== undefined) updateData.visibility = body.visibility;
    if (body.seo !== undefined) updateData.seo = JSON.stringify(body.seo);
    if (body.capacity !== undefined) updateData.capacity = body.capacity;
    if (body.coverImageUrl !== undefined) updateData.cover_image_url = body.coverImageUrl;
    if (body.externalUrl !== undefined) updateData.external_url = body.externalUrl;

    return serializeEvent(await repo.update(eventId, updateData));
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
      items: rows.map((row) => serializeMarketingIntegration(row)),
      nextCursor: null,
      hasMore: false,
    };
  });

  app.put('/events/:eventId/marketing-integrations/:provider', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId, provider } = request.params as { eventId: string; provider: string };
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

    const existing = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('tenant_id', '=', event.tenant_id)
      .where('organization_id', '=', event.organization_id)
      .where('brand_id', '=', event.brand_id)
      .where('event_id', '=', eventId)
      .where('provider', '=', body.provider)
      .executeTakeFirst();
    const now = new Date();
    if (existing) {
      const updated = {
        ...existing,
        config: JSON.stringify(body.config),
        consent_required: body.consentRequired,
        status: body.status,
        updated_at: now,
      };
      await db
        .updateTable('marketing_integrations')
        .set({
          config: updated.config,
          consent_required: updated.consent_required,
          status: updated.status,
          updated_at: now,
        })
        .where('id', '=', existing.id)
        .where('tenant_id', '=', event.tenant_id)
        .where('organization_id', '=', event.organization_id)
        .where('brand_id', '=', event.brand_id)
        .where('event_id', '=', eventId)
        .where('provider', '=', body.provider)
        .execute();
      return serializeMarketingIntegration(updated);
    }
    const values = {
      id: `mkt_${ulid()}`,
      tenant_id: event.tenant_id,
      organization_id: event.organization_id,
      brand_id: event.brand_id,
      event_id: eventId,
      provider: body.provider,
      config: JSON.stringify(body.config),
      consent_required: body.consentRequired,
      status: body.status,
      created_at: now,
      updated_at: now,
    };
    try {
      await db.insertInto('marketing_integrations').values(values).execute();
      return serializeMarketingIntegration(values);
    } catch (error) {
      if (!isMarketingIntegrationEventProviderDuplicateInsert(error)) throw error;
      const concurrent = await db
        .selectFrom('marketing_integrations')
        .selectAll()
        .where('tenant_id', '=', event.tenant_id)
        .where('organization_id', '=', event.organization_id)
        .where('brand_id', '=', event.brand_id)
        .where('event_id', '=', eventId)
        .where('provider', '=', body.provider)
        .executeTakeFirst();
      if (!concurrent) throw error;
      const recoveredAt = new Date();
      const recovered = {
        ...concurrent,
        config: JSON.stringify(body.config),
        consent_required: body.consentRequired,
        status: body.status,
        updated_at: recoveredAt,
      };
      await db
        .updateTable('marketing_integrations')
        .set({
          config: recovered.config,
          consent_required: recovered.consent_required,
          status: recovered.status,
          updated_at: recoveredAt,
        })
        .where('id', '=', concurrent.id)
        .where('tenant_id', '=', event.tenant_id)
        .where('organization_id', '=', event.organization_id)
        .where('brand_id', '=', event.brand_id)
        .where('event_id', '=', eventId)
        .where('provider', '=', body.provider)
        .execute();
      return serializeMarketingIntegration(recovered);
    }
  });

  app.post('/events/:eventId/publish', async (request) => {
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
    const result = await repo.updateStatus(eventId, 'published');
    await writeAuditLog(audit(), request, principal, {
      action: 'event.published',
      organizationId: existing.organization_id,
      brandId: existing.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
    });
    return serializeEvent(result);
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
    const result = await repo.updateStatus(eventId, 'paused');
    await writeAuditLog(audit(), request, principal, {
      action: 'event.paused',
      organizationId: existing.organization_id,
      brandId: existing.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
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
    const result = await repo.updateStatus(eventId, 'archived');
    await writeAuditLog(audit(), request, principal, {
      action: 'event.archived',
      organizationId: existing.organization_id,
      brandId: existing.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
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
    const config = existing.code_format
      ? (JSON.parse(existing.code_format) as CodeFormat)
      : DEFAULT_CODE_FORMAT;
    return { eventId, codeFormat: config, scannerContractVersion: SCANNER_CONTRACT_VERSION };
  });

  app.put('/events/:eventId/code-format', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = request.body as { symbology?: string; payloadFormat?: string; rotating?: unknown };
    const symbology = body.symbology ?? DEFAULT_CODE_FORMAT.symbology;
    const payloadFormat = body.payloadFormat ?? DEFAULT_CODE_FORMAT.payloadFormat;
    const validSymbologies = ['qr', 'code128', 'pdf417', 'aztec', 'data_matrix'];
    const validFormats = ['signed_v1', 'compact_v2'];
    if (!validSymbologies.includes(symbology)) {
      throw new ValidationError('Invalid symbology', { field: 'symbology' });
    }
    if (!validFormats.includes(payloadFormat)) {
      throw new ValidationError('Invalid payloadFormat', { field: 'payloadFormat' });
    }
    const config: CodeFormat = {
      symbology: symbology as CodeFormat['symbology'],
      payloadFormat: payloadFormat as CodeFormat['payloadFormat'],
    };
    if (body.rotating && typeof body.rotating === 'object') {
      const r = body.rotating as {
        timeStepSeconds?: number;
        toleranceWindows?: number;
        digits?: number;
      };
      if (typeof r.timeStepSeconds !== 'number' || r.timeStepSeconds < 5) {
        throw new ValidationError('rotating.timeStepSeconds must be >= 5', { field: 'rotating' });
      }
      if (typeof r.toleranceWindows !== 'number' || r.toleranceWindows < 0) {
        throw new ValidationError('rotating.toleranceWindows must be >= 0', { field: 'rotating' });
      }
      config.rotating = {
        timeStepSeconds: r.timeStepSeconds,
        toleranceWindows: r.toleranceWindows,
        digits: r.digits,
      };
    }
    const repo = new EventRepository(db);
    const existing = await repo.findById(eventId);
    if (!existing) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, existing, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, existing.organization_id);
    ClerkAuthService.requireBrandScope(principal, existing.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await repo.update(eventId, { code_format: JSON.stringify(config) } as Record<string, unknown>);
    await writeAuditLog(audit(), request, principal, {
      action: 'event.code_format_updated',
      organizationId: existing.organization_id,
      brandId: existing.brand_id,
      resourceType: 'Event',
      resourceId: eventId,
    });
    return { eventId, codeFormat: config, scannerContractVersion: SCANNER_CONTRACT_VERSION };
  });
};
