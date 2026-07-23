import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { attachBrowserErrorCollectors } from './helpers/browser-quality';
import { adminBaseUrl } from './helpers/env';
import { requireReachable } from './fixtures/validation-test';

const eventId = 'evt_checkin_recovery';
const checkInListId = 'cil_checkin_recovery';

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Supplies the kiosk's event and list prerequisites without mutating shared API state. */
async function installCheckInRecoveryMocks(page: Page): Promise<void> {
  await page.route('**/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/v1/bootstrap-context')) {
      return json(route, 200, {
        organizations: [
          {
            id: 'org_recovery',
            tenantId: 'tenant_recovery',
            name: 'Recovery Org',
            slug: 'recovery',
            status: 'active',
            boxOfficeSettings: {
              enabled: true,
              allowedTenderTypes: ['cash'],
              requireBuyerEmail: false,
              receiptMode: 'print',
            },
          },
        ],
        brands: [
          {
            id: 'brand_recovery',
            tenantId: 'tenant_recovery',
            organizationId: 'org_recovery',
            name: 'Recovery Brand',
            slug: 'recovery',
            status: 'active',
            theme: {},
            domains: [],
            legalUrls: {},
            whiteLabel: false,
          },
        ],
      });
    }
    if (url.includes('/v1/me'))
      return json(route, 200, {
        tenantId: 'tenant_recovery',
        organizationIds: ['org_recovery'],
        permissions: ['checkins.write', 'checkins.read'],
      });
    if (url.includes(`/v1/events/${eventId}/check-in-manifest-keys`)) {
      return json(route, 200, { version: 2, issuer: 'tixkit', keys: [] });
    }
    if (url.includes(`/v1/events/${eventId}/check-in-lists/${checkInListId}/manifest`)) {
      return json(route, 200, {
        version: 2,
        eventId,
        checkInListId,
        issuer: 'tixkit',
        keyId: 'missing-recovery-key',
        algorithm: 'ES256',
        generatedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        tickets: [],
        signature: '',
      });
    }
    if (url.includes('/v1/events?')) {
      return json(route, 200, {
        items: [
          {
            id: eventId,
            title: 'Recovery Doors',
            status: 'published',
            currency: 'USD',
            capacity: 100,
            ticketsSold: 10,
            checkIns: 0,
          },
        ],
        total: 1,
        filterTotal: 1,
        nextCursor: null,
      });
    }
    if (url.includes(`/v1/events/${eventId}/check-in-lists`)) {
      return json(route, 200, [
        {
          id: checkInListId,
          eventId,
          name: 'Main door',
          ticketTypeIds: [],
          status: 'active',
        },
      ]);
    }
    if (url.includes(`/v1/events/${eventId}/attendees`)) {
      return json(route, 200, { items: [], total: 0, filterTotal: 0, nextCursor: null });
    }
    if (url.includes('/v1/check-ins/scan')) {
      return json(route, 200, {
        status: 'invalid',
        message: 'No matching ticket found.',
        scannedAt: new Date().toISOString(),
      });
    }
    return json(route, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `Unmocked recovery request: ${url}`,
      },
    });
  });
}

test.describe('check-in cross-browser recovery (mocked kiosk)', () => {
  test.beforeEach(async ({ page }) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
  });

  test('manual entry, connectivity state, and camera-denial recovery remain available', async ({
    page,
  }, testInfo: TestInfo) => {
    const errors = attachBrowserErrorCollectors(page);
    try {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => {
              throw new DOMException('Permission denied by recovery test', 'NotAllowedError');
            },
            enumerateDevices: async () => [],
          },
        });
      });
      await installCheckInRecoveryMocks(page);
      await page.goto(`${adminBaseUrl}/kiosk/${eventId}?listId=${checkInListId}&tab=scan`);
      const manualTab = page.getByRole('tab', { name: 'Manual' });
      await expect(manualTab).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('tab', { name: 'Camera' })).toBeVisible();
      await manualTab.click();
      const manualInput = page.getByPlaceholder('Enter QR code or ticket ID');
      await expect(manualInput).toBeVisible();
      await manualInput.fill('MANUAL-RECOVERY-CODE');
      await expect(manualInput).toHaveValue('MANUAL-RECOVERY-CODE');
      await expect(page.getByRole('button', { name: 'Scan' })).toBeEnabled();

      await expect(page.getByTestId('scan-connectivity-status')).toContainText('Network online');
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await expect(page.getByTestId('scan-network-status')).toHaveText('Network offline');
      await page.context().setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(page.getByTestId('scan-network-status')).toHaveText('Network online');

      await page.getByRole('tab', { name: 'Camera' }).click();
      await page.getByRole('button', { name: 'Enable camera' }).click();
      await expect(page.getByText('Camera permission denied')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText(/switch to Manual entry/i)).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      errors.assertClean();
    } finally {
      await page.context().setOffline(false);
      errors.dispose();
    }
  });
});
