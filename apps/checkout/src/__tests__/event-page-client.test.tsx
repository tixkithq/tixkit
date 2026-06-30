import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import EventPageClient from '@/app/e/[eventId]/event-page-client';
import { publicApi, type AvailabilityItem, type PublicEvent } from '@/lib/api';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => {
  return {
    publicApi: {
      getEvent: vi.fn(),
      getEventBySlug: vi.fn(),
      getEventPage: vi.fn(),
      getEventPageBySlug: vi.fn(),
      getAvailability: vi.fn(),
      getResaleListings: vi.fn(),
      getBrand: vi.fn(),
    },
  };
});

const publicApiMock = publicApi as unknown as {
  getEvent: ReturnType<typeof vi.fn>;
  getEventBySlug: ReturnType<typeof vi.fn>;
  getEventPage: ReturnType<typeof vi.fn>;
  getEventPageBySlug: ReturnType<typeof vi.fn>;
  getAvailability: ReturnType<typeof vi.fn>;
  getResaleListings: ReturnType<typeof vi.fn>;
  getBrand: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
});

describe('EventPageClient escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getResaleListings.mockResolvedValue({ items: [] });
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
});
