import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import EventPageClient from '@/app/e/[eventId]/event-page-client';
import {
  publicApi,
  type AvailabilityItem,
  type PublicEvent,
  type PublicEventPageBootstrap,
} from '@/lib/api';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';

const push = vi.fn();

function userFacingMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => {
  class CheckoutApiError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly status: number,
      public readonly requestId?: string,
    ) {
      super(message);
      this.name = 'CheckoutApiError';
    }
  }

  return {
    publicApi: {
      getEvent: vi.fn(),
      getEventBySlug: vi.fn(),
      getEventPage: vi.fn(),
      getEventPageBySlug: vi.fn(),
      getEventPageBootstrap: vi.fn(),
      getEventPageBootstrapBySlug: vi.fn(),
      getAvailability: vi.fn(),
      getResaleListings: vi.fn(),
      getBrand: vi.fn(),
    },
    CheckoutApiError,
    userFacingMessage,
  };
});

type MockedCallable<TArgs extends unknown[], TResult> = ((...args: TArgs) => TResult) & {
  mockResolvedValue(value: unknown): MockedCallable<TArgs, TResult>;
  mockRejectedValue(value: unknown): MockedCallable<TArgs, TResult>;
  mockImplementation(fn: (...args: TArgs) => TResult): MockedCallable<TArgs, TResult>;
};

const publicApiMock = publicApi as unknown as {
  getEvent: MockedCallable<
    Parameters<typeof publicApi.getEvent>,
    ReturnType<typeof publicApi.getEvent>
  >;
  getEventBySlug: MockedCallable<
    Parameters<typeof publicApi.getEventBySlug>,
    ReturnType<typeof publicApi.getEventBySlug>
  >;
  getEventPage: MockedCallable<
    Parameters<typeof publicApi.getEventPage>,
    ReturnType<typeof publicApi.getEventPage>
  >;
  getEventPageBySlug: MockedCallable<
    Parameters<typeof publicApi.getEventPageBySlug>,
    ReturnType<typeof publicApi.getEventPageBySlug>
  >;
  getEventPageBootstrap: MockedCallable<
    Parameters<typeof publicApi.getEventPageBootstrap>,
    ReturnType<typeof publicApi.getEventPageBootstrap>
  >;
  getEventPageBootstrapBySlug: MockedCallable<
    Parameters<typeof publicApi.getEventPageBootstrapBySlug>,
    ReturnType<typeof publicApi.getEventPageBootstrapBySlug>
  >;
  getAvailability: MockedCallable<
    Parameters<typeof publicApi.getAvailability>,
    ReturnType<typeof publicApi.getAvailability>
  >;
  getResaleListings: MockedCallable<
    Parameters<typeof publicApi.getResaleListings>,
    ReturnType<typeof publicApi.getResaleListings>
  >;
  getBrand: MockedCallable<
    Parameters<typeof publicApi.getBrand>,
    ReturnType<typeof publicApi.getBrand>
  >;
};

afterEach(() => {
  cleanup();
});

describe('EventPageClient escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getResaleListings.mockResolvedValue({ items: [] });
    publicApiMock.getEventPageBootstrap.mockImplementation(async (eventId, signal) => {
      const [event, contentPage, availability, resaleListings] = await Promise.all([
        publicApiMock.getEvent(eventId, signal),
        publicApiMock.getEventPage(eventId, signal),
        publicApiMock.getAvailability(eventId, signal),
        publicApiMock.getResaleListings(eventId, signal),
      ]);
      return { event, contentPage, availability, resaleListings };
    });
    publicApiMock.getEventPageBootstrapBySlug.mockImplementation(async (slug, host, signal) => {
      const event = await publicApiMock.getEventBySlug(slug, host, signal);
      const [contentPage, availability, resaleListings] = await Promise.all([
        publicApiMock.getEventPageBySlug(slug, host, signal),
        publicApiMock.getAvailability(event.id, signal),
        publicApiMock.getResaleListings(event.id, signal),
      ]);
      return { event, contentPage, availability, resaleListings };
    });
  });

  it('hydrates from server-provided bootstrap data without a client bootstrap request', async () => {
    const initialBootstrap: PublicEventPageBootstrap = {
      event: {
        id: 'evt_server_bootstrap',
        title: 'Server Rendered Event',
        status: 'published',
        timezone: 'America/Chicago',
        startsAt: '2026-07-17T19:00:00.000Z',
      },
      contentPage: null,
      availability: [
        {
          type: 'ticket',
          ticketTypeId: 'tt_server',
          name: 'General Admission',
          kind: 'paid',
          priceCents: 4500,
          currency: 'USD',
          minPerOrder: 1,
          maxPerOrder: 4,
          available: 120,
          status: 'active',
        },
      ],
      resaleListings: { items: [], nextCursor: null, hasMore: false },
    };

    render(
      React.createElement(EventPageClient, { eventId: 'evt_server_bootstrap', initialBootstrap }),
    );

    await waitFor(() => expect(document.body.textContent).toContain('Server Rendered Event'));
    expect(document.body.textContent).toContain('General Admission');
    expect(publicApiMock.getEventPageBootstrap).not.toHaveBeenCalled();
    expect(publicApiMock.getEvent).not.toHaveBeenCalled();
  });

  it('renders HTML-looking event and ticket copy as text', async () => {
    const event: PublicEvent = {
      id: 'evt_xss',
      title: '<img src=x onerror=alert(1)>',
      description: '<script>alert(1)</script>',
      status: 'published',
      timezone: 'America/New_York',
      startsAt: '2026-06-01T18:00:00.000Z',
      brandId: 'brd_1',
    };
    const availability: AvailabilityItem[] = [
      {
        type: 'ticket',
        ticketTypeId: 'tt_xss',
        name: '<svg onload=alert(1)>',
        description: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        kind: 'paid',
        priceCents: 2500,
        currency: 'USD',
        minPerOrder: 1,
        maxPerOrder: 4,
        available: 10,
        status: 'active',
      },
    ];
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockResolvedValue(availability);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const { container, getByText } = render(
      React.createElement(EventPageClient, { eventId: 'evt_xss' }),
    );

    await waitFor(() => {
      expect(getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    });
    expect(getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(getByText('<svg onload=alert(1)>')).toBeInTheDocument();
    expect(getByText('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[onload]')).toBeNull();
  });

  it('renders public resale listings and routes buyers into resale checkout', async () => {
    const event: PublicEvent = {
      id: 'evt_resale',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getResaleListings.mockResolvedValue({
      items: [
        {
          id: 'lst_1',
          eventId: 'evt_resale',
          ticketTypeId: 'tt_1',
          ticketTypeName: 'General Admission',
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_resale' }));

    expect(await view.findByText('Resale ticket - General Admission')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Buy resale/i }));

    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('/checkout?eventId=evt_resale&resaleListing=lst_1'),
    );
  });

  it('keeps primary tickets available when resale listings fail', async () => {
    const event: PublicEvent = {
      id: 'evt_resale_down',
      title: 'Primary Still On Sale',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    const availability: AvailabilityItem[] = [
      {
        type: 'ticket',
        ticketTypeId: 'tt_primary',
        name: 'Primary General Admission',
        kind: 'paid',
        priceCents: 2500,
        currency: 'USD',
        minPerOrder: 1,
        maxPerOrder: 4,
        available: 24,
        status: 'active',
      },
    ];
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockResolvedValue(availability);
    publicApiMock.getResaleListings.mockRejectedValue(new Error('Resale listings unavailable'));
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_resale_down' }));

    expect(await view.findByText('Primary General Admission')).toBeInTheDocument();
    expect(view.queryByText('Could not load event')).toBeNull();
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Resale tickets are temporarily unavailable');
    expect(alert).toHaveTextContent('Resale listings unavailable');

    fireEvent.click(view.getByRole('button', { name: /Get tickets/i }));

    expect(push).toHaveBeenCalledWith(expect.stringContaining('/checkout?eventId=evt_resale_down'));
  });

  it('keeps availability failures page-blocking', async () => {
    const event: PublicEvent = {
      id: 'evt_availability_down',
      title: 'Availability Down',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockRejectedValue(new Error('Availability unavailable'));
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_availability_down' }));

    expect(await view.findByText('Could not load event')).toBeInTheDocument();
    expect(view.getByText('Availability unavailable')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Get tickets/i })).toBeNull();
    expect(view.queryByText('Resale tickets are temporarily unavailable')).toBeNull();
  });

  it('uses mobile-first vertical cards for long ticket and resale names', async () => {
    const event: PublicEvent = {
      id: 'evt_mobile',
      title: 'Mobile Layout Fest',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    const primaryName = 'General Admission With A Very Long Buyer-Facing Ticket Name';
    const resaleName = 'VIP Balcony Resale Listing With Long Section Details';
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockResolvedValue([
      {
        type: 'ticket',
        ticketTypeId: 'tt_mobile',
        name: primaryName,
        description: 'Long description for mobile layout validation.',
        kind: 'paid',
        priceCents: 2500,
        currency: 'USD',
        minPerOrder: 1,
        maxPerOrder: 4,
        available: 10,
        status: 'active',
      },
    ]);
    publicApiMock.getResaleListings.mockResolvedValue({
      items: [
        {
          id: 'lst_mobile',
          eventId: 'evt_mobile',
          ticketTypeId: 'tt_mobile',
          ticketTypeName: resaleName,
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_mobile' }));

    const primaryCard = (await view.findByText(primaryName)).closest('[data-slot="card"]');
    const resaleCard = (await view.findByText(`Resale ticket - ${resaleName}`)).closest(
      '[data-slot="card"]',
    );

    expect(primaryCard).toHaveClass('flex-col');
    expect(primaryCard).toHaveClass('sm:flex-row');
    expect(resaleCard).toHaveClass('flex-col');
    expect(resaleCard).toHaveClass('sm:flex-row');
    expect(view.getByText('$25.00').parentElement).toHaveClass('w-full', 'text-left');
    expect(view.getByText('$55.00').parentElement).toHaveClass('w-full', 'items-start');
  });

  it('sanitizes published event-page HTML before injecting it', async () => {
    const event: PublicEvent = {
      id: 'evt_content',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getEventPage.mockResolvedValue({
      document: {
        eventId: 'evt_content',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: { versionNumber: 1 },
      page: {
        html: '<section><h2>Published content</h2><script>alert(1)</script><a href="jav&#x61;script:alert(1)" onclick="alert(2)">bad</a><img src="da&Tab;ta&colon;text/html,evil" onerror=alert(3) /><a/href=javascript:alert(1)>slash link</a><img/src=javascript:alert(2) alt="slash image" /><a href="java&#9999999999;script:alert(1)">bad entity</a><form action="jav&#x61;script:alert(1)"><button>submit</button></form><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="jav&#x61;script:alert(1)"></object><svg><a xlink:href="jav&#x61;script:alert(1)">svg</a></svg></section>',
        text: 'Published content',
        headless: [],
        discovery: { title: 'All Access Chicago', summary: 'Published content', tags: [] },
      },
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_content' }));

    await waitFor(() => {
      expect(view.getByTestId('published-event-page')).toHaveTextContent('Published content');
    });
    const publishedPage = view.getByTestId('published-event-page');
    expect(publishedPage.querySelector('script')).toBeNull();
    expect(publishedPage.querySelector('[onclick]')).toBeNull();
    expect(publishedPage.querySelector('[onerror]')).toBeNull();
    expect(publishedPage.querySelector('[href^="javascript:"]')).toBeNull();
    expect(publishedPage.querySelector('[src^="data:"]')).toBeNull();
    expect(
      Array.from(publishedPage.querySelectorAll('a')).every((link) => !link.hasAttribute('href')),
    ).toBe(true);
    expect(publishedPage.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(publishedPage.querySelector('form')).toBeNull();
    expect(publishedPage.querySelector('iframe')).toBeNull();
    expect(publishedPage.querySelector('object')).toBeNull();
    expect(publishedPage.querySelector('svg')).toBeNull();
  });

  it('loads published event-page content through the verified custom-domain slug route', async () => {
    const event: PublicEvent = {
      id: 'evt_slug',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    publicApiMock.getEventBySlug.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getEventPageBySlug.mockResolvedValue({
      document: {
        eventId: 'evt_slug',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: { versionNumber: 1 },
      page: {
        html: '<section><h2>Domain page</h2></section>',
        text: 'Domain page',
        headless: [],
        discovery: { title: 'All Access Chicago', summary: 'Domain page', tags: [] },
      },
    });

    const view = render(
      React.createElement(EventPageClient, {
        eventSlug: 'all-access',
        customDomainHost: 'events.example.com',
      }),
    );

    await waitFor(() => {
      expect(view.getByTestId('published-event-page')).toHaveTextContent('Domain page');
    });
    expect(publicApi.getEventBySlug).toHaveBeenCalledWith(
      'all-access',
      'events.example.com',
      expect.any(AbortSignal),
    );
    expect(publicApi.getEventPageBySlug).toHaveBeenCalledWith(
      'all-access',
      'events.example.com',
      expect.any(AbortSignal),
    );
    expect(publicApi.getEventPage).not.toHaveBeenCalled();
  });

  it('renders the shared event page surface from page.renderModel and routes the ticket CTA to checkout', async () => {
    const event: PublicEvent = {
      id: 'evt_render_model',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    const renderContext: EventPageRenderContext = {
      event: {
        title: 'All Access Chicago',
        startsAt: '2026-07-17T19:00:00.000Z',
        timezone: 'America/Chicago',
        checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_render_model',
        venueName: 'The Salt Shed',
      },
      tickets: [
        {
          id: 'tt_ga',
          name: 'General Admission',
          status: 'active',
          priceLabel: '$35.00',
        },
      ],
    };
    const document = createDefaultEventPageDocument({
      eventId: 'evt_render_model',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_render_model',
    });
    const renderModel = resolveEventPageDocument(document, renderContext);

    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getEventPage.mockResolvedValue({
      document: {
        eventId: 'evt_render_model',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: { versionNumber: 1 },
      page: {
        html: '<div class="tixkit-event-page"></div>',
        text: 'All Access Chicago',
        headless: [],
        renderModel,
        discovery: { title: 'All Access Chicago', summary: 'A full night of access.', tags: [] },
      },
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_render_model' }));

    await waitFor(() => {
      expect(
        view.getByTestId('published-event-page').querySelector('.tixkit-event-page'),
      ).not.toBeNull();
    });
    const surface = view.getByTestId('published-event-page').querySelector('.tixkit-event-page');
    expect(surface?.querySelector('.tk-ep-hero')?.getAttribute('data-block-id')).toBe('hero');
    expect(surface?.querySelector('.tk-ep-tickets')?.getAttribute('data-block-id')).toBe('tickets');
    expect(surface?.textContent).toContain('General Admission');

    fireEvent.click(surface!.querySelector('.tk-ep-tickets .tk-ep-button')!);
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('/checkout?eventId=evt_render_model'),
    );
  });

  it('renders the default resale empty state from page.renderModel', async () => {
    const event: PublicEvent = {
      id: 'evt_resale_empty_render_model',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    const renderContext: EventPageRenderContext = {
      event: {
        title: 'All Access Chicago',
        startsAt: '2026-07-17T19:00:00.000Z',
        timezone: 'America/Chicago',
        checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_resale_empty_render_model',
      },
      tickets: [],
      resaleListings: [],
    };
    const document = createDefaultEventPageDocument({
      eventId: 'evt_resale_empty_render_model',
      eventTitle: 'All Access Chicago',
      eventDescription: 'A full night of access.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_resale_empty_render_model',
    });
    const resaleBlock = document.blocks.find((block) => block.type === 'resale_tickets');
    if (resaleBlock?.type === 'resale_tickets') {
      delete resaleBlock.emptyStateText;
    }
    const renderModel = resolveEventPageDocument(document, renderContext);

    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getEventPage.mockResolvedValue({
      document: {
        eventId: 'evt_resale_empty_render_model',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: { versionNumber: 1 },
      page: {
        html: '<div class="tixkit-event-page"></div>',
        text: 'All Access Chicago',
        headless: [],
        renderModel,
        discovery: { title: 'All Access Chicago', summary: 'A full night of access.', tags: [] },
      },
    });

    const view = render(
      React.createElement(EventPageClient, { eventId: 'evt_resale_empty_render_model' }),
    );

    await waitFor(() => {
      expect(view.getByText('No resale tickets available.')).not.toBeNull();
    });
  });

  it('renders the event title as p (not h1) when renderModel has a hero block', async () => {
    const event: PublicEvent = {
      id: 'evt_h1_dedup',
      title: 'Dedup Test Event',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    const renderContext: EventPageRenderContext = {
      event: {
        title: 'Dedup Test Event',
        startsAt: '2026-07-17T19:00:00.000Z',
        timezone: 'America/Chicago',
        checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_h1_dedup',
      },
      tickets: [],
    };
    const document = createDefaultEventPageDocument({
      eventId: 'evt_h1_dedup',
      eventTitle: 'Dedup Test Event',
      eventDescription: 'Testing h1 dedup.',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_h1_dedup',
    });
    const renderModel = resolveEventPageDocument(document, renderContext);

    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getEventPage.mockResolvedValue({
      document: {
        eventId: 'evt_h1_dedup',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: { versionNumber: 1 },
      page: {
        html: '<div class="tixkit-event-page"></div>',
        text: 'Dedup Test Event',
        headless: [],
        renderModel,
        discovery: { title: 'Dedup Test Event', summary: 'Testing h1 dedup.', tags: [] },
      },
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_h1_dedup' }));

    await waitFor(() => {
      expect(
        view.getByTestId('published-event-page').querySelector('.tixkit-event-page'),
      ).not.toBeNull();
    });
    // The event title should be a <p>, not an <h1>, because the hero block has the <h1>.
    const titleElements = view.getAllByText('Dedup Test Event');
    const titleP = titleElements.find((el) => el.tagName === 'P');
    expect(titleP).toBeTruthy();
    expect(titleP?.tagName).toBe('P');
    // The hero block's <h1> should be the only <h1> on the page.
    const surface = view.getByTestId('published-event-page').querySelector('.tixkit-event-page');
    const h1s = surface?.querySelectorAll('h1');
    expect(h1s?.length).toBe(1);
    expect(h1s?.[0]?.textContent).toContain('Dedup Test Event');
  });

  it('renders the event title as h1 when no content page exists (no hero block)', async () => {
    const event: PublicEvent = {
      id: 'evt_no_content',
      title: 'No Content Event',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brd_1',
    };
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_no_content' }));

    await waitFor(() => {
      expect(view.getByText('No Content Event')).toBeInTheDocument();
    });
    const titleElement = view.getByText('No Content Event');
    expect(titleElement.tagName).toBe('H1');
  });
});
