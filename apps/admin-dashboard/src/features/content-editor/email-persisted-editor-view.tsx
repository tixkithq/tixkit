'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  CalendarDays,
  ChevronLeft,
  Code,
  Columns2,
  Copy,
  Eye,
  FileJson,
  Image,
  Link,
  MapPin,
  Minus,
  MoreHorizontal,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  QrCode,
  ReceiptText,
  Save,
  Send,
  Share2,
  Sparkles,
  Ticket,
  Type,
  Variable,
} from 'lucide-react';
import { EmailEditor, type EmailEditorProps, type EmailEditorRef } from '@react-email/editor';
import { Inspector } from '@react-email/editor/ui';
import { toast } from 'sonner';
import {
  REACT_EMAIL_EDITOR_PACKAGE,
  createDefaultEmailTemplate,
  normalizeEmailTemplateDocument,
  renderEmailTemplate,
  validateEditorExport,
  validateEmailTemplate,
  type EmailTemplateDocument,
  type RenderedEmailTemplate,
} from '@tixkit/content-email';
import type { ContentValidationIssue } from '@tixkit/content-core';
import {
  adminApi,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminContentRenderOutput,
  type AdminEventDetail,
} from '@/lib/api';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type EmailReviewState = 'idle' | 'checking' | 'checked' | 'error';

type EditorPreview = {
  label: string;
  output: string;
  format: 'html' | 'text';
};

type InsertAction = {
  id: 'text' | 'image' | 'components' | 'variables';
  label: string;
  icon: React.ReactNode;
};

type EmailComponentInsert = {
  id:
    | 'button'
    | 'divider'
    | 'section-columns'
    | 'event-hero'
    | 'ticket-summary'
    | 'order-summary'
    | 'qr-code'
    | 'calendar'
    | 'venue'
    | 'social-links'
    | 'footer'
    | 'raw-html';
  label: string;
  description: string;
  icon: React.ReactNode;
  html: string;
};

const emailInsertActions: InsertAction[] = [
  { id: 'text', label: 'Text', icon: <Type className="size-4" /> },
  { id: 'image', label: 'Image', icon: <Image className="size-4" /> },
  { id: 'components', label: 'Components', icon: <Sparkles className="size-4" /> },
  { id: 'variables', label: 'Variables', icon: <Variable className="size-4" /> },
];

const emailComponentInserts: EmailComponentInsert[] = [
  {
    id: 'event-hero',
    label: 'Event hero',
    description: 'Headline, attendee greeting, and primary ticket CTA.',
    icon: <Sparkles className="size-4" />,
    html: [
      '<h1>{{event.title}}</h1>',
      '<p>Hi {{recipient.name}}, your tickets are ready.</p>',
      '<p><a href="{{event.checkoutUrl}}">View tickets</a></p>',
    ].join(''),
  },
  {
    id: 'section-columns',
    label: 'Section / columns',
    description: 'Two-column email section for schedule and venue details.',
    icon: <Columns2 className="size-4" />,
    html: [
      '<table role="presentation" width="100%">',
      '<tr>',
      '<td width="50%"><p>{{event.startsAt}}</p></td>',
      '<td width="50%"><p>{{event.venueName}}</p></td>',
      '</tr>',
      '</table>',
    ].join(''),
  },
  {
    id: 'ticket-summary',
    label: 'Ticket summary',
    description: 'Ticket type and order total for transactional mail.',
    icon: <Ticket className="size-4" />,
    html: '<p><strong>{{ticket.type}}</strong><br />{{order.total}}</p>',
  },
  {
    id: 'order-summary',
    label: 'Order summary',
    description: 'Compact order ID and payment total block.',
    icon: <ReceiptText className="size-4" />,
    html: '<p>Order {{order.id}}<br />Total {{order.total}}</p>',
  },
  {
    id: 'qr-code',
    label: 'QR code',
    description: 'Ticket QR image with safe merge-tag URL.',
    icon: <QrCode className="size-4" />,
    html: '<p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code" /></p>',
  },
  {
    id: 'calendar',
    label: 'Calendar button',
    description: 'Link attendees to the public event page.',
    icon: <CalendarDays className="size-4" />,
    html: '<p><a href="{{event.publicUrl}}">Add to calendar</a></p>',
  },
  {
    id: 'venue',
    label: 'Venue block',
    description: 'Date, time, and venue merge tags.',
    icon: <MapPin className="size-4" />,
    html: '<p>{{event.startsAt}}<br />{{event.venueName}}</p>',
  },
  {
    id: 'button',
    label: 'Button',
    description: 'Provider-safe link styled by the email renderer.',
    icon: <Link className="size-4" />,
    html: '<p><a href="{{event.checkoutUrl}}">Buy tickets</a></p>',
  },
  {
    id: 'divider',
    label: 'Divider',
    description: 'Horizontal separator between content sections.',
    icon: <Minus className="size-4" />,
    html: '<hr />',
  },
  {
    id: 'social-links',
    label: 'Social links',
    description: 'Reusable brand and support links.',
    icon: <Share2 className="size-4" />,
    html: '<p><a href="{{event.publicUrl}}">Event page</a> - <a href="{{brand.supportUrl}}">Support</a></p>',
  },
  {
    id: 'footer',
    label: 'Footer',
    description: 'Brand footer for transactional context.',
    icon: <PanelRightClose className="size-4" />,
    html: '<p>You are receiving this because you purchased or manage tickets with {{brand.name}}.</p>',
  },
  {
    id: 'raw-html',
    label: 'Raw HTML',
    description: 'Validated HTML handoff for advanced imports.',
    icon: <Code className="size-4" />,
    html: '<p data-tixkit-raw-html="true">Paste reviewed HTML here.</p>',
  },
];

const emailVariableInserts = [
  'event.title',
  'event.startsAt',
  'event.venueName',
  'event.checkoutUrl',
  'event.publicUrl',
  'recipient.name',
  'ticket.type',
  'ticket.qrCodeUrl',
  'order.id',
  'order.total',
  'brand.name',
  'brand.supportUrl',
];

const textInputClassName =
  'h-9 w-full border-0 border-b border-black/10 bg-transparent px-0 text-sm text-black outline-none transition placeholder:text-black/35 focus:border-black';
const darkInputClassName =
  'h-9 w-full rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-white/35 disabled:cursor-not-allowed disabled:opacity-50';

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
      venueName: 'Radius Chicago',
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
      id: 'ord_preview_123',
      total: '$35.00',
    },
  };
}

function defaultEmailDocument(event?: AdminEventDetail): EmailTemplateDocument {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: [
        '<h1>{{event.title}}</h1>',
        '<p>Hi {{recipient.name}}, your tickets are ready.</p>',
        '<p>{{ticket.type}} - {{order.total}}</p>',
        '<p>You are receiving this because you purchased or manage tickets with {{brand.name}}.</p>',
      ].join(''),
      contentText: [
        '{{event.title}}',
        'Hi {{recipient.name}}, your tickets are ready.',
        '{{ticket.type}} - {{order.total}}',
        'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
      ].join('\n\n'),
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
): Promise<EditorPreview> {
  const rendered = await renderEmailTemplate(document, sampleContext(event));
  return previewFromEmailOutput('React Email preview', rendered);
}

function previewFromEmailOutput(
  label: string,
  output: Pick<RenderedEmailTemplate, 'subject' | 'html' | 'text'> | AdminContentRenderOutput,
): EditorPreview {
  const text = output.text?.trim();
  const html = output.html?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: `Subject: ${output.subject ?? ''}\n\n${text || html || ''}`,
  };
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

function autosaveLabel(state: AutosaveState): string {
  switch (state) {
    case 'saving':
      return 'Saving';
    case 'saved':
      return 'Saved';
    case 'error':
      return 'Save failed';
    case 'idle':
      return 'Ready';
  }
}

function autosaveClassName(state: AutosaveState): string {
  switch (state) {
    case 'saving':
      return 'border-amber-400/40 bg-amber-400/10 text-amber-100';
    case 'saved':
      return 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100';
    case 'error':
      return 'border-red-400/40 bg-red-400/10 text-red-100';
    case 'idle':
      return 'border-cyan-400/40 bg-cyan-400/10 text-cyan-100';
  }
}

function validationIssueKey(issue: ContentValidationIssue): string {
  return `${issue.code}:${issue.field ?? ''}:${issue.message}:${issue.severity}`;
}

function mergeValidationIssues(issues: ContentValidationIssue[]): ContentValidationIssue[] {
  const seen = new Set<string>();
  const uniqueIssues: ContentValidationIssue[] = [];
  const errors: ContentValidationIssue[] = [];
  const warnings: ContentValidationIssue[] = [];
  for (const issue of issues) {
    const key = validationIssueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueIssues.push(issue);
  }
  for (const issue of uniqueIssues) {
    if (issue.severity === 'error') {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }
  return [...errors, ...warnings];
}

function hasBlockingIssues(issues: ContentValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

function issueBadgeClassName(issue: ContentValidationIssue): string {
  return issue.severity === 'error'
    ? 'border-red-400/40 bg-red-400/10 text-red-100'
    : 'border-amber-400/40 bg-amber-400/10 text-amber-100';
}

function NativeEmailInspector({ host }: { host: HTMLElement | null }) {
  if (!host) return null;
  return createPortal(
    <Inspector.Root
      aria-label="React Email style inspector"
      className="tixkit-email-native-inspector"
    >
      <div className="space-y-1 border-b border-white/10 pb-3">
        <p className="text-xs uppercase tracking-wide text-white/40">Selection</p>
        <div className="text-sm font-semibold text-white">
          <Inspector.Breadcrumb />
        </div>
      </div>
      <div className="space-y-5">
        <Inspector.Document />
        <Inspector.Node />
        <Inspector.Text />
      </div>
    </Inspector.Root>,
    host,
  );
}

function initialEditorContent(document: EmailTemplateDocument): EmailEditorProps['content'] {
  return (document.editor.contentJson ??
    document.editor.contentHtml) as EmailEditorProps['content'];
}

function withEditorExport(
  document: EmailTemplateDocument,
  exported: { html: string; text: string; json: Record<string, unknown> },
): EmailTemplateDocument {
  const contentText = exported.text.trim() || plainTextFromHtml(exported.html);
  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml: exported.html,
      contentText,
      contentJson: exported.json,
    },
    blocks: projectEditorTextToLegacyBlocks(document.blocks, contentText),
  };
}

function projectEditorTextToLegacyBlocks(
  blocks: EmailTemplateDocument['blocks'],
  contentText: string,
): EmailTemplateDocument['blocks'] {
  if (!contentText.trim()) return blocks;
  const firstTextBlock = blocks.findIndex(
    (block) => block.type === 'event_hero' || block.type === 'ticket_summary',
  );
  if (firstTextBlock < 0) return blocks;
  return blocks.map((block, index) => {
    if (index !== firstTextBlock) return block;
    if (block.type === 'event_hero') {
      return { ...block, body: contentText };
    }
    if (block.type === 'ticket_summary') {
      return { ...block, body: contentText };
    }
    return block;
  });
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function PreviewDrawer({ onClose, preview }: { onClose: () => void; preview: EditorPreview }) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-white/10 bg-neutral-950 text-white shadow-2xl"
      data-testid="preview-drawer"
    >
      <div className="flex h-14 items-center justify-between border-b border-white/10 px-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-white/45">{preview.format}</p>
          <h2 className="text-sm font-semibold">{preview.label}</h2>
        </div>
        <button
          aria-label="Close preview"
          className="inline-flex size-8 items-center justify-center rounded-md border border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onClose}
          type="button"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-white/80">
        {preview.output}
      </pre>
    </aside>
  );
}

export function EmailPersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [emailDocument, setEmailDocument] = React.useState<EmailTemplateDocument>();
  const [inspectorPanelId, setInspectorPanelId] = React.useState<
    'style' | 'components' | 'variables' | 'history' | 'issues' | 'json'
  >('style');
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = React.useState(false);
  const [reviewIssues, setReviewIssues] = React.useState<ContentValidationIssue[]>([]);
  const [reviewState, setReviewState] = React.useState<EmailReviewState>('idle');
  const [nativeInspectorHost, setNativeInspectorHost] = React.useState<HTMLElement | null>(null);
  const [recipient, setRecipient] = React.useState('ada@example.test');
  const [preview, setPreview] = React.useState<EditorPreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const emailEditorRef = React.useRef<EmailEditorRef | null>(null);

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
    setReviewState('idle');
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
    setReviewIssues(validateEmailTemplate(normalized, { provider: 'resend' }).issues);
    setReviewState('checked');
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const isArchived = document?.status === 'archived';
  const canEdit = !isArchived;

  function openInspectorPanel(panelId: typeof inspectorPanelId) {
    setInspectorPanelId(panelId);
    setInspectorCollapsed(false);
  }

  function openMenuInspectorPanel(panelId: typeof inspectorPanelId) {
    openInspectorPanel(panelId);
    setMoreActionsOpen(false);
  }

  function updateEmailDocument(nextDocument: EmailTemplateDocument) {
    if (isArchived) return;
    setEmailDocument(nextDocument);
    markDraftDirty();
  }

  async function snapshotFromEditor(
    snapshot = emailDocument,
  ): Promise<EmailTemplateDocument | undefined> {
    if (!snapshot) return undefined;
    const ref = emailEditorRef.current;
    if (!ref) return snapshot;
    const exported = await ref.getEmail();
    return withEditorExport(snapshot, {
      html: exported.html,
      text: exported.text,
      json: ref.getJSON() as Record<string, unknown>,
    });
  }

  function insertEditorContent(content: string) {
    if (isArchived) return;
    const editor = emailEditorRef.current?.editor;
    if (!editor) return;
    editor.chain().focus().insertContent(content).run();
    markDraftDirty();
  }

  function insertEmailVariable(variableKey: string) {
    insertEditorContent(`{{${variableKey}}}`);
  }

  function insertEmailComponent(componentId: EmailComponentInsert['id']) {
    const component = emailComponentInserts.find((item) => item.id === componentId);
    if (!component) return;
    insertEditorContent(component.html);
  }

  function insertEmailAction(actionId: InsertAction['id']) {
    if (actionId === 'variables') {
      openInspectorPanel('variables');
      return;
    }
    if (actionId === 'text') {
      insertEditorContent('<p>Add attendee-ready copy here.</p>');
      return;
    }
    if (actionId === 'components') {
      openInspectorPanel('components');
      return;
    }
    if (actionId === 'image') {
      insertEditorContent('<img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code" />');
    }
  }

  async function reviewCurrentDraft(options: { openPanel?: boolean } = {}) {
    if (!emailDocument) return undefined;
    setReviewState('checking');
    if (options.openPanel !== false) openInspectorPanel('issues');
    let editorSnapshot: EmailTemplateDocument | undefined;
    try {
      editorSnapshot = await snapshotFromEditor(emailDocument);
    } catch (reviewError) {
      setReviewState('error');
      setActionError(
        reviewError instanceof Error ? reviewError.message : 'Unable to review email draft',
      );
      return undefined;
    }
    if (!editorSnapshot) return undefined;
    const templateValidation = validateEmailTemplate(editorSnapshot, { provider: 'resend' });
    const exportValidation = validateEditorExport(editorSnapshot.editor.contentHtml);
    const issues = mergeValidationIssues([
      ...templateValidation.issues,
      ...exportValidation.issues,
    ]);
    setEmailDocument(editorSnapshot);
    setReviewIssues(issues);
    setReviewState('checked');
    setActionError(undefined);
    setNotice(
      issues.length === 0
        ? 'Current email draft passed review'
        : `Current email draft has ${issues.length} review ${issues.length === 1 ? 'item' : 'items'}`,
    );
    return { document: editorSnapshot, issues };
  }

  async function saveDraft(operationId = nextOperationId(), snapshot = emailDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    let editorSnapshot: EmailTemplateDocument | undefined;
    try {
      editorSnapshot = await snapshotFromEditor(snapshot);
    } catch (saveError) {
      if (!isCurrentOperation(operationId)) return undefined;
      setAutosave('error');
      setActionError(saveError instanceof Error ? saveError.message : 'Unable to export email');
      return undefined;
    }
    if (!editorSnapshot) return undefined;
    const rendered = await renderEmailTemplate(editorSnapshot, sampleContext(event));
    setReviewIssues(rendered.validation.issues);
    setReviewState('checked');
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: editorSnapshot,
      subject: editorSnapshot.settings.subject,
      previewText: editorSnapshot.settings.previewText,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
    });
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save email draft'));
      return undefined;
    }
    setEmailDocument(editorSnapshot);
    setDraft(result.data);
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
    setPreview(previewFromEmailOutput('React Email preview', rendered));
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return { version: result.data, document: editorSnapshot };
  }

  async function previewSavedDraft() {
    if (!document || !event || !emailDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, emailDocument);
    if (!saved) return;
    const result = await adminApi.previewContent(document.id, {
      versionId: saved.version.id,
      contentJson: saved.document,
      subject: saved.document.settings.subject,
      previewText: saved.document.settings.previewText,
      context: sampleContext(event),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to preview email draft'));
      return;
    }
    setPreview(previewFromEmailOutput('Saved email preview', result.data.output));
    setPreviewOpen(true);
    setActionError(undefined);
    setNotice('Preview rendered from the saved content version');
  }

  async function publishDraft() {
    if (!document || !emailDocument || isArchived) return;
    const review = await reviewCurrentDraft({ openPanel: false });
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email publish blockers before publishing.');
      setInspectorPanelId('issues');
      return;
    }
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, review.document);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.version.id);
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
      versionId: saved.version.id,
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
    return (
      <div className="flex min-h-svh items-center justify-center bg-neutral-950 text-sm text-white/65">
        Loading email editor...
      </div>
    );
  }

  if (error || !event || !document || !draft || !emailDocument || !preview) {
    return (
      <section className="flex min-h-svh items-center justify-center bg-neutral-950 p-6 text-white">
        <div className="w-full max-w-lg space-y-4 rounded-lg border border-white/10 bg-white/5 p-6">
          <div className="space-y-1">
            <p className="text-sm text-white/50">Email template editor</p>
            <h1 className="text-2xl font-semibold">Unable to load editor</h1>
          </div>
          <p className="text-sm text-red-200">{error ?? 'Email editor could not load.'}</p>
          <button
            className="rounded-md border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
            onClick={() => void load()}
            type="button"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const archivedReason = isArchived ? 'Archived templates are read-only.' : undefined;
  const history = versionSummaries(versions);
  const issuePanelIssues = reviewState === 'idle' ? draft.validation.issues : reviewIssues;
  const issuePanelTitle = reviewState === 'checked' ? 'Current draft review' : 'Saved draft review';

  return (
    <section className="min-h-svh overflow-hidden bg-neutral-950 text-white" data-channel="email">
      <header className="grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-white/10 px-4">
        <a
          aria-label="Back to event"
          className="inline-flex size-9 items-center justify-center rounded-md border border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
          href={`/events/${event.id}`}
        >
          <ChevronLeft className="size-4" />
        </a>
        <div className="min-w-0 text-center">
          <div className="flex min-w-0 items-center justify-center gap-2 text-sm text-white/55">
            <span className="truncate">Templates</span>
            <span>/</span>
            <button
              className="min-w-0 truncate font-semibold text-white"
              disabled={!canEdit}
              onClick={() => openInspectorPanel('style')}
              type="button"
            >
              {document.name}
            </button>
            <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-white/70">
              {document.status}
            </span>
            <span
              className={`rounded-md border px-2 py-0.5 text-xs ${autosaveClassName(autosave)}`}
            >
              {autosaveLabel(autosave)}
            </span>
          </div>
          {(notice || actionError) && (
            <p
              className={`mt-1 truncate text-xs ${actionError ? 'text-red-200' : 'text-white/45'}`}
            >
              {actionError ?? notice}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Open preview"
            className="inline-flex size-9 items-center justify-center rounded-md border border-white/10 text-white/70 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            disabled={Boolean(archivedReason)}
            onClick={() => setPreviewOpen(true)}
            title={archivedReason}
            type="button"
          >
            <Eye className="size-4" />
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-white/10 px-3 text-sm font-medium text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={Boolean(archivedReason)}
            onClick={() => void sendTest()}
            title={archivedReason}
            type="button"
          >
            <Send className="size-4" />
            Send test
          </button>
          <div className="relative">
            <button
              aria-label="More actions"
              aria-expanded={moreActionsOpen}
              className="inline-flex size-9 list-none items-center justify-center rounded-md border border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => setMoreActionsOpen((open) => !open)}
              type="button"
            >
              <MoreHorizontal className="size-4" />
            </button>
            {moreActionsOpen && (
              <div className="absolute right-0 top-11 z-30 w-56 rounded-lg border border-white/10 bg-neutral-900 p-1 text-sm shadow-2xl">
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-white/80 hover:bg-white/10"
                  onClick={() => openMenuInspectorPanel('variables')}
                  type="button"
                >
                  <Variable className="size-4" />
                  Open variables panel
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-white/80 hover:bg-white/10"
                  onClick={() => openMenuInspectorPanel('history')}
                  type="button"
                >
                  <Save className="size-4" />
                  Open version history
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-white/80 hover:bg-white/10"
                  onClick={() => openMenuInspectorPanel('style')}
                  type="button"
                >
                  <Palette className="size-4" />
                  Template details
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={reviewState === 'checking'}
                  onClick={() => {
                    setMoreActionsOpen(false);
                    void reviewCurrentDraft();
                  }}
                  type="button"
                >
                  <Eye className="size-4" />
                  Review blockers
                </button>
                <div className="my-1 border-t border-white/10" />
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={Boolean(archivedReason)}
                  onClick={() => {
                    setMoreActionsOpen(false);
                    void duplicateDocument();
                  }}
                  type="button"
                >
                  <Copy className="size-4" />
                  Duplicate template
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-red-200 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => {
                    setMoreActionsOpen(false);
                    void archiveDocument();
                  }}
                  type="button"
                >
                  <Archive className="size-4" />
                  Archive template
                </button>
              </div>
            )}
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={Boolean(archivedReason)}
            onClick={() => void publishDraft()}
            type="button"
          >
            Publish
          </button>
        </div>
      </header>

      <div
        className={`grid h-[calc(100svh-4rem)] grid-cols-[4rem_minmax(0,1fr)] ${
          inspectorCollapsed
            ? 'lg:grid-cols-[4rem_minmax(0,1fr)]'
            : 'lg:grid-cols-[4rem_minmax(0,1fr)_22rem]'
        }`}
      >
        <aside
          aria-label="Insert content"
          className="flex flex-col items-center gap-2 border-r border-white/10 bg-neutral-950 px-2 py-5"
        >
          {emailInsertActions.map((action) => (
            <button
              aria-label={`Insert ${action.label}`}
              className="inline-flex size-10 items-center justify-center rounded-md border border-white/10 text-white/60 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!canEdit}
              key={action.id}
              onClick={() => insertEmailAction(action.id)}
              title={action.label}
              type="button"
            >
              {action.icon}
            </button>
          ))}
        </aside>

        <main className="min-w-0 overflow-auto rounded-tl-3xl bg-white text-black">
          <div className="mx-auto min-h-full w-full max-w-[600px] px-6 py-10">
            <div className="space-y-3" data-testid="email-metadata-bar">
              <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
                <label className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 text-sm text-black/55">
                  From
                  <input
                    aria-label="From"
                    className={textInputClassName}
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
                <label className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 text-sm text-black/55">
                  Reply-To
                  <input
                    aria-label="Reply-To"
                    className={textInputClassName}
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
              <div className="grid gap-x-8 gap-y-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <label className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 text-sm text-black/55">
                  Subject
                  <input
                    aria-label="Subject"
                    className={textInputClassName}
                    disabled={!canEdit}
                    onChange={(change) => {
                      updateEmailDocument({
                        ...emailDocument,
                        settings: {
                          ...emailDocument.settings,
                          subject: change.currentTarget.value,
                        },
                      });
                    }}
                    placeholder="Subject"
                    value={emailDocument.settings.subject}
                  />
                </label>
                <label className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-4 text-sm text-black/55">
                  Preview
                  <input
                    aria-label="Preview text"
                    className={textInputClassName}
                    disabled={!canEdit}
                    onChange={(change) => {
                      updateEmailDocument({
                        ...emailDocument,
                        settings: {
                          ...emailDocument.settings,
                          previewText: change.currentTarget.value,
                        },
                      });
                    }}
                    placeholder="Preview text"
                    value={emailDocument.settings.previewText ?? ''}
                  />
                </label>
              </div>
            </div>

            <div className="mt-6 border-t border-black/10 pt-6">
              <EmailEditor
                key={draft.id}
                ref={emailEditorRef}
                bubbleMenu={{ hideWhenActiveNodes: ['button', 'horizontalRule'] }}
                className="tixkit-react-email-editor"
                content={initialEditorContent(emailDocument)}
                editable={canEdit}
                onReady={(ref) => {
                  emailEditorRef.current = ref;
                }}
                onUpdate={(ref) => {
                  emailEditorRef.current = ref;
                  markDraftDirty();
                }}
                placeholder="Write the email..."
              >
                <NativeEmailInspector host={nativeInspectorHost} />
              </EmailEditor>
            </div>
          </div>
        </main>

        <aside
          aria-label="Email inspector"
          className={`col-span-2 min-h-0 overflow-auto border-t border-white/10 bg-neutral-950 p-4 lg:col-span-1 lg:border-l lg:border-t-0 ${
            inspectorCollapsed ? 'hidden' : ''
          }`}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2">
            <div className="grid grid-cols-6 gap-1" aria-label="Email inspector modes">
              {[
                { id: 'style', label: 'Style', icon: <Palette className="size-4" /> },
                { id: 'components', label: 'Components', icon: <Sparkles className="size-4" /> },
                { id: 'variables', label: 'Variables', icon: <Variable className="size-4" /> },
                { id: 'history', label: 'History', icon: <Save className="size-4" /> },
                { id: 'issues', label: 'Issues', icon: <Eye className="size-4" /> },
                { id: 'json', label: 'JSON', icon: <FileJson className="size-4" /> },
              ].map((panel) => (
                <button
                  aria-label={panel.label}
                  aria-pressed={inspectorPanelId === panel.id}
                  className={`inline-flex h-9 items-center justify-center rounded-md border text-xs ${
                    inspectorPanelId === panel.id
                      ? 'border-white/30 bg-white text-black'
                      : 'border-white/10 text-white/60 hover:bg-white/10 hover:text-white'
                  }`}
                  key={panel.id}
                  onClick={() => openInspectorPanel(panel.id as typeof inspectorPanelId)}
                  title={panel.label}
                  type="button"
                >
                  {panel.icon}
                </button>
              ))}
            </div>
            <button
              aria-label="Collapse inspector"
              className="inline-flex h-9 items-center justify-center rounded-md border border-white/10 text-white/60 hover:bg-white/10 hover:text-white"
              onClick={() => setInspectorCollapsed(true)}
              title="Collapse inspector"
              type="button"
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>

          {inspectorPanelId === 'style' && (
            <section className="mt-6 space-y-5 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Page style</p>
                <h2 className="mt-1 font-semibold">React Email inspector</h2>
              </div>
              <div
                className="min-h-[24rem]"
                data-testid="native-email-inspector-host"
                ref={setNativeInspectorHost}
              />
              <label className="space-y-1.5 text-xs font-medium text-white/55">
                Test recipient
                <input
                  aria-label="Test recipient"
                  className={darkInputClassName}
                  disabled={!canEdit}
                  onChange={(change) => setRecipient(change.currentTarget.value)}
                  type="email"
                  value={recipient}
                />
              </label>
              <dl className="space-y-3 text-xs">
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-white/45">Template key</dt>
                  <dd className="font-mono text-white/80">{emailDocument.settings.templateKey}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-white/45">Locale</dt>
                  <dd className="font-mono text-white/80">{emailDocument.settings.locale}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3">
                  <dt className="text-white/45">Category</dt>
                  <dd className="font-mono text-white/80">{emailDocument.settings.category}</dd>
                </div>
              </dl>
              <button
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canEdit}
                onClick={() => void saveDraft()}
                type="button"
              >
                <Save className="size-4" />
                Save draft
              </button>
              <button
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canEdit}
                onClick={() => void previewSavedDraft()}
                type="button"
              >
                <Eye className="size-4" />
                Preview
              </button>
            </section>
          )}
          {inspectorPanelId === 'components' && (
            <section className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Components</p>
                <h2 className="mt-1 font-semibold">Insert email sections</h2>
              </div>
              <div className="grid gap-2">
                {emailComponentInserts.map((component) => (
                  <button
                    className="rounded-md border border-white/10 px-3 py-2 text-left text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canEdit}
                    key={component.id}
                    onClick={() => insertEmailComponent(component.id)}
                    type="button"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-white">
                      {component.icon}
                      <span>{component.label}</span>
                    </span>
                    <span className="mt-1 block text-xs text-white/45">
                      {component.description}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {inspectorPanelId === 'variables' && (
            <section className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Variables</p>
                <h2 className="mt-1 font-semibold">Insert merge tags</h2>
              </div>
              <div className="grid gap-2">
                {emailVariableInserts.map((key) => (
                  <button
                    className="rounded-md border border-white/10 px-3 py-2 text-left font-mono text-xs text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!canEdit}
                    key={key}
                    onClick={() => insertEmailVariable(key)}
                    type="button"
                  >
                    {`{{${key}}}`}
                  </button>
                ))}
              </div>
            </section>
          )}

          {inspectorPanelId === 'history' && (
            <section className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Version history</p>
                <h2 className="mt-1 font-semibold">{history.length} versions</h2>
              </div>
              <ol className="space-y-2">
                {history.map((version) => (
                  <li className="rounded-md border border-white/10 p-3 text-xs" key={version.id}>
                    <div className="font-medium text-white">{version.label}</div>
                    <div className="mt-1 text-white/45">{version.timestamp}</div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {inspectorPanelId === 'issues' && (
            <section className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Publish blockers</p>
                <h2 className="mt-1 font-semibold">{issuePanelTitle}</h2>
              </div>
              <button
                className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-white/10 text-sm font-medium text-white/80 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canEdit || reviewState === 'checking'}
                onClick={() => void reviewCurrentDraft()}
                type="button"
              >
                <Eye className="size-4" />
                {reviewState === 'checking' ? 'Reviewing...' : 'Review current draft'}
              </button>
              {reviewState === 'error' && (
                <p className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-xs text-red-100">
                  Unable to review the current email draft.
                </p>
              )}
              {issuePanelIssues.length === 0 ? (
                <p className="rounded-md border border-emerald-400/30 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                  No publish blockers.
                </p>
              ) : (
                <ul className="space-y-2">
                  {issuePanelIssues.map((issue) => (
                    <li
                      className={`rounded-md border p-3 text-xs ${issueBadgeClassName(issue)}`}
                      key={validationIssueKey(issue)}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <strong>{issue.code}</strong>
                        <span className="uppercase tracking-wide">{issue.severity}</span>
                      </div>
                      <p className="mt-1 opacity-80">{issue.message}</p>
                      {issue.field && <p className="mt-2 font-mono opacity-60">{issue.field}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {inspectorPanelId === 'json' && (
            <section className="mt-6 space-y-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">Editor JSON</p>
                <h2 className="mt-1 font-semibold">Saved payload</h2>
              </div>
              <pre className="max-h-[42rem] overflow-auto rounded-md border border-white/10 bg-white/5 p-3 text-xs leading-5 text-white/75">
                {JSON.stringify(emailDocument, null, 2)}
              </pre>
            </section>
          )}
        </aside>

        {inspectorCollapsed && (
          <button
            aria-label="Open inspector"
            className="fixed bottom-4 right-4 z-20 inline-flex h-10 items-center gap-2 rounded-md border border-white/10 bg-neutral-950 px-3 text-sm font-medium text-white/80 shadow-2xl hover:bg-neutral-900 hover:text-white"
            onClick={() => setInspectorCollapsed(false)}
            type="button"
          >
            <PanelRightOpen className="size-4" />
            Inspector
          </button>
        )}
      </div>

      {previewOpen && <PreviewDrawer onClose={() => setPreviewOpen(false)} preview={preview} />}
    </section>
  );
}
