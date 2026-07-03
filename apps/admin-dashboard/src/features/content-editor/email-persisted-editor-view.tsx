'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Code,
  Copy,
  Eye,
  Image,
  Palette,
  PanelRightClose,
  Save,
  Send,
  Variable,
} from 'lucide-react';
import { EmailEditor, type EmailEditorProps, type EmailEditorRef } from '@react-email/editor';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BubbleMenu,
  EditorFocusScope,
  Inspector,
  type TriggerFn,
} from '@react-email/editor/ui';
import { NodeSelection } from '@tiptap/pm/state';
import { useCurrentEditor, useEditorState } from '@tiptap/react';
import { toast } from 'sonner';
import {
  type DropdownMenuItemConfig,
  EditorChrome,
  EditorLeftRail,
  type EditorMode,
  EditorTopBar,
  InspectorPanel,
  InspectorReopenButton,
  MetadataBar,
  MetadataField,
  inputClassName,
} from '@tixkit/content-editor-shell';
import {
  REACT_EMAIL_EDITOR_PACKAGE,
  applyEmailGlobalCssToHtml,
  createDefaultEmailTemplate,
  normalizeEmailTemplateDocument,
  stripEmailGlobalCssFromHtml,
  validateEditorExport,
  validateEmailTemplate,
  type EmailTemplateDocument,
} from '@tixkit/content-email';
import { MERGE_TAG_REGISTRY, getTemplateLifecycle } from '@tixkit/domain';
import type { ContentValidationIssue } from '@tixkit/content-core';
import {
  adminApi,
  type AdminBrand,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminContentRenderOutput,
  type AdminBrandSenderIdentity,
  type AdminEventDetail,
  type SendMessageInput,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  applyMergeTagPreviewsToEditorContent,
  createBrandEmailEditorTheme,
  createEmailSlashCommands,
  mergeTagCanvasAttributeValue,
  mergeTagLiteral,
  sanitizeEmailFontFamily,
  tixkitInlineStyleMarkName,
  tixkitMergeTagMarkName,
  useEmailEditorExtensions,
  variablePresentation,
} from './email-editor-extensions';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type EmailReviewState = 'idle' | 'checking' | 'checked' | 'error';
type EmailInspectorPanelId = 'style' | 'variables' | 'details' | 'history' | 'issues' | 'json';
type EmailAudience = SendMessageInput['audience'];
type EmailSendMode = 'now' | 'scheduled';
type EmailThemePreset = 'brand' | 'minimal' | 'basic';

type EditorPreview = {
  label: string;
  output: string;
  format: 'html' | 'text';
};

type EmailTemplateChoice = AdminContentDocument;
const fallbackEmailVariableInserts = [
  'event.title',
  'event.startsAt',
  'event.endsAt',
  'event.timezone',
  'event.venueName',
  'event.venueCity',
  'event.checkoutUrl',
  'event.publicUrl',
  'brand.name',
  'brand.supportUrl',
  'recipient.name',
  'recipient.email',
  'recipient.phone',
  'attendee.name',
  'attendee.checkedIn',
  'ticket.type',
  'ticket.code',
  'ticket.qrCodeUrl',
  'order.id',
  'order.total',
  'refund.amount',
  'review.platform',
];

const emailVariableInserts =
  Array.isArray(MERGE_TAG_REGISTRY) && MERGE_TAG_REGISTRY.length > 0
    ? MERGE_TAG_REGISTRY.map((variable) => variable.key)
    : fallbackEmailVariableInserts;

const emailCategoryOptions = ['transactional', 'bulk', 'staff', 'system'] as const;

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
  const brandName = event.title.trim() || 'Event';
  return {
    event: {
      title: event.title,
      startsAt: event.startsAt,
      venueName: 'Radius Chicago',
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
      publicUrl: `https://events.example.test/e/${event.id}`,
    },
    brand: {
      name: brandName,
      supportUrl: `https://events.example.test/e/${event.id}/preferences`,
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    },
    ticket: {
      type: 'General Admission',
      code: 'TKT-123',
      qrCodeUrl: 'https://tickets.example.test/qr/preview.png',
    },
    order: {
      id: 'ord_preview_123',
      total: '$35.00',
    },
  };
}

type EmailBubbleSelectionState = {
  cursor?: number;
  from: number;
  key: string | null;
  nodeName?: string;
  scope?: 'node' | 'row' | 'text';
  style?: {
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    lineHeight?: string;
  };
  to: number;
};

type EmailSelectionRestoreDetail = EmailBubbleSelectionState & {
  focusEditor?: boolean;
};

type EmailSelectionFormatDetail = {
  alignment?: 'left' | 'center' | 'right';
  patch?: {
    color?: string;
    fontFamily?: string;
    fontSize?: string;
    lineHeight?: string;
  };
  selection?: EmailBubbleSelectionState;
};

const emailBubbleHiddenNodes = ['horizontalRule'];
const emailBubbleNodeSelectionNodes = ['button', 'image', 'section', 'columnsColumn'];
const emailBubbleControlFocusWindowMs = 2500;
const emailBubbleControlSelector =
  '[data-tixkit-email-bubble-controls="true"], .tixkit-email-bubble-control';
const emailBubbleControlUntilAttribute = 'data-tixkit-email-bubble-control-until';
let lastEmailBubbleControlInteractionAt = 0;
let latestEmailBubbleSelection: EmailBubbleSelectionState | null = null;

function emailBubbleInteractionTime(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function markEmailBubbleControlInteraction() {
  lastEmailBubbleControlInteractionAt = emailBubbleInteractionTime();
  globalThis.document?.documentElement.setAttribute(
    emailBubbleControlUntilAttribute,
    String(Date.now() + emailBubbleControlFocusWindowMs),
  );
}

function hasRecentEmailBubbleControlInteraction(): boolean {
  const sharedUntil = Number(
    globalThis.document?.documentElement.getAttribute(emailBubbleControlUntilAttribute) ?? '0',
  );
  return (
    emailBubbleInteractionTime() - lastEmailBubbleControlInteractionAt <
      emailBubbleControlFocusWindowMs ||
    Date.now() < sharedUntil
  );
}

function emailBubbleControlTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(emailBubbleControlSelector) : null;
}

function rememberEmailBubbleSelection(selection: EmailBubbleSelectionState | null) {
  latestEmailBubbleSelection = selection;
}

function currentEmailBubbleSelection(
  selection: EmailBubbleSelectionState | null,
  refSelection: EmailBubbleSelectionState | null,
): EmailBubbleSelectionState | null {
  return selection ?? refSelection ?? latestEmailBubbleSelection;
}

const emailBubbleMenuTrigger: TriggerFn = ({ editor, state }) => {
  const { selection } = state;
  if (
    selection instanceof NodeSelection &&
    emailBubbleHiddenNodes.includes(selection.node.type.name)
  ) {
    return false;
  }
  if (
    selection instanceof NodeSelection &&
    emailBubbleNodeSelectionNodes.includes(selection.node.type.name)
  ) {
    return true;
  }
  if (hasRecentEmailBubbleControlInteraction() && latestEmailBubbleSelection) {
    return true;
  }
  if (selection.empty) {
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if (emailBubbleNodeSelectionNodes.includes($from.node(depth).type.name)) return true;
    }
  }

  for (const nodeName of emailBubbleHiddenNodes) {
    if (editor.isActive(nodeName)) return false;
    const { $from } = selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name === nodeName) return false;
    }
  }

  if (editor.isActive('link')) return false;
  if (selection.content().size > 0) return true;
  if (!selection.empty) return false;

  const activeElement = editor.view.dom.ownerDocument.activeElement;
  const focusIsInBubbleMenu =
    activeElement instanceof HTMLElement && Boolean(activeElement.closest('[data-re-bubble-menu]'));
  if (
    !editor.view.hasFocus() &&
    !focusIsInBubbleMenu &&
    !hasRecentEmailBubbleControlInteraction()
  ) {
    return false;
  }

  const parent = selection.$from.parent;
  return parent.inlineContent && parent.content.size > 0;
};

function inlineControlValue(value: string | undefined, suffix: 'px' | '%'): string {
  if (!value) return '';
  return value.replace(new RegExp(`${suffix}$`, 'i'), '');
}

const emailBubbleFontOptions = [
  { label: 'Brand default', value: '' },
  { label: 'Inter', value: 'Inter, Arial, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: 'Times New Roman, Times, serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Mono', value: 'Courier New, Courier, monospace' },
] as const;

function isEmailBubbleSelectionState(value: unknown): value is EmailBubbleSelectionState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EmailBubbleSelectionState>;
  return typeof candidate.from === 'number' && typeof candidate.to === 'number';
}

function TixkitEmailBubbleMenu() {
  const { editor } = useCurrentEditor();
  const [nodeSelectorOpen, setNodeSelectorOpen] = React.useState(false);
  const [linkSelectorOpen, setLinkSelectorOpen] = React.useState(false);
  const [selection, setSelection] = React.useState<EmailBubbleSelectionState | null>(null);
  const variableSelectKeyRef = React.useRef<string | null>(null);
  const lastSelectionRef = React.useRef<EmailBubbleSelectionState | null>(null);
  const isCodeActive = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => activeEditor?.isActive('code') ?? false,
  });

  // The BubbleMenu from @tiptap/react portals to document.body, so the
  // library's EditorFocusScope (Radix Slot) never attaches to the actual
  // [data-re-bubble-menu] element. Register it as a focus scope manually so
  // the FocusScopes extension skips clearing the selection on focusout.
  React.useEffect(() => {
    if (!editor) return;
    const focusScope = editor.extensionStorage?.focusScope;
    if (!focusScope?.registerScope) return;

    let registeredEl: HTMLElement | null = null;
    let observer: MutationObserver | null = null;

    const tryRegister = () => {
      const bubbleEl = document.querySelector<HTMLElement>('[data-re-bubble-menu]');
      if (bubbleEl && bubbleEl !== registeredEl) {
        if (registeredEl) focusScope.unregisterScope(registeredEl);
        focusScope.registerScope(bubbleEl);
        registeredEl = bubbleEl;
      }
    };

    tryRegister();

    observer = new MutationObserver(() => tryRegister());
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      if (registeredEl) focusScope.unregisterScope(registeredEl);
    };
  }, [editor]);

  React.useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return undefined;
    const handleSelectionState = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isEmailBubbleSelectionState(detail)) {
        lastSelectionRef.current = detail;
        rememberEmailBubbleSelection(detail);
        setSelection(detail);
        return;
      }
      if (hasRecentEmailBubbleControlInteraction()) {
        setSelection(currentEmailBubbleSelection(null, lastSelectionRef.current));
        return;
      }
      lastSelectionRef.current = null;
      rememberEmailBubbleSelection(null);
      setSelection(null);
    };
    dom.addEventListener('tixkit-email-selection-state', handleSelectionState);
    const handleSelectionClear = () => {
      lastSelectionRef.current = null;
      rememberEmailBubbleSelection(null);
      setSelection(null);
    };
    dom.addEventListener('tixkit-email-selection-clear', handleSelectionClear);
    // Direct listener for variable selection (from chip clicks) — bypasses
    // the plugin state chain to reliably set selection.key.
    const handleVariableSelect = (event: Event) => {
      const detail = (event as CustomEvent<{ from: number; key: string; to: number }>).detail;
      if (!detail || typeof detail.from !== 'number' || typeof detail.to !== 'number') return;
      variableSelectKeyRef.current = detail.key;
      // Don't call setSelection here — handleSelectionState already sets
      // selection with the correct style info. We only set the ref as a
      // fallback for the render condition when selection.key is null.
      lastSelectionRef.current = {
        cursor: detail.from + 1,
        from: detail.from,
        key: detail.key,
        scope: 'text',
        to: detail.to,
      };
      rememberEmailBubbleSelection(lastSelectionRef.current);
    };
    dom.addEventListener('tixkit-email-variable-select', handleVariableSelect);
    const handleSelectionClearWithRef = () => {
      variableSelectKeyRef.current = null;
    };
    dom.addEventListener('tixkit-email-selection-clear', handleSelectionClearWithRef);
    return () => {
      dom.removeEventListener('tixkit-email-selection-state', handleSelectionState);
      dom.removeEventListener('tixkit-email-selection-clear', handleSelectionClear);
      dom.removeEventListener('tixkit-email-selection-clear', handleSelectionClearWithRef);
      dom.removeEventListener('tixkit-email-variable-select', handleVariableSelect);
    };
  }, [editor]);

  const dispatchSelectionRestore = React.useCallback(
    (currentSelection: EmailBubbleSelectionState) => {
      lastSelectionRef.current = currentSelection;
      rememberEmailBubbleSelection(currentSelection);
      editor?.view.dom.dispatchEvent(
        new CustomEvent('tixkit-email-selection-restore', {
          bubbles: true,
          detail: {
            ...currentSelection,
            focusEditor: false,
          } satisfies EmailSelectionRestoreDetail,
        }),
      );
    },
    [editor],
  );

  const dispatchSelectionFormat = React.useCallback(
    (detail: EmailSelectionFormatDetail) => {
      const currentSelection = currentEmailBubbleSelection(selection, lastSelectionRef.current);
      if (currentSelection) {
        markEmailBubbleControlInteraction();
        dispatchSelectionRestore(currentSelection);
      }
      editor?.view.dom.dispatchEvent(
        new CustomEvent('tixkit-email-selection-format', {
          bubbles: true,
          cancelable: true,
          detail: currentSelection ? { ...detail, selection: currentSelection } : detail,
        }),
      );
      if (currentSelection) {
        window.requestAnimationFrame(() => dispatchSelectionRestore(currentSelection));
        window.setTimeout(() => dispatchSelectionRestore(currentSelection), 0);
        window.setTimeout(() => dispatchSelectionRestore(currentSelection), 60);
      }
    },
    [dispatchSelectionRestore, editor, selection],
  );

  const formatCurrentSelection = React.useCallback(
    (detail: EmailSelectionFormatDetail) => {
      markEmailBubbleControlInteraction();
      const currentSelection = currentEmailBubbleSelection(selection, lastSelectionRef.current);
      if (currentSelection) {
        dispatchSelectionRestore(currentSelection);
      }
      dispatchSelectionFormat(detail);
    },
    [dispatchSelectionFormat, dispatchSelectionRestore, selection],
  );

  const handleNodeSelectorOpenChange = React.useCallback((open: boolean) => {
    setNodeSelectorOpen(open);
    if (open) setLinkSelectorOpen(false);
  }, []);

  const handleLinkSelectorOpenChange = React.useCallback((open: boolean) => {
    setLinkSelectorOpen(open);
    if (open) setNodeSelectorOpen(false);
  }, []);

  const restoreBubbleSelection = React.useCallback(() => {
    markEmailBubbleControlInteraction();
    const currentSelection = currentEmailBubbleSelection(selection, lastSelectionRef.current);
    if (!editor || !currentSelection) return;
    const restore = () => {
      dispatchSelectionRestore(currentSelection);
    };
    restore();
    window.requestAnimationFrame(restore);
    window.setTimeout(restore, 0);
  }, [dispatchSelectionRestore, editor, selection]);

  const toggleVariableMenu = React.useCallback(() => {
    // Only restore bubble selection if we don't have a variable select key
    // from a recent chip click (which would be overridden by the restore).
    if (!variableSelectKeyRef.current) restoreBubbleSelection();
    editor?.view.dom.dispatchEvent(
      new CustomEvent('tixkit-email-variable-menu-open', {
        bubbles: true,
        cancelable: true,
        detail: { mode: 'toggle' },
      }),
    );
  }, [editor, restoreBubbleSelection]);

  React.useEffect(() => {
    const dom = editor?.view.dom;
    const ownerDocument = dom?.ownerDocument;
    if (!dom || !ownerDocument) return undefined;

    const handleNativeBubbleControlInteraction = (event: Event) => {
      const control = emailBubbleControlTarget(event.target);
      if (!control) return;
      markEmailBubbleControlInteraction();
      const currentSelection = currentEmailBubbleSelection(selection, lastSelectionRef.current);
      if (event.type === 'pointerdown' || event.type === 'mousedown') {
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement
        ) {
          // Let native inputs receive their first click normally; the stored range below
          // keeps the editor selection alive while focus moves into the control.
          window.requestAnimationFrame(() => control.focus({ preventScroll: true }));
        } else {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
      if (!currentSelection) return;
      const restore = () =>
        dom.dispatchEvent(
          new CustomEvent('tixkit-email-selection-restore', {
            bubbles: true,
            detail: {
              ...currentSelection,
              focusEditor: false,
            } satisfies EmailSelectionRestoreDetail,
          }),
        );
      restore();
      window.requestAnimationFrame(restore);
      window.setTimeout(restore, 0);
    };

    ownerDocument.addEventListener('click', handleNativeBubbleControlInteraction, true);
    ownerDocument.addEventListener('focusin', handleNativeBubbleControlInteraction, true);
    ownerDocument.addEventListener('input', handleNativeBubbleControlInteraction, true);
    ownerDocument.addEventListener('mousedown', handleNativeBubbleControlInteraction, true);
    ownerDocument.addEventListener('pointerdown', handleNativeBubbleControlInteraction, true);
    return () => {
      ownerDocument.removeEventListener('click', handleNativeBubbleControlInteraction, true);
      ownerDocument.removeEventListener('focusin', handleNativeBubbleControlInteraction, true);
      ownerDocument.removeEventListener('input', handleNativeBubbleControlInteraction, true);
      ownerDocument.removeEventListener('mousedown', handleNativeBubbleControlInteraction, true);
      ownerDocument.removeEventListener('pointerdown', handleNativeBubbleControlInteraction, true);
    };
  }, [editor, selection]);

  const handleBubbleControlInteraction = React.useCallback(
    (event: React.SyntheticEvent<HTMLElement>, options?: { preventDefault?: boolean }) => {
      if (options?.preventDefault) {
        event.preventDefault();
      }
      event.stopPropagation();
      restoreBubbleSelection();
    },
    [restoreBubbleSelection],
  );
  const handleBubbleInputPress = React.useCallback(
    (event: React.MouseEvent<HTMLElement> | React.PointerEvent<HTMLElement>) => {
      const target = event.target;
      if (
        !(
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement ||
          target instanceof HTMLTextAreaElement
        )
      ) {
        handleBubbleControlInteraction(event, { preventDefault: true });
        return;
      }
      event.stopPropagation();
      markEmailBubbleControlInteraction();
      window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    },
    [handleBubbleControlInteraction],
  );

  const style = selection?.style ?? {};
  const colorValue = /^#[0-9a-f]{6}$/i.test(style.color ?? '') ? style.color : '#111827';
  const isNodeSelection =
    selection?.scope === 'node' ||
    emailBubbleNodeSelectionNodes.some((nodeName) => editor?.isActive(nodeName) ?? false);
  const isImageSelection = selection?.nodeName === 'image' || (editor?.isActive('image') ?? false);
  const replaceSelectedImage = React.useCallback(() => {
    restoreBubbleSelection();
    type EditorCommands = NonNullable<typeof editor>['commands'] & {
      uploadImage?: () => boolean;
    };
    const commands = editor?.commands as EditorCommands | undefined;
    commands?.uploadImage?.();
  }, [editor, restoreBubbleSelection]);
  const applySelectionColor = React.useCallback(
    (nextColor: string) => {
      restoreBubbleSelection();
      if (/^#[0-9a-f]{6}$/i.test(nextColor)) {
        formatCurrentSelection({ patch: { color: nextColor } });
      }
    },
    [formatCurrentSelection, restoreBubbleSelection],
  );
  const applySelectionTextSize = React.useCallback(
    (nextValue: string) => {
      restoreBubbleSelection();
      const trimmed = nextValue.trim();
      formatCurrentSelection({ patch: { fontSize: trimmed ? `${trimmed}px` : '' } });
    },
    [formatCurrentSelection, restoreBubbleSelection],
  );
  const applySelectionLineHeight = React.useCallback(
    (nextValue: string) => {
      restoreBubbleSelection();
      const trimmed = nextValue.trim();
      formatCurrentSelection({ patch: { lineHeight: trimmed ? `${trimmed}%` : '' } });
    },
    [formatCurrentSelection, restoreBubbleSelection],
  );

  return (
    <>
      <BubbleMenu.NodeSelector
        open={nodeSelectorOpen}
        onOpenChange={handleNodeSelectorOpenChange}
      />
      {isCodeActive ? (
        <BubbleMenu.Code />
      ) : (
        <>
          {!isNodeSelection && (
            <>
              <BubbleMenu.LinkSelector
                open={linkSelectorOpen}
                onOpenChange={handleLinkSelectorOpenChange}
              />
              <BubbleMenu.ItemGroup>
                <BubbleMenu.Bold />
                <BubbleMenu.Italic />
                <BubbleMenu.Underline />
                <BubbleMenu.Strike />
                <BubbleMenu.Code />
                <BubbleMenu.Uppercase />
              </BubbleMenu.ItemGroup>
            </>
          )}
          {!isNodeSelection && (selection?.key || variableSelectKeyRef.current) && (
            <BubbleMenu.ItemGroup>
              <BubbleMenu.Item
                isActive={false}
                name="Variable options"
                onCommand={toggleVariableMenu}
              >
                <Variable className="size-4" />
              </BubbleMenu.Item>
            </BubbleMenu.ItemGroup>
          )}
          {isImageSelection && (
            <BubbleMenu.ItemGroup>
              <BubbleMenu.Item
                isActive={false}
                name="Replace image"
                onCommand={replaceSelectedImage}
              >
                <Image className="size-4" />
              </BubbleMenu.Item>
            </BubbleMenu.ItemGroup>
          )}
          <BubbleMenu.ItemGroup>
              <BubbleMenu.Item
                isActive={false}
                name="Align left"
                onCommand={() => formatCurrentSelection({ alignment: 'left' })}
              >
                <AlignLeftIcon />
              </BubbleMenu.Item>
              <BubbleMenu.Item
                isActive={false}
                name="Align center"
                onCommand={() => formatCurrentSelection({ alignment: 'center' })}
              >
                <AlignCenterIcon />
              </BubbleMenu.Item>
              <BubbleMenu.Item
                isActive={false}
                name="Align right"
                onCommand={() => formatCurrentSelection({ alignment: 'right' })}
              >
                <AlignRightIcon />
              </BubbleMenu.Item>
            </BubbleMenu.ItemGroup>
          {!isNodeSelection && (
            <BubbleMenu.ItemGroup className="tixkit-email-bubble-controls">
              <span
                className="tixkit-email-bubble-controls__inputs"
                data-tixkit-email-bubble-controls="true"
                onClickCapture={handleBubbleControlInteraction}
                onFocusCapture={handleBubbleControlInteraction}
                onMouseDownCapture={handleBubbleInputPress}
                onPointerDownCapture={handleBubbleInputPress}
              >
                <input
                  aria-label="Selection color"
                  className="tixkit-email-bubble-control tixkit-email-bubble-control--color"
                  onChange={(event) => applySelectionColor(event.currentTarget.value)}
                  onClick={handleBubbleControlInteraction}
                  onInput={(event) => applySelectionColor(event.currentTarget.value)}
                  onMouseDown={handleBubbleControlInteraction}
                  onPointerDown={handleBubbleControlInteraction}
                  type="color"
                  value={colorValue}
                />
                <select
                  aria-label="Selection font family"
                  className="tixkit-email-bubble-control tixkit-email-bubble-control--font"
                  onChange={(event) => {
                    restoreBubbleSelection();
                    formatCurrentSelection({ patch: { fontFamily: event.currentTarget.value } });
                  }}
                  onClick={handleBubbleControlInteraction}
                  onMouseDown={handleBubbleControlInteraction}
                  onPointerDown={handleBubbleControlInteraction}
                  value={style.fontFamily ?? ''}
                >
                  {emailBubbleFontOptions.map((option) => (
                    <option key={option.label} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Selection text size"
                  className="tixkit-email-bubble-control tixkit-email-bubble-control--number"
                  inputMode="numeric"
                  onChange={(event) => applySelectionTextSize(event.currentTarget.value)}
                  onClick={handleBubbleControlInteraction}
                  onInput={(event) => applySelectionTextSize(event.currentTarget.value)}
                  onMouseDown={handleBubbleControlInteraction}
                  onPointerDown={handleBubbleControlInteraction}
                  placeholder="Size"
                  value={inlineControlValue(style.fontSize, 'px')}
                />
                <input
                  aria-label="Selection line height"
                  className="tixkit-email-bubble-control tixkit-email-bubble-control--number"
                  inputMode="numeric"
                  onChange={(event) => applySelectionLineHeight(event.currentTarget.value)}
                  onClick={handleBubbleControlInteraction}
                  onInput={(event) => applySelectionLineHeight(event.currentTarget.value)}
                  onMouseDown={handleBubbleControlInteraction}
                  onPointerDown={handleBubbleControlInteraction}
                  placeholder="Line"
                  value={inlineControlValue(style.lineHeight, '%')}
                />
              </span>
            </BubbleMenu.ItemGroup>
          )}
        </>
      )}
    </>
  );
}

function defaultEmailDocument(
  event?: AdminEventDetail,
  senderIdentity?: AdminBrandSenderIdentity,
): EmailTemplateDocument {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: [
        '<h1>{{event.title}}</h1>',
        '<p>Hi {{recipient.name}}, your tickets are ready.</p>',
        '<p>Order {{order.id}} - {{order.total}}</p>',
        '<p>{{ticket.type}} - {{ticket.code}}</p>',
        '<p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code" /></p>',
        '<p>You are receiving this because you purchased or manage tickets with {{brand.name}}.</p>',
      ].join(''),
      contentText: [
        '{{event.title}}',
        'Hi {{recipient.name}}, your tickets are ready.',
        'Order {{order.id}} - {{order.total}}',
        '{{ticket.type}} - {{ticket.code}}',
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
        fromEmail: senderIdentity?.email ?? '',
        fromName: senderIdentity?.name || '{{brand.name}}',
        replyToEmail: senderIdentity?.replyToEmail,
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
        body: 'Order {{order.id}} - {{order.total}} - {{ticket.type}} - {{ticket.code}}',
      },
      {
        type: 'qr_code',
        title: 'Ticket QR code',
        imageUrl: '{{ticket.qrCodeUrl}}',
        imageAlt: 'Ticket QR code',
      },
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
  });
}

function previewFromEditorDocument(label: string, document: EmailTemplateDocument): EditorPreview {
  const html = document.editor.contentHtml.trim();
  const text = document.editor.contentText?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: html || text || '',
  };
}

function previewFromEmailOutput(
  label: string,
  output: Pick<AdminContentRenderOutput, 'html' | 'text'>,
): EditorPreview {
  const text = output.text?.trim();
  const html = output.html?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: text || html || '',
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

function waitForReviewAnalysis(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function verifiedSenderIdentities(identities: AdminBrandSenderIdentity[]) {
  return identities.filter((identity) => identity.verified && identity.email.trim());
}

function findVerifiedSenderIdentity(
  identities: AdminBrandSenderIdentity[],
  fromEmail?: string,
): AdminBrandSenderIdentity | undefined {
  const normalizedFromEmail = fromEmail?.trim().toLowerCase();
  if (!normalizedFromEmail) return verifiedSenderIdentities(identities)[0];
  return verifiedSenderIdentities(identities).find(
    (identity) => identity.email.trim().toLowerCase() === normalizedFromEmail,
  );
}

function applySenderIdentity(
  document: EmailTemplateDocument,
  identity: AdminBrandSenderIdentity,
): EmailTemplateDocument {
  return {
    ...document,
    settings: {
      ...document.settings,
      sender: {
        ...document.settings.sender,
        fromEmail: identity.email,
        fromName: identity.name || document.settings.sender.fromName,
        replyToEmail: identity.replyToEmail,
      },
    },
  };
}

function senderIdentityIssues(
  document: EmailTemplateDocument,
  identities: AdminBrandSenderIdentity[],
): ContentValidationIssue[] {
  if (findVerifiedSenderIdentity(identities, document.settings.sender.fromEmail)) return [];
  const verifiedCount = verifiedSenderIdentities(identities).length;
  return [
    {
      code: verifiedCount > 0 ? 'email_sender_identity_mismatch' : 'email_sender_identity_missing',
      field: 'settings.sender.fromEmail',
      message:
        verifiedCount > 0
          ? 'Choose a verified sender identity for this brand before sending.'
          : 'This brand has no verified email sender identity. Verify a sender before sending.',
      severity: 'error',
    },
  ];
}

function ensureBulkUnsubscribeFooter(document: EmailTemplateDocument): EmailTemplateDocument {
  if (document.settings.category !== 'bulk') return document;
  if (document.blocks.some((block) => block.type === 'unsubscribe_footer')) return document;
  return {
    ...document,
    blocks: [
      ...document.blocks,
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you subscribed to updates from {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
  };
}

const inspectorNodeSectionLayout: Record<string, string[]> = {
  image: ['attributes', 'size', 'link', 'padding', 'border'],
  button: ['link', 'typography', 'size', 'padding', 'border', 'background'],
  section: ['background', 'padding', 'border'],
  div: ['background', 'padding', 'border'],
  codeBlock: ['attributes', 'padding', 'border'],
  footer: ['typography', 'padding', 'background'],
  twoColumns: ['columnSpacing', 'typography', 'padding', 'background', 'border'],
  threeColumns: ['columnSpacing', 'typography', 'padding', 'background', 'border'],
  fourColumns: ['columnSpacing', 'typography', 'padding', 'background', 'border'],
};
const inspectorDefaultSections = ['typography', 'padding', 'background', 'border'];
function inspectorSectionTypesForNode(nodeType: string): string[] {
  return inspectorNodeSectionLayout[nodeType] ?? inspectorDefaultSections;
}

function NativeEmailInspector({ host }: { host: HTMLElement | null }) {
  const { editor } = useCurrentEditor();
  const lastSelectionRef = React.useRef<EmailBubbleSelectionState | null>(null);
  const [isTextSelection, setIsTextSelection] = React.useState(false);

  React.useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return undefined;
    const handleSelectionState = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isEmailBubbleSelectionState(detail)) {
        lastSelectionRef.current = detail;
        rememberEmailBubbleSelection(detail);
        setIsTextSelection(detail.scope !== 'node');
      }
    };
    dom.addEventListener('tixkit-email-selection-state', handleSelectionState);
    return () => {
      dom.removeEventListener('tixkit-email-selection-state', handleSelectionState);
    };
  }, [editor]);

  const preserveSelectionForTarget = React.useCallback(
    (target: EventTarget | null, event?: { preventDefault: () => void; type?: string }) => {
      const selection = lastSelectionRef.current;
      const currentSelection = selection ?? latestEmailBubbleSelection;
      const dom = editor?.view.dom;
      if (!currentSelection || !dom) return;
      markEmailBubbleControlInteraction();
      const allowsNativeFocus =
        target instanceof HTMLElement &&
        Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
      if (!allowsNativeFocus && event?.type !== 'focusin' && event?.type !== 'input') {
        event?.preventDefault();
      }
      const restoreSelection = () => {
        dom.dispatchEvent(
          new CustomEvent('tixkit-email-selection-restore', {
            bubbles: true,
            detail: {
              ...currentSelection,
              focusEditor: !allowsNativeFocus,
            } satisfies EmailSelectionRestoreDetail,
          }),
        );
      };
      restoreSelection();
      window.requestAnimationFrame(restoreSelection);
      window.setTimeout(restoreSelection, 0);
      window.setTimeout(restoreSelection, 60);
    },
    [editor],
  );

  React.useEffect(() => {
    const handleInspectorInteraction = (event: Event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-tixkit-email-inspector="true"]')
      ) {
        preserveSelectionForTarget(event.target, event);
      }
    };
    document.addEventListener('click', handleInspectorInteraction, true);
    document.addEventListener('focusin', handleInspectorInteraction, true);
    document.addEventListener('input', handleInspectorInteraction, true);
    document.addEventListener('mousedown', handleInspectorInteraction, true);
    document.addEventListener('pointerdown', handleInspectorInteraction, true);
    return () => {
      document.removeEventListener('click', handleInspectorInteraction, true);
      document.removeEventListener('focusin', handleInspectorInteraction, true);
      document.removeEventListener('input', handleInspectorInteraction, true);
      document.removeEventListener('mousedown', handleInspectorInteraction, true);
      document.removeEventListener('pointerdown', handleInspectorInteraction, true);
    };
  }, [preserveSelectionForTarget]);

  const preserveEditorSelection = React.useCallback(
    (event: React.SyntheticEvent<HTMLElement>) => {
      preserveSelectionForTarget(event.target, event);
    },
    [preserveSelectionForTarget],
  );

  // Register the inspector host element as a focus scope so the FocusScopes
  // extension does not clear the editor selection when focus moves to an
  // inspector control. The EditorFocusScope wrapper may not reliably attach
  // via Radix Slot inside a portal, so we register the host directly.
  React.useEffect(() => {
    if (!editor || !host) return;
    const focusScope = editor.extensionStorage?.focusScope;
    if (!focusScope?.registerScope) return;
    focusScope.registerScope(host);
    return () => {
      focusScope.unregisterScope(host);
    };
  }, [editor, host]);

  if (!host) return null;
  return createPortal(
    <EditorFocusScope>
      <div
        className="tixkit-email-native-inspector"
        data-tixkit-email-inspector="true"
        onClickCapture={preserveEditorSelection}
        onFocusCapture={preserveEditorSelection}
        onInputCapture={preserveEditorSelection}
        onMouseDownCapture={preserveEditorSelection}
        onPointerDownCapture={preserveEditorSelection}
      >
      <Inspector.Root aria-label="React Email style inspector">
        <div className="space-y-1 border-b border-border pb-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Selection</p>
          <div className="text-sm font-semibold text-foreground">
            <Inspector.Breadcrumb />
          </div>
        </div>
        <div className="space-y-5">
          <Inspector.Document />
          {isTextSelection ? (
            <Inspector.Node>
              {(context) => {
                const sectionTypes = inspectorSectionTypesForNode(context.nodeType)
                  .filter((type) => type !== 'typography');
                return sectionTypes.map((type) => {
                  switch (type) {
                    case 'attributes':
                      return <Inspector.Attributes key={type} {...context} />;
                    case 'size':
                      return <Inspector.Size key={type} {...context} />;
                    case 'padding':
                      return <Inspector.Padding key={type} {...context} />;
                    case 'columnSpacing':
                      return <Inspector.ColumnSpacing key={type} {...context} />;
                    case 'background':
                      return <Inspector.Background key={type} {...context} />;
                    case 'border':
                      return <Inspector.Border key={type} {...context} />;
                    default:
                      return null;
                  }
                });
              }}
            </Inspector.Node>
          ) : (
            <Inspector.Node />
          )}
        </div>
      </Inspector.Root>
      </div>
    </EditorFocusScope>,
    host,
  );
}

function initialEditorContent(document: EmailTemplateDocument): EmailEditorProps['content'] {
  const contentJson = document.editor.contentJson;
  const contentHtml = document.editor.contentHtml;
  if (contentJson && !(isSinglePlainTextParagraphJson(contentJson) && hasStructuredEditorHtml(contentHtml))) {
    return applyMergeTagPreviewsToEditorContent(contentJson as EmailEditorProps['content']);
  }
  return applyMergeTagPreviewsToEditorContent(contentHtml as EmailEditorProps['content']);
}

function isSinglePlainTextParagraphJson(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const doc = value as { content?: unknown; type?: unknown };
  if (doc.type !== 'doc' || !Array.isArray(doc.content) || doc.content.length !== 1) return false;
  const paragraph = doc.content[0] as { content?: unknown; type?: unknown };
  if (paragraph.type !== 'paragraph') return false;
  if (!Array.isArray(paragraph.content) || paragraph.content.length === 0) return true;
  return paragraph.content.every((child) => {
    if (!child || typeof child !== 'object') return false;
    const node = child as { type?: unknown };
    return node.type === 'text' || node.type === 'hardBreak';
  });
}

function hasStructuredEditorHtml(value: string | null | undefined): boolean {
  const html = value?.trim();
  if (!html) return false;
  const blockMatches = html.match(/<(?:h[1-6]|p|ul|ol|li|blockquote|table|section|article|div|hr|img|a)\b/gi) ?? [];
  return (
    blockMatches.length > 1 ||
    /<(?:h[1-6]|ul|ol|blockquote|table|section|article|hr|img)\b/i.test(html)
  );
}

function scheduledAtFromInput(mode: EmailSendMode, value: string): string | undefined {
  if (mode !== 'scheduled' || !value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function audienceLabel(audience: EmailAudience): string {
  if (audience === 'checked_in') return 'Checked in attendees';
  if (audience === 'not_checked_in') return 'Not checked in attendees';
  if (audience === 'specific') return 'Specific attendees';
  return 'All attendees';
}

function withEditorExport(
  document: EmailTemplateDocument,
  exported: { html: string; text: string; json: Record<string, unknown> },
): EmailTemplateDocument {
  const exportedHtml = canonicalizeMergeTagPreviewHtml(exported.html.trim());
  const jsonText = tipTapPlainTextFromJson(exported.json);
  const missingMergeTagLiterals = mergeTagLiteralsFromJson(exported.json).filter(
    (literal) => !exportedHtml.includes(literal),
  );
  const jsonHtml =
    missingMergeTagLiterals.length > 0 || hasTixkitInlineStyleMarks(exported.json)
      ? tipTapHtmlFromJson(exported.json)
      : '';
  const canonicalHtml = jsonHtml || exportedHtml;
  const htmlText = plainTextFromHtml(canonicalHtml);
  const contentText = jsonText || exported.text.trim() || htmlText;
  const baseContentHtml =
    canonicalHtml && (htmlText || !jsonText) ? canonicalHtml : htmlFromPlainText(contentText);
  const contentHtml = applyEmailGlobalCssToHtml(baseContentHtml, document.editor.globalCss);
  return {
    ...document,
    editor: {
      ...document.editor,
      contentHtml,
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

function tipTapPlainTextFromJson(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { content?: unknown; marks?: unknown; text?: unknown; type?: unknown };
  if (typeof node.text === 'string') {
    const mergeTagKey = mergeTagKeyFromJsonMarks(node.marks);
    return mergeTagKey ? mergeTagLiteral(mergeTagKey) : node.text;
  }
  if (node.type === 'hardBreak') return '\n';
  if (!Array.isArray(node.content)) return '';
  const parts = node.content
    .map((child) => tipTapPlainTextFromJson(child))
    .filter((part) => part.length > 0);
  const separator =
    node.type === 'doc' ||
    node.type === 'container' ||
    node.type === 'bulletList' ||
    node.type === 'orderedList' ||
    node.type === 'listItem'
      ? '\n'
      : '';
  return parts.join(separator).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function mergeTagKeyFromJsonMarks(marks: unknown): string | null {
  if (!Array.isArray(marks)) return null;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const typedMark = mark as { attrs?: { key?: unknown }; type?: unknown };
    if (typedMark.type !== tixkitMergeTagMarkName) continue;
    const key = typedMark.attrs?.key;
    if (typeof key === 'string' && key.trim()) return key.trim();
  }
  return null;
}

function mergeTagLiteralsFromJson(value: unknown): string[] {
  const literals = new Set<string>();
  const visit = (nodeValue: unknown) => {
    if (!nodeValue || typeof nodeValue !== 'object') return;
    if (Array.isArray(nodeValue)) {
      for (const child of nodeValue) visit(child);
      return;
    }
    const node = nodeValue as TipTapJsonNode;
    const mergeTagKey = mergeTagKeyFromJsonMarks(node.marks);
    if (mergeTagKey) literals.add(mergeTagLiteral(mergeTagKey));
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value);
  return Array.from(literals);
}

function hasTixkitInlineStyleMarks(value: unknown): boolean {
  let found = false;
  const visit = (nodeValue: unknown) => {
    if (found || !nodeValue || typeof nodeValue !== 'object') return;
    if (Array.isArray(nodeValue)) {
      for (const child of nodeValue) visit(child);
      return;
    }
    const node = nodeValue as TipTapJsonNode;
    if (Array.isArray(node.marks)) {
      found = node.marks.some(
        (mark) =>
          mark &&
          typeof mark === 'object' &&
          (mark as { type?: unknown }).type === tixkitInlineStyleMarkName,
      );
      if (found) return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
    }
  };
  visit(value);
  return found;
}

type TipTapJsonNode = {
  attrs?: Record<string, unknown>;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
  type?: unknown;
};

function tipTapHtmlFromJson(value: unknown): string {
  const html = tipTapNodeHtml(value);
  return html.trim();
}

function tipTapNodeHtml(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((child) => tipTapNodeHtml(child)).join('');
  const node = value as TipTapJsonNode;
  if (typeof node.text === 'string') return tipTapTextHtml(node.text, node.marks);
  if (node.type === 'hardBreak') return '<br>';

  const children = Array.isArray(node.content)
    ? node.content.map((child) => tipTapNodeHtml(child)).join('')
    : '';
  switch (node.type) {
    case 'doc':
    case 'container':
      return children;
    case 'paragraph':
      return `<p${tipTapBlockAttributes(node.attrs)}>${children}</p>`;
    case 'heading': {
      const level = tipTapHeadingLevel(node.attrs);
      return `<h${level}${tipTapBlockAttributes(node.attrs)}>${children}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    default:
      return children;
  }
}

function tipTapTextHtml(text: string, marks: unknown): string {
  const mergeTagKey = mergeTagKeyFromJsonMarks(marks);
  const sourceText = mergeTagKey ? mergeTagLiteral(mergeTagKey) : text;
  let html = escapeHtml(sourceText);
  if (!Array.isArray(marks)) return html;
  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;
    const typedMark = mark as { attrs?: Record<string, unknown>; type?: unknown };
    if (typedMark.type === tixkitMergeTagMarkName) continue;
    if (typedMark.type === tixkitInlineStyleMarkName) {
      const style = inlineStyleAttribute(typedMark.attrs);
      if (style) html = `<span style="${escapeHtmlAttribute(style)}">${html}</span>`;
      continue;
    }
    if (typedMark.type === 'bold' || typedMark.type === 'strong') {
      html = `<strong>${html}</strong>`;
      continue;
    }
    if (typedMark.type === 'italic' || typedMark.type === 'em') {
      html = `<em>${html}</em>`;
      continue;
    }
    if (typedMark.type === 'strike') {
      html = `<s>${html}</s>`;
      continue;
    }
    if (typedMark.type === 'link') {
      const href = typeof typedMark.attrs?.href === 'string' ? typedMark.attrs.href : '';
      if (href.trim()) html = `<a href="${escapeHtmlAttribute(href.trim())}">${html}</a>`;
    }
  }
  return html;
}

function tipTapBlockAttributes(attrs: Record<string, unknown> | undefined): string {
  const alignment = tipTapAlignment(attrs);
  return alignment ? ` style="text-align: ${alignment}"` : '';
}

function tipTapAlignment(attrs: Record<string, unknown> | undefined): string | null {
  const value =
    typeof attrs?.textAlign === 'string'
      ? attrs.textAlign
      : typeof attrs?.align === 'string'
        ? attrs.align
        : typeof attrs?.alignment === 'string'
          ? attrs.alignment
          : '';
  if (value === 'left' || value === 'center' || value === 'right') return value;
  return null;
}

function tipTapHeadingLevel(attrs: Record<string, unknown> | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = typeof attrs?.level === 'number' ? attrs.level : 1;
  if (level === 2 || level === 3 || level === 4 || level === 5 || level === 6) return level;
  return 1;
}

function inlineStyleAttribute(attrs: Record<string, unknown> | undefined): string {
  const style: string[] = [];
  if (typeof attrs?.color === 'string' && attrs.color.trim()) {
    style.push(`color: ${attrs.color.trim()}`);
  }
  if (typeof attrs?.fontFamily === 'string' && attrs.fontFamily.trim()) {
    const fontFamily = sanitizeEmailFontFamily(attrs.fontFamily);
    if (fontFamily) style.push(`font-family: ${fontFamily}`);
  }
  if (typeof attrs?.fontSize === 'string' && attrs.fontSize.trim()) {
    style.push(`font-size: ${attrs.fontSize.trim()}`);
  }
  if (typeof attrs?.lineHeight === 'string' && attrs.lineHeight.trim()) {
    style.push(`line-height: ${attrs.lineHeight.trim()}`);
  }
  return style.join('; ');
}

function canonicalizeMergeTagPreviewHtml(html: string): string {
  if (!html.trim()) return '';
  if (typeof DOMParser === 'undefined') {
    return html.replace(
      /(<span\b[^>]*\bdata-tixkit-merge-tag=["']([^"']+)["'][^>]*>)([\s\S]*?)(<\/span>)/gi,
      (_match, opening: string, key: string, _content: string, closing: string) =>
        `${opening}${mergeTagLiteral(key.trim())}${closing}`,
    );
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-attr-src]'))) {
    const key = element.dataset.tixkitMergeAttrSrc;
    if (!key?.trim()) continue;
    element.setAttribute('src', mergeTagLiteral(key.trim()));
    element.removeAttribute('data-tixkit-merge-attr-src');
  }
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-attr-href]'))) {
    const key = element.dataset.tixkitMergeAttrHref;
    if (!key?.trim()) continue;
    element.setAttribute('href', mergeTagLiteral(key.trim()));
    element.removeAttribute('data-tixkit-merge-attr-href');
  }
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>('[src], [href]'))) {
    for (const attribute of ['src', 'href'] as const) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      for (const key of emailVariableInserts) {
        if (value === mergeTagCanvasAttributeValue(key)) {
          element.setAttribute(attribute, mergeTagLiteral(key));
          break;
        }
      }
    }
  }
  for (const element of Array.from(parsed.querySelectorAll<HTMLElement>('[data-tixkit-merge-tag]'))) {
    const key = element.dataset.tixkitMergeTag || element.dataset.variableKey;
    if (!key?.trim()) continue;
    element.textContent = mergeTagLiteral(key.trim());
    element.removeAttribute('data-tixkit-merge-tag');
    element.removeAttribute('data-variable-key');
    element.removeAttribute('data-variable-kind');
    element.removeAttribute('data-variable-label');
    element.removeAttribute('data-variable-preview');
    element.removeAttribute('data-variable-detail');
    element.removeAttribute('key');
    element.removeAttribute('kind');
    element.removeAttribute('label');
    element.removeAttribute('preview');
    element.removeAttribute('title');
    const classNames = element.className
      .split(/\s+/)
      .filter((className) => className && className !== 'tixkit-email-variable-chip');
    if (classNames.length > 0) {
      element.className = classNames.join(' ');
    } else {
      element.removeAttribute('class');
    }
  }
  for (const element of Array.from(
    parsed.querySelectorAll<HTMLElement>('[data-tixkit-inline-style]'),
  )) {
    element.removeAttribute('data-tixkit-inline-style');
  }

  const trimmed = html.trim();
  if (/<html[\s>]/i.test(trimmed)) {
    const doctype = /^<!doctype/i.test(trimmed) ? '<!DOCTYPE html>' : '';
    return `${doctype}${parsed.documentElement.outerHTML}`;
  }
  return parsed.body.innerHTML;
}

function htmlFromPlainText(text: string): string {
  if (!text.trim()) return '';
  return text
    .split(/\n{2,}|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function PreviewDrawer({ onClose, preview }: { onClose: () => void; preview: EditorPreview }) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background text-foreground shadow-2xl"
      data-testid="preview-drawer"
    >
      <div className="flex h-14 items-center justify-between border-b px-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{preview.format}</p>
          <h2 className="text-sm font-semibold">{preview.label}</h2>
        </div>
        <button
          aria-label="Close preview"
          className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={onClose}
          type="button"
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-muted-foreground">
        {preview.output}
      </pre>
    </aside>
  );
}

export function EmailPersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [brand, setBrand] = React.useState<AdminBrand>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [emailDocument, setEmailDocument] = React.useState<EmailTemplateDocument>();
  const [senderIdentities, setSenderIdentities] = React.useState<AdminBrandSenderIdentity[]>([]);
  const [templateChoices, setTemplateChoices] = React.useState<EmailTemplateChoice[]>([]);
  const [inspectorPanelId, setInspectorPanelId] = React.useState<EmailInspectorPanelId>('style');
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [editorRevision, setEditorRevision] = React.useState(0);
  const [audience, setAudience] = React.useState<EmailAudience>('all');
  const [sendMode, setSendMode] = React.useState<EmailSendMode>('now');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [reviewIssues, setReviewIssues] = React.useState<ContentValidationIssue[]>([]);
  const [reviewState, setReviewState] = React.useState<EmailReviewState>('idle');
  const [nativeInspectorHost, setNativeInspectorHost] = React.useState<HTMLElement | null>(null);
  const [recipient, setRecipient] = React.useState('ada@example.test');
  const [preview, setPreview] = React.useState<EditorPreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = React.useState(false);
  const [testDialogOpen, setTestDialogOpen] = React.useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = React.useState(false);
  const [reviewConfirmed, setReviewConfirmed] = React.useState(false);
  const [emailThemePreset, setEmailThemePreset] = React.useState<EmailThemePreset>('brand');
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const editorCanvasRef = React.useRef<HTMLElement | null>(null);
  const inspectorRef = React.useRef<HTMLDivElement | null>(null);
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
    [
      brand?.theme.fontFamily,
      brand?.theme.primaryColor,
      brand?.theme.radius,
      emailThemePreset,
    ],
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
        (brand) => brand.id === loadedEvent.brandId,
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
      const initialDocument = defaultEmailDocument(loadedEvent, defaultSenderIdentity);
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

    setEvent(loadedEvent);
    setBrand(loadedBrand);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setVersions(loadedVersions);
    setSenderIdentities(loadedSenderIdentities);
    setTemplateChoices(loadedTemplateChoices);
    setEmailDocument(normalizedWithSender);
    setPreview(previewFromEditorDocument('Editor snapshot', normalizedWithSender));
    setReviewIssues(
      mergeValidationIssues([
        ...validateEmailTemplate(normalizedWithSender, { provider: 'resend' }).issues,
        ...senderIdentityIssues(normalizedWithSender, loadedSenderIdentities),
      ]),
    );
    setReviewState('checked');
    setAutosave('saved');
    setLoading(false);
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

  const isArchived = document?.status === 'archived';
  const canEdit = !isArchived;

  React.useEffect(() => {
    const canvas = editorCanvasRef.current;
    const inspector = inspectorRef.current;
    if (!canvas && !inspector) return;
    const labelEmailBody = () => {
      if (!canvas) return;
      const editor = canvas.querySelector<HTMLElement>(
        '[contenteditable="true"], [contenteditable=""], [role="textbox"]:not(input):not(textarea)',
      );
      editor?.setAttribute('aria-label', 'Email body');
    };
    const labelInspectorControls = () => {
      if (!inspector) return;
      const contrastNodes = inspector.querySelectorAll<HTMLElement>(
        '[data-re-inspector-breadcrumb-button], [data-re-inspector-label]',
      );
      for (const node of contrastNodes) {
        node.style.removeProperty('color');
      }
      const inputs = inspector.querySelectorAll<HTMLInputElement>(
        'input[data-re-inspector-input], input[data-re-inspector-color-trigger], input[data-re-inspector-color-hex]',
      );
      for (const input of inputs) {
        if (input.getAttribute('aria-label')) continue;
        const row = input.closest<HTMLElement>('[data-re-inspector-prop-row]');
        const section = input.closest<HTMLElement>('[data-re-inspector-section]');
        const rowLabel =
          Array.from(row?.children ?? [])
            .find((child) => !child.contains(input))
            ?.textContent?.trim() || 'Inspector property';
        const sectionLabel =
          section
            ?.querySelector<HTMLElement>('[data-re-inspector-section-toggle]')
            ?.textContent?.trim() || 'Style';
        const inputLabel = input.hasAttribute('data-re-inspector-color-trigger')
          ? `${sectionLabel} ${rowLabel} color picker`
          : input.hasAttribute('data-re-inspector-color-hex')
            ? `${sectionLabel} ${rowLabel} hex color`
            : `${sectionLabel} ${rowLabel}`;
        input.setAttribute('aria-label', inputLabel);
      }
    };
    const labelEditorAccessibility = () => {
      labelEmailBody();
      labelInspectorControls();
    };
    labelEditorAccessibility();
    const observer = new MutationObserver(labelEditorAccessibility);
    if (canvas) observer.observe(canvas, { childList: true, subtree: true });
    if (inspector) observer.observe(inspector, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [draft?.id, emailDocument, inspectorCollapsed, inspectorPanelId]);

  function openInspectorPanel(panelId: EmailInspectorPanelId) {
    setInspectorPanelId(panelId);
    setInspectorCollapsed(false);
  }

  function openMenuInspectorPanel(panelId: EmailInspectorPanelId) {
    openInspectorPanel(panelId);
  }

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

  function insertEditorText(content: string) {
    if (isArchived) return;
    const editor = emailEditorRef.current?.editor;
    if (!editor) return;
    editor.chain().focus().insertContent(content).run();
    markDraftDirty();
  }

  function insertEmailVariable(variableKey: string) {
    insertEditorText(`{{${variableKey}}}`);
  }

  function insertBrandLogo() {
    if (isArchived) return;
    const logoUrl = typeof brand?.theme.logoUrl === 'string' ? brand.theme.logoUrl.trim() : '';
    if (!logoUrl) return;
    const editor = emailEditorRef.current?.editor;
    if (!editor) return;
    const logoAlt = `${brand?.name ?? 'Brand'} logo`;
    type EditorCommandChain = ReturnType<typeof editor.chain> & {
      setImage?: (attrs: { src: string; alt: string; alignment?: string }) => EditorCommandChain;
    };
    const chain = editor.chain().focus() as EditorCommandChain;
    if (typeof chain.setImage === 'function') {
      chain.setImage({ src: logoUrl, alt: logoAlt, alignment: 'center' }).run();
    } else {
      chain
        .insertContent({
          type: 'image',
          attrs: { src: logoUrl, alt: logoAlt, alignment: 'center' },
        })
        .run();
    }
    markDraftDirty();
  }

  async function reviewCurrentDraft(
    options: { analysisDelayMs?: number; openPanel?: boolean } = {},
  ) {
    if (!emailDocument) return undefined;
    setReviewState('checking');
    if (options.openPanel !== false) openInspectorPanel('issues');
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
    const review = await reviewCurrentDraft({ analysisDelayMs: 220, openPanel: false });
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email review blockers before sending.');
      setInspectorPanelId('issues');
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
    const review = await reviewCurrentDraft({ openPanel: false });
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email review blockers before sending.');
      setInspectorPanelId('issues');
      setReviewDialogOpen(false);
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
    const review = await reviewCurrentDraft({ openPanel: false });
    if (!review) return;
    if (hasBlockingIssues(review.issues)) {
      setAutosave('error');
      setActionError('Resolve email test-send blockers before sending a test.');
      openInspectorPanel('issues');
      return;
    }
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, review.document);
    if (!saved) return;
    const capturedRecipients: string[] = [];
    for (const testRecipient of recipients) {
      const result = await adminApi.testSendContent(document.id, {
        versionId: saved.version.id,
        recipient: testRecipient,
        context: event ? sampleContext(event) : undefined,
      });
      if (!isCurrentOperation(operationId)) return;
      if (!result.ok) {
        setAutosave('error');
        setActionError(resultMessage(result.error, 'Unable to capture email test send'));
        return;
      }
      capturedRecipients.push(result.data.testSend.recipient);
    }
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
  const issuePanelIssues = reviewState === 'idle' ? draft.validation.issues : reviewIssues;
  const issuePanelTitle = reviewState === 'checked' ? 'Current draft review' : 'Saved draft review';
  const verifiedSenders = verifiedSenderIdentities(senderIdentities);
  const selectedSenderIdentity = findVerifiedSenderIdentity(
    senderIdentities,
    emailDocument.settings.sender.fromEmail,
  );
  const inspectorHeading: Record<EmailInspectorPanelId, { eyebrow: string; title: string }> = {
    style: { eyebrow: 'Page style', title: 'Email template' },
    variables: { eyebrow: 'Variables', title: 'Merge tags' },
    details: { eyebrow: 'Template details', title: 'Settings' },
    history: { eyebrow: 'Version history', title: `${history.length} versions` },
    issues: { eyebrow: 'Review checks', title: issuePanelTitle },
    json: { eyebrow: 'Editor JSON', title: 'Saved payload' },
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
      id: 'test',
      label: 'Send test',
      icon: <Send className="size-4" />,
      onClick: () => setTestDialogOpen(true),
      disabled: Boolean(archivedReason),
    },
    {
      id: 'variables',
      label: 'Variables',
      icon: <Variable className="size-4" />,
      onClick: () => openMenuInspectorPanel('variables'),
    },
    {
      id: 'templates',
      label: 'Pick template',
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
      onClick: () => openMenuInspectorPanel('history'),
    },
    {
      id: 'details',
      label: 'Template details',
      icon: <Code className="size-4" />,
      onClick: () => openMenuInspectorPanel('details'),
      separatorAfter: true,
    },
    {
      id: 'json',
      label: 'View JSON',
      icon: <Code className="size-4" />,
      onClick: () => openMenuInspectorPanel('json'),
    },
    {
      id: 'review',
      label: 'Review blockers',
      icon: <Eye className="size-4" />,
      onClick: () => void reviewCurrentDraft(),
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
  const reviewSendTimeLabel =
    sendMode === 'scheduled' && reviewScheduledAt
      ? new Date(reviewScheduledAt).toLocaleString()
      : 'Now';
  const variableInsertItems = emailVariableInserts.map((key) => ({
    key,
    presentation: variablePresentation(key),
  }));

  return (
    <EditorChrome
      channel="email"
      testId="content-editor-shell"
      topBar={
        <EditorTopBar
          autosave={autosave}
          backHref={`/events/${event.id}`}
          channelLabel="Email"
          documentName={document.name}
          error={actionError}
          moreActions={moreActionsItems}
          notice={notice}
          onDocumentNameClick={() => openInspectorPanel('style')}
          onPublish={() => void openReviewDialog()}
          publishDisabled={Boolean(archivedReason)}
          publishLabel="Review"
          status={document.status}
        />
      }
      leftRail={
        <EditorLeftRail
          hiddenModes={{ preview: true }}
          insertsDisabled
          mode={editorMode}
          onModeChange={(mode) => void handleModeChange(mode)}
          inserts={null}
        />
      }
      canvas={
        <section
          aria-label="email template editable document"
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/30 lg:rounded-tl-3xl"
          data-testid="editor-canvas"
          ref={editorCanvasRef}
        >
          <div className="mx-auto min-h-full w-full max-w-[648px] px-5 py-6 sm:px-6">
            <MetadataBar>
              <label className="flex items-center gap-2 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">From</span>
                <select
                  aria-label="Verified sender"
                  className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                  disabled={!canEdit || verifiedSenders.length === 0}
                  onChange={(change) => {
                    const identity = verifiedSenders.find(
                      (sender) => sender.id === change.currentTarget.value,
                    );
                    if (!identity) return;
                    updateEmailDocument(applySenderIdentity(emailDocument, identity));
                  }}
                  value={selectedSenderIdentity?.id ?? ''}
                >
                  {verifiedSenders.length === 0 ? (
                    <option className="bg-background text-foreground" value="">
                      No verified senders
                    </option>
                  ) : null}
                  {verifiedSenders.map((sender) => (
                    <option className="bg-background text-foreground" key={sender.id} value={sender.id}>
                      {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 border-t border-border/60 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">Reply-To</span>
                <select
                  aria-label="Reply-To"
                  className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                  disabled={!canEdit || !selectedSenderIdentity}
                  onChange={(change) =>
                    updateEmailDocument({
                      ...emailDocument,
                      settings: {
                        ...emailDocument.settings,
                        sender: {
                          ...emailDocument.settings.sender,
                          replyToEmail: change.currentTarget.value || undefined,
                        },
                      },
                    })
                  }
                  value={emailDocument.settings.sender.replyToEmail ?? ''}
                >
                  <option className="bg-background text-foreground" value="">
                    Use From address
                  </option>
                  {selectedSenderIdentity?.replyToEmail ? (
                    <option
                      className="bg-background text-foreground"
                      value={selectedSenderIdentity.replyToEmail}
                    >
                      {selectedSenderIdentity.replyToEmail}
                    </option>
                  ) : null}
                </select>
              </label>
              <label className="flex items-center gap-2 border-t border-border/60 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">To</span>
                <select
                  aria-label="Audience"
                  className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                  disabled={!canEdit}
                  onChange={(change) => setAudience(change.currentTarget.value as EmailAudience)}
                  value={audience}
                >
                  <option className="bg-background text-foreground" value="all">
                    All attendees
                  </option>
                  <option className="bg-background text-foreground" value="checked_in">
                    Checked in
                  </option>
                  <option className="bg-background text-foreground" value="not_checked_in">
                    Not checked in
                  </option>
                  <option className="bg-background text-foreground" value="specific">
                    Specific attendees
                  </option>
                </select>
              </label>
              <div className="flex items-center gap-2 border-t border-border/60 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  Subscribe to
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {emailDocument.settings.category === 'bulk'
                    ? `${brand?.name ?? event.title} updates`
                    : 'Transactional ticket messages'}
                </span>
              </div>
              <label className="flex items-center gap-2 border-t border-border/60 py-1.5">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">When</span>
                <select
                  aria-label="Send timing"
                  className="w-28 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                  disabled={!canEdit}
                  onChange={(change) => setSendMode(change.currentTarget.value as EmailSendMode)}
                  value={sendMode}
                >
                  <option className="bg-background text-foreground" value="now">
                    Now
                  </option>
                  <option className="bg-background text-foreground" value="scheduled">
                    Scheduled
                  </option>
                </select>
                {sendMode === 'scheduled' && (
                  <input
                    aria-label="Scheduled send time"
                    className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
                    disabled={!canEdit}
                    onChange={(change) => setScheduledAt(change.currentTarget.value)}
                    type="datetime-local"
                    value={scheduledAt}
                  />
                )}
              </label>
              <MetadataField
                disabled={!canEdit}
                label="Subject"
                onChange={(value) =>
                  updateEmailDocument({
                    ...emailDocument,
                    settings: { ...emailDocument.settings, subject: value },
                  })
                }
                placeholder="Subject"
                value={emailDocument.settings.subject}
              />
              <MetadataField
                collapsible
                defaultOpen={false}
                disabled={!canEdit}
                label="Preview text"
                onChange={(value) =>
                  updateEmailDocument({
                    ...emailDocument,
                    settings: { ...emailDocument.settings, previewText: value },
                  })
                }
                placeholder="Preview text"
                value={emailDocument.settings.previewText ?? ''}
              />
            </MetadataBar>

            <div className="mt-6">
              {editorMode === 'code' ? (
                <div className="grid gap-4 rounded-lg bg-zinc-950 p-4 text-xs text-zinc-100 shadow-sm ring-1 ring-border/50">
                  <section>
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <h2 className="text-sm font-semibold text-white">Email HTML</h2>
                      <Button
                        className="h-8 border-zinc-700 bg-zinc-900 px-3 text-xs text-zinc-100 hover:bg-zinc-800"
                        onClick={() => void copyCodeHtml()}
                        type="button"
                        variant="outline"
                      >
                        Copy HTML
                      </Button>
                    </div>
                    <textarea
                      aria-label="Email HTML code"
                      className="min-h-80 w-full resize-y rounded-md border border-zinc-800 bg-black p-3 font-mono text-xs leading-5 text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-600 disabled:cursor-not-allowed disabled:opacity-70"
                      disabled={!canEdit}
                      onChange={(change) => updateCodeHtml(change.currentTarget.value)}
                      spellCheck={false}
                      value={emailDocument.editor.contentHtml}
                    />
                    <p className="mt-2 text-xs text-zinc-400">
                      Edits update the draft HTML. Return to Editor to reload the canvas from this HTML.
                    </p>
                  </section>
                  <details className="group/section">
                    <summary className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-semibold text-white">
                      <span>Global CSS</span>
                      <span className="text-xs font-normal text-zinc-500 group-open/section:hidden">
                        (click to expand)
                      </span>
                    </summary>
                    <textarea
                      aria-label="Global CSS"
                      className="mt-1 min-h-32 w-full resize-y rounded-md border border-zinc-800 bg-black p-3 font-mono text-xs leading-5 text-zinc-100 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-600 disabled:cursor-not-allowed disabled:opacity-70"
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
                      placeholder=".button { text-transform: uppercase; }"
                      spellCheck={false}
                      value={emailDocument.editor.globalCss ?? ''}
                    />
                    <p className="mt-2 text-xs text-zinc-400">
                      Injected once into the email HTML head. Validated for unsafe rules before publish.
                    </p>
                  </details>
                  <section>
                    <h2 className="mb-2 text-sm font-semibold text-white">Editor JSON</h2>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap leading-5">
                      {JSON.stringify(emailDocument.editor.contentJson ?? emailDocument, null, 2)}
                    </pre>
                  </section>
                </div>
              ) : (
              <EmailEditor
                bubbleMenu={{
                  hideWhenActiveNodes: emailBubbleHiddenNodes,
                  placement: 'top',
                  offset: 18,
                  trigger: emailBubbleMenuTrigger,
                  children: <TixkitEmailBubbleMenu />,
                }}
                className="tixkit-react-email-editor rounded-lg bg-white shadow-sm ring-1 ring-border/50 dark:bg-zinc-950"
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
                <NativeEmailInspector host={nativeInspectorHost} />
              </EmailEditor>
              )}
            </div>
          </div>
        </section>
      }
      inspector={
        inspectorCollapsed ? null : (
          <div
            className="h-full"
            data-tixkit-email-inspector="true"
            ref={inspectorRef}
          >
            <InspectorPanel
              eyebrow={inspectorHeading[inspectorPanelId].eyebrow}
              onClose={() => setInspectorCollapsed(true)}
              title={inspectorHeading[inspectorPanelId].title}
            >
              {inspectorPanelId === 'style' && (
                <div className="space-y-4">
                  <div
                    className="min-h-[16rem]"
                    data-testid="native-email-inspector-host"
                    ref={setNativeInspectorHost}
                  />
                </div>
              )}

              {inspectorPanelId === 'details' && (
                <div className="space-y-3">
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Template key
                    <input
                      aria-label="Template key"
                      className={inputClassName}
                      disabled={!canEdit}
                      onChange={(change) =>
                        updateEmailDocument({
                          ...emailDocument,
                          settings: {
                            ...emailDocument.settings,
                            templateKey: change.currentTarget.value,
                          },
                        })
                      }
                      value={emailDocument.settings.templateKey}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Locale
                    <input
                      aria-label="Locale"
                      className={inputClassName}
                      disabled={!canEdit}
                      onChange={(change) =>
                        updateEmailDocument({
                          ...emailDocument,
                          settings: {
                            ...emailDocument.settings,
                            locale: change.currentTarget.value,
                          },
                        })
                      }
                      value={emailDocument.settings.locale}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
                    Category
                    <select
                      aria-label="Category"
                      className={inputClassName}
                      disabled={!canEdit}
                      onChange={(change) => {
                        const category = change.currentTarget
                          .value as EmailTemplateDocument['settings']['category'];
                        updateEmailDocument(
                          ensureBulkUnsubscribeFooter({
                            ...emailDocument,
                            settings: {
                              ...emailDocument.settings,
                              category,
                            },
                          }),
                        );
                      }}
                      value={emailDocument.settings.category}
                    >
                      {emailCategoryOptions.map((category) => (
                        <option
                          className="bg-background text-foreground"
                          key={category}
                          value={category}
                        >
                          {category}
                        </option>
                      ))}
                    </select>
                  </label>
                  <dl className="space-y-2 pt-2 text-xs">
                    <div className="flex justify-between gap-4 border-b border-border pb-2">
                      <dt className="text-muted-foreground">Brand scope</dt>
                      <dd className="max-w-[12rem] truncate font-mono text-foreground/80">
                        {document.brandId}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-border pb-2">
                      <dt className="text-muted-foreground">Event scope</dt>
                      <dd className="max-w-[12rem] truncate font-mono text-foreground/80">
                        {document.eventId ?? 'brand'}
                      </dd>
                    </div>
                    {getTemplateLifecycle(
                      emailDocument.settings.templateKey as Parameters<typeof getTemplateLifecycle>[0],
                    ) ? (
                      <>
                        <div className="flex justify-between gap-4 border-b border-border pb-2">
                          <dt className="text-muted-foreground">Lifecycle family</dt>
                          <dd className="max-w-[12rem] truncate text-foreground/80">
                            {
                              getTemplateLifecycle(
                                emailDocument.settings.templateKey as Parameters<typeof getTemplateLifecycle>[0],
                              )!.family
                            }
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4 border-b border-border pb-2">
                          <dt className="text-muted-foreground">Tier</dt>
                          <dd className="max-w-[12rem] truncate text-foreground/80">
                            {
                              getTemplateLifecycle(
                                emailDocument.settings.templateKey as Parameters<typeof getTemplateLifecycle>[0],
                              )!.tier
                            }
                          </dd>
                        </div>
                        <div className="flex justify-between gap-4 border-b border-border pb-2">
                          <dt className="text-muted-foreground">Audience</dt>
                          <dd className="max-w-[12rem] truncate text-foreground/80">
                            {
                              getTemplateLifecycle(
                                emailDocument.settings.templateKey as Parameters<typeof getTemplateLifecycle>[0],
                              )!.defaultAudience
                            }
                          </dd>
                        </div>
                      </>
                    ) : null}
                  </dl>
                </div>
              )}

              {inspectorPanelId === 'variables' && (
                <div className="space-y-2">
                  {typeof brand?.theme.logoUrl === 'string' && brand.theme.logoUrl.trim() ? (
                    <button
                      className="flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                      disabled={!canEdit}
                      onClick={insertBrandLogo}
                      type="button"
                    >
                      <Image className="size-4" />
                      Brand logo
                    </button>
                  ) : null}
                  {variableInsertItems.map(({ key, presentation }) => (
                    <button
                      aria-label={`Insert ${presentation.label}`}
                      className="flex w-full items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                      disabled={!canEdit}
                      key={key}
                      onClick={() => insertEmailVariable(key)}
                      type="button"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{presentation.label}</span>
                        <span className="block truncate text-muted-foreground">
                          {presentation.preview}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-md border px-1.5 py-0.5 font-medium capitalize tixkit-variable-kind-badge tixkit-variable-kind-badge--${presentation.kind}`}
                      >
                        {presentation.kind}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {inspectorPanelId === 'history' && (
                <ol className="space-y-2">
                  {history.map((version) => (
                    <li className="rounded-md border p-3 text-xs" key={version.id}>
                      <div className="font-medium text-foreground">{version.label}</div>
                      <div className="mt-1 text-muted-foreground">{version.timestamp}</div>
                    </li>
                  ))}
                </ol>
              )}

              {inspectorPanelId === 'issues' && (
                <div className="space-y-3">
                  <button
                    className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={!canEdit || reviewState === 'checking'}
                    onClick={() => void reviewCurrentDraft()}
                    type="button"
                  >
                    <Eye className="size-4" />
                    {reviewState === 'checking' ? 'Reviewing...' : 'Review current draft'}
                  </button>
                  {reviewState === 'error' && (
                    <p className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                      Unable to review the current email draft.
                    </p>
                  )}
                  {issuePanelIssues.length === 0 ? (
                    <p className="rounded-md border border-emerald-400/40 bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                      No review blockers.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {issuePanelIssues.map((issue) => (
                        <li
                          className={`rounded-md border p-3 text-xs ${
                            issue.severity === 'error'
                              ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
                              : 'border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                          }`}
                          key={validationIssueKey(issue)}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <strong>{issue.code}</strong>
                            <span className="uppercase tracking-wide">{issue.severity}</span>
                          </div>
                          <p
                            className={`mt-1 ${
                              issue.severity === 'error'
                                ? 'text-red-900 dark:text-red-100'
                                : 'text-amber-900 dark:text-amber-100'
                            }`}
                          >
                            {issue.message}
                          </p>
                          {issue.field && (
                            <p
                              className={`mt-2 font-mono ${
                                issue.severity === 'error'
                                  ? 'text-red-950 dark:text-red-100'
                                  : 'text-amber-950 dark:text-amber-100'
                              }`}
                            >
                              {issue.field}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {inspectorPanelId === 'json' && (
                <pre className="max-h-[42rem] overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                  {JSON.stringify(emailDocument, null, 2)}
                </pre>
              )}
            </InspectorPanel>
          </div>
        )
      }
      reopenInspectorButton={
        inspectorCollapsed ? (
          <InspectorReopenButton onClick={() => setInspectorCollapsed(false)} />
        ) : undefined
      }
    >
      {previewOpen && <PreviewDrawer onClose={() => setPreviewOpen(false)} preview={preview} />}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Send the current draft to one or more test recipients before review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              Recipients
              <textarea
                aria-label="Test recipients"
                className={`${inputClassName} min-h-28 resize-y`}
                disabled={!canEdit || autosave === 'saving'}
                onChange={(change) => setRecipient(change.currentTarget.value)}
                onKeyDown={(keyboardEvent) => {
                  if ((keyboardEvent.metaKey || keyboardEvent.ctrlKey) && keyboardEvent.key === 'Enter') {
                    keyboardEvent.preventDefault();
                    void sendTest();
                  }
                }}
                placeholder="ada@example.test, grace@example.test"
                value={recipient}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Separate addresses with commas or line breaks.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={() => setTestDialogOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={!canEdit || autosave === 'saving'}
              onClick={() => void sendTest()}
              type="button"
            >
              Send test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pick a template</DialogTitle>
            <DialogDescription>
              Start from another email template saved for this brand.
            </DialogDescription>
          </DialogHeader>
          {templateChoices.length === 0 ? (
            <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              No brand email templates are available yet.
            </p>
          ) : (
            <div className="max-h-[28rem] space-y-2 overflow-auto">
              {templateChoices.map((template) => (
                <div
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                  key={template.id}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {template.name}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{template.key}</span>
                      <span>{template.locale}</span>
                      <span>{template.status}</span>
                      {template.eventId ? <span>event template</span> : <span>brand template</span>}
                    </div>
                  </div>
                  <Button
                    disabled={!canEdit}
                    onClick={() => void applyTemplateChoice(template)}
                    type="button"
                    variant="outline"
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setTemplatePickerOpen(false)} type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          setReviewDialogOpen(open);
          if (!open) setReviewConfirmed(false);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Ready to send?</DialogTitle>
            <DialogDescription>
              Review the campaign details and checks before this email is queued.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <dl className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-[7rem_1fr]">
              <dt className="text-muted-foreground">Audience</dt>
              <dd className="font-medium text-foreground">{audienceLabel(audience)}</dd>
              <dt className="text-muted-foreground">When</dt>
              <dd className="font-medium text-foreground">{reviewSendTimeLabel}</dd>
              <dt className="text-muted-foreground">From</dt>
              <dd className="font-medium text-foreground">
                {selectedSenderIdentity
                  ? selectedSenderIdentity.name
                    ? `${selectedSenderIdentity.name} <${selectedSenderIdentity.email}>`
                    : selectedSenderIdentity.email
                  : 'No verified sender'}
              </dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="font-medium text-foreground">{emailDocument.settings.subject}</dd>
              <dt className="text-muted-foreground">Template</dt>
              <dd className="font-mono text-xs text-foreground">
                {emailDocument.settings.templateKey}
              </dd>
            </dl>
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Preflight checks</h3>
              <div
                className={
                  reviewAnalysisFailed
                    ? 'rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
                    : reviewIsAnalyzing
                      ? 'rounded-md border border-sky-400/40 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                      : 'rounded-md border border-sky-400/40 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                }
                role="status"
              >
                <div className="font-medium">
                  {reviewAnalysisFailed
                    ? 'Content analysis failed'
                    : reviewIsAnalyzing
                      ? 'Analyzing your content...'
                      : 'Content analysis complete'}
                </div>
                <p className="mt-1 opacity-80">
                  {reviewAnalysisFailed
                    ? 'Review the error message and try again before sending.'
                    : reviewIsAnalyzing
                      ? 'Checking the current editor export, links, sender, audience, and unsubscribe requirements from the React Email output.'
                      : 'The current editor export, links, sender, audience, and unsubscribe requirements were checked from the saved React Email output.'}
                </p>
              </div>
              {reviewHasInvalidSchedule && (
                <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                  Choose a valid scheduled send time before confirming.
                </p>
              )}
              {reviewState !== 'checked' ? null : reviewBlockingIssues.length === 0 ? (
                <p className="rounded-md border border-emerald-400/40 bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                  No blocking issues found.
                </p>
              ) : (
                <ul className="space-y-2">
                  {reviewBlockingIssues.map((issue) => (
                    <li
                      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
                      key={validationIssueKey(issue)}
                    >
                      <div className="font-medium">{issue.code}</div>
                      <p className="mt-1 opacity-80">{issue.message}</p>
                    </li>
                  ))}
                </ul>
              )}
              {reviewState === 'checked' && reviewWarningIssues.length > 0 && (
                <ul className="space-y-2">
                  {reviewWarningIssues.map((issue) => (
                    <li
                      className="rounded-md border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                      key={validationIssueKey(issue)}
                    >
                      <div className="font-medium">{issue.code}</div>
                      <p className="mt-1 opacity-80">{issue.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">
                    {sendMode === 'scheduled' ? 'Slide to schedule' : 'Slide to send'}
                  </div>
                  <p className="text-muted-foreground">
                    Confirms the reviewed email, audience, and send time.
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-foreground">
                  {reviewConfirmed ? 'Confirmed' : 'Locked'}
                </span>
              </div>
              <input
                aria-label="Slide to confirm email campaign send"
                className="mt-3 h-2 w-full accent-foreground"
                disabled={!reviewCanConfirm}
                max="100"
                min="0"
                onChange={(change) =>
                  setReviewConfirmed(Number(change.currentTarget.value) >= 100)
                }
                type="range"
                value={reviewConfirmed ? 100 : 0}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setReviewDialogOpen(false);
                setReviewConfirmed(false);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={
                !reviewConfirmed || !reviewCanConfirm
              }
              onClick={() => void publishDraft()}
              type="button"
            >
              {sendMode === 'scheduled' ? 'Schedule email' : 'Send email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </EditorChrome>
  );
}
