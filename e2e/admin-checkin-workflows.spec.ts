import type { APIRequestContext, APIResponse, Page, Route, TestInfo } from '@playwright/test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import {
  readCheckInWorkflowState,
  seedCheckInListForOrder,
  seedFreeCheckoutEvent,
} from './helpers/seed';
import { expect, requireReachable, test } from './fixtures/validation-test';

type CheckoutSessionResponse = {
  id: string;
  clientToken: string;
  quote: { totalCents: number; currency: string };
  status: string;
};

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

async function createFreeTicketOrder(
  request: APIRequestContext,
  input: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    suffix: string;
  },
) {
  const session = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
      headers: { 'idempotency-key': `checkin-session-${input.suffix}` },
      data: {
        eventId: input.eventId,
        items: [{ ticketTypeId: input.ticketTypeId, quantity: input.quantity }],
        buyer: {
          email: `checkin+${input.suffix}@example.com`,
          firstName: 'Scanner',
          lastName: 'Buyer',
        },
      },
    }),
    201,
  )) as CheckoutSessionResponse;

  expect(session.quote).toMatchObject({ totalCents: 0, currency: 'USD' });

  const confirmation = (await expectJsonResponse(
    await request.post(`${apiBaseUrl}/v1/checkout/sessions/${session.id}/confirm`, {
      headers: {
        'idempotency-key': `checkin-confirm-${input.suffix}`,
        'x-checkout-session-token': session.clientToken,
      },
      data: {},
    }),
    200,
  )) as { status: string; order: { id: string; status: string } };

  expect(confirmation).toMatchObject({
    status: 'completed',
    order: { status: 'paid' },
  });
  return confirmation.order.id;
}

test.describe('admin check-in workflows', () => {
  test('validates online scanning, duplicate detection, offline manifest, and offline sync', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `checkin-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedFreeCheckoutEvent(request, suffix);
    const orderId = await createFreeTicketOrder(request, {
      eventId: event.id,
      ticketTypeId: ticketType.id,
      quantity: 2,
      suffix,
    });
    const checkInList = await seedCheckInListForOrder({
      eventId: event.id,
      orderId,
      suffix,
    });
    expect(checkInList.tickets).toHaveLength(2);

    const manifest = (await expectJsonResponse(
      await request.get(
        `${apiBaseUrl}/v1/events/${event.id}/check-in-lists/${checkInList.id}/manifest`,
      ),
      200,
    )) as {
      eventId: string;
      checkInListId: string;
      signature: string;
      tickets: Array<{
        ticketId: string;
        qrHash: string;
        attendeeName: string;
        status: string;
      }>;
    };

    expect(manifest).toMatchObject({
      eventId: event.id,
      checkInListId: checkInList.id,
    });
    expect(manifest.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.tickets).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain(`checkin+${suffix}@example.com`);

    const verificationKeys = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/events/${event.id}/check-in-manifest-keys`),
      200,
    )) as { version: number; issuer: string; keys: Array<{ keyId: string }> };
    const manifestV2 = (await expectJsonResponse(
      await request.get(
        `${apiBaseUrl}/v1/events/${event.id}/check-in-lists/${checkInList.id}/manifest?version=2`,
      ),
      200,
    )) as {
      version: number;
      algorithm: string;
      issuer: string;
      keyId: string;
      signature: string;
    };
    expect(manifestV2).toMatchObject({
      version: 2,
      algorithm: 'ES256',
      issuer: apiBaseUrl,
    });
    expect(manifestV2.signature).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(verificationKeys.issuer).toBe(apiBaseUrl);
    expect(verificationKeys.keys.map((key) => key.keyId)).toContain(manifestV2.keyId);

    const [onlineTicket, offlineTicket] = checkInList.tickets;
    const onlineScan = await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/check-ins/scan`, {
        headers: { 'idempotency-key': `checkin-online-${suffix}` },
        data: {
          checkInListId: checkInList.id,
          qrPayload: onlineTicket.qrPayload,
          scannedAt: '2026-06-27T12:00:00.000Z',
          deviceId: `scanner-online-${testInfo.workerIndex}`,
        },
      }),
      200,
    );
    expect(onlineScan).toMatchObject({
      outcome: 'accepted',
      ticketId: onlineTicket.id,
      message: 'Check-in successful',
    });

    const duplicateOnlineScan = await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/check-ins/scan`, {
        headers: { 'idempotency-key': `checkin-online-duplicate-${suffix}` },
        data: {
          checkInListId: checkInList.id,
          qrPayload: onlineTicket.qrPayload,
          scannedAt: '2026-06-27T12:01:00.000Z',
          deviceId: `scanner-online-${testInfo.workerIndex}`,
        },
      }),
      200,
    );
    expect(duplicateOnlineScan).toMatchObject({
      outcome: 'duplicate',
      ticketId: onlineTicket.id,
    });

    const offlineSync = await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/check-ins/sync`, {
        headers: { 'idempotency-key': `checkin-offline-sync-${suffix}` },
        data: {
          checkInListId: checkInList.id,
          deviceId: `scanner-offline-${testInfo.workerIndex}`,
          scans: [
            {
              qrHash: onlineTicket.qrHash,
              scannedAt: '2026-06-27T12:02:00.000Z',
              offline: true,
            },
            {
              qrHash: 'not-a-real-ticket-hash',
              scannedAt: '2026-06-27T12:03:00.000Z',
              offline: true,
            },
            {
              qrHash: offlineTicket.qrHash,
              scannedAt: '2026-06-27T12:00:30.000Z',
              offline: true,
            },
          ],
        },
      }),
      200,
    );

    expect(offlineSync).toMatchObject({
      accepted: 1,
      duplicates: 1,
      invalid: 1,
      results: [
        { qrHash: offlineTicket.qrHash, outcome: 'accepted' },
        { qrHash: onlineTicket.qrHash, outcome: 'duplicate' },
        { qrHash: 'not-a-real-ticket-hash', outcome: 'not_found' },
      ],
    });

    const state = await readCheckInWorkflowState({
      checkInListId: checkInList.id,
      ticketIds: checkInList.tickets.map((ticket) => ticket.id),
    });
    expect(state.tickets).toEqual([
      {
        id: onlineTicket.id,
        status: 'checked_in',
        checkedInByDeviceId: expect.any(String),
      },
      {
        id: offlineTicket.id,
        status: 'checked_in',
        checkedInByDeviceId: expect.any(String),
      },
    ]);
    expect(
      state.scanLogs.map((log) => ({
        outcome: log.outcome,
        offline: log.offline,
      })),
    ).toEqual([
      { outcome: 'accepted', offline: false },
      { outcome: 'accepted', offline: true },
      { outcome: 'duplicate', offline: false },
      { outcome: 'duplicate', offline: true },
      { outcome: 'not_found', offline: true },
    ]);
  });

  test('validates event scanner browser UI for accepted, duplicate, and invalid scans', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, adminBaseUrl, 'admin app');

    const suffix = `checkin-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedFreeCheckoutEvent(request, suffix);
    const orderId = await createFreeTicketOrder(request, {
      eventId: event.id,
      ticketTypeId: ticketType.id,
      quantity: 2,
      suffix,
    });
    const checkInList = await seedCheckInListForOrder({
      eventId: event.id,
      orderId,
      suffix,
    });
    const [onlineTicket, untouchedTicket] = checkInList.tickets;

    await page.goto(`${adminBaseUrl}/events/${event.id}/check-in`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByText('Check-in', { exact: true })).toBeVisible();
    await expect(page.getByText(checkInList.name)).toBeVisible();
    // Camera mode is the default when the browser supports it; switch to
    // Manual so the scanner input is visible for the e2e test.
    await page.getByRole('tab', { name: 'Manual' }).click();
    await expect(page.getByRole('button', { name: 'Scan' })).toBeDisabled();

    const scannerInput = page.getByPlaceholder('Enter QR code or ticket ID');
    await scannerInput.fill(onlineTicket.qrPayload);
    await page.getByRole('button', { name: 'Scan' }).click();
    await expect(page.getByText('accepted', { exact: true })).toBeVisible();
    await expect(page.getByText('Check-in successful')).toBeVisible();
    await expect(scannerInput).toHaveValue('');
    await attachScreenshot(page, testInfo, 'admin-checkin-browser-accepted');
    await expectNoAxeViolations(page, testInfo);

    await scannerInput.fill(onlineTicket.qrPayload);
    await page.getByRole('button', { name: 'Scan' }).click();
    await expect(page.getByText('duplicate', { exact: true })).toBeVisible();
    await expect(page.getByText('Check-in duplicate')).toBeVisible();

    await scannerInput.fill('not-a-signed-ticket-payload');
    await page.getByRole('button', { name: 'Scan' }).click();
    await expect(page.getByText('invalid', { exact: true })).toBeVisible();
    await expect(page.getByText('Check-in invalid')).toBeVisible();
    await attachScreenshot(page, testInfo, 'admin-checkin-browser-invalid');

    const state = await readCheckInWorkflowState({
      checkInListId: checkInList.id,
      ticketIds: checkInList.tickets.map((ticket) => ticket.id),
    });
    expect(state.tickets).toEqual([
      {
        id: onlineTicket.id,
        status: 'checked_in',
        checkedInByDeviceId: expect.any(String),
      },
      {
        id: untouchedTicket.id,
        status: 'valid',
        checkedInByDeviceId: null,
      },
    ]);
    expect(
      state.scanLogs.map((log) => ({
        outcome: log.outcome,
        offline: log.offline,
      })),
    ).toEqual([
      { outcome: 'accepted', offline: false },
      { outcome: 'duplicate', offline: false },
      { outcome: 'invalid', offline: false },
    ]);
  });

  test('verifies, durably queues, and reconciles a browser offline admission', async ({
    page,
    request,
    consoleErrors,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, adminBaseUrl, 'admin app');

    const suffix = `checkin-offline-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType } = await seedFreeCheckoutEvent(request, suffix);
    const orderId = await createFreeTicketOrder(request, {
      eventId: event.id,
      ticketTypeId: ticketType.id,
      quantity: 1,
      suffix,
    });
    const checkInList = await seedCheckInListForOrder({
      eventId: event.id,
      orderId,
      suffix,
    });
    const [ticket] = checkInList.tickets;

    await page.goto(`${adminBaseUrl}/events/${event.id}/check-in`);
    await page.getByRole('tab', { name: 'Manual' }).click();
    await expect(page.getByText('Offline ready', { exact: true })).toBeVisible();

    const secondPage = await page.context().newPage();
    const secondPageErrors: string[] = [];
    secondPage.on('console', (message) => {
      if (message.type() === 'error') {
        secondPageErrors.push(`[console.error] ${message.text()} (${message.location().url})`);
      }
    });
    secondPage.on('pageerror', (error) => {
      secondPageErrors.push(`[pageerror] ${error.message}`);
    });
    await secondPage.goto(`${adminBaseUrl}/events/${event.id}/check-in`);
    await secondPage.getByRole('tab', { name: 'Manual' }).click();
    await expect(secondPage.getByText('Offline ready', { exact: true })).toBeVisible();

    await page.context().route(`${apiBaseUrl}/v1/check-ins/scan`, async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Simulated event-day outage',
          },
        }),
      });
    });
    const heldSyncRoutes: Route[] = [];
    await page.context().route(`${apiBaseUrl}/v1/check-ins/sync`, async (route) => {
      heldSyncRoutes.push(route);
    });
    const scannerInput = page.getByPlaceholder('Enter QR code or ticket ID');
    const secondScannerInput = secondPage.getByPlaceholder('Enter QR code or ticket ID');
    await Promise.all([
      scannerInput.fill(ticket.qrPayload),
      secondScannerInput.fill(ticket.qrPayload),
    ]);
    await Promise.all([
      page.getByRole('button', { name: 'Scan' }).click(),
      secondPage.getByRole('button', { name: 'Scan' }).click(),
    ]);
    await expect
      .poll(async () => {
        const accepted = await Promise.all(
          [page, secondPage].map((candidate) =>
            candidate
              .getByText('Check-in accepted offline and queued for synchronization.')
              .count(),
          ),
        );
        const duplicate = await Promise.all(
          [page, secondPage].map((candidate) =>
            candidate.getByText('Ticket is already queued on this browser.').count(),
          ),
        );
        return {
          accepted: accepted.reduce((total, count) => total + count, 0),
          duplicate: duplicate.reduce((total, count) => total + count, 0),
        };
      })
      .toEqual({ accepted: 1, duplicate: 1 });
    await expect(page.getByText(/Offline ready · 1 pending sync/u)).toBeVisible();

    const durableState = await page.evaluate(async () => {
      const request = indexedDB.open('tixkit-offline-checkin-v1', 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), {
          once: true,
        });
        request.addEventListener('error', () => reject(request.error), {
          once: true,
        });
      });
      const transaction = database.transaction('contexts', 'readonly');
      const getAll = transaction.objectStore('contexts').getAll();
      const states = await new Promise<
        Array<{ pending: unknown[]; manifest: { version: number } }>
      >((resolve, reject) => {
        getAll.addEventListener('success', () => resolve(getAll.result), {
          once: true,
        });
        getAll.addEventListener('error', () => reject(getAll.error), {
          once: true,
        });
      });
      database.close();
      return states.map((state) => ({
        pending: state.pending.length,
        manifestVersion: state.manifest.version,
      }));
    });
    expect(durableState).toContainEqual({ pending: 1, manifestVersion: 2 });

    await secondPage.close();
    await expect.poll(() => heldSyncRoutes.length).toBe(1);
    await heldSyncRoutes[0]!.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accepted: 1,
        duplicates: 0,
        invalid: 0,
        results: [{ qrHash: ticket.qrHash, outcome: 'provider_contract_drift' }],
      }),
    });
    await expect(
      page.getByText('Offline sync returned results outside the submitted snapshot.'),
    ).toBeVisible();
    await expect(page.getByText(/Offline ready · 1 pending sync/u)).toBeVisible();
    await page.context().unroute(`${apiBaseUrl}/v1/check-ins/sync`);
    const syncButton = page.getByRole('button', { name: 'Sync offline scans' });
    await expect(syncButton).toBeEnabled();
    await syncButton.click();
    await expect(page.getByText('Offline ready', { exact: true })).toBeVisible();
    await expect(syncButton).toHaveCount(0);

    await scannerInput.fill(ticket.qrPayload);
    await page.getByRole('button', { name: 'Scan' }).click();
    await expect(page.getByText('Ticket was already admitted on this browser.')).toBeVisible();
    await expect(page.getByText('Offline ready', { exact: true })).toBeVisible();
    await page.context().unroute(`${apiBaseUrl}/v1/check-ins/scan`);

    const isExpectedScanOutage = (message: string) =>
      message.includes('/v1/check-ins/scan') && message.includes('503');
    const primaryExpectedErrors = consoleErrors.filter(isExpectedScanOutage);
    const secondExpectedErrors = secondPageErrors.filter(isExpectedScanOutage);
    for (const message of primaryExpectedErrors) {
      consoleErrors.splice(consoleErrors.indexOf(message), 1);
    }
    for (const message of secondExpectedErrors) {
      secondPageErrors.splice(secondPageErrors.indexOf(message), 1);
    }
    expect(secondPageErrors).toEqual([]);
    await expectNoAxeViolations(page, testInfo);

    const state = await readCheckInWorkflowState({
      checkInListId: checkInList.id,
      ticketIds: [ticket.id],
    });
    expect(state.tickets).toEqual([
      {
        id: ticket.id,
        status: 'checked_in',
        checkedInByDeviceId: expect.any(String),
      },
    ]);
    expect(
      state.scanLogs.map((log) => ({
        outcome: log.outcome,
        offline: log.offline,
      })),
    ).toEqual([{ outcome: 'accepted', offline: true }]);
  });
});
