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
  updateEventSchema,
  createTicketTypeSchema,
  updateTicketTypeSchema,
  createAccessRuleSchema,
  createTicketTypeBatchSchema,
  createProductCategorySchema,
  createProductSchema,
  updateBrandSchema,
  updateProductSchema,
  updateTicketTypeBatchSchema,
  MAX_OFFLINE_SYNC_SCANS,
  MAX_MESSAGE_TEMPLATE_HTML_LENGTH,
  MAX_MESSAGE_VARIABLES_BYTES,
  renderMessagePreviewSchema,
  sendMessageSchema,
  syncScanSchema,
} from '../http/schemas.js';
import { ValidationError } from '@tixkit/domain';

const makeOfflineScans = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    qrHash: `hash_${index}`,
    scannedAt: '2026-06-01T12:00:00.000Z',
    offline: true,
  }));

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

  it('accepts product checkout items', () => {
    const body = parseBody(createCheckoutSessionSchema(false), {
      eventId: 'evt_1',
      items: [
        { ticketTypeId: 'tt_1', quantity: 1 },
        { productId: 'prd_1', quantity: 2 },
      ],
    });

    expect(body.items).toEqual([
      { ticketTypeId: 'tt_1', quantity: 1 },
      { productId: 'prd_1', quantity: 2 },
    ]);
  });

  it('accepts occurrence-scoped ticket checkout items', () => {
    const body = parseBody(createCheckoutSessionSchema(false), {
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', occurrenceId: 'occ_1', quantity: 1 }],
    });

    expect(body.items).toEqual([{ ticketTypeId: 'tt_1', occurrenceId: 'occ_1', quantity: 1 }]);
  });

  it('rejects occurrence identifiers on product checkout items', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ productId: 'prd_1', occurrenceId: 'occ_1', quantity: 1 }],
      }),
    ).toThrow(ValidationError);
  });

  it('rejects checkout items that mix ticket and product identifiers', () => {
    expect(() =>
      parseBody(createCheckoutSessionSchema(false), {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', productId: 'prd_1', quantity: 1 }],
      }),
    ).toThrow(ValidationError);
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
    expect(parseBody(updateBrandSchema, { paymentAccountId: 'pa_1' }).paymentAccountId).toBe(
      'pa_1',
    );
    expect(parseBody(updateBrandSchema, { paymentAccountId: null }).paymentAccountId).toBeNull();
  });

  it('accepts safe brand support and legal urls', () => {
    const parsed = parseBody(updateBrandSchema, {
      supportUrl: 'http://help.example.test',
      legalUrls: {
        terms: 'https://example.test/terms',
        privacy: 'http://example.test/privacy',
        refundPolicy: 'https://example.test/refunds',
      },
    });

    expect(parsed.supportUrl).toBe('http://help.example.test');
    expect(parsed.legalUrls).toEqual({
      terms: 'https://example.test/terms',
      privacy: 'http://example.test/privacy',
      refundPolicy: 'https://example.test/refunds',
    });
  });

  it('rejects unsafe brand support and legal urls', () => {
    expect(() =>
      parseBody(updateBrandSchema, {
        supportUrl: 'javascript:alert(1)',
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseBody(updateBrandSchema, {
        legalUrls: { terms: 'data:text/html,<script>alert(1)</script>' },
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseBody(updateBrandSchema, {
        legalUrls: { privacy: 'file:///etc/passwd' },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects unknown brand legal url keys', () => {
    expect(() =>
      parseBody(updateBrandSchema, {
        legalUrls: {
          terms: 'https://example.test/terms',
          imprint: 'https://example.test/imprint',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('accepts full editable event detail fields on event updates', () => {
    const parsed = parseBody(updateEventSchema, {
      venue: { name: 'Riverside', address: '100 River Walk' },
      visibility: 'unlisted',
      seo: { title: 'Search title', description: 'Search description' },
      capacity: 250,
      coverImageUrl: 'https://cdn.example.test/cover.jpg',
      externalUrl: 'https://events.example.test/detail',
    });

    expect(parsed.venue).toEqual({ name: 'Riverside', address: '100 River Walk' });
    expect(parsed.visibility).toBe('unlisted');
    expect(parsed.seo).toEqual({ title: 'Search title', description: 'Search description' });
    expect(parsed.coverImageUrl).toBe('https://cdn.example.test/cover.jpg');
  });

  it('accepts ended but rejects hidden ticket statuses on updates', () => {
    const parsed = parseBody(updateTicketTypeSchema, { status: 'ended' });
    expect(parsed.status).toBe('ended');
    expect(() => parseBody(updateTicketTypeSchema, { status: 'hidden' })).toThrow(ValidationError);
  });

  it('validates access-rule creation payloads', () => {
    const parsed = parseBody(createAccessRuleSchema, {
      type: 'code',
      value: 'VIP123',
      maxUses: 10,
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(parsed.value).toBe('VIP123');
    expect(() => parseBody(createAccessRuleSchema, { type: 'code', value: '' })).toThrow(
      ValidationError,
    );
  });

  it('validates atomic ticket type batch payloads', () => {
    const create = parseBody(createTicketTypeBatchSchema, {
      ticketType: {
        name: 'Locked VIP',
        kind: 'paid',
        visibility: 'locked',
        priceCents: 7500,
        minimumPriceCents: null,
        currency: 'USD',
        requiresAccessCode: true,
        accessCodeHint: null,
      },
      inventoryPool: {
        name: 'VIP pool',
        totalCapacity: 50,
      },
      accessRules: [{ type: 'code', value: 'VIP123' }],
    });
    expect(create.inventoryPool?.totalCapacity).toBe(50);
    expect(create.ticketType.minimumPriceCents).toBeNull();
    expect(create.ticketType.accessCodeHint).toBeNull();
    expect(create.accessRules?.[0]?.value).toBe('VIP123');

    const update = parseBody(updateTicketTypeBatchSchema, {
      ticketType: {
        status: 'active',
        visibility: 'locked',
      },
      accessRules: [{ type: 'code', value: 'VIP456', maxUses: 10 }],
    });
    expect(update.ticketType.status).toBe('active');
    expect(update.accessRules?.[0]?.maxUses).toBe(10);

    expect(() =>
      parseBody(createTicketTypeBatchSchema, {
        ticketType: {
          name: 'No pool',
          kind: 'paid',
          priceCents: 7500,
          currency: 'USD',
        },
      }),
    ).toThrow(ValidationError);
  });

  it('validates product and product category payloads', () => {
    const category = parseBody(createProductCategorySchema, { name: 'Merch', sortOrder: 2 });
    expect(category).toEqual({ name: 'Merch', sortOrder: 2 });

    const product = parseBody(createProductSchema, {
      name: 'T-shirt',
      description: 'Cotton shirt',
      priceCents: 2500,
      currency: 'USD',
      categoryId: 'pcat_1',
      maxPerOrder: 3,
      availableFrom: '2026-08-01T00:00:00.000Z',
      status: 'active',
      sortOrder: 1,
    });
    expect(product.priceCents).toBe(2500);
    expect(product.categoryId).toBe('pcat_1');

    const update = parseBody(updateProductSchema, {
      description: null,
      categoryId: null,
      availableUntil: null,
      status: 'inactive',
    });
    expect(update.description).toBeNull();
    expect(update.categoryId).toBeNull();
    expect(update.availableUntil).toBeNull();

    expect(() =>
      parseBody(createProductSchema, { name: 'Bad', priceCents: -1, currency: 'USD' }),
    ).toThrow(ValidationError);
    expect(() => parseBody(updateProductSchema, { status: 'archived' })).toThrow(ValidationError);
  });
});

describe('webhook and OAuth URL policy', () => {
  it('accepts external https webhook URLs', () => {
    const body = parseBody(createWebhookEndpointSchema, {
      organizationId: 'org_1',
      url: 'https://hooks.example.com/tixkit',
      events: ['order.created'],
    });
    expect(body.url).toBe('https://hooks.example.com/tixkit');
  });

  it.each([
    { events: [], label: 'empty event list' },
    { events: [''], label: 'blank event name' },
    { events: ['order.paidd'], label: 'unknown event name' },
    { events: ['order.paid', 'order.paid'], label: 'duplicate event names' },
    {
      events: [
        'order.created',
        'order.paid',
        'order.refunded',
        'order.disputed',
        'ticket.issued',
        'ticket.checked_in',
        'attendee.updated',
        'event.published',
        'event.cancelled',
        'order.created',
      ],
      label: 'oversized event list',
    },
  ])('rejects webhook endpoint create with $label', ({ events }) => {
    expect(() =>
      parseBody(createWebhookEndpointSchema, {
        organizationId: 'org_1',
        url: 'https://hooks.example.com/tixkit',
        events,
      }),
    ).toThrow(ValidationError);
  });

  it.each([
    { events: [], label: 'empty event list' },
    { events: [''], label: 'blank event name' },
    { events: ['ticket.checked_in', 'ticket.checked_in'], label: 'duplicate event names' },
    { events: ['ticket.checked_in', 'ticket.checkedin'], label: 'unknown event name' },
  ])('rejects webhook endpoint update with $label', ({ events }) => {
    expect(() => parseBody(updateWebhookEndpointSchema, { events })).toThrow(ValidationError);
  });

  it.each([
    'http://hooks.example.com/tixkit',
    'https://localhost:8443/tixkit',
    'https://127.0.0.1/tixkit',
    'https://10.0.0.10/tixkit',
    'https://172.16.0.10/tixkit',
    'https://192.168.1.10/tixkit',
    'https://metadata.internal/tixkit',
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
    expect(() =>
      parseBody(updateWebhookEndpointSchema, { url: 'https://127.0.0.1/tixkit' }),
    ).toThrow(ValidationError);
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

describe('messaging schemas', () => {
  it('rejects unsafe template keys and oversized variables', () => {
    expect(() =>
      parseBody(sendMessageSchema, {
        channel: 'sms',
        audience: 'all',
        smsTemplateKey: '../attendee-message',
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseBody(sendMessageSchema, {
        channel: 'sms',
        audience: 'all',
        smsTemplateKey: 'attendee-message',
        variables: { body: 'x'.repeat(MAX_MESSAGE_VARIABLES_BYTES + 1) },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects oversized render-preview templates and context', () => {
    expect(() =>
      parseBody(renderMessagePreviewSchema, {
        channel: 'email',
        htmlTemplate: 'x'.repeat(MAX_MESSAGE_TEMPLATE_HTML_LENGTH + 1),
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseBody(renderMessagePreviewSchema, {
        channel: 'sms',
        textTemplate: 'Hello {{recipient.name}}',
        context: { body: 'x'.repeat(MAX_MESSAGE_VARIABLES_BYTES + 1) },
      }),
    ).toThrow(ValidationError);
  });
});

describe('parseBody strict mode', () => {
  it('rejects unknown fields in refundSchema', () => {
    expect(() => parseBody(refundSchema, { reason: 'test', unknownField: 'bad' })).toThrow(
      ValidationError,
    );
  });

  it('accepts valid refund body', () => {
    const body = parseBody(refundSchema, { reason: 'Customer requested', amountCents: 5000 });
    expect(body.reason).toBe('Customer requested');
    expect(body.amountCents).toBe(5000);
  });
});

describe('check-in scan schemas', () => {
  it('accepts the production offline sync batch ceiling', () => {
    const scans = makeOfflineScans(MAX_OFFLINE_SYNC_SCANS);
    const body = parseBody(syncScanSchema, { checkInListId: 'cil_1', scans });

    expect(body.scans).toHaveLength(MAX_OFFLINE_SYNC_SCANS);
  });

  it('caps offline sync batches before repository work', () => {
    const scans = makeOfflineScans(MAX_OFFLINE_SYNC_SCANS + 1);

    expect(() => parseBody(syncScanSchema, { checkInListId: 'cil_1', scans })).toThrow(
      ValidationError,
    );
  });
});
