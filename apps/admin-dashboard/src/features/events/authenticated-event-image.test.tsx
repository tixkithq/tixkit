import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticatedEventImage } from './authenticated-event-image';

const requestBlob = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api-http', () => ({ requestBlob }));

describe('AuthenticatedEventImage', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:event-thumbnail'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads private media with the authenticated blob client and preserves intrinsic dimensions', async () => {
    requestBlob.mockResolvedValue({ ok: true, data: new Blob(['image']) });
    const view = render(
      <AuthenticatedEventImage
        source={{
          url: '/v1/events/evt_1/media/renditions/emr_1',
          altText: 'Crowd beneath blue stage lights',
          width: 480,
          height: 270,
        }}
        className="size-12"
        fallbackClassName="size-12"
      />,
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const image = await screen.findByRole('img', {
      name: 'Crowd beneath blue stage lights',
    });
    expect(requestBlob).toHaveBeenCalledWith('/v1/events/evt_1/media/renditions/emr_1', {
      signal: expect.any(AbortSignal),
    });
    expect(image).toHaveAttribute('src', 'blob:event-thumbnail');
    expect(image).toHaveAttribute('width', '480');
    expect(image).toHaveAttribute('height', '270');

    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:event-thumbnail');
  });

  it('keeps the fixed fallback when authenticated media loading fails', async () => {
    requestBlob.mockResolvedValue({
      ok: false,
      error: {
        code: 'http_error',
        message: 'Image request failed',
        status: 404,
      },
    });
    const { container } = render(
      <AuthenticatedEventImage
        source={{
          url: '/v1/events/evt_1/media/renditions/emr_missing',
          altText: 'Missing image',
          width: 480,
          height: 270,
        }}
        fallbackClassName="size-12"
      />,
    );

    await waitFor(() => expect(requestBlob).toHaveBeenCalledOnce());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('size-12');
  });

  it('does not fetch offscreen options and only loads intersecting media', async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      element?: Element;
    }> = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '160px';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe(element: Element) {
        observers.at(-1)!.element = element;
      }
      disconnect() {}
      unobserve() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    requestBlob.mockResolvedValue({ ok: true, data: new Blob(['image']) });

    render(
      <div>
        {Array.from({ length: 100 }, (_, index) => (
          <AuthenticatedEventImage
            key={index}
            source={{
              url: `/v1/events/evt_${index}/media/renditions/emr_${index}`,
              altText: `Event ${index}`,
              width: 480,
              height: 270,
            }}
          />
        ))}
      </div>,
    );

    expect(observers).toHaveLength(100);
    expect(requestBlob).not.toHaveBeenCalled();
    observers[0]!.callback(
      [
        {
          isIntersecting: true,
          target: observers[0]!.element!,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    await waitFor(() => expect(requestBlob).toHaveBeenCalledOnce());
    expect(requestBlob.mock.calls[0]![0]).toBe('/v1/events/evt_0/media/renditions/emr_0');
  });

  it('aborts an in-flight private media request when unmounted', async () => {
    requestBlob.mockReturnValue(new Promise(() => {}));
    const view = render(
      <AuthenticatedEventImage
        source={{
          url: '/v1/events/evt_1/media/renditions/emr_1',
          altText: 'Event',
          width: 480,
          height: 270,
        }}
      />,
    );

    await waitFor(() => expect(requestBlob).toHaveBeenCalledOnce());
    const options = requestBlob.mock.calls[0]![1] as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    view.unmount();
    expect(options.signal.aborted).toBe(true);
  });
});
