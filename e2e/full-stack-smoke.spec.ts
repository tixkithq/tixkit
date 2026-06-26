import { expect, test, type APIRequestContext } from '@playwright/test';

const apiUrl = process.env.GATEKIT_API_URL ?? 'http://localhost:4200';
const checkoutUrl = process.env.CHECKOUT_URL ?? 'http://localhost:3201';
const devOrganizationId = 'org_dev_local';
const devBrandId = 'brd_dev_local';

type SeededCheckoutEvent = {
  event: { id: string; title: string };
  ticketType: { id: string; name: string };
};

async function expectJsonResponse(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
  expectedStatus: number,
) {
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body;
}

async function seedFreeCheckoutEvent(
  request: APIRequestContext,
  suffix: string,
): Promise<SeededCheckoutEvent> {
  const eventTitle = `E2E Checkout ${suffix}`;
  const event = (await expectJsonResponse(
    await request.post(`${apiUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-checkout-${suffix}`,
        title: eventTitle,
        description: 'Seeded by Playwright for hosted checkout coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-07-15T23:00:00.000Z',
        endsAt: '2026-07-16T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  )) as { id: string; title: string };

  const pool = (await expectJsonResponse(
    await request.post(`${apiUrl}/v1/events/${event.id}/inventory-pools`, {
      data: {
        name: 'General admission',
        totalCapacity: 25,
        holdTtlSeconds: 600,
      },
    }),
    201,
  )) as { id: string };

  const ticketType = (await expectJsonResponse(
    await request.post(`${apiUrl}/v1/events/${event.id}/ticket-types`, {
      data: {
        name: 'General Admission',
        kind: 'free',
        visibility: 'public',
        currency: 'USD',
        priceCents: 0,
        inventoryPoolId: pool.id,
        minPerOrder: 1,
        maxPerOrder: 4,
      },
    }),
    201,
  )) as { id: string; name: string };

  await expectJsonResponse(
    await request.post(`${apiUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );

  return { event, ticketType };
}

test.describe('full-stack smoke', () => {
  test('API health endpoint responds from the Playwright stack', async ({ request }) => {
    const response = await request.get(`${apiUrl}/health`);
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  test('hosted checkout root renders without crashing', async ({ page }) => {
    await page.goto(checkoutUrl);

    await expect(page).toHaveTitle(/GateKit|Checkout|Ticket/i);
    await expect(page.getByText('No event selected')).toBeVisible();
  });

  test('hosted checkout accepts event query entry points', async ({ page }) => {
    await page.goto(`${checkoutUrl}/checkout?eventId=evt_missing_smoke`);

    await expect(page.locator('body')).toBeVisible();
    await expect(page).toHaveURL(/\/checkout\?eventId=evt_missing_smoke/);
  });

  test('hosted checkout completes a seeded public free order', async ({
    page,
    request,
  }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedFreeCheckoutEvent(request, suffix);

    await page.goto(`${checkoutUrl}/checkout?eventId=${event.id}`);

    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByText(ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByText('Free', { exact: true })).toBeVisible();

    await page
      .getByRole('button', { name: `Increase ${ticketType.name} quantity` })
      .click();
    await page.getByLabel('Email').fill(`buyer+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Playwright');
    await page.getByLabel('Last name').fill('Buyer');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('button', { name: 'Edit order' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Place free order' }),
    ).toBeVisible();
    await expect(page.getByText(/Session reserved until/)).toBeVisible();

    await page.getByRole('button', { name: 'Place free order' }).click();

    await expect(page).toHaveURL(/\/checkout\/confirmation\?/);
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await expect(page.getByText('What happens next')).toBeVisible();
    await expect(page.getByText('Confirmation email sent')).toBeVisible();
    await expect(page.getByText('Ticket delivery')).toBeVisible();
  });
});
