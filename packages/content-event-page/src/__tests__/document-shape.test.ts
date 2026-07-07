import { describe, expect, it } from 'vitest';
import {
  EVENT_PAGE_BLOCK_NODE,
  EVENT_PAGE_SCHEMA_VERSION,
  TIPTAP_EVENT_PAGE_PROVIDER,
  blocksToEditorDocument,
  createDefaultEventPageDocument,
  editorDocumentToBlocks,
  isUnifiedEditorDocument,
  normalizeEventPageDocument,
  renderEventPageDocument,
  resolveEventPageDocument,
  validateEventPageDocument,
  type EventPageDocument,
  type EventPageRenderContext,
} from '../index.js';

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

const defaultInput = {
  eventId: 'evt_demo_001',
  eventTitle: 'All Access Chicago',
  eventDescription: 'A full night of music and access.',
  startsAt: '2026-07-17T19:00:00.000Z' as const,
  timezone: 'America/Chicago',
  venue: { name: 'The Salt Shed', city: 'Chicago' },
  brandName: 'Tixkit',
  publicUrl: 'https://events.example.test/e/all-access-chicago',
  checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
};

/**
 * A comprehensive document with all 17 block types. The default factory
 * produces 9 blocks; we append the remaining 8 so the snapshot and round-trip
 * tests cover the full block surface.
 */
function comprehensiveDocument(): EventPageDocument {
  const doc = createDefaultEventPageDocument(defaultInput);
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
  // Rebuild editor.document to include all blocks (unified schema)
  doc.editor.document = blocksToEditorDocument(doc.blocks);
  return doc;
}

describe('Phase 0: dual-store document shape snapshot', () => {
  it('createDefaultEventPageDocument produces the expected block type order', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    const blockTypes = doc.blocks.map((b) => b.type);
    expect(blockTypes).toEqual([
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
  });

  it('createDefaultEventPageDocument populates the dual store (editor.document + blocks[])', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    // Dual store: top-level TipTap document exists alongside typed blocks
    expect(doc.editor.provider).toBe(TIPTAP_EVENT_PAGE_PROVIDER);
    expect(doc.editor.document).toBeDefined();
    expect(doc.editor.document.type).toBe('doc');
    expect(Array.isArray(doc.editor.document.content)).toBe(true);
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it('comprehensiveDocument covers all 17 block types', () => {
    const doc = comprehensiveDocument();
    const blockTypes = new Set(doc.blocks.map((b) => b.type));
    expect(blockTypes.size).toBe(17);
    expect(blockTypes).toEqual(
      new Set([
        'event_header',
        'hero',
        'event_details',
        'tickets',
        'schedule',
        'venue_map',
        'faq',
        'resale_tickets',
        'brand_footer',
        'rich_text',
        'products',
        'sponsors',
        'speakers',
        'button',
        'divider',
        'social_links',
        'custom_embed',
      ]),
    );
  });

  it('every block has a non-empty id', () => {
    const doc = comprehensiveDocument();
    for (const block of doc.blocks) {
      expect(block.id.length).toBeGreaterThan(0);
    }
  });

  it('schemaVersion and editor.provider are pinned', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    expect(doc.schemaVersion).toBe(EVENT_PAGE_SCHEMA_VERSION);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.editor.provider).toBe('@tiptap/core');
  });
});

describe('Phase 0: round-trip stability', () => {
  it('normalize returns the same reference when chrome blocks are present', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    const normalized = normalizeEventPageDocument(doc);
    expect(normalized).toBe(doc);
  });

  it('normalize accepts the comprehensive document', () => {
    const doc = comprehensiveDocument();
    const normalized = normalizeEventPageDocument(doc);
    expect(normalized).toBeDefined();
    expect(normalized!.blocks.length).toBe(doc.blocks.length);
  });

  it('normalize rejects non-canonical objects', () => {
    expect(normalizeEventPageDocument(null)).toBeUndefined();
    expect(normalizeEventPageDocument({})).toBeUndefined();
    expect(
      normalizeEventPageDocument({
        schemaVersion: 2,
        editor: { provider: '@tiptap/core', document: {} },
        settings: { locale: 'en', ticketCtaLabel: 'x', discovery: { summary: '', tags: [] } },
        blocks: [],
      }),
    ).toBeUndefined();
    expect(
      normalizeEventPageDocument({
        schemaVersion: 1,
        editor: { provider: 'other', document: {} },
        settings: { locale: 'en', ticketCtaLabel: 'x', discovery: { summary: '', tags: [] } },
        blocks: [],
      }),
    ).toBeUndefined();
  });

  it('validateEventPageDocument passes for the default document', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('validateEventPageDocument passes for the comprehensive document with allowUnsafeEmbeds', () => {
    const doc = comprehensiveDocument();
    const result = validateEventPageDocument(doc, { allowUnsafeEmbeds: true });
    expect(result.valid).toBe(true);
  });

  it('renderEventPageDocument produces stable output across multiple calls', () => {
    const doc = comprehensiveDocument();
    const rendered1 = renderEventPageDocument(doc, context, { allowUnsafeEmbeds: true });
    const rendered2 = renderEventPageDocument(doc, context, { allowUnsafeEmbeds: true });
    expect(rendered2.html).toBe(rendered1.html);
    expect(rendered2.text).toBe(rendered1.text);
    expect(rendered2.headless).toEqual(rendered1.headless);
    expect(rendered2.discovery).toEqual(rendered1.discovery);
  });

  it('resolveEventPageDocument produces a serializable resolved model', () => {
    const doc = comprehensiveDocument();
    const resolved = resolveEventPageDocument(doc, context, { allowUnsafeEmbeds: true });
    expect(resolved.validation.valid).toBe(true);
    expect(resolved.blocks.length).toBe(17);
    // JSON round-trip
    const json = JSON.stringify(resolved);
    const parsed = JSON.parse(json);
    expect(parsed.blocks.length).toBe(17);
  });

  it('full round-trip: create -> normalize -> validate -> render -> resolve -> normalize is stable', () => {
    const doc = comprehensiveDocument();
    const normalized1 = normalizeEventPageDocument(doc);
    expect(normalized1).toBeDefined();
    const validation = validateEventPageDocument(normalized1!, { allowUnsafeEmbeds: true });
    expect(validation.valid).toBe(true);
    const rendered = renderEventPageDocument(normalized1!, context, { allowUnsafeEmbeds: true });
    expect(rendered.validation.valid).toBe(true);
    const resolved = resolveEventPageDocument(normalized1!, context, { allowUnsafeEmbeds: true });
    expect(resolved.validation.valid).toBe(true);
    // Re-normalizing the original document after render/resolve should still be stable
    const normalized2 = normalizeEventPageDocument(normalized1!);
    expect(normalized2).toBe(normalized1);
  });

  it('normalize migrates older documents by appending chrome blocks', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    // Remove chrome blocks to simulate an older document
    const olderBlocks = doc.blocks.filter(
      (b) => b.type !== 'event_header' && b.type !== 'resale_tickets' && b.type !== 'brand_footer',
    );
    const olderDoc: EventPageDocument = { ...doc, blocks: olderBlocks };
    const normalized = normalizeEventPageDocument(olderDoc);
    expect(normalized).toBeDefined();
    const types = normalized!.blocks.map((b) => b.type);
    expect(types[0]).toBe('event_header');
    expect(types[types.length - 2]).toBe('resale_tickets');
    expect(types[types.length - 1]).toBe('brand_footer');
  });
});

describe('Phase 0: settings and discovery shape', () => {
  it('settings contains locale, ticketCtaLabel, publicPath, and discovery', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    expect(doc.settings.locale).toBe('en');
    expect(doc.settings.ticketCtaLabel).toBe('Get tickets');
    expect(doc.settings.publicPath).toBe('https://events.example.test/e/all-access-chicago');
    expect(doc.settings.discovery).toBeDefined();
    expect(Array.isArray(doc.settings.discovery.tags)).toBe(true);
  });

  it('discovery metadata is populated from event input', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    expect(doc.settings.discovery.summary).toBe('A full night of music and access.');
    expect(doc.settings.discovery.seoTitle).toBe('All Access Chicago');
    expect(doc.settings.discovery.seoDescription).toBe('A full night of music and access.');
  });
});

describe('Phase 1: unified editor.document (blocks <-> node tree)', () => {
  it('createDefaultEventPageDocument produces a unified editor.document', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    expect(isUnifiedEditorDocument(doc.editor.document)).toBe(true);
  });

  it('editor.document contains eventPageBlock nodes matching blocks[]', () => {
    const doc = comprehensiveDocument();
    const content = doc.editor.document.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content!.length).toBe(doc.blocks.length);
    for (let i = 0; i < content!.length; i++) {
      expect(content![i].type).toBe(EVENT_PAGE_BLOCK_NODE);
      const attrs = content![i].attrs as { block: EventPageDocument['blocks'][number] };
      expect(attrs.block.type).toBe(doc.blocks[i].type);
      expect(attrs.block.id).toBe(doc.blocks[i].id);
    }
  });

  it('blocksToEditorDocument produces a doc with eventPageBlock nodes', () => {
    const blocks = comprehensiveDocument().blocks;
    const editorDoc = blocksToEditorDocument(blocks);
    expect(editorDoc.type).toBe('doc');
    expect(Array.isArray(editorDoc.content)).toBe(true);
    expect(editorDoc.content!.every((n) => n.type === EVENT_PAGE_BLOCK_NODE)).toBe(true);
    expect(editorDoc.content!.length).toBe(blocks.length);
  });

  it('editorDocumentToBlocks extracts blocks from eventPageBlock nodes', () => {
    const doc = comprehensiveDocument();
    const extracted = editorDocumentToBlocks(doc.editor.document);
    expect(extracted).toBeDefined();
    expect(extracted!.length).toBe(doc.blocks.length);
    for (let i = 0; i < extracted!.length; i++) {
      expect(extracted![i].type).toBe(doc.blocks[i].type);
      expect(extracted![i].id).toBe(doc.blocks[i].id);
    }
  });

  it('editorDocumentToBlocks returns undefined for old-format documents', () => {
    const oldDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Summary' }] }],
    };
    expect(editorDocumentToBlocks(oldDoc)).toBeUndefined();
  });

  it('isUnifiedEditorDocument detects unified vs old format', () => {
    const unified = blocksToEditorDocument(comprehensiveDocument().blocks);
    expect(isUnifiedEditorDocument(unified)).toBe(true);
    const old = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(isUnifiedEditorDocument(old)).toBe(false);
    expect(isUnifiedEditorDocument({ type: 'doc' } as never)).toBe(false);
  });

  it('round-trip: blocks -> editorDocument -> blocks is stable', () => {
    const blocks = comprehensiveDocument().blocks;
    const editorDoc = blocksToEditorDocument(blocks);
    const extracted = editorDocumentToBlocks(editorDoc);
    expect(extracted).toBeDefined();
    expect(extracted!).toEqual(blocks);
  });

  it('round-trip: editorDocument -> blocks -> editorDocument is stable', () => {
    const doc = comprehensiveDocument();
    const extracted = editorDocumentToBlocks(doc.editor.document);
    const rebuilt = blocksToEditorDocument(extracted!);
    expect(rebuilt).toEqual(doc.editor.document);
  });

  it('round-trip preserves all 17 block types', () => {
    const blocks = comprehensiveDocument().blocks;
    const roundTrip = editorDocumentToBlocks(blocksToEditorDocument(blocks))!;
    const originalTypes = blocks.map((b) => b.type);
    const roundTripTypes = roundTrip.map((b) => b.type);
    expect(roundTripTypes).toEqual(originalTypes);
  });

  it('round-trip preserves block field values (hero headline, tickets title, etc.)', () => {
    const blocks = comprehensiveDocument().blocks;
    const roundTrip = editorDocumentToBlocks(blocksToEditorDocument(blocks))!;
    const hero = blocks.find((b) => b.type === 'hero')!;
    const rtHero = roundTrip.find((b) => b.type === 'hero')!;
    expect(rtHero).toEqual(hero);
    const tickets = blocks.find((b) => b.type === 'tickets')!;
    const rtTickets = roundTrip.find((b) => b.type === 'tickets')!;
    expect(rtTickets).toEqual(tickets);
  });
});

describe('Phase 1: normalize migrates old-format documents', () => {
  it('normalize rebuilds editor.document for old-format documents', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    // Simulate an old-format document with a plain paragraph editor.document
    const oldDoc: EventPageDocument = {
      ...doc,
      editor: {
        provider: TIPTAP_EVENT_PAGE_PROVIDER,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old summary' }] }],
        },
      },
    };
    expect(isUnifiedEditorDocument(oldDoc.editor.document)).toBe(false);
    const normalized = normalizeEventPageDocument(oldDoc);
    expect(normalized).toBeDefined();
    expect(isUnifiedEditorDocument(normalized!.editor.document)).toBe(true);
    // The rebuilt editor.document should match blocksToEditorDocument(blocks)
    const expected = blocksToEditorDocument(normalized!.blocks);
    expect(normalized!.editor.document).toEqual(expected);
  });

  it('normalize returns same reference for already-unified documents', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    expect(isUnifiedEditorDocument(doc.editor.document)).toBe(true);
    const normalized = normalizeEventPageDocument(doc);
    expect(normalized).toBe(doc);
  });

  it('normalize migrates old-format document and appends missing chrome blocks', () => {
    const doc = createDefaultEventPageDocument(defaultInput);
    const olderBlocks = doc.blocks.filter(
      (b) => b.type !== 'event_header' && b.type !== 'resale_tickets' && b.type !== 'brand_footer',
    );
    const oldDoc: EventPageDocument = {
      ...doc,
      editor: {
        provider: TIPTAP_EVENT_PAGE_PROVIDER,
        document: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old' }] }],
        },
      },
      blocks: olderBlocks,
    };
    const normalized = normalizeEventPageDocument(oldDoc);
    expect(normalized).toBeDefined();
    expect(isUnifiedEditorDocument(normalized!.editor.document)).toBe(true);
    const types = normalized!.blocks.map((b) => b.type);
    expect(types[0]).toBe('event_header');
    expect(types[types.length - 2]).toBe('resale_tickets');
    expect(types[types.length - 1]).toBe('brand_footer');
  });

  it('validateEventPageDocument accepts unified documents with eventPageBlock nodes', () => {
    const doc = comprehensiveDocument();
    expect(isUnifiedEditorDocument(doc.editor.document)).toBe(true);
    const result = validateEventPageDocument(doc, { allowUnsafeEmbeds: true });
    expect(result.valid).toBe(true);
  });

  it('renderEventPageDocument output is unchanged after unification', () => {
    const doc = comprehensiveDocument();
    const rendered = renderEventPageDocument(doc, context, { allowUnsafeEmbeds: true });
    expect(rendered.validation.valid).toBe(true);
    expect(rendered.html).toContain('tixkit-event-page');
    expect(rendered.html).toContain('tk-ep-hero');
    expect(rendered.headless.length).toBe(17);
  });
});
