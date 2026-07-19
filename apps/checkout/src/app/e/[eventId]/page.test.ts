import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicEventPageBootstrap } from '@/lib/api';
import { eventPageMetadataFromBootstrap } from '@/lib/event-page-metadata';

const mocks = vi.hoisted(() => ({
  getEventPageBootstrap: vi.fn(),
}));

vi.mock('@/lib/api-server', () => ({
  getServerEventPageBootstrap: mocks.getEventPageBootstrap,
}));

import EventPage from './page';

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

describe('hosted event route locale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the requested locale to both bootstrap loading and the buyer client', async () => {
    const initialBootstrap = bootstrap({
      contentPage: {
        document: {
          eventId: 'evt_1',
          channel: 'event_page',
          key: 'main',
          name: 'Arabic event page',
          locale: 'ar-EG',
          updatedAt: '2026-07-18T00:00:00.000Z',
        },
        version: { versionNumber: 1 },
        page: {
          provider: '@puckeditor/core',
          puckData: null,
          discovery: { title: 'Arabic event', summary: 'Arabic summary', tags: [] },
        },
      },
    });
    mocks.getEventPageBootstrap.mockResolvedValue(initialBootstrap);

    const page = await EventPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
      searchParams: Promise.resolve({ locale: 'ar-eg' }),
    });

    expect(mocks.getEventPageBootstrap).toHaveBeenCalledWith('evt_1', 'ar-EG');
    expect(page.type).toBe('div');
    expect(page.props).toMatchObject({ lang: 'ar-EG', dir: 'rtl' });
    expect(page.props.children.props).toMatchObject({
      eventId: 'evt_1',
      locale: 'ar-EG',
      initialBootstrap,
    });
  });

  it('fails closed to English before loading an invalid or overlong locale', async () => {
    const initialBootstrap = bootstrap();
    mocks.getEventPageBootstrap.mockResolvedValue(initialBootstrap);

    const page = await EventPage({
      params: Promise.resolve({ eventId: 'evt_1' }),
      searchParams: Promise.resolve({ locale: `invalid_${'x'.repeat(80)}` }),
    });

    expect(mocks.getEventPageBootstrap).toHaveBeenCalledWith('evt_1', 'en');
    expect(page.props).toMatchObject({ lang: 'en', dir: 'ltr' });
    expect(page.props.children.props.locale).toBe('en');
  });
});

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

  it('uses deterministic owned-media role fallbacks for social metadata', () => {
    const metadata = eventPageMetadataFromBootstrap(
      bootstrap({
        event: {
          ...bootstrap().event,
          coverImageUrl: 'https://legacy.example/cover.jpg',
          mediaAssets: [
            {
              role: 'cover',
              altText: 'Crowd facing the stage',
              focalPoint: { x: 0.5, y: 0.4 },
              renditions: [
                {
                  variant: 'social',
                  width: 1200,
                  height: 630,
                  url: 'https://media.example/cover-social.webp',
                },
              ],
            },
            {
              role: 'social',
              altText: 'Festival social card',
              focalPoint: { x: 0.5, y: 0.5 },
              renditions: [
                {
                  variant: 'social',
                  width: 1200,
                  height: 630,
                  url: 'https://media.example/social.webp',
                },
              ],
            },
          ],
        },
      }),
    );

    expect(metadata.openGraph).toMatchObject({
      images: [{ url: 'https://media.example/social.webp' }],
    });
    expect(metadata.twitter).toMatchObject({ images: ['https://media.example/social.webp'] });
  });

  it('uses dimensions and alt text from the exact stored-role rendition', () => {
    const posterSocialReference = '/v1/public/event-media/renditions/emr_poster_social';
    const posterSocialUrl =
      'https://api.self-hosted.example/v1/public/event-media/renditions/emr_poster_social';
    const metadata = eventPageMetadataFromBootstrap(
      bootstrap({
        event: {
          ...bootstrap().event,
          mediaAssets: [
            {
              role: 'poster',
              altText: 'Portrait event poster',
              focalPoint: { x: 0.5, y: 0.5 },
              renditions: [
                {
                  variant: 'social',
                  width: 1200,
                  height: 630,
                  url: posterSocialUrl,
                },
              ],
            },
            {
              role: 'social',
              altText: 'Default social artwork',
              focalPoint: { x: 0.5, y: 0.5 },
              renditions: [
                {
                  variant: 'social',
                  width: 1200,
                  height: 630,
                  url: '/v1/public/event-media/renditions/emr_default_social',
                },
              ],
            },
          ],
        },
        contentPage: {
          document: {
            eventId: 'evt_1',
            channel: 'event_page',
            key: 'main',
            name: 'Event page',
            locale: 'en',
            updatedAt: '2026-07-15T00:00:00.000Z',
          },
          version: { versionNumber: 4 },
          page: {
            provider: '@puckeditor/core',
            puckData: null,
            settings: { discovery: { socialImageUrl: posterSocialReference } },
            discovery: { title: 'Event', summary: 'Event summary', tags: [] },
          },
        },
      }),
      'https://api.self-hosted.example',
    );

    expect(metadata.openGraph).toMatchObject({
      images: [
        {
          url: posterSocialUrl,
          width: 1200,
          height: 630,
          alt: 'Portrait event poster',
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({ images: [posterSocialUrl] });
  });

  it('does not emit unresolved logical media references in metadata', () => {
    const metadata = eventPageMetadataFromBootstrap(
      bootstrap({
        contentPage: {
          document: {
            eventId: 'evt_1',
            channel: 'event_page',
            key: 'main',
            name: 'Event page',
            locale: 'en',
            updatedAt: '2026-07-15T00:00:00.000Z',
          },
          version: { versionNumber: 4 },
          page: {
            provider: '@puckeditor/core',
            puckData: null,
            settings: { discovery: { socialImageUrl: 'tixkit:event-media:poster' } },
            discovery: { title: 'Event', summary: 'Event summary', tags: [] },
          },
        },
      }),
    );

    expect(JSON.stringify(metadata)).not.toContain('tixkit:event-media:');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });

  it.each([
    '/v1/events/evt_1/media/renditions/private',
    '/v1/upload-artifacts/upl_private',
    'blob:https://checkout.example.test/private-preview',
    'https://user:secret@cdn.example.test/social.jpg',
    'https://cdn.example.test/social.jpg?token=private',
  ])('does not emit an unsafe stored media source in metadata: %s', (unsafeImageUrl) => {
    const metadata = eventPageMetadataFromBootstrap(
      bootstrap({
        contentPage: {
          document: {
            eventId: 'evt_1',
            channel: 'event_page',
            key: 'main',
            name: 'Event page',
            locale: 'en',
            updatedAt: '2026-07-15T00:00:00.000Z',
          },
          version: { versionNumber: 4 },
          page: {
            provider: '@puckeditor/core',
            puckData: null,
            settings: { discovery: { socialImageUrl: unsafeImageUrl } },
            discovery: { title: 'Event', summary: 'Event summary', tags: [] },
          },
        },
      }),
    );

    expect(JSON.stringify(metadata)).not.toContain(unsafeImageUrl);
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).toMatchObject({ card: 'summary' });
  });
});
