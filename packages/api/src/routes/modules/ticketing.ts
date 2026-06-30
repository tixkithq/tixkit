import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AccessRuleRepository,
  AttendeeRepository,
  EventOccurrenceRepository,
  EventRepository,
  OrderRepository,
  TicketTypeRepository,
  TicketRepository,
  TicketListingRepository,
  InventoryPoolRepository,
  ProductCategoryRepository,
  ProductRepository,
} from '@tixkit/db';
import { NotFoundError, ResaleError, ValidationError, validateResalePrice } from '@tixkit/domain';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import { ulid } from 'ulid';
import {
  pageEnvelope,
  parsePagination,
  pickAllowedFields,
  serializeResalePolicy,
  serializeTicketListing,
  serializeTicketResaleCompletion,
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
  resalePolicySchema,
  createResaleListingSchema,
  completeResaleListingSchema,
  parseBody,
} from '../../http/schemas.js';

type Principal = NonNullable<FastifyRequest['principal']>;
type AccessRuleInput = {
  type: 'code' | 'email_domain';
  value: string;
  maxUses?: number | null;
  expiresAt?: string | null;
};
type NormalizedAccessRule = AccessRuleInput & { value: string };

function requireEventAccess(principal: Principal, event: Record<string, unknown>, eventId: string) {
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
}

function normalizeAccessRules(rules: AccessRuleInput[] = []): NormalizedAccessRule[] {
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
}

async function assertNoExistingAccessRuleDuplicates(
  ticketTypeId: string,
  rules: NormalizedAccessRule[],
  accessRuleRepo: AccessRuleRepository,
) {
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
}

function isUniqueViolation(error: unknown): boolean {
  const record = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    record.code === '23505' ||
    record.code === 'ER_DUP_ENTRY' ||
    record.errno === 1062 ||
    record.errno === '1062' ||
    /duplicate|unique/i.test(String(record.message ?? ''))
  );
}

function toResaleValidationError(error: unknown): never {
  if (error instanceof ResaleError) {
    throw new ValidationError(error.message);
  }
  throw error;
}

export const ticketingRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const inventoryService = app.context.inventoryService;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const validateEventOccurrence = async (eventId: string, occurrenceId?: string | null) => {
    if (!occurrenceId) return;
    const occurrence = await new EventOccurrenceRepository(db).findById(occurrenceId);
    if (!occurrence || occurrence.event_id !== eventId) {
      throw new NotFoundError('EventOccurrence', occurrenceId);
    }
  };

  app.get('/events/:eventId/resale-policy', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    return serializeResalePolicy(event);
  });

  app.put('/events/:eventId/resale-policy', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(resalePolicySchema, request.body);

    const eventRepo = new EventRepository(db);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const updated = await eventRepo.update(eventId, {
      resale_enabled: body.enabled,
      resale_max_multiplier: body.maxMultiplier,
      resale_max_absolute_cents: body.maxAbsoluteCents ?? null,
    });
    return serializeResalePolicy(updated);
  });

  app.get('/events/:eventId/resale-listings', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const listings = await new TicketListingRepository(db).findByEvent(
      eventId,
      pagination.limit + 1,
      pagination.cursor,
    );
    return pageEnvelope(listings.map(serializeTicketListing), pagination.limit);
  });

  app.post('/tickets/:ticketId/resale-listings', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { ticketId } = request.params as { ticketId: string };
    const body = parseBody(createResaleListingSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ValidationError('Idempotency-Key header is required for resale listings');
    }

    const ticketRepo = new TicketRepository(db);
    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    if (ticket.tenant_id !== principal.tenantId) throw new NotFoundError('Ticket', ticketId);
    const event = await loadEvent(ticket.event_id as string);
    requireEventAccess(principal, event, ticket.event_id as string);
    if (ticket.status !== 'valid') {
      throw new ValidationError(`Ticket status is ${ticket.status}, cannot list for resale`);
    }
    const ticketType = await new TicketTypeRepository(db).findById(ticket.ticket_type_id as string);
    if (!ticketType || ticketType.event_id !== ticket.event_id) {
      throw new NotFoundError('TicketType', ticket.ticket_type_id as string);
    }

    const tenantId = principal.tenantId;
    const requestHash = hashRequest({
      ticketId,
      priceCents: body.priceCents,
      expiresAt: body.expiresAt ?? null,
    });

    const result = await withIdempotency(
      db,
      { key: idempotencyKey, tenantId, requestHash },
      async () => {
        const listingRepo = new TicketListingRepository(db);
        const active = await listingRepo.findActiveByTicket(tenantId, ticketId);
        if (active) {
          throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
        }
        const faceValueCents = Number(ticketType.price_cents);
        try {
          validateResalePrice(body.priceCents, faceValueCents, serializeResalePolicy(event));
        } catch (error) {
          toResaleValidationError(error);
        }
        try {
          const listing = await listingRepo.create({
            tenantId,
            eventId: ticket.event_id as string,
            ticketId,
            sellerId: principal.id,
            priceCents: body.priceCents,
            currency: String(ticketType.currency),
            faceValueCents,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
          });
          return { status: 201, body: serializeTicketListing(listing) };
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
          }
          throw error;
        }
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.post('/ticket-listings/:listingId/delist', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { listingId } = request.params as { listingId: string };
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ValidationError('Idempotency-Key header is required for resale delisting');
    }

    const listingRepo = new TicketListingRepository(db);
    const listing = await listingRepo.findById(listingId);
    if (!listing) throw new NotFoundError('TicketListing', listingId);
    if (listing.tenant_id !== principal.tenantId) {
      throw new NotFoundError('TicketListing', listingId);
    }
    const event = await loadEvent(listing.event_id as string);
    requireEventAccess(principal, event, listing.event_id as string);

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ listingId, action: 'delist' }),
      },
      async () => {
        try {
          const delisted = await listingRepo.delist(listingId);
          return { status: 200, body: serializeTicketListing(delisted) };
        } catch (error) {
          if (error instanceof Error && /not listed/i.test(error.message)) {
            throw new ValidationError(`Ticket listing ${listingId} is not listed`);
          }
          throw error;
        }
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.post('/ticket-listings/:listingId/complete', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { listingId } = request.params as { listingId: string };
    const body = parseBody(completeResaleListingSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new ValidationError('Idempotency-Key header is required for resale completion');
    }

    const listingRepo = new TicketListingRepository(db);
    const listing = await listingRepo.findById(listingId);
    if (!listing) throw new NotFoundError('TicketListing', listingId);
    if (listing.tenant_id !== principal.tenantId) {
      throw new NotFoundError('TicketListing', listingId);
    }
    const event = await loadEvent(listing.event_id as string);
    requireEventAccess(principal, event, listing.event_id as string);

    const requestHash = hashRequest({
      listingId,
      buyerId: body.buyerId,
      buyerEmail: body.buyerEmail,
      buyerFirstName: body.buyerFirstName ?? null,
      buyerLastName: body.buyerLastName ?? null,
      buyerPhone: body.buyerPhone ?? null,
      externalPaymentReference: body.externalPaymentReference ?? null,
    });

    const result = await withIdempotency(
      db,
      { key: idempotencyKey, tenantId: principal.tenantId, requestHash },
      async () => {
        const completed = await db.transaction().execute(async (trx) => {
          const txDb = trx as typeof db;
          const txListingRepo = new TicketListingRepository(txDb);
          const txTicketRepo = new TicketRepository(txDb);
          const txAttendeeRepo = new AttendeeRepository(txDb);
          const txOrderRepo = new OrderRepository(txDb);
          const now = new Date();

          const currentListing = await txListingRepo.findById(listingId);
          if (!currentListing || currentListing.tenant_id !== principal.tenantId) {
            throw new NotFoundError('TicketListing', listingId);
          }
          if (currentListing.status !== 'listed') {
            throw new ValidationError(`Ticket listing ${listingId} is not listed`);
          }
          if (
            currentListing.expires_at &&
            new Date(currentListing.expires_at as Date | string).getTime() <= now.getTime()
          ) {
            await txListingRepo.expire(listingId);
            return { expired: true as const };
          }
          if (currentListing.seller_id === body.buyerId) {
            throw new ValidationError('Buyer cannot be the resale listing seller');
          }

          const sellerTicket = await txTicketRepo.findById(currentListing.ticket_id as string);
          if (
            !sellerTicket ||
            sellerTicket.tenant_id !== principal.tenantId ||
            sellerTicket.event_id !== currentListing.event_id
          ) {
            throw new ValidationError(`Ticket listing ${listingId} is not attached to a valid ticket`);
          }
          if (sellerTicket.status !== 'valid') {
            throw new ValidationError(`Ticket status is ${sellerTicket.status}, cannot complete resale`);
          }

          const sellerAttendee = await txAttendeeRepo.findById(sellerTicket.attendee_id as string);
          if (
            !sellerAttendee ||
            sellerAttendee.tenant_id !== principal.tenantId ||
            sellerAttendee.event_id !== sellerTicket.event_id
          ) {
            throw new ValidationError(
              `Ticket listing ${listingId} is not attached to a valid seller attendee`,
            );
          }

          const buyerAttendee = await txAttendeeRepo.create({
            tenantId: principal.tenantId,
            orderId: sellerTicket.order_id as string,
            eventId: sellerTicket.event_id as string,
            ticketTypeId: sellerTicket.ticket_type_id as string,
            eventOccurrenceId: (sellerTicket.event_occurrence_id as string | null) ?? undefined,
            email: body.buyerEmail,
            firstName: body.buyerFirstName ?? undefined,
            lastName: body.buyerLastName ?? undefined,
            phone: body.buyerPhone ?? undefined,
            customAnswers: {
              resaleListingId: listingId,
              resaleSellerAttendeeId: sellerAttendee.id,
              externalPaymentReference: body.externalPaymentReference ?? null,
            },
          });

          const buyerTicketId = `tkt_${ulid()}`;
          const qr = app.context.qrService.generate(buyerTicketId);
          const buyerTicket = await txTicketRepo.create({
            id: buyerTicketId,
            tenantId: principal.tenantId,
            orderId: sellerTicket.order_id as string,
            attendeeId: buyerAttendee.id as string,
            eventId: sellerTicket.event_id as string,
            ticketTypeId: sellerTicket.ticket_type_id as string,
            eventOccurrenceId: (sellerTicket.event_occurrence_id as string | null) ?? undefined,
            code: qr.code,
            qrPayload: qr.payload,
            qrHash: qr.hash,
          });
          const confirmedBuyerAttendee = await txAttendeeRepo.update(buyerAttendee.id as string, {
            ticket_id: buyerTicket.id,
            status: 'confirmed',
          });

          const sellerTransferred = await txTicketRepo.transferIfValid(
            sellerTicket.id as string,
            body.buyerEmail,
            now,
          );
          if (!sellerTransferred) {
            const currentSellerTicket = await txTicketRepo.findById(sellerTicket.id as string);
            throw new ValidationError(
              `Ticket status is ${currentSellerTicket?.status ?? sellerTicket.status}, cannot complete resale`,
            );
          }

          await txDb
            .updateTable('wallet_passes')
            .set({ status: 'revoked', revoked_at: now, updated_at: now })
            .where('ticket_id', '=', sellerTicket.id as string)
            .where('status', '=', 'active')
            .execute();

          const transferredSellerTicket = await txTicketRepo.findById(sellerTicket.id as string);
          const soldListing = await txListingRepo.markSold(listingId, body.buyerId);
          await txOrderRepo.addTimelineEvent(
            sellerTicket.order_id as string,
            'ticket.resale_completed',
            `Ticket ${sellerTicket.id} resold to ${body.buyerEmail}`,
            {
              listingId,
              sellerTicketId: sellerTicket.id,
              buyerTicketId: buyerTicket.id,
              buyerAttendeeId: confirmedBuyerAttendee.id,
              buyerId: body.buyerId,
              externalPaymentReference: body.externalPaymentReference ?? null,
            },
            principal.id,
          );

          return {
            listing: soldListing,
            sellerTicket: transferredSellerTicket!,
            buyerTicket,
            buyerAttendee: confirmedBuyerAttendee,
          };
        });
        if ('expired' in completed) {
          throw new ValidationError(`Ticket listing ${listingId} has expired`);
        }
        return { status: 200, body: serializeTicketResaleCompletion(completed) };
      },
    );

    return reply.status(result.status).send(result.body);
  });

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
    await validateEventOccurrence(eventId, body.eventOccurrenceId);
    const ticketType = await repo.create({
      eventId,
      name: body.name,
      kind: body.kind,
      currency: body.currency,
      priceCents: body.priceCents,
      inventoryPoolId: body.inventoryPoolId,
      visibility: body.visibility,
      description: body.description,
      minimumPriceCents: body.minimumPriceCents ?? undefined,
      salesStartAt: body.salesStartAt ? new Date(body.salesStartAt) : undefined,
      salesEndAt: body.salesEndAt ? new Date(body.salesEndAt) : undefined,
      minPerOrder: body.minPerOrder,
      maxPerOrder: body.maxPerOrder,
      requiresAccessCode: body.requiresAccessCode,
      accessCodeHint: body.accessCodeHint ?? undefined,
      eventOccurrenceId: body.eventOccurrenceId,
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
      await validateEventOccurrence(eventId, body.ticketType.eventOccurrenceId);

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
        salesStartAt: body.ticketType.salesStartAt
          ? new Date(body.ticketType.salesStartAt)
          : undefined,
        salesEndAt: body.ticketType.salesEndAt ? new Date(body.ticketType.salesEndAt) : undefined,
        minPerOrder: body.ticketType.minPerOrder,
        maxPerOrder: body.ticketType.maxPerOrder,
        requiresAccessCode: body.ticketType.requiresAccessCode,
        accessCodeHint: body.ticketType.accessCodeHint ?? undefined,
        eventOccurrenceId: body.ticketType.eventOccurrenceId,
      });

      const accessRuleRepo = new AccessRuleRepository(txDb);
      const createdRules = [];
      for (const rule of accessRules) {
        // oxlint-disable-next-line no-await-in-loop -- access rules are created sequentially inside the ticket-type transaction for deterministic rollback behavior.
        const createdRule = await accessRuleRepo.create({
          ticketTypeId: ticketType.id,
          type: rule.type,
          value: rule.value,
          maxUses: rule.maxUses ?? undefined,
          expiresAt: rule.expiresAt ? new Date(rule.expiresAt) : undefined,
        });
        createdRules.push(createdRule);
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
        'eventOccurrenceId',
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
        eventOccurrenceId: 'event_occurrence_id',
        requiresAccessCode: 'requires_access_code',
        accessCodeHint: 'access_code_hint',
        sortOrder: 'sort_order',
      },
    );
    if (updateData.sales_start_at)
      updateData.sales_start_at = new Date(updateData.sales_start_at as string);
    if (updateData.sales_end_at)
      updateData.sales_end_at = new Date(updateData.sales_end_at as string);
    if (updateData.inventory_pool_id) {
      const pool = await new InventoryPoolRepository(db).findById(
        updateData.inventory_pool_id as string,
      );
      if (!pool || pool.event_id !== existing.event_id) {
        throw new NotFoundError('InventoryPool', updateData.inventory_pool_id as string);
      }
    }
    if ('event_occurrence_id' in updateData) {
      await validateEventOccurrence(
        existing.event_id,
        updateData.event_occurrence_id as string | null,
      );
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
    await validateEventOccurrence(existing.event_id, body.ticketType.eventOccurrenceId);

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
          'eventOccurrenceId',
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
          eventOccurrenceId: 'event_occurrence_id',
          requiresAccessCode: 'requires_access_code',
          accessCodeHint: 'access_code_hint',
          sortOrder: 'sort_order',
        },
      );
      if (updateData.sales_start_at)
        updateData.sales_start_at = new Date(updateData.sales_start_at as string);
      if (updateData.sales_end_at)
        updateData.sales_end_at = new Date(updateData.sales_end_at as string);
      if ('event_occurrence_id' in updateData) {
        await validateEventOccurrence(
          existing.event_id,
          updateData.event_occurrence_id as string | null,
        );
      }

      const ticketType =
        Object.keys(updateData).length > 0
          ? await new TicketTypeRepository(txDb).update(ticketTypeId, updateData)
          : existing;
      for (const rule of accessRules) {
        // eslint-disable-next-line no-await-in-loop -- access-rule additions stay sequential in the same update transaction.
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
    return pageEnvelope(
      rows.map((row) => serializeTicketType(row)),
      pagination.limit,
    );
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
      .select(['access_rules.id as id', 'ticket_types.event_id as event_id'])
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
    return pageEnvelope(
      rows.map((row) => serializeInventoryPool(row)),
      pagination.limit,
    );
  });

  app.get('/events/:eventId/product-categories', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const rows = await new ProductCategoryRepository(db).findByEvent(
      eventId,
      pagination.limit + 1,
      pagination.cursor,
    );
    return pageEnvelope(
      rows.map((row) => serializeProductCategory(row)),
      pagination.limit,
    );
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

    const rows = await new ProductRepository(db).findByEvent(
      eventId,
      pagination.limit + 1,
      pagination.cursor,
    );
    return pageEnvelope(
      rows.map((row) => serializeProduct(row)),
      pagination.limit,
    );
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
    if (updateData.available_from)
      updateData.available_from = new Date(updateData.available_from as string);
    if (updateData.available_until)
      updateData.available_until = new Date(updateData.available_until as string);

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

    const results = await Promise.all(
      ticketTypes.map(async (tt) => {
        const availability = await inventoryService.getAvailability(tt.inventory_pool_id);
        return {
          ticketTypeId: tt.id,
          eventOccurrenceId: tt.event_occurrence_id ?? undefined,
          available: availability.available,
          total: availability.total,
          reserved: availability.reserved,
          sold: availability.sold,
          status: tt.status,
        };
      }),
    );

    return { items: results, nextCursor: null, hasMore: false };
  });
};
