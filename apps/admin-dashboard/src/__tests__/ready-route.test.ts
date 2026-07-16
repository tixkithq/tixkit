import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/ready/route';

function configureProduction() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
  vi.stubEnv('API_BASE_URL', 'https://admin.example.test');
  vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
  vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
  vi.stubEnv('AUTH_PROVIDER', 'clerk');
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', 'pk_live_example');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_example');
  vi.stubEnv('TIXKIT_BUILD_REVISION', 'release-1');
}

describe('admin readiness route', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns only schema, build and fingerprint for valid configuration', async () => {
    configureProduction();
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: '1',
      buildRevision: 'release-1',
      configFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(body)).not.toContain('example.test');
  });

  it('returns a safe 503 without configuration details when validation fails', async () => {
    configureProduction();
    vi.stubEnv('API_BASE_URL', 'https://user:secret@admin.example.test');
    const response = GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'unavailable',
      reason: 'invalid_runtime_configuration',
    });
  });
});
