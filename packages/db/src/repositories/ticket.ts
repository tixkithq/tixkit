import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

type TicketListingTerminalStatus = 'delisted' | 'expired';

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
      const now = new Date();
      const result = await trx
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
        await trx
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
    });
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
        expires_at: input.expiresAt ?? null,
        sold_at: null,
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
    const id = `scan_${ulid()}`;
    return this.insertReturning(
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

  async findByDevice(deviceId: string) {
    return this.db.selectFrom('scan_logs').selectAll().where('device_id', '=', deviceId).execute();
  }
}
