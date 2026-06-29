import { BaseRepository } from './base.js';
import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';
import type { BoxOfficeTenderType, SalesChannel } from '@tixkit/domain';

export class CheckoutHoldRepository extends BaseRepository {
  async create(input: {
    inventoryPoolId: string;
    checkoutSessionId: string;
    ticketTypeId: string;
    quantity: number;
    expiresAt: Date;
  }) {
    const id = `hld_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'checkout_holds',
      {
        id,
        inventory_pool_id: input.inventoryPoolId,
        checkout_session_id: input.checkoutSessionId,
        ticket_type_id: input.ticketTypeId,
        quantity: input.quantity,
        expires_at: input.expiresAt,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('checkout_holds').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findBySession(sessionId: string) {
    return this.db
      .selectFrom('checkout_holds')
      .selectAll()
      .where('checkout_session_id', '=', sessionId)
      .execute();
  }

  async release(id: string) {
    return this.updateReturning('checkout_holds', id, {
      status: 'released',
      updated_at: new Date(),
    });
  }

  async convert(id: string) {
    return this.updateReturning('checkout_holds', id, {
      status: 'converted',
      updated_at: new Date(),
    });
  }

  async expireStale(): Promise<number> {
    const stale = await this.db
      .selectFrom('checkout_holds')
      .select('id')
      .where('status', '=', 'active')
      .where('expires_at', '<', new Date())
      .execute();

    if (stale.length === 0) return 0;

    await this.db
      .updateTable('checkout_holds')
      .set({ status: 'expired', updated_at: new Date() })
      .where('status', '=', 'active')
      .where('expires_at', '<', new Date())
      .execute();

    return stale.length;
  }
}

export class CheckoutSessionRepository extends BaseRepository {
  async create(input: {
    id?: string;
    tenantId: string;
    eventId: string;
    brandId: string;
    holdId?: string;
    currency: string;
    cart: Record<string, unknown>;
    buyer: Record<string, unknown>;
    quote: Record<string, unknown>;
    expiresAt: Date;
    idempotencyKey: string;
    clientToken?: string;
    successUrl?: string;
    cancelUrl?: string;
  }) {
    const id = input.id ?? `cs_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'checkout_sessions',
      {
        id,
        tenant_id: input.tenantId,
        event_id: input.eventId,
        brand_id: input.brandId,
        status: 'open',
        hold_id: input.holdId ?? null,
        currency: input.currency,
        cart: JSON.stringify(input.cart),
        buyer: JSON.stringify(input.buyer),
        quote: JSON.stringify(input.quote),
        payment_intent_id: null,
        order_id: null,
        success_url: input.successUrl ?? null,
        cancel_url: input.cancelUrl ?? null,
        expires_at: input.expiresAt,
        idempotency_key: input.idempotencyKey,
        client_token: input.clientToken ?? randomBytes(24).toString('base64url'),
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByIdempotencyKey(key: string) {
    return this.db
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('checkout_sessions', id, { ...input, updated_at: new Date() });
  }
}

export class OrderRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
    checkoutSessionId: string;
    orderNumber: string;
    status: string;
    currency: string;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
    buyerEmail: string;
    buyerFirstName?: string;
    buyerLastName?: string;
    buyerPhone?: string;
    paymentIntentId?: string;
    paymentProvider?: string;
    salesChannel?: SalesChannel;
    operatorId?: string;
    tenderType?: BoxOfficeTenderType;
  }) {
    const id = `ord_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'orders',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId,
        event_id: input.eventId,
        checkout_session_id: input.checkoutSessionId,
        order_number: input.orderNumber,
        status: input.status,
        currency: input.currency,
        subtotal_cents: input.subtotalCents,
        discount_cents: input.discountCents,
        tax_cents: input.taxCents,
        fee_cents: input.feeCents,
        total_cents: input.totalCents,
        refunded_cents: 0,
        buyer_email: input.buyerEmail,
        buyer_first_name: input.buyerFirstName ?? null,
        buyer_last_name: input.buyerLastName ?? null,
        buyer_phone: input.buyerPhone ?? null,
        payment_intent_id: input.paymentIntentId ?? null,
        payment_provider: input.paymentProvider ?? null,
        sales_channel: input.salesChannel ?? 'online',
        operator_id: input.operatorId ?? null,
        tender_type: input.tenderType ?? null,
        paid_at: input.status === 'paid' ? now : null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByEvent(eventId: string, limit = 50, cursor?: string) {
    let query = this.db
      .selectFrom('orders')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc')
      .limit(limit);
    if (cursor) query = query.where('id', '>', cursor);
    return query.execute();
  }

  async findByTenant(tenantId: string, limit = 50, cursor?: string) {
    let query = this.db
      .selectFrom('orders')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'asc')
      .limit(limit);
    if (cursor) query = query.where('id', '>', cursor);
    return query.execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('orders', id, { ...input, updated_at: new Date() });
  }

  async addTimelineEvent(
    orderId: string,
    type: string,
    description: string,
    metadata?: Record<string, unknown>,
    actorId?: string,
  ) {
    const id = `ote_${ulid()}`;
    return this.insertReturning(
      'order_timeline_events',
      {
        id,
        order_id: orderId,
        type,
        description,
        metadata: metadata ? JSON.stringify(metadata) : null,
        actor_id: actorId ?? null,
        created_at: new Date(),
      },
      id,
    );
  }

  async getTimeline(orderId: string) {
    return this.db
      .selectFrom('order_timeline_events')
      .selectAll()
      .where('order_id', '=', orderId)
      .orderBy('created_at', 'asc')
      .execute();
  }

  async createLineItem(input: {
    orderId: string;
    ticketTypeId?: string;
    eventOccurrenceId?: string;
    productId?: string;
    attendeeId?: string;
    description: string;
    quantity: number;
    unitPriceCents: number;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
    currency: string;
  }) {
    const id = `oli_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'order_line_items',
      {
        id,
        order_id: input.orderId,
        ticket_type_id: input.ticketTypeId ?? null,
        event_occurrence_id: input.eventOccurrenceId ?? null,
        product_id: input.productId ?? null,
        attendee_id: input.attendeeId ?? null,
        description: input.description,
        quantity: input.quantity,
        unit_price_cents: input.unitPriceCents,
        subtotal_cents: input.subtotalCents,
        discount_cents: input.discountCents,
        tax_cents: input.taxCents,
        fee_cents: input.feeCents,
        total_cents: input.totalCents,
        currency: input.currency,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async getLineItems(orderId: string) {
    return this.db
      .selectFrom('order_line_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute();
  }
}

export class AttendeeRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    orderId: string;
    eventId: string;
    ticketTypeId: string;
    eventOccurrenceId?: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    customAnswers?: Record<string, unknown>;
  }) {
    const id = `att_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'attendees',
      {
        id,
        tenant_id: input.tenantId,
        order_id: input.orderId,
        event_id: input.eventId,
        ticket_type_id: input.ticketTypeId,
        event_occurrence_id: input.eventOccurrenceId ?? null,
        ticket_id: null,
        first_name: input.firstName ?? null,
        last_name: input.lastName ?? null,
        email: input.email,
        phone: input.phone ?? null,
        status: 'pending',
        custom_answers: input.customAnswers ? JSON.stringify(input.customAnswers) : null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('attendees').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByEvent(eventId: string, limit = 100, cursor?: string, tenantId?: string) {
    let query = this.db
      .selectFrom('attendees')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc')
      .limit(limit);
    if (cursor) query = query.where('id', '>', cursor);
    if (tenantId) query = query.where('tenant_id', '=', tenantId);
    return query.execute();
  }

  async findByOrder(orderId: string) {
    return this.db.selectFrom('attendees').selectAll().where('order_id', '=', orderId).execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('attendees', id, { ...input, updated_at: new Date() });
  }
}
