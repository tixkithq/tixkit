import type { BaseEntity, ISO8601Date, TenantScopedEntity, Ulid } from '../shared/index.js';
import type { ApiVersion } from '../shared/index.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from '../errors/index.js';

export type WebhookEndpoint = TenantScopedEntity & {
  organizationId: Ulid;
  url: string;
  secret: string;
  events: WebhookEventType[];
  status: 'active' | 'disabled';
  description?: string;
};

export const WEBHOOK_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.refunded',
  'order.disputed',
  'ticket.issued',
  'ticket.checked_in',
  'attendee.updated',
  'event.published',
  'event.cancelled',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_DATA_SCHEMAS = {
  'order.created': objectSchema(['orderId', 'eventId', 'checkoutSessionId']),
  'order.paid': objectSchema(['orderId', 'eventId', 'checkoutSessionId']),
  'order.refunded': objectSchema(['orderId', 'eventId', 'checkoutSessionId']),
  'order.disputed': objectSchema(['orderId', 'eventId', 'checkoutSessionId']),
  'ticket.issued': objectSchema(['orderId', 'ticketIds'], {
    ticketIds: { type: 'array', items: { type: 'string' } },
  }),
  'ticket.checked_in': objectSchema(['ticketId', 'eventId', 'checkInListId']),
  'attendee.updated': objectSchema(['attendeeId', 'eventId']),
  'event.published': objectSchema(['eventId']),
  'event.cancelled': objectSchema(['eventId']),
} as const satisfies Record<WebhookEventType, unknown>;

export const WEBHOOK_CANONICAL_DATA_FIXTURES = {
  'order.created': {
    orderId: 'ord_example',
    eventId: 'evt_example',
    checkoutSessionId: 'cs_example',
  },
  'order.paid': {
    orderId: 'ord_example',
    eventId: 'evt_example',
    checkoutSessionId: 'cs_example',
  },
  'order.refunded': {
    orderId: 'ord_example',
    eventId: 'evt_example',
    checkoutSessionId: 'cs_example',
  },
  'order.disputed': {
    orderId: 'ord_example',
    eventId: 'evt_example',
    checkoutSessionId: 'cs_example',
  },
  'ticket.issued': { orderId: 'ord_example', ticketIds: ['tkt_example'] },
  'ticket.checked_in': {
    ticketId: 'tkt_example',
    eventId: 'evt_example',
    checkInListId: 'cil_example',
  },
  'attendee.updated': { attendeeId: 'att_example', eventId: 'evt_example' },
  'event.published': { eventId: 'evt_example' },
  'event.cancelled': { eventId: 'evt_example' },
} as const satisfies Record<WebhookEventType, Record<string, unknown>>;

export function validateWebhookEventData(
  type: string,
  data: Record<string, unknown>,
): { success: true } | { success: false; issues: string[] } {
  if (!WEBHOOK_EVENT_TYPES.includes(type as WebhookEventType)) {
    return {
      success: false,
      issues: [`Unsupported webhook event type: ${type}`],
    };
  }
  const schema = WEBHOOK_DATA_SCHEMAS[type as WebhookEventType];
  const issues: string[] = [];
  for (const field of schema.required) {
    if (!(field in data)) {
      issues.push(`Missing required webhook data field: ${field}`);
      continue;
    }
    const property = schema.properties[field as keyof typeof schema.properties] as
      | { type?: string; items?: { type?: string } }
      | undefined;
    const value = data[field];
    if (property?.type === 'string' && typeof value !== 'string') {
      issues.push(`Webhook data field ${field} must be a string`);
    } else if (property?.type === 'integer' && !Number.isInteger(value)) {
      issues.push(`Webhook data field ${field} must be an integer`);
    } else if (property?.type === 'array') {
      if (!Array.isArray(value)) {
        issues.push(`Webhook data field ${field} must be an array`);
      } else if (
        property.items?.type === 'string' &&
        value.some((item) => typeof item !== 'string')
      ) {
        issues.push(`Webhook data field ${field} must contain only strings`);
      }
    }
  }
  return issues.length === 0 ? { success: true } : { success: false, issues };
}

function objectSchema(required: readonly string[], overrides: Record<string, unknown> = {}) {
  return {
    type: 'object',
    additionalProperties: true,
    required,
    properties: Object.fromEntries(
      required.map((name) => [name, overrides[name] ?? { type: 'string' }]),
    ),
  } as const;
}

export const WEBHOOK_EVENT_CATALOG = WEBHOOK_EVENT_TYPES.map((type) => ({
  type,
  subscribable: true,
  test: false,
  delivery: 'at-least-once' as const,
  ordering: 'not-guaranteed' as const,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'type', 'apiVersion', 'createdAt', 'tenantId', 'organizationId', 'data'],
    properties: {
      id: { type: 'string' },
      type: { const: type },
      apiVersion: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      tenantId: { type: 'string' },
      organizationId: { type: 'string' },
      data: WEBHOOK_DATA_SCHEMAS[type],
    },
  },
}));

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
