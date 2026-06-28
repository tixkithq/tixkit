import type { APIResponse, APIRequestContext, Page, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { readCheckoutOrderState, seedTicketVariantCheckoutEvent } from './helpers/seed';
import { expect, requireReachable, test } from './fixtures/validation-test';

type CheckoutSessionResponse = {
  id: string;
  clientToken: string;
  quote: { totalCents: number; currency: string };
  status: string;
};

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectJsonResponse(response: APIResponse, expectedStatus: number) {
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body;
}

async function createCheckoutSession(
  request: APIRequestContext,
  input: {
    suffix: string;
    label: string;
    eventId: string;
    items: Array<{ ticketTypeId: string; quantity: number; unitAmountCents?: number }>;
    accessCode?: string;
  },
): Promise<CheckoutSessionResponse> {
  return (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
      headers: { 'idempotency-key': `variant-session-${input.label}-${input.suffix}` },
      data: {
        eventId: input.eventId,
        items: input.items,
        accessCode: input.accessCode,
        buyer: {
          email: `variant-${input.label}+${input.suffix}@example.com`,
          firstName: 'Variant',
          lastName: 'Buyer',
        },
      },
    }),
    201,
  )) as CheckoutSessionResponse;
}

async function confirmCheckoutSession(
  request: APIRequestContext,
  input: { suffix: string; label: string; session: CheckoutSessionResponse },
) {
  return expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions/${input.session.id}/confirm`, {
      headers: {
        'idempotency-key': `variant-confirm-${input.label}-${input.suffix}`,
        'x-checkout-session-token': input.session.clientToken,
      },
      data: { paymentMethodId: 'pm_card_visa' },
    }),
    200,
  ) as Promise<{ status: string; sessionId: string; order: { id: string; status: string } }>;
}

test.describe('checkout ticket variant workflows', () => {
  test('validates hidden, locked, donation, and shared-pool ticket purchases through public checkout APIs', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `variants-${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedTicketVariantCheckoutEvent(request, suffix);

    const publicAvailability = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/public/events/${seeded.event.id}/availability`),
      200,
    )) as Array<{ ticketTypeId?: string; name: string; kind: string; minimumPriceCents?: number }>;
    const publicIds = new Set(publicAvailability.map((item) => item.ticketTypeId).filter(Boolean));
    expect(publicIds.has(seeded.tickets.public.id)).toBe(true);
    expect(publicIds.has(seeded.tickets.donation.id)).toBe(true);
    expect(publicIds.has(seeded.tickets.sharedA.id)).toBe(true);
    expect(publicIds.has(seeded.tickets.sharedB.id)).toBe(true);
    expect(publicIds.has(seeded.tickets.hidden.id)).toBe(false);
    expect(publicIds.has(seeded.tickets.locked.id)).toBe(false);

    const directAvailability = (await expectJsonResponse(
      await request.get(
        `${apiBaseUrl}/v1/public/events/${seeded.event.id}/availability?products=${seeded.tickets.hidden.id},${seeded.tickets.locked.id}`,
      ),
      200,
    )) as Array<{ ticketTypeId?: string; requiresAccessCode?: boolean; accessCodeHint?: string }>;
    const directIds = new Set(directAvailability.map((item) => item.ticketTypeId).filter(Boolean));
    expect(directIds.has(seeded.tickets.hidden.id)).toBe(true);
    expect(directIds.has(seeded.tickets.locked.id)).toBe(true);
    expect(
      directAvailability.find((item) => item.ticketTypeId === seeded.tickets.locked.id),
    ).toMatchObject({
      requiresAccessCode: true,
      accessCodeHint: 'Use the invited buyer code',
    });

    const hiddenSession = await createCheckoutSession(request, {
      suffix,
      label: 'hidden',
      eventId: seeded.event.id,
      items: [{ ticketTypeId: seeded.tickets.hidden.id, quantity: 1 }],
    });
    await confirmCheckoutSession(request, { suffix, label: 'hidden', session: hiddenSession });
    expect(await readCheckoutOrderState(hiddenSession.id, seeded.pools.hidden.id)).toMatchObject({
      session: { status: 'completed' },
      order: { status: 'paid', totalCents: 0 },
      holds: [{ ticketTypeId: seeded.tickets.hidden.id, status: 'converted', quantity: 1 }],
      inventoryPool: { soldCount: 1 },
      ticketCount: 1,
    });

    const lockedWithoutCode = await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
      headers: { 'idempotency-key': `variant-session-locked-missing-${suffix}` },
      data: {
        eventId: seeded.event.id,
        items: [{ ticketTypeId: seeded.tickets.locked.id, quantity: 1 }],
        buyer: { email: `locked-missing+${suffix}@example.com` },
      },
    });
    expect(lockedWithoutCode.status()).toBe(403);
    expect(JSON.stringify(await lockedWithoutCode.json())).toContain('ACCESS_CODE_REQUIRED');

    const invalidCode = await request.post(
      `${apiBaseUrl}/v1/public/events/${seeded.event.id}/access-code`,
      {
        data: {
          ticketTypeIds: [seeded.tickets.locked.id],
          accessCode: 'WRONG-CODE',
          buyerEmail: `locked+${suffix}@example.com`,
        },
      },
    );
    expect(invalidCode.status()).toBe(400);

    const validCode = await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/public/events/${seeded.event.id}/access-code`, {
        data: {
          ticketTypeIds: [seeded.tickets.locked.id],
          accessCode: seeded.accessCode,
          buyerEmail: `locked+${suffix}@example.com`,
        },
      }),
      200,
    );
    expect(validCode).toMatchObject({ valid: true, ticketTypeIds: [seeded.tickets.locked.id] });

    const lockedSession = await createCheckoutSession(request, {
      suffix,
      label: 'locked',
      eventId: seeded.event.id,
      accessCode: seeded.accessCode,
      items: [{ ticketTypeId: seeded.tickets.locked.id, quantity: 1 }],
    });
    await confirmCheckoutSession(request, { suffix, label: 'locked', session: lockedSession });
    expect(await readCheckoutOrderState(lockedSession.id, seeded.pools.locked.id)).toMatchObject({
      session: { status: 'completed' },
      order: { status: 'paid', totalCents: 0 },
      holds: [{ ticketTypeId: seeded.tickets.locked.id, status: 'converted', quantity: 1 }],
      inventoryPool: { soldCount: 1 },
      ticketCount: 1,
    });

    const belowMinimumDonation = await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
      headers: { 'idempotency-key': `variant-session-donation-low-${suffix}` },
      data: {
        eventId: seeded.event.id,
        items: [{ ticketTypeId: seeded.tickets.donation.id, quantity: 1, unitAmountCents: 499 }],
        buyer: { email: `donation-low+${suffix}@example.com` },
      },
    });
    expect(belowMinimumDonation.status()).toBe(400);
    expect(JSON.stringify(await belowMinimumDonation.json())).toContain(
      'requires at least 500 cents',
    );

    const donationSession = await createCheckoutSession(request, {
      suffix,
      label: 'donation',
      eventId: seeded.event.id,
      items: [{ ticketTypeId: seeded.tickets.donation.id, quantity: 1, unitAmountCents: 500 }],
    });
    expect(donationSession.quote).toMatchObject({ totalCents: 500, currency: 'USD' });
    await confirmCheckoutSession(request, { suffix, label: 'donation', session: donationSession });
    expect(
      await readCheckoutOrderState(donationSession.id, seeded.pools.donation.id),
    ).toMatchObject({
      session: { status: 'completed' },
      order: { status: 'paid', totalCents: 500 },
      holds: [{ ticketTypeId: seeded.tickets.donation.id, status: 'converted', quantity: 1 }],
      inventoryPool: { soldCount: 1 },
      ticketCount: 1,
    });

    const sharedSession = await createCheckoutSession(request, {
      suffix,
      label: 'shared',
      eventId: seeded.event.id,
      items: [
        { ticketTypeId: seeded.tickets.sharedA.id, quantity: 1 },
        { ticketTypeId: seeded.tickets.sharedB.id, quantity: 1 },
      ],
    });
    await confirmCheckoutSession(request, { suffix, label: 'shared', session: sharedSession });
    expect(await readCheckoutOrderState(sharedSession.id, seeded.pools.shared.id)).toMatchObject({
      session: { status: 'completed' },
      order: { status: 'paid', totalCents: 0 },
      holds: [
        { ticketTypeId: seeded.tickets.sharedA.id, status: 'converted', quantity: 1 },
        { ticketTypeId: seeded.tickets.sharedB.id, status: 'converted', quantity: 1 },
      ],
      inventoryPool: { soldCount: 2 },
      ticketCount: 2,
    });
  });

  test('hosted checkout renders and enforces ticket variant controls', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `variants-ui-${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedTicketVariantCheckoutEvent(request, suffix);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${seeded.event.id}`);
    await expect(page.getByRole('heading', { name: seeded.event.title })).toBeVisible();
    await expect(page.getByText(seeded.tickets.public.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.donation.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.minimumPair.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.sharedA.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.sharedB.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.soldOut.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.hidden.name)).toHaveCount(0);
    await expect(page.getByText(seeded.tickets.locked.name)).toHaveCount(0);

    const soldOutQuantity = page.getByRole('group', {
      name: `${seeded.tickets.soldOut.name} quantity`,
    });
    await expect(
      soldOutQuantity.getByRole('button', {
        name: `Increase ${seeded.tickets.soldOut.name} quantity`,
      }),
    ).toBeDisabled();
    await expect(page.getByText('Sold out', { exact: true })).toBeVisible();

    const minimumPairQuantity = page.getByRole('group', {
      name: `${seeded.tickets.minimumPair.name} quantity`,
    });
    await minimumPairQuantity
      .getByRole('button', { name: `Increase ${seeded.tickets.minimumPair.name} quantity` })
      .click();
    await expect(minimumPairQuantity.locator('output')).toHaveText('2');
    await expect(
      minimumPairQuantity.getByRole('button', {
        name: `Increase ${seeded.tickets.minimumPair.name} quantity`,
      }),
    ).toBeDisabled();
    await minimumPairQuantity
      .getByRole('button', { name: `Decrease ${seeded.tickets.minimumPair.name} quantity` })
      .click();
    await expect(minimumPairQuantity.locator('output')).toHaveText('0');

    await page.getByLabel(`Donation amount for ${seeded.tickets.donation.name}`).fill('4.99');
    await expect(page.getByText('Minimum $5.00')).toBeVisible();
    await page.getByLabel(`Donation amount for ${seeded.tickets.donation.name}`).fill('5.00');

    await attachScreenshot(page, testInfo, 'checkout-ticket-variants-public');
    await expectNoAxeViolations(page, testInfo);

    const sharedAQuantity = page.getByRole('group', {
      name: `${seeded.tickets.sharedA.name} quantity`,
    });
    const sharedBQuantity = page.getByRole('group', {
      name: `${seeded.tickets.sharedB.name} quantity`,
    });
    await sharedAQuantity
      .getByRole('button', { name: `Increase ${seeded.tickets.sharedA.name} quantity` })
      .click();
    await sharedBQuantity
      .getByRole('button', { name: `Increase ${seeded.tickets.sharedB.name} quantity` })
      .click();
    await page.getByLabel('Email').fill(`variants-shared+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Shared');
    await page.getByLabel('Last name').fill('Buyer');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Place free order' })).toBeVisible();
    await page.getByRole('button', { name: 'Place free order' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

    await page.goto(
      `${checkoutBaseUrl}/checkout?eventId=${seeded.event.id}&products=${seeded.tickets.hidden.id},${seeded.tickets.locked.id}`,
    );
    await expect(page.getByText(seeded.tickets.hidden.name)).toBeVisible();
    await expect(page.getByText(seeded.tickets.locked.name)).toBeVisible();
    await expect(page.getByText('Access code required')).toBeVisible();
    await expect(page.getByText('Use the invited buyer code')).toBeVisible();

    const lockedQuantity = page.getByRole('group', {
      name: `${seeded.tickets.locked.name} quantity`,
    });
    await expect(
      lockedQuantity.getByRole('button', {
        name: `Increase ${seeded.tickets.locked.name} quantity`,
      }),
    ).toBeDisabled();
    await page.getByLabel('Access code').fill(seeded.accessCode);
    await page.getByRole('button', { name: 'Apply' }).first().click();
    await expect(page.getByText('Access code verified')).toBeVisible();
    await lockedQuantity
      .getByRole('button', { name: `Increase ${seeded.tickets.locked.name} quantity` })
      .click();
    await expect(lockedQuantity.locator('output')).toHaveText('1');

    const hiddenQuantity = page.getByRole('group', {
      name: `${seeded.tickets.hidden.name} quantity`,
    });
    await hiddenQuantity
      .getByRole('button', { name: `Increase ${seeded.tickets.hidden.name} quantity` })
      .click();
    await expect(hiddenQuantity.locator('output')).toHaveText('1');
    await page.getByLabel('Email').fill(`variants-ui+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Variant');
    await page.getByLabel('Last name').fill('Buyer');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Place free order' })).toBeVisible();
    await page.getByRole('button', { name: 'Place free order' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

    await attachScreenshot(page, testInfo, 'checkout-ticket-variants-direct-complete');
  });
});
