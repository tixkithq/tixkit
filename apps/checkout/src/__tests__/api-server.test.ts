import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerEventPageBootstrap, issueCheckoutServerApiUrl } from '@/lib/api-server';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('checkout server API transport', () => {
  it('uses the internal origin while exposing public media URLs without caching live inventory', async () => {
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'compact');
    vi.stubEnv('API_BASE_URL', 'http://localhost:4000');
    vi.stubEnv('INTERNAL_API_BASE_URL', 'http://api:4000');
    vi.stubEnv('TIXKIT_CHECKOUT_URL', 'http://localhost:3000');
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'http://localhost:9000');
    vi.stubEnv('ALLOW_INSECURE_LOCAL_ORIGINS', '1');
    vi.stubEnv('TIXKIT_BUILD_REVISION', 'local');
    const fetchMock = vi.fn(async () =>
      Response.json({
        event: {
          id: 'evt_1',
          title: 'Event',
          status: 'published',
          timezone: 'UTC',
          startsAt: '2026-01-01T00:00:00.000Z',
          mediaAssets: [
            {
              role: 'cover',
              altText: 'Cover',
              focalPoint: { x: 0.5, y: 0.5 },
              renditions: [{ variant: 'page', width: 1200, height: 630, url: '/media/cover' }],
            },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getServerEventPageBootstrap('evt_1', 'en');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api:4000/v1/public/events/evt_1/page-bootstrap?locale=en',
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.event.mediaAssets?.[0]?.renditions[0]?.url).toBe(
      'http://localhost:4000/media/cover',
    );
  });

  it.each([
    ['https://user:secret@api.example.test', '/v1/public/events/evt_1/page-bootstrap'],
    ['file:///tmp/socket', '/v1/public/events/evt_1/page-bootstrap'],
    ['https://api.example.test/base', '/v1/public/events/evt_1/page-bootstrap'],
    ['https://api.example.test', '//evil.example/v1/public/events/evt_1/page-bootstrap'],
    ['https://api.example.test', '/v1/public/events/%2e%2e/page-bootstrap'],
    ['https://api.example.test', '/v1/public/events/evt_1/page-bootstrap\nX-Test: yes'],
  ])('rejects a hostile origin or path before transport: %s %s', (origin, path) => {
    expect(() => issueCheckoutServerApiUrl(origin, path)).toThrow();
  });
});
