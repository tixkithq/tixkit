import { TixkitClient } from '@tixkit/js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export { TIXKIT_API_VERSION } from '@tixkit/js';

export type TixkitNextClientConfig = {
  apiKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  timeout?: number;
  maxRetries?: number;
};

type HeaderValue = string | string[] | undefined;

type LegacyWebhookRequest = {
  body: string;
  headers: Record<string, HeaderValue>;
};

export type TixkitWebhookRouteHandlerOptions = {
  secret: string;
  toleranceSeconds?: number;
  signatureHeader?: string;
  onEvent?: (
    event: unknown,
    context: { request: Request; body: string },
  ) =>
    | Response
    | Record<string, unknown>
    | void
    | Promise<Response | Record<string, unknown> | void>;
};

export type TixkitCheckoutSessionRouteHandlerOptions = TixkitNextClientConfig & {
  defaultSuccessUrl?: string;
  defaultCancelUrl?: string;
  idempotencyHeader?: string;
};

export function createTixkitClient(config: TixkitNextClientConfig) {
  return new TixkitClient(config);
}

export async function loadPublicEventPage(
  client: TixkitClient,
  eventId: string,
  params?: { locale?: string },
) {
  return client.public.getEventPage(eventId, params);
}

export async function loadPublicEventPageBySlug(
  client: TixkitClient,
  slug: string,
  params: { host: string; locale?: string },
) {
  return client.public.getEventPageBySlug(slug, params);
}

export async function loadPublicEventDiscoveryCard(
  client: TixkitClient,
  eventId: string,
  params?: { locale?: string },
) {
  return client.public.getEventDiscoveryCard(eventId, params);
}

export async function listResaleListings(
  client: TixkitClient,
  eventId: string,
  params?: Parameters<TixkitClient['events']['listResaleListings']>[1],
) {
  return client.events.listResaleListings(eventId, params);
}

export async function createTicketResaleListing(
  client: TixkitClient,
  ticketId: string,
  input: Parameters<TixkitClient['tickets']['createResaleListing']>[1],
) {
  return client.tickets.createResaleListing(ticketId, input);
}

export async function delistResaleListing(
  client: TixkitClient,
  listingId: string,
  input: Parameters<TixkitClient['tickets']['delistResaleListing']>[1],
) {
  return client.tickets.delistResaleListing(listingId, input);
}

export async function getResaleSettlement(client: TixkitClient, listingId: string) {
  return client.tickets.getResaleSettlement(listingId);
}

export async function recordResaleSettlementPayout(
  client: TixkitClient,
  listingId: string,
  input: Parameters<TixkitClient['tickets']['recordResaleSettlementPayout']>[1],
) {
  return client.tickets.recordResaleSettlementPayout(listingId, input);
}

export async function recordResaleSettlementReversal(
  client: TixkitClient,
  listingId: string,
  input: Parameters<TixkitClient['tickets']['recordResaleSettlementReversal']>[1],
) {
  return client.tickets.recordResaleSettlementReversal(listingId, input);
}

export async function createCheckoutTicketResaleListing(
  client: TixkitClient,
  sessionId: string,
  ticketId: string,
  input: Parameters<TixkitClient['checkout']['createTicketResaleListing']>[2],
) {
  return client.checkout.createTicketResaleListing(sessionId, ticketId, input);
}

export function verifyTixkitWebhook(input: {
  body: string;
  signature: string;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  try {
    const parts = new Map(
      input.signature
        .split(',')
        .map((part) => part.trim().split('='))
        .filter(
          (part): part is [string, string] => part.length === 2 && part[0] !== '' && part[1] !== '',
        ),
    );
    const timestamp = Number(parts.get('t'));
    const received = parts.get('v1');
    if (!Number.isFinite(timestamp) || !received) return false;

    const toleranceSeconds = input.toleranceSeconds ?? 300;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > toleranceSeconds) return false;

    const expected = createHmac('sha256', input.secret)
      .update(`${timestamp}.${input.body}`)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function headerValue(
  headers: Headers | Record<string, HeaderValue>,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

function parseJsonBody(body: string): unknown {
  return body ? JSON.parse(body) : null;
}

export function createWebhookHandler(secret: string) {
  return async (request: LegacyWebhookRequest) => {
    const signature = headerValue(request.headers, 'x-tixkit-signature');

    if (!signature || !verifyTixkitWebhook({ body: request.body, signature, secret })) {
      return { status: 401, body: { error: 'Invalid signature' } };
    }

    let event: unknown;
    try {
      event = parseJsonBody(request.body);
    } catch {
      return { status: 400, body: { error: 'Invalid JSON body' } };
    }

    return { status: 200, body: { received: true, event } };
  };
}

export function createTixkitWebhookRouteHandler(options: TixkitWebhookRouteHandlerOptions) {
  const signatureHeader = options.signatureHeader ?? 'x-tixkit-signature';

  return async function tixkitWebhookRouteHandler(request: Request): Promise<Response> {
    const body = await request.text();
    const signature = headerValue(request.headers, signatureHeader);

    if (
      !signature ||
      !verifyTixkitWebhook({
        body,
        signature,
        secret: options.secret,
        toleranceSeconds: options.toleranceSeconds,
      })
    ) {
      return jsonResponse({ error: 'Invalid signature' }, { status: 401 });
    }

    let event: unknown;
    try {
      event = parseJsonBody(body);
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const result = await options.onEvent?.(event, { request, body });
    if (result instanceof Response) return result;
    if (result !== undefined) return jsonResponse(result, { status: 200 });

    return jsonResponse({ received: true, event }, { status: 200 });
  };
}

export function createCheckoutSessionRouteHandler(
  options: TixkitCheckoutSessionRouteHandlerOptions,
) {
  const client = createTixkitClient(options);
  const idempotencyHeader = options.idempotencyHeader ?? 'idempotency-key';

  return async function tixkitCheckoutSessionRouteHandler(request: Request): Promise<Response> {
    let input: Record<string, unknown>;
    try {
      const parsed = parseJsonBody(await request.text());
      input =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const idempotencyKey = headerValue(request.headers, idempotencyHeader);
    if (!idempotencyKey) {
      return jsonResponse({ error: 'Missing idempotency key' }, { status: 400 });
    }

    try {
      const session = await client.checkout.create({
        ...input,
        successUrl: input.successUrl ?? options.defaultSuccessUrl,
        cancelUrl: input.cancelUrl ?? options.defaultCancelUrl,
        idempotencyKey,
      } as Parameters<typeof client.checkout.create>[0]);
      return jsonResponse(session, { status: 201 });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: unknown }).statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 502;
      const message = err instanceof Error ? err.message : 'Checkout session creation failed';
      return jsonResponse({ error: message }, { status });
    }
  };
}
