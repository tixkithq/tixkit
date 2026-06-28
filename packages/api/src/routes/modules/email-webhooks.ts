import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  EmailDeliveryRepository,
  EmailJobRepository,
  EmailProviderEventRepository,
  EmailSuppressionRepository,
  MessageConsentRepository,
} from '@tixkit/db';

type EmailFeedbackBody = Record<string, unknown>;

const ACTIONABLE_EMAIL_FEEDBACK = new Set(['bounce', 'complaint', 'failure']);

export const emailWebhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/:provider', async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_RAW_BODY',
          message: 'Raw body is required for email webhook verification',
          requestId: request.id,
        },
      });
    }

    const verification = verifyEmailFeedbackWebhookRequest({
      rawBody,
      signature:
        request.headers['tixkit-signature'] ??
        request.headers['x-tixkit-signature'] ??
        request.headers['x-email-webhook-signature'],
      secret: process.env.EMAIL_WEBHOOK_SECRET,
      allowUnsigned: process.env.EMAIL_WEBHOOK_ALLOW_UNSIGNED,
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

    const provider = normalizeProvider((request.params as { provider: string }).provider);
    const body = request.body as EmailFeedbackBody;
    const eventType = normalizeEmailFeedbackType(readString(body, ['type', 'event_type', 'event']));
    const providerMessageId = readString(body, [
      'provider_message_id',
      'message_id',
      'messageId',
      'MessageID',
      'email_id',
    ]);
    const recipientEmail =
      readString(body, ['email', 'recipient_email', 'recipient', 'to']) ??
      readString(readRecord(body.recipient), ['email']);
    const providerEventId =
      readString(body, ['id', 'event_id', 'eventId', 'provider_event_id']) ??
      `${eventType ?? 'unknown'}:${providerMessageId ?? recipientEmail ?? rawBody}`;

    if (!eventType || !ACTIONABLE_EMAIL_FEEDBACK.has(eventType)) {
      return reply.status(200).send({ received: true, ignored: true });
    }

    try {
      const result = await db.transaction().execute(async (trx) => {
        const txDb = trx as typeof db;
        const eventRepo = new EmailProviderEventRepository(txDb);
        const existingEvent = await eventRepo.findByProviderEventId(provider, providerEventId);
        if (existingEvent) {
          return { duplicate: true, retryMissingDelivery: false };
        }

        const deliveryRepo = new EmailDeliveryRepository(txDb);
        const delivery = providerMessageId
          ? await deliveryRepo.findByProviderMessageId(provider, providerMessageId)
          : undefined;

        if (providerMessageId && !delivery && !extractTrustedTenantId(body)) {
          return { duplicate: false, retryMissingDelivery: true };
        }

        const job = delivery
          ? await new EmailJobRepository(txDb).findById(delivery.job_id)
          : undefined;
        const tenantId = delivery?.tenant_id ?? job?.tenant_id ?? extractTrustedTenantId(body);
        const email = recipientEmail ?? job?.to_email;

        await eventRepo.create({
          tenantId: tenantId ?? null,
          provider,
          providerEventId,
          eventType,
          providerMessageId,
          email,
          rawPayload: body,
        });

        if (delivery) {
          await deliveryRepo.update(delivery.id, emailDeliveryUpdate(eventType, body));
        }

        if (tenantId && email) {
          await new EmailSuppressionRepository(txDb).findOrCreate({
            tenantId,
            email,
            reason: eventType === 'complaint' ? 'complaint' : eventType,
            bounceType: eventType === 'bounce' ? normalizeBounceType(body) : undefined,
            source: `email_webhook:${provider}`,
          });
          await new MessageConsentRepository(txDb).revokeEmailOptInByEmail({
            tenantId,
            email,
          });
        }

        return { duplicate: false, retryMissingDelivery: false };
      });

      if (result.retryMissingDelivery) {
        return reply
          .status(503)
          .header('retry-after', '5')
          .send({
            error: {
              code: 'EMAIL_DELIVERY_NOT_READY',
              message: 'Email delivery is not ready to process this provider feedback webhook',
              requestId: request.id,
            },
          });
      }

      if (result.duplicate) {
        return reply.status(200).send({ received: true, duplicate: true });
      }
    } catch (err) {
      const eventRepo = new EmailProviderEventRepository(db);
      const racedEvent = await eventRepo.findByProviderEventId(provider, providerEventId);
      if (racedEvent) {
        return reply.status(200).send({ received: true, duplicate: true });
      }
      throw err;
    }

    return reply.status(200).send({ received: true });
  });
};

export function verifyEmailFeedbackWebhookRequest(input: {
  rawBody: string;
  signature?: string | string[];
  secret?: string;
  allowUnsigned?: string;
  nodeEnv?: string;
}): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!input.secret) {
    if (input.allowUnsigned === 'true' && input.nodeEnv === 'test') return { ok: true };
    return {
      ok: false,
      status: 503,
      code: 'WEBHOOK_NOT_CONFIGURED',
      message: 'Email webhook secret is not configured',
    };
  }

  const signature = Array.isArray(input.signature) ? input.signature[0] : input.signature;
  if (!signature) {
    return {
      ok: false,
      status: 400,
      code: 'MISSING_SIGNATURE',
      message: 'Email webhook signature is required',
    };
  }

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_SIGNATURE',
      message: 'Invalid email webhook signature',
    };
  }

  return { ok: true };
}

function normalizeProvider(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_')
    .slice(0, 50);
}

function normalizeEmailFeedbackType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replaceAll(/[._-]/g, ' ');
  if (normalized.includes('complaint') || normalized.includes('spam')) return 'complaint';
  if (normalized.includes('bounce')) return 'bounce';
  if (
    normalized.includes('failed') ||
    normalized.includes('failure') ||
    normalized.includes('dropped') ||
    normalized.includes('rejected')
  ) {
    return 'failure';
  }
  return undefined;
}

function emailDeliveryUpdate(eventType: string, body: EmailFeedbackBody): Record<string, unknown> {
  const reason =
    readString(body, ['reason', 'description', 'error', 'failure_reason']) ??
    readString(readRecord(body.error), ['message', 'reason']) ??
    eventType;

  if (eventType === 'complaint') {
    return {
      status: 'complained',
      bounced_at: new Date(),
      bounce_reason: reason,
    };
  }

  return {
    status: 'bounced',
    bounced_at: new Date(),
    bounce_reason: reason,
  };
}

function normalizeBounceType(body: EmailFeedbackBody): string {
  const value = readString(body, ['bounce_type', 'bounceType', 'type_detail', 'category']);
  if (!value) return 'hard';
  const normalized = value.toLowerCase();
  if (normalized.includes('soft') || normalized.includes('temporary')) return 'soft';
  return 'hard';
}

function extractTrustedTenantId(body: EmailFeedbackBody): string | undefined {
  const metadata = readRecord(body.metadata) ?? readRecord(body.meta);
  return (
    readString(metadata, ['tenantId', 'tenant_id']) ?? readString(body, ['tenantId', 'tenant_id'])
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
