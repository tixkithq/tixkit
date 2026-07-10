import { describe, expect, it } from 'vitest';
import { redactJsonValue } from '../activities/privacy.js';

describe('privacy DOB redaction', () => {
  it('removes buyer and nested attendee DOB values from checkout-session JSON', () => {
    const buyer = redactJsonValue(
      {
        email: 'buyer@example.com',
        dateOfBirth: '1990-01-01',
      },
      'erased@example.invalid',
      { subjectEmails: ['buyer@example.com'] },
    );
    const cart = redactJsonValue(
      {
        items: [
          {
            attendeeFields: [
              { email: 'attendee@example.com', dateOfBirth: '2001-02-03' },
              { email: 'guest@example.com', dob: '2002-04-05' },
            ],
          },
        ],
      },
      'erased@example.invalid',
      { subjectEmails: ['attendee@example.com', 'guest@example.com'] },
    );

    expect(JSON.stringify({ buyer, cart })).not.toContain('1990-01-01');
    expect(JSON.stringify({ buyer, cart })).not.toContain('2001-02-03');
    expect(JSON.stringify({ buyer, cart })).not.toContain('2002-04-05');
    expect(buyer).toMatchObject({ dateOfBirth: null });
  });
});
