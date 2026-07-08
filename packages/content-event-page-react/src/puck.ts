export {
  EVENT_PAGE_PUCK_STYLES_CLASS,
  ButtonBlock,
  CustomEmbedBlock,
  DividerBlock,
  EventDetailsBlock,
  EventPageRender,
  EventPagePuckRender,
  EventPageRoot,
  FAQBlock,
  HeroBlock,
  MediaBlock,
  RichTextBlock,
  ScheduleBlock,
  SocialLinksBlock,
  SpeakersBlock,
  SponsorsBlock,
  VenueBlock,
  createEventPageRenderStyle,
  eventPagePuckConfig,
  eventPagePuckIframeConfig,
  isEventPagePuckData,
  isEventPagePuckComponentType,
  resolveRenderData,
} from './index.js';

export type {
  EventPagePuckCategory,
  EventPagePuckComponentProps,
  EventPagePuckConfig,
  EventPagePuckCoreData,
  EventPageRenderProps,
} from './index.js';

export {
  EVENT_PAGE_DOCUMENT_V2_SCHEMA_VERSION,
  EVENT_PAGE_PUCK_PROVIDER,
  createDefaultEventPageDocument,
  isEventPageDocumentV2,
  normalizeEventPageDocumentV2,
  normalizePublicEventPagePayloadV2,
  validateEventPageDocumentV2,
} from '@tixkit/content-event-page/puck';

export type {
  EventPageDocumentV2,
  EventPagePuckData,
  EventPageSettingsV2,
  PublicEventPagePayloadV2,
} from '@tixkit/content-event-page/puck';
