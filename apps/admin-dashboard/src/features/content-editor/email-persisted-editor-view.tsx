'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { Archive, Code, Copy, Eye, Palette, Pencil, RotateCcw, Save, Send } from 'lucide-react';
import { EmailEditor, type EmailEditorRef } from '@react-email/editor';
import { toast } from 'sonner';
import {
  type DropdownMenuItemConfig,
  EditorChrome,
  EditorLeftRail,
  type EditorMode,
  EditorTopBar,
  InsertPopoverButton,
} from '@tixkit/content-editor-shell';
import {
  applyEmailGlobalCssToHtml,
  normalizeEmailTemplateDocument,
  stripEmailGlobalCssFromHtml,
  validateEditorExport,
  validateEmailTemplate,
  type EmailTemplateDocument,
} from '@tixkit/content-email';
import type { ContentValidationIssue } from '@tixkit/content-core';
import { getTemplateLifecycle, type TemplateKey } from '@tixkit/domain';
import {
  adminApi,
  type AdminBrand,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminBrandSenderIdentity,
  type AdminEventDetail,
} from '@/lib/api';
import { usePermissions } from '@/context/permission-provider';
import {
  createBrandEmailEditorTheme,
  createEmailSlashCommands,
  useEmailEditorExtensions,
  variablePresentation,
} from './email-editor-extensions';
import { EmailCodeView } from './email/code-view';
import { EmailDialogs } from './email/dialogs';
import {
  ensureBulkUnsubscribeFooter,
  findVerifiedSenderIdentity,
  hasBlockingIssues,
  mergeValidationIssues,
  sampleContext,
  senderIdentityIssues,
  verifiedSenderIdentities,
  waitForReviewAnalysis,
} from './email/document-rules';
import {
  TixkitEmailBubbleMenu,
  emailBubbleHiddenNodes,
  emailBubbleMenuTrigger,
} from './email/bubble-menu';
import {
  defaultEmailDocument,
  duplicateDocumentName,
  latestDraft,
  latestVersion,
  listItemsFromResponse,
  previewFromEditorDocument,
  previewFromEmailOutput,
  resultMessage,
  versionSummaries,
} from './email/draft-utils';
import { EnvelopeHeader, applySenderIdentity } from './email/envelope-header';
import { InsertPalette } from './email/insert-palette';
import { PreviewDrawer, type EmailEditorPreview } from './email/preview-drawer';
import type { EmailThemePreset, StyleInspectorProps } from './email/style-inspector';
import {
  audienceLabel,
  emailVariableInserts,
  initialEditorContent,
  plainTextFromHtml,
  projectEditorTextToLegacyBlocks,
  scheduledAtFromInput,
  type EmailAudience,
  type EmailSendMode,
  withEditorExport,
} from './email/render-utils';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type EmailReviewState = 'idle' | 'checking' | 'checked' | 'error';
type EditorPreview = EmailEditorPreview;

type EmailTemplateChoice = AdminContentDocument;

const StyleInspector = dynamic<StyleInspectorProps>(
  () => import('./email/style-inspector').then((module) => module.StyleInspector),
  { ssr: false },
);

function themePresetButtonClass(active: boolean) {
  return [
    'rounded-md border px-2.5 py-1.5 text-xs font-medium capitalize transition-colors disabled:pointer-events-none disabled:opacity-50',
    active
      ? 'border-foreground/20 bg-accent text-accent-foreground'
      : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
  ].join(' ');
}

function textFromEditorJson(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { content?: unknown; text?: unknown; type?: unknown };
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return '';
  return node.content
    .map((child) => textFromEditorJson(child))
    .join(node.type === 'doc' ? '\n' : '');
}

function hasEmailCanvasContent(document: EmailTemplateDocument): boolean {
  const htmlText = plainTextFromHtml(document.editor.contentHtml ?? '');
  const jsonText = textFromEditorJson(document.editor.contentJson);
  return Boolean(
    document.editor.contentText?.trim() ||
    htmlText.trim() ||
    jsonText.trim() ||
    /<(?:img|hr)\b/i.test(document.editor.contentHtml ?? ''),
  );
}

function restoreDefaultCanvasContent(
  document: EmailTemplateDocument,
  event: AdminEventDetail,
  senderIdentity: AdminBrandSenderIdentity | undefined,
  templateKey: TemplateKey,
): EmailTemplateDocument {
  if (hasEmailCanvasContent(document)) return document;
  const defaultDocument = defaultEmailDocument(event, senderIdentity, templateKey);
  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml: defaultDocument.editor.contentHtml,
      contentText: defaultDocument.editor.contentText,
      contentJson: defaultDocument.editor.contentJson,
    },
    blocks: defaultDocument.blocks,
  };
}

export function EmailPersistedEditorView({
  eventId,
  returnHref,
  templateKey = 'order-confirmed',
}: {
  eventId: string;
  returnHref?: string;
  templateKey?: TemplateKey;
}) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [brand, setBrand] = React.useState<AdminBrand>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [emailDocument, setEmailDocument] = React.useState<EmailTemplateDocument>();
  const [senderIdentities, setSenderIdentities] = React.useState<AdminBrandSenderIdentity[]>([]);
  const [templateChoices, setTemplateChoices] = React.useState<EmailTemplateChoice[]>([]);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [editorRevision, setEditorRevision] = React.useState(0);
  const [audience, setAudience] = React.useState<EmailAudience>('all');
  const [sendMode, setSendMode] = React.useState<EmailSendMode>('now');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [reviewIssues, setReviewIssues] = React.useState<ContentValidationIssue[]>([]);
  const [reviewState, setReviewState] = React.useState<EmailReviewState>('idle');
  const [recipient, setRecipient] = React.useState('ada@example.test');
  const [preview, setPreview] = React.useState<EditorPreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = React.useState(false);
  const [testDialogOpen, setTestDialogOpen] = React.useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
  const [detailsDialogOpen, setDetailsDialogOpen] = React.useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = React.useState(false);
  const [jsonDialogOpen, setJsonDialogOpen] = React.useState(false);
  const [issuesBannerDismissed, setIssuesBannerDismissed] = React.useState(false);
  const [reviewConfirmed, setReviewConfirmed] = React.useState(false);
  const [emailThemePreset, setEmailThemePreset] = React.useState<EmailThemePreset>('brand');
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const editorCanvasRef = React.useRef<HTMLElement | null>(null);
  const operationIdRef = React.useRef(0);
  const emailEditorRef = React.useRef<EmailEditorRef | null>(null);
  const brandTheme = React.useMemo(
    () =>
      createBrandEmailEditorTheme({
        preset: emailThemePreset,
        primaryColor:
          typeof brand?.theme.primaryColor === 'string' ? brand.theme.primaryColor : undefined,
        fontFamily:
          typeof brand?.theme.fontFamily === 'string' ? brand.theme.fontFamily : undefined,
        radius:
          typeof brand?.theme.radius === 'string' || typeof brand?.theme.radius === 'number'
            ? brand.theme.radius
            : undefined,
      }),
    [brand?.theme.fontFamily, brand?.theme.primaryColor, brand?.theme.radius, emailThemePreset],
  );
  const emailExtensions = useEmailEditorExtensions({
    mergeTags: emailVariableInserts,
    theme: brandTheme,
  });
  const emailSlashCommands = React.useMemo(
    () =>
      createEmailSlashCommands({
        mergeTags: emailVariableInserts,
        brandName: brand?.name ?? event?.title ?? 'Tixkit',
      }),
    [brand?.name, event?.title],
  );
  const emailSlashCommand = React.useMemo(
    () => ({ items: emailSlashCommands }),
    [emailSlashCommands],
  );
  const uploadInlineEmailImage = React.useCallback(
    async (file: File): Promise<{ url: string }> => {
      if (!event?.brandId || !event.id) {
        throw new Error('Email image uploads require an event and brand context.');
      }
      const result = await adminApi.uploadArtifact({
        purpose: 'content_email_image',
        file,
        brandId: event.brandId,
        eventId: event.id,
        metadata: {
          source: 'admin_email_editor',
          contentDocumentId: document?.id,
          templateKey: emailDocument?.settings.templateKey,
        },
      });
      if (!result.ok) {
        throw new Error(resultMessage(result.error, 'Unable to upload email image'));
      }
      if (!result.data.downloadUrl) {
        throw new Error('Uploaded email image did not return a download URL.');
      }
      return { url: result.data.downloadUrl };
    },
    [document?.id, emailDocument?.settings.templateKey, event?.brandId, event?.id],
  );

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

    const senderIdentitiesResult = await adminApi.listBrandEmailSenderIdentities(
      loadedEvent.brandId,
    );
    if (!senderIdentitiesResult.ok) {
      setError(resultMessage(senderIdentitiesResult.error, 'Unable to load email senders'));
      setLoading(false);
      return;
    }
    const loadedSenderIdentities = listItemsFromResponse<AdminBrandSenderIdentity>(
      senderIdentitiesResult.data,
    ).filter((identity) => identity.brandId === loadedEvent.brandId);
    const defaultSenderIdentity = verifiedSenderIdentities(loadedSenderIdentities)[0];
    const brandsResult = await adminApi.listBrands();
    let loadedBrand: AdminBrand | undefined;
    if (brandsResult.ok) {
      loadedBrand = listItemsFromResponse<AdminBrand>(brandsResult.data).find(
        (candidateBrand) => candidateBrand.id === loadedEvent.brandId,
      );
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
      (item) =>
        item.channel === 'email' && item.eventId === loadedEvent.id && item.key === templateKey,
    );
    if (!loadedDocument) {
      const lifecycle = getTemplateLifecycle(templateKey);
      const createResult = await adminApi.createContentDocument({
        organizationId: loadedEvent.organizationId,
        brandId: loadedEvent.brandId,
        eventId: loadedEvent.id,
        channel: 'email',
        key: templateKey,
        name:
          templateKey === 'order-confirmed'
            ? `${loadedEvent.title} email template`
            : lifecycle?.name
              ? `${loadedEvent.title} ${lifecycle.name}`
              : `${loadedEvent.title} email template`,
        locale: 'en',
      });
      if (!createResult.ok) {
        setError(resultMessage(createResult.error, 'Unable to create email content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const templatesResult = await adminApi.listContentDocuments({
      channel: 'email',
      brandId: loadedEvent.brandId,
      limit: 100,
    });
    const loadedTemplateChoices = templatesResult.ok
      ? listItemsFromResponse<AdminContentDocument>(templatesResult.data).filter(
          (item) =>
            item.channel === 'email' &&
            item.brandId === loadedEvent.brandId &&
            item.id !== loadedDocument.id &&
            item.status !== 'archived',
        )
      : [];

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load email versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = defaultEmailDocument(loadedEvent, defaultSenderIdentity, templateKey);
      const saveResult = await adminApi.saveContentVersion(loadedDocument.id, {
        contentJson: initialDocument,
        subject: initialDocument.settings.subject,
        previewText: initialDocument.settings.previewText,
        renderedHtml: initialDocument.editor.contentHtml,
        renderedText: initialDocument.editor.contentText ?? '',
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
    const currentSenderIdentity = findVerifiedSenderIdentity(
      loadedSenderIdentities,
      normalized.settings.sender.fromEmail,
    );
    const normalizedWithSender = currentSenderIdentity
      ? applySenderIdentity(normalized, currentSenderIdentity)
      : normalized;
    const canvasDocument = restoreDefaultCanvasContent(
      normalizedWithSender,
      loadedEvent,
      currentSenderIdentity ?? defaultSenderIdentity,
      templateKey,
    );

    setEvent(loadedEvent);
    setBrand(loadedBrand);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setSenderIdentities(loadedSenderIdentities);
    setTemplateChoices(loadedTemplateChoices);
    setEmailDocument(canvasDocument);
    setPreview(previewFromEditorDocument('Editor snapshot', canvasDocument));
    setReviewIssues(
      mergeValidationIssues([
        ...validateEmailTemplate(canvasDocument, { provider: 'resend' }).issues,
        ...senderIdentityIssues(canvasDocument, loadedSenderIdentities),
      ]),
    );
    setReviewState('checked');
    setAutosave('saved');
    setLoading(false);
  }, [eventId, templateKey]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const isArchived = document?.status === 'archived';
  const { can } = usePermissions();
  const canEdit = !isArchived && can('messages.write');

  React.useEffect(() => {
    const canvas = editorCanvasRef.current;
    if (!canvas) return;
    const labelEmailBody = () => {
      const editor = canvas.querySelector<HTMLElement>(
        '[contenteditable="true"], [contenteditable=""], [role="textbox"]:not(input):not(textarea)',
      );
      editor?.setAttribute('aria-label', 'Email body');
    };
    labelEmailBody();
    const observer = new MutationObserver(labelEmailBody);
    observer.observe(canvas, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [draft?.id, emailDocument]);

  function updateEmailDocument(nextDocument: EmailTemplateDocument) {
    if (isArchived) return;
    setEmailDocument(nextDocument);
    markDraftDirty();
  }

  function applyEmailThemePreset(nextPreset: EmailThemePreset) {
    if (isArchived) return;
    if (nextPreset === emailThemePreset) return;
    setEmailThemePreset(nextPreset);
    setEditorRevision((current) => current + 1);
    markDraftDirty();
  }

  function updateCodeHtml(nextHtml: string) {
    if (!emailDocument || isArchived) return;
    const contentHtml = stripEmailGlobalCssFromHtml(nextHtml);
    const contentText = plainTextFromHtml(contentHtml);
    updateEmailDocument({
      ...emailDocument,
      editor: {
        ...emailDocument.editor,
        contentHtml,
        contentText,
        contentJson: undefined,
      },
      blocks: projectEditorTextToLegacyBlocks(emailDocument.blocks, contentText),
    });
  }

  async function copyCodeHtml() {
    if (!emailDocument) return;
    try {
      await navigator.clipboard.writeText(emailDocument.editor.contentHtml);
      setNotice('Copied email HTML');
      setActionError(undefined);
    } catch {
      setActionError('Unable to copy email HTML');
    }
  }

  async function snapshotFromEditor(
    snapshot = emailDocument,
  ): Promise<EmailTemplateDocument | undefined> {
    if (!snapshot) return undefined;
    const ref = emailEditorRef.current;
    if (!ref) {
      const contentHtml = applyEmailGlobalCssToHtml(
        stripEmailGlobalCssFromHtml(snapshot.editor.contentHtml),
        snapshot.editor.globalCss,
      );
      return contentHtml === snapshot.editor.contentHtml
        ? snapshot
        : { ...snapshot, editor: { ...snapshot.editor, contentHtml } };
    }
    const exported = await ref.getEmail();
    return withEditorExport(snapshot, {
      html: exported.html,
      text: exported.text,
      json: ref.getJSON() as Record<string, unknown>,
    });
  }

  async function reviewCurrentDraft(options: { analysisDelayMs?: number } = {}) {
    if (!emailDocument) return undefined;
    setReviewState('checking');
    let editorSnapshot: EmailTemplateDocument | undefined;
    try {
      await waitForReviewAnalysis(options.analysisDelayMs ?? 0);
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
      ...senderIdentityIssues(editorSnapshot, senderIdentities),
    ]);
    setEmailDocument(editorSnapshot);
    setReviewIssues(issues);
    setIssuesBannerDismissed(false);
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
    const validation = validateEmailTemplate(editorSnapshot, { provider: 'resend' });
    setReviewIssues(
      mergeValidationIssues([
        ...validation.issues,
        ...senderIdentityIssues(editorSnapshot, senderIdentities),
      ]),
    );
    setReviewState('checked');
    const result = await adminApi.saveContentVersion(document.id, {
      contentJson: editorSnapshot,
      subject: editorSnapshot.settings.subject,
      previewText: editorSnapshot.settings.previewText,
      renderedHtml: editorSnapshot.editor.contentHtml,
      renderedText: editorSnapshot.editor.contentText ?? '',
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
    setPreview(previewFromEditorDocument('Editor snapshot', editorSnapshot));
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

  async function handleModeChange(mode: EditorMode) {
    if (mode === editorMode) return;
    if (mode === 'preview') {
      setEditorMode(mode);
      void previewSavedDraft();
      return;
    }
    if (mode === 'editor') {
      if (editorMode === 'code') {
        setEditorRevision((current) => current + 1);
      }
      setEditorMode(mode);
      return;
    }
    if (mode !== 'code' || !emailDocument) {
      setEditorMode(mode);
      return;
    }
    try {
      const currentExport = await snapshotFromEditor(emailDocument);
      if (currentExport) setEmailDocument(currentExport);
      setEditorMode(mode);
    } catch (codeExportError) {
      setAutosave('error');
      setActionError(
        codeExportError instanceof Error ? codeExportError.message : 'Unable to export email',
      );
    }
  }

  async function openReviewDialog() {
    if (!document || !event || !emailDocument || isArchived) return;
    setActionError(undefined);
    setReviewConfirmed(false);
    setReviewDialogOpen(true);
    if (audience === 'specific') {
      setAutosave('error');
      setActionError('Choose an audience with an available recipient selection.');
      return;
    }
    const review = await reviewCurrentDraft({ analysisDelayMs: 220 });
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email review blockers before sending.');
      return;
    }
    const sendAt = scheduledAtFromInput(sendMode, scheduledAt);
    if (sendMode === 'scheduled' && !sendAt) {
      setAutosave('error');
      setActionError('Choose a valid scheduled send time.');
      return;
    }
    setActionError(undefined);
  }

  async function publishDraft() {
    if (!document || !event || !emailDocument || isArchived) return;
    if (audience === 'specific') {
      setAutosave('error');
      setActionError('Choose an audience with an available recipient selection.');
      setReviewDialogOpen(true);
      return;
    }
    const review = await reviewCurrentDraft();
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email review blockers before sending.');
      setReviewDialogOpen(true);
      return;
    }
    const sendAt = scheduledAtFromInput(sendMode, scheduledAt);
    if (sendMode === 'scheduled' && !sendAt) {
      setAutosave('error');
      setActionError('Choose a valid scheduled send time.');
      setReviewDialogOpen(false);
      return;
    }
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, review.document);
    if (!saved) return;
    const publishResult = await adminApi.publishContentVersion(document.id, saved.version.id);
    if (!isCurrentOperation(operationId)) return;
    if (!publishResult.ok) {
      setAutosave('error');
      setActionError(resultMessage(publishResult.error, 'Unable to prepare email campaign'));
      return;
    }
    const sendResult = await adminApi.sendMessage(event.id, {
      channel: 'email',
      emailTemplateKey: saved.document.settings.templateKey,
      audience,
      scheduledAt: sendAt,
    });
    if (!isCurrentOperation(operationId)) return;
    if (!sendResult.ok) {
      setAutosave('error');
      setActionError(resultMessage(sendResult.error, 'Unable to create email campaign'));
      return;
    }
    setReviewDialogOpen(false);
    setReviewConfirmed(false);
    setDocument(publishResult.data.document);
    setDraft(publishResult.data.version);
    setVersions((current) => [
      publishResult.data.version,
      ...current.filter((version) => version.id !== publishResult.data.version.id),
    ]);
    setActionError(undefined);
    setNotice(
      sendAt
        ? `Scheduled ${audienceLabel(audience).toLowerCase()} for ${new Date(sendAt).toLocaleString()}`
        : `Queued ${audienceLabel(audience).toLowerCase()}`,
    );
    toast.success(sendAt ? 'Email campaign scheduled' : 'Email campaign queued');
  }

  async function sendTest() {
    if (!document || !emailDocument || isArchived) return;
    const recipients = recipient
      .split(/[\n,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      setAutosave('error');
      setActionError('Enter at least one test recipient.');
      return;
    }
    const review = await reviewCurrentDraft();
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email test-send blockers before sending a test.');
      setReviewDialogOpen(true);
      return;
    }
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, review.document);
    if (!saved) return;
    const testSendResults = await Promise.all(
      recipients.map((testRecipient) =>
        adminApi.testSendContent(document.id, {
          versionId: saved.version.id,
          recipient: testRecipient,
          context: event ? sampleContext(event) : undefined,
        }),
      ),
    );
    if (!isCurrentOperation(operationId)) return;
    const capturedRecipients: string[] = [];
    for (const result of testSendResults) {
      if (!result.ok) {
        setAutosave('error');
        setActionError(resultMessage(result.error, 'Unable to capture email test send'));
        return;
      }
      capturedRecipients.push(result.data.testSend.recipient);
    }
    if (!isCurrentOperation(operationId)) return;
    setTestDialogOpen(false);
    setActionError(undefined);
    setNotice(
      capturedRecipients.length === 1
        ? `Captured test send to ${capturedRecipients[0]}`
        : `Captured ${capturedRecipients.length} test sends`,
    );
    toast.success('Email test send captured');
  }

  async function applyTemplateChoice(template: EmailTemplateChoice) {
    if (!event || !emailDocument || isArchived) return;
    setActionError(undefined);
    const versionsResult = await adminApi.listContentVersions(template.id);
    if (!versionsResult.ok) {
      setAutosave('error');
      setActionError(resultMessage(versionsResult.error, 'Unable to load template versions'));
      return;
    }
    const templateVersion = latestVersion(
      listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data),
    );
    if (!templateVersion) {
      setAutosave('error');
      setActionError('Selected template has no saved versions.');
      return;
    }
    const templateDocument = normalizeEmailTemplateDocument(templateVersion.contentJson);
    if (!templateDocument) {
      setAutosave('error');
      setActionError('Selected template is not canonical React Email JSON.');
      return;
    }
    const nextDocument = ensureBulkUnsubscribeFooter({
      ...templateDocument,
      settings: {
        ...templateDocument.settings,
        sender: emailDocument.settings.sender,
      },
    });
    setEmailDocument(nextDocument);
    setPreview(previewFromEditorDocument('Editor snapshot', nextDocument));
    setEditorMode('editor');
    setEditorRevision((current) => current + 1);
    setTemplatePickerOpen(false);
    markDraftDirty();
    setNotice(`Applied template ${template.name}`);
  }

  function resetToStudioDefault() {
    if (!event || !emailDocument || isArchived) return;
    const currentTemplateKey = emailDocument.settings.templateKey as TemplateKey;
    const lifecycle = getTemplateLifecycle(currentTemplateKey);
    if (!lifecycle) {
      setAutosave('error');
      setActionError('This document is not tied to a lifecycle email default.');
      return;
    }
    const defaultDocument = defaultEmailDocument(event, selectedSenderIdentity, currentTemplateKey);
    const nextDocument = ensureBulkUnsubscribeFooter({
      ...defaultDocument,
      settings: {
        ...defaultDocument.settings,
        sender: emailDocument.settings.sender,
      },
    });
    setEmailDocument(nextDocument);
    setPreview(previewFromEditorDocument('Editor snapshot', nextDocument));
    setEditorMode('editor');
    setEditorRevision((current) => current + 1);
    setActionError(undefined);
    markDraftDirty();
    setNotice(`Reset to the Studio default for ${lifecycle.name}`);
  }

  async function archiveDocument() {
    if (!document) return;
    if (
      !window.confirm(
        'Archive this email template? Editing, review, previews, and test sends will be disabled.',
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
      <div className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading email editor...
      </div>
    );
  }

  if (error || !event || !document || !draft || !emailDocument || !preview) {
    return (
      <section className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Email template editor</p>
            <h1 className="text-2xl font-semibold">Unable to load editor</h1>
          </div>
          <p className="text-sm text-destructive">{error ?? 'Email editor could not load.'}</p>
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

  const archivedReason = isArchived ? 'Archived templates are read-only.' : undefined;
  const history = versionSummaries(versions);
  const verifiedSenders = verifiedSenderIdentities(senderIdentities);
  const selectedSenderIdentity = findVerifiedSenderIdentity(
    senderIdentities,
    emailDocument.settings.sender.fromEmail,
  );

  const moreActionsItems: DropdownMenuItemConfig[] = [
    {
      id: 'save',
      label: 'Save draft',
      icon: <Save className="size-4" />,
      onClick: () => void saveDraft(),
      disabled: Boolean(archivedReason) || autosave === 'saving',
    },
    {
      id: 'studio-default',
      label: 'Reset to Studio default',
      icon: <RotateCcw className="size-4" />,
      onClick: resetToStudioDefault,
      disabled: Boolean(archivedReason),
      separatorAfter: true,
    },
    {
      id: 'test',
      label: 'Send test email',
      icon: <Send className="size-4" />,
      onClick: () => setTestDialogOpen(true),
      disabled: Boolean(archivedReason),
    },
    {
      id: 'preview',
      label: 'Preview rendered HTML/text',
      icon: <Eye className="size-4" />,
      onClick: () => setPreviewOpen(true),
    },
    {
      id: 'templates',
      label: 'Switch template',
      icon: <Copy className="size-4" />,
      onClick: () => setTemplatePickerOpen(true),
      disabled: Boolean(archivedReason) || templateChoices.length === 0,
    },
    {
      id: 'theme-preset',
      label: 'Theme preset',
      icon: <Palette className="size-4" />,
      onClick: () => {},
      disabled: Boolean(archivedReason),
      separatorAfter: true,
      activeChildId: emailThemePreset,
      children: [
        {
          id: 'brand',
          label: 'Brand',
          onClick: () => applyEmailThemePreset('brand'),
          disabled: Boolean(archivedReason),
        },
        {
          id: 'minimal',
          label: 'Minimal',
          onClick: () => applyEmailThemePreset('minimal'),
          disabled: Boolean(archivedReason),
        },
        {
          id: 'basic',
          label: 'Basic',
          onClick: () => applyEmailThemePreset('basic'),
          disabled: Boolean(archivedReason),
        },
      ],
    },
    {
      id: 'history',
      label: 'Version history',
      icon: <Copy className="size-4" />,
      onClick: () => setHistoryDialogOpen(true),
    },
    {
      id: 'details',
      label: 'Details',
      icon: <Code className="size-4" />,
      onClick: () => setDetailsDialogOpen(true),
      separatorAfter: true,
    },
    {
      id: 'json',
      label: 'View JSON',
      icon: <Code className="size-4" />,
      onClick: () => setJsonDialogOpen(true),
    },
    {
      id: 'review',
      label: 'Review blockers',
      icon: <Eye className="size-4" />,
      onClick: () => void openReviewDialog(),
      disabled: reviewState === 'checking',
      separatorAfter: true,
    },
    {
      id: 'duplicate',
      label: 'Duplicate',
      icon: <Copy className="size-4" />,
      onClick: () => void duplicateDocument(),
      disabled: Boolean(archivedReason),
    },
    {
      id: 'archive',
      label: 'Archive',
      icon: <Archive className="size-4" />,
      onClick: () => void archiveDocument(),
      destructive: true,
    },
  ];
  const reviewBlockingIssues = reviewIssues.filter((issue) => issue.severity === 'error');
  const reviewWarningIssues = reviewIssues.filter((issue) => issue.severity !== 'error');
  const reviewScheduledAt = scheduledAtFromInput(sendMode, scheduledAt);
  const reviewHasInvalidSchedule = sendMode === 'scheduled' && !reviewScheduledAt;
  const reviewIsAnalyzing = reviewState === 'checking';
  const reviewAnalysisFailed = reviewState === 'error';
  const reviewCanConfirm =
    reviewState === 'checked' &&
    reviewBlockingIssues.length === 0 &&
    !reviewHasInvalidSchedule &&
    autosave !== 'saving';
  const variableInsertItems = emailVariableInserts.map((key) => ({
    key,
    presentation: variablePresentation(key),
  }));
  const paletteComponentItems = emailSlashCommands.filter(
    (item) =>
      item.category !== 'Variables' &&
      item.title !== 'Image upload' &&
      item.title !== 'Variable' &&
      item.title !== 'Text' &&
      item.title !== 'Image',
  );
  const paletteVariableItems = variableInsertItems.map(({ key, presentation }) => ({
    key,
    label: presentation.label,
    preview: presentation.preview,
    kind: presentation.kind,
  }));
  const issueBannerIssues =
    reviewState === 'checked'
      ? reviewBlockingIssues
      : draft.validation.issues.filter((issue) => issue.severity === 'error');
  const showIssueBanner = issueBannerIssues.length > 0 && !issuesBannerDismissed;
  const modeToggle = (
    <div
      aria-label="Editor mode"
      className="inline-flex h-9 overflow-hidden rounded-md border bg-background p-0.5"
    >
      {[
        { mode: 'editor' as const, label: 'Editor', icon: <Pencil className="size-4" /> },
        { mode: 'code' as const, label: 'Code', icon: <Code className="size-4" /> },
      ].map((item) => (
        <button
          aria-label={item.label}
          aria-pressed={editorMode === item.mode}
          className={`inline-flex items-center gap-1.5 rounded px-2.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${
            editorMode === item.mode
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          disabled={editorMode === item.mode}
          key={item.mode}
          onClick={() => void handleModeChange(item.mode)}
          type="button"
        >
          {item.icon}
          <span className="hidden sm:inline">{item.label}</span>
        </button>
      ))}
    </div>
  );
  const leftRailTools = (
    <>
      {editorMode === 'editor' ? (
        <InsertPalette
          components={paletteComponentItems}
          disabled={!canEdit}
          editorRef={emailEditorRef}
          onInsert={markDraftDirty}
          onUploadImage={uploadInlineEmailImage}
          variables={paletteVariableItems}
        />
      ) : null}
      <InsertPopoverButton disabled={!canEdit} icon={<Palette className="size-4" />} label="Theme">
        <div className="space-y-3 p-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Email theme
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Apply a preset to the current template.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['brand', 'minimal', 'basic'] as const).map((preset) => (
              <button
                aria-pressed={emailThemePreset === preset}
                className={themePresetButtonClass(emailThemePreset === preset)}
                disabled={!canEdit}
                key={preset}
                onClick={() => applyEmailThemePreset(preset)}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
      </InsertPopoverButton>
      <InsertPopoverButton
        disabled={!canEdit}
        icon={<Code className="size-4" />}
        label="Global CSS"
      >
        <div className="space-y-2 p-2">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Global CSS
            <textarea
              aria-label="Global CSS"
              className="mt-2 min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              disabled={!canEdit}
              onChange={(change) =>
                updateEmailDocument({
                  ...emailDocument,
                  editor: {
                    ...emailDocument.editor,
                    globalCss: change.currentTarget.value,
                  },
                })
              }
              placeholder=".email-root { }"
              value={emailDocument.editor.globalCss ?? ''}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Scoped CSS is applied to rendered email HTML before preview, test, and publish.
          </p>
        </div>
      </InsertPopoverButton>
    </>
  );

  return (
    <EditorChrome
      channel="email"
      testId="content-editor-shell"
      topBar={
        <EditorTopBar
          autosave={autosave}
          backHref={returnHref ?? `/events/${event.id}`}
          channelLabel="Email"
          documentName={document.name}
          error={actionError}
          moreActions={moreActionsItems}
          notice={notice}
          onPublish={() => void openReviewDialog()}
          publishDisabled={Boolean(archivedReason)}
          publishLabel="Publish"
          secondaryActions={modeToggle}
          status={document.status}
        />
      }
      leftRail={
        <EditorLeftRail
          hiddenModes={{ code: true, editor: true, preview: true }}
          insertsDisabled={!canEdit}
          mode={editorMode}
          onModeChange={(mode) => void handleModeChange(mode)}
          inserts={leftRailTools}
        />
      }
      inspector={null}
      canvas={
        <section
          aria-label="email template editable document"
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/30 lg:mr-80 xl:mr-[22rem]"
          data-testid="editor-canvas"
          ref={editorCanvasRef}
        >
          {showIssueBanner && (
            <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100 sm:px-6">
              <div className="mx-auto flex w-full max-w-[860px] items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">
                    {issueBannerIssues.length === 1
                      ? 'Resolve 1 required field before publishing.'
                      : `Resolve ${issueBannerIssues.length} required fields before publishing.`}
                  </div>
                  <p className="mt-0.5 truncate text-xs opacity-80">
                    {issueBannerIssues[0]?.message}
                  </p>
                </div>
                <button
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-red-100 dark:hover:bg-red-900/40"
                  onClick={() => setIssuesBannerDismissed(true)}
                  type="button"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <div className="mx-auto min-h-full w-full max-w-[860px] px-5 py-6 sm:px-6">
            <EnvelopeHeader
              disabled={!canEdit}
              emailDocument={emailDocument}
              onChange={updateEmailDocument}
              senderIdentities={verifiedSenders}
            />

            <div className="relative mt-6">
              {editorMode === 'code' ? (
                <EmailCodeView
                  canEdit={canEdit}
                  emailDocument={emailDocument}
                  onCopyHtml={() => void copyCodeHtml()}
                  onGlobalCssChange={(globalCss) =>
                    updateEmailDocument({
                      ...emailDocument,
                      editor: {
                        ...emailDocument.editor,
                        globalCss,
                      },
                    })
                  }
                  onHtmlChange={updateCodeHtml}
                />
              ) : (
                <>
                  <EmailEditor
                    bubbleMenu={{
                      hideWhenActiveNodes: emailBubbleHiddenNodes,
                      placement: 'top',
                      offset: 18,
                      trigger: emailBubbleMenuTrigger,
                      children: <TixkitEmailBubbleMenu />,
                    }}
                    className="tixkit-react-email-editor mx-auto w-full max-w-[600px] rounded-lg bg-white shadow-sm ring-1 ring-border/50 dark:bg-zinc-950"
                    content={initialEditorContent(emailDocument)}
                    editable={canEdit}
                    extensions={emailExtensions}
                    key={`${draft.id}:${editorRevision}`}
                    onUploadImage={uploadInlineEmailImage}
                    slashCommand={emailSlashCommand}
                    onUpdate={(ref) => {
                      emailEditorRef.current = ref;
                      markDraftDirty();
                    }}
                    onReady={(ref) => {
                      emailEditorRef.current = ref;
                    }}
                    placeholder="Write the email..."
                    ref={emailEditorRef}
                    theme={brandTheme}
                  >
                    <StyleInspector />
                  </EmailEditor>
                </>
              )}
            </div>
          </div>
        </section>
      }
    >
      {previewOpen && <PreviewDrawer onClose={() => setPreviewOpen(false)} preview={preview} />}
      <EmailDialogs
        audience={audience}
        autosave={autosave}
        brand={brand}
        canEdit={canEdit}
        detailsDialogOpen={detailsDialogOpen}
        document={document}
        emailDocument={emailDocument}
        event={event}
        history={history}
        historyDialogOpen={historyDialogOpen}
        jsonDialogOpen={jsonDialogOpen}
        onApplyTemplate={(template) => void applyTemplateChoice(template)}
        onAudienceChange={setAudience}
        onDetailsDialogOpenChange={setDetailsDialogOpen}
        onHistoryDialogOpenChange={setHistoryDialogOpen}
        onJsonDialogOpenChange={setJsonDialogOpen}
        onPublish={() => void publishDraft()}
        onRecipientChange={setRecipient}
        onReviewConfirmedChange={setReviewConfirmed}
        onReviewDialogOpenChange={setReviewDialogOpen}
        onScheduledAtChange={setScheduledAt}
        onSendModeChange={setSendMode}
        onSendTest={() => void sendTest()}
        onTemplatePickerOpenChange={setTemplatePickerOpen}
        onTestDialogOpenChange={setTestDialogOpen}
        recipient={recipient}
        reviewAnalysisFailed={reviewAnalysisFailed}
        reviewBlockingIssues={reviewBlockingIssues}
        reviewCanConfirm={reviewCanConfirm}
        reviewConfirmed={reviewConfirmed}
        reviewDialogOpen={reviewDialogOpen}
        reviewHasInvalidSchedule={reviewHasInvalidSchedule}
        reviewIsAnalyzing={reviewIsAnalyzing}
        reviewState={reviewState}
        reviewWarningIssues={reviewWarningIssues}
        scheduledAt={scheduledAt}
        selectedSenderIdentity={selectedSenderIdentity}
        sendMode={sendMode}
        templateChoices={templateChoices}
        templatePickerOpen={templatePickerOpen}
        testDialogOpen={testDialogOpen}
      />
    </EditorChrome>
  );
}
