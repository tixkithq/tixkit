import { createHash } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { ProviderAccountCleanupCommandTable } from '../types/db.js';
import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const CLEANUP_KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const CLEANUP_ERROR_MESSAGE = /^[a-z][a-z0-9_.-]{0,63}:[a-z][a-z0-9_.-]{0,63}$/;
const LEASE_TOKEN = /^[A-Za-z0-9:_-]{16,128}$/;
const MAX_CLEANUP_LEASE_MS = 15 * 60_000;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; errno?: number; number?: number };
  return (
    candidate.code === '23505' ||
    candidate.code === 'ER_DUP_ENTRY' ||
    candidate.errno === 1062 ||
    candidate.number === 2601 ||
    candidate.number === 2627
  );
}

function cleanupProviderAccountIdentity(provider: string, providerAccountId: string): string {
  return sha256(
    `tixkit:provider-account-cleanup:v1:${provider.length}:${provider}:${providerAccountId.length}:${providerAccountId}`,
  );
}

function assertCleanupKind(value: string, errorCode: string): void {
  if (!CLEANUP_KIND.test(value)) throw new Error(errorCode);
}

function assertCleanupLease(input: { leaseToken: string; now: Date; leaseExpiresAt: Date }): void {
  if (!LEASE_TOKEN.test(input.leaseToken)) {
    throw new Error('PROVIDER_ACCOUNT_CLEANUP_LEASE_TOKEN_INVALID');
  }
  const nowMs = input.now.getTime();
  const expiryMs = input.leaseExpiresAt.getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(expiryMs) ||
    expiryMs <= nowMs ||
    expiryMs - nowMs > MAX_CLEANUP_LEASE_MS
  ) {
    throw new Error('PROVIDER_ACCOUNT_CLEANUP_LEASE_EXPIRY_INVALID');
  }
}

function sanitizeCleanupErrorMessage(message: string): string {
  if (!CLEANUP_ERROR_MESSAGE.test(message)) {
    throw new Error('PROVIDER_ACCOUNT_CLEANUP_ERROR_MESSAGE_INVALID');
  }
  return message;
}

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

export class PaymentAccountCleanupCommandRepository extends BaseRepository {
  async enqueue(input: {
    tenantId: string;
    organizationId: string;
    provider: string;
    providerAccountId: string;
    idempotencyKey: string;
    reason: string;
    now?: Date;
  }): Promise<Selectable<ProviderAccountCleanupCommandTable>> {
    const provider = input.provider.trim().toLowerCase();
    if (provider !== input.provider || !PROVIDER_NAME.test(provider)) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_PROVIDER_INVALID');
    }
    if (
      input.providerAccountId.length < 1 ||
      input.providerAccountId.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(input.providerAccountId)
    ) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_ACCOUNT_ID_INVALID');
    }
    if (
      input.idempotencyKey.length < 16 ||
      input.idempotencyKey.length > 512 ||
      !/^[\x21-\x7e]+$/u.test(input.idempotencyKey)
    ) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_IDEMPOTENCY_KEY_INVALID');
    }
    assertCleanupKind(input.reason, 'PROVIDER_ACCOUNT_CLEANUP_REASON_INVALID');
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('PROVIDER_ACCOUNT_CLEANUP_TIME_INVALID');

    const providerAccountIdentitySha256 = cleanupProviderAccountIdentity(
      provider,
      input.providerAccountId,
    );
    const idempotencyKeySha256 = sha256(input.idempotencyKey);
    const existing = await this.findByIdentityOrIdempotency({
      providerAccountIdentitySha256,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      idempotencyKeySha256,
    });
    if (existing)
      return this.assertExactReplay(existing, { ...input, provider }, idempotencyKeySha256);

    const id = `pacc_${ulid()}`;
    try {
      await this.db
        .insertInto('provider_account_cleanup_commands')
        .values({
          id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          provider,
          provider_account_id: input.providerAccountId,
          provider_account_identity_sha256: providerAccountIdentitySha256,
          idempotency_key_sha256: idempotencyKeySha256,
          reason: input.reason,
          status: 'pending',
          attempts: 0,
          available_at: now,
          lease_token: null,
          lease_expires_at: null,
          last_error_kind: null,
          last_error_message: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        })
        .execute();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.findByIdentityOrIdempotency({
        providerAccountIdentitySha256,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        idempotencyKeySha256,
      });
      if (!winner) throw error;
      return this.assertExactReplay(winner, { ...input, provider }, idempotencyKeySha256);
    }
    return this.db
      .selectFrom('provider_account_cleanup_commands')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async claimNext(input: {
    now: Date;
    leaseToken: string;
    leaseExpiresAt: Date;
  }): Promise<Selectable<ProviderAccountCleanupCommandTable> | undefined> {
    assertCleanupLease(input);
    return this.db.transaction().execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom('provider_account_cleanup_commands')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'pending'), eb('available_at', '<=', input.now)]),
            eb.and([eb('status', '=', 'processing'), eb('lease_expires_at', '<=', input.now)]),
          ]),
        )
        .orderBy('available_at', 'asc')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!candidate) return undefined;

      const claimed = await transaction
        .updateTable('provider_account_cleanup_commands')
        .set((eb) => ({
          status: 'processing',
          attempts: eb('attempts', '+', 1),
          lease_token: input.leaseToken,
          lease_expires_at: input.leaseExpiresAt,
          last_error_kind: null,
          last_error_message: null,
          updated_at: input.now,
        }))
        .where('id', '=', candidate.id)
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'pending'), eb('available_at', '<=', input.now)]),
            eb.and([eb('status', '=', 'processing'), eb('lease_expires_at', '<=', input.now)]),
          ]),
        )
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) !== 1) return undefined;
      return transaction
        .selectFrom('provider_account_cleanup_commands')
        .selectAll()
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
    });
  }

  async markSucceeded(input: { id: string; leaseToken: string; now: Date }): Promise<boolean> {
    return this.finishClaimed({ ...input, status: 'succeeded' });
  }

  async reschedule(input: {
    id: string;
    leaseToken: string;
    availableAt: Date;
    errorKind: string;
    lastError: string;
    now: Date;
  }): Promise<boolean> {
    this.assertClaimMutation(input);
    if (!Number.isFinite(input.availableAt.getTime()) || input.availableAt < input.now) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_RETRY_TIME_INVALID');
    }
    const result = await this.db
      .updateTable('provider_account_cleanup_commands')
      .set({
        status: 'pending',
        available_at: input.availableAt,
        lease_token: null,
        lease_expires_at: null,
        last_error_kind: input.errorKind,
        last_error_message: sanitizeCleanupErrorMessage(input.lastError),
        updated_at: input.now,
        completed_at: null,
      })
      .where('id', '=', input.id)
      .where('status', '=', 'processing')
      .where('lease_token', '=', input.leaseToken)
      .where('lease_expires_at', '>', input.now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async markManualReview(input: {
    id: string;
    leaseToken: string;
    errorKind: string;
    lastError: string;
    now: Date;
  }): Promise<boolean> {
    return this.finishClaimed({ ...input, status: 'manual_review' });
  }

  findByProviderAccount(input: {
    tenantId: string;
    organizationId: string;
    provider: string;
    providerAccountId: string;
  }): Promise<Selectable<ProviderAccountCleanupCommandTable> | undefined> {
    const provider = input.provider.trim().toLowerCase();
    if (provider !== input.provider || !PROVIDER_NAME.test(provider)) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_PROVIDER_INVALID');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(input.providerAccountId)) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_ACCOUNT_ID_INVALID');
    }
    return this.db
      .selectFrom('provider_account_cleanup_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where(
        'provider_account_identity_sha256',
        '=',
        cleanupProviderAccountIdentity(provider, input.providerAccountId),
      )
      .executeTakeFirst();
  }

  findById(input: {
    tenantId: string;
    organizationId: string;
    id: string;
  }): Promise<Selectable<ProviderAccountCleanupCommandTable> | undefined> {
    return this.db
      .selectFrom('provider_account_cleanup_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.id)
      .executeTakeFirst();
  }

  private findByIdentityOrIdempotency(input: {
    providerAccountIdentitySha256: string;
    tenantId: string;
    organizationId: string;
    idempotencyKeySha256: string;
  }): Promise<Selectable<ProviderAccountCleanupCommandTable> | undefined> {
    return this.db
      .selectFrom('provider_account_cleanup_commands')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('provider_account_identity_sha256', '=', input.providerAccountIdentitySha256),
          eb.and([
            eb('tenant_id', '=', input.tenantId),
            eb('organization_id', '=', input.organizationId),
            eb('idempotency_key_sha256', '=', input.idempotencyKeySha256),
          ]),
        ]),
      )
      .executeTakeFirst();
  }

  private assertExactReplay(
    existing: Selectable<ProviderAccountCleanupCommandTable>,
    input: {
      tenantId: string;
      organizationId: string;
      provider: string;
      providerAccountId: string;
      reason: string;
    },
    idempotencyKeySha256: string,
  ): Selectable<ProviderAccountCleanupCommandTable> {
    if (
      existing.tenant_id !== input.tenantId ||
      existing.organization_id !== input.organizationId ||
      existing.provider !== input.provider ||
      existing.provider_account_id !== input.providerAccountId ||
      existing.reason !== input.reason ||
      existing.idempotency_key_sha256 !== idempotencyKeySha256
    ) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_IDEMPOTENCY_CONFLICT');
    }
    return existing;
  }

  private assertClaimMutation(input: { leaseToken: string; errorKind: string; now: Date }): void {
    if (!LEASE_TOKEN.test(input.leaseToken)) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_LEASE_TOKEN_INVALID');
    }
    if (!Number.isFinite(input.now.getTime())) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_TIME_INVALID');
    }
    assertCleanupKind(input.errorKind, 'PROVIDER_ACCOUNT_CLEANUP_ERROR_KIND_INVALID');
  }

  private async finishClaimed(
    input:
      | { id: string; leaseToken: string; now: Date; status: 'succeeded' }
      | {
          id: string;
          leaseToken: string;
          now: Date;
          status: 'manual_review';
          errorKind: string;
          lastError: string;
        },
  ): Promise<boolean> {
    if (!LEASE_TOKEN.test(input.leaseToken)) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_LEASE_TOKEN_INVALID');
    }
    if (!Number.isFinite(input.now.getTime())) {
      throw new Error('PROVIDER_ACCOUNT_CLEANUP_TIME_INVALID');
    }
    const manualReview = input.status === 'manual_review';
    if (manualReview) {
      assertCleanupKind(input.errorKind, 'PROVIDER_ACCOUNT_CLEANUP_ERROR_KIND_INVALID');
    }
    const result = await this.db
      .updateTable('provider_account_cleanup_commands')
      .set({
        status: input.status,
        lease_token: null,
        lease_expires_at: null,
        last_error_kind: manualReview ? input.errorKind : null,
        last_error_message: manualReview ? sanitizeCleanupErrorMessage(input.lastError) : null,
        updated_at: input.now,
        completed_at: input.now,
      })
      .where('id', '=', input.id)
      .where('status', '=', 'processing')
      .where('lease_token', '=', input.leaseToken)
      .where('lease_expires_at', '>', input.now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
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
