import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/ready/route';

afterEach(() => vi.unstubAllEnvs());

describe('checkout readiness', () => {
  it('returns bounded identity only when runtime configuration is valid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
    vi.stubEnv('API_BASE_URL', 'https://api.example.test');
    vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_live_example');
    vi.stubEnv('TIXKIT_BUILD_REVISION', 'release-1');
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: '1',
      buildRevision: 'release-1',
      configFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it('fails closed when production runtime configuration is incomplete', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
    const response = GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_runtime_configuration',
    });
  });

  it('fails closed when the server-only API transport origin is malformed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'compact');
    vi.stubEnv('API_BASE_URL', 'http://localhost:4000');
    vi.stubEnv('INTERNAL_API_BASE_URL', 'http://user:secret@api:4000');
    vi.stubEnv('TIXKIT_CHECKOUT_URL', 'http://localhost:3000');
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'http://localhost:9000');
    vi.stubEnv('ALLOW_INSECURE_LOCAL_ORIGINS', '1');
    vi.stubEnv('TIXKIT_BUILD_REVISION', 'local');
    const response = GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: 'invalid_runtime_configuration',
    });
  });
});
