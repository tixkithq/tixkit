import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = {
  tables: {} as Record<string, Record<string, any>>,
  locks: [] as string[],
  destroy: vi.fn(),
  afterSelect: undefined as ((table: string, rows: Array<Record<string, any>>) => void) | undefined,
};

const stripeMock = {
  paymentIntentsCreate: vi.fn(
    async (_params: Record<string, unknown>, _options: Record<string, unknown>) => ({
      id: 'pi_provider_1',
      status: 'requires_payment_method',
      client_secret: 'pi_provider_1_secret',
      amount: 2500,
      amount_received: 0,
    }),
  ),
  paymentIntentsRetrieve: vi.fn(async (_id: string) => ({
    id: 'pi_provider_1',
    status: 'requires_payment_method',
    amount: 2500,
    amount_received: 0,
  })),
  paymentIntentsCancel: vi.fn(
    async (_id: string, _params: Record<string, never>, _options: Record<string, unknown>) => ({
      id: 'pi_provider_1',
      status: 'canceled',
      amount: 2500,
      amount_received: 0,
    }),
  ),
  refundsCreate: vi.fn(
    async (_params: Record<string, unknown>, _options: Record<string, unknown>) => ({
      id: 're_1',
      status: 'succeeded',
    }),
  ),
};

vi.mock('@tixkit/provider-clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tixkit/provider-clients')>();
  class MockStripeSdkGateway {
    async createPaymentIntent(input: Record<string, any>) {
      const created = await stripeMock.paymentIntentsCreate(
        {
          amount: input.amount,
          currency: String(input.currency).toLowerCase(),
          description: input.description,
          automatic_payment_methods: { enabled: true },
          metadata: input.metadata,
          ...(input.connectedAccountId
            ? { transfer_data: { destination: input.connectedAccountId } }
            : {}),
          ...(input.connectedAccountId && input.applicationFeeAmount > 0
            ? { application_fee_amount: input.applicationFeeAmount }
            : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        id: created.id,
        status: created.status,
        clientSecret: created.client_secret,
        amount: created.amount,
        amountReceived: created.amount_received,
      };
    }

    async retrievePaymentIntent(id: string) {
      const intent = await stripeMock.paymentIntentsRetrieve(id);
      return {
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        amountReceived: intent.amount_received,
      };
    }

    async cancelPaymentIntent(id: string, idempotencyKey: string) {
      const intent = await stripeMock.paymentIntentsCancel(id, {}, { idempotencyKey });
      return {
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        amountReceived: intent.amount_received,
      };
    }

    async createRefund(input: Record<string, any>) {
      return stripeMock.refundsCreate(
        {
          payment_intent: input.paymentIntentId,
          amount: input.amount,
          ...(input.reverseTransfer ? { reverse_transfer: true } : {}),
          ...(input.refundApplicationFee ? { refund_application_fee: true } : {}),
        },
        { idempotencyKey: input.idempotencyKey },
      );
    }
  }
  return { ...actual, StripeSdkGateway: MockStripeSdkGateway };
});

type RowPredicate = (row: Record<string, any>) => boolean;

function compare(row: Record<string, any>, col: string, op: string, val: any): boolean {
  const value = row[col];
  if (op === '!=') return value !== val;
  if (op === '<') return new Date(value) < new Date(val);
  if (op === '>') return Number(value) > Number(val);
  if (op === '>=') return Number(value) >= Number(val);
  if (op === 'in') return Array.isArray(val) && val.includes(value);
  if (op === 'is') return val === null ? value == null : value === val;
  return value === val;
}

function expressionBuilder() {
  const eb = ((col: string, op: string, val: any) => (row: Record<string, any>) =>
    compare(row, col, op, val)) as ((col: string, op: string, val: any) => RowPredicate) & {
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
      where(
        col: string | ((eb: ReturnType<typeof expressionBuilder>) => RowPredicate),
        op?: string,
        val?: any,
      ) {
        filters.push(
          typeof col === 'function'
            ? col(expressionBuilder())
            : (row) => compare(row, col, op!, val),
        );
        return query;
      },
      forUpdate() {
        dbState.locks.push(table);
        return query;
      },
      async execute() {
        const rows = Object.values(rowsFor(table)).filter((row) => matches(row, filters));
        dbState.afterSelect?.(table, rows);
        return rows;
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
    let updates:
      | Record<string, unknown>
      | ((eb: (col: string, op: string, value: unknown) => unknown) => Record<string, unknown>) =
      {};
    const query = {
      set(values: typeof updates) {
        updates = values;
        return query;
      },
      where(
        col: string | ((eb: ReturnType<typeof expressionBuilder>) => RowPredicate),
        op?: string,
        val?: any,
      ) {
        filters.push(
          typeof col === 'function'
            ? col(expressionBuilder())
            : (row) => compare(row, col, op!, val),
        );
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
      async executeTakeFirst() {
        return (await query.execute())[0];
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

  function deleteQuery(table: string) {
    const filters: RowPredicate[] = [];
    const query = {
      where(
        col: string | ((eb: ReturnType<typeof expressionBuilder>) => RowPredicate),
        op?: string,
        val?: any,
      ) {
        filters.push(
          typeof col === 'function'
            ? col(expressionBuilder())
            : (row) => compare(row, col, op!, val),
        );
        return query;
      },
      async execute() {
        let deletedCount = 0;
        for (const [id, row] of Object.entries(rowsFor(table))) {
          if (!matches(row, filters)) continue;
          delete rowsFor(table)[id];
          deletedCount += 1;
        }
        return [{ numDeletedRows: BigInt(deletedCount) }];
      },
    };
    return query;
  }

  const db = {
    selectFrom: selectQuery,
    updateTable: updateQuery,
    insertInto: insertQuery,
    deleteFrom: deleteQuery,
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
      async findByProviderAndIntentId(provider: string, providerIntentId: string) {
        return Object.values(rowsFor('payment_intents')).find(
          (row) => row.provider === provider && row.provider_intent_id === providerIntentId,
        );
      }

      async findByCheckoutSessionAndProviderIntentId(
        checkoutSessionId: string,
        providerIntentId: string,
      ) {
        return Object.values(rowsFor('payment_intents')).find(
          (row) =>
            row.checkout_session_id === checkoutSessionId &&
            row.provider_intent_id === providerIntentId,
        );
      }

      async findLatestByCheckoutSession(checkoutSessionId: string) {
        return (
          Object.values(rowsFor('payment_intents'))
            .filter((row) => row.checkout_session_id === checkoutSessionId)
            // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh test array under ES2022.
            .sort(
              (left, right) =>
                new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
            )[0]
        );
      }

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

      async update(id: string, input: Record<string, unknown>) {
        const row = rowsFor('payment_intents')[id];
        if (!row) return undefined;
        Object.assign(row, input);
        return row;
      }
    },
    PaymentCompensationRepository: class {
      async findByProviderIntent(
        provider: string,
        providerIntentId: string,
        checkoutSessionId: string,
      ) {
        return Object.values(rowsFor('payment_compensations')).find(
          (row) =>
            row.provider === provider &&
            row.provider_intent_id === providerIntentId &&
            row.checkout_session_id === checkoutSessionId,
        );
      }

      async create(input: Record<string, unknown>) {
        const id = `pcmp_${Object.keys(rowsFor('payment_compensations')).length + 1}`;
        const row = {
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
          created_at: new Date(),
          updated_at: new Date(),
        };
        rowsFor('payment_compensations')[id] = row;
        return row;
      }

      async update(id: string, input: Record<string, unknown>) {
        const row = rowsFor('payment_compensations')[id];
        if (!row) return undefined;
        Object.assign(row, input, { updated_at: new Date() });
        return row;
      }
    },
  };
});

const checkoutActivities = await import('../activities/checkout.js');
const { ProviderOperationError } = await import('@tixkit/provider-clients');
const { finalizeOrderActivity, releaseHoldActivity } = checkoutActivities;

describe('createPaymentIntentActivity capture mode', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const originalRuntimeMode = process.env.TIXKIT_RUNTIME_MODE;

  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.afterSelect = undefined;
    dbState.destroy.mockClear();
    stripeMock.paymentIntentsCreate.mockClear();
    stripeMock.paymentIntentsRetrieve.mockClear();
    stripeMock.paymentIntentsCancel.mockClear();
    stripeMock.refundsCreate.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.TIXKIT_RUNTIME_MODE;
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalRuntimeMode === undefined) delete process.env.TIXKIT_RUNTIME_MODE;
    else process.env.TIXKIT_RUNTIME_MODE = originalRuntimeMode;
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
  });

  it('forces capture in sandbox mode even when Stripe credentials are present', async () => {
    process.env.TIXKIT_RUNTIME_MODE = 'sandbox';
    process.env.STRIPE_SECRET_KEY = 'sk_live_must_not_be_called';
    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
    });
    expect(result).toMatchObject({ ok: true, value: { provider: 'stripe_capture' } });
    expect(stripeMock.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('throws a sanitized retryable provider failure for Temporal to retry', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    stripeMock.paymentIntentsCreate.mockRejectedValueOnce(
      new ProviderOperationError(
        'stripe.payment-intent.create failed: server (HTTP 503)',
        'stripe',
        'payment-intent.create',
        'server',
        true,
        'unknown',
        false,
        { status: 503, providerRequestId: 'req_secret_1' },
      ),
    );

    const result = checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
    });

    await expect(result).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
      deliveryState: 'unknown',
      details: {},
    });
    await expect(result).rejects.not.toHaveProperty('cause');
  });

  it('returns permanent payment provider rejection without requesting a retry', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    stripeMock.paymentIntentsCreate.mockRejectedValueOnce(
      new ProviderOperationError(
        'stripe.payment-intent.create failed: validation (HTTP 400)',
        'stripe',
        'payment-intent.create',
        'validation',
        false,
        'rejected',
        false,
        { status: 400, providerCode: 'invalid_request' },
      ),
    );

    await expect(
      checkoutActivities.createPaymentIntentActivity({
        checkoutSessionId: 'cs_1',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        amountCents: 2500,
        currency: 'USD',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'PAYMENT_INTENT_PROVIDER_REJECTED',
      retryable: false,
    });
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBeUndefined();
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
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
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
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      status: 'requires_payment_method',
    });
    expect(stripeMock.paymentIntentsRetrieve).toHaveBeenCalledWith('pi_provider_1');
    expect(stripeMock.paymentIntentsCancel).toHaveBeenCalledWith(
      'pi_provider_1',
      {},
      { idempotencyKey: 'orphan-payment:cancel:stripe:pi_provider_1:cs_1' },
    );
    expect(dbState.tables.payment_compensations.pcmp_1).toMatchObject({
      checkout_session_id: 'cs_1',
      payment_intent_id: 'pi_1',
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      action: 'cancel',
      status: 'succeeded',
      provider_compensation_id: 'pi_provider_1',
      attempts: 1,
    });
    expect(JSON.parse(dbState.tables.payment_compensations.pcmp_1.metadata)).toMatchObject({
      brandId: 'brd_1',
      paymentIntentRowId: 'pi_1',
      source: 'checkout_payment_intent_attach_failed',
    });
  });

  it('blocks attach failure when created payment intent compensation needs manual review', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    dbState.tables.checkout_sessions.cs_1.status = 'expired';
    stripeMock.paymentIntentsRetrieve.mockResolvedValueOnce({
      id: 'pi_provider_1',
      status: 'requires_source_action',
      amount: 2500,
      amount_received: 0,
    });

    const result = await checkoutActivities.createPaymentIntentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      amountCents: 2500,
      currency: 'USD',
      description: 'Expired checkout with blocked compensation',
      feeCents: 125,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'PAYMENT_INTENT_COMPENSATION_BLOCKED',
      retryable: false,
    });
    expect(dbState.tables.payment_compensations.pcmp_1).toMatchObject({
      checkout_session_id: 'cs_1',
      payment_intent_id: 'pi_1',
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      action: 'refund',
      status: 'manual_review',
      attempts: 1,
    });
    expect(stripeMock.paymentIntentsCancel).not.toHaveBeenCalled();
    expect(stripeMock.refundsCreate).not.toHaveBeenCalled();
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
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.tables.checkout_sessions.cs_1.payment_intent_id).toBe('pi_other');
    expect(dbState.tables.payment_compensations.pcmp_1).toMatchObject({
      checkout_session_id: 'cs_1',
      payment_intent_id: 'pi_1',
      provider: 'stripe_capture',
      provider_intent_id: 'pi_capture_cs_1',
      action: 'local_noop',
      status: 'succeeded',
      provider_compensation_id: 'local:pi_capture_cs_1',
      attempts: 1,
    });
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
  });
});

describe('finalizeOrderActivity inventory holds', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.afterSelect = undefined;
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
  });

  it('releases test holds without changing production inventory counts', async () => {
    dbState.tables.checkout_sessions.cs_1.is_test = true;
    dbState.tables.events.evt_1.status = 'draft';

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      isTest: true,
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
    expect(dbState.tables.inventory_pools.pool_1.reserved_count).toBe(0);
    expect(Object.values(dbState.tables.orders)[0]).toMatchObject({ is_test: true });
  });

  it('rejects non-published events and releases pending checkout resources', async () => {
    dbState.tables.events.evt_1.status = 'paused';
    dbState.tables.discount_codes = {
      dc_1: {
        id: 'dc_1',
        uses_count: 1,
      },
    };
    dbState.tables.discount_redemptions = {
      dred_1: {
        id: 'dred_1',
        discount_code_id: 'dc_1',
        checkout_session_id: 'cs_1',
        order_id: null,
      },
    };

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EVENT_NOT_AVAILABLE',
      retryable: false,
    });
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(0);
    expect(Object.values(dbState.tables.discount_redemptions)).toHaveLength(0);
  });

  it('claims only the waitlist offer reserved by the finalized checkout session', async () => {
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      buyerFields: {},
      attendeeFields: {},
      waitlistEntryId: 'wle_1',
    });
    dbState.tables.waitlist_entries = {
      wle_1: {
        id: 'wle_1',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        status: 'reserved',
        reserved_checkout_session_id: 'cs_1',
        reserved_until: new Date(Date.now() + 60_000),
        claimed_at: null,
      },
    };

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.waitlist_entries.wle_1).toMatchObject({
      status: 'claimed',
      reserved_checkout_session_id: null,
      reserved_until: null,
    });
    expect(dbState.tables.waitlist_entries.wle_1.claimed_at).toBeInstanceOf(Date);
  });

  it('finalizes attendee records from sanitized cart item answers before legacy ticket-type answers', async () => {
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [
            { q_visible: { value: 'Ada Lovelace', answeredAt: '2026-06-01T12:00:00.000Z' } },
          ],
        },
      ],
      buyerFields: {},
      attendeeFields: {
        tt_1: [{ q_visible: 'legacy stale value', q_hidden: 'should not persist' }],
      },
    });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    const attendees = Object.values(dbState.tables.attendees) as Array<{ custom_answers: string }>;
    expect(attendees).toHaveLength(1);
    expect(JSON.parse(attendees[0].custom_answers)).toEqual({
      q_visible: { value: 'Ada Lovelace', answeredAt: '2026-06-01T12:00:00.000Z' },
    });
    expect(attendees[0].custom_answers).not.toContain('q_hidden');
    expect(attendees[0].custom_answers).not.toContain('legacy stale value');
  });

  it('finalizes distinct attendee identity fields instead of falling back to the buyer', async () => {
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [
            {
              firstName: 'Grace',
              lastName: 'Hopper',
              email: 'grace@example.test',
              phone: '+15555550101',
              q_attendee_consent: true,
            },
          ],
        },
      ],
      buyerFields: { q_buyer_consent: true },
    });
    dbState.tables.questions = {
      q_attendee_consent: {
        id: 'q_attendee_consent',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        applies_to: 'attendee',
        label: 'Attendee messages',
        is_consent_field: true,
        consent_text: 'Attendee agrees',
        consent_version: '1',
      },
      q_buyer_consent: {
        id: 'q_buyer_consent',
        event_id: 'evt_1',
        ticket_type_id: null,
        applies_to: 'buyer',
        label: 'Buyer messages',
        is_consent_field: true,
        consent_text: 'Buyer agrees',
        consent_version: '1',
      },
    };

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(Object.values(dbState.tables.attendees)[0]).toMatchObject({
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'grace@example.test',
      phone: '+15555550101',
    });
    expect(Object.values(dbState.tables.message_consents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'grace@example.test',
          phone: '+15555550101',
          consent_text: 'Attendee agrees',
        }),
        expect.objectContaining({
          email: 'buyer@example.test',
          phone: null,
          consent_text: 'Buyer agrees',
        }),
      ]),
    );
  });

  it('finalizes distinct attendee answers for repeated ticket types on separate cart lines', async () => {
    dbState.tables.checkout_sessions.cs_1.quote = JSON.stringify({
      subtotalCents: 2000,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2000,
      lineItems: [
        {
          ticketTypeId: 'tt_1',
          name: 'General Admission',
          quantity: 2,
          unitPriceCents: 1000,
          subtotalCents: 2000,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 2000,
        },
      ],
    });
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [
        {
          ticketTypeId: 'tt_1',
          occurrenceId: 'occ_morning',
          quantity: 1,
          attendeeFields: [{ q_name: 'Morning buyer' }],
        },
        {
          ticketTypeId: 'tt_1',
          occurrenceId: 'occ_evening',
          quantity: 1,
          attendeeFields: [{ q_name: 'Evening buyer' }],
        },
      ],
      buyerFields: {},
      attendeeFields: {
        tt_1: [{ q_name: 'legacy first' }, { q_name: 'legacy second' }],
      },
    });
    dbState.tables.checkout_holds.hld_1.quantity = 2;
    dbState.tables.payment_intents.pi_1.amount_cents = 2000;

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    const attendees = Object.values(dbState.tables.attendees) as Array<{
      custom_answers: string;
      event_occurrence_id: string;
    }>;
    expect(attendees).toHaveLength(2);
    expect(attendees.map((attendee) => JSON.parse(attendee.custom_answers))).toEqual([
      { q_name: 'Morning buyer' },
      { q_name: 'Evening buyer' },
    ]);
    expect(attendees.map((attendee) => attendee.event_occurrence_id)).toEqual([
      'occ_morning',
      'occ_evening',
    ]);
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
  });

  it('returns a committed order when a concurrent finalize wins before a handled transaction failure', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() - 60_000) });
    seedTrustedPaymentIntent();

    let injected = false;
    dbState.afterSelect = (table) => {
      if (table !== 'orders' || injected) return;
      injected = true;
      dbState.tables.orders.ord_committed = {
        id: 'ord_committed',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
      };
    };

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_committed' },
    });
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('expired');
  });

  it('throws retryable database concurrency errors so Temporal retries finalization', async () => {
    const concurrencyError = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });

    dbState.afterSelect = (table) => {
      if (table === 'checkout_holds') throw concurrencyError;
    };

    await expect(
      finalizeOrderActivity({
        checkoutSessionId: 'cs_1',
        tenantId: 'tnt_1',
        paymentIntentId: 'pi_provider_1',
      }),
    ).rejects.toBe(concurrencyError);
  });

  it('finalizes a reserved resale listing into a buyer order and transfers the seller ticket', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    dbState.tables.checkout_holds = {};
    dbState.tables.inventory_pools = {};
    dbState.tables.checkout_sessions.cs_1.quote = JSON.stringify({
      subtotalCents: 5500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 5500,
      lineItems: [
        {
          type: 'resale',
          ticketTypeId: 'tt_1',
          resaleListingId: 'lst_1',
          name: 'Resale ticket - General Admission',
          quantity: 1,
          unitPriceCents: 5500,
          subtotalCents: 5500,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 5500,
        },
      ],
    });
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [{ resaleListingId: 'lst_1', quantity: 1 }],
      buyerFields: {},
      attendeeFields: {},
    });
    dbState.tables.ticket_listings = {
      lst_1: {
        id: 'lst_1',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        ticket_id: 'tkt_seller_1',
        seller_id: 'ord_seller_1',
        status: 'listed',
        price_cents: 5500,
        currency: 'USD',
        face_value_cents: 5000,
        sold_to_id: null,
        active_listing_key: 'tkt_seller_1',
        reserved_checkout_session_id: 'cs_1',
        reserved_until: new Date(Date.now() + 60_000),
        expires_at: null,
        sold_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    };
    dbState.tables.tickets = {
      tkt_seller_1: {
        id: 'tkt_seller_1',
        tenant_id: 'tnt_1',
        order_id: 'ord_seller_1',
        attendee_id: 'att_seller_1',
        event_id: 'evt_1',
        event_occurrence_id: null,
        ticket_type_id: 'tt_1',
        status: 'valid',
      },
    };
    dbState.tables.wallet_passes = {
      wps_seller_1: {
        id: 'wps_seller_1',
        tenant_id: 'tnt_1',
        ticket_id: 'tkt_seller_1',
        status: 'active',
      },
    };
    seedTrustedPaymentIntent({ amountCents: 5500 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    const buyerOrderId = result.ok ? result.value.orderId : '';
    const buyerTickets = Object.values(dbState.tables.tickets).filter(
      (ticket) => ticket.order_id === buyerOrderId,
    );
    expect(buyerTickets).toHaveLength(1);
    expect(dbState.tables.tickets.tkt_seller_1).toMatchObject({
      status: 'transferred',
      transferred_to_email: 'buyer@example.test',
    });
    expect(dbState.tables.ticket_listings.lst_1).toMatchObject({
      status: 'sold',
      sold_to_id: buyerOrderId,
      active_listing_key: 'lst_1',
      reserved_checkout_session_id: null,
      reserved_until: null,
    });
    expect(dbState.tables.wallet_passes.wps_seller_1).toMatchObject({ status: 'revoked' });
    expect(Object.values(dbState.tables.order_line_items)).toEqual([
      expect.objectContaining({
        order_id: buyerOrderId,
        resale_listing_id: 'lst_1',
        ticket_type_id: 'tt_1',
        total_cents: 5500,
      }),
    ]);
    expect(Object.values(dbState.tables.order_timeline_events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ order_id: buyerOrderId, type: 'ticket.resale_purchased' }),
        expect.objectContaining({ order_id: 'ord_seller_1', type: 'ticket.resale_completed' }),
      ]),
    );
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
  });

  it('fails closed for a paid online checkout without a provider intent', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'PAYMENT_INTENT_UNTRUSTED',
      retryable: false,
    });
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('active');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
  });

  it('allows a paid offline box-office tender without a provider intent', async () => {
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentMode: 'offline',
      salesChannel: 'box_office',
      operatorId: 'usr_box',
      tenderType: 'cash',
    });

    expect(result.ok).toBe(true);
    expect(Object.values(dbState.tables.orders)).toHaveLength(1);
    expect(Object.values(dbState.tables.orders)[0]).toMatchObject({
      total_cents: 1000,
      payment_intent_id: null,
      payment_provider: null,
      sales_channel: 'box_office',
      operator_id: 'usr_box',
      tender_type: 'cash',
    });
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('converted');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(1);
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('completed');
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
  });
});

describe('releaseHoldActivity checkout session status', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.afterSelect = undefined;
    dbState.destroy.mockClear();
    seedCheckout({ holdExpiresAt: new Date(Date.now() + 60_000) });
    dbState.tables.checkout_sessions.cs_1.status = 'pending_payment';
  });

  it('releases active holds and expires the checkout session after payment timeout', async () => {
    dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      waitlistEntryId: 'wle_1',
    });
    dbState.tables.waitlist_entries = {
      wle_1: {
        id: 'wle_1',
        tenant_id: 'tnt_1',
        status: 'reserved',
        reserved_checkout_session_id: 'cs_1',
        reserved_until: new Date(Date.now() + 60_000),
      },
    };

    const result = await releaseHoldActivity({
      checkoutSessionId: 'cs_1',
      checkoutSessionStatus: 'expired',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('expired');
    expect(dbState.tables.inventory_pools.pool_1.sold_count).toBe(0);
    expect(dbState.tables.waitlist_entries.wle_1).toMatchObject({
      status: 'offered',
      reserved_checkout_session_id: null,
      reserved_until: null,
    });
  });

  it('cancels the checkout session when a buyer cancels before payment completes', async () => {
    const result = await releaseHoldActivity({
      checkoutSessionId: 'cs_1',
      checkoutSessionStatus: 'cancelled',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.checkout_holds.hld_1.status).toBe('released');
    expect(dbState.tables.checkout_sessions.cs_1.status).toBe('cancelled');
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
  });
});

describe('finalizeOrderActivity promo code redemption', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.afterSelect = undefined;
    dbState.destroy.mockClear();
  });

  it('attaches a reserved promo code on first finalize without incrementing uses_count', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      usesCount: 1,
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
    const orderId = result.ok ? result.value.orderId : undefined;
    expect(dbState.tables.discount_redemptions).toMatchObject({
      [Object.keys(dbState.tables.discount_redemptions)[0]]: {
        discount_code_id: 'dc_1',
        checkout_session_id: 'cs_1',
        order_id: orderId,
      },
    });
  });

  it('attaches the quoted promo reservation when the stored row has noncanonical case', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      storedCode: 'earlybird',
      usesCount: 1,
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
    expect(dbState.tables.discount_redemptions.dred_1.order_id).toBe(
      result.ok ? result.value.orderId : undefined,
    );
  });

  it('rejects a mismatched promo reservation before creating an order', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      storedCode: 'OTHER',
      usesCount: 1,
      maxUses: 10,
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
      errorCode: 'DISCOUNT_INVALID',
      retryable: false,
    });
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(1);
    expect(dbState.tables.discount_redemptions.dred_1.order_id).toBeNull();
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
  });

  it('is idempotent on duplicate finalize/retry - does not double-increment uses_count', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'EARLYBIRD',
      usesCount: 1,
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
        tenant_id: 'tnt_1',
        is_test: false,
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

  it('rejects a discounted checkout without a pre-payment promo reservation', async () => {
    seedCheckoutWithDiscount({
      holdExpiresAt: new Date(Date.now() + 60_000),
      discountCode: 'SOLDOUT',
      usesCount: 5,
      maxUses: 5,
      status: 'active',
      reserveDiscount: false,
    });
    seedTrustedPaymentIntent({ amountCents: 900 });

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'DISCOUNT_NOT_RESERVED',
      retryable: false,
    });
    expect(dbState.tables.discount_codes.dc_1.uses_count).toBe(5);
    expect(Object.values(dbState.tables.discount_redemptions ?? {})).toHaveLength(0);
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
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

describe('finalizeOrderActivity access rule redemption', () => {
  beforeEach(() => {
    dbState.tables = {};
    dbState.locks = [];
    dbState.afterSelect = undefined;
    dbState.destroy.mockClear();
  });

  it('consumes a valid access rule on first finalize, incrementing uses_count', async () => {
    seedCheckoutWithAccessRule({
      holdExpiresAt: new Date(Date.now() + 60_000),
      usesCount: 0,
      maxUses: 2,
    });
    seedTrustedPaymentIntent();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.access_rules.ar_1.uses_count).toBe(1);
    expect(Object.values(dbState.tables.access_rule_redemptions)).toHaveLength(1);
    expect(dbState.tables.access_rule_redemptions).toMatchObject({
      [Object.keys(dbState.tables.access_rule_redemptions)[0]]: {
        access_rule_id: 'ar_1',
        ticket_type_id: 'tt_1',
        checkout_session_id: 'cs_1',
      },
    });
  });

  it('does not double-consume an access rule with an existing session redemption', async () => {
    seedCheckoutWithAccessRule({
      holdExpiresAt: new Date(Date.now() + 60_000),
      usesCount: 1,
      maxUses: 1,
    });
    dbState.tables.access_rule_redemptions.ared_existing = {
      id: 'ared_existing',
      access_rule_id: 'ar_1',
      ticket_type_id: 'tt_1',
      event_id: 'evt_1',
      checkout_session_id: 'cs_1',
      order_id: 'ord_previous_attempt',
      tenant_id: 'tnt_1',
      created_at: new Date(),
    };
    seedTrustedPaymentIntent();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result.ok).toBe(true);
    expect(dbState.tables.access_rules.ar_1.uses_count).toBe(1);
    expect(Object.values(dbState.tables.access_rule_redemptions)).toHaveLength(1);
  });

  it('rejects an exhausted access rule before creating an order', async () => {
    seedCheckoutWithAccessRule({
      holdExpiresAt: new Date(Date.now() + 60_000),
      usesCount: 1,
      maxUses: 1,
    });
    seedTrustedPaymentIntent();

    const result = await finalizeOrderActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      paymentIntentId: 'pi_provider_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ACCESS_RULE_EXHAUSTED',
      retryable: false,
    });
    expect(dbState.tables.access_rules.ar_1.uses_count).toBe(1);
    expect(Object.values(dbState.tables.access_rule_redemptions)).toHaveLength(0);
    expect(Object.values(dbState.tables.orders)).toHaveLength(0);
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
        is_test: false,
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
        buyer: JSON.stringify({
          email: 'buyer@example.test',
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      },
    },
    events: {
      evt_1: {
        id: 'evt_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        status: 'published',
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
        reserved_count: 0,
        sold_count: 0,
      },
    },
    questions: {},
    payment_intents: {},
    affiliates: {},
  };
}

function seedCheckoutWithAccessRule(input: {
  holdExpiresAt: Date;
  usesCount: number;
  maxUses: number | null;
  expiresAt?: Date;
}) {
  seedCheckout({ holdExpiresAt: input.holdExpiresAt });
  dbState.tables.checkout_sessions.cs_1.cart = JSON.stringify({
    items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
    buyerFields: {},
    attendeeFields: {},
    accessRuleRedemptions: [{ accessRuleId: 'ar_1', ticketTypeId: 'tt_1' }],
  });
  dbState.tables.ticket_types = {
    tt_1: {
      id: 'tt_1',
      event_id: 'evt_1',
    },
  };
  dbState.tables.access_rules = {
    ar_1: {
      id: 'ar_1',
      ticket_type_id: 'tt_1',
      type: 'access_code',
      value: 'VIP123',
      max_uses: input.maxUses,
      uses_count: input.usesCount,
      expires_at: input.expiresAt ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    },
  };
  dbState.tables.access_rule_redemptions = {};
}

function seedTrustedPaymentIntent(
  input: { amountCents?: number; currency?: string; providerIntentId?: string } = {},
) {
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
    lineItems: quote.lineItems.map((line: Record<string, unknown>) =>
      Object.assign({}, line, {
        unitPriceCents: 0,
        subtotalCents: 0,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 0,
      }),
    ),
  });
}

function seedCheckoutWithDiscount(input: {
  holdExpiresAt: Date;
  discountCode: string;
  storedCode?: string;
  usesCount: number;
  maxUses: number;
  status: string;
  validUntil?: string;
  reserveDiscount?: boolean;
}) {
  const createdAt = new Date();
  dbState.tables = {
    orders: {},
    order_line_items: {},
    attendees: {},
    tickets: {},
    message_consents: {},
    order_timeline_events: {},
    discount_redemptions:
      input.reserveDiscount === false
        ? {}
        : {
            dred_1: {
              id: 'dred_1',
              discount_code_id: 'dc_1',
              event_id: 'evt_1',
              checkout_session_id: 'cs_1',
              order_id: null,
              tenant_id: 'tnt_1',
              created_at: createdAt,
            },
          },
    checkout_sessions: {
      cs_1: {
        id: 'cs_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'pending',
        is_test: false,
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
        buyer: JSON.stringify({
          email: 'buyer@example.test',
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
      },
    },
    events: {
      evt_1: {
        id: 'evt_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        status: 'published',
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
        code: input.storedCode ?? input.discountCode.toUpperCase(),
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
        created_at: createdAt,
        updated_at: createdAt,
      },
    },
    questions: {},
    payment_intents: {},
    affiliates: {},
  };
}
