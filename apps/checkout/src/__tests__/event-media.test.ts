import { describe, expect, it } from 'vitest';
import type { PublicEvent, PublicEventMediaAsset } from '@/lib/api';
import {
  resolveEventMediaByUrl,
  resolveEventPageMedia,
  resolveEventSocialMedia,
} from '@/lib/event-media';

function asset(
  role: PublicEventMediaAsset['role'],
  variants: PublicEventMediaAsset['renditions'][number]['variant'][],
): PublicEventMediaAsset {
  return {
    role,
    altText: `${role} alt`,
    focalPoint: { x: 0.5, y: 0.5 },
    renditions: variants.map((variant) => ({
      variant,
      width: variant === 'thumbnail' ? 320 : variant === 'card' ? 480 : 1200,
      height: variant === 'thumbnail' ? 320 : variant === 'card' ? 270 : 630,
      url: `https://media.example/${role}-${variant}.webp`,
    })),
  };
}

function event(mediaAssets: PublicEventMediaAsset[]): PublicEvent {
  return {
    id: 'evt_1',
    title: 'Event',
    status: 'published',
    timezone: 'UTC',
    startsAt: '2026-01-01T00:00:00.000Z',
    mediaAssets,
  };
}

describe('event media fallback resolution', () => {
  it.each([
    {
      name: 'uses poster page when a cover exists without a page rendition',
      assets: [asset('cover', ['thumbnail']), asset('poster', ['page'])],
      expected: 'https://media.example/poster-page.webp',
    },
    {
      name: 'uses an imported cover page rendition for social metadata',
      assets: [asset('cover', ['page'])],
      expected: 'https://media.example/cover-page.webp',
    },
    {
      name: 'uses a thumbnail only after larger renditions are exhausted',
      assets: [asset('social', ['thumbnail'])],
      expected: 'https://media.example/social-thumbnail.webp',
    },
    {
      name: 'uses a card before a square thumbnail when larger renditions are unavailable',
      assets: [asset('cover', ['thumbnail', 'card'])],
      expected: 'https://media.example/cover-card.webp',
    },
  ])('$name', ({ assets, expected }) => {
    expect(resolveEventSocialMedia(event(assets))?.url).toBe(expected);
  });

  it('prefers cover page over poster page for the event-page hero', () => {
    expect(
      resolveEventPageMedia(event([asset('poster', ['page']), asset('cover', ['page'])]))?.url,
    ).toBe('https://media.example/cover-page.webp');
  });

  it('canonicalizes only exact owned relative rendition paths to the API URL', () => {
    const mediaEvent = event([asset('social', ['social'])]);
    mediaEvent.mediaAssets![0]!.renditions[0]!.url =
      'https://api.example.test/v1/public/event-media/renditions/emr_social';

    expect(
      resolveEventMediaByUrl(
        mediaEvent,
        '/v1/public/event-media/renditions/emr_social',
        'https://api.example.test',
      )?.url,
    ).toBe('https://api.example.test/v1/public/event-media/renditions/emr_social');
    expect(
      resolveEventMediaByUrl(
        mediaEvent,
        'https://foreign.example/v1/public/event-media/renditions/emr_social',
        'https://api.example.test',
      ),
    ).toBeUndefined();
    expect(
      resolveEventMediaByUrl(
        mediaEvent,
        '/v1/public/event-media/renditions/emr_social?credential=secret',
        'https://api.example.test',
      ),
    ).toBeUndefined();

    mediaEvent.mediaAssets![0]!.renditions[0]!.url =
      'https://user:secret@foreign.example/v1/public/event-media/renditions/emr_social';
    expect(
      resolveEventMediaByUrl(
        mediaEvent,
        '/v1/public/event-media/renditions/emr_social',
        'https://api.example.test',
      ),
    ).toBeUndefined();
  });
});
