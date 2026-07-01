import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './api-http';

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
