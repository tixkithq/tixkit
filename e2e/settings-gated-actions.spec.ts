import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';

test.describe('admin settings validation', () => {
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

    await testInfo.attach('settings-profile', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
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

    await testInfo.attach('settings-billing', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await expectNoAxeViolations(page, testInfo);
  });
});
