import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = {
  tables: {} as Record<string, Record<string, any>>,
  locks: [] as string[],
  destroy: vi.fn(),
};

const stripeMock = {
  paymentIntentsCreate: vi.fn(async () => ({
    id: 'pi_provider_1',
    status: 'requires_payment_method',
    client_secret: 'pi_provider_1_secret',
  })),
};

vi.mock('stripe', () => {
  class MockStripe {
    paymentIntents = { create: stripeMock.paymentIntentsCreate };
  }
  return { default: MockStripe, Stripe: MockStripe };
});

type RowPredicate = (row: Record<string, any>) => boolean;

function compare(row: Record<string, any>, col: string, op: string, val: any): boolean {
  const value = row[col];
  if (op === '!=') return value !== val;
  if (op === '<') return new Date(value) < new Date(val);
  if (op === 'in') return Array.isArray(val) && val.includes(value);
  if (op === 'is') return val === null ? value == null : value === val;
  return value === val;
}

function expressionBuilder() {
  const eb = ((col: string, op: string, val: any) => (row: Record<string, any>) => compare(row, col, op, val)) as ((
    col: string,
    op: string,
    val: any,
  ) => RowPredicate) & {
    or: (predicates: RowPredicate[]) => RowPredicate;
    and: (predicates: RowPredicate[]) => RowPredicate;
  };
  eb.or = (predicates) => (row) => predicates.some((predicate) => predicate(row));
  eb.and = (predicates) => (row) => predicates.every((predicate) => predicate(row));
  return eb;
}

function matches(row: Record<string, any>, filters: RowPredicate[]): boolean {
  return filters.every((filter) => filter(row));
}

function EmailJobRepository() {}
function OrderRepository() {}

vi.mock('@tixkit/db', () => {
  function rowsFor(table: string): Record<string, any> {
    dbState.tables[table] ??= {};
    return dbState.tables[table];
  }

  function selectQuery(table: string) {
    const filters: RowPredicate[] = [];
    const query = {
      selectAll() {
        return query;
      },
      select() {
        return query;
      },
      where(col: string | ((eb: ReturnType<typeof expressionBuilder>) => RowPredicate), op?: string, val?: any) {
        filters.push(typeof col === 'function' ? col(expressionBuilder()) : (row) => compare(row, col, op!, val));
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
    const filters: RowPredicate[] = [];
    let updates: Record<string, unknown> | ((eb: (col: string, op: string, value: unknown) => unknown) => Record<string, unknown>) = {};
    const query = {
      set(values: typeof updates) {
        updates = values;
        return query;
      },
      where(col: string | ((eb: ReturnType<typeof expressionBuilder>) => RowPredicate), op?: string, val?: any) {
        filters.push(typeof col === 'function' ? col(expressionBuilder()) : (row) => compare(row, col, op!, val));
        return query;
      },
      async execute() {
        let updatedCount = 0;
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
          updatedCount += 1;
        }
        return [{ numUpdatedRows: BigInt(updatedCount) }];
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
    PaymentIntentRepository: class {
      async create(input: Record<string, unknown>) {
        const id = `pi_${Object.keys(rowsFor('payment_intents')).length + 1}`;
        const row = {
          id,
          tenant_id: input.tenantId,
          checkout_session_id: input.checkoutSessionId,
          order_id: null,
          provider: input.provider,
          provider_intent_id: input.providerIntentId,
          amount_cents: input.amountCents,
          currency: input.currency,
          status: input.status,
          client_secret: input.clientSecret ?? null,
          metadata: input.metadata ?? {},
          payment_account_id: input.paymentAccountId ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        rowsFor('payment_intents')[id] = row;
        return row;
      }
    },
  };
});

const checkoutActivities = await import('../activities/checkout.js');
const { finalizeOrderActivity, releaseHoldActivity } = checkoutActivities;

describe('createPaymentIntentActivity capture mode', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.destroy.mockClear();
    stripeMock.paymentIntentsCreate.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    delete process.env.STRIPE_SECRET_KEY;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('creates a deterministic local capture payment intent when Stripe is not configured outside production', async () => {
    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Local capture paid checkout',
      feeCents: 125,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        providerIntentId: 'pi_capture_cs_1',
        clientSecret: 'pi_capture_cs_1_secret',
        provider: 'stripe_capture',
      },
    });
    expect(dbState.tables.payment_intents.pi_1).toMatchObject({
      checkout_session_id: 'cs_1',
      provider: 'stripe_capture',
      provider_intent_id: 'pi_capture_cs_1',
      amount_cents: 2500,
      currency: 'USD',
      status: 'succeeded',
      client_secret: 'pi_capture_cs_1_secret',
      payment_account_id: null,
    });
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBe('pi_1');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('pending_payment');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('reuses an existing local payment intent row after a partial commit replay', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    dbState.tables.payment_intents.pi_existing = {
      id: 'pi_existing',
      tenant_id: 'tnt_1',
      checkout_session_id: 'cs_1',
      order_id: null,
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      amount_cents: 2500,
      currency: 'USD',
      status: 'requires_payment_method',
      client_secret: 'pi_provider_1_secret',
      metadata: {},
      payment_account_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Stripe checkout',
      feeCents: 125,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        providerIntentId: 'pi_provider_1',
        clientSecret: 'pi_provider_1_secret',
        provider: 'stripe',
      },
    });
    expect(stripeMock.paymentIntentsCreate).toHaveBeenCalledTimes(1);
    expect(Object.values(dbState.tables.payment_intents)).toHaveLength(1);
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBe('pi_existing');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('pending_payment');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('creates Stripe Connect destination charges with the configured application fee', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    dbState.tables.brands = {
      brd_1: {
        id: 'brd_1',
        payment_account_id: 'pa_1',
      },
    };
    dbState.tables.payment_accounts = {
      pa_1: {
        id: 'pa_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_connect_1',
        status: 'active',
        charges_enabled: true,
        payouts_enabled: true,
      },
    };

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Stripe Connect checkout',
      feeCents: 225,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        providerIntentId: 'pi_provider_1',
        clientSecret: 'pi_provider_1_secret',
        provider: 'stripe_connect',
      },
    });
    expect(stripeMock.paymentIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 2500,
        currency: 'usd',
        transfer_data: { destination: 'acct_connect_1' },
        application_fee_amount: 225,
      }),
      { idempotencyKey: 'cs_1' },
    );
    expect(dbState.tables.payment_intents.pi_1).toMatchObject({
      provider: 'stripe_connect',
      payment_account_id: 'pa_1',
    });
  });

  it('fails closed when attaching a payment intent to an expired checkout session', async () => {
    dbState.tables.checkout_sessions.cs_1.status = 'expired';

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Expired checkout',
      feeCents: 125,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CHECKOUT_SESSION_NOT_PAYABLE',
      retryable: false,
    });
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBeUndefined();
    expect(dbState.tables.payment_intents.pi_1).toMatchObject({
      checkout_session_id: 'cs_1',
      provider_intent_id: 'pi_capture_cs_1',
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the checkout session already points at a different payment intent', async () => {
    dbState.tables.checkout_sessions.cs_1.payment_intent_id = 'pi_other';

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Conflicting checkout payment',
      feeCents: 125,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CHECKOUT_SESSION_NOT_PAYABLE',
      retryable: false,
    });
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('open');
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBe('pi_other');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('fails closed in production when Stripe is not configured', async () => {
    process.env.NODE_ENV = 'production';

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'STRIPE_NOT_CONFIGURED',
      retryable: false,
    });
    expect(Object.values(dbState.tables.payment_intents)).toHaveLength(0);
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBeUndefined();
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeOrderActivity inventory holds', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.destroy.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    seedTrustedPaymentIntent();
  });

  it('converts active unexpired holds after locking pools before holds', async () => {
    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(Object.values(dbState.tables.orders)).toHaveLength(1);
    expect(Object.values(dbState.tables.orders)[0]).toMatchObject({
      payment_intent_id: 'pi_1',
      payment_provider: 'stripe',
    });
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('converted');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(1);
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('completed');
    expect(dbState.locks).toEqual(['inventory_pools', 'checkout_holds']);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('expires stale holds and fails before creating an order', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() - 60_000) });
    seedTrustedPaymentIntent();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
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

  it('fails closed for a paid checkout when the provider intent is unknown', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_unknown',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'PAYMENT_INTENT_UNTRUSTED',
      retryable: false,
    });
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('active');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('allows a free checkout without a payment intent', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    makeCheckoutFree();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
    });

    expect(result.ok).toBe(true);
    expect(Object.values(dbState.tables.orders)).toHaveLength(1);
    expect(Object.values(dbState.tables.orders)[0]).toMatchObject({
      total_cents: 0,
      payment_intent_id: null,
      payment_provider: null,
    });
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('converted');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('releaseHoldActivity checkout session status', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.destroy.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    dbState.tables.checkout_sessions.cs_1.status = 'pending_payment';
  });

  it('releases active holds and expires the checkout session after payment timeout', async () => {
    const result = await releaseHoldActivity({
      checkoutSessionId: 'cs_1',
      checkoutSessionStatus: 'expired',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('cancels the checkout session when a buyer cancels before payment completes', async () => {
    const result = await releaseHoldActivity({
      checkoutSessionId: 'cs_1',
      checkoutSessionStatus: 'cancelled',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('cancelled');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('requires a checkoutSessionId when updating checkout session status', async () => {
    const result = await releaseHoldActivity({
      holdId: 'hld_1',
      checkoutSessionStatus: 'expired',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOLD_RELEASE_FAILED',
      retryable: false,
    });
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('active');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('pending_payment');
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('finalizeOrderActivity promo code redemption', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.destroy.mockClear();
  });

  it('consumes a valid promo code on first finalize, incrementing uses_count', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      usesCount: 0,
      maxUses: 10,
      status: 'active',
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(1);
    expect(Object.values(dbState.tables.discount_redemptions)).toHaveLength(1);
    expect(dbState.tables.discount_redemptions).toMatchObject({
      [Object.keys(dbState.tables.discount_redemptions)[0]]: {
        discount_code_id: 'dc_1',
        checkout_session_id: 'cs_1',
      },
    });
  });

  it('is idempotent on duplicate finalize/retry - does not double-increment uses_count', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      usesCount: 0,
      maxUses: 10,
      status: 'active',
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    // First finalize
    const result1 = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });
    expect(result1.ok).toBe(true);
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(1);

    // Simulate a retry: the existing order check returns early
    dbState.tables.orders = {
      ord_existing: {
        id: 'ord_existing',
        checkout_session_id: 'cs_1',
      },
    };

    const result2 = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result2.ok).toBe(true);
    expect(result2).toMatchObject({ value: { orderId: 'ord_existing' } });
    // uses_count should still be 1 - no double increment
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(1);
  });

  it('rejects an exhausted promo code (uses_count >= max_uses)', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'SOLDOUT',
      usesCount: 5,
      maxUses: 5,
      status: 'active',
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DISCOUNT_EXHAUSTED',
      retryable: false,
    });
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(5);
    expect(Object.values(dbState.tables.discount_redemptions ?? {})).toHaveLength(0);
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
  });

  it('rejects an inactive promo code', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'INACTIVE',
      usesCount: 0,
      maxUses: 10,
      status: 'paused',
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DISCOUNT_INVALID',
      retryable: false,
    });
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(0);
    expect(Object.values(dbState.tables.discount_redemptions ?? {})).toHaveLength(0);
  });

  it('rejects an expired promo code (valid_until in the past)', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EXPIRED',
      usesCount: 0,
      maxUses: 10,
      status: 'active',
      validUntil: new Date(Date.now() - 86_400_000).toISOString(),
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DISCOUNT_INVALID',
      retryable: false,
    });
  });

  it('does not consume a discount code when no discountCode in cart', async () => {
    seedCheckout({
      holdExpiresAt: new Date(Date.now() + 60_000),
    });
    seedTrustedPaymentIntent();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.discount_codes).toBeUndefined();
    expect(dbState.tables.discount_redemptions).toBeUndefined();
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
        status: 'open',
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

function seedTrustedPaymentIntent(input: { amountCents?: number; currency?: string; providerIntentId?: string } = {}) {
  dbState.tables.payment_intents ??= {};
  dbState.tables.payment_intents.pi_1 = {
    id: 'pi_1',
    tenant_id: 'tnt_1',
    checkout_session_id: 'cs_1',
    order_id: null,
    provider: 'stripe',
    provider_intent_id: input.providerIntentId ?? 'pi_provider_1',
    amount_cents: input.amountCents ?? 1000,
    currency: input.currency ?? 'USD',
    status: 'requires_capture',
    client_secret: 'pi_provider_1_secret',
    metadata: {},
    payment_account_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeCheckoutFree() {
  const session = dbState.tables.checkout_sessions.cs_1;
  const quote = JSON.parse(session.quote);
  session.quote = JSON.stringify({
    ...quote,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 0,
    lineItems: quote.lineItems.map((line: Record<string, unknown>) => Object.assign({}, line, {
      unitPriceCents: 0,
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 0,
    })),
  });
}

function seedCheckoutWithDiscount(input: {
  holdExpiresAt: Date;
  discountCode: string;
  usesCount: number;
  maxUses: number;
  status: string;
  validUntil?: string;
}) {
  dbState.tables = {
    orders: {},
    order_line_items: {},
    attendees: {},
    tickets: {},
    message_consents: {},
    order_timeline_events: {},
    discount_redemptions: {},
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
          discountCents: 100,
          taxCents: 0,
          feeCents: 0,
          totalCents: 900,
          lineItems: [
            {
              ticketTypeId: 'tt_1',
              name: 'General Admission',
              quantity: 1,
              unitPriceCents: 1000,
              subtotalCents: 1000,
              discountCents: 100,
              taxCents: 0,
              feeCents: 0,
              totalCents: 900,
            },
          ],
        }),
        cart: JSON.stringify({
          items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
          buyerFields: {},
          attendeeFields: {},
          discountCode: input.discountCode,
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
    discount_codes: {
      dc_1: {
        id: 'dc_1',
        event_id: 'evt_1',
        code: input.discountCode.toUpperCase(),
        type: 'percentage',
        value: 1000,
        currency: 'USD',
        max_uses: input.maxUses,
        uses_count: input.usesCount,
        valid_from: null,
        valid_until: input.validUntil ?? null,
        min_order_cents: null,
        max_discount_cents: null,
        ticket_type_ids: null,
        status: input.status,
        created_at: new Date(),
        updated_at: new Date(),
      },
    },
    questions: {},
    payment_intents: {},
    affiliates: {},
  };
}
