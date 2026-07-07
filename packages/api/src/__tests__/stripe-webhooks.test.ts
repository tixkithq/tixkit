import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';

const stripeMock = {
  constructEvent: vi.fn((rawBody: string) => JSON.parse(rawBody)),
};

vi.mock('stripe', () => {
  class MockStripe {
    webhooks = {
      constructEvent: stripeMock.constructEvent,
    };
  }

  return { default: MockStripe, Stripe: MockStripe };
});

const { stripeWebhookRoutes } = await import('../routes/modules/stripe-webhooks.js');

type PaymentEventRow = {
  id: string;
  tenant_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  raw_payload: string;
  processed_at: Date | null;
  idempotency_key: string;
  created_at: Date;
};

type StripeWebhookTestState = {
  events: PaymentEventRow[];
  checkoutSession?: { id: string; tenant_id: string };
  paymentIntent?: {
    id: string;
    provider_intent_id: string;
    checkout_session_id: string;
    tenant_id: string;
    amount_cents: number;
    currency: string;
    payment_account_id?: string | null;
  };
  paymentAccount?: {
    id: string;
    tenant_id?: string;
    provider?: string;
    provider_account_id: string;
    status?: string;
    default_currency?: string;
    details_submitted?: boolean;
    charges_enabled?: boolean;
    payouts_enabled?: boolean;
    requirements?: string | null;
    disabled_reason?: string | null;
  };
  operations: string[];
  failInsertOnce?: boolean;
  eventOnFailedInsert?: PaymentEventRow;
  failSelectOnceForTable?: string;
};

function createMockDb(state: StripeWebhookTestState): unknown {
  type QueryFilter = { column: string; value: unknown };

  function findPaymentEvent(filters: QueryFilter[]) {
    return state.events.find((event) =>
      filters.every((filter) => {
        if (filter.column === 'id') return event.id === filter.value;
        if (filter.column === 'provider') return event.provider === filter.value;
        if (filter.column === 'provider_event_id') return event.provider_event_id === filter.value;
        return true;
      }),
    );
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- keep the mock query helpers grouped inside the DB factory.
  function rowMatches<T extends object>(row: T | undefined, filters: QueryFilter[]) {
    const record = row as Record<string, unknown> | undefined;
    return Boolean(record) && filters.every((filter) => record?.[filter.column] === filter.value);
  }

  function createQuery(table: string) {
    const filters: QueryFilter[] = [];
    const query = {
      select: () => query,
      selectAll: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      async executeTakeFirst() {
        if (state.failSelectOnceForTable === table) {
          state.failSelectOnceForTable = undefined;
          throw new Error(`Simulated ${table} lookup failure`);
        }
        if (table === 'payment_events') return findPaymentEvent(filters);
        if (table === 'checkout_sessions')
          return rowMatches(state.checkoutSession, filters) ? state.checkoutSession : undefined;
        if (table === 'payment_intents')
          return rowMatches(state.paymentIntent, filters) ? state.paymentIntent : undefined;
        if (table === 'payment_accounts')
          return rowMatches(state.paymentAccount, filters) ? state.paymentAccount : undefined;
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'payment_events') {
          const event = findPaymentEvent(filters);
          if (event) return event;
        }
        throw new Error(`No row for ${table}`);
      },
    };
    return query;
  }

  function createInsert(table: string) {
    return {
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            if (table !== 'payment_events') throw new Error(`Unexpected insert into ${table}`);
            if (state.failInsertOnce) {
              state.failInsertOnce = false;
              state.operations.push('insert-conflict:payment_events');
              if (state.eventOnFailedInsert) state.events.push(state.eventOnFailedInsert);
              throw new Error('duplicate key value violates unique constraint');
            }
            state.operations.push('insert:payment_events');
            const row = {
              ...values,
              raw_payload: String(values.raw_payload),
            } as PaymentEventRow;
            state.events.push(row);
            return row;
          },
        }),
        execute: async () => {
          if (table !== 'payment_events') throw new Error(`Unexpected insert into ${table}`);
          state.operations.push('insert:payment_events');
          const row = {
            ...values,
            raw_payload: String(values.raw_payload),
          } as PaymentEventRow;
          state.events.push(row);
        },
      }),
    };
  }

  function createUpdate(table: string) {
    const filters: QueryFilter[] = [];
    const updateQuery = (values: Record<string, unknown>) => ({
      where(column: string, _operator: string, value: unknown) {
        filters.push({ column, value });
        return updateQuery(values);
      },
      returningAll: () => ({
        executeTakeFirstOrThrow: async () => {
          if (table !== 'payment_events') throw new Error(`Unexpected update on ${table}`);
          const event = findPaymentEvent(filters);
          if (!event) throw new Error('No row for payment_events');
          state.operations.push('update:payment_events');
          Object.assign(event, values);
          return event;
        },
      }),
      execute: async () => {
        if (table === 'payment_events') {
          const event = findPaymentEvent(filters);
          if (!event) throw new Error('No row for payment_events');
          state.operations.push('update:payment_events');
          Object.assign(event, values);
          return;
        }
        if (table === 'payment_accounts') {
          if (rowMatches(state.paymentAccount, filters)) {
            state.operations.push('update:payment_accounts');
            Object.assign(state.paymentAccount!, values);
          }
          return;
        }
        throw new Error(`Unexpected update on ${table}`);
      },
    });
    return {
      set: updateQuery,
    };
  }

  return {
    selectFrom: createQuery,
    insertInto: createInsert,
    updateTable: createUpdate,
  };
}

async function setupStripeWebhookApp(
  db: Database,
  temporalClient: {
    startPaymentReconciliation: ReturnType<typeof vi.fn>;
    signalPaymentSucceeded: ReturnType<typeof vi.fn>;
    signalPaymentFailed: ReturnType<typeof vi.fn>;
  },
) {
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody: string }).rawBody = body as string;
    done(null, JSON.parse(body as string));
  });
  app.decorate('context', { db, temporalClient } as unknown as AppContext);
  await app.register(stripeWebhookRoutes);
  return app;
}

function createStripePaymentIntentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_stripe_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_stripe_1',
        amount: 1000,
        currency: 'usd',
        status: 'succeeded',
        metadata: { checkoutSessionId: 'cs_1' },
      },
    },
    ...overrides,
  };
}

function createStripeAccountUpdatedEvent() {
  return {
    id: 'evt_account_updated_1',
    type: 'account.updated',
    account: 'acct_connect_1',
    data: {
      object: {
        id: 'acct_connect_1',
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: false,
        default_currency: 'cad',
        requirements: {
          currently_due: ['external_account'],
          pending_verification: [],
          disabled_reason: 'requirements.past_due',
        },
      },
    },
  };
}

describe('Stripe webhook route', () => {
  const originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalStripeSecret = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_1';
    stripeMock.constructEvent.mockClear();
  });

  afterEach(() => {
    if (originalWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
    if (originalStripeSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecret;
  });

  it('stores the provider event before starting reconciliation without marking it processed', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      tenant_id: 'tnt_1',
      provider: 'stripe',
      provider_event_id: 'evt_stripe_1',
      event_type: 'payment_intent.succeeded',
      processed_at: null,
    });
    expect(state.operations).toEqual([
      'insert:payment_events',
      'signal:payment-succeeded',
      'start:payment-reconciliation',
    ]);
    expect(temporalClient.startPaymentReconciliation).toHaveBeenCalledWith({
      providerEventId: 'evt_stripe_1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: {
        id: 'pi_stripe_1',
        amount: 1000,
        currency: 'usd',
        status: 'succeeded',
        metadata: { checkoutSessionId: 'cs_1' },
      },
    });
    expect(temporalClient.signalPaymentSucceeded).toHaveBeenCalledWith('cs_1', 'pi_stripe_1');

    await app.close();
  });

  it('returns retryable failure when trusted checkout payment success signal fails', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
        throw new Error('Temporal signal unavailable');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: {
        code: 'CHECKOUT_PAYMENT_SIGNAL_FAILED',
        message: 'Temporal signal unavailable',
      },
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      provider_event_id: 'evt_stripe_1',
      processed_at: null,
    });
    expect(state.operations).toEqual(['insert:payment_events', 'signal:payment-succeeded']);
    expect(temporalClient.startPaymentReconciliation).not.toHaveBeenCalled();
    expect(temporalClient.signalPaymentSucceeded).toHaveBeenCalledWith('cs_1', 'pi_stripe_1');

    await app.close();
  });

  it('retries a trusted checkout failed-payment signal before reconciliation can mark processed', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    let failSignal = true;
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(),
      signalPaymentFailed: vi.fn(async () => {
        state.operations.push('signal:payment-failed');
        if (failSignal) {
          failSignal = false;
          throw new Error('Temporal failed-payment signal unavailable');
        }
      }),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);
    const payload = createStripePaymentIntentEvent({
      id: 'evt_failed_1',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_stripe_1',
          amount: 1000,
          currency: 'usd',
          status: 'requires_payment_method',
          metadata: { checkoutSessionId: 'cs_1' },
          last_payment_error: { message: 'Card declined' },
        },
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload,
    });

    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({
      error: {
        code: 'CHECKOUT_PAYMENT_SIGNAL_FAILED',
        message: 'Temporal failed-payment signal unavailable',
      },
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      provider_event_id: 'evt_failed_1',
      processed_at: null,
    });
    expect(temporalClient.startPaymentReconciliation).not.toHaveBeenCalled();
    expect(state.operations).toEqual(['insert:payment_events', 'signal:payment-failed']);

    const replay = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload,
    });

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ received: true, duplicate: false });
    expect(state.events[0]?.processed_at).toBeNull();
    expect(state.operations).toEqual([
      'insert:payment_events',
      'signal:payment-failed',
      'signal:payment-failed',
      'start:payment-reconciliation',
    ]);
    expect(temporalClient.signalPaymentFailed).toHaveBeenCalledTimes(2);
    expect(temporalClient.signalPaymentFailed).toHaveBeenLastCalledWith('cs_1', 'Card declined');
    expect(temporalClient.startPaymentReconciliation).toHaveBeenCalledOnce();

    await app.close();
  });

  it('ingests account.updated events into the connected payment account state', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      paymentAccount: {
        id: 'pa_1',
        tenant_id: 'tnt_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_connect_1',
        status: 'pending',
        default_currency: 'USD',
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: null,
        disabled_reason: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(),
      signalPaymentSucceeded: vi.fn(),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripeAccountUpdatedEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect(temporalClient.startPaymentReconciliation).not.toHaveBeenCalled();
    expect(state.paymentAccount).toMatchObject({
      status: 'restricted',
      default_currency: 'CAD',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: false,
      disabled_reason: 'requirements.past_due',
    });
    expect(JSON.parse(state.paymentAccount?.requirements ?? '{}')).toMatchObject({
      currently_due: ['external_account'],
      disabled_reason: 'requirements.past_due',
    });
    expect(state.operations).toEqual([
      'insert:payment_events',
      'update:payment_accounts',
      'update:payment_events',
    ]);

    await app.close();
  });

  it('does not reprocess a duplicate provider event that was already marked processed', async () => {
    const state: StripeWebhookTestState = {
      events: [
        {
          id: 'pevt_1',
          tenant_id: 'tnt_1',
          provider: 'stripe',
          provider_event_id: 'evt_stripe_1',
          event_type: 'payment_intent.succeeded',
          raw_payload: '{}',
          processed_at: new Date(),
          idempotency_key: 'evt_stripe_1',
          created_at: new Date(),
        },
      ],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(),
      signalPaymentSucceeded: vi.fn(),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(temporalClient.startPaymentReconciliation).not.toHaveBeenCalled();
    expect(state.operations).toEqual([]);

    await app.close();
  });

  it('retries reconciliation for a stored but unprocessed provider event', async () => {
    const state: StripeWebhookTestState = {
      events: [
        {
          id: 'pevt_1',
          tenant_id: 'tnt_1',
          provider: 'stripe',
          provider_event_id: 'evt_stripe_1',
          event_type: 'payment_intent.succeeded',
          raw_payload: '{}',
          processed_at: null,
          idempotency_key: 'evt_stripe_1',
          created_at: new Date(),
        },
      ],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect(state.operations).toEqual(['signal:payment-succeeded', 'start:payment-reconciliation']);
    expect(state.events[0].processed_at).toBeNull();

    await app.close();
  });

  it('retries reconciliation after a duplicate insert race stores an unprocessed event', async () => {
    const racedEvent: PaymentEventRow = {
      id: 'pevt_raced',
      tenant_id: 'tnt_1',
      provider: 'stripe',
      provider_event_id: 'evt_stripe_1',
      event_type: 'payment_intent.succeeded',
      raw_payload: '{}',
      processed_at: null,
      idempotency_key: 'evt_stripe_1',
      created_at: new Date(),
    };
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
      failInsertOnce: true,
      eventOnFailedInsert: racedEvent,
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.id).toBe('pevt_raced');
    expect(state.events[0]?.processed_at).toBeNull();
    expect(state.operations).toEqual([
      'insert-conflict:payment_events',
      'signal:payment-succeeded',
      'start:payment-reconciliation',
    ]);
    expect(temporalClient.startPaymentReconciliation).toHaveBeenCalledOnce();
    expect(temporalClient.signalPaymentSucceeded).toHaveBeenCalledOnce();

    await app.close();
  });

  it('starts reconciliation but does not signal when metadata checkout session points at a mismatched payment intent', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_different',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: false });
    expect(state.operations).toEqual(['insert:payment_events', 'start:payment-reconciliation']);
    expect(state.events[0]?.processed_at).toBeNull();
    expect(temporalClient.startPaymentReconciliation).toHaveBeenCalledOnce();
    expect(temporalClient.signalPaymentSucceeded).not.toHaveBeenCalled();

    await app.close();
  });

  it('leaves the provider event unprocessed when payment intent validation lookup fails', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
      paymentIntent: {
        id: 'pi_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        provider_intent_id: 'pi_stripe_1',
        amount_cents: 1000,
        currency: 'USD',
        payment_account_id: null,
      },
      operations: [],
      failSelectOnceForTable: 'payment_intents',
    };
    const temporalClient = {
      startPaymentReconciliation: vi.fn(async () => {
        state.operations.push('start:payment-reconciliation');
      }),
      signalPaymentSucceeded: vi.fn(async () => {
        state.operations.push('signal:payment-succeeded');
      }),
      signalPaymentFailed: vi.fn(),
    };
    const app = await setupStripeWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig_test' },
      payload: createStripePaymentIntentEvent(),
    });

    expect(res.statusCode).toBe(500);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.processed_at).toBeNull();
    expect(state.operations).toEqual(['insert:payment_events']);
    expect(temporalClient.startPaymentReconciliation).not.toHaveBeenCalled();
    expect(temporalClient.signalPaymentSucceeded).not.toHaveBeenCalled();

    await app.close();
  });
});
