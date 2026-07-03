'use client';

import * as React from 'react';
import type { EmailEditorProps } from '@react-email/editor';
import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Heading as TiptapHeading } from '@tiptap/extension-heading';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { StarterKit, type StarterKitOptions } from '@react-email/editor/extensions';
import {
  EmailTheming,
  createTheme,
  imageSlashCommand,
  type EditorThemeInput,
} from '@react-email/editor/plugins';
import {
  CalendarDays,
  Code,
  Image,
  MapPin,
  QrCode,
  Share2,
  Ticket,
  Variable,
} from 'lucide-react';
import { defaultSlashCommands, type SlashCommandItem } from '@react-email/editor/ui';

type BrandEmailEditorThemeInput = {
  primaryColor?: string;
  fontFamily?: string;
  preset?: 'brand' | 'minimal' | 'basic';
  radius?: string | number;
};

export type EmailVariableKind =
  | 'event'
  | 'recipient'
  | 'ticket'
  | 'order'
  | 'brand'
  | 'link'
  | 'system';

export type EmailVariablePresentation = {
  label: string;
  preview: string;
  kind: EmailVariableKind;
};

const ticketQrCanvasPreviewDataUri =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Crect width='160' height='160' fill='white'/%3E%3Cpath fill='%23111827' d='M16 16h40v40H16zM24 24v24h24V24zm80-8h40v40h-40zM112 24v24h24V24zM16 104h40v40H16zM24 112v24h24v-24zm64-32h16v16H88zm24 0h16v16h-16zm16 16h16v16h-16zM72 104h16v16H72zm16 16h16v24H88zm32 0h24v24h-24zM72 32h16v16H72zm0 24h16v16H72zm24 0h16v16H96zm-24 88h16v-16H72z'/%3E%3C/svg%3E";

const canvasPreviewAttributeValues: Record<string, string> = {
  'ticket.qrCodeUrl': ticketQrCanvasPreviewDataUri,
};

const mergeTagPattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
export const tixkitMergeTagMarkName = 'tixkitMergeTag';
export const tixkitInlineStyleMarkName = 'tixkitInlineStyle';

type MergeTagPreviewPluginState = {
  active:
    | {
        cursor?: number;
        from: number;
        key: string | null;
        nodeName?: string;
        scope?: 'node' | 'row' | 'text';
        to: number;
      }
    | null;
};

const mergeTagPreviewPluginKey = new PluginKey<MergeTagPreviewPluginState>(
  'tixkitMergeTagPreview',
);

// Set briefly after a chip click so `apply` doesn't clear the active state
// when a stray selectionchange event fires before the browser settles.
let chipClickGuardUntil = 0;
// The merge tag key from the most recent chip click, used as a fallback
// by openVariableMenu when the activeRange has been cleared by a stale
// selectionchange after the guard expired.
let lastChipClickKey: string | null = null;
let lastChipClickRange: { from: number; to: number } | null = null;

const variablePresentations: Record<string, EmailVariablePresentation> = {
  'event.title': {
    label: 'Event name',
    preview: 'Sample Summer Showcase',
    kind: 'event',
  },
  'event.startsAt': {
    label: 'Event date',
    preview: 'Sat, Aug 15 at 8:00 PM',
    kind: 'event',
  },
  'event.endsAt': {
    label: 'Event end time',
    preview: 'Sat, Aug 15 at 11:00 PM',
    kind: 'event',
  },
  'event.timezone': {
    label: 'Event timezone',
    preview: 'America/New_York',
    kind: 'event',
  },
  'event.venueName': {
    label: 'Venue',
    preview: 'River North Hall',
    kind: 'event',
  },
  'event.venueCity': {
    label: 'Venue city',
    preview: 'Chicago',
    kind: 'event',
  },
  'event.checkoutUrl': {
    label: 'Checkout link',
    preview: 'ticket checkout',
    kind: 'link',
  },
  'event.publicUrl': {
    label: 'Event page',
    preview: 'public event page',
    kind: 'link',
  },
  'recipient.name': {
    label: 'Attendee name',
    preview: 'Ada Lovelace',
    kind: 'recipient',
  },
  'recipient.email': {
    label: 'Attendee email',
    preview: 'ada@example.test',
    kind: 'recipient',
  },
  'recipient.phone': {
    label: 'Attendee phone',
    preview: '+1 555 123 4567',
    kind: 'recipient',
  },
  'attendee.name': {
    label: 'Attendee name',
    preview: 'Ada Lovelace',
    kind: 'recipient',
  },
  'attendee.checkedIn': {
    label: 'Check-in status',
    preview: 'checked in',
    kind: 'recipient',
  },
  'ticket.type': {
    label: 'Ticket type',
    preview: 'General Admission',
    kind: 'ticket',
  },
  'ticket.qrCodeUrl': {
    label: 'Ticket QR code',
    preview: 'QR image link',
    kind: 'ticket',
  },
  'ticket.code': {
    label: 'Ticket code',
    preview: 'TKT-ABC123',
    kind: 'ticket',
  },
  'order.id': {
    label: 'Order number',
    preview: '#A10045',
    kind: 'order',
  },
  'order.total': {
    label: 'Order total',
    preview: '$84.00',
    kind: 'order',
  },
  'refund.amount': {
    label: 'Refund amount',
    preview: '$20.00',
    kind: 'order',
  },
  'review.platform': {
    label: 'Review platform',
    preview: 'Google',
    kind: 'system',
  },
  'brand.name': {
    label: 'Brand name',
    preview: 'All Access Chicago',
    kind: 'brand',
  },
  'brand.supportUrl': {
    label: 'Support link',
    preview: 'help center',
    kind: 'link',
  },
};

export const emailEditorStarterKitOptions = {
  AlignmentAttribute: {
    types: [
      'body',
      'container',
      'div',
      'heading',
      'paragraph',
      'image',
      'blockquote',
      'codeBlock',
      'bulletList',
      'orderedList',
      'listItem',
      'button',
      'section',
      'table',
      'tableRow',
      'tableCell',
      'tableHeader',
      'columnsColumn',
    ],
  },
  CodeBlockPrism: {
    defaultLanguage: 'html',
    defaultTheme: 'github',
  },
  Heading: false,
} satisfies Partial<StarterKitOptions>;

function cssLength(value: string | number | undefined, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}px`;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

export function sanitizeEmailFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fontFamily = value.trim();
  if (!fontFamily || fontFamily.length > 180) return null;
  if (/[;{}<>]/.test(fontFamily)) return null;
  return fontFamily
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => /^['"]?[a-z0-9 ._-]+['"]?$/i.test(part))
    ? fontFamily
    : null;
}

function humanizeVariableKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function fallbackVariableKind(key: string): EmailVariableKind {
  if (key.startsWith('event.')) return 'event';
  if (key.startsWith('recipient.') || key.startsWith('attendee.') || key.startsWith('contact.')) {
    return 'recipient';
  }
  if (key.startsWith('ticket.')) return 'ticket';
  if (key.startsWith('order.') || key.startsWith('refund.')) return 'order';
  if (key.startsWith('brand.')) return 'brand';
  if (key.toLowerCase().includes('url') || key.toLowerCase().includes('link')) return 'link';
  return 'system';
}

function inlineStyleToReactStyle(value: unknown): React.CSSProperties | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const style: Record<string, string> = {};
  for (const declaration of value.split(';')) {
    const [rawProperty, ...rawValueParts] = declaration.split(':');
    const property = rawProperty?.trim();
    const propertyValue = rawValueParts.join(':').trim();
    if (!property || !propertyValue) continue;
    const camelProperty = property.replace(/-([a-z])/g, (_, character: string) =>
      character.toUpperCase(),
    );
    style[camelProperty] = propertyValue;
  }
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined;
}

function textAlignFromAttribute(value: unknown): React.CSSProperties | undefined {
  return value === 'left' || value === 'center' || value === 'right'
    ? { textAlign: value }
    : undefined;
}

function inlineStyleMarkStyle(attrs: {
  color?: unknown;
  fontFamily?: unknown;
  fontSize?: unknown;
  lineHeight?: unknown;
}): string {
  const declarations: string[] = [];
  if (typeof attrs.color === 'string' && attrs.color.trim()) {
    declarations.push(`color: ${attrs.color.trim()}`);
  }
  const fontFamily = sanitizeEmailFontFamily(attrs.fontFamily);
  if (fontFamily) {
    declarations.push(`font-family: ${fontFamily}`);
  }
  if (typeof attrs.fontSize === 'string' && attrs.fontSize.trim()) {
    declarations.push(`font-size: ${cssLength(attrs.fontSize.trim(), '')}`);
  }
  if (typeof attrs.lineHeight === 'string' && attrs.lineHeight.trim()) {
    declarations.push(`line-height: ${attrs.lineHeight.trim()}`);
  }
  return declarations.join('; ');
}

const TixkitHeading = TiptapHeading.configure({ levels: [1, 2, 3] }).extend({
  addNodeView() {
    return ReactNodeViewRenderer(({ node }) => {
      const attrs = node.attrs as {
        align?: unknown;
        alignment?: unknown;
        class?: unknown;
        level?: unknown;
        style?: unknown;
      };
      const level = attrs.level === 2 || attrs.level === 3 ? attrs.level : 1;
      const className = ['node-h' + level, typeof attrs.class === 'string' ? attrs.class : '']
        .filter(Boolean)
        .join(' ');
      const style = {
        ...inlineStyleToReactStyle(attrs.style),
        ...textAlignFromAttribute(attrs.align ?? attrs.alignment),
      };

      return React.createElement(
        NodeViewWrapper,
        {
          as: `h${level}` as React.ElementType,
          className,
          style,
        },
        React.createElement(NodeViewContent, { as: 'span' }),
      );
    });
  },
});

export function variablePresentation(key: string): EmailVariablePresentation {
  return (
    variablePresentations[key] ?? {
      label: humanizeVariableKey(key),
      preview: 'sample value',
      kind: fallbackVariableKind(key),
    }
  );
}

export function mergeTagLiteral(key: string): string {
  return `{{${key}}}`;
}

function mergeTagMarkAttrs(key: string): Record<string, string> {
  const presentation = variablePresentation(key);
  return {
    key,
    kind: presentation.kind,
    label: presentation.label,
    preview: presentation.preview,
  };
}

function mergeTagKeyFromLiteral(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/);
  return match?.[1]?.trim() || null;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderMergeTagPreviewHtml(key: string): string {
  const attrs = mergeTagMarkAttrs(key);
  return [
    '<span',
    ` class="tixkit-email-variable-chip"`,
    ` data-tixkit-merge-tag="${escapeHtmlAttribute(attrs.key)}"`,
    ` data-variable-key="${escapeHtmlAttribute(attrs.key)}"`,
    ` data-variable-kind="${escapeHtmlAttribute(attrs.kind)}"`,
    ` data-variable-label="${escapeHtmlAttribute(attrs.label)}"`,
    ` data-variable-preview="${escapeHtmlAttribute(attrs.preview)}"`,
    ` data-variable-detail="${escapeHtmlAttribute(`${attrs.label} - ${mergeTagLiteral(key)}`)}"`,
    '>',
    escapeHtmlText(attrs.preview),
    '</span>',
  ].join('');
}

export function mergeTagCanvasAttributeValue(key: string): string {
  return canvasPreviewAttributeValues[key] ?? variablePresentation(key).preview;
}

function applyMergeTagPreviewsToJsonAttrs(attrs: unknown): unknown {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return attrs;
  const source = attrs as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const attribute of ['src', 'href'] as const) {
    const key = mergeTagKeyFromLiteral(source[attribute]);
    if (!key) continue;
    next ??= { ...source };
    next[attribute] = mergeTagCanvasAttributeValue(key);
    next[`data-tixkit-merge-attr-${attribute}`] = key;
  }
  return next ?? attrs;
}

function applyMergeTagPreviewsToHtml(content: string): string {
  const withPreviewText = content.replace(
    /(^|>)([^<]+)(?=<|$)/g,
    (_match, prefix: string, text: string) => {
      mergeTagPattern.lastIndex = 0;
      if (!mergeTagPattern.test(text)) return `${prefix}${text}`;
      mergeTagPattern.lastIndex = 0;
      return `${prefix}${text.replace(mergeTagPattern, (_token, key: string) =>
        renderMergeTagPreviewHtml(key.trim()),
      )}`;
    },
  );
  return withPreviewText.replace(
    /\b(src|href)=["']\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}["']/gi,
    (_match, attribute: string, key: string) => {
      const normalizedKey = key.trim();
      return `${attribute}="${escapeHtmlAttribute(
        mergeTagCanvasAttributeValue(normalizedKey),
      )}" data-tixkit-merge-attr-${attribute.toLowerCase()}="${escapeHtmlAttribute(
        normalizedKey,
      )}"`;
    },
  );
}

function hasMergeTagMark(marks: unknown): boolean {
  return (
    Array.isArray(marks) &&
    marks.some(
      (mark) =>
        Boolean(mark) &&
        typeof mark === 'object' &&
        (mark as { type?: unknown }).type === tixkitMergeTagMarkName,
    )
  );
}

function marksWithMergeTag(marks: unknown, key: string): unknown[] {
  const baseMarks = Array.isArray(marks)
    ? marks.filter(
        (mark) =>
          !(
            Boolean(mark) &&
            typeof mark === 'object' &&
            (mark as { type?: unknown }).type === tixkitMergeTagMarkName
          ),
      )
    : [];
  return [...baseMarks, { type: tixkitMergeTagMarkName, attrs: mergeTagMarkAttrs(key) }];
}

function applyMergeTagPreviewsToJsonNode(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      const transformed = applyMergeTagPreviewsToJsonNode(child);
      return Array.isArray(transformed) ? transformed : [transformed];
    });
  }

  const node = value as {
    content?: unknown;
    marks?: unknown;
    attrs?: unknown;
    text?: unknown;
    type?: unknown;
    [key: string]: unknown;
  };
  const transformedAttrs = applyMergeTagPreviewsToJsonAttrs(node.attrs);
  const previewNode = transformedAttrs === node.attrs ? node : { ...node, attrs: transformedAttrs };

  if (previewNode.type === 'text' && typeof previewNode.text === 'string') {
    if (hasMergeTagMark(previewNode.marks)) return previewNode;
    mergeTagPattern.lastIndex = 0;
    const matches = Array.from(previewNode.text.matchAll(mergeTagPattern));
    if (matches.length === 0) return previewNode;

    const parts: unknown[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (typeof match.index !== 'number') continue;
      const key = match[1].trim();
      if (match.index > cursor) {
        parts.push({ ...previewNode, text: previewNode.text.slice(cursor, match.index) });
      }
      parts.push({
        ...previewNode,
        text: variablePresentation(key).preview,
        marks: marksWithMergeTag(previewNode.marks, key),
      });
      cursor = match.index + match[0].length;
    }
    if (cursor < previewNode.text.length) {
      parts.push({ ...previewNode, text: previewNode.text.slice(cursor) });
    }
    return parts;
  }

  if (Array.isArray(previewNode.content)) {
    return {
      ...previewNode,
      content: previewNode.content.flatMap((child) => {
        const transformed = applyMergeTagPreviewsToJsonNode(child);
        return Array.isArray(transformed) ? transformed : [transformed];
      }),
    };
  }

  return previewNode;
}

export function applyMergeTagPreviewsToEditorContent(
  content: EmailEditorProps['content'],
): EmailEditorProps['content'] {
  if (typeof content === 'string') return applyMergeTagPreviewsToHtml(content);
  if (content && typeof content === 'object') {
    return applyMergeTagPreviewsToJsonNode(content) as EmailEditorProps['content'];
  }
  return content;
}

export function orderedVariableOptions(mergeTags: readonly string[], currentKey: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const key of currentKey ? [currentKey, ...mergeTags] : mergeTags) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    options.push(normalizedKey);
  }
  return options;
}

function isEmailInspectorTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('[data-tixkit-email-inspector="true"]'))
  );
}

function hasActiveEmailBubbleControlInteraction(): boolean {
  const until = Number(
    globalThis.document?.documentElement.getAttribute(
      'data-tixkit-email-bubble-control-until',
    ) ?? '0',
  );
  return Date.now() < until;
}

type InlineStyleAttrs = {
  color?: string;
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: string;
};

type InlineTextAlignment = 'left' | 'center' | 'right';

const alignableNodeNames = new Set([
  'button',
  'image',
  'section',
  'columnsColumn',
]);

function cleanInlineStyleAttrs(attrs: InlineStyleAttrs): InlineStyleAttrs {
  return Object.fromEntries(
    Object.entries(attrs).filter((entry): entry is [keyof InlineStyleAttrs, string] =>
      Boolean(entry[1]?.trim()),
    ),
  );
}

function readInlineStyleMark(mark: { attrs: Record<string, unknown> } | undefined): InlineStyleAttrs {
  if (!mark) return {};
  return cleanInlineStyleAttrs({
    color: mark.attrs.color as string | undefined,
    fontFamily: mark.attrs.fontFamily as string | undefined,
    fontSize: mark.attrs.fontSize as string | undefined,
    lineHeight: mark.attrs.lineHeight as string | undefined,
  });
}

function nodeInlineStyleAttrs(node: { attrs?: Record<string, unknown> } | null | undefined): InlineStyleAttrs {
  if (!node?.attrs?.style || typeof node.attrs.style !== 'string') return {};
  const style = inlineStyleToReactStyle(node.attrs.style);
  if (!style) return {};
  return cleanInlineStyleAttrs({
    color: style.color as string | undefined,
    fontFamily: style.fontFamily as string | undefined,
    fontSize: style.fontSize as string | undefined,
    lineHeight: style.lineHeight as string | undefined,
  });
}

function rgbToHex(rgb: string): string | undefined {
  const match = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!match) return undefined;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function computedStyleFromDom(view: EditorView, position: number): InlineStyleAttrs {
  try {
    const pos = Math.max(0, Math.min(position, view.state.doc.content.size));
    const domInfo = view.domAtPos(pos);
    let el =
      domInfo.node instanceof HTMLElement
        ? domInfo.node
        : domInfo.node.parentElement;
    if (!el) return {};
    const themedEl = el.closest<HTMLElement>('h1, h2, h3, h4, h5, h6, p, [class*="node-h"], [class*="node-paragraph"]');
    if (themedEl) el = themedEl;
    const cs = globalThis.window.getComputedStyle(el);
    const fontSizePx = parseFloat(cs.fontSize);
    const lineHeightPx = parseFloat(cs.lineHeight);
    const lineHeight =
      fontSizePx > 0 && lineHeightPx > 0
        ? `${Math.round((lineHeightPx / fontSizePx) * 100)}%`
        : undefined;
    return cleanInlineStyleAttrs({
      color: rgbToHex(cs.color),
      fontFamily: cs.fontFamily,
      fontSize: Number.isFinite(fontSizePx) ? `${Math.round(fontSizePx)}px` : undefined,
      lineHeight,
    });
  } catch {
    return {};
  }
}

function markOnlyStyleAttrsFromView(
  view: EditorView,
  from: number,
  to: number,
): InlineStyleAttrs {
  const markType = view.state.schema.marks[tixkitInlineStyleMarkName];
  if (!markType || from === to) return {};
  let attrs: InlineStyleAttrs | null = null;
  view.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    if (attrs !== null) return false;
    const mark = node.marks.find((candidate) => candidate.type === markType);
    if (mark) {
      attrs = readInlineStyleMark(mark);
      return false;
    }
    return true;
  });
  return attrs ?? {};
}

function selectedInlineStyleAttrsFromView(
  view: EditorView,
  from: number,
  to: number,
): InlineStyleAttrs {
  const baseStyle = computedStyleFromDom(view, from);
  return { ...baseStyle, ...markOnlyStyleAttrsFromView(view, from, to) };
}

function inlineStyleAttrsAtCursor(
  state: EditorView['state'],
  position: number,
  view?: EditorView,
): InlineStyleAttrs {
  const markType = state.schema.marks[tixkitInlineStyleMarkName];
  if (!markType) return {};
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  if (!resolved.parent.inlineContent) return {};
  const parent = resolved.parent;
  const parentOffset = resolved.parentOffset;
  const baseStyle = view ? computedStyleFromDom(view, position) : nodeInlineStyleAttrs(parent);
  let childOffset = 0;
  for (let i = 0; i < parent.childCount; i += 1) {
    const child = parent.child(i);
    const childEnd = childOffset + child.nodeSize;
    if (child.isText && parentOffset >= childOffset && parentOffset <= childEnd) {
      const mark = child.marks.find((candidate) => candidate.type === markType);
      if (mark) return { ...baseStyle, ...readInlineStyleMark(mark) };
      // Only check adjacent nodes for merge tags that inherit surrounding styles.
      // Regular unmarked text should just return the base (theme) style.
      const mergeTagType = state.schema.marks[tixkitMergeTagMarkName];
      const hasMergeTagMark = mergeTagType
        ? child.marks.some((m) => m.type === mergeTagType)
        : false;
      if (!hasMergeTagMark) return baseStyle;
      for (let j = i - 1; j >= 0; j -= 1) {
        const prev = parent.child(j);
        if (!prev.isText || !prev.textContent.trim()) continue;
        const prevMark = prev.marks.find((candidate) => candidate.type === markType);
        if (prevMark) return { ...baseStyle, ...readInlineStyleMark(prevMark) };
        break;
      }
      for (let j = i + 1; j < parent.childCount; j += 1) {
        const next = parent.child(j);
        if (!next.isText || !next.textContent.trim()) continue;
        const nextMark = next.marks.find((candidate) => candidate.type === markType);
        if (nextMark) return { ...baseStyle, ...readInlineStyleMark(nextMark) };
        break;
      }
      return baseStyle;
    }
    childOffset = childEnd;
  }
  const nodeBefore = resolved.nodeBefore;
  if (nodeBefore?.isText) {
    const mark = nodeBefore.marks.find((candidate) => candidate.type === markType);
    return { ...baseStyle, ...(mark ? readInlineStyleMark(mark) : {}) };
  }
  const nodeAfter = resolved.nodeAfter;
  if (nodeAfter?.isText) {
    const mark = nodeAfter.marks.find((candidate) => candidate.type === markType);
    return { ...baseStyle, ...(mark ? readInlineStyleMark(mark) : {}) };
  }
  return baseStyle;
}

function findWordRangeAtPosition(
  state: EditorView['state'],
  position: number,
): { from: number; to: number } | null {
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  if (!resolved.parent.inlineContent || resolved.parent.content.size === 0) return null;
  const parentStart = resolved.start();
  const text = resolved.parent.textContent;
  const offset = Math.max(0, Math.min(position - parentStart, text.length));
  let wordStart = offset;
  let wordEnd = offset;
  while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart -= 1;
  while (wordEnd < text.length && !/\s/.test(text[wordEnd])) wordEnd += 1;
  if (wordStart === wordEnd) {
    let fwd = wordEnd;
    while (fwd < text.length && /\s/.test(text[fwd])) fwd += 1;
    let fwdEnd = fwd;
    while (fwdEnd < text.length && !/\s/.test(text[fwdEnd])) fwdEnd += 1;
    if (fwd < fwdEnd) {
      wordStart = fwd;
      wordEnd = fwdEnd;
    } else {
      let bwd = wordStart;
      while (bwd > 0 && /\s/.test(text[bwd - 1])) bwd -= 1;
      let bwdStart = bwd;
      while (bwdStart > 0 && !/\s/.test(text[bwdStart - 1])) bwdStart -= 1;
      if (bwdStart < bwd) {
        wordStart = bwdStart;
        wordEnd = bwd;
      }
    }
  }
  if (wordStart === wordEnd) return null;
  return { from: parentStart + wordStart, to: parentStart + wordEnd };
}

function preservedTextSelectionOrRange(
  state: EditorView['state'],
  transaction: EditorView['state']['tr'],
  from: number,
  to: number,
): TextSelection {
  if (state.selection.empty) {
    const candidate = state.selection.$from.parent.inlineContent ? state.selection.from : from;
    const position = Math.max(0, Math.min(transaction.mapping.map(candidate), transaction.doc.content.size));
    const resolved = transaction.doc.resolve(position);
    if (resolved.parent.inlineContent) {
      return TextSelection.create(transaction.doc, position);
    }
  }
  return TextSelection.create(transaction.doc, from, to);
}

function applyInlineStyleToRange(input: {
  cursor?: number;
  from: number;
  patch: InlineStyleAttrs;
  scope?: 'row' | 'text';
  to: number;
  view: EditorView;
}): void {
  const state = input.view.state;
  const markType = state.schema.marks[tixkitInlineStyleMarkName];
  if (!markType || input.from === input.to) return;
  const nextAttrs = cleanInlineStyleAttrs({
    ...markOnlyStyleAttrsFromView(input.view, input.from, input.to),
    ...input.patch,
  });
  let transaction = state.tr.removeMark(input.from, input.to, markType);
  if (Object.keys(nextAttrs).length > 0) {
    transaction = transaction.addMark(input.from, input.to, markType.create(nextAttrs));
  }
  const selection =
    input.scope === 'row'
      ? TextSelection.create(
          transaction.doc,
          transaction.mapping.map(input.cursor ?? state.selection.from, 1),
        )
      : preservedTextSelectionOrRange(state, transaction, input.from, input.to);
  transaction = transaction
    .setSelection(selection)
    .setMeta(mergeTagPreviewPluginKey, {
      active: {
        cursor: input.scope === 'row' ? selection.from : undefined,
        from: input.from,
        key: findMergeTagRangeAtPosition(state, input.from)?.key ?? null,
        scope: input.scope,
        to: input.to,
      },
    });
  input.view.dispatch(transaction);
  input.view.dom.dispatchEvent(
    new CustomEvent('tixkit-email-selection-style-change', {
      bubbles: true,
      detail: { from: input.from, to: input.to },
    }),
  );
}

function applyTextAlignmentToRange(input: {
  alignment: InlineTextAlignment;
  cursor?: number;
  from: number;
  scope?: 'row' | 'text';
  to: number;
  view: EditorView;
}): void {
  const state = input.view.state;
  const from = Math.max(0, Math.min(input.from, state.doc.content.size));
  const to = Math.max(from, Math.min(input.to, state.doc.content.size));
  let transaction = state.tr;
  state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return;
    const attrs = node.attrs as Record<string, unknown>;
    const alignmentProp = Object.prototype.hasOwnProperty.call(attrs, 'align')
      ? 'align'
      : 'alignment';
    transaction = transaction.setNodeMarkup(position, undefined, {
      ...attrs,
      [alignmentProp]: input.alignment,
    });
  });
  if (!transaction.docChanged) {
    const anchor = state.selection.$from;
    for (let depth = anchor.depth; depth > 0; depth -= 1) {
      const node = anchor.node(depth);
      if (!node.isTextblock) continue;
      const position = anchor.before(depth);
      const attrs = node.attrs as Record<string, unknown>;
      const alignmentProp = Object.prototype.hasOwnProperty.call(attrs, 'align')
        ? 'align'
        : 'alignment';
      transaction = transaction.setNodeMarkup(position, undefined, {
        ...attrs,
        [alignmentProp]: input.alignment,
      });
      break;
    }
  }
  if (!transaction.docChanged) return;
  const selection =
    input.scope === 'row'
      ? TextSelection.create(
          transaction.doc,
          transaction.mapping.map(input.cursor ?? state.selection.from, 1),
        )
      : preservedTextSelectionOrRange(state, transaction, from, to);
  transaction = transaction
    .setSelection(selection)
    .setMeta(mergeTagPreviewPluginKey, {
      active: {
        cursor: input.scope === 'row' ? selection.from : undefined,
        from,
        key: findMergeTagRangeAtPosition(state, from)?.key ?? null,
        scope: input.scope,
        to,
      },
    });
  input.view.dispatch(transaction);
  input.view.focus();
}

function applyNodeAlignmentToRange(input: {
  alignment: InlineTextAlignment;
  from: number;
  nodeName?: string;
  view: EditorView;
}): void {
  const { state } = input.view;
  const from = Math.max(0, Math.min(input.from, state.doc.content.size));
  const node = state.doc.nodeAt(from);
  if (!node || !alignableNodeNames.has(input.nodeName ?? node.type.name)) return;
  const attrs = node.attrs as Record<string, unknown>;
  const alignmentProp = Object.prototype.hasOwnProperty.call(attrs, 'align')
    ? 'align'
    : 'alignment';
  let transaction = state.tr.setNodeMarkup(from, undefined, {
    ...attrs,
    [alignmentProp]: input.alignment,
  });
  try {
    transaction = transaction.setSelection(NodeSelection.create(transaction.doc, from));
  } catch {
    // Non-selectable structural nodes still keep their plugin active range through metadata.
  }
  transaction = transaction.setMeta(mergeTagPreviewPluginKey, {
    active: {
      from,
      key: null,
      nodeName: input.nodeName ?? node.type.name,
      scope: 'node',
      to: from + node.nodeSize,
    },
  });
  input.view.dispatch(transaction);
  input.view.focus();
}

function createVariableMenuElement(input: {
  currentKey: string;
  mergeTags: readonly string[];
  onSelect: (key: string) => void;
}): HTMLElement {
  const menu = document.createElement('span');
  menu.className = 'tixkit-email-variable-chip__menu';
  menu.contentEditable = 'false';
  menu.setAttribute('aria-label', 'Edit variable');

  const options = document.createElement('span');
  options.className = 'tixkit-email-variable-chip__options';
  options.setAttribute('aria-label', 'Variable replacement');
  options.setAttribute('role', 'listbox');

  for (const key of orderedVariableOptions(input.mergeTags, input.currentKey).slice(0, 12)) {
    const option = variablePresentation(key);
    const button = document.createElement('button');
    button.className = 'tixkit-email-variable-chip__option';
    button.type = 'button';
    button.dataset.variableKey = key;
    button.setAttribute('aria-label', `Change variable to ${option.label}`);
    button.setAttribute('aria-selected', key === input.currentKey ? 'true' : 'false');
    button.setAttribute('role', 'option');
    button.textContent = option.label;
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      input.onSelect(key);
    });
    options.append(button);
  }

  menu.append(options);
  return menu;
}

function selectVariableToken(input: {
  from: number;
  key: string;
  to: number;
  view: EditorView;
}): void {
  const selection = TextSelection.create(input.view.state.doc, input.from, input.to);
  input.view.dispatch(input.view.state.tr.setSelection(selection));
  input.view.dom.dispatchEvent(
    new CustomEvent('tixkit-email-variable-select', {
      bubbles: true,
      detail: { from: input.from, key: input.key, to: input.to },
    }),
  );
  input.view.focus();
}

function mergeTagKeyFromMark(marks: readonly { attrs?: Record<string, unknown>; type: { name: string } }[]) {
  const mark = marks.find((candidate) => candidate.type.name === tixkitMergeTagMarkName);
  const key = mark?.attrs?.key;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

function replaceRawMergeTagsInView(view: EditorView): void {
  const markType = view.state.schema.marks[tixkitMergeTagMarkName];
  if (!markType) return;
  const replacements: {
    from: number;
    marks: readonly ReturnType<typeof markType.create>[];
    preview: string;
    to: number;
  }[] = [];

  view.state.doc.descendants((node, position) => {
    if (!node.isText || !node.text || mergeTagKeyFromMark(node.marks)) return;
    for (const match of node.text.matchAll(mergeTagPattern)) {
      if (typeof match.index !== 'number') continue;
      const key = match[1].trim();
      const from = position + match.index;
      const to = from + match[0].length;
      const presentation = variablePresentation(key);
      replacements.push({
        from,
        marks: [
          ...node.marks.filter((mark) => mark.type.name !== tixkitMergeTagMarkName),
          markType.create(mergeTagMarkAttrs(key)),
        ],
        preview: presentation.preview,
        to,
      });
    }
  });

  if (replacements.length === 0) return;
  const transaction = view.state.tr;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    transaction.replaceWith(
      replacement.from,
      replacement.to,
      view.state.schema.text(replacement.preview, replacement.marks),
    );
  }
  const mappedFrom = transaction.mapping.map(view.state.selection.from, 1);
  const mappedTo = transaction.mapping.map(view.state.selection.to, 1);
  if (mappedFrom <= mappedTo) {
    transaction.setSelection(TextSelection.create(transaction.doc, mappedFrom, mappedTo));
  }
  view.dispatch(transaction);
}

function findMergeTagRangeAtPosition(
  state: EditorView['state'],
  position: number,
): { from: number; key: string; to: number } | null {
  const segments: { from: number; key: string; to: number }[] = [];
  state.doc.descendants((node, nodePosition) => {
    if (!node.isText || !node.text) return;
    const key = mergeTagKeyFromMark(node.marks);
    if (!key) return;
    segments.push({
      from: nodePosition,
      key,
      to: nodePosition + node.nodeSize,
    });
  });
  if (segments.length === 0) return null;
  const normalizedPosition = Math.max(0, Math.min(position, state.doc.content.size));
  let segmentIndex = segments.findIndex(
    (segment) => normalizedPosition >= segment.from && normalizedPosition <= segment.to,
  );
  if (segmentIndex < 0 && normalizedPosition > 0) {
    segmentIndex = segments.findIndex(
      (segment) =>
        normalizedPosition - 1 >= segment.from && normalizedPosition - 1 <= segment.to,
    );
  }
  if (segmentIndex < 0) return null;

  const segment = segments[segmentIndex];
  let from = segment.from;
  let to = segment.to;
  for (let index = segmentIndex - 1; index >= 0; index -= 1) {
    const previous = segments[index];
    if (previous.key !== segment.key || previous.to !== from) break;
    from = previous.from;
  }
  for (let index = segmentIndex + 1; index < segments.length; index += 1) {
    const next = segments[index];
    if (next.key !== segment.key || next.from !== to) break;
    to = next.to;
  }

  return { from, key: segment.key, to };
}

function findSelectedMergeTagRange(
  state: EditorView['state'],
): { from: number; key: string; to: number } | null {
  const { selection } = state;
  const range = findMergeTagRangeAtPosition(state, selection.from);
  if (!range) return null;
  if (selection.empty) return null;
  return range.from === selection.from && range.to === selection.to ? range : null;
}

function findCursorMergeTagRange(
  state: EditorView['state'],
): NonNullable<MergeTagPreviewPluginState['active']> | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const range = findMergeTagRangeAtPosition(state, selection.from);
  return range ? { ...range, cursor: selection.from, scope: 'text' } : null;
}

function findSelectedTextRange(
  state: EditorView['state'],
): NonNullable<MergeTagPreviewPluginState['active']> | null {
  const { selection } = state;
  if (selection.empty || selection.from === selection.to) return null;
  const mergeTagRange = findSelectedMergeTagRange(state);
  if (mergeTagRange) return mergeTagRange;
  const from = Math.max(0, Math.min(selection.from, state.doc.content.size));
  const to = Math.max(from, Math.min(selection.to, state.doc.content.size));
  if (from === to) return null;
  // When the selection spans block boundaries (e.g. AllSelection starts at 0
  // and ends at doc.content.size), the resolved positions sit at the doc level
  // which is not inline content. Adjust to the first/last textblock content.
  let adjustedFrom = from;
  let adjustedTo = to;
  const fromPosition = state.doc.resolve(adjustedFrom);
  if (!fromPosition.parent.inlineContent) {
    let found = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (found) return false;
      if (node.isTextblock) {
        adjustedFrom = pos + 1;
        found = true;
        return false;
      }
      return true;
    });
    if (!found) return null;
  }
  const toPosition = state.doc.resolve(adjustedTo);
  if (!toPosition.parent.inlineContent) {
    let found = false;
    state.doc.nodesBetween(adjustedFrom, to, (node, pos) => {
      if (node.isTextblock) {
        adjustedTo = pos + node.nodeSize - 1;
        found = true;
        return false;
      }
      return true;
    });
    if (!found) return null;
  }
  if (adjustedFrom >= adjustedTo) return null;
  return { from: adjustedFrom, key: null, scope: 'text', to: adjustedTo };
}

function findCursorTextRowRange(
  state: EditorView['state'],
): NonNullable<MergeTagPreviewPluginState['active']> | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.inlineContent || $from.parent.content.size === 0) return null;
  const from = $from.start();
  const to = $from.end();
  if (from === to) return null;
  return { cursor: selection.from, from, key: null, scope: 'row', to };
}

function findSelectedAlignableNodeRange(
  state: EditorView['state'],
): NonNullable<MergeTagPreviewPluginState['active']> | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && alignableNodeNames.has(selection.node.type.name)) {
    return {
      from: selection.from,
      key: null,
      nodeName: selection.node.type.name,
      scope: 'node',
      to: selection.to,
    };
  }

  if (!selection.empty) return null;
  const anchor = selection.$from;
  for (let depth = anchor.depth; depth > 0; depth -= 1) {
    const node = anchor.node(depth);
    if (!alignableNodeNames.has(node.type.name)) continue;
    const from = anchor.before(depth);
    return {
      from,
      key: null,
      nodeName: node.type.name,
      scope: 'node',
      to: from + node.nodeSize,
    };
  }
  return null;
}

function createFloatingVariableMenu(input: {
  mergeTags: readonly string[];
  view: EditorView;
}): {
  containsActiveElement: () => boolean;
  destroy: () => void;
  isConnected: () => boolean;
  update: (active: MergeTagPreviewPluginState['active']) => void;
} {
  let activeRange: NonNullable<MergeTagPreviewPluginState['active']> | null = null;
  let menu: HTMLElement | null = null;

  const currentActiveRange = () =>
    activeRange ??
    mergeTagPreviewPluginKey.getState(input.view.state)?.active ??
    findSelectedTextRange(input.view.state) ??
    findCursorMergeTagRange(input.view.state) ??
    findCursorTextRowRange(input.view.state) ??
    findSelectedAlignableNodeRange(input.view.state);

  const activeRangeFromSelectionDetail = (
    detail: unknown,
  ): NonNullable<MergeTagPreviewPluginState['active']> | null => {
    if (!detail || typeof detail !== 'object') return null;
    const candidate = detail as {
      cursor?: unknown;
      from?: unknown;
      key?: unknown;
      nodeName?: unknown;
      scope?: unknown;
      to?: unknown;
    };
    if (typeof candidate.from !== 'number' || typeof candidate.to !== 'number') return null;
    const from = Math.max(0, Math.min(candidate.from, input.view.state.doc.content.size));
    const to = Math.max(from, Math.min(candidate.to, input.view.state.doc.content.size));
    if (from === to) return null;
    const scope =
      candidate.scope === 'node' || candidate.scope === 'row' || candidate.scope === 'text'
        ? candidate.scope
        : undefined;
    return {
      cursor: typeof candidate.cursor === 'number' ? candidate.cursor : undefined,
      from,
      key: typeof candidate.key === 'string' && candidate.key.trim() ? candidate.key.trim() : null,
      nodeName:
        typeof candidate.nodeName === 'string' && candidate.nodeName.trim()
          ? candidate.nodeName.trim()
          : undefined,
      scope,
      to,
    };
  };

  const removeMenu = () => {
    menu?.remove();
    menu = null;
  };

  const positionMenu = () => {
    if (!menu || !activeRange) return;
    const resolvedRange = activeRange.key && activeRange.scope !== 'node'
      ? findMergeTagRangeAtPosition(input.view.state, activeRange.from)
      : null;
    if (activeRange.key && (!resolvedRange || resolvedRange.key !== activeRange.key)) {
      removeMenu();
      return;
    }
    const from = resolvedRange?.from ?? activeRange.from;
    const to = resolvedRange?.to ?? activeRange.to;
    const start = input.view.coordsAtPos(from);
    const end = input.view.coordsAtPos(to);
    const left = Math.min(start.left, end.left);
    const variableMenuOffset = activeRange.key && activeRange.scope !== 'node' ? 52 : 8;
    const top = Math.max(start.bottom, end.bottom) + variableMenuOffset;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.maxWidth = `${Math.min(288, Math.max(220, globalThis.window.innerWidth - 16))}px`;
  };

  const resolveTextRange = (
    currentActive: NonNullable<MergeTagPreviewPluginState['active']>,
  ): { cursor?: number; from: number; scope?: 'row' | 'text'; to: number } | null => {
    if (currentActive.scope === 'node') return null;
    if (!currentActive.key) {
      return {
        cursor: currentActive.cursor,
        from: currentActive.from,
        scope: currentActive.scope === 'row' || currentActive.scope === 'text'
          ? currentActive.scope
          : undefined,
        to: currentActive.to,
      };
    }
    const exactRange = findMergeTagRangeAtPosition(input.view.state, currentActive.from);
    if (!exactRange || exactRange.key !== currentActive.key) return null;
    return {
      from: exactRange.from,
      scope: 'text',
      to: exactRange.to,
    };
  };

  const selectNextVariable = (nextKey: string) => {
    const currentActive = currentActiveRange();
    if (!currentActive) return;
    if (!currentActive.key || currentActive.scope === 'node') return;
    const currentRange = resolveTextRange(currentActive);
    if (!currentRange) return;
    const markType = input.view.state.schema.marks[tixkitMergeTagMarkName];
    if (!markType) return;
    const nextPresentation = variablePresentation(nextKey);
    const nextTo = currentRange.from + nextPresentation.preview.length;
    const transaction = input.view.state.tr.insertText(
      nextPresentation.preview,
      currentRange.from,
      currentRange.to,
    );
    transaction.addMark(
      currentRange.from,
      nextTo,
      markType.create(mergeTagMarkAttrs(nextKey)),
    );
    transaction.setSelection(TextSelection.create(transaction.doc, currentRange.from, nextTo));
    removeMenu();
    transaction.setMeta(mergeTagPreviewPluginKey, { active: null });
    input.view.dispatch(transaction);
    input.view.dom.dispatchEvent(
      new CustomEvent('tixkit-email-variable-select', {
        bubbles: true,
        detail: {
          from: currentRange.from,
          key: nextKey,
          to: nextTo,
          variableKey: nextKey,
        },
      }),
    );
    input.view.focus();
  };

  const isMenuForRange = (range: { from: number; key: string; to: number }) =>
    Boolean(
      menu &&
        menu.dataset.variableKey === range.key &&
        menu.dataset.variableFrom === String(range.from) &&
        menu.dataset.variableTo === String(range.to),
    );

  const openVariableMenu = (mode: 'open' | 'toggle') => {
    const currentActive = currentActiveRange();
    const fallbackActive = !currentActive?.key && lastChipClickKey
      ? { key: lastChipClickKey, from: lastChipClickRange?.from ?? 0, to: lastChipClickRange?.to ?? 0, scope: 'text' as const }
      : null;
    const effectiveActive = currentActive?.key ? currentActive : fallbackActive;
    if (!effectiveActive?.key || effectiveActive.scope === 'node') {
      removeMenu();
      return;
    }
    const exactRange = findMergeTagRangeAtPosition(input.view.state, effectiveActive.from);
    if (!exactRange || exactRange.key !== effectiveActive.key) {
      removeMenu();
      return;
    }
    if (mode === 'toggle' && isMenuForRange(exactRange)) {
      removeMenu();
      return;
    }
    activeRange = {
      ...effectiveActive,
      from: exactRange.from,
      key: exactRange.key,
      scope: 'text',
      to: exactRange.to,
    };
    removeMenu();
    menu = createVariableMenuElement({
      currentKey: exactRange.key,
      mergeTags: input.mergeTags,
      onSelect: selectNextVariable,
    });
    menu.dataset.variableKey = exactRange.key;
    menu.dataset.variableFrom = String(exactRange.from);
    menu.dataset.variableTo = String(exactRange.to);
    document.body.append(menu);
    positionMenu();
  };

  const applyStyle = (
    patch: InlineStyleAttrs,
    requestedActive?: NonNullable<MergeTagPreviewPluginState['active']> | null,
  ) => {
    const currentActive = requestedActive ?? currentActiveRange();
    if (!currentActive || currentActive.scope === 'node') return;
    const currentRange = resolveTextRange(currentActive);
    if (!currentRange) return;
    let styleFrom = currentRange.from;
    let styleTo = currentRange.to;
    if (currentRange.scope === 'row' && currentRange.cursor !== undefined) {
      const wordRange = findWordRangeAtPosition(input.view.state, currentRange.cursor);
      if (wordRange) {
        styleFrom = wordRange.from;
        styleTo = wordRange.to;
      }
    }
    applyInlineStyleToRange({
      cursor: currentRange.cursor,
      from: styleFrom,
      patch,
      scope: currentRange.scope,
      to: styleTo,
      view: input.view,
    });
  };

  const applyAlignment = (
    alignment: InlineTextAlignment,
    requestedActive?: NonNullable<MergeTagPreviewPluginState['active']> | null,
  ) => {
    const currentActive = requestedActive ?? currentActiveRange();
    if (!currentActive) return;
    if (currentActive.scope === 'node') {
      applyNodeAlignmentToRange({
        alignment,
        from: currentActive.from,
        nodeName: currentActive.nodeName,
        view: input.view,
      });
      return;
    }
    const currentRange = resolveTextRange(currentActive);
    if (!currentRange) return;
    applyTextAlignmentToRange({
      alignment,
      cursor: currentRange.cursor,
      from: currentRange.from,
      scope: currentRange.scope,
      to: currentRange.to,
      view: input.view,
    });
  };

  const handleSelectionFormat = (event: Event) => {
    const detail = (event as CustomEvent<{
      alignment?: InlineTextAlignment;
      patch?: InlineStyleAttrs;
      selection?: unknown;
      variableKey?: string;
    }>).detail;
    if (!detail || typeof detail !== 'object') return;
    event.preventDefault();
    const requestedActive = activeRangeFromSelectionDetail(detail.selection);
    if (detail.patch) applyStyle(detail.patch, requestedActive);
    if (detail.alignment) applyAlignment(detail.alignment, requestedActive);
    if (detail.variableKey) selectNextVariable(detail.variableKey);
  };

  const handleVariableMenuOpen = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: 'open' | 'toggle' }>).detail;
    if (detail?.mode !== 'open' && detail?.mode !== 'toggle') return;
    event.preventDefault();
    openVariableMenu(detail.mode);
  };

  const handleSelectionRestore = (event: Event) => {
    const detail = (event as CustomEvent<
      (MergeTagPreviewPluginState['active'] & { focusEditor?: boolean }) | null
    >).detail;
    if (!detail) return;
    const from = Math.max(0, Math.min(detail.from, input.view.state.doc.content.size));
    const to = Math.max(from, Math.min(detail.to, input.view.state.doc.content.size));
    if (from === to) return;
    if (detail.scope === 'node') {
      const node = input.view.state.doc.nodeAt(from);
      if (!node) return;
      let transaction = input.view.state.tr.setMeta(mergeTagPreviewPluginKey, {
        active: {
          from,
          key: null,
          nodeName: detail.nodeName ?? node.type.name,
          scope: 'node',
          to: Math.min(from + node.nodeSize, input.view.state.doc.content.size),
        },
      });
      try {
        transaction = transaction.setSelection(NodeSelection.create(transaction.doc, from));
      } catch {
        // Non-selectable structural nodes still restore the plugin selection state above.
      }
      input.view.dispatch(transaction);
      if (detail.focusEditor !== false) input.view.focus();
      return;
    }
    if (detail.scope === 'row') {
      input.view.dispatch(
        input.view.state.tr.setMeta(mergeTagPreviewPluginKey, {
          active: {
            cursor: detail.cursor,
            from,
            key: null,
            scope: 'row',
            to,
          },
        }),
      );
      if (detail.focusEditor !== false) input.view.focus();
      return;
    }
    const mergeTagRange = detail.key
      ? findMergeTagRangeAtPosition(input.view.state, from)
      : null;
    const active = mergeTagRange
      ? { ...mergeTagRange, cursor: mergeTagRange.from + 1, scope: 'text' as const }
      : { from, key: null as string | null, scope: 'text' as const, to };
    if (!active) return;
    const transaction = input.view.state.tr
      .setSelection(TextSelection.create(input.view.state.doc, active.from, active.to))
      .setMeta(mergeTagPreviewPluginKey, { active });
    input.view.dispatch(transaction);
    if (detail.focusEditor !== false) input.view.focus();
  };

  const update = (active: MergeTagPreviewPluginState['active']) => {
    activeRange = active;
    input.view.dom.dispatchEvent(
      new CustomEvent('tixkit-email-selection-state', {
        bubbles: true,
        detail: activeRange
          ? {
              cursor: activeRange.cursor,
              from: activeRange.from,
              key: activeRange.key,
              nodeName: activeRange.nodeName,
              scope: activeRange.scope,
              style:
                activeRange.scope === 'node'
                  ? {}
                  : activeRange.cursor !== undefined
                    ? inlineStyleAttrsAtCursor(input.view.state, activeRange.cursor, input.view)
                    : selectedInlineStyleAttrsFromView(
                        input.view,
                        activeRange.from,
                        activeRange.to,
                      ),
              to: activeRange.to,
            }
          : null,
      }),
    );
    if (!activeRange) {
      removeMenu();
      return;
    }

    if (activeRange.scope === 'node' || !activeRange.key) {
      removeMenu();
      return;
    }
    if (!menu) {
      return;
    }
    if (
      menu.dataset.variableKey !== activeRange.key ||
      menu.dataset.variableFrom !== String(activeRange.from) ||
      menu.dataset.variableTo !== String(activeRange.to)
    ) {
      removeMenu();
      return;
    }
    positionMenu();
  };

  const handleWindowReposition = () => positionMenu();
  globalThis.window.addEventListener('scroll', handleWindowReposition, true);
  globalThis.window.addEventListener('resize', handleWindowReposition);
  input.view.dom.addEventListener('tixkit-email-selection-format', handleSelectionFormat);
  input.view.dom.addEventListener('tixkit-email-selection-restore', handleSelectionRestore);
  input.view.dom.addEventListener('tixkit-email-variable-menu-open', handleVariableMenuOpen);

  return {
    containsActiveElement: () =>
      Boolean(
        menu &&
        document.activeElement instanceof HTMLElement &&
        menu.contains(document.activeElement),
      ),
    destroy: () => {
      globalThis.window.removeEventListener('scroll', handleWindowReposition, true);
      globalThis.window.removeEventListener('resize', handleWindowReposition);
      input.view.dom.removeEventListener('tixkit-email-selection-format', handleSelectionFormat);
      input.view.dom.removeEventListener('tixkit-email-selection-restore', handleSelectionRestore);
      input.view.dom.removeEventListener('tixkit-email-variable-menu-open', handleVariableMenuOpen);
      removeMenu();
    },
    isConnected: () => Boolean(menu?.isConnected),
    update,
  };
}

export const TixkitMergeTag = Mark.create({
  name: tixkitMergeTagMarkName,
  inclusive: false,

  addAttributes() {
    return {
      key: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-tixkit-merge-tag') ||
          element.getAttribute('data-variable-key') ||
          null,
      },
      kind: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-variable-kind') || null,
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-variable-label') || null,
      },
      preview: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-variable-preview') || null,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-tixkit-merge-tag]' }];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const markAttrs = mark.attrs as {
      key?: unknown;
      kind?: unknown;
      label?: unknown;
      preview?: unknown;
    };
    const key =
      typeof markAttrs.key === 'string' && markAttrs.key.trim()
        ? markAttrs.key.trim()
        : 'recipient.name';
    const presentation = variablePresentation(key);
    const label =
      typeof markAttrs.label === 'string' && markAttrs.label.trim()
        ? markAttrs.label.trim()
        : presentation.label;
    const preview =
      typeof markAttrs.preview === 'string' && markAttrs.preview.trim()
        ? markAttrs.preview.trim()
        : presentation.preview;
    const kind =
      typeof markAttrs.kind === 'string' && markAttrs.kind.trim()
        ? markAttrs.kind.trim()
        : presentation.kind;
    const safeHTMLAttributes = { ...HTMLAttributes };
    delete safeHTMLAttributes.key;
    delete safeHTMLAttributes.kind;
    delete safeHTMLAttributes.label;
    delete safeHTMLAttributes.preview;
    return [
      'span',
      mergeAttributes(safeHTMLAttributes, {
        class: 'tixkit-email-variable-chip',
        'data-tixkit-merge-tag': key,
        'data-variable-key': key,
        'data-variable-kind': kind,
        'data-variable-label': label,
        'data-variable-preview': preview,
        'data-variable-detail': `${label} - ${mergeTagLiteral(key)}`,
      }),
      0,
    ];
  },
});

export const TixkitInlineStyle = Mark.create({
  name: tixkitInlineStyleMarkName,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => element.style.color || null,
      },
      fontSize: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
      },
      fontFamily: {
        default: null,
        parseHTML: (element) => element.style.fontFamily || null,
      },
      lineHeight: {
        default: null,
        parseHTML: (element) => element.style.lineHeight || null,
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-tixkit-inline-style]' },
      {
        tag: 'span[style]',
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;
          return element.style.color ||
            element.style.fontFamily ||
            element.style.fontSize ||
            element.style.lineHeight
            ? null
            : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const safeHTMLAttributes = { ...HTMLAttributes };
    delete safeHTMLAttributes.color;
    delete safeHTMLAttributes.fontFamily;
    delete safeHTMLAttributes.fontSize;
    delete safeHTMLAttributes.lineHeight;
    return [
      'span',
      mergeAttributes(safeHTMLAttributes, {
        'data-tixkit-inline-style': 'true',
        style: inlineStyleMarkStyle(mark.attrs),
      }),
      0,
    ];
  },
});

function createMergeTagPreviewExtension(mergeTags: readonly string[]) {
  return Extension.create({
    name: 'tixkitMergeTagPreview',

    addProseMirrorPlugins() {
      return [
        new Plugin<MergeTagPreviewPluginState>({
          key: mergeTagPreviewPluginKey,
          state: {
            init() {
              return { active: null };
            },
            apply(transaction, pluginState) {
              const meta = transaction.getMeta(mergeTagPreviewPluginKey) as
                | { active?: MergeTagPreviewPluginState['active'] }
                | undefined;
              if (meta && 'active' in meta) return { active: meta.active ?? null };
              if (transaction.selectionSet) {
                if (pluginState.active && (hasActiveEmailBubbleControlInteraction() || Date.now() < chipClickGuardUntil)) {
                  if (
                    pluginState.active.scope === 'row' &&
                    transaction.selection.empty
                  ) {
                    const $from = transaction.selection.$from;
                    if ($from.parent.inlineContent && $from.parent.content.size > 0) {
                      return {
                        active: {
                          ...pluginState.active,
                          cursor: transaction.selection.from,
                          from: $from.start(),
                          to: $from.end(),
                        },
                      };
                    }
                  }
                  // If the cursor moved outside the active merge tag range
                  // during the interaction window, switch to row scope so
                  // word-scoped styling targets the new cursor position.
                  if (
                    pluginState.active.scope === 'text' &&
                    pluginState.active.key &&
                    transaction.selection.empty
                  ) {
                    const mergeTagRange = findMergeTagRangeAtPosition(
                      { doc: transaction.doc } as EditorView['state'],
                      transaction.selection.from,
                    );
                    const cursorInsideMergeTag =
                      mergeTagRange && mergeTagRange.key === pluginState.active.key;
                    if (!cursorInsideMergeTag) {
                      const $from = transaction.selection.$from;
                      if ($from.parent.inlineContent && $from.parent.content.size > 0) {
                        return {
                          active: {
                            cursor: transaction.selection.from,
                            from: $from.start(),
                            key: null,
                            scope: 'row',
                            to: $from.end(),
                          },
                        };
                      }
                    }
                  }
                  return pluginState;
                }
                return { active: null };
              }
              if (!pluginState.active || !transaction.docChanged) return pluginState;
              const from = transaction.mapping.map(pluginState.active.from, -1);
              const to = transaction.mapping.map(pluginState.active.to, 1);
              if (from >= to) return { active: null };
              return {
                active: {
                  ...pluginState.active,
                  from,
                  to,
                },
              };
            },
          },
          appendTransaction() {
            return null;
          },
          props: {
            handleDOMEvents: {
              click(view, event) {
                const target = event.target;
                const token =
                  target instanceof HTMLElement
                    ? target.closest<HTMLElement>('.tixkit-email-variable-chip')
                    : null;
                if (!token) {
                  const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
                  if (!position) return false;
                  view.dispatch(
                    view.state.tr.setMeta(mergeTagPreviewPluginKey, {
                      active: null,
                    }),
                  );
                  return false;
                }
                // If the user has a partial text selection (from a drag),
                // don't snap to the full merge tag - let the selection stand.
                const { selection } = view.state;
                if (!selection.empty && selection.from !== selection.to) {
                  return false;
                }
                const mergeTagKey = token.getAttribute('data-tixkit-merge-tag');
                const approxPos = view.posAtDOM(token, 0);
                const markType = view.state.schema.marks[tixkitMergeTagMarkName];
                let bestRange: { from: number; key: string; to: number } | null = null;
                let bestDist = Infinity;
                if (mergeTagKey && markType) {
                  view.state.doc.nodesBetween(0, view.state.doc.content.size, (node, pos) => {
                    if (!node.isText) return true;
                    const mark = node.marks.find((m) => m.type === markType);
                    if (mark && (mark.attrs as { key?: string }).key === mergeTagKey) {
                      const dist = Math.abs(pos - approxPos);
                      if (dist < bestDist) {
                        bestDist = dist;
                        bestRange = { from: pos, key: mergeTagKey, to: pos + node.nodeSize };
                      }
                    }
                    return true;
                  });
                }
                const range = bestRange ?? findMergeTagRangeAtPosition(view.state, approxPos);
                if (!range) return false;
                const { from, key, to } = range;
                chipClickGuardUntil = Date.now() + 500;
                lastChipClickKey = key;
                lastChipClickRange = { from, to };
                view.dispatch(
                  view.state.tr.setMeta(mergeTagPreviewPluginKey, {
                    active: { cursor: from + 1, from, key, scope: 'text', to },
                  }),
                );
                selectVariableToken({ from, key, to, view });
                view.dom.dispatchEvent(
                  new CustomEvent('tixkit-email-variable-activate', {
                    bubbles: true,
                    detail: { from, key, to },
                  }),
                );
                event.preventDefault();
                window.setTimeout(() => {
                  const closeOnOutsidePointerDown = (outsideEvent: PointerEvent) => {
                    if (
                      outsideEvent.target instanceof HTMLElement &&
                      outsideEvent.target.closest('.tixkit-email-variable-chip')
                    ) {
                      return;
                    }
                    if (
                      outsideEvent.target instanceof HTMLElement &&
                      outsideEvent.target.closest('.tixkit-email-variable-chip__menu')
                    ) {
                      return;
                    }
                    if (
                      outsideEvent.target instanceof HTMLElement &&
                      outsideEvent.target.closest('[data-re-bubble-menu]')
                    ) {
                      return;
                    }
                    if (isEmailInspectorTarget(outsideEvent.target)) return;
                    view.dispatch(
                      view.state.tr.setMeta(mergeTagPreviewPluginKey, {
                        active: null,
                      }),
                    );
                    document.removeEventListener('pointerdown', closeOnOutsidePointerDown);
                  };
                  document.addEventListener('pointerdown', closeOnOutsidePointerDown);
                }, 0);
                return true;
              },
              keydown(view, event) {
                if (event.key === 'Escape') {
                  lastChipClickKey = null;
                  lastChipClickRange = null;
                  view.dispatch(
                    view.state.tr.setMeta(mergeTagPreviewPluginKey, {
                      active: null,
                    }),
                  );
                  view.dom.dispatchEvent(
                    new CustomEvent('tixkit-email-selection-clear', {
                      bubbles: true,
                    }),
                  );
                  return true;
                }
                if (event.key !== 'Enter' && event.key !== ' ') return false;
                const range = findMergeTagRangeAtPosition(view.state, view.state.selection.from);
                if (!range) return false;
                event.preventDefault();
                const { from, key, to } = range;
                selectVariableToken({ from, key, to, view });
                view.dom.dispatchEvent(
                  new CustomEvent('tixkit-email-variable-activate', {
                    bubbles: true,
                    detail: { from, key, to },
                  }),
                );
                view.dispatch(
                  view.state.tr.setMeta(mergeTagPreviewPluginKey, {
                    active: { cursor: from + 1, from, key, scope: 'text', to },
                  }),
                );
                return true;
              },
            },
            decorations(state) {
              const decorations: Decoration[] = [];
              const pluginState = mergeTagPreviewPluginKey.getState(state);
              const activeSelection =
                findSelectedTextRange(state) ??
                findCursorMergeTagRange(state) ??
                findCursorTextRowRange(state) ??
                findSelectedAlignableNodeRange(state);
              const active = pluginState?.active ?? activeSelection;
              if (active?.key) {
                const activeRange = findMergeTagRangeAtPosition(state, active.from);
                if (activeRange && activeRange.key === active.key) {
                  decorations.push(
                    Decoration.inline(activeRange.from, activeRange.to, {
                      class: 'tixkit-email-variable-chip--active',
                      'data-editing': 'true',
                    }),
                  );
                }
              }
              return DecorationSet.create(state.doc, decorations);
            },
          },
          view(view) {
            const floatingMenu = createFloatingVariableMenu({ mergeTags, view });
            let previousActive: MergeTagPreviewPluginState['active'] | undefined;
            let convertTimer: number | undefined;
            const scheduleRawMergeTagConversion = (currentView: EditorView) => {
              if (convertTimer) window.clearTimeout(convertTimer);
              convertTimer = window.setTimeout(() => {
                convertTimer = undefined;
                replaceRawMergeTagsInView(currentView);
              }, 120);
            };
            return {
              destroy() {
                if (convertTimer) window.clearTimeout(convertTimer);
                floatingMenu.destroy();
              },
              update(currentView, previousState) {
                if (previousState.doc !== currentView.state.doc) {
                  scheduleRawMergeTagConversion(currentView);
                }
                let active =
                  mergeTagPreviewPluginKey.getState(currentView.state)?.active ??
                  findSelectedTextRange(currentView.state) ??
                  findCursorMergeTagRange(currentView.state) ??
                  findCursorTextRowRange(currentView.state) ??
                  findSelectedAlignableNodeRange(currentView.state);
                if (
                  !active &&
                  previousActive &&
                  (floatingMenu.containsActiveElement() || hasActiveEmailBubbleControlInteraction())
                ) {
                  active = previousActive;
                }
                if (
                  previousActive &&
                  active &&
                  previousActive.from === active.from &&
                  previousActive.to === active.to &&
                  previousActive.key === active.key &&
                  previousActive.nodeName === active.nodeName &&
                  previousActive.scope === active.scope &&
                  floatingMenu.isConnected()
                ) {
                  return;
                }
                previousActive = active;
                floatingMenu.update(active);
              },
            };
          },
        }),
      ];
    },
  });
}

export function createBrandEmailEditorTheme(
  brandTheme?: BrandEmailEditorThemeInput,
): EditorThemeInput {
  const preset = brandTheme?.preset ?? 'brand';
  const primaryColor = brandTheme?.primaryColor?.trim() || '#111827';
  const fontFamily =
    brandTheme?.fontFamily?.trim() ||
    'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const radius = cssLength(brandTheme?.radius, '8px');
  if (preset === 'minimal') {
    return createTheme({
      body: {
        backgroundColor: '#ffffff',
        color: '#18181b',
        fontFamily,
        width: '600px',
        padding: '24px',
        borderRadius: '0px',
      },
      button: {
        backgroundColor: '#18181b',
        borderRadius: '6px',
        color: '#ffffff',
        fontSize: '14px',
        fontWeight: '600',
        padding: '10px 16px',
        textDecoration: 'none',
      },
      h1: {
        color: '#18181b',
        fontSize: '28px',
        lineHeight: '1.15',
        fontWeight: '700',
      },
      h2: {
        color: '#27272a',
        fontSize: '20px',
        lineHeight: '1.3',
        fontWeight: '650',
      },
      paragraph: {
        color: '#3f3f46',
        fontSize: '15px',
        lineHeight: '1.65',
      },
    });
  }
  if (preset === 'basic') {
    return createTheme({
      body: {
        backgroundColor: '#f4f4f5',
        color: '#18181b',
        fontFamily,
        width: '600px',
        padding: '32px',
        borderRadius: '10px',
      },
      button: {
        backgroundColor: primaryColor,
        borderRadius: radius,
        color: '#ffffff',
        fontSize: '14px',
        fontWeight: '600',
        padding: '12px 18px',
        textDecoration: 'none',
      },
      h1: {
        color: primaryColor,
        fontSize: '30px',
        lineHeight: '1.15',
        fontWeight: '700',
      },
      h2: {
        color: '#18181b',
        fontSize: '21px',
        lineHeight: '1.28',
        fontWeight: '650',
      },
      paragraph: {
        color: '#3f3f46',
        fontSize: '15px',
        lineHeight: '1.7',
      },
    });
  }
  return createTheme({
    body: {
      backgroundColor: '#ffffff',
      color: '#18181b',
      fontFamily,
      width: '600px',
      padding: '32px',
      borderRadius: cssLength(brandTheme?.radius, '12px'),
    },
    button: {
      backgroundColor: primaryColor,
      borderRadius: radius,
      color: '#ffffff',
      fontSize: '14px',
      fontWeight: '600',
      padding: '12px 18px',
      textDecoration: 'none',
    },
    h1: {
      color: primaryColor,
      fontSize: '32px',
      lineHeight: '1.12',
      fontWeight: '700',
    },
    h2: {
      color: '#18181b',
      fontSize: '22px',
      lineHeight: '1.25',
      fontWeight: '650',
    },
    paragraph: {
      color: '#3f3f46',
      fontSize: '15px',
      lineHeight: '1.7',
    },
  });
}

export function useEmailEditorExtensions(input: {
  mergeTags: readonly string[];
  theme: EditorThemeInput;
}): EmailEditorProps['extensions'] {
  return React.useMemo(
    () => [
      StarterKit.configure(emailEditorStarterKitOptions),
      TixkitHeading,
      TixkitInlineStyle,
      TixkitMergeTag,
      createMergeTagPreviewExtension(input.mergeTags),
      EmailTheming.configure({ theme: input.theme }),
    ],
    [input.mergeTags, input.theme],
  );
}

export function createEmailSlashCommands(input: {
  mergeTags: readonly string[];
  brandName: string;
}): SlashCommandItem[] {
  const labelCounts = input.mergeTags.reduce<Record<string, number>>((counts, tag) => {
    const label = variablePresentation(tag).label;
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const customItems: SlashCommandItem[] = [
    {
      title: 'Image upload',
      description: 'Upload an image into this email',
      icon: React.createElement(Image, { className: 'size-4' }),
      category: 'Media',
      searchTerms: ['image', 'upload', 'asset', 'logo'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run();
        editor.commands.uploadImage();
      },
    },
    {
      title: 'Variable',
      description: 'Insert a merge tag placeholder',
      icon: React.createElement(Variable, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['merge', 'tag', 'personalize', 'variable'],
      command: ({ editor, range }) => {
        const firstTag = input.mergeTags[0] ?? 'recipient.name';
        editor.chain().focus().deleteRange(range).insertContent(`{{${firstTag}}}`).run();
      },
    },
    {
      title: 'Ticket QR',
      description: 'Add the attendee ticket QR image',
      icon: React.createElement(QrCode, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['qr', 'ticket', 'code', 'check in'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .setImage({
            src: mergeTagCanvasAttributeValue('ticket.qrCodeUrl'),
            alt: 'Ticket QR code',
            alignment: 'center',
          })
          .run();
      },
    },
    {
      title: 'Ticket summary',
      description: 'Ticket type and order total',
      icon: React.createElement(Ticket, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['ticket', 'order', 'summary'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text: '{{ticket.type}} - {{order.total}}' }],
          })
          .run();
      },
    },
    {
      title: 'Event date',
      description: 'Insert the event date and time',
      icon: React.createElement(CalendarDays, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['date', 'time', 'event', 'schedule'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text: '{{event.startsAt}}' }],
          })
          .run();
      },
    },
    {
      title: 'Venue',
      description: 'Insert the venue name',
      icon: React.createElement(MapPin, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['venue', 'map', 'location'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text: '{{event.venueName}}' }],
          })
          .run();
      },
    },
    {
      title: 'Social Links',
      description: 'Add share and support links',
      icon: React.createElement(Share2, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['social', 'links', 'follow', 'share', 'support'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Follow us: ' },
              {
                type: 'text',
                text: 'Event page',
                marks: [{ type: 'link', attrs: { href: '{{event.publicUrl}}' } }],
              },
              { type: 'text', text: ' | ' },
              {
                type: 'text',
                text: 'Support',
                marks: [{ type: 'link', attrs: { href: '{{brand.supportUrl}}' } }],
              },
            ],
          })
          .run();
      },
    },
    {
      title: 'Unsubscribe Footer',
      description: 'Add a brand footer with an unsubscribe link',
      icon: React.createElement(Ticket, { className: 'size-4' }),
      category: 'Tixkit',
      searchTerms: ['unsubscribe', 'footer', 'bulk', 'compliance'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent([
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: `You are receiving this because you subscribed to ${input.brandName} updates.`,
                },
              ],
            },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Manage preferences: ' },
                {
                  type: 'text',
                  text: '{{brand.supportUrl}}',
                },
              ],
            },
          ])
          .run();
      },
    },
    {
      title: 'HTML',
      description: 'Insert an HTML code block for review',
      icon: React.createElement(Code, { className: 'size-4' }),
      category: 'Advanced',
      searchTerms: ['html', 'code'],
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: 'codeBlock',
            attrs: { language: 'html' },
            content: [{ type: 'text', text: '<p>{{event.title}}</p>' }],
          })
          .run();
      },
    },
  ];

  return [
    ...defaultSlashCommands,
    imageSlashCommand,
    ...customItems,
    ...input.mergeTags.map((tag): SlashCommandItem => {
      const presentation = variablePresentation(tag);
      const title =
        (labelCounts[presentation.label] ?? 0) > 1
          ? `${presentation.label} (${tag})`
          : presentation.label;
      return {
        title,
        description: presentation.preview,
        icon: React.createElement(Variable, { className: 'size-4' }),
        category: 'Variables',
        searchTerms: [
          'merge',
          'tag',
          'variable',
          tag,
          presentation.label,
          presentation.preview,
          presentation.kind,
        ],
        command: ({ editor, range }) => {
          editor.chain().focus().deleteRange(range).insertContent(`{{${tag}}}`).run();
        },
      };
    }),
  ];
}
