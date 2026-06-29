import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../../app.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const now = new Date('2026-06-29T12:00:00.000Z');
const defaultQuote = {
  currency: 'USD',
  subtotalCents: 2500,
  discountCents: 0,
  taxCents: 0,
  feeCents: 0,
  totalCents: 2500,
  lineItems: [
    {
      type: 'ticket',
      ticketTypeId: 'tt_ga',
      name: 'General Admission',
      quantity: 1,
      unitPriceCents: 2500,
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
    },
  ],
};

function getColumn(row: Row, column: string) {
  return row[column] ?? row[column.split('.').at(-1) ?? column];
}

function matches(row: Row, filters: Array<[string, string, unknown]>) {
  return filters.every(([column, op, value]) => {
    const actual = getColumn(row, column);
    if (op === '=') return actual === value;
    if (op === '!=') return actual !== value;
    if (op === 'in' && Array.isArray(value)) return value.includes(actual);
    return true;
  });
}

function createMockDb(tables: Tables): unknown {
  const rowsFor = (table: string) => tables[table] ?? (tables[table] = []);

  function createSelect(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    const query = {
      select: () => query,
      selectAll: () => query,
      innerJoin: () => query,
      orderBy: () => query,
      limit: () => query,
      forUpdate: () => query,
      where: (...args: unknown[]) => {
        if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          filters.push([args[0], args[1], args[2]]);
        }
        return query;
      },
      rows: () => rowsFor(table).filter((row) => matches(row, filters)),
      execute: async () => query.rows(),
      executeTakeFirst: async () => query.rows()[0],
      executeTakeFirstOrThrow: async () => {
        const row = query.rows()[0];
        if (!row) throw new Error(`No row for ${table}`);
        return row;
      },
    };
    return query;
  }

  function createInsert(table: string) {
    return {
      values: (values: Row) => {
        const row = { ...values };
        const insert = async () => {
          rowsFor(table).push(row);
          return row;
        };
        return {
          execute: async () => {
            await insert();
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: insert,
          }),
        };
      },
    };
  }

  function createUpdate(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let updateValues: Row = {};
    const query = {
      set: (values: Row) => {
        updateValues = values;
        return query;
      },
      where: (...args: unknown[]) => {
        if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          filters.push([args[0], args[1], args[2]]);
        }
        return query;
      },
      execute: async () => {
        for (const row of rowsFor(table).filter((candidate) => matches(candidate, filters))) {
          Object.assign(row, updateValues);
        }
        return [];
      },
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => {
          const row = rowsFor(table).find((candidate) => matches(candidate, filters));
          if (!row) throw new Error(`No row for update ${table}`);
          Object.assign(row, updateValues);
          return row;
        },
      }),
    };
    return query;
  }

  return {
    selectFrom: createSelect,
    insertInto: createInsert,
    updateTable: createUpdate,
    deleteFrom: () => ({ where: () => ({ execute: async () => {} }) }),
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(createMockDb(tables)),
    }),
    destroy: vi.fn(),
  };
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_box',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read', 'orders.read', 'orders.write'],
    ...overrides,
  };
}

function boxOfficeOrderRow(overrides: Row = {}): Row {
  return {
    id: 'ord_box',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    event_id: 'evt_box',
    checkout_session_id: 'cs_existing',
    order_number: 'TK-BOX',
    status: 'paid',
    currency: 'USD',
    subtotal_cents: 2500,
    discount_cents: 0,
    tax_cents: 0,
    fee_cents: 0,
    total_cents: 2500,
    refunded_cents: 0,
    buyer_email: 'door@example.com',
    buyer_first_name: 'Door',
    buyer_last_name: 'Buyer',
    buyer_phone: null,
    payment_intent_id: null,
    payment_provider: null,
    sales_channel: 'box_office',
    operator_id: 'usr_box',
    tender_type: 'cash',
    paid_at: now,
    refunded_at: null,
    cancelled_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function baseTables(overrides: Tables = {}): Tables {
  return {
    events: [
      {
        id: 'evt_box',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        status: 'published',
        visibility: 'private',
        currency: 'USD',
      },
    ],
    ticket_types: [
      {
        id: 'tt_ga',
        event_id: 'evt_box',
        inventory_pool_id: 'pool_1',
        event_occurrence_id: null,
        name: 'General Admission',
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        price_cents: 2500,
        minimum_price_cents: null,
        currency: 'USD',
        min_per_order: 1,
        max_per_order: 10,
        sales_start_at: null,
        sales_end_at: null,
        requires_access_code: false,
      },
    ],
    event_occurrences: [],
    questions: [],
    discount_codes: [],
    tax_rules: [],
    fee_rules: [],
    checkout_sessions: [],
    idempotency_records: [],
    orders: [boxOfficeOrderRow()],
    ...overrides,
  };
}

async function setupApp(input: {
  tables: Tables;
  principal?: Principal;
  reserveCart?: ReturnType<typeof vi.fn>;
  startCheckoutSession?: ReturnType<typeof vi.fn>;
  quote?: typeof defaultQuote;
}) {
  const app = Fastify();
  const reserveCart =
    input.reserveCart ??
    vi.fn(async () => ({ primaryHoldId: 'hld_box', expiresAt: new Date(Date.now() + 600_000) }));
  const startCheckoutSession =
    input.startCheckoutSession ??
    vi.fn(async () => ({
      workflowId: 'checkout-session:cs_box',
      result: async () => ({ status: 'completed', orderId: 'ord_box' }),
    }));
  app.decorate('context', {
    db: createMockDb(input.tables) as Database,
    pricingEngine: {
      calculate: vi.fn(() => input.quote ?? defaultQuote),
    },
    inventoryService: { reserveCart },
    temporalClient: { startCheckoutSession },
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = input.principal ?? makePrincipal();
  });
  await app.register(checkoutRoutes);
  return { app, reserveCart, startCheckoutSession };
}

describe('box-office order route', () => {
  it('creates an offline cash order through the checkout workflow with POS attribution', async () => {
    const tables = baseTables();
    const { app, reserveCart, startCheckoutSession } = await setupApp({ tables });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_cash_1' },
      payload: {
        tenderType: 'cash',
        amountCents: 2500,
        buyer: { email: 'door@example.com', firstName: 'Door', lastName: 'Buyer' },
        items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      order: {
        id: 'ord_box',
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'cash',
      },
      status: 'completed',
    });
    expect(reserveCart).toHaveBeenCalledWith({
      checkoutSessionId: expect.stringMatching(/^cs_/),
      items: [{ inventoryPoolId: 'pool_1', ticketTypeId: 'tt_ga', quantity: 1 }],
    });
    expect(startCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMode: 'offline',
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'cash',
        amountCents: 2500,
      }),
    );
  });

  it('creates a comp order with a zeroed server quote and free payment mode', async () => {
    const tables = baseTables({
      orders: [
        boxOfficeOrderRow({
          subtotal_cents: 0,
          total_cents: 0,
          tender_type: 'comp',
        }),
      ],
    });
    const { app, reserveCart, startCheckoutSession } = await setupApp({ tables });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_comp_1' },
      payload: {
        tenderType: 'comp',
        amountCents: 0,
        buyer: { email: 'guest@example.com', firstName: 'Guest' },
        items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      order: {
        id: 'ord_box',
        totalCents: 0,
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'comp',
      },
      status: 'completed',
    });
    expect(reserveCart).toHaveBeenCalledTimes(1);
    expect(startCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 0,
        isFreeOrder: true,
        paymentMode: 'free',
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'comp',
      }),
    );
    const storedQuote = JSON.parse(String(tables.checkout_sessions[0]?.quote));
    expect(storedQuote).toMatchObject({
      discountCents: 2500,
      totalCents: 0,
    });
  });

  it('creates a manual card-not-present order without a provider intent', async () => {
    const tables = baseTables({
      orders: [boxOfficeOrderRow({ tender_type: 'manual_card' })],
    });
    const { app, reserveCart, startCheckoutSession } = await setupApp({ tables });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_manual_1' },
      payload: {
        tenderType: 'manual_card',
        amountCents: 2500,
        buyer: { email: 'manual@example.com' },
        items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      order: {
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'manual_card',
      },
    });
    expect(reserveCart).toHaveBeenCalledTimes(1);
    expect(startCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 2500,
        isFreeOrder: false,
        paymentMode: 'offline',
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'manual_card',
      }),
    );
  });

  it('rejects a cash tender that does not match the server-priced total before reserving inventory', async () => {
    const tables = baseTables();
    const reserveCart = vi.fn();
    const { app, startCheckoutSession } = await setupApp({ tables, reserveCart });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_cash_mismatch' },
      payload: {
        tenderType: 'cash',
        amountCents: 2400,
        buyer: { email: 'door@example.com' },
        items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(reserveCart).not.toHaveBeenCalled();
    expect(startCheckoutSession).not.toHaveBeenCalled();
  });

  it('replays a completed box-office order for the same idempotency key without duplicate side effects', async () => {
    const tables = baseTables();
    const { app, reserveCart, startCheckoutSession } = await setupApp({ tables });
    const payload = {
      tenderType: 'cash',
      amountCents: 2500,
      buyer: { email: 'door@example.com', firstName: 'Door', lastName: 'Buyer' },
      items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_replay_1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_replay_1' },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(reserveCart).toHaveBeenCalledTimes(1);
    expect(startCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed before reserving inventory for a cross-tenant event', async () => {
    const tables = baseTables({
      events: [
        {
          id: 'evt_box',
          tenant_id: 'tnt_other',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          visibility: 'private',
          currency: 'USD',
        },
      ],
    });
    const reserveCart = vi.fn();
    const { app, startCheckoutSession } = await setupApp({ tables, reserveCart });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_box/box-office/orders',
      headers: { 'idempotency-key': 'box_cross_tenant' },
      payload: {
        tenderType: 'cash',
        amountCents: 2500,
        items: [{ ticketTypeId: 'tt_ga', quantity: 1 }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(reserveCart).not.toHaveBeenCalled();
    expect(startCheckoutSession).not.toHaveBeenCalled();
  });
});
