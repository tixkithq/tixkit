import { describe, expect, it } from 'vitest';
import { createCheckoutSessionSchema, updateCheckoutSessionSchema, parseBody, refundSchema } from '../http/schemas.js';
import { ValidationError } from '@gatekit/domain';

describe('safeRedirectUrl / successUrl / cancelUrl validation', () => {
  it('rejects javascript: scheme in successUrl', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        successUrl: 'javascript:alert(1)',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects data: scheme in cancelUrl', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        cancelUrl: 'data:text/html,<script>alert(1)</script>',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects file: scheme in successUrl', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        successUrl: 'file:///etc/passwd',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects http: in production mode', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        successUrl: 'http://localhost:3000/success',
      }),
    ).toThrow(ValidationError);
  });

  it('accepts http: in dev mode', () => {
    const body = parseBody(createCheckoutSessionSchema(true), {
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      successUrl: 'http://localhost:3000/success',
    });
    expect(body.successUrl).toBe('http://localhost:3000/success');
  });

  it('accepts https: in production mode', () => {
    const body = parseBody(createCheckoutSessionSchema(false), {
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      successUrl: 'https://example.com/success',
    });
    expect(body.successUrl).toBe('https://example.com/success');
  });

  it('validates updateCheckoutSessionSchema successUrl too', () => {
    expect(() =>
      parseBody(updateCheckoutSessionSchema(false), {
        successUrl: 'javascript:alert(1)',
      }),
    ).toThrow(ValidationError);
  });
});

describe('parseBody strict mode', () => {
  it('rejects unknown fields in refundSchema', () => {
    expect(() =>
      parseBody(refundSchema, { reason: 'test', unknownField: 'bad' }),
    ).toThrow(ValidationError);
  });

  it('accepts valid refund body', () => {
    const body = parseBody(refundSchema, { reason: 'Customer requested', amountCents: 5000 });
    expect(body.reason).toBe('Customer requested');
    expect(body.amountCents).toBe(5000);
  });
});
