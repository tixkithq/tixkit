import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectNoAxeViolations } from './helpers/axe';
import { apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  readPromoCheckoutCaptureState,
  readPaidCheckoutCaptureState,
  readWalletPassState,
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

  test('renders Apple and Google Wallet actions backed by signed pass artifacts', async ({
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
    const { event, ticketType, inventoryPool } = await seedPaidCheckoutEvent(request, suffix);

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

    const walletPasses = await readWalletPassState(sessionId!);
    expect(walletPasses).toHaveLength(2);
    expect(walletPasses.map((pass) => pass.provider).sort()).toEqual(['apple', 'google']);
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
      organizationName: 'Tixkit E2E',
      backgroundColor: 'rgb(99, 102, 241)',
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
