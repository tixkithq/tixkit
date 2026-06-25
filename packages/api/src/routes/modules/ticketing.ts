import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import { EventRepository, TicketTypeRepository, InventoryPoolRepository } from '@gatekit/db';
import { NotFoundError } from '@gatekit/domain';
import {
  pageEnvelope,
  parsePagination,
  pickAllowedFields,
  serializeInventoryPool,
  serializeTicketType,
} from '../../http/contracts.js';
import {
  createTicketTypeSchema,
  updateTicketTypeSchema,
  createInventoryPoolSchema,
  parseBody,
} from '../../http/schemas.js';

export const ticketingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const inventoryService = app.context.inventoryService;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  app.post('/events/:eventId/ticket-types', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createTicketTypeSchema, request.body);

    const event = await loadEvent(eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const repo = new TicketTypeRepository(db);
    const pool = await new InventoryPoolRepository(db).findById(body.inventoryPoolId);
    if (!pool || pool.event_id !== eventId) {
      throw new NotFoundError('InventoryPool', body.inventoryPoolId);
    }
    const ticketType = await repo.create({
      eventId,
      name: body.name,
      kind: body.kind,
      currency: body.currency,
      priceCents: body.priceCents,
      inventoryPoolId: body.inventoryPoolId,
      visibility: body.visibility,
      description: body.description,
      minimumPriceCents: body.minimumPriceCents,
      salesStartAt: body.salesStartAt ? new Date(body.salesStartAt) : undefined,
      salesEndAt: body.salesEndAt ? new Date(body.salesEndAt) : undefined,
      minPerOrder: body.minPerOrder,
      maxPerOrder: body.maxPerOrder,
      requiresAccessCode: body.requiresAccessCode,
      accessCodeHint: body.accessCodeHint,
    });

    return reply.status(201).send(serializeTicketType(ticketType));
  });

  app.patch('/ticket-types/:ticketTypeId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { ticketTypeId } = request.params as { ticketTypeId: string };
    const body = parseBody(updateTicketTypeSchema, request.body);
    const repo = new TicketTypeRepository(db);
    const existing = await repo.findById(ticketTypeId);
    if (!existing) throw new NotFoundError('TicketType', ticketTypeId);
    const event = await loadEvent(existing.event_id);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', existing.event_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, existing.event_id);
    const updateData = pickAllowedFields(
      body,
      [
        'name',
        'description',
        'kind',
        'status',
        'visibility',
        'currency',
        'priceCents',
        'minimumPriceCents',
        'salesStartAt',
        'salesEndAt',
        'minPerOrder',
        'maxPerOrder',
        'inventoryPoolId',
        'requiresAccessCode',
        'accessCodeHint',
        'sortOrder',
      ],
      {
        priceCents: 'price_cents',
        minimumPriceCents: 'minimum_price_cents',
        salesStartAt: 'sales_start_at',
        salesEndAt: 'sales_end_at',
        minPerOrder: 'min_per_order',
        maxPerOrder: 'max_per_order',
        inventoryPoolId: 'inventory_pool_id',
        requiresAccessCode: 'requires_access_code',
        accessCodeHint: 'access_code_hint',
        sortOrder: 'sort_order',
      },
    );
    if (updateData.sales_start_at) updateData.sales_start_at = new Date(updateData.sales_start_at as string);
    if (updateData.sales_end_at) updateData.sales_end_at = new Date(updateData.sales_end_at as string);
    if (updateData.inventory_pool_id) {
      const pool = await new InventoryPoolRepository(db).findById(updateData.inventory_pool_id as string);
      if (!pool || pool.event_id !== existing.event_id) {
        throw new NotFoundError('InventoryPool', updateData.inventory_pool_id as string);
      }
    }
    return serializeTicketType(await repo.update(ticketTypeId, updateData));
  });

  app.get('/events/:eventId/ticket-types', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    const repo = new TicketTypeRepository(db);
    const rows = await repo.findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(rows.map((row) => serializeTicketType(row)), pagination.limit);
  });

  app.post('/events/:eventId/inventory-pools', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createInventoryPoolSchema, request.body);

    const event = await loadEvent(eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const repo = new InventoryPoolRepository(db);
    const pool = await repo.create({
      eventId,
      name: body.name,
      totalCapacity: body.totalCapacity,
      holdTtlSeconds: body.holdTtlSeconds,
    });

    return reply.status(201).send(serializeInventoryPool(pool));
  });

  app.get('/events/:eventId/availability', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await loadEvent(eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const ttRepo = new TicketTypeRepository(db);
    const ticketTypes = await ttRepo.findByEvent(eventId);

    const results = [];
    for (const tt of ticketTypes) {
      const availability = await inventoryService.getAvailability(tt.inventory_pool_id);
      results.push({
        ticketTypeId: tt.id,
        available: availability.available,
        total: availability.total,
        reserved: availability.reserved,
        sold: availability.sold,
        status: tt.status,
      });
    }

    return { items: results, nextCursor: null, hasMore: false };
  });
};
