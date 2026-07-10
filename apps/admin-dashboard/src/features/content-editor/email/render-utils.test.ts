import { describe, expect, it } from 'vitest';
import { createDefaultEmailTemplateForKey, validateEmailTemplate } from '@tixkit/content-email';
import {
  applyMergeTagPreviewsToEditorContent,
  mergeTagCanvasAttributeValue,
  mergeTagKeyFromCanvasAttributeValue,
} from '../email-editor-extensions';
import { makeLegacyBrandLogoEditable, withEditorExport } from './render-utils';

describe('email merge-tag canvas attribute previews', () => {
  it('removes only the legacy logo constraints that blocked size and alignment editing', () => {
    const legacy =
      '<img src="{{brand.logoUrl}}" alt="Brand logo" width="160" style="display: block; height: auto; margin: 0 auto; max-width: 160px; width: 100%;" />';
    const migrated = makeLegacyBrandLogoEditable(legacy);

    expect(migrated).toContain('width="160"');
    expect(migrated).toContain('style="display: inline-block; height: auto;"');
    expect(migrated).not.toContain('max-width');
    expect(migrated).not.toContain('width: 100%');
    expect(
      makeLegacyBrandLogoEditable(
        '<img src="https://example.test/custom.png" style="width: 100%" />',
      ),
    ).toContain('width: 100%');
  });

  it('uses http(s) destinations for URL merge tags used in href/src', () => {
    expect(mergeTagCanvasAttributeValue('brand.supportUrl')).toMatch(/^https:\/\//);
    expect(mergeTagCanvasAttributeValue('event.publicUrl')).toMatch(/^https:\/\//);
    expect(mergeTagCanvasAttributeValue('order.manageUrl')).toMatch(/^https:\/\//);
    expect(mergeTagCanvasAttributeValue('ticket.qrCodeUrl')).toMatch(/^data:image\//);
  });

  it('maps legacy non-URL previews back to merge tags', () => {
    expect(mergeTagKeyFromCanvasAttributeValue('help center')).toBe('brand.supportUrl');
    expect(mergeTagKeyFromCanvasAttributeValue('ticket checkout')).toBe('event.checkoutUrl');
    expect(
      mergeTagKeyFromCanvasAttributeValue(mergeTagCanvasAttributeValue('brand.supportUrl')),
    ).toBe('brand.supportUrl');
  });
});

describe('withEditorExport layout preservation', () => {
  it('keeps React Email layout HTML instead of flattening to plain paragraphs', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const layoutHtml = document.editor.contentHtml;
    expect(layoutHtml).toMatch(/background-color:\s*#f6f6f6/i);

    const exported = withEditorExport(document, {
      // Simulate React Email getEmail() returning styled layout while JSON only has text.
      html: layoutHtml.replaceAll('{{brand.supportUrl}}', 'help center'),
      text: 'Order cancelled',
      json: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Order cancelled',
                marks: [
                  {
                    type: 'tixkitMergeTag',
                    attrs: { key: 'event.title' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(exported.editor.contentHtml).toMatch(/background-color:\s*#f6f6f6/i);
    expect(exported.editor.contentHtml).toContain('href="{{brand.supportUrl}}"');
    expect(exported.editor.contentHtml).not.toBe('<p>{{event.title}}</p>');
  });

  it('falls back to previous studio shell when export is blank/shell-only', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const exported = withEditorExport(document, {
      html: '<!DOCTYPE html><html><body><p><br /></p></body></html>',
      text: '',
      json: { type: 'doc', content: [] },
    });
    expect(exported.editor.contentHtml).toMatch(/background-color:\s*#f6f6f6/i);
  });

  it('preserves intentionally empty structural layouts', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const layoutHtml =
      '<table><tbody><tr><td align="right" data-id="__react-email-column"><p><br /></p></td></tr></tbody></table>';
    const exported = withEditorExport(document, {
      html: layoutHtml,
      text: '',
      json: {
        type: 'doc',
        content: [
          {
            type: 'twoColumns',
            content: [
              {
                type: 'columnsColumn',
                attrs: { align: 'right' },
                content: [{ type: 'paragraph' }],
              },
            ],
          },
        ],
      },
    });

    expect(exported.editor.contentHtml).toContain(
      '<td align="right" data-id="__react-email-column">',
    );
    expect(exported.editor.contentHtml).not.toBe(document.editor.contentHtml);
  });
});

describe('withEditorExport merge-tag canonicalize', () => {
  it('restores canvas preview hrefs so order-cancelled validates after export', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const previewedHtml = String(applyMergeTagPreviewsToEditorContent(document.editor.contentHtml));

    expect(previewedHtml).toContain(mergeTagCanvasAttributeValue('brand.supportUrl'));
    expect(previewedHtml).toContain('data-tixkit-merge-attr-href="brand.supportUrl"');

    // Simulate React Email export dropping data-* merge attrs but keeping preview href.
    const strippedPreviewHtml = previewedHtml
      .replace(/\sdata-tixkit-merge-attr-href="[^"]*"/gi, '')
      .replace(/\sdata-tixkit-merge-attr-src="[^"]*"/gi, '');

    const exported = withEditorExport(document, {
      html: strippedPreviewHtml,
      text: document.editor.contentText ?? '',
      json: { type: 'doc', content: [] },
    });

    expect(exported.editor.contentHtml).toContain('href="{{brand.supportUrl}}"');
    expect(exported.editor.contentHtml).not.toContain('href="help center"');
    expect(exported.editor.contentHtml).not.toContain(
      `href="${mergeTagCanvasAttributeValue('brand.supportUrl')}"`,
    );

    const validation = validateEmailTemplate(exported, { provider: 'resend' });
    expect(validation.issues.filter((issue) => issue.code === 'unsafe_link')).toEqual([]);
  });

  it('restores legacy help-center hrefs from already-saved drafts', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const legacyHtml = document.editor.contentHtml.replaceAll(
      'href="{{brand.supportUrl}}"',
      'href="help center"',
    );

    const exported = withEditorExport(document, {
      html: legacyHtml,
      text: document.editor.contentText ?? '',
      json: { type: 'doc', content: [] },
    });

    expect(exported.editor.contentHtml).toContain('href="{{brand.supportUrl}}"');
    const validation = validateEmailTemplate(exported, { provider: 'resend' });
    expect(validation.issues.filter((issue) => issue.code === 'unsafe_link')).toEqual([]);
  });

  it('restores link mark preview hrefs emitted from TipTap JSON export', () => {
    const document = createDefaultEmailTemplateForKey('order-cancelled');
    const exported = withEditorExport(document, {
      html: '<p>fallback without merge tags</p>',
      text: 'Manage order',
      json: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'Manage order',
                marks: [
                  {
                    type: 'link',
                    attrs: {
                      href: 'help center',
                    },
                  },
                  {
                    type: 'tixkitMergeTag',
                    attrs: {
                      key: 'brand.supportUrl',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(exported.editor.contentHtml).toContain('href="{{brand.supportUrl}}"');
    const validation = validateEmailTemplate(exported, { provider: 'resend' });
    expect(validation.issues.filter((issue) => issue.code === 'unsafe_link')).toEqual([]);
  });
});
