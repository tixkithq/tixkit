'use client';

import * as React from 'react';
import {
  Archive,
  Copy,
  ExternalLink,
  Eye,
  FileJson,
  ListChecks,
  Save,
} from 'lucide-react';
import {
  Puck,
  type Config,
  type Overrides,
  type Permissions,
  type Viewports,
} from '@puckeditor/core';
import { toast } from 'sonner';
import {
  PUCK_EVENT_PAGE_PROVIDER,
  createDefaultEventPageDocument,
  isSafeEventPageUrl,
  migrateLegacyEventPageDocumentToPuck,
  normalizeEventPageDocument,
  resolveEventPageDocumentV2Discovery,
  validateEventPageDocument,
  type CreateDefaultEventPageDocumentInput,
  type EventPageDocument,
  type EventPageLegacyDocument,
  type EventPagePuckComponentData,
  type EventPagePuckData,
  type EventPageSettings,
  type EventPageValidationResultV2,
} from '@tixkit/content-event-page';
import {
  EventPageRender,
  eventPagePuckConfig,
  eventPagePuckIframeConfig,
  type EventPagePuckCoreData,
} from '@tixkit/content-event-page-react/puck';
import {
  EditorChrome,
  EditorLeftRail,
  EditorTopBar,
  InspectorPanel,
  InspectorReopenButton,
  type DropdownMenuItemConfig,
  type EditorMode,
} from '@tixkit/content-editor-shell';
import {
  adminApi,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminEventDetail,
} from '@/lib/api';
import { usePermissions } from '@/context/permission-provider';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type InspectorPanelId = 'page' | 'versions' | 'issues' | 'json';

type EventPagePreview = {
  label: string;
  document: EventPageDocument;
  validation: EventPageValidationResultV2;
};

const eventPageViewports: Viewports = [
  { width: 390, height: 'auto', label: 'Mobile' },
  { width: 768, height: 'auto', label: 'Tablet' },
  { width: '100%', height: 'auto', label: 'Desktop' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function listItemsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) return value.items as T[];
  return Object.values(value).filter(
    (item): item is T => Boolean(item) && typeof item === 'object',
  );
}

function resultMessage(error: { message?: string } | undefined, defaultMessage: string) {
  return error?.message ?? defaultMessage;
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

function duplicateDocumentName(name: string): string {
  const suffix = ' Copy';
  return name.endsWith(suffix) ? name : `${name.slice(0, 160 - suffix.length)}${suffix}`;
}

function defaultDocumentInput(event: AdminEventDetail): CreateDefaultEventPageDocumentInput {
  const publicPath = event.slug ? `/e/${event.slug}` : `/e/${event.id}`;
  return {
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description ?? 'Hosted event page draft generated from event metadata.',
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    venue: event.venue ?? {
      name: event.venueName,
      city: event.city,
    },
    coverImageUrl: event.coverImageUrl ?? undefined,
    coverImageAlt: event.title,
    publicUrl: publicPath,
    locale: 'en',
  };
}

function createDefaultDocument(event: AdminEventDetail): EventPageDocument {
  return createDefaultEventPageDocument(defaultDocumentInput(event));
}

function coerceStoredEventPageDocument(
  value: unknown,
  event: AdminEventDetail,
): EventPageDocument | undefined {
  const normalized = normalizeEventPageDocument(value);
  if (normalized) return normalized;
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.blocks) && !isRecord(value.settings)) return undefined;
  return migrateLegacyEventPageDocumentToPuck(value as EventPageLegacyDocument, defaultDocumentInput(event));
}

function isPuckComponentData(value: unknown): value is EventPagePuckComponentData {
  return isRecord(value) && typeof value.type === 'string' && isRecord(value.props);
}

function coercePuckData(value: unknown, fallback: EventPagePuckData): EventPagePuckData {
  if (!isRecord(value) || !isRecord(value.root) || !Array.isArray(value.content)) return fallback;
  const rootProps = isRecord(value.root.props)
    ? (value.root.props as EventPagePuckData['root']['props'])
    : fallback.root.props;
  const zones =
    isRecord(value.zones)
      ? Object.fromEntries(
          Object.entries(value.zones).flatMap(([zoneName, zoneContent]) =>
            Array.isArray(zoneContent)
              ? [[zoneName, zoneContent.filter(isPuckComponentData)]]
              : [],
          ),
        )
      : undefined;
  return {
    root: { props: rootProps },
    content: value.content.filter(isPuckComponentData),
    ...(zones ? { zones } : {}),
  };
}

function firstHero(document: EventPageDocument) {
  return document.editor.data.content.find((block) => block.type === 'Hero');
}

function eventPageSubject(document: EventPageDocument, event: AdminEventDetail): string {
  const hero = firstHero(document);
  return (
    cleanString(document.settings.discovery.seoTitle) ??
    cleanString(document.editor.data.root.props.title) ??
    cleanString(hero?.props.headline) ??
    event.title
  );
}

function eventPagePreviewText(document: EventPageDocument, event: AdminEventDetail): string {
  const hero = firstHero(document);
  return (
    cleanString(document.settings.discovery.seoDescription) ??
    cleanString(document.settings.discovery.summary) ??
    cleanString(document.editor.data.root.props.description) ??
    cleanString(hero?.props.body) ??
    cleanString(event.description) ??
    `Details for ${event.title}.`
  );
}

function syncSettingsFromData(
  settings: EventPageSettings,
  data: EventPagePuckData,
  event: AdminEventDetail,
): EventPageSettings {
  const hero = data.content.find((block) => block.type === 'Hero');
  const summary =
    cleanString(hero?.props.body) ??
    cleanString(data.root.props.description) ??
    settings.discovery.summary;
  const title =
    cleanString(data.root.props.title) ??
    cleanString(hero?.props.headline) ??
    event.title;
  return {
    ...settings,
    discovery: {
      ...settings.discovery,
      summary,
      seoTitle: title,
      seoDescription: summary,
      coverImageUrl: cleanString(hero?.props.imageUrl) ?? settings.discovery.coverImageUrl,
      socialImageUrl: cleanString(hero?.props.imageUrl) ?? settings.discovery.socialImageUrl,
    },
  };
}

function withPuckData(
  document: EventPageDocument,
  data: unknown,
  event: AdminEventDetail,
): EventPageDocument {
  const puckData = coercePuckData(data, document.editor.data);
  return {
    ...document,
    editor: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      data: puckData,
    },
    settings: syncSettingsFromData(document.settings, puckData, event),
  };
}

function saveBodyForDocument(document: EventPageDocument, event: AdminEventDetail) {
  return {
    contentJson: document,
    subject: eventPageSubject(document, event),
    previewText: eventPagePreviewText(document, event),
  };
}

function versionSummaries(versions: AdminContentDocumentVersion[]) {
  return versions
    .slice()
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map((version) => ({
      id: version.id,
      label: `${version.status === 'published' ? 'Published' : 'Draft'} v${version.versionNumber}`,
      status: version.status,
      timestamp: version.publishedAt ?? version.createdAt,
      author: version.createdBy,
    }));
}

function formatDate(value?: string): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function publicPageUrl(document: EventPageDocument, event: AdminEventDetail): string | undefined {
  const path = cleanString(document.settings.publicPath) ?? (event.slug ? `/e/${event.slug}` : `/e/${event.id}`);
  if (!isSafeEventPageUrl(path)) return undefined;
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return undefined;
  }
}

function PuckIframeOverride({
  children,
  document: previewDocument,
}: {
  children: React.ReactNode;
  document?: Document | null;
}) {
  React.useEffect(() => {
    if (!previewDocument) return;

    previewDocument.title = 'Event page editor canvas';
    previewDocument.documentElement.setAttribute('lang', 'en');

    const frame = previewDocument.defaultView?.frameElement;
    frame?.setAttribute('title', 'Event page editor canvas');
    frame?.setAttribute('aria-label', 'Event page editor canvas');
  }, [previewDocument]);

  return (
    <main aria-label="Event page editor canvas" className="min-h-full" data-testid="puck-iframe-main">
      {children}
    </main>
  );
}

function puckOverrides(): Partial<Overrides<Config>> {
  return {
    header: ({ actions }: { actions: React.ReactNode }) => (
      <div className="border-b bg-background px-3 py-2">
        <div className="flex items-center justify-end gap-2">{actions}</div>
      </div>
    ),
    headerActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    fields: ({ children, isLoading }: { children: React.ReactNode; isLoading: boolean }) => (
      <div className="h-full overflow-y-auto border-l bg-background p-4">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading fields...</p> : children}
      </div>
    ),
    drawer: ({ children }: { children: React.ReactNode }) => (
      <div className="h-full overflow-y-auto border-r bg-background p-3">{children}</div>
    ),
    iframe: PuckIframeOverride,
    preview: ({ children }: { children: React.ReactNode }) => (
      <div className="min-h-full bg-zinc-100 p-4 dark:bg-zinc-950">
        <div className="mx-auto min-h-[48rem] w-full max-w-4xl bg-background shadow-sm">
          {children}
        </div>
      </div>
    ),
  };
}

function PreviewDrawer({ onClose, preview }: { onClose: () => void; preview: EventPagePreview }) {
  const [tab, setTab] = React.useState<'rendered' | 'issues' | 'json'>('rendered');
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
            {preview.validation.valid ? 'Valid Puck document' : 'Publish blockers'}
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
        {(['rendered', 'issues', 'json'] as const).map((item) => (
          <button
            aria-pressed={tab === item}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              tab === item
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            key={item}
            onClick={() => setTab(item)}
            type="button"
          >
            {item === 'rendered' ? 'Rendered' : item === 'issues' ? 'Issues' : 'JSON'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === 'rendered' && (
          <div data-testid="preview-surface">
            <EventPageRender document={preview.document} />
          </div>
        )}
        {tab === 'issues' && (
          <div className="space-y-3 text-sm">
            {preview.validation.issues.length === 0 ? (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-700">
                No Puck document blockers.
              </p>
            ) : (
              preview.validation.issues.map((issue) => (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
                  key={`${issue.code}:${issue.field ?? ''}`}
                >
                  {issue.message}
                </p>
              ))
            )}
          </div>
        )}
        {tab === 'json' && (
          <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
            {JSON.stringify(preview.document, null, 2)}
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
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [inspectorPanelId, setInspectorPanelId] = React.useState<InspectorPanelId>('page');
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [preview, setPreview] = React.useState<EventPagePreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const { can } = usePermissions();
  const isArchived = document?.status === 'archived';
  const canEdit = !isArchived && can('events.write');
  const overrides = React.useMemo(() => puckOverrides(), []);

  function nextOperationId() {
    operationIdRef.current += 1;
    return operationIdRef.current;
  }

  function isCurrentOperation(operationId: number) {
    return operationIdRef.current === operationId;
  }

  function markDraftDirty() {
    if (isArchived) return;
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
      setError(resultMessage(documentsResult.error, 'Unable to load event page content documents'));
      setLoading(false);
      return;
    }

    const documents = listItemsFromResponse<AdminContentDocument>(documentsResult.data);
    let loadedDocument = documents.find(
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
        setError(resultMessage(createResult.error, 'Unable to create event page content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load event page versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = createDefaultDocument(loadedEvent);
      const saveResult = await adminApi.saveContentVersion(
        loadedDocument.id,
        saveBodyForDocument(initialDocument, loadedEvent),
      );
      if (!saveResult.ok) {
        setError(resultMessage(saveResult.error, 'Unable to create the initial event page draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = coerceStoredEventPageDocument(loadedDraft.contentJson, loadedEvent);
    if (!normalized) {
      setError('Saved event page draft is not a schemaVersion 2 Puck document.');
      setLoading(false);
      return;
    }

    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setEventPageDocument(normalized);
    setPreview({
      label: 'Current Puck draft',
      document: normalized,
      validation: validateEventPageDocument(normalized),
    });
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const result = await adminApi.saveContentVersion(
      document.id,
      saveBodyForDocument(snapshot, event),
    );
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save event page draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setPreview({
      label: `Saved draft v${result.data.versionNumber}`,
      document: snapshot,
      validation: validateEventPageDocument(snapshot),
    });
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return { version: result.data, document: snapshot };
  }

  async function previewSavedDraft() {
    if (!eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const snapshot = eventPageDocument;
    const saved = await saveDraft(operationId, snapshot);
    if (!saved || !isCurrentOperation(operationId)) return;
    setPreview({
      label: `Saved draft v${saved.version.versionNumber}`,
      document: saved.document,
      validation: validateEventPageDocument(saved.document),
    });
    setPreviewOpen(true);
    setActionError(undefined);
    setNotice('Preview opened from the saved Puck document');
  }

  async function publishDraft(snapshot = eventPageDocument) {
    if (!document || !snapshot || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, snapshot);
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
    if (!window.confirm('Archive this event page? Editing, publishing, and previews will be disabled.')) {
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

  function viewPublicPage() {
    if (!event || !eventPageDocument || isArchived) return;
    const url = publicPageUrl(eventPageDocument, event);
    if (!url) {
      setActionError('Public page URL is not available. Set a safe public path first.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    setActionError(undefined);
    setNotice('Opened public page');
  }

  function updateSettings(updater: (settings: EventPageSettings) => EventPageSettings) {
    if (!eventPageDocument || isArchived) return;
    setEventPageDocument({
      ...eventPageDocument,
      settings: updater(eventPageDocument.settings),
    });
    markDraftDirty();
  }

  function setCurrentPuckData(data: unknown) {
    if (!event || !eventPageDocument || isArchived) return;
    const nextDocument = withPuckData(eventPageDocument, data, event);
    setEventPageDocument(nextDocument);
    setPreview({
      label: 'Current Puck draft',
      document: nextDocument,
      validation: validateEventPageDocument(nextDocument),
    });
    markDraftDirty();
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading Puck event-page editor...
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
  const localValidation = validateEventPageDocument(eventPageDocument);
  const history = versionSummaries(versions);
  const publishDisabled = Boolean(archivedReason) || autosave === 'saving' || !localValidation.valid;
  const permissions: Partial<Permissions> = {
    delete: canEdit,
    drag: canEdit,
    duplicate: canEdit,
    edit: canEdit,
    insert: canEdit,
  };
  const discovery = resolveEventPageDocumentV2Discovery(eventPageDocument, {
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: event.timezone,
      venueName: event.venueName ?? event.venue?.name,
      publicUrl: event.slug ? `/e/${event.slug}` : `/e/${event.id}`,
    },
  });

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
      id: 'details',
      label: 'Page details',
      icon: <ListChecks className="size-4" />,
      onClick: () => {
        setInspectorPanelId('page');
        setInspectorCollapsed(false);
      },
    },
    {
      id: 'history',
      label: 'Version history',
      icon: <Copy className="size-4" />,
      onClick: () => {
        setInspectorPanelId('versions');
        setInspectorCollapsed(false);
      },
    },
    {
      id: 'json',
      label: 'View JSON',
      icon: <FileJson className="size-4" />,
      onClick: () => {
        setInspectorPanelId('json');
        setInspectorCollapsed(false);
      },
    },
    {
      id: 'review',
      label: 'Review blockers',
      icon: <Eye className="size-4" />,
      onClick: () => {
        setInspectorPanelId('issues');
        setInspectorCollapsed(false);
      },
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

  const inspectorHeading: Record<InspectorPanelId, { eyebrow: string; title: string }> = {
    page: { eyebrow: 'Page / Settings', title: discovery.title },
    versions: { eyebrow: 'More / History', title: `${history.length} versions` },
    issues: { eyebrow: 'More / Review', title: 'Publish blockers' },
    json: { eyebrow: 'More / Code', title: 'Puck document' },
  };

  const inspector = (
    <InspectorPanel
      eyebrow={inspectorHeading[inspectorPanelId].eyebrow}
      onClose={() => setInspectorCollapsed(true)}
      title={inspectorHeading[inspectorPanelId].title}
    >
      {inspectorPanelId === 'page' && (
        <div className="space-y-4 text-sm">
          <label className="block space-y-1.5 font-medium">
            Public path
            <input
              aria-label="Public path"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={!canEdit}
              onChange={(change) =>
                updateSettings((settings) => ({ ...settings, publicPath: change.currentTarget.value }))
              }
              value={eventPageDocument.settings.publicPath ?? ''}
            />
          </label>
          <label className="block space-y-1.5 font-medium">
            SEO title
            <input
              aria-label="SEO title"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={!canEdit}
              onChange={(change) =>
                updateSettings((settings) => ({
                  ...settings,
                  discovery: { ...settings.discovery, seoTitle: change.currentTarget.value },
                }))
              }
              value={eventPageDocument.settings.discovery.seoTitle ?? ''}
            />
          </label>
          <label className="block space-y-1.5 font-medium">
            Summary
            <textarea
              aria-label="Summary"
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
              disabled={!canEdit}
              onChange={(change) =>
                updateSettings((settings) => ({
                  ...settings,
                  discovery: {
                    ...settings.discovery,
                    summary: change.currentTarget.value,
                    seoDescription: change.currentTarget.value,
                  },
                }))
              }
              value={eventPageDocument.settings.discovery.summary}
            />
          </label>
          <dl className="grid gap-2 rounded-md border bg-muted/20 p-3 text-xs">
            <div>
              <dt className="font-medium text-muted-foreground">Provider</dt>
              <dd>{eventPageDocument.editor.provider}</dd>
            </div>
            <div>
              <dt className="font-medium text-muted-foreground">Content blocks</dt>
              <dd>{eventPageDocument.editor.data.content.length}</dd>
            </div>
          </dl>
        </div>
      )}
      {inspectorPanelId === 'versions' && (
        <ol className="space-y-2 text-sm">
          {history.map((item) => (
            <li className="rounded-md border p-3" key={item.id}>
              <p className="font-medium">{item.label}</p>
              <p className="text-xs text-muted-foreground">{formatDate(item.timestamp)}</p>
            </li>
          ))}
        </ol>
      )}
      {inspectorPanelId === 'issues' && (
        <div className="space-y-3 text-sm">
          {localValidation.issues.length === 0 ? (
            <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-700">
              No local Puck blockers.
            </p>
          ) : (
            localValidation.issues.map((issue) => (
              <p
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
                key={`${issue.code}:${issue.field ?? ''}`}
              >
                {issue.message}
              </p>
            ))
          )}
        </div>
      )}
      {inspectorPanelId === 'json' && (
        <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-5">
          {JSON.stringify(eventPageDocument, null, 2)}
        </pre>
      )}
    </InspectorPanel>
  );

  const canvas = (
    <main
      aria-label="Event page editable document"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30 lg:rounded-tl-3xl"
      data-testid="editor-canvas"
    >
      {editorMode === 'editor' && (
        <Puck
          config={eventPagePuckConfig}
          data={eventPageDocument.editor.data as EventPagePuckCoreData}
          iframe={eventPagePuckIframeConfig}
          onChange={(data) => setCurrentPuckData(data)}
          onPublish={(data) => {
            if (!eventPageDocument || !event) return;
            const nextDocument = withPuckData(eventPageDocument, data, event);
            setEventPageDocument(nextDocument);
            void publishDraft(nextDocument);
          }}
          overrides={overrides}
          permissions={permissions}
          viewports={eventPageViewports}
        >
          <div className="grid h-full min-h-[calc(100svh-60px)] grid-cols-[18rem_minmax(0,1fr)_20rem]">
            <Puck.Components />
            <Puck.Preview />
            <Puck.Fields />
          </div>
        </Puck>
      )}
      {editorMode === 'preview' && (
        <div className="h-full overflow-auto bg-zinc-100 p-5 dark:bg-zinc-950">
          <div className="mx-auto max-w-4xl bg-background shadow-sm" data-testid="preview-surface">
            <EventPageRender document={eventPageDocument} />
          </div>
        </div>
      )}
      {editorMode === 'code' && (
        <div className="h-full overflow-auto p-5">
          <pre className="rounded-md border bg-background p-4 text-xs leading-5">
            {JSON.stringify(eventPageDocument, null, 2)}
          </pre>
        </div>
      )}
    </main>
  );

  return (
    <>
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
            onDocumentNameClick={() => {
              setInspectorPanelId('page');
              setInspectorCollapsed(false);
            }}
            onPublish={() => void publishDraft()}
            publishDisabled={publishDisabled}
            status={document.status}
          />
        }
        leftRail={
          <EditorLeftRail
            hiddenModes={{}}
            inserts={<span className="sr-only">Puck components are available in the canvas.</span>}
            mode={editorMode}
            onModeChange={(mode: EditorMode) => {
              setEditorMode(mode);
              if (mode === 'preview') void previewSavedDraft();
            }}
          />
        }
        canvas={canvas}
        inspector={inspectorCollapsed ? null : inspector}
        reopenInspectorButton={
          inspectorCollapsed ? (
            <InspectorReopenButton onClick={() => setInspectorCollapsed(false)} />
          ) : undefined
        }
      />
      {previewOpen && preview && (
        <PreviewDrawer onClose={() => setPreviewOpen(false)} preview={preview} />
      )}
      {archivedReason && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm">
          {archivedReason}
        </div>
      )}
    </>
  );
}
