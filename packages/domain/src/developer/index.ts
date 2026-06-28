import type { BaseEntity, ISO8601Date, TenantScopedEntity, Ulid } from '../shared/index.js';
import type { ApiVersion } from '../shared/index.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from '../errors/index.js';

export type WebhookEndpoint = TenantScopedEntity & {
  organizationId: Ulid;
  url: string;
  secret: string;
  events: string[];
  status: 'active' | 'disabled';
  description?: string;
};

export type WebhookEventType =
  | 'order.created'
  | 'order.paid'
  | 'order.refunded'
  | 'ticket.issued'
  | 'ticket.checked_in'
  | 'attendee.updated'
  | 'event.published'
  | 'event.cancelled';

export type WebhookEnvelope = {
  id: Ulid;
  type: WebhookEventType;
  apiVersion: ApiVersion;
  createdAt: ISO8601Date;
  tenantId: Ulid;
  organizationId: Ulid;
  data: Record<string, unknown>;
};

export type WebhookDelivery = BaseEntity & {
  endpointId: Ulid | null;
  requestedEndpointId: Ulid;
  eventId: Ulid;
  attempt: number;
  statusCode?: number;
  response?: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead_lettered';
  deliveredAt?: ISO8601Date;
  nextRetryAt?: ISO8601Date;
};

export type WebhookEvent = BaseEntity & {
  tenantId: Ulid;
  organizationId: Ulid;
  type: WebhookEventType;
  payload: WebhookEnvelope;
  deliveries: WebhookDelivery[];
  status: 'pending' | 'delivered' | 'failed';
};

export type CreateWebhookEndpointInput = {
  organizationId: Ulid;
  url: string;
  events: WebhookEventType[];
  description?: string;
};

export type UpdateWebhookEndpointInput = Partial<
  Pick<WebhookEndpoint, 'url' | 'events' | 'status' | 'description'>
>;

export type SandboxMode = {
  enabled: boolean;
  mockProviders: boolean;
  testClock?: ISO8601Date;
};

const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function signWebhookPayload(input: {
  payload: string;
  secret: string;
  timestamp?: number;
}): string {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${input.payload}`;
  const signature = createHmac('sha256', input.secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(input: {
  body: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const parts = new Map(
    input.signature.split(',').map((part) => {
      const [key, value] = part.split('=', 2);
      return [key, value] as const;
    }),
  );
  const timestampRaw = parts.get('t');
  const signature = parts.get('v1');
  if (!timestampRaw || !signature) {
    throw new WebhookSignatureError('Webhook signature must use t=...,v1=... format');
  }

  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) {
    throw new WebhookSignatureError('Webhook signature timestamp is invalid');
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookSignatureError('Webhook signature timestamp is outside tolerance');
  }

  const expected = signWebhookPayload({
    payload: input.body,
    secret: input.secret,
    timestamp,
  }).split('v1=')[1]!;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(signature, 'hex');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
