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

// Route handler helper for checkout webhook processing
export function createWebhookHandler(secret: string) {
  return async (request: { body: string; headers: Record<string, string | string[]> }) => {
    const signature = Array.isArray(request.headers['x-gatekit-signature'])
      ? request.headers['x-gatekit-signature'][0]
      : request.headers['x-gatekit-signature'];

    if (!signature || !verifyGateKitWebhook({ body: request.body, signature, secret })) {
      return { status: 401, body: { error: 'Invalid signature' } };
    }

    const event = JSON.parse(request.body);
    return { status: 200, body: { received: true, event } };
  };
}
