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
      getEventPage: vi.fn(),
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
          '<section><h2>Published content</h2><script>alert(1)</script><a href="javascript:alert(1)" onclick="alert(2)">bad</a><img src=DATA:text/html,evil onerror=alert(3) /></section>',
        text: 'Published content',
        headless: [],
        discovery: { title: 'All Access Chicago', summary: 'Published content', tags: [] },
      },
    });

    const { container } = render(React.createElement(EventPageClient, { eventId: 'evt_content' }));

    await waitFor(() => {
      expect(screen.getByTestId('published-event-page')).toHaveTextContent('Published content');
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('[src^="data:"]')).toBeNull();
  });
});
