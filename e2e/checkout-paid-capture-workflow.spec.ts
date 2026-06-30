import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectNoAxeViolations } from './helpers/axe';
import { apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  devOrganizationId,
  readCheckoutSessionArtifactAnswerState,
  readOrphanPaymentCompensationState,
  readPromoCheckoutCaptureState,
  readPaidCheckoutCaptureState,
  readResalePurchaseState,
  readWalletPassState,
  seedCompensatedOrphanPaymentForSession,
  seedPaidCheckoutEvent,
  seedPaidPromoCheckoutEvent,
  seedPublishedEventPageContent,
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

function utf16BePdfHex(value: string): string {
  return Buffer.from(`\uFEFF${value}`, 'utf16le').swap16().toString('hex').toUpperCase();
}

function expectPdfToReference(pdfText: string, value: string): void {
  expect(pdfText.includes(value) || pdfText.toUpperCase().includes(utf16BePdfHex(value))).toBe(
    true,
  );
}

function readApplePassEntries(passBytes: Buffer): {
  passJson: Record<string, unknown>;
  passJsonBytes: Buffer;
  manifest: Record<string, string>;
  signature: Buffer;
} {
  const dir = mkdtempSync(join(tmpdir(), 'tixkit-e2e-pkpass-'));
  const passPath = join(dir, 'ticket.pkpass');
  const manifestPath = join(dir, 'manifest.json');
  const signaturePath = join(dir, 'signature');
  try {
    writeFileSync(passPath, passBytes);
    const passJsonBytes = execFileSync('unzip', ['-p', passPath, 'pass.json']);
    const manifestBytes = execFileSync('unzip', ['-p', passPath, 'manifest.json']);
    const signature = execFileSync('unzip', ['-p', passPath, 'signature']);
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(signaturePath, signature);
    execFileSync('openssl', [
      'smime',
      '-verify',
      '-inform',
      'DER',
      '-in',
      signaturePath,
      '-content',
      manifestPath,
      '-noverify',
      '-out',
      '/dev/null',
    ]);
    return {
      passJson: JSON.parse(passJsonBytes.toString('utf8')) as Record<string, unknown>,
      passJsonBytes,
      manifest: JSON.parse(manifestBytes.toString('utf8')) as Record<string, string>,
      signature,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function passFieldGroup(passJson: Record<string, unknown>, group: string): unknown {
  const eventTicket = passJson.eventTicket;
  if (!eventTicket || typeof eventTicket !== 'object') return undefined;
  return (eventTicket as Record<string, unknown>)[group];
}

function decodeGoogleWalletPayload(saveUrl: string): {
  eventTicketClasses: Array<{ issuerName?: string }>;
  eventTicketObjects: Array<{
    barcode?: { alternateText?: string; type?: string; value?: string };
    hexBackgroundColor?: string;
  }>;
} {
  const token = saveUrl.replace('https://pay.google.com/gp/v/save/', '');
  const [, payload] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    payload: {
      eventTicketClasses: Array<{ issuerName?: string }>;
      eventTicketObjects: Array<{
        barcode?: { alternateText?: string; type?: string; value?: string };
        hexBackgroundColor?: string;
      }>;
    };
  };
  return claims.payload;
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
    const pdfText = pdfBytes.toString('latin1');
    expect(pdfBytes.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(pdfText).toContain('%%EOF');
    expectPdfToReference(pdfText, event.title);
    expectPdfToReference(pdfText, state.ticketIds[0]);
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

  test('completes a public resale purchase through hosted checkout UI', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `resale-buy-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);
    await seedPublishedEventPageContent({ event, suffix });

    await expectJsonResponse(
      await request.put(`${apiBaseUrl}/v1/events/${event.id}/resale-policy`, {
        data: {
          enabled: true,
          maxMultiplier: 1.2,
          maxAbsoluteCents: 3000,
        },
      }),
      200,
    );

    const sellerSession = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
        headers: { 'idempotency-key': `resale-seller-session-${suffix}` },
        data: {
          eventId: event.id,
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          buyer: {
            email: `resale-seller+${suffix}@example.com`,
            firstName: 'Resale',
            lastName: 'Seller',
          },
        },
      }),
      201,
    )) as { id: string; clientToken: string };
    await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/checkout/sessions/${sellerSession.id}/confirm`, {
        headers: {
          'idempotency-key': `resale-seller-confirm-${suffix}`,
          'x-checkout-session-token': sellerSession.clientToken,
        },
        data: { paymentMethodId: 'pm_card_visa' },
      }),
      200,
    );

    const sellerState = await readPaidCheckoutCaptureState(sellerSession.id, inventoryPool.id);
    const listing = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/tickets/${sellerState.ticketIds[0]}/resale-listings`, {
        headers: { 'Idempotency-Key': `resale-public-list-${suffix}` },
        data: { priceCents: 2500 },
      }),
      201,
    )) as { id: string; priceCents: number; status: string };
    expect(listing).toMatchObject({ status: 'listed', priceCents: 2500 });

    const publicListings = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/public/events/${event.id}/resale-listings`),
      200,
    )) as { items: Array<Record<string, unknown>> };
    expect(publicListings.items).toContainEqual(
      expect.objectContaining({
        id: listing.id,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        status: 'listed',
        priceCents: 2500,
      }),
    );
    expect(publicListings.items[0]).not.toHaveProperty('tenantId');
    expect(publicListings.items[0]).not.toHaveProperty('sellerId');
    expect(publicListings.items[0]).not.toHaveProperty('ticketId');

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.locator('header').getByRole('heading', { name: event.title })).toBeVisible();
    const resaleSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Resale tickets' }) });
    await expect(resaleSection.getByRole('heading', { name: 'Resale tickets' })).toBeVisible();
    await expect(
      resaleSection.getByText(`Resale ticket - ${ticketType.name}`, { exact: true }),
    ).toBeVisible();
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const { result } = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const resaleHeading = [...document.querySelectorAll('h2,h3')].some((node) => node.textContent?.includes('Resale tickets'));
          const buyButton = [...document.querySelectorAll('button')].some((node) => node.textContent?.includes('Buy resale'));
          return { resaleHeading, buyButton, url: location.href };
        })()`,
        returnByValue: true,
      });
      expect(result.value).toMatchObject({ resaleHeading: true, buyButton: true });
      await client.detach();
    }

    await page.getByRole('button', { name: 'Buy resale' }).click();
    await expect(page).toHaveURL(/\/checkout\?/);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(
      page.getByText(`Resale ticket - ${ticketType.name}`, { exact: true }).first(),
    ).toBeVisible();
    await page.getByLabel('Email').fill(`resale-buyer+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Resale');
    await page.getByLabel('Last name').fill('Buyer');
    await attachScreenshot(page, testInfo, 'hosted-resale-checkout-select');
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Pay $25.00' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay $25.00' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await attachScreenshot(page, testInfo, 'hosted-resale-checkout-confirmed');

    const resaleState = await readResalePurchaseState({
      listingId: listing.id,
      buyerEmail: `resale-buyer+${suffix}@example.com`,
    });
    expect(resaleState.listing).toMatchObject({
      status: 'sold',
      ticketId: sellerState.ticketIds[0],
      soldToId: resaleState.buyerOrder.id,
    });
    expect(resaleState.buyerOrder).toMatchObject({
      status: 'paid',
      totalCents: 2500,
    });
    expect(resaleState.lineItems).toContainEqual(
      expect.objectContaining({ resaleListingId: listing.id, totalCents: 2500 }),
    );
    expect(resaleState.buyerTickets).toHaveLength(1);
    expect(resaleState.buyerTickets[0]).toMatchObject({ status: 'valid' });
    expect(resaleState.sellerTicket).toMatchObject({
      id: sellerState.ticketIds[0],
      transferredToEmail: `resale-buyer+${suffix}@example.com`,
    });

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByRole('heading', { name: 'Resale tickets' })).toHaveCount(0);
  });

  test('uploads a checkout file answer through hosted checkout and consumes the artifact', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `file-upload-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);
    const question = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/events/${event.id}/questions`, {
        data: {
          type: 'file',
          label: 'Upload waiver',
          required: true,
          appliesTo: 'buyer',
        },
      }),
      201,
    )) as { id: string };

    const uploadPath = join(tmpdir(), `tixkit-waiver-${suffix}.txt`);
    writeFileSync(uploadPath, `waiver evidence ${suffix}`);
    try {
      await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);
      await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
      await page.getByRole('button', { name: `Increase ${ticketType.name} quantity` }).click();
      await page.getByLabel('Email').fill(`file-upload-ui+${suffix}@example.com`);
      await page.getByLabel('First name').fill('File');
      await page.getByLabel('Last name').fill('Buyer');
      await page.getByLabel(/Upload waiver/).setInputFiles(uploadPath);
      await expect(page.getByText('Uploaded', { exact: false })).toContainText(
        `tixkit-waiver-${suffix}.txt`,
      );
      await attachScreenshot(page, testInfo, 'hosted-file-upload-checkout-select');
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

      const state = await readPaidCheckoutCaptureState(sessionId!, inventoryPool.id);
      expect(state.session).toMatchObject({ status: 'completed', orderId });
      const answerState = await readCheckoutSessionArtifactAnswerState(sessionId!, question.id);
      const buyerFields = answerState.cart.buyerFields as Record<string, unknown>;
      expect(buyerFields[question.id]).toMatchObject({
        fileName: `tixkit-waiver-${suffix}.txt`,
        contentType: 'text/plain',
      });
      expect(answerState.artifact).toMatchObject({
        eventId: event.id,
        purpose: 'checkout_answer',
        status: 'uploaded',
        scanStatus: 'clean',
        metadata: { questionId: question.id },
        consumedByCheckoutSessionId: sessionId,
      });
    } finally {
      rmSync(uploadPath, { force: true });
    }
  });

  test('shows compensated orphan payments as expired with no tickets or wallet actions', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `orphan-payment-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);

    const session = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/checkout/sessions`, {
        headers: { 'idempotency-key': `orphan-payment-session-${suffix}` },
        data: {
          eventId: event.id,
          items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
          buyer: {
            email: `orphan-payment+${suffix}@example.com`,
            firstName: 'Orphan',
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

    expect(session).toMatchObject({
      status: 'open',
      quote: { totalCents: 2_500, currency: 'USD' },
    });

    const seeded = await seedCompensatedOrphanPaymentForSession({
      sessionId: session.id,
      amountCents: session.quote.totalCents,
      currency: session.quote.currency,
    });

    const publicSession = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/checkout/sessions/${session.id}`, {
        headers: { 'x-checkout-session-token': session.clientToken },
      }),
      200,
    )) as {
      status: string;
      orderId: string | null;
      paymentCompensation: {
        status: string;
        action: string;
        provider: string;
        providerIntentId: string;
        providerCompensationId: string;
      };
    };
    expect(publicSession).toMatchObject({
      status: 'expired',
      orderId: null,
      paymentCompensation: {
        status: 'succeeded',
        action: 'local_noop',
        provider: 'stripe_capture',
        providerIntentId: seeded.providerIntentId,
        providerCompensationId: `local:${seeded.providerIntentId}`,
      },
    });

    await page.addInitScript(
      ({ checkoutSessionId, clientToken }) => {
        window.sessionStorage.setItem(`tk:session:${checkoutSessionId}`, clientToken);
      },
      { checkoutSessionId: session.id, clientToken: session.clientToken },
    );
    await page.goto(
      `${checkoutBaseUrl}/checkout/confirmation?sessionId=${session.id}&redirect_status=succeeded`,
    );

    await expect(page.getByRole('heading', { level: 1, name: 'Checkout expired' })).toBeVisible();
    await expect(page.getByText('This payment was closed without issuing tickets.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toHaveCount(0);
    await expect(page.getByText('Thank you. Your tickets are on the way.')).toHaveCount(0);
    await expect(page.getByText('Add to Wallet')).toHaveCount(0);
    await attachScreenshot(page, testInfo, 'hosted-orphan-payment-compensated');
    await expectNoAxeViolations(page, testInfo);

    const state = await readOrphanPaymentCompensationState(session.id, inventoryPool.id);
    expect(state.session).toMatchObject({
      status: 'expired',
      orderId: null,
      paymentIntentId: seeded.paymentIntentId,
    });
    expect(state.paymentIntent).toMatchObject({
      id: seeded.paymentIntentId,
      provider: 'stripe_capture',
      providerIntentId: seeded.providerIntentId,
      status: 'succeeded',
      orderId: null,
    });
    expect(state.compensation).toMatchObject({
      status: 'succeeded',
      action: 'local_noop',
      provider: 'stripe_capture',
      providerIntentId: seeded.providerIntentId,
      providerCompensationId: `local:${seeded.providerIntentId}`,
      amountCents: 2_500,
      currency: 'USD',
    });
    expect(state.hold).toMatchObject({ status: 'released', quantity: 1 });
    expect(state.inventoryPool.soldCount).toBe(0);
    expect(state.ticketCount).toBe(0);
    expect(state.walletPassCount).toBe(0);
  });

  test('renders Apple and Google Wallet actions backed by signed pass artifacts', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    test.skip(
      process.env.E2E_WALLET_PASSES !== '1',
      'Set E2E_WALLET_PASSES=1 locally; CI enables ephemeral Apple/Google signing keys by default.',
    );
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `wallet-ui-${testInfo.workerIndex}-${Date.now()}`;
    const initialBrand = (await expectJsonResponse(
      await request.post(`${apiBaseUrl}/v1/brands`, {
        data: {
          organizationId: devOrganizationId,
          name: `Wallet Initial ${suffix}`,
          slug: `wallet-initial-${suffix}`,
          theme: { primaryColor: '#222222' },
          whiteLabel: true,
        },
      }),
      201,
    )) as { id: string };
    const configuredBrand = (await expectJsonResponse(
      await request.patch(`${apiBaseUrl}/v1/brands/${initialBrand.id}`, {
        data: {
          name: `Wallet Brand ${suffix}`,
          theme: { primaryColor: '#0f766e' },
        },
      }),
      200,
    )) as { id: string; name: string; theme: { primaryColor: string } };
    expect(configuredBrand).toMatchObject({
      id: initialBrand.id,
      name: `Wallet Brand ${suffix}`,
      theme: { primaryColor: '#0f766e' },
    });

    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix, {
      brandId: configuredBrand.id,
    });
    await expectJsonResponse(
      await request.put(`${apiBaseUrl}/v1/events/${event.id}/resale-policy`, {
        data: {
          enabled: true,
          maxMultiplier: 1.2,
          maxAbsoluteCents: 3000,
        },
      }),
      200,
    );

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${event.id}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await page.getByRole('button', { name: `Increase ${ticketType.name} quantity` }).click();
    await page.getByLabel('Email').fill(`wallet-ui+${suffix}@example.com`);
    await page.getByLabel('First name').fill('Wallet');
    await page.getByLabel('Last name').fill('Buyer');
    await expectNoAxeViolations(page, testInfo);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Pay $25.00' })).toBeVisible();
    await page.getByRole('button', { name: 'Pay $25.00' }).click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
    await expect(page.getByText('Add to Wallet')).toBeVisible();

    const appleLink = page.getByRole('link', { name: 'Apple Wallet' });
    const googleLink = page.getByRole('link', { name: 'Google Wallet' });
    await expect(appleLink).toBeVisible();
    await expect(googleLink).toBeVisible();

    const confirmationUrl = new URL(page.url());
    const sessionId = confirmationUrl.searchParams.get('sessionId');
    const orderId = confirmationUrl.searchParams.get('orderId');
    expect(sessionId).toEqual(expect.any(String));
    expect(orderId).toEqual(expect.any(String));
    await attachScreenshot(page, testInfo, 'hosted-wallet-pass-confirmed');

    const state = await readPaidCheckoutCaptureState(sessionId!, inventoryPool.id);
    expect(state.session).toMatchObject({
      status: 'completed',
      orderId,
    });
    expect(state.ticketCount).toBe(1);
    expect(state.ticketQrPayloads).toHaveLength(1);
    expect(state.ticketQrPayloads[0]).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));

    const walletPasses = await readWalletPassState(sessionId!);
    expect(walletPasses).toHaveLength(2);
    expect(walletPasses.map((pass) => pass.provider).toSorted()).toEqual(['apple', 'google']);
    const applePass = walletPasses.find((pass) => pass.provider === 'apple');
    const googlePass = walletPasses.find((pass) => pass.provider === 'google');
    expect(applePass).toMatchObject({
      status: 'active',
      contentType: 'application/vnd.apple.pkpass',
      ticketId: state.ticketIds[0],
    });
    expect(applePass?.accessTokenHash).toEqual(expect.any(String));
    expect(
      Buffer.from(applePass?.artifactBase64 ?? '', 'base64')
        .subarray(0, 2)
        .toString(),
    ).toBe('PK');
    expect(googlePass).toMatchObject({
      status: 'active',
      ticketId: state.ticketIds[0],
    });
    expect(googlePass?.passUrl).toContain('https://pay.google.com/gp/v/save/');

    const appleHref = await appleLink.getAttribute('href');
    const googleHref = await googleLink.getAttribute('href');
    expect(appleHref).toBe(applePass?.passUrl);
    expect(googleHref).toBe(googlePass?.passUrl);

    const passResponse = await request.get(appleHref!);
    expect(passResponse.status()).toBe(200);
    expect(passResponse.headers()['content-type']).toContain('application/vnd.apple.pkpass');
    const passBytes = await passResponse.body();
    expect(passBytes.subarray(0, 2).toString()).toBe('PK');
    const { passJson, passJsonBytes, manifest, signature } = readApplePassEntries(passBytes);
    expect(signature.byteLength).toBeGreaterThan(64);
    expect(manifest['pass.json']).toBe(createHash('sha1').update(passJsonBytes).digest('hex'));
    expect(passJson).toMatchObject({
      description: `${event.title} ticket`,
      organizationName: configuredBrand.name,
      backgroundColor: 'rgb(15, 118, 110)',
    });
    expect(passFieldGroup(passJson, 'primaryFields')).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'event', value: event.title })]),
    );
    expect(passFieldGroup(passJson, 'headerFields')).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'ticket', value: ticketType.name })]),
    );
    expect(passFieldGroup(passJson, 'auxiliaryFields')).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'holder', value: 'Wallet Buyer' })]),
    );
    expect(passJson).toMatchObject({
      barcodes: [
        expect.objectContaining({
          altText: applePass?.ticketCode,
          format: 'PKBarcodeFormatQR',
          message: state.ticketQrPayloads[0],
        }),
      ],
    });
    const googlePayload = decodeGoogleWalletPayload(googleHref!);
    expect(googlePayload.eventTicketClasses[0]).toMatchObject({
      issuerName: configuredBrand.name,
    });
    expect(googlePayload.eventTicketObjects[0]).toMatchObject({
      barcode: {
        alternateText: googlePass?.ticketCode,
        type: 'QR_CODE',
        value: state.ticketQrPayloads[0],
      },
      hexBackgroundColor: configuredBrand.theme.primaryColor,
    });

    await page.getByRole('button', { name: 'List for resale' }).click();
    await page.getByLabel('Resale price').fill('25.00');
    const resaleResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            `/v1/checkout/sessions/${sessionId}/tickets/${state.ticketIds[0]}/resale-listing`,
          ) && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create listing' }).click();
    expect((await resaleResponse).status()).toBe(201);
    await expect(page.getByText('Listed for $25.00')).toBeVisible();

    const listings = (await expectJsonResponse(
      await request.get(`${apiBaseUrl}/v1/events/${event.id}/resale-listings`),
      200,
    )) as { items: Array<{ ticketId: string; status: string; priceCents: number }> };
    expect(listings.items).toContainEqual(
      expect.objectContaining({
        ticketId: state.ticketIds[0],
        status: 'listed',
        priceCents: 2500,
      }),
    );

    await attachScreenshot(page, testInfo, 'hosted-wallet-pass-resale-listed');
    await expectNoAxeViolations(page, testInfo);
    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const { result } = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const buttons = [...document.querySelectorAll('button')].map((node) => node.textContent?.trim());
          const listed = document.body.textContent?.includes('Listed for $25.00') ?? false;
          return { listed, buttons };
        })()`,
        returnByValue: true,
      });
      expect(result.value).toMatchObject({
        listed: true,
      });
      await client.detach();
    }
  });

  test('applies a hosted promo code and persists discount redemption in local capture mode', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    const suffix = `paid-promo-ui-${testInfo.workerIndex}-${Date.now()}`;
    const { event, ticketType, inventoryPool, discountCode } = await seedPaidPromoCheckoutEvent(
      request,
      suffix,
    );

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

    const state = await readPromoCheckoutCaptureState(
      sessionId!,
      inventoryPool.id,
      discountCode.id,
    );
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
