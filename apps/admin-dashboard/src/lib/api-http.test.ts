import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, requestBlob } from './api-http';

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not send a JSON content type for empty-body requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('sends a JSON content type for string request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example' }),
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves backend request IDs on API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_failed',
              message: 'Invalid request',
              details: { field: 'name' },
              requestId: 'req_admin_123',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await request<{ ok: boolean }>('/v1/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'validation_failed',
        message: 'Invalid request',
        status: 400,
        details: { field: 'name' },
        requestId: 'req_admin_123',
      });
    }
  });

  it('retries transient GET failures once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = request<{ ok: boolean }>('/v1/test');
    await vi.advanceTimersByTimeAsync(250);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry transient POST failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example' }),
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('requestBlob', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads binary media with credentials and does not parse it as JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event-thumbnail', {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob('/v1/events/evt_1/media/renditions/emr_1');

    expect(result.ok).toBe(true);
    if (result.ok) expect(await result.data.text()).toBe('event-thumbnail');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/v1/events/evt_1/media/renditions/emr_1');
    expect(init.credentials).toBe('include');
  });

  it('fails closed when a private rendition is denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const result = await requestBlob('/v1/events/evt_1/media/renditions/emr_other');

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'http_error',
        message: 'Image request failed with status 404',
        status: 404,
      },
    });
  });

  it('rejects cross-origin media before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob(
      'https://attacker.example/v1/events/evt_1/media/renditions/emr_1',
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_media_url',
        message: 'The authenticated event media URL is invalid',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects same-origin paths outside the authenticated rendition surface', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob('/v1/agent/sessions?redirect=https://attacker.example');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
