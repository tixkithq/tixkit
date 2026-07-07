import { describe, expect, it } from 'vitest';
import { computeOverlayPlacement } from '../index.js';

function rect(top: number, left: number, width: number, height: number): DOMRectReadOnly {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}

describe('computeOverlayPlacement', () => {
  it('translates a block rect into canvas-relative coordinates', () => {
    const placement = computeOverlayPlacement(
      rect(120, 80, 300, 200),
      rect(20, 40, 800, 600),
      { top: 0, left: 0 },
    );
    expect(placement).toEqual({ top: 100, left: 40, width: 300, height: 200 });
  });

  it('adds canvas scroll offset for content-relative positioning', () => {
    const placement = computeOverlayPlacement(
      rect(50, 30, 100, 50),
      rect(10, 10, 500, 400),
      { top: 250, left: 0 },
    );
    expect(placement).toEqual({ top: 290, left: 20, width: 100, height: 50 });
  });

  it('handles a block at the canvas origin', () => {
    const placement = computeOverlayPlacement(
      rect(10, 10, 50, 50),
      rect(10, 10, 500, 400),
      { top: 0, left: 0 },
    );
    expect(placement).toEqual({ top: 0, left: 0, width: 50, height: 50 });
  });
});
