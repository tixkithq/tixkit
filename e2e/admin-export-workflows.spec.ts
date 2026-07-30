import { type Page, type Response as PlaywrightResponse, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  readPromoCheckoutCaptureState,
  resignTicketsForOnlineScan,
  seedAffiliateAttributionForOrder,
  seedCheckInListForOrder,
  seedFreeCheckoutEvent,
  seedPaidPromoCheckoutEvent,
  seedTaxSnapshotForOrder,
} from './helpers/seed';

const exportCases = [
  { type: 'sales', buttonName: 'Export sales CSV', statusLabel: 'Sales' },
  { type: 'tax', buttonName: 'Export tax CSV', statusLabel: 'Tax' },
  { type: 'attendees', buttonName: 'Export attendees CSV', statusLabel: 'Attendees' },
  { type: 'orders', buttonName: 'Export orders CSV', statusLabel: 'Orders' },
  { type: 'tickets', buttonName: 'Export tickets CSV', statusLabel: 'Tickets' },
  { type: 'scan_logs', buttonName: 'Export scan logs CSV', statusLabel: 'Scan Logs' },
] as const;

const mobileReportViewport = { width: 390, height: 844 } as const;

type AttendanceReport = {
  eventId: string;
  totalAttendees: number;
  checkedIn: number;
  notCheckedIn: number;
  checkInRate: number;
  breakdownByTicketType: Array<{
    ticketTypeName: string;
    total: number;
    checkedIn: number;
  }>;
};

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function waitForToastNotificationsToDismiss(page: Page): Promise<void> {
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
}

async function expectJsonStatus<T>(
  response: PlaywrightResponse | Awaited<ReturnType<Page['request']['get']>>,
  expectedStatus: number,
): Promise<T> {
  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body as T;
}

async function readAttendanceReport(page: Page, eventId: string): Promise<AttendanceReport> {
  return expectJsonStatus<AttendanceReport>(
    await page.request.get(`${apiBaseUrl}/v1/events/${eventId}/reports/attendance`, {
      failOnStatusCode: false,
    }),
    200,
  );
}

async function expectCheckedInAttendanceReport(
  page: Page,
  eventId: string,
  ticketTypeName: string,
): Promise<AttendanceReport> {
  let latestReport: AttendanceReport | undefined;

  await expect
    .poll(
      async () => {
        latestReport = await readAttendanceReport(page, eventId);
        return {
          totalAttendees: latestReport.totalAttendees,
          checkedIn: latestReport.checkedIn,
          notCheckedIn: latestReport.notCheckedIn,
          checkInRate: latestReport.checkInRate,
          ticketTypeRow: latestReport.breakdownByTicketType.find(
            (row) => row.ticketTypeName === ticketTypeName,
          ),
        };
      },
      { message: 'attendance report reflects accepted scan', timeout: 10_000 },
    )
    .toMatchObject({
      totalAttendees: 1,
      checkedIn: 1,
      notCheckedIn: 0,
      checkInRate: 1,
      ticketTypeRow: expect.objectContaining({
        ticketTypeName,
        total: 1,
        checkedIn: 1,
      }),
    });

  return latestReport!;
}

async function completeSeededFreeCheckout(
  page: Page,
  eventId: string,
  eventTitle: string,
  ticketName: string,
  productName: string,
  buyerEmail: string,
): Promise<{ sessionId: string; orderId: string }> {
  await page.goto(`${checkoutBaseUrl}/checkout?eventId=${eventId}`);

  await expect(page.getByRole('heading', { name: eventTitle })).toBeVisible();
  await page.getByRole('button', { name: `Increase ${ticketName} quantity` }).click();
  await page.getByRole('button', { name: `Increase ${productName} quantity` }).click();
  await page.getByLabel('Email').fill(buyerEmail);
  await page.getByLabel('First name').fill('Export');
  await page.getByLabel('Last name').fill('Buyer');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('button', { name: 'Place free order' })).toBeVisible();
  await page.getByRole('button', { name: 'Place free order' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

  const confirmationUrl = new URL(page.url());
  const sessionId = confirmationUrl.searchParams.get('sessionId');
  const orderId = confirmationUrl.searchParams.get('orderId');
  expect(sessionId).toEqual(expect.any(String));
  expect(orderId).toEqual(expect.any(String));

  return { sessionId: sessionId!, orderId: orderId! };
}

async function completeSeededPromoCheckout(
  page: Page,
  eventId: string,
  eventTitle: string,
  ticketName: string,
  promoCode: string,
  buyerEmail: string,
): Promise<{ sessionId: string; orderId: string }> {
  await page.goto(`${checkoutBaseUrl}/checkout?eventId=${eventId}`);

  await expect(page.getByRole('heading', { name: eventTitle })).toBeVisible();
  await page.getByRole('button', { name: `Increase ${ticketName} quantity` }).click();
  await page.getByLabel('Promo code').fill(promoCode);
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(`Promo code ${promoCode} applied`)).toBeVisible();
  await page.getByLabel('Email').fill(buyerEmail);
  await page.getByLabel('First name').fill('Promo');
  await page.getByLabel('Last name').fill('Reporter');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Discount')).toBeVisible();
  await expect(page.getByText('-$5.00')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();
  await page.getByRole('button', { name: /I understand — update my selection/ }).click();
  await page.getByRole('button', { name: 'Pay $20.00' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

  const confirmationUrl = new URL(page.url());
  const sessionId = confirmationUrl.searchParams.get('sessionId');
  const orderId = confirmationUrl.searchParams.get('orderId');
  expect(sessionId).toEqual(expect.any(String));
  expect(orderId).toEqual(expect.any(String));

  return { sessionId: sessionId!, orderId: orderId! };
}

test.describe('admin export workflow coverage', () => {
  test('admin can generate and download every supported event export', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    const buyerEmail = `export-workflow+${suffix}@example.com`;

    await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      buyerEmail,
    );

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(
      page.getByText('Sales, tax, and attendance analytics for this event'),
    ).toBeVisible();

    const salesReport = await expectJsonStatus<{
      eventId: string;
      ticketsSold: number;
      grossSalesCents: number;
      netRevenueCents: number;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${event.id}/reports/sales`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(salesReport.eventId).toBe(event.id);
    expect(salesReport.ticketsSold).toBe(1);

    const conversionReport = await expectJsonStatus<{
      eventId: string;
      widgetViews: number;
      checkoutStarted: number;
      checkoutCompleted: number;
      conversionRate: number;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${event.id}/reports/conversion`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(conversionReport.eventId).toBe(event.id);
    expect(conversionReport.widgetViews).toBe(0);
    expect(conversionReport.checkoutCompleted).toBeGreaterThanOrEqual(1);

    await page.getByRole('tab', { name: 'Conversion' }).click();
    await expect(page.getByText('Conversion rate')).toBeVisible();
    await expect(page.getByText('0', { exact: true })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-conversion-untracked-desktop');

    for (const exportCase of exportCases) {
      const createExportResponse = page.waitForResponse(
        (response) =>
          response.url() === `${apiBaseUrl}/v1/exports` && response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: exportCase.buttonName }).click();

      const queuedExport = await expectJsonStatus<{
        exportId: string;
        status: string;
      }>(await createExportResponse, 202);
      expect(queuedExport.status).toBe('pending');

      await expect(
        page.getByText(
          `${exportCase.statusLabel} CSV export ${queuedExport.exportId} is completed.`,
        ),
      ).toBeVisible({ timeout: 60_000 });

      const downloadLink = page.getByRole('link', { name: 'Download' });
      await expect(downloadLink).toBeVisible();
      const href = await downloadLink.getAttribute('href');
      expect(href).toBe(`${apiBaseUrl}/v1/exports/${queuedExport.exportId}/download`);

      const completedExport = await expectJsonStatus<{
        exportId: string;
        eventId: string;
        type: string;
        format: string;
        status: string;
        downloadUrl?: string;
        fileUrl?: string;
      }>(
        await page.request.get(`${apiBaseUrl}/v1/exports/${queuedExport.exportId}`, {
          failOnStatusCode: false,
        }),
        200,
      );
      expect(completedExport.eventId).toBe(event.id);
      expect(completedExport.type).toBe(exportCase.type);
      expect(completedExport.format).toBe('csv');
      expect(completedExport.status).toBe('completed');
      expect(completedExport.downloadUrl).toBe(`/v1/exports/${queuedExport.exportId}/download`);
      expect(completedExport.fileUrl).toBeUndefined();

      const redirectResponse = await fetch(href!, { redirect: 'manual' });
      expect(redirectResponse.status).toBe(302);
      expect(redirectResponse.headers.get('location')).toContain(
        `/exports/${queuedExport.exportId}.csv`,
      );
    }

    await attachScreenshot(page, testInfo, 'admin-export-completed-desktop');
    await waitForToastNotificationsToDismiss(page);
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin reports render promo and affiliate browser edge states', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `report-edge-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool, discountCode } = await seedPaidPromoCheckoutEvent(
      request,
      suffix,
    );
    const buyerEmail = `report-edge+${suffix}@example.com`;

    const completed = await completeSeededPromoCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      discountCode.code,
      buyerEmail,
    );
    const state = await readPromoCheckoutCaptureState(
      completed.sessionId,
      inventoryPool.id,
      discountCode.id,
    );
    expect(state.order).toMatchObject({
      id: completed.orderId,
      subtotalCents: 2_500,
      discountCents: 500,
      totalCents: 2_000,
    });

    const affiliate = await seedAffiliateAttributionForOrder(completed.orderId, suffix);

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

    const promoReport = await expectJsonStatus<{
      eventId: string;
      discountCodes: Array<{
        code: string;
        usesCount: number;
        discountAmountCents: number;
        revenueAttributedCents: number;
      }>;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${event.id}/reports/promo`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(promoReport.discountCodes).toContainEqual({
      code: discountCode.code,
      usesCount: 1,
      discountAmountCents: 500,
      revenueAttributedCents: 2_000,
    });

    await page.getByRole('tab', { name: 'Promo' }).click();
    await expect(page.getByText(discountCode.code)).toBeVisible();
    await expect(page.getByRole('row', { name: /SAVE20 1 \$5\.00 \$20\.00/ })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-promo-report-edge-state');

    const affiliateReport = await expectJsonStatus<{
      organizationId: string;
      affiliates: Array<{
        code: string;
        name: string;
        referralsCount: number;
        revenueAttributedCents: number;
        commissionCents: number;
      }>;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/organizations/org_dev_local/reports/affiliate`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(affiliateReport.affiliates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: affiliate.affiliate.code,
          name: affiliate.affiliate.name,
          referralsCount: 1,
          revenueAttributedCents: 2_000,
          commissionCents: affiliate.affiliate.commissionCents,
        }),
      ]),
    );

    await page.getByRole('tab', { name: 'Affiliate' }).click();
    await expect(
      page.getByText('Choose a workspace before loading affiliate reporting.'),
    ).toBeVisible();
    await page.getByRole('combobox', { name: 'Select workspace' }).click();
    await page.getByRole('option', { name: 'Tixkit Dev' }).click();
    await expect(page.getByText(affiliate.affiliate.name)).toBeVisible();
    await expect(page.getByText(affiliate.affiliate.code)).toBeVisible();
    await expect(
      page.getByRole('row', {
        name: new RegExp(
          `${affiliate.affiliate.name} ${affiliate.affiliate.code} 1 \\$20\\.00 \\$2\\.00`,
        ),
      }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-affiliate-report-edge-state');
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin reports show retryable affiliate workspace load failures', async ({
    consoleErrors,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    await page.route(`${apiBaseUrl}/v1/organizations`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'workspace_unavailable',
            message: 'Workspaces unavailable',
          },
        }),
      });
    });

    for (const viewport of [
      { name: 'desktop', size: { width: 1280, height: 900 } },
      { name: 'mobile', size: mobileReportViewport },
    ]) {
      await page.setViewportSize(viewport.size);
      await page.goto(`${adminBaseUrl}/reports`);
      await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

      await page.getByRole('tab', { name: 'Affiliate' }).click();

      const affiliatePanel = page.getByLabel('Affiliate');
      await expect(page.getByText('Unable to load workspaces')).toBeVisible();
      await expect(affiliatePanel.getByText('Workspaces unavailable')).toBeVisible();
      await expect(affiliatePanel.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(
        affiliatePanel.getByText('Choose a workspace before loading affiliate reporting.'),
      ).toBeHidden();
      await attachScreenshot(
        page,
        testInfo,
        `admin-affiliate-workspace-load-error-${viewport.name}`,
      );
    }

    for (let index = consoleErrors.length - 1; index >= 0; index -= 1) {
      if (
        consoleErrors[index].includes('Failed to load resource') &&
        consoleErrors[index].includes('/v1/organizations')
      ) {
        consoleErrors.splice(index, 1);
      }
    }

    await expectNoAxeViolations(page, testInfo);
  });

  test('admin reports render tax and attendance browser edge states', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `report-tax-attendance-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    const buyerEmail = `report-tax-attendance+${suffix}@example.com`;

    const completed = await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      buyerEmail,
    );
    await resignTicketsForOnlineScan(completed.orderId);
    const taxSnapshot = await seedTaxSnapshotForOrder({
      eventId: event.id,
      orderId: completed.orderId,
      suffix,
    });
    const checkInList = await seedCheckInListForOrder({
      eventId: event.id,
      orderId: completed.orderId,
      suffix,
    });
    const [checkedInTicket] = checkInList.tickets;
    const scanResult = await expectJsonStatus<{
      outcome: string;
      ticketId?: string;
      message: string;
    }>(
      await request.post(`${apiBaseUrl}/v1/check-ins/scan`, {
        headers: { 'idempotency-key': `report-attendance-scan-${suffix}` },
        data: {
          checkInListId: checkInList.id,
          qrPayload: checkedInTicket.qrPayload,
          scannedAt: '2026-06-27T12:00:00.000Z',
          deviceId: `report-attendance-${testInfo.workerIndex}`,
        },
      }),
      200,
    );
    expect(scanResult).toMatchObject({
      outcome: 'accepted',
      ticketId: checkedInTicket.id,
      message: 'Check-in successful',
    });

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

    const taxReport = await expectJsonStatus<{
      eventId: string;
      totalTaxCollectedCents: number;
      breakdown: Array<{
        taxRuleName: string;
        rate: number | null;
        taxableAmountCents: number;
        taxCollectedCents: number;
      }>;
    }>(
      await page.request.get(`${apiBaseUrl}/v1/events/${event.id}/reports/tax`, {
        failOnStatusCode: false,
      }),
      200,
    );
    expect(taxReport).toMatchObject({
      eventId: event.id,
      totalTaxCollectedCents: taxSnapshot.taxCollectedCents,
    });
    expect(taxReport.breakdown).toContainEqual({
      taxRuleName: taxSnapshot.taxRule.name,
      rate: taxSnapshot.taxRule.rate,
      taxableAmountCents: taxSnapshot.taxableAmountCents,
      taxCollectedCents: taxSnapshot.taxCollectedCents,
    });

    await page.getByRole('tab', { name: 'Tax' }).click();
    await expect(page.getByText(taxSnapshot.taxRule.name)).toBeVisible();
    await expect(
      page.getByRole('row', {
        name: new RegExp(`${taxSnapshot.taxRule.name} 8\\.3% \\$40\\.00 \\$3\\.30`),
      }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-tax-report-edge-state');

    const attendanceReport = await expectCheckedInAttendanceReport(page, event.id, ticketType.name);
    expect(attendanceReport).toMatchObject({
      eventId: event.id,
      totalAttendees: 1,
      checkedIn: 1,
      notCheckedIn: 0,
      checkInRate: 1,
    });
    expect(attendanceReport.breakdownByTicketType).toContainEqual(
      expect.objectContaining({
        ticketTypeName: ticketType.name,
        total: 1,
        checkedIn: 1,
      }),
    );

    await page.getByRole('tab', { name: 'Attendance' }).click();
    await expect(page.getByText('Check-in Rate')).toBeVisible();
    await expect(
      page.getByRole('row', {
        name: new RegExp(`${ticketType.name} 1 1 100%`),
      }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-attendance-report-edge-state');
    await expectNoAxeViolations(page, testInfo);
  });

  test('admin reports stay usable on mobile viewport', async ({ page, request }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    await page.setViewportSize(mobileReportViewport);

    const suffix = `report-mobile-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    const buyerEmail = `report-mobile+${suffix}@example.com`;

    const completed = await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      buyerEmail,
    );
    await resignTicketsForOnlineScan(completed.orderId);
    const taxSnapshot = await seedTaxSnapshotForOrder({
      eventId: event.id,
      orderId: completed.orderId,
      suffix,
    });
    const checkInList = await seedCheckInListForOrder({
      eventId: event.id,
      orderId: completed.orderId,
      suffix,
    });
    const [checkedInTicket] = checkInList.tickets;
    const scanResult = await expectJsonStatus<{
      outcome: string;
      ticketId?: string;
      message: string;
    }>(
      await request.post(`${apiBaseUrl}/v1/check-ins/scan`, {
        headers: { 'idempotency-key': `report-mobile-scan-${suffix}` },
        data: {
          checkInListId: checkInList.id,
          qrPayload: checkedInTicket.qrPayload,
          scannedAt: '2026-06-27T12:05:00.000Z',
          deviceId: `report-mobile-${testInfo.workerIndex}`,
        },
      }),
      200,
    );
    expect(scanResult).toMatchObject({
      outcome: 'accepted',
      ticketId: checkedInTicket.id,
      message: 'Check-in successful',
    });
    await expectCheckedInAttendanceReport(page, event.id, ticketType.name);

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expect(
      page.getByText('Sales, tax, and attendance analytics for this event'),
    ).toBeVisible();
    await expect(page.getByRole('tablist')).toBeVisible();

    await page.getByRole('tab', { name: 'Sales' }).click();
    await expect(page.getByText('Tickets Sold')).toBeVisible();
    await expect(page.getByText('Gross Sales')).toBeVisible();
    await expect(page.getByText('Online Sales')).toBeVisible();
    await expect(page.getByText('Box Office')).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-mobile-sales');

    await page.getByRole('tab', { name: 'Tax' }).click();
    await expect(page.getByText(taxSnapshot.taxRule.name)).toBeVisible();
    await expect(
      page.getByRole('row', {
        name: new RegExp(`${taxSnapshot.taxRule.name} 8\\.3% \\$40\\.00 \\$3\\.30`),
      }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-mobile-tax');

    await page.getByRole('tab', { name: 'Attendance' }).click();
    await expect(page.getByText('Check-in Rate')).toBeVisible();
    await expect(
      page.getByRole('row', {
        name: new RegExp(`${ticketType.name} 1 1 100%`),
      }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-mobile-attendance');

    await page.getByRole('tab', { name: 'Conversion' }).click();
    await expect(page.getByText('Conversion rate')).toBeVisible();
    await expect(page.getByText('0', { exact: true })).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-reports-mobile-conversion');

    await expectNoAxeViolations(page, testInfo);
  });

  test('admin sales report channel cards expose Chromium CDP layout metrics', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `report-channel-cdp-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, product } = await seedFreeCheckoutEvent(request, suffix);
    await completeSeededFreeCheckout(
      page,
      event.id,
      event.title,
      ticketType.name,
      product.name,
      `report-channel-cdp+${suffix}@example.com`,
    );

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await page.getByRole('tab', { name: 'Sales' }).click();
    await expect(page.getByText('Online Sales')).toBeVisible();
    await expect(page.getByText('Box Office')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await attachScreenshot(page, testInfo, 'admin-reports-channel-cdp');

    const client = await page.context().newCDPSession(page);
    const evaluation = await client.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const titles = ['Online Sales', 'Box Office'];
        return Object.fromEntries(titles.map((title) => {
          const titleNode = Array.from(document.querySelectorAll('[data-slot="card-title"]'))
            .find((node) => node.textContent?.trim() === title);
          const card = titleNode?.closest('[data-slot="card"]');
          const rect = card?.getBoundingClientRect();
          return [title, rect ? {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            top: rect.top,
          } : null];
        }));
      })()`,
    });
    const metrics = evaluation.result.value as Record<
      string,
      { width: number; height: number; left: number; top: number } | null
    >;

    expect(metrics['Online Sales']).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(metrics['Box Office']).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number),
    });
    expect(metrics['Online Sales']?.width).toBeGreaterThan(140);
    expect(metrics['Online Sales']?.height).toBeGreaterThan(80);
    expect(metrics['Box Office']?.width).toBeGreaterThan(140);
    expect(metrics['Box Office']?.height).toBeGreaterThan(80);
  });
});
