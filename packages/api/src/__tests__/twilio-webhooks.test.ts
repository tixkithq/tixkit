import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import {
  twilioWebhookRoutes,
  verifyTwilioWebhookRequest,
} from '../routes/modules/twilio-webhooks.js';

const webhookUrl = 'https://api.example.test/v1/webhooks/twilio/sms';

type TwilioWebhookTestState = {
  existingEvent?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  job?: Record<string, unknown>;
  insertedEvents: Record<string, unknown>[];
  deliveryUpdates: Record<string, unknown>[];
  consentUpdates: Record<string, unknown>[];
};

function signature(params: Record<string, string>, token = 'twilio_test_token'): string {
  let payload = webhookUrl;
  for (const key of Object.keys(params).sort()) payload += `${key}${params[key]}`;
  return createHmac('sha1', token).update(payload).digest('base64');
}

function signedRequest(params: Record<string, string>, token = 'twilio_test_token') {
  return {
    method: 'POST' as const,
    url: '/sms',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature(params, token),
    },
    payload: new URLSearchParams(params).toString(),
  };
}

function createMockDb(state: TwilioWebhookTestState): unknown {
  type Filter = { column: string; value: unknown };

  function query(table: string) {
    const filters: Filter[] = [];
    const builder = {
      selectAll: () => builder,
      where: (column: string, _operator: string, value: unknown) => {
        filters.push({ column, value });
        return builder;
      },
      async executeTakeFirst() {
        if (table === 'sms_provider_events') {
          const events = [state.existingEvent, ...state.insertedEvents].filter(
            (event): event is Record<string, unknown> => Boolean(event),
          );
          return events.find((event) =>
            filters.every(({ column, value }) => event[column] === value),
          );
        }
        if (table === 'sms_deliveries') return state.delivery;
        if (table === 'sms_jobs') return state.job;
        return undefined;
      },
    };
    return builder;
  }

  function update(table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        const builder = {
          where: () => builder,
          execute: async () => {
            if (table === 'sms_deliveries') {
              state.deliveryUpdates.push(values);
              if (state.delivery) Object.assign(state.delivery, values);
            }
            if (table === 'message_consents') state.consentUpdates.push(values);
            return [];
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'sms_deliveries') {
                state.deliveryUpdates.push(values);
                if (state.delivery) Object.assign(state.delivery, values);
              }
              return { id: 'updated', ...values };
            },
          }),
        };
        return builder;
      },
    };
  }

  const facade = {
    selectFrom: query,
    updateTable: update,
    insertInto: (table: string) => ({
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            if (table === 'sms_provider_events') state.insertedEvents.push(values);
            return { id: 'new_1', ...values };
          },
        }),
      }),
    }),
    transaction: () => ({
      execute: async <T>(callback: (trx: unknown) => Promise<T>) => callback(facade),
    }),
  };
  return facade;
}

async function setupApp(state: TwilioWebhookTestState) {
  const app = Fastify();
  app.decorate('context', {
    db: createMockDb(state) as Database,
  } as unknown as AppContext);
  await app.register(twilioWebhookRoutes);
  return app;
}

function stateWithDelivery(
  overrides: Partial<TwilioWebhookTestState> = {},
): TwilioWebhookTestState {
  return {
    delivery: {
      id: 'smd_1',
      tenant_id: 'ten_1',
      job_id: 'smj_1',
      provider: 'twilio',
      provider_message_id: 'SM123',
      status: 'queued',
    },
    job: { id: 'smj_1', to_phone: '+15551234567' },
    insertedEvents: [],
    deliveryUpdates: [],
    consentUpdates: [],
    ...overrides,
  };
}

describe('Twilio webhook verification', () => {
  it('verifies the sorted form parameters against the exact public URL', () => {
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    const url = 'https://mycompany.com/myapp.php';
    let payload = url;
    for (const key of Object.keys(params).sort()) {
      payload += `${key}${params[key as keyof typeof params]}`;
    }
    const signed = createHmac('sha1', '12345').update(payload).digest('base64');
    const result = verifyTwilioWebhookRequest({
      url,
      params,
      signature: signed,
      authToken: '12345',
    });
    expect(result).toEqual({ ok: true });
    expect(
      verifyTwilioWebhookRequest({
        url: `${url}?unexpected=1`,
        params,
        signature: signed,
        authToken: '12345',
      }),
    ).toMatchObject({ ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' });
  });

  it('fails closed when the auth token is absent or the signature is invalid', () => {
    expect(
      verifyTwilioWebhookRequest({
        url: webhookUrl,
        params: {},
        signature: 'invalid',
      }),
    ).toMatchObject({ ok: false, status: 503, code: 'WEBHOOK_NOT_CONFIGURED' });
    expect(
      verifyTwilioWebhookRequest({
        url: webhookUrl,
        params: {},
        signature: 'invalid',
        authToken: 'token',
      }),
    ).toMatchObject({ ok: false, status: 400, code: 'WEBHOOK_SIGNATURE_INVALID' });
  });
});

describe('Twilio SMS status webhooks', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.API_BASE_URL = 'https://api.example.test';
    process.env.TWILIO_AUTH_TOKEN = 'twilio_test_token';
    delete process.env.TWILIO_WEBHOOK_ALLOW_UNSIGNED;
    delete process.env.TWILIO_WEBHOOK_PUBLIC_URL;
  });

  afterEach(() => {
    delete process.env.API_BASE_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WEBHOOK_ALLOW_UNSIGNED;
    delete process.env.TWILIO_WEBHOOK_PUBLIC_URL;
  });

  it('reconciles a delivery by MessageSid and persists only normalized status data', async () => {
    const state = stateWithDelivery();
    const app = await setupApp(state);
    const params = {
      MessageSid: 'SM123',
      MessageStatus: 'delivered',
      To: '+15551234567',
      Body: 'private message text',
    };

    const response = await app.inject(signedRequest(params));
    expect(response.statusCode).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(state.insertedEvents[0]).toMatchObject({
      tenant_id: 'ten_1',
      provider: 'twilio',
      event_type: 'message.delivered',
      provider_message_id: 'SM123',
    });
    const storedPayload = JSON.parse(String(state.insertedEvents[0]?.raw_payload));
    expect(storedPayload).toEqual({
      MessageSid: 'SM123',
      MessageStatus: 'delivered',
    });
    expect(JSON.stringify(state.insertedEvents)).not.toContain('+15551234567');
    expect(JSON.stringify(state.insertedEvents)).not.toContain('private message text');
    await app.close();
  });

  it('asks Twilio to retry when the outbound delivery row is not ready', async () => {
    const state = stateWithDelivery({ delivery: undefined });
    const app = await setupApp(state);
    const response = await app.inject(
      signedRequest({ MessageSid: 'SM123', MessageStatus: 'sent' }),
    );

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(state.insertedEvents).toHaveLength(0);
    await app.close();
  });

  it('replays a stored provider event to repair a missing delivery update', async () => {
    const state = stateWithDelivery({
      existingEvent: {
        provider: 'twilio',
        provider_event_id:
          'sha256:5f51b304324c0dc35719767e791cc337e4da07e0fa7311b993ce187c8f5bb251',
      },
    });
    const app = await setupApp(state);
    const response = await app.inject(
      signedRequest({ MessageSid: 'SM123', MessageStatus: 'sent' }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true, duplicate: true });
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'sent' });
    await app.close();
  });

  it('revokes local SMS consent for Twilio’s explicit recipient opt-out code', async () => {
    const state = stateWithDelivery();
    const app = await setupApp(state);
    const response = await app.inject(
      signedRequest({
        MessageSid: 'SM123',
        MessageStatus: 'failed',
        ErrorCode: '21610',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'Twilio delivery failed (21610)',
    });
    expect(state.consentUpdates).toHaveLength(1);
    expect(state.consentUpdates[0]).toMatchObject({ sms_opt_in: false });
    await app.close();
  });

  it('does not revoke consent for a non-opt-out delivery failure', async () => {
    const state = stateWithDelivery();
    const app = await setupApp(state);
    const response = await app.inject(
      signedRequest({
        MessageSid: 'SM123',
        MessageStatus: 'undelivered',
        ErrorCode: '30003',
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'failed' });
    expect(state.consentUpdates).toHaveLength(0);
    await app.close();
  });

  it('does not downgrade a terminal delivery on a late sent callback', async () => {
    const state = stateWithDelivery({
      delivery: {
        id: 'smd_1',
        tenant_id: 'ten_1',
        job_id: 'smj_1',
        provider: 'twilio',
        provider_message_id: 'SM123',
        status: 'delivered',
      },
    });
    const app = await setupApp(state);
    const response = await app.inject(
      signedRequest({ MessageSid: 'SM123', MessageStatus: 'sent' }),
    );

    expect(response.statusCode).toBe(200);
    expect(state.deliveryUpdates).toHaveLength(0);
    await app.close();
  });
});
