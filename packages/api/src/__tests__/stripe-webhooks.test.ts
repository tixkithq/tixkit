import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../app.js';
import { stripeWebhookRoutes } from '../routes/modules/stripe-webhooks.js';

const stripeMock = vi.hoisted(() => ({
  constructEvent: vi.fn((rawBody: string) => JSON.parse(rawBody)),
}));

vi.mock('stripe', () => {
  class MockStripe {
    webhooks = {
      constructEvent: stripeMock.constructEvent,
    };
  }

  return { default: MockStripe, Stripe: MockStripe };
});

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
  paymentIntent?: { provider_intent_id: string; tenant_id: string };
  operations: string[];
  failInsertOnce?: boolean;
};

function createMockDb(state: StripeWebhookTestState): unknown {
  function createQuery(table: string) {
    const query = {
      select: () => query,
      selectAll: () => query,
      where: () => query,
      async executeTakeFirst() {
        if (table === 'payment_events') return state.events[0];
        if (table === 'checkout_sessions') return state.checkoutSession;
        if (table === 'payment_intents') return state.paymentIntent;
        if (table === 'payment_accounts') return undefined;
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'payment_events') return state.events[0];
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
    return {
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table !== 'payment_events') throw new Error(`Unexpected update on ${table}`);
              state.operations.push('update:payment_events');
              Object.assign(state.events[0], values);
              return state.events[0];
            },
          }),
          execute: async () => {
            if (table !== 'payment_events') throw new Error(`Unexpected update on ${table}`);
            state.operations.push('update:payment_events');
            Object.assign(state.events[0], values);
          },
        }),
      }),
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
        status: 'succeeded',
        metadata: { checkoutSessionId: 'cs_1' },
      },
    },
    ...overrides,
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

  it('stores the provider event before starting reconciliation and marking it processed', async () => {
    const state: StripeWebhookTestState = {
      events: [],
      checkoutSession: { id: 'cs_1', tenant_id: 'tnt_1' },
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
    });
    expect(state.operations).toEqual([
      'insert:payment_events',
      'start:payment-reconciliation',
      'signal:payment-succeeded',
      'update:payment_events',
    ]);
    expect(temporalClient.startPaymentReconciliation).toHaveBeenCalledWith({
      providerEventId: 'evt_stripe_1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: {
        id: 'pi_stripe_1',
        status: 'succeeded',
        metadata: { checkoutSessionId: 'cs_1' },
      },
    });

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
    expect(state.operations).toEqual([
      'start:payment-reconciliation',
      'signal:payment-succeeded',
      'update:payment_events',
    ]);
    expect(state.events[0].processed_at).toBeInstanceOf(Date);

    await app.close();
  });
});
