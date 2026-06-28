import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTixkitClient, createTixkitWebhookEndpoint, verifyTixkitWebhook } from '../server.js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Astro server helpers', () => {
  it('verifies timestamped Tixkit webhook signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);

    expect(
      verifyTixkitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
      }),
    ).toBe(true);
  });

  it('returns false for invalid signatures', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 't=0,v1=invalid',
      }),
    ).toBe(false);
  });

  it('returns false for signatures outside tolerance', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000) - 301;

    expect(
      verifyTixkitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it('createTixkitClient returns a client instance', () => {
    const client = createTixkitClient({ apiKey: 'sk_test_1' });
    expect(client).toBeDefined();
    expect(typeof client.checkout.create).toBe('function');
  });

  it('createTixkitWebhookEndpoint rejects invalid signatures with 401', async () => {
    const handler = createTixkitWebhookEndpoint({ secret: 'whsec_test' });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body: JSON.stringify({ id: 'wevt_1' }),
      headers: { 'tixkit-signature': 't=0,v1=invalid' },
    });
    const response = await handler({ request, url: new URL(request.url) });
    expect(response.status).toBe(401);
  });

  it('createTixkitWebhookEndpoint accepts valid signatures and calls onEvent', async () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);
    const onEvent = vi.fn().mockResolvedValue({ received: true });
    const handler = createTixkitWebhookEndpoint({ secret, onEvent });
    const request = new Request('https://example.test/api/webhook', {
      method: 'POST',
      body,
      headers: { 'tixkit-signature': signature(body, secret, timestamp) },
    });
    const response = await handler({ request, url: new URL(request.url) });
    expect(response.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
