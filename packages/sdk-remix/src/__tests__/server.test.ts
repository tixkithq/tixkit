import { describe, expect, it } from 'vitest';
import { TixkitClient } from '@tixkit/js';
import { createTixkitClient, verifyTixkitWebhook } from '../server.js';

describe('Remix server helpers', () => {
  it('creates a server-side Tixkit client', () => {
    expect(createTixkitClient({ apiKey: '***********' })).toBeInstanceOf(TixkitClient);
  });

  it('returns false for an invalid webhook signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 't=1,v1=bad',
      }),
    ).toBe(false);
  });

  it('returns false for a malformed signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 'not-a-signature',
      }),
    ).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: '',
      }),
    ).toBe(false);
  });
});
