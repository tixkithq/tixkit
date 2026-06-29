import { describe, it, expect } from 'vitest';
import {
  evaluateRisk,
  VelocityTracker,
  mapRadarEventToReviewStatus,
  shouldHoldForReview,
  type RiskSignal,
  type RiskRule,
} from '../payments/risk-engine.js';

const baseSignal: RiskSignal = {
  orderId: 'ord_1',
  amountCents: 5000,
  currency: 'USD',
  email: 'buyer@example.test',
  ip: '203.0.113.10',
  cardFingerprint: 'card_fp_1',
  country: 'US',
};

describe('evaluateRisk - amount thresholds', () => {
  it('blocks when amount exceeds a block threshold', () => {
    const rules: RiskRule[] = [
      { type: 'amount_threshold', minCents: 100_000, action: 'block' },
    ];
    const decision = evaluateRisk({ ...baseSignal, amountCents: 150_000 }, rules, {});
    expect(decision.level).toBe('block');
    expect(decision.triggeredRules).toContain('amount_threshold');
    expect(decision.score).toBe(80);
  });

  it('sends to review when amount is in the review band', () => {
    const rules: RiskRule[] = [
      { type: 'amount_threshold', minCents: 50_000, maxCents: 100_000, action: 'review' },
    ];
    const decision = evaluateRisk({ ...baseSignal, amountCents: 60_000 }, rules, {});
    expect(decision.level).toBe('review');
  });

  it('allows small amounts', () => {
    const rules: RiskRule[] = [
      { type: 'amount_threshold', minCents: 50_000, action: 'review' },
    ];
    const decision = evaluateRisk({ ...baseSignal, amountCents: 5_000 }, rules, {});
    expect(decision.level).toBe('allow');
  });
});

describe('evaluateRisk - country blocklist', () => {
  it('blocks blocklisted countries', () => {
    const rules: RiskRule[] = [{ type: 'block_country', countries: ['XX', 'YY'], action: 'block' }];
    const decision = evaluateRisk({ ...baseSignal, country: 'XX' }, rules, {});
    expect(decision.level).toBe('block');
    expect(decision.reasons.some((r) => r.includes('XX'))).toBe(true);
  });

  it('allows non-blocklisted countries', () => {
    const rules: RiskRule[] = [{ type: 'block_country', countries: ['XX'], action: 'block' }];
    expect(evaluateRisk(baseSignal, rules, {}).level).toBe('allow');
  });
});

describe('evaluateRisk - velocity', () => {
  it('reviews when email velocity exceeds the limit', () => {
    const rules: RiskRule[] = [
      {
        type: 'velocity',
        fingerprint: 'email',
        window: { durationSeconds: 3600, maxCount: 3 },
        action: 'review',
      },
    ];
    const decision = evaluateRisk(baseSignal, rules, { email: 5 });
    expect(decision.level).toBe('review');
    expect(decision.reasons.some((r) => r.includes('velocity'))).toBe(true);
  });

  it('blocks when card fingerprint velocity is very high', () => {
    const rules: RiskRule[] = [
      {
        type: 'velocity',
        fingerprint: 'card',
        window: { durationSeconds: 600, maxCount: 2 },
        action: 'block',
      },
    ];
    const decision = evaluateRisk(baseSignal, rules, { card: 10 });
    expect(decision.level).toBe('block');
  });

  it('does not trigger when the fingerprint is absent', () => {
    const rules: RiskRule[] = [
      { type: 'velocity', fingerprint: 'ip', window: { durationSeconds: 60, maxCount: 1 }, action: 'block' },
    ];
    const decision = evaluateRisk({ ...baseSignal, ip: undefined }, rules, {});
    expect(decision.level).toBe('allow');
  });
});

describe('evaluateRisk - allowlist override', () => {
  it('an allowlisted email overrides a block down to allow', () => {
    const rules: RiskRule[] = [
      { type: 'amount_threshold', minCents: 100, action: 'block' },
      { type: 'allow_email', emails: ['trusted@example.test'] },
    ];
    const decision = evaluateRisk(
      { ...baseSignal, amountCents: 500_000, email: 'trusted@example.test' },
      rules,
      {},
    );
    expect(decision.level).toBe('allow');
    expect(decision.reasons).toContain('email allowlist override');
  });
});

describe('evaluateRisk - highest action wins', () => {
  it('block beats review when both rules trigger', () => {
    const rules: RiskRule[] = [
      { type: 'amount_threshold', minCents: 100, action: 'review' },
      { type: 'block_country', countries: ['US'], action: 'block' },
    ];
    const decision = evaluateRisk(baseSignal, rules, {});
    expect(decision.level).toBe('block');
  });
});

describe('VelocityTracker', () => {
  it('counts events within the rolling window and evicts old ones', () => {
    const tracker = new VelocityTracker(60);
    const now = 1_000_000;
    tracker.record('fp_a', now);
    tracker.record('fp_a', now + 10_000);
    tracker.record('fp_a', now + 20_000);
    expect(tracker.count('fp_a', now + 30_000)).toBe(3);
    // After the window passes, old events are evicted.
    expect(tracker.count('fp_a', now + 120_000)).toBe(0);
  });

  it('snapshot counts all fingerprint kinds for a signal', () => {
    const tracker = new VelocityTracker(3600);
    const now = 1_000_000;
    tracker.record(baseSignal.email!, now);
    tracker.record(baseSignal.ip!, now);
    const snap = tracker.snapshot(baseSignal, now + 1000);
    expect(snap.email).toBe(1);
    expect(snap.ip).toBe(1);
    expect(snap.card).toBe(0);
  });
});

describe('Stripe Radar event mapping', () => {
  it('maps review.opened to open', () => {
    expect(mapRadarEventToReviewStatus('review.opened')).toBe('open');
  });

  it('maps review.closed approved to released', () => {
    expect(mapRadarEventToReviewStatus('review.closed', 'approved')).toBe('released');
  });

  it('maps review.closed rejected to flagged', () => {
    expect(mapRadarEventToReviewStatus('review.closed', 'rejected')).toBe('flagged');
  });

  it('maps review.closed refunded to refunded', () => {
    expect(mapRadarEventToReviewStatus('review.closed', 'refunded')).toBe('refunded');
  });

  it('maps radar.early_fraud_warning to flagged', () => {
    expect(mapRadarEventToReviewStatus('radar.early_fraud_warning')).toBe('flagged');
  });
});

describe('shouldHoldForReview', () => {
  it('holds for review and block decisions but not allow', () => {
    expect(shouldHoldForReview({ level: 'review', score: 30, reasons: [], triggeredRules: [] })).toBe(true);
    expect(shouldHoldForReview({ level: 'block', score: 80, reasons: [], triggeredRules: [] })).toBe(true);
    expect(shouldHoldForReview({ level: 'allow', score: 0, reasons: [], triggeredRules: [] })).toBe(false);
  });
});
