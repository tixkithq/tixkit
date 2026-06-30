/**
 * Advanced fraud controls and Stripe Radar rule hooks (C-075).
 *
 * A pure risk-signal rules engine for checkout finalization:
 * - Configurable allow/block/review rules (amount thresholds, country blocklist,
 *   velocity limits per email/IP/card fingerprint, email allowlist).
 * - A rolling-window velocity tracker (count events per fingerprint).
 * - Stripe Radar event mapping (review.opened / review.closed /
 *   radar.early_fraud_warning) to an order review status.
 *
 * The engine is pure (no DB): callers feed in the current velocity counts and
 * rules, and persist the resulting RiskDecision. Radar webhook handling maps
 * provider events to order review state.
 */

export type RiskLevel = 'allow' | 'review' | 'block';

export type FingerprintKind = 'email' | 'ip' | 'card';

export type RiskSignal = {
  orderId: string;
  amountCents: number;
  currency: string;
  email?: string;
  ip?: string;
  cardFingerprint?: string;
  country?: string;
};

export type VelocityWindow = {
  durationSeconds: number;
  maxCount: number;
};

export type RiskRule =
  | { type: 'amount_threshold'; minCents?: number; maxCents?: number; action: RiskLevel }
  | { type: 'block_country'; countries: string[]; action: RiskLevel }
  | { type: 'velocity'; fingerprint: FingerprintKind; window: VelocityWindow; action: RiskLevel }
  | { type: 'allow_email'; emails: string[] };

export type VelocityCounts = {
  email?: number;
  ip?: number;
  card?: number;
};

export type RiskDecision = {
  level: RiskLevel;
  score: number;
  reasons: string[];
  triggeredRules: string[];
};

const LEVEL_RANK: Record<RiskLevel, number> = { allow: 0, review: 1, block: 2 };

function fingerprintValue(signal: RiskSignal, kind: FingerprintKind): string | undefined {
  if (kind === 'email') return signal.email;
  if (kind === 'ip') return signal.ip;
  return signal.cardFingerprint;
}

export function evaluateRisk(
  signal: RiskSignal,
  rules: RiskRule[],
  velocityCounts: VelocityCounts,
): RiskDecision {
  let level: RiskLevel = 'allow';
  const reasons: string[] = [];
  const triggered: string[] = [];
  const signalScore = { allow: 0, review: 30, block: 80 };

  for (const rule of rules) {
    const hit = ruleMatches(rule, signal, velocityCounts);
    if (hit.matched) {
      triggered.push(rule.type);
      if (hit.reason) reasons.push(hit.reason);
      if (LEVEL_RANK[hit.action] > LEVEL_RANK[level]) level = hit.action;
    }
  }

  // Allowlist overrides block/review down to allow for known-good emails.
  if (level !== 'allow') {
    const allowRule = rules.find((r) => r.type === 'allow_email');
    if (
      allowRule &&
      allowRule.type === 'allow_email' &&
      signal.email &&
      allowRule.emails.includes(signal.email)
    ) {
      level = 'allow';
      reasons.push('email allowlist override');
    }
  }

  const score = signalScore[level];
  return { level, score, reasons, triggeredRules: [...new Set(triggered)] };
}

function ruleMatches(
  rule: RiskRule,
  signal: RiskSignal,
  velocityCounts: VelocityCounts,
): { matched: boolean; action: RiskLevel; reason?: string } {
  switch (rule.type) {
    case 'amount_threshold': {
      if (rule.minCents !== undefined && signal.amountCents >= rule.minCents) {
        return {
          matched: true,
          action: rule.action,
          reason: `amount ${signal.amountCents} >= threshold ${rule.minCents}`,
        };
      }
      if (rule.maxCents !== undefined && signal.amountCents > rule.maxCents) {
        return {
          matched: true,
          action: rule.action,
          reason: `amount ${signal.amountCents} > max ${rule.maxCents}`,
        };
      }
      return { matched: false, action: 'allow' };
    }
    case 'block_country': {
      if (signal.country && rule.countries.includes(signal.country)) {
        return {
          matched: true,
          action: rule.action,
          reason: `country ${signal.country} blocklisted`,
        };
      }
      return { matched: false, action: 'allow' };
    }
    case 'velocity': {
      const value = fingerprintValue(signal, rule.fingerprint);
      if (!value) return { matched: false, action: 'allow' };
      const count = velocityCounts[rule.fingerprint] ?? 0;
      if (count > rule.window.maxCount) {
        return {
          matched: true,
          action: rule.action,
          reason: `velocity ${rule.fingerprint}=${count} > ${rule.window.maxCount} in ${rule.window.durationSeconds}s`,
        };
      }
      return { matched: false, action: 'allow' };
    }
    case 'allow_email': {
      return { matched: false, action: 'allow' };
    }
  }
}

/**
 * Rolling-window velocity tracker. Stores timestamps per fingerprint and
 * evicts entries outside the window. Pure logic over a mutable map; callers
 * persist as needed.
 */
export class VelocityTracker {
  private readonly events = new Map<string, number[]>();
  private readonly windowSeconds: number;

  constructor(windowSeconds: number) {
    this.windowSeconds = windowSeconds;
  }

  record(fingerprint: string, at: number = Date.now()): void {
    const arr = this.events.get(fingerprint) ?? [];
    arr.push(at);
    this.events.set(fingerprint, arr);
  }

  count(fingerprint: string, at: number = Date.now()): number {
    const arr = this.events.get(fingerprint);
    if (!arr) return 0;
    const cutoff = at - this.windowSeconds * 1000;
    const kept = arr.filter((ts) => ts >= cutoff);
    this.events.set(fingerprint, kept);
    return kept.length;
  }

  /** Build a VelocityCounts snapshot for a signal across all fingerprint kinds. */
  snapshot(signal: RiskSignal, at: number = Date.now()): VelocityCounts {
    return {
      email: signal.email ? this.count(signal.email, at) : undefined,
      ip: signal.ip ? this.count(signal.ip, at) : undefined,
      card: signal.cardFingerprint ? this.count(signal.cardFingerprint, at) : undefined,
    };
  }
}

// ---- Stripe Radar webhook mapping ----

export type RadarReviewEvent = 'review.opened' | 'review.closed' | 'radar.early_fraud_warning';

export type OrderReviewStatus = 'open' | 'released' | 'refunded' | 'flagged';

export function mapRadarEventToReviewStatus(
  event: RadarReviewEvent,
  reviewOutcome?: 'approved' | 'rejected' | 'refunded',
): OrderReviewStatus {
  switch (event) {
    case 'review.opened':
      return 'open';
    case 'review.closed':
      if (reviewOutcome === 'refunded') return 'refunded';
      return reviewOutcome === 'approved' ? 'released' : 'flagged';
    case 'radar.early_fraud_warning':
      return 'flagged';
  }
}

/** Determine whether an order should be held for manual review. */
export function shouldHoldForReview(decision: RiskDecision): boolean {
  return decision.level === 'review' || decision.level === 'block';
}
