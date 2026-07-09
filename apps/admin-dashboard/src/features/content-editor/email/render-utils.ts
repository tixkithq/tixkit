import { type EmailEditorProps } from '@react-email/editor';
import { applyEmailGlobalCssToHtml, type EmailTemplateDocument } from '@tixkit/content-email';
import { MERGE_TAG_REGISTRY } from '@tixkit/domain';
import {
  applyMergeTagPreviewsToEditorContent,
  mergeTagCanvasAttributeValue,
  mergeTagKeyFromCanvasAttributeValue,
  mergeTagLiteral,
  sanitizeEmailFontFamily,
  tixkitInlineStyleMarkName,
  tixkitMergeTagMarkName,
} from '../email-editor-extensions';

export function initialEditorContent(document: EmailTemplateDocument): EmailEditorProps['content'] {
  const contentJson = document.editor.contentJson;
  const contentHtml = document.editor.contentHtml;
  if (
    contentJson &&
    !(isSinglePlainTextParagraphJson(contentJson) && hasStructuredEditorHtml(contentHtml))
  ) {
    return applyMergeTagPreviewsToEditorContent(contentJson as EmailEditorProps['content']);
  }
  return applyMergeTagPreviewsToEditorContent(contentHtml as EmailEditorProps['content']);
}

function isSinglePlainTextParagraphJson(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const doc = value as { content?: unknown; type?: unknown };
  if (doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length !== 1) return false;
  const paragraph = doc.content[0] as { content?: unknown; type?: unknown };
  if (paragraph.type !== 'paragraph') return false;
  if (!Array.isArray(paragraph.content) || paragraph.content.length === 0) return true;
  return paragraph.content.every((child) => {
    if (!child || typeof child !== 'object') return false;
    const node = child as { type?: unknown };
    return node.type === 'text' || node.type === 'hardBreak';
  });
}

function hasStructuredEditorHtml(value: string | null | undefined): boolean {
  const html = value?.trim();
  if (!html) return false;
  const blockMatches =
    html.match(/<(?:h[1-6]|p|ul|ol|li|blockquote|table|section|article|div|hr|img|a)\b/gi) ?? [];
  return (
    blockMatches.length > 1 ||
    /<(?:h[1-6]|ul|ol|blockquote|table|section|article|hr|img)\b/i.test(html)
  );
}

export function withEditorExport(
  document: EmailTemplateDocument,
  exported: { html: string; text: string; json: Record<string, unknown> },
): EmailTemplateDocument {
  const exportedHtml = canonicalizeMergeTagPreviewHtml(exported.html.trim());
  const jsonText = tipTapPlainTextFromJson(exported.json);
  const missingMergeTagLiterals = mergeTagLiteralsFromJson(exported.json).filter(
    (literal) => !exportedHtml.includes(literal),
  );
  // React Email getEmail() returns layout-preserving HTML (often full documents with
  // tables/styles). Never discard that for the incomplete tipTap text serializer when
  // the export already has real email layout. JSON rebuild is a last-resort fallback.
  const exportHasLayout = hasEmailLayoutHtml(exportedHtml);
  const shouldRebuildFromJson =
    !exportHasLayout &&
    (missingMergeTagLiterals.length > 0 ||
      hasTixkitInlineStyleMarks(exported.json) ||
      !hasMeaningfulHtml(exportedHtml));
  const jsonHtml = shouldRebuildFromJson
    ? canonicalizeMergeTagPreviewHtml(tipTapHtmlFromJson(exported.json))
    : '';
  // Prefer structured React Email HTML when present. Otherwise use the JSON
  // rebuild (needed for merge-tag restoration) before plain export text.
  const preferredHtml = exportHasLayout ? exportedHtml : jsonHtml || exportedHtml;
  // Always re-canonicalize so canvas preview href/src values never leak.
  const canonicalHtml = canonicalizeMergeTagPreviewHtml(preferredHtml);
  const htmlText = plainTextFromHtml(canonicalHtml);
  const contentText = jsonText || exported.text.trim() || htmlText;
  if (!contentText.trim() && !hasMeaningfulHtml(canonicalHtml)) {
    return document;
  }
  // If the live editor export is blank/shell-only but the saved document still
  // has the studio shell, keep the richer saved HTML.
  const previousHtml = document.editor.contentHtml ?? '';
  const exportIsBlank = !hasMeaningfulHtml(canonicalHtml);
  const keepPreviousLayout =
    exportIsBlank && hasEmailLayoutHtml(previousHtml) && hasMeaningfulHtml(previousHtml);
  const baseContentHtml = keepPreviousLayout
    ? previousHtml
    : canonicalHtml && (htmlText || !jsonText)
      ? canonicalHtml
      : htmlFromPlainText(contentText);
  const contentHtml = applyEmailGlobalCssToHtml(
    canonicalizeMergeTagPreviewHtml(baseContentHtml),
    document.editor.globalCss,
  );
  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml,
      contentText,
      contentJson: exported.json,
    },
    blocks: projectEditorTextToLegacyBlocks(document.blocks, contentText),
  };
}

function hasMeaningfulHtml(html: string): boolean {
  const withoutEmptyTags = html
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return withoutEmptyTags.length > 0 || /<(?:img|hr)\b/i.test(html);
}

function hasEmailLayoutHtml(html: string): boolean {
  if (!html.trim()) return false;
  return (
    /style\s*=\s*["'][^"']*(?:background|padding|border-radius|max-width|font-family)/i.test(
      html,
    ) ||
    /<(?:table|section|header|footer|td|th)\b/i.test(html) ||
    /data-type=["'](?:container|section)["']/i.test(html) ||
    /<(?:html|body)\b/i.test(html)
  );
}

export function projectEditorTextToLegacyBlocks(
  blocks: EmailTemplateDocument['blocks'],
  contentText: string,
): EmailTemplateDocument['blocks'] {
  if (!contentText.trim()) return blocks;
  const firstTextBlock = blocks.findIndex(
    (block) => block.type === 'event_hero' || block.type === 'ticket_summary',
  );
  if (firstTextBlock < 0) return blocks;
  return blocks.map((block, index) => {
    if (index !== firstTextBlock) return block;
    if (block.type === 'event_hero') {
      return { ...block, body: contentText };
    }
    if (block.type === 'ticket_summary') {
      return { ...block, body: contentText };
    }
    return block;
  });
}

export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function tipTapPlainTextFromJson(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { content?: unknown; marks?: unknown; text?: unknown; type?: unknown };
  if (typeof node.text === 'string') {
    const mergeTagKey = mergeTagKeyFromJsonMarks(node.marks);
    return mergeTagKey ? mergeTagLiteral(mergeTagKey) : node.text;
  }
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return '';
  const parts = node.content
    .map((child) => tipTapPlainTextFromJson(child))
    .filter((part) => part.length > 0);
  const separator =
    node.type === 'doc' ||
    node.type === 'container' ||
    node.type === 'bulletList' ||
    node.type === 'orderedList' ||
    node.type === 'listItem'
      ? '\n'
      : '';
  return parts
    .join(separator)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mergeTagKeyFromJsonMarks(marks: unknown): string | null {
  if (!Array.isArray(marks)) return null;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const typedMark = mark as { attrs?: { key?: unknown }; type?: unknown };
    if (typedMark.type !== tixkitMergeTagMarkName) continue;
    const key = typedMark.attrs?.key;
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return null;
}

function mergeTagLiteralsFromJson(value: unknown): string[] {
  const literals = new Set<string>();
  const visit = (nodeValue: unknown) => {
    if (!nodeValue || typeof nodeValue !== 'object') return;
    if (Array.isArray(nodeValue)) {
      for (const child of nodeValue) visit(child);
      return;
    }
    const node = nodeValue as TipTapJsonNode;
    const mergeTagKey = mergeTagKeyFromJsonMarks(node.marks);
    if (mergeTagKey) literals.add(mergeTagLiteral(mergeTagKey));
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value);
  return Array.from(literals);
}

function hasTixkitInlineStyleMarks(value: unknown): boolean {
  let found = false;
  const visit = (nodeValue: unknown) => {
    if (found || !nodeValue || typeof nodeValue !== 'object') return;
    if (Array.isArray(nodeValue)) {
      for (const child of nodeValue) visit(child);
      return;
    }
    const node = nodeValue as TipTapJsonNode;
    if (Array.isArray(node.marks)) {
      found = node.marks.some(
        (mark) =>
          mark &&
          typeof mark === 'object' &&
          (mark as { type?: unknown }).type === tixkitInlineStyleMarkName,
      );
      if (found) return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value);
  return found;
}

type TipTapJsonNode = {
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
  type?: unknown;
};

function tipTapHtmlFromJson(value: unknown): string {
  const html = tipTapNodeHtml(value);
  return html.trim();
}

function tipTapNodeHtml(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((child) => tipTapNodeHtml(child)).join('');
  const node = value as TipTapJsonNode;
  if (typeof node.text === 'string') return tipTapTextHtml(node.text, node.marks);
  if (node.type === 'hardBreak') return '<br>';

  const children = Array.isArray(node.content)
    ? node.content.map((child) => tipTapNodeHtml(child)).join('')
    : '';
  const attrs = tipTapElementAttributes(node.attrs);
  switch (node.type) {
    case 'doc':
      return children;
    case 'body':
      return `<div${attrs}>${children}</div>`;
    case 'container':
      return `<div data-type="container"${attrs}>${children}</div>`;
    case 'section':
      return `<section data-type="section"${attrs}>${children}</section>`;
    case 'div':
    case 'header':
    case 'footer':
      return `<div${attrs}>${children}</div>`;
    case 'paragraph':
      return `<p${attrs}>${children}</p>`;
    case 'heading': {
      const level = tipTapHeadingLevel(node.attrs);
      return `<h${level}${attrs}>${children}</h${level}>`;
    }
    case 'bulletList':
      return `<ul${attrs}>${children}</ul>`;
    case 'orderedList':
      return `<ol${attrs}>${children}</ol>`;
    case 'listItem':
      return `<li${attrs}>${children}</li>`;
    case 'blockquote':
      return `<blockquote${attrs}>${children}</blockquote>`;
    case 'button': {
      const href =
        typeof node.attrs?.href === 'string' && node.attrs.href.trim()
          ? canonicalizeLinkHrefFromMarkAttrs({ href: node.attrs.href, ...node.attrs })
          : '#';
      return `<a data-id="react-email-button" href="${escapeHtmlAttribute(href)}"${attrs}>${children}</a>`;
    }
    case 'image': {
      const rawSrc = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const mergeKey =
        mergeAttrKeyFromRecord(node.attrs, 'src') ||
        mergeTagKeyFromCanvasAttributeValue(rawSrc) ||
        emailVariableInserts.find((key) => mergeTagCanvasAttributeValue(key) === rawSrc);
      const src = mergeKey ? mergeTagLiteral(mergeKey) : rawSrc;
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      if (!src) return '';
      return `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}"${attrs} />`;
    }
    case 'table':
      return `<table${attrs}>${children}</table>`;
    case 'tableRow':
      return `<tr${attrs}>${children}</tr>`;
    case 'tableCell':
      return `<td${attrs}>${children}</td>`;
    case 'tableHeader':
      return `<th${attrs}>${children}</th>`;
    default:
      return children;
  }
}

function tipTapElementAttributes(attrs: Record<string, unknown> | undefined): string {
  if (!attrs) return '';
  const parts: string[] = [];
  if (typeof attrs.style === 'string' && attrs.style.trim()) {
    parts.push(`style="${escapeHtmlAttribute(attrs.style.trim())}"`);
  }
  if (typeof attrs.class === 'string' && attrs.class.trim()) {
    parts.push(`class="${escapeHtmlAttribute(attrs.class.trim())}"`);
  }
  const alignment = tipTapAlignment(attrs);
  if (alignment && !parts.some((part) => part.startsWith('style='))) {
    parts.push(`style="text-align: ${alignment}"`);
  } else if (alignment) {
    // already have style; leave alignment to the style string when present
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function tipTapTextHtml(text: string, marks: unknown): string {
  const mergeTagKey = mergeTagKeyFromJsonMarks(marks);
  const sourceText = mergeTagKey ? mergeTagLiteral(mergeTagKey) : text;
  let html = escapeHtml(sourceText);
  if (!Array.isArray(marks)) return html;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const typedMark = mark as { attrs?: Record<string, unknown>; type?: unknown };
    if (typedMark.type === tixkitMergeTagMarkName) continue;
    if (typedMark.type === tixkitInlineStyleMarkName) {
      const style = inlineStyleAttribute(typedMark.attrs);
      if (style) html = `<span style="${escapeHtmlAttribute(style)}">${html}</span>`;
      continue;
    }
    if (typedMark.type === 'bold' || typedMark.type === 'strong') {
      html = `<strong>${html}</strong>`;
      continue;
    }
    if (typedMark.type === 'italic' || typedMark.type === 'em') {
      html = `<em>${html}</em>`;
      continue;
    }
    if (typedMark.type === 'strike') {
      html = `<s>${html}</s>`;
      continue;
    }
    if (typedMark.type === 'link') {
      const href = canonicalizeLinkHrefFromMarkAttrs(typedMark.attrs);
      if (href.trim()) html = `<a href="${escapeHtmlAttribute(href.trim())}">${html}</a>`;
    }
  }
  return html;
}

function tipTapAlignment(attrs: Record<string, unknown> | undefined): string | null {
  const value =
    typeof attrs?.textAlign === 'string'
      ? attrs.textAlign
      : typeof attrs?.align === 'string'
        ? attrs.align
        : typeof attrs?.alignment === 'string'
          ? attrs.alignment
          : '';
  if (value === 'left' || value === 'center' || value === 'right') return value;
  return null;
}

function tipTapHeadingLevel(attrs: Record<string, unknown> | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = typeof attrs?.level === 'number' ? attrs.level : 1;
  if (level === 2 || level === 3 || level === 4 || level === 5 || level === 6) return level;
  return 1;
}

function inlineStyleAttribute(attrs: Record<string, unknown> | undefined): string {
  const style: string[] = [];
  if (typeof attrs?.color === 'string' && attrs.color.trim()) {
    style.push(`color: ${attrs.color.trim()}`);
  }
  if (typeof attrs?.fontFamily === 'string' && attrs.fontFamily.trim()) {
    const fontFamily = sanitizeEmailFontFamily(attrs.fontFamily);
    if (fontFamily) style.push(`font-family: ${fontFamily}`);
  }
  if (typeof attrs?.fontSize === 'string' && attrs.fontSize.trim()) {
    style.push(`font-size: ${attrs.fontSize.trim()}`);
  }
  if (typeof attrs?.lineHeight === 'string' && attrs.lineHeight.trim()) {
    style.push(`line-height: ${attrs.lineHeight.trim()}`);
  }
  return style.join('; ');
}

function mergeAttrKeyFromRecord(
  attrs: Record<string, unknown> | undefined,
  attribute: 'href' | 'src',
): string | null {
  if (!attrs) return null;
  const candidates = [
    attrs[`data-tixkit-merge-attr-${attribute}`],
    attrs[`dataTixkitMergeAttr${attribute === 'href' ? 'Href' : 'Src'}`],
    attrs.tixkitMergeAttrHref,
    attrs.tixkitMergeAttrSrc,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function canonicalizeLinkHrefFromMarkAttrs(attrs: Record<string, unknown> | undefined): string {
  const mergeKey = mergeAttrKeyFromRecord(attrs, 'href');
  if (mergeKey) return mergeTagLiteral(mergeKey);
  const raw = typeof attrs?.href === 'string' ? attrs.href.trim() : '';
  if (!raw) return '';
  const fromPreview = mergeTagKeyFromCanvasAttributeValue(raw);
  if (fromPreview) return mergeTagLiteral(fromPreview);
  for (const key of emailVariableInserts) {
    if (raw === mergeTagCanvasAttributeValue(key)) return mergeTagLiteral(key);
  }
  return raw;
}

function canonicalizeMergeTagPreviewHtml(html: string): string {
  if (!html.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(
        /\b(src|href)=(["'])([\s\S]*?)\2(\s[^>]*?)?\sdata-tixkit-merge-attr-\1=(["'])([^"']+)\5/gi,
        (
          _match,
          attribute: string,
          quote: string,
          _value: string,
          middle = '',
          _q2: string,
          key: string,
        ) => `${attribute}=${quote}${mergeTagLiteral(key.trim())}${quote}${middle}`,
      )
      .replace(
        /\bdata-tixkit-merge-attr-(src|href)=(["'])([^"']+)\2\s+([^>]*?\b)\1=(["'])([\s\S]*?)\5/gi,
        (_match, attribute: string, _q1: string, key: string, middle: string, quote: string) =>
          `${middle}${attribute}=${quote}${mergeTagLiteral(key.trim())}${quote}`,
      )
      .replace(
        /\b(src|href)=(["'])([\s\S]*?)\2/gi,
        (match, attribute: string, quote: string, value: string) => {
          const key =
            mergeTagKeyFromCanvasAttributeValue(value) ||
            emailVariableInserts.find(
              (candidate) => mergeTagCanvasAttributeValue(candidate) === value,
            );
          return key ? `${attribute}=${quote}${mergeTagLiteral(key)}${quote}` : match;
        },
      )
      .replace(
        /(<span\b[^>]*\bdata-tixkit-merge-tag=["']([^"']+)["'][^>]*>)([\s\S]*?)(<\/span>)/gi,
        (_match, opening: string, key: string, _content: string, closing: string) =>
          `${opening}${mergeTagLiteral(key.trim())}${closing}`,
      );
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  for (const element of Array.from(
    parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-attr-src]'),
  )) {
    const key = element.dataset.tixkitMergeAttrSrc;
    if (!key?.trim()) continue;
    element.setAttribute('src', mergeTagLiteral(key.trim()));
    element.removeAttribute('data-tixkit-merge-attr-src');
  }
  for (const element of Array.from(
    parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-attr-href]'),
  )) {
    const key = element.dataset.tixkitMergeAttrHref;
    if (!key?.trim()) continue;
    element.setAttribute('href', mergeTagLiteral(key.trim()));
    element.removeAttribute('data-tixkit-merge-attr-href');
  }
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>('[src], [href]'))) {
    for (const attribute of ['src', 'href'] as const) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const fromPreview = mergeTagKeyFromCanvasAttributeValue(value);
      if (fromPreview) {
        element.setAttribute(attribute, mergeTagLiteral(fromPreview));
        continue;
      }
      for (const key of emailVariableInserts) {
        if (value === mergeTagCanvasAttributeValue(key)) {
          element.setAttribute(attribute, mergeTagLiteral(key));
          break;
        }
      }
    }
  }
  for (const element of Array.from(
    parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-tag]'),
  )) {
    const key = element.dataset.tixkitMergeTag || element.dataset.variableKey;
    if (!key?.trim()) continue;
    element.textContent = mergeTagLiteral(key.trim());
    element.removeAttribute('data-tixkit-merge-tag');
    element.removeAttribute('data-variable-key');
    element.removeAttribute('data-variable-kind');
    element.removeAttribute('data-variable-label');
    element.removeAttribute('data-variable-preview');
    element.removeAttribute('data-variable-detail');
    element.removeAttribute('key');
    element.removeAttribute('kind');
    element.removeAttribute('label');
    element.removeAttribute('preview');
    element.removeAttribute('title');
    const classNames = element.className
      .split(/\s+/)
      .filter((className) => className && className !== 'tixkit-email-variable-chip');
    if (classNames.length > 0) {
      element.className = classNames.join(' ');
    } else {
      element.removeAttribute('class');
    }
  }
  for (const element of Array.from(
    parsed.querySelectorAll<HTMLElement>('[data-tixkit-inline-style]'),
  )) {
    element.removeAttribute('data-tixkit-inline-style');
  }

  const trimmed = html.trim();
  if (/<html[\s>]/i.test(trimmed)) {
    const doctype = /^<!doctype/i.test(trimmed) ? '<!DOCTYPE html>' : '';
    return `${doctype}${parsed.documentElement.outerHTML}`;
  }
  return parsed.body.innerHTML;
}

function htmlFromPlainText(text: string): string {
  if (!text.trim()) return '';
  return text
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const fallbackEmailVariableInserts = [
  'event.title',
  'event.startsAt',
  'event.endsAt',
  'event.timezone',
  'event.venueName',
  'event.venueCity',
  'event.checkoutUrl',
  'event.publicUrl',
  'brand.name',
  'brand.supportUrl',
  'recipient.name',
  'recipient.email',
  'recipient.phone',
  'attendee.name',
  'attendee.checkedIn',
  'ticket.type',
  'ticket.code',
  'ticket.qrCodeUrl',
  'order.id',
  'order.total',
  'refund.amount',
  'review.platform',
];

export const emailVariableInserts =
  Array.isArray(MERGE_TAG_REGISTRY) && MERGE_TAG_REGISTRY.length > 0
    ? MERGE_TAG_REGISTRY.map((variable) => variable.key)
    : fallbackEmailVariableInserts;
