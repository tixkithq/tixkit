'use client';

import * as React from 'react';
import { Image, Variable } from 'lucide-react';
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  BubbleMenu,
  type TriggerFn,
} from '@react-email/editor/ui';
import { NodeSelection } from '@tiptap/pm/state';
import { useCurrentEditor, useEditorState } from '@tiptap/react';

export type EmailBubbleSelectionState = {
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

export type EmailSelectionRestoreDetail = EmailBubbleSelectionState & {
  focusEditor?: boolean;
  // When true, the restore only refreshes the merge-tag plugin's `active`
  // selection state without re-setting the editor's ProseMirror selection.
  // Used by inspector controls so a `text`-scoped stored selection does not
  // unmount the inspector (and steal focus from the clicked input).
  softRestore?: boolean;
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

export const emailBubbleHiddenNodes = ['horizontalRule'];
const emailBubbleNodeSelectionNodes = ['button', 'image', 'section', 'columnsColumn'];
const emailBubbleControlFocusWindowMs = 2500;
const emailBubbleControlSelector =
  '[data-tixkit-email-bubble-controls="true"], .tixkit-email-bubble-control';
const emailBubbleControlUntilAttribute = 'data-tixkit-email-bubble-control-until';
let lastEmailBubbleControlInteractionAt = 0;
export let latestEmailBubbleSelection: EmailBubbleSelectionState | null = null;

function emailBubbleInteractionTime(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function markEmailBubbleControlInteraction() {
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
      emailBubbleControlFocusWindowMs || Date.now() < sharedUntil
  );
}

function emailBubbleControlTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(emailBubbleControlSelector) : null;
}

export function rememberEmailBubbleSelection(selection: EmailBubbleSelectionState | null) {
  latestEmailBubbleSelection = selection;
}

function currentEmailBubbleSelection(
  selection: EmailBubbleSelectionState | null,
  refSelection: EmailBubbleSelectionState | null,
): EmailBubbleSelectionState | null {
  return selection ?? refSelection ?? latestEmailBubbleSelection;
}

export const emailBubbleMenuTrigger: TriggerFn = ({ editor, state }) => {
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

export function isEmailBubbleSelectionState(value: unknown): value is EmailBubbleSelectionState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EmailBubbleSelectionState>;
  return typeof candidate.from === 'number' && typeof candidate.to === 'number';
}

export function TixkitEmailBubbleMenu() {
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
