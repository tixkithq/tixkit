import { describe, expect, it } from 'vitest';
import {
  EVENT_PAGE_BLOCK_NODE,
  EVENT_PAGE_FONT_FAMILY_OPTIONS,
  EVENT_PAGE_INLINE_STYLE_MARK,
  EVENT_PAGE_SCHEMA_VERSION,
  EventPageInlineStyle,
  EventPageTextAlignment,
  TIPTAP_EVENT_PAGE_PROVIDER,
  blocksToEditorDocument,
  collectUsedFontFamilies,
  createDefaultEventPageDocument,
  editorDocumentToBlocks,
  googleFontLinkTags,
  isAllowedEventPageFontFamily,
  isUnifiedEditorDocument,
  validateEventPageDocument,
  type EventPageDocument,
} from '../index.js';

/**
 * Phase 0: Pin the TipTap node/mark surface that the editor and renderer
 * depend on. These tests serve as a tripwire: if the TipTap schema changes
 * (new nodes, removed marks, changed attributes), these tests break and force
 * a conscious update of the editor surface and parity tests.
 */

describe('Phase 0: TipTap node surface pin', () => {
  it('allows the supported node types in editor.document', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    // The unified editor.document has eventPageBlock nodes (one per block)
    expect(doc.editor.document.type).toBe('doc');
    const content = doc.editor.document.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content![0].type).toBe(EVENT_PAGE_BLOCK_NODE);
  });

  it('validates a document with all allowed node types in rich_text', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-all-nodes',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading 1' }] },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading 2' }] },
          { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Heading 3' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Paragraph text' }] },
          { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bullet' }] }] }] },
          { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ordered' }] }] }] },
          { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] },
          { type: 'image', attrs: { src: 'https://cdn.test/img.png', alt: 'Alt text' } },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('rejects unsupported node types', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-node',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'video', attrs: { src: 'https://test/v.mp4' } }],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_tiptap_node')).toBe(true);
  });

  it('rejects heading levels outside 1-3', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-heading',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'H4' }] }],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_heading_level')).toBe(true);
  });
});

describe('Phase 0: TipTap mark surface pin', () => {
  it('validates a document with all allowed mark types', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-all-marks',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
              { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
              { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
              { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] },
              { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('rejects unsupported mark types', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-mark',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'underlined', marks: [{ type: 'underline' }] }],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_tiptap_mark')).toBe(true);
  });
});

describe('Phase 0: inline style mark surface pin', () => {
  it('pins the mark name constant', () => {
    expect(EVENT_PAGE_INLINE_STYLE_MARK).toBe('eventPageInlineStyle');
  });

  it('EventPageInlineStyle mark is defined', () => {
    expect(EventPageInlineStyle).toBeDefined();
    expect(EventPageInlineStyle.name).toBe('eventPageInlineStyle');
  });

  it('validates a document with approved inline style attributes', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-inline-style',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Styled text',
                marks: [
                  {
                    type: 'eventPageInlineStyle',
                    attrs: {
                      fontFamily: 'Inter, Arial, sans-serif',
                      color: '#ff0000',
                      fontSize: '16px',
                      lineHeight: '150%',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('rejects unapproved font families', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-font',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Bad font',
                marks: [{ type: 'eventPageInlineStyle', attrs: { fontFamily: 'Comic Sans MS' } }],
              },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_font_family')).toBe(true);
  });

  it('rejects unapproved text colors', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-color',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Bad color',
                marks: [{ type: 'eventPageInlineStyle', attrs: { color: 'red' } }],
              },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_text_color')).toBe(true);
  });

  it('rejects font sizes outside 8-96px', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-size',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Bad size',
                marks: [{ type: 'eventPageInlineStyle', attrs: { fontSize: '200px' } }],
              },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_font_size')).toBe(true);
  });

  it('rejects line heights outside 80-240%', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-line-height',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Bad lh',
                marks: [{ type: 'eventPageInlineStyle', attrs: { lineHeight: '50%' } }],
              },
            ],
          },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_line_height')).toBe(true);
  });
});

describe('Phase 0: font family options pin', () => {
  it('pins the exact font family allowlist', () => {
    expect(EVENT_PAGE_FONT_FAMILY_OPTIONS).toEqual([
      { label: 'Brand default', value: '' },
      { label: 'Inter', value: 'Inter, Arial, sans-serif' },
      { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
      { label: 'Georgia', value: 'Georgia, serif' },
      { label: 'Times', value: 'Times New Roman, Times, serif' },
      { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
      { label: 'Mono', value: 'Courier New, Courier, monospace' },
    ]);
  });

  it('isAllowedEventPageFontFamily accepts allowlist entries and rejects others', () => {
    expect(isAllowedEventPageFontFamily('Inter, Arial, sans-serif')).toBe(true);
    expect(isAllowedEventPageFontFamily('Georgia, serif')).toBe(true);
    // Empty string is NOT in the allowlist (filter(Boolean) removes it);
    // "Brand default" is represented by null in the mark, not ''
    expect(isAllowedEventPageFontFamily('')).toBe(false);
    expect(isAllowedEventPageFontFamily('Comic Sans MS')).toBe(false);
    expect(isAllowedEventPageFontFamily('  ')).toBe(false);
  });
});

describe('Phase 0: text alignment extension pin', () => {
  it('EventPageTextAlignment extension is defined', () => {
    expect(EventPageTextAlignment).toBeDefined();
    expect(EventPageTextAlignment.name).toBe('eventPageTextAlignment');
  });

  it('validates a document with approved text alignment on headings and paragraphs', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-alignment',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Centered' }] },
          { type: 'paragraph', attrs: { textAlign: 'right' }, content: [{ type: 'text', text: 'Right' }] },
          { type: 'paragraph', attrs: { textAlign: 'left' }, content: [{ type: 'text', text: 'Left' }] },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('rejects unsupported text alignment values', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-bad-align',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { textAlign: 'justify' }, content: [{ type: 'text', text: 'Justify' }] },
        ],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsupported_text_alignment')).toBe(true);
  });
});

describe('Phase 0: image node surface pin', () => {
  it('validates images with safe http(s) URLs and alt text', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-image-ok',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'https://cdn.test/img.png', alt: 'Alt' } }],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('rejects images with unsafe URLs', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-image-bad-url',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'Alt' } }],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'unsafe_image')).toBe(true);
  });

  it('rejects images with missing alt text', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      checkoutUrl: 'https://checkout.test/c',
    });
    doc.blocks.push({
      id: 'rich-image-no-alt',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'https://cdn.test/img.png' } }],
      },
    });
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'missing_image_alt')).toBe(true);
  });
});

describe('Phase 0: provider and schema constants pin', () => {
  it('pins the provider constant', () => {
    expect(TIPTAP_EVENT_PAGE_PROVIDER).toBe('@tiptap/core');
  });

  it('pins the schema version constant', () => {
    expect(EVENT_PAGE_SCHEMA_VERSION).toBe(1);
  });

  it('a valid document has the pinned provider and schema version', () => {
    const doc: EventPageDocument = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test',
      eventDescription: 'Desc.',
      checkoutUrl: 'https://checkout.test/c',
    });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.editor.provider).toBe('@tiptap/core');
  });
});

describe('Phase 1: eventPageBlock node surface pin', () => {
  it('pins the eventPageBlock node name constant', () => {
    expect(EVENT_PAGE_BLOCK_NODE).toBe('eventPageBlock');
  });

  it('validateEventPageDocument accepts eventPageBlock nodes in editor.document', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test',
      eventDescription: 'Desc.',
      checkoutUrl: 'https://checkout.test/c',
    });
    expect(isUnifiedEditorDocument(doc.editor.document)).toBe(true);
    const result = validateEventPageDocument(doc);
    expect(result.valid).toBe(true);
  });

  it('blocksToEditorDocument and editorDocumentToBlocks round-trip all block types', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'Test',
      eventDescription: 'Desc.',
      checkoutUrl: 'https://checkout.test/c',
    });
    const editorDoc = blocksToEditorDocument(doc.blocks);
    expect(isUnifiedEditorDocument(editorDoc)).toBe(true);
    const extracted = editorDocumentToBlocks(editorDoc);
    expect(extracted).toBeDefined();
    expect(extracted!.length).toBe(doc.blocks.length);
    expect(extracted!.map((b) => b.type)).toEqual(doc.blocks.map((b) => b.type));
  });
});

describe('Per-document Google Font loading', () => {
  it('collectUsedFontFamilies returns empty for default document (no inline style marks)', () => {
    const doc = createDefaultEventPageDocument({ eventId: 'e1', eventTitle: 'T' });
    expect(collectUsedFontFamilies(doc)).toEqual([]);
  });

  it('collectUsedFontFamilies extracts font families from rich_text inline style marks', () => {
    const doc = createDefaultEventPageDocument({ eventId: 'e1', eventTitle: 'T' });
    doc.blocks.push({
      id: 'rt-test',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Styled text',
                marks: [
                  {
                    type: EVENT_PAGE_INLINE_STYLE_MARK,
                    attrs: { fontFamily: 'Inter, Arial, sans-serif' },
                  },
                ],
              },
              {
                type: 'text',
                text: ' more text',
                marks: [
                  {
                    type: EVENT_PAGE_INLINE_STYLE_MARK,
                    attrs: { fontFamily: 'Georgia, serif' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const families = collectUsedFontFamilies(doc);
    expect(families).toContain('Inter, Arial, sans-serif');
    expect(families).toContain('Georgia, serif');
    expect(families).toHaveLength(2);
  });

  it('collectUsedFontFamilies deduplicates repeated font families', () => {
    const doc = createDefaultEventPageDocument({ eventId: 'e1', eventTitle: 'T' });
    doc.blocks = [
      { type: 'rich_text', id: 'rt1', content: {
        type: 'doc', content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'A', marks: [{ type: EVENT_PAGE_INLINE_STYLE_MARK, attrs: { fontFamily: 'Inter, Arial, sans-serif' } }] },
          ] },
        ] } },
      { type: 'rich_text', id: 'rt2', content: {
        type: 'doc', content: [
          { type: 'paragraph', content: [
            { type: 'text', text: 'B', marks: [{ type: EVENT_PAGE_INLINE_STYLE_MARK, attrs: { fontFamily: 'Inter, Arial, sans-serif' } }] },
          ] },
        ] } },
    ];
    const families = collectUsedFontFamilies(doc);
    expect(families).toEqual(['Inter, Arial, sans-serif']);
  });

  it('googleFontLinkTags returns empty string for system-only fonts', () => {
    const links = googleFontLinkTags(['Georgia, serif', 'Arial, Helvetica, sans-serif']);
    expect(links).toBe('');
  });

  it('googleFontLinkTags returns link tags for Inter', () => {
    const links = googleFontLinkTags(['Inter, Arial, sans-serif']);
    expect(links).toContain('fonts.googleapis.com');
    expect(links).toContain('family=Inter');
    expect(links).toContain('preconnect');
  });

  it('googleFontLinkTags returns empty for empty input', () => {
    expect(googleFontLinkTags([])).toBe('');
  });

  it('googleFontLinkTags includes only Google fonts when mixed with system fonts', () => {
    const links = googleFontLinkTags(['Inter, Arial, sans-serif', 'Georgia, serif', 'Verdana, Geneva, sans-serif']);
    expect(links).toContain('family=Inter');
    expect(links).not.toContain('Georgia');
    expect(links).not.toContain('Verdana');
  });
});
