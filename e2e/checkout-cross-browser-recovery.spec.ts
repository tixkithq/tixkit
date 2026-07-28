import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import {
  attachBrowserErrorCollectors,
  expectElementReachable,
  expectNoHorizontalOverflow,
} from './helpers/browser-quality';
import { checkoutBaseUrl } from './helpers/env';
import {
  baseSession,
  createRecoveryMockState,
  installCheckoutRecoveryMocks,
  seedSessionToken,
} from './helpers/checkout-recovery-mocks';
import { requireReachable } from './fixtures/validation-test';

async function openCheckout(page: Page, eventId: string, locale?: string) {
  const params = new URLSearchParams({ eventId });
  if (locale) params.set('locale', locale);
  await page.goto(`${checkoutBaseUrl}/checkout?${params.toString()}`);
  await expect(page.getByText('General Admission')).toBeVisible({
    timeout: 15_000,
  });
}

async function selectTicketAndBuyer(page: Page, email = 'buyer@example.com') {
  await page.getByRole('button', { name: 'Increase General Admission quantity' }).click();
  await page.getByLabel(/Email/i).first().fill(email);
}

async function expectRecoveryAxeClean(page: Page, testInfo: TestInfo) {
  await expectNoAxeViolations(page, testInfo, 'body', [
    'button:disabled',
    '[aria-disabled="true"]',
  ]);
}

test.describe('checkout cross-browser recovery (mocked frontend)', () => {
  test.beforeEach(async ({ page }) => requireReachable(page, checkoutBaseUrl, 'checkout app'));

  test('inventory exhaustion requires acknowledgement and preserves buyer details', async ({
    page,
  }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    const state = createRecoveryMockState({
      createSessionImpl: () => {
        state.tickets = state.tickets.map((ticket) =>
          ticket.ticketTypeId === 'tt_ga'
            ? { ...ticket, available: 0, status: 'sold_out' }
            : ticket,
        );
        return {
          status: 409,
          error: {
            code: 'INVENTORY_EXHAUSTED',
            message: 'Insufficient inventory',
          },
        };
      },
    });
    let endExpectedConflict: (() => void) | undefined;
    try {
      await installCheckoutRecoveryMocks(page, state);
      await openCheckout(page, state.eventId);
      await selectTicketAndBuyer(page, 'keep-me@example.com');
      endExpectedConflict = errors.beginExpectedErrorScope({
        phase: 'intentional inventory exhaustion response',
        console: [
          {
            message:
              /Failed to load resource: the server responded with a status of 409 \(Conflict\)/i,
            url: /\/v1\/checkout\/sessions$/u,
          },
        ],
      });
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('Your selection changed')).toBeVisible();
      endExpectedConflict();
      await expect(page.getByLabel(/Email/i).first()).toHaveValue('keep-me@example.com');
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
      expect(state.createCalls).toBe(1);
      await page.getByRole('button', { name: /I understand/i }).click();
      await expect(page.getByText('Your selection changed')).toHaveCount(0);
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      endExpectedConflict?.();
      errors.dispose();
    }
  });

  test('expired reservation blocks payment and starts a new order', async ({ page }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    try {
      const expiresAt = new Date(Date.now() + 2_500).toISOString();
      const state = createRecoveryMockState({
        createSessionImpl: () => baseSession(state, { id: 'cs_expired', expiresAt }),
        sessionFactory: () =>
          baseSession(state, {
            id: 'cs_expired',
            status: 'expired',
            expiresAt,
          }),
      });
      await installCheckoutRecoveryMocks(page, state);
      await openCheckout(page, state.eventId);
      await selectTicketAndBuyer(page);
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByText('Checkout expired')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('button', { name: 'Pay $25.00' })).toBeDisabled();
      await page.getByRole('button', { name: 'Start new order' }).click();
      await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
      expect(state.confirmCalls).toBe(0);
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      errors.dispose();
    }
  });

  test('offline before session creation fails closed and reconnecting restores Continue', async ({
    page,
  }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    try {
      const state = createRecoveryMockState();
      await installCheckoutRecoveryMocks(page, state);
      await openCheckout(page, state.eventId, 'es-MX');
      await selectTicketAndBuyer(page, 'offline@example.com');
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(page.locator('[lang="es"]')).toBeVisible();
      await expect(page.getByText('No tienes conexión')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continuar' })).toBeDisabled();
      expect(state.createCalls).toBe(0);
      await page.context().setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      const continueButton = page.getByRole('button', { name: 'Continuar' });
      await expect(continueButton).toBeEnabled();
      await expect
        .poll(
          () => continueButton.evaluate((element) => window.getComputedStyle(element).opacity),
          { message: 'Continue must finish its enabled-state opacity transition before axe' },
        )
        .toBe('1');
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      await page.context().setOffline(false);
      errors.dispose();
    }
  });

  test('authoritative failed server state renders decline while pending state stays pending', async ({
    page,
  }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    try {
      const failedId = 'cs_authoritative_failed';
      const state = createRecoveryMockState({
        session: baseSession(createRecoveryMockState(), {
          id: failedId,
          status: 'failed',
        }),
      });
      await seedSessionToken(page, failedId);
      await installCheckoutRecoveryMocks(page, state);
      await page.goto(
        `${checkoutBaseUrl}/checkout/confirmation?sessionId=${failedId}&redirect_status=failed`,
      );
      await expect(page.getByRole('heading', { level: 1, name: 'Payment failed' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
      const pendingId = 'cs_authoritative_pending';
      state.session = baseSession(state, {
        id: pendingId,
        status: 'pending_payment',
      });
      await seedSessionToken(page, pendingId);
      await page.goto(
        `${checkoutBaseUrl}/checkout/confirmation?sessionId=${pendingId}&redirect_status=failed`,
      );
      await expect(page.getByText('Processing your payment')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: 'Payment failed' })).toHaveCount(0);
      await expect(page.getByText('What happens next')).toHaveCount(0);
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      errors.dispose();
    }
  });

  test('availability request aborts once, shows stale state, and retry recovers', async ({
    page,
  }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    const state = createRecoveryMockState({
      pageBootstrapFail: true,
      availabilityFailOnce: true,
    });
    const endExpectedErrors = errors.beginExpectedErrorScope({
      phase: 'intentional first availability abort',
      console: [
        {
          message:
            /Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)/i,
          url: new RegExp(`/v1/public/events/${state.eventId}/page-bootstrap(?:\\?.*)?$`, 'u'),
        },
        {
          message: /Failed to load resource:.*ERR_FAILED/i,
          url: new RegExp(`/v1/public/events/${state.eventId}/availability(?:\\?.*)?$`, 'u'),
        },
        {
          message: /Cross-Origin Request Blocked:.*CORS request did not succeed/i,
          url: new RegExp(`/v1/public/events/${state.eventId}/availability(?:\\?.*)?$`, 'u'),
        },
      ],
    });
    try {
      await installCheckoutRecoveryMocks(page, state);
      await page.goto(`${checkoutBaseUrl}/e/${state.eventId}`);
      await expect(page.getByRole('heading', { name: 'Recovery Night' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('availability-status-banner')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retry availability' })).toBeVisible();
      expect(state.availabilityCalls).toBe(1);
      endExpectedErrors();
      await page.getByRole('button', { name: 'Retry availability' }).click();
      await expect(page.getByTestId('availability-status-banner')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Get tickets/i })).toBeVisible();
      expect(state.availabilityCalls).toBe(2);
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      endExpectedErrors();
      errors.dispose();
    }
  });

  test('keyboard and narrow mobile layouts keep recovery controls reachable', async ({
    page,
  }, testInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    try {
      const state = createRecoveryMockState();
      await installCheckoutRecoveryMocks(page, state);
      await page.setViewportSize({ width: 320, height: 568 });
      await openCheckout(page, state.eventId);
      const increase = page.getByRole('button', {
        name: 'Increase General Admission quantity',
      });
      await increase.focus();
      await page.keyboard.press('Enter');
      const email = page.getByLabel(/Email/i).first();
      await email.focus();
      await page.keyboard.type('keyboard@example.com');
      await expectNoHorizontalOverflow(page);
      await expectElementReachable(page, 'button:has-text("Continue")');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expectElementReachable(page, 'button:has-text("Pay")');
      await expectNoHorizontalOverflow(page);
      await expectRecoveryAxeClean(page, testInfo);
      errors.assertClean();
    } finally {
      errors.dispose();
    }
  });
});
