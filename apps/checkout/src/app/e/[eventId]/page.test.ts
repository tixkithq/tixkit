import { describe, expect, it } from 'vitest';
import type { PublicEventPageBootstrap } from '@/lib/api';
import { eventPageMetadataFromBootstrap } from '@/lib/event-page-metadata';

function bootstrap(overrides: Partial<PublicEventPageBootstrap> = {}): PublicEventPageBootstrap {
  return {
    event: {
      id: 'evt_1',
      title: 'All Access Chicago',
      description: 'The public event description.',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
    },
    contentPage: null,
    availability: [],
    resaleListings: { items: [] },
    ...overrides,
  };
}

describe('eventPageMetadataFromBootstrap', () => {
  it('uses stored SEO and social overrides for hosted event pages', () => {
    const metadata = eventPageMetadataFromBootstrap(
      bootstrap({
        contentPage: {
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
                seoTitle: "Chicago's best summer festival",
                seoDescription: 'A custom description for search results.',
                socialImageUrl: 'https://cdn.example.com/social.jpg',
              },
            },
            discovery: {
              title: 'Public discovery title',
              summary: 'Public discovery summary',
              tags: ['music'],
              imageUrl: 'https://cdn.example.com/fallback.jpg',
            },
          },
        },
      }),
    );

    expect(metadata.title).toEqual({
      absolute: "Chicago's best summer festival",
    });
    expect(metadata.description).toBe('A custom description for search results.');
    expect(metadata.openGraph).toMatchObject({
      title: "Chicago's best summer festival",
      description: 'A custom description for search results.',
      images: [{ url: 'https://cdn.example.com/social.jpg' }],
    });
    expect(metadata.twitter).toMatchObject({
      card: 'summary_large_image',
      title: "Chicago's best summer festival",
      images: ['https://cdn.example.com/social.jpg'],
    });
  });

  it('falls back to event metadata when no content page is published', () => {
    const metadata = eventPageMetadataFromBootstrap(bootstrap());

    expect(metadata.title).toEqual({ absolute: 'All Access Chicago' });
    expect(metadata.description).toBe('The public event description.');
    expect(metadata.openGraph).toEqual({
      title: 'All Access Chicago',
      description: 'The public event description.',
    });
    expect(metadata.twitter).toEqual({
      card: 'summary',
      title: 'All Access Chicago',
      description: 'The public event description.',
    });
  });
});
