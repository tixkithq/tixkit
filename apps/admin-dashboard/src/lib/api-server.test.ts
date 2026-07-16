import { afterEach, describe, expect, it, vi } from 'vitest';
import { getServerPrincipal } from './api-server';

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
    configure('https://one.example.test');
    await getServerPrincipal('token-one');
    configure('https://two.example.test');
    await getServerPrincipal('token-two');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://one.example.test/v1/me',
      'https://two.example.test/v1/me',
    ]);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer token-two',
    );
  });
});
