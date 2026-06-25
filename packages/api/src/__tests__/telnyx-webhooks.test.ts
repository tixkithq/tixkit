import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../app.js';
import {
  telnyxWebhookRoutes,
  verifyTelnyxWebhookRequest,
} from '../routes/modules/telnyx-webhooks.js';

function publicKeyRawBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(-32).toString('base64');
}

function createSignature(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  timestamp: string;
  rawBody: string;
}): string {
  return sign(null, Buffer.from(`${input.timestamp}|${input.rawBody}`), input.privateKey).toString('base64');
}

function createMockDb(state: {
  existingEvent?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  insertedEvents: Record<string, unknown>[];
  deliveryUpdates: Record<string, unknown>[];
}): unknown {
  function createQuery(table: string) {
    const query = {
      selectAll: () => query,
      where: () => query,
      async executeTakeFirst() {
        if (table === 'sms_provider_events') return state.existingEvent;
        if (table === 'sms_deliveries') return state.delivery;
        return undefined;
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'sms_deliveries') state.deliveryUpdates.push(values);
              return { id: 'updated', ...values };
            },
          }),
        }),
      }),
    };
  }

  function createInsert(table: string) {
    return {
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            if (table === 'sms_provider_events') state.insertedEvents.push(values);
            return { id: 'new_1', ...values };
          },
        }),
      }),
    };
  }

  return {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
  };
}

async function setupTelnyxApp(db: Database) {
  const app = Fastify();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody: string }).rawBody = body as string;
    done(null, JSON.parse(body as string));
  });
  app.decorate('context', { db } as unknown as AppContext);
  await app.register(telnyxWebhookRoutes);
  return app;
}

describe('Telnyx webhook verification', () => {
  it('verifies Telnyx Ed25519 signatures over timestamp and raw payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawBody = JSON.stringify({ data: { id: 'evt_1' } });
    const timestamp = '1780000000';
    const signature = createSignature({ privateKey, timestamp, rawBody });

    const result = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp,
      signature,
      publicKey: publicKeyRawBase64(publicKey),
      nodeEnv: 'test',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects invalid Telnyx signatures', () => {
    const { publicKey } = generateKeyPairSync('ed25519');

    const result = verifyTelnyxWebhookRequest({
      rawBody: JSON.stringify({ data: { id: 'evt_1' } }),
      timestamp: '1780000000',
      signature: Buffer.from('bad-signature').toString('base64'),
      publicKey: publicKeyRawBase64(publicKey),
      nodeEnv: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});

describe('Telnyx SMS webhook route', () => {
  it('updates SMS delivery and stores provider event locally', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject({
      method: 'POST',
      url: '/sms',
      headers: { 'content-type': 'application/json' },
      payload: {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{ status: 'delivered' }],
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(state.insertedEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      provider: 'telnyx',
      provider_event_id: 'telnyx_evt_1',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('deduplicates repeated Telnyx webhook events', async () => {
    const state = {
      existingEvent: { id: 'spe_1', provider_event_id: 'telnyx_evt_1' },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject({
      method: 'POST',
      url: '/sms',
      headers: { 'content-type': 'application/json' },
      payload: {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.sent',
          payload: { id: 'telnyx_msg_1' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.insertedEvents).toHaveLength(0);

    await app.close();
  });
});
