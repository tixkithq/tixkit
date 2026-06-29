/**
 * Server-only entrypoint for @tixkit/astro.
 *
 * This module uses `node:crypto` and must never be imported from client-side
 * Astro code. Use the `./server` subpath import:
 *
 * ```ts
 * import { createTixkitClient, verifyTixkitWebhook } from '@tixkit/astro/server';
 * ```
 */
import { TixkitClient } from '@tixkit/js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export { TIXKIT_API_VERSION } from '@tixkit/js';

export type TixkitAstroClientConfig = {
  apiKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  timeout?: number;
  maxRetries?: number;
};

export type CheckoutFormActionRequest = {
  request: {
    formData(): Promise<FormData>;
  };
};

export type CheckoutFormActionResult =
  | { success: true; session: Awaited<ReturnType<TixkitClient['checkout']['create']>> }
  | {
      success: false;
      status: 400 | 502;
      error: string;
      fieldErrors?: Record<string, string>;
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

export type TixkitAstroEndpointHandler = (context: {
  request: Request;
  url: URL;
  site?: URL;
}) => Promise<Response>;

export function createTixkitClient(config: TixkitAstroClientConfig) {
  return new TixkitClient(config);
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

export async function loadEvent(eventId: string, client: TixkitClient) {
  return client.events.get(eventId);
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

export async function createCheckoutAction(
  client: TixkitClient,
  formData: {
    eventId: string;
    items: { ticketTypeId: string; quantity: number }[];
    idempotencyKey: string;
  },
) {
  return client.checkout.create(formData);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return parsePositiveIntegerString(value);
}

function parsePositiveIntegerString(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseCheckoutItems(formData: FormData): {
  items: { ticketTypeId?: string; productId?: string; quantity: number }[];
  fieldErrors: Record<string, string>;
} {
  const items: { ticketTypeId?: string; productId?: string; quantity: number }[] = [];
  const fieldErrors: Record<string, string> = {};

  const ticketTypeIds = formData.getAll('ticketTypeId');
  const ticketQuantities = formData.getAll('quantity');
  for (let index = 0; index < ticketTypeIds.length; index += 1) {
    const ticketTypeId = optionalString(ticketTypeIds[index] ?? null);
    if (!ticketTypeId) continue;
    const quantity = parsePositiveInteger(ticketQuantities[index] ?? ticketQuantities[0] ?? null);
    if (!quantity) {
      fieldErrors.quantity = 'Ticket quantity must be a positive integer.';
      continue;
    }
    items.push({ ticketTypeId, quantity });
  }

  const productIds = formData.getAll('productId');
  const productQuantities = formData.getAll('productQuantity');
  for (let index = 0; index < productIds.length; index += 1) {
    const productId = optionalString(productIds[index] ?? null);
    if (!productId) continue;
    const quantity = parsePositiveInteger(productQuantities[index] ?? productQuantities[0] ?? null);
    if (!quantity) {
      fieldErrors.productQuantity = 'Product quantity must be a positive integer.';
      continue;
    }
    items.push({ productId, quantity });
  }

  const encodedItems = optionalString(formData.get('items'));
  if (encodedItems) {
    for (const part of encodedItems.split(',')) {
      const [ticketTypeId, rawQuantity] = part.split('=').map((item) => item.trim());
      if (!ticketTypeId) continue;
      const quantity = rawQuantity ? parsePositiveIntegerString(rawQuantity) : null;
      if (!quantity) {
        fieldErrors.items =
          'Encoded items must use ticketTypeId=quantity pairs with positive integer quantities.';
        continue;
      }
      items.push({ ticketTypeId, quantity });
    }
  }

  if (items.length === 0 && Object.keys(fieldErrors).length === 0) {
    fieldErrors.items = 'Choose at least one ticket or product.';
  }

  return { items, fieldErrors };
}

export function createCheckoutFormAction(
  client: TixkitClient,
  defaults: { successUrl?: string; cancelUrl?: string } = {},
) {
  return async function checkoutFormAction(
    event: CheckoutFormActionRequest,
  ): Promise<CheckoutFormActionResult> {
    const formData = await event.request.formData();
    const eventId = optionalString(formData.get('eventId'));
    const idempotencyKey = optionalString(formData.get('idempotencyKey'));
    const { items, fieldErrors } = parseCheckoutItems(formData);

    if (!eventId) fieldErrors.eventId = 'Event is required.';
    if (!idempotencyKey) fieldErrors.idempotencyKey = 'Idempotency key is required.';

    if (Object.keys(fieldErrors).length > 0) {
      return {
        success: false,
        status: 400,
        error: 'Checkout form is invalid.',
        fieldErrors,
      };
    }

    try {
      const session = await client.checkout.create({
        eventId: eventId!,
        items,
        idempotencyKey: idempotencyKey!,
        buyer: {
          email: optionalString(formData.get('buyerEmail')),
          firstName: optionalString(formData.get('buyerFirstName')),
          lastName: optionalString(formData.get('buyerLastName')),
          phone: optionalString(formData.get('buyerPhone')),
        },
        discountCode: optionalString(formData.get('discountCode')),
        accessCode: optionalString(formData.get('accessCode')),
        affiliateCode: optionalString(formData.get('affiliateCode')),
        trackingId: optionalString(formData.get('trackingId')),
        successUrl: optionalString(formData.get('successUrl')) ?? defaults.successUrl,
        cancelUrl: optionalString(formData.get('cancelUrl')) ?? defaults.cancelUrl,
      });
      return { success: true, session };
    } catch (err) {
      return {
        success: false,
        status: 502,
        error: err instanceof Error ? err.message : 'Checkout session creation failed.',
      };
    }
  };
}

export function createTixkitWebhookEndpoint(
  options: TixkitWebhookRouteHandlerOptions,
): TixkitAstroEndpointHandler {
  return async ({ request }) => {
    const body = await request.text();
    const signature = request.headers.get(options.signatureHeader ?? 'tixkit-signature') ?? '';
    if (
      !verifyTixkitWebhook({
        body,
        signature,
        secret: options.secret,
        toleranceSeconds: options.toleranceSeconds,
      })
    ) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const event = JSON.parse(body) as unknown;
    const result = await options.onEvent?.(event, { request, body });
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result ?? { received: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
