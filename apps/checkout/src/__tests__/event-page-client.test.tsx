import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import EventPageClient from '@/app/e/[eventId]/event-page-client';
import {
  CheckoutApiError,
  publicApi,
  type AvailabilityItem,
  type PublicContentPage,
  type PublicEvent,
  type PublicEventPageBootstrap,
} from '@/lib/api';
import type { EventPagePuckData } from '@tixkit/content-event-page-react/puck';

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

const emptyResaleListings = { items: [], nextCursor: null, hasMore: false };

function eventFixture(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 'evt_1',
    title: 'All Access Chicago',
    status: 'published',
    timezone: 'America/Chicago',
    startsAt: '2026-07-17T19:00:00.000Z',
    brandId: 'brd_1',
    ...overrides,
  };
}

function activeTicket(overrides: Partial<AvailabilityItem> = {}): AvailabilityItem {
  return {
    type: 'ticket',
    ticketTypeId: 'tt_ga',
    name: 'General Admission',
    kind: 'paid',
    priceCents: 4500,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 4,
    available: 120,
    status: 'active',
    ...overrides,
  };
}

function puckContentPage(puckData: EventPagePuckData | null): PublicContentPage {
  return {
    document: {
      eventId: 'evt_1',
      channel: 'event_page',
      key: 'main',
      name: 'Main event page',
      locale: 'en',
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    version: { versionNumber: 1 },
    page: {
      provider: '@puckeditor/core',
      puckData,
      discovery: { title: 'All Access Chicago', summary: 'Puck page', tags: [] },
    },
  };
}

function puckDataFixture(): EventPagePuckData {
  return {
    root: { props: {} },
    content: [
      {
        type: 'EventDescription',
        props: {
          id: 'puck-description',
          eyebrow: 'Featured night',
          title: 'Rendered from Puck data',
          body: 'Puck owns this content block.',
        },
      },
      {
        type: 'FAQ',
        props: {
          id: 'puck-faq',
          title: 'Need to know',
          items: [{ question: 'Can I transfer tickets?', answer: 'Yes, from your wallet.' }],
        },
      },
    ],
  };
}

afterEach(() => {
  cleanup();
});

describe('EventPageClient Puck runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    push.mockReset();
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    publicApiMock.getResaleListings.mockResolvedValue(emptyResaleListings);
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture(),
      contentPage: null,
      availability: [],
      resaleListings: emptyResaleListings,
    });
    publicApiMock.getEventPageBootstrapBySlug.mockResolvedValue({
      event: eventFixture({ id: 'evt_slug' }),
      contentPage: null,
      availability: [],
      resaleListings: emptyResaleListings,
    });
  });

  it('hydrates from server-provided bootstrap data without a client bootstrap request', async () => {
    const initialBootstrap: PublicEventPageBootstrap = {
      event: eventFixture({ id: 'evt_server_bootstrap', title: 'Server Rendered Event' }),
      contentPage: null,
      availability: [activeTicket({ ticketTypeId: 'tt_server' })],
      resaleListings: emptyResaleListings,
    };

    render(
      React.createElement(EventPageClient, { eventId: 'evt_server_bootstrap', initialBootstrap }),
    );

    await waitFor(() => expect(document.body.textContent).toContain('Server Rendered Event'));
    expect(document.body.textContent).toContain('General Admission');
    expect(publicApiMock.getEventPageBootstrap).not.toHaveBeenCalled();
    expect(publicApiMock.getEvent).not.toHaveBeenCalled();
  });

  it('renders published content from Puck data and ignores legacy HTML', async () => {
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture({ id: 'evt_puck' }),
      contentPage: puckContentPage(puckDataFixture()),
      availability: [],
      resaleListings: emptyResaleListings,
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_puck' }));

    expect(await view.findByText('Rendered from Puck data')).toBeInTheDocument();
    expect(view.getByText('Puck owns this content block.')).toBeInTheDocument();
    expect(view.getByText('Can I transfer tickets?')).toBeInTheDocument();
    expect(view.getByText('Yes, from your wallet.')).toBeInTheDocument();
    expect(view.queryByText('Legacy HTML fallback must not render')).toBeNull();
    expect(view.container.querySelector('script')).toBeNull();
  });

  it('does not fall back to legacy HTML when content exists without Puck data', async () => {
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture({ id: 'evt_no_puck' }),
      contentPage: puckContentPage(null),
      availability: [activeTicket()],
      resaleListings: emptyResaleListings,
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_no_puck' }));

    expect(await view.findByText('General Admission')).toBeInTheDocument();
    expect(view.queryByTestId('published-event-page')).toBeNull();
    expect(view.queryByText('Legacy HTML fallback must not render')).toBeNull();
    expect(view.getByRole('button', { name: /Get tickets/i })).toBeInTheDocument();
  });

  it('keeps checkout-owned ticket CTA and resale chrome around Puck content', async () => {
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture({ id: 'evt_commerce' }),
      contentPage: puckContentPage(puckDataFixture()),
      availability: [activeTicket({ ticketTypeId: 'tt_commerce', priceCents: 3500 })],
      resaleListings: {
        items: [
          {
            id: 'lst_1',
            eventId: 'evt_commerce',
            ticketTypeId: 'tt_commerce',
            ticketTypeName: 'General Admission',
            status: 'listed',
            priceCents: 5500,
            currency: 'USD',
            faceValueCents: 5000,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_commerce' }));

    expect(await view.findByText('Rendered from Puck data')).toBeInTheDocument();
    expect(view.getByText('Tickets')).toBeInTheDocument();
    expect(view.getByText('General Admission')).toBeInTheDocument();
    expect(view.getByText('Resale ticket - General Admission')).toBeInTheDocument();
    expect(view.getByText('Secure checkout powered by Tixkit')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: /Get tickets/i }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/checkout?eventId=evt_commerce'));

    fireEvent.click(view.getByRole('button', { name: /Buy resale/i }));
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('/checkout?eventId=evt_commerce&resaleListing=lst_1'),
    );
  });

  it('consumes the same Puck payload through the custom-domain slug bootstrap path', async () => {
    publicApiMock.getEventPageBootstrapBySlug.mockResolvedValue({
      event: eventFixture({ id: 'evt_slug', title: 'Domain Event' }),
      contentPage: puckContentPage(puckDataFixture()),
      availability: [activeTicket({ ticketTypeId: 'tt_slug' })],
      resaleListings: emptyResaleListings,
    });

    const view = render(
      React.createElement(EventPageClient, {
        eventSlug: 'all-access',
        customDomainHost: 'events.example.com',
      }),
    );

    expect(await view.findByText('Rendered from Puck data')).toBeInTheDocument();
    expect(view.getByTestId('published-event-page')).toBeInTheDocument();
    expect(view.getByTestId('public-event-page-surface')).toBeInTheDocument();
    expect(publicApi.getEventPageBootstrapBySlug).toHaveBeenCalledWith(
      'all-access',
      'events.example.com',
      expect.any(AbortSignal),
      'en',
    );
    expect(publicApi.getEventPageBySlug).not.toHaveBeenCalled();
    expect(publicApi.getEventPage).not.toHaveBeenCalled();
  });

  it('preserves a canonical locale through loading, document semantics, and checkout', async () => {
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture({ id: 'evt_ar' }),
      contentPage: null,
      availability: [activeTicket()],
      resaleListings: emptyResaleListings,
    });

    const view = render(
      React.createElement(EventPageClient, {
        eventId: 'evt_ar',
        locale: 'ar-eg',
      }),
    );

    expect(await view.findByRole('button', { name: /Get tickets/i })).toBeInTheDocument();
    expect(publicApiMock.getEventPageBootstrap).toHaveBeenCalledWith(
      'evt_ar',
      expect.any(AbortSignal),
      'ar-EG',
    );
    expect(document.documentElement).toHaveAttribute('lang', 'ar-EG');
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');

    fireEvent.click(view.getByRole('button', { name: /Get tickets/i }));
    expect(push).toHaveBeenCalledWith(expect.stringContaining('locale=ar-EG'));
  });

  it('preserves the requested locale when bootstrap loading falls back to separate resources', async () => {
    publicApiMock.getEventPageBootstrap.mockRejectedValue(
      new CheckoutApiError('BOOTSTRAP_UNAVAILABLE', 'Bootstrap unavailable', 503),
    );
    publicApiMock.getEvent.mockResolvedValue(eventFixture({ id: 'evt_fallback' }));
    publicApiMock.getAvailability.mockResolvedValue([activeTicket()]);
    publicApiMock.getEventPage.mockResolvedValue(puckContentPage(null));

    const view = render(
      React.createElement(EventPageClient, { eventId: 'evt_fallback', locale: 'es-mx' }),
    );

    expect(await view.findByRole('button', { name: /Get tickets/i })).toBeInTheDocument();
    expect(publicApiMock.getEventPage).toHaveBeenCalledWith(
      'evt_fallback',
      expect.any(AbortSignal),
      'es-MX',
    );
  });

  it('keeps missing content valid while still rendering checkout chrome', async () => {
    publicApiMock.getEventPageBootstrap.mockResolvedValue({
      event: eventFixture({ id: 'evt_missing_content', title: 'No Content Event' }),
      contentPage: null,
      availability: [activeTicket()],
      resaleListings: emptyResaleListings,
    });

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_missing_content' }));

    expect(await view.findByRole('heading', { name: 'No Content Event' })).toBeInTheDocument();
    expect(view.queryByTestId('published-event-page')).toBeNull();
    expect(view.getByText('Tickets')).toBeInTheDocument();
    expect(view.getByRole('button', { name: /Get tickets/i })).toBeInTheDocument();
  });

  it('preserves event content when availability refresh fails and marks tickets stale', async () => {
    publicApiMock.getEventPageBootstrap.mockRejectedValue(
      new CheckoutApiError('BOOTSTRAP_UNAVAILABLE', 'Bootstrap unavailable', 503),
    );
    publicApiMock.getEvent.mockResolvedValue(
      eventFixture({ id: 'evt_stale_avail', title: 'Stale Availability Event' }),
    );
    publicApiMock.getAvailability.mockRejectedValue(
      new CheckoutApiError('NETWORK_ERROR', 'offline', 0),
    );
    publicApiMock.getEventPage.mockResolvedValue(null);
    publicApiMock.getResaleListings.mockResolvedValue(emptyResaleListings);

    const view = render(React.createElement(EventPageClient, { eventId: 'evt_stale_avail' }));

    expect(
      await view.findByRole('heading', { name: 'Stale Availability Event' }),
    ).toBeInTheDocument();
    expect(view.getByTestId('availability-status-banner')).toBeVisible();
    expect(view.getByRole('button', { name: 'Retry availability' })).toBeVisible();
    expect(view.queryByRole('button', { name: /Get tickets/i })).not.toBeInTheDocument();
  });
});
