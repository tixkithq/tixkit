import type { FastifyPluginAsync } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  type Database,
  MessageConsentRepository,
  SmsDeliveryRepository,
  SmsJobRepository,
  SmsProviderEventRepository,
} from '@tixkit/db';

type TwilioWebhookBody = Record<string, string | string[]>;

const TWILIO_FORM_BODY_LIMIT_BYTES = 32 * 1024;
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'failed']);
const DELIVERY_STATUSES = new Set([
  'accepted',
  'scheduled',
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'undelivered',
  'failed',
  'canceled',
]);
const FAILED_DELIVERY_STATUSES = new Set(['undelivered', 'failed', 'canceled']);
const OPT_OUT_ERROR_CODE = '21610';

export const twilioWebhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: TWILIO_FORM_BODY_LIMIT_BYTES },
      (_request, body, done) => {
        const values: TwilioWebhookBody = {};
        for (const [key, value] of new URLSearchParams(body as string)) {
          const existing = values[key];
          values[key] =
            existing === undefined
              ? value
              : Array.isArray(existing)
                ? [...existing, value]
                : [existing, value];
        }
        done(null, values);
      },
    );
  }

  app.post('/sms', async (request, reply) => {
    const body = isTwilioWebhookBody(request.body) ? request.body : undefined;
    if (!body) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_TWILIO_WEBHOOK',
          message: 'Twilio webhook body must be form encoded',
          requestId: request.id,
        },
      });
    }

    const verification = verifyTwilioWebhookRequest({
      url: configuredTwilioWebhookUrl(),
      params: body,
      signature: request.headers['x-twilio-signature'],
      authToken: process.env.TWILIO_AUTH_TOKEN,
      allowUnsigned: process.env.TWILIO_WEBHOOK_ALLOW_UNSIGNED,
      nodeEnv: process.env.NODE_ENV,
    });
    if (!verification.ok) {
      return reply.status(verification.status).send({
        error: {
          code: verification.code,
          message: verification.message,
          requestId: request.id,
        },
      });
    }

    const providerMessageId = singleString(body.MessageSid) ?? singleString(body.SmsSid);
    const status = singleString(body.MessageStatus)?.trim().toLowerCase();
    const errorCode = singleString(body.ErrorCode)?.trim();
    if (!providerMessageId || !status || !DELIVERY_STATUSES.has(status)) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_TWILIO_WEBHOOK',
          message: 'Twilio webhook is missing a valid MessageSid or MessageStatus',
          requestId: request.id,
        },
      });
    }

    const providerEventId = twilioProviderEventId({ providerMessageId, status, errorCode });
    const eventType = `message.${status}`;
    const normalizedPayload = {
      MessageSid: providerMessageId,
      MessageStatus: status,
      ...(errorCode ? { ErrorCode: errorCode } : {}),
    };

    try {
      const result = await reconcileTwilioStatus(db, {
        providerEventId,
        providerMessageId,
        eventType,
        status,
        errorCode,
        normalizedPayload,
      });
      if (result.retryMissingDelivery) {
        return reply
          .status(503)
          .header('retry-after', '5')
          .send({
            error: {
              code: 'TWILIO_DELIVERY_NOT_READY',
              message: 'SMS delivery is not ready to process this Twilio status webhook',
              requestId: request.id,
            },
          });
      }
      return reply.status(200).send({
        received: true,
        ...(result.duplicate ? { duplicate: true } : {}),
      });
    } catch (error) {
      const racedEvent = await new SmsProviderEventRepository(db).findByProviderEventId(
        'twilio',
        providerEventId,
      );
      if (!racedEvent) throw error;

      const repaired = await reconcileTwilioStatus(db, {
        providerEventId,
        providerMessageId,
        eventType,
        status,
        errorCode,
        normalizedPayload,
      });
      if (repaired.retryMissingDelivery) {
        return reply
          .status(503)
          .header('retry-after', '5')
          .send({
            error: {
              code: 'TWILIO_DELIVERY_NOT_READY',
              message: 'SMS delivery is not ready to process this Twilio status webhook',
              requestId: request.id,
            },
          });
      }
      return reply.status(200).send({ received: true, duplicate: true });
    }
  });
};

async function reconcileTwilioStatus(
  db: Database,
  input: {
    providerEventId: string;
    providerMessageId: string;
    eventType: string;
    status: string;
    errorCode?: string;
    normalizedPayload: Record<string, unknown>;
  },
) {
  return db.transaction().execute(async (trx) => {
    const txDb = trx as typeof db;
    const eventRepo = new SmsProviderEventRepository(txDb);
    const existingEvent = await eventRepo.findByProviderEventId('twilio', input.providerEventId);
    const deliveryRepo = new SmsDeliveryRepository(txDb);
    const delivery = await deliveryRepo.findByProviderMessageId('twilio', input.providerMessageId);

    if (!delivery) {
      return { duplicate: Boolean(existingEvent), retryMissingDelivery: true };
    }

    if (!existingEvent) {
      await eventRepo.create({
        tenantId: delivery.tenant_id,
        provider: 'twilio',
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        providerMessageId: input.providerMessageId,
        rawPayload: input.normalizedPayload,
      });
    }

    const update = twilioDeliveryUpdate(input.status, input.errorCode);
    if (shouldApplyTwilioDeliveryUpdate(delivery.status, update)) {
      await deliveryRepo.update(delivery.id, update);
    }
    await applyTwilioConsentUpdate(txDb, delivery, input.errorCode);

    return { duplicate: Boolean(existingEvent), retryMissingDelivery: false };
  });
}

async function applyTwilioConsentUpdate(
  db: Database,
  delivery: Record<string, unknown>,
  errorCode: string | undefined,
) {
  if (errorCode !== OPT_OUT_ERROR_CODE) return;
  const jobId = typeof delivery.job_id === 'string' ? delivery.job_id : undefined;
  const tenantId = typeof delivery.tenant_id === 'string' ? delivery.tenant_id : undefined;
  if (!jobId || !tenantId) return;

  const job = await new SmsJobRepository(db).findById(jobId);
  if (!job?.to_phone) return;

  await new MessageConsentRepository(db).revokeSmsOptInByPhone({
    tenantId,
    phone: job.to_phone,
  });
}

function twilioDeliveryUpdate(status: string, errorCode?: string): Record<string, unknown> {
  if (status === 'sending' || status === 'sent') {
    return { status: 'sent', sent_at: new Date() };
  }
  if (status === 'delivered' || status === 'read') {
    return { status: 'delivered', delivered_at: new Date() };
  }
  if (FAILED_DELIVERY_STATUSES.has(status)) {
    return {
      status: 'failed',
      failed_at: new Date(),
      failure_reason: errorCode
        ? `Twilio delivery failed (${errorCode})`
        : 'Twilio delivery failed',
    };
  }
  return {};
}

function shouldApplyTwilioDeliveryUpdate(
  currentStatus: unknown,
  update: Record<string, unknown>,
): boolean {
  if (Object.keys(update).length === 0) return false;
  const nextStatus = update.status;
  if (typeof currentStatus !== 'string' || typeof nextStatus !== 'string') return true;
  return !(
    TERMINAL_DELIVERY_STATUSES.has(currentStatus) && !TERMINAL_DELIVERY_STATUSES.has(nextStatus)
  );
}

function configuredTwilioWebhookUrl(): string {
  const explicit = process.env.TWILIO_WEBHOOK_PUBLIC_URL?.trim();
  if (explicit) return explicit;
  const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
  return new URL('/v1/webhooks/twilio/sms', baseUrl).toString();
}

export function verifyTwilioWebhookRequest(input: {
  url: string;
  params: TwilioWebhookBody;
  signature: unknown;
  authToken?: string;
  allowUnsigned?: string;
  nodeEnv?: string;
}): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const authToken = input.authToken?.trim();
  if (!authToken) {
    if (input.nodeEnv === 'test' && input.allowUnsigned === 'true') return { ok: true };
    return {
      ok: false,
      status: 503,
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'Twilio webhook auth token is not configured',
    };
  }
  if (typeof input.signature !== 'string' || input.signature.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'X-Twilio-Signature header is required',
    };
  }

  const payload = twilioSignaturePayload(input.url, input.params);
  const expected = createHmac('sha1', authToken).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(input.signature, 'base64');
  } catch {
    actual = Buffer.alloc(0);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Twilio webhook signature is invalid',
    };
  }
  return { ok: true };
}

function twilioSignaturePayload(url: string, params: TwilioWebhookBody): string {
  let payload = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    const values = Array.isArray(value) ? [...value].sort() : [value];
    for (const item of values) payload += `${key}${item}`;
  }
  return payload;
}

function twilioProviderEventId(input: {
  providerMessageId: string;
  status: string;
  errorCode?: string;
}): string {
  return `sha256:${createHash('sha256')
    .update(`${input.providerMessageId}\0${input.status}\0${input.errorCode ?? ''}`)
    .digest('hex')}`;
}

function singleString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isTwilioWebhookBody(value: unknown): value is TwilioWebhookBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      typeof item === 'string' ||
      (Array.isArray(item) && item.every((nested) => typeof nested === 'string')),
  );
}
