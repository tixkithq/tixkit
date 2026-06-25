import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, any>>,
  locks: [] as string[],
  destroy: vi.fn(),
}));

function matches(row: Record<string, any>, filters: Array<{ col: string; op: string; val: any }>): boolean {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.op === '!=') return value !== filter.val;
    if (filter.op === '<') return new Date(value) < new Date(filter.val);
    return value === filter.val;
  });
}

function EmailJobRepository() {}
function OrderRepository() {}
function PaymentIntentRepository() {}

vi.mock('@gatekit/db', () => {
  function rowsFor(table: string): Record<string, any> {
    dbState.tables[table] ??= {};
    return dbState.tables[table];
  }

  function selectQuery(table: string) {
    const filters: Array<{ col: string; op: string; val: any }> = [];
    const query = {
      selectAll() {
        return query;
      },
      select() {
        return query;
      },
      where(col: string, op: string, val: any) {
        filters.push({ col, op, val });
        return query;
      },
      forUpdate() {
        dbState.locks.push(table);
        return query;
      },
      async execute() {
        return Object.values(rowsFor(table)).filter((row) => matches(row, filters));
      },
      async executeTakeFirst() {
        return (await query.execute())[0];
      },
      async executeTakeFirstOrThrow() {
        const row = await query.executeTakeFirst();
        if (!row) throw new Error(`${table} row not found`);
        return row;
      },
    };
    return query;
  }

  function updateQuery(table: string) {
    const filters: Array<{ col: string; op: string; val: any }> = [];
    let updates: Record<string, unknown> | ((eb: (col: string, op: string, value: unknown) => unknown) => Record<string, unknown>) = {};
    const query = {
      set(values: typeof updates) {
        updates = values;
        return query;
      },
      where(col: string, op: string, val: any) {
        filters.push({ col, op, val });
        return query;
      },
      async execute() {
        for (const row of Object.values(rowsFor(table))) {
          if (!matches(row, filters)) continue;
          const resolved =
            typeof updates === 'function'
              ? updates((col, op, value) => {
                  if (op === '+') return Number(row[col] ?? 0) + Number(value);
                  if (op === '-') return Number(row[col] ?? 0) - Number(value);
                  return value;
                })
              : updates;
          Object.assign(row, resolved);
        }
      },
    };
    return query;
  }

  function insertQuery(table: string) {
    let values: Record<string, any> = {};
    return {
      values(input: Record<string, any>) {
        values = input;
        return this;
      },
      async execute() {
        rowsFor(table)[values.id] = values;
      },
    };
  }

  const db = {
    selectFrom: selectQuery,
    updateTable: updateQuery,
    insertInto: insertQuery,
    transaction: () => ({
      execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
    }),
    destroy: dbState.destroy,
  };

  return {
    createDb: () => db,
    EmailJobRepository,
    OrderRepository,
    PaymentIntentRepository,
  };
});

const { finalizeOrderActivity } = await import('../activities/checkout.js');

describe('finalizeOrderActivity inventory holds', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.destroy.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
  });

  it('converts active unexpired holds after locking pools before holds', async () => {
    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
    });

    expect(result.ok).toBe(true);
    expect(Object.values(dbState.tables.orders)).toHaveLength(1);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('converted');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(1);
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('completed');
    expect(dbState.locks).toEqual(['inventory_pools', 'checkout_holds']);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('expires stale holds and fails before creating an order', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() - 60_000) });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOLD_EXPIRED',
      retryable: false,
    });
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('expired');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});

function seedCheckout(input: { holdExpiresAt: Date }) {
  dbState.tables = {
    orders: {},
    order_line_items: {},
    attendees: {},
    tickets: {},
    message_consents: {},
    order_timeline_events: {},
    checkout_sessions: {
      cs_1: {
        id: 'cs_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'pending',
        currency: 'USD',
        quote: JSON.stringify({
          subtotalCents: 1000,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 1000,
          lineItems: [
            {
              ticketTypeId: 'tt_1',
              name: 'General Admission',
              quantity: 1,
              unitPriceCents: 1000,
              subtotalCents: 1000,
              discountCents: 0,
              taxCents: 0,
              feeCents: 0,
              totalCents: 1000,
            },
          ],
        }),
        cart: JSON.stringify({
          items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
          buyerFields: {},
          attendeeFields: {},
        }),
        buyer: JSON.stringify({ email: 'buyer@example.test', firstName: 'Ada', lastName: 'Lovelace' }),
      },
    },
    events: {
      evt_1: {
        id: 'evt_1',
        organization_id: 'org_1',
      },
    },
    checkout_holds: {
      hld_1: {
        id: 'hld_1',
        checkout_session_id: 'cs_1',
        inventory_pool_id: 'pool_1',
        ticket_type_id: 'tt_1',
        quantity: 1,
        expires_at: input.holdExpiresAt,
        status: 'active',
      },
    },
    inventory_pools: {
      pool_1: {
        id: 'pool_1',
        sold_count: 0,
      },
    },
    questions: {},
    payment_intents: {},
    affiliates: {},
  };
}
