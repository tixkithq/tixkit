import { describe, expect, it } from 'vitest';
import {
  assertOrderDateOfBirthEligibility,
  normalizeAttendeeFieldsForCartItems,
} from '../routes/modules/checkout.js';
import { completeResaleListingSchema, transferTicketSchema } from '../http/schemas.js';

const event = {
  starts_at: '2030-07-10T01:00:00.000Z',
  timezone: 'America/Chicago',
  minimum_age: 21,
};

const ticketTypeOccurrences = new Map([['tt_1', 'occ_1']]);
const occurrences = new Map([
  [
    'occ_1',
    {
      id: 'occ_1',
      starts_at: '2030-07-10T01:00:00.000Z',
      timezone: 'America/Chicago',
    },
  ],
]);

describe('checkout date-of-birth enforcement', () => {
  it('keeps DOB optional in transport contracts so event policy decides whether it is required', () => {
    expect(transferTicketSchema.safeParse({ toEmail: 'buyer@example.com' }).success).toBe(true);
    expect(
      completeResaleListingSchema.safeParse({
        buyerId: 'usr_1',
        buyerEmail: 'buyer@example.com',
      }).success,
    ).toBe(true);
    expect(
      completeResaleListingSchema.safeParse({
        buyerId: 'usr_1',
        buyerEmail: 'buyer@example.com',
        buyerDateOfBirth: '1990-01-01',
      }).success,
    ).toBe(true);
  });

  it('does not collect buyer or attendee DOB for unrestricted events', () => {
    expect(() =>
      assertOrderDateOfBirthEligibility({
        event: { ...event, minimum_age: null },
        buyer: {},
        items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
        ticketTypeOccurrences,
        occurrences,
      }),
    ).not.toThrow();
  });

  it('accepts buyer and attendee DOBs that meet the age requirement on the occurrence date', () => {
    expect(() =>
      assertOrderDateOfBirthEligibility({
        event,
        buyer: { dateOfBirth: '2009-07-09' },
        items: [
          {
            ticketTypeId: 'tt_1',
            quantity: 1,
            attendeeFields: [{ dateOfBirth: '2009-07-09' }],
          },
        ],
        ticketTypeOccurrences,
        occurrences,
      }),
    ).not.toThrow();
  });

  it('preserves system DOB fields when an event has no custom attendee questions', () => {
    const normalized = normalizeAttendeeFieldsForCartItems(
      [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ dateOfBirth: '2009-07-09' }],
        },
      ],
      [],
      '2030-01-01T00:00:00.000Z',
    );

    expect(normalized.items[0]?.attendeeFields).toEqual([{ dateOfBirth: '2009-07-09' }]);
    expect(normalized.attendeeFieldsByTicketType).toEqual({});
    expect(() =>
      assertOrderDateOfBirthEligibility({
        event,
        buyer: { dateOfBirth: '2000-01-01' },
        items: normalized.items,
        ticketTypeOccurrences,
        occurrences,
      }),
    ).not.toThrow();
  });

  it('preserves normalized box-office attendee identity fields', () => {
    const normalized = normalizeAttendeeFieldsForCartItems(
      [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [
            {
              firstName: ' Ada ',
              lastName: ' Lovelace ',
              email: ' ada@example.test ',
              phone: ' +15555550100 ',
            },
          ],
        },
      ],
      [],
      '2030-01-01T00:00:00.000Z',
    );

    expect(normalized.items[0]?.attendeeFields).toEqual([
      {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
        phone: '+15555550100',
      },
    ]);
  });

  it('rejects an underage buyer even when the client bypasses the date picker', () => {
    expect(() =>
      assertOrderDateOfBirthEligibility({
        event,
        buyer: { dateOfBirth: '2009-07-10' },
        items: [
          {
            ticketTypeId: 'tt_1',
            quantity: 1,
            attendeeFields: [{ dateOfBirth: '2000-01-01' }],
          },
        ],
        ticketTypeOccurrences,
        occurrences,
      }),
    ).toThrow(/Buyer date of birth: Attendees must be at least 21/);
  });

  it('rejects missing or underage attendee DOBs independently of the buyer', () => {
    expect(() =>
      assertOrderDateOfBirthEligibility({
        event,
        buyer: { dateOfBirth: '2000-01-01' },
        items: [
          {
            ticketTypeId: 'tt_1',
            quantity: 2,
            attendeeFields: [{ dateOfBirth: '2000-01-01' }, { dateOfBirth: '2009-07-10' }],
          },
        ],
        ticketTypeOccurrences,
        occurrences,
      }),
    ).toThrow(/Ticket item 1, attendee 2: Attendees must be at least 21/);

    expect(() =>
      assertOrderDateOfBirthEligibility({
        event,
        buyer: { dateOfBirth: '2000-01-01' },
        items: [{ ticketTypeId: 'tt_1', quantity: 2, attendeeFields: [{}] }],
        ticketTypeOccurrences,
        occurrences,
      }),
    ).toThrow(/requires date of birth details for all 2 attendees/);
  });
});
