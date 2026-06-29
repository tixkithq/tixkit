import { type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { seedPaidCheckoutEvent } from './helpers/seed';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function fillDoorOrderForm(
  page: Page,
  tender: 'cash' | 'manual_card' | 'comp',
): Promise<void> {
  await page.getByLabel('Tender', { exact: true }).selectOption(tender);
  await page.getByLabel('Buyer first name').fill('Box');
  await page.getByLabel('Buyer last name').fill('Office');
  await page.getByLabel('Buyer email').fill(`box-office-${tender}@example.com`);
  await page.getByLabel('Attendee 1 first name').fill('Door');
  await page.getByLabel('Attendee 1 last name').fill('Guest');
  await page.getByLabel('Attendee 1 email').fill(`door-${tender}@example.com`);
  if (tender !== 'comp') {
    await page.getByLabel('Tender amount', { exact: true }).fill('25.00');
  }
  await page.getByLabel('Operator notes').fill(`E2E ${tender} door sale`);
}

test.describe('admin box-office POS workflows', () => {
  test('operator creates a manual-card door order across the browser matrix', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `box-office-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedPaidCheckoutEvent(request, suffix);

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Ticket Types' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sell at door' })).toBeVisible();
    await expect(page.getByText('Expected total')).toBeVisible();

    await fillDoorOrderForm(page, 'manual_card');
    const orderResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/v1/events/${event.id}/box-office/orders` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Issue door order' }).click();
    const orderResponse = await orderResponsePromise;
    const orderBody = await orderResponse.json();
    expect(orderResponse.status(), JSON.stringify(orderBody, null, 2)).toBe(201);
    expect(orderBody.order.salesChannel).toBe('box_office');
    expect(orderBody.order.tenderType).toBe('manual_card');
    expect(orderBody.order.totalCents).toBe(2500);

    const issuedOrderAlert = page.getByRole('alert').filter({ hasText: 'Order issued' });
    await expect(issuedOrderAlert).toBeVisible();
    await expect(issuedOrderAlert.getByText(`Order: ${orderBody.order.id}`)).toBeVisible();
    await expect(issuedOrderAlert.getByRole('link', { name: 'Open order' })).toHaveAttribute(
      'href',
      `/orders/${orderBody.order.id}`,
    );
    await expect(issuedOrderAlert.getByRole('button', { name: 'Print receipt' })).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await attachScreenshot(page, testInfo, 'admin-box-office-door-order-desktop');

    const orders = await request.get(`${apiBaseUrl}/v1/orders?eventId=${event.id}`, {
      failOnStatusCode: false,
    });
    const ordersBody = await orders.json();
    expect(orders.status(), JSON.stringify(ordersBody, null, 2)).toBe(200);
    expect(
      ordersBody.items.some(
        (order: { id: string; salesChannel?: string; tenderType?: string }) =>
          order.id === orderBody.order.id &&
          order.salesChannel === 'box_office' &&
          order.tenderType === 'manual_card',
      ),
    ).toBe(true);

    await page.setViewportSize(mobileViewport);
    await expect(page.getByRole('heading', { name: 'Sell at door' })).toBeVisible();
    await expect(issuedOrderAlert.getByText(`Order: ${orderBody.order.id}`)).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await attachScreenshot(page, testInfo, 'admin-box-office-door-order-mobile');
  });

  test('Sell at door panel exposes Chromium CDP layout metrics after issue', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `box-office-cdp-${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedPaidCheckoutEvent(request, suffix);

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Sell at door' })).toBeVisible();
    await fillDoorOrderForm(page, 'cash');
    await page.getByRole('button', { name: 'Issue door order' }).click();
    await expect(page.getByRole('alert').getByText('Order issued', { exact: true })).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await attachScreenshot(page, testInfo, 'admin-box-office-cdp');

    const client = await page.context().newCDPSession(page);
    const evaluation = await client.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const heading = Array.from(document.querySelectorAll('h2'))
          .find((node) => node.textContent?.trim() === 'Sell at door');
        const panel = heading?.closest('[data-slot="card"]') ?? heading?.closest('.rounded-xl, .rounded-lg, form') ?? null;
        const result = Array.from(document.querySelectorAll('[role="alert"]'))
          .find((node) => node.textContent?.includes('Order issued')) ?? null;
        const submit = Array.from(document.querySelectorAll('button'))
          .find((node) => node.textContent?.includes('Issue door order')) ?? null;
        const tender = document.querySelector('#box-office-tender');
        const amount = document.querySelector('#box-office-amount');
        const metric = (node) => {
          const rect = node?.getBoundingClientRect();
          return rect ? {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
            visible: rect.width > 0 && rect.height > 0,
          } : null;
        };
        return {
          panel: metric(panel),
          result: metric(result),
          submit: metric(submit),
          tender: metric(tender),
          amount: metric(amount),
        };
      })()`,
    });
    const metrics = evaluation.result.value as Record<
      string,
      { width: number; height: number; top: number; left: number; visible: boolean } | null
    >;

    for (const key of ['panel', 'result', 'submit', 'tender', 'amount'] as const) {
      expect(metrics[key], key).toMatchObject({
        width: expect.any(Number),
        height: expect.any(Number),
        visible: true,
      });
    }
    expect(metrics.panel?.width).toBeGreaterThan(320);
    expect(metrics.panel?.height).toBeGreaterThan(360);
    expect(metrics.result?.height).toBeGreaterThan(40);
    expect(metrics.submit?.width).toBeGreaterThan(120);
    expect(metrics.tender?.height).toBeGreaterThan(28);
    expect(metrics.amount?.height).toBeGreaterThan(28);
  });

  test('operator issues a comp order and prints the receipt artifact', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `box-office-print-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedPaidCheckoutEvent(request, suffix);

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/tickets`);
    await expect(page.getByRole('heading', { name: 'Sell at door' })).toBeVisible();
    await fillDoorOrderForm(page, 'comp');

    const orderResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/v1/events/${event.id}/box-office/orders` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Issue door order' }).click();
    const orderResponse = await orderResponsePromise;
    const orderBody = await orderResponse.json();
    expect(orderResponse.status(), JSON.stringify(orderBody, null, 2)).toBe(201);
    expect(orderBody.order.salesChannel).toBe('box_office');
    expect(orderBody.order.tenderType).toBe('comp');
    expect(orderBody.order.totalCents).toBe(0);

    const issuedOrderAlert = page.getByRole('alert').filter({ hasText: 'Order issued' });
    await expect(issuedOrderAlert).toBeVisible();
    await expect(issuedOrderAlert.getByText(`Order: ${orderBody.order.id}`)).toBeVisible();
    await expectNoAxeViolations(page, testInfo);

    await page.evaluate(() => {
      window.print = () => {
        document.documentElement.setAttribute('data-print-receipt-invoked', 'true');
      };
    });
    await issuedOrderAlert.getByRole('button', { name: 'Print receipt' }).click();
    await expect(page.locator('html[data-print-receipt-invoked="true"]')).toHaveCount(1);
    await attachScreenshot(page, testInfo, 'admin-box-office-print-receipt');
  });
});
