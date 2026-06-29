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

function previewFromRendered(document: SmsTemplateDocument, event: AdminEventDetail): ContentEditorPreview {
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
    },
    {
      id: 'sms-compliance',
      label: 'Compliance',
      summary: `${document.settings.category} · ${document.settings.consentCategory} · limit ${document.settings.segmentLimit} segments`,
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
    setNotice(undefined);
  }

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
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

    let loadedDocument = documentsResult.data.items.find(
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

    let loadedVersions = versionsResult.data.items;
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
    if (!document || !snapshot) return undefined;
    setAutosave('saving');
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: snapshot,
      renderedText: snapshot.editor.body,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to save SMS draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [result.data, ...current.filter((version) => version.id !== result.data.id)]);
    setAutosave('saved');
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !smsDocument) return;
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
      setError(resultMessage(result.error, 'Unable to preview SMS draft'));
      return;
    }
    setPreview(previewFromApiText(result.data.output.text, result.data.output.segments));
    setNotice('Preview rendered from the saved content version');
  }

  async function publishDraft() {
    if (!document || !smsDocument) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, smsDocument);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to publish SMS draft'));
      return;
    }
    setDocument(result.data.document);
    setDraft(result.data.version);
    setVersions((current) => [
      result.data.version,
      ...current.filter((version) => version.id !== result.data.version.id),
    ]);
    setNotice(`Published v${result.data.version.versionNumber}`);
    toast.success('SMS template published');
  }

  async function sendTest() {
    if (!document || !smsDocument) return;
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
      setError(resultMessage(result.error, 'Unable to capture SMS test send'));
      return;
    }
    setNotice(`Captured test send to ${result.data.testSend.recipient}`);
    toast.success('SMS test send captured');
  }

  async function archiveDocument() {
    if (!document) return;
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to archive SMS template'));
      return;
    }
    setDocument(result.data);
    setNotice('Archived SMS template');
    toast.success('SMS template archived');
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading SMS editor...</p>;
  }

  if (error || !event || !document || !draft || !smsDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">SMS template editor</h1>
        <p className="text-sm text-destructive">{error ?? 'SMS editor could not load.'}</p>
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
          <h1 className="truncate text-2xl font-bold tracking-tight">SMS template editor</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Persisted SMS composer for {event.title}
          </p>
        </div>
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      </div>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <label className="space-y-2 text-sm font-medium">
          SMS body
          <textarea
            className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm leading-6"
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
              onChange={(change) => setRecipient(change.currentTarget.value)}
              type="tel"
              value={recipient}
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
            <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2" onClick={() => void sendTest()} type="button">
              <Send className="size-4" />
              Send test
            </button>
          </div>
        </div>
      </section>

      <ContentEditorShell
        autosave={autosave}
        canvasBlocks={canvasBlocks(smsDocument)}
        channelLabel="SMS template"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        insertActions={smsInsertActions}
        preview={preview}
        versions={versionSummaries(versions)}
        onPreview={() => void previewSavedDraft()}
        onPublish={() => void publishDraft()}
        onArchive={() => void archiveDocument()}
        onTestSend={() => void sendTest()}
      />
    </div>
  );
}
