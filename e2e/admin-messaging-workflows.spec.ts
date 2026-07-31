import { type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  seedFreeCheckoutEvent,
  seedMessageConsentForEmail,
  seedMessagingPrerequisites,
} from './helpers/seed';

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function completeSeededFreeCheckout(
  page: Page,
  eventId: string,
  eventTitle: string,
  ticketName: string,
  productName: string,
  buyerEmail: string,
): Promise<void> {
  await page.goto(`${checkoutBaseUrl}/checkout?eventId=${eventId}`);

  await expect(page.getByRole('heading', { name: eventTitle })).toBeVisible();
  await page.getByRole('button', { name: `Increase ${ticketName} quantity` }).click();
  await page.getByRole('button', { name: `Increase ${productName} quantity` }).click();
  await page.getByLabel('Email').fill(buyerEmail);
  await page.getByLabel('First name').fill('Message');
  await page.getByLabel('Last name').fill('Buyer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Place free order' })).toBeVisible();
  await page.getByRole('button', { name: 'Place free order' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
}

test.describe('admin messaging workflow coverage', () => {
  test('global messages opens a searchable lifecycle library with direct editor access', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `lifecycle-${testInfo.workerIndex}-${Date.now()}`;
    const { event } = await seedFreeCheckoutEvent(request, suffix);
    await page.goto(
      `${adminBaseUrl}/messages?tab=lifecycle&eventId=${event.id}&templateKey=tickets-issued`,
    );

    await expect(page.getByRole('tab', { name: 'Lifecycle emails' })).toHaveAttribute(
      'data-state',
      'active',
    );
    await expect(page.getByRole('button', { name: `Event: ${event.title}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tickets issued' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customize email' })).toHaveAttribute(
      'href',
      expect.stringContaining(`/events/${event.id}/content/email?templateKey=tickets-issued`),
    );

    await page.getByRole('searchbox', { name: 'Search lifecycle emails' }).fill('webhook');
    const webhookTemplate = page.getByRole('button', { name: /Webhook failed/ });
    await expect(webhookTemplate).toBeVisible();
    await expect(page.getByRole('button', { name: /Order confirmed/ })).toHaveCount(0);
    await webhookTemplate.click();
    await expect(page.getByRole('heading', { name: 'Webhook failed' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Customize email' })).toHaveAttribute(
      'href',
      expect.stringContaining('templateKey=webhook-failed'),
    );

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const snapshot = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
          const search = panel?.querySelector('[aria-label="Search lifecycle emails"]');
          const selected = panel?.querySelector('[aria-pressed="true"]');
          return {
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            searchVisible: Boolean(search && search.getBoundingClientRect().height > 0),
            selectedText: selected?.textContent?.trim() ?? null,
          };
        })()`,
        returnByValue: true,
      });
      await testInfo.attach('cdp-global-lifecycle-library', {
        body: JSON.stringify(snapshot.result.value, null, 2),
        contentType: 'application/json',
      });
      expect(snapshot.result.value).toMatchObject({
        hasHorizontalOverflow: false,
        searchVisible: true,
        selectedText: expect.stringContaining('Webhook failed'),
      });
    }

    await attachScreenshot(page, testInfo, 'admin-lifecycle-library-desktop');
    await expectNoAxeViolations(page, testInfo, '[role="tabpanel"]');
  });

  test('admin can send, reload, and inspect an attendee message campaign', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    const { emailTemplateKey } = await seedMessagingPrerequisites(suffix, event.id);
    const buyerEmail = `message-workflow+${suffix}@example.com`;

    await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      buyerEmail,
    );
    await seedMessageConsentForEmail(event.id, buyerEmail, suffix);

    await page.goto(`${adminBaseUrl}/events/${event.id}/messages`);
    await expect(page.getByRole('heading', { name: 'Messages' })).toBeVisible();
    await page.getByRole('button', { name: 'New campaign' }).click();

    await expect(page.getByRole('heading', { name: 'New Campaign' })).toBeVisible();
    await expect(page.getByLabel('Email template')).toContainText('E2E campaign');
    await page.getByLabel('Message').fill(`Browser messaging validation ${suffix}`);
    await expect(page.getByText('1 recipients')).toBeVisible();
    await page.getByRole('button', { name: 'Send Campaign' }).click();

    await expect(page.getByText(emailTemplateKey, { exact: true })).toBeVisible();
    await expect(page.getByText('All attendees · 1 queued', { exact: true })).toBeVisible();

    await page.reload();
    const campaignRow = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText(emailTemplateKey, { exact: true }) });
    await expect(campaignRow).toBeVisible();
    await campaignRow.getByRole('button', { name: 'Details' }).click();

    const detailPanel = page.locator('[data-slot="card"]').filter({ hasText: 'Email jobs' });
    await expect(detailPanel.getByText(emailTemplateKey, { exact: true })).toBeVisible();
    await expect(detailPanel.getByText('Queued', { exact: true })).toBeVisible();
    await expect(detailPanel.getByText('Email jobs', { exact: true })).toBeVisible();
    await expect(detailPanel.getByText('Consent exclusions', { exact: true })).toBeVisible();
    await expect(detailPanel.getByText('Jobs', { exact: true })).toBeVisible();
    const maskedBuyerEmail = `${buyerEmail.slice(0, 1)}***@${buyerEmail.split('@')[1]}`;
    await expect(detailPanel.getByText(maskedBuyerEmail, { exact: true })).toBeVisible();
    await expect(detailPanel.getByText(buyerEmail, { exact: true })).toHaveCount(0);
    await expect(detailPanel.getByText('Delivery logs', { exact: true })).toBeVisible();
    await expect(detailPanel.getByText('Provider events', { exact: true })).toBeVisible();

    await attachScreenshot(page, testInfo, 'admin-messaging-detail-desktop');
    await expectNoAxeViolations(page, testInfo);
  });
});
