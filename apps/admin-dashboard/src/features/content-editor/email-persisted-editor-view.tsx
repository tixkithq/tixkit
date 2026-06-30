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

const emailInsertActions: ContentEditorInsertAction[] = [
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'image', label: 'Image', icon: 'image' },
  { id: 'components', label: 'Components', icon: 'ticket' },
  { id: 'variables', label: 'Variables', icon: 'variable' },
];

const inputClassName = 'w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm';
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
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
      publicUrl: `https://events.example.test/e/${event.id}`,
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
      qrCodeUrl: 'https://tickets.example.test/qr/preview.png',
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
      contentHtml: '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p>',
    },
    settings: {
      templateKey: 'order-confirmed',
      subject: event
        ? `Your ${event.title} tickets are ready`
        : 'Your {{event.title}} tickets are ready',
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

function updateEmailBlock(
  document: EmailTemplateDocument,
  blockIndex: number,
  update: EmailTemplateDocument['blocks'][number],
): EmailTemplateDocument {
  return syncEmailEditorHtml({
    ...document,
    blocks: document.blocks.map((block, index) => (index === blockIndex ? update : block)),
  });
}

function appendToken(value: string | undefined, token: string): string {
  const current = value?.trim() ?? '';
  if (!current) return token;
  if (current.includes(token)) return current;
  return `${current} ${token}`;
}

function appendVariableToBlock(
  block: EmailTemplateDocument['blocks'][number],
  token: string,
): EmailTemplateDocument['blocks'][number] {
  switch (block.type) {
    case 'event_hero':
      return { ...block, body: appendToken(block.body, token) };
    case 'ticket_summary':
      return { ...block, body: appendToken(block.body, token) };
    case 'unsubscribe_footer':
      return { ...block, body: appendToken(block.body, token) };
    case 'order_summary': {
      if (block.rows.length === 0) {
        return { ...block, rows: [{ label: 'Note', value: token }] };
      }
      return {
        ...block,
        rows: block.rows.map((row, index) =>
          index === block.rows.length - 1 ? { ...row, value: appendToken(row.value, token) } : row,
        ),
      };
    }
    case 'qr_code':
      return { ...block, title: appendToken(block.title, token) };
    case 'calendar_button':
      return { ...block, label: appendToken(block.label, token) };
    case 'venue_block':
      return { ...block, address: appendToken(block.address, token) };
    case 'social_links':
      if (block.links.length === 0) {
        return { ...block, links: [{ label: token, url: '{{brand.supportUrl}}' }] };
      }
      return {
        ...block,
        links: block.links.map((link, index) =>
          index === block.links.length - 1
            ? { ...link, label: appendToken(link.label, token) }
            : link,
        ),
      };
    case 'raw_html':
      return { ...block, html: appendToken(block.html, token) };
  }
}

function syncEmailEditorHtml(document: EmailTemplateDocument): EmailTemplateDocument {
  const hero = document.blocks.find((block) => block.type === 'event_hero');
  const ticketSummary = document.blocks.find((block) => block.type === 'ticket_summary');
  const footer = document.blocks.find((block) => block.type === 'unsubscribe_footer');
  const headline = hero?.type === 'event_hero' ? hero.headline : '{{event.title}}';
  const heroBody = hero?.type === 'event_hero' ? (hero.body ?? '') : '';
  const ticketBody = ticketSummary?.type === 'ticket_summary' ? ticketSummary.body : '';
  const footerBody = footer?.type === 'unsubscribe_footer' ? footer.body : '';

  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml: [
        `<h1>${escapeHtml(headline)}</h1>`,
        heroBody ? `<p>${escapeHtml(heroBody)}</p>` : '',
        ticketBody ? `<p>${escapeHtml(ticketBody)}</p>` : '',
        footerBody ? `<p>${escapeHtml(footerBody)}</p>` : '',
      ]
        .filter(Boolean)
        .join(''),
    },
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

function blockLabel(block: EmailTemplateDocument['blocks'][number]): string {
  switch (block.type) {
    case 'event_hero':
      return 'Email body';
    case 'ticket_summary':
      return 'Ticket summary';
    case 'unsubscribe_footer':
      return 'Footer';
    case 'order_summary':
      return 'Order summary';
    case 'qr_code':
      return 'QR code';
    case 'calendar_button':
      return 'Calendar button';
    case 'venue_block':
      return 'Venue';
    case 'social_links':
      return 'Social links';
    case 'raw_html':
      return 'Raw HTML';
  }
}

function blockSummary(block: EmailTemplateDocument['blocks'][number]): string {
  switch (block.type) {
    case 'event_hero':
      return block.body ? `${block.headline} - ${block.body}` : block.headline;
    case 'ticket_summary':
      return block.body ? `${block.title} - ${block.body}` : block.title;
    case 'unsubscribe_footer':
      return block.body;
    case 'order_summary':
      return `${block.rows.length} rows`;
    case 'qr_code':
      return block.title;
    case 'calendar_button':
      return block.label;
    case 'venue_block':
      return block.address ? `${block.title} - ${block.address}` : block.title;
    case 'social_links':
      return `${block.links.length} links`;
    case 'raw_html':
      return block.safe ? 'Reviewed HTML' : 'Blocked until reviewed';
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

function unreachableEmailBlock(block: never): never {
  throw new Error(`Unhandled email template block: ${JSON.stringify(block)}`);
}

export function EmailPersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [emailDocument, setEmailDocument] = React.useState<EmailTemplateDocument>();
  const [selectedBlockId, setSelectedBlockId] = React.useState('email-block-0');
  const [inspectorPanelId, setInspectorPanelId] = React.useState('block');
  const [recipient, setRecipient] = React.useState('ada@example.test');
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

    let loadedDocument = listItemsFromResponse<AdminContentDocument>(documentsResult.data).find(
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

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = defaultEmailDocument(loadedEvent);
      const initialPreview = await renderEmailTemplate(initialDocument, sampleContext(loadedEvent));
      const saveResult = await adminApi.saveContentVersion(loadedDocument.id, {
        contentJson: initialDocument,
        subject: initialDocument.settings.subject,
        previewText: initialDocument.settings.previewText,
        renderedHtml: initialPreview.html,
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

  const isArchived = document?.status === 'archived';

  function updateEmailDocument(nextDocument: EmailTemplateDocument) {
    if (isArchived) return;
    setEmailDocument(nextDocument);
    markDraftDirty();
  }

  function selectBlock(blockId: string) {
    setSelectedBlockId(blockId);
    setInspectorPanelId('block');
  }

  function insertEmailVariable(variableKey: string) {
    if (!emailDocument || isArchived) return;
    const token = `{{${variableKey}}}`;
    const selectedIndex = emailDocument.blocks.findIndex(
      (_block, index) => `email-block-${index}` === selectedBlockId,
    );
    const heroIndex = emailDocument.blocks.findIndex((block) => block.type === 'event_hero');
    const targetIndex = selectedIndex >= 0 ? selectedIndex : heroIndex;
    if (targetIndex < 0) return;
    updateEmailDocument({
      ...emailDocument,
      blocks: emailDocument.blocks.map((block, index) =>
        index === targetIndex ? appendVariableToBlock(block, token) : block,
      ),
    });
    setSelectedBlockId(`email-block-${targetIndex}`);
  }

  function insertEmailAction(actionId: string) {
    if (!emailDocument || isArchived) return;
    if (actionId === 'variables') {
      insertEmailVariable('recipient.name');
      return;
    }
    if (actionId === 'text') {
      updateEmailDocument({
        ...emailDocument,
        blocks: [
          ...emailDocument.blocks,
          {
            type: 'ticket_summary',
            title: 'New text block',
            body: 'Add attendee-ready copy here.',
          },
        ],
      });
      setSelectedBlockId(`email-block-${emailDocument.blocks.length}`);
      return;
    }
    if (actionId === 'components') {
      updateEmailDocument({
        ...emailDocument,
        blocks: [
          ...emailDocument.blocks,
          {
            type: 'calendar_button',
            label: 'Add to calendar',
            url: '{{event.checkoutUrl}}',
          },
        ],
      });
      setSelectedBlockId(`email-block-${emailDocument.blocks.length}`);
      return;
    }
    if (actionId === 'image') {
      updateEmailDocument({
        ...emailDocument,
        blocks: [
          ...emailDocument.blocks,
          {
            type: 'qr_code',
            title: 'Ticket QR code',
            imageUrl: '{{ticket.qrCodeUrl}}',
            imageAlt: 'Ticket QR code',
          },
        ],
      });
      setSelectedBlockId(`email-block-${emailDocument.blocks.length}`);
    }
  }

  async function saveDraft(operationId = nextOperationId(), snapshot = emailDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const rendered = await renderEmailTemplate(snapshot, sampleContext(event));
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: snapshot,
      subject: snapshot.settings.subject,
      previewText: snapshot.settings.previewText,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save email draft'));
      return undefined;
    }
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setPreview(previewFromEmailOutput('React Email preview', rendered));
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return result.data;
  }

  async function previewSavedDraft() {
    if (!document || !event || !emailDocument || isArchived) return;
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
      setActionError(resultMessage(result.error, 'Unable to preview email draft'));
      return;
    }
    setPreview(previewFromEmailOutput('Saved email preview', result.data.output));
    setActionError(undefined);
    setNotice('Preview rendered from the saved content version');
  }

  async function publishDraft() {
    if (!document || !emailDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, emailDocument);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to publish email draft'));
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
    toast.success('Email template published');
  }

  async function sendTest() {
    if (!document || !emailDocument || isArchived) return;
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
      setActionError(resultMessage(result.error, 'Unable to capture email test send'));
      return;
    }
    setActionError(undefined);
    setNotice(`Captured test send to ${result.data.testSend.recipient}`);
    toast.success('Email test send captured');
  }

  async function archiveDocument() {
    if (!document) return;
    if (
      !window.confirm(
        'Archive this email template? Editing, publishing, previews, and test sends will be disabled.',
      )
    ) {
      return;
    }
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to archive email template'));
      return;
    }
    setDocument(result.data);
    setActionError(undefined);
    setNotice('Archived email template');
    toast.success('Email template archived');
  }

  async function duplicateDocument() {
    if (!document || !emailDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, emailDocument);
    if (!saved) return;
    const result = await adminApi.duplicateContentDocument(document.id, {
      name: duplicateDocumentName(document.name),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to duplicate email template'));
      return;
    }
    setActionError(undefined);
    setNotice(`Duplicated email template as ${result.data.name}`);
    toast.success('Email template duplicated');
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading email editor...</p>;
  }

  if (error || !event || !document || !draft || !emailDocument || !preview) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Email template editor</h1>
        <p className="text-sm text-destructive">{error ?? 'Email editor could not load.'}</p>
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

  const selectedBlockIndex = emailDocument.blocks.findIndex(
    (_block, index) => `email-block-${index}` === selectedBlockId,
  );
  const selectedBlock =
    selectedBlockIndex >= 0 ? emailDocument.blocks[selectedBlockIndex] : emailDocument.blocks[0];
  const selectedBlockLabel = selectedBlock ? blockLabel(selectedBlock) : 'Content';
  const canEdit = !isArchived;
  const archivedReason = isArchived ? 'Archived templates are read-only.' : undefined;
  const canvasHeader = (
    <div className="space-y-3" data-testid="email-metadata-bar">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          From
          <input
            aria-label="From"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEmailDocument({
                ...emailDocument,
                settings: {
                  ...emailDocument.settings,
                  sender: {
                    ...emailDocument.settings.sender,
                    fromEmail: change.currentTarget.value,
                  },
                },
              });
            }}
            type="email"
            value={emailDocument.settings.sender.fromEmail ?? ''}
          />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Reply-To
          <input
            aria-label="Reply-To"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEmailDocument({
                ...emailDocument,
                settings: {
                  ...emailDocument.settings,
                  sender: {
                    ...emailDocument.settings.sender,
                    replyToEmail: change.currentTarget.value,
                  },
                },
              });
            }}
            type="email"
            value={emailDocument.settings.sender.replyToEmail ?? ''}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Subject
          <input
            aria-label="Subject"
            className={inputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEmailDocument({
                ...emailDocument,
                settings: { ...emailDocument.settings, subject: change.currentTarget.value },
              });
            }}
            value={emailDocument.settings.subject}
          />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Preview text
          <input
            aria-label="Preview text"
            className={inputClassName}
            disabled={!canEdit}
            onChange={(change) => {
              updateEmailDocument({
                ...emailDocument,
                settings: { ...emailDocument.settings, previewText: change.currentTarget.value },
              });
            }}
            value={emailDocument.settings.previewText ?? ''}
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
          onClick={() => void sendTest()}
          type="button"
        >
          <Send className="size-4" />
          Send test
        </button>
        <label className="ml-auto min-w-56 space-y-1.5 text-xs font-medium text-muted-foreground">
          Test recipient
          <input
            aria-label="Test recipient"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) => setRecipient(change.currentTarget.value)}
            type="email"
            value={recipient}
          />
        </label>
      </div>
    </div>
  );
  const directCanvasBlocks: ContentEditorCanvasBlock[] = emailDocument.blocks.map(
    (block, index) => {
      const id = `email-block-${index}`;
      const selected = id === selectedBlockId;
      const summary = blockSummary(block);
      const updateBlock = (nextBlock: EmailTemplateDocument['blocks'][number]) => {
        updateEmailDocument(updateEmailBlock(emailDocument, index, nextBlock));
      };

      if (block.type === 'event_hero') {
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
                className="max-w-[34rem] text-3xl font-bold leading-tight text-foreground"
                disabled={!canEdit}
                label="Email headline"
                onChange={(value) => updateBlock({ ...block, headline: value })}
                onFocus={() => selectBlock(id)}
                value={block.headline}
              />
              <EditablePlainText
                className="max-w-[35rem] whitespace-pre-wrap text-base leading-7 text-muted-foreground"
                disabled={!canEdit}
                label="Email body"
                multiline
                onChange={(value) => updateBlock({ ...block, body: value })}
                onFocus={() => selectBlock(id)}
                value={block.body ?? ''}
              />
              <div className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm">
                <EditablePlainText
                  className="min-w-20 text-primary-foreground"
                  disabled={!canEdit}
                  label="CTA label"
                  onChange={(value) => updateBlock({ ...block, ctaLabel: value })}
                  onFocus={() => selectBlock(id)}
                  value={block.ctaLabel ?? ''}
                />
              </div>
            </div>
          ),
        };
      }

      if (block.type === 'ticket_summary') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-2">
              <EditablePlainText
                className="text-lg font-semibold text-foreground"
                disabled={!canEdit}
                label="Ticket summary title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <EditablePlainText
                className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground"
                disabled={!canEdit}
                label="Ticket summary body"
                multiline
                onChange={(value) => updateBlock({ ...block, body: value })}
                onFocus={() => selectBlock(id)}
                value={block.body}
              />
            </div>
          ),
        };
      }

      if (block.type === 'unsubscribe_footer') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-2">
              <EditablePlainText
                className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
                disabled={!canEdit}
                label="Footer body"
                multiline
                onChange={(value) => updateBlock({ ...block, body: value })}
                onFocus={() => selectBlock(id)}
                value={block.body}
              />
            </div>
          ),
        };
      }

      if (block.type === 'qr_code') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-3 text-center">
              <EditablePlainText
                className="text-lg font-semibold text-foreground"
                disabled={!canEdit}
                label="QR code title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <div className="mx-auto flex size-36 items-center justify-center rounded-md border border-dashed bg-muted/30 px-3 text-xs font-medium text-muted-foreground">
                QR image
              </div>
            </div>
          ),
        };
      }

      if (block.type === 'calendar_button') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="inline-flex min-h-10 items-center rounded-md border bg-background px-4 py-2 text-sm font-semibold shadow-sm">
              <EditablePlainText
                className="min-w-28 text-foreground"
                disabled={!canEdit}
                label="Calendar button label"
                onChange={(value) => updateBlock({ ...block, label: value })}
                onFocus={() => selectBlock(id)}
                value={block.label}
              />
            </div>
          ),
        };
      }

      if (block.type === 'order_summary') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-3">
              <p className="text-lg font-semibold text-foreground">Order summary</p>
              <dl className="divide-y text-sm">
                {block.rows.map((row, rowIndex) => (
                  <div
                    className="grid grid-cols-[1fr_auto] gap-4 py-2"
                    key={`${row.label}-${rowIndex}`}
                  >
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className="font-medium text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ),
        };
      }

      if (block.type === 'venue_block') {
        return {
          id,
          label: blockLabel(block),
          presentation: 'document',
          summary,
          selected,
          onSelect: () => selectBlock(id),
          content: (
            <div className="space-y-2">
              <EditablePlainText
                className="text-lg font-semibold text-foreground"
                disabled={!canEdit}
                label="Venue title"
                onChange={(value) => updateBlock({ ...block, title: value })}
                onFocus={() => selectBlock(id)}
                value={block.title}
              />
              <EditablePlainText
                className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground"
                disabled={!canEdit}
                label="Venue address"
                multiline
                onChange={(value) => updateBlock({ ...block, address: value })}
                onFocus={() => selectBlock(id)}
                value={block.address}
              />
            </div>
          ),
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
            <nav aria-label="Email social links" className="flex flex-wrap gap-3 text-sm">
              {block.links.map((link, linkIndex) => (
                <a
                  className="font-medium text-primary underline-offset-4 hover:underline"
                  href={link.url}
                  key={`${link.label}-${linkIndex}`}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ),
        };
      }

      if (block.type === 'raw_html') {
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
              label="Raw HTML"
              multiline
              onChange={(value) => updateBlock({ ...block, html: value })}
              onFocus={() => selectBlock(id)}
              value={block.html}
            />
          ),
        };
      }

      return unreachableEmailBlock(block);
    },
  );
  const updateSelectedEmailBlock = (nextBlock: EmailTemplateDocument['blocks'][number]) => {
    if (selectedBlockIndex < 0) return;
    updateEmailDocument(updateEmailBlock(emailDocument, selectedBlockIndex, nextBlock));
  };
  const selectedBlockControls = (() => {
    if (!selectedBlock) {
      return <p className="text-xs text-muted-foreground">Select content in the canvas.</p>;
    }

    if (selectedBlock.type === 'event_hero') {
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          CTA URL
          <input
            aria-label="CTA URL"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEmailBlock({ ...selectedBlock, ctaUrl: change.currentTarget.value })
            }
            value={selectedBlock.ctaUrl ?? ''}
          />
        </label>
      );
    }

    if (selectedBlock.type === 'unsubscribe_footer') {
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Preferences URL
          <input
            aria-label="Preferences URL"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEmailBlock({
                ...selectedBlock,
                unsubscribeUrl: change.currentTarget.value,
              })
            }
            value={selectedBlock.unsubscribeUrl}
          />
        </label>
      );
    }

    if (selectedBlock.type === 'qr_code') {
      return (
        <div className="space-y-3">
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            QR image URL
            <input
              aria-label="QR image URL"
              className={compactInputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEmailBlock({ ...selectedBlock, imageUrl: change.currentTarget.value })
              }
              value={selectedBlock.imageUrl}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
            QR image alt text
            <input
              aria-label="QR image alt text"
              className={compactInputClassName}
              disabled={!canEdit}
              onChange={(change) =>
                updateSelectedEmailBlock({ ...selectedBlock, imageAlt: change.currentTarget.value })
              }
              value={selectedBlock.imageAlt ?? ''}
            />
          </label>
        </div>
      );
    }

    if (selectedBlock.type === 'calendar_button') {
      return (
        <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
          Calendar URL
          <input
            aria-label="Calendar URL"
            className={compactInputClassName}
            disabled={!canEdit}
            onChange={(change) =>
              updateSelectedEmailBlock({ ...selectedBlock, url: change.currentTarget.value })
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
    <div className="grid grid-cols-2 gap-1" aria-label="Email inspector modes">
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
          <h2 className="text-sm font-semibold">Email metadata</h2>
          <dl className="space-y-2">
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="truncate font-medium">{emailDocument.settings.subject}</dd>
            </div>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">From</dt>
              <dd className="truncate font-medium">
                {emailDocument.settings.sender.fromEmail ?? 'Missing'}
              </dd>
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
          <h2 className="text-sm font-semibold">Body style</h2>
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            React Email body uses Tixkit transactional defaults with 640px content width.
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
            Locale {emailDocument.settings.locale}; category {emailDocument.settings.category}.
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
            {JSON.stringify(emailDocument, null, 2)}
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
            {['event.title', 'recipient.name', 'ticket.type', 'order.total', 'brand.name'].map(
              (key) => (
                <button
                  className="rounded-md border px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                  disabled={!canEdit}
                  key={key}
                  onClick={() => insertEmailVariable(key)}
                  type="button"
                >
                  {`{{${key}}}`}
                </button>
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
          <h1 className="truncate text-2xl font-bold tracking-tight">Email template editor</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Persisted React Email composer for {event.title}
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
        channelLabel="Email template"
        document={toShellDocument(document)}
        draft={toShellVersion(draft)}
        activeInspectorPanelId={inspectorPanelId}
        inspectorPanels={inspectorPanels}
        insertActions={emailInsertActions}
        preview={preview}
        showInspectorPanelTabs={false}
        testSendUnavailableReason={archivedReason}
        versions={versionSummaries(versions)}
        onInsertAction={insertEmailAction}
        onInspectorPanelChange={setInspectorPanelId}
        onPreview={() => void previewSavedDraft()}
        onPublish={() => void publishDraft()}
        onDuplicate={() => void duplicateDocument()}
        onArchive={() => void archiveDocument()}
        onTestSend={() => void sendTest()}
      />
    </div>
  );
}
