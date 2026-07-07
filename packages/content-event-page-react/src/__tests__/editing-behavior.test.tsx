import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  type EventPageBlock,
  type EventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageSurface, type SurfaceEditing } from '../index.js';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    venueName: 'The Salt Shed',
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.example.test' },
  tickets: [
    { id: 'tt_ga', name: 'General Admission', status: 'active', priceLabel: '$35.00' },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden', priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
};

function makeDocument(): EventPageDocument {
  return createDefaultEventPageDocument({
    eventId: 'evt_demo_001',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night of access.',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
  });
}

function renderEdit(doc: EventPageDocument, editing: Partial<SurfaceEditing> = {}) {
  const onChangeBlock = vi.fn();
  const resolved = resolveEventPageDocument(doc, context, {
    allowUnsafeEmbeds: true,
    mode: 'edit',
  });
  const editingValue: SurfaceEditing = {
    document: doc,
    disabled: false,
    onChangeBlock,
    ...editing,
  };
  const utils = render(
    <EventPageSurface resolvedPage={resolved} mode="edit" editing={editingValue} />,
  );
  return { ...utils, onChangeBlock, resolved };
}

describe('EventPageSurface edit-mode behavior', () => {
  it('editing hero headline calls onChangeBlock with the raw hero block and new value', () => {
    const doc = makeDocument();
    const { container, onChangeBlock } = renderEdit(doc);
    const headline = container.querySelector('[data-editable-field="headline"]') as HTMLElement;
    expect(headline).not.toBeNull();
    headline.textContent = 'Updated headline';
    fireEvent.input(headline);
    expect(onChangeBlock).toHaveBeenCalledTimes(1);
    const [blockId, block] = onChangeBlock.mock.calls[0];
    expect(blockId).toBe('hero');
    expect(block).toMatchObject({ type: 'hero', id: 'hero', headline: 'Updated headline' });
  });

  it('excludes hidden ticket types in edit mode (renders resolved tickets read-only)', () => {
    const doc = makeDocument();
    const { container } = renderEdit(doc);
    const names = Array.from(container.querySelectorAll('.tk-ep-tickets ul li strong')).map(
      (el) => el.textContent,
    );
    expect(names).toContain('General Admission');
    expect(names).not.toContain('Hidden comp');
  });

  it('CTA click does not navigate in edit mode', () => {
    const doc = makeDocument();
    const { container } = renderEdit(doc);
    const heroCta = container.querySelector<HTMLAnchorElement>('.tk-ep-hero .tk-ep-button');
    expect(heroCta).not.toBeNull();
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    heroCta!.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(true);
  });

  it('renders an invalid document in edit mode (editors see blockers)', () => {
    const doc = makeDocument();
    // Remove the tickets block -> missing_tickets validation error -> invalid.
    doc.blocks = doc.blocks.filter((b) => b.type !== 'tickets');
    const { container } = renderEdit(doc);
    // Edit mode still renders the remaining blocks (e.g. hero) instead of null.
    expect(container.querySelector('.tk-ep-hero')).not.toBeNull();
    expect(container.querySelector('[data-testid="tixkit-event-page"]')).not.toBeNull();
  });

  it('rich_text slot receives the raw block and propagates onChange', () => {
    const doc = makeDocument();
    const richBlock: Extract<EventPageBlock, { type: 'rich_text' }> = {
      id: 'rich-1',
      type: 'rich_text',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Copy' }] }],
      },
    };
    doc.blocks.push(richBlock);
    const slot = vi.fn(({ block, onChange }) => (
      <button
        type="button"
        data-testid="rich-slot"
        onClick={() =>
          onChange({
            ...block,
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Updated' }] }],
            },
          })
        }
      >
        WYSIWYG
      </button>
    ));
    const { container, onChangeBlock } = renderEdit(doc, { renderRichTextBlock: slot });
    expect(slot).toHaveBeenCalledTimes(1);
    const [input] = slot.mock.calls[0];
    expect(input.block).toEqual(richBlock);
    const button = container.querySelector('[data-testid="rich-slot"]') as HTMLButtonElement;
    fireEvent.click(button);
    expect(onChangeBlock).toHaveBeenCalledWith(
      'rich-1',
      expect.objectContaining({ type: 'rich_text' }),
    );
    const [, updated] = onChangeBlock.mock.calls[0];
    expect((updated as EventPageBlock).type === 'rich_text').toBe(true);
  });

  it('renders the empty state when the document has only chrome blocks', () => {
    const doc = makeDocument();
    const chromeTypes = new Set(['event_header', 'resale_tickets', 'brand_footer']);
    doc.blocks = doc.blocks.filter((b) => chromeTypes.has(b.type));
    const { container } = renderEdit(doc);
    expect(container.querySelector('[data-testid="tk-ep-empty-state"]')).not.toBeNull();
  });
});
