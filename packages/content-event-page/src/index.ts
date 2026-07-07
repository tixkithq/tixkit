import { Extension, Mark, mergeAttributes, type JSONContent } from '@tiptap/core';
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
export const EVENT_PAGE_INLINE_STYLE_MARK = 'eventPageInlineStyle' as const;
export const EVENT_PAGE_BLOCK_NODE = 'eventPageBlock' as const;

export const EVENT_PAGE_FONT_FAMILY_OPTIONS = [
  { label: 'Brand default', value: '' },
  { label: 'Inter', value: 'Inter, Arial, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: 'Times New Roman, Times, serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Mono', value: 'Courier New, Courier, monospace' },
] as const;

const allowedEventPageFontFamilies = new Set<string>(
  EVENT_PAGE_FONT_FAMILY_OPTIONS.map((option) => option.value).filter(Boolean),
);
const allowedEventPageTextAlignments = new Set(['left', 'center', 'right']);

export function isAllowedEventPageFontFamily(value: unknown): value is string {
  return typeof value === 'string' && allowedEventPageFontFamilies.has(value.trim());
}

/**
 * Map of approved font family values to their Google Font family name.
 * Only fonts that require an external stylesheet load are included;
 * system fonts (Arial, Georgia, Times, Verdana, Courier) are omitted.
 */
const GOOGLE_FONT_MAP: Record<string, string> = {
  'Inter, Arial, sans-serif': 'Inter',
};

/**
 * Scan an EventPageDocument for font families used in rich_text block inline
 * style marks. Returns a deduplicated array of approved font family values.
 */
export function collectUsedFontFamilies(document: EventPageDocument): string[] {
  const found = new Set<string>();
  for (const block of document.blocks) {
    if (block.type !== 'rich_text') continue;
    visitTipTapMarks(block.content, (mark) => {
      if (
        mark.type === EVENT_PAGE_INLINE_STYLE_MARK &&
        isRecord(mark.attrs) &&
        typeof mark.attrs.fontFamily === 'string' &&
        isAllowedEventPageFontFamily(mark.attrs.fontFamily)
      ) {
        found.add(mark.attrs.fontFamily.trim());
      }
    });
  }
  return Array.from(found);
}

/**
 * Generate Google Font `<link>` tags for the font families used in a document.
 * Only approved fonts that require external loading (e.g. Inter) are included;
 * system fonts are silently skipped.
 */
export function googleFontLinkTags(fontFamilies: string[]): string {
  const googleFonts = new Set<string>();
  for (const family of fontFamilies) {
    const googleName = GOOGLE_FONT_MAP[family.trim()];
    if (googleName) googleFonts.add(googleName);
  }
  if (googleFonts.size === 0) return '';
  const families = Array.from(googleFonts)
    .map((name) => `family=${name.replace(/ /g, '+')}:wght@400;500;600;700`)
    .join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link href="https://fonts.googleapis.com/css2?${families}&display=swap" rel="stylesheet" />`;
}

function visitTipTapMarks(value: JSONContent, fn: (mark: JSONContent) => void): void {
  if (Array.isArray(value.marks)) {
    for (const mark of value.marks) {
      fn(mark);
    }
  }
  if (Array.isArray(value.content)) {
    for (const child of value.content) {
      visitTipTapMarks(child, fn);
    }
  }
}

function isAllowedEventPageColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());
}

function isAllowedEventPageFontSize(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^(\d{1,3})px$/);
  if (!match) return false;
  const size = Number(match[1]);
  return Number.isInteger(size) && size >= 8 && size <= 96;
}

function isAllowedEventPageLineHeight(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^(\d{2,3})%$/);
  if (!match) return false;
  const lineHeight = Number(match[1]);
  return Number.isInteger(lineHeight) && lineHeight >= 80 && lineHeight <= 240;
}

function isAllowedEventPageTextAlignment(value: unknown): value is string {
  return typeof value === 'string' && allowedEventPageTextAlignments.has(value.trim());
}

function eventPageInlineStyleAttribute(attrs: {
  color?: unknown;
  fontFamily?: unknown;
  fontSize?: unknown;
  lineHeight?: unknown;
}): string | undefined {
  const declarations: string[] = [];
  const color = typeof attrs.color === 'string' ? attrs.color.trim() : '';
  if (isAllowedEventPageColor(color)) declarations.push(`color: ${color}`);
  const fontFamily = typeof attrs.fontFamily === 'string' ? attrs.fontFamily.trim() : '';
  if (isAllowedEventPageFontFamily(fontFamily)) declarations.push(`font-family: ${fontFamily}`);
  const fontSize = typeof attrs.fontSize === 'string' ? attrs.fontSize.trim() : '';
  if (isAllowedEventPageFontSize(fontSize)) declarations.push(`font-size: ${fontSize}`);
  const lineHeight = typeof attrs.lineHeight === 'string' ? attrs.lineHeight.trim() : '';
  if (isAllowedEventPageLineHeight(lineHeight)) declarations.push(`line-height: ${lineHeight}`);
  return declarations.length > 0 ? declarations.join('; ') : undefined;
}

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
  | { type: 'custom_embed'; id: string; html: string; allowUnsafeEmbed: boolean }
  | {
      type: 'event_header';
      id: string;
      badgeLabel?: string;
      descriptionOverride?: string;
      showBadge?: boolean;
      showDate?: boolean;
      showVenue?: boolean;
      showDescription?: boolean;
    }
  | {
      type: 'resale_tickets';
      id: string;
      title: string;
      ctaLabel?: string;
      emptyStateText?: string;
      showVerifiedBadge?: boolean;
    }
  | {
      type: 'brand_footer';
      id: string;
      showSupport?: boolean;
      showTerms?: boolean;
      showPrivacy?: boolean;
      showRefund?: boolean;
    };

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

export type EventPageResaleListing = {
  id: string;
  ticketTypeName?: string;
  priceLabel: string;
  expiresAt?: string;
};

export type EventPageRenderContext = MergeTagContext & {
  tickets?: EventPageTicket[];
  products?: EventPageProduct[];
  resaleListings?: EventPageResaleListing[];
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

export type ResolveEventPageOptions = EventPageValidationOptions & {
  mode?: 'edit' | 'preview' | 'public' | 'server';
};

export type ResolvedEventPageSettings = {
  locale: string;
  publicPath?: string;
  ticketCtaLabel: string;
  discovery: EventPageDiscoveryMetadata;
};

export type ResolvedEventPageDetailItem = { label: string; value: string };
export type ResolvedEventPageScheduleItem = {
  title: string;
  startsAt: string;
  endsAt?: string;
  timezone?: string;
  venueName?: string;
};
export type ResolvedEventPageFaqItem = { question: string; answer: string };
export type ResolvedEventPageLogoItem = {
  name: string;
  role?: string;
  bio?: string;
  url?: string;
  imageUrl?: string;
  imageAlt?: string;
};
export type ResolvedEventPageLink = { label: string; url: string };

export type ResolvedEventPageBlock =
  | { type: 'rich_text'; id: string; html: string; text: string }
  | {
      type: 'hero';
      id: string;
      eyebrow?: string;
      headline: string;
      body?: string;
      imageUrl?: string;
      imageAlt?: string;
      ctaLabel?: string;
      ctaUrl?: string;
    }
  | { type: 'event_details'; id: string; title: string; items: ResolvedEventPageDetailItem[] }
  | {
      type: 'tickets';
      id: string;
      title: string;
      body?: string;
      ctaLabel?: string;
      tickets: EventPageTicket[];
      checkoutUrl?: string;
    }
  | {
      type: 'products';
      id: string;
      title: string;
      body?: string;
      products: EventPageProduct[];
    }
  | { type: 'schedule'; id: string; title: string; items: ResolvedEventPageScheduleItem[] }
  | {
      type: 'venue_map';
      id: string;
      title: string;
      venueName: string;
      address?: string;
      mapUrl?: string;
    }
  | { type: 'faq'; id: string; title: string; items: ResolvedEventPageFaqItem[] }
  | { type: 'sponsors'; id: string; title: string; items: ResolvedEventPageLogoItem[] }
  | { type: 'speakers'; id: string; title: string; items: ResolvedEventPageLogoItem[] }
  | { type: 'button'; id: string; label: string; url: string; style?: 'primary' | 'secondary' }
  | { type: 'divider'; id: string }
  | { type: 'social_links'; id: string; title?: string; links: ResolvedEventPageLink[] }
  | { type: 'custom_embed'; id: string; html: string; allowed: boolean }
  | {
      type: 'event_header';
      id: string;
      badgeLabel?: string;
      title: string;
      description?: string;
      startsAt?: string;
      timezone?: string;
      venueName?: string;
      showBadge: boolean;
      showDate: boolean;
      showVenue: boolean;
      showDescription: boolean;
    }
  | {
      type: 'resale_tickets';
      id: string;
      title: string;
      ctaLabel?: string;
      emptyStateText?: string;
      showVerifiedBadge: boolean;
      listings: EventPageResaleListing[];
      checkoutUrl?: string;
    }
  | { type: 'brand_footer'; id: string; links: ResolvedEventPageLink[] };

export type ResolvedEventPage = {
  schemaVersion: typeof EVENT_PAGE_SCHEMA_VERSION;
  settings: ResolvedEventPageSettings;
  blocks: ResolvedEventPageBlock[];
  discovery: EventPageDiscoveryCard;
  validation: ContentValidationResult;
};

export const EventPageInlineStyle = Mark.create({
  name: EVENT_PAGE_INLINE_STYLE_MARK,

  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element) => {
          const fontFamily = element.style.fontFamily;
          return isAllowedEventPageFontFamily(fontFamily) ? fontFamily : null;
        },
      },
      color: {
        default: null,
        parseHTML: (element) => {
          const color = element.style.color;
          return isAllowedEventPageColor(color) ? color : null;
        },
      },
      fontSize: {
        default: null,
        parseHTML: (element) => {
          const fontSize = element.style.fontSize;
          return isAllowedEventPageFontSize(fontSize) ? fontSize : null;
        },
      },
      lineHeight: {
        default: null,
        parseHTML: (element) => {
          const lineHeight = element.style.lineHeight;
          return isAllowedEventPageLineHeight(lineHeight) ? lineHeight : null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-event-page-inline-style]' }];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const safeHTMLAttributes = { ...HTMLAttributes };
    delete safeHTMLAttributes.fontFamily;
    delete safeHTMLAttributes.color;
    delete safeHTMLAttributes.fontSize;
    delete safeHTMLAttributes.lineHeight;
    return [
      'span',
      mergeAttributes(safeHTMLAttributes, {
        'data-event-page-inline-style': 'true',
        style: eventPageInlineStyleAttribute(mark.attrs),
      }),
      0,
    ];
  },
});

export const EventPageTextAlignment = Extension.create({
  name: 'eventPageTextAlignment',

  addGlobalAttributes() {
    return [
      {
        types: ['heading', 'paragraph'],
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (element) => {
              const textAlign = element.style.textAlign;
              return isAllowedEventPageTextAlignment(textAlign) ? textAlign : null;
            },
            renderHTML: (attributes) => {
              const textAlign = attributes.textAlign;
              return isAllowedEventPageTextAlignment(textAlign)
                ? { style: `text-align: ${textAlign.trim()}` }
                : {};
            },
          },
        },
      },
    ];
  },
});

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
  EventPageInlineStyle,
  EventPageTextAlignment,
];

/**
 * Build a unified TipTap node tree from typed blocks. Each block becomes an
 * `eventPageBlock` node with the full block data stored in `attrs.block`.
 * This is the "projection" from the canonical typed model to the authoring
 * surface: `editor.document` becomes the single node tree that serializes
 * back to `blocks[]` on snapshot.
 */
export function blocksToEditorDocument(blocks: EventPageBlock[]): JSONContent {
  return {
    type: 'doc',
    content: blocks.map((block) => ({
      type: EVENT_PAGE_BLOCK_NODE,
      attrs: { block: structuredClone(block) },
    })),
  };
}

/**
 * Serialize a unified TipTap node tree back to typed blocks. Each
 * `eventPageBlock` node's `attrs.block` is extracted as a typed block.
 * Returns `undefined` if the document is not in the unified format (i.e.,
 * does not contain `eventPageBlock` nodes).
 */
export function editorDocumentToBlocks(document: JSONContent): EventPageBlock[] | undefined {
  if (!Array.isArray(document.content)) return undefined;
  const blocks: EventPageBlock[] = [];
  let foundBlockNode = false;
  for (const node of document.content) {
    if (node.type === EVENT_PAGE_BLOCK_NODE && isRecord(node.attrs) && isRecord(node.attrs.block)) {
      foundBlockNode = true;
      blocks.push(node.attrs.block as EventPageBlock);
    }
  }
  return foundBlockNode ? blocks : undefined;
}

/**
 * Returns true if the editor document is in the unified format (contains
 * `eventPageBlock` nodes). Old documents have a plain paragraph summary
 * instead.
 */
export function isUnifiedEditorDocument(document: JSONContent): boolean {
  if (!Array.isArray(document.content)) return false;
  return document.content.some((node) => node.type === EVENT_PAGE_BLOCK_NODE);
}

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

  const blocks: EventPageBlock[] = [
      {
        type: 'event_header',
        id: 'header',
        showBadge: true,
        showDate: true,
        showVenue: true,
        showDescription: true,
      },
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
      {
        type: 'resale_tickets',
        id: 'resale',
        title: 'Resale tickets',
        ctaLabel: 'Buy resale',
        emptyStateText: 'No resale tickets available.',
        showVerifiedBadge: true,
      },
      {
        type: 'brand_footer',
        id: 'footer',
        showSupport: true,
        showTerms: true,
        showPrivacy: true,
        showRefund: true,
      },
    ];

  return {
    schemaVersion: EVENT_PAGE_SCHEMA_VERSION,
    editor: {
      provider: TIPTAP_EVENT_PAGE_PROVIDER,
      document: blocksToEditorDocument(blocks),
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
    blocks,
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

  issues.push(...validateTipTapDocument(document.editor.document, 'editor.document', options));
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

export function resolveEventPageDocument(
  document: EventPageDocument,
  context: EventPageRenderContext,
  options: ResolveEventPageOptions = {},
): ResolvedEventPage {
  const validation = validateEventPageDocument(document, options);
  const discovery = discoveryCard(document, context);
  const settings = resolveEventPageSettings(document, context);
  if (!validation.valid) {
    return { schemaVersion: document.schemaVersion, settings, blocks: [], discovery, validation };
  }
  const blocks = document.blocks.map((block) => resolveBlock(block, context, options));
  return { schemaVersion: document.schemaVersion, settings, blocks, discovery, validation };
}

export function renderResolvedEventPageHtml(resolved: ResolvedEventPage): string {
  if (!resolved.validation.valid) return '';
  return `<div class="tixkit-event-page" data-schema-version="${resolved.schemaVersion}">${resolved.blocks
    .map((block) => resolvedBlockHtml(block))
    .join('')}</div>`;
}

export function renderResolvedEventPageHeadless(
  resolved: ResolvedEventPage,
): EventPageHeadlessBlock[] {
  return resolved.blocks.map((block) => resolvedBlockHeadless(block));
}

export function renderResolvedEventPageText(resolved: ResolvedEventPage): string {
  return toPlainText(renderResolvedEventPageHeadless(resolved));
}

export function renderEventPageDocument(
  document: EventPageDocument,
  context: EventPageRenderContext,
  options: EventPageValidationOptions = {},
): RenderedEventPage {
  const resolved = resolveEventPageDocument(document, context, options);
  if (!resolved.validation.valid) {
    return {
      html: '',
      text: '',
      headless: [],
      discovery: resolved.discovery,
      validation: resolved.validation,
    };
  }
  return {
    html: renderResolvedEventPageHtml(resolved),
    text: renderResolvedEventPageText(resolved),
    headless: renderResolvedEventPageHeadless(resolved),
    discovery: resolved.discovery,
    validation: resolved.validation,
  };
}

function resolveEventPageSettings(
  document: EventPageDocument,
  context: MergeTagContext,
): ResolvedEventPageSettings {
  return {
    locale: document.settings.locale,
    publicPath: document.settings.publicPath
      ? safeRenderedUrl(document.settings.publicPath, context, {})
      : undefined,
    ticketCtaLabel: renderPlain(document.settings.ticketCtaLabel, context),
    discovery: {
      summary: renderPlain(document.settings.discovery.summary, context),
      category: document.settings.discovery.category,
      tags: document.settings.discovery.tags,
      coverImageUrl: document.settings.discovery.coverImageUrl
        ? safeRenderedUrl(document.settings.discovery.coverImageUrl, context, {})
        : undefined,
      socialImageUrl: document.settings.discovery.socialImageUrl
        ? safeRenderedUrl(document.settings.discovery.socialImageUrl, context, {})
        : undefined,
      seoTitle: document.settings.discovery.seoTitle
        ? renderPlain(document.settings.discovery.seoTitle, context)
        : undefined,
      seoDescription: document.settings.discovery.seoDescription
        ? renderPlain(document.settings.discovery.seoDescription, context)
        : undefined,
    },
  };
}

function resolveBlock(
  block: EventPageBlock,
  context: EventPageRenderContext,
  options: EventPageValidationOptions,
): ResolvedEventPageBlock {
  switch (block.type) {
    case 'hero': {
      const imageUrl = block.imageUrl
        ? safeRenderedUrl(block.imageUrl, context, options)
        : undefined;
      const ctaUrl = block.ctaUrl ? safeRenderedUrl(block.ctaUrl, context, options) : undefined;
      return {
        type: 'hero',
        id: block.id,
        eyebrow: block.eyebrow ? renderPlain(block.eyebrow, context) : undefined,
        headline: renderPlain(block.headline, context),
        body: block.body ? renderPlain(block.body, context) : undefined,
        imageUrl,
        imageAlt: block.imageAlt ? renderPlain(block.imageAlt, context) : undefined,
        ctaLabel: block.ctaLabel ? renderPlain(block.ctaLabel, context) : undefined,
        ctaUrl,
      };
    }
    case 'rich_text': {
      const html = sanitizeEventPageHtml(renderTipTap(block.content, context));
      return { type: 'rich_text', id: block.id, html, text: stripTags(html) };
    }
    case 'event_details': {
      return {
        type: 'event_details',
        id: block.id,
        title: renderPlain(block.title, context),
        items: block.items.map((item) => ({
          label: renderPlain(item.label, context),
          value: renderPlain(item.value, context),
        })),
      };
    }
    case 'tickets': {
      const tickets = (context.tickets ?? []).filter((ticket) => ticket.status !== 'hidden');
      const checkoutUrl = context.event?.checkoutUrl
        ? safeRenderedUrl(context.event.checkoutUrl, context, options)
        : undefined;
      return {
        type: 'tickets',
        id: block.id,
        title: renderPlain(block.title, context),
        body: block.body ? renderPlain(block.body, context) : undefined,
        ctaLabel: block.ctaLabel ? renderPlain(block.ctaLabel, context) : undefined,
        tickets,
        checkoutUrl,
      };
    }
    case 'products': {
      const productIds = new Set(block.productIds);
      return {
        type: 'products',
        id: block.id,
        title: renderPlain(block.title, context),
        body: block.body ? renderPlain(block.body, context) : undefined,
        products: (context.products ?? []).filter((product) => productIds.has(product.id)),
      };
    }
    case 'schedule': {
      return {
        type: 'schedule',
        id: block.id,
        title: renderPlain(block.title, context),
        items: block.items.map((item) => ({
          title: renderPlain(item.title, context),
          startsAt: renderPlain(item.startsAt, context),
          endsAt: item.endsAt ? renderPlain(item.endsAt, context) : undefined,
          timezone: item.timezone ? renderPlain(item.timezone, context) : undefined,
          venueName: item.venueName ? renderPlain(item.venueName, context) : undefined,
        })),
      };
    }
    case 'venue_map': {
      return {
        type: 'venue_map',
        id: block.id,
        title: renderPlain(block.title, context),
        venueName: renderPlain(block.venueName, context),
        address: block.address ? renderPlain(block.address, context) : undefined,
        mapUrl: block.mapUrl ? safeRenderedUrl(block.mapUrl, context, options) : undefined,
      };
    }
    case 'faq': {
      return {
        type: 'faq',
        id: block.id,
        title: renderPlain(block.title, context),
        items: block.items.map((item) => ({
          question: renderPlain(item.question, context),
          answer: renderPlain(item.answer, context),
        })),
      };
    }
    case 'sponsors':
    case 'speakers': {
      return {
        type: block.type,
        id: block.id,
        title: renderPlain(block.title, context),
        items: block.items.map((item) => renderItem(item, context, options)),
      };
    }
    case 'button': {
      return {
        type: 'button',
        id: block.id,
        label: renderPlain(block.label, context),
        url: safeRenderedUrl(block.url, context, options),
        style: block.style,
      };
    }
    case 'divider':
      return { type: 'divider', id: block.id };
    case 'social_links': {
      return {
        type: 'social_links',
        id: block.id,
        title: block.title ? renderPlain(block.title, context) : undefined,
        links: block.links.map((link) => ({
          label: renderPlain(link.label, context),
          url: safeRenderedUrl(link.url, context, options),
        })),
      };
    }
    case 'custom_embed': {
      const allowed = Boolean(options.allowUnsafeEmbeds) && block.allowUnsafeEmbed;
      return {
        type: 'custom_embed',
        id: block.id,
        html: allowed ? sanitizeEventPageHtml(block.html) : '',
        allowed,
      };
    }
    case 'event_header': {
      const showBadge = block.showBadge ?? true;
      const showDate = block.showDate ?? true;
      const showVenue = block.showVenue ?? true;
      const showDescription = block.showDescription ?? true;
      return {
        type: 'event_header',
        id: block.id,
        badgeLabel: showBadge
          ? block.badgeLabel
            ? renderPlain(block.badgeLabel, context)
            : context.brand?.name
          : undefined,
        title: context.event?.title ?? '',
        description: showDescription
          ? block.descriptionOverride
            ? renderPlain(block.descriptionOverride, context)
            : context.event?.description
          : undefined,
        startsAt: showDate ? context.event?.startsAt : undefined,
        timezone: showDate ? context.event?.timezone : undefined,
        venueName: showVenue ? context.event?.venueName : undefined,
        showBadge,
        showDate,
        showVenue,
        showDescription,
      };
    }
    case 'resale_tickets': {
      const checkoutUrl = context.event?.checkoutUrl
        ? safeRenderedUrl(context.event.checkoutUrl, context, options)
        : undefined;
      return {
        type: 'resale_tickets',
        id: block.id,
        title: renderPlain(block.title, context),
        ctaLabel: block.ctaLabel ? renderPlain(block.ctaLabel, context) : undefined,
        emptyStateText: block.emptyStateText
          ? renderPlain(block.emptyStateText, context)
          : undefined,
        showVerifiedBadge: block.showVerifiedBadge ?? true,
        listings: (context.resaleListings ?? []).filter(Boolean),
        checkoutUrl,
      };
    }
    case 'brand_footer': {
      const showSupport = block.showSupport ?? true;
      const showTerms = block.showTerms ?? true;
      const showPrivacy = block.showPrivacy ?? true;
      const showRefund = block.showRefund ?? true;
      const links: ResolvedEventPageLink[] = [];
      if (showSupport && context.brand?.supportUrl) {
        links.push({
          label: 'Support',
          url: safeRenderedUrl(context.brand.supportUrl, context, options),
        });
      }
      if (showTerms && context.brand?.termsUrl) {
        links.push({
          label: 'Terms',
          url: safeRenderedUrl(context.brand.termsUrl, context, options),
        });
      }
      if (showPrivacy && context.brand?.privacyUrl) {
        links.push({
          label: 'Privacy',
          url: safeRenderedUrl(context.brand.privacyUrl, context, options),
        });
      }
      if (showRefund && context.brand?.refundUrl) {
        links.push({
          label: 'Refund',
          url: safeRenderedUrl(context.brand.refundUrl, context, options),
        });
      }
      return { type: 'brand_footer', id: block.id, links };
    }
  }
}

function resolvedBlockHtml(block: ResolvedEventPageBlock): string {
  switch (block.type) {
    case 'hero': {
      return [
        `<section class="tk-ep-hero" data-block-id="${escapeAttr(block.id)}">`,
        block.eyebrow ? `<p class="tk-ep-eyebrow">${escapeHtml(block.eyebrow)}</p>` : '',
        `<h1>${escapeHtml(block.headline)}</h1>`,
        block.body ? `<p>${escapeHtml(block.body)}</p>` : '',
        block.imageUrl
          ? `<img src="${escapeAttr(block.imageUrl)}" alt="${escapeAttr(block.imageAlt ?? '')}" loading="lazy" />`
          : '',
        block.ctaLabel && block.ctaUrl
          ? `<a class="tk-ep-button" href="${escapeAttr(block.ctaUrl)}">${escapeHtml(block.ctaLabel)}</a>`
          : '',
        '</section>',
      ].join('');
    }
    case 'rich_text':
      return `<section class="tk-ep-rich-text" data-block-id="${escapeAttr(block.id)}">${block.html}</section>`;
    case 'event_details': {
      return `<section class="tk-ep-details" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2><dl>${block.items
        .map(
          (item) =>
            `<div><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.value)}</dd></div>`,
        )
        .join('')}</dl></section>`;
    }
    case 'tickets': {
      return `<section class="tk-ep-tickets" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2>${block.body ? `<p>${escapeHtml(block.body)}</p>` : ''}<ul>${block.tickets
        .map(
          (ticket) =>
            `<li><strong>${escapeHtml(ticket.name)}</strong>${ticket.description ? `<span>${escapeHtml(ticket.description)}</span>` : ''}${ticket.priceLabel ? `<span>${escapeHtml(ticket.priceLabel)}</span>` : ''}</li>`,
        )
        .join(
          '',
        )}</ul>${block.ctaLabel && block.checkoutUrl ? `<a class="tk-ep-button" href="${escapeAttr(block.checkoutUrl)}">${escapeHtml(block.ctaLabel)}</a>` : ''}</section>`;
    }
    case 'products': {
      return `<section class="tk-ep-products" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2>${block.body ? `<p>${escapeHtml(block.body)}</p>` : ''}<ul>${block.products
        .map(
          (product) =>
            `<li><strong>${escapeHtml(product.name)}</strong>${product.description ? `<span>${escapeHtml(product.description)}</span>` : ''}${product.priceLabel ? `<span>${escapeHtml(product.priceLabel)}</span>` : ''}</li>`,
        )
        .join('')}</ul></section>`;
    }
    case 'schedule': {
      return `<section class="tk-ep-schedule" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2><ol>${block.items
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.title)}</strong><time>${escapeHtml(item.startsAt)}</time>${item.venueName ? `<span>${escapeHtml(item.venueName)}</span>` : ''}</li>`,
        )
        .join('')}</ol></section>`;
    }
    case 'venue_map': {
      return `<section class="tk-ep-venue" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2><p><strong>${escapeHtml(block.venueName)}</strong></p>${block.address ? `<p>${escapeHtml(block.address)}</p>` : ''}${block.mapUrl ? `<a href="${escapeAttr(block.mapUrl)}">Open map</a>` : ''}</section>`;
    }
    case 'faq': {
      return `<section class="tk-ep-faq" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2>${block.items
        .map(
          (item) =>
            `<details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`,
        )
        .join('')}</section>`;
    }
    case 'sponsors':
    case 'speakers': {
      return `<section class="tk-ep-${block.type}" data-block-id="${escapeAttr(block.id)}"><h2>${escapeHtml(block.title)}</h2><ul>${block.items
        .map(
          (item) =>
            `<li><strong>${escapeHtml(item.name)}</strong>${item.role ? `<span>${escapeHtml(item.role)}</span>` : ''}${item.bio ? `<p>${escapeHtml(item.bio)}</p>` : ''}${item.url ? `<a href="${escapeAttr(item.url)}">Open</a>` : ''}${item.imageUrl ? `<img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.imageAlt ?? item.name)}" loading="lazy" />` : ''}</li>`,
        )
        .join('')}</ul></section>`;
    }
    case 'button': {
      return `<section class="tk-ep-action" data-block-id="${escapeAttr(block.id)}"><a class="tk-ep-button tk-ep-button-${escapeAttr(block.style ?? 'primary')}" href="${escapeAttr(block.url)}">${escapeHtml(block.label)}</a></section>`;
    }
    case 'divider':
      return `<hr class="tk-ep-divider" data-block-id="${escapeAttr(block.id)}" />`;
    case 'social_links': {
      return `<section class="tk-ep-social" data-block-id="${escapeAttr(block.id)}">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ''}<ul>${block.links
        .map((link) => `<li><a href="${escapeAttr(link.url)}">${escapeHtml(link.label)}</a></li>`)
        .join('')}</ul></section>`;
    }
    case 'custom_embed':
      return block.html
        ? `<section class="tk-ep-embed" data-block-id="${escapeAttr(block.id)}">${block.html}</section>`
        : '';
    case 'event_header': {
      const meta: string[] = [];
      if (block.showDate && block.startsAt) {
        meta.push(
          `<div><dt>Date</dt><dd>${escapeHtml(block.startsAt)}</dd></div>`,
        );
      }
      if (block.showDate && block.timezone) {
        meta.push(
          `<div><dt>Timezone</dt><dd>${escapeHtml(block.timezone)}</dd></div>`,
        );
      }
      if (block.showVenue && block.venueName) {
        meta.push(
          `<div><dt>Venue</dt><dd>${escapeHtml(block.venueName)}</dd></div>`,
        );
      }
      return [
        `<section class="tk-ep-header" data-block-id="${escapeAttr(block.id)}">`,
        block.showBadge && block.badgeLabel
          ? `<p class="tk-ep-badge">${escapeHtml(block.badgeLabel)}</p>`
          : '',
        `<p class="tk-ep-header__title">${escapeHtml(block.title)}</p>`,
        block.showDescription && block.description
          ? `<p class="tk-ep-header__description">${escapeHtml(block.description)}</p>`
          : '',
        meta.length > 0 ? `<dl class="tk-ep-header__meta">${meta.join('')}</dl>` : '',
        '</section>',
      ].join('');
    }
    case 'resale_tickets': {
      const list =
        block.listings.length > 0
          ? `<ul>${block.listings
              .map(
                (listing) =>
                  `<li><strong>${escapeHtml(listing.ticketTypeName ? `Resale ticket - ${listing.ticketTypeName}` : 'Resale ticket')}</strong><span>1 available</span>${listing.priceLabel ? `<span>${escapeHtml(listing.priceLabel)}</span>` : ''}${listing.expiresAt ? `<span>Expires ${escapeHtml(listing.expiresAt)}</span>` : ''}</li>`,
              )
              .join('')}</ul>`
          : `<p>${escapeHtml(block.emptyStateText ?? 'No resale tickets available.')}</p>`;
      return `<section class="tk-ep-resale" data-block-id="${escapeAttr(block.id)}"><div class="tk-ep-resale__header"><h2>${escapeHtml(block.title)}</h2>${block.showVerifiedBadge ? '<span class="tk-ep-badge tk-ep-badge--verified">Verified listings</span>' : ''}</div>${list}${block.ctaLabel && block.checkoutUrl ? `<a class="tk-ep-button" href="${escapeAttr(block.checkoutUrl)}">${escapeHtml(block.ctaLabel)}</a>` : ''}</section>`;
    }
    case 'brand_footer': {
      return block.links.length > 0
        ? `<footer class="tk-ep-footer" data-block-id="${escapeAttr(block.id)}"><ul class="tk-ep-footer__links">${block.links
            .map((link) => `<li><a href="${escapeAttr(link.url)}">${escapeHtml(link.label)}</a></li>`)
            .join('')}</ul></footer>`
        : `<footer class="tk-ep-footer" data-block-id="${escapeAttr(block.id)}"></footer>`;
    }
  }
}

function resolvedBlockHeadless(block: ResolvedEventPageBlock): EventPageHeadlessBlock {
  switch (block.type) {
    case 'hero':
      return {
        type: block.type,
        id: block.id,
        title: block.headline,
        text: block.body,
        html: resolvedBlockHtml(block),
        imageUrl: block.imageUrl,
        imageAlt: block.imageAlt,
      };
    case 'rich_text':
      return { type: block.type, id: block.id, html: resolvedBlockHtml(block), text: block.text };
    case 'event_details':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.items,
      };
    case 'tickets':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        text: block.body,
        html: resolvedBlockHtml(block),
        items: block.tickets,
      };
    case 'products':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.products,
      };
    case 'schedule':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.items,
      };
    case 'venue_map':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        links: block.mapUrl ? [{ label: 'Open map', url: block.mapUrl }] : [],
      };
    case 'faq':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.items,
      };
    case 'sponsors':
    case 'speakers':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.items,
      };
    case 'button':
      return {
        type: block.type,
        id: block.id,
        title: block.label,
        html: resolvedBlockHtml(block),
        links: [{ label: block.label, url: block.url }],
      };
    case 'divider':
      return { type: block.type, id: block.id, html: resolvedBlockHtml(block) };
    case 'social_links':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        links: block.links,
      };
    case 'custom_embed':
      return { type: block.type, id: block.id, html: resolvedBlockHtml(block) };
    case 'event_header':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        text: block.description,
        html: resolvedBlockHtml(block),
      };
    case 'resale_tickets':
      return {
        type: block.type,
        id: block.id,
        title: block.title,
        html: resolvedBlockHtml(block),
        items: block.listings,
      };
    case 'brand_footer':
      return {
        type: block.type,
        id: block.id,
        html: resolvedBlockHtml(block),
        links: block.links,
      };
  }
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
    .replace(
      /[\s/]+(srcdoc|style)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi,
      (_attribute: string, name: string, rawValue: string) => {
        if (name.toLowerCase() !== 'style') return '';
        return safeEventPageStyleAttribute(rawValue) ?? '';
      },
    )
    .replace(
      /[\s/]+(href|src|data|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi,
      (attribute: string, _name: string, rawValue: string) =>
        hasUnsafeHtmlUrlScheme(rawValue) ? '' : attribute,
    );
}

function safeEventPageStyleAttribute(rawValue: string): string | undefined {
  const declarations = stripAttributeQuotes(rawValue)
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  const attrs: Record<string, string> = {};
  for (const declaration of declarations) {
    const [rawProperty, ...rawValueParts] = declaration.split(':');
    const property = rawProperty?.trim().toLowerCase();
    const value = rawValueParts.join(':').trim();
    if (!property || !value) continue;
    if (property === 'color' && isAllowedEventPageColor(value)) attrs.color = value;
    if (property === 'font-family' && isAllowedEventPageFontFamily(value)) attrs.fontFamily = value;
    if (property === 'font-size' && isAllowedEventPageFontSize(value)) attrs.fontSize = value;
    if (property === 'line-height' && isAllowedEventPageLineHeight(value)) attrs.lineHeight = value;
    if (property === 'text-align' && isAllowedEventPageTextAlignment(value)) {
      attrs.textAlign = value;
    }
  }
  const declarationsToKeep: string[] = [];
  if (attrs.color) declarationsToKeep.push(`color: ${attrs.color}`);
  if (attrs.fontFamily) declarationsToKeep.push(`font-family: ${attrs.fontFamily}`);
  if (attrs.fontSize) declarationsToKeep.push(`font-size: ${attrs.fontSize}`);
  if (attrs.lineHeight) declarationsToKeep.push(`line-height: ${attrs.lineHeight}`);
  if (attrs.textAlign) declarationsToKeep.push(`text-align: ${attrs.textAlign}`);
  return declarationsToKeep.length > 0 ? ` style="${declarationsToKeep.join('; ')}"` : undefined;
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
  const rawBlocks = value.blocks as EventPageBlock[];
  const hasHeader = rawBlocks.some((block) => isRecord(block) && block.type === 'event_header');
  const hasResale = rawBlocks.some(
    (block) => isRecord(block) && block.type === 'resale_tickets',
  );
  const hasFooter = rawBlocks.some((block) => isRecord(block) && block.type === 'brand_footer');
  const isUnified = isUnifiedEditorDocument(editor.document as JSONContent);
  if (hasHeader && hasResale && hasFooter && isUnified) {
    return value as EventPageDocument;
  }
  const blocks: EventPageBlock[] = [...rawBlocks];
  if (!hasHeader) {
    blocks.unshift({
      type: 'event_header',
      id: 'header',
      showBadge: true,
      showDate: true,
      showVenue: true,
      showDescription: true,
    });
  }
  if (!hasResale) {
    blocks.push({
      type: 'resale_tickets',
      id: 'resale',
      title: 'Resale tickets',
      ctaLabel: 'Buy resale',
      emptyStateText: 'No resale tickets available.',
      showVerifiedBadge: true,
    });
  }
  if (!hasFooter) {
    blocks.push({
      type: 'brand_footer',
      id: 'footer',
      showSupport: true,
      showTerms: true,
      showPrivacy: true,
      showRefund: true,
    });
  }
  const result: EventPageDocument = { ...(value as EventPageDocument), blocks };
  if (!isUnified) {
    result.editor = {
      provider: TIPTAP_EVENT_PAGE_PROVIDER,
      document: blocksToEditorDocument(blocks),
    };
  }
  return result;
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

function validateTipTapDocument(
  value: JSONContent,
  field: string,
  options: EventPageValidationOptions,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  walkTipTap(value, field, options, issues);
  return issues;
}

function walkTipTap(
  value: JSONContent,
  field: string,
  options: EventPageValidationOptions,
  issues: ContentValidationIssue[],
): void {
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
    EVENT_PAGE_BLOCK_NODE,
  ]);
  const allowedMarks = new Set([
    'bold',
    'italic',
    'strike',
    'link',
    'code',
    EVENT_PAGE_INLINE_STYLE_MARK,
  ]);
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
  if (
    (value.type === 'heading' || value.type === 'paragraph') &&
    isRecord(value.attrs) &&
    value.attrs.textAlign !== undefined &&
    value.attrs.textAlign !== null &&
    !isAllowedEventPageTextAlignment(value.attrs.textAlign)
  ) {
    issues.push({
      code: 'unsupported_text_alignment',
      message: 'Event-page text alignment must be left, center, or right',
      severity: 'error',
      field: `${field}.attrs.textAlign`,
    });
  }
  if (value.type === 'image') {
    const attrs = isRecord(value.attrs) ? value.attrs : {};
    const src = typeof attrs.src === 'string' ? attrs.src : '';
    const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
    validateMergeTags(src).unknownTags.forEach((tag) =>
      issues.push({
        code: 'unknown_variable',
        message: `Unknown merge tag {{${tag}}} — add it to the registry or remove it`,
        severity: 'error',
        field: `${field}.attrs.src`,
      }),
    );
    const renderedSrc = src
      ? renderMergeTags(src, sampleContext(), { channel: 'email', escape: 'plain' })
      : '';
    if (!src || !isAllowedDestination(renderedSrc, Boolean(options.allowPrivateLinks))) {
      issues.push({
        code: 'unsafe_image',
        message: 'TipTap images must use safe http(s) destinations',
        severity: 'error',
        field: `${field}.attrs.src`,
      });
    }
    if (!alt.trim()) {
      issues.push({
        code: 'missing_image_alt',
        message: 'Event-page images require alt text',
        severity: 'error',
        field: `${field}.attrs.alt`,
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
      if (mark.type === EVENT_PAGE_INLINE_STYLE_MARK && isRecord(mark.attrs)) {
        if (
          mark.attrs.fontFamily !== undefined &&
          mark.attrs.fontFamily !== null &&
          !isAllowedEventPageFontFamily(mark.attrs.fontFamily)
        ) {
          issues.push({
            code: 'unsupported_font_family',
            message: 'Selected event-page font family is not in the approved font catalog',
            severity: 'error',
            field,
          });
        }
        if (
          mark.attrs.color !== undefined &&
          mark.attrs.color !== null &&
          !isAllowedEventPageColor(mark.attrs.color)
        ) {
          issues.push({
            code: 'unsupported_text_color',
            message: 'Selected event-page text color must be a safe hex color',
            severity: 'error',
            field,
          });
        }
        if (
          mark.attrs.fontSize !== undefined &&
          mark.attrs.fontSize !== null &&
          !isAllowedEventPageFontSize(mark.attrs.fontSize)
        ) {
          issues.push({
            code: 'unsupported_font_size',
            message: 'Selected event-page font size must be between 8px and 96px',
            severity: 'error',
            field,
          });
        }
        if (
          mark.attrs.lineHeight !== undefined &&
          mark.attrs.lineHeight !== null &&
          !isAllowedEventPageLineHeight(mark.attrs.lineHeight)
        ) {
          issues.push({
            code: 'unsupported_line_height',
            message: 'Selected event-page line height must be between 80% and 240%',
            severity: 'error',
            field,
          });
        }
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
    value.content.forEach((child, index) =>
      walkTipTap(child, `${field}.content.${index}`, options, issues),
    );
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
  if (block.type === 'rich_text') {
    issues.push(...validateTipTapDocument(block.content, `${field}.content`, options));
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
    case 'speakers':
      return block.items.flatMap((item, index) => {
        const url = (item as { url?: string }).url;
        return url ? [{ field: `items.${index}.url`, url }] : [];
      });
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
    case 'event_header':
      return [block.badgeLabel ?? '', block.descriptionOverride ?? ''];
    case 'resale_tickets':
      return [block.title, block.ctaLabel ?? '', block.emptyStateText ?? ''];
    case 'brand_footer':
      return [];
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
