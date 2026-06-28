import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockRow = Record<string, any>;

const dbState = {
  tables: {} as Record<string, MockRow[]>,
  destroy: vi.fn(),
};

function getRows(table: string): MockRow[] {
  dbState.tables[table] ??= [];
  return dbState.tables[table];
}

function matches(row: MockRow, filters: Array<{ col: string; op: string; val: any }>): boolean {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.op === '<') return new Date(value) < new Date(filter.val);
    if (filter.op === 'is') return filter.val === null ? value == null : value === filter.val;
    return value === filter.val;
  });
}

vi.mock('@tixkit/db', () => {
  const db = {
    updateTable: (table: string) => {
      const filters: Array<{ col: string; op: string; val: any }> = [];
      let updates: MockRow = {};
      const query = {
        set(values: MockRow) {
          updates = values;
          return query;
        },
        where(col: string, op: string, val: any) {
          filters.push({ col, op, val });
          return query;
        },
        async execute() {
          let updatedCount = 0;
          for (const row of getRows(table)) {
            if (!matches(row, filters)) continue;
            Object.assign(row, updates);
            updatedCount += 1;
          }
          return [{ numUpdatedRows: BigInt(updatedCount) }];
        },
      };
      return query;
    },
    destroy: dbState.destroy,
  };

  return {
    createDb: () => db,
    EmailJobRepository: class {
      async create() {
        return undefined;
      }
    },
  };
});

const { expireStaleSessionsActivity } = await import('../activities/hold-expiration.js');

describe('expireStaleSessionsActivity', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.destroy.mockClear();
  });

  it('does not expire open checkout sessions that already have a payment intent', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    dbState.tables.checkout_sessions = [
      { id: 'cs_payment_owned', status: 'open', expires_at: past, payment_intent_id: 'pi_1' },
      { id: 'cs_stale_open', status: 'open', expires_at: past, payment_intent_id: null },
      { id: 'cs_fresh_open', status: 'open', expires_at: future, payment_intent_id: null },
    ];

    const result = await expireStaleSessionsActivity();

    expect(result).toEqual({ ok: true, value: { expiredCount: 1 } });
    expect(dbState.tables.checkout_sessions[0].status).toBe('open');
    expect(dbState.tables.checkout_sessions[1].status).toBe('expired');
    expect(dbState.tables.checkout_sessions[2].status).toBe('open');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});
