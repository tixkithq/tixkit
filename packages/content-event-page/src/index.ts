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
  'EventHeader',
  'EventDescription',
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
  'Tickets',
  'ResaleTickets',
  'CheckoutCta',
  'BrandFooter',
] as const;

/** First-class page chrome blocks that form the default public page composition. */
export const EVENT_PAGE_CHROME_COMPONENT_TYPES = [
  'EventHeader',
  'Tickets',
  'ResaleTickets',
  'CheckoutCta',
  'BrandFooter',
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

export type EventPageAlignment = 'left' | 'center' | 'right';
export type EventPageSpacing = 'compact' | 'normal' | 'loose';
export type EventPageTextSize = 'small' | 'normal' | 'large';
export type EventPageRadiusPreset = 'none' | 'tight' | 'soft' | 'round';
export type EventPageSectionStyle = 'plain' | 'outlined' | 'filled';

export type EventPageSectionDesignProps = {
  alignment?: EventPageAlignment;
  spacing?: EventPageSpacing;
  sectionStyle?: EventPageSectionStyle;
  titleFontSize?: string;
  titleColor?: string;
};

export type EventPagePuckContentItem<
  Type extends EventPagePuckComponentType,
  Props extends Record<string, unknown>,
> = {
  type: Type;
  props: Props & { id: string };
};

/** Editable event body section. Section title renders as h2 for page outline. */
export type EventPageEventDescriptionProps = {
  eyebrow?: string;
  title?: string;
  body?: string;
  imageUrl?: string;
  imageAlt?: string;
  alignment?: EventPageAlignment;
  titleAlignment?: EventPageAlignment;
  bodyAlignment?: EventPageAlignment;
  imageAlignment?: EventPageAlignment;
  spacing?: EventPageSpacing;
  backgroundColor?: string;
  imageRadius?: EventPageRadiusPreset;
  imageLayout?: 'inline' | 'background';
  imageFit?: 'cover' | 'contain';
  imagePosition?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  imagePositionX?: string;
  imagePositionY?: string;
  imagePlacement?: {
    x?: string;
    y?: string;
    scale?: string;
  };
  overlayContentPosition?: 'top' | 'center' | 'bottom';
  overlayContentHorizontalPosition?: EventPageAlignment;
  overlayMinHeight?: string;
  overlayPadding?: string;
  imageOpacity?: string;
  backgroundOverlayColor?: string;
  backgroundOverlayOpacity?: string;
  imageOverlay?: unknown;
  logos?: EventPageLogoItem[];
  logoPosition?:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';
  logoSize?: 'sm' | 'md' | 'lg';
  logoMaxHeight?: string;
  logoMaxWidth?: string;
  eyebrowFontSize?: string;
  titleFontSize?: string;
  bodyFontSize?: string;
  eyebrowColor?: string;
  titleColor?: string;
  bodyColor?: string;
  contentBackgroundColor?: string;
  contentPadding?: string;
  contentRadius?: string;
  contentGap?: string;
};

export type EventPageRichTextProps = EventPageSectionDesignProps & {
  body: string;
  textSize?: EventPageTextSize;
  fontSize?: string;
  lineHeight?: string;
  paragraphGap?: string;
};

export type EventPageMediaProps = {
  imageUrl: string;
  imageAlt: string;
  caption?: string;
  aspectRatio?: 'auto' | '16:9' | '4:3' | '1:1';
  alignment?: EventPageAlignment;
  radius?: EventPageRadiusPreset;
  width?: 'normal' | 'wide';
  spacing?: EventPageSpacing;
  maxWidth?: string;
  customRadius?: string;
  captionFontSize?: string;
  overlayEnabled?: boolean;
  overlayContentPosition?: 'top' | 'center' | 'bottom';
  overlayMinHeight?: string;
  overlayPadding?: string;
  imageOpacity?: string;
  imageOverlay?: unknown;
};

export type EventPageDetailItem = {
  label: string;
  value: string;
};

export type EventPageDetailsProps = EventPageSectionDesignProps & {
  title: string;
  items: EventPageDetailItem[];
  labelFontSize?: string;
  valueFontSize?: string;
  labelColor?: string;
  valueColor?: string;
};

export type EventPageScheduleItem = {
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  description?: string;
};

export type EventPageScheduleProps = EventPageSectionDesignProps & {
  title: string;
  items: EventPageScheduleItem[];
};

export type EventPageVenueProps = EventPageSectionDesignProps & {
  title: string;
  venueName: string;
  address?: string;
  mapUrl?: string;
};

export type EventPageFaqItem = {
  question: string;
  answer: string;
};

export type EventPageFaqProps = EventPageSectionDesignProps & {
  title: string;
  items: EventPageFaqItem[];
};

export type EventPageLogoItem = {
  name: string;
  url?: string;
  imageUrl?: string;
  imageAlt?: string;
};

export type EventPageSponsorsProps = EventPageSectionDesignProps & {
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

export type EventPageSpeakersProps = EventPageSectionDesignProps & {
  title: string;
  items: EventPagePersonItem[];
};

export type EventPageButtonProps = {
  label: string;
  url: string;
  style?: 'primary' | 'secondary' | 'link';
  alignment?: EventPageAlignment;
  size?: 'small' | 'medium' | 'large';
  width?: 'auto' | 'full';
  radius?: 'square' | 'tight' | 'soft' | 'pill';
  textStyle?: 'normal' | 'bold' | 'uppercase';
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  openInNewTab?: boolean;
  fontSize?: string;
  paddingX?: string;
  paddingY?: string;
  minHeight?: string;
  borderWidth?: string;
  customRadius?: string;
  letterSpacing?: string;
  lineHeight?: string;
};

export type EventPageDividerProps = {
  spacing?: 'compact' | 'normal' | 'loose';
};

export type EventPageLink = {
  label: string;
  url: string;
};

export type EventPageSocialLinksProps = EventPageSectionDesignProps & {
  title?: string;
  links: EventPageLink[];
};

export type EventPageCustomEmbedProps = {
  html: string;
  allowUnsafeEmbed: boolean;
};

/** Editable event intro chrome. Renders as the page h1 for outline/heading audit. */
export type EventPageEventHeaderProps = {
  brandLabel?: string;
  title: string;
  description?: string;
  startsAtLabel?: string;
  timezone?: string;
  venueName?: string;
  showDate?: boolean;
  showTimezone?: boolean;
  showVenue?: boolean;
  showBrandBadge?: boolean;
  imageUrl?: string;
  imageAlt?: string;
  imageFit?: 'cover' | 'contain';
  imagePosition?: 'center' | 'top' | 'bottom' | 'left' | 'right';
  imagePositionX?: string;
  imagePositionY?: string;
  imagePlacement?: {
    x?: string;
    y?: string;
    scale?: string;
  };
  overlayContentPosition?: 'top' | 'center' | 'bottom';
  overlayContentHorizontalPosition?: EventPageAlignment;
  overlayMinHeight?: string;
  overlayPadding?: string;
  contentPadding?: string;
  contentGap?: string;
  imageOpacity?: string;
  backgroundOverlayColor?: string;
  backgroundOverlayOpacity?: string;
  logos?: EventPageLogoItem[];
  logoPosition?:
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';
  logoSize?: 'sm' | 'md' | 'lg';
  logoMaxHeight?: string;
  logoMaxWidth?: string;
  titleFontSize?: string;
  titleColor?: string;
  descriptionFontSize?: string;
  descriptionColor?: string;
  metaFontSize?: string;
  metaColor?: string;
  metaIconColor?: string;
  metaGap?: string;
  badgeFontSize?: string;
  badgeTextColor?: string;
  badgeBackgroundColor?: string;
  badgeBorderColor?: string;
};

/** Live ticket list chrome. Section title is an h2 for outline/heading audit. */
export type EventPageTicketsProps = EventPageSectionDesignProps & {
  title?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  previewState?: 'live' | 'empty' | 'populated';
  sectionGap?: string;
  itemGap?: string;
  itemPadding?: string;
  itemRadius?: string;
  itemBackgroundColor?: string;
  itemBorderColor?: string;
  itemTextColor?: string;
  itemDescriptionColor?: string;
  priceTextColor?: string;
  emptyBackgroundColor?: string;
  emptyBorderColor?: string;
};

/** Live resale list chrome. Section title is an h2 for outline/heading audit. */
export type EventPageResaleTicketsProps = {
  title?: string;
  badgeLabel?: string;
  previewState?: 'live' | 'empty' | 'populated';
};

/** Checkout CTA chrome. */
export type EventPageCheckoutCtaProps = {
  label?: string;
  supportingText?: string;
};

/** Brand/legal footer chrome. */
export type EventPageBrandFooterProps = {
  label?: string;
};

export type EventPagePuckComponentData =
  | EventPagePuckContentItem<'EventHeader', EventPageEventHeaderProps>
  | EventPagePuckContentItem<'EventDescription', EventPageEventDescriptionProps>
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
  | EventPagePuckContentItem<'CustomEmbed', EventPageCustomEmbedProps>
  | EventPagePuckContentItem<'Tickets', EventPageTicketsProps>
  | EventPagePuckContentItem<'ResaleTickets', EventPageResaleTicketsProps>
  | EventPagePuckContentItem<'CheckoutCta', EventPageCheckoutCtaProps>
  | EventPagePuckContentItem<'BrandFooter', EventPageBrandFooterProps>;

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

/**
 * Default page is the full public chrome composition (single Puck document).
 * Heading outline: EventHeader h1 → Tickets h2 → ResaleTickets h2.
 */
export function createDefaultEventPageData(
  input: CreateDefaultEventPageDocumentInput,
): EventPagePuckData {
  const title = nonEmpty(input.eventTitle, 'Untitled event');
  const description = cleanOptionalString(input.eventDescription);
  const startsAt = cleanOptionalString(input.startsAt);
  const timezone = cleanOptionalString(input.timezone);
  const venueName = cleanOptionalString(input.venue?.name);
  const startsLabel = formatEventDateLabel(startsAt, timezone) ?? 'Date to be announced';

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
    content: [
      {
        type: 'EventHeader',
        props: {
          id: blockId('event-header', input.eventId),
          brandLabel: cleanOptionalString(input.brandName) ?? 'Event',
          title,
          description,
          startsAtLabel: startsLabel,
          timezone:
            formatTimezoneLabel(timezone, startsAt) ?? timezone ?? 'Timezone to be announced',
          venueName: venueName ?? 'Venue to be announced',
          showDate: true,
          showTimezone: true,
          showVenue: true,
          showBrandBadge: true,
          imageUrl: cleanOptionalString(input.coverImageUrl),
          imageAlt: cleanOptionalString(input.coverImageAlt) ?? title,
          imageFit: 'cover',
          imagePosition: 'center',
          imagePlacement: { x: '50%', y: '50%', scale: '1' },
          overlayContentPosition: 'center',
          overlayContentHorizontalPosition: 'left',
          overlayMinHeight: '',
          overlayPadding: '',
          contentPadding: '',
          contentGap: '',
          imageOpacity: '1',
          backgroundOverlayColor: '#000000',
          backgroundOverlayOpacity: '0.35',
          logos: [],
          logoPosition: 'top-left',
          logoSize: 'md',
          logoMaxHeight: '48px',
          logoMaxWidth: '160px',
        },
      },
      {
        type: 'EventDescription',
        props: {
          id: blockId('event-description', input.eventId),
          eyebrow: '',
          title: 'About this event',
          body: description ?? '',
          imageUrl: '',
          imageAlt: '',
          alignment: 'left',
          titleAlignment: 'left',
          bodyAlignment: 'left',
          imageAlignment: 'center',
          spacing: 'normal',
          backgroundColor: '',
          imageLayout: 'inline',
          imageFit: 'cover',
          imagePosition: 'center',
          imagePositionX: '',
          imagePositionY: '',
          imagePlacement: { x: '50%', y: '50%', scale: '1' },
          imageRadius: 'soft',
          overlayContentPosition: 'center',
          overlayContentHorizontalPosition: 'left',
          overlayMinHeight: '',
          overlayPadding: '',
          imageOpacity: '1',
          backgroundOverlayColor: '#000000',
          backgroundOverlayOpacity: '0.35',
          imageOverlay: [],
          logos: [],
          logoPosition: 'top-left',
          logoSize: 'md',
          logoMaxHeight: '',
          logoMaxWidth: '',
          eyebrowFontSize: '',
          titleFontSize: '',
          bodyFontSize: '',
          eyebrowColor: '',
          titleColor: '',
          bodyColor: '',
          contentBackgroundColor: '',
          contentPadding: '',
          contentRadius: '',
          contentGap: '',
        },
      },
      {
        type: 'Divider',
        props: {
          id: blockId('divider', input.eventId),
          spacing: 'normal',
        },
      },
      {
        type: 'Tickets',
        props: {
          id: blockId('tickets', input.eventId),
          title: 'Tickets',
          emptyTitle: 'No tickets available',
          emptyDescription: 'Ticket sales have not opened for this event yet. Check back soon.',
        },
      },
      {
        type: 'ResaleTickets',
        props: {
          id: blockId('resale-tickets', input.eventId),
          title: 'Resale tickets',
          badgeLabel: 'Verified listings',
        },
      },
      {
        type: 'CheckoutCta',
        props: {
          id: blockId('checkout-cta', input.eventId),
          label: 'Get tickets',
          supportingText: 'Secure checkout powered by Tixkit',
        },
      },
      {
        type: 'BrandFooter',
        props: {
          id: blockId('brand-footer', input.eventId),
        },
      },
    ],
  };
}

/**
 * Ensure the standard chrome blocks are present without wiping custom content.
 *
 * Stored content blocks (FAQ, RichText, etc.) are preserved in their
 * original order. Missing chrome blocks (EventHeader, EventDescription,
 * Tickets, ResaleTickets, CheckoutCta, BrandFooter) are inserted at appropriate
 * positions so every page has the required header, body, ticket list, CTA, and
 * footer.
 */
export function ensureEventPageChromeBlocks(
  data: EventPagePuckData,
  input: CreateDefaultEventPageDocumentInput,
): EventPagePuckData {
  const defaults = createDefaultEventPageData(input);
  const storedRoot = isRecord(data.root?.props) ? data.root.props : {};
  const storedContent = Array.isArray(data.content)
    ? data.content.filter(
        (b): b is EventPagePuckComponentData =>
          isRecord(b) && typeof b.type === 'string' && isRecord(b.props),
      )
    : [];
  const storedTypes = new Set(storedContent.map((b) => b.type));
  const content = [...storedContent];

  const defaultBlock = (type: string) => defaults.content.find((b) => b.type === type);

  // Ensure EventHeader at the start.
  if (!storedTypes.has('EventHeader')) {
    const block = defaultBlock('EventHeader');
    if (block) content.unshift(block);
  }

  // Ensure EventDescription after EventHeader.
  if (!storedTypes.has('EventDescription')) {
    const block = defaultBlock('EventDescription');
    if (block) {
      const headerIdx = content.findIndex((b) => b.type === 'EventHeader');
      content.splice(headerIdx + 1, 0, block);
    }
  }

  // Ensure Tickets after EventDescription.
  if (!storedTypes.has('Tickets')) {
    const block = defaultBlock('Tickets');
    if (block) {
      const descriptionIdx = content.findIndex((b) => b.type === 'EventDescription');
      const headerIdx = content.findIndex((b) => b.type === 'EventHeader');
      content.splice((descriptionIdx >= 0 ? descriptionIdx : headerIdx) + 1, 0, block);
    }
  }

  // Ensure ResaleTickets after Tickets.
  if (!storedTypes.has('ResaleTickets')) {
    const block = defaultBlock('ResaleTickets');
    if (block) {
      const ticketsIdx = content.findIndex((b) => b.type === 'Tickets');
      if (ticketsIdx >= 0) content.splice(ticketsIdx + 1, 0, block);
      else content.push(block);
    }
  }

  // Ensure BrandFooter at the end.
  if (!storedTypes.has('BrandFooter')) {
    const block = defaultBlock('BrandFooter');
    if (block) content.push(block);
  }

  // Ensure CheckoutCta before BrandFooter.
  if (!storedTypes.has('CheckoutCta')) {
    const block = defaultBlock('CheckoutCta');
    if (block) {
      const footerIdx = content.findIndex((b) => b.type === 'BrandFooter');
      if (footerIdx >= 0) content.splice(footerIdx, 0, block);
      else content.push(block);
    }
  }

  return {
    root: {
      props: {
        ...defaults.root.props,
        ...pickRootThemeProps(storedRoot),
        title: defaults.root.props.title,
        description: defaults.root.props.description ?? cleanOptionalString(storedRoot.description),
      },
    },
    content,
  };
}

function pickRootThemeProps(props: Record<string, unknown>): Partial<EventPageRootProps> {
  const themeKeys = [
    'backgroundColor',
    'foregroundColor',
    'accentColor',
    'accentForegroundColor',
    'fontFamily',
    'headingFontFamily',
    'radius',
  ] as const;
  const next: Partial<EventPageRootProps> = {};
  for (const key of themeKeys) {
    const value = cleanOptionalString(props[key]);
    if (value) next[key] = value;
  }
  return next;
}

export function createDefaultEventPageSettings(
  input: CreateDefaultEventPageDocumentInput,
): EventPageSettings {
  const title = nonEmpty(input.eventTitle, 'Untitled event');
  const summary = nonEmpty(input.eventDescription, `Details for ${title}.`);
  return {
    locale: cleanOptionalString(input.locale) ?? 'en',
    publicPath: resolveRelativePublicPath(input.publicUrl, input.eventId),
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

function materializeEventPageComponent<Block extends EventPagePuckComponentData>(
  block: Block,
  replacements: Record<string, string>,
): Block {
  return {
    ...block,
    props: materializeRecord(block.props, replacements, block.type) as Block['props'],
  };
}

/**
 * Resolve leftover merge tags / unsafe URLs from legacy drafts using current event data.
 * Event pages no longer resolve merge tags at render time.
 */
export function materializeEventPageDocument(
  document: EventPageDocument,
  input: CreateDefaultEventPageDocumentInput,
): EventPageDocument {
  const replacements = buildEventPageMergeReplacements(input);
  const ensured = ensureEventPageChromeBlocks(document.editor.data, input);
  const defaultHeader = createDefaultEventPageData(input).content.find(
    (block) => block.type === 'EventHeader',
  ) as EventPagePuckContentItem<'EventHeader', EventPageEventHeaderProps> | undefined;
  const content = ensured.content.map((block) => {
    const materialized = materializeEventPageComponent(block, replacements);
    if (materialized.type !== 'EventHeader' || !defaultHeader) return materialized;
    return {
      ...materialized,
      props: {
        ...materialized.props,
        title: defaultHeader.props.title,
        description: defaultHeader.props.description,
        startsAtLabel: defaultHeader.props.startsAtLabel,
        timezone: defaultHeader.props.timezone,
        venueName: defaultHeader.props.venueName,
      },
    };
  });
  const zones = ensured.zones
    ? Object.fromEntries(
        Object.entries(ensured.zones).map(([zoneName, zoneContent]) => [
          zoneName,
          zoneContent.map((block) => materializeEventPageComponent(block, replacements)),
        ]),
      )
    : undefined;

  const publicPath =
    resolveRelativePublicPath(document.settings.publicPath, input.eventId) ??
    resolveRelativePublicPath(input.publicUrl, input.eventId);

  return {
    ...document,
    editor: {
      ...document.editor,
      data: {
        root: {
          props: materializeRecord(ensured.root.props, replacements) as EventPageRootProps,
        },
        content,
        ...(zones ? { zones } : {}),
      },
    },
    settings: {
      ...document.settings,
      publicPath,
      discovery: {
        ...document.settings.discovery,
        summary:
          materializeString(document.settings.discovery.summary, replacements) ??
          document.settings.discovery.summary,
        seoTitle: materializeString(document.settings.discovery.seoTitle, replacements),
        seoDescription: materializeString(document.settings.discovery.seoDescription, replacements),
        coverImageUrl: sanitizeOptionalEventPageUrl(document.settings.discovery.coverImageUrl),
        socialImageUrl: sanitizeOptionalEventPageUrl(document.settings.discovery.socialImageUrl),
      },
    },
  };
}

export function resolveRelativePublicPath(value: unknown, eventId?: string): string | undefined {
  const cleaned = cleanOptionalString(value);
  if (
    cleaned &&
    cleaned.startsWith('/') &&
    !cleaned.startsWith('//') &&
    isSafeEventPageUrl(cleaned)
  ) {
    return cleaned;
  }
  if (cleaned && isSafeEventPageUrl(cleaned, false)) {
    try {
      const parsed = new URL(cleaned);
      if (parsed.pathname.startsWith('/')) return parsed.pathname;
    } catch {
      // fall through
    }
  }
  const id = cleanOptionalString(eventId);
  return id ? `/e/${id}` : undefined;
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
    issues.push(
      issue(
        'missing_locale',
        'Event page settings.locale is required.',
        'error',
        'settings.locale',
      ),
    );
  }
  if (!isRecord(settings.discovery)) {
    issues.push(
      issue(
        'missing_discovery',
        'Event page discovery metadata is required.',
        'error',
        'settings.discovery',
      ),
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
  validateOptionalUrl(
    issues,
    settings.discovery.socialImageUrl,
    'settings.discovery.socialImageUrl',
  );
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
        issue(
          'invalid_zones',
          'Event page editor.data.zones must be an object.',
          'error',
          'editor.data.zones',
        ),
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
  // Same-page anchors are used by event page CTAs to jump to ticket chrome.
  if (allowRelative && /^#[A-Za-z][\w:-]*$/.test(url)) return true;
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
  return (
    /<script\b/i.test(html) ||
    /\son[a-z]+\s*=/i.test(html) ||
    /\s(?:href|src)\s*=\s*(?:"|'|)?\s*(?:javascript|data|file):/i.test(html)
  );
}

export function migrateLegacyEventPageDocumentToPuck(
  legacy: EventPageLegacyDocument,
  fallback: CreateDefaultEventPageDocumentInput,
): EventPageDocument {
  const settings = createDefaultEventPageSettings(fallback);
  const migrated: EventPageDocument = {
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
      publicPath:
        resolveRelativePublicPath(legacy.settings?.publicPath, fallback.eventId) ??
        settings.publicPath,
      discovery: {
        ...settings.discovery,
        ...legacy.settings?.discovery,
        tags: legacy.settings?.discovery?.tags ?? settings.discovery.tags,
      },
    },
  };
  return materializeEventPageDocument(migrated, fallback);
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
  if (normalized) {
    // Only rewrite known leftovers when callers supply real event context.
    if (fallback === DEFAULT_EVENT_PAGE_DOCUMENT_INPUT) return normalized;
    return materializeEventPageDocument(normalized, fallback);
  }
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
          type: 'EventDescription',
          props: {
            id,
            eyebrow: cleanOptionalString(block.eyebrow),
            title: nonEmpty(block.headline, 'About this event'),
            body: cleanOptionalString(block.body),
            imageUrl: cleanOptionalString(block.imageUrl),
            imageAlt: cleanOptionalString(block.imageAlt),
            alignment: readAlignment(block.alignment),
            titleAlignment: readAlignment(block.headlineAlignment),
            bodyAlignment: readAlignment(block.bodyAlignment),
            imageAlignment: readAlignment(block.imageAlignment),
            spacing: readSpacing(block.spacing),
            backgroundColor: cleanOptionalString(block.backgroundColor),
            imageRadius: readRadiusPreset(block.imageRadius),
            imageLayout: readHeroImageLayout(block.imageLayout),
            imageFit: readHeroImageFit(block.imageFit),
            imagePosition: readHeroImagePosition(block.imagePosition),
            imagePositionX: cleanOptionalString(block.imagePositionX),
            imagePositionY: cleanOptionalString(block.imagePositionY),
            imagePlacement: readHeroImagePlacement(block.imagePlacement),
            overlayContentPosition: readOverlayContentPosition(block.overlayContentPosition),
            overlayContentHorizontalPosition: readAlignment(block.overlayContentHorizontalPosition),
            overlayMinHeight: cleanOptionalString(block.overlayMinHeight),
            overlayPadding: cleanOptionalString(block.overlayPadding),
            imageOpacity: cleanOptionalString(block.imageOpacity),
            backgroundOverlayColor: cleanOptionalString(block.backgroundOverlayColor),
            backgroundOverlayOpacity: cleanOptionalString(block.backgroundOverlayOpacity),
            logos: Array.isArray(block.logos)
              ? block.logos
                  .filter((item): item is Record<string, unknown> => isRecord(item))
                  .map((item) => ({
                    name: nonEmpty(item.name, 'Logo'),
                    url: cleanOptionalString(item.url),
                    imageUrl: cleanOptionalString(item.imageUrl),
                    imageAlt: cleanOptionalString(item.imageAlt),
                  }))
              : undefined,
            logoPosition: readHeroLogoPosition(block.logoPosition),
            logoSize: readHeroLogoSize(block.logoSize),
            logoMaxHeight: cleanOptionalString(block.logoMaxHeight),
            logoMaxWidth: cleanOptionalString(block.logoMaxWidth),
            eyebrowFontSize: cleanOptionalString(block.eyebrowFontSize),
            titleFontSize: cleanOptionalString(block.headlineFontSize),
            bodyFontSize: cleanOptionalString(block.bodyFontSize),
            eyebrowColor: cleanOptionalString(block.eyebrowColor),
            titleColor: cleanOptionalString(block.headlineColor),
            bodyColor: cleanOptionalString(block.bodyColor),
            contentBackgroundColor: cleanOptionalString(block.contentBackgroundColor),
            contentPadding: cleanOptionalString(block.contentPadding),
            contentRadius: cleanOptionalString(block.contentRadius),
            contentGap: cleanOptionalString(block.contentGap),
          },
        });
        break;
      case 'rich_text':
        content.push({
          type: 'RichText',
          props: {
            id,
            body: legacyRichTextToHtml(block.content),
            alignment: readAlignment(block.alignment),
            textSize: readTextSize(block.textSize),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            fontSize: cleanOptionalString(block.fontSize),
            lineHeight: cleanOptionalString(block.lineHeight),
            paragraphGap: cleanOptionalString(block.paragraphGap),
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
            alignment: readAlignment(block.alignment),
            radius: readRadiusPreset(block.radius),
            width: readWidth(block.width),
            spacing: readSpacing(block.spacing),
            maxWidth: cleanOptionalString(block.maxWidth),
            customRadius: cleanOptionalString(block.customRadius),
            captionFontSize: cleanOptionalString(block.captionFontSize),
            overlayEnabled: block.overlayEnabled === true,
            overlayContentPosition: readOverlayContentPosition(block.overlayContentPosition),
            overlayMinHeight: cleanOptionalString(block.overlayMinHeight),
            overlayPadding: cleanOptionalString(block.overlayPadding),
            imageOpacity: cleanOptionalString(block.imageOpacity),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
            labelFontSize: cleanOptionalString(block.labelFontSize),
            valueFontSize: cleanOptionalString(block.valueFontSize),
            labelColor: cleanOptionalString(block.labelColor),
            valueColor: cleanOptionalString(block.valueColor),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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
            size: readButtonSize(block.size),
            width: readButtonWidth(block.width),
            radius: readButtonRadius(block.radius),
            textStyle: readButtonTextStyle(block.textStyle),
            backgroundColor: cleanOptionalString(block.backgroundColor),
            textColor: cleanOptionalString(block.textColor),
            borderColor: cleanOptionalString(block.borderColor),
            openInNewTab: block.openInNewTab === true,
            fontSize: cleanOptionalString(block.fontSize),
            paddingX: cleanOptionalString(block.paddingX),
            paddingY: cleanOptionalString(block.paddingY),
            minHeight: cleanOptionalString(block.minHeight),
            borderWidth: cleanOptionalString(block.borderWidth),
            customRadius: cleanOptionalString(block.customRadius),
            letterSpacing: cleanOptionalString(block.letterSpacing),
            lineHeight: cleanOptionalString(block.lineHeight),
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
            alignment: readAlignment(block.alignment),
            spacing: readSpacing(block.spacing),
            sectionStyle: readSectionStyle(block.sectionStyle),
            titleFontSize: cleanOptionalString(block.titleFontSize),
            titleColor: cleanOptionalString(block.titleColor),
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

  const descriptionBlock = content.find((block) => block.type === 'EventDescription') as
    | EventPagePuckContentItem<'EventDescription', EventPageEventDescriptionProps>
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
        title:
          rootTitle === DEFAULT_EVENT_PAGE_DOCUMENT_INPUT.eventTitle
            ? descriptionBlock?.props.title
            : rootTitle,
        description: rootDescription ?? descriptionBlock?.props.body,
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
  const header = document.editor.data.content.find((block) => block.type === 'EventHeader');
  const headerProps = header?.props as Partial<EventPageEventHeaderProps> | undefined;
  const description = document.editor.data.content.find(
    (block) => block.type === 'EventDescription',
  );
  const descriptionProps = description?.props as
    | Partial<EventPageEventDescriptionProps>
    | undefined;
  const title =
    cleanOptionalString(root.title) ??
    cleanOptionalString(headerProps?.title) ??
    cleanOptionalString(descriptionProps?.title) ??
    cleanOptionalString(context.event?.title) ??
    'Untitled event';
  const summary =
    cleanOptionalString(document.settings.discovery.summary) ??
    cleanOptionalString(root.description) ??
    cleanOptionalString(descriptionProps?.body) ??
    cleanOptionalString(headerProps?.description) ??
    cleanOptionalString(context.event?.description) ??
    `Details for ${title}.`;

  return {
    title,
    summary,
    category: cleanOptionalString(document.settings.discovery.category),
    tags: Array.isArray(document.settings.discovery.tags)
      ? document.settings.discovery.tags.filter(
          (tag): tag is string => typeof tag === 'string' && tag.trim().length > 0,
        )
      : [],
    imageUrl:
      cleanOptionalString(document.settings.discovery.coverImageUrl) ??
      cleanOptionalString(headerProps?.imageUrl) ??
      cleanOptionalString(descriptionProps?.imageUrl),
    startsAt: cleanOptionalString(context.event?.startsAt),
    venueName: cleanOptionalString(context.event?.venueName),
    publicPath:
      cleanOptionalString(document.settings.publicPath) ??
      cleanOptionalString(context.event?.publicUrl),
  };
}

export function normalizePublicEventPagePayloadV2(
  value: unknown,
): PublicEventPagePayloadV2 | undefined {
  if (!isRecord(value)) return undefined;
  if (!isRecord(value.document) || !isRecord(value.version) || !isRecord(value.page))
    return undefined;

  if (
    'html' in value.page ||
    'text' in value.page ||
    'headless' in value.page ||
    'renderModel' in value.page
  ) {
    return undefined;
  }
  if ('contentJson' in value.page || 'document' in value.page || 'data' in value.page)
    return undefined;
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
      issues.push(
        issue('invalid_block', 'Event page content blocks must be objects.', 'error', path),
      );
      return;
    }

    const type = cleanOptionalString(item.type);
    if (!type) {
      issues.push(
        issue(
          'missing_block_type',
          'Event page content block type is required.',
          'error',
          `${path}.type`,
        ),
      );
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
      issues.push(
        issue(
          'unknown_block_type',
          `Unknown event page Puck block "${type}".`,
          'error',
          `${path}.type`,
        ),
      );
      return;
    }

    if (!isRecord(item.props)) {
      issues.push(
        issue(
          'missing_block_props',
          'Event page content block props are required.',
          'error',
          `${path}.props`,
        ),
      );
      return;
    }
    const id = cleanOptionalString(item.props.id);
    if (!id) {
      issues.push(
        issue(
          'missing_block_id',
          'Event page content block id is required.',
          'error',
          `${path}.props.id`,
        ),
      );
    } else if (ids.has(id)) {
      issues.push(
        issue(
          'duplicate_block_id',
          `Duplicate event page block id "${id}".`,
          'error',
          `${path}.props.id`,
        ),
      );
    } else {
      ids.add(id);
    }

    validateComponentProps(
      issues,
      type as EventPagePuckComponentType,
      item.props,
      `${path}.props`,
      options,
    );
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
    case 'EventDescription':
      validateOptionalUrl(issues, props.imageUrl, `${field}.imageUrl`);
      validateImageAlt(issues, props.imageUrl, props.imageAlt, `${field}.imageAlt`);
      validateOptionalColor(issues, props.backgroundColor, `${field}.backgroundColor`);
      validateOptionalLength(issues, props.imagePositionX, `${field}.imagePositionX`);
      validateOptionalLength(issues, props.imagePositionY, `${field}.imagePositionY`);
      validateHeroImagePlacement(issues, props.imagePlacement, `${field}.imagePlacement`);
      validateOptionalLength(issues, props.overlayMinHeight, `${field}.overlayMinHeight`);
      validateOptionalLength(issues, props.overlayPadding, `${field}.overlayPadding`);
      validateOptionalOpacity(issues, props.imageOpacity, `${field}.imageOpacity`);
      validateOptionalColor(
        issues,
        props.backgroundOverlayColor,
        `${field}.backgroundOverlayColor`,
      );
      validateOptionalOpacity(
        issues,
        props.backgroundOverlayOpacity,
        `${field}.backgroundOverlayOpacity`,
      );
      if (props.logos !== undefined) {
        validateLogoItems(issues, props.logos, `${field}.logos`);
      }
      validateOptionalLength(issues, props.eyebrowFontSize, `${field}.eyebrowFontSize`);
      validateOptionalLength(issues, props.titleFontSize, `${field}.titleFontSize`);
      validateOptionalLength(issues, props.bodyFontSize, `${field}.bodyFontSize`);
      validateOptionalColor(issues, props.eyebrowColor, `${field}.eyebrowColor`);
      validateOptionalColor(issues, props.titleColor, `${field}.titleColor`);
      validateOptionalColor(issues, props.bodyColor, `${field}.bodyColor`);
      validateOptionalColor(
        issues,
        props.contentBackgroundColor,
        `${field}.contentBackgroundColor`,
      );
      validateOptionalLength(issues, props.contentPadding, `${field}.contentPadding`);
      validateOptionalLength(issues, props.contentRadius, `${field}.contentRadius`);
      validateOptionalLength(issues, props.contentGap, `${field}.contentGap`);
      break;
    case 'RichText':
      validateRequiredString(issues, props.body, `${field}.body`, 'Rich text body is required.');
      if (typeof props.body === 'string' && hasUnsafeEventPageHtml(props.body)) {
        issues.push(
          issue('unsafe_html', 'Rich text contains unsafe HTML.', 'error', `${field}.body`),
        );
      }
      validateOptionalLength(issues, props.fontSize, `${field}.fontSize`);
      validateOptionalLength(issues, props.paragraphGap, `${field}.paragraphGap`);
      validateOptionalNumberOrLength(issues, props.lineHeight, `${field}.lineHeight`);
      break;
    case 'Media':
      validateRequiredString(
        issues,
        props.imageUrl,
        `${field}.imageUrl`,
        'Media imageUrl is required.',
      );
      validateRequiredString(
        issues,
        props.imageAlt,
        `${field}.imageAlt`,
        'Media imageAlt is required.',
      );
      validateOptionalUrl(issues, props.imageUrl, `${field}.imageUrl`);
      validateOptionalLength(issues, props.maxWidth, `${field}.maxWidth`);
      validateOptionalLength(issues, props.customRadius, `${field}.customRadius`);
      validateOptionalLength(issues, props.captionFontSize, `${field}.captionFontSize`);
      validateOptionalLength(issues, props.overlayMinHeight, `${field}.overlayMinHeight`);
      validateOptionalLength(issues, props.overlayPadding, `${field}.overlayPadding`);
      validateOptionalOpacity(issues, props.imageOpacity, `${field}.imageOpacity`);
      break;
    case 'EventDetails':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(
        issues,
        props.title,
        `${field}.title`,
        'Event details title is required.',
      );
      validateDetailItems(issues, props.items, `${field}.items`);
      validateOptionalLength(issues, props.labelFontSize, `${field}.labelFontSize`);
      validateOptionalLength(issues, props.valueFontSize, `${field}.valueFontSize`);
      validateOptionalColor(issues, props.labelColor, `${field}.labelColor`);
      validateOptionalColor(issues, props.valueColor, `${field}.valueColor`);
      break;
    case 'Schedule':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(issues, props.title, `${field}.title`, 'Schedule title is required.');
      validateScheduleItems(issues, props.items, `${field}.items`);
      break;
    case 'Venue':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(issues, props.title, `${field}.title`, 'Venue title is required.');
      validateRequiredString(
        issues,
        props.venueName,
        `${field}.venueName`,
        'Venue name is required.',
      );
      validateOptionalUrl(issues, props.mapUrl, `${field}.mapUrl`);
      break;
    case 'FAQ':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(issues, props.title, `${field}.title`, 'FAQ title is required.');
      validateFaqItems(issues, props.items, `${field}.items`);
      break;
    case 'Sponsors':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(issues, props.title, `${field}.title`, 'Sponsors title is required.');
      validateLogoItems(issues, props.items, `${field}.items`);
      break;
    case 'Speakers':
      validateSectionDesignProps(issues, props, field);
      validateRequiredString(issues, props.title, `${field}.title`, 'Speakers title is required.');
      validatePersonItems(issues, props.items, `${field}.items`);
      break;
    case 'Button':
      validateRequiredString(issues, props.label, `${field}.label`, 'Button label is required.');
      validateRequiredString(issues, props.url, `${field}.url`, 'Button URL is required.');
      validateOptionalUrl(issues, props.url, `${field}.url`);
      validateOptionalColor(issues, props.backgroundColor, `${field}.backgroundColor`);
      validateOptionalColor(issues, props.textColor, `${field}.textColor`);
      validateOptionalColor(issues, props.borderColor, `${field}.borderColor`);
      validateOptionalLength(issues, props.fontSize, `${field}.fontSize`);
      validateOptionalLength(issues, props.paddingX, `${field}.paddingX`);
      validateOptionalLength(issues, props.paddingY, `${field}.paddingY`);
      validateOptionalLength(issues, props.minHeight, `${field}.minHeight`);
      validateOptionalLength(issues, props.borderWidth, `${field}.borderWidth`);
      validateOptionalLength(issues, props.customRadius, `${field}.customRadius`);
      validateOptionalLength(issues, props.letterSpacing, `${field}.letterSpacing`);
      validateOptionalNumberOrLength(issues, props.lineHeight, `${field}.lineHeight`);
      break;
    case 'Divider':
      break;
    case 'SocialLinks':
      validateSectionDesignProps(issues, props, field);
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
      if (
        !options.allowUnsafeEmbeds &&
        typeof props.html === 'string' &&
        hasUnsafeEventPageHtml(props.html)
      ) {
        issues.push(
          issue(
            'unsafe_embed_html',
            'Custom embed contains unsafe HTML.',
            'error',
            `${field}.html`,
          ),
        );
      }
      break;
    case 'EventHeader':
      validateRequiredString(
        issues,
        props.title,
        `${field}.title`,
        'Event header title is required.',
      );
      validateOptionalUrl(issues, props.imageUrl, `${field}.imageUrl`);
      validateImageAlt(issues, props.imageUrl, props.imageAlt, `${field}.imageAlt`);
      validateOptionalLength(issues, props.imagePositionX, `${field}.imagePositionX`);
      validateOptionalLength(issues, props.imagePositionY, `${field}.imagePositionY`);
      validateHeroImagePlacement(issues, props.imagePlacement, `${field}.imagePlacement`);
      validateOptionalLength(issues, props.overlayMinHeight, `${field}.overlayMinHeight`);
      validateOptionalLength(issues, props.overlayPadding, `${field}.overlayPadding`);
      validateOptionalOpacity(issues, props.imageOpacity, `${field}.imageOpacity`);
      validateOptionalColor(
        issues,
        props.backgroundOverlayColor,
        `${field}.backgroundOverlayColor`,
      );
      validateOptionalOpacity(
        issues,
        props.backgroundOverlayOpacity,
        `${field}.backgroundOverlayOpacity`,
      );
      if (props.logos !== undefined) {
        validateLogoItems(issues, props.logos, `${field}.logos`);
      }
      validateOptionalLength(issues, props.logoMaxHeight, `${field}.logoMaxHeight`);
      validateOptionalLength(issues, props.logoMaxWidth, `${field}.logoMaxWidth`);
      validateOptionalLength(issues, props.titleFontSize, `${field}.titleFontSize`);
      validateOptionalColor(issues, props.titleColor, `${field}.titleColor`);
      validateOptionalLength(issues, props.descriptionFontSize, `${field}.descriptionFontSize`);
      validateOptionalColor(issues, props.descriptionColor, `${field}.descriptionColor`);
      validateOptionalLength(issues, props.metaFontSize, `${field}.metaFontSize`);
      validateOptionalColor(issues, props.metaColor, `${field}.metaColor`);
      validateOptionalColor(issues, props.metaIconColor, `${field}.metaIconColor`);
      validateOptionalLength(issues, props.metaGap, `${field}.metaGap`);
      validateOptionalLength(issues, props.badgeFontSize, `${field}.badgeFontSize`);
      validateOptionalColor(issues, props.badgeTextColor, `${field}.badgeTextColor`);
      validateOptionalColor(issues, props.badgeBackgroundColor, `${field}.badgeBackgroundColor`);
      validateOptionalColor(issues, props.badgeBorderColor, `${field}.badgeBorderColor`);
      break;
    case 'Tickets':
      validateSectionDesignProps(issues, props, field);
      validateOptionalLength(issues, props.sectionGap, `${field}.sectionGap`);
      validateOptionalLength(issues, props.itemGap, `${field}.itemGap`);
      validateOptionalLength(issues, props.itemPadding, `${field}.itemPadding`);
      validateOptionalLength(issues, props.itemRadius, `${field}.itemRadius`);
      validateOptionalColor(issues, props.itemBackgroundColor, `${field}.itemBackgroundColor`);
      validateOptionalColor(issues, props.itemBorderColor, `${field}.itemBorderColor`);
      validateOptionalColor(issues, props.itemTextColor, `${field}.itemTextColor`);
      validateOptionalColor(issues, props.itemDescriptionColor, `${field}.itemDescriptionColor`);
      validateOptionalColor(issues, props.priceTextColor, `${field}.priceTextColor`);
      validateOptionalColor(issues, props.emptyBackgroundColor, `${field}.emptyBackgroundColor`);
      validateOptionalColor(issues, props.emptyBorderColor, `${field}.emptyBorderColor`);
      break;
    case 'ResaleTickets':
    case 'CheckoutCta':
    case 'BrandFooter':
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
    issues.push(
      issue('invalid_radius', 'Root radius must be a CSS string.', 'error', `${field}.radius`),
    );
  }
}

function validateSectionDesignProps(
  issues: ContentValidationIssue[],
  props: Record<string, unknown>,
  field: string,
): void {
  validateOptionalLength(issues, props.titleFontSize, `${field}.titleFontSize`);
  validateOptionalColor(issues, props.titleColor, `${field}.titleColor`);
}

function validateDetailItems(
  issues: ContentValidationIssue[],
  items: unknown,
  field: string,
): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(
      issue(
        'missing_detail_items',
        'Event details must include at least one item.',
        'error',
        field,
      ),
    );
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(
        issue(
          'invalid_detail_item',
          'Event detail items must be objects.',
          'error',
          `${field}.${index}`,
        ),
      );
      return;
    }
    validateRequiredString(
      issues,
      item.label,
      `${field}.${index}.label`,
      'Event detail label is required.',
    );
    validateRequiredString(
      issues,
      item.value,
      `${field}.${index}.value`,
      'Event detail value is required.',
    );
  });
}

function validateScheduleItems(
  issues: ContentValidationIssue[],
  items: unknown,
  field: string,
): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(
      issue('missing_schedule_items', 'Schedule must include at least one item.', 'error', field),
    );
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(
        issue(
          'invalid_schedule_item',
          'Schedule items must be objects.',
          'error',
          `${field}.${index}`,
        ),
      );
      return;
    }
    validateRequiredString(
      issues,
      item.title,
      `${field}.${index}.title`,
      'Schedule item title is required.',
    );
    validateRequiredString(
      issues,
      item.startsAt,
      `${field}.${index}.startsAt`,
      'Schedule item startsAt is required.',
    );
  });
}

function validateFaqItems(issues: ContentValidationIssue[], items: unknown, field: string): void {
  if (!Array.isArray(items) || items.length === 0) {
    issues.push(issue('missing_faq_items', 'FAQ must include at least one item.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(
        issue('invalid_faq_item', 'FAQ items must be objects.', 'error', `${field}.${index}`),
      );
      return;
    }
    validateRequiredString(
      issues,
      item.question,
      `${field}.${index}.question`,
      'FAQ question is required.',
    );
    validateRequiredString(
      issues,
      item.answer,
      `${field}.${index}.answer`,
      'FAQ answer is required.',
    );
  });
}

function validateLogoItems(issues: ContentValidationIssue[], items: unknown, field: string): void {
  if (!Array.isArray(items)) {
    issues.push(issue('invalid_logo_items', 'Sponsor items must be an array.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(
        issue('invalid_logo_item', 'Sponsor items must be objects.', 'error', `${field}.${index}`),
      );
      return;
    }
    validateRequiredString(
      issues,
      item.name,
      `${field}.${index}.name`,
      'Sponsor name is required.',
    );
    validateOptionalUrl(issues, item.url, `${field}.${index}.url`);
    validateOptionalUrl(issues, item.imageUrl, `${field}.${index}.imageUrl`);
    validateImageAlt(issues, item.imageUrl, item.imageAlt, `${field}.${index}.imageAlt`);
  });
}

function validatePersonItems(
  issues: ContentValidationIssue[],
  items: unknown,
  field: string,
): void {
  if (!Array.isArray(items)) {
    issues.push(issue('invalid_person_items', 'Speaker items must be an array.', 'error', field));
    return;
  }
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(
        issue(
          'invalid_person_item',
          'Speaker items must be objects.',
          'error',
          `${field}.${index}`,
        ),
      );
      return;
    }
    validateRequiredString(
      issues,
      item.name,
      `${field}.${index}.name`,
      'Speaker name is required.',
    );
    validateOptionalUrl(issues, item.url, `${field}.${index}.url`);
    validateOptionalUrl(issues, item.imageUrl, `${field}.${index}.imageUrl`);
    validateImageAlt(issues, item.imageUrl, item.imageAlt, `${field}.${index}.imageAlt`);
  });
}

function validateLinks(issues: ContentValidationIssue[], links: unknown, field: string): void {
  if (!Array.isArray(links) || links.length === 0) {
    issues.push(
      issue('missing_links', 'Social links must include at least one link.', 'error', field),
    );
    return;
  }
  links.forEach((link, index) => {
    if (!isRecord(link)) {
      issues.push(
        issue('invalid_link', 'Social link items must be objects.', 'error', `${field}.${index}`),
      );
      return;
    }
    validateRequiredString(
      issues,
      link.label,
      `${field}.${index}.label`,
      'Social link label is required.',
    );
    validateRequiredString(
      issues,
      link.url,
      `${field}.${index}.url`,
      'Social link URL is required.',
    );
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
    issues.push(
      issue('unsafe_url', 'URL must be http(s) and cannot target private hosts.', 'error', field),
    );
  }
}

function validateOptionalColor(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
    issues.push(
      issue('invalid_color', 'Color values must be six-digit hex colors.', 'error', field),
    );
  }
}

function validateOptionalLength(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  if (
    typeof value !== 'string' ||
    !/^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw|ch)$/.test(value.trim())
  ) {
    issues.push(
      issue(
        'invalid_length',
        'Length values must be numeric with a supported unit.',
        'error',
        field,
      ),
    );
  }
}

function validateOptionalNumberOrLength(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  if (
    typeof value !== 'string' ||
    !/^(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw|ch)?$/.test(value.trim())
  ) {
    issues.push(
      issue(
        'invalid_number_or_length',
        'Value must be a number or a numeric value with a supported unit.',
        'error',
        field,
      ),
    );
  }
}

function validateOptionalOpacity(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null || value === '') return;
  const parsed = typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    issues.push(
      issue('invalid_opacity', 'Opacity values must be a number from 0 to 1.', 'error', field),
    );
  }
}

function validateHeroImagePlacement(
  issues: ContentValidationIssue[],
  value: unknown,
  field: string,
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issues.push(
      issue('invalid_image_placement', 'Image placement must be an object.', 'error', field),
    );
    return;
  }
  validateOptionalLength(issues, value.x, `${field}.x`);
  validateOptionalLength(issues, value.y, `${field}.y`);
  if (value.scale !== undefined && value.scale !== null && value.scale !== '') {
    const parsed = typeof value.scale === 'string' ? Number(value.scale.trim()) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) {
      issues.push(
        issue(
          'invalid_image_scale',
          'Image zoom must be a number from 1 to 3.',
          'error',
          `${field}.scale`,
        ),
      );
    }
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
  if (!eventId || value.channel !== 'event_page' || !key || !name || !locale || !updatedAt)
    return undefined;
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
  if (typeof value.versionNumber !== 'number' || !Number.isFinite(value.versionNumber))
    return undefined;
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
  const severity =
    value.severity === 'warning' || value.severity === 'error' ? value.severity : undefined;
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

function formatEventDateLabel(value: string | undefined, timeZone?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return value;
  }
}

/** Human label for an IANA zone, e.g. America/New_York → "Eastern Time". */
export function formatTimezoneLabel(
  timeZone: string | undefined,
  at: string | Date = new Date(),
): string | undefined {
  const zone = cleanOptionalString(timeZone);
  if (!zone) return undefined;
  if (!zone.includes('/')) return zone;

  const date = typeof at === 'string' ? new Date(at) : at;
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

  for (const timeZoneName of ['longGeneric', 'long', 'shortGeneric', 'short'] as const) {
    try {
      const parts = new Intl.DateTimeFormat(undefined, {
        timeZone: zone,
        timeZoneName,
      }).formatToParts(safeDate);
      const label = parts.find((part) => part.type === 'timeZoneName')?.value?.trim();
      if (label && label !== zone) return label;
    } catch {
      // try next style / fallback below
    }
  }

  const city = zone.split('/').pop()?.replace(/_/g, ' ');
  return city || zone;
}

function buildEventPageMergeReplacements(
  input: CreateDefaultEventPageDocumentInput,
): Record<string, string> {
  const title = nonEmpty(input.eventTitle, 'Untitled event');
  const description = cleanOptionalString(input.eventDescription) ?? '';
  const timezone = cleanOptionalString(input.timezone) ?? '';
  const venueName = cleanOptionalString(input.venue?.name) ?? '';
  const brandName = cleanOptionalString(input.brandName) ?? '';
  const startsAt = cleanOptionalString(input.startsAt) ?? '';
  const endsAt = cleanOptionalString(input.endsAt) ?? '';
  const startsLabel = formatEventDateLabel(startsAt, timezone) ?? startsAt;
  const endsLabel = formatEventDateLabel(endsAt, timezone) ?? endsAt;
  const publicPath = resolveRelativePublicPath(input.publicUrl, input.eventId) ?? '';
  return {
    'event.title': title,
    'event.description': description,
    'event.startsAt': startsLabel || 'Date to be announced',
    'event.endsAt': endsLabel,
    'event.timezone': timezone || 'Timezone to be announced',
    'event.venueName': venueName || 'Venue to be announced',
    'event.publicUrl': publicPath,
    'event.checkoutUrl': '#tickets',
    'brand.name': brandName,
    'BRAND.NAME': brandName,
  };
}

function materializeString(
  value: unknown,
  replacements: Record<string, string>,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const exactMerge = trimmed.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);
  if (exactMerge) {
    const key = exactMerge[1] ?? '';
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      return replacements[key] ?? '';
    }
  }

  return trimmed.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(replacements, key)) {
      return replacements[key] ?? '';
    }
    return match;
  });
}

function sanitizeOptionalEventPageUrl(value: unknown): string | undefined {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) return undefined;
  if (isSafeEventPageUrl(cleaned)) return cleaned;
  return undefined;
}

function materializeRecord(
  value: Record<string, unknown>,
  replacements: Record<string, string>,
  componentType?: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      const materialized = materializeString(entry, replacements);
      if (
        (key === 'ctaUrl' || key === 'url' || key === 'mapUrl' || key.endsWith('Url')) &&
        materialized &&
        !isSafeEventPageUrl(materialized)
      ) {
        next[key] = key === 'ctaUrl' ? '#tickets' : undefined;
        continue;
      }
      next[key] = materialized ?? entry;
      continue;
    }
    if (Array.isArray(entry)) {
      next[key] = entry.map((item) =>
        isRecord(item) ? materializeRecord(item, replacements, componentType) : item,
      );
      continue;
    }
    if (isRecord(entry)) {
      next[key] = materializeRecord(entry, replacements, componentType);
      continue;
    }
    next[key] = entry;
  }
  return next;
}

function readAlignment(value: unknown): EventPageAlignment | undefined {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

function readSpacing(value: unknown): EventPageSpacing | undefined {
  return value === 'compact' || value === 'normal' || value === 'loose' ? value : undefined;
}

function readTextSize(value: unknown): EventPageTextSize | undefined {
  return value === 'small' || value === 'normal' || value === 'large' ? value : undefined;
}

function readHeroImageLayout(value: unknown): EventPageEventDescriptionProps['imageLayout'] {
  return value === 'background' || value === 'inline' ? value : undefined;
}

function readHeroLogoPosition(value: unknown): EventPageEventDescriptionProps['logoPosition'] {
  return value === 'top-left' ||
    value === 'top-center' ||
    value === 'top-right' ||
    value === 'bottom-left' ||
    value === 'bottom-center' ||
    value === 'bottom-right'
    ? value
    : undefined;
}
function readHeroLogoSize(value: unknown): EventPageEventDescriptionProps['logoSize'] {
  return value === 'sm' || value === 'md' || value === 'lg' ? value : undefined;
}

function readHeroImageFit(value: unknown): EventPageEventDescriptionProps['imageFit'] {
  return value === 'contain' || value === 'cover' ? value : undefined;
}

function readHeroImagePosition(value: unknown): EventPageEventDescriptionProps['imagePosition'] {
  return value === 'center' ||
    value === 'top' ||
    value === 'bottom' ||
    value === 'left' ||
    value === 'right'
    ? value
    : undefined;
}

function readHeroImagePlacement(value: unknown): EventPageEventDescriptionProps['imagePlacement'] {
  if (!isRecord(value)) return undefined;
  const x = cleanOptionalString(value.x);
  const y = cleanOptionalString(value.y);
  const scale = cleanOptionalString(value.scale);
  return x || y || scale ? { x, y, scale } : undefined;
}

function readOverlayContentPosition(
  value: unknown,
): EventPageEventDescriptionProps['overlayContentPosition'] {
  return value === 'top' || value === 'center' || value === 'bottom' ? value : undefined;
}

function readRadiusPreset(value: unknown): EventPageRadiusPreset | undefined {
  return value === 'none' || value === 'tight' || value === 'soft' || value === 'round'
    ? value
    : undefined;
}

function readSectionStyle(value: unknown): EventPageSectionStyle | undefined {
  return value === 'plain' || value === 'outlined' || value === 'filled' ? value : undefined;
}

function readWidth(value: unknown): EventPageMediaProps['width'] {
  return value === 'wide' || value === 'normal' ? value : undefined;
}

function readAspectRatio(value: unknown): EventPageMediaProps['aspectRatio'] {
  return value === '16:9' || value === '4:3' || value === '1:1' || value === 'auto'
    ? value
    : 'auto';
}

function readButtonStyle(value: unknown): EventPageButtonProps['style'] {
  return value === 'secondary' || value === 'link' || value === 'primary' ? value : 'primary';
}

function readButtonSize(value: unknown): EventPageButtonProps['size'] {
  return value === 'small' || value === 'medium' || value === 'large' ? value : undefined;
}

function readButtonWidth(value: unknown): EventPageButtonProps['width'] {
  return value === 'auto' || value === 'full' ? value : undefined;
}

function readButtonRadius(value: unknown): EventPageButtonProps['radius'] {
  return value === 'square' || value === 'tight' || value === 'soft' || value === 'pill'
    ? value
    : undefined;
}

function readButtonTextStyle(value: unknown): EventPageButtonProps['textStyle'] {
  return value === 'normal' || value === 'bold' || value === 'uppercase' ? value : undefined;
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
