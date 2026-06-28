import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTixkitClient, verifyTixkitWebhook } from '../server.js';
import { TixkitClient } from '@tixkit/js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Vue server helpers', () => {
  it('createTixkitClient returns a TixkitClient instance', () => {
    const client = createTixkitClient({ apiKey: 'test-key-placeholder' });
    expect(client).toBeInstanceOf(TixkitClient);
  });

  it('verifyTixkitWebhook accepts a valid signature', () => {
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

  it('verifyTixkitWebhook returns false for an invalid signature', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';

    expect(
      verifyTixkitWebhook({
        body,
        secret,
        signature: 't=123,v1=invalid',
      }),
    ).toBe(false);
  });

  it('verifyTixkitWebhook returns false for signatures outside tolerance', () => {
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

  it('verifyTixkitWebhook returns false for malformed signatures', () => {
    expect(
      verifyTixkitWebhook({
        body: '{}',
        secret: 'whsec_test',
        signature: 'not-a-valid-signature',
      }),
    ).toBe(false);
  });
});
