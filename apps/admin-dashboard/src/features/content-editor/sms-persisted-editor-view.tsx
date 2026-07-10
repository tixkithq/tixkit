'use client';

import * as React from 'react';
import { Eye, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  createDefaultSmsTemplate,
  normalizeSmsTemplateDocument,
  renderSmsTemplate,
  type SmsTemplateDocument,
} from '@tixkit/content-message';
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
  type AdminEventDetail,
} from '@/lib/api';
import { usePermissions } from '@/context/permission-provider';

const smsInsertActions: ContentEditorInsertAction[] = [
  { id: 'variable', label: 'Variable', icon: 'variable' },
  { id: 'link', label: 'Link', icon: 'link' },
  { id: 'opt-out', label: 'Opt-out', icon: 'shield' },
];

function sampleContext(event: AdminEventDetail): Record<string, unknown> {
  return {
    event: {
      title: event.title,
      startsAt: event.startsAt,
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
    },
    recipient: {
      name: 'Ada Lovelace',
      phone: '+15550000001',
    },
  };
}

function defaultSmsDocument(): SmsTemplateDocument {
  return createDefaultSmsTemplate({
    editor: {
      body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}. Tickets: {{event.checkoutUrl}}',
    },
    settings: {
      templateKey: 'event-update',
      locale: 'en',
      category: 'bulk',
      consentCategory: 'marketing',
      segmentLimit: 3,
      estimatedCostPerSegmentCents: 2,
      optOutText: 'Reply STOP to opt out',
    },
    shortLinks: [],
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

function previewFromRendered(
  document: SmsTemplateDocument,
  event: AdminEventDetail,
): ContentEditorPreview {
  const rendered = renderSmsTemplate(document, sampleContext(event));
  return {
    label: 'SMS preview',
    format: 'text',
    output: `${rendered.text}\n\nSegments: ${rendered.segments} (${rendered.encoding})\nEstimated cost: ${rendered.estimatedCostCents} cents`,
  };
}

function previewFromApiText(text: string | undefined, segments: unknown): ContentEditorPreview {
  const segmentText = typeof segments === 'number' ? `\n\nSegments: ${segments}` : '';
  return {
    label: 'Saved SMS preview',
    format: 'text',
    output: `${text ?? ''}${segmentText}`,
  };
}

function canvasBlocks(document: SmsTemplateDocument): ContentEditorCanvasBlock[] {
  return [
    {
      id: 'sms-body',
      label: 'SMS body',
      summary: document.editor.body,
      content: (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
          {document.editor.body}
        </p>
      ),
    },
    {
      id: 'sms-compliance',
      label: 'Compliance',
      summary: `${document.settings.category} · ${document.settings.consentCategory} · limit ${document.settings.segmentLimit} segments`,
      content: (
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">Category</dt>
            <dd className="mt-1 font-medium">{document.settings.category}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">Consent</dt>
            <dd className="mt-1 font-medium">{document.settings.consentCategory}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-muted-foreground">Segment limit</dt>
            <dd className="mt-1 font-medium">{document.settings.segmentLimit}</dd>
          </div>
        </dl>
      ),
    },
  ];
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

function duplicateDocumentName(name: string): string {
  return name.endsWith(' Copy') ? `${name} 2` : `${name} Copy`;
}

function appendSmsToken(body: string, token: string): string {
  if (!body.trim()) return token;
  const separator = body.endsWith(' ') || body.endsWith('\n') ? '' : ' ';
  return `${body}${separator}${token}`;
}

export function SmsPersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [smsDocument, setSmsDocument] = React.useState<SmsTemplateDocument>();
  const [recipient, setRecipient] = React.useState('+15550000001');
  const [preview, setPreview] = React.useState<ContentEditorPreview>();
  const [autosave, setAutosave] = React.useState<ContentEditorAutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const isArchived = document?.status === 'archived';
  const { can } = usePermissions();
  const canEdit = !isArchived && can('messages.write');
  const archivedReason = isArchived ? 'Archived templates are read-only.' : undefined;

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
      setError('Event is missing organization or brand scope for persisted SMS content.');
      setLoading(false);
      return;
    }

    const documentsResult = await adminApi.listContentDocuments({
      channel: 'sms',
      brandId: loadedEvent.brandId,
      eventId: loadedEvent.id,
      limit: 20,
    });
    if (!documentsResult.ok) {
      setError(resultMessage(documentsResult.error, 'Unable to load SMS content documents'));
      setLoading(false);
      return;
    }

    const documents = listItemsFromResponse<AdminContentDocument>(documentsResult.data);
    let loadedDocument = documents.find(
      (item) => item.channel === 'sms' && item.eventId === loadedEvent.id,
    );
    if (!loadedDocument) {
      const createResult = await adminApi.createContentDocument({
        organizationId: loadedEvent.organizationId,
        brandId: loadedEvent.brandId,
        eventId: loadedEvent.id,
        channel: 'sms',
        key: 'event-update',
        name: `${loadedEvent.title} SMS updates`,
        locale: 'en',
      });
      if (!createResult.ok) {
        setError(resultMessage(createResult.error, 'Unable to create SMS content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load SMS versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = defaultSmsDocument();
      const saveResult = await adminApi.saveContentVersion(loadedDocument.id, {
        contentJson: initialDocument,
        renderedText: initialDocument.editor.body,
      });
      if (!saveResult.ok) {
        setError(resultMessage(saveResult.error, 'Unable to create the initial SMS draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = normalizeSmsTemplateDocument(loadedDraft.contentJson);
    if (!normalized) {
      setError('Saved SMS draft is not canonical Tixkit SMS template JSON.');
      setLoading(false);
      return;
    }

    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setSmsDocument(normalized);
    setPreview(previewFromRendered(normalized, loadedEvent));
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft(operationId = nextOperationId(), snapshot = smsDocument) {
    if (!document || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: snapshot,
      renderedText: snapshot.editor.body,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save SMS draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !smsDocument || isArchived) return;
    const operationId = nextOperationId();
    const snapshot = smsDocument;
    const saved = await saveDraft(operationId, snapshot);
    if (!saved) return;
    const result = await adminApi.previewContent(document.id, {
      versionId: saved.id,
      contentJson: snapshot,
      renderedText: snapshot.editor.body,
      context: sampleContext(event),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to preview SMS draft'));
      return;
    }
    setPreview(previewFromApiText(result.data.output.text, result.data.output.segments));
    setActionError(undefined);
    setNotice('Preview rendered from the saved content version');
  }

  async function publishDraft() {
    if (!document || !smsDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, smsDocument);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to publish SMS draft'));
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
    toast.success('SMS template published');
  }

  async function sendTest() {
    if (!document || !smsDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, smsDocument);
    if (!saved) return;
    const result = await adminApi.testSendContent(document.id, {
      versionId: saved.id,
      recipient,
      context: event ? sampleContext(event) : undefined,
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to capture SMS test send'));
      return;
    }
    setActionError(undefined);
    setNotice(`Captured test send to ${result.data.testSend.recipient}`);
    toast.success('SMS test send captured');
  }

  async function archiveDocument() {
    if (!document) return;
    if (
      !window.confirm(
        'Archive this SMS template? Editing, publishing, previews, and test sends will be disabled.',
      )
    ) {
      return;
    }
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to archive SMS template'));
      return;
    }
    setDocument(result.data);
    setActionError(undefined);
    setNotice('Archived SMS template');
    toast.success('SMS template archived');
  }

  async function duplicateDocument() {
    if (!document || !smsDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, smsDocument);
    if (!saved) return;
    const result = await adminApi.duplicateContentDocument(document.id, {
      name: duplicateDocumentName(document.name),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to duplicate SMS template'));
      return;
    }
    setActionError(undefined);
    setNotice(`Duplicated SMS template as ${result.data.name}`);
    toast.success('SMS template duplicated');
  }

  function insertSmsAction(actionId: string) {
    if (!smsDocument || isArchived) return;
    const token =
      actionId === 'variable'
        ? '{{recipient.name}}'
        : actionId === 'link'
          ? '{{event.checkoutUrl}}'
          : (smsDocument.settings.optOutText ?? 'Reply STOP to opt out');
    setSmsDocument({
      ...smsDocument,
      editor: {
        ...smsDocument.editor,
        body: appendSmsToken(smsDocument.editor.body, token),
      },
    });
    markDraftDirty();
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading SMS editor...</p>;
  }

  if (error || !event || !document || !draft || !smsDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">SMS template editor</h1>
        <p className="text-sm text-destructive">{error ?? 'SMS editor could not load.'}</p>
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

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-bold tracking-tight">SMS template editor</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Persisted SMS composer for {event.title}
          </p>
        </div>
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      </header>
      {actionError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <section aria-label="SMS draft controls" className="grid gap-3 lg:grid-cols-[1fr_18rem]">
        <label className="space-y-2 text-sm font-medium">
          SMS body
          <textarea
            className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm leading-6"
            disabled={!canEdit}
            onChange={(change) => {
              setSmsDocument({
                ...smsDocument,
                editor: { ...smsDocument.editor, body: change.currentTarget.value },
              });
              markDraftDirty();
            }}
            value={smsDocument.editor.body}
          />
        </label>
        <div className="space-y-3 text-sm">
          <label className="block space-y-2 font-medium">
            Test recipient
            <input
              className="w-full rounded-md border bg-background px-3 py-2"
              disabled={!canEdit}
              onChange={(change) => setRecipient(change.currentTarget.value)}
              type="tel"
              value={recipient}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2"
              disabled={!canEdit}
              onClick={() => void saveDraft()}
              type="button"
            >
              <Save className="size-4" />
              Save draft
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2"
              disabled={!canEdit}
              onClick={() => void previewSavedDraft()}
              type="button"
            >
              <Eye className="size-4" />
              Preview
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2"
              disabled={!canEdit}
              onClick={() => void sendTest()}
              type="button"
            >
              <Send className="size-4" />
              Send test
            </button>
          </div>
        </div>
      </section>

      <ContentEditorShell
        actionsUnavailableReason={archivedReason}
        autosave={autosave}
        canvasBlocks={canvasBlocks(smsDocument)}
        channelLabel="SMS template"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        insertActions={smsInsertActions}
        preview={preview}
        testSendUnavailableReason={archivedReason}
        versions={versionSummaries(versions)}
        onInsertAction={insertSmsAction}
        onPreview={() => void previewSavedDraft()}
        onPublish={() => void publishDraft()}
        onDuplicate={() => void duplicateDocument()}
        onArchive={() => void archiveDocument()}
        onTestSend={() => void sendTest()}
      />
    </div>
  );
}
