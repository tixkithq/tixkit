import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_KEYS,
  P0_TEMPLATE_KEYS,
  P1_TEMPLATE_KEYS,
  P2_TEMPLATE_KEYS,
  TEMPLATE_LIFECYCLES,
  getTemplateLifecycle,
  listTemplateLifecyclesByFamily,
  complianceForCategory,
  type TemplateKey,
  type TemplateCategory,
  type TemplateLifecycleCompliance,
} from '../messaging/template-lifecycles.js';
import { MERGE_TAG_REGISTRY } from '../messaging/merge-tags.js';

const registryKeys = new Set(MERGE_TAG_REGISTRY.map((variable) => variable.key));

const knownTemplateKeys = new Set<string>(TEMPLATE_KEYS);

describe('template lifecycle registry', () => {
  it('expands TemplateKey to include the missing P0 lifecycle keys', () => {
    // The original baseline keys are still present...
    for (const key of [
      'order-confirmed',
      'tickets-issued',
      'order-refunded',
      'event-updated',
      'event-cancelled',
      'attendee-message',
      'staff-order-notification',
      'checkin-device-invited',
    ] as const) {
      expect(TEMPLATE_KEYS).toContain(key);
    }

    // ...and the P0 expansion added the three missing ticketing-critical keys.
    expect(TEMPLATE_KEYS).toContain('payment-failed');
    expect(TEMPLATE_KEYS).toContain('order-cancelled');
    expect(TEMPLATE_KEYS).toContain('event-reminder');
  });

  it('does not duplicate template keys', () => {
    expect(new Set(TEMPLATE_KEYS).size).toBe(TEMPLATE_KEYS.length);
  });

  it('represents every current TemplateKey in the lifecycle registry', () => {
    for (const key of TEMPLATE_KEYS) {
      expect(getTemplateLifecycle(key), `missing lifecycle entry for ${key}`).toBeDefined();
    }
  });

  it('does not register lifecycle entries for unknown template keys', () => {
    for (const entry of TEMPLATE_LIFECYCLES) {
      expect(knownTemplateKeys.has(entry.key), `unknown key registered: ${entry.key}`).toBe(true);
    }
  });

  it('does not duplicate lifecycle entries', () => {
    const keys = TEMPLATE_LIFECYCLES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every P0 lifecycle key family/category/audience/compliance metadata', () => {
    for (const key of P0_TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key);
      expect(entry, `missing P0 entry for ${key}`).toBeDefined();
      expect(entry!.name.trim().length).toBeGreaterThan(0);
      expect(entry!.family).toBeTruthy();
      expect(entry!.category).toBeTruthy();
      expect(entry!.tier).toBe('P0');
      expect(entry!.trigger.trim().length).toBeGreaterThan(0);
      expect(entry!.defaultAudience).toBeTruthy();
      expect(entry!.defaultSubject.trim().length).toBeGreaterThan(0);
      expect(entry!.compliance).toEqual(
        expect.objectContaining({
          requiresUnsubscribe: expect.any(Boolean),
          requiresConsent: expect.any(Boolean),
          bypassesMarketingOptOut: expect.any(Boolean),
          auditLog: expect.any(Boolean),
        }),
      );
    }
  });

  it('requires only merge-tag variables that exist in the registry', () => {
    for (const entry of TEMPLATE_LIFECYCLES) {
      for (const variable of entry.requiredVariables) {
        expect(
          registryKeys.has(variable),
          `${entry.key} requires unknown variable {{${variable}}}`,
        ).toBe(true);
      }
      for (const variable of entry.optionalVariables) {
        expect(
          registryKeys.has(variable),
          `${entry.key} lists unknown optional variable {{${variable}}}`,
        ).toBe(true);
      }
    }
  });

  it('documents required-variable gaps explicitly and only for missing tags', () => {
    for (const entry of TEMPLATE_LIFECYCLES) {
      for (const gap of entry.variableGaps) {
        expect(
          registryKeys.has(gap),
          `${entry.key} lists {{${gap}}} as a gap but it exists in the merge-tag registry`,
        ).toBe(false);
      }
    }
  });

  it('closes all P0 merge-tag gaps now that the variables are registered', () => {
    for (const key of P0_TEMPLATE_KEYS) {
      const entry = getTemplateLifecycle(key);
      expect(entry, `missing P0 entry for ${key}`).toBeDefined();
      expect(entry!.variableGaps, `${key} still has unresolved variable gaps`).toEqual([]);
    }
  });

  it('requires unsubscribe behavior for bulk templates', () => {
    const bulkEntries = TEMPLATE_LIFECYCLES.filter((entry) => entry.category === 'bulk');
    expect(bulkEntries.length).toBeGreaterThan(0);

    for (const entry of bulkEntries) {
      expect(
        entry.compliance.requiresUnsubscribe,
        `${entry.key} bulk must require unsubscribe`,
      ).toBe(true);
      expect(entry.compliance.requiresConsent, `${entry.key} bulk must require consent`).toBe(true);
      expect(entry.compliance.bypassesMarketingOptOut).toBe(false);
    }
  });

  it('does not force unsubscribe footers on transactional templates', () => {
    const transactionalEntries = TEMPLATE_LIFECYCLES.filter(
      (entry) => entry.category === 'transactional',
    );
    expect(transactionalEntries.length).toBeGreaterThan(0);

    for (const entry of transactionalEntries) {
      expect(
        entry.compliance.requiresUnsubscribe,
        `${entry.key} transactional must not require unsubscribe`,
      ).toBe(false);
      // Transactional ticket/order emails bypass marketing opt-out but still audit.
      expect(entry.compliance.bypassesMarketingOptOut).toBe(true);
      expect(entry.compliance.auditLog).toBe(true);
    }
  });

  it('derives the compliance matrix from category consistently', () => {
    const expected: Record<TemplateCategory, TemplateLifecycleCompliance> = {
      bulk: {
        requiresUnsubscribe: true,
        requiresConsent: true,
        bypassesMarketingOptOut: false,
        auditLog: true,
      },
      transactional: {
        requiresUnsubscribe: false,
        requiresConsent: false,
        bypassesMarketingOptOut: true,
        auditLog: true,
      },
      staff: {
        requiresUnsubscribe: false,
        requiresConsent: false,
        bypassesMarketingOptOut: true,
        auditLog: true,
      },
      system: {
        requiresUnsubscribe: false,
        requiresConsent: false,
        bypassesMarketingOptOut: true,
        auditLog: true,
      },
    };

    for (const category of Object.keys(expected) as TemplateCategory[]) {
      expect(complianceForCategory(category)).toEqual(expected[category]);
    }

    // Registry entries must match the derived matrix for their category.
    for (const entry of TEMPLATE_LIFECYCLES) {
      expect(entry.compliance).toEqual(complianceForCategory(entry.category));
    }
  });

  it('groups P0 checkout and ticket families under the expected lifecycles', () => {
    const checkout = listTemplateLifecyclesByFamily('checkout').map((entry) => entry.key);
    expect(checkout).toEqual(
      expect.arrayContaining(['order-confirmed', 'payment-failed', 'order-cancelled']),
    );

    const ticket = listTemplateLifecyclesByFamily('ticket').map((entry) => entry.key);
    expect(ticket).toEqual(expect.arrayContaining(['tickets-issued']));
  });

  it('keeps TemplateKey assignable to the runtime key list at compile time', () => {
    // If TEMPLATE_KEYS omits a TemplateKey or adds a value outside the union,
    // the assignments below fail to compile.
    const key: TemplateKey = TEMPLATE_KEYS[0];
    const allKeys: readonly TemplateKey[] = TEMPLATE_KEYS;
    expect(allKeys.length).toBeGreaterThan(0);
    expect(key).toBeTruthy();
  });

  it('partitions all keys into disjoint P0, P1, P2 tiers', () => {
    const p0 = new Set(P0_TEMPLATE_KEYS);
    const p1 = new Set(P1_TEMPLATE_KEYS);
    const p2 = new Set(P2_TEMPLATE_KEYS);

    // No overlap between tiers.
    for (const key of p1) expect(p0.has(key), `${key} in both P0 and P1`).toBe(false);
    for (const key of p2) expect(p0.has(key), `${key} in both P0 and P2`).toBe(false);
    for (const key of p2) expect(p1.has(key), `${key} in both P1 and P2`).toBe(false);

    // Union of the three tiers equals the full key set.
    const union = [...P0_TEMPLATE_KEYS, ...P1_TEMPLATE_KEYS, ...P2_TEMPLATE_KEYS];
    expect(union.length).toBe(TEMPLATE_KEYS.length);
    expect(new Set(union)).toEqual(new Set(TEMPLATE_KEYS));

    // Expected counts.
    expect(P0_TEMPLATE_KEYS.length).toBe(11);
    expect(P1_TEMPLATE_KEYS.length).toBe(11);
    expect(P2_TEMPLATE_KEYS.length).toBe(9);
  });

  it('tags every P1 and P2 entry with the correct tier', () => {
    for (const key of P1_TEMPLATE_KEYS) {
      expect(getTemplateLifecycle(key)?.tier, `${key} should be P1`).toBe('P1');
    }
    for (const key of P2_TEMPLATE_KEYS) {
      expect(getTemplateLifecycle(key)?.tier, `${key} should be P2`).toBe('P2');
    }
  });

  it('closes all P1 and P2 merge-tag gaps', () => {
    for (const key of [...P1_TEMPLATE_KEYS, ...P2_TEMPLATE_KEYS]) {
      const entry = getTemplateLifecycle(key);
      expect(entry, `missing entry for ${key}`).toBeDefined();
      expect(entry!.variableGaps, `${key} still has unresolved variable gaps`).toEqual([]);
    }
  });

  it('groups new P1/P2 families under the expected lifecycles', () => {
    expect(listTemplateLifecyclesByFamily('waitlist').map((e) => e.key)).toEqual([
      'waitlist-joined',
      'waitlist-invite',
      'waitlist-invite-expiring',
    ]);
    expect(listTemplateLifecyclesByFamily('dispute').map((e) => e.key)).toEqual([
      'chargeback-opened',
      'chargeback-won',
      'chargeback-lost',
    ]);
    expect(listTemplateLifecyclesByFamily('payout').map((e) => e.key)).toEqual([
      'payout-scheduled',
      'payout-paid',
      'payout-failed',
    ]);
    const integrationKeys = listTemplateLifecyclesByFamily('integration').map((e) => e.key);
    // eslint-disable-next-line unicorn/no-array-sort -- Sorting a fresh key array keeps this assertion stable without requiring ES2023 toSorted.
    integrationKeys.sort();
    expect(integrationKeys).toEqual(['integration-disconnected', 'webhook-failed']);
    expect(listTemplateLifecyclesByFamily('reporting').map((e) => e.key)).toEqual([
      'daily-sales-digest',
    ]);
  });

  it('does not force unsubscribe footers on system templates', () => {
    const systemEntries = TEMPLATE_LIFECYCLES.filter((entry) => entry.category === 'system');
    expect(systemEntries.length).toBeGreaterThan(0);
    for (const entry of systemEntries) {
      expect(entry.compliance.requiresUnsubscribe).toBe(false);
      expect(entry.compliance.requiresConsent).toBe(false);
      expect(entry.compliance.auditLog).toBe(true);
    }
  });
});
