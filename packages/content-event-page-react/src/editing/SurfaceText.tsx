import * as React from 'react';
import { SurfaceEditingContext } from './context.js';

export type SurfaceTextProps<C extends React.ElementType = 'span'> = {
  blockId: string;
  /** Raw field name, emitted as data-editable-field for tests/e2e. */
  field: string;
  value: string;
  /** Resolved value shown when not editing (defaults to value). */
  display?: React.ReactNode;
  onCommit: (value: string) => void;
  /** Must match the public tag exactly. */
  as?: C;
  multiline?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
} & Omit<
  React.ComponentPropsWithoutRef<C>,
  | 'as'
  | 'children'
  | 'className'
  | 'contentEditable'
  | 'onInput'
  | 'onBlur'
  | 'onFocus'
  | 'onKeyDown'
  | 'dangerouslySetInnerHTML'
>;

/**
 * Inline editable text node. In public/preview mode (no SurfaceEditingContext)
 * renders a bare tag identical to public output. In edit mode renders the same
 * tag plus contenteditable + binding attributes, never adding wrapper elements
 * so the DOM shape stays pixel-identical to the public surface.
 *
 * Uncontrolled while focused (so the caret is never clobbered mid-edit); synced
 * from props via effect when not focused.
 */
export function SurfaceText<C extends React.ElementType = 'span'>({
  blockId: _blockId,
  field,
  value,
  display,
  onCommit,
  as,
  multiline = false,
  placeholder,
  ariaLabel,
  className,
  ...rest
}: SurfaceTextProps<C>) {
  const Tag = (as ?? 'span') as React.ElementType;
  const ctx = React.useContext(SurfaceEditingContext);
  const ref = React.useRef<HTMLElement | null>(null);
  const focusedRef = React.useRef(false);

  React.useEffect(() => {
    if (!ctx || !ref.current) return;
    if (focusedRef.current) return;
    if (ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [ctx, value]);

  if (!ctx) {
    return React.createElement(Tag, { className, ...rest }, display ?? value);
  }

  const editable = !ctx.disabled;
  return React.createElement(
    Tag,
    {
      ...rest,
      ref: ref as React.Ref<HTMLElement>,
      className,
      contentEditable: editable,
      suppressContentEditableWarning: true,
      'data-editable-field': field,
      'data-placeholder': placeholder,
      role: multiline ? 'textbox' : undefined,
      'aria-label': ariaLabel,
      'aria-multiline': multiline || undefined,
      'aria-disabled': ctx.disabled || undefined,
      spellCheck: false,
      onInput: (event: React.FormEvent<HTMLElement>) => {
        onCommit((event.target as HTMLElement).textContent ?? '');
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        focusedRef.current = false;
        onCommit(event.currentTarget.textContent?.trim() ?? '');
      },
      onFocus: () => {
        focusedRef.current = true;
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (!multiline && event.key === 'Enter') {
          event.preventDefault();
        }
      },
    },
    display ?? value,
  );
}
