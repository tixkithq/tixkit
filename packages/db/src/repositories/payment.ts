import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

export class PaymentIntentRepository extends BaseRepository {
  async create(input: {
    tenantId?: string | null;
    checkoutSessionId: string;
    provider: string;
    providerIntentId: string;
    amountCents: number;
    currency: string;
    status: string;
    clientSecret?: string;
    metadata?: Record<string, string>;
    orderId?: string;
    paymentAccountId?: string | null;
  }) {
    const id = `pi_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'payment_intents',
      {
        id,
        tenant_id: input.tenantId ?? null,
        order_id: input.orderId ?? null,
        checkout_session_id: input.checkoutSessionId,
        provider: input.provider,
        provider_intent_id: input.providerIntentId,
        amount_cents: input.amountCents,
        currency: input.currency,
        status: input.status,
        client_secret: input.clientSecret ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        payment_account_id: input.paymentAccountId ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByProviderIntentId(providerIntentId: string) {
    return this.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('provider_intent_id', '=', providerIntentId)
      .executeTakeFirst();
  }

  async findByProviderAndIntentId(provider: string, providerIntentId: string) {
    return this.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_intent_id', '=', providerIntentId)
      .executeTakeFirst();
  }

  async findByCheckoutSessionAndProviderIntentId(
    checkoutSessionId: string,
    providerIntentId: string,
  ) {
    return this.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('checkout_session_id', '=', checkoutSessionId)
      .where('provider_intent_id', '=', providerIntentId)
      .executeTakeFirst();
  }

  async findLatestByCheckoutSession(checkoutSessionId: string) {
    return this.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('checkout_session_id', '=', checkoutSessionId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('payment_intents', id, { ...input, updated_at: new Date() });
  }
}

export class PaymentCompensationRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    checkoutSessionId: string;
    paymentIntentId?: string | null;
    provider: string;
    providerIntentId: string;
    amountCents: number;
    currency: string;
    action: string;
    status?: string;
    providerCompensationId?: string | null;
    attempts?: number;
    reason: string;
    lastError?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    const id = `pcmp_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'payment_compensations',
      {
        id,
        tenant_id: input.tenantId,
        checkout_session_id: input.checkoutSessionId,
        payment_intent_id: input.paymentIntentId ?? null,
        provider: input.provider,
        provider_intent_id: input.providerIntentId,
        amount_cents: input.amountCents,
        currency: input.currency,
        action: input.action,
        status: input.status ?? 'pending',
        provider_compensation_id: input.providerCompensationId ?? null,
        attempts: input.attempts ?? 0,
        reason: input.reason,
        last_error: input.lastError ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByProviderIntent(
    provider: string,
    providerIntentId: string,
    checkoutSessionId: string,
  ) {
    return this.db
      .selectFrom('payment_compensations')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_intent_id', '=', providerIntentId)
      .where('checkout_session_id', '=', checkoutSessionId)
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('payment_compensations', id, { ...input, updated_at: new Date() });
  }
}

export class RefundRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    orderId: string;
    paymentIntentId?: string | null;
    provider: string;
    providerRefundId: string;
    amountCents: number;
    currency: string;
    reason: string;
    metadata?: Record<string, string>;
    status?: string;
  }) {
    const id = `ref_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'refunds',
      {
        id,
        tenant_id: input.tenantId,
        order_id: input.orderId,
        payment_intent_id: input.paymentIntentId ?? null,
        provider: input.provider,
        provider_refund_id: input.providerRefundId,
        amount_cents: input.amountCents,
        currency: input.currency,
        status: input.status ?? 'pending',
        reason: input.reason,
        metadata: JSON.stringify(input.metadata ?? {}),
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('refunds').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByOrder(orderId: string) {
    return this.db.selectFrom('refunds').selectAll().where('order_id', '=', orderId).execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('refunds', id, { ...input, updated_at: new Date() });
  }
}

export class PaymentEventRepository extends BaseRepository {
  async create(input: {
    tenantId?: string | null;
    provider: string;
    providerEventId: string;
    eventType: string;
    rawPayload: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    const id = `pevt_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'payment_events',
      {
        id,
        tenant_id: input.tenantId ?? null,
        provider: input.provider,
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        raw_payload: JSON.stringify(input.rawPayload),
        processed_at: null,
        idempotency_key: input.idempotencyKey,
        created_at: now,
      },
      id,
    );
  }

  async findByProviderEventId(provider: string, providerEventId: string) {
    return this.db
      .selectFrom('payment_events')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_event_id', '=', providerEventId)
      .executeTakeFirst();
  }

  async markProcessed(id: string) {
    return this.updateReturning('payment_events', id, { processed_at: new Date() });
  }

  async markProcessedByProviderEventId(provider: string, providerEventId: string) {
    const event = await this.findByProviderEventId(provider, providerEventId);
    if (!event) {
      throw new Error(`Payment event not found for provider event ${provider}:${providerEventId}`);
    }
    return this.markProcessed(event.id);
  }
}
