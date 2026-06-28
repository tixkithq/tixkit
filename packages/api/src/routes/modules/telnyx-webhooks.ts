import type { FastifyPluginAsync } from 'fastify';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  type Database,
  MessageConsentRepository,
  SmsDeliveryRepository,
  SmsJobRepository,
  SmsProviderEventRepository,
} from '@tixkit/db';

type TelnyxWebhookData = {
  id?: string;
  event_type?: string;
  occurred_at?: string;
  payload?: {
    id?: string;
    direction?: string;
    errors?: Array<{ title?: string; detail?: string }>;
    to?: Array<{ status?: string }>;
  };
};

type TelnyxWebhookBody = {
  data?: TelnyxWebhookData;
  meta?: Record<string, unknown>;
};

const RAW_ED25519_PUBLIC_KEY_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const TELNYX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'failed']);
const DELIVERY_STATUS_EVENT_TYPES = new Set(['message.sent', 'message.finalized']);

export const telnyxWebhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/sms', async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_RAW_BODY',
          message: 'Raw body is required for Telnyx webhook verification',
          requestId: request.id,
        },
      });
    }

    const verification = verifyTelnyxWebhookRequest({
      rawBody,
      timestamp: request.headers['telnyx-timestamp'],
      signature: request.headers['telnyx-signature-ed25519'],
      publicKey: process.env.TELNYX_WEBHOOK_PUBLIC_KEY ?? process.env.TELNYX_PUBLIC_KEY,
      allowUnsigned: process.env.TELNYX_WEBHOOK_ALLOW_UNSIGNED,
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

    const body = request.body as TelnyxWebhookBody;
    const data = body.data;
    const providerEventId = data?.id;
    const eventType = data?.event_type;
    const providerMessageId = data?.payload?.id;

    if (!providerEventId || !eventType) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_TELNYX_WEBHOOK',
          message: 'Telnyx webhook is missing data.id or data.event_type',
          requestId: request.id,
        },
      });
    }

    try {
      const result = await db.transaction().execute(async (trx) => {
        const txDb = trx as typeof db;
        const eventRepo = new SmsProviderEventRepository(txDb);
        const existingEvent = await eventRepo.findByProviderEventId('telnyx', providerEventId);
        if (existingEvent) {
          const existingStatusEvent = storedTelnyxStatusEvent(existingEvent, data);
          if (existingStatusEvent) {
            const deliveryRepo = new SmsDeliveryRepository(txDb);
            const delivery = await deliveryRepo.findByProviderMessageId(
              'telnyx',
              existingStatusEvent.providerMessageId,
            );

            if (!delivery) {
              return { duplicate: true, retryMissingDelivery: true };
            }

            const update = telnyxDeliveryUpdate(
              existingStatusEvent.eventType,
              existingStatusEvent.payload,
            );
            if (shouldApplyTelnyxDeliveryUpdate(delivery.status, update)) {
              await deliveryRepo.update(delivery.id, update);
            }
            await applyTelnyxConsentUpdate(txDb, delivery, update);
          }

          return { duplicate: true, retryMissingDelivery: false };
        }

        const deliveryRepo = new SmsDeliveryRepository(txDb);
        const delivery = providerMessageId
          ? await deliveryRepo.findByProviderMessageId('telnyx', providerMessageId)
          : undefined;

        if (shouldRetryUntilDeliveryExists(eventType, providerMessageId, delivery)) {
          return { duplicate: false, retryMissingDelivery: true };
        }

        await eventRepo.create({
          tenantId: delivery?.tenant_id ?? null,
          provider: 'telnyx',
          providerEventId,
          eventType,
          providerMessageId,
          rawPayload: body as Record<string, unknown>,
        });

        if (delivery && providerMessageId) {
          const update = telnyxDeliveryUpdate(eventType, data?.payload);
          if (shouldApplyTelnyxDeliveryUpdate(delivery.status, update)) {
            await deliveryRepo.update(delivery.id, update);
          }
          await applyTelnyxConsentUpdate(txDb, delivery, update);
        }

        return { duplicate: false, retryMissingDelivery: false };
      });

      if (result.retryMissingDelivery) {
        return reply
          .status(503)
          .header('retry-after', '5')
          .send({
            error: {
              code: 'TELNYX_DELIVERY_NOT_READY',
              message: 'SMS delivery is not ready to process this Telnyx status webhook',
              requestId: request.id,
            },
          });
      }
      if (result.duplicate) {
        return reply.status(200).send({ received: true, duplicate: true });
      }
    } catch (err) {
      const eventRepo = new SmsProviderEventRepository(db);
      const racedEvent = await eventRepo.findByProviderEventId('telnyx', providerEventId);
      if (racedEvent) {
        return reply.status(200).send({ received: true, duplicate: true });
      }
      throw err;
    }

    return reply.status(200).send({ received: true });
  });
};

function shouldRetryUntilDeliveryExists(
  eventType: string,
  providerMessageId: string | undefined,
  delivery: unknown,
): boolean {
  return Boolean(providerMessageId && DELIVERY_STATUS_EVENT_TYPES.has(eventType) && !delivery);
}

async function applyTelnyxConsentUpdate(
  db: Database,
  delivery: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  if (update.status !== 'failed') return;
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

function storedTelnyxStatusEvent(
  event: Record<string, unknown>,
  currentData: TelnyxWebhookData | undefined,
):
  | {
      eventType: string;
      providerMessageId: string;
      payload: TelnyxWebhookData['payload'];
    }
  | undefined {
  const rawData = telnyxDataFromRawPayload(event.raw_payload);
  const eventType =
    typeof event.event_type === 'string'
      ? event.event_type
      : typeof rawData?.event_type === 'string'
        ? rawData.event_type
        : undefined;
  const providerMessageId =
    typeof event.provider_message_id === 'string'
      ? event.provider_message_id
      : typeof rawData?.payload?.id === 'string'
        ? rawData.payload.id
        : undefined;

  if (!eventType || !providerMessageId || !DELIVERY_STATUS_EVENT_TYPES.has(eventType)) {
    return undefined;
  }

  return {
    eventType,
    providerMessageId,
    payload: rawData?.payload ?? currentData?.payload,
  };
}

function telnyxDataFromRawPayload(rawPayload: unknown): TelnyxWebhookData | undefined {
  let payload = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return undefined;
    }
  }

  if (!isRecord(payload) || !isRecord(payload.data)) return undefined;
  return payload.data as TelnyxWebhookData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function verifyTelnyxWebhookRequest(input: {
  rawBody: string;
  timestamp: unknown;
  signature: unknown;
  publicKey?: string;
  allowUnsigned?: string;
  nodeEnv?: string;
}):
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    } {
  const publicKey = typeof input.publicKey === 'string' ? input.publicKey.trim() : '';
  if (!publicKey) {
    if (input.nodeEnv === 'test' && input.allowUnsigned === 'true') return { ok: true };

    return {
      ok: false,
      status: 503,
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'Telnyx webhook public key is not configured',
    };
  }

  if (typeof input.timestamp !== 'string' || typeof input.signature !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Telnyx signature headers are required',
    };
  }

  const timestamp = parseTelnyxTimestamp(input.timestamp);
  if (timestamp === undefined) {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Telnyx webhook timestamp is invalid',
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const earliestAllowed = nowSeconds - TELNYX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const latestAllowed = nowSeconds + TELNYX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  if (timestamp < earliestAllowed || timestamp > latestAllowed) {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Telnyx webhook timestamp is outside the allowed tolerance',
    };
  }

  try {
    const key = createTelnyxPublicKey(publicKey);
    const payload = Buffer.from(`${input.timestamp}|${input.rawBody}`);
    const signature = Buffer.from(input.signature, 'base64');
    if (!verifySignature(null, payload, key, signature)) {
      return {
        ok: false,
        status: 400,
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Telnyx webhook signature is invalid',
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: err instanceof Error ? err.message : 'Telnyx webhook signature is invalid',
    };
  }
}

function parseTelnyxTimestamp(timestamp: string): number | undefined {
  if (!/^\d+$/.test(timestamp)) return undefined;
  const parsed = Number(timestamp);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

function createTelnyxPublicKey(publicKey: string) {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    return createPublicKey(trimmed);
  }

  const raw =
    /^[0-9a-f]+$/i.test(trimmed) && trimmed.length === 64
      ? Buffer.from(trimmed, 'hex')
      : Buffer.from(trimmed, 'base64');
  return createPublicKey({
    key: Buffer.concat([RAW_ED25519_PUBLIC_KEY_DER_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function telnyxDeliveryUpdate(
  eventType: string,
  payload: TelnyxWebhookData['payload'],
): Record<string, unknown> {
  if (eventType === 'message.sent') {
    return {
      status: 'sent',
      sent_at: new Date(),
    };
  }

  if (eventType !== 'message.finalized') {
    return {};
  }

  const recipientStatus = payload?.to?.[0]?.status;
  if (recipientStatus === 'delivered') {
    return {
      status: 'delivered',
      delivered_at: new Date(),
    };
  }

  const failureReason =
    payload?.errors?.[0]?.detail ??
    payload?.errors?.[0]?.title ??
    recipientStatus ??
    'Delivery failed';
  return {
    status: 'failed',
    failed_at: new Date(),
    failure_reason: failureReason,
  };
}

function shouldApplyTelnyxDeliveryUpdate(
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
