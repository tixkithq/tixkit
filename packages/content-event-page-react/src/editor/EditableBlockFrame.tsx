import * as React from 'react';

export type EditableBlockFrameProps = {
  blockId: string;
  blockType: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: (blockId: string) => void;
  children: React.ReactNode;
};

/**
 * Selection-aware frame rendered around each editable block in the admin canvas.
 * Mirrors the public surface section structure with .tk-ep-section + data-block-id,
 * adding the selection outline, block label, and click-to-select affordance.
 */
export function EditableBlockFrame({
  blockId,
  blockType,
  label,
  selected = false,
  disabled = false,
  onSelect,
  children,
}: EditableBlockFrameProps) {
  return (
    <section
      className={`tk-ep-section ${selected ? 'tk-ep-section--selected' : ''}`}
      data-block-id={blockId}
      data-block-type={blockType}
      data-selected={selected || undefined}
      aria-label={`${label} block`}
    >
      <div className="tk-ep-section__label" contentEditable={false}>
        <button
          type="button"
          className="tk-ep-section__select"
          aria-pressed={selected}
          disabled={disabled}
          onClick={() => onSelect?.(blockId)}
        >
          {label}
        </button>
        {selected && <span className="tk-ep-section__badge">Selected</span>}
      </div>
      <div className="tk-ep-section__content" contentEditable={false}>
        {children}
      </div>
    </section>
  );
}
