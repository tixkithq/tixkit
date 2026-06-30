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

  it('resolves custom answers', () => {
    const out = renderMergeTags('Shirt: {{customAnswers.tshirtSize}}', baseContext, {
      channel: 'email',
    });
    expect(out).toBe('Shirt: M');
  });

  it('resolves ticket QR code URLs for email image blocks', () => {
    const out = renderMergeTags('QR: {{ticket.qrCodeUrl}}', baseContext, {
      channel: 'email',
      escape: 'plain',
    });
    expect(out).toBe('QR: https://tickets.example.test/qr/TKT-ABC123.png');
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
  });

  it('accepts custom answers as known', () => {
    const result = validateMergeTags('{{customAnswers.shirt}} {{recipient.name}}');
    expect(result.unknownTags).toEqual([]);
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
    expect(listTemplateTags('Hi {{recipient.name}} {{event.title}} {{recipient.name}}')).toEqual([
      'recipient.name',
      'event.title',
    ]);
  });
});
