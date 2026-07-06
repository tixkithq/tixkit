import { test, expect, requireReachable } from './fixtures/validation-test';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { seedPaidCheckoutEvent } from './helpers/seed';

/**
 * Regression guard for the events list sales-stats contract.
 *
 * A prior bug caused serializeEvent to omit grossSalesCents, ticketsSold, and
 * checkIns entirely, so both GET /v1/events and GET /v1/events/:eventId
 * returned zeros. The dashboard overview reduces over these fields, so the
 * stats cards were always $0 / 0. The sales report endpoint was tested but the
 * events list endpoint was not, which is why the regression slipped through.
 *
 * This test creates a published event with a paid ticket type, places a
 * box-office order, then verifies that the events list and detail endpoints
 * return non-zero sales stats.
 */
test.describe('events list sales stats', () => {
  test('GET /v1/events returns non-zero grossSalesCents and ticketsSold after a box-office order', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `sales-stats-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedPaidCheckoutEvent(request, suffix);

    // Place a box-office cash order for 1 ticket at $25.00.
    const orderRes = await request.post(
      `${apiBaseUrl}/v1/events/${event.id}/box-office/orders`,
      {
        headers: { 'Idempotency-Key': `e2e-sales-stats-${suffix}` },
        data: {
          tenderType: 'cash',
          amountCents: 2500,
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          buyer: {
            email: `sales-stats-${suffix}@example.com`,
            firstName: 'Sales',
            lastName: 'Stats',
          },
          notes: `E2E sales stats ${suffix}`,
        },
        failOnStatusCode: false,
      },
    );
    const orderBody = await orderRes.json();
    expect(orderRes.status(), JSON.stringify(orderBody, null, 2)).toBe(201);

    // Verify GET /v1/events includes the event with non-zero stats.
    // Use the search parameter to find the specific event, since the list is
    // ordered by id ASC and the new event's ULID may sort beyond the first page.
    const listRes = await request.get(
      `${apiBaseUrl}/v1/events?search=${encodeURIComponent(suffix)}`,
      { failOnStatusCode: false },
    );
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const listEvent = listBody.items.find(
      (e: { id: string }) => e.id === event.id,
    );
    expect(listEvent, 'seeded event should appear in events list').toBeDefined();
    expect(listEvent.grossSalesCents, 'grossSalesCents should be non-zero in list').toBeGreaterThan(0);
    expect(listEvent.ticketsSold, 'ticketsSold should be non-zero in list').toBeGreaterThanOrEqual(1);

    // Verify GET /v1/events/:eventId also returns non-zero stats.
    const detailRes = await request.get(`${apiBaseUrl}/v1/events/${event.id}`, {
      failOnStatusCode: false,
    });
    expect(detailRes.status()).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.grossSalesCents, 'grossSalesCents should be non-zero in detail').toBeGreaterThan(0);
    expect(detailBody.ticketsSold, 'ticketsSold should be non-zero in detail').toBeGreaterThanOrEqual(1);
  });

  test('dashboard overview displays non-zero sales stats after a box-office order', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    // Skip if the admin server is Clerk-enabled (returns 404 or redirects to sign-in).
    const adminCheck = await request.get(`${adminBaseUrl}/dashboard`, {
      failOnStatusCode: false,
    });
    const adminPath = new URL(adminCheck.url()).pathname;
    if (
      adminCheck.status() === 404 ||
      (adminCheck.status() >= 300 && adminCheck.status() < 400) ||
      adminPath.includes('/sign-in') ||
      adminPath.includes('/sign-up')
    ) {
      test.skip(true, 'runtime admin server is Clerk-enabled; dashboard UI is unit-tested');
    }

    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    const suffix = `sales-stats-dashboard-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedPaidCheckoutEvent(request, suffix);

    // Place a box-office cash order for 1 ticket at $25.00.
    const orderRes = await request.post(
      `${apiBaseUrl}/v1/events/${event.id}/box-office/orders`,
      {
        headers: { 'Idempotency-Key': `e2e-sales-stats-dash-${suffix}` },
        data: {
          tenderType: 'cash',
          amountCents: 2500,
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          buyer: {
            email: `sales-stats-dash-${suffix}@example.com`,
            firstName: 'Sales',
            lastName: 'Dashboard',
          },
          notes: `E2E sales stats dashboard ${suffix}`,
        },
        failOnStatusCode: false,
      },
    );
    expect(orderRes.status(), JSON.stringify(await orderRes.json(), null, 2)).toBe(201);

    // Navigate to the dashboard overview and verify stats cards show non-zero values.
    await page.goto(`${adminBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    // Wait for the stats cards to render (not skeletons).
    const grossSalesCard = page.locator('[data-slot="card"]').filter({ hasText: 'Gross Sales' });
    await expect(grossSalesCard).toBeVisible();
    const grossSalesValue = grossSalesCard.locator('.text-2xl');
    await expect(grossSalesValue).toBeVisible();
    // The Gross Sales value should not be $0.00 after a box-office order.
    await expect(grossSalesValue).not.toHaveText('$0.00');

    // The Tickets Sold value should not be 0 after a box-office order.
    const ticketsSoldCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: 'Tickets Sold' });
    await expect(ticketsSoldCard).toBeVisible();
    const ticketsSoldValue = ticketsSoldCard.locator('.text-2xl');
    await expect(ticketsSoldValue).toBeVisible();
    await expect(ticketsSoldValue).not.toHaveText('0');
  });
});
