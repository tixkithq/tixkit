import type { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from '@tixkit/domain';
import { PaymentEventRepository } from '@tixkit/db';

const SVIX_TOLERANCE_SECONDS = 5 * 60;

type ClerkWebhookData = {
  id?: string;
  email_addresses?: { email_address: string }[];
  first_name?: string;
  last_name?: string;
  image_url?: string;
  name?: string;
};

export const clerkWebhookRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const temporalClient = app.context.temporalClient;
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  app.post('/', async (request, reply) => {
    if (!webhookSecret) {
      request.log.error('CLERK_WEBHOOK_SECRET is not configured; rejecting Clerk webhook');
      return reply.status(503).send({
        error: {
          code: 'WEBHOOK_NOT_CONFIGURED',
          message: 'Clerk webhook verification is not configured',
          requestId: request.id,
        },
      });
    }

    const rawBody = (request as unknown as { rawBody?: string }).rawBody;
    if (!rawBody) {
      throw new WebhookSignatureError('Missing raw body required for signature verification');
    }
    const signature = request.headers['svix-signature'] as string;
    const timestamp = request.headers['svix-timestamp'] as string;
    const msgId = request.headers['svix-id'] as string;

    if (!signature || !timestamp || !msgId) {
      throw new WebhookSignatureError('Missing required webhook headers');
    }

    if (!verifySvixSignature(rawBody, msgId, timestamp, signature, webhookSecret)) {
        throw new WebhookSignatureError('Invalid signature');
      }

    const event = request.body as { type: string; data: ClerkWebhookData };

    // Persist + dedupe before processing. Svix message IDs are unique per event.
    // If a previous attempt stored the event but failed before marking it
    // processed, replay must retry sync instead of treating it as a completed
    // duplicate (same pattern as Stripe webhook handler).
    const eventRepo = new PaymentEventRepository(db);
    let storedEvent = await eventRepo.findByProviderEventId('clerk', msgId);
    if (storedEvent?.processed_at) {
      return reply.status(200).send({ received: true, duplicate: true });
    }
    if (!storedEvent) {
      try {
        storedEvent = await eventRepo.create({
          tenantId: 'system',
          provider: 'clerk',
          providerEventId: msgId,
          eventType: event.type,
          rawPayload: event as unknown as Record<string, unknown>,
          idempotencyKey: `${msgId}-${timestamp}`,
        });
      } catch (err) {
        storedEvent = await eventRepo.findByProviderEventId('clerk', msgId);
        if (!storedEvent) throw err;
        if (storedEvent.processed_at) {
          return reply.status(200).send({ received: true, duplicate: true });
        }
      }
    }

    const isOrgEvent = event.type.startsWith('organization');
    await temporalClient.startClerkIdentitySync({
      eventType: event.type,
      clerkUserId: isOrgEvent ? undefined : event.data.id,
      email: event.data.email_addresses?.[0]?.email_address,
      firstName: event.data.first_name,
      lastName: event.data.last_name,
      avatarUrl: event.data.image_url,
      clerkOrgId: isOrgEvent ? event.data.id : undefined,
      orgName: isOrgEvent ? event.data.name : undefined,
    });

    // Mark only after durable sync has been accepted. Clerk can safely replay
    // unprocessed rows if this final update fails.
    await eventRepo.markProcessed(storedEvent.id);

    return reply.status(200).send({ received: true });
  });
};

/**
 * Verifies a Svix/Clerk webhook signature.
 *
 * Svix signs `${id}.${timestamp}.${body}` with HMAC-SHA256 using the base64
 * secret (after the `whsec_` prefix). The `svix-signature` header is a
 * space-delimited list of `v{n},{base64sig}` entries; a match against any
 * `v1` entry (with constant-time comparison) is accepted. The timestamp must be
 * within tolerance to prevent replay.
 */
export function verifySvixSignature(
  body: string,
  msgId: string,
  timestamp: string,
  signatureHeader: string,
  secret: string,
): boolean {
  try {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > SVIX_TOLERANCE_SECONDS) return false;

    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${msgId}.${timestamp}.${body}`;
    const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
    const expectedBuf = Buffer.from(expected);

    const candidates = signatureHeader.split(' ');
    for (const candidate of candidates) {
      const [version, value] = candidate.split(',');
      if (version !== 'v1' || !value) continue;
      const providedBuf = Buffer.from(value);
      if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
