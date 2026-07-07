'use client';

import * as React from 'react';
import { type JSONContent } from '@tiptap/core';
import {
  Archive,
  CalendarDays,
  Code2,
  Copy,
  Eye,
  ExternalLink,
  FileJson,
  PanelBottom,
  Heading,
  HelpCircle,
  ImageIcon,
  Info,
  LayoutTemplate,
  ListChecks,
  MapPin,
  Mic,
  Minus,
  PanelRightClose,
  PanelLeftClose,
  Repeat,
  Save,
  Share2,
  ShoppingBag,
  Sparkles,
  Ticket,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  type DropdownMenuItemConfig,
  EditorChrome,
  EditorLeftRail,
  type EditorMode,
  EditorTopBar,
  InsertPopoverButton,
  InsertPopoverItem,
  InspectorPanel,
  InspectorReopenButton,
  MobileInsertButton,
  cn,
  inputClassName,
} from '@tixkit/content-editor-shell';
import {
  createDefaultEventPageDocument,
  normalizeEventPageDocument,
  renderEventPageDocument,
  renderResolvedEventPageHtml,
  renderResolvedEventPageText,
  resolveEventPageDocument,
  TIPTAP_EVENT_PAGE_PROVIDER,
  type EventPageBlock,
  type EventPageDocument,
  type EventPageRenderContext,
  type ResolvedEventPage,
} from '@tixkit/content-event-page';
import { EventPageSurface } from '@tixkit/content-event-page-react';
import {
  adminApi,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminEventDetail,
} from '@/lib/api';
import { usePermissions } from '@/context/permission-provider';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type EditorPreview = {
  label: string;
  renderModel: ResolvedEventPage;
  html: string;
  text: string;
};
type InsertActionId =
  | 'text'
  | 'image'
  | 'hero'
  | 'event_details'
  | 'tickets'
  | 'products'
  | 'schedule'
  | 'venue'
  | 'faq'
  | 'sponsors'
  | 'speakers'
  | 'button'
  | 'divider'
  | 'social_links'
  | 'custom_embed'
  | 'event_header'
  | 'resale_tickets'
  | 'brand_footer';
type EventPageVariableKind = 'event' | 'ticket' | 'brand' | 'link' | 'system';
type EventPageVariablePresentation = {
  label: string;
  preview: string;
  kind: EventPageVariableKind;
};
type InspectorPanelId = 'block' | 'page' | 'code' | 'variables' | 'history' | 'issues';

type InsertAction = {
  id: InsertActionId;
  label: string;
  icon: React.ReactNode;
};

const eventPageInsertActions: InsertAction[] = [
  { id: 'text', label: 'Text', icon: <Type className="size-4" /> },
  { id: 'image', label: 'Image', icon: <ImageIcon className="size-4" /> },
  { id: 'hero', label: 'Hero', icon: <Sparkles className="size-4" /> },
  { id: 'event_details', label: 'Event details', icon: <Info className="size-4" /> },
  { id: 'tickets', label: 'Tickets', icon: <Ticket className="size-4" /> },
  { id: 'products', label: 'Products', icon: <ShoppingBag className="size-4" /> },
  { id: 'schedule', label: 'Schedule', icon: <CalendarDays className="size-4" /> },
  { id: 'venue', label: 'Venue', icon: <MapPin className="size-4" /> },
  { id: 'faq', label: 'FAQ', icon: <HelpCircle className="size-4" /> },
  { id: 'sponsors', label: 'Sponsors', icon: <LayoutTemplate className="size-4" /> },
  { id: 'speakers', label: 'Speakers', icon: <Mic className="size-4" /> },
  { id: 'button', label: 'Button', icon: <ExternalLink className="size-4" /> },
  { id: 'divider', label: 'Divider', icon: <Minus className="size-4" /> },
  { id: 'social_links', label: 'Social links', icon: <Share2 className="size-4" /> },
  { id: 'custom_embed', label: 'Custom embed', icon: <Code2 className="size-4" /> },
  { id: 'event_header', label: 'Event header', icon: <Heading className="size-4" /> },
  { id: 'resale_tickets', label: 'Resale tickets', icon: <Repeat className="size-4" /> },
  { id: 'brand_footer', label: 'Brand footer', icon: <PanelBottom className="size-4" /> },
];

const eventPageMergeTagPattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const eventPageVariableKeys = [
  'event.title',
  'event.startsAt',
  'event.endsAt',
  'event.timezone',
  'event.venueName',
  'event.checkoutUrl',
  'event.publicUrl',
  'brand.name',
  'ticket.name',
  'ticket.priceLabel',
] as const;

const eventPageVariablePresentations: Record<string, EventPageVariablePresentation> = {
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
  'brand.name': {
    label: 'Brand name',
    preview: 'Tixkit',
    kind: 'brand',
  },
  'ticket.name': {
    label: 'Ticket name',
    preview: 'General Admission',
    kind: 'ticket',
  },
  'ticket.priceLabel': {
    label: 'Ticket price',
    preview: '$35.00',
    kind: 'ticket',
  },
};

function fallbackEventPageVariableKind(key: string): EventPageVariableKind {
  if (key.startsWith('event.')) return key.endsWith('Url') ? 'link' : 'event';
  if (key.startsWith('ticket.') || key.startsWith('tickets.')) return 'ticket';
  if (key.startsWith('brand.')) return 'brand';
  if (key.endsWith('Url') || key.endsWith('Link')) return 'link';
  return 'system';
}

function eventPageVariablePresentation(key: string): EventPageVariablePresentation {
  const fallbackLabel = key
    .split('.')
    .filter(Boolean)
    .map((part) => part.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(' ');
  return (
    eventPageVariablePresentations[key] ?? {
      label: fallbackLabel || 'Dynamic value',
      preview: fallbackLabel || 'dynamic value',
      kind: fallbackEventPageVariableKind(key),
    }
  );
}

function mergeTagKeys(value: string): string[] {
  return Array.from(value.matchAll(eventPageMergeTagPattern), (match) => match[1]).filter(
    (key, index, keys) => key && keys.indexOf(key) === index,
  );
}

function friendlyMergeTagText(value: string): string {
  return value.replace(eventPageMergeTagPattern, (_tag, key: string) => {
    const presentation = eventPageVariablePresentation(key);
    return presentation.preview;
  });
}

function listItemsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const keyed = value as { items?: unknown };
  if (Array.isArray(keyed.items)) return keyed.items as T[];
  return Object.values(value).filter(
    (item): item is T => Boolean(item) && typeof item === 'object',
  );
}

function sampleContext(event: AdminEventDetail): EventPageRenderContext {
  return {
    event: {
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      venueName: event.venueName ?? event.venue?.name,
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
      publicUrl: `https://events.example.test/e/${event.id}`,
    },
    brand: {
      name: 'Tixkit',
    },
    tickets: [
      {
        id: 'tt_preview_ga',
        name: 'General Admission',
        status: 'active',
        priceLabel: '$35.00',
      },
    ],
    products: [
      {
        id: 'prod_preview_shirt',
        name: 'Event T-Shirt',
        priceLabel: '$25.00',
      },
    ],
  };
}

function defaultEventPageDocument(event: AdminEventDetail): EventPageDocument {
  return createDefaultEventPageDocument({
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description ?? 'Hosted event-page draft generated from event metadata.',
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    venue: event.venue ?? {
      name: event.venueName,
      city: event.city,
    },
    checkoutUrl: '{{event.checkoutUrl}}',
    publicUrl: '{{event.publicUrl}}',
    coverImageUrl: event.coverImageUrl,
  });
}

function previewFromRendered(document: EventPageDocument, event: AdminEventDetail): EditorPreview {
  const resolved = resolveEventPageDocument(document, sampleContext(event));
  return {
    label: 'TipTap event-page preview',
    renderModel: resolved,
    html: renderResolvedEventPageHtml(resolved),
    text: renderResolvedEventPageText(resolved),
  };
}

function publicPageUrl(document: EventPageDocument, event: AdminEventDetail): string | undefined {
  const rendered = renderEventPageDocument(document, sampleContext(event));
  const publicPath = rendered.discovery.publicPath;
  return publicPath && publicPath !== '#' ? publicPath : undefined;
}

function heroBlock(document: EventPageDocument) {
  return document.blocks.find((block) => block.type === 'hero');
}

function ticketsBlock(document: EventPageDocument) {
  return document.blocks.find((block) => block.type === 'tickets');
}

function heroHeadline(document: EventPageDocument): string {
  const block = heroBlock(document);
  return block?.type === 'hero' ? block.headline : '';
}

function ticketCtaLabel(document: EventPageDocument): string {
  const block = ticketsBlock(document);
  return block?.type === 'tickets'
    ? (block.ctaLabel ?? document.settings.ticketCtaLabel)
    : document.settings.ticketCtaLabel;
}

function nextBlockId(document: EventPageDocument, prefix: string): string {
  const existing = new Set(document.blocks.map((block) => block.id));
  let index = document.blocks.length + 1;
  let id = `${prefix}-${index}`;
  while (existing.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

function textContentNode(text: string): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function imageContentNode(src: string, alt: string): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'image',
        attrs: { src, alt, title: alt },
      },
    ],
  };
}

function tipTapText(block: Extract<EventPageBlock, { type: 'rich_text' }>): string {
  const values: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const current = node as { text?: unknown; content?: unknown };
    if (typeof current.text === 'string') values.push(current.text);
    if (Array.isArray(current.content)) current.content.forEach(visit);
  };
  visit(block.content);
  return values.join('\n');
}

function tipTapImageAttrs(block: Extract<EventPageBlock, { type: 'rich_text' }>) {
  const queue: unknown[] = [block.content];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const current = node as {
      type?: unknown;
      attrs?: unknown;
      content?: unknown;
    };
    if (current.type === 'image' && current.attrs && typeof current.attrs === 'object') {
      const attrs = current.attrs as { src?: unknown; alt?: unknown };
      return {
        src: typeof attrs.src === 'string' ? attrs.src : '',
        alt: typeof attrs.alt === 'string' ? attrs.alt : '',
      };
    }
    if (Array.isArray(current.content)) queue.push(...current.content);
  }
  return undefined;
}

function createInsertedBlock(
  actionId: InsertActionId,
  document: EventPageDocument,
  event: AdminEventDetail,
): EventPageBlock | undefined {
  if (actionId === 'text') {
    return {
      id: nextBlockId(document, 'rich-text'),
      type: 'rich_text',
      content: textContentNode('Add event page copy here.'),
    };
  }
  if (actionId === 'image') {
    return {
      id: nextBlockId(document, 'image'),
      type: 'rich_text',
      content: imageContentNode(
        event.coverImageUrl ?? 'https://images.example.test/event-page-image.jpg',
        `${event.title} image`,
      ),
    };
  }
  if (actionId === 'tickets') {
    return {
      id: nextBlockId(document, 'tickets'),
      type: 'tickets',
      title: 'Tickets',
      body: 'Choose your ticket type and continue through secure checkout.',
      ctaLabel: document.settings.ticketCtaLabel,
    };
  }
  if (actionId === 'schedule') {
    return {
      id: nextBlockId(document, 'schedule'),
      type: 'schedule',
      title: 'Schedule',
      items: [
        {
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timezone: event.timezone,
          venueName: event.venueName ?? event.venue?.name,
        },
      ],
    };
  }
  if (actionId === 'venue') {
    return {
      id: nextBlockId(document, 'venue'),
      type: 'venue_map',
      title: 'Venue',
      venueName: event.venueName ?? event.venue?.name ?? 'Venue name',
      address: event.venue?.address ?? event.city ?? 'Venue address',
    };
  }
  if (actionId === 'button') {
    return {
      id: nextBlockId(document, 'button'),
      type: 'button',
      label: 'Buy tickets',
      url: '{{event.checkoutUrl}}',
    };
  }
  if (actionId === 'hero') {
    return {
      id: nextBlockId(document, 'hero'),
      type: 'hero',
      eyebrow: '{{brand.name}}',
      headline: event.title,
      body: event.description ?? 'Event page headline.',
      ctaLabel: 'Get tickets',
      ctaUrl: '{{event.checkoutUrl}}',
    };
  }
  if (actionId === 'event_details') {
    return {
      id: nextBlockId(document, 'details'),
      type: 'event_details',
      title: 'Event details',
      items: [
        { label: 'Starts', value: '{{event.startsAt}}' },
        { label: 'Ends', value: '{{event.endsAt}}' },
        { label: 'Timezone', value: '{{event.timezone}}' },
      ],
    };
  }
  if (actionId === 'products') {
    return {
      id: nextBlockId(document, 'products'),
      type: 'products',
      title: 'Products',
      body: 'Event merchandise and add-ons.',
      productIds: [],
    };
  }
  if (actionId === 'faq') {
    return {
      id: nextBlockId(document, 'faq'),
      type: 'faq',
      title: 'FAQ',
      items: [
        {
          question: 'How do I get my tickets?',
          answer:
            'Tickets are delivered by email after checkout and can be opened from your confirmation page.',
        },
      ],
    };
  }
  if (actionId === 'sponsors') {
    return {
      id: nextBlockId(document, 'sponsors'),
      type: 'sponsors',
      title: 'Sponsors',
      items: [],
    };
  }
  if (actionId === 'speakers') {
    return {
      id: nextBlockId(document, 'speakers'),
      type: 'speakers',
      title: 'Speakers',
      items: [],
    };
  }
  if (actionId === 'divider') {
    return {
      id: nextBlockId(document, 'divider'),
      type: 'divider',
    };
  }
  if (actionId === 'social_links') {
    return {
      id: nextBlockId(document, 'social'),
      type: 'social_links',
      title: 'Follow',
      links: [],
    };
  }
  if (actionId === 'custom_embed') {
    return {
      id: nextBlockId(document, 'embed'),
      type: 'custom_embed',
      html: '',
      allowUnsafeEmbed: false,
    };
  }
  if (actionId === 'event_header') {
    return {
      id: nextBlockId(document, 'header'),
      type: 'event_header',
      showBadge: true,
      showDate: true,
      showVenue: true,
      showDescription: true,
    };
  }
  if (actionId === 'resale_tickets') {
    return {
      id: nextBlockId(document, 'resale'),
      type: 'resale_tickets',
      title: 'Resale tickets',
      ctaLabel: 'Buy resale',
      emptyStateText: 'No resale tickets available.',
      showVerifiedBadge: true,
    };
  }
  if (actionId === 'brand_footer') {
    return {
      id: nextBlockId(document, 'footer'),
      type: 'brand_footer',
      showSupport: true,
      showTerms: true,
      showPrivacy: true,
      showRefund: true,
    };
  }
  return undefined;
}

function blockLabel(block: EventPageBlock): string {
  switch (block.type) {
    case 'hero':
      return 'Hero';
    case 'rich_text':
      return 'Rich text';
    case 'event_details':
      return 'Event details';
    case 'tickets':
      return 'Tickets';
    case 'products':
      return 'Products';
    case 'schedule':
      return 'Schedule';
    case 'venue_map':
      return 'Venue';
    case 'faq':
      return 'FAQ';
    case 'sponsors':
      return 'Sponsors';
    case 'speakers':
      return 'Speakers';
    case 'button':
      return 'Button';
    case 'divider':
      return 'Divider';
    case 'social_links':
      return 'Social links';
    case 'custom_embed':
      return 'Custom embed';
    case 'event_header':
      return 'Event header';
    case 'resale_tickets':
      return 'Resale tickets';
    case 'brand_footer':
      return 'Brand footer';
  }
}

function blockSummary(block: EventPageBlock): string {
  const previewText = (value: string | undefined) => friendlyMergeTagText(value ?? '');
  switch (block.type) {
    case 'hero':
      return block.body
        ? `${previewText(block.headline)} - ${previewText(block.body)}`
        : previewText(block.headline);
    case 'event_details':
      return `${block.items.length} details`;
    case 'tickets':
      return previewText(block.body ?? block.title);
    case 'schedule':
      return `${block.items.length} schedule items`;
    case 'venue_map':
      return block.address
        ? `${previewText(block.venueName)} - ${previewText(block.address)}`
        : previewText(block.venueName);
    case 'faq':
      return `${block.items.length} questions`;
    case 'products':
      return `${block.productIds.length} products`;
    case 'sponsors':
    case 'speakers':
      return `${block.items.length} entries`;
    case 'button':
      return previewText(block.label);
    case 'social_links':
      return `${block.links.length} links`;
    case 'custom_embed':
      return block.allowUnsafeEmbed ? 'Reviewed custom embed' : 'Embed blocked until reviewed';
    case 'divider':
      return 'Divider';
    case 'rich_text':
      return tipTapImageAttrs(block)
        ? 'Image content'
        : previewText(tipTapText(block)) || 'Structured content';
    case 'event_header':
      return block.badgeLabel ? previewText(block.badgeLabel) : 'Event metadata header';
    case 'resale_tickets':
      return previewText(block.title);
    case 'brand_footer':
      return 'Footer links';
  }
}

function versionSummaries(versions: AdminContentDocumentVersion[]) {
  return versions.map((version) => ({
    id: version.id,
    label: `${version.status === 'published' ? 'Published' : 'Draft'} v${version.versionNumber}`,
    status: version.status,
    timestamp: version.publishedAt ?? version.createdAt,
    author: version.createdBy,
  }));
}

function latestVersion(items: AdminContentDocumentVersion[]) {
  return items.reduce<AdminContentDocumentVersion | undefined>(
    (current, version) =>
      !current || version.versionNumber > current.versionNumber ? version : current,
    undefined,
  );
}

function latestDraft(versions: AdminContentDocumentVersion[], document: AdminContentDocument) {
  return (
    versions.find((version) => version.id === document.currentDraftVersionId) ??
    latestVersion(versions.filter((version) => version.status === 'draft')) ??
    latestVersion(versions)
  );
}

function resultMessage(error: { message?: string } | undefined, defaultMessage: string) {
  return error?.message ?? defaultMessage;
}

function duplicateDocumentName(name: string): string {
  const suffix = ' Copy';
  return name.endsWith(suffix) ? name : `${name.slice(0, 160 - suffix.length)}${suffix}`;
}

function editorDocumentFromBlocks(blocks: EventPageBlock[]): JSONContent {
  const content = blocks
    .flatMap((block) => {
      const summary = blockSummary(block).trim();
      return summary
        ? [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: summary }],
            },
          ]
        : [];
    })
    .slice(0, 40);
  return {
    type: 'doc',
    content: content.length > 0 ? content : [{ type: 'paragraph' }],
  };
}

function withEditorBlocks(
  snapshot: EventPageDocument,
  blocks: EventPageBlock[],
): EventPageDocument {
  const hero = blocks.find(
    (block): block is Extract<EventPageBlock, { type: 'hero' }> => block.type === 'hero',
  );
  const tickets = blocks.find(
    (block): block is Extract<EventPageBlock, { type: 'tickets' }> => block.type === 'tickets',
  );
  const summary = hero?.body ?? snapshot.settings.discovery.summary;
  const ticketLabel = tickets?.ctaLabel ?? snapshot.settings.ticketCtaLabel;

  return {
    ...snapshot,
    editor: {
      provider: TIPTAP_EVENT_PAGE_PROVIDER,
      document: editorDocumentFromBlocks(blocks),
    },
    settings: {
      ...snapshot.settings,
      ticketCtaLabel: ticketLabel,
      discovery: {
        ...snapshot.settings.discovery,
        summary,
        seoTitle: hero?.headline ?? snapshot.settings.discovery.seoTitle,
        seoDescription: summary,
        coverImageUrl: snapshot.settings.discovery.coverImageUrl ?? hero?.imageUrl,
        socialImageUrl: snapshot.settings.discovery.socialImageUrl ?? hero?.imageUrl,
      },
    },
    blocks,
  };
}

function formatDate(value?: string) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function VariablePreviewHint({ keys }: { keys: string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[0.68rem] font-medium leading-5 text-black/45">
      <span>Dynamic values</span>
      {keys.map((key) => {
        const presentation = eventPageVariablePresentation(key);
        return (
          <span
            className={`tixkit-variable-kind-badge tixkit-variable-kind-badge--${presentation.kind} inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5`}
            key={key}
            title={presentation.label}
          >
            <span>{presentation.label}</span>
            <span aria-hidden="true" className="opacity-60">
              /
            </span>
            <span className="truncate">{presentation.preview}</span>
          </span>
        );
      })}
    </span>
  );
}
function PreviewDrawer({ onClose, preview }: { onClose: () => void; preview: EditorPreview }) {
  const [debugTab, setDebugTab] = React.useState<'rendered' | 'html' | 'text'>('rendered');
  return (
    <aside
      aria-label="Event page preview"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background text-foreground shadow-2xl"
      data-testid="preview-drawer"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{preview.label}</p>
          <p className="text-xs text-muted-foreground">
            {preview.renderModel.validation.valid ? 'Valid' : 'Publish blockers'}
          </p>
        </div>
        <button
          className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      <div className="flex gap-1 border-b px-4 py-2">
        {(['rendered', 'html', 'text'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              debugTab === tab
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            onClick={() => setDebugTab(tab)}
            aria-pressed={debugTab === tab}
          >
            {tab === 'rendered' ? 'Rendered' : tab.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {debugTab === 'rendered' ? (
          <div data-testid="preview-surface">
            <EventPageSurface resolvedPage={preview.renderModel} mode="preview" />
          </div>
        ) : (
          <pre
            data-testid={`preview-${debugTab}`}
            className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5 text-muted-foreground"
          >
            {debugTab === 'html' ? preview.html : preview.text}
          </pre>
        )}
      </div>
    </aside>
  );
}

export function EventPagePersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [eventPageDocument, setEventPageDocument] = React.useState<EventPageDocument>();
  const [selectedBlockId, setSelectedBlockId] = React.useState<string>();
  const [inspectorPanelId, setInspectorPanelId] = React.useState<InspectorPanelId>('block');
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [insertDrawerOpen, setInsertDrawerOpen] = React.useState(false);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [preview, setPreview] = React.useState<EditorPreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const documentRef = React.useRef<EventPageDocument | undefined>(undefined);
  const isArchived = document?.status === 'archived';
  const { can } = usePermissions();
  const canEdit = Boolean(document) && !isArchived && can('events.write');

  const [previewUrl, setPreviewUrl] = React.useState<string | undefined>(undefined);
  const [previewError, setPreviewError] = React.useState<string | undefined>(undefined);
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const suppressIframeUpdateRef = React.useRef(false);
  const updateEventPageSettingsRef = React.useRef<
    (update: (document: EventPageDocument) => EventPageDocument) => void
  >(() => undefined);

  const ADMIN_SOURCE = 'tixkit-event-page-admin';
  const EDITOR_SOURCE = 'tixkit-event-page-editor';

  const iframeOrigin = React.useMemo(() => {
    if (!previewUrl) return null;
    try {
      return new URL(previewUrl).origin;
    } catch {
      return null;
    }
  }, [previewUrl]);

  const sendMessageToIframe = React.useCallback(
    (message: Record<string, unknown>) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      iframe.contentWindow.postMessage({ source: ADMIN_SOURCE, ...message }, iframeOrigin ?? '*');
    },
    [iframeOrigin],
  );

  React.useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (iframeOrigin && event.origin !== iframeOrigin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const msg = data as Record<string, unknown>;
      if (msg.source !== EDITOR_SOURCE) return;
      if (msg.type === 'ready') {
        if (eventPageDocument) {
          sendMessageToIframe({
            type: 'update-document',
            document: eventPageDocument,
            selectedBlockId,
          });
        }
        return;
      }
      if (msg.type === 'selection-change' && typeof msg.blockId === 'string') {
        setSelectedBlockId(msg.blockId as string);
        return;
      }
      if (msg.type === 'block-change' && typeof msg.blockId === 'string' && msg.block) {
        suppressIframeUpdateRef.current = true;
        updateEventPageSettingsRef.current((current) => ({
          ...current,
          blocks: current.blocks.map((b) =>
            b.id === (msg.blockId as string) ? (msg.block as EventPageBlock) : b,
          ),
        }));
        return;
      }
      if (msg.type === 'blocks-reorder' && Array.isArray(msg.blocks)) {
        suppressIframeUpdateRef.current = true;
        updateEventPageSettingsRef.current((current) => ({
          ...current,
          blocks: msg.blocks as EventPageBlock[],
        }));
        return;
      }
      if (msg.type === 'block-delete' && typeof msg.blockId === 'string') {
        suppressIframeUpdateRef.current = true;
        const deletedId = msg.blockId as string;
        updateEventPageSettingsRef.current((current) => {
          const blocks = current.blocks.filter((b) => b.id !== deletedId);
          const nextSelected = blocks.find((b) => b.id !== deletedId)?.id;
          if (nextSelected) {
            setSelectedBlockId(nextSelected);
            sendMessageToIframe({ type: 'select-block', blockId: nextSelected });
          }
          return { ...current, blocks };
        });
        return;
      }
      if (msg.type === 'block-duplicate' && typeof msg.blockId === 'string' && msg.block) {
        suppressIframeUpdateRef.current = true;
        const originalId = msg.blockId as string;
        const duplicate = msg.block as EventPageBlock;
        updateEventPageSettingsRef.current((current) => {
          const index = current.blocks.findIndex((b) => b.id === originalId);
          if (index < 0) return current;
          const blocks = [
            ...current.blocks.slice(0, index + 1),
            duplicate,
            ...current.blocks.slice(index + 1),
          ];
          setSelectedBlockId(duplicate.id);
          return { ...current, blocks };
        });
        return;
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [eventPageDocument, sendMessageToIframe, iframeOrigin, selectedBlockId]);

  React.useEffect(() => {
    documentRef.current = eventPageDocument;
  }, [eventPageDocument]);

  function nextOperationId() {
    operationIdRef.current += 1;
    return operationIdRef.current;
  }

  function isCurrentOperation(operationId: number) {
    return operationIdRef.current === operationId;
  }

  function markDraftDirty() {
    nextOperationId();
    setAutosave('idle');
    setActionError(undefined);
    setNotice(undefined);
  }

  function openInspectorPanel(panelId: InspectorPanelId) {
    setInspectorPanelId(panelId);
    setInspectorCollapsed(false);
  }

  function openMenuInspectorPanel(panelId: InspectorPanelId) {
    openInspectorPanel(panelId);
  }

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setActionError(undefined);
    setNotice(undefined);

    const eventResult = await adminApi.getEvent(eventId);
    if (!eventResult.ok) {
      setError(resultMessage(eventResult.error, 'Unable to load event'));
      setLoading(false);
      return;
    }
    const loadedEvent = eventResult.data;
    if (!loadedEvent.organizationId || !loadedEvent.brandId) {
      setError('Event is missing organization or brand scope for persisted event-page content.');
      setLoading(false);
      return;
    }

    const documentsResult = await adminApi.listContentDocuments({
      channel: 'event_page',
      brandId: loadedEvent.brandId,
      eventId: loadedEvent.id,
      limit: 20,
    });
    if (!documentsResult.ok) {
      setError(resultMessage(documentsResult.error, 'Unable to load event-page content documents'));
      setLoading(false);
      return;
    }

    let loadedDocument = listItemsFromResponse<AdminContentDocument>(documentsResult.data).find(
      (item) => item.channel === 'event_page' && item.eventId === loadedEvent.id,
    );
    if (!loadedDocument) {
      const createResult = await adminApi.createContentDocument({
        organizationId: loadedEvent.organizationId,
        brandId: loadedEvent.brandId,
        eventId: loadedEvent.id,
        channel: 'event_page',
        key: 'main',
        name: `${loadedEvent.title} event page`,
        locale: 'en',
      });
      if (!createResult.ok) {
        setError(resultMessage(createResult.error, 'Unable to create event-page content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load event-page versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = defaultEventPageDocument(loadedEvent);
      const rendered = renderEventPageDocument(initialDocument, sampleContext(loadedEvent));
      const saveResult = await adminApi.saveContentVersion(loadedDocument.id, {
        contentJson: initialDocument,
        subject: heroHeadline(initialDocument),
        previewText: initialDocument.settings.discovery.summary,
        renderedHtml: rendered.html,
        renderedText: rendered.text,
      });
      if (!saveResult.ok) {
        setError(resultMessage(saveResult.error, 'Unable to create the initial event-page draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = normalizeEventPageDocument(loadedDraft.contentJson);
    if (!normalized) {
      setError('Saved event-page draft is not canonical Tixkit TipTap event-page JSON.');
      setLoading(false);
      return;
    }

    documentRef.current = normalized;
    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setEventPageDocument(normalized);
    setSelectedBlockId(normalized.blocks[0]?.id);
    setPreview(previewFromRendered(normalized, loadedEvent));
    setAutosave('saved');
    setLoading(false);

    setPreviewError(undefined);
    const tokenResult = await adminApi.mintPreviewToken(loadedDocument.id);
    if (tokenResult.ok) {
      setPreviewUrl(tokenResult.data.url);
    } else {
      setPreviewError(
        resultMessage(
          tokenResult.error,
          'Unable to mint preview token. Check that TIXKIT_PREVIEW_TOKEN_SECRET and PUBLIC_CHECKOUT_URL are configured.',
        ),
      );
    }
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1023px)').matches) {
      setInspectorCollapsed(true);
    }
  }, []);

  function snapshotFromEditor(snapshot = eventPageDocument): EventPageDocument | undefined {
    if (!snapshot) return undefined;
    return withEditorBlocks(snapshot, snapshot.blocks);
  }

  function updateEventPageSettings(update: (document: EventPageDocument) => EventPageDocument) {
    if (!eventPageDocument || isArchived) return;
    const nextDocument = update(eventPageDocument);
    documentRef.current = nextDocument;
    setEventPageDocument(nextDocument);
    markDraftDirty();
    if (!suppressIframeUpdateRef.current) {
      sendMessageToIframe({
        type: 'update-document',
        document: nextDocument,
        selectedBlockId,
      });
    }
    suppressIframeUpdateRef.current = false;
  }

  React.useEffect(() => {
    updateEventPageSettingsRef.current = updateEventPageSettings;
  });

  function selectBlock(blockId: string) {
    setSelectedBlockId(blockId);
    openInspectorPanel('block');
    sendMessageToIframe({ type: 'select-block', blockId });
  }

  function updateSelectedEventPageBlock(nextBlock: EventPageBlock) {
    if (!eventPageDocument || !selectedBlockId) return;
    const nextDocument: EventPageDocument = {
      ...eventPageDocument,
      blocks: eventPageDocument.blocks.map((block) =>
        block.id === selectedBlockId ? nextBlock : block,
      ),
    };
    documentRef.current = nextDocument;
    setEventPageDocument(nextDocument);
    markDraftDirty();
    sendMessageToIframe({
      type: 'update-block',
      blockId: selectedBlockId,
      block: nextBlock,
    });
  }

  function insertEventPageAction(actionId: InsertActionId) {
    if (!event || !eventPageDocument || isArchived) return;
    const currentDocument = snapshotFromEditor(eventPageDocument) ?? eventPageDocument;
    const inserted = createInsertedBlock(actionId, currentDocument, event);
    if (!inserted) return;
    updateEventPageSettings((current) => ({
      ...current,
      blocks: [...current.blocks, inserted],
    }));
    selectBlock(inserted.id);
  }

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const editorSnapshot = snapshotFromEditor(snapshot);
    if (!editorSnapshot) return undefined;
    const rendered = renderEventPageDocument(editorSnapshot, sampleContext(event));
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: editorSnapshot,
      subject: heroHeadline(editorSnapshot),
      previewText: editorSnapshot.settings.discovery.summary,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save event-page draft'));
      return undefined;
    }
    documentRef.current = editorSnapshot;
    setEventPageDocument(editorSnapshot);
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setPreview(previewFromRendered(editorSnapshot, event));
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return { version: result.data, document: editorSnapshot };
  }

  async function previewSavedDraft() {
    if (!document || !event || !eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, eventPageDocument);
    if (!saved) return;
    const result = await adminApi.previewContent(document.id, {
      versionId: saved.version.id,
      contentJson: saved.document,
      subject: heroHeadline(saved.document),
      previewText: saved.document.settings.discovery.summary,
      context: sampleContext(event),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to preview event-page draft'));
      return;
    }
    const resolved = resolveEventPageDocument(saved.document, sampleContext(event));
    setPreview({
      label: 'Saved event-page preview',
      renderModel: resolved,
      html: result.data.output.html ?? renderResolvedEventPageHtml(resolved),
      text: result.data.output.text ?? renderResolvedEventPageText(resolved),
    });
    setPreviewOpen(true);
    setActionError(undefined);
    setNotice('Preview rendered from the saved content version');
  }

  function viewPublicPage() {
    if (!event || !eventPageDocument || isArchived) return;
    const snapshot = snapshotFromEditor(eventPageDocument) ?? eventPageDocument;
    const url = publicPageUrl(snapshot, event);
    if (!url) {
      setActionError('Public page URL is not available. Set a safe http(s) public path first.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    setActionError(undefined);
    setNotice('Opened public page');
  }

  async function publishDraft() {
    if (!document || !eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, eventPageDocument);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.version.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to publish event page'));
      return;
    }
    setDocument(result.data.document);
    setDraft(result.data.version);
    setVersions((current) => [
      result.data.version,
      ...current.filter((version) => version.id !== result.data.version.id),
    ]);
    setActionError(undefined);
    setNotice(`Published v${result.data.version.versionNumber}`);
    toast.success('Event page published');
  }

  async function archiveDocument() {
    if (!document) return;
    if (
      !window.confirm(
        'Archive this event page? Editing, publishing, and previews will be disabled.',
      )
    ) {
      return;
    }
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to archive event page'));
      return;
    }
    setDocument(result.data);
    setActionError(undefined);
    setNotice('Archived event page');
    toast.success('Event page archived');
  }

  async function duplicateDocument() {
    if (!document || !eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, eventPageDocument);
    if (!saved) return;
    const result = await adminApi.duplicateContentDocument(document.id, {
      name: duplicateDocumentName(document.name),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to duplicate event page'));
      return;
    }
    setActionError(undefined);
    setNotice(`Duplicated event page as ${result.data.name}`);
    toast.success('Event page duplicated');
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading event-page editor...
      </div>
    );
  }

  if (error || !event || !document || !draft || !eventPageDocument || !preview) {
    return (
      <section className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Event page editor</p>
            <h1 className="text-2xl font-semibold">Unable to load editor</h1>
          </div>
          <p className="text-sm text-destructive">
            {error ?? 'Hosted page editor could not load.'}
          </p>
          <button
            className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
            onClick={() => void load()}
            type="button"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const archivedReason = isArchived ? 'Archived pages are read-only.' : undefined;
  const selectedBlock = eventPageDocument.blocks.find((block) => block.id === selectedBlockId);
  const selectedBlockLabel = selectedBlock ? blockLabel(selectedBlock) : 'Content';
  const history = versionSummaries(versions);
  const selectedBlockControls = (() => {
    if (!selectedBlock) {
      return <p className="text-xs text-muted-foreground">Select content in the canvas.</p>;
    }

    if (selectedBlock.type === 'hero') {
      const variableKeys = mergeTagKeys(selectedBlock.ctaUrl ?? '');
      return (
        <div className="space-y-2">
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            Hero CTA URL
            <input
              aria-label="Hero CTA URL"
              className={inputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEventPageBlock({
                  ...selectedBlock,
                  ctaUrl: change.currentTarget.value,
                })
              }
              value={selectedBlock.ctaUrl ?? ''}
            />
          </label>
          {variableKeys.length > 0 && <VariablePreviewHint keys={variableKeys} />}
        </div>
      );
    }

    if (selectedBlock.type === 'rich_text') {
      const imageAttrs = tipTapImageAttrs(selectedBlock);
      if (!imageAttrs) {
        return <p className="text-xs text-muted-foreground">{blockSummary(selectedBlock)}</p>;
      }
      return (
        <div className="space-y-3">
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            Image URL
            <input
              aria-label="Image URL"
              className={inputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEventPageBlock({
                  ...selectedBlock,
                  content: imageContentNode(change.currentTarget.value, imageAttrs.alt),
                })
              }
              value={imageAttrs.src}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            Image alt text
            <input
              aria-label="Image alt text"
              className={inputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEventPageBlock({
                  ...selectedBlock,
                  content: imageContentNode(imageAttrs.src, change.currentTarget.value),
                })
              }
              value={imageAttrs.alt}
            />
          </label>
        </div>
      );
    }

    if (selectedBlock.type === 'venue_map') {
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Map URL
          <input
            aria-label="Map URL"
            className={inputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEventPageBlock({
                ...selectedBlock,
                mapUrl: change.currentTarget.value || undefined,
              })
            }
            value={selectedBlock.mapUrl ?? ''}
          />
        </label>
      );
    }

    if (selectedBlock.type === 'button') {
      const variableKeys = mergeTagKeys(selectedBlock.url);
      return (
        <div className="space-y-2">
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            Button URL
            <input
              aria-label="Button URL"
              className={inputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEventPageBlock({ ...selectedBlock, url: change.currentTarget.value })
              }
              value={selectedBlock.url}
            />
          </label>
          {variableKeys.length > 0 && <VariablePreviewHint keys={variableKeys} />}
        </div>
      );
    }

    return <p className="text-xs text-muted-foreground">{blockSummary(selectedBlock)}</p>;
  })();
  const inspectorHeading: Record<InspectorPanelId, { eyebrow: string; title: string }> = {
    block: {
      eyebrow: selectedBlock ? `Page / ${selectedBlockLabel}` : 'Page',
      title: selectedBlockLabel,
    },
    page: { eyebrow: 'Page / Settings', title: heroHeadline(eventPageDocument) },
    code: { eyebrow: 'More / Code', title: 'Saved payload' },
    variables: { eyebrow: 'More / Variables', title: 'Merge tags' },
    history: { eyebrow: 'More / History', title: `${history.length} versions` },
    issues: { eyebrow: 'More / Review', title: 'Publish blockers' },
  };

  const moreActionsItems: DropdownMenuItemConfig[] = [
    {
      id: 'save',
      label: 'Save draft',
      icon: <Save className="size-4" />,
      onClick: () => void saveDraft(),
      disabled: Boolean(archivedReason) || autosave === 'saving',
      separatorAfter: true,
    },
    {
      id: 'preview',
      label: 'Open preview',
      icon: <Eye className="size-4" />,
      onClick: () => void previewSavedDraft(),
      disabled: Boolean(archivedReason) || autosave === 'saving',
    },
    {
      id: 'public',
      label: 'View public page',
      icon: <ExternalLink className="size-4" />,
      onClick: () => viewPublicPage(),
      disabled: Boolean(archivedReason),
    },
    {
      id: 'variables',
      label: 'Variables',
      icon: <Type className="size-4" />,
      onClick: () => openMenuInspectorPanel('variables'),
    },
    {
      id: 'history',
      label: 'Version history',
      icon: <Copy className="size-4" />,
      onClick: () => openMenuInspectorPanel('history'),
    },
    {
      id: 'details',
      label: 'Page details',
      icon: <ListChecks className="size-4" />,
      onClick: () => openMenuInspectorPanel('page'),
    },
    {
      id: 'json',
      label: 'View JSON',
      icon: <FileJson className="size-4" />,
      onClick: () => openMenuInspectorPanel('code'),
    },
    {
      id: 'review',
      label: 'Review blockers',
      icon: <Eye className="size-4" />,
      onClick: () => openMenuInspectorPanel('issues'),
      separatorAfter: true,
    },
    {
      id: 'duplicate',
      label: 'Duplicate page',
      icon: <Copy className="size-4" />,
      onClick: () => void duplicateDocument(),
      disabled: Boolean(archivedReason),
      separatorAfter: true,
    },
    {
      id: 'archive',
      label: 'Archive page',
      icon: <Archive className="size-4" />,
      onClick: () => void archiveDocument(),
      destructive: true,
    },
  ];

  return (
    <EditorChrome
      channel="event-page"
      testId="content-editor-shell"
      topBar={
        <EditorTopBar
          autosave={autosave}
          backHref={`/events/${event.id}`}
          channelLabel="Page"
          documentName={document.name}
          error={actionError}
          moreActions={moreActionsItems}
          notice={notice}
          onDocumentNameClick={() => openInspectorPanel('page')}
          onPublish={() => void publishDraft()}
          publishDisabled={Boolean(archivedReason)}
          status={document.status}
        />
      }
      leftRail={
        <EditorLeftRail
          insertsDisabled={!canEdit}
          mode={editorMode}
          onModeChange={(mode) => {
            setEditorMode(mode);
            if (mode === 'preview') void previewSavedDraft();
          }}
          inserts={
            <>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<Type className="size-4" />}
                label="Text"
              >
                <InsertPopoverItem label="Text" onClick={() => insertEventPageAction('text')} />
              </InsertPopoverButton>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<ImageIcon className="size-4" />}
                label="Image"
              >
                <InsertPopoverItem label="Image" onClick={() => insertEventPageAction('image')} />
              </InsertPopoverButton>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<Sparkles className="size-4" />}
                label="Content"
              >
                <InsertPopoverItem
                  icon={<Sparkles className="size-4" />}
                  label="Hero"
                  onClick={() => insertEventPageAction('hero')}
                />
                <InsertPopoverItem
                  icon={<Info className="size-4" />}
                  label="Event details"
                  onClick={() => insertEventPageAction('event_details')}
                />
                <InsertPopoverItem
                  icon={<ExternalLink className="size-4" />}
                  label="Button"
                  onClick={() => insertEventPageAction('button')}
                />
                <InsertPopoverItem
                  icon={<Minus className="size-4" />}
                  label="Divider"
                  onClick={() => insertEventPageAction('divider')}
                />
                <InsertPopoverItem
                  icon={<HelpCircle className="size-4" />}
                  label="FAQ"
                  onClick={() => insertEventPageAction('faq')}
                />
                <InsertPopoverItem
                  icon={<Share2 className="size-4" />}
                  label="Social links"
                  onClick={() => insertEventPageAction('social_links')}
                />
              </InsertPopoverButton>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<Ticket className="size-4" />}
                label="Commerce"
              >
                <InsertPopoverItem
                  icon={<Ticket className="size-4" />}
                  label="Tickets"
                  onClick={() => insertEventPageAction('tickets')}
                />
                <InsertPopoverItem
                  icon={<ShoppingBag className="size-4" />}
                  label="Products"
                  onClick={() => insertEventPageAction('products')}
                />
                <InsertPopoverItem
                  icon={<Repeat className="size-4" />}
                  label="Resale tickets"
                  onClick={() => insertEventPageAction('resale_tickets')}
                />
              </InsertPopoverButton>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<CalendarDays className="size-4" />}
                label="Event"
              >
                <InsertPopoverItem
                  icon={<CalendarDays className="size-4" />}
                  label="Schedule"
                  onClick={() => insertEventPageAction('schedule')}
                />
                <InsertPopoverItem
                  icon={<MapPin className="size-4" />}
                  label="Venue"
                  onClick={() => insertEventPageAction('venue')}
                />
                <InsertPopoverItem
                  icon={<LayoutTemplate className="size-4" />}
                  label="Sponsors"
                  onClick={() => insertEventPageAction('sponsors')}
                />
                <InsertPopoverItem
                  icon={<Mic className="size-4" />}
                  label="Speakers"
                  onClick={() => insertEventPageAction('speakers')}
                />
              </InsertPopoverButton>
              <InsertPopoverButton
                disabled={!canEdit}
                icon={<Code2 className="size-4" />}
                label="Advanced"
              >
                <InsertPopoverItem
                  icon={<Code2 className="size-4" />}
                  label="Custom embed"
                  onClick={() => insertEventPageAction('custom_embed')}
                />
                <InsertPopoverItem
                  icon={<Heading className="size-4" />}
                  label="Event header"
                  onClick={() => insertEventPageAction('event_header')}
                />
                <InsertPopoverItem
                  icon={<PanelBottom className="size-4" />}
                  label="Brand footer"
                  onClick={() => insertEventPageAction('brand_footer')}
                />
              </InsertPopoverButton>
            </>
          }
        />
      }
      canvas={
        <main
          aria-label="Event page editable document"
          className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30 lg:rounded-tl-3xl"
          data-testid="editor-canvas"
        >
          {previewUrl ? (
            <iframe
              ref={iframeRef}
              src={previewUrl}
              className="h-full w-full border-0"
              data-testid="editor-iframe"
              title="Event page editor canvas"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : previewError ? (
            <div className="flex h-full items-center justify-center p-8">
              <div className="max-w-md space-y-3 text-center">
                <p className="text-sm font-medium text-destructive">Editor canvas unavailable</p>
                <p className="text-xs text-muted-foreground">{previewError}</p>
                <button
                  className="rounded-md border px-3 py-2 text-xs transition-colors hover:bg-accent"
                  onClick={() => void load()}
                  type="button"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Preparing editor...</p>
            </div>
          )}
        </main>
      }
      inspector={
        inspectorCollapsed ? null : (
          <InspectorPanel
            eyebrow={inspectorHeading[inspectorPanelId].eyebrow}
            onClose={() => setInspectorCollapsed(true)}
            title={inspectorHeading[inspectorPanelId].title}
          >
            {inspectorPanelId !== 'block' && (
              <button
                className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => openInspectorPanel('block')}
                type="button"
              >
                <PanelLeftClose className="size-3 rotate-180" />
                Back to block
              </button>
            )}

            {inspectorPanelId === 'block' && (
              <div className="space-y-4">
                {selectedBlockControls}
                {draft.validation.issues.length > 0 && (
                  <button
                    className="w-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200"
                    onClick={() => openInspectorPanel('issues')}
                    type="button"
                  >
                    <span className="font-medium">
                      {draft.validation.issues.length} publish blocker
                      {draft.validation.issues.length === 1 ? '' : 's'}
                    </span>
                    <span className="mt-0.5 block opacity-80">Tap to review</span>
                  </button>
                )}
                <div className="space-y-2 border-t border-border pt-4">
                  {eventPageDocument.blocks.map((block) => (
                    <button
                      className={cn(
                        'w-full rounded-md border px-3 py-2 text-left text-xs transition-colors',
                        block.id === selectedBlockId
                          ? 'border-foreground/20 bg-accent text-accent-foreground'
                          : 'border-border text-foreground hover:bg-accent',
                      )}
                      key={block.id}
                      onClick={() => selectBlock(block.id)}
                      type="button"
                    >
                      <span className="block font-medium">{blockLabel(block)}</span>
                      <span className="mt-1 block truncate text-foreground/80">
                        {blockSummary(block)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {inspectorPanelId === 'page' && (
              <div className="space-y-4">
                <div className="space-y-3">
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Public path
                    <input
                      aria-label="Public path"
                      className={inputClassName}
                      disabled={!canEdit}
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            publicPath: change.currentTarget.value,
                          },
                        }))
                      }
                      value={eventPageDocument.settings.publicPath ?? ''}
                    />
                  </label>
                </div>

                <div className="space-y-3 border-t border-border pt-4">
                  <p className="text-xs font-semibold text-foreground">Discovery &amp; SEO</p>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    SEO title
                    <input
                      aria-label="SEO title"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="Defaults to hero headline"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              seoTitle: change.currentTarget.value || undefined,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.seoTitle ?? ''}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    SEO description
                    <input
                      aria-label="SEO description"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="Defaults to page summary"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              seoDescription: change.currentTarget.value || undefined,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.seoDescription ?? ''}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Summary
                    <input
                      aria-label="Page summary"
                      className={inputClassName}
                      disabled={!canEdit}
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              summary: change.currentTarget.value,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.summary}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Category
                    <input
                      aria-label="Discovery category"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="e.g. Music, Sports, Theater"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              category: change.currentTarget.value || undefined,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.category ?? ''}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Tags (comma-separated)
                    <input
                      aria-label="Discovery tags"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="e.g. summer, outdoor, family-friendly"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              tags: change.currentTarget.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean),
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.tags.join(', ')}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Cover image URL
                    <input
                      aria-label="Cover image URL"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="Defaults to hero image"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              coverImageUrl: change.currentTarget.value || undefined,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.coverImageUrl ?? ''}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Social image URL
                    <input
                      aria-label="Social share image URL"
                      className={inputClassName}
                      disabled={!canEdit}
                      placeholder="Defaults to cover image"
                      onChange={(change) =>
                        updateEventPageSettings((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            discovery: {
                              ...current.settings.discovery,
                              socialImageUrl: change.currentTarget.value || undefined,
                            },
                          },
                        }))
                      }
                      value={eventPageDocument.settings.discovery.socialImageUrl ?? ''}
                    />
                  </label>
                </div>

                <dl className="space-y-3 text-xs">
                  <div className="flex justify-between gap-4 border-b border-border pb-3">
                    <dt className="text-muted-foreground">CTA</dt>
                    <dd className="font-medium text-foreground">
                      {ticketCtaLabel(eventPageDocument)}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

            {inspectorPanelId === 'code' && (
              <pre className="max-h-[42rem] overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                {JSON.stringify(eventPageDocument, null, 2)}
              </pre>
            )}

            {inspectorPanelId === 'variables' && (
              <div className="grid gap-2">
                {eventPageVariableKeys.map((key) => {
                  const presentation = eventPageVariablePresentation(key);
                  return (
                    <div
                      aria-label={`Dynamic value ${presentation.label}`}
                      className="rounded-md border p-3 text-xs"
                      key={key}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-foreground">{presentation.label}</span>
                        <span
                          className={`tixkit-variable-kind-badge tixkit-variable-kind-badge--${presentation.kind} rounded-md border px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase`}
                        >
                          {presentation.kind}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-muted-foreground">{presentation.preview}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {inspectorPanelId === 'history' && (
              <ol className="space-y-2">
                {history.map((version) => (
                  <li className="rounded-md border p-3 text-xs" key={version.id}>
                    <div className="font-medium text-foreground">{version.label}</div>
                    <div className="mt-1 text-muted-foreground">
                      {formatDate(version.timestamp)}
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {inspectorPanelId === 'issues' && (
              <div className="space-y-3">
                {draft.validation.issues.length === 0 ? (
                  <p className="rounded-md border border-emerald-400/40 bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                    No publish blockers. The page is ready to publish.
                  </p>
                ) : (
                  (() => {
                    const groups: Record<string, typeof draft.validation.issues> = {};
                    for (const issue of draft.validation.issues) {
                      const groupKey = issue.code.replace(/_.+$/, '');
                      (groups[groupKey] ??= []).push(issue);
                    }
                    const groupLabels: Record<string, string> = {
                      unknown: 'Unknown variables',
                      unsafe: 'Unsafe content',
                      missing: 'Missing fields',
                      unsupported: 'Unsupported features',
                      missingHero: 'Required blocks',
                      missingTickets: 'Required blocks',
                      missingBlockId: 'Block integrity',
                      customEmbed: 'Custom embeds',
                    };
                    return (
                      <div className="space-y-3">
                        <p className="text-xs font-medium text-muted-foreground">
                          {draft.validation.issues.length} issue
                          {draft.validation.issues.length === 1 ? '' : 's'} must be resolved before
                          publishing.
                        </p>
                        {Object.entries(groups).map(([groupKey, groupIssues]) => (
                          <div key={groupKey} className="space-y-1.5">
                            <p className="text-xs font-semibold text-foreground">
                              {groupLabels[groupKey] ?? groupKey}
                              <span className="ml-1 text-muted-foreground">
                                ({groupIssues.length})
                              </span>
                            </p>
                            <ul className="space-y-1.5">
                              {groupIssues.map((issue, index) => (
                                <li
                                  className="rounded-md border border-red-300 bg-red-50 p-2.5 text-xs text-red-800 dark:border-red-800/70 dark:bg-red-950/40 dark:text-red-200"
                                  key={`${issue.code}-${issue.message}-${index}`}
                                >
                                  <strong>{issue.code}</strong>
                                  <p className="mt-0.5 opacity-80">{issue.message}</p>
                                  {issue.field && (
                                    <p className="mt-0.5 font-mono text-[0.65rem] opacity-60">
                                      {issue.field}
                                    </p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    );
                  })()
                )}
              </div>
            )}
          </InspectorPanel>
        )
      }
      reopenInspectorButton={
        inspectorCollapsed ? (
          <InspectorReopenButton onClick={() => setInspectorCollapsed(false)} />
        ) : undefined
      }
    >
      <MobileInsertButton disabled={!canEdit} onClick={() => setInsertDrawerOpen(true)} />
      {insertDrawerOpen && (
        <aside
          aria-label="Mobile insert content"
          className="fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-auto rounded-t-2xl border-t bg-background p-4 text-foreground shadow-2xl lg:hidden"
        >
          <div className="flex items-start justify-between gap-3 border-b pb-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Insert</p>
              <h2 className="mt-1 font-semibold">Add page content</h2>
            </div>
            <button
              aria-label="Close insert menu"
              className="inline-flex h-9 items-center justify-center rounded-md border px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => setInsertDrawerOpen(false)}
              type="button"
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>
          <div className="mt-4 grid gap-2">
            {eventPageInsertActions.map((action) => (
              <button
                className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                disabled={!canEdit}
                key={action.id}
                onClick={() => {
                  setInsertDrawerOpen(false);
                  insertEventPageAction(action.id);
                }}
                type="button"
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>
        </aside>
      )}
      {previewOpen && <PreviewDrawer onClose={() => setPreviewOpen(false)} preview={preview} />}
    </EditorChrome>
  );
}
