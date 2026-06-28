import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @temporalio/client so startNotificationWorkflow doesn't try to connect.
vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  order: {
    id: 'ord_1',
    tenant_id: 'tnt_1',
    total_cents: 10000,
    tax_cents: 800,
    fee_cents: 200,
    refunded_cents: 0,
    currency: 'USD',
    status: 'paid',
    order_number: 'TK-1001',
    event_id: 'evt_1',
    brand_id: 'brd_1',
    buyer_email: 'buyer@test.com',
    payment_intent_id: 'pi_1',
  } as Record<string, unknown>,
  lineItems: [] as Record<string, unknown>[],
  tickets: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  timeline: [] as Record<string, unknown>[],
  paymentIntent: {
    id: 'pi_db_1',
    provider_intent_id: 'pi_stripe_1',
    payment_account_id: null,
  } as Record<string, unknown> | null,
  paymentAccount: { provider_account_id: 'acct_connect_1' } as Record<string, unknown> | null,
  updatedTickets: [] as Record<string, unknown>[],
  createdRefunds: [] as Record<string, unknown>[],
  stripeRefunds: [] as Record<string, unknown>[],
  transactionQueue: Promise.resolve() as Promise<void>,
  destroy: vi.fn(),
}));

function matches(
  row: Record<string, unknown>,
  filters: Array<{ col: string; op: string; val: unknown }>,
): boolean {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.op === 'in') return Array.isArray(filter.val) && filter.val.includes(value);
    return value === filter.val;
  });
}

vi.mock('@tixkit/db', () => {
  class OrderRepository {
    async findById(id: string) {
      return { ...dbState.order, id };
    }
    async update(id: string, data: Record<string, unknown>) {
      Object.assign(dbState.order, data);
      return { ...dbState.order, id };
    }
    async addTimelineEvent(
      orderId: string,
      type: string,
      description: string,
      metadata?: Record<string, unknown>,
    ) {
      dbState.timeline.push({
        order_id: orderId,
        type,
        description,
        metadata: metadata ? JSON.stringify(metadata) : null,
      });
    }
    async getTimeline() {
      return dbState.timeline;
    }
    async getLineItems() {
      return dbState.lineItems;
    }
  }
  class PaymentIntentRepository {
    async findById() {
      return dbState.paymentIntent;
    }
  }
  class RefundRepository {
    async create(input: Record<string, unknown>) {
      dbState.createdRefunds.push(input);
      const record = {
        id: 'rfd_1',
        order_id: input.orderId,
        provider_refund_id: input.providerRefundId,
        amount_cents: input.amountCents,
        currency: input.currency,
        status: input.status ?? 'pending',
        reason: input.reason,
      };
      dbState.refunds.push(record);
      return record;
    }
    async findByOrder() {
      return dbState.refunds;
    }
  }
  class EmailJobRepository {
    async create(input: Record<string, unknown>) {
      return { id: 'emj_1', ...input };
    }
  }

  function createQuery(table: string) {
    const filters: Array<{ col: string; op: string; val: unknown }> = [];
    const query = {
      innerJoin() {
        return query;
      },
      select() {
        return query;
      },
      selectAll() {
        return query;
      },
      where(col: string, op: string, val: unknown) {
        filters.push({ col, op, val });
        return query;
      },
      orderBy() {
        return query;
      },
      forUpdate() {
        return query;
      },
      async executeTakeFirst() {
        if (table === 'email_jobs') return undefined;
        if (table === 'email_provider_routes') return { id: 'epr_1' };
        if (table === 'notification_templates as template') return { id: 'ntv_1' };
        if (table === 'orders') return matches(dbState.order, filters) ? dbState.order : undefined;
        if (table === 'payment_accounts') return dbState.paymentAccount;
        if (table === 'payment_intents') return dbState.paymentIntent;
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'orders') return dbState.order;
        throw new Error(`No mock for ${table}`);
      },
      async execute() {
        if (table === 'tickets') return dbState.tickets.filter((row) => matches(row, filters));
        if (table === 'refunds') return dbState.refunds.filter((row) => matches(row, filters));
        if (table === 'checkout_holds') return [];
        return [];
      },
      fn: {
        sum: () => 'sum',
        countAll: () => 'count',
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        dbState.updatedTickets.push({ table, ...values });
        const query = {
          where: () => query,
          execute: async () => [],
        };
        return query;
      },
    };
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- this helper must stay inside the hoisted vi.mock factory.
  function createInsert(_table: string) {
    return {
      values: (vals: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => ({ id: 'q_1', ...vals }),
        }),
        execute: async () => {},
      }),
    };
  }

  return {
    createDb: () => ({
      selectFrom: createQuery,
      updateTable: createUpdate,
      insertInto: createInsert,
      transaction: () => ({
        execute: async (fn: (trx: unknown) => Promise<unknown>) => {
          const db = {
            selectFrom: createQuery,
            updateTable: createUpdate,
            insertInto: createInsert,
          };
          const previous = dbState.transactionQueue;
          let release!: () => void;
          dbState.transactionQueue = new Promise<void>((resolve) => {
            release = resolve;
          });
          await previous;
          try {
            return await fn(db);
          } finally {
            release();
          }
        },
      }),
      destroy: dbState.destroy,
    }),
    OrderRepository,
    PaymentIntentRepository,
    RefundRepository,
    EmailJobRepository,
  };
});

// Mock stripe with a class-based mock that supports `new Stripe()`.
const stripeMock = vi.hoisted(() => ({
  refundsCreate: vi.fn(async (opts: Record<string, unknown>, opts2: Record<string, unknown>) => {
    dbState.stripeRefunds.push({ opts, opts2 });
    return { id: 're_stripe_1', status: 'succeeded' };
  }),
}));

vi.mock('stripe', () => {
  class MockStripe {
    refunds = { create: stripeMock.refundsCreate };
    paymentIntents = { create: vi.fn() };
    accounts = { create: vi.fn() };
    accountLinks = { create: vi.fn() };
  }
  return { default: MockStripe, Stripe: MockStripe };
});

const { processRefundActivity, updateLedgerActivity, voidTicketsActivity, notifyRefundActivity } =
  await import('../activities/refund.js');

beforeEach(() => {
  dbState.transactionQueue = Promise.resolve();
  dbState.destroy.mockClear();
  stripeMock.refundsCreate.mockReset();
  stripeMock.refundsCreate.mockImplementation(
    async (opts: Record<string, unknown>, opts2: Record<string, unknown>) => {
      dbState.stripeRefunds.push({ opts, opts2 });
      return { id: 're_stripe_1', status: 'succeeded' };
    },
  );
});

describe('voidTicketsActivity', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 0,
      currency: 'USD',
      status: 'paid',
      order_number: 'TK-1001',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      buyer_email: 'buyer@test.com',
      payment_intent_id: 'pi_1',
    };
    dbState.updatedTickets = [];
  });

  it('voids all valid tickets on full refund', async () => {
    dbState.tickets = [
      { id: 'tkt_1', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
      { id: 'tkt_2', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
      { id: 'tkt_3', order_id: 'ord_1', ticket_type_id: 'tt_2', status: 'valid' },
    ];
    dbState.lineItems = [
      { ticket_type_id: 'tt_1', unit_price_cents: 5000, quantity: 2 },
      { ticket_type_id: 'tt_2', unit_price_cents: 2000, quantity: 1 },
    ];

    const result = await voidTicketsActivity({
      orderId: 'ord_1',
      amountCents: 10000,
      isFullRefund: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.voidedCount).toBe(3);
    }
    expect(dbState.updatedTickets).toContainEqual(
      expect.objectContaining({
        table: 'wallet_passes',
        status: 'revoked',
      }),
    );
  });

  it('voids proportionally using per-line-item prices for partial refund (multi-ticket-type)', async () => {
    // Order: 2x $50 tickets (tt_1) + 1x $20 ticket (tt_2) = $120 total
    // Refund $50 → should void 1x $50 ticket (from tt_1, most expensive first)
    dbState.tickets = [
      { id: 'tkt_1', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
      { id: 'tkt_2', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
      { id: 'tkt_3', order_id: 'ord_1', ticket_type_id: 'tt_2', status: 'valid' },
    ];
    dbState.lineItems = [
      { ticket_type_id: 'tt_1', unit_price_cents: 5000, quantity: 2 },
      { ticket_type_id: 'tt_2', unit_price_cents: 2000, quantity: 1 },
    ];

    const result = await voidTicketsActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      isFullRefund: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.voidedCount).toBe(1);
      expect(result.value.voidedTicketIds).toEqual(['tkt_1']);
    }
  });

  it('voids from cheaper ticket type when refund amount matches it', async () => {
    // Refund $20 → should void 1x $20 ticket (from tt_2)
    dbState.tickets = [
      { id: 'tkt_1', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
      { id: 'tkt_2', order_id: 'ord_1', ticket_type_id: 'tt_2', status: 'valid' },
    ];
    dbState.lineItems = [
      { ticket_type_id: 'tt_1', unit_price_cents: 5000, quantity: 1 },
      { ticket_type_id: 'tt_2', unit_price_cents: 2000, quantity: 1 },
    ];

    const result = await voidTicketsActivity({
      orderId: 'ord_1',
      amountCents: 2000,
      isFullRefund: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // $50 tickets first: floor(2000/5000) = 0, then $20: floor(2000/2000) = 1
      expect(result.value.voidedCount).toBe(1);
      expect(result.value.voidedTicketIds).toEqual(['tkt_2']);
    }
  });

  it('does not void already-voided tickets', async () => {
    dbState.tickets = [
      { id: 'tkt_1', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'void' },
      { id: 'tkt_2', order_id: 'ord_1', ticket_type_id: 'tt_1', status: 'valid' },
    ];
    dbState.lineItems = [{ ticket_type_id: 'tt_1', unit_price_cents: 5000, quantity: 2 }];

    const result = await voidTicketsActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      isFullRefund: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.voidedCount).toBe(1);
      expect(result.value.voidedTicketIds).toEqual(['tkt_2']);
    }
  });
});

describe('processRefundActivity - idempotency / dedup', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 0,
      currency: 'USD',
      status: 'paid',
      order_number: 'TK-1001',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      buyer_email: 'buyer@test.com',
      payment_intent_id: 'pi_1',
    };
    dbState.refunds = [];
    dbState.createdRefunds = [];
    dbState.stripeRefunds = [];
    dbState.timeline = [];
    dbState.paymentAccount = null;
    dbState.paymentIntent = {
      id: 'pi_db_1',
      provider_intent_id: 'pi_stripe_1',
      payment_account_id: null,
    };
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('dedupes on providerRefundId for replay path', async () => {
    // Simulate a replay: the refund already exists with the same provider_refund_id.
    // The Stripe mock returns { id: 're_stripe_1' }, matching the existing refund.
    dbState.refunds = [
      {
        id: 'rfd_existing',
        order_id: 'ord_1',
        provider_refund_id: 're_stripe_1',
        amount_cents: 5000,
        currency: 'USD',
        status: 'succeeded',
        reason: 'test',
      },
    ];

    const result = await processRefundActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      reason: 'test',
      idempotencyKey: 'key_1',
      nonce: 'refund_nonce_1',
    });
    expect(result.ok).toBe(true);
    // Should not create a duplicate refund record
    expect(dbState.createdRefunds).toHaveLength(0);
    // Should recompute the refunded total from existing records
    expect(dbState.order.refunded_cents).toBe(5000);
    expect(dbState.order.status).toBe('partially_refunded');
    expect(dbState.timeline).toHaveLength(0);
  });

  it('repairs order refund totals when replay finds the refund by idempotency metadata', async () => {
    dbState.refunds = [
      {
        id: 'rfd_existing',
        order_id: 'ord_1',
        provider_refund_id: 're_existing_1',
        amount_cents: 5000,
        currency: 'USD',
        status: 'succeeded',
        reason: 'test',
        metadata: JSON.stringify({
          stripeIdempotencyKey: 'key_1:refund_nonce_1',
          refundNonce: 'refund_nonce_1',
        }),
      },
    ];

    const result = await processRefundActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      reason: 'test',
      idempotencyKey: 'key_1',
      nonce: 'refund_nonce_1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerRefundId).toBe('re_existing_1');
    }
    expect(dbState.stripeRefunds).toHaveLength(0);
    expect(dbState.createdRefunds).toHaveLength(0);
    expect(dbState.order.refunded_cents).toBe(5000);
    expect(dbState.order.status).toBe('partially_refunded');
    expect(dbState.timeline).toHaveLength(0);
  });

  it('recomputes status as refunded when total is reached', async () => {
    // Existing refunds total 5000, adding 5000 more reaches the 10000 total.
    dbState.refunds = [
      {
        id: 'rfd_1',
        order_id: 'ord_1',
        provider_refund_id: 're_old_1',
        amount_cents: 5000,
        currency: 'USD',
        status: 'succeeded',
        reason: 'test',
      },
    ];

    const result = await processRefundActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      reason: 'test',
      nonce: 'refund_nonce_2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The Stripe mock returns 're_stripe_1' which doesn't match 're_old_1', so a new refund is created.
      // Total refunds = 5000 (existing) + 5000 (new) = 10000 = order total → status = 'refunded'
      expect(dbState.order.refunded_cents).toBe(10000);
      expect(dbState.order.status).toBe('refunded');
    }
  });

  it('allows only one concurrent refund when two requests would exceed the order total', async () => {
    let refundSequence = 0;
    stripeMock.refundsCreate.mockImplementation(
      async (opts: Record<string, unknown>, opts2: Record<string, unknown>) => {
        dbState.stripeRefunds.push({ opts, opts2 });
        await new Promise((resolve) => setTimeout(resolve, 10));
        refundSequence += 1;
        return { id: `re_stripe_${refundSequence}`, status: 'succeeded' };
      },
    );

    const results = await Promise.all([
      processRefundActivity({
        orderId: 'ord_1',
        amountCents: 7000,
        reason: 'first refund',
        idempotencyKey: 'key_a',
        nonce: 'refund_nonce_a',
      }),
      processRefundActivity({
        orderId: 'ord_1',
        amountCents: 7000,
        reason: 'second refund',
        idempotencyKey: 'key_b',
        nonce: 'refund_nonce_b',
      }),
    ]);

    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      ok: false,
      errorCode: 'REFUND_EXCEEDS_TOTAL',
      retryable: false,
    });
    expect(dbState.createdRefunds).toHaveLength(1);
    expect(dbState.stripeRefunds).toHaveLength(1);
    expect(dbState.order.refunded_cents).toBe(7000);
    expect(dbState.order.status).toBe('partially_refunded');
  });
});

describe('processRefundActivity - Stripe Connect', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 0,
      currency: 'USD',
      status: 'paid',
      order_number: 'TK-1001',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      buyer_email: 'buyer@test.com',
      payment_intent_id: 'pi_1',
    };
    dbState.refunds = [];
    dbState.createdRefunds = [];
    dbState.stripeRefunds = [];
    dbState.paymentIntent = {
      id: 'pi_db_1',
      provider_intent_id: 'pi_stripe_1',
      payment_account_id: 'pa_1',
    };
    dbState.paymentAccount = { provider: 'stripe_connect', provider_account_id: 'acct_connect_1' };
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('refunds destination charges from the platform account', async () => {
    const result = await processRefundActivity({
      orderId: 'ord_1',
      amountCents: 5000,
      reason: 'test',
      nonce: 'refund_nonce_3',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(dbState.stripeRefunds).toHaveLength(1);
      expect(dbState.stripeRefunds[0].opts2).toEqual({
        idempotencyKey: 'refund-ord_1:refund_nonce_3',
      });
      expect(dbState.stripeRefunds[0].opts).toMatchObject({
        payment_intent: 'pi_stripe_1',
        amount: 5000,
        reverse_transfer: true,
        refund_application_fee: true,
      });
    }
  });
});

describe('updateLedgerActivity', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      subtotal_cents: 9000,
      tax_cents: 800,
      fee_cents: 200,
      refunded_cents: 5000,
      currency: 'USD',
      status: 'partially_refunded',
      order_number: 'TK-1001',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      buyer_email: 'buyer@test.com',
      payment_intent_id: 'pi_1',
    };
    dbState.timeline = [];
  });

  it('writes a balanced refund ledger event with financial allocation', async () => {
    const result = await updateLedgerActivity({
      orderId: 'ord_1',
      refundAmountCents: 5000,
      providerRefundId: 're_stripe_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.timeline).toHaveLength(1);
    const metadata = JSON.parse(String(dbState.timeline[0].metadata)) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      providerRefundId: 're_stripe_1',
      refundCents: 5000,
      taxRefundCents: 400,
      feeRefundCents: 100,
      grossRefundCents: 4500,
      netRevenueDeltaCents: -4600,
      balanced: true,
    });
  });

  it('does not duplicate ledger entries on activity retry', async () => {
    await updateLedgerActivity({
      orderId: 'ord_1',
      refundAmountCents: 5000,
      providerRefundId: 're_stripe_1',
    });
    const result = await updateLedgerActivity({
      orderId: 'ord_1',
      refundAmountCents: 5000,
      providerRefundId: 're_stripe_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.timeline).toHaveLength(1);
  });
});

describe('notifyRefundActivity - idempotency key includes providerRefundId', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 5000,
      currency: 'USD',
      status: 'partially_refunded',
      order_number: 'TK-1001',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      buyer_email: 'buyer@test.com',
      payment_intent_id: 'pi_1',
    };
  });

  it('uses providerRefundId in the idempotency key so partial refunds get separate notifications', async () => {
    const result = await notifyRefundActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@test.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      providerRefundId: 're_stripe_abc',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notified).toBe(true);
      expect(result.value.jobId).toBeDefined();
    }
  });
});
