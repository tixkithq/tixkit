import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  BrandRepository,
  EventRepository,
  EventOccurrenceRepository,
  AuditLogRepository,
} from '@tixkit/db';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  pageEnvelope,
  parsePagination,
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
    const pagination = parsePagination(request.query);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }
    let query = db
      .selectFrom('events')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);

    const { organizationId } = request.query as { organizationId?: string };
    if (organizationId) {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
      query = query.where('organization_id', '=', organizationId);
    }
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.brandIds && principal.brandIds.length > 0) {
      query = query.where('brand_id', 'in', principal.brandIds);
    }
    if (principal.eventIds && principal.eventIds.length > 0) {
      query = query.where('id', 'in', principal.eventIds);
    }
    if (principal.type !== 'system') {
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeEvent(row)),
      pagination.limit,
    );
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
    return serializeEvent(event);
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
    if (body.status !== undefined) updateData.status = body.status;

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
};
