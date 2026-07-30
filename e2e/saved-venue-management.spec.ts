import { expect, requireReachable, test } from './fixtures/validation-test';
import type { Locator, Page } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId, ensureDevTenantGraph } from './helpers/seed';

async function tabTo(page: Page, target: Locator, direction: 'forward' | 'backward' = 'forward') {
  const isWebKit = page.context().browser()?.browserType().name() === 'webkit';
  const key =
    direction === 'forward'
      ? isWebKit
        ? 'Alt+Tab'
        : 'Tab'
      : isWebKit
        ? 'Alt+Shift+Tab'
        : 'Shift+Tab';
  for (let step = 0; step < 80; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute('aria-label')}`);
}

async function settleAnimations(target: Locator) {
  await target.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
  });
}

test.describe('Saved venue management', () => {
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
    await page.waitForLoadState('networkidle');
  });

  test('creates, defaults, reuses, and safely deletes a venue with keyboard access', async ({
    page,
  }, testInfo) => {
    const venueName = `Managed venue ${testInfo.project.name} ${Date.now()}`;
    await page.goto(`${adminBaseUrl}/settings/workspace`);
    if (new URL(page.url()).pathname === '/sign-in') {
      test.skip(true, 'runtime admin server requires live Clerk authentication');
    }

    const addVenue = page.getByRole('button', { name: 'Add saved venue' });
    await tabTo(page, addVenue);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Venue name')).toBeFocused();
    await page.keyboard.type(venueName);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Austin');
    await page.keyboard.press('Tab');
    await page.keyboard.type('TX');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('US');
    await page.keyboard.press('Tab');
    await page.keyboard.type('America/Chicago');
    await expectNoAxeViolations(page, testInfo);
    const saveVenue = page.getByRole('button', { name: 'Save venue' });
    await tabTo(page, saveVenue);
    await expect(saveVenue).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Saved venue created.')).toBeVisible();
    const venueList = page.getByRole('list', { name: 'Reusable saved venues' });
    await expect(venueList.getByText(venueName, { exact: true })).toBeVisible();

    const defaultVenue = page.getByLabel('Default saved venue');
    await tabTo(page, defaultVenue, 'backward');
    await page.keyboard.type(venueName);
    await expect(defaultVenue.locator('option:checked')).toHaveText(venueName);
    const saveChanges = page.getByRole('button', { name: 'Save Changes' });
    await tabTo(page, saveChanges);
    await page.keyboard.press('Enter');
    const savedToast = page.locator('[data-sonner-toast]').filter({
      hasText: 'Workspace settings saved',
    });
    await expect(savedToast).toBeVisible();
    await settleAnimations(savedToast);
    await expectNoAxeViolations(page, testInfo);

    await page.goto(`${adminBaseUrl}/events/new`);
    await page.waitForLoadState('networkidle');
    await page.reload();
    await expect(page.getByLabel('Saved venue')).toHaveValue(/ven_/u);
    await expect(page.getByLabel(/Venue name/)).toHaveValue(venueName);
    await expect(page.getByRole('combobox', { name: 'Timezone' })).toHaveValue('America/Chicago');
    await page.waitForLoadState('networkidle');

    await page.goto(`${adminBaseUrl}/settings/workspace`);
    const restoredDefaultVenue = page.getByLabel('Default saved venue');
    await tabTo(page, restoredDefaultVenue);
    await page.keyboard.type('No default venue');
    await expect(restoredDefaultVenue.locator('option:checked')).toHaveText('No default venue');
    await tabTo(page, page.getByRole('button', { name: 'Save Changes' }));
    await page.keyboard.press('Enter');
    await expect(page.getByText('Workspace settings saved.')).toBeVisible();
    const deleteTrigger = page.getByRole('button', { name: `Delete ${venueName}` });
    await tabTo(page, deleteTrigger, 'backward');
    await page.keyboard.press('Enter');
    const deleteDialog = page.getByRole('alertdialog');
    await expect(deleteDialog).toBeVisible();
    await settleAnimations(deleteDialog);
    await expectNoAxeViolations(page, testInfo);
    const deleteAction = page.getByRole('button', { name: 'Delete venue' });
    await tabTo(page, deleteAction);
    await page.keyboard.press('Space');
    await expect(page.getByText(`${venueName} deleted.`)).toBeVisible();
    await expect(venueList.getByText(venueName, { exact: true })).toHaveCount(0);
    await expect(addVenue).toBeFocused();
  });
});
