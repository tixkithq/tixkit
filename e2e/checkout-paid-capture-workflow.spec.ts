import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  readPromoCheckoutCaptureState,
  readPaidCheckoutCaptureState,
  seedPaidCheckoutEvent,
  seedPaidPromoCheckoutEvent,
} from './helpers/seed';
import { expect, requireReachable, test } from './fixtures/validation-test';

async function expectJsonResponse(response: APIResponse, expectedStatus: number) {
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

test.describe('paid checkout capture workflow', () => {
  test('completes a paid order through the API, Temporal workflow, and local capture provider', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `paid-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);

    const session = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
        headers: { 'idempotency-key': `paid-session-${suffix}` },
        data: {
          eventId: event.id,
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          buyer: {
            email: `paid-checkout+${suffix}@example.com`,
            firstName: 'Paid',
            lastName: 'Buyer',
          },
        },
      }),
      201,
    )) as {
      id: string;
      clientToken: string;
      quote: { totalCents: number; currency: string };
      status: string;
    };

    expect(session.status).toBe('open');
    expect(session.quote).toMatchObject({ totalCents: 2_500, currency: 'USD' });
    expect(session.clientToken).toEqual(expect.any(String));

    const confirmation = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/checkout/sessions/${session.id}/confirm`, {
        headers: {
          'idempotency-key': `paid-confirm-${suffix}`,
          'x-checkout-session-token': session.clientToken,
        },
        data: { paymentMethodId: 'pm_card_visa' },
      }),
      200,
    )) as { status: string; sessionId: string; order: { id: string; status: string } };

    expect(confirmation).toMatchObject({
      status: 'completed',
      sessionId: session.id,
      order: { status: 'paid' },
    });

    const state = await readPaidCheckoutCaptureState(session.id, inventoryPool.id);
    expect(state.session).toMatchObject({
      status: 'completed',
      orderId: confirmation.order.id,
    });
    expect(state.order).toMatchObject({
      id: confirmation.order.id,
      status: 'paid',
      totalCents: 2_500,
      paymentProvider: 'stripe_capture',
      paymentIntentId: state.session.paymentIntentId,
    });
    expect(state.paymentIntent).toMatchObject({
      provider: 'stripe_capture',
      providerIntentId: `pi_capture_${session.id}`,
      status: 'succeeded',
      orderId: confirmation.order.id,
    });
    expect(state.hold).toMatchObject({ status: 'converted', quantity: 1 });
    expect(state.inventoryPool.soldCount).toBe(1);
    expect(state.ticketCount).toBe(1);
    expect(state.ticketEmailJob).toMatchObject({ templateKey: 'tickets-issued' });
    expect(state.ticketEmailJob?.attachments).toHaveLength(1);
    const ticketPdf = state.ticketEmailJob!.attachments[0];
    expect(ticketPdf).toMatchObject({
      contentType: 'application/pdf',
      contentEncoding: 'base64',
    });
    expect(ticketPdf.filename).toMatch(/^ticket-.+\.pdf$/);
    const pdfBytes = Buffer.from(ticketPdf.content, 'base64');
    expect(pdfBytes.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(pdfBytes.toString('latin1')).toContain('%%EOF');
    expect(pdfBytes.toString('latin1')).toContain(event.title);
    expect(pdfBytes.toString('latin1')).toContain(state.ticketIds[0]);
  });

  test('completes a paid order through hosted checkout UI in local capture mode', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `paid-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await page.getByRole('button', { name: `Increase ${ticketType.name} quantity` }).click();
    await page.getByLabel('Email').fill(`paid-ui+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Paid');
    await page.getByLabel('Last name').fill('Buyer');
    await attachScreenshot(page, testInfo, 'hosted-paid-checkout-select');
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Pay $25.00' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay $25.00' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

    const confirmationUrl = new URL(page.url());
    const sessionId = confirmationUrl.searchParams.get('sessionId');
    const orderId = confirmationUrl.searchParams.get('orderId');
    expect(sessionId).toEqual(expect.any(String));
    expect(orderId).toEqual(expect.any(String));
    await attachScreenshot(page, testInfo, 'hosted-paid-checkout-confirmed');

    const state = await readPaidCheckoutCaptureState(sessionId!, inventoryPool.id);
    expect(state.session).toMatchObject({
      status: 'completed',
      orderId,
    });
    expect(state.order).toMatchObject({
      id: orderId,
      status: 'paid',
      totalCents: 2_500,
      paymentProvider: 'stripe_capture',
      paymentIntentId: state.session.paymentIntentId,
    });
    expect(state.hold).toMatchObject({ status: 'converted', quantity: 1 });
    expect(state.inventoryPool.soldCount).toBe(1);
    expect(state.ticketCount).toBe(1);
  });

  test('applies a hosted promo code and persists discount redemption in local capture mode', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `paid-promo-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool, discountCode } = await seedPaidPromoCheckoutEvent(request, suffix);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await page.getByRole('button', { name: `Increase ${ticketType.name} quantity` }).click();
    await page.getByLabel('Promo code').fill(discountCode.code);
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(`Promo code ${discountCode.code} applied`)).toBeVisible();
    await page.getByLabel('Email').fill(`paid-promo-ui+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Promo');
    await page.getByLabel('Last name').fill('Buyer');
    await attachScreenshot(page, testInfo, 'hosted-paid-promo-checkout-select');
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Discount')).toBeVisible();
    await expect(page.getByText('-$5.00')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay $20.00' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay $20.00' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();

    const confirmationUrl = new URL(page.url());
    const sessionId = confirmationUrl.searchParams.get('sessionId');
    const orderId = confirmationUrl.searchParams.get('orderId');
    expect(sessionId).toEqual(expect.any(String));
    expect(orderId).toEqual(expect.any(String));
    await attachScreenshot(page, testInfo, 'hosted-paid-promo-checkout-confirmed');

    const state = await readPromoCheckoutCaptureState(sessionId!, inventoryPool.id, discountCode.id);
    expect(state.session).toMatchObject({
      status: 'completed',
      orderId,
    });
    expect(state.order).toMatchObject({
      id: orderId,
      status: 'paid',
      subtotalCents: 2_500,
      discountCents: discountCode.discountCents,
      totalCents: 2_000,
      paymentProvider: 'stripe_capture',
      paymentIntentId: state.session.paymentIntentId,
    });
    expect(state.discountCode).toMatchObject({
      id: discountCode.id,
      code: discountCode.code,
      usesCount: 1,
    });
    expect(state.redemption).toMatchObject({
      discountCodeId: discountCode.id,
      eventId: event.id,
      checkoutSessionId: sessionId,
      orderId,
      tenantId: 'tnt_dev_local',
    });
    expect(state.hold).toMatchObject({ status: 'converted', quantity: 1 });
    expect(state.inventoryPool.soldCount).toBe(1);
    expect(state.ticketCount).toBe(1);
  });
});
