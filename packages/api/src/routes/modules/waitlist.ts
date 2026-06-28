import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';
import { EventRepository, getDriver, type Database } from '@tixkit/db';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import { ClerkAuthService } from '../../auth/clerk.js';
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

const offerWaitlistSchema = z
  .object({
    expiresInMinutes: z
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 14)
      .default(60 * 24),
  })
  .strict();

const waitlistSettingsSchema = z
  .object({
    autoOfferEnabled: z.boolean(),
    offerTtlMinutes: z
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 14),
  })
  .strict();

export function hashWaitlistClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
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

    const updateQuery = db
      .updateTable('events')
      .set({
        waitlist_auto_offer_enabled: body.autoOfferEnabled,
        waitlist_offer_ttl_minutes: body.offerTtlMinutes,
        updated_at: new Date(),
      })
      .where('id', '=', eventId);
    const updated =
      getDriver() === 'postgres'
        ? await updateQuery
            .returning(['waitlist_auto_offer_enabled', 'waitlist_offer_ttl_minutes'])
            .executeTakeFirst()
        : await updateQuery
            .execute()
            .then(() =>
              db
                .selectFrom('events')
                .select(['waitlist_auto_offer_enabled', 'waitlist_offer_ttl_minutes'])
                .where('id', '=', eventId)
                .executeTakeFirst(),
            );

    if (!updated) {
      return publicSettings({
        waitlist_auto_offer_enabled: body.autoOfferEnabled,
        waitlist_offer_ttl_minutes: body.offerTtlMinutes,
      });
    }
    return publicSettings(updated);
  });

  app.post('/events/:eventId/waitlist/:entryId/offer', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'tickets.write');
    const { eventId, entryId } = request.params as { eventId: string; entryId: string };
    const body = parseBody(offerWaitlistSchema.partial(), request.body);
    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, eventId);

    const entry = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', '=', entryId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    if (!entry) throw new NotFoundError('WaitlistEntry', entryId);
    if (entry.status !== 'joined')
      throw new ValidationError('Only joined waitlist entries can be offered');

    const ticketType = await db
      .selectFrom('ticket_types')
      .selectAll()
      .where('id', '=', entry.ticket_type_id)
      .executeTakeFirstOrThrow();
    const availability = await app.context.inventoryService.getAvailability(
      ticketType.inventory_pool_id,
    );
    if (availability.available < entry.quantity) {
      throw new ValidationError('Not enough freed capacity to issue this waitlist offer');
    }

    const token = randomBytes(24).toString('base64url');
    const now = new Date();
    const expiresInMinutes =
      body.expiresInMinutes ?? Number(event.waitlist_offer_ttl_minutes ?? 60 * 24);
    const offerExpiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);
    const updateQuery = db
      .updateTable('waitlist_entries')
      .set({
        status: 'offered',
        claim_token_hash: hashWaitlistClaimToken(token),
        offer_expires_at: offerExpiresAt,
        offered_at: now,
        updated_at: now,
      })
      .where('id', '=', entryId);
    const updated =
      getDriver() === 'postgres'
        ? await updateQuery.returningAll().executeTakeFirstOrThrow()
        : await updateQuery.execute().then(() => loadWaitlistEntry(db, entryId));

    return { entry: publicEntry(updated), claimToken: token };
  });
};
