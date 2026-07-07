import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  blocksToEditorDocument,
  type EventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageSurface, type SurfaceEditing } from '../index.js';
import { normalizeBlocksByHtml } from './helpers/normalize-dom.js';

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
    {
      id: 'tt_ga',
      name: 'General Admission',
      description: 'Standing room',
      status: 'active',
      priceLabel: '$35.00',
    },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden', priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
  resaleListings: [
    {
      id: 'resale_1',
      ticketTypeName: 'General Admission',
      priceLabel: '$40.00',
      expiresAt: '2026-07-15T00:00:00.000Z',
    },
  ],
};

/**
 * Comprehensive document covering all 17 block types with merge-tag-free
 * editable text fields (so raw === resolved for every directly-editable node,
 * which is the parity-by-construction invariant the harness guards).
 */
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
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Extra copy' }] }],
      },
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
      items: [
        {
          name: 'Acme Corp',
          url: 'https://acme.test',
          imageUrl: 'https://cdn.test/acme.png',
          imageAlt: 'Acme logo',
        },
      ],
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
  doc.editor.document = blocksToEditorDocument(doc.blocks);
  return doc;
}

/**
 * Renders the comprehensive document in both public and edit modes and returns
 * per-block normalized outerHTML for structural comparison. Edit mode threads a
 * SurfaceEditing context bound to the raw working document; the resolved page
 * is shared so derived content (tickets, products, resale) is identical.
 */
function renderBoth(doc: EventPageDocument) {
  const resolved = resolveEventPageDocument(doc, context, {
    allowUnsafeEmbeds: true,
    mode: 'edit',
  });
  const editing: SurfaceEditing = {
    document: doc,
    disabled: false,
    onChangeBlock: vi.fn(),
  };
  const publicSurface = render(<EventPageSurface resolvedPage={resolved} mode="public" />);
  const editSurface = render(
    <EventPageSurface resolvedPage={resolved} mode="edit" editing={editing} />,
  );
  return {
    resolved,
    publicBlocks: normalizeBlocksByHtml(
      publicSurface.container.querySelector('.tixkit-event-page') as HTMLElement,
    ),
    editBlocks: normalizeBlocksByHtml(
      editSurface.container.querySelector('.tixkit-event-page') as HTMLElement,
    ),
    publicContainer: publicSurface.container,
    editContainer: editSurface.container,
  };
}

describe('edit/public DOM parity (single renderer)', () => {
  it('renders all 17 blocks with data-block-id in both modes', () => {
    const doc = comprehensiveDocument();
    const { publicBlocks, editBlocks } = renderBoth(doc);
    for (const block of doc.blocks) {
      expect(publicBlocks.has(block.id), `public missing ${block.id}`).toBe(true);
      expect(editBlocks.has(block.id), `edit missing ${block.id}`).toBe(true);
    }
  });

  // Per-block parity assertions. The single renderer uses SurfaceText in both
  // modes, so edit DOM (after stripping edit-only attributes) must equal public
  // DOM for every block type.
  it('hero: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('hero')).toBe(publicBlocks.get('hero'));
  });

  it('tickets: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('tickets')).toBe(publicBlocks.get('tickets'));
  });

  it('event_details: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('details')).toBe(publicBlocks.get('details'));
  });

  it('schedule: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('schedule')).toBe(publicBlocks.get('schedule'));
  });

  it('venue_map: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('venue')).toBe(publicBlocks.get('venue'));
  });

  it('faq: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('faq')).toBe(publicBlocks.get('faq'));
  });

  it('products: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('products-1')).toBe(publicBlocks.get('products-1'));
  });

  it('sponsors: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('sponsors-1')).toBe(publicBlocks.get('sponsors-1'));
  });

  it('speakers: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('speakers-1')).toBe(publicBlocks.get('speakers-1'));
  });

  it('button: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('btn-1')).toBe(publicBlocks.get('btn-1'));
  });

  it('divider: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('div-1')).toBe(publicBlocks.get('div-1'));
  });

  it('social_links: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('social-1')).toBe(publicBlocks.get('social-1'));
  });

  it('rich_text: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('rich-1')).toBe(publicBlocks.get('rich-1'));
  });

  it('custom_embed: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('embed-1')).toBe(publicBlocks.get('embed-1'));
  });

  it('event_header: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('header')).toBe(publicBlocks.get('header'));
  });

  it('resale_tickets: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('resale')).toBe(publicBlocks.get('resale'));
  });

  it('brand_footer: edit DOM matches public DOM', () => {
    const { publicBlocks, editBlocks } = renderBoth(comprehensiveDocument());
    expect(editBlocks.get('footer')).toBe(publicBlocks.get('footer'));
  });
});
