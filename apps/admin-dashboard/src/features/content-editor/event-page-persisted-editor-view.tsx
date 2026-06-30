'use client';

import * as React from 'react';
import { ExternalLink, Eye, Save } from 'lucide-react';
import { toast } from 'sonner';
import {
  createDefaultEventPageDocument,
  normalizeEventPageDocument,
  renderEventPageDocument,
  type EventPageBlock,
  type EventPageDocument,
} from '@tixkit/content-event-page';
import {
  ContentEditorShell,
  type ContentEditorAutosaveState,
  type ContentEditorCanvasBlock,
  type ContentEditorInspectorPanel,
  type ContentEditorInsertAction,
  type ContentEditorPreview,
  type ContentEditorVersionSummary,
} from '@tixkit/content-editor-shell';
import type { ContentDocument, ContentDocumentVersion } from '@tixkit/content-core';
import {
  adminApi,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminContentRenderOutput,
  type AdminEventDetail,
} from '@/lib/api';

const eventPageInsertActions: ContentEditorInsertAction[] = [
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'image', label: 'Image', icon: 'image' },
  { id: 'tickets', label: 'Tickets', icon: 'ticket' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar' },
  { id: 'venue', label: 'Venue', icon: 'map' },
  { id: 'button', label: 'Button', icon: 'link' },
];

const compactInputClassName =
  'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm shadow-sm';
const actionButtonClassName =
  'inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

function EditablePlainText({
  className,
  disabled,
  label,
  multiline = false,
  onChange,
  onFocus,
  value,
}: {
  className: string;
  disabled: boolean;
  label: string;
  multiline?: boolean;
  onChange: (value: string) => void;
  onFocus?: () => void;
  value: string;
}) {
  const controlClassName = `${className} w-full rounded-sm border-0 bg-transparent p-0 shadow-none outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-70`;

  if (multiline) {
    return (
      <textarea
        aria-label={label}
        className={`${controlClassName} resize-none overflow-hidden`}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={onFocus}
        rows={3}
        value={value}
      />
    );
  }

  return (
    <input
      aria-label={label}
      className={controlClassName}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={onFocus}
      value={value}
    />
  );
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

function sampleContext(event: AdminEventDetail): Record<string, unknown> {
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

function previewFromRendered(
  document: EventPageDocument,
  event: AdminEventDetail,
): ContentEditorPreview {
  const rendered = renderEventPageDocument(document, sampleContext(event));
  return {
    label: 'TipTap event-page preview',
    format: 'html',
    output: rendered.text || rendered.html,
  };
}

function publicPageUrl(document: EventPageDocument, event: AdminEventDetail): string | undefined {
  const rendered = renderEventPageDocument(document, sampleContext(event));
  const publicPath = rendered.discovery.publicPath;
  return publicPath && publicPath !== '#' ? publicPath : undefined;
}

function previewFromApiOutput(output: AdminContentRenderOutput): ContentEditorPreview {
  return {
    label: 'Saved event-page preview',
    format: output.html ? 'html' : 'text',
    output: output.text ?? output.html ?? '',
  };
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

function updateHero(
  document: EventPageDocument,
  update: Partial<Extract<EventPageBlock, { type: 'hero' }>>,
): EventPageDocument {
  return {
    ...document,
    blocks: document.blocks.map((block) =>
      block.type === 'hero' ? { ...block, ...update } : block,
    ),
  };
}

function updateSummary(document: EventPageDocument, summary: string): EventPageDocument {
  return {
    ...updateHero(document, { body: summary }),
    settings: {
      ...document.settings,
      discovery: {
        ...document.settings.discovery,
        summary,
        seoDescription: summary,
      },
    },
  };
}

function updateTicketCta(document: EventPageDocument, label: string): EventPageDocument {
  return {
    ...document,
    settings: { ...document.settings, ticketCtaLabel: label },
    blocks: document.blocks.map((block) =>
      block.type === 'tickets' ? { ...block, ctaLabel: label } : block,
    ),
  };
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

function textContentNode(text: string) {
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

function imageContentNode(src: string, alt: string) {
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
  actionId: string,
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
  }
}

function blockSummary(block: EventPageBlock): string {
  switch (block.type) {
    case 'hero':
      return block.body ? `${block.headline} - ${block.body}` : block.headline;
    case 'event_details':
      return `${block.items.length} details`;
    case 'tickets':
      return block.body ?? block.title;
    case 'schedule':
      return `${block.items.length} schedule items`;
    case 'venue_map':
      return block.address ? `${block.venueName} - ${block.address}` : block.venueName;
    case 'faq':
      return `${block.items.length} questions`;
    case 'products':
      return `${block.productIds.length} products`;
    case 'sponsors':
    case 'speakers':
      return `${block.items.length} entries`;
    case 'button':
      return block.label;
    case 'social_links':
      return `${block.links.length} links`;
    case 'custom_embed':
      return block.allowUnsafeEmbed ? 'Reviewed custom embed' : 'Embed blocked until reviewed';
    case 'divider':
      return 'Divider';
    case 'rich_text':
      return 'Structured TipTap content';
  }
}

function versionSummaries(versions: AdminContentDocumentVersion[]): ContentEditorVersionSummary[] {
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

function toShellDocument(document: AdminContentDocument): ContentDocument {
  return document as ContentDocument;
}

function toShellVersion(version: AdminContentDocumentVersion): ContentDocumentVersion {
  return version as ContentDocumentVersion;
}

function resultMessage(error: { message?: string } | undefined, defaultMessage: string) {
  return error?.message ?? defaultMessage;
}

function duplicateDocumentName(name: string): string {
  const suffix = ' Copy';
  return name.endsWith(suffix) ? name : `${name.slice(0, 160 - suffix.length)}${suffix}`;
}

function unreachableEventPageBlock(block: never): never {
  throw new Error(`Unhandled event-page block: ${JSON.stringify(block)}`);
}

export function EventPagePersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [eventPageDocument, setEventPageDocument] = React.useState<EventPageDocument>();
  const [selectedBlockId, setSelectedBlockId] = React.useState('event-page-block-0');
  const [inspectorPanelId, setInspectorPanelId] = React.useState('block');
  const [preview, setPreview] = React.useState<ContentEditorPreview>();
  const [autosave, setAutosave] = React.useState<ContentEditorAutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);

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

    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setEventPageDocument(normalized);
    setPreview(previewFromRendered(normalized, loadedEvent));
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const isArchived = document?.status === 'archived';

  function updateEventPageDocument(nextDocument: EventPageDocument) {
    if (isArchived) return;
    setEventPageDocument(nextDocument);
    markDraftDirty();
  }

  function selectBlock(blockId: string) {
    setSelectedBlockId(blockId);
    setInspectorPanelId('block');
  }

  function insertEventPageAction(actionId: string) {
    if (!event || !eventPageDocument || isArchived) return;
    const inserted = createInsertedBlock(actionId, eventPageDocument, event);
    if (!inserted) return;
    updateEventPageDocument({
      ...eventPageDocument,
      blocks: [...eventPageDocument.blocks, inserted],
    });
    setSelectedBlockId(`event-page-block-${eventPageDocument.blocks.length}`);
  }

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const rendered = renderEventPageDocument(snapshot, sampleContext(event));
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: snapshot,
      subject: heroHeadline(snapshot),
      previewText: snapshot.settings.discovery.summary,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save event-page draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setPreview({
      label: 'TipTap event-page preview',
      format: 'html',
      output: rendered.text || rendered.html,
    });
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const snapshot = eventPageDocument;
    const saved = await saveDraft(operationId, snapshot);
    if (!saved) return;
    const result = await adminApi.previewContent(document.id, {
      versionId: saved.id,
      contentJson: snapshot,
      subject: heroHeadline(snapshot),
      previewText: snapshot.settings.discovery.summary,
      context: sampleContext(event),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to preview event-page draft'));
      return;
    }
    setPreview(previewFromApiOutput(result.data.output));
    setActionError(undefined);
    setNotice('Preview rendered from the saved content version');
  }

  function viewPublicPage() {
    if (!event || !eventPageDocument || isArchived) return;
    const url = publicPageUrl(eventPageDocument, event);
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
    const result = await adminApi.publishContentVersion(document.id, saved.id);
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
    return <p className="text-sm text-muted-foreground">Loading event-page editor...</p>;
  }

  if (error || !event || !document || !draft || !eventPageDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Event-page editor</h1>
        <p className="text-sm text-destructive">{error ?? 'Event-page editor could not load.'}</p>
        <button
          className="rounded-md border px-3 py-2 text-sm"
          onClick={() => void load()}
          type="button"
        >
          Retry
        </button>
      </section>
    );
  }

  const selectedBlockIndex = eventPageDocument.blocks.findIndex(
    (_block, index) => `event-page-block-${index}` === selectedBlockId,
  );
  const selectedBlock =
    selectedBlockIndex >= 0
      ? eventPageDocument.blocks[selectedBlockIndex]
      : eventPageDocument.blocks[0];
  const selectedBlockLabel = selectedBlock ? blockLabel(selectedBlock) : 'Content';
  const canEdit = !isArchived;
  const archivedReason = isArchived ? 'Archived pages are read-only.' : undefined;
  const canvasHeader = (
    <div className="space-y-3" data-testid="event-page-metadata-bar">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem]">
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Public path
          <input
            aria-label="Public path"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEventPageDocument({
                ...eventPageDocument,
                settings: { ...eventPageDocument.settings, publicPath: change.currentTarget.value },
              });
            }}
            value={eventPageDocument.settings.publicPath ?? ''}
          />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Locale
          <input
            aria-label="Locale"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEventPageDocument({
                ...eventPageDocument,
                settings: { ...eventPageDocument.settings, locale: change.currentTarget.value },
              });
            }}
            value={eventPageDocument.settings.locale}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={actionButtonClassName}
          disabled={!canEdit}
          onClick={() => void saveDraft()}
          type="button"
        >
          <Save className="size-4" />
          Save draft
        </button>
        <button
          className={actionButtonClassName}
          disabled={!canEdit}
          onClick={() => void previewSavedDraft()}
          type="button"
        >
          <Eye className="size-4" />
          Preview
        </button>
        <button
          className={actionButtonClassName}
          disabled={!canEdit}
          onClick={viewPublicPage}
          type="button"
        >
          <ExternalLink className="size-4" />
          View public page
        </button>
      </div>
    </div>
  );
  const directCanvasBlocks: ContentEditorCanvasBlock[] = eventPageDocument.blocks.map(
    (block, index) => {
      const id = `event-page-block-${index}`;
      const selected = id === selectedBlockId;
      const summary = blockSummary(block);
      const updateBlock = (nextBlock: EventPageBlock) => {
        updateEventPageDocument({
          ...eventPageDocument,
          blocks: eventPageDocument.blocks.map((item, itemIndex) =>
            itemIndex === index ? nextBlock : item,
          ),
        });
      };

      if (block.type === 'hero') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-5">
              <EditablePlainText
                className="max-w-3xl text-4xl font-bold leading-tight text-foreground"
                disabled={!canEdit}
                label="Page headline"
                onChange={(value) =>
                  updateEventPageDocument(updateHero(eventPageDocument, { headline: value }))
                }
                onFocus={() => selectBlock(id)}
                value={block.headline}
              />
              <EditablePlainText
                className="max-w-2xl whitespace-pre-wrap text-base leading-7 text-muted-foreground"
                disabled={!canEdit}
                label="Page summary"
                multiline
                onChange={(value) =>
                  updateEventPageDocument(updateSummary(eventPageDocument, value))
                }
                onFocus={() => selectBlock(id)}
                value={block.body ?? ''}
              />
              <div className="space-y-2">
                <div className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm">
                  <EditablePlainText
                    className="min-w-20 text-primary-foreground"
                    disabled={!canEdit}
                    label="Hero CTA label"
                    onChange={(value) => updateBlock({ ...block, ctaLabel: value })}
                    onFocus={() => selectBlock(id)}
                    value={block.ctaLabel ?? ''}
                  />
                </div>
              </div>
            </div>
          ),
        };
      }

      if (block.type === 'tickets') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-3">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Ticket block title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="inline-flex min-h-10 items-center rounded-md border bg-background px-4 py-2 text-sm font-semibold shadow-sm">
                <EditablePlainText
                  className="min-w-24 text-foreground"
                  disabled={!canEdit}
                  label="Ticket CTA label"
                  onChange={(value) =>
                    updateEventPageDocument(updateTicketCta(eventPageDocument, value))
                  }
                  onFocus={() => selectBlock(id)}
                  value={ticketCtaLabel(eventPageDocument)}
                />
              </div>
            </div>
          ),
        };
      }

      if (block.type === 'rich_text') {
        const imageAttrs = tipTapImageAttrs(block);
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-3">
              {imageAttrs ? (
                <>
                  {imageAttrs.src ? (
                    <img
                      alt={imageAttrs.alt}
                      className="max-h-80 w-full rounded-md object-cover"
                      src={imageAttrs.src}
                    />
                  ) : (
                    <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed bg-muted/30 text-sm font-medium text-muted-foreground">
                      Add an image URL
                    </div>
                  )}
                </>
              ) : (
                <EditablePlainText
                  className="whitespace-pre-wrap text-base leading-7 text-foreground"
                  disabled={!canEdit}
                  label="Rich text content"
                  multiline
                  onChange={(value) => updateBlock({ ...block, content: textContentNode(value) })}
                  onFocus={() => selectBlock(id)}
                  value={tipTapText(block)}
                />
              )}
            </div>
          ),
        };
      }

      if (block.type === 'event_details') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Event details title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <dl className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
                {block.items.map((item, itemIndex) => (
                  <div className="border-t pt-3" key={`${item.label}-${itemIndex}`}>
                    <dt className="font-medium text-muted-foreground">{item.label}</dt>
                    <dd className="mt-1 text-foreground">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ),
        };
      }

      if (block.type === 'schedule') {
        const firstItem = block.items[0] ?? {
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timezone: event.timezone,
          venueName: event.venueName ?? event.venue?.name,
        };
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Schedule title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_13rem]">
                <EditablePlainText
                  className="text-base font-medium text-foreground"
                  disabled={!canEdit}
                  label="Schedule item title"
                  onChange={(value) =>
                    updateBlock({
                      ...block,
                      items: [{ ...firstItem, title: value }, ...block.items.slice(1)],
                    })
                  }
                  onFocus={() => selectBlock(id)}
                  value={firstItem.title}
                />
                <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                  Starts
                  <input
                    aria-label="Schedule start time"
                    className={compactInputClassName}
                    disabled={!canEdit}
                    onChange={(change) =>
                      updateBlock({
                        ...block,
                        items: [
                          { ...firstItem, startsAt: change.currentTarget.value },
                          ...block.items.slice(1),
                        ],
                      })
                    }
                    onFocus={() => selectBlock(id)}
                    value={firstItem.startsAt}
                  />
                </label>
              </div>
            </section>
          ),
        };
      }

      if (block.type === 'venue_map') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Venue title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="grid gap-3 md:grid-cols-2">
                <EditablePlainText
                  className="text-base font-medium text-foreground"
                  disabled={!canEdit}
                  label="Venue name"
                  onChange={(value) => updateBlock({ ...block, venueName: value })}
                  onFocus={() => selectBlock(id)}
                  value={block.venueName}
                />
                <EditablePlainText
                  className="text-sm text-muted-foreground"
                  disabled={!canEdit}
                  label="Venue address"
                  onChange={(value) => updateBlock({ ...block, address: value })}
                  onFocus={() => selectBlock(id)}
                  value={block.address ?? ''}
                />
              </div>
            </section>
          ),
        };
      }

      if (block.type === 'faq') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="FAQ title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="divide-y">
                {block.items.map((item, itemIndex) => (
                  <div className="space-y-1 py-3" key={`${item.question}-${itemIndex}`}>
                    <p className="font-medium text-foreground">{item.question}</p>
                    <p className="text-sm text-muted-foreground">{item.answer}</p>
                  </div>
                ))}
              </div>
            </section>
          ),
        };
      }

      if (block.type === 'products') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-3">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Products title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <EditablePlainText
                className="whitespace-pre-wrap text-base leading-7 text-muted-foreground"
                disabled={!canEdit}
                label="Products body"
                multiline
                onChange={(value) => updateBlock({ ...block, body: value })}
                onFocus={() => selectBlock(id)}
                value={block.body ?? ''}
              />
              <p className="text-sm font-medium text-foreground">
                {block.productIds.length} linked products
              </p>
            </section>
          ),
        };
      }

      if (block.type === 'sponsors') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Sponsors title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-medium text-foreground">
                {block.items.map((item, itemIndex) =>
                  item.url ? (
                    <a
                      className="text-primary underline-offset-4 hover:underline"
                      href={item.url}
                      key={`${item.name}-${itemIndex}`}
                    >
                      {item.name}
                    </a>
                  ) : (
                    <span key={`${item.name}-${itemIndex}`}>{item.name}</span>
                  ),
                )}
              </div>
            </section>
          ),
        };
      }

      if (block.type === 'speakers') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <section className="space-y-4">
              <EditablePlainText
                className="text-2xl font-semibold text-foreground"
                disabled={!canEdit}
                label="Speakers title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="divide-y">
                {block.items.map((item, itemIndex) => (
                  <div className="py-3" key={`${item.name}-${itemIndex}`}>
                    <p className="font-medium text-foreground">{item.name}</p>
                    {item.role && <p className="text-sm text-muted-foreground">{item.role}</p>}
                    {item.bio && (
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.bio}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ),
        };
      }

      if (block.type === 'button') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm">
              <EditablePlainText
                className="min-w-20 text-primary-foreground"
                disabled={!canEdit}
                label="Button label"
                onChange={(value) => updateBlock({ ...block, label: value })}
                onFocus={() => selectBlock(id)}
                value={block.label}
              />
            </div>
          ),
        };
      }

      if (block.type === 'divider') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: <hr className="border-border" />,
        };
      }

      if (block.type === 'social_links') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <nav aria-label="Event page social links" className="space-y-3">
              {block.title && (
                <h2 className="text-2xl font-semibold text-foreground">{block.title}</h2>
              )}
              <div className="flex flex-wrap gap-3 text-sm">
                {block.links.map((link, linkIndex) => (
                  <a
                    className="font-medium text-primary underline-offset-4 hover:underline"
                    href={link.url}
                    key={`${link.label}-${linkIndex}`}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            </nav>
          ),
        };
      }

      if (block.type === 'custom_embed') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <EditablePlainText
              className="font-mono text-xs leading-5 text-muted-foreground"
              disabled={!canEdit}
              label="Custom embed HTML"
              multiline
              onChange={(value) => updateBlock({ ...block, html: value })}
              onFocus={() => selectBlock(id)}
              value={block.html}
            />
          ),
        };
      }

      return unreachableEventPageBlock(block);
    },
  );
  const updateSelectedEventPageBlock = (nextBlock: EventPageBlock) => {
    if (selectedBlockIndex < 0) return;
    updateEventPageDocument({
      ...eventPageDocument,
      blocks: eventPageDocument.blocks.map((item, itemIndex) =>
        itemIndex === selectedBlockIndex ? nextBlock : item,
      ),
    });
  };
  const selectedBlockControls = (() => {
    if (!selectedBlock) {
      return <p className="text-xs text-muted-foreground">Select content in the canvas.</p>;
    }

    if (selectedBlock.type === 'hero') {
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Hero CTA URL
          <input
            aria-label="Hero CTA URL"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEventPageBlock({ ...selectedBlock, ctaUrl: change.currentTarget.value })
            }
            value={selectedBlock.ctaUrl ?? ''}
          />
        </label>
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
              className={compactInputClassName}
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
              className={compactInputClassName}
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
            className={compactInputClassName}
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
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Button URL
          <input
            aria-label="Button URL"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEventPageBlock({ ...selectedBlock, url: change.currentTarget.value })
            }
            value={selectedBlock.url}
          />
        </label>
      );
    }

    return <p className="text-xs text-muted-foreground">{blockSummary(selectedBlock)}</p>;
  })();
  const panelIds = ['block', 'page', 'body', 'theme', 'code', 'variables', 'history', 'issues'];
  const panelLabels: Record<string, string> = {
    block: 'Content',
    page: 'Page',
    body: 'Body',
    theme: 'Theme',
    code: 'Code',
    variables: 'Variables',
    history: 'History',
    issues: 'Issues',
  };
  const inspectorNav = (
    <div className="grid grid-cols-2 gap-1" aria-label="Event page inspector modes">
      {panelIds.map((id) => (
        <button
          aria-pressed={inspectorPanelId === id}
          className={`rounded-md px-2 py-1.5 text-xs font-medium ${
            inspectorPanelId === id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent'
          }`}
          key={id}
          onClick={() => setInspectorPanelId(id)}
          type="button"
        >
          {panelLabels[id]}
        </button>
      ))}
    </div>
  );
  const inspectorPanels: ContentEditorInspectorPanel[] = [
    {
      id: 'block',
      label: 'Content',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Selected {selectedBlockLabel}</h2>
          {selectedBlockControls}
        </section>
      ),
    },
    {
      id: 'page',
      label: 'Page',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Page metadata</h2>
          <dl className="space-y-2">
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">Title</dt>
              <dd className="truncate font-medium">{heroHeadline(eventPageDocument)}</dd>
            </div>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">CTA</dt>
              <dd className="truncate font-medium">{eventPageDocument.settings.ticketCtaLabel}</dd>
            </div>
          </dl>
        </section>
      ),
    },
    {
      id: 'body',
      label: 'Body',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Body</h2>
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            Hosted event pages use full-width responsive sections with checkout-first content
            density.
          </p>
        </section>
      ),
    },
    {
      id: 'theme',
      label: 'Theme',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Theme</h2>
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            Locale {eventPageDocument.settings.locale}; public path{' '}
            {eventPageDocument.settings.publicPath ?? 'default'}.
          </p>
        </section>
      ),
    },
    {
      id: 'code',
      label: 'Code',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Editor JSON</h2>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
            {JSON.stringify(eventPageDocument, null, 2)}
          </pre>
        </section>
      ),
    },
    {
      id: 'variables',
      label: 'Variables',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Variables</h2>
          <div className="grid gap-2">
            {['event.title', 'event.startsAt', 'event.venueName', 'event.checkoutUrl'].map(
              (key) => (
                <code
                  className="rounded-md border px-2 py-1.5 text-xs"
                  key={key}
                >{`{{${key}}}`}</code>
              ),
            )}
          </div>
        </section>
      ),
    },
    {
      id: 'history',
      label: 'History',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">History</h2>
          <ol className="space-y-2">
            {versionSummaries(versions).map((version) => (
              <li className="rounded-md border p-2 text-xs" key={version.id}>
                <div className="font-medium">{version.label}</div>
                <div className="text-muted-foreground">{version.status}</div>
              </li>
            ))}
          </ol>
        </section>
      ),
    },
    {
      id: 'issues',
      label: 'Issues',
      content: (
        <section className="space-y-3 text-sm">
          {inspectorNav}
          <h2 className="text-sm font-semibold">Issues</h2>
          {draft.validation.issues.length === 0 ? (
            <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800">
              No publish blockers.
            </p>
          ) : (
            <ul className="space-y-2">
              {draft.validation.issues.map((issue) => (
                <li
                  className="rounded-md border p-2 text-xs"
                  key={`${issue.code}-${issue.message}`}
                >
                  <strong>{issue.code}</strong>
                  <p>{issue.message}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">Event-page editor</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Persisted hosted page composer for {event.title}
          </p>
        </div>
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      </div>
      {actionError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <ContentEditorShell
        actionsUnavailableReason={archivedReason}
        autosave={autosave}
        canvasBlocks={directCanvasBlocks}
        canvasHeader={canvasHeader}
        channelLabel="Event page"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        activeInspectorPanelId={inspectorPanelId}
        inspectorPanels={inspectorPanels}
        insertActions={eventPageInsertActions}
        preview={preview}
        showInspectorPanelTabs={false}
        testSendUnavailableReason="Hosted pages use preview and public routes instead of test sends."
        versions={versionSummaries(versions)}
        onInsertAction={insertEventPageAction}
        onInspectorPanelChange={setInspectorPanelId}
        onPreview={() => void previewSavedDraft()}
        onPublish={() => void publishDraft()}
        onDuplicate={() => void duplicateDocument()}
        onArchive={() => void archiveDocument()}
      />
    </div>
  );
}
