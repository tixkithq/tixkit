import { createHmac } from 'node:crypto';
import type { APIRequestContext, APIResponse, Page, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  readPaidCheckoutCaptureState,
  readRefundWorkflowState,
  seedPaidCheckoutEvent,
  seedRefundNotificationPrerequisites,
} from './helpers/seed';
import { expect, requireReachable, test } from './fixtures/validation-test';

function requiredEnv(name: string): string {
  const value = process.env[name];
  test.skip(!value, `${name} is required for Stripe provider browser validation`);
  return value ?? '';
}

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

async function expectReportCardValue(page: Page, title: string, value: string): Promise<void> {
  const card = page.locator('[data-slot="card"]').filter({ hasText: title });
  await expect(card).toContainText(value);
}

async function fillFirstAvailable(
  page: Page,
  candidates: {
    labels?: RegExp[];
    placeholders?: RegExp[];
    selectors?: string[];
  },
  value: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const frame of page.frames()) {
      for (const candidate of candidates.labels ?? []) {
        const input = frame.getByLabel(candidate).first();
        if (await input.count()) {
          try {
            await input.fill(value);
            return true;
          } catch {
            continue;
          }
        }
      }
      for (const candidate of candidates.placeholders ?? []) {
        const input = frame.getByPlaceholder(candidate).first();
        if (await input.count()) {
          try {
            await input.fill(value);
            return true;
          } catch {
            continue;
          }
        }
      }
      for (const selector of candidates.selectors ?? []) {
        const input = frame.locator(selector).first();
        if (await input.count()) {
          try {
            await input.fill(value);
            return true;
          } catch {
            continue;
          }
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function selectStripeCardPaymentMethod(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const frame of page.frames()) {
      const cardOption = frame.getByText(/^Card$/).first();
      if (await cardOption.count()) {
        try {
          await cardOption.click();
          return;
        } catch {
          continue;
        }
      }
    }
    await page.waitForTimeout(250);
  }
}

async function disableStripeLinkSaveInfo(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const checkboxes = frame.locator('input[type="checkbox"]');
    const count = await checkboxes.count();
    for (let index = 0; index < count; index++) {
      const checkbox = checkboxes.nth(index);
      try {
        if (!(await checkbox.isChecked())) continue;
        await checkbox.uncheck({ force: true });
        if (!(await checkbox.isChecked())) return true;
        await checkbox.click({ force: true });
        if (!(await checkbox.isChecked())) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function fillStripeCard(page: Page): Promise<void> {
  await selectStripeCardPaymentMethod(page);
  expect(
    await fillFirstAvailable(
      page,
      {
        labels: [/Card number/i, /Card information/i],
        placeholders: [/1234 1234 1234 1234/i],
        selectors: ['input[name="number"]', 'input[autocomplete="cc-number"]'],
      },
      '4242424242424242',
    ),
  ).toBe(true);
  expect(
    await fillFirstAvailable(
      page,
      {
        labels: [/Expiration/i, /MM\s*\/\s*YY/i],
        placeholders: [/MM\s*\/\s*YY/i],
        selectors: ['input[name="expiry"]', 'input[autocomplete="cc-exp"]'],
      },
      '1234',
    ),
  ).toBe(true);
  expect(
    await fillFirstAvailable(
      page,
      {
        labels: [/CVC/i, /Security code/i],
        placeholders: [/CVC/i],
        selectors: ['input[name="cvc"]', 'input[autocomplete="cc-csc"]'],
      },
      '123',
    ),
  ).toBe(true);
  await fillFirstAvailable(
    page,
    {
      labels: [/ZIP/i, /Postal code/i],
      placeholders: [/ZIP/i, /Postal code/i],
      selectors: ['input[name="postalCode"]', 'input[autocomplete="postal-code"]'],
    },
    '10001',
  );
  if (await disableStripeLinkSaveInfo(page)) return;

  const filledLinkEmail = await fillFirstAvailable(
    page,
    {
      labels: [/^Email$/i],
      placeholders: [/you@example\.com/i],
      selectors: ['input[name="email"]', 'input[autocomplete="email"]'],
    },
    'stripe-link-e2e@example.com',
  );
  if (filledLinkEmail) {
    expect(
      await fillFirstAvailable(
        page,
        {
          labels: [/Mobile number/i, /^Phone$/i],
          placeholders: [/\(201\) 555-0123/i],
          selectors: [
            'input[name="phone"]',
            'input[type="tel"]',
            'input[autocomplete="tel"]',
            'input[autocomplete="tel-national"]',
          ],
        },
        '2015550123',
      ),
    ).toBe(true);
  }
}

function stripeSignature(payload: string, webhookSecret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

async function postPaymentSucceededWebhook(
  request: APIRequestContext,
  input: {
    webhookSecret: string;
    eventId: string;
    sessionId: string;
    paymentIntentId: string;
  },
) {
  const payload = JSON.stringify({
    id: input.eventId,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: input.paymentIntentId,
        object: 'payment_intent',
        amount: 2_500,
        currency: 'usd',
        status: 'succeeded',
        metadata: {
          checkoutSessionId: input.sessionId,
        },
      },
    },
  });

  await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(payload, input.webhookSecret),
      },
      data: payload,
    }),
    200,
  );
}

async function confirmStripePaymentIntent(input: {
  stripeSecretKey: string;
  paymentIntentId: string;
  returnUrl: string;
}): Promise<void> {
  const body = new URLSearchParams({
    payment_method: 'pm_card_visa',
    return_url: input.returnUrl,
  });
  const response = await fetch(
    `https://api.stripe.com/v1/payment_intents/${input.paymentIntentId}/confirm`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.stripeSecretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );
  const responseBody = (await response.json().catch(async () => ({
    raw: await response.text(),
  }))) as { status?: string; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      `Stripe confirm failed with ${response.status}: ${JSON.stringify(responseBody)}`,
    );
  }
  expect(responseBody.status).toBe('succeeded');
}

test.describe('Stripe provider hosted checkout workflow', () => {
  test('completes hosted checkout and refund through Stripe Elements, signed webhook, Temporal, and Postgres', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    const stripeSecretKey = requiredEnv('STRIPE_SECRET_KEY');
    const webhookSecret = requiredEnv('STRIPE_WEBHOOK_SECRET');
    requiredEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
    test.skip(
      process.env.E2E_STRIPE_PROVIDER !== '1',
      'Set E2E_STRIPE_PROVIDER=1 to preserve Stripe keys in Playwright web servers.',
    );

    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    const suffix = `stripe-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);
    await seedRefundNotificationPrerequisites(suffix, event.id);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await page.getByRole('button', { name: `Increase ${ticketType.name} quantity` }).click();
    await page.getByLabel('Email').fill(`stripe-ui+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Stripe');
    await page.getByLabel('Last name').fill('Buyer');
    await attachScreenshot(page, testInfo, 'stripe-provider-checkout-select');
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Pay $25.00' })).toBeVisible();
    const pendingPaymentResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/v1/checkout/sessions/') &&
        response.url().endsWith('/confirm'),
    );
    await page.getByRole('button', { name: 'Pay $25.00' }).click();
    const pendingPayment = (await expectJsonResponse(await pendingPaymentResponsePromise, 200)) as {
      sessionId: string;
      status: string;
      paymentIntentId: string;
      clientSecret: string;
      totalCents: number;
      currency: string;
    };
    expect(pendingPayment).toMatchObject({
      status: 'pending_payment',
      totalCents: 2_500,
      currency: 'USD',
    });
    expect(pendingPayment.paymentIntentId).toEqual(expect.stringMatching(/^pi_/));
    expect(pendingPayment.clientSecret).toContain('_secret_');

    await expect(page.getByText('Secure payment processed by Stripe')).toBeVisible();
    await expect(page.locator('iframe').first()).toBeVisible();
    await fillStripeCard(page);
    await attachScreenshot(page, testInfo, 'stripe-provider-payment-element');

    await confirmStripePaymentIntent({
      stripeSecretKey,
      paymentIntentId: pendingPayment.paymentIntentId,
      returnUrl: `${checkoutBaseUrl}/checkout/confirmation?sessionId=${encodeURIComponent(
        pendingPayment.sessionId,
      )}`,
    });
    const confirmationUrl = new URL(`${checkoutBaseUrl}/checkout/confirmation`);
    confirmationUrl.searchParams.set('sessionId', pendingPayment.sessionId);
    confirmationUrl.searchParams.set('payment_intent', pendingPayment.paymentIntentId);
    confirmationUrl.searchParams.set('payment_intent_client_secret', pendingPayment.clientSecret);
    confirmationUrl.searchParams.set('redirect_status', 'succeeded');
    await page.goto(confirmationUrl.toString());
    await expect(page).toHaveURL(/\/checkout\/confirmation\?/);
    const redirectedUrl = new URL(page.url());
    expect(redirectedUrl.searchParams.get('redirect_status')).toBe('succeeded');
    const sessionId = redirectedUrl.searchParams.get('sessionId');
    const paymentIntentId = redirectedUrl.searchParams.get('payment_intent');
    expect(sessionId).toBe(pendingPayment.sessionId);
    expect(paymentIntentId).toBe(pendingPayment.paymentIntentId);

    await postPaymentSucceededWebhook(request, {
      webhookSecret,
      eventId: `evt_tixkit_provider_${suffix}`,
      sessionId: sessionId!,
      paymentIntentId: paymentIntentId!,
    });

    await expect
      .poll(
        async () => {
          try {
            const state = await readPaidCheckoutCaptureState(sessionId!, inventoryPool.id);
            return state.paymentIntent.providerIntentId === paymentIntentId && state.ticketEmailJob
              ? state
              : null;
          } catch {
            return null;
          }
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] },
      )
      .not.toBeNull();
    const state = await readPaidCheckoutCaptureState(sessionId!, inventoryPool.id);

    expect(state!.session).toMatchObject({
      status: 'completed',
      orderId: state!.order.id,
    });
    expect(state!.order.status).toBe('paid');
    expect(state!.order.totalCents).toBe(2_500);
    expect(state!.order.paymentProvider).toBe('stripe');
    expect(state!.order.paymentIntentId).toBe(state!.session.paymentIntentId);
    expect(state!.paymentIntent).toMatchObject({
      provider: 'stripe',
      providerIntentId: paymentIntentId,
      orderId: state!.order.id,
    });
    expect(state!.hold).toMatchObject({ status: 'converted', quantity: 1 });
    expect(state!.inventoryPool.soldCount).toBe(1);
    expect(state!.ticketCount).toBe(1);
    expect(state!.ticketEmailJob).toMatchObject({
      templateKey: 'tickets-issued',
      attachments: [
        expect.objectContaining({
          filename: expect.stringMatching(/^ticket-.*\.pdf$/),
          contentType: 'application/pdf',
          contentEncoding: 'base64',
        }),
      ],
    });
    await attachScreenshot(page, testInfo, 'stripe-provider-confirmation');

    const salesReport = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/events/${event.id}/reports/sales`, {
        failOnStatusCode: false,
      }),
      200,
    )) as {
      eventId: string;
      currency: string;
      grossSalesCents: number;
      netRevenueCents: number;
      refundsCents: number;
      ticketsSold: number;
      paidOrdersCount: number;
    };
    expect(salesReport).toMatchObject({
      eventId: event.id,
      currency: 'USD',
      grossSalesCents: 2_500,
      netRevenueCents: 2_500,
      refundsCents: 0,
      ticketsSold: 1,
      paidOrdersCount: 1,
    });

    await page.goto(`${adminBaseUrl}/events/${event.id}/reports`);
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
    await expectReportCardValue(page, 'Gross Sales', '$25.00');
    await expectReportCardValue(page, 'Net Revenue', '$25.00');
    await expectReportCardValue(page, 'Tickets Sold', '1');
    await expectReportCardValue(page, 'Paid Orders', '1');
    await attachScreenshot(page, testInfo, 'stripe-provider-admin-sales-report');
    await expectNoAxeViolations(page, testInfo);

    await page.goto(`${adminBaseUrl}/orders/${state!.order.id}`);
    await expect(page.getByRole('heading', { name: state!.order.id })).toBeVisible();
    await expect(
      page.getByText(`stripe-ui+${suffix}@example.com`, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText('$25.00', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Refund' }).click();
    await expect(
      page.getByRole('heading', { name: `Refund order ${state!.order.id}` }),
    ).toBeVisible();
    await page
      .getByPlaceholder('Describe the refund reason (required)')
      .fill('E2E Stripe provider refund validation');
    await page.getByLabel('Restore inventory').click();

    const refundResponse = page.waitForResponse(
      (response) =>
        response.url() === `${apiBaseUrl}/v1/orders/${state!.order.id}/refunds` &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Refund $25.00' }).click();
    await expectJsonResponse(await refundResponse, 202);

    await expect
      .poll(
        async () => {
          const refundState = await readRefundWorkflowState(
            state!.order.id,
            inventoryPool.id,
            state!.ticketIds,
          );
          const providerRefundId = refundState.refunds[0]?.providerRefundId ?? '';
          return [
            refundState.order.status,
            refundState.order.refundedCents,
            refundState.refunds.length,
            refundState.refunds[0]?.amountCents ?? 0,
            providerRefundId.startsWith('re_'),
            refundState.tickets.filter((ticket) => ticket.status === 'void').length,
            refundState.inventoryPool.soldCount,
            refundState.timelineTypes.includes('ledger.refund'),
            refundState.timelineTypes.includes('tickets.voided'),
            refundState.emailJobs.length,
          ].join(':');
        },
        { timeout: 60_000 },
      )
      .toBe('refunded:2500:1:2500:true:1:0:true:true:1');

    await page.reload();
    await expect(page.getByText('Refunded', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('-$25.00', { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText('E2E Stripe provider refund validation', { exact: true }),
    ).toBeVisible();
    await attachScreenshot(page, testInfo, 'stripe-provider-admin-refund');
    await expectNoAxeViolations(page, testInfo);
  });
});
