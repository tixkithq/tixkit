import { expect, requireReachable, test } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';

test.describe('migration workspace', () => {
  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  test('is keyboard-operable and accessible at desktop width', async ({ page }, testInfo) => {
    await page.goto(`${adminBaseUrl}/migrations`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Migration workspace' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Migration setup' })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });

  test('keeps setup and recovery controls usable at mobile width', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${adminBaseUrl}/migrations`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Migration workspace' }),
    ).toBeVisible();
    await expect(page.getByLabel('Importer')).toBeVisible();
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    await expectNoAxeViolations(page, testInfo);
  });
});
