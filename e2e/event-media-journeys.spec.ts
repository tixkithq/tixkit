import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  countEventMediaRemovalAudits,
  readEventMediaCleanupJobs,
  seedEventMediaFixture,
  seedFreeCheckoutEvent,
} from './helpers/seed';

const transparentPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const responsiveMediaViewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

async function focusWithKeyboard(page: Page, targetName: string, focusKey = 'Tab') {
  const target = page.getByRole('button', { name: targetName });
  await expect(target).toBeVisible();

  for (let tabIndex = 0; tabIndex < 10; tabIndex += 1) {
    await page.keyboard.press(focusKey);
    if (await target.evaluate((element) => element === document.activeElement)) return target;
  }

  throw new Error(`Keyboard focus did not reach the "${targetName}" button after 10 Tab presses`);
}

async function installLargestContentfulPaintObserver(page: Page) {
  await page.addInitScript(() => {
    window.__tixkitLargestContentfulPaint = 0;
    if (!('PerformanceObserver' in window)) return;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__tixkitLargestContentfulPaint = Math.max(
            window.__tixkitLargestContentfulPaint,
            entry.startTime,
          );
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // Firefox and WebKit do not expose LargestContentfulPaint yet. Decode,
      // semantic, and axe assertions still run in every browser below.
    }
  });
}

async function readEventMediaResourceTiming(page: Page, renditionPath: string) {
  return page.evaluate((expectedPath) => {
    const entries = performance
      .getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => {
        if (!(entry instanceof PerformanceResourceTiming)) return false;
        try {
          return new URL(entry.name).pathname === expectedPath;
        } catch {
          return false;
        }
      });
    const entry = entries.at(-1);
    return entry
      ? {
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          transferSize: entry.transferSize,
          origin: new URL(entry.name).origin,
        }
      : undefined;
  }, renditionPath);
}

declare global {
  interface Window {
    __tixkitLargestContentfulPaint: number;
  }
}

test.describe('role-based event media journeys', () => {
  test('organizer uploads, scans, finalizes, and renders a real poster through object storage', async ({
    page,
    request,
  }, testInfo) => {
    testInfo.setTimeout(60_000);
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    const suffix = `media-upload-${testInfo.project.name}-${Date.now()}`;
    const seeded = await seedFreeCheckoutEvent(request, suffix);

    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/settings`);
    if (new URL(page.url()).pathname === '/sign-in')
      test.skip(true, 'runtime admin server requires live Clerk authentication');

    const altText = `Tixkit poster uploaded in ${testInfo.project.name}`;
    await page.locator('#event-poster-alt').fill(altText);
    await page.locator('#event-poster-upload').setInputFiles({
      name: 'event-poster.png',
      mimeType: 'image/png',
      buffer: await readFile('apps/admin-dashboard/public/brand/tixkit-symbol.png'),
    });

    await page.getByRole('heading', { name: 'Poster', exact: true }).scrollIntoViewIfNeeded();
    const preview = page.getByAltText(altText);
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toHaveAttribute('src', /^blob:/u);

    const mediaResponse = await request.get(`${apiBaseUrl}/v1/events/${seeded.event.id}/media`);
    expect(mediaResponse.status()).toBe(200);
    const media = (await mediaResponse.json()) as Array<{
      role: string;
      altText: string;
      original: { checksumSha256: string };
      renditions: Array<{
        id: string;
        variant: 'thumbnail' | 'card' | 'page' | 'social';
        checksumSha256: string;
        sizeBytes: number;
        width: number;
        height: number;
        url: string;
        organizerUrl: string;
      }>;
    }>;
    const poster = media.find((asset) => asset.role === 'poster');
    expect(poster).toMatchObject({ altText });
    expect(poster?.original.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(poster?.renditions.map((rendition) => rendition.variant).sort()).toEqual([
      'card',
      'page',
      'social',
      'thumbnail',
    ]);
    expect(
      poster?.renditions.every((rendition) => /^[a-f0-9]{64}$/u.test(rendition.checksumSha256)),
    ).toBe(true);
    const renditionBudgets = {
      thumbnail: 150_000,
      card: 200_000,
      page: 600_000,
      social: 400_000,
    } as const;
    const renditionDimensions = {
      thumbnail: [320, 320],
      card: [480, 270],
      page: [1080, 1350],
      social: [1200, 630],
    } as const;
    for (const rendition of poster!.renditions) {
      expect(rendition.sizeBytes).toBeLessThanOrEqual(renditionBudgets[rendition.variant]);
      expect([rendition.width, rendition.height]).toEqual(renditionDimensions[rendition.variant]);
      const delivered = await request.get(`${apiBaseUrl}${rendition.organizerUrl}`);
      expect(delivered.status()).toBe(200);
      expect(delivered.headers()['cache-control']).toBe('private, max-age=31536000, immutable');
      const deliveredBody = await delivered.body();
      expect(deliveredBody.byteLength).toBe(rendition.sizeBytes);
      expect(createHash('sha256').update(deliveredBody).digest('hex')).toBe(
        rendition.checksumSha256,
      );
      const publicDelivery = await request.get(`${apiBaseUrl}${rendition.url}`);
      expect(publicDelivery.status()).toBe(200);
      expect(publicDelivery.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    }

    const concurrentReplacement = {
      uploadArtifactId: poster!.original.uploadArtifactId,
      altText,
      focalPoint: { x: 0.5, y: 0.5 },
    };
    const concurrentStatuses = (
      await Promise.all([
        request.put(`${apiBaseUrl}/v1/events/${seeded.event.id}/media/poster`, {
          data: concurrentReplacement,
          headers: { 'x-tixkit-e2e-media-replacement-barrier': '1' },
        }),
        request.put(`${apiBaseUrl}/v1/events/${seeded.event.id}/media/poster`, {
          data: concurrentReplacement,
          headers: { 'x-tixkit-e2e-media-replacement-barrier': '1' },
        }),
      ])
    )
      .map((response) => response.status())
      .sort();
    expect(concurrentStatuses).toEqual([200, 400]);
    await expect
      .poll(async () => readEventMediaCleanupJobs(seeded.event.id, 'event-media-replaced'))
      .toHaveLength(4);

    const replaced = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        response.url().endsWith(`/v1/events/${seeded.event.id}/media/poster`),
    );
    await page.locator('#event-poster-upload').setInputFiles({
      name: 'replacement-poster.png',
      mimeType: 'image/png',
      buffer: await readFile('apps/admin-dashboard/public/brand/tixkit-symbol.png'),
    });
    const replacementResponse = await replaced;
    expect(replacementResponse.status()).toBe(200);
    const replacementMedia = (await replacementResponse.json()) as {
      renditions: Array<{
        variant: string;
        url: string;
        sizeBytes: number;
        checksumSha256: string;
      }>;
    };
    const replacementPage = replacementMedia.renditions.find(
      (rendition) => rendition.variant === 'page',
    );
    const replacementSocialUrl = replacementMedia.renditions.find(
      (rendition) => rendition.variant === 'social',
    )?.url;
    expect(replacementPage).toBeTruthy();
    expect(replacementPage!.sizeBytes).toBeLessThanOrEqual(600_000);
    expect(replacementPage!.checksumSha256).toMatch(/^[a-f0-9]{64}$/u);
    const replacementDelivery = await request.get(new URL(replacementPage!.url, apiBaseUrl).href);
    expect(replacementDelivery.status()).toBe(200);
    const replacementBytes = await replacementDelivery.body();
    expect(replacementBytes.byteLength).toBe(replacementPage!.sizeBytes);
    expect(createHash('sha256').update(replacementBytes).digest('hex')).toBe(
      replacementPage!.checksumSha256,
    );
    expect(replacementSocialUrl).toBeTruthy();
    const expectedSocialUrl = new URL(replacementSocialUrl!, apiBaseUrl).href;
    const expectedPagePath = new URL(replacementPage!.url, apiBaseUrl).pathname;
    await expect
      .poll(async () => readEventMediaCleanupJobs(seeded.event.id, 'event-media-replaced'))
      .toHaveLength(8);
    await expectNoAxeViolations(
      page,
      testInfo,
      'section[aria-labelledby="event-role-media-heading"]',
    );

    await installLargestContentfulPaintObserver(page);
    const buyerMediaRequestPaths: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path.includes('/event-media/') ||
        path.includes('/media/renditions/') ||
        path.includes('/upload-artifacts/')
      )
        buyerMediaRequestPaths.push(path);
    });
    const viewports = testInfo.project.name.startsWith('mobile-')
      ? [responsiveMediaViewports[0]]
      : responsiveMediaViewports;
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`${checkoutBaseUrl}/e/${seeded.event.id}`);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('heading', { name: seeded.event.title })).toBeVisible();
      const buyerPoster = page.getByAltText(altText);
      await expect(buyerPoster).toBeVisible();
      await expect(buyerPoster).toHaveAttribute(
        'src',
        new URL(replacementPage!.url, apiBaseUrl).href,
      );
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        'content',
        expectedSocialUrl,
      );
      await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
        'content',
        expectedSocialUrl,
      );
      await buyerPoster.evaluate((image: HTMLImageElement) => image.decode());
      const initialTiming = await readEventMediaResourceTiming(page, expectedPagePath);
      expect(
        initialTiming,
        `${viewport.name} page rendition timing should be visible`,
      ).toBeDefined();
      expect(initialTiming!.encodedBodySize).toBeGreaterThan(0);
      expect(initialTiming!.encodedBodySize).toBeLessThanOrEqual(replacementPage!.sizeBytes);
      expect(initialTiming!.decodedBodySize).toBeGreaterThan(0);
      expect(initialTiming!.transferSize).toBeGreaterThanOrEqual(0);
      expect(initialTiming!.origin).toBe(new URL(replacementPage!.url, apiBaseUrl).origin);
      const performance = await buyerPoster.evaluate((image: HTMLImageElement) => {
        return {
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          largestContentfulPaintMs: window.__tixkitLargestContentfulPaint,
          supportsLargestContentfulPaint:
            typeof PerformanceObserver !== 'undefined' &&
            PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint'),
        };
      });
      expect(performance.naturalWidth, `${viewport.name} poster should decode`).toBeGreaterThan(0);
      expect(performance.naturalHeight, `${viewport.name} poster should decode`).toBeGreaterThan(0);
      if (performance.supportsLargestContentfulPaint) {
        await buyerPoster.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => setTimeout(resolve, 500));
              });
            }),
        );
        const settledLargestContentfulPaint = await page.evaluate(
          () => window.__tixkitLargestContentfulPaint,
        );
        expect(settledLargestContentfulPaint).toBeGreaterThan(0);
        expect(settledLargestContentfulPaint).toBeLessThanOrEqual(4_000);
      }
      await expectNoAxeViolations(page, testInfo, 'main');

      await page.reload();
      const cachedBuyerPoster = page.getByAltText(altText);
      await expect(cachedBuyerPoster).toBeVisible();
      await cachedBuyerPoster.evaluate((image: HTMLImageElement) => image.decode());
      const cachedTiming = await readEventMediaResourceTiming(page, expectedPagePath);
      expect(
        cachedTiming,
        `${viewport.name} cached rendition timing should be visible`,
      ).toBeDefined();
      expect(cachedTiming!.encodedBodySize).toBe(initialTiming!.encodedBodySize);
      expect(cachedTiming!.decodedBodySize).toBe(initialTiming!.decodedBodySize);
      expect(cachedTiming!.transferSize).toBeGreaterThanOrEqual(0);
      expect(cachedTiming!.origin).toBe(initialTiming!.origin);
    }
    expect(buyerMediaRequestPaths.length).toBeGreaterThan(0);
    expect([...new Set(buyerMediaRequestPaths)]).toEqual([expectedPagePath]);

    await page.setViewportSize(
      testInfo.project.name.startsWith('mobile-')
        ? responsiveMediaViewports[0]
        : responsiveMediaViewports[1],
    );
    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/settings`);
    await page.getByRole('heading', { name: 'Poster', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByAltText(altText)).toBeVisible();

    const confirmation = new Promise<void>((resolve, reject) => {
      page.once('dialog', async (dialog) => {
        try {
          expect(dialog.type()).toBe('confirm');
          expect(dialog.message()).toBe('Remove the poster image and its published renditions?');
          await dialog.accept();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/v1/events/${seeded.event.id}/media/poster`),
    );
    const posterUpload = page.locator('#event-poster-upload');
    await posterUpload.focus();
    await expect(posterUpload).toBeFocused();
    const removePoster = await focusWithKeyboard(
      page,
      'Remove poster',
      testInfo.project.name.includes('webkit') ? 'Alt+Tab' : 'Tab',
    );
    await expect(removePoster).toBeFocused();
    await page.keyboard.press('Enter');
    await confirmation;
    expect((await removed).status()).toBe(204);
    await expect(page.getByAltText(altText)).toHaveCount(0);
    await expect
      .poll(async () => readEventMediaCleanupJobs(seeded.event.id, 'event-media-removed'))
      .toHaveLength(4);
    await expect.poll(() => countEventMediaRemovalAudits(seeded.event.id)).toBe(1);
    expect(
      (await request.delete(`${apiBaseUrl}/v1/events/${seeded.event.id}/media/poster`)).status(),
    ).toBe(404);
  });

  test('organizer media settings expose accessible role thumbnails and per-role crop controls', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    const seeded = await seedFreeCheckoutEvent(request, `media-admin-${Date.now()}`);
    const renditionUrl = `${apiBaseUrl}/v1/events/${seeded.event.id}/media/renditions/emr_e2e_cover`;

    await page.route(`${apiBaseUrl}/v1/events/${seeded.event.id}/media`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ema_e2e_cover',
            role: 'cover',
            original: {
              uploadArtifactId: 'upl_e2e_cover',
              width: 1600,
              height: 900,
              format: 'webp',
              checksumSha256: 'a'.repeat(64),
              sizeBytes: 1024,
            },
            focalPoint: { x: 0.35, y: 0.6 },
            altText: 'Audience beneath violet stage lights',
            renditions: [
              {
                id: 'emr_e2e_cover',
                variant: 'thumbnail',
                width: 480,
                height: 270,
                format: 'webp',
                checksumSha256: 'b'.repeat(64),
                sizeBytes: transparentPixel.byteLength,
                url: '/v1/public/event-media/renditions/emr_e2e_cover',
                organizerUrl: `/v1/events/${seeded.event.id}/media/renditions/emr_e2e_cover`,
              },
            ],
          },
        ]),
      }),
    );
    await page.route(renditionUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: transparentPixel,
      }),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/settings`);
    if (new URL(page.url()).pathname === '/sign-in')
      test.skip(true, 'runtime admin server requires live Clerk authentication');

    await expect(
      page.getByRole('heading', {
        name: 'Event poster, cover, and social images',
      }),
    ).toBeVisible();
    await page.getByRole('heading', { name: 'Cover', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByAltText('Audience beneath violet stage lights')).toBeVisible();
    await expect(page.getByRole('slider', { name: 'cover horizontal focal point' })).toHaveValue(
      '0.35',
    );
    await expect(page.getByRole('slider', { name: 'cover vertical focal point' })).toHaveValue(
      '0.6',
    );
    await page.getByRole('slider', { name: 'cover horizontal focal point' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('slider', { name: 'cover horizontal focal point' })).toHaveValue(
      '0.36',
    );
    await expectNoAxeViolations(
      page,
      testInfo,
      'section[aria-labelledby="event-role-media-heading"]',
    );
  });

  test('buyer event page renders deterministic owned-media fallback without console errors', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    const suffix = `media-buyer-${testInfo.project.name}-${Date.now()}`;
    const seeded = await seedFreeCheckoutEvent(request, suffix);
    const media = await seedEventMediaFixture({
      eventId: seeded.event.id,
      suffix,
    });
    await page.route(`${apiBaseUrl}${media.renditionPath}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: transparentPixel,
      }),
    );

    await page.goto(`${checkoutBaseUrl}/e/${seeded.event.id}`);
    await expect(page.getByRole('heading', { name: seeded.event.title })).toBeVisible();
    await expect(page.getByAltText('Poster of the Media Browser Proof event')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });
});
