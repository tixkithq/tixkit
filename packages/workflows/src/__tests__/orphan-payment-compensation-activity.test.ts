import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  paymentIntent: undefined as Record<string, any> | undefined,
  checkoutSession: {
    id: 'cs_1',
    tenant_id: 'tnt_1',
    currency: 'USD',
    status: 'pending_payment',
  } as Record<string, any> | undefined,
  order: undefined as Record<string, any> | undefined,
  compensation: undefined as Record<string, any> | undefined,
  createdCompensations: [] as Record<string, any>[],
  updatedCompensations: [] as Record<string, any>[],
  paymentIntentUpdates: [] as Record<string, any>[],
  checkoutHoldUpdates: [] as Record<string, any>[],
  checkoutSessionUpdates: [] as Record<string, any>[],
  destroy: vi.fn(),
  stripeRetrieve: vi.fn(),
  stripeCancel: vi.fn(),
  stripeRefundCreate: vi.fn(),
}));

vi.mock('@tixkit/shared', () => ({
  withSpan: async (
    _name: string,
    _attrs: Record<string, unknown>,
    fn: (span: { setAttribute: () => void }) => Promise<unknown>,
  ) => fn({ setAttribute: () => undefined }),
}));

vi.mock('stripe', () => {
  class MockStripe {
    paymentIntents = {
      retrieve: mockState.stripeRetrieve,
      cancel: mockState.stripeCancel,
    };
    refunds = {
      create: mockState.stripeRefundCreate,
    };
  }
  return { default: MockStripe, Stripe: MockStripe };
});

function updateQuery(table: string) {
  let updates: Record<string, unknown> = {};
  const query = {
    set(input: Record<string, unknown>) {
      updates = input;
      return query;
    },
    where() {
      return query;
    },
    async execute() {
      if (table === 'checkout_holds') mockState.checkoutHoldUpdates.push(updates);
      if (table === 'checkout_sessions') {
        mockState.checkoutSessionUpdates.push(updates);
        if (mockState.checkoutSession) Object.assign(mockState.checkoutSession, updates);
      }
      return [{ numUpdatedRows: 1n }];
    },
  };
  return query;
}

vi.mock('@tixkit/db', () => {
  const db = {
    selectFrom: (table: string) => {
      const query = {
        select() {
          return query;
        },
        where() {
          return query;
        },
        async executeTakeFirst() {
          if (table === 'orders') return mockState.order;
          if (table === 'checkout_sessions') return mockState.checkoutSession;
          return undefined;
        },
      };
      return query;
    },
    updateTable: updateQuery,
    transaction: () => ({
      execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
    }),
    destroy: mockState.destroy,
  };

  return {
    createDb: () => db,
    PaymentIntentRepository: class {
      async findByProviderAndIntentId(provider: string, providerIntentId: string) {
        return mockState.paymentIntent?.provider === provider &&
          mockState.paymentIntent.provider_intent_id === providerIntentId
          ? mockState.paymentIntent
          : undefined;
      }

      async findByCheckoutSessionAndProviderIntentId(
        checkoutSessionId: string,
        providerIntentId: string,
      ) {
        return mockState.paymentIntent?.checkout_session_id === checkoutSessionId &&
          mockState.paymentIntent.provider_intent_id === providerIntentId
          ? mockState.paymentIntent
          : undefined;
      }

      async findLatestByCheckoutSession(checkoutSessionId: string) {
        return mockState.paymentIntent?.checkout_session_id === checkoutSessionId
          ? mockState.paymentIntent
          : undefined;
      }

      async update(_id: string, input: Record<string, unknown>) {
        mockState.paymentIntentUpdates.push(input);
        if (mockState.paymentIntent) Object.assign(mockState.paymentIntent, input);
        return mockState.paymentIntent;
      }
    },
    PaymentCompensationRepository: class {
      async findByProviderIntent(
        provider: string,
        providerIntentId: string,
        checkoutSessionId: string,
      ) {
        if (
          mockState.compensation?.provider === provider &&
          mockState.compensation.provider_intent_id === providerIntentId &&
          mockState.compensation.checkout_session_id === checkoutSessionId
        ) {
          return mockState.compensation;
        }
        return undefined;
      }

      async create(input: Record<string, unknown>) {
        const row = {
          id: 'pcmp_1',
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
        mockState.compensation = row;
        mockState.createdCompensations.push(row);
        return row;
      }

      async update(_id: string, input: Record<string, unknown>) {
        mockState.updatedCompensations.push(input);
        mockState.compensation = { ...mockState.compensation, ...input };
        return mockState.compensation;
      }
    },
  };
});

const { compensateOrphanPaymentActivity } = await import('../activities/checkout.js');

describe('compensateOrphanPaymentActivity', () => {
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    mockState.paymentIntent = {
      id: 'pi_db_1',
      tenant_id: 'tnt_1',
      order_id: null,
      checkout_session_id: 'cs_1',
      provider: 'stripe_capture',
      provider_intent_id: 'pi_capture_cs_1',
      amount_cents: 2500,
      currency: 'USD',
      status: 'succeeded',
    };
    mockState.checkoutSession = {
      id: 'cs_1',
      tenant_id: 'tnt_1',
      currency: 'USD',
      status: 'pending_payment',
    };
    mockState.order = undefined;
    mockState.compensation = undefined;
    mockState.createdCompensations = [];
    mockState.updatedCompensations = [];
    mockState.paymentIntentUpdates = [];
    mockState.checkoutHoldUpdates = [];
    mockState.checkoutSessionUpdates = [];
    mockState.destroy.mockClear();
    mockState.stripeRetrieve.mockReset();
    mockState.stripeCancel.mockReset();
    mockState.stripeRefundCreate.mockReset();
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
  });

  it('marks local stripe_capture compensation succeeded once and replays without another attempt', async () => {
    const first = await compensateOrphanPaymentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      provider: 'stripe_capture',
      providerIntentId: 'pi_capture_cs_1',
      amountCents: 2500,
      currency: 'USD',
      reason: 'test orphan',
    });

    const second = await compensateOrphanPaymentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      provider: 'stripe_capture',
      providerIntentId: 'pi_capture_cs_1',
      amountCents: 2500,
      currency: 'USD',
      reason: 'test orphan',
    });

    expect(first).toMatchObject({ ok: true, value: { status: 'succeeded', action: 'local_noop' } });
    expect(second).toMatchObject({
      ok: true,
      value: { status: 'succeeded', action: 'local_noop' },
    });
    expect(mockState.createdCompensations).toHaveLength(1);
    expect(mockState.compensation).toMatchObject({
      status: 'succeeded',
      action: 'local_noop',
      provider_compensation_id: 'local:pi_capture_cs_1',
      attempts: 1,
    });
    expect(mockState.stripeRefundCreate).not.toHaveBeenCalled();
    expect(mockState.stripeCancel).not.toHaveBeenCalled();
  });

  it('refunds captured Stripe payments with a stable orphan idempotency key', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    mockState.paymentIntent = {
      ...mockState.paymentIntent,
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
    };
    mockState.stripeRetrieve.mockResolvedValue({
      id: 'pi_provider_1',
      status: 'succeeded',
      amount: 2500,
      amount_received: 2500,
    });
    mockState.stripeRefundCreate.mockResolvedValue({ id: 're_1', status: 'succeeded' });

    const result = await compensateOrphanPaymentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_provider_1',
      amountCents: 2500,
      currency: 'USD',
      reason: 'test orphan',
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', action: 'refund' } });
    expect(mockState.stripeRefundCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_provider_1', amount: 2500 },
      { idempotencyKey: 'orphan-payment:refund:stripe:pi_provider_1:cs_1' },
    );
  });

  it('cancels uncaptured Stripe payments with a stable orphan idempotency key', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    mockState.paymentIntent = {
      ...mockState.paymentIntent,
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      status: 'requires_capture',
    };
    mockState.stripeRetrieve.mockResolvedValue({
      id: 'pi_provider_1',
      status: 'requires_capture',
      amount: 2500,
      amount_received: 0,
    });
    mockState.stripeCancel.mockResolvedValue({ id: 'pi_provider_1', status: 'canceled' });

    const result = await compensateOrphanPaymentActivity({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_provider_1',
      amountCents: 2500,
      currency: 'USD',
      reason: 'test orphan',
    });

    expect(result).toMatchObject({ ok: true, value: { status: 'succeeded', action: 'cancel' } });
    expect(mockState.stripeCancel).toHaveBeenCalledWith(
      'pi_provider_1',
      {},
      { idempotencyKey: 'orphan-payment:cancel:stripe:pi_provider_1:cs_1' },
    );
  });
});
