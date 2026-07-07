import * as React from 'react';

export type EditableBlockFrameProps = {
  blockId: string;
  blockType: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: (blockId: string) => void;
  onDelete?: (blockId: string) => void;
  onDuplicate?: (blockId: string) => void;
  onMoveUp?: (blockId: string) => void;
  onMoveDown?: (blockId: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  children: React.ReactNode;
};

/**
 * Selection-aware frame rendered around each editable block in the admin canvas.
 * Mirrors the public surface section structure with .tk-ep-section + data-block-id,
 * adding the selection outline, block label, click-to-select affordance, and
 * block management actions (delete, duplicate, move up/down) shown when selected.
 */
export function EditableBlockFrame({
  blockId,
  blockType,
  label,
  selected = false,
  disabled = false,
  onSelect,
  onDelete,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
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
        {selected && !disabled && (
          <div className="tk-ep-section__actions">
            <button
              type="button"
              className="tk-ep-section__action"
              aria-label={`Move ${label} up`}
              disabled={!canMoveUp}
              onClick={() => onMoveUp?.(blockId)}
            >
              ↑
            </button>
            <button
              type="button"
              className="tk-ep-section__action"
              aria-label={`Move ${label} down`}
              disabled={!canMoveDown}
              onClick={() => onMoveDown?.(blockId)}
            >
              ↓
            </button>
            <button
              type="button"
              className="tk-ep-section__action"
              aria-label={`Duplicate ${label}`}
              onClick={() => onDuplicate?.(blockId)}
            >
              ⧉
            </button>
            <button
              type="button"
              className="tk-ep-section__action tk-ep-section__action--danger"
              aria-label={`Delete ${label}`}
              onClick={() => onDelete?.(blockId)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      <div className="tk-ep-section__content" contentEditable={false}>
        {children}
      </div>
    </section>
  );
}
