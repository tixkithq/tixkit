import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  calculateWaitlistOfferAvailability,
  hashWaitlistClaimToken,
} from '../routes/modules/waitlist.js';

describe('waitlist claim tokens', () => {
  it('hashes claim tokens with a stable non-reversible SHA-256 digest', () => {
    const token = 'claim_token_test_123';
    expect(hashWaitlistClaimToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashWaitlistClaimToken(token)).not.toContain(token);
  });

  it('produces different hashes for different claim tokens', () => {
    expect(hashWaitlistClaimToken('claim_a')).not.toBe(hashWaitlistClaimToken('claim_b'));
  });
});

describe('manual waitlist offer capacity accounting', () => {
  it('subtracts unexpired offered waitlist quantity before issuing another offer', () => {
    expect(
      calculateWaitlistOfferAvailability({
        totalCapacity: 2,
        soldCount: 1,
        activeHoldsQuantity: 0,
        activeOffersQuantity: 1,
      }),
    ).toBe(0);
  });

  it('subtracts active holds and sold inventory from offerable capacity', () => {
    expect(
      calculateWaitlistOfferAvailability({
        totalCapacity: 5,
        soldCount: 2,
        activeHoldsQuantity: 2,
        activeOffersQuantity: 0,
      }),
    ).toBe(1);
  });
});
