import { test, expect, requireReachable } from './fixtures/validation-test';
import { adminBaseUrl, checkoutBaseUrl } from './helpers/env';
import { isLoopbackHostname } from '../apps/admin-dashboard/next.config.mjs';

function expectCspDirectives(header: string | null, directives: string[]): void {
  expect(header).toBeTruthy();
  const policy = header ?? '';
  for (const directive of directives) {
    expect(policy).toContain(directive);
  }
}

function expectAdminCspRuntimeFloor(policy: string): void {
  const adminRuntime =
    process.env.E2E_ADMIN_RUNTIME ??
    (process.env.E2E_LIVE_CLERK === '1' ? 'production' : 'development');

  if (adminRuntime === 'development') {
    expect(policy).toContain("'unsafe-eval'");
    return;
  }

  expect(adminRuntime).toBe('production');

  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain('https://esm.sh');

  const connectDirective = policy
    .split('; ')
    .find((candidate) => candidate.startsWith('connect-src '));
  expect(connectDirective).toBeDefined();
  for (const source of connectDirective?.split(/\s+/u).slice(1) ?? []) {
    if (!/^(?:http|ws)s?:\/\//u.test(source)) continue;
    const parseableSource = source.replace(/:\*$/u, ':65535');
    expect(isLoopbackHostname(new URL(parseableSource).hostname), source).toBe(false);
  }
}

const contentStudioSecretPattern =
  /RESEND_API_KEY|SENDGRID_API_KEY|MAILGUN_API_KEY|TWILIO_AUTH_TOKEN|STRIPE_SECRET_KEY|PAYPAL_CLIENT_SECRET|secret:\/\/|sk_(?:live|test)_|rk_(?:live|test)_/i;

test.describe('browser security headers', () => {
  test('admin dashboard sends CSP and anti-framing headers', async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    const response = await page.request.get(`${adminBaseUrl}/sign-in`, {
      failOnStatusCode: false,
    });

    expect(response.status()).toBeLessThan(500);
    expectCspDirectives(response.headers()['content-security-policy'] ?? null, [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ]);
    expectAdminCspRuntimeFloor(response.headers()['content-security-policy'] ?? '');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
  });

  test('hosted checkout sends embeddable CSP for widget iframe usage', async ({ page }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const response = await page.request.get(
      `${checkoutBaseUrl}/checkout?eventId=evt_security_headers`,
      {
        failOnStatusCode: false,
      },
    );

    expect(response.status()).toBeLessThan(500);
    expectCspDirectives(response.headers()['content-security-policy'] ?? null, [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https:",
      "style-src-elem 'self' 'unsafe-inline'",
      "style-src-attr 'unsafe-inline'",
      'https://js.stripe.com',
    ]);
    expect(response.headers()['x-frame-options']).toBeUndefined();
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
  });

  test('content studio editor route keeps CSP and exposes no provider secrets', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    const response = await page.goto(`${adminBaseUrl}/events/evt_security_headers/content/email`, {
      waitUntil: 'domcontentloaded',
    });

    expect(response?.status()).toBeLessThan(500);
    const headers = response?.headers() ?? {};
    expectCspDirectives(headers['content-security-policy'] ?? null, [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ]);
    expectAdminCspRuntimeFloor(headers['content-security-policy'] ?? '');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

    const html = await page.content();
    expect(html).not.toMatch(contentStudioSecretPattern);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const evaluated = await client.send('Runtime.evaluate', {
        expression: `({
          title: document.title,
          location: document.location.pathname,
          text: document.documentElement.innerText,
          scriptCount: document.scripts.length
        })`,
        returnByValue: true,
      });
      const value = evaluated.result.value as {
        title: string;
        location: string;
        text: string;
        scriptCount: number;
      };
      expect(value.location).toBe('/events/evt_security_headers/content/email');
      expect(value.text).not.toMatch(contentStudioSecretPattern);
      expect(value.scriptCount).toBeGreaterThan(0);
      await testInfo.attach('cdp-content-studio-security-snapshot', {
        body: JSON.stringify(
          { title: value.title, location: value.location, scriptCount: value.scriptCount },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      await client.detach();
    }
  });
});
