'use client';

import * as React from 'react';
import { Eye, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import {
  REACT_EMAIL_EDITOR_PACKAGE,
  createDefaultEmailTemplate,
  normalizeEmailTemplateDocument,
  renderEmailTemplate,
  type EmailTemplateDocument,
  type RenderedEmailTemplate,
} from '@tixkit/content-email';
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

const emailInsertActions: ContentEditorInsertAction[] = [
  { id: 'variable', label: 'Variable', icon: 'variable' },
  { id: 'button', label: 'Button', icon: 'link' },
  { id: 'image', label: 'Image', icon: 'image' },
  { id: 'ticket', label: 'Ticket', icon: 'ticket' },
];

function sampleContext(event: AdminEventDetail): Record<string, unknown> {
  return {
    event: {
      title: event.title,
      startsAt: event.startsAt,
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
    },
    brand: {
      name: 'Tixkit',
      supportUrl: 'https://help.example.test/preferences',
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    },
    ticket: {
      type: 'General Admission',
    },
    order: {
      total: '$35.00',
    },
  };
}

function defaultEmailDocument(event?: AdminEventDetail): EmailTemplateDocument {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml:
        '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p>',
    },
    settings: {
      templateKey: 'order-confirmed',
      subject: event ? `Your ${event.title} tickets are ready` : 'Your {{event.title}} tickets are ready',
      previewText: 'Everything you need before arrival.',
      locale: 'en',
      category: 'transactional',
      sender: {
        fromEmail: 'tickets@example.test',
        fromName: '{{brand.name}}',
        replyToEmail: 'support@example.test',
      },
    },
    blocks: [
      {
        type: 'event_hero',
        headline: '{{event.title}}',
        body: 'Hi {{recipient.name}}, your order is confirmed.',
        ctaLabel: 'View tickets',
        ctaUrl: '{{event.checkoutUrl}}',
      },
      {
        type: 'ticket_summary',
        title: 'Ticket summary',
        body: '{{ticket.type}} - {{order.total}}',
      },
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
  });
}

async function previewFromRendered(
  document: EmailTemplateDocument,
  event: AdminEventDetail,
): Promise<ContentEditorPreview> {
  const rendered = await renderEmailTemplate(document, sampleContext(event));
  return previewFromEmailOutput('React Email preview', rendered);
}

function previewFromEmailOutput(
  label: string,
  output: Pick<RenderedEmailTemplate, 'subject' | 'html' | 'text'> | AdminContentRenderOutput,
): ContentEditorPreview {
  const text = output.text?.trim();
  const html = output.html?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: `Subject: ${output.subject ?? ''}\n\n${text || html || ''}`,
  };
}

function primaryBody(document: EmailTemplateDocument): string {
  const hero = document.blocks.find((block) => block.type === 'event_hero');
  return hero?.type === 'event_hero' ? hero.body ?? '' : document.editor.contentHtml;
}

function updatePrimaryBody(document: EmailTemplateDocument, body: string): EmailTemplateDocument {
  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml: `<h1>{{event.title}}</h1><p>${escapeHtml(body)}</p>`,
    },
    blocks: document.blocks.map((block) =>
      block.type === 'event_hero' ? { ...block, body } : block,
    ),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function canvasBlocks(document: EmailTemplateDocument): ContentEditorCanvasBlock[] {
  return [
    {
      id: 'email-subject',
      label: 'Subject',
      summary: document.settings.subject,
    },
    {
      id: 'email-body',
      label: 'Email body',
      summary: primaryBody(document),
    },
    {
      id: 'email-sender',
      label: 'Sender',
      summary: `${document.settings.sender.fromName ?? 'No sender name'} <${document.settings.sender.fromEmail ?? 'missing'}>`,
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

export function EmailPersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [emailDocument, setEmailDocument] = React.useState<EmailTemplateDocument>();
  const [recipient, setRecipient] = React.useState('ada@example.test');
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
      setError('Event is missing organization or brand scope for persisted email content.');
      setLoading(false);
      return;
    }

    const documentsResult = await adminApi.listContentDocuments({
      channel: 'email',
      brandId: loadedEvent.brandId,
      eventId: loadedEvent.id,
      limit: 20,
    });
    if (!documentsResult.ok) {
      setError(resultMessage(documentsResult.error, 'Unable to load email content documents'));
      setLoading(false);
      return;
    }

    let loadedDocument = documentsResult.data.items.find(
      (item) => item.channel === 'email' && item.eventId === loadedEvent.id,
    );
    if (!loadedDocument) {
      const createResult = await adminApi.createContentDocument({
        organizationId: loadedEvent.organizationId,
        brandId: loadedEvent.brandId,
        eventId: loadedEvent.id,
        channel: 'email',
        key: 'order-confirmed',
        name: `${loadedEvent.title} email template`,
        locale: 'en',
      });
      if (!createResult.ok) {
        setError(resultMessage(createResult.error, 'Unable to create email content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load email versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = versionsResult.data.items;
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = defaultEmailDocument(loadedEvent);
      const initialPreview = await renderEmailTemplate(initialDocument, sampleContext(loadedEvent));
      const saveResult = await adminApi.saveContentVersion(loadedDocument.id, {
        contentJson: initialDocument,
        subject: initialDocument.settings.subject,
        previewText: initialDocument.settings.previewText,
        renderedHtml: initialDocument.editor.contentHtml,
        renderedText: initialPreview.text,
      });
      if (!saveResult.ok) {
        setError(resultMessage(saveResult.error, 'Unable to create the initial email draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = normalizeEmailTemplateDocument(loadedDraft.contentJson);
    if (!normalized) {
      setError('Saved email draft is not canonical Tixkit React Email template JSON.');
      setLoading(false);
      return;
    }

    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setEmailDocument(normalized);
    setPreview(await previewFromRendered(normalized, loadedEvent));
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft(operationId = nextOperationId(), snapshot = emailDocument) {
    if (!document || !event || !snapshot) return undefined;
    setAutosave('saving');
    const rendered = await renderEmailTemplate(snapshot, sampleContext(event));
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: snapshot,
      subject: snapshot.settings.subject,
      previewText: snapshot.settings.previewText,
      renderedHtml: snapshot.editor.contentHtml,
      renderedText: rendered.text,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to save email draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [result.data, ...current.filter((version) => version.id !== result.data.id)]);
    setPreview(previewFromEmailOutput('React Email preview', rendered));
    setAutosave('saved');
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !emailDocument) return;
    const operationId = nextOperationId();
    const snapshot = emailDocument;
    const saved = await saveDraft(operationId, snapshot);
    if (!saved) return;
    const result = await adminApi.previewContent(document.id, {
      versionId: saved.id,
      contentJson: snapshot,
      subject: snapshot.settings.subject,
      previewText: snapshot.settings.previewText,
      context: sampleContext(event),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to preview email draft'));
      return;
    }
    setPreview(previewFromEmailOutput('Saved email preview', result.data.output));
    setNotice('Preview rendered from the saved content version');
  }

  async function publishDraft() {
    if (!document || !emailDocument) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, emailDocument);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to publish email draft'));
      return;
    }
    setDocument(result.data.document);
    setDraft(result.data.version);
    setVersions((current) => [
      result.data.version,
      ...current.filter((version) => version.id !== result.data.version.id),
    ]);
    setNotice(`Published v${result.data.version.versionNumber}`);
    toast.success('Email template published');
  }

  async function sendTest() {
    if (!document || !emailDocument) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, emailDocument);
    if (!saved) return;
    const result = await adminApi.testSendContent(document.id, {
      versionId: saved.id,
      recipient,
      context: event ? sampleContext(event) : undefined,
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to capture email test send'));
      return;
    }
    setNotice(`Captured test send to ${result.data.testSend.recipient}`);
    toast.success('Email test send captured');
  }

  async function archiveDocument() {
    if (!document) return;
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setError(resultMessage(result.error, 'Unable to archive email template'));
      return;
    }
    setDocument(result.data);
    setNotice('Archived email template');
    toast.success('Email template archived');
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading email editor...</p>;
  }

  if (error || !event || !document || !draft || !emailDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Email template editor</h1>
        <p className="text-sm text-destructive">{error ?? 'Email editor could not load.'}</p>
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
          <h1 className="truncate text-2xl font-bold tracking-tight">Email template editor</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Persisted React Email composer for {event.title}
          </p>
        </div>
        {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      </div>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-3">
          <label className="space-y-2 text-sm font-medium">
            Subject
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(change) => {
                setEmailDocument({
                  ...emailDocument,
                  settings: { ...emailDocument.settings, subject: change.currentTarget.value },
                });
                markDraftDirty();
              }}
              value={emailDocument.settings.subject}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Preview text
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              onChange={(change) => {
                setEmailDocument({
                  ...emailDocument,
                  settings: { ...emailDocument.settings, previewText: change.currentTarget.value },
                });
                markDraftDirty();
              }}
              value={emailDocument.settings.previewText ?? ''}
            />
          </label>
          <label className="space-y-2 text-sm font-medium">
            Email body
            <textarea
              className="min-h-32 w-full rounded-md border bg-background px-3 py-2 text-sm leading-6"
              onChange={(change) => {
                setEmailDocument(updatePrimaryBody(emailDocument, change.currentTarget.value));
                markDraftDirty();
              }}
              value={primaryBody(emailDocument)}
            />
          </label>
        </div>
        <div className="space-y-3 text-sm">
          <label className="block space-y-2 font-medium">
            From email
            <input
              className="w-full rounded-md border bg-background px-3 py-2"
              onChange={(change) => {
                setEmailDocument({
                  ...emailDocument,
                  settings: {
                    ...emailDocument.settings,
                    sender: { ...emailDocument.settings.sender, fromEmail: change.currentTarget.value },
                  },
                });
                markDraftDirty();
              }}
              type="email"
              value={emailDocument.settings.sender.fromEmail ?? ''}
            />
          </label>
          <label className="block space-y-2 font-medium">
            Reply-to email
            <input
              className="w-full rounded-md border bg-background px-3 py-2"
              onChange={(change) => {
                setEmailDocument({
                  ...emailDocument,
                  settings: {
                    ...emailDocument.settings,
                    sender: { ...emailDocument.settings.sender, replyToEmail: change.currentTarget.value },
                  },
                });
                markDraftDirty();
              }}
              type="email"
              value={emailDocument.settings.sender.replyToEmail ?? ''}
            />
          </label>
          <label className="block space-y-2 font-medium">
            Test recipient
            <input
              className="w-full rounded-md border bg-background px-3 py-2"
              onChange={(change) => setRecipient(change.currentTarget.value)}
              type="email"
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
        canvasBlocks={canvasBlocks(emailDocument)}
        channelLabel="Email template"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        insertActions={emailInsertActions}
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
