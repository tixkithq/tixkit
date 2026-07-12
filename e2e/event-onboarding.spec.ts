import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';
import {
  seedPublishedEventPageContent,
  seedPublishedOrderConfirmationContent,
} from './helpers/seed';

test.describe('State-driven event onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`creates a durable draft and opens the launch center on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      await page.goto(`${adminBaseUrl}/events/new`);
      if (new URL(page.url()).pathname === '/sign-in') {
        test.skip(true, 'runtime admin server requires live Clerk authentication');
      }

      await expect(page.getByRole('heading', { name: 'Create an event' })).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      const title = `Onboarding ${testInfo.project.name} ${Date.now()}`;
      const titleInput = page.getByLabel('Title');
      await titleInput.fill(title);
      await expect(titleInput).toHaveValue(title);
      await page.getByLabel('Currency').fill('USD');

      await page.getByRole('button', { name: 'Create draft' }).click();
      await expect(page).toHaveURL(/\/events\/[^/]+$/, { timeout: 15_000 });
      await expect(page.getByText(title)).toBeVisible();
      await expect(page.getByText(/launch center|required setup complete/i).first()).toBeVisible();
      await expect(page.getByRole('link', { name: /ticket/i }).first()).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
    });
  }

  test('supports keyboard-only starting-point selection and validation recovery', async ({
    page,
  }) => {
    await page.goto(`${adminBaseUrl}/events/new`);
    if (new URL(page.url()).pathname === '/sign-in')
      test.skip(true, 'live Clerk authentication required');
    const freeRsvp = page.getByRole('radio', { name: /Free RSVP/i });
    await freeRsvp.focus();
    await page.keyboard.press('Space');
    await expect(freeRsvp).toBeChecked();
    await page.getByLabel('Title').fill('Keyboard event');
    await page.getByLabel('Currency').fill('US');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.locator('#new-event-error')).toContainText(
      'Currency must be a three-letter ISO code',
    );
  });

  test('selects a reusable saved venue and applies its timezone', async ({ page }, testInfo) => {
    const name = `Saved venue ${testInfo.project.name} ${Date.now()}`;
    await page.goto(`${adminBaseUrl}/events/new`);
    const created = await page.evaluate(async (venueName) => {
      const response = await fetch('http://localhost:4200/v1/venues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_dev_local',
          name: venueName,
          address: { city: 'Austin', region: 'TX', country: 'US' },
          timezone: 'America/Chicago',
        }),
      });
      return { ok: response.ok, body: await response.text() };
    }, name);
    expect(created.ok, created.body).toBe(true);
    await page.reload();
    await page.getByLabel('Saved venue').selectOption({ label: name });
    await expect(page.getByLabel(/Venue name/)).toHaveValue(name);
    await expect(page.getByRole('combobox', { name: 'Timezone' })).toHaveValue('America/Chicago');
  });

  test('completes free ticket, preview review, safe test order, preflight, and publish', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(`${adminBaseUrl}/events/new`);
    const title = `Launch workflow ${testInfo.project.name} ${Date.now()}`;
    const freeRsvp = page.getByRole('radio', { name: /Free RSVP/i });
    await freeRsvp.focus();
    await page.keyboard.press('Space');
    await expect(freeRsvp).toBeChecked();
    await page.getByLabel('Title').fill(title);
    const createDraft = page.getByRole('button', { name: 'Create draft' });
    await expect(createDraft).toBeEnabled({ timeout: 30_000 });
    await createDraft.click();
    await expect(page).toHaveURL(/\/events\/(?!new$)[^/]+$/, { timeout: 30_000 });
    const eventId = new URL(page.url()).pathname.split('/').at(-1)!;
    const suffix = `${testInfo.project.name}-${Date.now()}`;
    await seedPublishedEventPageContent({ event: { id: eventId, title }, suffix });
    await seedPublishedOrderConfirmationContent({ eventId, suffix });
    const checkoutReview = await page.evaluate(async (id) => {
      const response = await fetch(
        `http://localhost:4200/v1/events/${id}/readiness-acknowledgements/checkout_consent`,
        { method: 'POST' },
      );
      return { ok: response.ok, body: await response.text() };
    }, eventId);
    expect(checkoutReview.ok, checkoutReview.body).toBe(true);

    await page.goto(`${adminBaseUrl}/events/${eventId}/preview`);
    await expect(page.getByText('Interactive checkout preview')).toBeVisible();
    await page.getByRole('button', { name: 'Mark preview reviewed' }).click();
    await expect(page.getByText('Preview marked reviewed.')).toBeVisible();
    const confirmationResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/checkout/sessions/') &&
        response.url().endsWith('/confirm') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Run safe test checkout' }).click();
    const confirmation = await confirmationResponse;
    const confirmationBody = await confirmation.text();
    expect(confirmation.ok(), confirmationBody).toBe(true);
    await expect(page.getByText(/Test checkout completed/)).toBeVisible();

    await page.getByRole('link', { name: 'Back to launch center' }).click();
    await expect(page.getByRole('button', { name: 'Review and publish' })).toBeEnabled();
    await page.getByRole('button', { name: 'Review and publish' }).click();
    await expect(page.getByRole('heading', { name: 'Publish preflight' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm publish' }).click();
    await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });
});
