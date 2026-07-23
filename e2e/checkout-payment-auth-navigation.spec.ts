/**
 * Checkout payment authentication / navigation coverage that does not depend on
 * the always-succeeded local-capture redirect fixture.
 *
 * These tests mock checkout API + Stripe-adjacent browser surfaces so browser
 * runs can assert:
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
  const fallbackSession =
    typeof input.session === 'function' ? baseSession({ id: input.sessionId }) : input.session;
  await page.addInitScript(
    ({ sessionId, token: storedToken }) => {
      window.sessionStorage.setItem(`tk:session:${sessionId}`, storedToken);
    },
    { sessionId: input.sessionId, token },
  );

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const sessionPath = `/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}`;

    if (request.method() === 'GET' && url.pathname === `${sessionPath}/wallet-passes`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tickets: [] }),
      });
      return;
    }

    if (request.method() === 'GET' && url.pathname === sessionPath) {
      const session = typeof input.session === 'function' ? input.session() : input.session;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      });
      return;
    }

    if (
      request.method() === 'GET' &&
      url.pathname === `/v1/public/events/${encodeURIComponent(fallbackSession.eventId)}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: fallbackSession.eventId,
          title: 'Auth Navigation Night',
          status: 'published',
          timezone: 'America/New_York',
          startsAt: '2026-07-17T19:00:00.000Z',
          brandId: fallbackSession.brandId,
        }),
      });
      return;
    }

    if (
      request.method() === 'GET' &&
      url.pathname === `/v1/public/brands/${encodeURIComponent(fallbackSession.brandId)}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: fallbackSession.brandId,
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

test.describe('mocked confirmation authority and navigation', () => {
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

  test('pending session + redirect_status=failed remains processing until the server resolves it', async ({
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

    await expect(page.getByText('Processing your payment')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Payment failed' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
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

  test('expired backend session wins over redirect_status=succeeded', async ({ page }) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const sessionId = 'cs_auth_expired';
    await installCheckoutConfirmationMocks(page, {
      sessionId,
      session: baseSession({ id: sessionId, status: 'expired', orderId: null }),
    });

    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${sessionId}&redirect_status=succeeded&payment_intent=pi_expired`,
    );

    await expect(page.getByRole('heading', { level: 1, name: 'Checkout expired' })).toBeVisible();
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
    expect(calls).toBe(2);
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
