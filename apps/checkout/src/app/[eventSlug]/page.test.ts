import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicEventPageBootstrap } from '@/lib/api';

const mocks = vi.hoisted(() => ({
  getEventPageBootstrapBySlug: vi.fn(),
  headers: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('@/lib/api-server', () => ({
  getServerEventPageBootstrapBySlug: mocks.getEventPageBootstrapBySlug,
}));
vi.mock('@/lib/runtime-config-server', () => ({
  parseCheckoutRuntimeConfig: () => ({
    apiBaseUrl: 'https://api.tixkit.com',
    checkoutUrl: 'https://checkout.tixkit.com',
  }),
}));

import { generateMetadata } from './page';

function bootstrap(contentPage: PublicEventPageBootstrap['contentPage']): PublicEventPageBootstrap {
  return {
    event: {
      id: 'evt_1',
      title: 'All Access Chicago',
      description: 'The public event description.',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
    },
    contentPage,
    availability: [],
    resaleListings: { items: [] },
  };
}

describe('custom-domain event metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ host: 'events.example.com' }));
  });

  it('uses editor SEO and social overrides', async () => {
    mocks.getEventPageBootstrapBySlug.mockResolvedValue(
      bootstrap({
        document: {
          eventId: 'evt_1',
          channel: 'event_page',
          key: 'main',
          name: 'All Access Chicago event page',
          locale: 'en',
          updatedAt: '2026-07-09T00:00:00.000Z',
        },
        version: { versionNumber: 3 },
        page: {
          provider: '@puckeditor/core',
          puckData: null,
          settings: {
            discovery: {
              seoTitle: 'Custom-domain festival title',
              seoDescription: 'Custom-domain search description.',
              socialImageUrl: 'https://cdn.example.com/custom-social.jpg',
            },
          },
          discovery: {
            title: 'Public discovery title',
            summary: 'Public discovery summary',
            tags: [],
          },
        },
      }),
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ eventSlug: 'all-access' }),
      searchParams: Promise.resolve({ locale: 'en' }),
    });

    expect(mocks.getEventPageBootstrapBySlug).toHaveBeenCalledWith(
      'all-access',
      'events.example.com',
      'en',
    );
    expect(metadata).toMatchObject({
      title: { absolute: 'Custom-domain festival title' },
      description: 'Custom-domain search description.',
      openGraph: {
        images: [{ url: 'https://cdn.example.com/custom-social.jpg' }],
      },
      twitter: {
        card: 'summary_large_image',
        images: ['https://cdn.example.com/custom-social.jpg'],
      },
    });
  });

  it('falls back to event metadata without a published content page', async () => {
    mocks.getEventPageBootstrapBySlug.mockResolvedValue(bootstrap(null));

    const metadata = await generateMetadata({
      params: Promise.resolve({ eventSlug: 'all-access' }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.title).toEqual({ absolute: 'All Access Chicago' });
    expect(metadata.description).toBe('The public event description.');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });
});
