import { test, expect, requireReachable } from './fixtures/validation-test';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId } from './helpers/seed';

const desktopViewport = { width: 1440, height: 1000 } as const;

type SeededContentEvent = { id: string; title: string };

async function seedContentEvent(page: import('@playwright/test').Page, suffix: string) {
  const response = await page.request.post(`${apiBaseUrl}/v1/events`, {
    data: {
      organizationId: devOrganizationId,
      brandId: devBrandId,
      slug: `e2e-inspector-focus-${suffix}`,
      title: `E2E Inspector Focus ${suffix}`,
      description: 'Seeded by Playwright for email inspector focus coverage.',
      currency: 'USD',
      timezone: 'America/New_York',
      startsAt: '2026-11-17T23:00:00.000Z',
      endsAt: '2026-11-18T02:00:00.000Z',
      visibility: 'public',
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as SeededContentEvent;
}

test.describe('persisted admin email inspector focus stability', () => {
  test.describe.configure({ timeout: 180_000 });

  test('keeps focus when clicking and typing in inspector style fields', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    const event = await seedContentEvent(
      page,
      `focus-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`,
    );
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);

    const emailBody = page.getByLabel('Email body');
    const inspectorHost = page.locator('[data-testid="native-email-inspector-host"]');
    await expect(emailBody).toBeVisible();
    await expect(inspectorHost).toBeVisible();

    // Click into a paragraph to surface the text/node inspector sections.
    const paragraphPoint = await page.evaluate(() => {
      const p = document.querySelector('.ProseMirror p');
      if (!p) return null;
      const rect = p.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    expect(paragraphPoint).not.toBeNull();
    await page.mouse.click(paragraphPoint!.x, paragraphPoint!.y);
    await page.waitForTimeout(600);
    await expect(inspectorHost.locator('text=Selection')).toBeVisible();

    // The color hex input commits on every keystroke, making it the most
    // churn-prone field. Click it and verify focus is retained.
    const colorHex = inspectorHost.locator('[data-re-inspector-color-hex]').first();
    await expect(colorHex).toBeVisible();
    await colorHex.click();
    await expect(colorHex).toBeFocused();

    // Typing into the hex field should not lose focus to the editor or body.
    await colorHex.fill('#aabbcc');
    await expect(colorHex).toBeFocused();
    await expect(colorHex).toHaveValue('#aabbcc');

    // A padding number input should also retain focus on click.
    const paddingInput = inspectorHost.locator('input[type="number"]').first();
    if (await paddingInput.isVisible()) {
      await paddingInput.click();
      await expect(paddingInput).toBeFocused();
    }
  });
});
