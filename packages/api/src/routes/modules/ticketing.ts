import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AccessRuleRepository,
  EventRepository,
  TicketTypeRepository,
  InventoryPoolRepository,
  ProductCategoryRepository,
  ProductRepository,
} from '@gatekit/db';
import { NotFoundError, ValidationError } from '@gatekit/domain';
import {
  pageEnvelope,
  parsePagination,
  pickAllowedFields,
  serializeInventoryPool,
  serializeAccessRule,
  serializeProduct,
  serializeProductCategory,
  serializeTicketType,
} from '../../http/contracts.js';
import {
  createAccessRuleSchema,
  createTicketTypeBatchSchema,
  createProductCategorySchema,
  createProductSchema,
  createTicketTypeSchema,
  updateTicketTypeBatchSchema,
  updateTicketTypeSchema,
  createInventoryPoolSchema,
  updateProductSchema,
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

  const requireEventAccess = (principal: NonNullable<FastifyRequest['principal']>, event: Record<string, unknown>, eventId: string) => {
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
    ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
    ClerkAuthService.requireEventScope(principal, eventId);
  };

  const normalizeAccessRules = (rules: Array<{
    type: 'code' | 'email_domain';
    value: string;
    maxUses?: number | null;
    expiresAt?: string | null;
  }> = []) => {
    const normalized = rules.map((rule) => ({
      ...rule,
      value: rule.value.trim(),
    }));
    const keys = new Set<string>();
    for (const rule of normalized) {
      const key = `${rule.type}:${rule.value.toLowerCase()}`;
      if (keys.has(key)) {
        throw new ValidationError(`Duplicate access rule value: ${rule.value}`);
      }
      keys.add(key);
    }
    return normalized;
  };

  const assertNoExistingAccessRuleDuplicates = async (
    ticketTypeId: string,
    rules: ReturnType<typeof normalizeAccessRules>,
    accessRuleRepo: AccessRuleRepository,
  ) => {
    if (rules.length === 0) return;
    const existing = await accessRuleRepo.findByTicketType(ticketTypeId);
    const existingKeys = new Set(
      existing.map((rule) => `${rule.type}:${String(rule.value).trim().toLowerCase()}`),
    );
    const duplicate = rules.find((rule) =>
      existingKeys.has(`${rule.type}:${rule.value.toLowerCase()}`),
    );
    if (duplicate) {
      throw new ValidationError(`Access rule already exists: ${duplicate.value}`);
    }
  };

  app.post('/events/:eventId/ticket-types', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createTicketTypeSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

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

  app.post('/events/:eventId/ticket-types/batch', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createTicketTypeBatchSchema, request.body);
    const accessRules = normalizeAccessRules(body.accessRules);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    if (body.ticketType.inventoryPoolId) {
      const pool = await new InventoryPoolRepository(db).findById(body.ticketType.inventoryPoolId);
      if (!pool || pool.event_id !== eventId) {
        throw new NotFoundError('InventoryPool', body.ticketType.inventoryPoolId);
      }
    }

    const result = await db.transaction().execute(async (trx) => {
      const txDb = trx as typeof db;
      let inventoryPoolId = body.ticketType.inventoryPoolId;

      if (!inventoryPoolId && body.inventoryPool) {
        const pool = await new InventoryPoolRepository(txDb).create({
          eventId,
          name: body.inventoryPool.name,
          totalCapacity: body.inventoryPool.totalCapacity,
          holdTtlSeconds: body.inventoryPool.holdTtlSeconds,
        });
        inventoryPoolId = pool.id;
      }

      if (!inventoryPoolId) {
        throw new ValidationError('Provide inventoryPoolId or inventoryPool');
      }

      const ticketType = await new TicketTypeRepository(txDb).create({
        eventId,
        name: body.ticketType.name,
        kind: body.ticketType.kind,
        currency: body.ticketType.currency,
        priceCents: body.ticketType.priceCents,
        inventoryPoolId,
        visibility: body.ticketType.visibility,
        description: body.ticketType.description,
        minimumPriceCents: body.ticketType.minimumPriceCents ?? undefined,
        salesStartAt: body.ticketType.salesStartAt ? new Date(body.ticketType.salesStartAt) : undefined,
        salesEndAt: body.ticketType.salesEndAt ? new Date(body.ticketType.salesEndAt) : undefined,
        minPerOrder: body.ticketType.minPerOrder,
        maxPerOrder: body.ticketType.maxPerOrder,
        requiresAccessCode: body.ticketType.requiresAccessCode,
        accessCodeHint: body.ticketType.accessCodeHint,
      });

      const accessRuleRepo = new AccessRuleRepository(txDb);
      const createdRules = [];
      for (const rule of accessRules) {
        createdRules.push(await accessRuleRepo.create({
          ticketTypeId: ticketType.id,
          type: rule.type,
          value: rule.value,
          maxUses: rule.maxUses ?? undefined,
          expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : undefined,
        }));
      }

      return { ticketType, accessRules: createdRules };
    });

    return reply.status(201).send({
      ticketType: serializeTicketType(result.ticketType),
      accessRules: result.accessRules.map((rule) => serializeAccessRule(rule)),
    });
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
    requireEventAccess(principal, event, existing.event_id);
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

  app.patch('/ticket-types/:ticketTypeId/batch', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { ticketTypeId } = request.params as { ticketTypeId: string };
    const body = parseBody(updateTicketTypeBatchSchema, request.body);
    const accessRules = normalizeAccessRules(body.accessRules);
    const repo = new TicketTypeRepository(db);
    const existing = await repo.findById(ticketTypeId);
    if (!existing) throw new NotFoundError('TicketType', ticketTypeId);
    const event = await loadEvent(existing.event_id);
    requireEventAccess(principal, event, existing.event_id);

    if (body.ticketType.inventoryPoolId) {
      const pool = await new InventoryPoolRepository(db).findById(body.ticketType.inventoryPoolId);
      if (!pool || pool.event_id !== existing.event_id) {
        throw new NotFoundError('InventoryPool', body.ticketType.inventoryPoolId);
      }
    }

    const result = await db.transaction().execute(async (trx) => {
      const txDb = trx as typeof db;
      const accessRuleRepo = new AccessRuleRepository(txDb);
      await assertNoExistingAccessRuleDuplicates(ticketTypeId, accessRules, accessRuleRepo);

      const updateData = pickAllowedFields(
        body.ticketType,
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

      const ticketType = Object.keys(updateData).length > 0
        ? await new TicketTypeRepository(txDb).update(ticketTypeId, updateData)
        : existing;
      for (const rule of accessRules) {
        await accessRuleRepo.create({
          ticketTypeId,
          type: rule.type,
          value: rule.value,
          maxUses: rule.maxUses ?? undefined,
          expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : undefined,
        });
      }
      const allRules = await accessRuleRepo.findByTicketType(ticketTypeId);
      return { ticketType, accessRules: allRules };
    });

    return {
      ticketType: serializeTicketType(result.ticketType),
      accessRules: result.accessRules.map((rule) => serializeAccessRule(rule)),
    };
  });

  app.get('/events/:eventId/ticket-types', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const repo = new TicketTypeRepository(db);
    const rows = await repo.findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(rows.map((row) => serializeTicketType(row)), pagination.limit);
  });

  app.get('/ticket-types/:ticketTypeId/access-rules', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { ticketTypeId } = request.params as { ticketTypeId: string };
    const repo = new TicketTypeRepository(db);
    const ticketType = await repo.findById(ticketTypeId);
    if (!ticketType) throw new NotFoundError('TicketType', ticketTypeId);
    const event = await loadEvent(ticketType.event_id);
    requireEventAccess(principal, event, ticketType.event_id);

    const rows = await new AccessRuleRepository(db).findByTicketType(ticketTypeId);
    return { items: rows.map((row) => serializeAccessRule(row)), nextCursor: null, hasMore: false };
  });

  app.post('/ticket-types/:ticketTypeId/access-rules', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { ticketTypeId } = request.params as { ticketTypeId: string };
    const body = parseBody(createAccessRuleSchema, request.body);
    const repo = new TicketTypeRepository(db);
    const ticketType = await repo.findById(ticketTypeId);
    if (!ticketType) throw new NotFoundError('TicketType', ticketTypeId);
    const event = await loadEvent(ticketType.event_id);
    requireEventAccess(principal, event, ticketType.event_id);

    const accessRule = await new AccessRuleRepository(db).create({
      ticketTypeId,
      type: body.type,
      value: body.value.trim(),
      maxUses: body.maxUses ?? undefined,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
    return reply.status(201).send(serializeAccessRule(accessRule));
  });

  app.delete('/access-rules/:accessRuleId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { accessRuleId } = request.params as { accessRuleId: string };
    const rule = await db
      .selectFrom('access_rules')
      .innerJoin('ticket_types', 'ticket_types.id', 'access_rules.ticket_type_id')
      .select([
        'access_rules.id as id',
        'ticket_types.event_id as event_id',
      ])
      .where('access_rules.id', '=', accessRuleId)
      .executeTakeFirst();
    if (!rule) throw new NotFoundError('AccessRule', accessRuleId);
    const event = await loadEvent(rule.event_id);
    requireEventAccess(principal, event, rule.event_id);

    await new AccessRuleRepository(db).delete(accessRuleId);
    return reply.status(204).send();
  });

  app.post('/events/:eventId/inventory-pools', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createInventoryPoolSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const repo = new InventoryPoolRepository(db);
    const pool = await repo.create({
      eventId,
      name: body.name,
      totalCapacity: body.totalCapacity,
      holdTtlSeconds: body.holdTtlSeconds,
    });

    return reply.status(201).send(serializeInventoryPool(pool));
  });

  app.get('/events/:eventId/inventory-pools', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const repo = new InventoryPoolRepository(db);
    const rows = await repo.findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(rows.map((row) => serializeInventoryPool(row)), pagination.limit);
  });

  app.get('/events/:eventId/product-categories', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const rows = await new ProductCategoryRepository(db).findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(rows.map((row) => serializeProductCategory(row)), pagination.limit);
  });

  app.post('/events/:eventId/product-categories', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createProductCategorySchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const category = await new ProductCategoryRepository(db).create({
      eventId,
      name: body.name,
      sortOrder: body.sortOrder,
    });

    return reply.status(201).send(serializeProductCategory(category));
  });

  app.get('/events/:eventId/products', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const rows = await new ProductRepository(db).findByEvent(eventId, pagination.limit + 1, pagination.cursor);
    return pageEnvelope(rows.map((row) => serializeProduct(row)), pagination.limit);
  });

  app.post('/events/:eventId/products', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createProductSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    if (body.categoryId) {
      const category = await new ProductCategoryRepository(db).findById(body.categoryId);
      if (!category || category.event_id !== eventId) {
        throw new NotFoundError('ProductCategory', body.categoryId);
      }
    }

    const product = await new ProductRepository(db).create({
      eventId,
      name: body.name,
      description: body.description,
      priceCents: body.priceCents,
      currency: body.currency,
      categoryId: body.categoryId,
      maxPerOrder: body.maxPerOrder,
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : undefined,
      availableUntil: body.availableUntil ? new Date(body.availableUntil) : undefined,
      status: body.status,
      sortOrder: body.sortOrder,
    });

    return reply.status(201).send(serializeProduct(product));
  });

  app.patch('/products/:productId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { productId } = request.params as { productId: string };
    const body = parseBody(updateProductSchema, request.body);
    const repo = new ProductRepository(db);
    const existing = await repo.findById(productId);
    if (!existing) throw new NotFoundError('Product', productId);

    const event = await loadEvent(existing.event_id);
    requireEventAccess(principal, event, existing.event_id);

    if (body.categoryId) {
      const category = await new ProductCategoryRepository(db).findById(body.categoryId);
      if (!category || category.event_id !== existing.event_id) {
        throw new NotFoundError('ProductCategory', body.categoryId);
      }
    }

    const updateData = pickAllowedFields(
      body,
      [
        'name',
        'description',
        'priceCents',
        'currency',
        'categoryId',
        'maxPerOrder',
        'availableFrom',
        'availableUntil',
        'status',
        'sortOrder',
      ],
      {
        priceCents: 'price_cents',
        categoryId: 'category_id',
        maxPerOrder: 'max_per_order',
        availableFrom: 'available_from',
        availableUntil: 'available_until',
        sortOrder: 'sort_order',
      },
    );
    if (updateData.available_from) updateData.available_from = new Date(updateData.available_from as string);
    if (updateData.available_until) updateData.available_until = new Date(updateData.available_until as string);

    return serializeProduct(await repo.update(productId, updateData));
  });

  app.get('/events/:eventId/availability', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

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
