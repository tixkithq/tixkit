import { test, expect, requireReachable } from './fixtures/validation-test';
import type { Page, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';

const settingsRoutes = [
  { path: '/settings', heading: 'Settings Home', name: 'home' },
  { path: '/settings/workspace', heading: 'Workspace', name: 'workspace' },
  { path: '/settings/branding', heading: 'Brand', name: 'brand' },
  { path: '/settings/members', heading: 'Members', name: 'members' },
  { path: '/settings/payments', heading: 'Payments', name: 'payments' },
  { path: '/settings/billing', heading: 'Billing', name: 'billing' },
  { path: '/settings/profile', heading: 'Profile', name: 'profile' },
  { path: '/settings/appearance', heading: 'Appearance', name: 'appearance' },
] as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test.describe('admin settings validation', () => {
  test('settings primary routes render across desktop and mobile without accessibility regressions', async ({ page }, testInfo) => {
    test.slow();
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of settingsRoutes) {
      await page.goto(`${adminBaseUrl}${route.path}`);
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Workspace' })).toBeVisible();
      await attachScreenshot(page, testInfo, `settings-${route.name}-desktop`);
      await expectNoAxeViolations(page, testInfo);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of settingsRoutes) {
      await page.goto(`${adminBaseUrl}${route.path}`);
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await attachScreenshot(page, testInfo, `settings-${route.name}-mobile`);
    }
    await expectNoAxeViolations(page, testInfo);
  });

  test('profile gated actions stay inactive and pass axe', async ({ page }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.goto(`${adminBaseUrl}/settings/profile`);
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    const avatar = page.getByRole('button', { name: 'Change Avatar' });
    if (await avatar.isVisible().catch(() => false)) {
      await expect(avatar).toHaveAttribute('aria-disabled', 'true');
    }

    const save = page.getByRole('button', { name: 'Save Changes' });
    if (await save.isVisible().catch(() => false)) {
      await expect(save).toHaveAttribute('aria-disabled', 'true');
    }

    await attachScreenshot(page, testInfo, 'settings-profile');
    await expectNoAxeViolations(page, testInfo);
  });

  test('billing invoice action is not exposed as an enabled fake success path', async ({ page }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.goto(`${adminBaseUrl}/settings/billing`);
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();

    const invoices = page.getByRole('button', { name: 'Download Invoices' });
    if (await invoices.isVisible().catch(() => false)) {
      await expect(invoices).toHaveAttribute('aria-disabled', 'true');
    }

    await attachScreenshot(page, testInfo, 'settings-billing');
    await expectNoAxeViolations(page, testInfo);
  });
});
