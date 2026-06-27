import { test, expect, requireReachable } from './fixtures/validation-test';
import { adminBaseUrl, checkoutBaseUrl } from './helpers/env';

function expectCspDirectives(header: string | null, directives: string[]): void {
  expect(header).toBeTruthy();
  const policy = header ?? '';
  for (const directive of directives) {
    expect(policy).toContain(directive);
  }
}

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
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
  });

  test('hosted checkout sends embeddable CSP for widget iframe usage', async ({ page }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const response = await page.request.get(`${checkoutBaseUrl}/checkout?eventId=evt_security_headers`, {
      failOnStatusCode: false,
    });

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
});
