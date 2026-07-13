import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { seedEventMediaFixture, seedFreeCheckoutEvent } from './helpers/seed';

const transparentPixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test.describe('role-based event media journeys', () => {
  test('organizer media settings expose accessible role thumbnails and per-role crop controls', async ({
    page,
    request,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    const seeded = await seedFreeCheckoutEvent(request, `media-admin-${Date.now()}`);
    const renditionUrl = `${apiBaseUrl}/v1/public/event-media/renditions/emr_e2e_cover`;

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
              },
            ],
          },
        ]),
      }),
    );
    await page.route(renditionUrl, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: transparentPixel }),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${adminBaseUrl}/events/${seeded.event.id}/settings`);
    if (new URL(page.url()).pathname === '/sign-in')
      test.skip(true, 'runtime admin server requires live Clerk authentication');

    await expect(
      page.getByRole('heading', { name: 'Event poster, cover, and social images' }),
    ).toBeVisible();
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
    const media = await seedEventMediaFixture({ eventId: seeded.event.id, suffix });
    await page.route(`${apiBaseUrl}${media.renditionPath}`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: transparentPixel }),
    );

    await page.goto(`${checkoutBaseUrl}/e/${seeded.event.id}`);
    await expect(page.getByRole('heading', { name: seeded.event.title })).toBeVisible();
    await expect(page.getByAltText('Poster of the Media Browser Proof event')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });
});
