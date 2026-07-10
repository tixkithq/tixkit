export type AgeEligibilityFailureCode =
  | 'DATE_OF_BIRTH_REQUIRED'
  | 'DATE_OF_BIRTH_INVALID'
  | 'DATE_OF_BIRTH_IN_FUTURE'
  | 'MINIMUM_AGE_NOT_MET'
  | 'PARTICIPATION_DATE_INVALID';

export type AgeEligibilityResult =
  | {
      eligible: true;
      dateOfBirth: string;
      maximumDateOfBirth: string;
      ageOnParticipationDate: number;
    }
  | {
      eligible: false;
      code: AgeEligibilityFailureCode;
      message: string;
      maximumDateOfBirth?: string;
      ageOnParticipationDate?: number;
    };

type DateParts = { year: number; month: number; day: number };

export function requiresDateOfBirthVerification(minimumAge?: number | null): boolean {
  return typeof minimumAge === 'number' && Number.isFinite(minimumAge) && minimumAge > 0;
}

function parseDateOnly(value: string): DateParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, month, day };
}

function formatDateOnly(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function compareDateParts(left: DateParts, right: DateParts): number {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

function datePartsInTimeZone(value: Date | string, timeZone: string): DateParts | undefined {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const result = {
      year: numberPart('year'),
      month: numberPart('month'),
      day: numberPart('day'),
    };
    return parseDateOnly(formatDateOnly(result));
  } catch {
    return undefined;
  }
}

function subtractYearsClamped(date: DateParts, years: number): DateParts {
  const year = date.year - years;
  const lastDay = new Date(Date.UTC(year, date.month, 0)).getUTCDate();
  return { year, month: date.month, day: Math.min(date.day, lastDay) };
}

export function maximumEligibleDateOfBirth(input: {
  participationAt: Date | string;
  timezone: string;
  minimumAge?: number | null;
  now?: Date;
}): string | undefined {
  const participationDate = datePartsInTimeZone(input.participationAt, input.timezone);
  const today = datePartsInTimeZone(input.now ?? new Date(), input.timezone);
  if (!participationDate || !today) return undefined;
  const ageThreshold = subtractYearsClamped(
    participationDate,
    Math.max(0, Math.trunc(input.minimumAge ?? 0)),
  );
  return formatDateOnly(compareDateParts(ageThreshold, today) < 0 ? ageThreshold : today);
}

export function evaluateDateOfBirthEligibility(input: {
  dateOfBirth: unknown;
  participationAt: Date | string;
  timezone: string;
  minimumAge?: number | null;
  now?: Date;
}): AgeEligibilityResult {
  const minimumAge = Math.max(0, Math.trunc(input.minimumAge ?? 0));
  const participationDate = datePartsInTimeZone(input.participationAt, input.timezone);
  const today = datePartsInTimeZone(input.now ?? new Date(), input.timezone);
  if (!participationDate || !today) {
    return {
      eligible: false,
      code: 'PARTICIPATION_DATE_INVALID',
      message: 'The event participation date or timezone is invalid.',
    };
  }
  if (typeof input.dateOfBirth !== 'string' || !input.dateOfBirth.trim()) {
    return {
      eligible: false,
      code: 'DATE_OF_BIRTH_REQUIRED',
      message: 'Date of birth is required.',
    };
  }
  const normalized = input.dateOfBirth.trim();
  const dateOfBirth = parseDateOnly(normalized);
  if (!dateOfBirth) {
    return {
      eligible: false,
      code: 'DATE_OF_BIRTH_INVALID',
      message: 'Date of birth must be a valid calendar date in YYYY-MM-DD format.',
    };
  }
  if (compareDateParts(dateOfBirth, today) > 0) {
    return {
      eligible: false,
      code: 'DATE_OF_BIRTH_IN_FUTURE',
      message: 'Date of birth cannot be in the future.',
    };
  }
  let age = participationDate.year - dateOfBirth.year;
  if (
    participationDate.month < dateOfBirth.month ||
    (participationDate.month === dateOfBirth.month && participationDate.day < dateOfBirth.day)
  ) {
    age -= 1;
  }
  const maximumDateOfBirth = formatDateOnly(
    compareDateParts(subtractYearsClamped(participationDate, minimumAge), today) < 0
      ? subtractYearsClamped(participationDate, minimumAge)
      : today,
  );
  if (age < minimumAge) {
    return {
      eligible: false,
      code: 'MINIMUM_AGE_NOT_MET',
      message: `Attendees must be at least ${minimumAge} years old on the event date.`,
      maximumDateOfBirth,
      ageOnParticipationDate: age,
    };
  }
  return {
    eligible: true,
    dateOfBirth: normalized,
    maximumDateOfBirth,
    ageOnParticipationDate: age,
  };
}
