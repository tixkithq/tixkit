import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import { BrandRepository, EventRepository, AuditLogRepository } from '@gatekit/db';
import { NotFoundError } from '@gatekit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import { pageEnvelope, parsePagination, serializeEvent } from '../../http/contracts.js';
import { createEventSchema, updateEventSchema, parseBody } from '../../http/schemas.js';

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
	    return pageEnvelope(rows.map((row) => serializeEvent(row)), pagination.limit);
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
      resourceType: 'Event',
      resourceId: eventId,
    });
    return serializeEvent(result);
  });
};
