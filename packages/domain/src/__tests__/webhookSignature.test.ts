import { describe, expect, it } from 'vitest';
import { WebhookSignatureError } from '../errors/index.js';
import { signWebhookPayload, verifyWebhookSignature } from '../developer/index.js';

describe('webhook signatures', () => {
  const body = JSON.stringify({ id: 'wevt_1', type: 'order.paid' });
  const secret = 'whsec_test_secret';
  const timestamp = 1_782_000_000;

  it('emits and verifies the t=...,v1=... format', () => {
    const signature = signWebhookPayload({ payload: body, secret, timestamp });

    expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(
      verifyWebhookSignature({
        body,
        signature,
        secret,
        nowSeconds: timestamp + 60,
      }),
    ).toBe(true);
  });

  it('rejects tampered payloads', () => {
    const signature = signWebhookPayload({ payload: body, secret, timestamp });

    expect(
      verifyWebhookSignature({
        body: JSON.stringify({ id: 'wevt_1', type: 'order.refunded' }),
        signature,
        secret,
        nowSeconds: timestamp,
      }),
    ).toBe(false);
  });

  it('rejects signatures outside timestamp tolerance', () => {
    const signature = signWebhookPayload({ payload: body, secret, timestamp });

    expect(() =>
      verifyWebhookSignature({
        body,
        signature,
        secret,
        toleranceSeconds: 300,
        nowSeconds: timestamp + 301,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects legacy raw signature strings', () => {
    expect(() =>
      verifyWebhookSignature({
        body,
        signature: 'deadbeef',
        secret,
        nowSeconds: timestamp,
      }),
    ).toThrow(WebhookSignatureError);
  });
});
