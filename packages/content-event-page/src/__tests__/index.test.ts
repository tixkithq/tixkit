import { describe, expect, it } from 'vitest';
import {
  EVENT_PAGE_INLINE_STYLE_MARK,
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
    {
      id: 'tt_ga',
      name: 'General Admission',
      description: 'Standing room',
      status: 'active' as const,
      priceLabel: '$35.00',
    },
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
      'event_header',
      'hero',
      'event_details',
      'tickets',
      'schedule',
      'venue_map',
      'faq',
      'resale_tickets',
      'brand_footer',
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
    expect(first.html).toContain('<div class="tixkit-event-page"');
    expect(first.html).not.toContain('<main');
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

  it('renders discovery URL merge tags through the safe URL path', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      publicUrl: '{{event.publicUrl}}',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });

    const rendered = renderEventPageDocument(document, context);

    expect(rendered.discovery.publicPath).toBe('https://events.example.test/e/all-access-chicago');
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

  it('renders approved rich-text inline styles and strips arbitrary style CSS', () => {
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
            attrs: { textAlign: 'center' },
            content: [
              {
                type: 'text',
                text: 'Styled page copy',
                marks: [
                  {
                    type: EVENT_PAGE_INLINE_STYLE_MARK,
                    attrs: {
                      color: '#0f766e',
                      fontFamily: 'Georgia, serif',
                      fontSize: '18px',
                      lineHeight: '140%',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const rendered = renderEventPageDocument(document, context);

    expect(rendered.validation.valid).toBe(true);
    expect(rendered.html).toContain('data-event-page-inline-style="true"');
    expect(rendered.html).toContain('style="text-align: center"');
    expect(rendered.html).toContain(
      'style="color: #0f766e; font-family: Georgia, serif; font-size: 18px; line-height: 140%"',
    );
    expect(sanitizeEventPageHtml('<span style="position:fixed;color:red">Bad</span>')).toBe(
      '<span>Bad</span>',
    );
    expect(
      sanitizeEventPageHtml(
        '<p style="position:fixed;text-align:center;color:#0f766e;font-size:18px;line-height:140%">Good</p>',
      ),
    ).toBe('<p style="color: #0f766e; font-size: 18px; line-height: 140%; text-align: center">Good</p>');
  });

  it('rejects rich-text images with unsafe URLs or missing alt text', () => {
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
            type: 'image',
            attrs: {
              src: 'http://127.0.0.1/private-preview.png',
              alt: '',
            },
          },
        ],
      },
    });

    const validation = validateEventPageDocument(document);
    const rendered = renderEventPageDocument(document, context);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsafe_image',
          field: 'blocks.9.content.content.0.attrs.src',
        }),
        expect.objectContaining({
          code: 'missing_image_alt',
          field: 'blocks.9.content.content.0.attrs.alt',
        }),
      ]),
    );
    expect(rendered.html).toBe('');
  });

  it('renders a deterministic 200-page load within the event-page budget', () => {
    const documents = Array.from({ length: 200 }, (_, index) =>
      createDefaultEventPageDocument({
        eventId: `evt_load_${index}`,
        eventTitle: `All Access Chicago ${index}`,
        eventDescription: `Load proof ${index}`,
        checkoutUrl: `https://checkout.example.test/checkout?eventId=evt_load_${index}`,
      }),
    );

    const startedAt = performance.now();
    const rendered = documents.map((document, index) =>
      renderEventPageDocument(document, {
        ...context,
        event: {
          ...context.event,
          title: `All Access Chicago ${index}`,
          checkoutUrl: `https://checkout.example.test/checkout?eventId=evt_load_${index}`,
        },
      }),
    );
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(2_000);
    expect(rendered).toHaveLength(200);
    expect(rendered.every((page) => page.validation.valid)).toBe(true);
    expect(new Set(rendered.map((page) => page.html)).size).toBe(200);
    expect(rendered.every((page) => !page.html.includes('<script'))).toBe(true);
  });

  it('fails closed for malformed editor exports with unsafe links and unsupported nodes', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.editor.document = {
      type: 'doc',
      content: [
        {
          type: 'video',
          attrs: { src: 'javascript:alert(1)' },
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Unsafe link',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    };

    const validation = validateEventPageDocument(document);
    const rendered = renderEventPageDocument(document, context);

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['unsupported_tiptap_node', 'unsafe_link']),
    );
    expect(rendered.html).toBe('');
    expect(rendered.headless).toEqual([]);
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
        '<div onclick="alert(1)" onmouseover=alert(2)><script>alert(1)</script><a href="jav&#x61;script:alert(1)" src=DATA:text/html,evil>quoted</a><img src="fi&Tab;le&colon;///etc/passwd" onerror=alert(3) /><a/href=javascript:alert(1)>slash link</a><img/src=javascript:alert(2) alt="slash image" /><a href="java&#9999999999;script:alert(1)">bad entity</a><form action="jav&#x61;script:alert(1)"><button>submit</button></form><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="jav&#x61;script:alert(1)"></object><svg><a xlink:href="jav&#x61;script:alert(1)">svg</a></svg></div>',
      ),
    ).toBe(
      '<div><a>quoted</a><img /><a>slash link</a><img alt="slash image" /><a>bad entity</a></div>',
    );
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
