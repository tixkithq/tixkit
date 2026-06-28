import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { checkoutBaseUrl, checkoutEventId, widgetBundlePath } from './helpers/env';
import { seedFreeCheckoutEvent } from './helpers/seed';
import { expectNoAxeViolations } from './helpers/axe';

async function checkoutEventForTest(
  request: Parameters<typeof seedFreeCheckoutEvent>[0],
  suffix: string,
): Promise<string> {
  if (checkoutEventId) return checkoutEventId;
  const { event } = await seedFreeCheckoutEvent(request, suffix);
  return event.id;
}

function widgetHostBaseUrl(): string {
  const checkoutUrl = new URL(checkoutBaseUrl);
  const port = checkoutUrl.port ? `:${checkoutUrl.port}` : '';
  if (checkoutUrl.hostname === 'localhost') {
    return `${checkoutUrl.protocol}//127.0.0.1${port}`;
  }
  return checkoutBaseUrl;
}

function widgetReportingApiUrl(): string {
  return widgetHostBaseUrl();
}

async function loadWidgetHostPage(page: Page, path: string, body: string): Promise<void> {
  const url = `${widgetHostBaseUrl()}${path}`;
  await page.route(`${widgetHostBaseUrl()}/v1/public/events/**/widget-impressions`, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ tracked: true, deduped: false }),
    }),
  );
  await page.route(`${widgetHostBaseUrl()}/v1/public/events/**/marketing-integrations`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body,
    }),
  );
  await page.goto(url);
}

test.describe('checkout and widget console gates', () => {
  test('hosted checkout event page renders without console errors', async ({
    page,
    request,
  }, testInfo) => {
    const eventId = await checkoutEventForTest(
      request,
      `console-event-${testInfo.workerIndex}-${Date.now()}`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(eventId)}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await testInfo.attach('checkout-event-page', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('hosted checkout entry renders without console errors', async ({
    page,
    request,
  }, testInfo) => {
    const eventId = await checkoutEventForTest(
      request,
      `console-entry-${testInfo.workerIndex}-${Date.now()}`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${encodeURIComponent(eventId)}`);
    await expect(page.getByRole('heading').first()).toBeVisible();

    await testInfo.attach('checkout-entry', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('embedded widget shell mounts without console errors', async ({
    page,
    request,
  }, testInfo) => {
    const eventId = await checkoutEventForTest(
      request,
      `console-widget-${testInfo.workerIndex}-${Date.now()}`,
    );
    test.skip(
      !fs.existsSync(widgetBundlePath),
      `Widget bundle not found at ${widgetBundlePath}; run bun --filter @tixkit/widget build.`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await loadWidgetHostPage(
      page,
      '/__e2e_widget_shell',
      `
      <!doctype html>
      <html lang="en">
        <head>
          <title>Tixkit widget validation</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <main>
            <h1>Widget validation</h1>
            <tixkit-widget
              api-base-url="${checkoutBaseUrl}"
              reporting-api-url="${widgetReportingApiUrl()}"
              brand="brd_dev_local"
              event="${eventId}"
              checkout-mode="modal"
            ></tixkit-widget>
          </main>
        </body>
      </html>
    `,
    );

    await page.addScriptTag({ path: widgetBundlePath, type: 'module' });
    await page.waitForFunction(() => customElements.get('tixkit-widget'));
    await expect(page.locator('tixkit-widget')).toBeVisible();

    await testInfo.attach('widget-shell', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

  test('embedded widget lifecycle modes dispatch browser events without console errors', async ({
    page,
    request,
  }, testInfo) => {
    const eventId = await checkoutEventForTest(
      request,
      `widget-lifecycle-${testInfo.workerIndex}-${Date.now()}`,
    );
    test.skip(
      !fs.existsSync(widgetBundlePath),
      `Widget bundle not found at ${widgetBundlePath}; run bun --filter @tixkit/widget build.`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await loadWidgetHostPage(
      page,
      '/__e2e_widget_lifecycle',
      `
      <!doctype html>
      <html lang="en">
        <head>
          <title>Tixkit widget lifecycle validation</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <main>
            <h1>Widget lifecycle validation</h1>
            <tixkit-widget
              id="inline-widget"
              api-base-url="${checkoutBaseUrl}"
              reporting-api-url="${widgetReportingApiUrl()}"
              brand="brd_dev_local"
              event="${eventId}"
              checkout-mode="inline"
            ></tixkit-widget>
            <tixkit-widget
              id="modal-widget"
              api-base-url="${checkoutBaseUrl}"
              reporting-api-url="${widgetReportingApiUrl()}"
              brand="brd_dev_local"
              event="${eventId}"
              checkout-mode="modal"
            ></tixkit-widget>
            <tixkit-widget
              id="redirect-widget"
              api-base-url="${checkoutBaseUrl}"
              reporting-api-url="${widgetReportingApiUrl()}"
              brand="brd_dev_local"
              event="${eventId}"
              checkout-mode="redirect"
            ></tixkit-widget>
            <tixkit-button
              id="modal-button"
              api-base-url="${checkoutBaseUrl}"
              reporting-api-url="${widgetReportingApiUrl()}"
              brand="brd_dev_local"
              event="${eventId}"
              checkout-mode="modal"
              items="tt_demo=1"
              tracking-id="e2e-widget"
            >Buy with button</tixkit-button>
          </main>
        </body>
      </html>
    `,
    );

    await page.evaluate(() => {
      const lifecycleEvents = [
        'loaded',
        'loading',
        'opened',
        'closed',
        'checkout_started',
        'order_completed',
        'error',
      ];
      (
        window as unknown as {
          __gkWidgetEvents: Array<{ id: string; type: string; detail: unknown }>;
        }
      ).__gkWidgetEvents = [];
      (window as unknown as { __gkOpenedUrls: unknown[] }).__gkOpenedUrls = [];
      window.open = ((...args: unknown[]) => {
        (window as unknown as { __gkOpenedUrls: unknown[] }).__gkOpenedUrls.push(args);
        return null;
      }) as typeof window.open;
      for (const element of document.querySelectorAll('tixkit-widget, tixkit-button')) {
        for (const type of lifecycleEvents) {
          element.addEventListener(type, (event) => {
            (
              window as unknown as {
                __gkWidgetEvents: Array<{ id: string; type: string; detail: unknown }>;
              }
            ).__gkWidgetEvents.push({
              id: element.id,
              type,
              detail: event instanceof CustomEvent ? event.detail : null,
            });
          });
        }
      }
    });

    await page.addScriptTag({ path: widgetBundlePath, type: 'module' });
    await page.waitForFunction(
      () => customElements.get('tixkit-widget') && customElements.get('tixkit-button'),
    );

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents
            .filter((event) => event.type === 'loaded')
            .map((event) => event.id)
            .sort(),
        ),
      )
      .toEqual(['inline-widget', 'modal-button', 'modal-widget', 'redirect-widget']);

    const inlineFrame = await page.evaluate(() => {
      const iframe = document
        .querySelector<HTMLElement>('#inline-widget')
        ?.shadowRoot?.querySelector('iframe');
      return {
        src: iframe?.getAttribute('src') ?? '',
        sandbox: iframe?.getAttribute('sandbox') ?? '',
        allow: iframe?.getAttribute('allow') ?? '',
      };
    });
    expect(inlineFrame.src).toContain('/checkout?');
    expect(inlineFrame.src).toContain(`eventId=${encodeURIComponent(eventId)}`);
    expect(inlineFrame.sandbox).toContain('allow-scripts');
    expect(inlineFrame.sandbox).toContain('allow-forms');
    expect(inlineFrame.allow).toContain('payment');
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents.some(
            (event) => event.id === 'inline-widget' && event.type === 'loading',
          ),
        ),
      )
      .toBe(true);

    await page.evaluate(
      ({ eventIdForMessage, checkoutOrigin }) => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: checkoutOrigin,
            data: {
              source: 'tixkit-checkout',
              event: 'checkout_started',
              eventId: eventIdForMessage,
              sessionId: 'cs_widget_e2e',
            },
          }),
        );
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: checkoutOrigin,
            data: {
              source: 'tixkit-checkout',
              event: 'order_completed',
              eventId: eventIdForMessage,
              sessionId: 'cs_widget_e2e',
              orderId: 'ord_widget_e2e',
            },
          }),
        );
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://evil.example.com',
            data: {
              source: 'tixkit-checkout',
              event: 'checkout_started',
              eventId: eventIdForMessage,
              sessionId: 'cs_evil',
            },
          }),
        );
      },
      { eventIdForMessage: eventId, checkoutOrigin: new URL(checkoutBaseUrl).origin },
    );

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __gkWidgetEvents: Array<{ id: string; type: string; detail: Record<string, string> }>;
            }
          ).__gkWidgetEvents
            .filter(
              (event) =>
                event.id === 'inline-widget' &&
                (event.type === 'checkout_started' || event.type === 'order_completed'),
            )
            .map((event) => ({
              type: event.type,
              sessionId: event.detail.sessionId,
              orderId: event.detail.orderId,
            })),
        ),
      )
      .toEqual([
        { type: 'checkout_started', sessionId: 'cs_widget_e2e', orderId: undefined },
        { type: 'order_completed', sessionId: 'cs_widget_e2e', orderId: 'ord_widget_e2e' },
      ]);
    const evilSessionCount = await page.evaluate(
      () =>
        (
          window as unknown as { __gkWidgetEvents: Array<{ detail: Record<string, string> }> }
        ).__gkWidgetEvents.filter((event) => event.detail?.sessionId === 'cs_evil').length,
    );
    expect(evilSessionCount).toBe(0);

    await page.evaluate(() => {
      const modalWidget = document.querySelector<HTMLElement>('#modal-widget');
      modalWidget?.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click();
    });
    await expect
      .poll(async () =>
        page.evaluate(() =>
          Boolean(
            document
              .querySelector<HTMLElement>('#modal-widget')
              ?.shadowRoot?.querySelector('iframe.tk-modal-frame'),
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents.some(
            (event) => event.id === 'modal-widget' && event.type === 'opened',
          ),
        ),
      )
      .toBe(true);
    await expectNoAxeViolations(
      page,
      testInfo,
      'body',
      ['iframe'],
      ['landmark-unique', 'landmark-one-main', 'page-has-heading-one'],
    );
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('#modal-widget')
        ?.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-modal-close')
        ?.click();
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const events = (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents
            .filter(
              (event) =>
                event.id === 'modal-widget' && (event.type === 'opened' || event.type === 'closed'),
            )
            .map((event) => event.type);
          return events.includes('opened') && events.at(-1) === 'closed';
        }),
      )
      .toBe(true);

    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('#redirect-widget')
        ?.shadowRoot?.querySelector<HTMLButtonElement>('button')
        ?.click();
    });
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __gkOpenedUrls: unknown[] }).__gkOpenedUrls.length,
        ),
      )
      .toBe(1);

    await page.evaluate(() => {
      const modalButton = document.querySelector<HTMLElement>('#modal-button');
      modalButton?.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click();
    });
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents.some(
            (event) => event.id === 'modal-button' && event.type === 'opened',
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>('#modal-button')
        ?.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-modal-close')
        ?.click();
    });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const events = (
            window as unknown as { __gkWidgetEvents: Array<{ id: string; type: string }> }
          ).__gkWidgetEvents
            .filter(
              (event) =>
                event.id === 'modal-button' && (event.type === 'opened' || event.type === 'closed'),
            )
            .map((event) => event.type);
          return events.includes('opened') && events.at(-1) === 'closed';
        }),
      )
      .toBe(true);

    await testInfo.attach('widget-lifecycle', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
});
