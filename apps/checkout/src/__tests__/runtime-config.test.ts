import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBrowserRuntimeConfig,
  initializeBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from '@/lib/runtime-config-browser';
import {
  CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES,
  readCheckoutRuntimeConfig,
  runtimeConfigDataAttributes,
  type PublicCheckoutRuntimeConfig,
  parseExactOrigin,
  validateDomainBrandMap,
  validateStripePublishableKey,
} from '@/lib/runtime-config-contract';
import {
  parseCheckoutRuntimeConfig,
  parseCheckoutServerRuntime,
} from '@/lib/runtime-config-server';

function config(overrides: Partial<PublicCheckoutRuntimeConfig> = {}): PublicCheckoutRuntimeConfig {
  return {
    schemaVersion: '1',
    deploymentProfile: 'production',
    apiBaseUrl: 'https://api.example.test',
    platformApiBaseUrl: 'https://api.example.test/v1',
    checkoutUrl: 'https://checkout.example.test',
    mediaOrigin: 'https://media.example.test',
    stripePublishableKey: 'pk_test_example',
    domainBrandMap: '{"events.example.test":"brand_example"}',
    buildRevision: 'release-1',
    configFingerprint: `sha256:${'1'.repeat(64)}`,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetBrowserRuntimeConfigForTests();
});

describe('checkout runtime configuration', () => {
  it.each([
    'https://user:pass@example.test',
    'https://example.test/path',
    'https://example.test?query=1',
    'https://example.test#fragment',
    'https://*.example.test',
    'https://example.test;script-src',
    'https://example.test\\attacker',
    `https://example.test${String.fromCharCode(10)}`,
    `https://${'a'.repeat(520)}.test`,
    'http://api.example.test',
  ])('rejects unsafe public origin %s', (value) => {
    expect(() => parseExactOrigin(value, 'API_BASE_URL', { allowLoopbackHttp: false })).toThrow();
  });

  it('rejects loopback public origins in production and requires the Compact escape', () => {
    expect(() =>
      parseExactOrigin('http://localhost:4000', 'API_BASE_URL', { allowLoopbackHttp: false }),
    ).toThrow(/HTTPS|loopback/u);
    expect(() =>
      parseCheckoutRuntimeConfig({
        NODE_ENV: 'production',
        TIXKIT_DEPLOYMENT_PROFILE: 'compact',
        API_BASE_URL: 'http://localhost:4000',
        TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        TIXKIT_BUILD_REVISION: 'local',
      }),
    ).toThrow(/HTTPS/u);
  });

  it.each(['pk_test', 'sk_test_secret', 'pk_live_bad value', `pk_test_${'a'.repeat(260)}`])(
    'rejects invalid Stripe publishable key %s',
    (value) => expect(() => validateStripePublishableKey(value)).toThrow(),
  );

  it.each(['latest', 'local', 'unset', 'example', 'main', 'snapshot'])(
    'rejects production placeholder revision %s',
    (buildRevision) => {
      expect(() =>
        parseCheckoutRuntimeConfig({
          NODE_ENV: 'production',
          TIXKIT_DEPLOYMENT_PROFILE: 'production',
          API_BASE_URL: 'https://api.example.test',
          TIXKIT_CHECKOUT_URL: 'https://checkout.example.test',
          S3_PUBLIC_ENDPOINT: 'https://media.example.test',
          STRIPE_PUBLISHABLE_KEY: 'pk_live_example',
          TIXKIT_BUILD_REVISION: buildRevision,
        }),
      ).toThrow(/immutable/u);
    },
  );

  it.each([
    'http://user:pass@api:4000',
    'http://api:4000/v1',
    'http://api:4000?query=1',
    `http://api:4000${String.fromCharCode(10)}`,
  ])('rejects unsafe internal origin %s', (internalOrigin) => {
    expect(() =>
      parseCheckoutServerRuntime({
        TIXKIT_DEPLOYMENT_PROFILE: 'compact',
        API_BASE_URL: 'http://localhost:4000',
        INTERNAL_API_BASE_URL: internalOrigin,
        TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        ALLOW_INSECURE_LOCAL_ORIGINS: '1',
        TIXKIT_BUILD_REVISION: 'local',
      }),
    ).toThrow(/INTERNAL_API_BASE_URL/u);
  });

  it('bounds and validates domain-to-brand mappings', () => {
    expect(validateDomainBrandMap('{"events.example.test":"brand_1"}')).toBe(
      '{"events.example.test":"brand_1"}',
    );
    expect(() => validateDomainBrandMap('{"bad host":"brand_1"}')).toThrow();
    expect(() => validateDomainBrandMap('{"events.example.test":"bad brand"}')).toThrow();
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`event-${index}.example.test`, `brand_${index}`]),
    );
    expect(() => validateDomainBrandMap(JSON.stringify(tooMany))).toThrow(/too many/u);
  });
  it('derives /v1 from an exact public origin and keeps the internal server origin private', () => {
    const runtime = parseCheckoutServerRuntime({
      NODE_ENV: 'production',
      TIXKIT_DEPLOYMENT_PROFILE: 'compact',
      API_BASE_URL: 'http://localhost:4000',
      INTERNAL_API_BASE_URL: 'http://api:4000',
      TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      ALLOW_INSECURE_LOCAL_ORIGINS: '1',
      TIXKIT_BUILD_REVISION: 'local',
    });

    expect(runtime.publicConfig.platformApiBaseUrl).toBe('http://localhost:4000/v1');
    expect(runtime.internalApiBaseUrl).toBe('http://api:4000');
    expect(JSON.stringify(runtime.publicConfig)).not.toContain('http://api:4000');
    const alternate = parseCheckoutServerRuntime({
      NODE_ENV: 'production',
      TIXKIT_DEPLOYMENT_PROFILE: 'compact',
      API_BASE_URL: 'http://localhost:4000',
      INTERNAL_API_BASE_URL: 'http://api-alternate:4000',
      TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      ALLOW_INSECURE_LOCAL_ORIGINS: '1',
      TIXKIT_BUILD_REVISION: 'local',
    });
    expect(alternate.publicConfig.configFingerprint).toBe(runtime.publicConfig.configFingerprint);
  });

  it('never serializes planted private secrets and excludes server-only transport from the fingerprint', () => {
    const first = parseCheckoutServerRuntime({
      TIXKIT_DEPLOYMENT_PROFILE: 'compact',
      API_BASE_URL: 'http://localhost:4000',
      INTERNAL_API_BASE_URL: 'http://api:4000',
      TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      ALLOW_INSECURE_LOCAL_ORIGINS: '1',
      TIXKIT_BUILD_REVISION: 'local',
      STRIPE_SECRET_KEY: 'sk_test_planted_private_secret',
      DATABASE_URL: 'postgres://private:secret@database/tixkit',
    });
    const second = parseCheckoutServerRuntime({
      TIXKIT_DEPLOYMENT_PROFILE: 'compact',
      API_BASE_URL: 'http://localhost:4000',
      INTERNAL_API_BASE_URL: 'http://other-api:4000',
      TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      ALLOW_INSECURE_LOCAL_ORIGINS: '1',
      TIXKIT_BUILD_REVISION: 'local',
      STRIPE_SECRET_KEY: 'sk_test_different_private_secret',
      DATABASE_URL: 'postgres://other:secret@database/tixkit',
    });
    const serialized = JSON.stringify(runtimeConfigDataAttributes(first.publicConfig));
    expect(serialized).not.toMatch(/planted|postgres|DATABASE|INTERNAL|sk_test/u);
    expect(second.publicConfig.configFingerprint).toBe(first.publicConfig.configFingerprint);
  });

  it('requires immutable revision and Stripe configuration in production-like profiles', () => {
    const environment = {
      NODE_ENV: 'production',
      TIXKIT_DEPLOYMENT_PROFILE: 'production',
      API_BASE_URL: 'https://api.example.test',
      TIXKIT_CHECKOUT_URL: 'https://checkout.example.test',
      S3_PUBLIC_ENDPOINT: 'https://media.example.test',
    };
    expect(() => parseCheckoutRuntimeConfig(environment)).toThrow(/STRIPE_PUBLISHABLE_KEY/u);
    expect(() =>
      parseCheckoutRuntimeConfig({
        ...environment,
        STRIPE_PUBLISHABLE_KEY: 'pk_live_example',
        TIXKIT_BUILD_REVISION: 'latest',
      }),
    ).toThrow(/immutable production artifact/u);
  });

  it('round-trips the public snapshot without serializing server transport', () => {
    const expected = config();
    const attributes = runtimeConfigDataAttributes(expected);
    const actual = readCheckoutRuntimeConfig({
      getAttribute: (name) => attributes[name] ?? null,
    });
    expect(actual).toEqual(expected);
    expect(attributes[CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl]).toBe(
      'https://api.example.test',
    );
  });

  it('is inert during SSR and binds a copied immutable browser snapshot once', () => {
    const mutable = { ...config() };
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    initializeBrowserRuntimeConfig(mutable);
    expect(getBrowserRuntimeConfig().deploymentProfile).toBe('test');
    vi.unstubAllGlobals();

    initializeBrowserRuntimeConfig(mutable);
    mutable.apiBaseUrl = 'https://mutated.example.test';
    document.documentElement.setAttribute(
      CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl,
      'https://dom-mutated.example.test',
    );
    expect(getBrowserRuntimeConfig().apiBaseUrl).toBe('https://api.example.test');
    expect(Object.isFrozen(getBrowserRuntimeConfig())).toBe(true);
  });

  it('rejects a forged same-fingerprint rebind when any public field changes', () => {
    initializeBrowserRuntimeConfig(config());
    expect(() =>
      initializeBrowserRuntimeConfig(config({ mediaOrigin: 'https://attacker.example.test' })),
    ).toThrow(/changed after initialization/u);
    const { stripePublishableKey: _removed, ...withoutStripe } = config();
    expect(() => initializeBrowserRuntimeConfig(withoutStripe)).toThrow(
      /changed after initialization/u,
    );
  });
});
