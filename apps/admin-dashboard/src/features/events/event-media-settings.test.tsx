import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminEventDetail } from '@/lib/api';
import { EventMediaSettings } from './event-media-settings';

const api = vi.hoisted(() => ({
  listEventMedia: vi.fn(),
  uploadArtifact: vi.fn(),
  attachEventMedia: vi.fn(),
  removeEventMedia: vi.fn(),
  updateEvent: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ adminApi: api }));
vi.mock('./authenticated-event-image', () => ({
  AuthenticatedEventImage: ({
    source,
  }: {
    source: { url: string; altText: string; width: number; height: number };
  }) => <img src={source.url} alt={source.altText} width={source.width} height={source.height} />,
}));

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
              id: 'emr_card',
              variant: 'card',
              width: 480,
              height: 270,
              format: 'webp',
              checksumSha256: 'c'.repeat(64),
              sizeBytes: 60,
              url: '/v1/public/event-media/renditions/emr_card',
              organizerUrl: '/v1/events/evt_1/media/renditions/emr_card',
            },
            {
              id: 'emr_thumb',
              variant: 'thumbnail',
              width: 320,
              height: 320,
              format: 'webp',
              checksumSha256: 'b'.repeat(64),
              sizeBytes: 50,
              url: '/v1/public/event-media/renditions/emr_thumb',
              organizerUrl: '/v1/events/evt_1/media/renditions/emr_thumb',
            },
          ],
        },
      ],
    });
    api.uploadArtifact.mockResolvedValue({
      ok: true,
      data: {
        artifactId: 'upl_social',
        status: 'uploaded',
        scanStatus: 'clean',
      },
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

    const onChanged = vi.fn();
    const view = render(<EventMediaSettings event={event} onChanged={onChanged} />);
    expect(await view.findByAltText('Crowd under stage lights')).toHaveAttribute(
      'src',
      '/v1/events/evt_1/media/renditions/emr_card',
    );
    expect(view.getByRole('slider', { name: 'cover vertical focal point' })).toHaveValue('0.4');

    fireEvent.change(view.getByLabelText('Social alt text for next upload'), {
      target: { value: 'Social card for Launch Night' },
    });
    const file = new File(['image'], 'social.webp', { type: 'image/webp' });
    fireEvent.change(view.getByLabelText('Upload social'), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(api.attachEventMedia).toHaveBeenCalledWith('evt_1', 'social', {
        uploadArtifactId: 'upl_social',
        altText: 'Social card for Launch Night',
        focalPoint: { x: 0.5, y: 0.5 },
      }),
    );
    expect(api.uploadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'event_social',
        eventId: 'evt_1',
        file,
      }),
    );

    api.removeEventMedia.mockResolvedValue({ ok: true, data: undefined });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const removeCover = view.getByRole('button', { name: 'Remove cover' });
    expect(removeCover).toHaveClass('text-foreground');
    fireEvent.click(removeCover);
    await waitFor(() => expect(api.removeEventMedia).toHaveBeenCalledWith('evt_1', 'cover'));
    expect(view.queryByAltText('Crowd under stage lights')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy image metadata read-only and never persists signed upload URLs', async () => {
    api.listEventMedia.mockResolvedValue({ ok: true, data: [] });
    const legacyEvent = {
      ...event,
      coverImageUrl: 'https://storage.example.test/signed-cover?expires=900',
      seo: { imageUrl: 'https://storage.example.test/signed-social?expires=900' },
      seoUseCoverImage: false,
    } as AdminEventDetail;

    const view = render(<EventMediaSettings event={legacyEvent} onChanged={vi.fn()} />);

    expect(
      await view.findByRole('complementary', { name: 'Legacy event media' }),
    ).toHaveTextContent('read-only here');
    expect(view.queryByLabelText('Upload event cover')).not.toBeInTheDocument();
    expect(view.queryByLabelText('Social image')).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Save media' })).not.toBeInTheDocument();
    expect(
      view.queryByRole('img', { name: /event cover preview|social sharing preview/i }),
    ).toBeNull();
    expect(api.updateEvent).not.toHaveBeenCalled();
    expect(api.getEvent).not.toHaveBeenCalled();
  });

  it('requires alt text before creating a structured role upload', async () => {
    api.listEventMedia.mockResolvedValue({ ok: true, data: [] });
    const view = render(<EventMediaSettings event={event} onChanged={vi.fn()} />);
    await waitFor(() => expect(api.listEventMedia).toHaveBeenCalledWith('evt_1'));

    fireEvent.change(view.getByLabelText('Cover alt text for next upload'), {
      target: { value: '   ' },
    });
    fireEvent.change(view.getByLabelText('Upload cover'), {
      target: { files: [new File(['image'], 'cover.webp', { type: 'image/webp' })] },
    });

    expect(await view.findByRole('alert')).toHaveTextContent(
      'Add alt text before uploading the cover image.',
    );
    expect(api.uploadArtifact).not.toHaveBeenCalled();
    expect(api.attachEventMedia).not.toHaveBeenCalled();
  });

  it('recovers controls and preserves the asset when removal rejects unexpectedly', async () => {
    api.listEventMedia.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'ema_social',
          role: 'social',
          original: {
            uploadArtifactId: 'upl_social',
            width: 1200,
            height: 630,
            format: 'webp',
            checksumSha256: 'd'.repeat(64),
            sizeBytes: 80,
          },
          focalPoint: { x: 0.5, y: 0.5 },
          altText: 'Launch Night social card',
          renditions: [],
        },
      ],
    });
    api.removeEventMedia.mockRejectedValue(new Error('Connection interrupted'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<EventMediaSettings event={event} onChanged={vi.fn()} />);

    fireEvent.click(await view.findByRole('button', { name: 'Remove social' }));

    expect(await view.findByRole('alert')).toHaveTextContent('Connection interrupted');
    expect(view.getByLabelText('Social alt text for next upload')).toHaveValue(
      'Launch Night social card',
    );
    expect(view.getByLabelText('Upload social')).toBeEnabled();
    expect(view.getByRole('button', { name: 'Remove social' })).toBeEnabled();
  });

  it('fails closed and retries when the initial media request rejects', async () => {
    api.listEventMedia
      .mockRejectedValueOnce(new Error('Media service unavailable'))
      .mockResolvedValueOnce({ ok: true, data: [] });
    const view = render(<EventMediaSettings event={event} onChanged={vi.fn()} />);

    expect(await view.findByRole('alert')).toHaveTextContent('Media service unavailable');
    expect(view.getByLabelText('Upload cover')).toBeDisabled();
    fireEvent.click(view.getByRole('button', { name: 'Retry loading media' }));

    await waitFor(() => expect(api.listEventMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.getByLabelText('Upload cover')).toBeEnabled());
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
    expect(view.getByText(/JPEG, PNG, and WebP files up to 8 MB/)).toBeInTheDocument();
  });
});
