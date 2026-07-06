import type { APIRequestContext, APIResponse, Page, TestInfo } from '@playwright/test';
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
  input: { eventId: string; ticketTypeId: string; quantity: number; suffix: string },
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

  expect(confirmation).toMatchObject({ status: 'completed', order: { status: 'paid' } });
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
    const checkInList = await seedCheckInListForOrder({ eventId: event.id, orderId, suffix });
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
      tickets: Array<{ ticketId: string; qrHash: string; attendeeName: string; status: string }>;
    };

    expect(manifest).toMatchObject({
      eventId: event.id,
      checkInListId: checkInList.id,
    });
    expect(manifest.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.tickets).toHaveLength(2);
    expect(JSON.stringify(manifest)).not.toContain(`checkin+${suffix}@example.com`);

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
    expect(state.scanLogs.map((log) => ({ outcome: log.outcome, offline: log.offline }))).toEqual([
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
    const checkInList = await seedCheckInListForOrder({ eventId: event.id, orderId, suffix });
    const [onlineTicket, untouchedTicket] = checkInList.tickets;

    await page.goto(`${adminBaseUrl}/events/${event.id}/check-in`);
    await expect(page.getByRole('heading', { name: 'Check-in' })).toBeVisible();
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
    expect(state.scanLogs.map((log) => ({ outcome: log.outcome, offline: log.offline }))).toEqual([
      { outcome: 'accepted', offline: false },
      { outcome: 'duplicate', offline: false },
      { outcome: 'invalid', offline: false },
    ]);
  });
});
