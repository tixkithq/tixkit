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

  it('rejects timestamps with trailing characters instead of accepting a numeric prefix', () => {
    const signature = signWebhookPayload({ payload: body, secret, timestamp }).replace(
      `t=${timestamp}`,
      `t=${timestamp}junk`,
    );

    expect(() =>
      verifyWebhookSignature({
        body,
        signature,
        secret,
        nowSeconds: timestamp,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects timestamps outside the safe integer range', () => {
    expect(() =>
      verifyWebhookSignature({
        body,
        signature: `t=9007199254740992,v1=${'0'.repeat(64)}`,
        secret,
        nowSeconds: timestamp,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it.each([
    ['trailing non-hex data', `${signWebhookPayload({ payload: body, secret, timestamp })}junk`],
    ['odd-length digest', `t=${timestamp},v1=${'a'.repeat(63)}`],
    ['non-hex digest', `t=${timestamp},v1=${'g'.repeat(64)}`],
    ['truncated digest', `t=${timestamp},v1=${'a'.repeat(62)}`],
    ['oversized digest', `t=${timestamp},v1=${'a'.repeat(66)}`],
  ])('rejects a %s', (_label, signature) => {
    expect(() =>
      verifyWebhookSignature({
        body,
        signature,
        secret,
        nowSeconds: timestamp,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it.each([
    ['bare component', `t=${timestamp},v1=${'a'.repeat(64)},junk`],
    ['leading unknown component', `junk=x,t=${timestamp},v1=${'a'.repeat(64)}`],
    ['duplicate timestamp', `t=${timestamp},t=${timestamp},v1=${'a'.repeat(64)}`],
    ['duplicate digest', `t=${timestamp},v1=${'a'.repeat(64)},v1=${'a'.repeat(64)}`],
    ['reordered fields', `v1=${'a'.repeat(64)},t=${timestamp}`],
  ])('rejects an ambiguous multipart header with a %s', (_label, signature) => {
    expect(() =>
      verifyWebhookSignature({
        body,
        signature,
        secret,
        nowSeconds: timestamp,
      }),
    ).toThrow(WebhookSignatureError);
  });
});
