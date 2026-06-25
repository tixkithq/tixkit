import { GateKitClient } from '@gatekit/js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export function createGateKitClient(config: { apiKey: string; apiBaseUrl?: string }) {
  return new GateKitClient(config);
}

export function verifyGateKitWebhook(input: {
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
        .filter((part): part is [string, string] => part.length === 2 && part[0] !== '' && part[1] !== ''),
    );
    const timestamp = Number(parts.get('t'));
    const received = parts.get('v1');
    if (!Number.isFinite(timestamp) || !received) return false;

    const toleranceSeconds = input.toleranceSeconds ?? 300;
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > toleranceSeconds) return false;

    const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(received, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// SvelteKit load helper
export async function loadEvent(eventId: string, client: GateKitClient) {
  return client.events.get(eventId);
}

// SvelteKit form action helper
export async function createCheckoutAction(
  client: GateKitClient,
  formData: {
    eventId: string;
    items: { ticketTypeId: string; quantity: number }[];
    idempotencyKey: string;
  },
) {
  return client.checkout.create(formData);
}

// Checkout widget component (Svelte component compiled separately)
export const checkoutWidgetUrl = (config: { widgetBaseUrl?: string; apiBaseUrl?: string; brand: string; event: string; locale?: string; theme?: string }) => {
  const base = config.widgetBaseUrl ?? 'https://widget.gatekit.com';
  const params = new URLSearchParams();
  if (config.brand) params.set('brand', config.brand);
  if (config.locale) params.set('locale', config.locale);
  if (config.theme) params.set('theme', config.theme);
  return `${base}/e/${config.event}?${params.toString()}`;
};
