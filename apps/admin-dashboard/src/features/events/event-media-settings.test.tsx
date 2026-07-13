import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminEventDetail } from '@/lib/api';
import { EventMediaSettings } from './event-media-settings';

const api = vi.hoisted(() => ({
  listEventMedia: vi.fn(),
  uploadArtifact: vi.fn(),
  attachEventMedia: vi.fn(),
  updateEvent: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ adminApi: api }));

const event = {
  id: 'evt_1',
  title: 'Launch Night',
  slug: 'launch-night',
  status: 'draft',
  startsAt: '2026-08-01T18:00:00.000Z',
  timezone: 'America/Chicago',
  venue: null,
  visibility: 'public',
  seo: {},
  currency: 'USD',
  grossSalesCents: 0,
  ticketsSold: 0,
  coverImageUrl: null,
  coverImageAlt: 'Launch Night crowd',
  externalUrl: null,
  resalePolicy: { enabled: false, maxMultiplier: 1 },
  checkIns: 0,
  updatedAt: '2026-07-12T00:00:00.000Z',
  brandId: 'brd_1',
} as AdminEventDetail;

afterEach(() => vi.clearAllMocks());

describe('EventMediaSettings', () => {
  it('renders optimized role thumbnails and attaches a social upload with alt and focal metadata', async () => {
    api.listEventMedia.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'ema_cover',
          role: 'cover',
          original: {
            uploadArtifactId: 'upl_cover',
            width: 1600,
            height: 900,
            format: 'webp',
            checksumSha256: 'a'.repeat(64),
            sizeBytes: 100,
          },
          focalPoint: { x: 0.5, y: 0.4 },
          altText: 'Crowd under stage lights',
          renditions: [
            {
              id: 'emr_thumb',
              variant: 'thumbnail',
              width: 480,
              height: 270,
              format: 'webp',
              checksumSha256: 'b'.repeat(64),
              sizeBytes: 50,
              url: '/v1/public/event-media/renditions/emr_thumb',
            },
          ],
        },
      ],
    });
    api.uploadArtifact.mockResolvedValue({
      ok: true,
      data: { artifactId: 'upl_social', status: 'uploaded', scanStatus: 'clean' },
    });
    api.attachEventMedia.mockResolvedValue({
      ok: true,
      data: {
        id: 'ema_social',
        role: 'social',
        original: {
          uploadArtifactId: 'upl_social',
          width: 1200,
          height: 630,
          format: 'webp',
          checksumSha256: 'c'.repeat(64),
          sizeBytes: 80,
        },
        focalPoint: { x: 0.5, y: 0.5 },
        altText: 'Social card for Launch Night',
        renditions: [],
      },
    });

    const view = render(<EventMediaSettings event={event} onSaved={vi.fn()} />);
    expect(await view.findByAltText('Crowd under stage lights')).toHaveAttribute(
      'src',
      '/v1/public/event-media/renditions/emr_thumb',
    );
    expect(view.getByRole('slider', { name: 'cover vertical focal point' })).toHaveValue('0.4');

    fireEvent.change(
      view.getByLabelText('Alt text for next upload', { selector: '#event-social-alt' }),
      {
        target: { value: 'Social card for Launch Night' },
      },
    );
    const file = new File(['image'], 'social.webp', { type: 'image/webp' });
    fireEvent.change(view.getByLabelText('Upload social'), { target: { files: [file] } });

    await waitFor(() =>
      expect(api.attachEventMedia).toHaveBeenCalledWith('evt_1', 'social', {
        uploadArtifactId: 'upl_social',
        altText: 'Social card for Launch Night',
        focalPoint: { x: 0.5, y: 0.5 },
      }),
    );
    expect(api.uploadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'event_social', eventId: 'evt_1', file }),
    );
  });
});
