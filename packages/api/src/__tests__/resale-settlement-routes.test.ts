import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventRepository,
  ResaleSettlementConflictError,
  ResaleSettlementRepository,
  TicketListingRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../app.js';
import { registerErrorHandler } from '../app.js';
import { ticketingRoutes } from '../routes/modules/ticketing.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
}));

vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

const tenantId = 'tnt_resale_settlement';
const organizationId = 'org_resale_settlement';
const brandId = 'brd_resale_settlement';
const eventId = 'evt_resale_settlement';
const listingId = 'lst_resale_settlement';
const settlementId = 'rst_resale_settlement';
const payableCents = 8_500;
const createdAt = new Date('2026-07-16T12:00:00.000Z');

type SettlementRow = Record<string, unknown> & {
  id: string;
  listing_id: string;
  tenant_id: string;
  organization_id: string;
  brand_id: string;
  event_id: string;
  currency: string;
  payable_cents: number;
  paid_cents: number;
  reversed_cents: number;
  recovery_cents: number;
  state: string;
  version: number;
  updated_at: Date;
};

type EntryRow = Record<string, unknown> & {
  id: string;
  kind: string;
  amount_cents: number;
  currency: string;
  idempotency_key: string;
  actor_id: string;
  method: string;
  external_reference_sha256: string | null;
  reason: string | null;
  created_at: Date;
};

type RouteState = {
  listing: Record<string, unknown> | undefined;
  event: Record<string, unknown> | undefined;
  settlement: SettlementRow;
  entries: EntryRow[];
  audits: Array<Record<string, unknown>>;
  failAudit: boolean;
};

let state: RouteState;
let transactionStart: ReturnType<typeof vi.fn>;

function initialState(): RouteState {
  return {
    listing: {
      id: listingId,
      tenant_id: tenantId,
      event_id: eventId,
    },
    event: {
      id: eventId,
      tenant_id: tenantId,
      organization_id: organizationId,
      brand_id: brandId,
    },
    settlement: {
      id: settlementId,
      listing_id: listingId,
      tenant_id: tenantId,
      organization_id: organizationId,
      brand_id: brandId,
      event_id: eventId,
      seller_order_id: 'ord_seller',
      buyer_order_id: 'ord_buyer',
      seller_ticket_id: 'tkt_seller',
      buyer_ticket_id: 'tkt_buyer',
      currency: 'USD',
      gross_cents: 10_000,
      fee_cents: 1_500,
      payable_cents: payableCents,
      paid_cents: 0,
      reversed_cents: 0,
      recovery_cents: 0,
      state: 'pending',
      terms_version: '2026-07-16',
      version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    },
    entries: [
      {
        id: 'rse_accrual',
        kind: 'payable_accrued',
        amount_cents: payableCents,
        currency: 'USD',
        idempotency_key: 'checkout-accrual',
        actor_id: 'system:checkout',
        method: 'checkout',
        external_reference_sha256: null,
        reason: null,
        created_at: createdAt,
      },
    ],
    audits: [],
    failAudit: false,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_billing_operator',
    tenantId,
    organizationIds: [organizationId],
    brandIds: [brandId],
    eventIds: [eventId],
    scopes: ['orders.read', 'billing.write'],
    ...overrides,
  };
}

function scopeMatches(input: Record<string, unknown>): boolean {
  return (
    input.tenantId === state.settlement.tenant_id &&
    input.organizationId === state.settlement.organization_id &&
    input.brandId === state.settlement.brand_id &&
    input.eventId === state.settlement.event_id &&
    input.listingId === state.settlement.listing_id
  );
}

function cloneMutableState() {
  return {
    settlement: { ...state.settlement },
    entries: state.entries.map((entry) => ({ ...entry })),
    audits: state.audits.map((audit) => ({ ...audit })),
  };
}

function createTransactionDatabase(): Database {
  transactionStart = vi.fn(() => ({
    execute: async <Result>(operation: (transaction: Database) => Promise<Result>) => {
      const snapshot = cloneMutableState();
      try {
        return await operation(database as unknown as Database);
      } catch (error) {
        state.settlement = snapshot.settlement;
        state.entries = snapshot.entries;
        state.audits = snapshot.audits;
        throw error;
      }
    },
  }));
  const database = {
    isTransaction: true,
    transaction: transactionStart,
  };
  return database as unknown as Database;
}

function findReplay(idempotencyKey: string): EntryRow | undefined {
  return state.entries.find((entry) => entry.idempotency_key === idempotencyKey);
}

function assertReplayMatches(replay: EntryRow, input: Record<string, unknown>, kind: string): void {
  const evidence = input.evidence as Record<string, unknown>;
  if (
    replay.kind !== kind ||
    replay.amount_cents !== input.amountCents ||
    replay.currency !== input.currency ||
    replay.actor_id !== evidence.actorId ||
    replay.method !== evidence.method ||
    replay.external_reference_sha256 !== (evidence.externalReferenceSha256 ?? null) ||
    replay.reason !== (evidence.reason ?? null)
  ) {
    throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_IDEMPOTENCY_CONFLICT');
  }
}

async function setupApp(activePrincipal: Principal = principal()): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('context', {
    db: createTransactionDatabase(),
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(ticketingRoutes);
  return app;
}

function payoutPayload(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: payableCents,
    currency: 'USD',
    expectedVersion: 1,
    method: 'bank_transfer',
    externalReference: 'bank-payout-sensitive-reference',
    ...overrides,
  };
}

function reversalPayload(overrides: Record<string, unknown> = {}) {
  return {
    amountCents: payableCents,
    currency: 'USD',
    expectedVersion: 1,
    method: 'accounting_adjustment',
    reason: 'Buyer refund coordinated with seller recovery',
    ...overrides,
  };
}

describe('resale settlement routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    state = initialState();

    vi.spyOn(TicketListingRepository.prototype, 'findById').mockImplementation(async () =>
      state.listing ? (state.listing as never) : undefined,
    );
    vi.spyOn(EventRepository.prototype, 'findById').mockImplementation(async () =>
      state.event ? (state.event as never) : undefined,
    );
    vi.spyOn(ResaleSettlementRepository.prototype, 'findExact').mockImplementation(async (scope) =>
      scopeMatches(scope) ? (state.settlement as never) : undefined,
    );
    vi.spyOn(ResaleSettlementRepository.prototype, 'lockExact').mockImplementation(async (scope) =>
      scopeMatches(scope) ? (state.settlement as never) : undefined,
    );
    vi.spyOn(ResaleSettlementRepository.prototype, 'listEntriesExact').mockImplementation(
      async (scope) => (scopeMatches(scope) ? (state.entries as never) : []),
    );
    vi.spyOn(ResaleSettlementRepository.prototype, 'recordPayout').mockImplementation(
      async (input) => {
        const evidence = input.evidence;
        const replay = findReplay(evidence.idempotencyKey);
        if (replay) {
          assertReplayMatches(replay, input, 'payout_recorded');
          return state.settlement as never;
        }
        if (state.settlement.version !== input.expectedVersion) {
          throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_VERSION_CONFLICT');
        }
        if (
          state.settlement.state !== 'pending' ||
          input.currency !== state.settlement.currency ||
          input.amountCents !== payableCents
        ) {
          throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_INVALID_PAYOUT_TRANSITION');
        }
        state.settlement = {
          ...state.settlement,
          paid_cents: input.amountCents,
          state: 'paid',
          version: input.expectedVersion + 1,
          updated_at: new Date('2026-07-16T12:01:00.000Z'),
        };
        state.entries.push({
          id: 'rse_payout',
          kind: 'payout_recorded',
          amount_cents: input.amountCents,
          currency: input.currency,
          idempotency_key: evidence.idempotencyKey,
          actor_id: evidence.actorId,
          method: evidence.method,
          external_reference_sha256: evidence.externalReferenceSha256,
          reason: null,
          created_at: state.settlement.updated_at,
        });
        return state.settlement as never;
      },
    );
    vi.spyOn(ResaleSettlementRepository.prototype, 'recordReversal').mockImplementation(
      async (input) => {
        const evidence = input.evidence;
        const replay = findReplay(evidence.idempotencyKey);
        const kind = state.settlement.paid_cents > 0 ? 'recovery_required' : 'payable_reversed';
        if (replay) {
          assertReplayMatches(replay, input, kind);
          return state.settlement as never;
        }
        if (state.settlement.version !== input.expectedVersion) {
          throw new ResaleSettlementConflictError('RESALE_SETTLEMENT_VERSION_CONFLICT');
        }
        state.settlement = {
          ...state.settlement,
          reversed_cents: state.settlement.reversed_cents + input.amountCents,
          recovery_cents:
            state.settlement.paid_cents > 0
              ? state.settlement.recovery_cents + input.amountCents
              : state.settlement.recovery_cents,
          state: state.settlement.paid_cents > 0 ? 'recovery_required' : 'reversed',
          version: input.expectedVersion + 1,
          updated_at: new Date('2026-07-16T12:02:00.000Z'),
        };
        state.entries.push({
          id: 'rse_reversal',
          kind,
          amount_cents: input.amountCents,
          currency: input.currency,
          idempotency_key: evidence.idempotencyKey,
          actor_id: evidence.actorId,
          method: evidence.method,
          external_reference_sha256: null,
          reason: evidence.reason ?? null,
          created_at: state.settlement.updated_at,
        });
        return state.settlement as never;
      },
    );

    writeAuditLog.mockImplementation(
      async (
        _repository: unknown,
        _request: unknown,
        _principal: unknown,
        audit: Record<string, unknown>,
      ) => {
        if (state.failAudit) throw new Error('audit unavailable');
        state.audits.push(structuredClone(audit));
      },
    );
  });

  it('returns a scoped settlement and its append-only entries', async () => {
    const app = await setupApp();
    const response = await app.inject({
      method: 'GET',
      url: `/ticket-listings/${listingId}/settlement`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: settlementId,
      listingId,
      payableCents,
      paidCents: 0,
      state: 'pending',
      version: 1,
      entries: [{ kind: 'payable_accrued', amountCents: payableCents }],
    });
    await app.close();
  });

  it.each([
    ['payout', 'payouts', payoutPayload()],
    ['reversal', 'reversals', reversalPayload()],
  ])(
    'denies %s before lookup, transaction, repository mutation, or audit',
    async (_operation, path, payload) => {
      const app = await setupApp(principal({ scopes: ['orders.read'] }));
      const response = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/settlement/${path}`,
        headers: { 'idempotency-key': `${_operation}-denied` },
        payload,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(TicketListingRepository.prototype.findById).not.toHaveBeenCalled();
      expect(transactionStart).not.toHaveBeenCalled();
      expect(ResaleSettlementRepository.prototype.recordPayout).not.toHaveBeenCalled();
      expect(ResaleSettlementRepository.prototype.recordReversal).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      expect(state.entries).toHaveLength(1);
      await app.close();
    },
  );

  it('denies settlement reads before lookup when orders.read is absent', async () => {
    const app = await setupApp(principal({ scopes: ['billing.write'] }));
    const response = await app.inject({
      method: 'GET',
      url: `/ticket-listings/${listingId}/settlement`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    expect(TicketListingRepository.prototype.findById).not.toHaveBeenCalled();
    expect(transactionStart).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['tenant', principal({ tenantId: 'tnt_unrelated' })],
    ['organization', principal({ organizationIds: ['org_unrelated'] })],
    ['brand', principal({ brandIds: ['brd_unrelated'] })],
    ['event', principal({ eventIds: ['evt_unrelated'] })],
  ])('conceals an out-of-scope %s as 404 without mutation', async (_boundary, deniedPrincipal) => {
    const app = await setupApp(deniedPrincipal);
    const response = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': `payout-denied-${_boundary}` },
      payload: payoutPayload(),
    });

    expect(response.statusCode).toBe(404);
    expect(transactionStart).not.toHaveBeenCalled();
    expect(ResaleSettlementRepository.prototype.recordPayout).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(state.entries).toHaveLength(1);
    await app.close();
  });

  it.each([
    ['tenant', principal({ tenantId: 'tnt_unrelated' })],
    ['organization', principal({ organizationIds: ['org_unrelated'] })],
    ['brand', principal({ brandIds: ['brd_unrelated'] })],
    ['event', principal({ eventIds: ['evt_unrelated'] })],
  ])('conceals an out-of-scope %s settlement read as 404', async (_boundary, deniedPrincipal) => {
    const app = await setupApp(deniedPrincipal);
    const response = await app.inject({
      method: 'GET',
      url: `/ticket-listings/${listingId}/settlement`,
    });

    expect(response.statusCode).toBe(404);
    expect(transactionStart).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['tenant', principal({ tenantId: 'tnt_unrelated' })],
    ['organization', principal({ organizationIds: ['org_unrelated'] })],
    ['brand', principal({ brandIds: ['brd_unrelated'] })],
    ['event', principal({ eventIds: ['evt_unrelated'] })],
  ])(
    'conceals an out-of-scope %s reversal as 404 without mutation',
    async (_boundary, deniedPrincipal) => {
      const app = await setupApp(deniedPrincipal);
      const response = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/settlement/reversals`,
        headers: { 'idempotency-key': `reversal-denied-${_boundary}` },
        payload: reversalPayload(),
      });

      expect(response.statusCode).toBe(404);
      expect(transactionStart).not.toHaveBeenCalled();
      expect(ResaleSettlementRepository.prototype.recordReversal).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      expect(state.entries).toHaveLength(1);
      await app.close();
    },
  );

  it('persists, audits, and returns only the SHA-256 payout evidence', async () => {
    const app = await setupApp();
    const rawReference = 'bank-payout-sensitive-reference';
    const expectedHash = createHash('sha256').update(rawReference, 'utf8').digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-hash-only' },
      payload: payoutPayload({ externalReference: rawReference }),
    });

    expect(response.statusCode).toBe(200);
    expect(state.entries.at(-1)).toMatchObject({
      kind: 'payout_recorded',
      external_reference_sha256: expectedHash,
    });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: 'resale.settlement.payout_recorded',
      diffSummary: { externalReferenceSha256: expectedHash },
    });
    const persistedAndReturned = JSON.stringify({ state, response: response.json() });
    expect(persistedAndReturned).not.toContain(rawReference);
    expect(response.json().entries.at(-1)).toMatchObject({
      kind: 'payout_recorded',
      externalReferenceSha256: expectedHash,
    });
    await app.close();
  });

  it('rolls back the payout entry and settlement transition when fail-closed audit fails', async () => {
    state.failAudit = true;
    const app = await setupApp();
    const response = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-audit-failure' },
      payload: payoutPayload(),
    });

    expect(response.statusCode).toBe(500);
    expect(state.settlement).toMatchObject({ state: 'pending', paid_cents: 0, version: 1 });
    expect(state.entries).toHaveLength(1);
    expect(state.audits).toHaveLength(0);
    await app.close();
  });

  it('replays the exact payout without another ledger entry or audit', async () => {
    const app = await setupApp();
    const request = {
      method: 'POST' as const,
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-replay' },
      payload: payoutPayload(),
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(state.entries.filter((entry) => entry.kind === 'payout_recorded')).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(replay.json()).toEqual(first.json());
    await app.close();
  });

  it('rejects a changed replay and an optimistic version conflict without mutation or audit', async () => {
    const app = await setupApp();
    const first = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-conflict' },
      payload: payoutPayload(),
    });
    const changedReplay = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-conflict' },
      payload: payoutPayload({ externalReference: 'different-reference' }),
    });
    const staleVersion = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-stale-version' },
      payload: payoutPayload({ expectedVersion: 1 }),
    });

    expect(first.statusCode).toBe(200);
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json().error.details.reason).toBe(
      'RESALE_SETTLEMENT_IDEMPOTENCY_CONFLICT',
    );
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json().error.details.reason).toBe('RESALE_SETTLEMENT_VERSION_CONFLICT');
    expect(state.entries.filter((entry) => entry.kind === 'payout_recorded')).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    await app.close();
  });

  it('records a paid-settlement reversal as recovery required', async () => {
    const app = await setupApp();
    const payout = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/payouts`,
      headers: { 'idempotency-key': 'payout-before-reversal' },
      payload: payoutPayload(),
    });
    const reversal = await app.inject({
      method: 'POST',
      url: `/ticket-listings/${listingId}/settlement/reversals`,
      headers: { 'idempotency-key': 'reversal-after-payout' },
      payload: {
        amountCents: payableCents,
        currency: 'USD',
        expectedVersion: 2,
        method: 'accounting_adjustment',
        reason: 'Buyer refund coordinated with seller recovery',
      },
    });

    expect(payout.statusCode).toBe(200);
    expect(reversal.statusCode).toBe(200);
    expect(reversal.json()).toMatchObject({
      state: 'recovery_required',
      paidCents: payableCents,
      reversedCents: payableCents,
      recoveryCents: payableCents,
      version: 3,
      entries: [
        { kind: 'payable_accrued' },
        { kind: 'payout_recorded' },
        {
          kind: 'recovery_required',
          reason: 'Buyer refund coordinated with seller recovery',
        },
      ],
    });
    expect(state.audits.at(-1)).toMatchObject({
      action: 'resale.settlement.reversal_recorded',
      diffSummary: { listingId, amountCents: payableCents },
    });
    await app.close();
  });

  it('rejects settlement idempotency keys that cannot fit the durable ledger', async () => {
    const app = await setupApp();
    for (const operation of ['payouts', 'reversals'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/ticket-listings/${listingId}/settlement/${operation}`,
        headers: { 'idempotency-key': 'x'.repeat(129) },
        payload:
          operation === 'payouts'
            ? payoutPayload()
            : {
                amountCents: payableCents,
                currency: 'USD',
                expectedVersion: 1,
                method: 'accounting_adjustment',
                reason: 'Buyer refund coordinated',
              },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(state.entries).toHaveLength(1);
    expect(state.audits).toHaveLength(0);
    await app.close();
  });
});
