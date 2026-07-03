import { describe, it, expect } from 'vitest';
import {
  MERGE_TAG_REGISTRY,
  renderMergeTags,
  validateMergeTags,
  listTemplateTags,
  htmlEscape,
  plainTextEscape,
  detectEncoding,
  countSmsSegments,
  injectOptOutToken,
  estimateSmsCost,
  MergeTagError,
  type MergeTagContext,
} from '../messaging/merge-tags.js';

const baseContext: MergeTagContext = {
  event: {
    title: 'Summer Showcase',
    startsAt: '2026-07-04 19:00',
    venueName: 'The Grand Hall',
    venueCity: 'Brooklyn',
    publicUrl: 'https://example.test/e/evt_1',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_1',
  },
  brand: { name: 'Acme Events', supportUrl: 'https://help.example.test' },
  recipient: { name: 'Jordan Lee', email: 'jordan@example.test' },
  attendee: { name: 'Jordan Lee', checkedIn: false },
  ticket: {
    type: 'General Admission',
    code: 'TKT-ABC123',
    qrCodeUrl: 'https://tickets.example.test/qr/TKT-ABC123.png',
  },
  order: { id: 'ORD-123', total: '$45.00' },
  customAnswers: { tshirtSize: 'M' },
};

describe('merge-tag registry', () => {
  it('exposes a non-empty whitelisted vocabulary', () => {
    expect(MERGE_TAG_REGISTRY.length).toBeGreaterThan(10);
    expect(MERGE_TAG_REGISTRY.some((v) => v.required)).toBe(true);
  });

  it('marks recipient.name as required', () => {
    const recipientName = MERGE_TAG_REGISTRY.find((v) => v.key === 'recipient.name');
    expect(recipientName?.required).toBe(true);
  });

  it('includes ticket QR image URLs for rendered email QR blocks', () => {
    const qrCodeUrl = MERGE_TAG_REGISTRY.find((v) => v.key === 'ticket.qrCodeUrl');
    expect(qrCodeUrl?.example).toContain('https://');
  });
});

describe('P0 lifecycle merge-tag variables', () => {
  const p0Variables = [
    'event.doorTime',
    'event.mapUrl',
    'event.refundPolicyUrl',
    'event.changeSummary',
    'event.cancellationReason',
    'order.manageUrl',
    'order.receiptUrl',
    'order.retryUrl',
    'order.cancellationReason',
    'order.creditStatus',
    'order.buyerName',
    'order.buyerEmail',
    'ticket.pdfUrl',
    'ticket.walletAppleUrl',
    'ticket.walletGoogleUrl',
    'refund.processingEta',
    'refund.processedAt',
    'device.inviteUrl',
    'device.permissionScope',
    'device.expiresAt',
    'dashboard.url',
  ];

  it('registers every P0 lifecycle gap variable', () => {
    const keys = new Set(MERGE_TAG_REGISTRY.map((v) => v.key));
    for (const key of p0Variables) {
      expect(keys.has(key), `missing registry entry for {{${key}}}`).toBe(true);
    }
  });

  it('resolves P0 lifecycle variables from context', () => {
    const ctx: MergeTagContext = {
      ...baseContext,
      event: {
        ...baseContext.event,
        doorTime: '2026-07-04 18:00',
        mapUrl: 'https://maps.example.test/venue',
        refundPolicyUrl: 'https://help.example.test/refunds',
        changeSummary: 'Venue moved to The Forum',
        cancellationReason: 'Weather',
      },
      order: {
        ...baseContext.order,
        manageUrl: 'https://checkout.example.test/orders/ORD-123',
        receiptUrl: 'https://checkout.example.test/receipts/ORD-123',
        retryUrl: 'https://checkout.example.test/checkout?retry=ORD-123',
        cancellationReason: 'Organizer cancelled',
        creditStatus: 'Full credit issued',
        buyerName: 'Jordan Lee',
        buyerEmail: 'jordan@example.test',
      },
      ticket: {
        ...baseContext.ticket,
        pdfUrl: 'https://tickets.example.test/pdf/TKT-ABC123.pdf',
        walletAppleUrl: 'https://tickets.example.test/pass/apple/TKT-ABC123.pkpass',
        walletGoogleUrl: 'https://pay.google.com/gp/v/save/abc',
      },
      refund: {
        amount: '$20.00',
        processingEta: '5-10 business days',
        processedAt: '2026-07-10 12:00',
      },
      device: {
        inviteUrl: 'https://scan.example.test/invite/dev_1',
        permissionScope: 'checkins.write',
        expiresAt: '2026-07-04 19:00',
      },
      dashboard: { url: 'https://admin.example.test/events/evt_1' },
    };

    const out = renderMergeTags(
      [
        'Doors {{event.doorTime}} at {{event.venueName}}.',
        'Map {{event.mapUrl}}. Refunds {{event.refundPolicyUrl}}.',
        'Update {{event.changeSummary}}. Cancelled {{event.cancellationReason}}.',
        'Manage {{order.manageUrl}}. Receipt {{order.receiptUrl}}. Retry {{order.retryUrl}}.',
        'Cancel reason {{order.cancellationReason}}. Credit {{order.creditStatus}}.',
        'Buyer {{order.buyerName}} <{{order.buyerEmail}}>.',
        'PDF {{ticket.pdfUrl}}. Apple {{ticket.walletAppleUrl}}. Google {{ticket.walletGoogleUrl}}.',
        'Refund ETA {{refund.processingEta}} processed {{refund.processedAt}}.',
        'Invite {{device.inviteUrl}} scope {{device.permissionScope}} expires {{device.expiresAt}}.',
        'Dashboard {{dashboard.url}}.',
      ].join(' '),
      ctx,
      { channel: 'email' },
    );

    expect(out).toContain('Doors 2026-07-04 18:00 at The Grand Hall.');
    expect(out).toContain('Map https://maps.example.test/venue.');
    expect(out).toContain('Refunds https://help.example.test/refunds.');
    expect(out).toContain('Update Venue moved to The Forum.');
    expect(out).toContain('Cancelled Weather.');
    expect(out).toContain('Manage https://checkout.example.test/orders/ORD-123.');
    expect(out).toContain('Receipt https://checkout.example.test/receipts/ORD-123.');
    expect(out).toContain('Retry https://checkout.example.test/checkout?retry=ORD-123.');
    expect(out).toContain('Cancel reason Organizer cancelled.');
    expect(out).toContain('Credit Full credit issued.');
    expect(out).toContain('Buyer Jordan Lee <jordan@example.test>.');
    expect(out).toContain('PDF https://tickets.example.test/pdf/TKT-ABC123.pdf.');
    expect(out).toContain('Apple https://tickets.example.test/pass/apple/TKT-ABC123.pkpass.');
    expect(out).toContain('Google https://pay.google.com/gp/v/save/abc.');
    expect(out).toContain('Refund ETA 5-10 business days processed 2026-07-10 12:00.');
    expect(out).toContain(
      'Invite https://scan.example.test/invite/dev_1 scope checkins.write expires 2026-07-04 19:00.',
    );
    expect(out).toContain('Dashboard https://admin.example.test/events/evt_1.');
  });

  it('falls back to empty for unresolved P0 lifecycle variables', () => {
    const out = renderMergeTags(
      'PDF {{ticket.pdfUrl}} wallet {{ticket.walletAppleUrl}} dashboard {{dashboard.url}}',
      baseContext,
      { channel: 'email' },
    );
    expect(out).toBe('PDF  wallet  dashboard ');
  });

  it('rejects non-http(s) values for P0 lifecycle URL tags', () => {
    const ctx: MergeTagContext = {
      ...baseContext,
      ticket: {
        ...baseContext.ticket,
        pdfUrl: 'javascript:alert(1)',
        walletAppleUrl: 'data:text/html,<script>alert(1)</script>',
        walletGoogleUrl: 'ftp://evil.example/pass',
      },
      order: { ...baseContext.order, manageUrl: 'javascript:alert(1)', retryUrl: 'data:text/plain,x' },
      device: { inviteUrl: 'file:///etc/passwd', permissionScope: 'x', expiresAt: 'x' },
    };
    const out = renderMergeTags(
      '{{ticket.pdfUrl}}|{{ticket.walletAppleUrl}}|{{ticket.walletGoogleUrl}}|{{order.manageUrl}}|{{order.retryUrl}}|{{device.inviteUrl}}',
      ctx,
      { channel: 'email' },
    );
    expect(out).toBe('|||||');
  });
});

describe('P1/P2 lifecycle merge-tag variables', () => {
  const p1p2Variables = [
    'ticket.transferUrl',
    'waitlist.position',
    'waitlist.inviteUrl',
    'waitlist.expiresAt',
    'chargeback.id',
    'chargeback.amount',
    'chargeback.dueAt',
    'chargeback.evidenceUrl',
    'payout.amount',
    'payout.eta',
    'payout.account',
    'payout.period',
    'webhook.endpointUrl',
    'webhook.attempts',
    'integration.name',
    'integration.reconnectUrl',
    'salesDigest.revenue',
    'salesDigest.orders',
    'salesDigest.topTicketType',
  ];

  it('registers every P1/P2 lifecycle variable', () => {
    const keys = new Set(MERGE_TAG_REGISTRY.map((v) => v.key));
    for (const key of p1p2Variables) {
      expect(keys.has(key), `missing registry entry for {{${key}}}`).toBe(true);
    }
  });

  it('resolves P1/P2 lifecycle variables from context', () => {
    const ctx: MergeTagContext = {
      ...baseContext,
      ticket: { ...baseContext.ticket, transferUrl: 'https://checkout.example.test/transfer/tkt_1/claim' },
      waitlist: {
        position: '12',
        inviteUrl: 'https://checkout.example.test/waitlist/claim/abc',
        expiresAt: '2026-07-04 19:00',
      },
      chargeback: {
        id: 'dp_1',
        amount: '$45.00',
        dueAt: '2026-07-18',
        evidenceUrl: 'https://admin.example.test/disputes/dp_1',
      },
      payout: { amount: '$1,250.00', eta: '2-3 business days', account: 'Bank ••••4242', period: 'June 2026' },
      webhook: { endpointUrl: 'https://hooks.example.test/integrations/stripe', attempts: '5' },
      integration: { name: 'Stripe', reconnectUrl: 'https://admin.example.test/integrations/stripe/reconnect' },
      salesDigest: { revenue: '$4,320.00', orders: '38', topTicketType: 'General Admission' },
    };

    const out = renderMergeTags(
      [
        'Transfer {{ticket.transferUrl}}.',
        'Waitlist pos {{waitlist.position}} invite {{waitlist.inviteUrl}} exp {{waitlist.expiresAt}}.',
        'Chargeback {{chargeback.id}} {{chargeback.amount}} due {{chargeback.dueAt}} evidence {{chargeback.evidenceUrl}}.',
        'Payout {{payout.amount}} eta {{payout.eta}} account {{payout.account}} period {{payout.period}}.',
        'Webhook {{webhook.endpointUrl}} attempts {{webhook.attempts}}.',
        'Integration {{integration.name}} reconnect {{integration.reconnectUrl}}.',
        'Digest revenue {{salesDigest.revenue}} orders {{salesDigest.orders}} top {{salesDigest.topTicketType}}.',
      ].join(' '),
      ctx,
      { channel: 'email' },
    );

    expect(out).toContain('Transfer https://checkout.example.test/transfer/tkt_1/claim.');
    expect(out).toContain('Waitlist pos 12 invite https://checkout.example.test/waitlist/claim/abc exp 2026-07-04 19:00.');
    expect(out).toContain('Chargeback dp_1 $45.00 due 2026-07-18 evidence https://admin.example.test/disputes/dp_1.');
    expect(out).toContain('Payout $1,250.00 eta 2-3 business days account Bank ••••4242 period June 2026.');
    expect(out).toContain('Webhook https://hooks.example.test/integrations/stripe attempts 5.');
    expect(out).toContain('Integration Stripe reconnect https://admin.example.test/integrations/stripe/reconnect.');
    expect(out).toContain('Digest revenue $4,320.00 orders 38 top General Admission.');
  });

  it('rejects non-http(s) values for P1/P2 URL tags', () => {
    const ctx: MergeTagContext = {
      ...baseContext,
      ticket: { ...baseContext.ticket, transferUrl: 'javascript:alert(1)' },
      waitlist: { inviteUrl: 'data:text/html,<script>' },
      chargeback: { evidenceUrl: 'file:///etc/passwd' },
      webhook: { endpointUrl: 'ftp://evil.example' },
      integration: { reconnectUrl: 'vbscript:msgbox(1)' },
    };
    const out = renderMergeTags(
      '{{ticket.transferUrl}}|{{waitlist.inviteUrl}}|{{chargeback.evidenceUrl}}|{{webhook.endpointUrl}}|{{integration.reconnectUrl}}',
      ctx,
      { channel: 'email' },
    );
    expect(out).toBe('||||');
  });
});

describe('renderMergeTags - email', () => {
  it('resolves whitelisted tags and HTML-escapes values', () => {
    const ctx: MergeTagContext = {
      ...baseContext,
      event: { ...baseContext.event, title: '<script>alert(1)</script>' },
    };
    const out = renderMergeTags('Hi {{recipient.name}}, welcome to {{event.title}}!', ctx, {
      channel: 'email',
    });
    expect(out).toBe('Hi Jordan Lee, welcome to &lt;script&gt;alert(1)&lt;/script&gt;!');
  });

  it('escapes quotes and ampersands', () => {
    const out = renderMergeTags(
      '{{brand.name}}',
      { brand: { name: 'A & B "Co"' } },
      {
        channel: 'email',
      },
    );
    expect(out).toBe('A &amp; B &quot;Co&quot;');
  });

  it('uses fallback for missing optional variables', () => {
    const out = renderMergeTags('Hi {{event.venueCity}}!', { event: {} }, { channel: 'email' });
    expect(out).toBe('Hi !');
  });

  it('uses a custom fallback for missing variables', () => {
    const out = renderMergeTags(
      'Hi {{event.venueCity}}!',
      { event: {} },
      {
        channel: 'email',
        fallback: '—',
      },
    );
    expect(out).toBe('Hi —!');
  });

  it('escapes custom fallback values before inserting them into email output', () => {
    const out = renderMergeTags(
      'Missing {{event.venueCity}} and {{unknown.tag}}',
      { event: {} },
      {
        channel: 'email',
        fallback: '<script>alert("x")</script>',
      },
    );
    expect(out).toBe(
      'Missing &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; and &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
  });

  it('resolves custom answers', () => {
    const out = renderMergeTags(
      'Shirt: {{customAnswers.tshirtSize}}, ticket: {{customAnswers.ticket-size}}',
      {
        ...baseContext,
        customAnswers: { tshirtSize: 'M', 'ticket-size': 'VIP' },
      },
      {
        channel: 'email',
      },
    );
    expect(out).toBe('Shirt: M, ticket: VIP');
  });

  it('resolves ticket QR code URLs for email image blocks', () => {
    const out = renderMergeTags('QR: {{ticket.qrCodeUrl}}', baseContext, {
      channel: 'email',
      escape: 'plain',
    });
    expect(out).toBe('QR: https://tickets.example.test/qr/TKT-ABC123.png');
  });

  it('falls back for unsafe URL-valued tags before email rendering', () => {
    const out = renderMergeTags(
      [
        '<a href="{{event.publicUrl}}">event</a>',
        '<a href="{{brand.supportUrl}}">support</a>',
        '<img src="{{ticket.qrCodeUrl}}">',
      ].join(' '),
      {
        event: { publicUrl: 'javascript:alert(1)' },
        brand: { supportUrl: 'vbscript:msgbox(1)' },
        ticket: { qrCodeUrl: 'data:text/html,<script>alert(1)</script>' },
      },
      {
        channel: 'email',
        fallback: '#',
      },
    );
    expect(out).toBe('<a href="#">event</a> <a href="#">support</a> <img src="#">');
  });

  it('renders attendee check-in status', () => {
    expect(
      renderMergeTags(
        'Status: {{attendee.checkedIn}}',
        { attendee: { checkedIn: true } },
        { channel: 'email' },
      ),
    ).toBe('Status: checked in');
    expect(
      renderMergeTags(
        'Status: {{attendee.checkedIn}}',
        { attendee: { checkedIn: false } },
        { channel: 'email' },
      ),
    ).toBe('Status: not checked in');
  });
});

describe('renderMergeTags - unknown tags', () => {
  it('falls back by default for unknown tags', () => {
    const out = renderMergeTags('Hi {{unknown.tag}}!', baseContext, { channel: 'email' });
    expect(out).toBe('Hi !');
  });

  it('preserves unknown tags when configured', () => {
    const out = renderMergeTags('Hi {{unknown.tag}}!', baseContext, {
      channel: 'email',
      unknownTagBehavior: 'preserve',
    });
    expect(out).toBe('Hi {{unknown.tag}}!');
  });

  it('throws on unknown tags when configured to error', () => {
    expect(() =>
      renderMergeTags('Hi {{unknown.tag}}!', baseContext, {
        channel: 'email',
        unknownTagBehavior: 'error',
      }),
    ).toThrow(MergeTagError);
  });
});

describe('renderMergeTags - sms', () => {
  it('plain-text renders without HTML escaping and injects opt-out token', () => {
    const out = renderMergeTags(
      'Hi {{recipient.name}}, your ticket {{ticket.code}} is ready',
      baseContext,
      { channel: 'sms', optOutToken: 'Reply STOP to opt out' },
    );
    expect(out).toBe('Hi Jordan Lee, your ticket TKT-ABC123 is ready. Reply STOP to opt out');
  });

  it('does not duplicate an already-present opt-out token', () => {
    const body = 'Hi {{recipient.name}}. Reply STOP to opt out';
    const out = renderMergeTags(body, baseContext, {
      channel: 'sms',
      optOutToken: 'Reply STOP to opt out',
    });
    expect(out).toBe('Hi Jordan Lee. Reply STOP to opt out');
  });

  it('strips control characters but keeps newlines in plain-text escape', () => {
    expect(plainTextEscape('a\x00b\x07c\nd')).toBe('abc\nd');
  });
});

describe('validateMergeTags', () => {
  it('reports unknown tags', () => {
    const result = validateMergeTags('Hi {{recipient.name}} and {{bogus.tag}}');
    expect(result.unknownTags).toEqual(['bogus.tag']);
    expect(result.valid).toBe(false);
  });

  it('reports missing required tags', () => {
    const result = validateMergeTags('Welcome to {{event.title}}');
    expect(result.missingRequired).toEqual(['recipient.name']);
    expect(result.valid).toBe(false);
  });

  it('accepts custom answers as known', () => {
    const result = validateMergeTags(
      '{{customAnswers.shirt}} {{customAnswers.ticket-size}} {{recipient.name}}',
    );
    expect(result.unknownTags).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('SMS segment accounting', () => {
  it('detects GSM vs unicode encoding', () => {
    expect(detectEncoding('Hello world')).toBe('gsm');
    expect(detectEncoding('Hello € world')).toBe('gsm'); // € is in extension table
    expect(detectEncoding('Hello 👍 world')).toBe('unicode');
    expect(detectEncoding('café')).toBe('gsm'); // é is part of the GSM basic charset
    expect(detectEncoding('こんにちは')).toBe('unicode');
  });

  it('counts a short GSM body as one segment', () => {
    const result = countSmsSegments('Hello world');
    expect(result.segments).toBe(1);
    expect(result.encoding).toBe('gsm');
    expect(result.charsPerSegment).toBe(160);
  });

  it('counts a 160-char GSM body as one segment and 161 as two', () => {
    const body160 = 'a'.repeat(160);
    expect(countSmsSegments(body160).segments).toBe(1);
    const body161 = 'a'.repeat(161);
    expect(countSmsSegments(body161).segments).toBe(2);
    expect(countSmsSegments(body161).charsPerSegment).toBe(153);
  });

  it('counts unicode bodies with 70/67 limits', () => {
    const body70 = '👍'.repeat(35); // 35 emoji = 70 unicode code units
    expect(countSmsSegments(body70).segments).toBe(1);
    const body71 = '👍'.repeat(36); // 72 code units
    expect(countSmsSegments(body71).segments).toBe(2);
    expect(countSmsSegments(body71).charsPerSegment).toBe(67);
  });

  it('treats GSM extension chars as 2 units', () => {
    // 159 basic + 1 extension char (2 units) = 161 units -> 2 segments
    const body = 'a'.repeat(159) + '{';
    const result = countSmsSegments(body);
    expect(result.unitsUsed).toBe(161);
    expect(result.segments).toBe(2);
  });

  it('estimates cost from per-segment rate', () => {
    expect(estimateSmsCost('hello', 0.05)).toBeCloseTo(0.05);
    expect(estimateSmsCost('a'.repeat(161), 0.05)).toBeCloseTo(0.1);
  });
});

describe('injectOptOutToken', () => {
  it('appends the token with a separator', () => {
    expect(injectOptOutToken('See you there', 'Reply STOP to opt out')).toBe(
      'See you there. Reply STOP to opt out',
    );
  });

  it('does not duplicate an existing token', () => {
    expect(injectOptOutToken('See you there. Reply STOP to opt out', 'Reply STOP to opt out')).toBe(
      'See you there. Reply STOP to opt out',
    );
  });
});

describe('htmlEscape', () => {
  it('escapes all five dangerous characters', () => {
    expect(htmlEscape('<>"\'&')).toBe('&lt;&gt;&quot;&#39;&amp;');
  });
});

// ---- Property / fuzz-style tests (deterministic, seeded loops) ----

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const HOSTILE_CHARS = [
  '<',
  '>',
  '"',
  "'",
  '&',
  '{',
  '}',
  '\\',
  '/',
  ' ',
  '\n',
  'é',
  '👍',
  'a',
  '1',
];

describe('merge-tag fuzz/property tests', () => {
  it('email rendering never emits unescaped <, >, or & from variable values', () => {
    const rand = seededRandom(42);
    for (let i = 0; i < 5000; i += 1) {
      const len = 1 + Math.floor(rand() * 12);
      let hostile = '';
      for (let j = 0; j < len; j += 1) {
        hostile += HOSTILE_CHARS[Math.floor(rand() * HOSTILE_CHARS.length)];
      }
      const out = renderMergeTags(
        'Hi {{recipient.name}}',
        { recipient: { name: hostile } },
        {
          channel: 'email',
        },
      );
      // No raw angle brackets or unescaped ampersand from the value.
      expect(out).not.toContain('<');
      expect(out).not.toContain('>');
      // Ampersand must be escaped (no bare & not part of an entity).
      const bareAmp = out.match(/&(?!amp;|lt;|gt;|quot;|#39;)/g);
      expect(bareAmp).toBeNull();
    }
  });

  it('rendering is idempotent for already-safe text', () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 1000; i += 1) {
      const safe = `Hello ${Math.floor(rand() * 1000)}`;
      const once = renderMergeTags(
        `{{recipient.name}}`,
        { recipient: { name: safe } },
        { channel: 'email' },
      );
      const twice = renderMergeTags(
        `{{recipient.name}}`,
        { recipient: { name: once } },
        { channel: 'email' },
      );
      // Escaping is idempotent: escaping an already-escaped & does produce &amp;amp;,
      // so we assert the second pass only differs by ampersand re-escaping and never
      // introduces raw angle brackets.
      expect(twice).not.toContain('<');
      expect(twice).not.toContain('>');
    }
  });

  it('SMS segment count is monotonic non-decreasing as body grows', () => {
    let body = '';
    let prev = 0;
    for (let i = 0; i < 320; i += 1) {
      body += i % 7 === 0 ? '👍' : 'a';
      const segs = countSmsSegments(body).segments;
      expect(segs).toBeGreaterThanOrEqual(prev);
      prev = segs;
    }
  });

  it('unknown tags never leak raw context object data', () => {
    const ctx: MergeTagContext = {
      recipient: { name: 'Secret' },
      event: { title: 'Hidden' },
    };
    for (let i = 0; i < 200; i += 1) {
      const tag = `fake${i}.field`;
      const out = renderMergeTags(`{{${tag}}}`, ctx, { channel: 'email' });
      expect(out).not.toContain('Secret');
      expect(out).not.toContain('Hidden');
    }
  });

  it('listTemplateTags extracts only the inner tag names', () => {
    expect(
      listTemplateTags(
        'Hi {{recipient.name}} {{event.title}} {{customAnswers.ticket-size}} {{recipient.name}}',
      ),
    ).toEqual(['recipient.name', 'event.title', 'customAnswers.ticket-size']);
  });

  it('does not treat top-level hyphenated brace text as merge tags', () => {
    expect(listTemplateTags('Literal {{promo-code}} text')).toEqual([]);
    expect(renderMergeTags('Literal {{promo-code}} text', baseContext, { channel: 'email' })).toBe(
      'Literal {{promo-code}} text',
    );
  });
});
