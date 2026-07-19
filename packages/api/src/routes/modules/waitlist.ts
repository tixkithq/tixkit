import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';
import { AuditLogRepository, EventRepository, getDriver, type Database } from '@tixkit/db';
import { ConflictError, NotFoundError, ValidationError } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
import { writeAuditLog } from '../../auth/audit.js';
import { parseBody } from '../../http/schemas.js';

const joinWaitlistSchema = z
  .object({
    ticketTypeId: z.string().min(1),
    email: z.string().email(),
    firstName: z.string().min(1).max(128).optional(),
    lastName: z.string().min(1).max(128).optional(),
    phone: z.string().min(1).max(64).optional(),
    quantity: z.number().int().min(1).max(20).default(1),
  })
  .strict();

const waitlistOfferTtlMinutesSchema = z
  .number()
  .int()
  .min(5)
  .max(60 * 24 * 14);

const offerWaitlistSchema = z
  .object({
    expiresInMinutes: waitlistOfferTtlMinutesSchema,
  })
  .strict();

const waitlistSettingsSchema = z
  .object({
    autoOfferEnabled: z.boolean(),
    offerTtlMinutes: waitlistOfferTtlMinutesSchema,
  })
  .strict();

export function hashWaitlistClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function calculateWaitlistOfferAvailability(input: {
  totalCapacity: number;
  soldCount: number;
  activeHoldsQuantity: number;
  activeOffersQuantity: number;
}): number {
  return (
    input.totalCapacity - input.soldCount - input.activeHoldsQuantity - input.activeOffersQuantity
  );
}

function publicEntry(row: {
  id: string;
  event_id: string;
  ticket_type_id: string;
  buyer_email: string;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_phone: string | null;
  quantity: number;
  status: string;
  offer_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id,
    email: row.buyer_email,
    firstName: row.buyer_first_name ?? undefined,
    lastName: row.buyer_last_name ?? undefined,
    phone: row.buyer_phone ?? undefined,
    quantity: row.quantity,
    status: row.status,
    offerExpiresAt: row.offer_expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function publicSettings(event: {
  waitlist_auto_offer_enabled?: boolean | number | null;
  waitlist_offer_ttl_minutes?: number | null;
}) {
  return {
    autoOfferEnabled: Boolean(event.waitlist_auto_offer_enabled ?? true),
    offerTtlMinutes: Number(event.waitlist_offer_ttl_minutes ?? 60 * 24),
  };
}

function assertOfferUsable(entry: {
  status: string;
  offer_expires_at: Date | string | null;
}): void {
  if (entry.status !== 'offered') {
    throw new ValidationError('Waitlist offer is not available');
  }
  if (!entry.offer_expires_at || new Date(entry.offer_expires_at) <= new Date()) {
    throw new ValidationError('Waitlist offer has expired');
  }
}

async function loadWaitlistEntry(db: Database, id: string) {
  return db
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

export const publicWaitlistRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/public/events/:eventId/waitlist', async (request, reply) => {
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(joinWaitlistSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event || event.status !== 'published') throw new NotFoundError('Event', eventId);

    const ticketType = await db
      .selectFrom('ticket_types')
      .selectAll()
      .where('id', '=', body.ticketTypeId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (!ticketType) throw new NotFoundError('TicketType', body.ticketTypeId);
    if (!['active', 'sold_out'].includes(ticketType.status)) {
      throw new ValidationError('Waitlist is only available for active or sold-out ticket types');
    }

    const availability = await app.context.inventoryService.getAvailability(
      ticketType.inventory_pool_id,
    );
    if (availability.available > 0 && ticketType.status !== 'sold_out') {
      throw new ValidationError('Waitlist is only available after the ticket type is sold out');
    }

    const normalizedEmail = body.email.trim().toLowerCase();
    const existing = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('ticket_type_id', '=', body.ticketTypeId)
      .where('buyer_email', '=', normalizedEmail)
      .where('status', 'in', ['joined', 'offered'])
      .executeTakeFirst();
    if (existing) {
      return reply.status(200).send(publicEntry(existing));
    }

    const now = new Date();
    const entryId = `wle_${ulid()}`;
    const insertQuery = db.insertInto('waitlist_entries').values({
      id: entryId,
      tenant_id: event.tenant_id,
      organization_id: event.organization_id,
      brand_id: event.brand_id,
      event_id: event.id,
      ticket_type_id: ticketType.id,
      buyer_email: normalizedEmail,
      buyer_first_name: body.firstName ?? null,
      buyer_last_name: body.lastName ?? null,
      buyer_phone: body.phone ?? null,
      quantity: body.quantity,
      status: 'joined',
      offer_expires_at: null,
      claim_token_hash: null,
      offered_at: null,
      claimed_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    });
    const entry =
      getDriver() === 'postgres'
        ? await insertQuery.returningAll().executeTakeFirstOrThrow()
        : await insertQuery.execute().then(() => loadWaitlistEntry(db, entryId));

    return reply.status(201).send(publicEntry(entry));
  });

  app.get('/public/waitlist/claims/:token', async (request) => {
    const { token } = request.params as { token: string };
    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('claim_token_hash', '=', hashWaitlistClaimToken(token))
      .executeTakeFirst();
    if (!entry) throw new NotFoundError('WaitlistOffer', 'claim');
    assertOfferUsable(entry);
    return publicEntry(entry);
  });
};

export const waitlistRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/events/:eventId/waitlist', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const entries = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('created_at', 'asc')
      .execute();

    return { items: entries.map(publicEntry), settings: publicSettings(event) };
  });

  app.patch('/events/:eventId/waitlist/settings', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(waitlistSettingsSchema, request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.waitlistSettingsCheckpoint?.({ stage: 'before_transaction', eventId });

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
      const before = publicSettings(currentEvent);
      const updated = await new EventRepository(transaction).update(eventId, {
        waitlist_auto_offer_enabled: body.autoOfferEnabled,
        waitlist_offer_ttl_minutes: body.offerTtlMinutes,
      });
      const after = publicSettings(updated);
      await writeAuditLog(
        new AuditLogRepository(transaction),
        request,
        principal,
        {
          action: 'event.waitlist.settings.updated',
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

  app.post('/events/:eventId/waitlist/:entryId/offer', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId, entryId } = request.params as { eventId: string; entryId: string };
    const body = parseBody(offerWaitlistSchema.partial(), request.body ?? {});
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);
    await app.context.waitlistOfferCheckpoint?.({
      stage: 'before_transaction',
      eventId,
      entryId,
    });

    const token = randomBytes(24).toString('base64url');
    const updated = await db.transaction().execute(async (trx) => {
      const now = new Date();
      const currentEvent = await trx
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
      const entry = await trx
        .selectFrom('waitlist_entries')
        .selectAll()
        .where('id', '=', entryId)
        .where('event_id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry) throw new NotFoundError('WaitlistEntry', entryId);
      if (
        entry.tenant_id !== currentEvent.tenant_id ||
        entry.organization_id !== currentEvent.organization_id ||
        entry.brand_id !== currentEvent.brand_id
      ) {
        throw new NotFoundError('WaitlistEntry', entryId);
      }
      if (entry.status !== 'joined') {
        throw new ConflictError('Only joined waitlist entries can be offered');
      }

      const ticketType = await trx
        .selectFrom('ticket_types')
        .selectAll()
        .where('id', '=', entry.ticket_type_id)
        .where('event_id', '=', eventId)
        .executeTakeFirst();
      if (!ticketType) throw new NotFoundError('WaitlistEntry', entryId);
      const pool = await trx
        .selectFrom('inventory_pools')
        .select(['total_capacity', 'sold_count'])
        .where('id', '=', ticketType.inventory_pool_id)
        .where('event_id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!pool) throw new NotFoundError('WaitlistEntry', entryId);
      const activeHolds = await trx
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.sum<number>('quantity').as('quantity'))
        .where('inventory_pool_id', '=', ticketType.inventory_pool_id)
        .where('status', '=', 'active')
        .where('expires_at', '>', now)
        .executeTakeFirst();
      const activeOffers = await trx
        .selectFrom('waitlist_entries as active_entry')
        .innerJoin(
          'ticket_types as active_ticket_type',
          'active_ticket_type.id',
          'active_entry.ticket_type_id',
        )
        .select(({ fn }) => fn.sum<number>('active_entry.quantity').as('quantity'))
        .where('active_ticket_type.inventory_pool_id', '=', ticketType.inventory_pool_id)
        .where('active_entry.status', '=', 'offered')
        .where('active_entry.offer_expires_at', '>', now)
        .executeTakeFirst();

      const available = calculateWaitlistOfferAvailability({
        totalCapacity: Number(pool.total_capacity),
        soldCount: Number(pool.sold_count),
        activeHoldsQuantity: Number(activeHolds?.quantity ?? 0),
        activeOffersQuantity: Number(activeOffers?.quantity ?? 0),
      });
      if (available < Number(entry.quantity)) {
        throw new ConflictError('Not enough freed capacity to issue this waitlist offer');
      }

      const expiresInMinutes =
        body.expiresInMinutes ??
        parseBody(
          waitlistOfferTtlMinutesSchema,
          Number(currentEvent.waitlist_offer_ttl_minutes ?? 60 * 24),
        );
      const offerExpiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);
      const updateQuery = trx
        .updateTable('waitlist_entries')
        .set({
          status: 'offered',
          claim_token_hash: hashWaitlistClaimToken(token),
          offer_expires_at: offerExpiresAt,
          offered_at: now,
          updated_at: now,
        })
        .where('id', '=', entryId)
        .where('status', '=', 'joined');
      const persisted =
        getDriver() === 'postgres'
          ? await updateQuery.returningAll().executeTakeFirst()
          : await updateQuery.executeTakeFirst().then(async (result) => {
              if (Number(result.numUpdatedRows ?? 0) !== 1) return undefined;
              return trx
                .selectFrom('waitlist_entries')
                .selectAll()
                .where('id', '=', entryId)
                .executeTakeFirst();
            });
      if (!persisted) throw new ConflictError('Only joined waitlist entries can be offered');
      await writeAuditLog(
        new AuditLogRepository(trx),
        request,
        principal,
        {
          action: 'event.waitlist.offer.created',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'WaitlistEntry',
          resourceId: entryId,
          diffSummary: {
            before: publicEntry(entry),
            after: publicEntry(persisted),
          },
        },
        { failClosed: true },
      );
      return persisted;
    });

    return { entry: publicEntry(updated), claimToken: token };
  });
};
