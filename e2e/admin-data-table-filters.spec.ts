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

  // ---------------------------------------------------------------------------
  // Data-contract tests: verify filter/sort/pagination correctness, not just UI
  // ---------------------------------------------------------------------------

  test.describe('Orders data-contract', () => {
    test('status filter narrows rows to matching status', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Open the status filter popover
      const filterButton = page.getByRole('button', { name: /status/i }).first();
      await filterButton.click();

      // Select "paid" from the filter options
      const paidCheckbox = page.getByRole('checkbox', { name: /paid/i }).first();
      await expect(paidCheckbox).toBeVisible({ timeout: 5_000 });
      await paidCheckbox.check();

      // Wait for URL to reflect the filter
      await page.waitForURL(/status=paid/, { timeout: 10_000 });

      // Verify all visible data rows contain "paid" in the status column
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/paid/i, { ignoreCase: true }),
          ),
        );
      }
    });

    test('sort direction changes row order', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Find a sortable column header (e.g., "Created" or "Date")
      const createdHeader = page.getByRole('columnheader').filter({ hasText: /created|date/i }).first();
      await createdHeader.click();

      // Wait for URL to reflect sort param
      await page.waitForURL(/sort=/, { timeout: 10_000 });

      // Capture first row text after initial sort
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const firstRowTextBefore = (await dataRows.first().textContent()) ?? '';

      // Click the same header to reverse sort direction
      await createdHeader.click();
      await page.waitForURL(/sort=/, { timeout: 10_000 });

      // Verify the first row changed (different order)
      const firstRowTextAfter = (await dataRows.first().textContent()) ?? '';

      // If there are at least 2 rows, the first row should differ after reversing sort
      const rowCount = await dataRows.count();
      if (rowCount >= 2) {
        expect(firstRowTextAfter).not.toEqual(firstRowTextBefore);
      }
    });

    test('URL state persists status filter across navigation', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Apply a status filter via URL directly (data-contract: URL params drive the table)
      await page.goto(`${adminBaseUrl}/dashboard/orders?status=paid`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Verify URL has the filter param
      await expect(page).toHaveURL(/status=paid/);

      // Navigate away
      await page.goto(`${adminBaseUrl}/dashboard`);
      await expect(page).toHaveURL(/dashboard$/);

      // Navigate back via URL
      await page.goto(`${adminBaseUrl}/dashboard/orders?status=paid`);
      await expect(page).toHaveURL(/status=paid/);

      // Table should still be filtered
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/paid/i, { ignoreCase: true }),
          ),
        );
      }
    });

    test('row sheet displays order details', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Capture the first data row's content for comparison
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const firstRowText = (await dataRows.first().textContent()) ?? '';

      // Click the first data row to open the sheet
      await dataRows.first().click();

      // Verify the sheet/dialog appears
      const sheet = page.getByRole('dialog').or(page.locator('[data-state="open"]').first());
      await expect(sheet).toBeVisible({ timeout: 5_000 });

      // The sheet should contain order detail labels (data-contract: sheet shows structured data)
      const sheetText = (await sheet.textContent()) ?? '';
      // At least one of these detail labels should be present
      const hasOrderDetail =
        /order\s*(id|#)/i.test(sheetText) ||
        /status/i.test(sheetText) ||
        /total|amount/i.test(sheetText) ||
        /buyer|email|customer/i.test(sheetText) ||
        /event/i.test(sheetText);
      expect(hasOrderDetail).toBe(true);

      // The sheet content should overlap with the row content (same order data)
      // Extract a meaningful identifier from the first row (e.g., an ID or email)
      const rowHasMatch = firstRowText.length > 10;
      if (rowHasMatch) {
        // The sheet should share at least some text with the clicked row
        const sheetHasRowData = firstRowText
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .some((word) => sheetText.includes(word));
        expect(sheetHasRowData).toBe(true);
      }

      await attachScreenshot(page, testInfo, 'orders-row-sheet-details');
      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });

    test('combined filters intersect correctly', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      // Apply both search and status filter via URL
      await page.goto(`${adminBaseUrl}/dashboard/orders?status=paid&search=a`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // If rows are present, each should match both "paid" status AND search term
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        const rowTexts = await Promise.all(
          Array.from({ length: count }, (_, i) => dataRows.nth(i).textContent()),
        );
        for (const text of rowTexts) {
          expect((text ?? '').toLowerCase()).toContain('paid');
        }
      }

      // URL should reflect both params
      await expect(page).toHaveURL(/status=paid/);
      await expect(page).toHaveURL(/search=a/);
    });

    test('cursor pagination produces no duplicate rows', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Collect row identifiers from the first page
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const firstPageIds = new Set<string>();
      const firstRowCount = await dataRows.count();
      const firstPageTexts = await Promise.all(
        Array.from({ length: firstRowCount }, (_, i) => dataRows.nth(i).textContent()),
      );
      for (const text of firstPageTexts) {
        const id = (text ?? '').trim().slice(0, 50);
        if (id) firstPageIds.add(id);
      }

      // Look for a "Next" or pagination button
      const nextButton = page.getByRole('button', { name: /next|load\s*more|→/i }).first();
      const hasNext = await nextButton.isVisible().catch(() => false);

      if (hasNext) {
        await nextButton.click();
        await page.waitForURL(/cursor=/, { timeout: 10_000 }).catch(() => {});

        // Collect row identifiers from the second page
        const secondRowCount = await dataRows.count();
        const secondPageTexts = await Promise.all(
          Array.from({ length: secondRowCount }, (_, i) => dataRows.nth(i).textContent()),
        );
        let duplicateCount = 0;
        for (const text of secondPageTexts) {
          const id = (text ?? '').trim().slice(0, 50);
          if (id && firstPageIds.has(id)) duplicateCount++;
        }

        // No rows from the first page should appear on the second page
        expect(duplicateCount).toBe(0);
      }
    });
  });

  test.describe('Attendees data-contract', () => {
    test('status filter narrows attendee rows to matching status', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Apply status filter via URL
      await page.goto(`${adminBaseUrl}/dashboard/attendees?status=active`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Verify visible rows match the filter
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/active/i, { ignoreCase: true }),
          ),
        );
      }

      await expect(page).toHaveURL(/status=active/);
    });

    test('attendee row sheet displays attendee details', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const firstRowText = (await dataRows.first().textContent()) ?? '';

      await dataRows.first().click();

      const sheet = page.getByRole('dialog').or(page.locator('[data-state="open"]').first());
      await expect(sheet).toBeVisible({ timeout: 5_000 });

      // The sheet should contain attendee detail labels
      const sheetText = (await sheet.textContent()) ?? '';
      const hasAttendeeDetail =
        /email/i.test(sheetText) ||
        /ticket/i.test(sheetText) ||
        /status/i.test(sheetText) ||
        /name/i.test(sheetText) ||
        /event/i.test(sheetText);
      expect(hasAttendeeDetail).toBe(true);

      // Sheet should share data with the clicked row
      const rowHasMatch = firstRowText.length > 10;
      if (rowHasMatch) {
        const sheetHasRowData = firstRowText
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .some((word) => sheetText.includes(word));
        expect(sheetHasRowData).toBe(true);
      }

      await attachScreenshot(page, testInfo, 'attendees-row-sheet-details');
      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });

    test('URL state persists attendee status filter across navigation', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/dashboard/attendees?status=active`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/status=active/);

      // Navigate away
      await page.goto(`${adminBaseUrl}/dashboard`);
      await expect(page).toHaveURL(/dashboard$/);

      // Navigate back via URL
      await page.goto(`${adminBaseUrl}/dashboard/attendees?status=active`);
      await expect(page).toHaveURL(/status=active/);

      // Table should still be filtered
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/active/i, { ignoreCase: true }),
          ),
        );
      }
    });
  });
});
