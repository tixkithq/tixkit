import * as React from 'react';

export type OverlayPlacement = {
  top: number;
  left: number;
  width: number;
  height: number;
};

/**
 * Pure placement math: translates a block's viewport rect into coordinates
 * relative to the canvas container, adding scroll offset for content-relative
 * positioning. Unit-testable without a DOM.
 */
export function computeOverlayPlacement(
  blockRect: DOMRectReadOnly,
  canvasRect: DOMRectReadOnly,
  canvasScroll: { top: number; left: number },
): OverlayPlacement {
  return {
    top: blockRect.top - canvasRect.top + canvasScroll.top,
    left: blockRect.left - canvasRect.left + canvasScroll.left,
    width: blockRect.width,
    height: blockRect.height,
  };
}

/**
 * Measures [data-block-id] descendants of the canvas and returns their overlay
 * placements. Re-measures on ResizeObserver (per block + canvas), window
 * resize, scroll (rAF-throttled), and MutationObserver childList changes.
 *
 * In jsdom (no ResizeObserver/MutationObserver) only the initial layout
 * measurement runs, which is enough for unit tests that mock
 * getBoundingClientRect.
 */
export function useBlockRects(
  canvasRef: React.RefObject<HTMLElement | null>,
  blockIds: readonly string[],
): ReadonlyMap<string, OverlayPlacement> {
  const [rects, setRects] = React.useState<ReadonlyMap<string, OverlayPlacement>>(
    new Map(),
  );

  const blockIdsKey = blockIds.join('\n');

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const measure = () => {
      const canvasEl = canvasRef.current;
      if (!canvasEl) return;
      const canvasRect = canvasEl.getBoundingClientRect();
      const next = new Map<string, OverlayPlacement>();
      for (const id of blockIds) {
        const el = canvasEl.querySelector(`[data-block-id="${cssEscape(id)}"]`);
        if (!el) continue;
        next.set(id, computeOverlayPlacement(el.getBoundingClientRect(), canvasRect, { top: 0, left: 0 }));
      }
      setRects(next);
    };

    measure();

    let rafId = 0;
    const scheduleMeasure = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(measure);
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(scheduleMeasure)
        : null;
    resizeObserver?.observe(canvas);
    canvas.querySelectorAll('[data-block-id]').forEach((el) => resizeObserver?.observe(el));

    const mutationObserver =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(scheduleMeasure)
        : null;
    mutationObserver?.observe(canvas, { childList: true, subtree: true, attributes: true });

    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, true);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure, true);
      if (rafId) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, blockIdsKey]);

  return rects;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
