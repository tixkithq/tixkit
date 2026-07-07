import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  blocksToEditorDocument,
  type EventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageSurface, EventPageEditorSurface } from '../index.js';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    description: 'A full night of music and access.',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    venueName: 'The Salt Shed',
    venueCity: 'Chicago',
  },
  brand: {
    name: 'Tixkit',
    supportUrl: 'https://help.example.test',
    termsUrl: 'https://example.test/terms',
    privacyUrl: 'https://example.test/privacy',
    refundUrl: 'https://example.test/refunds',
  },
  tickets: [
    { id: 'tt_ga', name: 'General Admission', description: 'Standing room', status: 'active', priceLabel: '$35.00' },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden', priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
  resaleListings: [
    { id: 'resale_1', ticketTypeName: 'General Admission', priceLabel: '$40.00', expiresAt: '2026-07-15T00:00:00.000Z' },
  ],
};

function comprehensiveDocument(): EventPageDocument {
  const doc = createDefaultEventPageDocument({
    eventId: 'evt_demo_001',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night of music and access.',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    venue: { name: 'The Salt Shed', city: 'Chicago' },
    brandName: 'Tixkit',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
  });
  doc.blocks.push(
    {
      id: 'rich-1',
      type: 'rich_text',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Extra copy' }] }] },
    },
    {
      id: 'products-1',
      type: 'products',
      title: 'Products',
      body: 'Add some merch.',
      productIds: ['prod_poster'],
    },
    {
      id: 'sponsors-1',
      type: 'sponsors',
      title: 'Sponsors',
      items: [{ name: 'Acme Corp', url: 'https://acme.test', imageUrl: 'https://cdn.test/acme.png', imageAlt: 'Acme logo' }],
    },
    {
      id: 'speakers-1',
      type: 'speakers',
      title: 'Speakers',
      items: [{ name: 'Jane Doe', role: 'Host', bio: 'Bio text' }],
    },
    {
      id: 'btn-1',
      type: 'button',
      label: 'Learn more',
      url: 'https://example.test/about',
      style: 'secondary',
    },
    { id: 'div-1', type: 'divider' },
    {
      id: 'social-1',
      type: 'social_links',
      title: 'Follow us',
      links: [{ label: 'Instagram', url: 'https://instagram.test/acme' }],
    },
    {
      id: 'embed-1',
      type: 'custom_embed',
      html: '<iframe src="https://youtube.test/embed/abc" width="560" height="315"></iframe>',
      allowUnsafeEmbed: true,
    },
  );
  // Rebuild editor.document to include all blocks (unified schema)
  doc.editor.document = blocksToEditorDocument(doc.blocks);
  return doc;
}

/**
 * Renders a document through both the editor canvas and the public surface,
 * returning both containers for structural comparison.
 */
function renderBoth(doc: EventPageDocument) {
  const resolved = resolveEventPageDocument(doc, context, { allowUnsafeEmbeds: true });
  const editor = render(<EventPageEditorSurface document={doc} sampleContext={context} />);
  const publicSurface = render(<EventPageSurface resolvedPage={resolved} />);
  return { resolved, editor, publicSurface };
}

/**
 * Phase 0: Canvas-vs-public parity harness.
 *
 * This test renders the same EventPageDocument through both
 * EventPageEditorSurface (the admin canvas, edit mode) and EventPageSurface
 * (the public/preview surface) and asserts that they share the same DOM
 * contract: .tk-ep-* class names, data-block-id attributes, heading levels,
 * and text content.
 *
 * Known parity gaps are documented in dedicated "gap" test cases. When a gap
 * is fixed in Phase 2, the gap test should be updated to assert full parity.
 */
describe('Phase 0: canvas-vs-public parity harness', () => {
  it('both surfaces render the root .tixkit-event-page class', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tixkit-event-page')).not.toBeNull();
    expect(publicSurface.container.querySelector('.tixkit-event-page')).not.toBeNull();
  });

  it('both surfaces render all 17 blocks with matching .tk-ep-* classes', () => {
    const doc = comprehensiveDocument();
    const { editor, publicSurface } = renderBoth(doc);

    for (const block of doc.blocks) {
      const cls = blockClass(block.type);
      const editorEl = editor.container.querySelector(`.${cls}[data-block-id="${block.id}"]`);
      const publicEl = publicSurface.container.querySelector(`.${cls}[data-block-id="${block.id}"]`);
      expect(editorEl, `editor missing ${cls}[data-block-id="${block.id}"]`).not.toBeNull();
      expect(publicEl, `public missing ${cls}[data-block-id="${block.id}"]`).not.toBeNull();
    }
  });
});

describe('Phase 0: per-block structural parity', () => {
  it('hero: both surfaces render h1 headline with the same text', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorH1 = editor.container.querySelector('.tk-ep-hero h1');
    const publicH1 = publicSurface.container.querySelector('.tk-ep-hero h1');
    expect(editorH1?.tagName).toBe('H1');
    expect(publicH1?.tagName).toBe('H1');
    expect(editorH1?.textContent).toBe(publicH1?.textContent);
  });

  it('hero: both surfaces render the eyebrow with the same text', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorEyebrow = editor.container.querySelector('.tk-ep-eyebrow');
    const publicEyebrow = publicSurface.container.querySelector('.tk-ep-eyebrow');
    expect(editorEyebrow?.textContent).toBe(publicEyebrow?.textContent);
  });

  it('hero: both surfaces render the body paragraph with the same text', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorBody = editor.container.querySelector('.tk-ep-hero p:not(.tk-ep-eyebrow)');
    const publicBody = publicSurface.container.querySelector('.tk-ep-hero p:not(.tk-ep-eyebrow)');
    expect(editorBody?.textContent).toBe(publicBody?.textContent);
  });

  it('tickets: both surfaces render h2 title with the same text', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-tickets h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-tickets h2')?.textContent,
    );
  });

  it('tickets: both surfaces render a UL list with the same ticket names', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorNames = Array.from(editor.container.querySelectorAll('.tk-ep-tickets ul li strong')).map((el) => el.textContent);
    const publicNames = Array.from(publicSurface.container.querySelectorAll('.tk-ep-tickets ul li strong')).map((el) => el.textContent);
    expect(editorNames).toEqual(publicNames);
    expect(editorNames).toContain('General Admission');
    expect(editorNames).not.toContain('Hidden comp');
  });

  it('event_details: both surfaces render h2 title and a DL with matching items', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-details h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-details h2')?.textContent,
    );
    const editorLabels = Array.from(editor.container.querySelectorAll('.tk-ep-details dt')).map((el) => el.textContent);
    const publicLabels = Array.from(publicSurface.container.querySelectorAll('.tk-ep-details dt')).map((el) => el.textContent);
    expect(editorLabels).toEqual(publicLabels);
  });

  it('schedule: both surfaces render h2 title and an OL list', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-schedule h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-schedule h2')?.textContent,
    );
    expect(editor.container.querySelector('.tk-ep-schedule ol')).not.toBeNull();
    expect(publicSurface.container.querySelector('.tk-ep-schedule ol')).not.toBeNull();
  });

  it('venue_map: both surfaces render h2 title and venue name with the same text', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-venue h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-venue h2')?.textContent,
    );
    // Editor renders venue name as EditableText (<p>), public renders <p><strong>
    // Compare text content, not element type (known structural gap)
    const editorVenueName = editor.container.querySelector('.tk-ep-venue__name')?.textContent;
    const publicVenueName = publicSurface.container.querySelector('.tk-ep-venue strong')?.textContent;
    expect(editorVenueName).toBe(publicVenueName);
  });

  it('faq: both surfaces render h2 title and a details/summary structure', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-faq h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-faq h2')?.textContent,
    );
    expect(editor.container.querySelector('.tk-ep-faq details summary')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-faq details summary')?.textContent,
    );
  });

  it('products: both surfaces render h2 title and a UL with matching product names', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-products h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-products h2')?.textContent,
    );
    const editorNames = Array.from(editor.container.querySelectorAll('.tk-ep-products ul li strong')).map((el) => el.textContent);
    const publicNames = Array.from(publicSurface.container.querySelectorAll('.tk-ep-products ul li strong')).map((el) => el.textContent);
    expect(editorNames).toEqual(publicNames);
  });

  it('sponsors: both surfaces render h2 title and a UL with matching names', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-sponsors h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-sponsors h2')?.textContent,
    );
    expect(editor.container.querySelector('.tk-ep-sponsors ul li strong')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-sponsors ul li strong')?.textContent,
    );
  });

  it('speakers: both surfaces render h2 title and a UL with matching names and roles', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-speakers h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-speakers h2')?.textContent,
    );
    expect(editor.container.querySelector('.tk-ep-speakers ul li strong')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-speakers ul li strong')?.textContent,
    );
  });

  it('social_links: both surfaces render the title and a UL with matching link labels', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-social h2')?.textContent).toBe(
      publicSurface.container.querySelector('.tk-ep-social h2')?.textContent,
    );
    const editorLabels = Array.from(editor.container.querySelectorAll('.tk-ep-social ul li a')).map((el) => el.textContent);
    const publicLabels = Array.from(publicSurface.container.querySelectorAll('.tk-ep-social ul li a')).map((el) => el.textContent);
    expect(editorLabels).toEqual(publicLabels);
  });

  it('divider: both surfaces render an hr with the tk-ep-divider class', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('hr.tk-ep-divider')).not.toBeNull();
    expect(publicSurface.container.querySelector('hr.tk-ep-divider')).not.toBeNull();
  });

  it('rich_text: both surfaces render the .tk-ep-rich-text class', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-rich-text')).not.toBeNull();
    expect(publicSurface.container.querySelector('.tk-ep-rich-text')).not.toBeNull();
  });
});

/**
 * Parity assertions for previously-known gaps between the canvas and the
 * public page. Each test was originally a GAP tripwire in Phase 0; the
 * gaps have been fixed in Phase 2 and these now assert full structural
 * parity between the editor surface and the public surface.
 */
describe('Phase 2: fixed parity gaps (canvas now matches public)', () => {
  it('hero CTA is an anchor in both canvas and public page', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorCta = editor.container.querySelector('.tk-ep-hero .tk-ep-button');
    const publicCta = publicSurface.container.querySelector('.tk-ep-hero .tk-ep-button');
    expect(editorCta?.tagName).toBe('A');
    expect(publicCta?.tagName).toBe('A');
  });

  it('tickets CTA is an anchor in both canvas and public page', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorCta = editor.container.querySelector('.tk-ep-tickets .tk-ep-button');
    const publicCta = publicSurface.container.querySelector('.tk-ep-tickets .tk-ep-button');
    expect(editorCta?.tagName).toBe('A');
    expect(publicCta?.tagName).toBe('A');
  });

  it('button block uses anchor in both canvas and public page', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorBtn = editor.container.querySelector('.tk-ep-action .tk-ep-button');
    const publicBtn = publicSurface.container.querySelector('.tk-ep-action .tk-ep-button');
    expect(editorBtn?.tagName).toBe('A');
    expect(publicBtn?.tagName).toBe('A');
  });

  it('event_header canvas renders the date/venue metadata dl matching public', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-header__meta')).not.toBeNull();
    expect(publicSurface.container.querySelector('.tk-ep-header__meta')).not.toBeNull();
  });

  it('event_header canvas respects showBadge=false matching public', () => {
    const doc = comprehensiveDocument();
    const header = doc.blocks.find((b) => b.type === 'event_header');
    if (header && header.type === 'event_header') {
      header.showBadge = false;
    }
    const { editor, publicSurface } = renderBoth(doc);
    expect(publicSurface.container.querySelector('.tk-ep-header .tk-ep-badge')).toBeNull();
    expect(editor.container.querySelector('.tk-ep-header .tk-ep-badge')).toBeNull();
  });

  it('resale_tickets canvas renders the verified badge matching public', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    expect(editor.container.querySelector('.tk-ep-badge--verified')).not.toBeNull();
    expect(publicSurface.container.querySelector('.tk-ep-badge--verified')).not.toBeNull();
  });

  it('resale_tickets canvas CTA is wrapped in anchor matching public', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const publicCta = publicSurface.container.querySelector('.tk-ep-resale .tk-ep-button');
    expect(publicCta?.tagName).toBe('A');
    const editorCta = editor.container.querySelector('.tk-ep-resale .tk-ep-button');
    expect(editorCta?.tagName).toBe('A');
  });

  it('brand_footer canvas respects show* toggles matching public', () => {
    const doc = comprehensiveDocument();
    const footer = doc.blocks.find((b) => b.type === 'brand_footer');
    if (footer && footer.type === 'brand_footer') {
      footer.showSupport = false;
    }
    const { editor, publicSurface } = renderBoth(doc);
    const publicLinks = Array.from(publicSurface.container.querySelectorAll('.tk-ep-footer a')).map((el) => el.textContent);
    expect(publicLinks).not.toContain('Support');
    const editorLinks = Array.from(editor.container.querySelectorAll('.tk-ep-footer a')).map((el) => el.textContent);
    expect(editorLinks).not.toContain('Support');
  });

  it('GAP: custom_embed canvas shows raw HTML text, public renders sanitized HTML', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const editorEmbed = editor.container.querySelector('.tk-ep-embed');
    const publicEmbed = publicSurface.container.querySelector('.tk-ep-embed');
    // The editor renders the raw HTML as editable text content
    expect(editorEmbed?.textContent).toContain('iframe');
    // The public surface renders the sanitized HTML (iframe element)
    expect(publicEmbed?.querySelector('iframe')).not.toBeNull();
  });

  it('block wrapper element matches: both canvas and public use section', () => {
    const { editor, publicSurface } = renderBoth(comprehensiveDocument());
    const publicHero = publicSurface.container.querySelector('.tk-ep-hero');
    expect(publicHero?.tagName).toBe('SECTION');
    const editorHero = editor.container.querySelector('.tk-ep-hero');
    expect(editorHero?.tagName).toBe('SECTION');
  });
});

/**
 * Maps a block type to its .tk-ep-* CSS class name.
 * This is the shared DOM contract between canvas and public surface.
 */
function blockClass(type: string): string {
  const map: Record<string, string> = {
    hero: 'tk-ep-hero',
    rich_text: 'tk-ep-rich-text',
    event_details: 'tk-ep-details',
    tickets: 'tk-ep-tickets',
    products: 'tk-ep-products',
    schedule: 'tk-ep-schedule',
    venue_map: 'tk-ep-venue',
    faq: 'tk-ep-faq',
    sponsors: 'tk-ep-sponsors',
    speakers: 'tk-ep-speakers',
    button: 'tk-ep-action',
    divider: 'tk-ep-divider',
    social_links: 'tk-ep-social',
    custom_embed: 'tk-ep-embed',
    event_header: 'tk-ep-header',
    resale_tickets: 'tk-ep-resale',
    brand_footer: 'tk-ep-footer',
  };
  return map[type] ?? `tk-ep-${type}`;
}
