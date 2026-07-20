import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AccessRuleRepository,
  EventOccurrenceRepository,
  EventRepository,
  TicketTypeRepository,
  TicketRepository,
  TicketListingRepository,
  InventoryPoolRepository,
  ProductCategoryRepository,
  ProductRepository,
  AuditLogRepository,
  ResaleSettlementRepository,
  ResaleSettlementConflictError,
  type Database,
} from '@tixkit/db';
import {
  ConflictError,
  NotFoundError,
  ResaleError,
  ValidationError,
  normalizeEmailDomainAccessRuleValue,
  assertCurrentResaleTermsAcceptance,
  validateResalePrice,
} from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import {
  pageEnvelope,
  parsePagination,
  pickAllowedFields,
  serializeResalePolicy,
  serializeTicketListing,
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
  recordResaleSettlementPayoutSchema,
  recordResaleSettlementReversalSchema,
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

function accessRuleKey(rule: { type: string; value: string }): string {
  const value =
    rule.type === 'email_domain'
      ? normalizeEmailDomainAccessRuleValue(rule.value)
      : rule.value.trim().toLowerCase();
  return `${rule.type}:${value}`;
}

function requireEventAccess(principal: Principal, event: Record<string, unknown>, eventId: string) {
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
}

function normalizeAccessRules(rules: AccessRuleInput[] = []): NormalizedAccessRule[] {
  const normalized = rules.map((rule) => ({
    ...rule,
    value:
      rule.type === 'email_domain'
        ? normalizeEmailDomainAccessRuleValue(rule.value)
        : rule.value.trim(),
  }));
  const keys = new Set<string>();
  for (const rule of normalized) {
    if (!rule.value) {
      throw new ValidationError('Access rule value is required');
    }
    const key = accessRuleKey(rule);
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
    existing.map((rule) => accessRuleKey({ type: String(rule.type), value: String(rule.value) })),
  );
  const duplicate = rules.find((rule) => existingKeys.has(accessRuleKey(rule)));
  if (duplicate) {
    throw new ValidationError(`Access rule already exists: ${duplicate.value}`);
  }
}

async function assertInventoryPoolReassignmentAllowed(
  db: Database,
  input: {
    ticketTypeId: string;
    currentInventoryPoolId: string;
    nextInventoryPoolId?: unknown;
  },
) {
  if (
    typeof input.nextInventoryPoolId !== 'string' ||
    input.nextInventoryPoolId === input.currentInventoryPoolId
  ) {
    return;
  }

  const [hold, orderLineItem, ticket, waitlistEntry] = await Promise.all([
    db
      .selectFrom('checkout_holds')
      .select('id')
      .where('ticket_type_id', '=', input.ticketTypeId)
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('order_line_items')
      .select('id')
      .where('ticket_type_id', '=', input.ticketTypeId)
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('tickets')
      .select('id')
      .where('ticket_type_id', '=', input.ticketTypeId)
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom('waitlist_entries')
      .select('id')
      .where('ticket_type_id', '=', input.ticketTypeId)
      .where('status', 'in', ['joined', 'offered'])
      .limit(1)
      .executeTakeFirst(),
  ]);

  if (hold || orderLineItem || ticket || waitlistEntry) {
    throw new ValidationError(
      'Inventory pool cannot be changed after holds, orders, tickets, or active waitlist entries exist for this ticket type',
    );
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

function requireIdempotencyKey(request: FastifyRequest, action: string, maxLength = 255): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ValidationError(`Idempotency-Key header is required for ${action}`);
  }
  const normalized = key.trim();
  if (normalized.length > maxLength) {
    throw new ValidationError(`Idempotency-Key header is too long for ${action}`);
  }
  return normalized;
}

function requireNoLiveResaleCheckoutReservation(
  listing: { reserved_checkout_session_id?: string | null; reserved_until?: Date | string | null },
  listingId: string,
  now: Date,
) {
  const reservationId = listing.reserved_checkout_session_id;
  const reservedUntil = listing.reserved_until;
  if (!reservationId && !reservedUntil) return;
  const reservedUntilMs = reservedUntil ? new Date(reservedUntil).getTime() : Number.NaN;
  if (!reservationId || !reservedUntil || !Number.isFinite(reservedUntilMs)) {
    throw new ValidationError(`Ticket listing ${listingId} has an invalid checkout reservation`);
  }
  if (reservedUntilMs > now.getTime()) {
    throw new ValidationError(`Ticket listing ${listingId} is reserved for checkout`);
  }
}

function serializeResaleSettlement(
  settlement: Record<string, unknown>,
  entries: Array<Record<string, unknown>>,
) {
  const cents = (value: unknown) => (value === null ? null : Number(value));
  const timestamp = (value: unknown) =>
    value instanceof Date ? value.toISOString() : String(value);
  return {
    id: settlement.id,
    listingId: settlement.listing_id,
    tenantId: settlement.tenant_id,
    organizationId: settlement.organization_id,
    brandId: settlement.brand_id,
    eventId: settlement.event_id,
    sellerOrderId: settlement.seller_order_id,
    buyerOrderId: settlement.buyer_order_id,
    sellerTicketId: settlement.seller_ticket_id,
    buyerTicketId: settlement.buyer_ticket_id,
    currency: settlement.currency,
    grossCents: cents(settlement.gross_cents),
    feeCents: cents(settlement.fee_cents),
    payableCents: cents(settlement.payable_cents),
    paidCents: cents(settlement.paid_cents),
    reversedCents: cents(settlement.reversed_cents),
    recoveryCents: cents(settlement.recovery_cents),
    state: settlement.state,
    termsVersion: settlement.terms_version,
    version: Number(settlement.version),
    createdAt: timestamp(settlement.created_at),
    updatedAt: timestamp(settlement.updated_at),
    entries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      amountCents: cents(entry.amount_cents),
      currency: entry.currency,
      actorId: entry.actor_id,
      method: entry.method,
      externalReferenceSha256: entry.external_reference_sha256,
      reason: entry.reason,
      createdAt: timestamp(entry.created_at),
    })),
  };
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

  const loadAuthorizedEventForUpdate = async (
    transaction: Database,
    principal: Principal,
    eventId: string,
  ) => {
    const event = await transaction
      .selectFrom('events')
      .selectAll()
      .where('id', '=', eventId)
      .forUpdate()
      .executeTakeFirst();
    if (!event) throw new NotFoundError('Event', eventId);
    requireEventAccess(principal, event, eventId);
    return event;
  };

  const loadSettlementScope = async (principal: Principal, listingId: string) => {
    const listing = await new TicketListingRepository(db).findById(listingId);
    if (!listing || listing.tenant_id !== principal.tenantId) {
      throw new NotFoundError('ResaleSettlement', listingId);
    }
    const event = await loadEvent(listing.event_id);
    requireEventAccess(principal, event, listing.event_id);
    return {
      tenantId: principal.tenantId,
      organizationId: String(event.organization_id),
      brandId: String(event.brand_id),
      eventId: listing.event_id,
      listingId,
    };
  };

  const validateEventOccurrence = async (eventId: string, occurrenceId?: string | null) => {
    if (!occurrenceId) return;
    const occurrence = await new EventOccurrenceRepository(db).findById(occurrenceId);
    if (!occurrence || occurrence.event_id !== eventId) {
      throw new NotFoundError('EventOccurrence', occurrenceId);
    }
  };

  const emitFirstTicketMilestone = (eventCreatedAt: Date | string) => {
    app.observability?.metrics.metrics.onboardingEvents?.inc({
      stage: 'first_ticket',
      outcome: 'completed',
      reason_code: 'none',
    });
    app.observability?.metrics.metrics.onboardingMilestoneDuration?.observe(
      { milestone: 'first_ticket' },
      Math.max(0, (Date.now() - new Date(eventCreatedAt).getTime()) / 1000),
    );
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

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    await app.context.resalePolicyCheckpoint?.({ stage: 'before_transaction', eventId });

    return db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(transaction, principal, eventId);
      const before = serializeResalePolicy(currentEvent);
      const updated = await new EventRepository(transaction).update(eventId, {
        resale_enabled: body.enabled,
        resale_max_multiplier: body.maxMultiplier,
        resale_max_absolute_cents: body.maxAbsoluteCents ?? null,
      });
      const after = serializeResalePolicy(updated);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'event.resale_policy.updated',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: {
            before,
            after,
            previousVersion: Number(currentEvent.version),
            newVersion: Number(updated.version),
          },
        },
        { failClosed: true },
      );
      return after;
    });
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
    assertCurrentResaleTermsAcceptance(body.termsAcceptance);
    const idempotencyKey = requireIdempotencyKey(request, 'resale listings');

    const ticketRepo = new TicketRepository(db);
    const ticket = await ticketRepo.findById(ticketId);
    if (!ticket) throw new NotFoundError('Ticket', ticketId);
    if (ticket.tenant_id !== principal.tenantId) throw new NotFoundError('Ticket', ticketId);
    const event = await loadEvent(ticket.event_id as string);
    requireEventAccess(principal, event, ticket.event_id as string);
    if (ticket.status !== 'valid') {
      throw new ValidationError(`Ticket status is ${ticket.status}, cannot list for resale`);
    }
    if (!ticket.order_id) {
      throw new ValidationError(`Ticket ${ticketId} is not attached to an order`);
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
      termsAcceptance: body.termsAcceptance,
    });

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId,
        requestHash,
        discardErrorCodes: ['NOT_FOUND', 'FORBIDDEN'],
      },
      async () => {
        return db.transaction().execute(async (transaction) => {
          const currentEvent = await loadAuthorizedEventForUpdate(
            transaction,
            principal,
            ticket.event_id as string,
          );
          const currentTicket = await new TicketRepository(transaction).findByIdForUpdate(ticketId);
          if (
            !currentTicket ||
            currentTicket.tenant_id !== tenantId ||
            currentTicket.event_id !== currentEvent.id
          ) {
            throw new NotFoundError('Ticket', ticketId);
          }
          if (currentTicket.status !== 'valid') {
            throw new ValidationError(
              `Ticket status is ${currentTicket.status}, cannot list for resale`,
            );
          }
          if (!currentTicket.order_id) {
            throw new ValidationError(`Ticket ${ticketId} is not attached to an order`);
          }
          const currentTicketType = await transaction
            .selectFrom('ticket_types')
            .selectAll()
            .where('id', '=', currentTicket.ticket_type_id as string)
            .forUpdate()
            .executeTakeFirst();
          if (!currentTicketType || currentTicketType.event_id !== currentTicket.event_id) {
            throw new NotFoundError('TicketType', currentTicket.ticket_type_id as string);
          }
          const listingRepo = new TicketListingRepository(transaction);
          const active = await listingRepo.findActiveByTicket(tenantId, ticketId);
          if (active) {
            throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
          }
          const faceValueCents = Number(currentTicketType.price_cents);
          try {
            validateResalePrice(
              body.priceCents,
              faceValueCents,
              serializeResalePolicy(currentEvent),
            );
          } catch (error) {
            toResaleValidationError(error);
          }
          try {
            const listing = await listingRepo.create({
              tenantId,
              eventId: currentTicket.event_id as string,
              ticketId,
              sellerId: currentTicket.order_id as string,
              priceCents: body.priceCents,
              currency: String(currentTicketType.currency),
              faceValueCents,
              expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
              termsAcceptance: body.termsAcceptance,
            });
            return { status: 201, body: serializeTicketListing(listing) };
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
            }
            throw error;
          }
        });
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.post('/ticket-listings/:listingId/delist', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { listingId } = request.params as { listingId: string };
    const idempotencyKey = requireIdempotencyKey(request, 'resale delisting');

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
        discardErrorCodes: ['NOT_FOUND', 'FORBIDDEN'],
      },
      async () => {
        return db.transaction().execute(async (transaction) => {
          const currentEvent = await loadAuthorizedEventForUpdate(
            transaction,
            principal,
            listing.event_id as string,
          );
          const txListingRepo = new TicketListingRepository(transaction);
          const currentListing = await txListingRepo.findByIdForUpdate(listingId);
          if (
            !currentListing ||
            currentListing.tenant_id !== principal.tenantId ||
            currentListing.event_id !== currentEvent.id
          ) {
            throw new NotFoundError('TicketListing', listingId);
          }
          requireNoLiveResaleCheckoutReservation(currentListing, listingId, new Date());
          try {
            const delisted = await txListingRepo.delist(listingId);
            return { status: 200, body: serializeTicketListing(delisted) };
          } catch (error) {
            if (error instanceof Error && /not listed/i.test(error.message)) {
              throw new ValidationError(`Ticket listing ${listingId} is not listed`);
            }
            throw error;
          }
        });
      },
    );
    return reply.status(result.status).send(result.body);
  });

  app.get('/ticket-listings/:listingId/settlement', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { listingId } = request.params as { listingId: string };
    const scope = await loadSettlementScope(principal, listingId);
    const repository = new ResaleSettlementRepository(db);
    const settlement = await repository.findExact(scope);
    if (!settlement) throw new NotFoundError('ResaleSettlement', listingId);
    const entries = await repository.listEntriesExact(scope);
    return serializeResaleSettlement(settlement, entries);
  });

  app.post('/ticket-listings/:listingId/settlement/payouts', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { listingId } = request.params as { listingId: string };
    const body = parseBody(recordResaleSettlementPayoutSchema, request.body);
    const idempotencyKey = requireIdempotencyKey(request, 'resale settlement payouts', 128);
    const scope = await loadSettlementScope(principal, listingId);
    const externalReferenceSha256 = createHash('sha256')
      .update(body.externalReference, 'utf8')
      .digest('hex');

    try {
      const response = await db.transaction().execute(async (transaction) => {
        const repository = new ResaleSettlementRepository(transaction);
        const locked = await repository.lockExact(scope);
        const entriesBefore = locked ? await repository.listEntriesExact(scope) : [];
        const replayed = entriesBefore.some((entry) => entry.idempotency_key === idempotencyKey);
        const settlement = await repository.recordPayout({
          ...scope,
          amountCents: body.amountCents,
          currency: body.currency,
          expectedVersion: body.expectedVersion,
          evidence: {
            idempotencyKey,
            actorId: principal.id,
            method: body.method,
            externalReferenceSha256,
          },
        });
        if (!replayed) {
          await writeAuditLog(
            new AuditLogRepository(transaction),
            request,
            principal,
            {
              action: 'resale.settlement.payout_recorded',
              organizationId: scope.organizationId,
              brandId: scope.brandId,
              resourceType: 'ResaleSettlement',
              resourceId: settlement.id,
              diffSummary: {
                listingId,
                amountCents: body.amountCents,
                currency: body.currency,
                method: body.method,
                externalReferenceSha256,
              },
            },
            { failClosed: true },
          );
        }
        const entries = await repository.listEntriesExact(scope);
        return serializeResaleSettlement(settlement, entries);
      });
      return reply.status(200).send(response);
    } catch (error) {
      if (error instanceof ResaleSettlementConflictError) {
        throw new ConflictError('Resale settlement payout could not be recorded', {
          reason: error.message,
          listingId,
        });
      }
      throw error;
    }
  });

  app.post('/ticket-listings/:listingId/settlement/reversals', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { listingId } = request.params as { listingId: string };
    const body = parseBody(recordResaleSettlementReversalSchema, request.body);
    const idempotencyKey = requireIdempotencyKey(request, 'resale settlement reversals', 128);
    const scope = await loadSettlementScope(principal, listingId);

    try {
      const response = await db.transaction().execute(async (transaction) => {
        const repository = new ResaleSettlementRepository(transaction);
        const locked = await repository.lockExact(scope);
        const entriesBefore = locked ? await repository.listEntriesExact(scope) : [];
        const replayed = entriesBefore.some((entry) => entry.idempotency_key === idempotencyKey);
        const settlement = await repository.recordReversal({
          ...scope,
          amountCents: body.amountCents,
          currency: body.currency,
          expectedVersion: body.expectedVersion,
          evidence: {
            idempotencyKey,
            actorId: principal.id,
            method: body.method,
            reason: body.reason,
          },
        });
        if (!replayed) {
          await writeAuditLog(
            new AuditLogRepository(transaction),
            request,
            principal,
            {
              action: 'resale.settlement.reversal_recorded',
              organizationId: scope.organizationId,
              brandId: scope.brandId,
              resourceType: 'ResaleSettlement',
              resourceId: settlement.id,
              diffSummary: {
                listingId,
                amountCents: body.amountCents,
                currency: body.currency,
                method: body.method,
                reason: body.reason,
              },
            },
            { failClosed: true },
          );
        }
        const entries = await repository.listEntriesExact(scope);
        return serializeResaleSettlement(settlement, entries);
      });
      return reply.status(200).send(response);
    } catch (error) {
      if (error instanceof ResaleSettlementConflictError) {
        throw new ConflictError('Resale settlement reversal could not be recorded', {
          reason: error.message,
          listingId,
        });
      }
      throw error;
    }
  });

  app.post('/ticket-listings/:listingId/complete', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    return reply
      .header('Deprecation', '@1784160000')
      .header('Link', '</v1/checkout/sessions>; rel="successor-version"')
      .status(410)
      .send({
        error: {
          code: 'RESALE_COMPLETION_RETIRED',
          message:
            'Provider-delegated resale completion is retired. Reserve the listing in a checkout session and confirm that session so payment, buyer order creation, ticket transfer and compensation use the shared checkout workflow.',
          requestId: request.id,
        },
      });
  });

  app.post('/events/:eventId/ticket-types', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createTicketTypeSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'ticket_type_create',
      eventId,
    });

    const result = await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(transaction, principal, eventId);
      const pool = await transaction
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', body.inventoryPoolId)
        .forUpdate()
        .executeTakeFirst();
      if (!pool || pool.event_id !== eventId) {
        throw new NotFoundError('InventoryPool', body.inventoryPoolId);
      }
      if (body.eventOccurrenceId) {
        const occurrence = await transaction
          .selectFrom('event_occurrences')
          .selectAll()
          .where('id', '=', body.eventOccurrenceId)
          .forUpdate()
          .executeTakeFirst();
        if (!occurrence || occurrence.event_id !== eventId) {
          throw new NotFoundError('EventOccurrence', body.eventOccurrenceId);
        }
      }
      const priorTicketCount = await transaction
        .selectFrom('ticket_types')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      const ticketType = await new TicketTypeRepository(transaction).create({
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
      const serialized = serializeTicketType(ticketType);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'ticket_type.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'TicketType',
          resourceId: ticketType.id,
          diffSummary: { eventId, after: serialized },
        },
        { failClosed: true },
      );
      return {
        firstTicket: Number(priorTicketCount?.count ?? 0) === 0,
        serialized,
      };
    });
    if (result.firstTicket) {
      emitFirstTicketMilestone(event.created_at);
    }

    return reply.status(201).send(result.serialized);
  });

  app.post('/events/:eventId/ticket-types/batch', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createTicketTypeBatchSchema, request.body);
    const accessRules = normalizeAccessRules(body.accessRules);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'ticket_type_batch_create',
      eventId,
    });

    const result = await db.transaction().execute(async (trx) => {
      const txDb = trx as typeof db;
      const currentEvent = await loadAuthorizedEventForUpdate(txDb, principal, eventId);
      const priorTicketCount = await txDb
        .selectFrom('ticket_types')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      let inventoryPoolId = body.ticketType.inventoryPoolId;
      let createdInventoryPool: ReturnType<typeof serializeInventoryPool> | null = null;

      if (inventoryPoolId) {
        const pool = await txDb
          .selectFrom('inventory_pools')
          .selectAll()
          .where('id', '=', inventoryPoolId)
          .forUpdate()
          .executeTakeFirst();
        if (!pool || pool.event_id !== eventId) {
          throw new NotFoundError('InventoryPool', inventoryPoolId);
        }
      } else if (body.inventoryPool) {
        const pool = await new InventoryPoolRepository(txDb).create({
          eventId,
          name: body.inventoryPool.name,
          totalCapacity: body.inventoryPool.totalCapacity,
          holdTtlSeconds: body.inventoryPool.holdTtlSeconds,
        });
        inventoryPoolId = pool.id;
        createdInventoryPool = serializeInventoryPool(pool);
      }

      if (!inventoryPoolId) {
        throw new ValidationError('Provide inventoryPoolId or inventoryPool');
      }
      if (body.ticketType.eventOccurrenceId) {
        const occurrence = await txDb
          .selectFrom('event_occurrences')
          .selectAll()
          .where('id', '=', body.ticketType.eventOccurrenceId)
          .forUpdate()
          .executeTakeFirst();
        if (!occurrence || occurrence.event_id !== eventId) {
          throw new NotFoundError('EventOccurrence', body.ticketType.eventOccurrenceId);
        }
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

      const serialized = {
        ticketType: serializeTicketType(ticketType),
        accessRules: createdRules.map((rule) => serializeAccessRule(rule)),
      };
      await writeAuditLog(
        new AuditLogRepository(txDb),
        request,
        principal,
        {
          action: 'ticket_type.batch_created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'TicketType',
          resourceId: ticketType.id,
          diffSummary: {
            eventId,
            after: { ...serialized, inventoryPool: createdInventoryPool },
          },
        },
        { failClosed: true },
      );
      return {
        firstTicket: Number(priorTicketCount?.count ?? 0) === 0,
        serialized,
      };
    });

    if (result.firstTicket) emitFirstTicketMilestone(event.created_at);
    return reply.status(201).send(result.serialized);
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
      await assertInventoryPoolReassignmentAllowed(db, {
        ticketTypeId,
        currentInventoryPoolId: existing.inventory_pool_id,
        nextInventoryPoolId: updateData.inventory_pool_id,
      });
    }
    if ('event_occurrence_id' in updateData) {
      await validateEventOccurrence(
        existing.event_id,
        updateData.event_occurrence_id as string | null,
      );
    }
    return db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(
        transaction,
        principal,
        existing.event_id,
      );
      const currentTicketType = await transaction
        .selectFrom('ticket_types')
        .selectAll()
        .where('id', '=', ticketTypeId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentTicketType || currentTicketType.event_id !== currentEvent.id) {
        throw new NotFoundError('TicketType', ticketTypeId);
      }
      if (updateData.inventory_pool_id) {
        const pool = await new InventoryPoolRepository(transaction).findById(
          updateData.inventory_pool_id as string,
        );
        if (!pool || pool.event_id !== currentEvent.id) {
          throw new NotFoundError('InventoryPool', updateData.inventory_pool_id as string);
        }
        await assertInventoryPoolReassignmentAllowed(transaction, {
          ticketTypeId,
          currentInventoryPoolId: currentTicketType.inventory_pool_id,
          nextInventoryPoolId: updateData.inventory_pool_id,
        });
      }
      if ('event_occurrence_id' in updateData) {
        const occurrenceId = updateData.event_occurrence_id as string | null;
        if (occurrenceId) {
          const occurrence = await new EventOccurrenceRepository(transaction).findById(
            occurrenceId,
          );
          if (!occurrence || occurrence.event_id !== currentEvent.id) {
            throw new NotFoundError('EventOccurrence', occurrenceId);
          }
        }
      }
      return serializeTicketType(
        await new TicketTypeRepository(transaction).update(ticketTypeId, updateData),
      );
    });
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
      await assertInventoryPoolReassignmentAllowed(db, {
        ticketTypeId,
        currentInventoryPoolId: existing.inventory_pool_id,
        nextInventoryPoolId: body.ticketType.inventoryPoolId,
      });
    }
    await validateEventOccurrence(existing.event_id, body.ticketType.eventOccurrenceId);

    const result = await db.transaction().execute(async (trx) => {
      const txDb = trx as typeof db;
      const currentEvent = await loadAuthorizedEventForUpdate(txDb, principal, existing.event_id);
      const currentTicketType = await txDb
        .selectFrom('ticket_types')
        .selectAll()
        .where('id', '=', ticketTypeId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentTicketType || currentTicketType.event_id !== currentEvent.id) {
        throw new NotFoundError('TicketType', ticketTypeId);
      }
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

      if (updateData.inventory_pool_id) {
        const pool = await new InventoryPoolRepository(txDb).findById(
          updateData.inventory_pool_id as string,
        );
        if (!pool || pool.event_id !== currentEvent.id) {
          throw new NotFoundError('InventoryPool', updateData.inventory_pool_id as string);
        }
        await assertInventoryPoolReassignmentAllowed(txDb, {
          ticketTypeId,
          currentInventoryPoolId: currentTicketType.inventory_pool_id,
          nextInventoryPoolId: updateData.inventory_pool_id,
        });
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
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'access_rule_list',
      eventId: ticketType.event_id,
    });

    return db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(
        transaction,
        principal,
        ticketType.event_id,
      );
      const currentTicketType = await transaction
        .selectFrom('ticket_types')
        .select(['id', 'event_id'])
        .where('id', '=', ticketTypeId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentTicketType || currentTicketType.event_id !== currentEvent.id) {
        throw new NotFoundError('TicketType', ticketTypeId);
      }
      const rows = await new AccessRuleRepository(transaction).findByTicketType(ticketTypeId);
      return {
        items: rows.map((row) => serializeAccessRule(row)),
        nextCursor: null,
        hasMore: false,
      };
    });
  });

  app.post('/ticket-types/:ticketTypeId/access-rules', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { ticketTypeId } = request.params as { ticketTypeId: string };
    const body = parseBody(createAccessRuleSchema, request.body);
    const [accessRuleInput] = normalizeAccessRules([body]);
    const repo = new TicketTypeRepository(db);
    const ticketType = await repo.findById(ticketTypeId);
    if (!ticketType) throw new NotFoundError('TicketType', ticketTypeId);
    const event = await loadEvent(ticketType.event_id);
    requireEventAccess(principal, event, ticketType.event_id);
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'access_rule_create',
      eventId: ticketType.event_id,
    });

    const accessRule = await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(
        transaction,
        principal,
        ticketType.event_id,
      );
      const currentTicketType = await transaction
        .selectFrom('ticket_types')
        .select(['id', 'event_id'])
        .where('id', '=', ticketTypeId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentTicketType || currentTicketType.event_id !== currentEvent.id) {
        throw new NotFoundError('TicketType', ticketTypeId);
      }
      return new AccessRuleRepository(transaction).create({
        ticketTypeId,
        type: accessRuleInput.type,
        value: accessRuleInput.value,
        maxUses: accessRuleInput.maxUses ?? undefined,
        expiresAt: accessRuleInput.expiresAt ? new Date(accessRuleInput.expiresAt) : undefined,
      });
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
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'access_rule_delete',
      eventId: rule.event_id,
    });

    await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(
        transaction,
        principal,
        rule.event_id,
      );
      const currentRule = await transaction
        .selectFrom('access_rules')
        .innerJoin('ticket_types', 'ticket_types.id', 'access_rules.ticket_type_id')
        .select(['access_rules.id as id', 'ticket_types.event_id as event_id'])
        .where('access_rules.id', '=', accessRuleId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentRule || currentRule.event_id !== currentEvent.id) {
        throw new NotFoundError('AccessRule', accessRuleId);
      }
      await new AccessRuleRepository(transaction).delete(accessRuleId);
    });
    return reply.status(204).send();
  });

  app.post('/events/:eventId/inventory-pools', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createInventoryPoolSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    await app.context.ticketConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'inventory_pool_create',
      eventId,
    });

    const pool = await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(transaction, principal, eventId);
      const created = await new InventoryPoolRepository(transaction).create({
        eventId,
        name: body.name,
        totalCapacity: body.totalCapacity,
        holdTtlSeconds: body.holdTtlSeconds,
      });
      const serialized = serializeInventoryPool(created);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'inventory_pool.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'InventoryPool',
          resourceId: created.id,
          diffSummary: { eventId, after: serialized },
        },
        { failClosed: true },
      );
      return serialized;
    });

    return reply.status(201).send(pool);
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
    await app.context.productConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'product_category_create',
      eventId,
    });

    const category = await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(transaction, principal, eventId);
      const created = await new ProductCategoryRepository(transaction).create({
        eventId,
        name: body.name,
        sortOrder: body.sortOrder,
      });
      const serialized = serializeProductCategory(created);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'product_category.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'ProductCategory',
          resourceId: created.id,
          diffSummary: { eventId, after: serialized },
        },
        { failClosed: true },
      );
      return serialized;
    });

    return reply.status(201).send(category);
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
    await app.context.productConfigurationCheckpoint?.({
      stage: 'before_transaction',
      operation: 'product_create',
      eventId,
    });

    const product = await db.transaction().execute(async (transaction) => {
      const currentEvent = await loadAuthorizedEventForUpdate(transaction, principal, eventId);
      if (body.categoryId) {
        const category = await transaction
          .selectFrom('product_categories')
          .selectAll()
          .where('id', '=', body.categoryId)
          .forUpdate()
          .executeTakeFirst();
        if (!category || category.event_id !== eventId) {
          throw new NotFoundError('ProductCategory', body.categoryId);
        }
      }
      const created = await new ProductRepository(transaction).create({
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
      const serialized = serializeProduct(created);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'product.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'Product',
          resourceId: created.id,
          diffSummary: { eventId, after: serialized },
        },
        { failClosed: true },
      );
      return serialized;
    });

    return reply.status(201).send(product);
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
