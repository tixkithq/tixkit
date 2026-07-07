import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import {
  emailWebhookRoutes,
  verifyEmailFeedbackWebhookRequest,
} from '../routes/modules/email-webhooks.js';

type EmailWebhookTestState = {
  existingEvent?: Record<string, unknown>;
  delivery?: Record<string, unknown>;
  job?: Record<string, unknown>;
  suppression?: Record<string, unknown>;
  insertedEvents: Record<string, unknown>[];
  insertedSuppressions: Record<string, unknown>[];
  deliveryUpdates: Record<string, unknown>[];
  consentUpdates: Record<string, unknown>[];
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function signedEmailRequest(payload: Record<string, unknown>, secret = 'whsec_email_test') {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    method: 'POST' as const,
    url: '/postmark',
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': `sha256=${signature}`,
    },
    payload: rawBody,
  };
}

function createMockDb(state: EmailWebhookTestState): unknown {
  type QueryFilter = { column: string; value: unknown };

  function createQuery(target: EmailWebhookTestState, table: string) {
    const filters: QueryFilter[] = [];
    const query = {
      selectAll: () => query,
      where: (column: string, _operator: string, value: unknown) => {
        filters.push({ column, value });
        return query;
      },
      async executeTakeFirst() {
        if (table === 'email_provider_events') {
          return [target.existingEvent, ...target.insertedEvents]
            .filter((event): event is Record<string, unknown> => Boolean(event))
            .find((event) =>
              filters.every((filter) => {
                if (filter.column === 'provider') return event.provider === filter.value;
                if (filter.column === 'provider_event_id')
                  return event.provider_event_id === filter.value;
                return true;
              }),
            );
        }
        if (table === 'email_deliveries') return target.delivery;
        if (table === 'email_jobs') return target.job;
        if (table === 'email_suppressions') return target.suppression;
        return undefined;
      },
    };
    return query;
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- keep mock DB builders beside the mocked query state.
  function createInsert(target: EmailWebhookTestState, table: string) {
    return {
      values: (values: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => {
            if (table === 'email_provider_events') target.insertedEvents.push(values);
            if (table === 'email_suppressions') target.insertedSuppressions.push(values);
            return { id: 'new_1', ...values };
          },
        }),
      }),
    };
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- keep mock DB builders beside the mocked query state.
  function createUpdate(target: EmailWebhookTestState, table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        const query = {
          where: () => query,
          execute: async () => {
            if (table === 'message_consents') target.consentUpdates.push(values);
            return { id: 'updated', ...values };
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'email_deliveries') {
                target.deliveryUpdates.push(values);
                if (target.delivery) Object.assign(target.delivery, values);
              }
              return { id: 'updated', ...values };
            },
          }),
        };
        return query;
      },
    };
  }

  function createDbFacade(target: EmailWebhookTestState) {
    return {
      selectFrom: (table: string) => createQuery(target, table),
      insertInto: (table: string) => createInsert(target, table),
      updateTable: (table: string) => createUpdate(target, table),
      transaction: () => ({
        execute: async <T>(callback: (trx: unknown) => Promise<T>): Promise<T> => {
          const txState: EmailWebhookTestState = {
            existingEvent: target.existingEvent ? { ...target.existingEvent } : undefined,
            delivery: target.delivery ? { ...target.delivery } : undefined,
            job: target.job ? { ...target.job } : undefined,
            suppression: target.suppression ? { ...target.suppression } : undefined,
            insertedEvents: target.insertedEvents.map((event) => ({ ...event })),
            insertedSuppressions: target.insertedSuppressions.map((row) => ({ ...row })),
            deliveryUpdates: target.deliveryUpdates.map((update) => ({ ...update })),
            consentUpdates: target.consentUpdates.map((update) => ({ ...update })),
          };

          const result = await callback(createDbFacade(txState));

          target.existingEvent = txState.existingEvent;
          target.delivery = txState.delivery;
          target.job = txState.job;
          target.suppression = txState.suppression;
          target.insertedEvents.length = 0;
          target.insertedEvents.push(...txState.insertedEvents);
          target.insertedSuppressions.length = 0;
          target.insertedSuppressions.push(...txState.insertedSuppressions);
          target.deliveryUpdates.length = 0;
          target.deliveryUpdates.push(...txState.deliveryUpdates);
          target.consentUpdates.length = 0;
          target.consentUpdates.push(...txState.consentUpdates);
          return result;
        },
      }),
    };
  }

  return createDbFacade(state);
}

async function setupEmailWebhookApp(db: Database) {
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
  await app.register(emailWebhookRoutes);
  return app;
}

describe('Email feedback webhook verification', () => {
  const originalSecret = process.env.EMAIL_WEBHOOK_SECRET;
  const originalAllowUnsigned = process.env.EMAIL_WEBHOOK_ALLOW_UNSIGNED;

  afterEach(() => {
    restoreEnv('EMAIL_WEBHOOK_SECRET', originalSecret);
    restoreEnv('EMAIL_WEBHOOK_ALLOW_UNSIGNED', originalAllowUnsigned);
  });

  it('requires a shared secret unless unsigned mode is explicitly enabled for tests', () => {
    const missingSecret = verifyEmailFeedbackWebhookRequest({
      rawBody: JSON.stringify({ id: 'evt_1' }),
      signature: 'sha256=abcd',
      nodeEnv: 'production',
    });
    const unsignedTest = verifyEmailFeedbackWebhookRequest({
      rawBody: JSON.stringify({ id: 'evt_1' }),
      allowUnsigned: 'true',
      nodeEnv: 'test',
    });

    expect(missingSecret.ok).toBe(false);
    if (!missingSecret.ok) expect(missingSecret.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(unsignedTest.ok).toBe(true);
  });

  it('verifies HMAC SHA-256 signatures', () => {
    const rawBody = JSON.stringify({ id: 'evt_1' });
    const signature = createHmac('sha256', 'secret').update(rawBody).digest('hex');

    expect(
      verifyEmailFeedbackWebhookRequest({
        rawBody,
        signature: `sha256=${signature}`,
        secret: 'secret',
      }).ok,
    ).toBe(true);
    expect(
      verifyEmailFeedbackWebhookRequest({
        rawBody,
        signature: 'sha256=001122',
        secret: 'secret',
      }).ok,
    ).toBe(false);
  });

  it('stores bounce feedback, updates delivery, suppresses email, and revokes consent', async () => {
    process.env.EMAIL_WEBHOOK_SECRET = 'whsec_email_test';
    const state: EmailWebhookTestState = {
      delivery: {
        id: 'emd_1',
        tenant_id: 'tnt_1',
        job_id: 'emj_1',
        provider: 'postmark',
        provider_message_id: 'postmark_msg_1',
        status: 'accepted',
      },
      job: {
        id: 'emj_1',
        tenant_id: 'tnt_1',
        to_email: 'buyer@example.com',
      },
      insertedEvents: [],
      insertedSuppressions: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupEmailWebhookApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedEmailRequest({
        id: 'postmark_evt_1',
        type: 'HardBounce',
        message_id: 'postmark_msg_1',
        email: 'buyer@example.com',
        reason: 'Mailbox disabled',
      }),
    );

    expect(res.statusCode, res.body).toBe(200);
    expect(state.insertedEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      provider: 'postmark',
      provider_event_id: 'postmark_evt_1',
      event_type: 'bounce',
      provider_message_id: 'postmark_msg_1',
      email: 'buyer@example.com',
    });
    expect(state.deliveryUpdates[0]).toMatchObject({
      status: 'bounced',
      bounce_reason: 'Mailbox disabled',
    });
    expect(state.insertedSuppressions[0]).toMatchObject({
      tenant_id: 'tnt_1',
      email: 'buyer@example.com',
      reason: 'bounce',
      bounce_type: 'hard',
      source: 'email_webhook:postmark',
    });
    expect(state.consentUpdates[0]).toMatchObject({ email_opt_in: false });

    await app.close();
  });

  it('retries provider-message feedback with payload tenant metadata until delivery is matched', async () => {
    process.env.EMAIL_WEBHOOK_SECRET = 'whsec_email_test';
    const state: EmailWebhookTestState = {
      insertedEvents: [],
      insertedSuppressions: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupEmailWebhookApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedEmailRequest({
        id: 'postmark_evt_unmatched',
        type: 'HardBounce',
        message_id: 'postmark_msg_missing',
        email: 'buyer@example.com',
        metadata: {
          tenantId: 'tnt_payload',
        },
      }),
    );

    expect(res.statusCode, res.body).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json().error.code).toBe('EMAIL_DELIVERY_NOT_READY');
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.insertedSuppressions).toHaveLength(0);
    expect(state.deliveryUpdates).toHaveLength(0);
    expect(state.consentUpdates).toHaveLength(0);

    await app.close();
  });

  it('deduplicates repeated email provider events', async () => {
    process.env.EMAIL_WEBHOOK_SECRET = 'whsec_email_test';
    const state: EmailWebhookTestState = {
      existingEvent: {
        id: 'epe_1',
        provider: 'postmark',
        provider_event_id: 'postmark_evt_1',
      },
      insertedEvents: [],
      insertedSuppressions: [],
      deliveryUpdates: [],
      consentUpdates: [],
    };
    const app = await setupEmailWebhookApp(createMockDb(state) as Database);

    const res = await app.inject(
      signedEmailRequest({
        id: 'postmark_evt_1',
        type: 'SpamComplaint',
        message_id: 'postmark_msg_1',
        email: 'buyer@example.com',
      }),
    );

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(state.insertedEvents).toHaveLength(0);
    expect(state.insertedSuppressions).toHaveLength(0);
    expect(state.consentUpdates).toHaveLength(0);

    await app.close();
  });
});
