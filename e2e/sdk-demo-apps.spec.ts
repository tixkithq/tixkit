import { createHmac } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, test } from '@playwright/test';

const NEXT_DEMO_URL = 'http://127.0.0.1:3310';
const SVELTEKIT_DEMO_URL = 'http://127.0.0.1:3311';
const CHECKOUT_ORIGIN = 'http://localhost:3201';
const WEBHOOK_SECRET = 'whsec_demo';
const servers: ChildProcessWithoutNullStreams[] = [];

function startServer(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      TIXKIT_WEBHOOK_SECRET: WEBHOOK_SECRET,
      NEXT_PUBLIC_TIXKIT_CHECKOUT_URL: CHECKOUT_ORIGIN,
    },
    stdio: 'pipe',
  });
  servers.push(child);
  return child;
}

async function waitForHttp(url: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function tixkitSignature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test.beforeAll(async () => {
  startServer(
    'bun',
    ['run', '--filter', '@tixkit/sdk-next-demo', 'start', '--', '-p', '3310'],
    process.cwd(),
  );
  startServer(
    'bun',
    [
      'run',
      '--filter',
      '@tixkit/sdk-sveltekit-demo',
      'preview',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      '3311',
    ],
    process.cwd(),
  );
  await Promise.all([waitForHttp(NEXT_DEMO_URL), waitForHttp(SVELTEKIT_DEMO_URL)]);
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

test('external Next.js demo renders SDK widgets and handles webhook route', async ({
  page,
  request,
}) => {
  await page.goto(NEXT_DEMO_URL);
  await expect(page.getByRole('heading', { name: 'Tixkit Next SDK Demo' })).toBeVisible();
  const widget = page.locator('iframe[title="Tixkit Ticket Widget"]');
  await expect(widget).toHaveAttribute('src', /eventId=evt_demo_next/);

  await page.evaluate((origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: {
          source: 'tixkit-checkout',
          event: 'order_completed',
          eventId: 'evt_demo_next',
          orderId: 'ord_demo',
        },
      }),
    );
  }, CHECKOUT_ORIGIN);
  await expect(page.getByLabel('Tixkit lifecycle events')).toContainText('order_completed');

  const body = JSON.stringify({ id: 'wevt_next_demo', type: 'order.completed' });
  const response = await request.post(`${NEXT_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-tixkit-signature': tixkitSignature(body),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({ received: true, handledBy: 'sdk-next-demo' });
});

test('external SvelteKit demo renders SDK widget component and handles webhook route', async ({
  page,
  request,
}) => {
  await page.goto(SVELTEKIT_DEMO_URL);
  await expect(page.getByRole('heading', { name: 'Tixkit SvelteKit SDK Demo' })).toBeVisible();
  const widget = page.locator('iframe[title="Tixkit checkout"]');
  await expect(widget).toHaveAttribute('src', /eventId=evt_demo_sveltekit/);

  await page.evaluate((origin) => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: {
          type: 'order_completed',
          eventId: 'evt_demo_sveltekit',
          orderId: 'ord_demo',
        },
      }),
    );
  }, CHECKOUT_ORIGIN);
  await expect(page.getByLabel('Tixkit lifecycle events')).toContainText('order_completed');

  const body = JSON.stringify({ id: 'wevt_sveltekit_demo', type: 'order.completed' });
  const response = await request.post(`${SVELTEKIT_DEMO_URL}/api/tixkit/webhook`, {
    data: body,
    headers: {
      'content-type': 'application/json',
      'x-tixkit-signature': tixkitSignature(body),
    },
  });
  await expect(response).toBeOK();
  await expect(await response.json()).toMatchObject({
    received: true,
    handledBy: 'sdk-sveltekit-demo',
  });
});
