import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';
import {
  devBrandId,
  devOrganizationId,
  ensureDevTenantGraph,
  seedPublishedEventPageContent,
  seedPublishedOrderConfirmationContent,
} from './helpers/seed';

test.describe('State-driven event onboarding', () => {
  test.beforeEach(async ({ page }) => {
    await ensureDevTenantGraph();
    await page.addInitScript(
      ({ organizationId, brandId }) => {
        window.localStorage.setItem('tixkit:selected-organization-id', organizationId);
        window.localStorage.setItem('tixkit:selected-brand-id', brandId);
      },
      { organizationId: devOrganizationId, brandId: devBrandId },
    );
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    test(`creates a durable draft and opens the media-aware launch center on ${viewport.name}`, async ({
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
      await expect(page.getByRole('link', { name: 'Add event media' })).toHaveAttribute(
        'href',
        /\/events\/[^/]+\/settings#media$/u,
      );
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
    await expect(freeRsvp).toBeEnabled();
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
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `e2e-saved-venue-${Date.now()}`,
        },
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

  test('recovers a real concurrent event edit with explicit field ownership', async ({
    page,
    consoleErrors,
  }, testInfo) => {
    await page.goto(`${adminBaseUrl}/events/new`);
    if (new URL(page.url()).pathname === '/sign-in') {
      test.skip(true, 'runtime admin server requires live Clerk authentication');
    }
    const originalTitle = `Conflict recovery ${testInfo.project.name} ${Date.now()}`;
    await page.getByLabel('Title').fill(originalTitle);
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/events\/(?!new$)[^/]+$/, { timeout: 30_000 });
    const eventId = new URL(page.url()).pathname.split('/').at(-1)!;
    await page.waitForLoadState('networkidle');

    await page.goto(`${adminBaseUrl}/events/${eventId}/settings#basics`);
    const basics = page.locator('#basics');
    await expect(basics.getByLabel('Title')).toHaveValue(originalTitle);
    const remoteTitle = `${originalTitle} remote`;
    const remoteUpdate = await page.evaluate(
      async ({ id, title }) => {
        const current = await fetch(`http://localhost:4200/v1/events/${id}`);
        const currentBody = (await current.json()) as { version?: number; error?: unknown };
        if (!current.ok || typeof currentBody.version !== 'number') {
          return { ok: false, status: current.status, body: JSON.stringify(currentBody) };
        }
        const response = await fetch(`http://localhost:4200/v1/events/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            expectedVersion: currentBody.version,
          }),
        });
        return { ok: response.ok, status: response.status, body: await response.text() };
      },
      { id: eventId, title: remoteTitle },
    );
    expect(remoteUpdate.ok, remoteUpdate.body).toBe(true);

    const localTitle = `${originalTitle} local`;
    await basics.getByLabel('Title').fill(localTitle);
    await basics.getByRole('button', { name: 'Save Changes' }).click();
    const conflictHeading = page.getByRole('heading', {
      name: 'Choose values for 1 conflicting field',
    });
    await expect(conflictHeading).toBeFocused();
    await expect(page.getByText(`Title: ${localTitle}`)).toBeVisible();
    await expect(page.getByText(`Title: ${remoteTitle}`)).toBeVisible();
    for (let index = consoleErrors.length - 1; index >= 0; index -= 1) {
      const message = consoleErrors[index] ?? '';
      if (message.includes('409 (Conflict)') && message.includes(`/v1/events/${eventId}`)) {
        consoleErrors.splice(index, 1);
      }
    }
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Keep my Title change' }).click();
    await basics.getByRole('button', { name: 'Save Changes' }).click();
    await expect(basics.getByText('Saved', { exact: true })).toBeVisible();
    const persistedTitle = await page.evaluate(async (id) => {
      const response = await fetch(`http://localhost:4200/v1/events/${id}`);
      const body = (await response.json()) as { title?: string };
      return response.ok ? body.title : undefined;
    }, eventId);
    expect(persistedTitle).toBe(localTitle);
    expect(consoleErrors).toEqual([]);
  });

  test('completes free ticket, preview review, safe test order, preflight, and publish', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.goto(`${adminBaseUrl}/events/new`);
    const title = `Launch workflow ${testInfo.project.name} ${Date.now()}`;
    const freeRsvp = page.getByRole('radio', { name: /Free RSVP/i });
    await expect(freeRsvp).toBeEnabled();
    await freeRsvp.focus();
    await page.keyboard.press('Space');
    await expect(freeRsvp).toBeChecked();
    await page.getByLabel('Title').fill(title);
    const createDraft = page.getByRole('button', { name: 'Create draft' });
    await expect(createDraft).toBeEnabled({ timeout: 30_000 });
    await createDraft.click();
    await expect(page).toHaveURL(/\/events\/(?!new$)[^/]+$/, { timeout: 30_000 });
    const eventId = new URL(page.url()).pathname.split('/').at(-1)!;
    await page.waitForLoadState('networkidle');
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
    await expect(page.getByRole('heading', { name: 'Your event is live' })).toBeVisible();
    await expect(page.getByLabel('Public event URL')).toHaveValue(/^https?:\/\//u);
    await expect(page.getByRole('list', { name: 'Event operational health' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open public page' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open monitor sales' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open verify another checkout' })).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });
});
