import { createHmac } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { test, expect } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';

const NUXT_DEMO_URL = 'http://127.0.0.1:3312';
const ASTRO_DEMO_URL = 'http://127.0.0.1:3313';
const REMIX_DEMO_URL = 'http://127.0.0.1:3314';
const CHECKOUT_ORIGIN = 'http://localhost:3201';
const WEBHOOK_SECRET = 'whsec_demo_framework';
const REPO_ROOT = process.cwd();
const servers: ChildProcessWithoutNullStreams[] = [];

function startServer(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  servers.push(child);
  return child;
}

async function waitForHttp(url: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function tixkitSignature(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  startServer(
    'node',
    ['apps/sdk-nuxt-demo/.output/server/index.mjs'],
    REPO_ROOT,
    {
      PORT: '3312',
      NUXT_PUBLIC_TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );
  startServer(
    'node',
    ['apps/sdk-astro-demo/dist/server/entry.mjs'],
    REPO_ROOT,
    {
      PORT: '3313',
      HOST: '127.0.0.1',
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );
  startServer(
    'bunx',
    ['remix-serve', './build/server/index.js'],
    `${REPO_ROOT}/apps/sdk-remix-demo`,
    {
      PORT: '3314',
      TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );
  await Promise.all([waitForHttp(NUXT_DEMO_URL), waitForHttp(ASTRO_DEMO_URL), waitForHttp(REMIX_DEMO_URL)]);
});

test.afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server.exitCode !== null) {
            resolve();
            return;
          }
          server.once('exit', () => resolve());
          server.kill('SIGTERM');
          setTimeout(() => {
            if (server.exitCode === null) server.kill('SIGKILL');
            resolve();
          }, 2_000).unref();
        }),
    ),
  );
});

// Intercept the widget iframe's checkout request so it loads clean HTML
// instead of hitting the real checkout server (which has no evt_demo event),
// keeping the no-console gate green while still asserting the iframe src contract.
const widgetStubHtml =
  '<!DOCTYPE html><html lang="en"><head><title>Tixkit Ticket Widget</title></head><body><main><h1>Checkout</h1><div>checkout</div></main></body></html>';

async function attachConsoleAndRoute(page: import('@playwright/test').Page): Promise<void> {
  await page.route(`${CHECKOUT_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: widgetStubHtml }),
  );
}

test('Nuxt demo renders widget iframe, checkout handoff, lifecycle, and verifies webhook', async ({
  page,
  request,
}, testInfo) => {
  await attachConsoleAndRoute(page);
  await page.goto(NUXT_DEMO_URL);
  await expect(page.getByRole('heading', { name: 'Tixkit Nuxt Demo' })).toBeVisible();

  const widget = page.locator('iframe[title="Tixkit Ticket Widget"]');
  await expect(widget).toHaveAttribute('src', /eventId=evt_demo/);
  await expect(widget).toHaveAttribute('src', /brand=brd_demo/);

  await expect(page.getByTestId('checkout-handoff-url')).toContainText('eventId=evt_demo');
  await expect(page.getByTestId('checkout-handoff-url')).toContainText(CHECKOUT_ORIGIN);

  await page.evaluate((origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'order_completed', eventId: 'evt_demo', orderId: 'ord_demo' },
      }),
    );
  }, CHECKOUT_ORIGIN);
  await expect(page.getByLabel('Tixkit lifecycle events')).toContainText('order_completed');

  const body = JSON.stringify({ id: 'wevt_nuxt_demo', type: 'order.completed' });
  const response = await request.post(`${NUXT_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({ received: true, handledBy: 'sdk-nuxt-demo' });

  const badResponse = await request.post(`${NUXT_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-nuxt-demo', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Astro demo renders widget iframe, checkout handoff, lifecycle, and verifies webhook', async ({
  page,
  request,
}, testInfo) => {
  await attachConsoleAndRoute(page);
  await page.goto(ASTRO_DEMO_URL);
  await expect(page.getByRole('heading', { name: 'Tixkit Astro Demo' })).toBeVisible();

  const widget = page.locator('iframe[title="Tixkit Ticket Widget"]');
  await expect(widget).toHaveAttribute('src', /eventId=evt_demo/);
  await expect(widget).toHaveAttribute('src', /brand=brd_demo/);

  await expect(page.getByTestId('checkout-handoff-url')).toContainText('eventId=evt_demo');
  await expect(page.getByTestId('checkout-handoff-url')).toContainText(CHECKOUT_ORIGIN);

  await page.evaluate((origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'order_completed', eventId: 'evt_demo', orderId: 'ord_demo' },
      }),
    );
  }, CHECKOUT_ORIGIN);
  await expect(page.getByLabel('Tixkit lifecycle events')).toContainText('order_completed');

  const body = JSON.stringify({ id: 'wevt_astro_demo', type: 'order.completed' });
  const response = await request.post(`${ASTRO_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({ received: true, handledBy: 'sdk-astro-demo' });

  const badResponse = await request.post(`${ASTRO_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-astro-demo', { body: await page.screenshot(), contentType: 'image/png' });
});

test('Remix demo renders widget iframe, checkout handoff, lifecycle, and verifies webhook', async ({
  page,
  request,
}, testInfo) => {
  await attachConsoleAndRoute(page);
  await page.goto(REMIX_DEMO_URL);
  await expect(page.getByRole('heading', { name: 'Tixkit Remix Demo' })).toBeVisible();

  const widget = page.locator('iframe[title="Tixkit Ticket Widget"]');
  await expect(widget).toHaveAttribute('src', /eventId=evt_demo/);
  await expect(widget).toHaveAttribute('src', /brand=brd_demo/);

  await expect(page.getByTestId('checkout-handoff-url')).toContainText('eventId=evt_demo');
  await expect(page.getByTestId('checkout-handoff-url')).toContainText(CHECKOUT_ORIGIN);

  await page.evaluate((origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'order_completed', eventId: 'evt_demo', orderId: 'ord_demo' },
      }),
    );
  }, CHECKOUT_ORIGIN);
  await expect(page.getByLabel('Tixkit lifecycle events')).toContainText('order_completed');

  const body = JSON.stringify({ id: 'wevt_remix_demo', type: 'order.completed' });
  const response = await request.post(`${REMIX_DEMO_URL}/api/tixkit-webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({ received: true, handledBy: 'sdk-remix-demo' });

  const badResponse = await request.post(`${REMIX_DEMO_URL}/api/tixkit-webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-remix-demo', { body: await page.screenshot(), contentType: 'image/png' });
});
