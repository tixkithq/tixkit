import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { TixkitMigrationProvider } from '../../migrate.js';
import { ResaleSettlementRepository } from '../../repositories/resale-settlement.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(here, '../../migrations/0089_resale_settlements.ts');
const repositoryPath = resolve(here, '../../repositories/resale-settlement.ts');

type Condition = [column: string, value: unknown];

function scopedReadDb(row?: Record<string, unknown>) {
  const conditions: Condition[] = [];
  const query = {
    selectAll: () => query,
    where(column: string, _operator: string, value: unknown) {
      conditions.push([column, value]);
      return query;
    },
    executeTakeFirst: async () => row,
  };
  return {
    conditions,
    db: { selectFrom: () => query } as unknown as Database,
  };
}

function mutationDb(models: { settlement: string | null; refund: string | null }) {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    events: [{ id: 'evt_1', tenant_id: 'ten_1', organization_id: 'org_1', brand_id: 'brd_1' }],
    ticket_listings: [
      {
        id: 'lst_1',
        tenant_id: 'ten_1',
        event_id: 'evt_1',
        ticket_id: 'tkt_seller',
        seller_id: 'ord_seller',
        sold_to_id: 'ord_buyer',
        status: 'sold',
        seller_terms_version: 'resale-terms-v1',
        settlement_model: models.settlement,
        refund_model: models.refund,
      },
    ],
    orders: [
      {
        id: 'ord_seller',
        tenant_id: 'ten_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'ord_buyer',
        tenant_id: 'ten_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
    ],
    tickets: [
      {
        id: 'tkt_seller',
        tenant_id: 'ten_1',
        event_id: 'evt_1',
        order_id: 'ord_seller',
      },
      {
        id: 'tkt_buyer',
        tenant_id: 'ten_1',
        event_id: 'evt_1',
        order_id: 'ord_buyer',
      },
    ],
    resale_settlements: [],
    resale_settlement_entries: [],
  };
  const db = {
    isTransaction: true,
    selectFrom(table: string) {
      const conditions: Condition[] = [];
      const query = {
        select: () => query,
        selectAll: () => query,
        where(column: string, _operator: string, value: unknown) {
          conditions.push([column, value]);
          return query;
        },
        forUpdate: () => query,
        executeTakeFirst: async () =>
          rows[table]?.find((row) => conditions.every(([column, value]) => row[column] === value)),
      };
      return query;
    },
    insertInto(table: string) {
      return {
        values(value: Record<string, unknown>) {
          return {
            execute: async () => {
              rows[table]!.push(value);
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Database, rows };
}

describe('resale settlement persistence contract', () => {
  const scope = {
    tenantId: 'ten_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    eventId: 'evt_1',
    listingId: 'lst_1',
  };

  it('registers the settlement migration after the existing migration chain', async () => {
    const migrations = await new TixkitMigrationProvider().getMigrations();
    expect(Object.keys(migrations).at(-1)).toBe('0090_webhook_replay_requests');
    expect(migrations).toHaveProperty('0089_resale_settlements');
  });

  it('binds reads to the complete tenant, organization, brand, event, and listing scope', async () => {
    const { db, conditions } = scopedReadDb();
    await new ResaleSettlementRepository(db).findExact(scope);
    expect(conditions).toEqual([
      ['tenant_id', 'ten_1'],
      ['organization_id', 'org_1'],
      ['brand_id', 'brd_1'],
      ['event_id', 'evt_1'],
      ['listing_id', 'lst_1'],
    ]);
  });

  it('rejects un-hashed provider references before opening a transaction', async () => {
    const db = {
      transaction: () => {
        throw new Error('transaction must not be reached');
      },
    } as unknown as Database;
    const repository = new ResaleSettlementRepository(db);

    await expect(
      repository.recordPayout({
        ...scope,
        amountCents: 100,
        currency: 'USD',
        expectedVersion: 1,
        evidence: {
          idempotencyKey: 'payout-1',
          actorId: 'system:payout-worker',
          method: 'stripe-connect',
          externalReferenceSha256: 'po_provider_raw_identifier',
        },
      }),
    ).rejects.toThrow('RESALE_SETTLEMENT_EXTERNAL_REFERENCE_MUST_BE_SHA256');
  });

  it('requires transaction ownership for settlement row locks', async () => {
    const repository = new ResaleSettlementRepository({} as Database);
    await expect(repository.lockExact(scope)).rejects.toThrow(
      'RESALE_SETTLEMENT_TRANSACTION_REQUIRED',
    );
  });

  it('requires caller-owned transactions for accrual, payout, and reversal mutations', async () => {
    const repository = new ResaleSettlementRepository({} as Database);
    const evidence = {
      idempotencyKey: 'operation-1',
      actorId: 'system:settlement-worker',
      method: 'organizer-managed',
    };

    await expect(
      repository.createAndAccrue({
        ...scope,
        sellerOrderId: 'ord_seller',
        buyerOrderId: 'ord_buyer',
        sellerTicketId: 'tkt_seller',
        buyerTicketId: 'tkt_buyer',
        currency: 'USD',
        grossCents: 1_000,
        feeCents: 100,
        payableCents: 900,
        termsVersion: 'resale-terms-v1',
        evidence,
      }),
    ).rejects.toThrow('RESALE_SETTLEMENT_TRANSACTION_REQUIRED');
    await expect(
      repository.recordPayout({
        ...scope,
        amountCents: 900,
        currency: 'USD',
        expectedVersion: 1,
        evidence: { ...evidence, externalReferenceSha256: 'a'.repeat(64) },
      }),
    ).rejects.toThrow('RESALE_SETTLEMENT_TRANSACTION_REQUIRED');
    await expect(
      repository.recordReversal({
        ...scope,
        amountCents: 900,
        currency: 'USD',
        expectedVersion: 1,
        evidence,
      }),
    ).rejects.toThrow('RESALE_SETTLEMENT_TRANSACTION_REQUIRED');
  });

  it('defines append-only entries, constrained states, and review-only legacy backfill', () => {
    const source = readFileSync(migrationPath, 'utf8');
    expect(source).toContain(
      "state in ('pending', 'paid', 'reversed', 'recovery_required', 'review_required')",
    );
    expect(source).toContain(
      "kind in ('payable_accrued', 'payout_recorded', 'payable_reversed', 'recovery_required')",
    );
    expect(source).toContain('resale_settlement_entries_amount_positive');
    expect(source).toContain('resale_settlement_entries_idempotency_unique');
    expect(source).toContain('resale_settlements_state_money_consistent');
    expect(source).toContain("state = 'paid' and paid_cents = payable_cents");
    expect(source).toContain(
      "state = 'recovery_required' and paid_cents = payable_cents and reversed_cents > 0",
    );
    expect(source).toContain("where l.status = 'sold'");
    expect(source).toContain("l.price_cents, 'review_required', null");
    expect(source).toContain('resale settlement entries are immutable');
    expect(source).not.toMatch(/external_reference(?!_sha256)/);
  });

  it('keeps legacy listing policy fields nullable for explicit runtime adoption', () => {
    const source = readFileSync(migrationPath, 'utf8');
    expect(source).toContain("addColumn('seller_terms_version', 'varchar(64)')");
    expect(source).toContain("addColumn('settlement_model', 'varchar(32)')");
    expect(source).toContain("addColumn('refund_model', 'varchar(32)')");
  });

  it('admits only the accepted organizer-managed settlement and refund models', () => {
    const source = readFileSync(repositoryPath, 'utf8');
    expect(source).toContain("listing.settlement_model !== 'organizer_managed'");
    expect(source).toContain("listing.refund_model !== 'manual_coordinated_resolution'");
  });

  it('rejects non-canonical listing models and accrues canonical listings atomically', async () => {
    const input = {
      ...scope,
      sellerOrderId: 'ord_seller',
      buyerOrderId: 'ord_buyer',
      sellerTicketId: 'tkt_seller',
      buyerTicketId: 'tkt_buyer',
      currency: 'USD',
      grossCents: 1_000,
      feeCents: 100,
      payableCents: 900,
      termsVersion: 'resale-terms-v1',
      evidence: {
        idempotencyKey: 'accrual-1',
        actorId: 'system:checkout',
        method: 'checkout-finalization',
      },
    };
    const rejected = mutationDb({
      settlement: 'provider_managed',
      refund: 'automatic',
    });
    await expect(
      new ResaleSettlementRepository(rejected.db).createAndAccrue(input),
    ).rejects.toThrow('RESALE_SETTLEMENT_LISTING_NOT_ELIGIBLE');
    expect(rejected.rows.resale_settlements).toHaveLength(0);

    const accepted = mutationDb({
      settlement: 'organizer_managed',
      refund: 'manual_coordinated_resolution',
    });
    const settlement = await new ResaleSettlementRepository(accepted.db).createAndAccrue(input);
    expect(settlement).toMatchObject({
      listing_id: 'lst_1',
      state: 'pending',
      gross_cents: 1_000,
      fee_cents: 100,
      payable_cents: 900,
      version: 1,
    });
    expect(accepted.rows.resale_settlement_entries).toEqual([
      expect.objectContaining({
        settlement_id: settlement.id,
        kind: 'payable_accrued',
        amount_cents: 900,
        idempotency_key: 'accrual-1',
        external_reference_sha256: null,
      }),
    ]);
  });
});
