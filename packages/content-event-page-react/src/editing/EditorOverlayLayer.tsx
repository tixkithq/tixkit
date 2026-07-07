import * as React from 'react';
import type { EventPageBlock } from '@tixkit/content-event-page';
import { useBlockRects, type OverlayPlacement } from './use-block-rects.js';

export type EditorOverlayLayerProps = {
  canvasRef: React.RefObject<HTMLElement | null>;
  blocks: Array<{ id: string; type: EventPageBlock['type']; label: string }>;
  selectedBlockId?: string;
  disabled?: boolean;
  onSelectBlock: (blockId: string) => void;
  onDeleteBlock: (blockId: string) => void;
  onDuplicateBlock: (blockId: string) => void;
  onMoveBlock: (blockId: string, direction: 'up' | 'down') => void;
};

const TOOLBAR_HEIGHT = 40;

/**
 * Puck-style overlay chrome: hover outlines, selection frame, and a per-block
 * toolbar rendered in an absolutely positioned layer that measures
 * `[data-block-id]` rects and never participates in page layout. All chrome
 * carries `data-editor-chrome` and lives outside `.tixkit-event-page`, so the
 * parity harness never sees it.
 *
 * The hit area for the selected block is disabled (pointer-events: none) so
 * clicks reach the inline contenteditable instead of re-selecting the block.
 */
export function EditorOverlayLayer({
  canvasRef,
  blocks,
  selectedBlockId,
  disabled = false,
  onSelectBlock,
  onDeleteBlock,
  onDuplicateBlock,
  onMoveBlock,
}: EditorOverlayLayerProps) {
  const blockIds = React.useMemo(() => blocks.map((b) => b.id), [blocks]);
  const rects = useBlockRects(canvasRef, blockIds);
  const [hoveredId, setHoveredId] = React.useState<string | undefined>(undefined);

  return (
    <div className="tk-ep-overlay" data-editor-chrome aria-hidden>
      {blocks.map((block, index) => {
        const placement = rects.get(block.id);
        if (!placement) return null;
        const selected = block.id === selectedBlockId;
        const canMoveUp = index > 0;
        const canMoveDown = index < blocks.length - 1;
        const flipBelow = placement.top < TOOLBAR_HEIGHT;
        return (
          <div
            key={block.id}
            className="tk-ep-overlay__slot"
            style={slotStyle(placement)}
            data-editor-chrome
          >
            <button
              type="button"
              className={
                selected
                  ? 'tk-ep-overlay__hit tk-ep-overlay__hit--selected'
                  : 'tk-ep-overlay__hit'
              }
              style={{ pointerEvents: selected || disabled ? 'none' : 'auto' }}
              data-overlay-hit={block.id}
              tabIndex={-1}
              aria-label={`Select ${block.label} block`}
              onClick={() => {
                if (!disabled && !selected) onSelectBlock(block.id);
              }}
              onMouseEnter={() => setHoveredId(block.id)}
              onMouseLeave={() => setHoveredId((current) => (current === block.id ? undefined : current))}
            />
            {!selected && hoveredId === block.id ? (
              <div className="tk-ep-overlay__hover" data-editor-chrome />
            ) : null}
            {selected ? (
              <>
                <div className="tk-ep-overlay__selected" data-editor-chrome />
                <div
                  className={
                    flipBelow
                      ? 'tk-ep-overlay__toolbar tk-ep-overlay__toolbar--below'
                      : 'tk-ep-overlay__toolbar'
                  }
                  data-editor-chrome
                >
                  <span className="tk-ep-overlay__toolbar-label" data-editor-chrome>
                    {block.label}
                  </span>
                  <div className="tk-ep-overlay__toolbar-actions" data-editor-chrome>
                    <button
                      type="button"
                      className="tk-ep-overlay__action"
                      aria-label={`Move ${block.label} up`}
                      disabled={!canMoveUp}
                      onClick={() => onMoveBlock(block.id, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="tk-ep-overlay__action"
                      aria-label={`Move ${block.label} down`}
                      disabled={!canMoveDown}
                      onClick={() => onMoveBlock(block.id, 'down')}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="tk-ep-overlay__action"
                      aria-label={`Duplicate ${block.label}`}
                      onClick={() => onDuplicateBlock(block.id)}
                    >
                      ⧉
                    </button>
                    <button
                      type="button"
                      className="tk-ep-overlay__action tk-ep-overlay__action--danger"
                      aria-label={`Delete ${block.label}`}
                      onClick={() => onDeleteBlock(block.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function slotStyle(placement: OverlayPlacement): React.CSSProperties {
  return {
    position: 'absolute',
    top: placement.top,
    left: placement.left,
    width: placement.width,
    height: placement.height,
  };
}
