import { describe, expect, it } from 'vitest';
import {
  createCheckoutSessionSchema,
  updateCheckoutSessionSchema,
  parseBody,
  refundSchema,
  createWebhookEndpointSchema,
  updateWebhookEndpointSchema,
  createOAuthAppSchema,
  createEventSchema,
  createTicketTypeSchema,
  updateBrandSchema,
} from '../http/schemas.js';
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

  it('accepts localhost http: in dev mode', () => {
    const body = parseBody(createCheckoutSessionSchema(true), {
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      successUrl: 'http://localhost:3000/success',
    });
    expect(body.successUrl).toBe('http://localhost:3000/success');
  });

  it('rejects non-localhost http: in dev mode', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(true), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        successUrl: 'http://example.com/success',
      }),
    ).toThrow(ValidationError);
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

describe('API mutation schema drift guards', () => {
  it('rejects datetime-local event timestamps without timezone offsets', () => {
    expect(() =>
      parseBody(createEventSchema, {
        organizationId: 'org_1',
        brandId: 'brd_1',
        title: 'Event',
        startsAt: '2026-08-15T19:00',
        timezone: 'America/New_York',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects datetime-local ticket sales windows without timezone offsets', () => {
    expect(() =>
      parseBody(createTicketTypeSchema, {
        name: 'General admission',
        priceCents: 2500,
        currency: 'USD',
        salesStartAt: '2026-08-15T19:00',
      }),
    ).toThrow(ValidationError);
  });

  it('accepts paymentAccountId on brand updates', () => {
    expect(parseBody(updateBrandSchema, { paymentAccountId: 'pa_1' }).paymentAccountId).toBe('pa_1');
    expect(parseBody(updateBrandSchema, { paymentAccountId: null }).paymentAccountId).toBeNull();
  });
});

describe('webhook and OAuth URL policy', () => {
  it('accepts external https webhook URLs', () => {
    const body = parseBody(createWebhookEndpointSchema, {
      organizationId: 'org_1',
      url: 'https://hooks.example.com/gatekit',
      events: ['order.created'],
    });
    expect(body.url).toBe('https://hooks.example.com/gatekit');
  });

  it.each([
    'http://hooks.example.com/gatekit',
    'https://localhost:8443/gatekit',
    'https://127.0.0.1/gatekit',
    'https://10.0.0.10/gatekit',
    'https://172.16.0.10/gatekit',
    'https://192.168.1.10/gatekit',
    'https://metadata.internal/gatekit',
  ])('rejects unsafe webhook URL %s', (url) => {
    expect(() =>
      parseBody(createWebhookEndpointSchema, {
        organizationId: 'org_1',
        url,
        events: ['order.created'],
      }),
    ).toThrow(ValidationError);
  });

  it('applies webhook URL policy to updates', () => {
    expect(() => parseBody(updateWebhookEndpointSchema, { url: 'https://127.0.0.1/gatekit' })).toThrow(
      ValidationError,
    );
  });

  it('allows localhost http OAuth redirects in test/dev only', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const body = parseBody(createOAuthAppSchema, {
        organizationId: 'org_1',
        name: 'Local app',
        redirectUris: ['http://localhost:3000/callback'],
        scopes: ['events.read'],
      });
      expect(body.redirectUris).toEqual(['http://localhost:3000/callback']);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('rejects non-localhost http OAuth redirects', () => {
    expect(() =>
      parseBody(createOAuthAppSchema, {
        organizationId: 'org_1',
        name: 'Unsafe app',
        redirectUris: ['http://example.com/callback'],
        scopes: ['events.read'],
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
