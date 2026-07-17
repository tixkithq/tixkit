import { ulid } from 'ulid';
import type { Selectable } from 'kysely';
import type { Database } from '../client.js';
import type {
  ResaleSettlementEntryKind,
  ResaleSettlementEntryTable,
  ResaleSettlementState,
  ResaleSettlementTable,
} from '../types/db.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;

type SettlementScope = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  listingId: string;
};

type EntryEvidence = {
  idempotencyKey: string;
  actorId: string;
  method: string;
  externalReferenceSha256?: string;
  reason?: string;
};

export class ResaleSettlementConflictError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ResaleSettlementConflictError';
  }
}

function assertTransactionOwned(database: Database): void {
  if ((database as Database & { isTransaction?: boolean }).isTransaction !== true) {
    throw new Error('RESALE_SETTLEMENT_TRANSACTION_REQUIRED');
  }
}

function assertSafeCents(value: number, field: string, allowZero = true): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`RESALE_SETTLEMENT_INVALID_${field.toUpperCase()}`);
  }
}

function assertCurrency(currency: string): void {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('RESALE_SETTLEMENT_INVALID_CURRENCY');
}

function assertEvidence(evidence: EntryEvidence): void {
  if (evidence.idempotencyKey.length < 1 || evidence.idempotencyKey.length > 128) {
    throw new Error('RESALE_SETTLEMENT_INVALID_IDEMPOTENCY_KEY');
  }
  if (evidence.actorId.length < 1 || evidence.actorId.length > 128) {
    throw new Error('RESALE_SETTLEMENT_INVALID_ACTOR');
  }
  if (evidence.method.length < 1 || evidence.method.length > 64) {
    throw new Error('RESALE_SETTLEMENT_INVALID_METHOD');
  }
  if (
    evidence.externalReferenceSha256 !== undefined &&
    !SHA256_HEX.test(evidence.externalReferenceSha256)
  ) {
    throw new Error('RESALE_SETTLEMENT_EXTERNAL_REFERENCE_MUST_BE_SHA256');
  }
  if (evidence.reason !== undefined && evidence.reason.length > 512) {
    throw new Error('RESALE_SETTLEMENT_INVALID_REASON');
  }
}

function numberValue(value: number | string | bigint | null, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ResaleSettlementConflictError(`RESALE_SETTLEMENT_INVALID_STORED_${field}`);
  }
  return parsed;
}

function matchesEntry(
  row: Selectable<ResaleSettlementEntryTable>,
  input: EntryEvidence & {
    kind: ResaleSettlementEntryKind;
    amountCents: number;
    currency: string;
  },
): boolean {
  return (
    row.kind === input.kind &&
    numberValue(row.amount_cents, 'ENTRY_AMOUNT') === input.amountCents &&
    row.currency === input.currency &&
    row.actor_id === input.actorId &&
    row.method === input.method &&
    row.external_reference_sha256 === (input.externalReferenceSha256 ?? null) &&
    row.reason === (input.reason ?? null)
  );
}

export class ResaleSettlementRepository {
  constructor(private readonly db: Database) {}

  async findExact(scope: SettlementScope): Promise<Selectable<ResaleSettlementTable> | undefined> {
    return this.db
      .selectFrom('resale_settlements')
      .selectAll()
      .where('tenant_id', '=', scope.tenantId)
      .where('organization_id', '=', scope.organizationId)
      .where('brand_id', '=', scope.brandId)
      .where('event_id', '=', scope.eventId)
      .where('listing_id', '=', scope.listingId)
      .executeTakeFirst();
  }

  async lockExact(scope: SettlementScope): Promise<Selectable<ResaleSettlementTable> | undefined> {
    assertTransactionOwned(this.db);
    return this.db
      .selectFrom('resale_settlements')
      .selectAll()
      .where('tenant_id', '=', scope.tenantId)
      .where('organization_id', '=', scope.organizationId)
      .where('brand_id', '=', scope.brandId)
      .where('event_id', '=', scope.eventId)
      .where('listing_id', '=', scope.listingId)
      .forUpdate()
      .executeTakeFirst();
  }

  async listEntriesExact(
    scope: SettlementScope,
  ): Promise<Selectable<ResaleSettlementEntryTable>[]> {
    return this.db
      .selectFrom('resale_settlement_entries as entry')
      .innerJoin('resale_settlements as settlement', (join) =>
        join
          .onRef('settlement.id', '=', 'entry.settlement_id')
          .onRef('settlement.tenant_id', '=', 'entry.tenant_id'),
      )
      .selectAll('entry')
      .where('settlement.tenant_id', '=', scope.tenantId)
      .where('settlement.organization_id', '=', scope.organizationId)
      .where('settlement.brand_id', '=', scope.brandId)
      .where('settlement.event_id', '=', scope.eventId)
      .where('settlement.listing_id', '=', scope.listingId)
      .orderBy('entry.created_at', 'asc')
      .orderBy('entry.id', 'asc')
      .execute();
  }

  async createAndAccrue(
    input: SettlementScope & {
      sellerOrderId: string;
      buyerOrderId: string;
      sellerTicketId: string;
      buyerTicketId: string;
      currency: string;
      grossCents: number;
      feeCents: number;
      payableCents: number;
      termsVersion: string;
      evidence: EntryEvidence;
    },
  ): Promise<Selectable<ResaleSettlementTable>> {
    assertCurrency(input.currency);
    assertSafeCents(input.grossCents, 'gross_cents');
    assertSafeCents(input.feeCents, 'fee_cents');
    assertSafeCents(input.payableCents, 'payable_cents', false);
    if (input.feeCents + input.payableCents !== input.grossCents) {
      throw new Error('RESALE_SETTLEMENT_MONEY_MISMATCH');
    }
    if (!input.termsVersion || input.termsVersion.length > 64) {
      throw new Error('RESALE_SETTLEMENT_INVALID_TERMS_VERSION');
    }
    assertEvidence(input.evidence);
    assertTransactionOwned(this.db);

    const event = await this.db
      .selectFrom('events')
      .select('id')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('brand_id', '=', input.brandId)
      .where('id', '=', input.eventId)
      .forUpdate()
      .executeTakeFirst();
    if (!event) throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_EVENT_NOT_FOUND');

    const listing = await this.db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('event_id', '=', input.eventId)
      .where('id', '=', input.listingId)
      .forUpdate()
      .executeTakeFirst();
    if (!listing) throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_LISTING_NOT_FOUND');

    const existing = await this.lockExact(input);
    if (existing) {
      const entry = await this.findEntryByIdempotency(
        existing.id,
        input.tenantId,
        input.evidence.idempotencyKey,
      );
      if (
        existing.seller_order_id !== input.sellerOrderId ||
        existing.buyer_order_id !== input.buyerOrderId ||
        existing.seller_ticket_id !== input.sellerTicketId ||
        existing.buyer_ticket_id !== input.buyerTicketId ||
        existing.currency !== input.currency ||
        numberValue(existing.gross_cents, 'GROSS_CENTS') !== input.grossCents ||
        numberValue(existing.fee_cents, 'FEE_CENTS') !== input.feeCents ||
        numberValue(existing.payable_cents, 'PAYABLE_CENTS') !== input.payableCents ||
        existing.terms_version !== input.termsVersion ||
        !entry ||
        !matchesEntry(entry, {
          ...input.evidence,
          kind: 'payable_accrued',
          amountCents: input.payableCents,
          currency: input.currency,
        })
      ) {
        throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_IDEMPOTENCY_CONFLICT');
      }
      return existing;
    }

    if (
      listing.status !== 'sold' ||
      listing.ticket_id !== input.sellerTicketId ||
      listing.seller_id !== input.sellerOrderId ||
      listing.sold_to_id !== input.buyerOrderId ||
      listing.seller_terms_version !== input.termsVersion ||
      listing.settlement_model !== 'organizer_managed' ||
      listing.refund_model !== 'manual_coordinated_resolution'
    ) {
      throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_LISTING_NOT_ELIGIBLE');
    }

    const sellerOrder = await this.findScopedOrder(input.sellerOrderId, input);
    const buyerOrder = await this.findScopedOrder(input.buyerOrderId, input);
    const sellerTicket = await this.findScopedTicket(
      input.sellerTicketId,
      input.sellerOrderId,
      input,
    );
    const buyerTicket = await this.findScopedTicket(input.buyerTicketId, input.buyerOrderId, input);
    if (!sellerOrder || !buyerOrder || !sellerTicket || !buyerTicket) {
      throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_REFERENCES_NOT_IN_SCOPE');
    }

    const now = new Date();
    const settlementId = `rst_${ulid()}`;
    await this.db
      .insertInto('resale_settlements')
      .values({
        id: settlementId,
        listing_id: input.listingId,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId,
        event_id: input.eventId,
        seller_order_id: input.sellerOrderId,
        buyer_order_id: input.buyerOrderId,
        seller_ticket_id: input.sellerTicketId,
        buyer_ticket_id: input.buyerTicketId,
        currency: input.currency,
        gross_cents: input.grossCents,
        fee_cents: input.feeCents,
        payable_cents: input.payableCents,
        paid_cents: 0,
        reversed_cents: 0,
        recovery_cents: 0,
        state: 'pending',
        terms_version: input.termsVersion,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.insertEntry(
      settlementId,
      input.tenantId,
      'payable_accrued',
      input.payableCents,
      input.currency,
      input.evidence,
      now,
    );
    return (await this.lockExact(input))!;
  }

  async recordPayout(
    input: SettlementScope & {
      amountCents: number;
      currency: string;
      expectedVersion: number;
      evidence: EntryEvidence & { externalReferenceSha256: string };
    },
  ): Promise<Selectable<ResaleSettlementTable>> {
    return this.transition(input, 'payout');
  }

  async recordReversal(
    input: SettlementScope & {
      amountCents: number;
      currency: string;
      expectedVersion: number;
      evidence: EntryEvidence;
    },
  ): Promise<Selectable<ResaleSettlementTable>> {
    return this.transition(input, 'reversal');
  }

  private async transition(
    input: SettlementScope & {
      amountCents: number;
      currency: string;
      expectedVersion: number;
      evidence: EntryEvidence;
    },
    operation: 'payout' | 'reversal',
  ): Promise<Selectable<ResaleSettlementTable>> {
    assertCurrency(input.currency);
    assertSafeCents(input.amountCents, 'amount_cents', false);
    assertEvidence(input.evidence);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('RESALE_SETTLEMENT_INVALID_EXPECTED_VERSION');
    }
    assertTransactionOwned(this.db);

    const settlement = await this.lockExact(input);
    if (!settlement) throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_NOT_FOUND');
    if (settlement.currency !== input.currency) {
      throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_CURRENCY_MISMATCH');
    }

    const payable = numberValue(settlement.payable_cents, 'PAYABLE_CENTS');
    const paid = numberValue(settlement.paid_cents, 'PAID_CENTS');
    const reversed = numberValue(settlement.reversed_cents, 'REVERSED_CENTS');
    const recovery = numberValue(settlement.recovery_cents, 'RECOVERY_CENTS');
    const kind: ResaleSettlementEntryKind =
      operation === 'payout'
        ? 'payout_recorded'
        : paid > 0
          ? 'recovery_required'
          : 'payable_reversed';
    const priorEntry = await this.findEntryByIdempotency(
      settlement.id,
      input.tenantId,
      input.evidence.idempotencyKey,
    );
    if (priorEntry) {
      if (
        !matchesEntry(priorEntry, {
          ...input.evidence,
          kind,
          amountCents: input.amountCents,
          currency: input.currency,
        })
      ) {
        throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_IDEMPOTENCY_CONFLICT');
      }
      return settlement;
    }
    if (numberValue(settlement.version, 'VERSION') !== input.expectedVersion) {
      throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_VERSION_CONFLICT');
    }

    let state: ResaleSettlementState;
    let values: {
      paid_cents?: number;
      reversed_cents?: number;
      recovery_cents?: number;
    };
    if (operation === 'payout') {
      if (
        settlement.state !== 'pending' ||
        paid !== 0 ||
        input.amountCents !== payable - reversed
      ) {
        throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_INVALID_PAYOUT_TRANSITION');
      }
      state = 'paid';
      values = { paid_cents: input.amountCents };
    } else {
      if (!['pending', 'paid', 'recovery_required'].includes(settlement.state)) {
        throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_INVALID_REVERSAL_TRANSITION');
      }
      if (input.amountCents > payable - reversed) {
        throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_REVERSAL_EXCEEDS_PAYABLE');
      }
      if (paid === 0 && input.amountCents !== payable - reversed) {
        throw new ResaleSettlementConflictError(
          'RESALE_SETTLEMENT_PARTIAL_UNPAID_REVERSAL_UNSUPPORTED',
        );
      }
      state = paid > 0 ? 'recovery_required' : 'reversed';
      values = {
        reversed_cents: reversed + input.amountCents,
        recovery_cents: paid > 0 ? recovery + input.amountCents : recovery,
      };
    }

    const now = new Date();
    const result = await this.db
      .updateTable('resale_settlements')
      .set({ ...values, state, version: input.expectedVersion + 1, updated_at: now })
      .where('id', '=', settlement.id)
      .where('tenant_id', '=', input.tenantId)
      .where('version', '=', input.expectedVersion)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) !== 1) {
      throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_VERSION_CONFLICT');
    }
    await this.insertEntry(
      settlement.id,
      input.tenantId,
      kind,
      input.amountCents,
      input.currency,
      input.evidence,
      now,
    );
    return (await this.lockExact(input))!;
  }

  private async findEntryByIdempotency(
    settlementId: string,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Selectable<ResaleSettlementEntryTable> | undefined> {
    return this.db
      .selectFrom('resale_settlement_entries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('settlement_id', '=', settlementId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  private async findScopedOrder(orderId: string, scope: SettlementScope) {
    return this.db
      .selectFrom('orders')
      .select('id')
      .where('id', '=', orderId)
      .where('tenant_id', '=', scope.tenantId)
      .where('organization_id', '=', scope.organizationId)
      .where('brand_id', '=', scope.brandId)
      .where('event_id', '=', scope.eventId)
      .executeTakeFirst();
  }

  private async findScopedTicket(ticketId: string, orderId: string, scope: SettlementScope) {
    return this.db
      .selectFrom('tickets')
      .select('id')
      .where('id', '=', ticketId)
      .where('tenant_id', '=', scope.tenantId)
      .where('event_id', '=', scope.eventId)
      .where('order_id', '=', orderId)
      .executeTakeFirst();
  }

  private async insertEntry(
    settlementId: string,
    tenantId: string,
    kind: ResaleSettlementEntryKind,
    amountCents: number,
    currency: string,
    evidence: EntryEvidence,
    createdAt: Date,
  ): Promise<void> {
    await this.db
      .insertInto('resale_settlement_entries')
      .values({
        id: `rse_${ulid()}`,
        settlement_id: settlementId,
        tenant_id: tenantId,
        kind,
        amount_cents: amountCents,
        currency,
        idempotency_key: evidence.idempotencyKey,
        actor_id: evidence.actorId,
        method: evidence.method,
        external_reference_sha256: evidence.externalReferenceSha256 ?? null,
        reason: evidence.reason ?? null,
        created_at: createdAt,
      })
      .execute();
  }
}
