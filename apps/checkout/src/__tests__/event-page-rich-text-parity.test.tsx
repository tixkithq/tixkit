import './test-dom';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import * as React from 'react';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  type EventPageBlock,
  type EventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageSurface, type SurfaceEditing } from '@tixkit/content-event-page-react';
import { EventPageRichTextEditor } from '@/components/event-page-rich-text-editor';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/evt_1',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_1',
    venueName: 'The Salt Shed',
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.example.test' },
  tickets: [{ id: 'tt_ga', name: 'GA', status: 'active', priceLabel: '$35' }],
};

const richBlock: Extract<EventPageBlock, { type: 'rich_text' }> = {
  id: 'rich-parity',
  type: 'rich_text',
  content: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' with ' },
          { type: 'text', text: 'italics', marks: [{ type: 'italic' }] },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2, textAlign: 'left' },
        content: [{ type: 'text', text: 'Section title' }],
      },
    ],
  },
};

function docWithRichText(): EventPageDocument {
  const base = createDefaultEventPageDocument({
    eventId: 'evt_1',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night.',
    checkoutUrl: '{{event.checkoutUrl}}',
    publicUrl: '{{event.publicUrl}}',
  });
  return { ...base, blocks: [...base.blocks, richBlock] };
}

/**
 * Strip ProseMirror/editor-only attributes and classes so TipTap DOM can be
 * structurally compared to the server-resolved public HTML.
 */
function normalizeInnerHtml(html: string): string {
  return html
    .replace(
      /\s*(contenteditable|spellcheck|role|aria-multiline|aria-label|data-placeholder|translate|tabindex)="[^"]*"/g,
      '',
    )
    .replace(/\s*data-pm-[a-z-]+="[^"]*"/g, '')
    .replace(/class="([^"]*)"/g, (_m, classes: string) => {
      const kept = classes
        .split(/\s+/)
        .filter(
          (c) => c && c !== 'ProseMirror' && c !== 'tiptap' && c !== 'tk-ep-rich-text__content',
        )
        .join(' ');
      return kept ? ` class="${kept}"` : '';
    })
    .replace(/\s+style="([^"]*)"/g, (_m, styles: string) => {
      const norm = styles
        .replace(/\s*;\s*/g, ';')
        .replace(/;$/, '')
        .trim();
      return norm ? ` style="${norm}"` : '';
    })
    .replace(/\s+>/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderBoth() {
  const doc = docWithRichText();
  const resolved = resolveEventPageDocument(doc, context, { mode: 'edit' });
  const onChangeBlock = vi.fn();
  const editing: SurfaceEditing = {
    document: doc,
    disabled: false,
    onChangeBlock,
    renderRichTextBlock: ({ block, disabled, onChange }) => (
      <EventPageRichTextEditor block={block} disabled={disabled} onChange={onChange} />
    ),
  };
  const editSurface = render(
    <EventPageSurface resolvedPage={resolved} mode="edit" editing={editing} />,
  );
  const publicSurface = render(<EventPageSurface resolvedPage={resolved} mode="public" />);
  return { doc, resolved, editing, onChangeBlock, editSurface, publicSurface };
}

describe('rich_text TipTap parity contract', () => {
  it('renders the TipTap editor inside the same block wrapper as public', async () => {
    const { editSurface, publicSurface } = renderBoth();

    await waitFor(() => {
      expect(editSurface.container.querySelector('.ProseMirror')).not.toBeNull();
    });

    const editSection = editSurface.container.querySelector('[data-block-id="rich-parity"]');
    const publicSection = publicSurface.container.querySelector('[data-block-id="rich-parity"]');
    expect(editSection).not.toBeNull();
    expect(publicSection).not.toBeNull();
    expect(editSection?.className).toBe('tk-ep-rich-text');
    expect(publicSection?.className).toBe('tk-ep-rich-text');
  });

  it('TipTap editor inner DOM matches public renderer HTML', async () => {
    const { editSurface, publicSurface } = renderBoth();

    await waitFor(() => {
      expect(editSurface.container.querySelector('.ProseMirror')).not.toBeNull();
    });

    // Edit: the TipTap content lives inside the .ProseMirror element.
    const editContent = editSurface.container.querySelector('.ProseMirror') as HTMLElement;
    // Public: the section innerHTML is the server-resolved HTML.
    const publicSection = publicSurface.container.querySelector(
      '[data-block-id="rich-parity"]',
    ) as HTMLElement;

    const editHtml = normalizeInnerHtml(editContent.innerHTML);
    const publicHtml = normalizeInnerHtml(publicSection.innerHTML);

    expect(editHtml).toBe(publicHtml);
  });

  it('propagates TipTap edits via onChange to the SurfaceEditing context', async () => {
    const { editSurface, onChangeBlock } = renderBoth();

    const editor = await waitFor(() => {
      const el = editSurface.container.querySelector('.ProseMirror') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });

    // Simulate a user keystroke by setting textContent and dispatching input.
    editor.innerHTML = '<p>Edited rich text</p>';
    editSurface.container.dispatchEvent(new Event('input', { bubbles: true }));

    await waitFor(() => {
      expect(onChangeBlock).toHaveBeenCalledWith(
        'rich-parity',
        expect.objectContaining({ type: 'rich_text' }),
      );
    });
  });
});
