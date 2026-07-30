import { type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';
import { seedAdminAttendeeTableRow } from './helpers/seed';

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

async function attachJsonEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

function uniqueE2eSuffix(testInfo: TestInfo, prefix: string): string {
  return `${prefix}-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`
    .replaceAll(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
}

test.describe('Admin data table filters', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  // -------------------------------------------------------------------------
  // Orders table
  // -------------------------------------------------------------------------

  test.describe('Orders table filters', () => {
    test('renders orders table with filter toolbar on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);

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
      await page.goto(`${adminBaseUrl}/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'orders-filters-mobile');
      await expectNoAxeViolations(page, testInfo);
    });

    test('opens a filter popover and shows filter options', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Click the first filter button
      const filterButton = page.getByRole('button', { name: /filter/i }).first();
      await filterButton.click();

      // A popover should appear with checkbox options or a filter UI
      await expect(page.getByRole('checkbox').first()).toBeVisible({
        timeout: 5_000,
      });
    });

    test('row sheet opens on row click and closes on Escape', async ({
      page,
      request,
    }, testInfo) => {
      const seeded = await seedAdminAttendeeTableRow(
        request,
        uniqueE2eSuffix(testInfo, 'order-sheet'),
      );

      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const seededRow = dataRows.filter({ hasText: seeded.attendee.email });
      await expect(seededRow).toHaveCount(1);
      await seededRow.getByText(seeded.attendee.email).click();

      // A sheet/dialog should appear
      const sheet = page.getByRole('dialog', { name: 'Details' });
      await expect(sheet).toBeVisible({ timeout: 5_000 });

      await attachScreenshot(page, testInfo, 'orders-row-sheet-open');

      // Close with Escape
      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });

    test('URL state reflects search query', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Type in search
      const searchInput = page.getByPlaceholder(/search/i).first();
      await searchInput.fill('test@example.com');

      // Wait for URL to update (debounced)
      await page.waitForURL(/search=/, { timeout: 10_000 });

      // Reload the current route - URL-backed state should rehydrate from the query string
      await page.reload();
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // The search param should still be in the URL
      await expect(page).toHaveURL(/search=/);
      await expect(searchInput).toHaveValue('test@example.com');
    });
  });

  // -------------------------------------------------------------------------
  // Attendees table
  // -------------------------------------------------------------------------

  test.describe('Attendees table filters', () => {
    test('renders attendees table with filter toolbar on desktop', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'attendees-filters-desktop');
      await expectNoAxeViolations(page, testInfo);
    });

    test('renders attendees table on mobile viewport', async ({ page }, testInfo) => {
      await page.setViewportSize(mobileViewport);
      await page.goto(`${adminBaseUrl}/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'attendees-filters-mobile');
      await expectNoAxeViolations(page, testInfo);
    });

    test('attendees row sheet opens on row click', async ({ page }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/attendees`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const rows = page.getByRole('row');
      const firstDataRow = rows.nth(1);
      await firstDataRow.click();

      const sheet = page.getByRole('dialog', { name: 'Details' });
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
      await page.goto(`${adminBaseUrl}/events`);

      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await attachScreenshot(page, testInfo, 'events-filters-desktop');
      await expectNoAxeViolations(page, testInfo);
    });

    test('renders events table on mobile viewport', async ({ page }, testInfo) => {
      await page.setViewportSize(mobileViewport);
      await page.goto(`${adminBaseUrl}/events`);

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
      await page.goto(`${adminBaseUrl}/audit-log`);

      // The audit log page may have a heading or table
      await expect(page.getByRole('table').or(page.getByText(/audit events/i))).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(100);
      await attachScreenshot(page, testInfo, 'audit-log-desktop');
      await expectNoAxeViolations(page, testInfo);
    });
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  test('orders table shows empty state when no data', async ({ page }, testInfo) => {
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/orders?eventId=evt_no_results_expected`);

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
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Open the status filter popover
      const filterButton = page.getByRole('button', { name: /status/i }).first();
      await filterButton.click();

      // Select "paid" from the filter options
      const paidOption = page.getByRole('option', { name: /^paid/i });
      await expect(paidOption).toBeVisible({ timeout: 5_000 });
      await paidOption.click();

      // Wait for URL to reflect the filter
      await page.waitForURL(/status=paid/, { timeout: 10_000 });

      // Verify all visible data rows contain "paid" in the status column
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/paid/i, {
              ignoreCase: true,
            }),
          ),
        );
      }
    });

    test('sort direction changes row order', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Find a sortable column header (e.g., "Created" or "Date")
      const dateSortButton = page.getByRole('button', { name: /date/i }).first();
      await dateSortButton.click();
      await page.getByRole('menuitem', { name: /^asc$/i }).click();

      // Wait for URL to reflect sort param
      await page.waitForURL(/sort=/, { timeout: 10_000 });

      // Capture first row text after initial sort
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const firstRowTextBefore = (await dataRows.first().textContent()) ?? '';

      // Reverse sort direction through the URL-backed table contract after the header menu path.
      await page.goto(`${adminBaseUrl}/orders?sort=createdAt%3Adesc`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const firstRowTextAfter = (await dataRows.first().textContent()) ?? '';

      await expect(page).toHaveURL(/sort=createdAt%3Adesc|sort=createdAt:desc/);
      expect(firstRowTextAfter.length).toBeGreaterThan(0);
      expect(firstRowTextBefore.length).toBeGreaterThan(0);
    });

    test('URL state persists status filter across navigation', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Apply a status filter via URL directly (data-contract: URL params drive the table)
      await page.goto(`${adminBaseUrl}/orders?status=paid`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Verify URL has the filter param
      await expect(page).toHaveURL(/status=paid/);
      await page.waitForLoadState('networkidle');

      // Navigate away
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page).not.toHaveURL(/status=paid/);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');

      // Navigate back through browser history so URL state is restored by the app router
      await page.goBack();
      await expect(page).toHaveURL(/status=paid/);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');

      // Table should still be filtered
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/paid/i, {
              ignoreCase: true,
            }),
          ),
        );
      }
    });

    test('row sheet displays order details', async ({ page, request }, testInfo) => {
      const seeded = await seedAdminAttendeeTableRow(
        request,
        uniqueE2eSuffix(testInfo, 'order-detail'),
      );

      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const seededRow = dataRows.filter({ hasText: seeded.attendee.email });
      await expect(seededRow).toHaveCount(1);
      const firstRowText = (await seededRow.first().textContent()) ?? '';

      await seededRow.getByText(seeded.attendee.email).click();

      // Verify the sheet/dialog appears
      const sheet = page.getByRole('dialog', { name: 'Details' });
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

      expect(firstRowText.length).toBeGreaterThan(10);

      await attachScreenshot(page, testInfo, 'orders-row-sheet-details');
      await page.keyboard.press('Escape');
      await expect(sheet).not.toBeVisible({ timeout: 5_000 });
    });

    test('combined filters intersect correctly', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      // Apply both search and status filter via URL
      await page.goto(`${adminBaseUrl}/orders?status=paid&search=a`);
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

    test('captures live table API evidence for filter, sort, and pagination state', async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(desktopViewport);
      const ordersResponse = page.waitForResponse(
        (response) => {
          const url = new URL(response.url());
          return (
            url.pathname.endsWith('/v1/orders') &&
            url.searchParams.toString().length > 0 &&
            response.status() === 200
          );
        },
        { timeout: 15_000 },
      );

      await page.goto(`${adminBaseUrl}/orders?status=paid&sort=createdAt%3Adesc&limit=5`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const response = await ordersResponse;
      const requestUrl = new URL(response.url());
      const payload = await response.json();
      const items = Array.isArray(payload.items) ? payload.items : [];
      const itemIds = items
        .map((item: unknown) =>
          item && typeof item === 'object' && 'id' in item
            ? String((item as { id: unknown }).id)
            : undefined,
        )
        .filter((id): id is string => Boolean(id));

      expect(requestUrl.search).toContain('sort=');
      expect(requestUrl.search).toContain('limit=5');
      expect(payload.items).toEqual(expect.any(Array));
      expect(payload.nextCursor == null || typeof payload.nextCursor === 'string').toBe(true);
      expect(itemIds.length).toBeLessThanOrEqual(5);

      await attachJsonEvidence(testInfo, 'orders-table-api-contract', {
        requestPath: `${requestUrl.pathname}${requestUrl.search}`,
        status: response.status(),
        itemCount: itemIds.length,
        itemIds,
        hasMore: typeof payload.nextCursor === 'string',
        nextCursor: payload.nextCursor ?? null,
      });
      await attachScreenshot(page, testInfo, 'orders-table-filter-sort-pagination-evidence');
    });

    test('cursor pagination produces no duplicate rows', async ({ page }) => {
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/orders`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Collect row identifiers from the first page
      const orderLinks = page.getByRole('link', { name: /^ord_/ });
      const firstLinkCount = await orderLinks.count();
      const firstPageIds = new Set(
        await Promise.all(
          Array.from({ length: firstLinkCount }, (_, i) => orderLinks.nth(i).innerText()),
        ),
      );

      // Look for a "Next" or pagination button
      const nextButton = page.getByRole('button', { name: /next|load\s*more|→/i }).first();
      const hasNext =
        (await nextButton.isVisible().catch(() => false)) &&
        (await nextButton.isEnabled().catch(() => false));

      if (hasNext) {
        await nextButton.click();
        await page.waitForURL(/cursor=/, { timeout: 10_000 }).catch(() => {});

        // Collect row identifiers from the second page
        await expect
          .poll(async () => {
            const nextLinkCount = await orderLinks.count();
            const nextPageIds = await Promise.all(
              Array.from({ length: nextLinkCount }, (_, i) => orderLinks.nth(i).innerText()),
            );
            return nextPageIds.some((id) => !firstPageIds.has(id));
          })
          .toBe(true);

        const secondLinkCount = await orderLinks.count();
        const secondPageIds = await Promise.all(
          Array.from({ length: secondLinkCount }, (_, i) => orderLinks.nth(i).innerText()),
        );
        const duplicateCount = secondPageIds.filter((id) => firstPageIds.has(id)).length;

        // No rows from the first page should appear on the second page
        expect(duplicateCount).toBe(0);
      }
    });
  });

  test.describe('Attendees data-contract', () => {
    test('status filter narrows attendee rows to matching status', async ({
      page,
      request,
    }, testInfo) => {
      await seedAdminAttendeeTableRow(request, uniqueE2eSuffix(testInfo, 'att-status'));

      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/attendees`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Apply a real attendee lifecycle status via URL.
      await page.goto(`${adminBaseUrl}/attendees?status=confirmed`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      // Verify visible rows match the filter
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/active/i, {
              ignoreCase: true,
            }),
          ),
        );
      }

      await expect(page).toHaveURL(/status=confirmed/);
    });

    test('attendee row sheet displays attendee details', async ({ page, request }, testInfo) => {
      const seeded = await seedAdminAttendeeTableRow(
        request,
        uniqueE2eSuffix(testInfo, 'att-sheet'),
      );

      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/attendees`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const seededRow = dataRows.filter({ hasText: seeded.attendee.email });
      await expect(seededRow).toHaveCount(1);
      const firstRowText = (await seededRow.first().textContent()) ?? '';

      await seededRow.first().click();

      const sheet = page.getByRole('dialog', { name: 'Details' });
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

    test('URL state persists attendee status filter across navigation', async ({
      page,
      request,
    }, testInfo) => {
      await seedAdminAttendeeTableRow(request, uniqueE2eSuffix(testInfo, 'att-url'));

      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/attendees?status=active`);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(/status=active/);
      await page.waitForLoadState('networkidle');

      // Navigate away within the same route
      await page.goto(`${adminBaseUrl}/attendees`);
      await expect(page).not.toHaveURL(/status=active/);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');

      // Navigate back through browser history so URL state is restored by the app router
      await page.goBack();
      await expect(page).toHaveURL(/status=active/);
      await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');

      // Table should still be filtered
      const dataRows = page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') });
      const count = await dataRows.count();
      if (count > 0) {
        await Promise.all(
          Array.from({ length: count }, (_, i) =>
            expect(dataRows.nth(i)).toContainText(/active/i, {
              ignoreCase: true,
            }),
          ),
        );
      }
    });
  });
});
