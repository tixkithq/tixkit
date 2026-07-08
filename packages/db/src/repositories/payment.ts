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

  async findLatestByCheckoutSession(checkoutSessionId: string) {
    return this.db
      .selectFrom('payment_compensations')
      .selectAll()
      .where('checkout_session_id', '=', checkoutSessionId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  async listForTenant(input: {
    tenantId: string;
    organizationIds?: string[];
    brandIds?: string[];
    eventIds?: string[];
    status?: string;
    checkoutSessionId?: string;
    limit: number;
    cursor?: string;
  }) {
    let query = this.db
      .selectFrom('payment_compensations')
      .innerJoin(
        'checkout_sessions',
        'checkout_sessions.id',
        'payment_compensations.checkout_session_id',
      )
      .innerJoin('events', 'events.id', 'checkout_sessions.event_id')
      .selectAll('payment_compensations')
      .where('payment_compensations.tenant_id', '=', input.tenantId)
      .where('checkout_sessions.tenant_id', '=', input.tenantId)
      .where('events.tenant_id', '=', input.tenantId)
      .orderBy('payment_compensations.id', 'asc')
      .limit(input.limit + 1);
    if (input.organizationIds) {
      query =
        input.organizationIds.length > 0
          ? query.where('events.organization_id', 'in', input.organizationIds)
          : query.where('events.organization_id', 'in', ['__none__']);
    }
    if (input.brandIds && input.brandIds.length > 0) {
      query = query.where('checkout_sessions.brand_id', 'in', input.brandIds);
    }
    if (input.eventIds && input.eventIds.length > 0) {
      query = query.where('checkout_sessions.event_id', 'in', input.eventIds);
    }
    if (input.status) query = query.where('payment_compensations.status', '=', input.status);
    if (input.checkoutSessionId) {
      query = query.where(
        'payment_compensations.checkout_session_id',
        '=',
        input.checkoutSessionId,
      );
    }
    if (input.cursor) query = query.where('payment_compensations.id', '>', input.cursor);
    return query.execute();
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
    requestIdempotencyKey?: string | null;
    requestNonce?: string | null;
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
        request_idempotency_key:
          input.requestIdempotencyKey ?? `provider:${input.provider}:${input.providerRefundId}`,
        request_nonce: input.requestNonce ?? null,
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
        recovery_status: 'pending',
        recovery_attempts: 0,
        recovery_owner: null,
        recovery_claimed_until: null,
        next_recovery_at: null,
        last_recovery_error: null,
        recovery_updated_at: null,
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
    return this.updateReturning('payment_events', id, {
      processed_at: new Date(),
      recovery_status: 'processed',
      recovery_owner: null,
      recovery_claimed_until: null,
      next_recovery_at: null,
      recovery_updated_at: new Date(),
    });
  }

  async markProcessedByProviderEventId(provider: string, providerEventId: string) {
    const event = await this.findByProviderEventId(provider, providerEventId);
    if (!event) {
      throw new Error(`Payment event not found for provider event ${provider}:${providerEventId}`);
    }
    return this.markProcessed(event.id);
  }

  async claimUnprocessedForRecovery(input: {
    ownerId: string;
    limit: number;
    leaseUntil: Date;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const candidates = await this.db
      .selectFrom('payment_events')
      .selectAll()
      .where('processed_at', 'is', null)
      .where('recovery_status', 'in', ['pending', 'dispatched', 'retryable'])
      .where((eb) =>
        eb.or([eb('recovery_claimed_until', 'is', null), eb('recovery_claimed_until', '<', now)]),
      )
      .where((eb) => eb.or([eb('next_recovery_at', 'is', null), eb('next_recovery_at', '<=', now)]))
      .orderBy('created_at', 'asc')
      .limit(input.limit)
      .execute();

    const claimed = [];
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop -- each conditional update is a lease claim.
      const row = await this.db
        .updateTable('payment_events')
        .set({
          recovery_status: 'claimed',
          recovery_attempts: Number(candidate.recovery_attempts ?? 0) + 1,
          recovery_owner: input.ownerId,
          recovery_claimed_until: input.leaseUntil,
          last_recovery_error: null,
          recovery_updated_at: now,
        })
        .where('id', '=', candidate.id)
        .where('processed_at', 'is', null)
        .where((eb) =>
          eb.or([eb('recovery_claimed_until', 'is', null), eb('recovery_claimed_until', '<', now)]),
        )
        .returningAll()
        .executeTakeFirst();
      if (row) claimed.push(row);
    }

    return claimed;
  }

  async markRecoveryDispatched(input: {
    id: string;
    ownerId: string;
    nextRecoveryAt: Date;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db
      .updateTable('payment_events')
      .set({
        recovery_status: 'dispatched',
        recovery_owner: null,
        recovery_claimed_until: null,
        next_recovery_at: input.nextRecoveryAt,
        last_recovery_error: null,
        recovery_updated_at: now,
      })
      .where('id', '=', input.id)
      .where('recovery_owner', '=', input.ownerId)
      .where('processed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }

  async markRecoveryFailed(input: {
    id: string;
    ownerId: string;
    retryable: boolean;
    message: string;
    nextRecoveryAt?: Date;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db
      .updateTable('payment_events')
      .set({
        recovery_status: input.retryable ? 'retryable' : 'manual_review',
        recovery_owner: null,
        recovery_claimed_until: null,
        next_recovery_at: input.retryable ? (input.nextRecoveryAt ?? now) : null,
        last_recovery_error: input.message,
        recovery_updated_at: now,
      })
      .where('id', '=', input.id)
      .where('recovery_owner', '=', input.ownerId)
      .where('processed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
  }
}
