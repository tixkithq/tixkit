import { describe, expect, it } from 'vitest';
import {
  evaluateDateOfBirthEligibility,
  maximumEligibleDateOfBirth,
  requiresDateOfBirthVerification,
} from '../eligibility/age.js';

describe('age eligibility', () => {
  it('requires DOB verification only for a positive explicit minimum age', () => {
    expect(requiresDateOfBirthVerification(null)).toBe(false);
    expect(requiresDateOfBirthVerification(undefined)).toBe(false);
    expect(requiresDateOfBirthVerification(0)).toBe(false);
    expect(requiresDateOfBirthVerification(18)).toBe(true);
  });

  it('accepts the exact minimum-age birthday and rejects one day younger', () => {
    const base = {
      participationAt: '2030-07-10T01:00:00.000Z',
      timezone: 'America/Chicago',
      minimumAge: 21,
      now: new Date('2029-01-01T12:00:00.000Z'),
    };
    expect(evaluateDateOfBirthEligibility({ ...base, dateOfBirth: '2009-07-09' })).toMatchObject({
      eligible: true,
      ageOnParticipationDate: 21,
    });
    expect(evaluateDateOfBirthEligibility({ ...base, dateOfBirth: '2009-07-10' })).toMatchObject({
      eligible: false,
      code: 'MINIMUM_AGE_NOT_MET',
      ageOnParticipationDate: 20,
    });
  });

  it('uses the event-local calendar date across UTC boundaries', () => {
    expect(
      maximumEligibleDateOfBirth({
        participationAt: '2030-01-01T01:00:00.000Z',
        timezone: 'America/Los_Angeles',
        minimumAge: 18,
        now: new Date('2029-01-01T12:00:00.000Z'),
      }),
    ).toBe('2011-12-31');
  });

  it('clamps leap-day thresholds and never permits a future DOB', () => {
    expect(
      maximumEligibleDateOfBirth({
        participationAt: '2028-02-29T18:00:00.000Z',
        timezone: 'UTC',
        minimumAge: 18,
        now: new Date('2027-01-01T00:00:00.000Z'),
      }),
    ).toBe('2010-02-28');
    expect(
      evaluateDateOfBirthEligibility({
        dateOfBirth: '2030-01-01',
        participationAt: '2031-01-01T00:00:00.000Z',
        timezone: 'UTC',
        now: new Date('2029-01-01T00:00:00.000Z'),
      }),
    ).toMatchObject({ eligible: false, code: 'DATE_OF_BIRTH_IN_FUTURE' });
  });

  it('rejects malformed and impossible date-only values', () => {
    for (const dateOfBirth of ['', '02/01/2000', '2000-02-30']) {
      expect(
        evaluateDateOfBirthEligibility({
          dateOfBirth,
          participationAt: '2030-01-01T00:00:00.000Z',
          timezone: 'UTC',
        }).eligible,
      ).toBe(false);
    }
  });
});
