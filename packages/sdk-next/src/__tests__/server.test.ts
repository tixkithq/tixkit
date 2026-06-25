import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGateKitWebhook } from '../server.js';

function signature(body: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('Next server webhook helpers', () => {
  it('verifies timestamped GateKit webhook signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const timestamp = Math.floor(Date.now() / 1000);

    expect(
      verifyGateKitWebhook({
        body,
        secret,
        signature: signature(body, secret, timestamp),
      }),
    ).toBe(true);
  });

  it('rejects legacy raw body signatures', () => {
    const body = JSON.stringify({ id: 'wevt_1' });
    const secret = 'whsec_test';
    const legacy = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyGateKitWebhook({ body, secret, signature: legacy })).toBe(false);
  });
});
