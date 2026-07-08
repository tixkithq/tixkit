import type {
  ContentValidationIssue,
  ContentValidationResult,
  ValidationSeverity,
} from '@tixkit/content-core';
import { isAllowedDestination } from '@tixkit/domain';

export const PUCK_EVENT_PAGE_PROVIDER = '@puckeditor/core' as const;
export const EVENT_PAGE_SCHEMA_VERSION = 2 as const;
export const EVENT_PAGE_DOCUMENT_V2_SCHEMA_VERSION = EVENT_PAGE_SCHEMA_VERSION;
export const EVENT_PAGE_PUCK_PROVIDER = PUCK_EVENT_PAGE_PROVIDER;

export const EVENT_PAGE_PUCK_COMPONENT_TYPES = [
  'Hero',
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
] as const;

export const EVENT_PAGE_LEGACY_COMMERCE_BLOCK_TYPES = [
  'event_header',
  'tickets',
  'products',
  'resale_tickets',
  'brand_footer',
] as const;

const eventPagePuckComponentTypeSet = new Set<string>(EVENT_PAGE_PUCK_COMPONENT_TYPES);
const legacyCommerceBlockTypeSet = new Set<string>(EVENT_PAGE_LEGACY_COMMERCE_BLOCK_TYPES);

const DEFAULT_EVENT_PAGE_DOCUMENT_INPUT: CreateDefaultEventPageDocumentInput = {
  eventId: 'event-page',
  eventTitle: 'Event page',
  eventDescription: 'Event details',
  locale: 'en',
};

export type EventPagePuckComponentType = (typeof EVENT_PAGE_PUCK_COMPONENT_TYPES)[number];
export type EventPageLegacyCommerceBlockType =
  (typeof EVENT_PAGE_LEGACY_COMMERCE_BLOCK_TYPES)[number];

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
  discovery: EventPageDiscoveryMetadata;
};

export type EventPageRootProps = {
  title?: string;
  description?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  accentColor?: string;
  accentForegroundColor?: string;
  fontFamily?: string;
  headingFontFamily?: string;
  radius?: string;
};

export type EventPagePuckContentItem<
  Type extends EventPagePuckComponentType,
  Props extends Record<string, unknown>,
> = {
  type: Type;
  props: Props & { id: string };
};

export type EventPageHeroProps = {
  eyebrow?: string;
  headline: string;
  body?: string;
  imageUrl?: string;
  imageAlt?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  alignment?: 'left' | 'center';
};

export type EventPageRichTextProps = {
  body: string;
};

export type EventPageMediaProps = {
  imageUrl: string;
  imageAlt: string;
  caption?: string;
  aspectRatio?: 'auto' | '16:9' | '4:3' | '1:1';
};

export type EventPageDetailItem = {
  label: string;
  value: string;
};

export type EventPageDetailsProps = {
  title: string;
  items: EventPageDetailItem[];
};

export type EventPageScheduleItem = {
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  description?: string;
};

export type EventPageScheduleProps = {
  title: string;
  items: EventPageScheduleItem[];
};

export type EventPageVenueProps = {
  title: string;
  venueName: string;
  address?: string;
  mapUrl?: string;
};

export type EventPageFaqItem = {
  question: string;
  answer: string;
};

export type EventPageFaqProps = {
  title: string;
  items: EventPageFaqItem[];
};

export type EventPageLogoItem = {
  name: string;
  url?: string;
  imageUrl?: string;
  imageAlt?: string;
};

export type EventPageSponsorsProps = {
  title: string;
  items: EventPageLogoItem[];
};

export type EventPagePersonItem = {
  name: string;
  role?: string;
  bio?: string;
  imageUrl?: string;
  imageAlt?: string;
  url?: string;
};

export type EventPageSpeakersProps = {
  title: string;
  items: EventPagePersonItem[];
};

export type EventPageButtonProps = {
  label: string;
  url: string;
  style?: 'primary' | 'secondary' | 'link';
  alignment?: 'left' | 'center';
};

export type EventPageDividerProps = {
  spacing?: 'compact' | 'normal' | 'loose';
};

export type EventPageLink = {
  label: string;
  url: string;
};

export type EventPageSocialLinksProps = {
  title?: string;
  links: EventPageLink[];
};

export type EventPageCustomEmbedProps = {
  html: string;
  allowUnsafeEmbed: boolean;
};

export type EventPagePuckComponentData =
  | EventPagePuckContentItem<'Hero', EventPageHeroProps>
  | EventPagePuckContentItem<'RichText', EventPageRichTextProps>
  | EventPagePuckContentItem<'Media', EventPageMediaProps>
  | EventPagePuckContentItem<'EventDetails', EventPageDetailsProps>
  | EventPagePuckContentItem<'Schedule', EventPageScheduleProps>
  | EventPagePuckContentItem<'Venue', EventPageVenueProps>
  | EventPagePuckContentItem<'FAQ', EventPageFaqProps>
  | EventPagePuckContentItem<'Sponsors', EventPageSponsorsProps>
  | EventPagePuckContentItem<'Speakers', EventPageSpeakersProps>
  | EventPagePuckContentItem<'Button', EventPageButtonProps>
  | EventPagePuckContentItem<'Divider', EventPageDividerProps>
  | EventPagePuckContentItem<'SocialLinks', EventPageSocialLinksProps>
  | EventPagePuckContentItem<'CustomEmbed', EventPageCustomEmbedProps>;

export type EventPagePuckRootData = {
  props: EventPageRootProps;
};

export type EventPagePuckData = {
  root: EventPagePuckRootData;
  content: EventPagePuckComponentData[];
  zones?: Record<string, EventPagePuckComponentData[]>;
};

export type EventPageDocument = {
  schemaVersion: typeof EVENT_PAGE_SCHEMA_VERSION;
  editor: {
    provider: typeof PUCK_EVENT_PAGE_PROVIDER;
    data: EventPagePuckData;
  };
  settings: EventPageSettings;
};

export type EventPageDocumentV2 = EventPageDocument;
export type EventPageSettingsV2 = EventPageSettings;
export type EventPageDiscoveryMetadataV2 = EventPageDiscoveryMetadata;
export type EventPageValidationResultV2 = ContentValidationResult;

export type EventPageRenderContext = Record<string, unknown> & {
  event?: {
    id?: string;
    title?: string;
    description?: string;
    startsAt?: string;
    endsAt?: string;
    timezone?: string;
    venueName?: string;
    publicUrl?: string;
  };
  brand?: {
    name?: string;
  };
};

export type EventPageDiscoveryCardV2 = {
  title: string;
  summary: string;
  category?: string;
  tags: string[];
  imageUrl?: string;
  startsAt?: string;
  venueName?: string;
  publicPath?: string;
};

export type EventPageDiscoveryCard = EventPageDiscoveryCardV2;

export type EventPagePublicDocumentMetadataV2 = {
  eventId: string;
  channel: 'event_page';
  key: string;
  name: string;
  locale: string;
  updatedAt: string;
};

export type EventPagePublicVersionMetadataV2 = {
  versionNumber: number;
  subject?: string;
  previewText?: string;
  publishedAt?: string;
};

export type PublicEventPagePayloadV2 = {
  document: EventPagePublicDocumentMetadataV2;
  version: EventPagePublicVersionMetadataV2;
  page: {
    provider: typeof PUCK_EVENT_PAGE_PROVIDER;
    puckData: EventPagePuckData;
    settings: EventPageSettings;
    discovery: EventPageDiscoveryCard;
    validation?: EventPageValidationResultV2;
  };
};

export type EventPageValidationOptions = {
  allowUnsafeEmbeds?: boolean;
};

export type CreateDefaultEventPageDocumentInput = {
  eventId: string;
  eventTitle: string;
  eventDescription?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  venue?: {
    name?: string;
    address?: string;
    city?: string;
    region?: string;
    country?: string;
    mapUrl?: string;
  };
  brandName?: string;
  coverImageUrl?: string;
  coverImageAlt?: string;
  publicUrl?: string;
  locale?: string;
};

export type EventPageLegacyBlock = Record<string, unknown> & {
  id?: string;
  type?: string;
};

export type EventPageLegacyDocument = {
  blocks?: unknown[];
  settings?: Partial<EventPageSettings>;
};

export type EventPageBrandVariables = {
  background?: string;
  foreground?: string;
  accent?: string;
  accentForeground?: string;
  fontBody?: string;
  fontHeading?: string;
  radius?: string;
};

export function createDefaultEventPageDocument(
  input: CreateDefaultEventPageDocumentInput,
): EventPageDocument {
  return {
    schemaVersion: EVENT_PAGE_SCHEMA_VERSION,
    editor: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      data: createDefaultEventPageData(input),
    },
    settings: createDefaultEventPageSettings(input),
  };
}

export function createDefaultEventPageData(
  input: CreateDefaultEventPageDocumentInput,
): EventPagePuckData {
  const title = nonEmpty(input.eventTitle, 'Untitled event');
  const description = cleanOptionalString(input.eventDescription);
  const startsAt = cleanOptionalString(input.startsAt);
  const endsAt = cleanOptionalString(input.endsAt);
  const timezone = cleanOptionalString(input.timezone);
  const venueName = cleanOptionalString(input.venue?.name);
  const venueAddress = formatVenueAddress(input.venue);
  const dateLabel = startsAt ?? 'Date to be announced';
  const timezoneLabel = timezone ?? 'Timezone to be announced';
  const venueLabel = venueName ?? 'Venue to be announced';

  const content: EventPagePuckComponentData[] = [
    {
      type: 'Hero',
      props: {
        id: blockId('hero', input.eventId),
        eyebrow: cleanOptionalString(input.brandName),
        headline: title,
        body: description,
        imageUrl: cleanOptionalString(input.coverImageUrl),
        imageAlt: cleanOptionalString(input.coverImageAlt) ?? title,
        alignment: 'left',
      },
    },
    {
      type: 'EventDetails',
      props: {
        id: blockId('details', input.eventId),
        title: 'Event details',
        items: detailItems([
          ['Date', dateLabel],
          ['Timezone', timezoneLabel],
          ['Venue', venueLabel],
        ]),
      },
    },
    {
      type: 'Schedule',
      props: {
        id: blockId('schedule', input.eventId),
        title: 'Schedule',
        items: [
          {
            title: 'Event starts',
            startsAt: dateLabel,
            endsAt,
            location: venueName,
          },
        ],
      },
    },
    {
      type: 'Venue',
      props: {
        id: blockId('venue', input.eventId),
        title: 'Venue',
        venueName: venueName ?? 'Venue to be announced',
        address: venueAddress,
        mapUrl: cleanOptionalString(input.venue?.mapUrl),
      },
    },
    {
      type: 'FAQ',
      props: {
        id: blockId('faq', input.eventId),
        title: 'FAQ',
        items: [
          {
            question: 'Where can I get help?',
            answer: 'Contact the organizer for event-specific questions.',
          },
        ],
      },
    },
  ];

  return {
    root: {
      props: {
        title,
        description,
        backgroundColor: '#ffffff',
        foregroundColor: '#111111',
        accentColor: '#111111',
        accentForegroundColor: '#ffffff',
        fontFamily: 'Inter, system-ui, sans-serif',
        headingFontFamily: 'Inter, system-ui, sans-serif',
        radius: '14px',
      },
    },
    content,
  };
}

export function createDefaultEventPageSettings(
  input: CreateDefaultEventPageDocumentInput,
): EventPageSettings {
  const title = nonEmpty(input.eventTitle, 'Untitled event');
  const summary = nonEmpty(input.eventDescription, `Details for ${title}.`);
  return {
    locale: cleanOptionalString(input.locale) ?? 'en',
    publicPath: cleanOptionalString(input.publicUrl),
    discovery: {
      summary,
      tags: [],
      coverImageUrl: cleanOptionalString(input.coverImageUrl),
      socialImageUrl: cleanOptionalString(input.coverImageUrl),
      seoTitle: title,
      seoDescription: summary,
    },
  };
}

export function normalizeEventPageDocument(value: unknown): EventPageDocument | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== EVENT_PAGE_SCHEMA_VERSION) return undefined;
  if (!isRecord(value.editor)) return undefined;
  if (value.editor.provider !== PUCK_EVENT_PAGE_PROVIDER) return undefined;
  if (!isEventPagePuckDataShape(value.editor.data)) return undefined;
  if (!isEventPageSettingsShape(value.settings)) return undefined;
  return value as EventPageDocument;
}

export function isEventPageDocument(value: unknown): value is EventPageDocument {
  return normalizeEventPageDocument(value) !== undefined;
}

export function normalizeEventPageDocumentV2(value: unknown): EventPageDocumentV2 | undefined {
  return normalizeEventPageDocument(value);
}

export function isEventPageDocumentV2(value: unknown): value is EventPageDocumentV2 {
  return normalizeEventPageDocumentV2(value) !== undefined;
}

export function validateEventPageDocument(
  value: unknown,
  options: EventPageValidationOptions = {},
): ContentValidationResult {
  const issues: ContentValidationIssue[] = [];
  const document = normalizeEventPageDocument(value);

  if (!document) {
    issues.push(
      issue(
        'invalid_event_page_document',
        'Event page content must be a schemaVersion 2 Puck document.',
        'error',
      ),
    );
    return validationResult(issues);
  }

  issues.push(...validateEventPageSettings(document.settings));
  issues.push(...validateEventPagePuckData(document.editor.data, options));
  return validationResult(issues);
}

export function validateEventPageDocumentV2(
  value: unknown,
  options: EventPageValidationOptions = {},
): EventPageValidationResultV2 {
  return validateEventPageDocument(value, options);
}

export function validateEventPageSettings(settings: EventPageSettings): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  if (!nonEmpty(settings.locale)) {
    issues.push(issue('missing_locale', 'Event page settings.locale is required.', 'error', 'settings.locale'));
  }
  if (!isRecord(settings.discovery)) {
    issues.push(
      issue('missing_discovery', 'Event page discovery metadata is required.', 'error', 'settings.discovery'),
    );
    return issues;
  }
  if (!nonEmpty(settings.discovery.summary)) {
    issues.push(
      issue(
        'missing_discovery_summary',
        'Event page discovery.summary is required.',
        'error',
        'settings.discovery.summary',
      ),
    );
  }
  validateOptionalUrl(issues, settings.publicPath, 'settings.publicPath');
  validateOptionalUrl(issues, settings.discovery.coverImageUrl, 'settings.discovery.coverImageUrl');
  validateOptionalUrl(issues, settings.discovery.socialImageUrl, 'settings.discovery.socialImageUrl');
  return issues;
}

export function validateEventPagePuckData(
  data: unknown,
  options: EventPageValidationOptions = {},
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  if (!isEventPagePuckDataShape(data)) {
    return [
      issue(
        'invalid_puck_data',
        'Event page editor.data must contain a root object and content array.',
        'error',
        'editor.data',
      ),
    ];
  }

  validateRootProps(issues, data.root.props, 'editor.data.root.props');
  validateContentItems(issues, data.content, 'editor.data.content', options);

  if (data.zones !== undefined) {
    if (!isRecord(data.zones)) {
      issues.push(
        issue('invalid_zones', 'Event page editor.data.zones must be an object.', 'error', 'editor.data.zones'),
      );
    } else {
      for (const [zoneName, items] of Object.entries(data.zones)) {
        if (!Array.isArray(items)) {
          issues.push(
            issue(
              'invalid_zone_content',
              'Event page Puck zones must contain arrays of content blocks.',
              'error',
              `editor.data.zones.${zoneName}`,
            ),
          );
          continue;
        }
        validateContentItems(issues, items, `editor.data.zones.${zoneName}`, options);
      }
    }
  }

  return issues;
}

export function isSafeEventPageUrl(value: unknown, allowRelative = true): value is string {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!url) return false;
  if (allowRelative && url.startsWith('/') && !url.startsWith('//')) return true;
  return isAllowedDestination(url);
}

export function sanitizeEventPageHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+(href|src)\s*=\s*"(?:(?:javascript|data|file):)[^"]*"/gi, '')
    .replace(/\s+(href|src)\s*=\s*'(?:(?:javascript|data|file):)[^']*'/gi, '')
    .replace(/\s+(href|src)\s*=\s*(?:(?:javascript|data|file):)[^\s>]+/gi, '');
}

export function hasUnsafeEventPageHtml(html: string): boolean {
  return /<script\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /\s(?:href|src)\s*=\s*(?:"|'|)?\s*(?:javascript|data|file):/i.test(html);
}

export function migrateLegacyEventPageDocumentToPuck(
  legacy: EventPageLegacyDocument,
  fallback: CreateDefaultEventPageDocumentInput,
): EventPageDocument {
  const settings = createDefaultEventPageSettings(fallback);
  return {
    schemaVersion: EVENT_PAGE_SCHEMA_VERSION,
    editor: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      data: migrateLegacyEventPageBlocksToPuckData(legacy.blocks ?? [], {
        root: createDefaultEventPageData(fallback).root.props,
      }),
    },
    settings: {
      ...settings,
      ...legacy.settings,
      discovery: {
        ...settings.discovery,
        ...legacy.settings?.discovery,
        tags: legacy.settings?.discovery?.tags ?? settings.discovery.tags,
      },
    },
  };
}

export function migrateEventPageDocumentToV2(
  legacy: EventPageLegacyDocument,
  fallback: CreateDefaultEventPageDocumentInput = DEFAULT_EVENT_PAGE_DOCUMENT_INPUT,
): EventPageDocumentV2 {
  return migrateLegacyEventPageDocumentToPuck(legacy, fallback);
}

export function normalizeOrMigrateEventPageDocumentV2(
  value: unknown,
  fallback: CreateDefaultEventPageDocumentInput = DEFAULT_EVENT_PAGE_DOCUMENT_INPUT,
): EventPageDocumentV2 | undefined {
  const normalized = normalizeEventPageDocumentV2(value);
  if (normalized) return normalized;
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.blocks) && !isRecord(value.settings)) return undefined;
  return migrateEventPageDocumentToV2(value as EventPageLegacyDocument, fallback);
}

export function migrateLegacyEventPageBlocksToPuckData(
  legacyBlocks: unknown[],
  options: { root?: Partial<EventPageRootProps> } = {},
): EventPagePuckData {
  const content: EventPagePuckComponentData[] = [];

  legacyBlocks.forEach((block, index) => {
    if (!isRecord(block)) return;
    const type = cleanOptionalString(block.type);
    if (!type || legacyCommerceBlockTypeSet.has(type)) return;

    const id = cleanOptionalString(block.id) ?? `migrated-${index + 1}`;
    switch (type) {
      case 'hero':
        content.push({
          type: 'Hero',
          props: {
            id,
            eyebrow: cleanOptionalString(block.eyebrow),
            headline: nonEmpty(block.headline, 'Event headline'),
            body: cleanOptionalString(block.body),
            imageUrl: cleanOptionalString(block.imageUrl),
            imageAlt: cleanOptionalString(block.imageAlt),
            ctaLabel: cleanOptionalString(block.ctaLabel),
            ctaUrl: cleanOptionalString(block.ctaUrl),
            alignment: readAlignment(block.alignment),
          },
        });
        break;
      case 'rich_text':
        content.push({
          type: 'RichText',
          props: {
            id,
            body: legacyRichTextToHtml(block.content),
          },
        });
        break;
      case 'image':
      case 'media':
        content.push({
          type: 'Media',
          props: {
            id,
            imageUrl: nonEmpty(block.imageUrl ?? block.url, ''),
            imageAlt: nonEmpty(block.imageAlt ?? block.alt, ''),
            caption: cleanOptionalString(block.caption),
            aspectRatio: readAspectRatio(block.aspectRatio),
          },
        });
        break;
      case 'event_details':
        content.push({
          type: 'EventDetails',
          props: {
            id,
            title: nonEmpty(block.title, 'Event details'),
            items: readDetailItems(block.items),
          },
        });
        break;
      case 'schedule':
        content.push({
          type: 'Schedule',
          props: {
            id,
            title: nonEmpty(block.title, 'Schedule'),
            items: readScheduleItems(block.items),
          },
        });
        break;
      case 'venue':
      case 'venue_map':
        content.push({
          type: 'Venue',
          props: {
            id,
            title: nonEmpty(block.title, 'Venue'),
            venueName: nonEmpty(block.venueName, 'Venue'),
            address: cleanOptionalString(block.address),
            mapUrl: cleanOptionalString(block.mapUrl),
          },
        });
        break;
      case 'faq':
        content.push({
          type: 'FAQ',
          props: {
            id,
            title: nonEmpty(block.title, 'FAQ'),
            items: readFaqItems(block.items),
          },
        });
        break;
      case 'sponsors':
        content.push({
          type: 'Sponsors',
          props: {
            id,
            title: nonEmpty(block.title, 'Sponsors'),
            items: readLogoItems(block.items),
          },
        });
        break;
      case 'speakers':
        content.push({
          type: 'Speakers',
          props: {
            id,
            title: nonEmpty(block.title, 'Speakers'),
            items: readPersonItems(block.items),
          },
        });
        break;
      case 'button':
        content.push({
          type: 'Button',
          props: {
            id,
            label: nonEmpty(block.label, 'Learn more'),
            url: nonEmpty(block.url, '#'),
            style: readButtonStyle(block.style),
            alignment: readAlignment(block.alignment),
          },
        });
        break;
      case 'divider':
        content.push({
          type: 'Divider',
          props: {
            id,
            spacing: readDividerSpacing(block.spacing),
          },
        });
        break;
      case 'social_links':
        content.push({
          type: 'SocialLinks',
          props: {
            id,
            title: cleanOptionalString(block.title),
            links: readLinks(block.links),
          },
        });
        break;
      case 'custom_embed':
        content.push({
          type: 'CustomEmbed',
          props: {
            id,
            html: nonEmpty(block.html, ''),
            allowUnsafeEmbed: block.allowUnsafeEmbed === true,
          },
        });
        break;
    }
  });

  const hero = content.find((block) => block.type === 'Hero') as
    | EventPagePuckContentItem<'Hero', EventPageHeroProps>
    | undefined;
  const rootTitle = cleanOptionalString(options.root?.title);
  const rootDescription = cleanOptionalString(options.root?.description);

  return {
    root: {
      props: {
        backgroundColor: '#ffffff',
        foregroundColor: '#111111',
        accentColor: '#111111',
        accentForegroundColor: '#ffffff',
        fontFamily: 'Inter, system-ui, sans-serif',
        headingFontFamily: 'Inter, system-ui, sans-serif',
        radius: '14px',
        ...options.root,
        title: rootTitle === DEFAULT_EVENT_PAGE_DOCUMENT_INPUT.eventTitle ? hero?.props.headline : rootTitle,
        description: rootDescription ?? hero?.props.body,
      },
    },
    content,
  };
}

export function eventPageBrandVariablesToCssProperties(
  variables: EventPageBrandVariables = {},
): Record<`--tk-brand-${string}`, string> {
  const css: Record<`--tk-brand-${string}`, string> = {};
  if (variables.background) css['--tk-brand-bg'] = variables.background;
  if (variables.foreground) css['--tk-brand-fg'] = variables.foreground;
  if (variables.accent) css['--tk-brand-accent'] = variables.accent;
  if (variables.accentForeground) css['--tk-brand-accent-fg'] = variables.accentForeground;
  if (variables.fontBody) css['--tk-brand-font-body'] = variables.fontBody;
  if (variables.fontHeading) css['--tk-brand-font-heading'] = variables.fontHeading;
  if (variables.radius) css['--tk-brand-radius'] = variables.radius;
  return css;
}

export function resolveEventPageDocumentV2Discovery(
  document: EventPageDocumentV2,
  context: EventPageRenderContext = {},
): EventPageDiscoveryCardV2 {
  const root = document.editor.data.root.props;
  const hero = document.editor.data.content.find((block) => block.type === 'Hero');
  const heroProps = hero?.props as Partial<EventPageHeroProps> | undefined;
  const title =
    cleanOptionalString(root.title) ??
    cleanOptionalString(heroProps?.headline) ??
    cleanOptionalString(context.event?.title) ??
    'Untitled event';
  const summary =
    cleanOptionalString(document.settings.discovery.summary) ??
    cleanOptionalString(root.description) ??
    cleanOptionalString(heroProps?.body) ??
    cleanOptionalString(context.event?.description) ??
    `Details for ${title}.`;

  return {
    title,
    summary,
    category: cleanOptionalString(document.settings.discovery.category),
    tags: Array.isArray(document.settings.discovery.tags)
      ? document.settings.discovery.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [],
    imageUrl:
      cleanOptionalString(document.settings.discovery.coverImageUrl) ??
      cleanOptionalString(heroProps?.imageUrl),
    startsAt: cleanOptionalString(context.event?.startsAt),
    venueName: cleanOptionalString(context.event?.venueName),
    publicPath: cleanOptionalString(document.settings.publicPath) ?? cleanOptionalString(context.event?.publicUrl),
  };
}

export function normalizePublicEventPagePayloadV2(value: unknown): PublicEventPagePayloadV2 | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.document) || !isRecord(value.version) || !isRecord(value.page)) return undefined;

  if ('html' in value.page || 'text' in value.page || 'headless' in value.page || 'renderModel' in value.page) {
    return undefined;
  }
  if ('contentJson' in value.page || 'document' in value.page || 'data' in value.page) return undefined;
  if (value.page.provider !== PUCK_EVENT_PAGE_PROVIDER) return undefined;
  if (!isEventPagePuckDataShape(value.page.puckData)) return undefined;
  if (!isEventPageSettingsShape(value.page.settings)) return undefined;

  const documentMetadata = normalizePublicDocumentMetadata(value.document);
  const versionMetadata = normalizePublicVersionMetadata(value.version);
  const discovery = normalizeEventPageDiscoveryCard(value.page.discovery);
  if (!documentMetadata || !versionMetadata || !discovery) return undefined;

  const validation = normalizeValidationResult(value.page.validation);
  return {
    document: documentMetadata,
    version: versionMetadata,
    page: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      puckData: value.page.puckData,
      settings: value.page.settings,
      discovery,
      ...(validation ? { validation } : {}),
    },
  };
}

function validateContentItems(
  issues: ContentValidationIssue[],
  items: unknown[],
  field: string,
  options: EventPageValidationOptions,
): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const path = `${field}.${index}`;
    if (!isRecord(item)) {
      issues.push(issue('invalid_block', 'Event page content blocks must be objects.', 'error', path));
      return;
    }

    const type = cleanOptionalString(item.type);
    if (!type) {
      issues.push(issue('missing_block_type', 'Event page content block type is required.', 'error', `${path}.type`));
      return;
    }
    if (legacyCommerceBlockTypeSet.has(type)) {
      issues.push(
        issue(
          'commerce_block_not_content',
          `Legacy commerce block "${type}" must be rendered by checkout chrome, not Puck content.`,
          'error',
          `${path}.type`,
        ),
      );
      return;
    }
    if (!eventPagePuckComponentTypeSet.has(type)) {
      issues.push(issue('unknown_block_type', `Unknown event page Puck block "${type}".`, 'error', `${path}.type`));
      return;
    }

    if (!isRecord(item.props)) {
      issues.push(issue('missing_block_props', 'Event page content block props are required.', 'error', `${path}.props`));
      return;
    }
    const id = cleanOptionalString(item.props.id);
    if (!id) {
      issues.push(issue('missing_block_id', 'Event page content block id is required.', 'error', `${path}.props.id`));
    } else if (ids.has(id)) {
      issues.push(issue('duplicate_block_id', `Duplicate event page block id "${id}".`, 'error', `${path}.props.id`));
    } else {
      ids.add(id);
    }

    validateComponentProps(issues, type as EventPagePuckComponentType, item.props, `${path}.props`, options);
  });
}

function validateComponentProps(
  issues: ContentValidationIssue[],
  type: EventPagePuckComponentType,
  props: Record<string, unknown>,
  field: string,
  options: EventPageValidationOptions,
): void {
  switch (type) {
    case 'Hero':
      validateRequiredString(issues, props.headline, `${field}.headline`, 'Hero headline is required.');
      validateOptionalUrl(issues, props.imageUrl, `${field}.imageUrl`);
      validateImageAlt(issues, props.imageUrl, props.imageAlt, `${field}.imageAlt`);
      validateOptionalUrl(issues, props.ctaUrl, `${field}.ctaUrl`);
      break;
    case 'RichText':
      validateRequiredString(issues, props.body, `${field}.body`, 'Rich text body is required.');
      if (typeof props.body === 'string' && hasUnsafeEventPageHtml(props.body)) {
        issues.push(issue('unsafe_html', 'Rich text contains unsafe HTML.', 'error', `${field}.body`));
      }
      break;
    case 'Media':
      validateRequiredString(issues, props.imageUrl, `${field}.imageUrl`, 'Media imageUrl is required.');
      validateRequiredString(issues, props.imageAlt, `${field}.imageAlt`, 'Media imageAlt is required.');
      validateOptionalUrl(issues, props.imageUrl, `${field}.imageUrl`);
      break;
    case 'EventDetails':
      validateRequiredString(issues, props.title, `${field}.title`, 'Event details title is required.');
      validateDetailItems(issues, props.items, `${field}.items`);
      break;
    case 'Schedule':
      validateRequiredString(issues, props.title, `${field}.title`, 'Schedule title is required.');
      validateScheduleItems(issues, props.items, `${field}.items`);
      break;
    case 'Venue':
      validateRequiredString(issues, props.title, `${field}.title`, 'Venue title is required.');
      validateRequiredString(issues, props.venueName, `${field}.venueName`, 'Venue name is required.');
      validateOptionalUrl(issues, props.mapUrl, `${field}.mapUrl`);
      break;
    case 'FAQ':
      validateRequiredString(issues, props.title, `${field}.title`, 'FAQ title is required.');
      validateFaqItems(issues, props.items, `${field}.items`);
      break;
    case 'Sponsors':
      validateRequiredString(issues, props.title, `${field}.title`, 'Sponsors title is required.');
      validateLogoItems(issues, props.items, `${field}.items`);
      break;
    case 'Speakers':
      validateRequiredString(issues, props.title, `${field}.title`, 'Speakers title is required.');
      validatePersonItems(issues, props.items, `${field}.items`);
      break;
    case 'Button':
      validateRequiredString(issues, props.label, `${field}.label`, 'Button label is required.');
      validateRequiredString(issues, props.url, `${field}.url`, 'Button URL is required.');
      validateOptionalUrl(issues, props.url, `${field}.url`);
      break;
    case 'Divider':
      break;
    case 'SocialLinks':
      validateLinks(issues, props.links, `${field}.links`);
      break;
    case 'CustomEmbed':
      validateRequiredString(issues, props.html, `${field}.html`, 'Custom embed HTML is required.');
      if (props.allowUnsafeEmbed !== true && nonEmpty(props.html)) {
        issues.push(
          issue(
            'embed_requires_opt_in',
            'Custom embeds must explicitly set allowUnsafeEmbed to true.',
            'error',
            `${field}.allowUnsafeEmbed`,
          ),
        );
      }
      if (!options.allowUnsafeEmbeds && typeof props.html === 'string' && hasUnsafeEventPageHtml(props.html)) {
        issues.push(issue('unsafe_embed_html', 'Custom embed contains unsafe HTML.', 'error', `${field}.html`));
      }
      break;
  }
}

function validateRootProps(
  issues: ContentValidationIssue[],
  root: EventPageRootProps,
  field: string,
): void {
  validateOptionalColor(issues, root.backgroundColor, `${field}.backgroundColor`);
  validateOptionalColor(issues, root.foregroundColor, `${field}.foregroundColor`);
  validateOptionalColor(issues, root.accentColor, `${field}.accentColor`);
  validateOptionalColor(issues, root.accentForegroundColor, `${field}.accentForegroundColor`);
  if (root.radius !== undefined && typeof root.radius !== 'string') {
    issues.push(issue('invalid_radius', 'Root radius must be a CSS string.', 'error', `${field}.radius`));
  }
}

function validateDetailItems(
  issues: ContentValidationIssue[],
  items: unknown,
  field: string,
): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(issue('missing_detail_items', 'Event details must include at least one item.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue('invalid_detail_item', 'Event detail items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, item.label, `${field}.${index}.label`, 'Event detail label is required.');
    validateRequiredString(issues, item.value, `${field}.${index}.value`, 'Event detail value is required.');
  });
}

function validateScheduleItems(
  issues: ContentValidationIssue[],
  items: unknown,
  field: string,
): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(issue('missing_schedule_items', 'Schedule must include at least one item.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue('invalid_schedule_item', 'Schedule items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, item.title, `${field}.${index}.title`, 'Schedule item title is required.');
    validateRequiredString(issues, item.startsAt, `${field}.${index}.startsAt`, 'Schedule item startsAt is required.');
  });
}

function validateFaqItems(issues: ContentValidationIssue[], items: unknown, field: string): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(issue('missing_faq_items', 'FAQ must include at least one item.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue('invalid_faq_item', 'FAQ items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, item.question, `${field}.${index}.question`, 'FAQ question is required.');
    validateRequiredString(issues, item.answer, `${field}.${index}.answer`, 'FAQ answer is required.');
  });
}

function validateLogoItems(issues: ContentValidationIssue[], items: unknown, field: string): void {
  if (!Array.isArray(items)) {
    issues.push(issue('invalid_logo_items', 'Sponsor items must be an array.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue('invalid_logo_item', 'Sponsor items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, item.name, `${field}.${index}.name`, 'Sponsor name is required.');
    validateOptionalUrl(issues, item.url, `${field}.${index}.url`);
    validateOptionalUrl(issues, item.imageUrl, `${field}.${index}.imageUrl`);
    validateImageAlt(issues, item.imageUrl, item.imageAlt, `${field}.${index}.imageAlt`);
  });
}

function validatePersonItems(issues: ContentValidationIssue[], items: unknown, field: string): void {
  if (!Array.isArray(items)) {
    issues.push(issue('invalid_person_items', 'Speaker items must be an array.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue('invalid_person_item', 'Speaker items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, item.name, `${field}.${index}.name`, 'Speaker name is required.');
    validateOptionalUrl(issues, item.url, `${field}.${index}.url`);
    validateOptionalUrl(issues, item.imageUrl, `${field}.${index}.imageUrl`);
    validateImageAlt(issues, item.imageUrl, item.imageAlt, `${field}.${index}.imageAlt`);
  });
}

function validateLinks(issues: ContentValidationIssue[], links: unknown, field: string): void {
  if (!Array.isArray(links) || links.length === 0) {
    issues.push(issue('missing_links', 'Social links must include at least one link.', 'error', field));
    return;
  }
  links.forEach((link, index) => {
    if (!isRecord(link)) {
      issues.push(issue('invalid_link', 'Social link items must be objects.', 'error', `${field}.${index}`));
      return;
    }
    validateRequiredString(issues, link.label, `${field}.${index}.label`, 'Social link label is required.');
    validateRequiredString(issues, link.url, `${field}.${index}.url`, 'Social link URL is required.');
    validateOptionalUrl(issues, link.url, `${field}.${index}.url`);
  });
}

function validateOptionalUrl(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  if (!isSafeEventPageUrl(value)) {
    issues.push(issue('unsafe_url', 'URL must be http(s) and cannot target private hosts.', 'error', field));
  }
}

function validateOptionalColor(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    issues.push(issue('invalid_color', 'Color values must be six-digit hex colors.', 'error', field));
  }
}

function validateImageAlt(
  issues: ContentValidationIssue[],
  imageUrl: unknown,
  imageAlt: unknown,
  field: string,
): void {
  if (!nonEmpty(imageUrl)) return;
  if (!nonEmpty(imageAlt)) {
    issues.push(issue('missing_image_alt', 'Images must include alt text.', 'error', field));
  }
}

function validateRequiredString(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
  message: string,
): void {
  if (!nonEmpty(value)) {
    issues.push(issue('missing_required_text', message, 'error', field));
  }
}

function isEventPagePuckDataShape(value: unknown): value is EventPagePuckData {
  return (
    isRecord(value) &&
    isRecord(value.root) &&
    isRecord(value.root.props) &&
    Array.isArray(value.content)
  );
}

function isEventPageSettingsShape(value: unknown): value is EventPageSettings {
  return isRecord(value) && typeof value.locale === 'string' && isRecord(value.discovery);
}

function normalizePublicDocumentMetadata(
  value: Record<string, unknown>,
): EventPagePublicDocumentMetadataV2 | undefined {
  const eventId = cleanOptionalString(value.eventId);
  const key = cleanOptionalString(value.key);
  const name = cleanOptionalString(value.name);
  const locale = cleanOptionalString(value.locale);
  const updatedAt = cleanOptionalString(value.updatedAt);
  if (!eventId || value.channel !== 'event_page' || !key || !name || !locale || !updatedAt) return undefined;
  return {
    eventId,
    channel: 'event_page',
    key,
    name,
    locale,
    updatedAt,
  };
}

function normalizePublicVersionMetadata(
  value: Record<string, unknown>,
): EventPagePublicVersionMetadataV2 | undefined {
  if (typeof value.versionNumber !== 'number' || !Number.isFinite(value.versionNumber)) return undefined;
  return {
    versionNumber: value.versionNumber,
    subject: cleanOptionalString(value.subject),
    previewText: cleanOptionalString(value.previewText),
    publishedAt: cleanOptionalString(value.publishedAt),
  };
}

function normalizeEventPageDiscoveryCard(value: unknown): EventPageDiscoveryCardV2 | undefined {
  if (!isRecord(value)) return undefined;
  const title = cleanOptionalString(value.title);
  const summary = cleanOptionalString(value.summary);
  if (!title || !summary) return undefined;
  return {
    title,
    summary,
    category: cleanOptionalString(value.category),
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      : [],
    imageUrl: cleanOptionalString(value.imageUrl),
    startsAt: cleanOptionalString(value.startsAt),
    venueName: cleanOptionalString(value.venueName),
    publicPath: cleanOptionalString(value.publicPath),
  };
}

function normalizeValidationResult(value: unknown): EventPageValidationResultV2 | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.valid !== 'boolean') return undefined;
  const severity = value.severity === 'warning' || value.severity === 'error' ? value.severity : undefined;
  if (!severity || !Array.isArray(value.issues)) return undefined;
  const issues = value.issues.flatMap((validationIssue): ContentValidationIssue[] => {
    if (!isRecord(validationIssue)) return [];
    const code = cleanOptionalString(validationIssue.code);
    const message = cleanOptionalString(validationIssue.message);
    const issueSeverity =
      validationIssue.severity === 'warning' || validationIssue.severity === 'error'
        ? validationIssue.severity
        : undefined;
    if (!code || !message || !issueSeverity) return [];
    return [
      {
        code,
        message,
        severity: issueSeverity,
        ...(cleanOptionalString(validationIssue.field)
          ? { field: cleanOptionalString(validationIssue.field) }
          : {}),
      },
    ];
  });
  return { valid: value.valid, severity, issues };
}

function issue(
  code: string,
  message: string,
  severity: ValidationSeverity,
  field?: string,
): ContentValidationIssue {
  return field ? { code, message, severity, field } : { code, message, severity };
}

function validationResult(issues: ContentValidationIssue[]): ContentValidationResult {
  const hasError = issues.some((validationIssue) => validationIssue.severity === 'error');
  return {
    valid: !hasError,
    severity: hasError ? 'error' : 'warning',
    issues,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmpty(value: unknown, fallback?: string): string {
  const cleaned = cleanOptionalString(value);
  if (cleaned) return cleaned;
  return fallback ?? '';
}

function blockId(prefix: string, eventId: string): string {
  const normalizedEventId = eventId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalizedEventId ? `${prefix}-${normalizedEventId}` : prefix;
}

function detailItems(input: Array<[string, string | undefined]>): EventPageDetailItem[] {
  return input
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => ({ label, value: value ?? '' }));
}

function formatVenueAddress(venue: CreateDefaultEventPageDocumentInput['venue']): string | undefined {
  if (!venue) return undefined;
  const parts = [venue.address, venue.city, venue.region, venue.country]
    .map((part) => cleanOptionalString(part))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function readAlignment(value: unknown): 'left' | 'center' | undefined {
  return value === 'left' || value === 'center' ? value : undefined;
}

function readAspectRatio(value: unknown): EventPageMediaProps['aspectRatio'] {
  return value === '16:9' || value === '4:3' || value === '1:1' || value === 'auto'
    ? value
    : 'auto';
}

function readButtonStyle(value: unknown): EventPageButtonProps['style'] {
  return value === 'secondary' || value === 'link' || value === 'primary' ? value : 'primary';
}

function readDividerSpacing(value: unknown): EventPageDividerProps['spacing'] {
  return value === 'compact' || value === 'loose' || value === 'normal' ? value : 'normal';
}

function readDetailItems(value: unknown): EventPageDetailItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    label: nonEmpty(item.label, 'Detail'),
    value: nonEmpty(item.value, ''),
  }));
}

function readScheduleItems(value: unknown): EventPageScheduleItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    title: nonEmpty(item.title, 'Schedule item'),
    startsAt: nonEmpty(item.startsAt, ''),
    endsAt: cleanOptionalString(item.endsAt),
    location: cleanOptionalString(item.location),
    description: cleanOptionalString(item.description),
  }));
}

function readFaqItems(value: unknown): EventPageFaqItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    question: nonEmpty(item.question, 'Question'),
    answer: nonEmpty(item.answer, ''),
  }));
}

function readLogoItems(value: unknown): EventPageLogoItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    name: nonEmpty(item.name, 'Sponsor'),
    url: cleanOptionalString(item.url),
    imageUrl: cleanOptionalString(item.imageUrl),
    imageAlt: cleanOptionalString(item.imageAlt),
  }));
}

function readPersonItems(value: unknown): EventPagePersonItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    name: nonEmpty(item.name, 'Speaker'),
    role: cleanOptionalString(item.role),
    bio: cleanOptionalString(item.bio),
    imageUrl: cleanOptionalString(item.imageUrl),
    imageAlt: cleanOptionalString(item.imageAlt),
    url: cleanOptionalString(item.url),
  }));
}

function readLinks(value: unknown): EventPageLink[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    label: nonEmpty(item.label, 'Link'),
    url: nonEmpty(item.url, ''),
  }));
}

function legacyRichTextToHtml(value: unknown): string {
  if (typeof value === 'string') return sanitizeEventPageHtml(value);
  const text = tipTapText(value).trim();
  return text ? `<p>${escapeHtml(text)}</p>` : '';
}

function tipTapText(value: unknown): string {
  if (!isRecord(value)) return '';
  const ownText = typeof value.text === 'string' ? value.text : '';
  const childText = Array.isArray(value.content) ? value.content.map(tipTapText).join(' ') : '';
  return [ownText, childText].filter(Boolean).join(' ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
