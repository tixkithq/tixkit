import { BaseRepository, insertReturning } from './base.js';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import type { Database } from '../client.js';
import type { ResaleTermsAcceptance } from '@tixkit/domain';

type TicketListingTerminalStatus = 'delisted' | 'expired';

function assertTransactionOwned(database: Database): void {
  if ((database as Database & { isTransaction?: boolean }).isTransaction !== true) {
    throw new Error('CHECK_IN_TRANSACTION_REQUIRED');
  }
}

export class TicketRepository extends BaseRepository {
  async create(input: {
    id?: string;
    tenantId: string;
    orderId: string;
    attendeeId: string;
    eventId: string;
    ticketTypeId: string;
    eventOccurrenceId?: string;
    code: string;
    qrPayload: string;
    qrHash: string;
  }) {
    const id = input.id ?? `tkt_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'tickets',
      {
        id,
        tenant_id: input.tenantId,
        order_id: input.orderId,
        attendee_id: input.attendeeId,
        event_id: input.eventId,
        ticket_type_id: input.ticketTypeId,
        event_occurrence_id: input.eventOccurrenceId ?? null,
        status: 'valid',
        code: input.code,
        qr_payload: input.qrPayload,
        qr_hash: input.qrHash,
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('tickets').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByIdForUpdate(id: string) {
    assertTransactionOwned(this.db);
    return this.db
      .selectFrom('tickets')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async findByCode(code: string) {
    return this.db.selectFrom('tickets').selectAll().where('code', '=', code).executeTakeFirst();
  }

  async findByQrHash(qrHash: string) {
    return this.db
      .selectFrom('tickets')
      .selectAll()
      .where('qr_hash', '=', qrHash)
      .executeTakeFirst();
  }

  async findByEvent(eventId: string) {
    return this.db.selectFrom('tickets').selectAll().where('event_id', '=', eventId).execute();
  }

  async findByOrder(orderId: string) {
    return this.db.selectFrom('tickets').selectAll().where('order_id', '=', orderId).execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('tickets', id, { ...input, updated_at: new Date() });
  }

  async transferIfValid(id: string, toEmail: string, transferredAt: Date): Promise<boolean> {
    const result = await this.db
      .updateTable('tickets')
      .set({
        status: 'transferred',
        transferred_to_email: toEmail,
        transferred_at: transferredAt,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('status', '=', 'valid')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0) === 1;
  }

  /**
   * Atomically transitions a ticket from `valid` to `checked_in` using a
   * conditional update. Returns true only if THIS call performed the check-in,
   * so concurrent scanners cannot both succeed for the same ticket.
   */
  async checkInIfValid(id: string, deviceId: string, checkedInAt: Date): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      return new TicketRepository(trx as Database).checkInIfValidInTransaction(
        id,
        deviceId,
        checkedInAt,
      );
    });
  }

  async checkInIfValidInTransaction(
    id: string,
    deviceId: string,
    checkedInAt: Date,
  ): Promise<boolean> {
    assertTransactionOwned(this.db);
    const now = new Date();
    const result = await this.db
      .updateTable('tickets')
      .set({
        status: 'checked_in',
        checked_in_at: checkedInAt,
        checked_in_by_device_id: deviceId,
        updated_at: now,
      })
      .where('id', '=', id)
      .where('status', '=', 'valid')
      .executeTakeFirst();
    const updated = Number(result.numUpdatedRows ?? 0) === 1;
    if (updated) {
      await this.db
        .updateTable('attendees')
        .set({
          status: 'checked_in',
          checked_in_at: checkedInAt,
          check_in_device_id: deviceId,
          updated_at: now,
        })
        .where('ticket_id', '=', id)
        .execute();
    }
    return updated;
  }
}

export class TicketListingRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    eventId: string;
    ticketId: string;
    sellerId: string;
    priceCents: number;
    currency: string;
    faceValueCents: number;
    expiresAt?: Date;
    termsAcceptance: ResaleTermsAcceptance;
  }) {
    const id = `lst_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'ticket_listings',
      {
        id,
        tenant_id: input.tenantId,
        event_id: input.eventId,
        ticket_id: input.ticketId,
        seller_id: input.sellerId,
        status: 'listed',
        price_cents: input.priceCents,
        currency: input.currency,
        face_value_cents: input.faceValueCents,
        sold_to_id: null,
        active_listing_key: input.ticketId,
        reserved_checkout_session_id: null,
        reserved_until: null,
        expires_at: input.expiresAt ?? null,
        sold_at: null,
        seller_terms_version: input.termsAcceptance.termsVersion,
        settlement_model: input.termsAcceptance.settlementModel,
        refund_model: input.termsAcceptance.refundModel,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByIdForUpdate(id: string) {
    assertTransactionOwned(this.db);
    return this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async findActiveByTicket(tenantId: string, ticketId: string) {
    return this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('ticket_id', '=', ticketId)
      .where('status', '=', 'listed')
      .executeTakeFirst();
  }

  async findByEvent(eventId: string, limit = 50, cursor?: string) {
    let query = this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc')
      .limit(limit);
    if (cursor) query = query.where('id', '>', cursor);
    return query.execute();
  }

  async findPublicAvailableByEvent(input: {
    tenantId: string;
    eventId: string;
    limit: number;
    cursor?: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    let query = this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('event_id', '=', input.eventId)
      .where('status', '=', 'listed')
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .where((eb) =>
        eb.or([
          eb('reserved_checkout_session_id', 'is', null),
          eb('reserved_until', 'is', null),
          eb('reserved_until', '<=', now),
        ]),
      )
      .orderBy('id', 'asc')
      .limit(input.limit);
    if (input.cursor) query = query.where('id', '>', input.cursor);
    return query.execute();
  }

  async reserveForCheckout(input: {
    tenantId: string;
    listingId: string;
    checkoutSessionId: string;
    reservedUntil: Date;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const result = await this.db
      .updateTable('ticket_listings')
      .set({
        reserved_checkout_session_id: input.checkoutSessionId,
        reserved_until: input.reservedUntil,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.listingId)
      .where('status', '=', 'listed')
      .where((eb) =>
        eb.or([
          eb('reserved_checkout_session_id', 'is', null),
          eb('reserved_checkout_session_id', '=', input.checkoutSessionId),
          eb('reserved_until', '<=', now),
        ]),
      )
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) !== 1) return undefined;
    return this.findById(input.listingId);
  }

  async releaseCheckoutReservation(input: {
    tenantId: string;
    listingId: string;
    checkoutSessionId: string;
  }) {
    await this.db
      .updateTable('ticket_listings')
      .set({
        reserved_checkout_session_id: null,
        reserved_until: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.listingId)
      .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
      .where('status', '=', 'listed')
      .execute();
  }

  async delist(id: string) {
    return this.setTerminalStatus(id, 'delisted');
  }

  async expire(id: string) {
    return this.setTerminalStatus(id, 'expired');
  }

  async markSold(id: string, buyerId: string) {
    await this.updateListedListing(id, {
      status: 'sold',
      sold_to_id: buyerId,
      sold_at: new Date(),
      active_listing_key: id,
      reserved_checkout_session_id: null,
      reserved_until: null,
      updated_at: new Date(),
    });
    return this.findByIdOrThrow(id);
  }

  async relist(
    id: string,
    input: {
      priceCents: number;
      faceValueCents: number;
      expiresAt?: Date;
    },
  ) {
    const listing = await this.findByIdOrThrow(id);
    const result = await this.db
      .updateTable('ticket_listings')
      .set({
        status: 'listed',
        price_cents: input.priceCents,
        face_value_cents: input.faceValueCents,
        sold_to_id: null,
        sold_at: null,
        active_listing_key: listing.ticket_id,
        reserved_checkout_session_id: null,
        reserved_until: null,
        expires_at: input.expiresAt ?? null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('status', '=', 'delisted')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) !== 1) {
      throw new Error(`Ticket listing ${id} is not delisted`);
    }
    return this.findByIdOrThrow(id);
  }

  private async setTerminalStatus(id: string, status: TicketListingTerminalStatus) {
    await this.updateListedListing(id, {
      status,
      active_listing_key: id,
      reserved_checkout_session_id: null,
      reserved_until: null,
      updated_at: new Date(),
    });
    return this.findByIdOrThrow(id);
  }

  private async updateListedListing(id: string, values: Record<string, unknown>) {
    const result = await this.db
      .updateTable('ticket_listings')
      .set(values)
      .where('id', '=', id)
      .where('status', '=', 'listed')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) !== 1) {
      throw new Error(`Ticket listing ${id} is not listed`);
    }
  }

  private async findByIdOrThrow(id: string) {
    const listing = await this.findById(id);
    if (!listing) throw new Error(`Ticket listing ${id} not found`);
    return listing;
  }
}

export class CheckInListRepository extends BaseRepository {
  async create(input: { eventId: string; name: string; ticketTypeIds: string[] }) {
    const id = `cil_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'check_in_lists',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        ticket_type_ids: JSON.stringify(input.ticketTypeIds),
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('check_in_lists').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByIdForUpdate(id: string) {
    assertTransactionOwned(this.db);
    return this.db
      .selectFrom('check_in_lists')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  async findByEvent(eventId: string, limit?: number, cursor?: string) {
    let query = this.db
      .selectFrom('check_in_lists')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc');
    if (cursor) query = query.where('id', '>', cursor);
    if (limit) query = query.limit(limit);
    return query.execute();
  }
}

export class ScanLogRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    checkInListId: string;
    deviceId: string;
    ticketId?: string;
    qrHash: string;
    outcome: string;
    scannedAt: Date;
    offline: boolean;
    metadata?: Record<string, unknown>;
  }) {
    return this.db.transaction().execute(async (trx) => {
      return new ScanLogRepository(trx as Database).createInTransaction(input);
    });
  }

  async createInTransaction(input: {
    tenantId: string;
    checkInListId: string;
    deviceId: string;
    ticketId?: string;
    qrHash: string;
    outcome: string;
    scannedAt: Date;
    offline: boolean;
    metadata?: Record<string, unknown>;
  }) {
    assertTransactionOwned(this.db);
    const id = `scan_${ulid()}`;
    const list = await this.db
      .selectFrom('check_in_lists')
      .select(sql<string>`concat('', next_activity_sequence)`.as('next_activity_sequence_exact'))
      .where('id', '=', input.checkInListId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const activitySequence = (BigInt(list.next_activity_sequence_exact) + 1n).toString();
    await this.db
      .updateTable('check_in_lists')
      .set({ next_activity_sequence: activitySequence })
      .where('id', '=', input.checkInListId)
      .execute();
    return insertReturning(
      this.db,
      'scan_logs',
      {
        id,
        tenant_id: input.tenantId,
        check_in_list_id: input.checkInListId,
        device_id: input.deviceId,
        ticket_id: input.ticketId ?? null,
        qr_hash: input.qrHash,
        outcome: input.outcome,
        scanned_at: input.scannedAt,
        synced_at: input.offline ? null : new Date(),
        offline: input.offline,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        created_at: new Date(),
        activity_sequence: activitySequence,
      },
      id,
    );
  }

  async findByList(listId: string, limit = 100) {
    return this.db
      .selectFrom('scan_logs')
      .selectAll()
      .where('check_in_list_id', '=', listId)
      .orderBy('scanned_at', 'desc')
      .limit(limit)
      .execute();
  }

  async findByListSince(input: {
    listId: string;
    tenantId: string;
    since?: Date;
    afterId?: string;
    limit?: number;
  }) {
    const limit = input.limit ?? 50;
    const cursor = input.afterId
      ? await this.db
          .selectFrom('scan_logs')
          .select('activity_sequence')
          .where('tenant_id', '=', input.tenantId)
          .where('check_in_list_id', '=', input.listId)
          .where('id', '=', input.afterId)
          .executeTakeFirst()
      : undefined;
    if (input.afterId && !cursor) return [];
    let query = this.db
      .selectFrom('scan_logs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('check_in_list_id', '=', input.listId)
      .orderBy('activity_sequence', 'asc')
      .limit(limit);

    if (input.since) {
      query = query.where('scanned_at', '>=', input.since);
    }
    if (cursor?.activity_sequence != null) {
      query = query.where('activity_sequence', '>', cursor.activity_sequence);
    } else if (input.afterId) {
      query = query.where('id', '>', input.afterId);
    }

    return query.execute();
  }

  async findByDevice(deviceId: string) {
    return this.db.selectFrom('scan_logs').selectAll().where('device_id', '=', deviceId).execute();
  }
}
