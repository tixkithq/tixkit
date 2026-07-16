import { describe, expect, it } from 'vitest';
import { adminContentSecurityPolicy } from '../../next.config.mjs';

function directive(policy: string, name: string): string {
  const value = policy.split('; ').find((candidate) => candidate.startsWith(`${name} `));
  expect(value, `${name} directive`).toBeDefined();
  return value ?? '';
}

describe('adminContentSecurityPolicy', () => {
  it('uses exact configured origins and excludes development execution sources in production', () => {
    const policy = adminContentSecurityPolicy({
      nodeEnv: 'production',
      apiUrl: 'https://api.tixkit.example/v1?region=us',
      checkoutUrl: 'https://checkout.tixkit.example/embed/event',
    });

    expect(directive(policy, 'img-src')).toContain('https://api.tixkit.example');
    expect(directive(policy, 'frame-src')).toContain('https://checkout.tixkit.example');
    expect(directive(policy, 'connect-src')).toContain('https://api.tixkit.example');
    expect(policy).not.toContain('/v1');
    expect(policy).not.toContain('/embed/event');
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain('127.0.0.1');
    expect(policy).not.toContain('https://esm.sh');
    expect(policy).not.toContain('http://localhost:7331');
    expect(directive(policy, 'script-src')).toContain('https://*.clerk.com');
  });

  it('fails closed without adding loopback fallbacks when production URLs are absent', () => {
    const policy = adminContentSecurityPolicy({ nodeEnv: 'production' });

    expect(directive(policy, 'connect-src')).toBe(
      "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
    );
    expect(directive(policy, 'frame-src')).toBe(
      "frame-src 'self' https://*.clerk.accounts.dev https://*.clerk.com",
    );
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain('127.0.0.1');
  });

  it('retains the bounded sources required by the development runtime', () => {
    const policy = adminContentSecurityPolicy({
      nodeEnv: 'development',
      apiUrl: 'http://localhost:4000/v1',
      checkoutUrl: 'http://127.0.0.1:3000/checkout',
    });

    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(policy, 'script-src')).toContain('http://localhost:7331');
    expect(directive(policy, 'script-src')).toContain('https://esm.sh');
    expect(directive(policy, 'connect-src')).toContain('ws://localhost:*');
    expect(directive(policy, 'connect-src')).toContain('http://127.0.0.1:*');
    expect(directive(policy, 'frame-src')).toContain('http://127.0.0.1:3000');
  });

  it('preserves the development devtools-disable control without removing Next evaluation', () => {
    const policy = adminContentSecurityPolicy({
      nodeEnv: 'development',
      apiUrl: 'http://localhost:4000/v1',
      checkoutUrl: 'http://localhost:3000',
      disableReactDevtools: true,
    });

    expect(directive(policy, 'script-src')).toContain("'unsafe-eval'");
    expect(policy).not.toContain('http://localhost:7331');
    expect(policy).not.toContain('https://esm.sh');
  });

  it('excludes development sources in production regardless of the devtools control', () => {
    const policy = adminContentSecurityPolicy({
      nodeEnv: 'production',
      apiUrl: 'https://api.example.com/v1',
      checkoutUrl: 'https://checkout.example.com',
      disableReactDevtools: false,
    });

    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain('http://localhost:7331');
    expect(policy).not.toContain('https://esm.sh');
  });

  it.each([
    ['non-HTTP scheme', 'javascript:alert(1)'],
    ['credentials', 'https://user:password@example.com/v1'],
    ['CSP delimiter', 'https://example.com;script-src https://evil.example'],
    ['comma delimiter', 'https://example.com,https://evil.example'],
    ['embedded newline', 'https://example.com\nscript-src https://evil.example'],
    ['embedded tab', 'https://example.com\t/path'],
    ['wildcard hostname', 'https://*.example.com/path'],
    ['quote hostname', "https://example.com'/path"],
    ['backslash normalization', 'https://example.com\\evil.example/path'],
    ['malformed URL', 'not a URL'],
  ])('rejects %s in configured URLs', (_case, value) => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: value,
        checkoutUrl: 'https://checkout.example.com',
      }),
    ).toThrow();
  });

  it('applies the same hostile-input validation to the checkout URL', () => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: 'https://api.example.com',
        checkoutUrl: 'https://checkout.example.com;frame-src https://evil.example',
      }),
    ).toThrow(/checkout URL/u);
  });

  it.each([
    ['remote HTTP', 'http://checkout.example.com/path', /HTTPS in production/u],
    ['credentials', 'https://user:password@checkout.example.com/path', /credentials/u],
    ['loopback', 'http://localhost:3000/path', /loopback origin/u],
  ])('fails closed for checkout %s configuration', (_case, checkoutUrl, expectedError) => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: 'https://api.example.com',
        checkoutUrl,
      }),
    ).toThrow(expectedError);
  });

  it.each([
    'http://localhost:4000',
    'http://127.0.0.1:4000',
    'http://127.99.2.3:4000',
    'http://[::1]:4000',
    'http://[::ffff:127.0.0.1]:4000',
    'http://0.0.0.0:4000',
    'http://localhost.:4000',
    'http://api.localhost:4000',
  ])('rejects production loopback origin %s', (value) => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: value,
        checkoutUrl: 'https://checkout.example.com',
      }),
    ).toThrow(/loopback origin/u);
  });

  it('permits HTTP loopback only through the explicit Compact production escape', () => {
    const policy = adminContentSecurityPolicy({
      nodeEnv: 'production',
      apiUrl: 'http://127.0.0.1:4000/v1',
      checkoutUrl: 'http://localhost:3000/checkout',
      allowInsecureLocalOrigins: true,
    });

    expect(directive(policy, 'connect-src')).toContain('http://127.0.0.1:4000');
    expect(directive(policy, 'frame-src')).toContain('http://localhost:3000');
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it.each([true, false])('rejects remote production HTTP when escape is %s', (enabled) => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: 'http://api.example.com/v1',
        checkoutUrl: 'https://checkout.example.com',
        allowInsecureLocalOrigins: enabled,
      }),
    ).toThrow(/HTTPS in production/u);
  });

  it.each(['1', 'true', 1, {}, []])(
    'does not enable the Compact escape for truthy value %j',
    (value) => {
      expect(() =>
        adminContentSecurityPolicy({
          nodeEnv: 'production',
          apiUrl: 'http://localhost:4000/v1',
          checkoutUrl: 'https://checkout.example.com',
          // @ts-expect-error -- Runtime hardening must reject non-boolean configuration values.
          allowInsecureLocalOrigins: value,
        }),
      ).toThrow(/loopback origin/u);
    },
  );

  it('rejects HTTPS loopback even when the Compact HTTP escape is enabled', () => {
    expect(() =>
      adminContentSecurityPolicy({
        nodeEnv: 'production',
        apiUrl: 'https://localhost:4000/v1',
        checkoutUrl: 'https://checkout.example.com',
        allowInsecureLocalOrigins: true,
      }),
    ).toThrow(/loopback origin/u);
  });
});
