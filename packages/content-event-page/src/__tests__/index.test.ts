import { describe, expect, it } from 'vitest';
import {
  TIPTAP_EVENT_PAGE_PROVIDER,
  createDefaultEventPageDocument,
  normalizeEventPageDocument,
  renderEventPageDocument,
  sanitizeEventPageHtml,
  validateEventPageDocument,
  type EventPageDocument,
} from '../index.js';

const context = {
  event: {
    id: 'evt_demo_001',
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    coverImageUrl: 'https://cdn.example.test/all-access.jpg',
    venue: { name: 'The Salt Shed', city: 'Chicago' },
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.example.test' },
  tickets: [
    { id: 'tt_ga', name: 'General Admission', description: 'Standing room', status: 'active' as const, priceLabel: '$35.00' },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden' as const, priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
};

describe('createDefaultEventPageDocument', () => {
  it('creates a TipTap-backed event page with required production blocks', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      startsAt: '2026-07-17T19:00:00.000Z',
      timezone: 'America/Chicago',
      venue: { name: 'The Salt Shed', city: 'Chicago' },
      brandName: 'Tixkit',
      publicUrl: 'https://events.example.test/e/all-access-chicago',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });

    expect(document.editor.provider).toBe(TIPTAP_EVENT_PAGE_PROVIDER);
    expect(document.blocks.map((block) => block.type)).toEqual([
      'hero',
      'event_details',
      'tickets',
      'schedule',
      'venue_map',
      'faq',
    ]);
    expect(validateEventPageDocument(document).valid).toBe(true);
  });
});

describe('renderEventPageDocument', () => {
  it('renders deterministic sanitized HTML, headless blocks, text, and discovery card', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });

    const first = renderEventPageDocument(document, context);
    const second = renderEventPageDocument(document, context);

    expect(first.validation.valid).toBe(true);
    expect(first.html).toContain('class="tixkit-event-page"');
    expect(first.html).toContain('All Access Chicago');
    expect(first.html).toContain('General Admission');
    expect(first.html).toContain('Get tickets');
    expect(first.text).toContain('Get tickets');
    expect(first.html).not.toContain('Hidden comp');
    expect(first.headless.some((block) => block.type === 'tickets')).toBe(true);
    expect(first.discovery).toMatchObject({
      title: 'All Access Chicago',
      summary: 'A full night of access.',
    });
    expect(second).toEqual(first);
  });

  it('escapes merge tag values and blocks unsafe links', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: '{{event.title}}',
      eventDescription: 'Safe copy',
      checkoutUrl: 'javascript:alert(1)',
    });

    const validation = validateEventPageDocument(document);
    const rendered = renderEventPageDocument(document, {
      ...context,
      event: { ...context.event, title: '<script>alert(1)</script>' },
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'unsafe_link')).toBe(true);
    expect(rendered.html).toBe('');
  });

  it('renders TipTap rich text without executing embedded script text', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'rich_text',
      id: 'story',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Welcome {{event.title}} <script>alert(1)</script>' }],
          },
        ],
      },
    });

    const rendered = renderEventPageDocument(document, context);

    expect(rendered.validation.valid).toBe(true);
    expect(rendered.html).toContain('Welcome All Access Chicago');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
  });
});

describe('custom embed sanitization', () => {
  it('fails closed unless unsafe embeds are explicitly allowed', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'custom_embed',
      id: 'embed',
      html: '<iframe src="https://player.example.test/video"></iframe>',
      allowUnsafeEmbed: true,
    });

    expect(validateEventPageDocument(document).valid).toBe(false);
    expect(validateEventPageDocument(document, { allowUnsafeEmbeds: true }).valid).toBe(true);
  });

  it('removes scripts, event handlers, and unsafe URL attributes', () => {
    expect(
      sanitizeEventPageHtml(
        '<div onclick="alert(1)" onmouseover=alert(2)><script>alert(1)</script><a href="javascript:alert(1)" src=DATA:text/html,evil>quoted</a><img src=file:///etc/passwd onerror=alert(3) /></div>',
      ),
    ).toBe('<div><a>quoted</a><img /></div>');
  });
});

describe('normalizeEventPageDocument', () => {
  it('accepts canonical event-page JSON and rejects unrelated objects', () => {
    const document: EventPageDocument = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });

    expect(normalizeEventPageDocument(document)).toBe(document);
    expect(normalizeEventPageDocument({ schemaVersion: 1, blocks: [] })).toBeUndefined();
  });
});
