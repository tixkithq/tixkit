import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import EventPageClient from '@/app/e/[eventId]/event-page-client';
import { publicApi, type AvailabilityItem, type PublicEvent } from '@/lib/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    publicApi: {
      ...actual.publicApi,
      getEvent: vi.fn(),
      getEventBySlug: vi.fn(),
      getEventPage: vi.fn(),
      getEventPageBySlug: vi.fn(),
      getAvailability: vi.fn(),
      getBrand: vi.fn(),
    },
  };
});

describe('EventPageClient escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(publicApi.getEvent).mockResolvedValue(event);
    vi.mocked(publicApi.getEventPage).mockResolvedValue(null as never);
    vi.mocked(publicApi.getAvailability).mockResolvedValue(availability);
    vi.mocked(publicApi.getBrand).mockRejectedValue(new Error('brand unavailable'));

    const { container } = render(React.createElement(EventPageClient, { eventId: 'evt_xss' }));

    await waitFor(() => {
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    });
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('<svg onload=alert(1)>')).toBeInTheDocument();
    expect(
      screen.getByText('<iframe srcdoc="<script>alert(1)</script>"></iframe>'),
    ).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('[onload]')).toBeNull();
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
    vi.mocked(publicApi.getEvent).mockResolvedValue(event);
    vi.mocked(publicApi.getAvailability).mockResolvedValue([]);
    vi.mocked(publicApi.getBrand).mockRejectedValue(new Error('brand unavailable'));
    vi.mocked(publicApi.getEventPage).mockResolvedValue({
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
        html:
          '<section><h2>Published content</h2><script>alert(1)</script><a href="jav&#x61;script:alert(1)" onclick="alert(2)">bad</a><img src="da&Tab;ta&colon;text/html,evil" onerror=alert(3) /><a href="java&#9999999999;script:alert(1)">bad entity</a><form action="jav&#x61;script:alert(1)"><button>submit</button></form><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><object data="jav&#x61;script:alert(1)"></object><svg><a xlink:href="jav&#x61;script:alert(1)">svg</a></svg></section>',
        text: 'Published content',
        headless: [],
        discovery: { title: 'All Access Chicago', summary: 'Published content', tags: [] },
      },
    });

    render(React.createElement(EventPageClient, { eventId: 'evt_content' }));

    await waitFor(() => {
      expect(screen.getByTestId('published-event-page')).toHaveTextContent('Published content');
    });
    const publishedPage = screen.getByTestId('published-event-page');
    expect(publishedPage.querySelector('script')).toBeNull();
    expect(publishedPage.querySelector('[onclick]')).toBeNull();
    expect(publishedPage.querySelector('[onerror]')).toBeNull();
    expect(publishedPage.querySelector('[href^="javascript:"]')).toBeNull();
    expect(publishedPage.querySelector('[src^="data:"]')).toBeNull();
    expect(Array.from(publishedPage.querySelectorAll('a')).every((link) => !link.hasAttribute('href'))).toBe(
      true,
    );
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
    vi.mocked(publicApi.getEventBySlug).mockResolvedValue(event);
    vi.mocked(publicApi.getAvailability).mockResolvedValue([]);
    vi.mocked(publicApi.getBrand).mockRejectedValue(new Error('brand unavailable'));
    vi.mocked(publicApi.getEventPageBySlug).mockResolvedValue({
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

    render(
      React.createElement(EventPageClient, {
        eventSlug: 'all-access',
        customDomainHost: 'events.example.com',
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('published-event-page')).toHaveTextContent('Domain page');
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
