import { expect, test } from '@playwright/test';
import { apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { seedFreeCheckoutEvent } from './helpers/seed';

test.describe('full-stack smoke', () => {
  test('API health endpoint responds from the Playwright stack', async ({ request }) => {
    const response = await request.get(`${apiBaseUrl}/health`);
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  test('hosted checkout root renders without crashing', async ({ page }) => {
    await page.goto(checkoutBaseUrl);

    await expect(page).toHaveTitle(/Tixkit|Checkout|Ticket/i);
    await expect(page.getByText('No event selected')).toBeVisible();
  });

  test('hosted checkout accepts event query entry points', async ({ page }) => {
    await page.goto(`${checkoutBaseUrl}/checkout?eventId=evt_missing_smoke`);

    await expect(page.locator('body')).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\?eventId=evt_missing_smoke/);
  });

  test('hosted checkout completes a seeded public free order', async ({
    page,
    request,
  }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);

    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByText(ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByText(product.name, { exact: true })).toBeVisible();
    await expect(page.getByText('Free', { exact: true })).toBeVisible();

    await page
      .getByRole('button', { name: `Increase ${ticketType.name} quantity` })
      .click();
    await page
      .getByRole('button', { name: `Increase ${product.name} quantity` })
      .click();
    await page.getByLabel('Email').fill(`buyer+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Playwright');
    await page.getByLabel('Last name').fill('Buyer');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('button', { name: 'Edit order' })).toBeVisible();
    await expect(page.getByText(product.name, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Place free order' }),
    ).toBeVisible();
    await expect(page.getByText(/Session reserved until/)).toBeVisible();

    await page.getByRole('button', { name: 'Place free order' }).click();

    await expect(page).toHaveURL(/\/checkout\/confirmation\?/);
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    await expect(page.getByText('Confirmation email sent')).toBeVisible();
    await expect(page.getByText('Ticket delivery')).toBeVisible();
  });
});
