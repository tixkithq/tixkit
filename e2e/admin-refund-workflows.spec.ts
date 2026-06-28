import { type Page, type Response as PlaywrightResponse, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { readRefundWorkflowState, seedPaidRefundableOrder } from './helpers/seed';

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectJsonStatus<T>(
  response: PlaywrightResponse | Awaited<ReturnType<Page['request']['get']>>,
  expectedStatus: number,
): Promise<T> {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body as T;
}

test.describe('admin refund workflow coverage', () => {
  test('admin can partially refund an order through the Temporal refund workflow', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000);
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedPaidRefundableOrder(request, suffix);

    await page.goto(`${adminBaseUrl}/orders/${seeded.order.id}`);
    await expect(page.getByRole('heading', { name: seeded.order.id })).toBeVisible();
    await expect(page.getByText(seeded.order.buyerEmail, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(seeded.ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByText('$100.00', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Refund' }).click();
    await expect(
      page.getByRole('heading', { name: `Refund order ${seeded.order.id}` }),
    ).toBeVisible();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Partial refund' }).click();
    await page.getByLabel('Amount (USD)').fill('50.00');
    await page
      .getByPlaceholder('Describe the refund reason (required)')
      .fill('E2E partial refund validation');
    await page.getByLabel('Restore inventory').click();

    const refundResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/v1/orders/${seeded.order.id}/refunds` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Refund $50.00' }).click();
    expect((await refundResponse).status()).toBe(202);

    await expect
      .poll(
        async () => {
          const state = await readRefundWorkflowState(
            seeded.order.id,
            seeded.inventoryPool.id,
            seeded.ticketIds,
          );
          return [
            state.order.status,
            state.order.refundedCents,
            state.refunds.length,
            state.refunds[0]?.amountCents ?? 0,
            state.tickets.filter((ticket) => ticket.status === 'void').length,
            state.inventoryPool.soldCount,
            state.timelineTypes.includes('ledger.refund'),
            state.timelineTypes.includes('tickets.voided'),
            state.emailJobs.length,
          ].join(':');
        },
        { timeout: 60_000 },
      )
      .toBe('partially_refunded:5000:1:5000:1:1:true:true:1');

    await page.reload();
    await expect(page.getByText('Partially Refunded', { exact: true })).toBeVisible();
    await expect(page.getByText('-$50.00', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('E2E partial refund validation', { exact: true })).toBeVisible();
    await expect(page.getByText('Refund Processed', { exact: true })).toBeVisible();

    await attachScreenshot(page, testInfo, 'admin-partial-refund-desktop');
    await expectNoAxeViolations(page, testInfo);

    const salesReport = await expectJsonStatus<{
      grossSalesCents: number;
      refundsCents: number;
      netRevenueCents: number;
      ticketsSold: number;
      paidOrdersCount: number;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${seeded.event.id}/reports/sales`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(salesReport).toMatchObject({
      grossSalesCents: 10_000,
      refundsCents: 5_000,
      netRevenueCents: 5_000,
      ticketsSold: 1,
      paidOrdersCount: 1,
    });

    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(page.getByText('Gross Sales')).toBeVisible();
    await expect(page.getByText('$100.00', { exact: true })).toBeVisible();
    await expect(page.getByText('Net Revenue')).toBeVisible();
    await expect(page.getByText('$50.00', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Refunds')).toBeVisible();
    await expect(page.getByText('1', { exact: true }).first()).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-partial-refund-report-desktop');
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin can fully refund an order through the Temporal refund workflow', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000);
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}-full`;
    const seeded = await seedPaidRefundableOrder(request, suffix);

    await page.goto(`${adminBaseUrl}/orders/${seeded.order.id}`);
    await expect(page.getByRole('heading', { name: seeded.order.id })).toBeVisible();
    await expect(page.getByText(seeded.order.buyerEmail, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(seeded.ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByText('$100.00', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Refund' }).click();
    await expect(
      page.getByRole('heading', { name: `Refund order ${seeded.order.id}` }),
    ).toBeVisible();
    await page
      .getByPlaceholder('Describe the refund reason (required)')
      .fill('E2E full refund validation');
    await page.getByLabel('Restore inventory').click();

    const refundResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/v1/orders/${seeded.order.id}/refunds` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Refund $100.00' }).click();
    expect((await refundResponse).status()).toBe(202);

    await expect
      .poll(
        async () => {
          const state = await readRefundWorkflowState(
            seeded.order.id,
            seeded.inventoryPool.id,
            seeded.ticketIds,
          );
          return [
            state.order.status,
            state.order.refundedCents,
            state.refunds.length,
            state.refunds[0]?.amountCents ?? 0,
            state.tickets.filter((ticket) => ticket.status === 'void').length,
            state.inventoryPool.soldCount,
            state.timelineTypes.includes('ledger.refund'),
            state.timelineTypes.includes('tickets.voided'),
            state.emailJobs.length,
          ].join(':');
        },
        { timeout: 60_000 },
      )
      .toBe('refunded:10000:1:10000:2:0:true:true:1');

    await page.reload();
    await expect(page.getByText('Refunded', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('-$100.00', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('E2E full refund validation', { exact: true })).toBeVisible();
    await expect(page.getByText('Refund Processed', { exact: true })).toBeVisible();

    await attachScreenshot(page, testInfo, 'admin-full-refund-desktop');
    await expectNoAxeViolations(page, testInfo);
  });
});
