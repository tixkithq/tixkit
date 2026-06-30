import { createHmac } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { test, expect } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';

let nuxtDemoUrl = 'http://127.0.0.1:3312';
let astroDemoUrl = 'http://127.0.0.1:3313';
let remixDemoUrl = 'http://127.0.0.1:3314';
const CHECKOUT_ORIGIN = 'http://localhost:3201';
const WEBHOOK_SECRET = 'whsec_demo_framework';
const REPO_ROOT = process.cwd();
const servers: Array<{ child: ChildProcessWithoutNullStreams; label: string; logs: string[] }> = [];

function startServer(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'pipe',
  });
  const server = { child, label, logs: [] };
  child.stdout.on('data', (chunk: Buffer) => {
    server.logs.push(chunk.toString());
    if (server.logs.length > 50) server.logs.splice(0, server.logs.length - 50);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    server.logs.push(chunk.toString());
    if (server.logs.length > 50) server.logs.splice(0, server.logs.length - 50);
  });
  servers.push(server);
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a loopback port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHttp(url: string, serverLabel: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const server = servers.find((entry) => entry.label === serverLabel);
    if (server?.child.exitCode !== null && server.child.exitCode !== 0) {
      throw new Error(
        `${serverLabel} exited with code ${server.child.exitCode} before ${url} became healthy:\n${server.logs.join('')}`,
      );
    }
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

function stopFrameworkDevServers(): void {
  for (const [pkg, args] of [
    ['@tixkit/sdk-astro-demo', ['dev', 'stop']],
    ['@tixkit/sdk-nuxt-demo', ['clean']],
  ] as const) {
    try {
      execFileSync('bun', ['run', '--filter', pkg, ...args], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
    } catch {
      // Best-effort cleanup for framework dev daemons left behind by retries.
    }
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  stopFrameworkDevServers();
  const [nuxtPort, astroPort, remixPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePort(),
  ]);
  nuxtDemoUrl = `http://127.0.0.1:${nuxtPort}`;
  astroDemoUrl = `http://127.0.0.1:${astroPort}`;
  remixDemoUrl = `http://127.0.0.1:${remixPort}`;

  startServer(
    'sdk-nuxt-demo',
    'bun',
    [
      'run',
      '--filter',
      '@tixkit/sdk-nuxt-demo',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(nuxtPort),
    ],
    REPO_ROOT,
    {
      NUXT_PUBLIC_TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
      NUXT_IGNORE_LOCK: '1',
      PORT: String(nuxtPort),
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );

  startServer(
    'sdk-astro-demo',
    'bun',
    [
      'run',
      '--filter',
      '@tixkit/sdk-astro-demo',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(astroPort),
    ],
    REPO_ROOT,
    {
      PUBLIC_TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
      PORT: String(astroPort),
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );

  startServer(
    'sdk-remix-demo',
    'bun',
    [
      'run',
      '--filter',
      '@tixkit/sdk-remix-demo',
      'dev',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(remixPort),
    ],
    REPO_ROOT,
    {
      PORT: String(remixPort),
      TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  );
  await Promise.all([
    waitForHttp(nuxtDemoUrl, 'sdk-nuxt-demo'),
    waitForHttp(astroDemoUrl, 'sdk-astro-demo'),
    waitForHttp(remixDemoUrl, 'sdk-remix-demo'),
  ]);
});

test.afterAll(async () => {
  await Promise.all(
    servers.map(
      ({ child }) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM');
            else child.kill('SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
          setTimeout(() => {
            if (child.exitCode === null) {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
            }
            resolve();
          }, 2_000).unref();
        }),
    ),
  );
  stopFrameworkDevServers();
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
  await page.goto(nuxtDemoUrl);
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
  const response = await request.post(`${nuxtDemoUrl}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({ received: true, handledBy: 'sdk-nuxt-demo' });

  const badResponse = await request.post(`${nuxtDemoUrl}/api/tixkit/webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-nuxt-demo', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('Astro demo renders widget iframe, checkout handoff, lifecycle, and verifies webhook', async ({
  page,
  request,
}, testInfo) => {
  await attachConsoleAndRoute(page);
  await page.goto(astroDemoUrl);
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
  const response = await request.post(`${astroDemoUrl}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({
    received: true,
    handledBy: 'sdk-astro-demo',
  });

  const badResponse = await request.post(`${astroDemoUrl}/api/tixkit/webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-astro-demo', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('Remix demo renders widget iframe, checkout handoff, lifecycle, and verifies webhook', async ({
  page,
  request,
}, testInfo) => {
  await attachConsoleAndRoute(page);
  await page.goto(remixDemoUrl);
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
  const response = await request.post(`${remixDemoUrl}/api/tixkit-webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'tixkit-signature': tixkitSignature(body, WEBHOOK_SECRET),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({
    received: true,
    handledBy: 'sdk-remix-demo',
  });

  const badResponse = await request.post(`${remixDemoUrl}/api/tixkit-webhook`, {
    data: body,
    headers: { 'content-type': 'application/json', 'tixkit-signature': 't=1,v1=bad' },
  });
  expect(badResponse.status()).toBe(401);

  await expectNoAxeViolations(page, testInfo, 'body', ['iframe#tixkit-widget-demo']);
  await testInfo.attach('sdk-remix-demo', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
