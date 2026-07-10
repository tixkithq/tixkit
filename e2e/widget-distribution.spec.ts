import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const artifactDirectory = resolve(process.cwd(), 'artifacts/widget');
const manifest = JSON.parse(readFileSync(resolve(artifactDirectory, 'manifest.json'), 'utf8')) as {
  files: { widget: { path: string; integrity: string } };
};
const widgetBytes = readFileSync(resolve(artifactDirectory, manifest.files.widget.path));

test.describe('immutable widget distribution', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://cdn.example.test/widget.js', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        headers: {
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=31536000, immutable',
        },
        body: widgetBytes,
      });
    });
  });

  test('loads the immutable artifact with manifest SRI', async ({ page }) => {
    await page.setContent(
      `<script type="module" crossorigin="anonymous" integrity="${manifest.files.widget.integrity}" src="https://cdn.example.test/widget.js"></script>`,
    );
    await expect
      .poll(() => page.evaluate(() => Boolean(customElements.get('tixkit-widget'))))
      .toBe(true);
  });

  test('rejects a mismatched artifact hash', async ({ page }) => {
    await page.setContent(
      '<script type="module" crossorigin="anonymous" integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" src="https://cdn.example.test/widget.js"></script>',
    );
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => Boolean(customElements.get('tixkit-widget')))).toBe(false);
  });

  test('renders under a strict host CSP without unsafe-inline or broad HTTPS', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().toLowerCase().includes('content security'))
        violations.push(message.text());
    });
    await page.route('https://merchant.example.test/', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: {
          'content-security-policy':
            "default-src 'self'; script-src https://cdn.example.test; style-src 'self'; frame-src https://checkout.example.test; connect-src 'self' https://api.example.test; object-src 'none'; base-uri 'self'",
        },
        body: `<!doctype html><html lang="en"><head><title>Tickets</title><script type="module" crossorigin="anonymous" integrity="${manifest.files.widget.integrity}" src="https://cdn.example.test/widget.js"></script></head><body><main><h1>Tickets</h1><tixkit-button brand="brd_demo" event="evt_demo" checkout-mode="redirect" api-base-url="https://checkout.example.test" host-origin="https://merchant.example.test">Buy tickets</tixkit-button></main></body></html>`,
      });
    });
    await page.goto('https://merchant.example.test/');
    const launcher = page.locator('tixkit-button').locator('button');
    await expect(launcher).toHaveText('Buy tickets');
    await expect(launcher).toHaveCSS('cursor', 'pointer');
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    expect(violations).toEqual([]);
  });

  test('leaves a usable hosted link when JavaScript cannot load', async ({ page }) => {
    await page.setContent(
      '<tixkit-widget><a href="https://checkout.example.test/checkout?eventId=evt_demo">Continue to secure checkout</a></tixkit-widget>',
    );
    const fallback = page.getByRole('link', { name: 'Continue to secure checkout' });
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveAttribute('href', /eventId=evt_demo/);
  });

  test('announces modal handshake failure, restores focus, and offers recovery', async ({
    page,
  }) => {
    await page.clock.install();
    await page.route('https://merchant.example.test/', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<script type="module" crossorigin="anonymous" integrity="${manifest.files.widget.integrity}" src="https://cdn.example.test/widget.js"></script><tixkit-widget brand="brd_demo" event="evt_demo" checkout-mode="modal" api-base-url="https://checkout.example.test" host-origin="https://merchant.example.test"><a href="https://checkout.example.test/checkout?eventId=evt_demo">Continue to secure checkout</a></tixkit-widget>`,
      });
    });
    await page.route('https://checkout.example.test/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>Checkout unavailable</title>',
      }),
    );
    await page.goto('https://merchant.example.test/');
    const widget = page.locator('tixkit-widget');
    await widget.locator('button', { hasText: 'Buy tickets' }).click();
    await expect(widget.locator('iframe')).toBeVisible();
    await page.clock.fastForward(10_000);
    await expect(widget.locator('[role="alert"]')).toContainText('secure handshake');
    await expect(widget.locator('a', { hasText: 'Open secure checkout' })).toBeVisible();
    await expect(widget.locator('button', { hasText: 'Retry' })).toBeFocused();
  });

  test('focuses button retry after a failed checkout frame', async ({ page }) => {
    await page.clock.install();
    await page.route('https://merchant.example.test/', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<script type="module" crossorigin="anonymous" integrity="${manifest.files.widget.integrity}" src="https://cdn.example.test/widget.js"></script><tixkit-button brand="brd_demo" event="evt_demo" api-base-url="https://checkout.example.test" host-origin="https://merchant.example.test">Buy tickets</tixkit-button>`,
      });
    });
    await page.route('https://checkout.example.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Unavailable</title>' }),
    );
    await page.goto('https://merchant.example.test/');
    const button = page.locator('tixkit-button');
    await button.locator('button.tk-launcher').click();
    await expect(button.locator('iframe')).toBeVisible();
    await page.clock.fastForward(10_000);
    await expect(button.locator('[role="alert"]')).toContainText('secure handshake');
    await expect(button.locator('button', { hasText: 'Retry checkout' })).toBeFocused();
  });
});
