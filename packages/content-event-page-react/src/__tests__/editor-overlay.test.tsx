import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, within } from '@testing-library/react';
import * as React from 'react';
import { EditorOverlayLayer } from '../index.js';

type BlockDef = { id: string; type: 'hero' | 'tickets' | 'faq'; label: string };

const blocks: BlockDef[] = [
  { id: 'a', type: 'hero', label: 'Hero' },
  { id: 'b', type: 'tickets', label: 'Tickets' },
  { id: 'c', type: 'faq', label: 'FAQ' },
];

function rectMock(top: number, left: number, width: number, height: number) {
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
  } as DOMRect;
}

let getRectSpy: ReturnType<typeof vi.spyOn> | undefined;

function setupRectMock(selectedBlockId?: string) {
  getRectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
  getRectSpy.mockImplementation(function (this: Element) {
    const id = this.getAttribute('data-block-id');
    if (id === 'a') return rectMock(0, 0, 720, 120);
    if (id === 'b') return rectMock(120, 0, 720, 80);
    if (id === 'c') return rectMock(200, 0, 720, 100);
    // canvas container (no data-block-id)
    return rectMock(0, 0, 720, 600);
  });
  void selectedBlockId;
}

beforeEach(() => {
  setupRectMock();
});

afterEach(() => {
  getRectSpy?.mockRestore();
  cleanup();
});

function renderOverlay(props: Partial<React.ComponentProps<typeof EditorOverlayLayer>> = {}) {
  const canvasRef = React.createRef<HTMLDivElement>();
  const onSelectBlock = vi.fn();
  const onDeleteBlock = vi.fn();
  const onDuplicateBlock = vi.fn();
  const onMoveBlock = vi.fn();
  const utils = render(
    <div style={{ position: 'relative' }}>
      <div ref={canvasRef}>
        {blocks.map((b) => (
          <div key={b.id} data-block-id={b.id} style={{ height: 80 }}>
            {b.label}
          </div>
        ))}
      </div>
      <EditorOverlayLayer
        canvasRef={canvasRef}
        blocks={blocks}
        onSelectBlock={onSelectBlock}
        onDeleteBlock={onDeleteBlock}
        onDuplicateBlock={onDuplicateBlock}
        onMoveBlock={onMoveBlock}
        {...props}
      />
    </div>,
  );
  return { ...utils, canvasRef, onSelectBlock, onDeleteBlock, onDuplicateBlock, onMoveBlock };
}

describe('EditorOverlayLayer', () => {
  it('renders one overlay hit area per block', () => {
    const { container } = renderOverlay();
    const hits = container.querySelectorAll('[data-overlay-hit]');
    expect(hits.length).toBe(3);
    expect(container.querySelector('[data-overlay-hit="a"]')).not.toBeNull();
    expect(container.querySelector('[data-overlay-hit="b"]')).not.toBeNull();
    expect(container.querySelector('[data-overlay-hit="c"]')).not.toBeNull();
  });

  it('clicking a hit area selects that block', () => {
    const { container, onSelectBlock } = renderOverlay();
    fireEvent.click(container.querySelector('[data-overlay-hit="b"]')!);
    expect(onSelectBlock).toHaveBeenCalledWith('b');
  });

  it('does not re-select when clicking the already-selected block hit area', () => {
    const { container, onSelectBlock } = renderOverlay({ selectedBlockId: 'a' });
    fireEvent.click(container.querySelector('[data-overlay-hit="a"]')!);
    expect(onSelectBlock).not.toHaveBeenCalled();
  });

  it('shows the toolbar only for the selected block', () => {
    const first = renderOverlay({ selectedBlockId: 'b' });
    // Only one toolbar label is rendered (the selected block's).
    const toolbars = first.container.querySelectorAll('.tk-ep-overlay__toolbar-label');
    expect(toolbars.length).toBe(1);
    expect(toolbars[0].textContent).toBe('Tickets');
  });

  it('exposes selected block toolbar actions outside aria-hidden chrome', () => {
    const { getByRole } = renderOverlay({ selectedBlockId: 'b' });
    const toolbar = getByRole('toolbar', { name: 'Tickets block actions' });
    const buttons = [
      within(toolbar).getByRole('button', { name: 'Move Tickets up' }),
      within(toolbar).getByRole('button', { name: 'Move Tickets down' }),
      within(toolbar).getByRole('button', { name: 'Duplicate Tickets' }),
      within(toolbar).getByRole('button', { name: 'Delete Tickets' }),
    ];

    expect(toolbar.closest('[aria-hidden="true"]')).toBeNull();
    for (const button of buttons) {
      expect(button.closest('[aria-hidden="true"]')).toBeNull();
    }
  });

  it('disables move up for the first block and move down for the last block', () => {
    const { container } = renderOverlay({ selectedBlockId: 'a' });
    const moveUp = container.querySelector<HTMLButtonElement>('[aria-label="Move Hero up"]')!;
    const moveDown = container.querySelector<HTMLButtonElement>('[aria-label="Move Hero down"]')!;
    expect(moveUp.disabled).toBe(true);
    expect(moveDown.disabled).toBe(false);

    cleanup();
    getRectSpy?.mockRestore();
    setupRectMock();
    const last = renderOverlay({ selectedBlockId: 'c' });
    const lastUp = last.container.querySelector<HTMLButtonElement>('[aria-label="Move FAQ up"]')!;
    const lastDown = last.container.querySelector<HTMLButtonElement>(
      '[aria-label="Move FAQ down"]',
    )!;
    expect(lastUp.disabled).toBe(false);
    expect(lastDown.disabled).toBe(true);
  });

  it('fires delete and duplicate callbacks with the block id', () => {
    const { container, onDeleteBlock, onDuplicateBlock } = renderOverlay({ selectedBlockId: 'b' });
    fireEvent.click(container.querySelector('[aria-label="Delete Tickets"]')!);
    expect(onDeleteBlock).toHaveBeenCalledWith('b');
    fireEvent.click(container.querySelector('[aria-label="Duplicate Tickets"]')!);
    expect(onDuplicateBlock).toHaveBeenCalledWith('b');
  });

  it('fires move up/down with the block id and direction', () => {
    const { container, onMoveBlock } = renderOverlay({ selectedBlockId: 'b' });
    fireEvent.click(container.querySelector('[aria-label="Move Tickets up"]')!);
    expect(onMoveBlock).toHaveBeenCalledWith('b', 'up');
    fireEvent.click(container.querySelector('[aria-label="Move Tickets down"]')!);
    expect(onMoveBlock).toHaveBeenCalledWith('b', 'down');
  });

  it('sets pointer-events: none on the selected block hit area', () => {
    const { container } = renderOverlay({ selectedBlockId: 'a' });
    const selectedHit = container.querySelector('[data-overlay-hit="a"]') as HTMLElement;
    const otherHit = container.querySelector('[data-overlay-hit="b"]') as HTMLElement;
    expect(selectedHit.style.pointerEvents).toBe('none');
    expect(otherHit.style.pointerEvents).toBe('auto');
  });

  it('all chrome carries data-editor-chrome and lives outside the page content', () => {
    const { container } = renderOverlay({ selectedBlockId: 'a' });
    const overlay = container.querySelector('.tk-ep-overlay')!;
    expect(overlay.getAttribute('data-editor-chrome')).not.toBeNull();
    // The overlay is a sibling of the canvas content, not inside a block.
    expect(overlay.closest('[data-block-id]')).toBeNull();
  });
});
