'use client';

import * as React from 'react';
import { Eye, Save } from 'lucide-react';
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

function previewFromRendered(document: EventPageDocument, event: AdminEventDetail): ContentEditorPreview {
  const rendered = renderEventPageDocument(document, sampleContext(event));
  return {
    label: 'TipTap event-page preview',
    format: 'html',
    output: rendered.text || rendered.html,
  };
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

function heroBody(document: EventPageDocument): string {
  const block = heroBlock(document);
  return block?.type === 'hero' ? block.body ?? '' : document.settings.discovery.summary;
}

function ticketCtaLabel(document: EventPageDocument): string {
  const block = ticketsBlock(document);
  return block?.type === 'tickets'
    ? block.ctaLabel ?? document.settings.ticketCtaLabel
    : document.settings.ticketCtaLabel;
}

function updateHero(document: EventPageDocument, update: Partial<Extract<EventPageBlock, { type: 'hero' }>>): EventPageDocument {
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

function canvasBlocks(document: EventPageDocument): ContentEditorCanvasBlock[] {
  return document.blocks.map((block) => ({
    id: block.id,
    label: blockLabel(block),
    summary: blockSummary(block),
  }));
}

function blockLabel(block: EventPageBlock): string {
  switch (block.type) {
    case 'hero':
      return 'Hero';
    case 'rich_text':
      return 'Rich text';
    case 'event_details':
      return 'Event details';
    case 'venue_map':
      return 'Venue';
    case 'social_links':
      return 'Social links';
    case 'custom_embed':
      return 'Custom embed';
    default:
      return block.type.charAt(0).toUpperCase() + block.type.slice(1).replaceAll('_', ' ');
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

function resultMessage(error: { message?: string } | undefined, fallback: string) {
  return error?.message ?? fallback;
}

export function EventPagePersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [eventPageDocument, setEventPageDocument] = React.useState<EventPageDocument>();
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

    let loadedDocument = documentsResult.data.items.find(
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

    let loadedVersions = versionsResult.data.items;
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

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot) return undefined;
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
    setVersions((current) => [result.data, ...current.filter((version) => version.id !== result.data.id)]);
    setPreview({ label: 'TipTap event-page preview', format: 'html', output: rendered.text || rendered.html });
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !eventPageDocument) return;
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

  async function publishDraft() {
    if (!document || !eventPageDocument) return;
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

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading event-page editor...</p>;
  }

  if (error || !event || !document || !draft || !eventPageDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Event-page editor</h1>
        <p className="text-sm text-destructive">{error ?? 'Event-page editor could not load.'}</p>
        <button className="rounded-md border px-3 py-2 text-sm" onClick={() => void load()} type="button">
          Retry
        </button>
      </section>
    );
  }

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

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-3">
          <label className="space-y-2 text-sm font-medium">
            Page headline
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(change) => {
                setEventPageDocument(updateHero(eventPageDocument, { headline: change.currentTarget.value }));
                markDraftDirty();
              }}
              value={heroHeadline(eventPageDocument)}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Page summary
            <textarea
              className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm leading-6"
              onChange={(change) => {
                setEventPageDocument(updateSummary(eventPageDocument, change.currentTarget.value));
                markDraftDirty();
              }}
              value={heroBody(eventPageDocument)}
            />
          </label>
        </div>
        <div className="space-y-3 text-sm">
          <label className="block space-y-2 font-medium">
            Ticket CTA label
            <input
              className="w-full rounded-md border bg-background px-3 py-2"
              onChange={(change) => {
                setEventPageDocument(updateTicketCta(eventPageDocument, change.currentTarget.value));
                markDraftDirty();
              }}
              value={ticketCtaLabel(eventPageDocument)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2" onClick={() => void saveDraft()} type="button">
              <Save className="size-4" />
              Save draft
            </button>
            <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2" onClick={() => void previewSavedDraft()} type="button">
              <Eye className="size-4" />
              Preview
            </button>
          </div>
        </div>
      </section>

      <ContentEditorShell
        autosave={autosave}
        canvasBlocks={canvasBlocks(eventPageDocument)}
        channelLabel="Event page"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        insertActions={eventPageInsertActions}
        preview={preview}
        testSendUnavailableReason="Hosted pages use preview and public routes instead of test sends."
        versions={versionSummaries(versions)}
        onPreview={() => void previewSavedDraft()}
        onPublish={() => void publishDraft()}
        onArchive={() => void archiveDocument()}
      />
    </div>
  );
}
