import * as React from 'react';
import type {
  EventPageBlock,
  EventPageDocument,
} from '@tixkit/content-event-page';

export type SurfaceEditing = {
  /** Raw working document; blocks matched to resolved blocks by id. */
  document: EventPageDocument;
  disabled: boolean;
  onChangeBlock: (blockId: string, block: EventPageBlock) => void;
  /** WYSIWYG slot for rich_text blocks (TipTap in apps). */
  renderRichTextBlock?: (input: {
    block: Extract<EventPageBlock, { type: 'rich_text' }>;
    disabled: boolean;
    onChange: (block: EventPageBlock) => void;
  }) => React.ReactNode;
};

export const SurfaceEditingContext = React.createContext<SurfaceEditing | null>(null);

/** Returns the active editing context, or null in public/preview mode. */
export function useSurfaceEditing(): SurfaceEditing | null {
  return React.useContext(SurfaceEditingContext);
}

export type EditableBlockHandle<T extends EventPageBlock = EventPageBlock> = {
  raw: T;
  disabled: boolean;
  patch: (partial: Partial<T>) => void;
  /** WYSIWYG slot for rich_text blocks, surfaced from the editing context. */
  renderRichTextBlock?: SurfaceEditing['renderRichTextBlock'];
};

/**
 * Returns the raw block for this id, or null when not editing / id missing /
 * type mismatch. The raw block carries the canonical field values that inline
 * edits write to, while the resolved block (rendered by EventPageBlockView)
 * carries the display values derived from the render context.
 *
 * The `type` parameter narrows the handle so `patch` accepts only fields that
 * exist on the specific block variant (Partial over a discriminated union
 * would otherwise only expose shared keys).
 */
export function useEditableBlock<T extends EventPageBlock['type']>(
  blockId: string,
  type: T,
): EditableBlockHandle<Extract<EventPageBlock, { type: T }>> | null {
  const ctx = React.useContext(SurfaceEditingContext);
  if (!ctx) return null;
  const raw = ctx.document.blocks.find((b) => b.id === blockId);
  if (!raw || raw.type !== type) return null;
  const typed = raw as Extract<EventPageBlock, { type: T }>;
  return {
    raw: typed,
    disabled: ctx.disabled,
    patch: (partial) => ctx.onChangeBlock(blockId, { ...typed, ...partial }),
    renderRichTextBlock: ctx.renderRichTextBlock,
  };
}
