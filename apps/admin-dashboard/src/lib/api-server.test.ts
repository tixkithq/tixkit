import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerPrincipal, issueServerAdminApiUrl } from './api-server';

function configure(origin: string) {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
  vi.stubEnv('API_BASE_URL', origin);
  vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
  vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
  vi.stubEnv('AUTH_PROVIDER', 'clerk');
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', 'pk_live_example');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_example');
  vi.stubEnv('TIXKIT_BUILD_REVISION', 'release-1');
}

describe('server admin API transport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('works without document and resolves each request from current validated server config', async () => {
    vi.stubGlobal('document', undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tenantId: 'tnt_1', organizationIds: [], permissions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    configure('https://public-one.example.test');
    vi.stubEnv('INTERNAL_API_BASE_URL', 'http://api-one:4000');
    await getServerPrincipal('token-one');
    configure('https://public-two.example.test');
    vi.stubEnv('INTERNAL_API_BASE_URL', 'http://api-two:4000');
    await getServerPrincipal('token-two');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://api-one:4000/v1/me',
      'http://api-two:4000/v1/me',
    ]);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer token-two',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  });

  it.each([
    ['https://user:secret@api.example.test', '/v1/me'],
    ['file:///tmp/socket', '/v1/me'],
    ['https://api.example.test/base', '/v1/me'],
    ['https://api.example.test', '//evil.example/v1/me'],
    ['https://api.example.test', '/v1/%2e%2e/health'],
    ['https://api.example.test', '/v1/me\nInjected: yes'],
  ])('rejects a hostile origin or path before transport: %s %s', (origin, path) => {
    expect(() => issueServerAdminApiUrl(origin, path)).toThrow();
  });
});
