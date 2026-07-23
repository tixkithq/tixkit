/**
 * Checkout payment authentication / navigation coverage that does not depend on
 * the always-succeeded local-capture redirect fixture.
 *
 * These tests mock checkout API + Stripe-adjacent browser surfaces so Chromium
 * can assert:
 * - redirect_status is never treated as order authority
 * - decline / processing / cancelled session outcomes
 * - refresh and back navigation do not invent a completed order
 *
 * Firefox/WebKit are intentionally unrun unless explicitly executed.
 */
import { expect, test, type Page } from '@playwright/test';
import { checkoutBaseUrl } from './helpers/env';
import { requireReachable } from './fixtures/validation-test';

type MockSession = {
  id: string;
  eventId: string;
  brandId: string;
  status: string;
  currency: string;
  quote: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  };
  expiresAt: string;
  orderId: string | null;
};

function baseSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    id: 'cs_auth_nav',
    eventId: 'evt_auth_nav',
    brandId: 'brand_platform',
    status: 'pending_payment',
    currency: 'USD',
    quote: {
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
    orderId: null,
    ...overrides,
  };
}

async function installCheckoutConfirmationMocks(
  page: Page,
  input: {
    sessionId: string;
    session: MockSession | (() => MockSession);
    token?: string;
  },
) {
  const token = input.token ?? 'tok_auth_nav';
  await page.addInitScript(
    ({ sessionId, token: storedToken }) => {
      window.sessionStorage.setItem(`tk:session:${sessionId}`, storedToken);
    },
    { sessionId: input.sessionId, token },
  );

  await page.route('**/v1/**', async (route) => {
    const url = route.request().url();
    const session = typeof input.session === 'function' ? input.session() : input.session;

    if (url.includes(`/v1/checkout/sessions/${input.sessionId}/wallet-passes`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tickets: [] }),
      });
      return;
    }

    if (
      url.includes(`/v1/checkout/sessions/${input.sessionId}`) &&
      !url.includes('/confirm') &&
      !url.includes('/handoff')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      });
      return;
    }

    if (url.includes(`/v1/public/events/${session.eventId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: session.eventId,
          title: 'Auth Navigation Night',
          status: 'published',
          timezone: 'America/New_York',
          startsAt: '2026-07-17T19:00:00.000Z',
          brandId: session.brandId,
        }),
      });
      return;
    }

    if (url.includes(`/v1/public/brands/${session.brandId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: session.brandId,
          name: 'Platform',
          supportUrl: null,
          termsUrl: null,
          privacyUrl: null,
          refundUrl: null,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: 'unmocked' } }),
    });
  });
}

test.describe('checkout payment auth and navigation (mocked, Chromium)', () => {
  test('pending_payment + redirect_status=succeeded stays processing (session is authoritative)', async ({
    page,
  }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_succeeded_pending';
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: baseSession({ id: sessionId, status: 'pending_payment', orderId: null }),
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=succeeded&payment_intent=pi_auth_pending`,
    );

    await expect(page.getByText('Processing your payment')).toBeVisible();
    await expect(page.getByText('What happens next')).toHaveCount(0);
    await expect(page.getByText('Add to Wallet')).toHaveCount(0);
    await expect(page.getByText('Payment failed')).toHaveCount(0);
  });

  test('auth decline path: pending session + redirect_status=failed shows payment failed', async ({
    page,
  }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_declined';
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: baseSession({ id: sessionId, status: 'pending_payment' }),
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=failed&payment_intent=pi_declined`,
    );

    await expect(page.getByRole('heading', { level: 1, name: 'Payment failed' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText('What happens next')).toHaveCount(0);
    await expect(page.getByText('Add to Wallet')).toHaveCount(0);
  });

  test('processing redirect keeps pending UI until backend marks completed', async ({ page }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_processing';
    let calls = 0;
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: () => {
        calls += 1;
        if (calls >= 2) {
          return baseSession({
            id: sessionId,
            status: 'completed',
            orderId: 'ord_auth_processing',
          });
        }
        return baseSession({ id: sessionId, status: 'pending_payment' });
      },
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=processing&payment_intent=pi_processing`,
    );

    await expect(page.getByText('Processing your payment')).toBeVisible();
    await expect(page.getByText('What happens next')).toHaveCount(0);

    await expect(page.getByText('What happens next')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Processing your payment')).toHaveCount(0);
  });

  test('cancelled backend session wins over redirect_status=succeeded', async ({ page }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_cancelled';
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: baseSession({ id: sessionId, status: 'cancelled', orderId: null }),
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=succeeded&payment_intent=pi_cancel`,
    );

    await expect(page.getByRole('heading', { level: 1, name: 'Order cancelled' })).toBeVisible();
    await expect(page.getByText('What happens next')).toHaveCount(0);
  });

  test('refresh on confirmation reloads session state and does not invent completion from URL', async ({
    page,
  }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_refresh';
    let calls = 0;
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: () => {
        calls += 1;
        // Still pending across first paint + refresh.
        return baseSession({ id: sessionId, status: 'pending_payment' });
      },
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=succeeded&payment_intent=pi_refresh`,
    );
    await expect(page.getByText('Processing your payment')).toBeVisible();

    await page.reload();
    await expect(page.getByText('Processing your payment')).toBeVisible();
    await expect(page.getByText('What happens next')).toHaveCount(0);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('browser back from confirmation to checkout entry does not keep a fake completed order shell', async ({
    page,
  }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_back';
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: baseSession({ id: sessionId, status: 'pending_payment' }),
    });

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=evt_auth_nav`);
    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=succeeded&payment_intent=pi_back`,
    );
    await expect(page.getByText('Processing your payment')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/checkout/);
    await expect(page.getByText('What happens next')).toHaveCount(0);
    await expect(page.getByText('Add to Wallet')).toHaveCount(0);
  });
});
