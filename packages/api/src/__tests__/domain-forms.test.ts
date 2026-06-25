import { describe, expect, it } from 'vitest';
import {
  isConsentAnswerSnapshot,
  isQuestionVisible,
  normalizeQuestionAnswers,
  validateQuestionDefinition,
  validateAnswers,
  type Question,
} from '@gatekit/domain';

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q_1',
    eventId: 'evt_1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: 'text',
    label: 'Full Name',
    required: true,
    appliesTo: 'attendee',
    sortOrder: 0,
    isConsentField: false,
    ...overrides,
  };
}

describe('validateAnswers', () => {
  it('passes when required fields are provided', () => {
    const questions = [makeQuestion({ id: 'q_1', required: true })];
    const result = validateAnswers(questions, { q_1: 'Ada Lovelace' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required fields are missing', () => {
    const questions = [makeQuestion({ id: 'q_1', required: true })];
    const result = validateAnswers(questions, {});
    expect(result.valid).toBe(false);
    expect(result.errors[0].questionId).toBe('q_1');
  });

  it('passes when optional fields are missing', () => {
    const questions = [makeQuestion({ id: 'q_1', required: false })];
    const result = validateAnswers(questions, {});
    expect(result.valid).toBe(true);
  });

  it('validates email type', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'email', required: true })];
    expect(validateAnswers(questions, { q_1: 'not-an-email' }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: 'ada@test.com' }).valid).toBe(true);
  });

  it('validates phone type', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'phone', required: true })];
    expect(validateAnswers(questions, { q_1: 'abc' }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: '+1 (555) 123-4567' }).valid).toBe(true);
  });

  it('validates select option membership', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'select', options: ['A', 'B'], required: true })];
    expect(validateAnswers(questions, { q_1: 'C' }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: 'A' }).valid).toBe(true);
  });

  it('validates multiselect option membership', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'multiselect', options: ['A', 'B', 'C'], required: true })];
    expect(validateAnswers(questions, { q_1: ['A', 'D'] }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: ['A', 'B'] }).valid).toBe(true);
  });

  it('validates consent/waiver fields require true', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'waiver', isConsentField: true, required: true })];
    expect(validateAnswers(questions, { q_1: false }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: true }).valid).toBe(true);
  });

  it('rejects file answers until upload artifact validation exists', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'file', required: false })];
    expect(validateAnswers(questions, {}).valid).toBe(true);
    const result = validateAnswers(questions, { q_1: 'waiver.pdf' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('file uploads are not supported');
  });

  it('validates regex pattern', () => {
    const questions = [makeQuestion({ id: 'q_1', type: 'text', validationPattern: '^\\d{4}$', required: true })];
    expect(validateAnswers(questions, { q_1: 'abc' }).valid).toBe(false);
    expect(validateAnswers(questions, { q_1: '1234' }).valid).toBe(true);
  });

  it('skips required conditional questions when the condition is not met', () => {
    const questions = [
      makeQuestion({ id: 'q_parent', label: 'Bring guest?', type: 'select', options: ['yes', 'no'], required: true }),
      makeQuestion({
        id: 'q_guest',
        label: 'Guest name',
        required: true,
        conditionalVisibility: { field: 'q_parent', operator: 'equals', value: 'yes' },
      }),
    ];

    expect(validateAnswers(questions, { q_parent: 'no' }).valid).toBe(true);
    expect(validateAnswers(questions, { q_parent: 'yes' }).valid).toBe(false);
  });

  it('evaluates conditional visibility against multiselect answers', () => {
    const question = makeQuestion({
      id: 'q_details',
      conditionalVisibility: { field: 'q_parent', operator: 'contains', value: 'VIP' },
    });

    expect(isQuestionVisible(question, { q_parent: ['VIP', 'General'] })).toBe(true);
    expect(isQuestionVisible(question, { q_parent: ['General'] })).toBe(false);
  });

  it('snapshots accepted consent answers with text, version, and timestamp', () => {
    const consentedAt = '2026-06-24T12:00:00.000Z';
    const [question] = [
      makeQuestion({
        id: 'q_consent',
        type: 'waiver',
        label: 'Marketing consent',
        isConsentField: true,
        consentText: 'I agree to receive event updates.',
        consentVersion: 'v3',
      }),
    ];

    const normalized = normalizeQuestionAnswers([question], { q_consent: true }, consentedAt);
    expect(isConsentAnswerSnapshot(normalized.q_consent)).toBe(true);
    expect(normalized.q_consent).toEqual({
      accepted: true,
      consentText: 'I agree to receive event updates.',
      consentVersion: 'v3',
      consentedAt,
    });
  });
});

describe('validateQuestionDefinition', () => {
  it('requires options for select and multiselect questions', () => {
    expect(validateQuestionDefinition({ type: 'select' })).toContain('select questions require at least one option');
    expect(validateQuestionDefinition({ type: 'multiselect', options: ['A'] })).toEqual([]);
  });

  it('rejects options on non-option question types', () => {
    expect(validateQuestionDefinition({ type: 'text', options: ['A'] })).toContain('text questions cannot define selectable options');
  });

  it('rejects empty and duplicate options', () => {
    const errors = validateQuestionDefinition({ type: 'select', options: ['VIP', ' ', 'VIP'] });
    expect(errors).toContain('Question options cannot be empty');
    expect(errors).toContain('Question options must be unique');
  });

  it('rejects file questions until upload support exists', () => {
    expect(validateQuestionDefinition({ type: 'file' })).toContain('File questions are not supported until upload storage and validation are available');
  });

  it('requires consent metadata for consent fields', () => {
    const errors = validateQuestionDefinition({ type: 'waiver', isConsentField: true });
    expect(errors).toContain('Consent fields require consent text');
    expect(errors).toContain('Consent fields require a consent version');
  });

  it('rejects self-referential conditional visibility and invalid regex', () => {
    const errors = validateQuestionDefinition({
      id: 'q_1',
      type: 'text',
      conditionalVisibility: { field: 'q_1', operator: 'equals', value: 'yes' },
      validationPattern: '[',
    });
    expect(errors).toContain('A question cannot conditionally depend on itself');
    expect(errors).toContain('Validation pattern must be a valid regular expression');
  });
});
