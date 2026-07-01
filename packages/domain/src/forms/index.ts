import type { BaseEntity, Ulid } from '../shared/index.js';

export type QuestionType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'waiver';

export type Question = BaseEntity & {
  eventId: Ulid;
  ticketTypeId?: Ulid;
  type: QuestionType;
  label: string;
  description?: string;
  required: boolean;
  appliesTo: 'buyer' | 'attendee' | 'both';
  options?: string[];
  placeholder?: string;
  validationPattern?: string;
  conditionalVisibility?: {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains';
    value: string;
  };
  sortOrder: number;
  isConsentField: boolean;
  consentText?: string;
  consentVersion?: string;
};

export type QuestionAnswer = {
  questionId: Ulid;
  value: string | string[] | boolean | ConsentAnswerSnapshot | UploadArtifactAnswer | null;
};

export type UploadArtifactAnswer = {
  artifactId: Ulid;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type ConsentAnswerSnapshot = {
  accepted: true;
  consentText: string;
  consentVersion: string;
  consentedAt: string;
};

export type CreateQuestionInput = {
  eventId: Ulid;
  ticketTypeId?: Ulid;
  type: QuestionType;
  label: string;
  description?: string;
  required?: boolean;
  appliesTo?: 'buyer' | 'attendee' | 'both';
  options?: string[];
  placeholder?: string;
  validationPattern?: string;
  conditionalVisibility?: Question['conditionalVisibility'];
  sortOrder?: number;
  isConsentField?: boolean;
  consentText?: string;
};

export type QuestionDefinitionValidationInput = {
  id?: Ulid;
  type: QuestionType;
  options?: string[] | null;
  validationPattern?: string | null;
  conditionalVisibility?: Question['conditionalVisibility'] | null;
  sortOrder?: number;
  isConsentField?: boolean;
  consentText?: string | null;
  consentVersion?: string | null;
};

export type ValidationRule = {
  type:
    | 'required'
    | 'pattern'
    | 'minLength'
    | 'maxLength'
    | 'email'
    | 'phone'
    | 'date'
    | 'fileSize'
    | 'fileType';
  value?: string | number;
  message: string;
};

export type QuestionValidationResult = {
  valid: boolean;
  errors: { questionId: Ulid; message: string }[];
};

function answerValues(answer: unknown): string[] {
  if (Array.isArray(answer)) return answer.map((value) => String(value));
  if (typeof answer === 'boolean') return [answer ? 'true' : 'false'];
  if (answer === undefined || answer === null) return [];
  return [String(answer)];
}

export function isQuestionVisible(question: Question, answers: Record<string, unknown>): boolean {
  const condition = question.conditionalVisibility;
  if (!condition) return true;

  const values = answerValues(answers[condition.field]);
  if (condition.operator === 'equals') {
    return values.some((value) => value === condition.value);
  }
  if (condition.operator === 'not_equals') {
    return values.every((value) => value !== condition.value);
  }
  return values.some((value) => value.includes(condition.value));
}

function isAnswerEmpty(answer: unknown): boolean {
  return (
    answer === undefined ||
    answer === null ||
    answer === '' ||
    (Array.isArray(answer) && answer.length === 0)
  );
}

const OPTION_BEARING_TYPES = new Set<QuestionType>(['select', 'multiselect']);
const CONSENT_TYPES = new Set<QuestionType>(['checkbox', 'waiver']);

export function validateQuestionDefinition(input: QuestionDefinitionValidationInput): string[] {
  const errors: string[] = [];
  const options = input.options ?? undefined;

  if (OPTION_BEARING_TYPES.has(input.type)) {
    if (!options || options.length === 0) {
      errors.push(`${input.type} questions require at least one option`);
    }
  } else if (options && options.length > 0) {
    errors.push(`${input.type} questions cannot define selectable options`);
  }

  if (options) {
    const normalized = options.map((option) => option.trim());
    if (normalized.some((option) => option.length === 0)) {
      errors.push('Question options cannot be empty');
    }
    if (new Set(normalized).size !== normalized.length) {
      errors.push('Question options must be unique');
    }
  }

  const isWaiver = input.type === 'waiver';
  if (isWaiver && input.isConsentField === false) {
    errors.push('Waiver questions must be consent fields');
  }

  if (input.isConsentField || isWaiver) {
    if (!CONSENT_TYPES.has(input.type)) {
      errors.push('Consent fields must use checkbox or waiver question types');
    }
    if (!input.consentText?.trim()) {
      errors.push('Consent fields require consent text');
    }
    if (!input.consentVersion?.trim()) {
      errors.push('Consent fields require a consent version');
    }
  }

  if (input.conditionalVisibility) {
    if (!input.conditionalVisibility.field.trim()) {
      errors.push('Conditional visibility requires a source field');
    }
    if (input.id && input.conditionalVisibility.field === input.id) {
      errors.push('A question cannot conditionally depend on itself');
    }
  }

  if (input.validationPattern) {
    try {
      RegExp(input.validationPattern);
    } catch {
      errors.push('Validation pattern must be a valid regular expression');
    }
  }

  if (input.sortOrder !== undefined && !Number.isSafeInteger(input.sortOrder)) {
    errors.push('Sort order must be a safe integer');
  }

  return errors;
}

export function isConsentAnswerSnapshot(answer: unknown): answer is ConsentAnswerSnapshot {
  return Boolean(
    answer &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    (answer as { accepted?: unknown }).accepted === true &&
    typeof (answer as { consentText?: unknown }).consentText === 'string' &&
    typeof (answer as { consentVersion?: unknown }).consentVersion === 'string' &&
    typeof (answer as { consentedAt?: unknown }).consentedAt === 'string',
  );
}

export function isConsentAccepted(answer: unknown): boolean {
  return answer === true || isConsentAnswerSnapshot(answer);
}

export function isUploadArtifactAnswer(answer: unknown): answer is UploadArtifactAnswer {
  return Boolean(
    answer &&
    typeof answer === 'object' &&
    !Array.isArray(answer) &&
    typeof (answer as { artifactId?: unknown }).artifactId === 'string' &&
    (answer as { artifactId: string }).artifactId.startsWith('upl_'),
  );
}

function isValidDateAnswer(answer: unknown): answer is string {
  if (typeof answer !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(answer);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function normalizeQuestionAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
  consentedAt = new Date().toISOString(),
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const question of questions) {
    if (!isQuestionVisible(question, answers)) continue;
    const answer = answers[question.id];
    if (isAnswerEmpty(answer)) continue;

    if ((question.isConsentField || question.type === 'waiver') && isConsentAccepted(answer)) {
      normalized[question.id] = {
        accepted: true,
        consentText: question.consentText ?? question.label,
        consentVersion: question.consentVersion ?? '1',
        consentedAt,
      } satisfies ConsentAnswerSnapshot;
      continue;
    }

    normalized[question.id] = answer;
  }

  return normalized;
}

/**
 * Validates attendee/buyer answers against question definitions.
 * Enforces required fields, type-specific validation (email, phone, pattern),
 * select/multiselect option membership, and consent field acceptance.
 */
export function validateAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
): QuestionValidationResult {
  const errors: { questionId: Ulid; message: string }[] = [];

  for (const question of questions) {
    if (!isQuestionVisible(question, answers)) continue;

    const answer = answers[question.id];
    const isEmpty = isAnswerEmpty(answer);

    if (question.type === 'file') {
      if (question.required && isEmpty) {
        errors.push({ questionId: question.id, message: `${question.label} is required` });
      } else if (!isEmpty && !isUploadArtifactAnswer(answer)) {
        errors.push({
          questionId: question.id,
          message: `${question.label} must reference a completed upload artifact`,
        });
      }
      continue;
    }

    if (question.required && isEmpty) {
      errors.push({ questionId: question.id, message: `${question.label} is required` });
      continue;
    }

    if (isEmpty) continue;

    // Type-specific validation
    switch (question.type) {
      case 'email':
        if (typeof answer !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) {
          errors.push({
            questionId: question.id,
            message: `${question.label} must be a valid email`,
          });
        }
        break;
      case 'phone':
        if (typeof answer !== 'string' || !/^[+\d\s()-]{7,}$/.test(answer)) {
          errors.push({
            questionId: question.id,
            message: `${question.label} must be a valid phone number`,
          });
        }
        break;
      case 'date':
        if (!isValidDateAnswer(answer)) {
          errors.push({
            questionId: question.id,
            message: `${question.label} must be a valid date`,
          });
        }
        break;
      case 'select':
        if (
          typeof answer !== 'string' ||
          (question.options && !question.options.includes(answer))
        ) {
          errors.push({
            questionId: question.id,
            message: `${question.label} has an invalid option`,
          });
        }
        break;
      case 'multiselect':
        if (!Array.isArray(answer)) {
          errors.push({
            questionId: question.id,
            message: `${question.label} has an invalid option`,
          });
        } else if (question.options) {
          for (const val of answer) {
            if (typeof val !== 'string' || !question.options.includes(val)) {
              errors.push({
                questionId: question.id,
                message: `${question.label} has an invalid option`,
              });
              break;
            }
          }
        }
        break;
      case 'checkbox':
      case 'waiver':
        if (
          question.required &&
          (question.isConsentField || question.type === 'waiver') &&
          !isConsentAccepted(answer)
        ) {
          errors.push({ questionId: question.id, message: `${question.label} must be accepted` });
        }
        break;
    }

    // Pattern validation
    if (question.validationPattern && typeof answer === 'string') {
      try {
        const regex = new RegExp(question.validationPattern);
        if (!regex.test(answer)) {
          errors.push({ questionId: question.id, message: `${question.label} format is invalid` });
        }
      } catch {
        // Invalid regex pattern on the question; skip validation
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
