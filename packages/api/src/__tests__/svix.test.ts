import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySvixSignature } from '../routes/modules/clerk-webhooks.js';

const SECRET = 'whsec_test-secret-for-svix-verification';

function sign(body: string, msgId: string, timestamp: number, secret: string): string {
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${msgId}.${timestamp}.${body}`;
  const sig = createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  return `v1,${sig}`;
}

describe('verifySvixSignature', () => {
  const body = '{"type":"user.created","data":{"id":"user_1"}}';
  const msgId = 'msg_pre_abc123';
  const validTimestamp = Math.floor(Date.now() / 1000);

  it('accepts a valid signature', () => {
    const signature = sign(body, msgId, validTimestamp, SECRET);
    expect(verifySvixSignature(body, msgId, String(validTimestamp), signature, SECRET)).toBe(true);
  });

  it('rejects tampered body', () => {
    const signature = sign(body, msgId, validTimestamp, SECRET);
    expect(verifySvixSignature('{"type":"user.deleted","data":{}}', msgId, String(validTimestamp), signature, SECRET)).toBe(false);
  });

  it('rejects wrong message ID', () => {
    const signature = sign(body, msgId, validTimestamp, SECRET);
    expect(verifySvixSignature(body, 'msg_wrong', String(validTimestamp), signature, SECRET)).toBe(false);
  });

  it('rejects expired timestamp (outside tolerance)', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const signature = sign(body, msgId, oldTimestamp, SECRET);
    expect(verifySvixSignature(body, msgId, String(oldTimestamp), signature, SECRET)).toBe(false);
  });

  it('rejects future timestamp (outside tolerance)', () => {
    const futureTimestamp = Math.floor(Date.now() / 1000) + 600; // 10 minutes ahead
    const signature = sign(body, msgId, futureTimestamp, SECRET);
    expect(verifySvixSignature(body, msgId, String(futureTimestamp), signature, SECRET)).toBe(false);
  });

  it('rejects signature from wrong secret', () => {
    const signature = sign(body, msgId, validTimestamp, 'whsec_wrong-secret');
    expect(verifySvixSignature(body, msgId, String(validTimestamp), signature, SECRET)).toBe(false);
  });

  it('rejects malformed signature header', () => {
    expect(verifySvixSignature(body, msgId, String(validTimestamp), 'not-a-valid-signature', SECRET)).toBe(false);
  });

  it('rejects empty signature header', () => {
    expect(verifySvixSignature(body, msgId, String(validTimestamp), '', SECRET)).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    const signature = sign(body, msgId, validTimestamp, SECRET);
    expect(verifySvixSignature(body, msgId, 'not-a-number', signature, SECRET)).toBe(false);
  });

  it('accepts signature with multiple v1 entries (one valid)', () => {
    const validSig = sign(body, msgId, validTimestamp, SECRET);
    const fakeSig = 'v1,invalidbase64==';
    const multiSig = `${fakeSig} ${validSig}`;
    expect(verifySvixSignature(body, msgId, String(validTimestamp), multiSig, SECRET)).toBe(true);
  });

  it('rejects signature with only non-v1 versions', () => {
    const sig = sign(body, msgId, validTimestamp, SECRET);
    const v2Sig = sig.replace('v1,', 'v2,');
    expect(verifySvixSignature(body, msgId, String(validTimestamp), v2Sig, SECRET)).toBe(false);
  });

  it('handles secret without whsec_ prefix', () => {
    const rawSecret = SECRET.replace(/^whsec_/, '');
    const signature = sign(body, msgId, validTimestamp, SECRET);
    expect(verifySvixSignature(body, msgId, String(validTimestamp), signature, rawSecret)).toBe(true);
  });
});
