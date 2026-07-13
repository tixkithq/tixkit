import { describe, expect, it } from 'vitest';
import type { PublicEvent, PublicEventMediaAsset } from '@/lib/api';
import { resolveEventPageMedia, resolveEventSocialMedia } from '@/lib/event-media';

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
      width: variant === 'thumbnail' ? 480 : 1200,
      height: variant === 'thumbnail' ? 270 : 630,
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
  ])('$name', ({ assets, expected }) => {
    expect(resolveEventSocialMedia(event(assets))?.url).toBe(expected);
  });

  it('prefers cover page over poster page for the event-page hero', () => {
    expect(
      resolveEventPageMedia(event([asset('poster', ['page']), asset('cover', ['page'])]))?.url,
    ).toBe('https://media.example/cover-page.webp');
  });
});
