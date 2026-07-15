import { describe, expect, it } from 'vitest';
import { resolveEventMediaThumbnails } from '../services/event-media.js';

function row(
  eventId: string,
  role: 'poster' | 'cover' | 'social',
  renditionId: string,
  variant: 'card' | 'thumbnail' = 'card',
) {
  return {
    rendition_id: renditionId,
    width: variant === 'thumbnail' ? 320 : 480,
    height: variant === 'thumbnail' ? 320 : 270,
    checksum_sha256: role.repeat(16).slice(0, 64),
    event_id: eventId,
    role,
    variant,
    alt_text: `${role} image`,
  };
}

describe('event media organizer thumbnails', () => {
  it('deterministically prefers cover, then poster, then social regardless of row order', () => {
    const first = resolveEventMediaThumbnails([
      row('evt_1', 'social', 'emr_social'),
      row('evt_1', 'poster', 'emr_poster'),
      row('evt_1', 'cover', 'emr_cover'),
    ]);
    const reversed = resolveEventMediaThumbnails([
      row('evt_1', 'cover', 'emr_cover'),
      row('evt_1', 'poster', 'emr_poster'),
      row('evt_1', 'social', 'emr_social'),
    ]);

    expect(first.get('evt_1')).toEqual(reversed.get('evt_1'));
    expect(first.get('evt_1')).toMatchObject({
      renditionId: 'emr_cover',
      role: 'cover',
      variant: 'card',
      width: 480,
      height: 270,
      url: '/v1/events/evt_1/media/renditions/emr_cover',
    });
  });

  it('prefers a card rendition over a legacy thumbnail and retains the legacy fallback', () => {
    const preferred = resolveEventMediaThumbnails([
      row('evt_1', 'cover', 'emr_cover_thumbnail', 'thumbnail'),
      row('evt_1', 'poster', 'emr_poster_card', 'card'),
    ]);
    const fallback = resolveEventMediaThumbnails([
      row('evt_2', 'poster', 'emr_poster_thumbnail', 'thumbnail'),
    ]);

    expect(preferred.get('evt_1')).toMatchObject({
      renditionId: 'emr_poster_card',
      variant: 'card',
    });
    expect(fallback.get('evt_2')).toMatchObject({
      renditionId: 'emr_poster_thumbnail',
      variant: 'thumbnail',
    });
  });

  it('never emits an original artifact URL and resolves each event independently', () => {
    const thumbnails = resolveEventMediaThumbnails([
      row('evt_poster', 'poster', 'emr_poster'),
      row('evt_social', 'social', 'emr_social'),
    ]);

    expect([...thumbnails.values()]).toHaveLength(2);
    expect([...thumbnails.values()].every(({ url }) => url.includes('/renditions/'))).toBe(true);
    expect([...thumbnails.values()].every(({ url }) => !url.includes('upload-artifacts'))).toBe(
      true,
    );
  });
});
