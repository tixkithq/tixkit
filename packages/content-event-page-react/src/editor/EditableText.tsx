import * as React from 'react';

export type EditableTextProps = {
  value: string;
  onChange: (value: string) => void;
  as?: React.ElementType;
  multiline?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
};

/**
 * Inline editable text control used by the admin canvas edit mode.
 * Renders a contenteditable element bound to the canonical block field.
 */
export function EditableText({
  value,
  onChange,
  as,
  multiline = false,
  disabled = false,
  placeholder,
  className,
  ariaLabel,
}: EditableTextProps) {
  const Tag = as ?? 'span';
  const ref = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  return (
    <Tag
      ref={ref as React.Ref<HTMLElement>}
      className={className}
      contentEditable={!disabled}
      suppressContentEditableWarning
      aria-multiline={multiline || undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      onInput={(event: React.FormEvent<HTMLElement>) =>
        onChange((event.target as HTMLElement).textContent ?? '')
      }
      onBlur={(event: React.FocusEvent<HTMLElement>) =>
        onChange(event.currentTarget.textContent?.trim() ?? '')
      }
    />
  );
}
