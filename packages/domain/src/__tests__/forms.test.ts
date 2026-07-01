import { describe, expect, it } from 'vitest';
import {
  normalizeQuestionAnswers,
  validateAnswers,
  validateQuestionDefinition,
  type Question,
} from '../forms/index.js';

function waiverQuestion(overrides: Partial<Question> = {}): Question {
  const now = '2026-07-01T00:00:00.000Z';
  return {
    id: 'q_waiver',
    eventId: 'evt_1',
    type: 'waiver',
    label: 'Liability waiver',
    required: true,
    appliesTo: 'buyer',
    sortOrder: 0,
    isConsentField: true,
    consentText: 'I accept the liability waiver.',
    consentVersion: 'v1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('forms question validation', () => {
  it('requires waiver definitions to use consent semantics and metadata', () => {
    expect(
      validateQuestionDefinition({
        type: 'waiver',
        isConsentField: false,
        consentText: 'I agree',
        consentVersion: 'v1',
      }),
    ).toContain('Waiver questions must be consent fields');

    expect(validateQuestionDefinition({ type: 'waiver', isConsentField: true })).toEqual([
      'Consent fields require consent text',
      'Consent fields require a consent version',
    ]);
  });

  it('requires explicit waiver acceptance and snapshots legacy waiver rows', () => {
    const legacyWaiver = waiverQuestion({ isConsentField: false });

    expect(validateAnswers([legacyWaiver], { q_waiver: false })).toEqual({
      valid: false,
      errors: [{ questionId: 'q_waiver', message: 'Liability waiver must be accepted' }],
    });

    expect(
      normalizeQuestionAnswers([legacyWaiver], { q_waiver: true }, '2026-07-01T12:00:00.000Z'),
    ).toEqual({
      q_waiver: {
        accepted: true,
        consentText: 'I accept the liability waiver.',
        consentVersion: 'v1',
        consentedAt: '2026-07-01T12:00:00.000Z',
      },
    });
  });
});
