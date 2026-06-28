import type { CheckoutQuestion } from './api';

export type UploadArtifactAnswer = {
  artifactId: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
};

export type CheckoutAnswerValue = string | string[] | boolean | UploadArtifactAnswer;
export type CheckoutAnswers = Record<string, CheckoutAnswerValue>;

export function isAnswerEmpty(answer: unknown): boolean {
  return (
    answer === undefined ||
    answer === null ||
    answer === '' ||
    (Array.isArray(answer) && answer.length === 0)
  );
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
