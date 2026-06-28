import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import { clerkWebhookRoutes } from '../routes/modules/clerk-webhooks.js';

const CLERK_WEBHOOK_SECRET = 'whsec_test-secret-for-clerk-route';

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

type ClerkWebhookTestState = {
  events: PaymentEventRow[];
  operations: string[];
  failInsertOnce?: boolean;
  eventOnFailedInsert?: PaymentEventRow;
};

function signSvixPayload(body: string, msgId: string, timestamp: number, secret: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

function createMockDb(state: ClerkWebhookTestState): unknown {
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

  function createQuery(table: string) {
    const filters: QueryFilter[] = [];
    const query = {
      selectAll: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      async executeTakeFirst() {
        if (table === 'payment_events') return findPaymentEvent(filters);
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
        },
      }),
    };
  }

  function createUpdate(table: string) {
    const filters: QueryFilter[] = [];
    return {
      set: (values: Record<string, unknown>) => ({
        where: (column: string, _operator: string, value: unknown) => {
          filters.push({ column, value });
          return {
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
              if (table !== 'payment_events') throw new Error(`Unexpected update on ${table}`);
              const event = findPaymentEvent(filters);
              if (!event) throw new Error('No row for payment_events');
              state.operations.push('update:payment_events');
              Object.assign(event, values);
            },
          };
        },
      }),
    };
  }

  return {
    selectFrom: createQuery,
    insertInto: createInsert,
    updateTable: createUpdate,
  };
}

async function setupClerkWebhookApp(
  db: Database,
  temporalClient: {
    startClerkIdentitySync: ReturnType<typeof vi.fn>;
  },
) {
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody: string }).rawBody = body as string;
    done(null, JSON.parse(body as string));
  });
  app.decorate('context', { db, temporalClient } as unknown as AppContext);
  await app.register(clerkWebhookRoutes);
  return app;
}

function createClerkUserEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'user.created',
    data: {
      id: 'user_1',
      email_addresses: [{ email_address: 'user@example.com' }],
      first_name: 'Ada',
      last_name: 'Lovelace',
      image_url: 'https://example.com/avatar.png',
    },
    ...overrides,
  };
}

async function injectSignedClerkWebhook(
  app: Awaited<ReturnType<typeof setupClerkWebhookApp>>,
  payload: Record<string, unknown>,
  msgId = 'msg_clerk_1',
) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signSvixPayload(body, msgId, timestamp, CLERK_WEBHOOK_SECRET);

  return app.inject({
    method: 'POST',
    url: '/',
    headers: {
      'content-type': 'application/json',
      'svix-id': msgId,
      'svix-timestamp': String(timestamp),
      'svix-signature': signature,
    },
    payload: body,
  });
}

describe('Clerk webhook route', () => {
  const originalWebhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.CLERK_WEBHOOK_SECRET = CLERK_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (originalWebhookSecret === undefined) delete process.env.CLERK_WEBHOOK_SECRET;
    else process.env.CLERK_WEBHOOK_SECRET = originalWebhookSecret;
  });

  it('stores the provider event before starting identity sync without marking it processed', async () => {
    const state: ClerkWebhookTestState = {
      events: [],
      operations: [],
    };
    const temporalClient = {
      startClerkIdentitySync: vi.fn(async () => {
        state.operations.push('start:clerk-identity-sync');
      }),
    };
    const app = await setupClerkWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await injectSignedClerkWebhook(app, createClerkUserEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      tenant_id: 'system',
      provider: 'clerk',
      provider_event_id: 'msg_clerk_1',
      event_type: 'user.created',
      processed_at: null,
    });
    expect(state.operations).toEqual(['insert:payment_events', 'start:clerk-identity-sync']);
    expect(temporalClient.startClerkIdentitySync).toHaveBeenCalledWith({
      providerEventId: 'msg_clerk_1',
      eventType: 'user.created',
      clerkUserId: 'user_1',
      email: 'user@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'https://example.com/avatar.png',
      clerkOrgId: undefined,
      orgName: undefined,
    });

    await app.close();
  });

  it('returns duplicate and skips sync for a processed provider event', async () => {
    const state: ClerkWebhookTestState = {
      events: [
        {
          id: 'pevt_processed',
          tenant_id: 'system',
          provider: 'clerk',
          provider_event_id: 'msg_clerk_1',
          event_type: 'user.created',
          raw_payload: '{}',
          processed_at: new Date(),
          idempotency_key: 'msg_clerk_1-123',
          created_at: new Date(),
        },
      ],
      operations: [],
    };
    const temporalClient = {
      startClerkIdentitySync: vi.fn(),
    };
    const app = await setupClerkWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await injectSignedClerkWebhook(app, createClerkUserEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(temporalClient.startClerkIdentitySync).not.toHaveBeenCalled();
    expect(state.operations).toEqual([]);

    await app.close();
  });

  it('retries sync after a duplicate insert race stores an unprocessed event', async () => {
    const racedEvent: PaymentEventRow = {
      id: 'pevt_raced',
      tenant_id: 'system',
      provider: 'clerk',
      provider_event_id: 'msg_clerk_1',
      event_type: 'user.created',
      raw_payload: '{}',
      processed_at: null,
      idempotency_key: 'msg_clerk_1-123',
      created_at: new Date(),
    };
    const state: ClerkWebhookTestState = {
      events: [],
      operations: [],
      failInsertOnce: true,
      eventOnFailedInsert: racedEvent,
    };
    const temporalClient = {
      startClerkIdentitySync: vi.fn(async () => {
        state.operations.push('start:clerk-identity-sync');
      }),
    };
    const app = await setupClerkWebhookApp(createMockDb(state) as Database, temporalClient);

    const res = await injectSignedClerkWebhook(app, createClerkUserEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.id).toBe('pevt_raced');
    expect(state.events[0]?.processed_at).toBeNull();
    expect(state.operations).toEqual([
      'insert-conflict:payment_events',
      'start:clerk-identity-sync',
    ]);
    expect(temporalClient.startClerkIdentitySync).toHaveBeenCalledOnce();
    expect(temporalClient.startClerkIdentitySync).toHaveBeenCalledWith({
      providerEventId: 'msg_clerk_1',
      eventType: 'user.created',
      clerkUserId: 'user_1',
      email: 'user@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'https://example.com/avatar.png',
      clerkOrgId: undefined,
      orgName: undefined,
    });

    await app.close();
  });
});
