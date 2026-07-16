import { describe, expect, it } from 'vitest';
import {
  ADMIN_RUNTIME_CONFIG_ATTRIBUTES,
  readAdminRuntimeConfig,
  runtimeConfigDataAttributes,
} from './runtime-config-contract';
import { parseAdminRuntimeConfig } from './runtime-config-server';

const productionEnvironment = {
  NODE_ENV: 'production',
  TIXKIT_DEPLOYMENT_PROFILE: 'production',
  API_BASE_URL: 'https://admin.example.test',
  TIXKIT_CHECKOUT_URL: 'https://checkout.example.test',
  TIXKIT_DOCS_URL: 'https://docs.example.test',
  S3_PUBLIC_ENDPOINT: 'https://media.example.test',
  AUTH_PROVIDER: 'clerk',
  CLERK_PUBLISHABLE_KEY: 'pk_live_example',
  CLERK_SECRET_KEY: 'sk_live_example',
  TIXKIT_BUILD_REVISION: 'release-1',
} as const;

describe('admin runtime configuration', () => {
  it('creates only the explicit public snapshot and derives the platform path', () => {
    const config = parseAdminRuntimeConfig({ ...productionEnvironment, PRIVATE_SECRET: 'never' });
    expect(config.platformApiBaseUrl).toBe('https://admin.example.test/v1');
    expect(config.configFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(config)).not.toContain('never');
    expect(JSON.stringify(config)).not.toContain('sk_live_example');
    expect(
      parseAdminRuntimeConfig({ ...productionEnvironment, CLERK_SECRET_KEY: 'sk_live_different' })
        .configFingerprint,
    ).toBe(config.configFingerprint);
    expect(Object.keys(runtimeConfigDataAttributes(config)).sort()).toEqual(
      Object.values(ADMIN_RUNTIME_CONFIG_ATTRIBUTES).sort(),
    );
  });

  it('round-trips through explicit document attributes', () => {
    const expected = parseAdminRuntimeConfig(productionEnvironment);
    const attributes = runtimeConfigDataAttributes(expected);
    const actual = readAdminRuntimeConfig({
      getAttribute: (name) => attributes[name] ?? null,
    });
    expect(actual).toEqual(expected);
  });

  it.each([
    ['credentials', { API_BASE_URL: 'https://user:secret@admin.example.test' }],
    ['query', { API_BASE_URL: 'https://admin.example.test?x=1' }],
    ['hash', { API_BASE_URL: 'https://admin.example.test#x' }],
    ['path', { API_BASE_URL: 'https://admin.example.test/v1' }],
    ['wildcard', { API_BASE_URL: 'https://*.example.test' }],
    ['CSP delimiter', { API_BASE_URL: 'https://admin.example.test;connect-src https://evil.test' }],
    ['control character', { API_BASE_URL: 'https://admin.example.test\nhttps://evil.test' }],
    ['backslash', { API_BASE_URL: 'https:\\admin.example.test' }],
    ['placeholder', { API_BASE_URL: '${API_BASE_URL}' }],
    ['loopback', { API_BASE_URL: 'https://localhost:4000' }],
  ])('rejects hostile production %s input', (_, override) => {
    expect(() => parseAdminRuntimeConfig({ ...productionEnvironment, ...override })).toThrow();
  });

  it.each(['API_BASE_URL', 'TIXKIT_CHECKOUT_URL', 'TIXKIT_DOCS_URL', 'S3_PUBLIC_ENDPOINT'])(
    'rejects attribute/CSP breakout input in %s',
    (key) => {
      expect(() =>
        parseAdminRuntimeConfig({
          ...productionEnvironment,
          [key]: `https://safe.example.test"><script src=https://evil.example></script>`,
        }),
      ).toThrow();
    },
  );

  it('rejects non-public Clerk key and build-revision characters before serialization', () => {
    expect(() =>
      parseAdminRuntimeConfig({
        ...productionEnvironment,
        CLERK_PUBLISHABLE_KEY: 'sk_live_secret',
      }),
    ).toThrow('CLERK_PUBLISHABLE_KEY is invalid');
    expect(() =>
      parseAdminRuntimeConfig({
        ...productionEnvironment,
        TIXKIT_BUILD_REVISION: 'release" onload=',
      }),
    ).toThrow('TIXKIT_BUILD_REVISION is invalid');
  });

  it('requires production-like revision and Clerk server secret and caps public values', () => {
    expect(() =>
      parseAdminRuntimeConfig({ ...productionEnvironment, TIXKIT_BUILD_REVISION: undefined }),
    ).toThrow('TIXKIT_BUILD_REVISION is required');
    expect(() =>
      parseAdminRuntimeConfig({ ...productionEnvironment, CLERK_SECRET_KEY: undefined }),
    ).toThrow('CLERK_SECRET_KEY is required');
    expect(() =>
      parseAdminRuntimeConfig({
        ...productionEnvironment,
        API_BASE_URL: `https://${'a'.repeat(520)}.test`,
      }),
    ).toThrow();
  });

  it.each([
    'latest',
    'local',
    'unknown',
    'unset',
    'development',
    'placeholder',
    'example',
    'main',
    'HEAD',
  ])('rejects Fly/Render-style production placeholder revision %s', (revision) => {
    expect(() =>
      parseAdminRuntimeConfig({ ...productionEnvironment, TIXKIT_BUILD_REVISION: revision }),
    ).toThrow('must identify an immutable production artifact');
  });

  it('permits Compact local revision while retaining the explicit loopback escape', () => {
    expect(
      parseAdminRuntimeConfig({
        NODE_ENV: 'production',
        TIXKIT_DEPLOYMENT_PROFILE: 'compact',
        API_BASE_URL: 'http://localhost:4000',
        TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
        S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
        AUTH_PROVIDER: 'dev',
        ALLOW_INSECURE_LOCAL_ORIGINS: '1',
        TIXKIT_BUILD_REVISION: 'local',
      }).buildRevision,
    ).toBe('local');
  });

  it('permits Compact loopback HTTP and dev auth only with the exact escape', () => {
    const compact = {
      NODE_ENV: 'production',
      TIXKIT_DEPLOYMENT_PROFILE: 'compact',
      API_BASE_URL: 'http://localhost:4000',
      TIXKIT_CHECKOUT_URL: 'http://localhost:3000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      AUTH_PROVIDER: 'dev',
    } as const;
    expect(() => parseAdminRuntimeConfig(compact)).toThrow();
    expect(
      parseAdminRuntimeConfig({ ...compact, ALLOW_INSECURE_LOCAL_ORIGINS: '1' }).authProvider,
    ).toBe('dev');
    expect(() =>
      parseAdminRuntimeConfig({ ...compact, ALLOW_INSECURE_LOCAL_ORIGINS: 'true' }),
    ).toThrow();
  });

  it.each(['evaluation', 'production', 'cloud'] as const)(
    'requires Clerk for the %s profile',
    (profile) => {
      expect(() =>
        parseAdminRuntimeConfig({
          ...productionEnvironment,
          TIXKIT_DEPLOYMENT_PROFILE: profile,
          AUTH_PROVIDER: 'dev',
          CLERK_PUBLISHABLE_KEY: undefined,
        }),
      ).toThrow(`requires Clerk authentication`);
    },
  );

  it('rejects OIDC and unknown authentication modes', () => {
    expect(() =>
      parseAdminRuntimeConfig({ ...productionEnvironment, AUTH_PROVIDER: 'oidc' }),
    ).toThrow('AUTH_PROVIDER must be clerk or dev');
  });

  it('rejects a document snapshot whose derived platform path was substituted', () => {
    const config = parseAdminRuntimeConfig(productionEnvironment);
    const attributes: Record<string, string> = {
      ...runtimeConfigDataAttributes(config),
      [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.platformApiBaseUrl]: 'https://attacker.example/v1',
    };
    expect(() =>
      readAdminRuntimeConfig({ getAttribute: (name) => attributes[name] ?? null }),
    ).toThrow('does not match');
  });
});
