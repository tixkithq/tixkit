import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashWaitlistClaimToken } from '../routes/modules/waitlist.js';

describe('waitlist claim tokens', () => {
  it('hashes claim tokens with a stable non-reversible SHA-256 digest', () => {
    const token = 'claim_token_test_123';
    expect(hashWaitlistClaimToken(token)).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(hashWaitlistClaimToken(token)).not.toContain(token);
  });

  it('produces different hashes for different claim tokens', () => {
    expect(hashWaitlistClaimToken('claim_a')).not.toBe(
      hashWaitlistClaimToken('claim_b'),
    );
  });
});
