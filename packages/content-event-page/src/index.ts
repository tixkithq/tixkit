import type { JSONContent } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import StarterKit from '@tiptap/starter-kit';
import { renderToHTMLString } from '@tiptap/static-renderer/pm/html-string';
import {
  validateContentVersion,
  type ContentValidationIssue,
  type ContentValidationResult,
} from '@tixkit/content-core';
import {
  isAllowedDestination,
  renderMergeTags,
  validateMergeTags,
  type MergeTagContext,
} from '@tixkit/domain';

export const TIPTAP_EVENT_PAGE_PROVIDER = '@tiptap/core' as const;
export const EVENT_PAGE_SCHEMA_VERSION = 1 as const;

export type EventPageDiscoveryMetadata = {
  summary: string;
  category?: string;
  tags: string[];
  coverImageUrl?: string;
  socialImageUrl?: string;
  seoTitle?: string;
  seoDescription?: string;
};

export type EventPageSettings = {
  locale: string;
  publicPath?: string;
  ticketCtaLabel: string;
  discovery: EventPageDiscoveryMetadata;
};

export type EventPageDocument = {
  schemaVersion: typeof EVENT_PAGE_SCHEMA_VERSION;
  editor: {
    provider: typeof TIPTAP_EVENT_PAGE_PROVIDER;
    document: JSONContent;
  };
  settings: EventPageSettings;
  blocks: EventPageBlock[];
};

export type EventPageBlock =
  | { type: 'rich_text'; id: string; content: JSONContent }
  | {
      type: 'hero';
      id: string;
      headline: string;
      eyebrow?: string;
      body?: string;
      imageUrl?: string;
      imageAlt?: string;
      ctaLabel?: string;
      ctaUrl?: string;
    }
  | { type: 'event_details'; id: string; title: string; items: EventPageDetailItem[] }
  | { type: 'tickets'; id: string; title: string; body?: string; ctaLabel?: string }
  | { type: 'products'; id: string; title: string; body?: string; productIds: string[] }
  | { type: 'schedule'; id: string; title: string; items: EventPageScheduleItem[] }
  | {
      type: 'venue_map';
      id: string;
      title: string;
      venueName: string;
      address?: string;
      mapUrl?: string;
    }
  | { type: 'faq'; id: string; title: string; items: EventPageFaqItem[] }
  | { type: 'sponsors'; id: string; title: string; items: EventPageLogoItem[] }
  | { type: 'speakers'; id: string; title: string; items: EventPagePersonItem[] }
  | { type: 'button'; id: string; label: string; url: string; style?: 'primary' | 'secondary' }
  | { type: 'divider'; id: string }
  | { type: 'social_links'; id: string; title?: string; links: EventPageLink[] }
  | { type: 'custom_embed'; id: string; html: string; allowUnsafeEmbed: boolean };

export type EventPageDetailItem = {
  label: string;
  value: string;
};

export type EventPageScheduleItem = {
  title: string;
  startsAt: string;
  endsAt?: string;
  timezone?: string;
  venueName?: string;
};

export type EventPageFaqItem = {
  question: string;
  answer: string;
};

export type EventPageLogoItem = {
  name: string;
  url?: string;
  imageUrl?: string;
  imageAlt?: string;
};

export type EventPagePersonItem = {
  name: string;
  role?: string;
  bio?: string;
  imageUrl?: string;
  imageAlt?: string;
};

export type EventPageLink = {
  label: string;
  url: string;
};

export type EventPageTicket = {
  id: string;
  name: string;
  description?: string;
  status?: 'active' | 'sold_out' | 'hidden';
  priceLabel?: string;
  available?: number;
};

export type EventPageProduct = {
  id: string;
  name: string;
  description?: string;
  priceLabel?: string;
};

export type EventPageRenderContext = MergeTagContext & {
  tickets?: EventPageTicket[];
  products?: EventPageProduct[];
};

export type EventPageHeadlessBlock = {
  type: EventPageBlock['type'];
  id: string;
  title?: string;
  text?: string;
  html?: string;
  imageUrl?: string;
  imageAlt?: string;
  links?: EventPageLink[];
  items?: unknown[];
};

export type EventPageDiscoveryCard = {
  title: string;
  summary: string;
  category?: string;
  tags: string[];
  imageUrl?: string;
  startsAt?: string;
  venueName?: string;
  publicPath?: string;
};

export type RenderedEventPage = {
  html: string;
  text: string;
  headless: EventPageHeadlessBlock[];
  discovery: EventPageDiscoveryCard;
  validation: ContentValidationResult;
};

export type EventPageValidationOptions = {
  allowPrivateLinks?: boolean;
  allowUnsafeEmbeds?: boolean;
};

const tiptapExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    link: false,
    codeBlock: false,
    horizontalRule: false,
  }),
  Link.configure({
    openOnClick: false,
    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
  }),
  Image.configure({
    allowBase64: false,
  }),
];

export function createDefaultEventPageDocument(input: {
  eventId: string;
  eventTitle: string;
  eventDescription?: string | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  timezone?: string | null;
  venue?: {
    name?: string | null;
    address?: string | null;
    city?: string | null;
    region?: string | null;
    country?: string | null;
    mapUrl?: string | null;
  } | null;
  brandName?: string | null;
  publicUrl?: string | null;
  checkoutUrl?: string | null;
  coverImageUrl?: string | null;
  category?: string | null;
  tags?: string[];
}): EventPageDocument {
  const startsAt = isoOrTemplate(input.startsAt, '{{event.startsAt}}');
  const endsAt = isoOrTemplate(input.endsAt, '{{event.endsAt}}');
  const venueName = input.venue?.name?.trim() || '{{event.venueName}}';
  const summary = firstNonEmpty(
    input.eventDescription,
    `Tickets and details for ${input.eventTitle}.`,
  );
  const checkoutUrl = input.checkoutUrl?.trim() || '{{event.checkoutUrl}}';

  return {
    schemaVersion: EVENT_PAGE_SCHEMA_VERSION,
    editor: {
      provider: TIPTAP_EVENT_PAGE_PROVIDER,
      document: docFromText(summary),
    },
    settings: {
      locale: 'en',
      publicPath: input.publicUrl ?? undefined,
      ticketCtaLabel: 'Get tickets',
      discovery: {
        summary,
        category: input.category ?? undefined,
        tags: input.tags ?? [],
        coverImageUrl: input.coverImageUrl ?? undefined,
        socialImageUrl: input.coverImageUrl ?? undefined,
        seoTitle: input.eventTitle,
        seoDescription: summary,
      },
    },
    blocks: [
      {
        type: 'hero',
        id: 'hero',
        eyebrow: input.brandName ?? '{{brand.name}}',
        headline: input.eventTitle,
        body: summary,
        imageUrl: input.coverImageUrl ?? undefined,
        imageAlt: input.coverImageUrl ? `${input.eventTitle} cover image` : undefined,
        ctaLabel: 'Get tickets',
        ctaUrl: checkoutUrl,
      },
      {
        type: 'event_details',
        id: 'details',
        title: 'Event details',
        items: [
          { label: 'Starts', value: startsAt },
          ...(endsAt ? [{ label: 'Ends', value: endsAt }] : []),
          { label: 'Timezone', value: input.timezone ?? '{{event.timezone}}' },
          { label: 'Venue', value: venueName },
        ],
      },
      {
        type: 'tickets',
        id: 'tickets',
        title: 'Tickets',
        body: 'Choose your tickets and continue through secure checkout.',
        ctaLabel: 'Get tickets',
      },
      {
        type: 'schedule',
        id: 'schedule',
        title: 'Schedule',
        items: [
          {
            title: input.eventTitle,
            startsAt,
            endsAt,
            timezone: input.timezone ?? undefined,
            venueName,
          },
        ],
      },
      {
        type: 'venue_map',
        id: 'venue',
        title: 'Venue',
        venueName,
        address: formatAddress(input.venue),
        mapUrl: input.venue?.mapUrl ?? undefined,
      },
      {
        type: 'faq',
        id: 'faq',
        title: 'FAQ',
        items: [
          {
            question: 'How do I get my tickets?',
            answer:
              'Tickets are delivered by email after checkout and can be opened from your confirmation page.',
          },
        ],
      },
    ],
  };
}

export function validateEventPageDocument(
  document: EventPageDocument,
  options: EventPageValidationOptions = {},
): ContentValidationResult {
  const issues: ContentValidationIssue[] = [];

  if (document.schemaVersion !== EVENT_PAGE_SCHEMA_VERSION) {
    issues.push({
      code: 'unsupported_schema_version',
      message: `Event page schema ${document.schemaVersion} is not supported`,
      severity: 'error',
      field: 'schemaVersion',
    });
  }

  if (document.editor.provider !== TIPTAP_EVENT_PAGE_PROVIDER) {
    issues.push({
      code: 'unsupported_editor_provider',
      message: 'Event pages must use the TipTap event-page schema',
      severity: 'error',
      field: 'editor.provider',
    });
  }

  if (!document.blocks.some((block) => block.type === 'hero')) {
    issues.push({
      code: 'missing_hero',
      message: 'Event pages require a hero block before publishing',
      severity: 'error',
      field: 'blocks.hero',
    });
  }
  if (!document.blocks.some((block) => block.type === 'tickets')) {
    issues.push({
      code: 'missing_tickets',
      message: 'Event pages require a tickets block before publishing',
      severity: 'error',
      field: 'blocks.tickets',
    });
  }

  issues.push(...validateTipTapDocument(document.editor.document, 'editor.document'));
  for (const [index, block] of document.blocks.entries()) {
    issues.push(...validateBlock(block, index, options));
  }

  const strings = collectStrings(document).join('\n');
  const base = validateContentVersion(
    {
      renderedHtml: strings,
      renderedText: strings,
      contentJson: document,
    },
    'event_page',
  );
  issues.push(...base.issues);

  const uniqueIssues = dedupeIssues(issues);
  return {
    valid: uniqueIssues.every((issue) => issue.severity !== 'error'),
    severity: uniqueIssues.some((issue) => issue.severity === 'error') ? 'error' : 'warning',
    issues: uniqueIssues,
  };
}

export function renderEventPageDocument(
  document: EventPageDocument,
  context: EventPageRenderContext,
  options: EventPageValidationOptions = {},
): RenderedEventPage {
  const validation = validateEventPageDocument(document, options);
  if (!validation.valid) {
    return {
      html: '',
      text: '',
      headless: [],
      discovery: discoveryCard(document, context),
      validation,
    };
  }

  const headless = document.blocks.map((block) => renderHeadlessBlock(block, context, options));
  const html = `<div class="tixkit-event-page" data-schema-version="${EVENT_PAGE_SCHEMA_VERSION}">${headless
    .map((block) => block.html ?? '')
    .join('')}</div>`;
  return {
    html,
    text: toPlainText(headless),
    headless,
    discovery: discoveryCard(document, context),
    validation,
  };
}

export function sanitizeEventPageHtml(html: string): string {
  return html
    .replace(/<iframe\b(?=[^>]*\ssrcdoc\b)[\s\S]*?<\/iframe>/gi, '')
    .replace(
      /<(script|object|embed|form|svg|math|base|link|meta|style|template)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<(script|object|embed|form|svg|math|base|link|meta|style|template)\b[^>]*\/?>/gi, '')
    .replace(/[\s/]+on[a-z][\w:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]+))?/gi, '')
    .replace(/[\s/]+(srcdoc|style)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi, '')
    .replace(
      /[\s/]+(href|src|data|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi,
      (attribute: string, _name: string, rawValue: string) =>
        hasUnsafeHtmlUrlScheme(rawValue) ? '' : attribute,
    );
}

function hasUnsafeHtmlUrlScheme(rawValue: string): boolean {
  const value = stripAttributeQuotes(rawValue)
    .replace(
      /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));?/gi,
      (_entity, hex, decimal, named) => {
        if (hex) return htmlCodePointEntity(hex, 16);
        if (decimal) return htmlCodePointEntity(decimal, 10);
        return namedHtmlEntity(named);
      },
    )
    .split('')
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .toLowerCase();
  return /^(?:javascript|data|file):/.test(value);
}

function stripAttributeQuotes(rawValue: string): string {
  const first = rawValue[0];
  const last = rawValue[rawValue.length - 1];
  return (first === '"' || first === "'" || first === '`') && first === last
    ? rawValue.slice(1, -1)
    : rawValue;
}

function htmlCodePointEntity(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return '';
  }
  return String.fromCodePoint(codePoint);
}

function namedHtmlEntity(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === 'colon') return ':';
  if (normalized === 'tab') return '\t';
  if (normalized === 'newline') return '\n';
  if (normalized === 'amp') return '&';
  if (normalized === 'lt') return '<';
  if (normalized === 'gt') return '>';
  if (normalized === 'quot') return '"';
  if (normalized === 'apos') return "'";
  return `&${name};`;
}

export function normalizeEventPageDocument(value: unknown): EventPageDocument | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== EVENT_PAGE_SCHEMA_VERSION) return undefined;
  const editor = value.editor;
  if (
    !isRecord(editor) ||
    editor.provider !== TIPTAP_EVENT_PAGE_PROVIDER ||
    !isRecord(editor.document)
  ) {
    return undefined;
  }
  if (!isRecord(value.settings) || !Array.isArray(value.blocks)) return undefined;
  return value as EventPageDocument;
}

function renderHeadlessBlock(
  block: EventPageBlock,
  context: EventPageRenderContext,
  options: EventPageValidationOptions,
): EventPageHeadlessBlock {
  switch (block.type) {
    case 'hero': {
      const title = renderPlain(block.headline, context);
      const body = block.body ? renderPlain(block.body, context) : undefined;
      const imageUrl = block.imageUrl
        ? safeRenderedUrl(block.imageUrl, context, options)
        : undefined;
      const ctaUrl = block.ctaUrl ? safeRenderedUrl(block.ctaUrl, context, options) : undefined;
      const html = [
        `<section class="tk-ep-hero" data-block-id="${escapeAttr(block.id)}">`,
        block.eyebrow
          ? `<p class="tk-ep-eyebrow">${escapeHtml(renderPlain(block.eyebrow, context))}</p>`
          : '',
        `<h1>${escapeHtml(title)}</h1>`,
        body ? `<p>${escapeHtml(body)}</p>` : '',
        imageUrl
          ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeAttr(renderPlain(block.imageAlt ?? '', context))}" loading="lazy" />`
          : '',
        block.ctaLabel && ctaUrl
          ? `<a class="tk-ep-button" href="${escapeAttr(ctaUrl)}">${escapeHtml(renderPlain(block.ctaLabel, context))}</a>`
          : '',
        '</section>',
      ].join('');
      return {
        type: block.type,
        id: block.id,
        title,
        text: body,
        html,
        imageUrl,
        imageAlt: block.imageAlt,
      };
    }
    case 'rich_text': {
      const html = `<section class="tk-ep-rich-text" data-block-id="${escapeAttr(block.id)}">${sanitizeEventPageHtml(renderTipTap(block.content, context))}</section>`;
      return { type: block.type, id: block.id, html, text: stripTags(html) };
    }
    case 'event_details': {
      const items = block.items.map((item) => ({
        label: renderPlain(item.label, context),
        value: renderPlain(item.value, context),
      }));
      const html = `<section class="tk-ep-details" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2><dl>${items
        .map(
          (item) =>
            `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`,
        )
        .join('')}</dl></section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        items,
      };
    }
    case 'tickets': {
      const tickets = (context.tickets ?? []).filter((ticket) => ticket.status !== 'hidden');
      const checkoutUrl = context.event?.checkoutUrl
        ? safeRenderedUrl(context.event.checkoutUrl, context, options)
        : undefined;
      const html = `<section class="tk-ep-tickets" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2>${block.body ? `<p>${escapeHtml(renderPlain(block.body, context))}</p>` : ''}<ul>${tickets
        .map(
          (ticket) =>
            `<li><strong>${escapeHtml(ticket.name)}</strong>${ticket.description ? `<span>${escapeHtml(ticket.description)}</span>` : ''}${ticket.priceLabel ? `<span>${escapeHtml(ticket.priceLabel)}</span>` : ''}</li>`,
        )
        .join(
          '',
        )}</ul>${block.ctaLabel && checkoutUrl ? `<a class="tk-ep-button" href="${escapeAttr(checkoutUrl)}">${escapeHtml(renderPlain(block.ctaLabel, context))}</a>` : ''}</section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        text: block.body ? renderPlain(block.body, context) : undefined,
        html,
        items: tickets,
      };
    }
    case 'products': {
      const productIds = new Set(block.productIds);
      const products = (context.products ?? []).filter((product) => productIds.has(product.id));
      const html = `<section class="tk-ep-products" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2>${block.body ? `<p>${escapeHtml(renderPlain(block.body, context))}</p>` : ''}<ul>${products
        .map(
          (product) =>
            `<li><strong>${escapeHtml(product.name)}</strong>${product.description ? `<span>${escapeHtml(product.description)}</span>` : ''}${product.priceLabel ? `<span>${escapeHtml(product.priceLabel)}</span>` : ''}</li>`,
        )
        .join('')}</ul></section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        items: products,
      };
    }
    case 'schedule': {
      const items = block.items.map((item) => ({
        title: renderPlain(item.title, context),
        startsAt: renderPlain(item.startsAt, context),
        endsAt: item.endsAt ? renderPlain(item.endsAt, context) : undefined,
        timezone: item.timezone ? renderPlain(item.timezone, context) : undefined,
        venueName: item.venueName ? renderPlain(item.venueName, context) : undefined,
      }));
      const html = `<section class="tk-ep-schedule" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2><ol>${items
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.title)}</strong><time>${escapeHtml(item.startsAt)}</time>${item.venueName ? `<span>${escapeHtml(item.venueName)}</span>` : ''}</li>`,
        )
        .join('')}</ol></section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        items,
      };
    }
    case 'venue_map': {
      const mapUrl = block.mapUrl ? safeRenderedUrl(block.mapUrl, context, options) : undefined;
      const html = `<section class="tk-ep-venue" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2><p><strong>${escapeHtml(renderPlain(block.venueName, context))}</strong></p>${block.address ? `<p>${escapeHtml(renderPlain(block.address, context))}</p>` : ''}${mapUrl ? `<a href="${escapeAttr(mapUrl)}">Open map</a>` : ''}</section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        links: mapUrl ? [{ label: 'Open map', url: mapUrl }] : [],
      };
    }
    case 'faq': {
      const items = block.items.map((item) => ({
        question: renderPlain(item.question, context),
        answer: renderPlain(item.answer, context),
      }));
      const html = `<section class="tk-ep-faq" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2>${items
        .map(
          (item) =>
            `<details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`,
        )
        .join('')}</section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        items,
      };
    }
    case 'sponsors':
    case 'speakers': {
      const items = block.items.map((item) => renderItem(item, context, options));
      const html = `<section class="tk-ep-${block.type}" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(renderPlain(block.title, context))}</h2><ul>${items
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.name)}</strong>${item.role ? `<span>${escapeHtml(item.role)}</span>` : ''}${item.bio ? `<p>${escapeHtml(item.bio)}</p>` : ''}${item.url ? `<a href="${escapeAttr(item.url)}">Open</a>` : ''}${item.imageUrl ? `<img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.imageAlt ?? item.name)}" loading="lazy" />` : ''}</li>`,
        )
        .join('')}</ul></section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        html,
        items,
      };
    }
    case 'button': {
      const url = safeRenderedUrl(block.url, context, options);
      const html = `<section class="tk-ep-action" data-block-id="${escapeAttr(block.id)}"><a class="tk-ep-button tk-ep-button-${escapeAttr(block.style ?? 'primary')}" href="${escapeAttr(url)}">${escapeHtml(renderPlain(block.label, context))}</a></section>`;
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.label, context),
        html,
        links: [{ label: renderPlain(block.label, context), url }],
      };
    }
    case 'divider':
      return {
        type: block.type,
        id: block.id,
        html: `<hr class="tk-ep-divider" data-block-id="${escapeAttr(block.id)}" />`,
      };
    case 'social_links': {
      const links = block.links.map((link) => ({
        label: renderPlain(link.label, context),
        url: safeRenderedUrl(link.url, context, options),
      }));
      const html = `<section class="tk-ep-social" data-block-id="${escapeAttr(block.id)}">${block.title ? `<h2>${escapeHtml(renderPlain(block.title, context))}</h2>` : ''}<ul>${links
        .map((link) => `<li><a href="${escapeAttr(link.url)}">${escapeHtml(link.label)}</a></li>`)
        .join('')}</ul></section>`;
      return {
        type: block.type,
        id: block.id,
        title: block.title ? renderPlain(block.title, context) : undefined,
        html,
        links,
      };
    }
    case 'custom_embed': {
      const html =
        options.allowUnsafeEmbeds && block.allowUnsafeEmbed
          ? `<section class="tk-ep-embed" data-block-id="${escapeAttr(block.id)}">${sanitizeEventPageHtml(block.html)}</section>`
          : '';
      return { type: block.type, id: block.id, html };
    }
  }
}

function renderTipTap(content: JSONContent, context: MergeTagContext): string {
  const renderedContent = renderMergeTagsInJson(content, context);
  return renderToHTMLString({ extensions: tiptapExtensions, content: renderedContent });
}

function renderMergeTagsInJson(value: JSONContent, context: MergeTagContext): JSONContent {
  const next: JSONContent = { ...value };
  if (typeof next.text === 'string') {
    next.text = renderMergeTags(next.text, context, { channel: 'email', escape: 'plain' });
  }
  if (next.attrs && isRecord(next.attrs)) {
    next.attrs = Object.fromEntries(
      Object.entries(next.attrs).map(([key, attr]) => [
        key,
        typeof attr === 'string'
          ? renderMergeTags(attr, context, { channel: 'email', escape: 'plain' })
          : attr,
      ]),
    );
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map((child) => renderMergeTagsInJson(child, context));
  }
  return next;
}

function validateTipTapDocument(value: JSONContent, field: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  walkTipTap(value, field, issues);
  return issues;
}

function walkTipTap(value: JSONContent, field: string, issues: ContentValidationIssue[]): void {
  const allowedNodes = new Set([
    'doc',
    'paragraph',
    'text',
    'heading',
    'bulletList',
    'orderedList',
    'listItem',
    'blockquote',
    'hardBreak',
    'image',
  ]);
  const allowedMarks = new Set(['bold', 'italic', 'strike', 'link', 'code']);
  if (value.type && !allowedNodes.has(value.type)) {
    issues.push({
      code: 'unsupported_tiptap_node',
      message: `TipTap node ${value.type} is not allowed in event pages`,
      severity: 'error',
      field,
    });
  }
  if (value.type === 'heading') {
    const level = isRecord(value.attrs) ? Number(value.attrs.level) : 0;
    if (![1, 2, 3].includes(level)) {
      issues.push({
        code: 'unsupported_heading_level',
        message: 'Event-page headings are limited to h1, h2, and h3',
        severity: 'error',
        field,
      });
    }
  }
  if (Array.isArray(value.marks)) {
    for (const mark of value.marks) {
      if (!mark.type || !allowedMarks.has(mark.type)) {
        issues.push({
          code: 'unsupported_tiptap_mark',
          message: `TipTap mark ${mark.type ?? 'unknown'} is not allowed in event pages`,
          severity: 'error',
          field,
        });
      }
      if (mark.type === 'link' && isRecord(mark.attrs) && typeof mark.attrs.href === 'string') {
        validateMergeTags(mark.attrs.href).unknownTags.forEach((tag) =>
          issues.push({
            code: 'unknown_variable',
            message: `Unknown merge tag {{${tag}}} — add it to the registry or remove it`,
            severity: 'error',
            field,
          }),
        );
        if (
          !isAllowedDestination(
            renderMergeTags(mark.attrs.href, sampleContext(), {
              channel: 'email',
              escape: 'plain',
            }),
          )
        ) {
          issues.push({
            code: 'unsafe_link',
            message: 'TipTap links must use safe http(s) destinations',
            severity: 'error',
            field,
          });
        }
      }
    }
  }
  if (Array.isArray(value.content)) {
    value.content.forEach((child, index) => walkTipTap(child, `${field}.content.${index}`, issues));
  }
}

function validateBlock(
  block: EventPageBlock,
  index: number,
  options: EventPageValidationOptions,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const field = `blocks.${index}`;
  if (!block.id.trim()) {
    issues.push({
      code: 'missing_block_id',
      message: 'Event-page blocks require stable IDs',
      severity: 'error',
      field,
    });
  }
  if (block.type === 'custom_embed') {
    if (!options.allowUnsafeEmbeds || !block.allowUnsafeEmbed) {
      issues.push({
        code: 'unsafe_custom_embed',
        message: 'Custom embeds require explicit unsafe-embed permission and block approval',
        severity: 'error',
        field,
      });
    }
    const sanitized = sanitizeEventPageHtml(block.html);
    if (sanitized !== block.html) {
      issues.push({
        code: 'custom_embed_sanitized',
        message: 'Custom embed HTML contains disallowed scripts, event handlers, or URL schemes',
        severity: 'error',
        field,
      });
    }
  }
  for (const link of linkFields(block)) {
    const rendered = renderMergeTags(link.url, sampleContext(), {
      channel: 'email',
      escape: 'plain',
    });
    if (!isAllowedDestination(rendered, Boolean(options.allowPrivateLinks))) {
      issues.push({
        code: 'unsafe_link',
        message: `${link.field} must be an http(s) URL and may not target private hosts`,
        severity: 'error',
        field: `${field}.${link.field}`,
      });
    }
  }
  for (const image of imageFields(block)) {
    const rendered = renderMergeTags(image.url, sampleContext(), {
      channel: 'email',
      escape: 'plain',
    });
    if (!isAllowedDestination(rendered, Boolean(options.allowPrivateLinks))) {
      issues.push({
        code: 'unsafe_image',
        message: `${image.field} must be a safe http(s) URL`,
        severity: 'error',
        field: `${field}.${image.field}`,
      });
    }
    if (!image.alt?.trim()) {
      issues.push({
        code: 'missing_image_alt',
        message: 'Event-page images require alt text',
        severity: 'error',
        field: `${field}.${image.altField}`,
      });
    }
  }
  return issues;
}

function linkFields(block: EventPageBlock): { field: string; url: string }[] {
  switch (block.type) {
    case 'hero':
      return block.ctaUrl ? [{ field: 'ctaUrl', url: block.ctaUrl }] : [];
    case 'venue_map':
      return block.mapUrl ? [{ field: 'mapUrl', url: block.mapUrl }] : [];
    case 'button':
      return [{ field: 'url', url: block.url }];
    case 'social_links':
      return block.links.map((link, index) => ({ field: `links.${index}.url`, url: link.url }));
    case 'sponsors':
      return block.items.flatMap((item, index) =>
        item.url ? [{ field: `items.${index}.url`, url: item.url }] : [],
      );
    default:
      return [];
  }
}

function imageFields(
  block: EventPageBlock,
): { field: string; url: string; altField: string; alt?: string }[] {
  switch (block.type) {
    case 'hero':
      return block.imageUrl
        ? [{ field: 'imageUrl', url: block.imageUrl, altField: 'imageAlt', alt: block.imageAlt }]
        : [];
    case 'sponsors':
    case 'speakers':
      return block.items.flatMap((item, index) =>
        item.imageUrl
          ? [
              {
                field: `items.${index}.imageUrl`,
                url: item.imageUrl,
                altField: `items.${index}.imageAlt`,
                alt: item.imageAlt,
              },
            ]
          : [],
      );
    default:
      return [];
  }
}

function collectStrings(document: EventPageDocument): string[] {
  const values = [
    document.settings.ticketCtaLabel,
    document.settings.discovery.summary,
    document.settings.discovery.seoTitle ?? '',
    document.settings.discovery.seoDescription ?? '',
    ...textFromTipTap(document.editor.document),
  ];
  for (const block of document.blocks) {
    values.push(...stringsFromBlock(block));
  }
  return values.filter(Boolean);
}

function stringsFromBlock(block: EventPageBlock): string[] {
  switch (block.type) {
    case 'rich_text':
      return textFromTipTap(block.content);
    case 'hero':
      return [
        block.headline,
        block.eyebrow ?? '',
        block.body ?? '',
        block.ctaLabel ?? '',
        block.ctaUrl ?? '',
        block.imageUrl ?? '',
        block.imageAlt ?? '',
      ];
    case 'event_details':
      return [block.title, ...block.items.flatMap((item) => [item.label, item.value])];
    case 'tickets':
      return [block.title, block.body ?? '', block.ctaLabel ?? ''];
    case 'products':
      return [block.title, block.body ?? '', ...block.productIds];
    case 'schedule':
      return [
        block.title,
        ...block.items.flatMap((item) => [
          item.title,
          item.startsAt,
          item.endsAt ?? '',
          item.timezone ?? '',
          item.venueName ?? '',
        ]),
      ];
    case 'venue_map':
      return [block.title, block.venueName, block.address ?? '', block.mapUrl ?? ''];
    case 'faq':
      return [block.title, ...block.items.flatMap((item) => [item.question, item.answer])];
    case 'sponsors':
    case 'speakers':
      return [
        block.title,
        ...block.items.flatMap((item) => [
          item.name,
          'role' in item ? (item.role ?? '') : '',
          'bio' in item ? (item.bio ?? '') : '',
          'url' in item ? (item.url ?? '') : '',
          item.imageUrl ?? '',
          item.imageAlt ?? '',
        ]),
      ];
    case 'button':
      return [block.label, block.url];
    case 'divider':
      return [];
    case 'social_links':
      return [block.title ?? '', ...block.links.flatMap((link) => [link.label, link.url])];
    case 'custom_embed':
      return [block.html];
  }
}

function textFromTipTap(value: JSONContent): string[] {
  const values: string[] = [];
  if (typeof value.text === 'string') values.push(value.text);
  if (Array.isArray(value.content)) {
    for (const child of value.content) values.push(...textFromTipTap(child));
  }
  return values;
}

function renderItem(
  item: EventPageLogoItem | EventPagePersonItem,
  context: MergeTagContext,
  options: EventPageValidationOptions,
) {
  return {
    name: renderPlain(item.name, context),
    role: 'role' in item && item.role ? renderPlain(item.role, context) : undefined,
    bio: 'bio' in item && item.bio ? renderPlain(item.bio, context) : undefined,
    url: 'url' in item && item.url ? safeRenderedUrl(item.url, context, options) : undefined,
    imageUrl: item.imageUrl ? safeRenderedUrl(item.imageUrl, context, options) : undefined,
    imageAlt: item.imageAlt ? renderPlain(item.imageAlt, context) : undefined,
  };
}

function discoveryCard(
  document: EventPageDocument,
  context: EventPageRenderContext,
): EventPageDiscoveryCard {
  const hero = document.blocks.find(
    (block): block is Extract<EventPageBlock, { type: 'hero' }> => block.type === 'hero',
  );
  const imageUrl = document.settings.discovery.coverImageUrl ?? hero?.imageUrl;
  const publicPath = document.settings.publicPath ?? context.event?.publicUrl;
  return {
    title: renderPlain(
      document.settings.discovery.seoTitle ?? hero?.headline ?? context.event?.title ?? 'Event',
      context,
    ),
    summary: renderPlain(document.settings.discovery.summary, context),
    category: document.settings.discovery.category,
    tags: document.settings.discovery.tags,
    imageUrl: imageUrl ? safeRenderedUrl(imageUrl, context, {}) : undefined,
    startsAt: context.event?.startsAt,
    venueName: context.event?.venueName,
    publicPath: publicPath ? safeRenderedUrl(publicPath, context, {}) : undefined,
  };
}

function toPlainText(blocks: EventPageHeadlessBlock[]): string {
  return blocks
    .flatMap((block) => [block.title, block.text, block.html ? stripTags(block.html) : undefined])
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function docFromText(text: string): JSONContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function isoOrTemplate(value: string | Date | null | undefined, fallback: string): string {
  if (!value) return fallback;
  return value instanceof Date ? value.toISOString() : value;
}

function formatAddress(
  venue:
    | {
        address?: string | null;
        city?: string | null;
        region?: string | null;
        country?: string | null;
      }
    | null
    | undefined,
): string | undefined {
  const parts = [venue?.address, venue?.city, venue?.region, venue?.country]
    .map((part) => part?.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function renderPlain(template: string, context: MergeTagContext): string {
  return renderMergeTags(template, context, { channel: 'email', escape: 'plain' });
}

function safeRenderedUrl(
  template: string,
  context: MergeTagContext,
  options: EventPageValidationOptions,
): string {
  const rendered = renderMergeTags(template, context, { channel: 'email', escape: 'plain' });
  if (!isAllowedDestination(rendered, Boolean(options.allowPrivateLinks))) return '#';
  return rendered;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sampleContext(): MergeTagContext {
  return {
    event: {
      title: 'All Access Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      endsAt: '2026-07-17T23:00:00.000Z',
      timezone: 'America/Chicago',
      venueName: 'The Salt Shed',
      venueCity: 'Chicago',
      publicUrl: 'https://events.example.test/e/all-access-chicago',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    },
    brand: {
      name: 'Tixkit',
      supportUrl: 'https://help.example.test',
    },
  };
}

function dedupeIssues(issues: ContentValidationIssue[]): ContentValidationIssue[] {
  const seen = new Set<string>();
  const unique: ContentValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.field ?? ''}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}
