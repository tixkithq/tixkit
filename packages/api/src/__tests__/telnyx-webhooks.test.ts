import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import {
  telnyxWebhookRoutes,
  verifyTelnyxWebhookRequest,
} from '../routes/modules/telnyx-webhooks.js';

function publicKeyRawBase64(
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(-32).toString('base64');
}

function createSignature(input: {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  timestamp: string;
  rawBody: string;
}): string {
  return sign(null, Buffer.from(`${input.timestamp}|${input.rawBody}`), input.privateKey).toString(
    'base64',
  );
}

type TelnyxWebhookTestState = {
  existingEvent?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  job?: Record<string, unknown>;
  insertedEvents: Record<string, unknown>[];
  deliveryUpdates: Record<string, unknown>[];
  consentUpdates?: Record<string, unknown>[];
  failInsertOnce?: boolean;
  failDeliveryUpdateOnce?: boolean;
  eventOnFailedInsert?: Record<string, unknown>;
};

function currentUnixTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

function signedTelnyxSmsRequest(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  payload: Record<string, unknown>,
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = currentUnixTimestamp();
  return {
    method: 'POST' as const,
    url: '/sms',
    headers: {
      'content-type': 'application/json',
      'telnyx-timestamp': timestamp,
      'telnyx-signature-ed25519': createSignature({ privateKey, timestamp, rawBody }),
    },
    payload: rawBody,
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createMockDb(state: TelnyxWebhookTestState): unknown {
  type QueryFilter = { column: string; value: unknown };

  // eslint-disable-next-line unicorn/consistent-function-scoping -- keep provider-event lookup beside the mocked DB query builder.
  function findProviderEvent(
    target: TelnyxWebhookTestState,
    filters: QueryFilter[],
    includeRacedEvent: boolean,
  ) {
    const events = [
      target.existingEvent,
      ...target.insertedEvents,
      includeRacedEvent ? target.eventOnFailedInsert : undefined,
    ].filter((event): event is Record<string, unknown> => Boolean(event));

    return events.find((event) =>
      filters.every((filter) => {
        if (filter.column === 'provider') return event.provider === filter.value;
        if (filter.column === 'provider_event_id') return event.provider_event_id === filter.value;
        return true;
      }),
    );
  }

  function createQuery(target: TelnyxWebhookTestState, includeRacedEvent: boolean, table: string) {
    const filters: QueryFilter[] = [];
    const query = {
      selectAll: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      async executeTakeFirst() {
        if (table === 'sms_provider_events')
          return findProviderEvent(target, filters, includeRacedEvent);
        if (table === 'sms_deliveries') return target.delivery;
        if (table === 'sms_jobs') return target.job;
        return undefined;
      },
    };
    return query;
  }

  function createUpdate(target: TelnyxWebhookTestState, table: string) {
    const applyUpdate = async (values: Record<string, unknown>) => {
      if (table === 'sms_deliveries') {
        if (state.failDeliveryUpdateOnce) {
          state.failDeliveryUpdateOnce = false;
          throw new Error('delivery update failed');
        }
        target.deliveryUpdates.push(values);
        if (target.delivery) Object.assign(target.delivery, values);
      }
      if (table === 'message_consents') {
        target.consentUpdates?.push(values);
      }
      return { id: 'updated', ...values };
    };

    return {
      set: (values: Record<string, unknown>) => {
        const query = {
          where: () => query,
          execute: async () => applyUpdate(values),
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => applyUpdate(values),
          }),
        };
        return query;
      },
    };
  }

  function createInsert(target: TelnyxWebhookTestState, table: string) {
    return {
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            if (table === 'sms_provider_events') {
              if (state.failInsertOnce) {
                state.failInsertOnce = false;
                throw new Error('duplicate key value violates unique constraint');
              }
              target.insertedEvents.push(values);
            }
            return { id: 'new_1', ...values };
          },
        }),
      }),
    };
  }

  function createDbFacade(target: TelnyxWebhookTestState, includeRacedEvent: boolean) {
    return {
      selectFrom: (table: string) => createQuery(target, includeRacedEvent, table),
      updateTable: (table: string) => createUpdate(target, table),
      insertInto: (table: string) => createInsert(target, table),
      transaction: () => ({
        execute: async <T>(callback: (trx: unknown) => Promise<T>): Promise<T> => {
          const txState: TelnyxWebhookTestState = {
            existingEvent: target.existingEvent ? { ...target.existingEvent } : undefined,
            delivery: target.delivery ? { ...target.delivery } : undefined,
            job: target.job ? { ...target.job } : undefined,
            insertedEvents: target.insertedEvents.map((event) => ({ ...event })),
            deliveryUpdates: target.deliveryUpdates.map((update) => ({ ...update })),
            consentUpdates: target.consentUpdates?.map((update) => ({ ...update })),
            failInsertOnce: target.failInsertOnce,
            failDeliveryUpdateOnce: target.failDeliveryUpdateOnce,
            eventOnFailedInsert: target.eventOnFailedInsert
              ? { ...target.eventOnFailedInsert }
              : undefined,
          };

          const result = await callback(createDbFacade(txState, false));

          target.existingEvent = txState.existingEvent;
          target.delivery = txState.delivery;
          target.job = txState.job;
          target.insertedEvents.length = 0;
          target.insertedEvents.push(...txState.insertedEvents);
          target.deliveryUpdates.length = 0;
          target.deliveryUpdates.push(...txState.deliveryUpdates);
          if (target.consentUpdates && txState.consentUpdates) {
            target.consentUpdates.length = 0;
            target.consentUpdates.push(...txState.consentUpdates);
          }
          target.failInsertOnce = txState.failInsertOnce;
          target.failDeliveryUpdateOnce = txState.failDeliveryUpdateOnce;
          return result;
        },
      }),
    };
  }

  return createDbFacade(state, true);
}

async function setupTelnyxApp(db: Database) {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    reply.status(500).send({
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as unknown as { rawBody: string }).rawBody = body as string;
    done(null, JSON.parse(body as string));
  });
  app.decorate('context', { db } as unknown as AppContext);
  await app.register(telnyxWebhookRoutes);
  return app;
}

describe('Telnyx webhook verification', () => {
  it('requires a Telnyx public key unless unsigned mode is explicitly enabled for tests', () => {
    const rawBody = JSON.stringify({ data: { id: 'evt_1' } });

    const missingKey = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp: currentUnixTimestamp(),
      signature: Buffer.from('signature').toString('base64'),
      nodeEnv: 'staging',
    });
    const unsignedTest = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp: undefined,
      signature: undefined,
      allowUnsigned: 'true',
      nodeEnv: 'test',
    });
    const unsignedNonTest = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp: undefined,
      signature: undefined,
      allowUnsigned: 'true',
      nodeEnv: 'development',
    });

    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) {
      expect(missingKey.status).toBe(503);
      expect(missingKey.code).toBe('WEBHOOK_NOT_CONFIGURED');
    }
    expect(unsignedTest.ok).toBe(true);
    expect(unsignedNonTest.ok).toBe(false);
    if (!unsignedNonTest.ok) expect(unsignedNonTest.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('verifies Telnyx Ed25519 signatures over timestamp and raw payload', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawBody = JSON.stringify({ data: { id: 'evt_1' } });
    const timestamp = currentUnixTimestamp();
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
      timestamp: currentUnixTimestamp(),
      signature: Buffer.from('bad-signature').toString('base64'),
      publicKey: publicKeyRawBase64(publicKey),
      nodeEnv: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('rejects stale signed Telnyx webhook payloads', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const rawBody = JSON.stringify({ data: { id: 'evt_1' } });
    const timestamp = (Math.floor(Date.now() / 1000) - 301).toString();
    const signature = createSignature({ privateKey, timestamp, rawBody });

    const result = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp,
      signature,
      publicKey: publicKeyRawBase64(publicKey),
      nodeEnv: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });
});

describe('Telnyx SMS webhook route', () => {
  let originalTelnyxWebhookPublicKey: string | undefined;
  let originalTelnyxPublicKey: string | undefined;
  let originalTelnyxWebhookAllowUnsigned: string | undefined;
  let routePrivateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];

  beforeEach(() => {
    originalTelnyxWebhookPublicKey = process.env.TELNYX_WEBHOOK_PUBLIC_KEY;
    originalTelnyxPublicKey = process.env.TELNYX_PUBLIC_KEY;
    originalTelnyxWebhookAllowUnsigned = process.env.TELNYX_WEBHOOK_ALLOW_UNSIGNED;

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    routePrivateKey = privateKey;
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicKeyRawBase64(publicKey);
    delete process.env.TELNYX_WEBHOOK_ALLOW_UNSIGNED;
  });

  afterEach(() => {
    restoreEnv('TELNYX_WEBHOOK_PUBLIC_KEY', originalTelnyxWebhookPublicKey);
    restoreEnv('TELNYX_PUBLIC_KEY', originalTelnyxPublicKey);
    restoreEnv('TELNYX_WEBHOOK_ALLOW_UNSIGNED', originalTelnyxWebhookAllowUnsigned);
  });

  it('rejects Telnyx webhooks when no public key is configured without mutating state', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);
    delete process.env.TELNYX_WEBHOOK_PUBLIC_KEY;
    delete process.env.TELNYX_PUBLIC_KEY;

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.sent',
          payload: { id: 'telnyx_msg_1' },
        },
      }),
    );

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: { code: 'WEBHOOK_NOT_CONFIGURED' },
    });
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.delivery).toMatchObject({ status: 'accepted' });

    await app.close();
  });

  it('updates SMS delivery and stores provider event locally', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{ status: 'delivered' }],
          },
        },
      }),
    );

    expect(res.statusCode, res.body).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(state.insertedEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      provider: 'telnyx',
      provider_event_id: 'telnyx_evt_1',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('revokes SMS consent when Telnyx finalizes a delivery failure', async () => {
    const state: TelnyxWebhookTestState = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        job_id: 'smj_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      job: {
        id: 'smj_1',
        tenant_id: 'tnt_1',
        to_phone: '+15550000001',
      },
      insertedEvents: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_failure',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            errors: [{ title: 'Rejected', detail: 'Carrier rejected recipient' }],
            to: [{ status: 'failed' }],
          },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(state.deliveryUpdates[0]).toMatchObject({
      status: 'failed',
      failure_reason: 'Carrier rejected recipient',
    });
    expect(state.consentUpdates).toHaveLength(1);
    expect(state.consentUpdates?.[0]).toMatchObject({ sms_opt_in: false });
    expect(state.insertedEvents[0]).toMatchObject({
      provider_event_id: 'telnyx_evt_failure',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('stores delivery-unconfirmed finalized events without failing delivery or revoking consent', async () => {
    const state: TelnyxWebhookTestState = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        job_id: 'smj_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'sent',
      },
      job: {
        id: 'smj_1',
        tenant_id: 'tnt_1',
        to_phone: '+15550000001',
      },
      insertedEvents: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_unconfirmed',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{ status: 'delivery_unconfirmed' }],
          },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.consentUpdates).toHaveLength(0);
    expect(state.delivery).toMatchObject({ status: 'sent' });
    expect(state.insertedEvents[0]).toMatchObject({
      provider_event_id: 'telnyx_evt_unconfirmed',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('stores finalized events with no recipient status or errors without failing delivery', async () => {
    const state: TelnyxWebhookTestState = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        job_id: 'smj_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'sent',
      },
      job: {
        id: 'smj_1',
        tenant_id: 'tnt_1',
        to_phone: '+15550000001',
      },
      insertedEvents: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_missing_status',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{}],
          },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.consentUpdates).toHaveLength(0);
    expect(state.delivery).toMatchObject({ status: 'sent' });
    expect(state.insertedEvents[0]).toMatchObject({
      provider_event_id: 'telnyx_evt_missing_status',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('returns a retryable error without storing a status event when delivery is not ready', async () => {
    const state = {
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{ status: 'delivered' }],
          },
        },
      }),
    );

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toMatchObject({
      error: { code: 'TELNYX_DELIVERY_NOT_READY' },
    });
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);

    await app.close();
  });

  it('processes a retried status event once the delivery exists', async () => {
    const state: TelnyxWebhookTestState = {
      insertedEvents: [],
      deliveryUpdates: [],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);
    const payload = {
      data: {
        id: 'telnyx_evt_1',
        event_type: 'message.sent',
        payload: { id: 'telnyx_msg_1' },
      },
    };

    const missingDelivery = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(missingDelivery.statusCode).toBe(503);
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);

    state.delivery = {
      id: 'smd_1',
      tenant_id: 'tnt_1',
      provider: 'telnyx',
      provider_message_id: 'telnyx_msg_1',
      status: 'accepted',
    };

    const retried = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ received: true });
    expect(state.deliveryUpdates).toHaveLength(1);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'sent' });
    expect(state.delivery).toMatchObject({ status: 'sent' });
    expect(state.insertedEvents).toHaveLength(1);
    expect(state.insertedEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      provider: 'telnyx',
      provider_event_id: 'telnyx_evt_1',
      provider_message_id: 'telnyx_msg_1',
    });

    await app.close();
  });

  it('repairs an already-stored status event on duplicate retry once the delivery exists', async () => {
    const payload = {
      data: {
        id: 'telnyx_evt_1',
        event_type: 'message.finalized',
        payload: {
          id: 'telnyx_msg_1',
          to: [{ status: 'delivered' }],
        },
      },
    };
    const state: TelnyxWebhookTestState = {
      existingEvent: {
        id: 'spe_1',
        tenant_id: null,
        provider: 'telnyx',
        provider_event_id: 'telnyx_evt_1',
        event_type: 'message.finalized',
        provider_message_id: 'telnyx_msg_1',
        raw_payload: JSON.stringify(payload),
      },
      insertedEvents: [],
      deliveryUpdates: [],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const missingDelivery = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(missingDelivery.statusCode).toBe(503);
    expect(missingDelivery.headers['retry-after']).toBe('5');
    expect(missingDelivery.json()).toMatchObject({
      error: { code: 'TELNYX_DELIVERY_NOT_READY' },
    });
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);

    state.delivery = {
      id: 'smd_1',
      tenant_id: 'tnt_1',
      provider: 'telnyx',
      provider_message_id: 'telnyx_msg_1',
      status: 'accepted',
    };

    const repaired = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(repaired.statusCode).toBe(200);
    expect(repaired.json()).toEqual({ received: true, duplicate: true });
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(1);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(state.delivery).toMatchObject({ status: 'delivered' });

    await app.close();
  });

  it('deduplicates repeated Telnyx webhook events', async () => {
    const state = {
      existingEvent: { id: 'spe_1', provider: 'telnyx', provider_event_id: 'telnyx_evt_1' },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.sent',
          payload: { id: 'telnyx_msg_1' },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.insertedEvents).toHaveLength(0);

    await app.close();
  });

  it('does not downgrade delivered finalized state when a later sent event arrives', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const finalized = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_finalized',
          event_type: 'message.finalized',
          payload: {
            id: 'telnyx_msg_1',
            to: [{ status: 'delivered' }],
          },
        },
      }),
    );
    const sent = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_sent',
          event_type: 'message.sent',
          payload: { id: 'telnyx_msg_1' },
        },
      }),
    );

    expect(finalized.statusCode).toBe(200);
    expect(sent.statusCode).toBe(200);
    expect(state.deliveryUpdates).toHaveLength(1);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });
    expect(state.delivery).toMatchObject({ status: 'delivered' });
    expect(state.insertedEvents.map((event) => event.provider_event_id)).toEqual([
      'telnyx_evt_finalized',
      'telnyx_evt_sent',
    ]);

    await app.close();
  });

  it('returns duplicate and skips delivery update after a duplicate insert race', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
      failInsertOnce: true,
      eventOnFailedInsert: {
        id: 'spe_raced',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_event_id: 'telnyx_evt_1',
        event_type: 'message.sent',
        provider_message_id: 'telnyx_msg_1',
      },
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedTelnyxSmsRequest(routePrivateKey, {
        data: {
          id: 'telnyx_evt_1',
          event_type: 'message.sent',
          payload: { id: 'telnyx_msg_1' },
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.insertedEvents).toHaveLength(0);

    await app.close();
  });

  it('rolls back provider event insert when delivery update fails so retry can process it', async () => {
    const state = {
      delivery: {
        id: 'smd_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_message_id: 'telnyx_msg_1',
        status: 'accepted',
      },
      insertedEvents: [] as Record<string, unknown>[],
      deliveryUpdates: [] as Record<string, unknown>[],
      failDeliveryUpdateOnce: true,
    };
    const app = await setupTelnyxApp(createMockDb(state) as Database);
    const payload = {
      data: {
        id: 'telnyx_evt_1',
        event_type: 'message.finalized',
        payload: {
          id: 'telnyx_msg_1',
          to: [{ status: 'delivered' }],
        },
      },
    };

    const failed = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(failed.statusCode).toBe(500);
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.delivery).toMatchObject({ status: 'accepted' });

    const retried = await app.inject(signedTelnyxSmsRequest(routePrivateKey, payload));

    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ received: true });
    expect(state.insertedEvents).toHaveLength(1);
    expect(state.insertedEvents[0]).toMatchObject({
      provider: 'telnyx',
      provider_event_id: 'telnyx_evt_1',
    });
    expect(state.deliveryUpdates).toHaveLength(1);
    expect(state.deliveryUpdates[0]).toMatchObject({ status: 'delivered' });

    await app.close();
  });
});
