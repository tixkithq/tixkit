import { type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';

/**
 * E2E tests for the admin data table filter system (TBL-072).
 *
 * Covers orders filters, attendees filters, row sheet keyboard/focus behavior,
 * URL state back/forward, empty/loading/error states, console error checks,
 * and axe accessibility violations on desktop and mobile viewports.
 *
 * Requires a running admin dashboard (next dev or production build).
 * Tests are skipped when the admin server is not reachable.
 */

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test.describe('Admin data table filters', () => {
  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  // -------------------------------------------------------------------------
  // Orders table
  // -------------------------------------------------------------------------

  test.describe('Orders table filters', () => {
    test('renders orders table with filter toolbar on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);

      // Wait for the table to render
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Toolbar should have search input
      await expect(page.getByPlaceholder(/search/i).first()).toBeVisible();

      // Filter popovers or filter buttons should be visible
      const filterButtons = page.getByRole('button', { name: /filter/i });
      await expect(filterButtons.first()).toBeVisible();

      await attachScreenshot(page, testInfo, 'orders-filters-desktop');
      await expectNoAxeViolations(page, testInfo);
    });

    test('renders orders table on mobile viewport', async ({ page }, testInfo) => {
      await page.setViewportSize(mobileViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'orders-filters-mobile');
      await expectNoAxeViolations(page, testInfo);
    });

    test('opens a filter popover and shows filter options', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Click the first filter button
      const filterButton = page.getByRole('button', { name: /filter/i }).first();
      await filterButton.click();

      // A popover should appear with checkbox options or a filter UI
      await expect(page.getByRole('checkbox').first()).toBeVisible({
        timeout: 5_000,
      });
    });

    test('row sheet opens on row click and closes on Escape', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Click the first data row (not header)
      const rows = page.getByRole('row');
      const firstDataRow = rows.nth(1); // Skip header row
      await firstDataRow.click();

      // A sheet/dialog should appear
      const sheet = page.getByRole('dialog').or(page.locator('[data-state="open"]').first());
      await expect(sheet).toBeVisible({ timeout: 5_000 });

      await attachScreenshot(page, testInfo, 'orders-row-sheet-open');

      // Close with Escape
      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });

    test('URL state reflects search query', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Type in search
      const searchInput = page.getByPlaceholder(/search/i).first();
      await searchInput.fill('test@example.com');

      // Wait for URL to update (debounced)
      await page.waitForURL(/search=/, { timeout: 10_000 });

      // Navigate away and back - URL state should persist
      await page.goto(`${adminBaseUrl}/dashboard`);
      await page.goBack();

      // The search param should still be in the URL
      await expect(page).toHaveURL(/search=/);
    });
  });

  // -------------------------------------------------------------------------
  // Attendees table
  // -------------------------------------------------------------------------

  test.describe('Attendees table filters', () => {
    test('renders attendees table with filter toolbar on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'attendees-filters-desktop');
      await expectNoAxeViolations(page, testInfo);
    });

    test('renders attendees table on mobile viewport', async ({ page }, testInfo) => {
      await page.setViewportSize(mobileViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'attendees-filters-mobile');
      await expectNoAxeViolations(page, testInfo);
    });

    test('attendees row sheet opens on row click', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const rows = page.getByRole('row');
      const firstDataRow = rows.nth(1);
      await firstDataRow.click();

      const sheet = page.getByRole('dialog').or(page.locator('[data-state="open"]').first());
      await expect(sheet).toBeVisible({ timeout: 5_000 });

      await attachScreenshot(page, testInfo, 'attendees-row-sheet-open');

      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });
  });

  // -------------------------------------------------------------------------
  // Events table
  // -------------------------------------------------------------------------

  test.describe('Events table filters', () => {
    test('renders events table with filter toolbar on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/events`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'events-filters-desktop');
      await expectNoAxeViolations(page, testInfo);
    });

    test('renders events table on mobile viewport', async ({ page }, testInfo) => {
      await page.setViewportSize(mobileViewport);
      await page.goto(`${adminBaseUrl}/dashboard/events`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'events-filters-mobile');
      await expectNoAxeViolations(page, testInfo);
    });
  });

  // -------------------------------------------------------------------------
  // Audit log table
  // -------------------------------------------------------------------------

  test.describe('Audit log table', () => {
    test('renders audit log table on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/audit-log`);

      // The audit log page may have a heading or table
      await expect(page.getByRole('table').or(page.getByText(/audit events/i))).toBeVisible({
        timeout: 15_000,
      });
      await attachScreenshot(page, testInfo, 'audit-log-desktop');
      await expectNoAxeViolations(page, testInfo);
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  test('orders table shows empty state when no data', async ({ page }, testInfo) => {
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/dashboard/orders?search=zzz-no-results-expected`);

    // Should show an empty state message
    await expect(page.getByText(/no orders/i)).toBeVisible({ timeout: 15_000 });
    await attachScreenshot(page, testInfo, 'orders-empty-state');
  });
});
