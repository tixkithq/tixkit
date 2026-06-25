import type { FastifyPluginAsync } from 'fastify';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { SmsDeliveryRepository, SmsProviderEventRepository } from '@gatekit/db';

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

    const eventRepo = new SmsProviderEventRepository(db);
    const existingEvent = await eventRepo.findByProviderEventId('telnyx', providerEventId);
    if (existingEvent) {
      return reply.status(200).send({ received: true, duplicate: true });
    }

    const deliveryRepo = new SmsDeliveryRepository(db);
    const delivery = providerMessageId
      ? await deliveryRepo.findByProviderMessageId('telnyx', providerMessageId)
      : undefined;

    if (delivery && providerMessageId) {
      const update = telnyxDeliveryUpdate(eventType, data?.payload);
      if (Object.keys(update).length > 0) {
        await deliveryRepo.update(delivery.id, update);
      }
    }

    await eventRepo.create({
      tenantId: delivery?.tenant_id ?? null,
      provider: 'telnyx',
      providerEventId,
      eventType,
      providerMessageId,
      rawPayload: body as Record<string, unknown>,
    });

    return reply.status(200).send({ received: true });
  });
};

export function verifyTelnyxWebhookRequest(input: {
  rawBody: string;
  timestamp: unknown;
  signature: unknown;
  publicKey?: string;
  nodeEnv?: string;
}):
  | { ok: true }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
    } {
  const shouldVerify = Boolean(input.publicKey);
  if (!shouldVerify) {
    if (input.nodeEnv === 'production') {
      return {
        ok: false,
        status: 503,
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Telnyx webhook public key is not configured',
      };
    }
    return { ok: true };
  }

  if (typeof input.timestamp !== 'string' || typeof input.signature !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'WEBHOOK_SIGNATURE_MISSING',
      message: 'Telnyx signature headers are required',
    };
  }

  try {
    const key = createTelnyxPublicKey(input.publicKey!);
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
    payload?.errors?.[0]?.detail ?? payload?.errors?.[0]?.title ?? recipientStatus ?? 'Delivery failed';
  return {
    status: 'failed',
    failed_at: new Date(),
    failure_reason: failureReason,
  };
}
