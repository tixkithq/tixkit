import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import * as React from 'react';
import EventPageEditOverlay from '@/app/e/[eventId]/event-page-edit-overlay';
import {
  createDefaultEventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';

const postMessageMock = vi.fn();

vi.mock('@/lib/api', () => {
  class CheckoutApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = 'CheckoutApiError';
    }
  }
  return {
    publicApi: { getDraftPreview: vi.fn() },
    CheckoutApiError,
    userFacingMessage: (e: unknown) => (e instanceof Error ? e.message : 'Error'),
  };
});

vi.mock('@/lib/brand', () => ({
  brandThemeStyle: () => undefined,
}));

vi.mock('@/lib/use-brand', () => ({
  useResolvedBrand: () => ({ id: 'b1', name: 'Tixkit' }),
}));

vi.mock('@/components/event-page-rich-text-editor', () => ({
  EventPageRichTextEditor: ({ block }: { block: { id: string } }) =>
    React.createElement('div', { 'data-testid': `rich-text-${block.id}` }, 'WYSIWYG'),
}));

vi.mock('@tixkit/content-event-page-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tixkit/content-event-page-react')>();
  const ReactModule = await import('react');
  return {
    ...actual,
    EditorOverlayLayer: ({
      blocks,
      onDuplicateBlock,
    }: {
      blocks: Array<{ id: string; label: string }>;
      onDuplicateBlock: (blockId: string) => void;
    }) =>
      ReactModule.createElement(
        'div',
        { 'data-testid': 'editor-overlay-layer' },
        blocks.map((block) =>
          ReactModule.createElement(
            'button',
            {
              key: block.id,
              type: 'button',
              'aria-label': `Duplicate ${block.label}`,
              onClick: () => onDuplicateBlock(block.id),
            },
            `Duplicate ${block.label}`,
          ),
        ),
      ),
  };
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.test/e/e1',
    checkoutUrl: 'https://checkout.test/checkout?eventId=e1',
    venueName: 'The Salt Shed',
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.test' },
  tickets: [{ id: 'tt_ga', name: 'GA', status: 'active', priceLabel: '$35' }],
};

const { publicApi } = await import('@/lib/api');
const publicApiMock = publicApi as unknown as { getDraftPreview: ReturnType<typeof vi.fn> };

const PARENT_SOURCE = 'tixkit-event-page-admin';

function seedDraft() {
  const doc = createDefaultEventPageDocument({
    eventId: 'e1',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night.',
    checkoutUrl: 'https://checkout.test/checkout?eventId=e1',
  });
  publicApiMock.getDraftPreview.mockResolvedValue({
    contentJson: doc,
    context,
    validation: { valid: true, severity: 'ok', issues: [] },
  });
  return doc;
}

function defaultEventPageDocument() {
  return createDefaultEventPageDocument({
    eventId: 'e1',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night.',
    checkoutUrl: 'https://checkout.test/checkout?eventId=e1',
  });
}

function headlineField(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-editable-field="headline"]') as HTMLElement;
}

beforeEach(() => {
  postMessageMock.mockClear();
  Object.defineProperty(window, 'parent', {
    value: { postMessage: postMessageMock },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderOverlay() {
  seedDraft();
  const utils = render(<EventPageEditOverlay eventId="e1" token="t1" brandId="b1" />);
  await waitFor(() => expect(utils.container.querySelector('.tk-ep-hero')).not.toBeNull());
  return utils;
}

describe('EventPageEditOverlay postMessage resolver loop', () => {
  it('sends block-change when a SurfaceText commit fires', async () => {
    const { container } = await renderOverlay();
    postMessageMock.mockClear();
    const headline = headlineField(container);
    headline.textContent = 'Updated headline';
    fireEvent.input(headline);
    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'block-change', blockId: 'hero' }),
        '*',
      );
    });
  });

  it('does not echo block-change when receiving an update-block from the parent', async () => {
    const { container } = await renderOverlay();
    // First, a real user edit sends block-change.
    const headline = headlineField(container);
    headline.textContent = 'From user';
    fireEvent.input(headline);
    await waitFor(() => expect(postMessageMock).toHaveBeenCalled());
    postMessageMock.mockClear();

    // Parent echoes an update-block with the same block (simulating the round-trip).
    const heroBlock = defaultEventPageDocument().blocks.find((b) => b.type === 'hero')!;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: PARENT_SOURCE,
          type: 'update-block',
          blockId: 'hero',
          block: { ...heroBlock, headline: 'From user' },
        },
      }),
    );
    // Allow any re-render to settle; no block-change should be echoed back.
    await waitFor(() => expect(container.querySelector('.tk-ep-hero')).not.toBeNull());
    const blockChangeCalls = postMessageMock.mock.calls.filter(
      ([msg]) => msg && msg.type === 'block-change',
    );
    expect(blockChangeCalls).toHaveLength(0);
  });

  it('posts the first inline edit after receiving an update-block from the parent', async () => {
    const { container } = await renderOverlay();
    postMessageMock.mockClear();

    const heroBlock = defaultEventPageDocument().blocks.find((b) => b.type === 'hero')!;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: PARENT_SOURCE,
          type: 'update-block',
          blockId: 'hero',
          block: { ...heroBlock, headline: 'Inspector headline' },
        },
      }),
    );
    await waitFor(() =>
      expect(headlineField(container).textContent).toContain('Inspector headline'),
    );

    const headline = headlineField(container);
    headline.textContent = 'Iframe headline';
    fireEvent.input(headline);

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'block-change',
          blockId: 'hero',
          block: expect.objectContaining({ headline: 'Iframe headline' }),
        }),
        '*',
      );
    });
  });

  it('posts the first inline edit after receiving an update-document from the parent', async () => {
    const { container } = await renderOverlay();
    postMessageMock.mockClear();

    const nextDocument = {
      ...defaultEventPageDocument(),
      blocks: defaultEventPageDocument().blocks.map((block) =>
        block.id === 'hero' ? Object.assign({}, block, { headline: 'Document headline' }) : block,
      ),
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: PARENT_SOURCE,
          type: 'update-document',
          document: nextDocument,
          selectedBlockId: 'hero',
        },
      }),
    );
    await waitFor(() =>
      expect(headlineField(container).textContent).toContain('Document headline'),
    );

    const headline = headlineField(container);
    headline.textContent = 'Iframe document headline';
    fireEvent.input(headline);

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'block-change',
          blockId: 'hero',
          block: expect.objectContaining({ headline: 'Iframe document headline' }),
        }),
        '*',
      );
    });
  });

  it('posts the generated duplicate block so the parent keeps the iframe block id', async () => {
    await renderOverlay();
    postMessageMock.mockClear();

    fireEvent.click(document.querySelector('[aria-label="Duplicate Hero"]')!);

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'block-duplicate',
          blockId: 'hero',
          block: expect.objectContaining({
            type: 'hero',
            id: expect.stringMatching(/^hero-/),
          }),
        }),
        '*',
      );
    });
  });
});
