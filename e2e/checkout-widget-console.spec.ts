import fs from 'node:fs';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { checkoutBaseUrl, checkoutEventId, widgetBundlePath } from './helpers/env';

test.describe('checkout and widget console gates', () => {
  test('hosted checkout event page renders without console errors', async ({ page }, testInfo) => {
    test.skip(!checkoutEventId, 'Set E2E_CHECKOUT_EVENT_ID to a published seeded event id.');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(checkoutEventId)}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await testInfo.attach('checkout-event-page', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('hosted checkout entry renders without console errors', async ({ page }, testInfo) => {
    test.skip(!checkoutEventId, 'Set E2E_CHECKOUT_EVENT_ID to a published seeded event id.');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${encodeURIComponent(checkoutEventId)}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await testInfo.attach('checkout-entry', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('embedded widget shell mounts without console errors', async ({ page }, testInfo) => {
    test.skip(!checkoutEventId, 'Set E2E_CHECKOUT_EVENT_ID to a published seeded event id.');
    test.skip(!fs.existsSync(widgetBundlePath), `Widget bundle not found at ${widgetBundlePath}; run bun --filter @gatekit/widget build.`);
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.setContent(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>GateKit widget validation</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <main>
            <h1>Widget validation</h1>
            <gatekit-widget
              api-base-url="${checkoutBaseUrl}"
              event="${checkoutEventId}"
              checkout-mode="modal"
            ></gatekit-widget>
          </main>
        </body>
      </html>
    `);

    await page.addScriptTag({ path: widgetBundlePath, type: 'module' });
    await page.waitForFunction(() => customElements.get('gatekit-widget'));
    await expect(page.locator('gatekit-widget')).toBeVisible();

    await testInfo.attach('widget-shell', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
});
