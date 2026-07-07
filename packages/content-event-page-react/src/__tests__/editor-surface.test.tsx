import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  type EventPageBlock,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageEditorSurface, EditableBlockBody } from '../index.js';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    venueName: 'The Salt Shed',
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.example.test' },
  tickets: [
    { id: 'tt_ga', name: 'General Admission', status: 'active', priceLabel: '$35.00' },
  ],
};

describe('EventPageEditorSurface', () => {
  it('renders the shared .tixkit-event-page class and data-mode=edit', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    render(
      <EventPageEditorSurface document={document} sampleContext={context} />,
    );
    const surface = screen.getByTestId('tixkit-event-page-editor');
    expect(surface.classList.contains('tixkit-event-page')).toBe(true);
    expect(surface.getAttribute('data-mode')).toBe('edit');
  });

  it('renders a selectable frame around each block with the block label', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    render(
      <EventPageEditorSurface document={document} sampleContext={context} />,
    );
    const hero = screen.getByText('Hero');
    expect(hero.tagName).toBe('BUTTON');
    expect(screen.getAllByText('Tickets').length).toBeGreaterThan(0);
  });

  it('marks the selected block with data-selected and the Selected badge', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    const ticketsBlock = document.blocks.find((b) => b.type === 'tickets')!;
    render(
      <EventPageEditorSurface
        document={document}
        sampleContext={context}
        selectedBlockId={ticketsBlock.id}
      />,
    );
    const section = screen
      .getByRole('button', { name: 'Tickets' })
      .closest('[data-block-id]') as HTMLElement;
    expect(section.getAttribute('data-selected')).toBe('true');
    expect(screen.getByText('Selected')).toBeTruthy();
  });

  it('calls onSelectBlock when a block frame is clicked', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    const onSelectBlock = vi.fn();
    render(
      <EventPageEditorSurface
        document={document}
        sampleContext={context}
        onSelectBlock={onSelectBlock}
      />,
    );
    const heroButton = screen.getByRole('button', { name: 'Hero' });
    fireEvent.click(heroButton);
    expect(onSelectBlock).toHaveBeenCalledWith('hero');
  });

  it('renders editable text fields bound to canonical block data', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    render(
      <EventPageEditorSurface document={document} sampleContext={context} />,
    );
    const headline = screen.getByLabelText('Page headline');
    expect(headline.tagName).toMatch(/H1/);
    expect(headline.textContent).toBe('All Access Chicago');
  });

  it('delegates rich_text blocks to the renderRichTextBlock slot', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    document.blocks.push({
      id: 'rich-1',
      type: 'rich_text',
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Extra copy' }] }] },
    });
    const slot = vi.fn(() => <div data-testid="rich-text-slot">WYSIWYG</div>);
    render(
      <EventPageEditorSurface
        document={document}
        sampleContext={context}
        renderRichTextBlock={slot}
      />,
    );
    expect(screen.getByTestId('rich-text-slot')).toBeTruthy();
    expect(slot).toHaveBeenCalledTimes(
      document.blocks.filter((b) => b.type === 'rich_text').length,
    );
  });

  it('preserves .tk-ep-* class names matching the public surface contract', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    render(
      <EventPageEditorSurface document={document} sampleContext={context} />,
    );
    const surface = screen.getByTestId('tixkit-event-page-editor');
    expect(surface.querySelector('.tk-ep-hero')).not.toBeNull();
    expect(surface.querySelector('.tk-ep-tickets')).not.toBeNull();
    expect(surface.querySelector('.tk-ep-hero')?.getAttribute('data-block-id')).toBe('hero');
  });

  it('calls onChangeBlock when an editable field is modified', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    const onChangeBlock = vi.fn();
    render(
      <EventPageEditorSurface
        document={document}
        sampleContext={context}
        onChangeBlock={onChangeBlock}
      />,
    );
    const headline = screen.getByLabelText('Page headline');
    fireEvent.input(headline, { target: { textContent: 'Updated headline' } });
    expect(onChangeBlock).toHaveBeenCalledTimes(1);
    const [blockId, block] = onChangeBlock.mock.calls[0];
    expect(blockId).toBe('hero');
    expect(block).toMatchObject({ type: 'hero', headline: 'Updated headline' });
  });

  it('renders the tickets list before the CTA (visual order parity with public surface)', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo',
    });
    const { container } = render(
      <EventPageEditorSurface document={document} sampleContext={context} />,
    );
    const ticketsSection = container.querySelector('.tk-ep-tickets');
    expect(ticketsSection).not.toBeNull();
    const children = Array.from(ticketsSection!.children);
    const ulIndex = children.findIndex((el) => el.tagName === 'UL');
    const ctaIndex = children.findIndex((el) =>
      el.classList.contains('tk-ep-button'),
    );
    expect(ulIndex).toBeGreaterThanOrEqual(0);
    expect(ctaIndex).toBeGreaterThan(ulIndex);
  });
});

describe('EditableBlockBody (standalone export)', () => {
  it('renders a hero block with .tk-ep-hero class and data-block-id', () => {
    const block: EventPageBlock = {
      id: 'hero-1',
      type: 'hero',
      headline: 'Test Headline',
      body: 'Test summary',
      ctaLabel: 'Buy tickets',
    };
    const { container } = render(
      <EditableBlockBody block={block} disabled={false} sampleContext={context} onChange={() => {}} />,
    );
    const hero = container.querySelector('.tk-ep-hero');
    expect(hero).not.toBeNull();
    expect(hero?.getAttribute('data-block-id')).toBe('hero-1');
    expect(screen.getByLabelText('Page headline').textContent).toBe('Test Headline');
  });

  it('calls onChange when an editable field is modified', () => {
    const block: EventPageBlock = {
      id: 'hero-1',
      type: 'hero',
      headline: 'Original',
      body: 'Body',
      ctaLabel: 'CTA',
    };
    const onChange = vi.fn();
    render(
      <EditableBlockBody block={block} disabled={false} sampleContext={context} onChange={onChange} />,
    );
    const headline = screen.getByLabelText('Page headline');
    headline.textContent = 'Updated';
    fireEvent.input(headline);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [updatedBlock] = onChange.mock.calls[0];
    expect(updatedBlock).toMatchObject({ id: 'hero-1', type: 'hero', headline: 'Updated' });
  });

  it('renders disabled fields as non-contenteditable', () => {
    const block: EventPageBlock = {
      id: 'hero-1',
      type: 'hero',
      headline: 'Locked',
      ctaLabel: 'CTA',
    };
    render(
      <EditableBlockBody block={block} disabled={true} sampleContext={context} onChange={() => {}} />,
    );
    const headline = screen.getByLabelText('Page headline');
    expect(headline.getAttribute('contenteditable')).toBe('false');
  });

  it('delegates rich_text blocks to renderRichTextBlock slot', () => {
    const block: Extract<EventPageBlock, { type: 'rich_text' }> = {
      id: 'rt-1',
      type: 'rich_text',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    };
    const slot = vi.fn(() => <div data-testid="wysiwyg">WYSIWYG</div>);
    render(
      <EditableBlockBody
        block={block}
        disabled={false}
        sampleContext={context}
        onChange={() => {}}
        renderRichTextBlock={slot}
      />,
    );
    expect(screen.getByTestId('wysiwyg')).toBeTruthy();
    expect(slot).toHaveBeenCalledTimes(1);
  });
});

describe('Empty-state fast starts', () => {
  it('shows empty state when document has only chrome blocks', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Test Event',
    });
    // Remove all content blocks, leaving only chrome (header, resale, footer)
    const chromeTypes = new Set(['event_header', 'resale_tickets', 'brand_footer']);
    doc.blocks = doc.blocks.filter((b) => chromeTypes.has(b.type));

    const { container } = render(
      <EventPageEditorSurface document={doc} sampleContext={context} disabled={false} />,
    );

    expect(container.querySelector('[data-testid="tk-ep-empty-state"]')).not.toBeNull();
  });

  it('does not show empty state when document has content blocks', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Test Event',
    });

    const { container } = render(
      <EventPageEditorSurface document={doc} sampleContext={context} disabled={false} />,
    );

    expect(container.querySelector('[data-testid="tk-ep-empty-state"]')).toBeNull();
  });
});
