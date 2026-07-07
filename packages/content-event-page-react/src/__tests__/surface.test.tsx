import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EventPageSurface } from '../index.js';

const context: EventPageRenderContext = {
  event: {
    title: 'All Access Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    publicUrl: 'https://events.example.test/e/all-access-chicago',
    checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    venueName: 'The Salt Shed',
    venueCity: 'Chicago',
  },
  brand: { name: 'Tixkit', supportUrl: 'https://help.example.test' },
  tickets: [
    {
      id: 'tt_ga',
      name: 'General Admission',
      description: 'Standing room',
      status: 'active',
      priceLabel: '$35.00',
    },
    { id: 'tt_hidden', name: 'Hidden comp', status: 'hidden', priceLabel: 'Free' },
  ],
  products: [{ id: 'prod_poster', name: 'Poster', priceLabel: '$10.00' }],
};

function resolvedPage(checkoutUrl = 'https://checkout.example.test/checkout?eventId=evt_demo_001') {
  const document = createDefaultEventPageDocument({
    eventId: 'evt_demo_001',
    eventTitle: 'All Access Chicago',
    eventDescription: 'A full night of access.',
    checkoutUrl,
  });
  return resolveEventPageDocument(document, context);
}

describe('EventPageSurface', () => {
  it('renders the shared surface with namespaced classes and block IDs', () => {
    const { container } = render(<EventPageSurface resolvedPage={resolvedPage()} />);

    expect(container.querySelector('.tixkit-event-page')).not.toBeNull();
    expect(container.querySelector('[data-testid="tixkit-event-page"]')).not.toBeNull();
    expect(container.querySelector('.tk-ep-hero')?.getAttribute('data-block-id')).toBe('hero');
    expect(container.querySelector('.tk-ep-tickets')?.getAttribute('data-block-id')).toBe(
      'tickets',
    );
    expect(container.querySelector('.tk-ep-venue')?.getAttribute('data-block-id')).toBe('venue');
  });

  it('renders resolved hero content and resolved merge tags', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: '{{event.title}}',
      eventDescription: 'Join {{brand.name}}',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    const resolved = resolveEventPageDocument(document, context);
    render(<EventPageSurface resolvedPage={resolved} />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('All Access Chicago');
    expect(screen.getByText('Join Tixkit')).not.toBeNull();
  });

  it('renders tickets excluding hidden ticket types', () => {
    render(<EventPageSurface resolvedPage={resolvedPage()} />);

    expect(screen.getByText('General Admission')).not.toBeNull();
    expect(screen.queryByText('Hidden comp')).toBeNull();
  });

  it('renders the default resale empty state when no custom text is resolved', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    const resaleBlock = document.blocks.find((block) => block.type === 'resale_tickets');
    if (resaleBlock?.type === 'resale_tickets') {
      delete resaleBlock.emptyStateText;
    }
    const resolved = resolveEventPageDocument(document, {
      ...context,
      resaleListings: [],
    });

    render(<EventPageSurface resolvedPage={resolved} />);

    expect(screen.getByText('No resale tickets available.')).not.toBeNull();
  });

  it('renders the ticket CTA and invokes onTicketCtaClick without navigating', () => {
    const clicks: { blockId: string }[] = [];
    const { container } = render(
      <EventPageSurface
        resolvedPage={resolvedPage()}
        onTicketCtaClick={(input) => clicks.push(input)}
      />,
    );

    const ticketsCta = container.querySelector<HTMLAnchorElement>('.tk-ep-tickets .tk-ep-button');
    expect(ticketsCta?.getAttribute('href')).toBe(
      'https://checkout.example.test/checkout?eventId=evt_demo_001',
    );
    ticketsCta?.click();
    expect(clicks).toEqual([{ blockId: 'tickets' }]);
  });

  it('renders nothing for an invalid resolved page', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'javascript:alert(1)',
    });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    expect(container.firstChild).toBeNull();
  });

  it('renders rich-text sanitized html verbatim (no script execution)', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'rich_text',
      id: 'story',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Welcome <script>alert(1)</script>' }],
          },
        ],
      },
    });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    const richText = container.querySelector('.tk-ep-rich-text');
    expect(richText?.innerHTML).toContain('Welcome');
    expect(richText?.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(richText?.innerHTML).toContain('&lt;script&gt;');
  });

  it('does not double-wrap rich_text blocks (parity with server HTML)', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'rich_text',
      id: 'story',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inner' }] }],
      },
    });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    // The surface renders one .tk-ep-rich-text section for the added block,
    // with no nested .tk-ep-rich-text inside (which would indicate double-wrapping).
    const storySection = container.querySelector('.tk-ep-rich-text[data-block-id="story"]');
    expect(storySection).not.toBeNull();
    expect(storySection?.textContent).toContain('Inner');
    expect(storySection?.querySelector('.tk-ep-rich-text')).toBeNull();
  });

  it('sets data-mode to public by default and preview when specified', () => {
    const { container, rerender } = render(<EventPageSurface resolvedPage={resolvedPage()} />);
    expect(container.querySelector('[data-mode="public"]')).not.toBeNull();

    rerender(<EventPageSurface resolvedPage={resolvedPage()} mode="preview" />);
    expect(container.querySelector('[data-mode="preview"]')).not.toBeNull();
  });

  it('appends a custom className to the root element', () => {
    const { container } = render(
      <EventPageSurface resolvedPage={resolvedPage()} className="my-custom-class" />,
    );
    const root = container.querySelector('.tixkit-event-page');
    expect(root?.classList.contains('my-custom-class')).toBe(true);
  });

  it('invokes onTicketCtaClick for the hero CTA', () => {
    const clicks: { blockId: string }[] = [];
    const { container } = render(
      <EventPageSurface
        resolvedPage={resolvedPage()}
        onTicketCtaClick={(input) => clicks.push(input)}
      />,
    );
    const heroCta = container.querySelector<HTMLAnchorElement>('.tk-ep-hero .tk-ep-button');
    expect(heroCta).not.toBeNull();
    fireEvent.click(heroCta!);
    expect(clicks).toEqual([{ blockId: 'hero' }]);
  });

  it('renders the button block with the correct style class', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'button',
      id: 'btn-1',
      label: 'Learn more',
      url: 'https://example.test/about',
      style: 'secondary',
    });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    const button = container.querySelector('.tk-ep-action .tk-ep-button');
    expect(button).not.toBeNull();
    expect(button?.classList.contains('tk-ep-button-secondary')).toBe(true);
    expect(button?.getAttribute('href')).toBe('https://example.test/about');
  });

  it('renders the divider block as an hr with the correct class', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({ type: 'divider', id: 'div-1' });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    const hr = container.querySelector('hr.tk-ep-divider');
    expect(hr).not.toBeNull();
    expect(hr?.getAttribute('data-block-id')).toBe('div-1');
  });

  it('strips onerror attributes from rich_text HTML (XSS hardening)', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks.push({
      type: 'rich_text',
      id: 'xss-1',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '<img src="x" onerror="alert(1)">' }],
          },
        ],
      },
    });
    const resolved = resolveEventPageDocument(document, context);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);

    const richText = container.querySelector('.tk-ep-rich-text');
    expect(richText?.innerHTML).not.toContain('onerror');
    expect(richText?.innerHTML).not.toContain('alert(1)');
  });

  it('renders without emitting console errors or warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<EventPageSurface resolvedPage={resolvedPage()} />);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('renders nothing for a valid page with no blocks (missing hero/tickets makes it invalid)', () => {
    const document = createDefaultEventPageDocument({
      eventId: 'evt_demo_001',
      eventTitle: 'All Access Chicago',
      eventDescription: 'Safe copy',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    });
    document.blocks = [];
    const resolved = resolveEventPageDocument(document, context);
    expect(resolved.validation.valid).toBe(false);
    const { container } = render(<EventPageSurface resolvedPage={resolved} />);
    expect(container.firstChild).toBeNull();
  });
});
