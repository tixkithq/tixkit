import { describe, expect, it } from 'vitest';
import { AgentProtocolValidationError, validateAgentMemoryWrite } from '../index.js';

const base = { namespace: { tenantId: 'tenant_primary', sponsorPrincipalId: 'user_sponsor',
  scopeType: 'event' as const, scopeId: 'event_primary', purpose: 'organizer_preferences' as const },
key: 'tone.default', content: { kind: 'organizer_preferences' as const,
  summary: 'Prefer a concise and warm tone', tone: 'warm' as const },
provenance: { type: 'organizer' as const, actorPrincipalId: 'user_sponsor',
  observedAt: '2026-07-12T12:00:00.000Z' }, retentionExpiresAt: '2026-10-12T12:00:00.000Z',
now: '2026-07-12T12:00:00.000Z' };

describe('agent memory protocol', () => {
  it('accepts bounded inspectable event-scoped organizer context', () => {
    expect(validateAgentMemoryWrite(base)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    { content: { kind: 'organizer_preferences', summary: 'Use sk_live_abc123 for calls' } },
    { content: { kind: 'organizer_preferences', summary: 'Contact buyer@example.com' } },
    { content: { kind: 'organizer_preferences', summary: 'Card 4242424242424242' } },
    { content: { kind: 'organizer_preferences', summary: 'Unsafe', apiToken: 'abc' } },
    { content: { kind: 'organizer_preferences', summary: 'Use AKIAIOSFODNN7EXAMPLE' } },
    { content: { kind: 'organizer_preferences', summary: 'Use bearer\u200b abcdefghijklmnop' } },
    { key: 'authorization.default' },
    { provenance: { ...base.provenance, sourceReference: 'sk_live_abcdef' } },
    { provenance: { ...base.provenance, password: 'not-a-secret-shape' } },
    { provenance: { ...base.provenance, actorPrincipalId: 'user_other' } },
    { provenance: { type: 'import', actorPrincipalId: 'user_sponsor',
      observedAt: base.now } },
    { provenance: { ...base.provenance, observedAt: '2026-07-13T12:00:00.000Z' } },
    { namespace: { ...base.namespace, sponsorPrincipalId: 'other', scopeId: undefined } },
    { retentionExpiresAt: '2028-07-12T12:00:00.000Z' },
  ])('rejects sensitive, unscoped, or over-retained memory: %o', (override) => {
    expect(() => validateAgentMemoryWrite({ ...base, ...override } as typeof base))
      .toThrow(AgentProtocolValidationError);
  });

  it('normalizes equivalent Unicode before digesting', () => {
    expect(validateAgentMemoryWrite({ ...base, content: { ...base.content,
      summary: 'Ｐrefer a warm tone' } })).toBe(validateAgentMemoryWrite({ ...base,
      content: { ...base.content, summary: 'Prefer a warm tone' } }));
  });
});
