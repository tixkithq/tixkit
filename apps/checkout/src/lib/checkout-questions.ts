import type { CheckoutQuestion } from './api';

export type UploadArtifactAnswer = {
  artifactId: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type CheckoutAnswerValue = string | string[] | boolean | UploadArtifactAnswer;
export type CheckoutAnswers = Record<string, CheckoutAnswerValue>;

const PATTERN_VALIDATION_TYPES = new Set(['text', 'textarea', 'email', 'phone', 'date']);

export function isAnswerEmpty(answer: unknown): boolean {
  return (
    answer === undefined ||
    answer === null ||
    answer === '' ||
    (Array.isArray(answer) && answer.length === 0)
  );
}

export function isRequiredCheckoutAnswerMissing(
  question: CheckoutQuestion,
  answer: unknown,
): boolean {
  if (question.type === 'checkbox' || question.type === 'waiver') {
    return answer !== true && answer !== 'true';
  }
  return isAnswerEmpty(answer);
}

function answerValues(answer: unknown): string[] {
  if (Array.isArray(answer)) return answer.map((value) => String(value));
  if (typeof answer === 'boolean') return [answer ? 'true' : 'false'];
  if (answer === undefined || answer === null) return [];
  return [String(answer)];
}

export function isCheckoutQuestionVisible(
  question: CheckoutQuestion,
  answers: Record<string, unknown>,
): boolean {
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

export function visibleCheckoutQuestions(
  questions: CheckoutQuestion[],
  answers: Record<string, unknown>,
): CheckoutQuestion[] {
  return questions.filter((question) => isCheckoutQuestionVisible(question, answers));
}

export function normalizeCheckoutAnswers(
  answers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => {
      if (answer === 'true') return [questionId, true];
      if (answer === 'false') return [questionId, false];
      return [questionId, answer];
    }),
  );
}

export function questionPatternValidationMessage(
  question: CheckoutQuestion,
  answer: unknown,
): string {
  if (!question.validationPattern || !PATTERN_VALIDATION_TYPES.has(question.type)) return '';
  if (isAnswerEmpty(answer)) return '';
  const value = String(answer);
  try {
    return new RegExp(question.validationPattern).test(value)
      ? ''
      : `${question.label} format is invalid`;
  } catch {
    return `${question.label} format is invalid`;
  }
}

export function questionTypeValidationMessage(question: CheckoutQuestion, answer: unknown): string {
  if (isAnswerEmpty(answer)) return '';
  switch (question.type) {
    case 'email':
      return typeof answer === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)
        ? ''
        : `${question.label} must be a valid email`;
    case 'phone':
      return typeof answer === 'string' && /^[+\d\s()-]{7,}$/.test(answer)
        ? ''
        : `${question.label} must be a valid phone number`;
    case 'date':
      return isValidDateAnswer(answer) ? '' : `${question.label} must be a valid date`;
    default:
      return '';
  }
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
