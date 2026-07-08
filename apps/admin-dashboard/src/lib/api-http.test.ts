import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './api-http';

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

    const result = await request<{ ok: boolean }>('/v1/test', { method: 'POST' });

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
