import { describe, expect, it } from 'vitest';
import {
  EVENT_PAGE_LEGACY_COMMERCE_BLOCK_TYPES,
  EVENT_PAGE_PUCK_COMPONENT_TYPES,
  EVENT_PAGE_SCHEMA_VERSION,
  PUCK_EVENT_PAGE_PROVIDER,
  createDefaultEventPageDocument,
  eventPageBrandVariablesToCssProperties,
  formatTimezoneLabel,
  migrateLegacyEventPageBlocksToPuckData,
  migrateLegacyEventPageDocumentToPuck,
  materializeEventPageDocument,
  normalizeEventPageDocument,
  sanitizeEventPageEmbedHtml,
  validateEventPageDocument,
  type EventPageDocument,
} from '../index.js';

const defaultInput = {
  eventId: 'evt_demo_001',
  eventTitle: 'All Access Chicago',
  eventDescription: 'A full night of music and access.',
  startsAt: '2026-07-17T19:00:00.000Z',
  timezone: 'America/Chicago',
  venue: {
    name: 'The Salt Shed',
    address: '1357 N Elston Ave',
    city: 'Chicago',
    region: 'IL',
    country: 'US',
    mapUrl: 'https://maps.example.test/salt-shed',
  },
  brandName: 'Tixkit',
  coverImageUrl: 'https://cdn.example.test/all-access.jpg',
  coverImageAlt: 'All Access Chicago crowd',
  publicUrl: 'https://events.example.test/e/all-access-chicago',
};

describe('EventPageDocument v2', () => {
  it('creates a schemaVersion 2 Puck document', () => {
    const document = createDefaultEventPageDocument(defaultInput);

    expect(document.schemaVersion).toBe(EVENT_PAGE_SCHEMA_VERSION);
    expect(document.editor.provider).toBe(PUCK_EVENT_PAGE_PROVIDER);
    expect(document.editor.data.root.props.title).toBe('All Access Chicago');
    expect(document.editor.data.content.map((block) => block.type)).toEqual([
      'EventHeader',
      'EventDescription',
      'Divider',
      'Tickets',
      'ResaleTickets',
      'CheckoutCta',
      'BrandFooter',
    ]);
    expect(document.editor.data.content[0]).toEqual(
      expect.objectContaining({
        type: 'EventHeader',
        props: expect.objectContaining({
          title: 'All Access Chicago',
          brandLabel: 'Tixkit',
          timezone: expect.not.stringMatching(/^America\//),
        }),
      }),
    );
    expect(validateEventPageDocument(document).valid).toBe(true);
  });

  it('formats IANA timezones as human-readable labels', () => {
    expect(formatTimezoneLabel('America/New_York', '2026-07-15T23:00:00.000Z')).toEqual(
      expect.stringMatching(/Eastern|EDT|EST|New York/i),
    );
    expect(formatTimezoneLabel('America/Chicago')).toEqual(
      expect.stringMatching(/Central|CDT|CST|Chicago/i),
    );
    expect(formatTimezoneLabel('Pacific Time')).toBe('Pacific Time');
  });

  it('fills missing header media from current event data without replacing an explicit override', () => {
    const original = createDefaultEventPageDocument({
      ...defaultInput,
      coverImageUrl: undefined,
      coverImageAlt: undefined,
    });
    const filled = materializeEventPageDocument(original, defaultInput);
    expect(filled.editor.data.content[0]).toMatchObject({
      type: 'EventHeader',
      props: {
        imageUrl: defaultInput.coverImageUrl,
        imageAlt: defaultInput.coverImageAlt,
      },
    });

    const explicit = createDefaultEventPageDocument({
      ...defaultInput,
      coverImageUrl: 'https://cdn.example.test/organizer-override.jpg',
      coverImageAlt: 'Organizer override',
    });
    const preserved = materializeEventPageDocument(explicit, defaultInput);
    expect(preserved.editor.data.content[0]).toMatchObject({
      type: 'EventHeader',
      props: {
        imageUrl: 'https://cdn.example.test/organizer-override.jpg',
        imageAlt: 'Organizer override',
      },
    });
  });

  it('normalizes only the hard-cutover v2 provider shape', () => {
    const document = createDefaultEventPageDocument(defaultInput);
    expect(normalizeEventPageDocument(document)).toBe(document);

    expect(
      normalizeEventPageDocument({
        schemaVersion: 1,
        editor: { provider: '@tiptap/core', document: { type: 'doc' } },
        settings: { locale: 'en', discovery: { summary: 'legacy', tags: [] } },
        blocks: [],
      }),
    ).toBeUndefined();
    expect(
      normalizeEventPageDocument({
        ...document,
        editor: { ...document.editor, provider: '@tiptap/core' },
      }),
    ).toBeUndefined();
  });

  it('exports the expected full-page Puck vocabulary', () => {
    expect(EVENT_PAGE_PUCK_COMPONENT_TYPES).toEqual([
      'EventHeader',
      'EventDescription',
      'RichText',
      'Media',
      'EventDetails',
      'Schedule',
      'Venue',
      'FAQ',
      'Sponsors',
      'Speakers',
      'Button',
      'Divider',
      'SocialLinks',
      'CustomEmbed',
      'Tickets',
      'ProductAddOns',
      'ResaleTickets',
      'CheckoutCta',
      'BrandFooter',
    ]);
    expect(EVENT_PAGE_LEGACY_COMMERCE_BLOCK_TYPES).toEqual([
      'event_header',
      'tickets',
      'products',
      'resale_tickets',
      'brand_footer',
    ]);
  });

  it('maps brand tokens to isolated CSS variables', () => {
    expect(
      eventPageBrandVariablesToCssProperties({
        background: '#000000',
        foreground: '#ffffff',
        accent: '#ffcc00',
        accentForeground: '#111111',
        fontBody: 'Inter, sans-serif',
        fontHeading: 'Georgia, serif',
        radius: '8px',
      }),
    ).toEqual({
      '--tk-brand-bg': '#000000',
      '--tk-brand-fg': '#ffffff',
      '--tk-brand-accent': '#ffcc00',
      '--tk-brand-accent-fg': '#111111',
      '--tk-brand-font-body': 'Inter, sans-serif',
      '--tk-brand-font-heading': 'Georgia, serif',
      '--tk-brand-radius': '8px',
    });
  });
});

describe('legacy block migration helper', () => {
  it('maps legacy content blocks and drops checkout-owned commerce blocks', () => {
    const data = migrateLegacyEventPageBlocksToPuckData([
      { id: 'event-header', type: 'event_header' },
      { id: 'hero-1', type: 'hero', headline: 'Legacy hero', body: 'Welcome' },
      { id: 'tickets-1', type: 'tickets', title: 'Tickets' },
      {
        id: 'rich-1',
        type: 'rich_text',
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Story' }] }],
        },
      },
      { id: 'resale-1', type: 'resale_tickets', title: 'Resale' },
      { id: 'button-1', type: 'button', label: 'More', url: 'https://example.test/more' },
    ]);

    expect(data.content.map((block) => block.type)).toEqual(['RichText', 'Button']);
    expect(data.content.map((block) => block.props.id)).toEqual(['rich-1', 'button-1']);
  });

  it('wraps migrated data in the v2 document contract', () => {
    const migrated = migrateLegacyEventPageDocumentToPuck(
      {
        settings: {
          locale: 'en-US',
          discovery: { summary: 'Migrated summary', tags: ['music'] },
        },
        blocks: [{ id: 'hero-1', type: 'hero', headline: 'Migrated event' }],
      },
      defaultInput,
    );

    expect(migrated).toMatchObject({
      schemaVersion: 2,
      editor: { provider: '@puckeditor/core' },
      settings: {
        locale: 'en-US',
        discovery: { summary: 'Migrated summary', tags: ['music'] },
      },
    });
    expect(migrated.editor.data.content.some((block) => block.props.id === 'hero-1')).toBe(false);
    expect(JSON.stringify(migrated.editor.data.content)).not.toContain('Migrated event');
    expect(validateEventPageDocument(migrated).valid).toBe(true);
  });
});

describe('validation', () => {
  it('rejects commerce blocks in Puck content', () => {
    const document = createDefaultEventPageDocument(defaultInput);
    const invalid: EventPageDocument = {
      ...document,
      editor: {
        provider: PUCK_EVENT_PAGE_PROVIDER,
        data: {
          ...document.editor.data,
          content: [
            ...document.editor.data.content,
            {
              type: 'tickets' as never,
              props: { id: 'tickets-legacy' },
            },
          ],
        },
      },
    };

    const result = validateEventPageDocument(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'commerce_block_not_content',
          field: 'editor.data.content.7.type',
        }),
      ]),
    );
  });

  it('rejects unsafe URLs and missing image alt text', () => {
    const document = createDefaultEventPageDocument(defaultInput);
    document.editor.data.content.push({
      type: 'Media',
      props: {
        id: 'media-unsafe',
        imageUrl: 'http://127.0.0.1/private.jpg',
        imageAlt: '',
        aspectRatio: '16:9',
      },
    });

    const result = validateEventPageDocument(document);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsafe_url',
          field: 'editor.data.content.7.props.imageUrl',
        }),
        expect.objectContaining({
          code: 'missing_required_text',
          field: 'editor.data.content.7.props.imageAlt',
        }),
      ]),
    );
  });

  it('requires explicit unsafe embed opt-in', () => {
    const document = createDefaultEventPageDocument(defaultInput);
    document.editor.data.content.push({
      type: 'CustomEmbed',
      props: {
        id: 'embed-1',
        html: '<iframe src="https://video.example.test/embed/abc"></iframe>',
        allowUnsafeEmbed: false,
      },
    });

    const result = validateEventPageDocument(document);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'embed_requires_opt_in',
          field: 'editor.data.content.7.props.allowUnsafeEmbed',
        }),
      ]),
    );
  });

  it('sandboxes public iframe embeds and rejects unsafe iframe destinations', () => {
    expect(
      sanitizeEventPageEmbedHtml(
        '<iframe src="https://video.example.test/embed/abc" sandbox="allow-same-origin allow-scripts" referrerpolicy="origin"></iframe>',
      ),
    ).toBe(
      '<iframe src="https://video.example.test/embed/abc" title="Embedded content" sandbox="allow-scripts allow-forms allow-popups" referrerpolicy="no-referrer" loading="lazy"></iframe>',
    );
    expect(sanitizeEventPageEmbedHtml('<iframe src="http://127.0.0.1/admin"></iframe>')).toBe('');
    expect(sanitizeEventPageEmbedHtml('<iframe src="https://[fd12:3456::1]/"></iframe>')).toBe('');
    expect(sanitizeEventPageEmbedHtml('<iframe src="https://localhost./admin"></iframe>')).toBe('');
    expect(sanitizeEventPageEmbedHtml('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBe(
      '',
    );
    expect(
      sanitizeEventPageEmbedHtml(
        '<form action="javascript:alert(1)"><button>Continue</button></form><svg><a xlink:href="javascript:alert(1)">Open</a></svg>',
      ),
    ).toBe('');
  });
});
