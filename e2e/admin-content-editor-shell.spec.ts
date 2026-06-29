import { type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl } from './helpers/env';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;
const fixtureEventId = 'evt_demo_001';

const unavailableRoutes = [
  {
    path: `/events/${fixtureEventId}/content/imessage`,
    heading: 'iMessage template unavailable',
    preview: 'Unavailable preview',
    name: 'imessage',
    minCanvasWidth: 500,
  },
  {
    path: `/events/${fixtureEventId}/content/social-invite`,
    heading: 'Social invite unavailable',
    preview: 'Unavailable preview',
    name: 'social-invite',
    minCanvasWidth: 500,
  },
] as const;

type UnavailableRoute = (typeof unavailableRoutes)[number];

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function expectShellRegions(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.getByLabel('Insert blocks').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish unavailable' })).toBeDisabled();
}

async function expectUnavailableRoute(
  page: Page,
  testInfo: TestInfo,
  route: UnavailableRoute,
): Promise<void> {
  await page.setViewportSize(desktopViewport);
  await page.goto(`${adminBaseUrl}${route.path}`);
  await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
  await expectShellRegions(page);
  await page.getByRole('button', { name: 'Open preview' }).click();
  await expect(page.getByTestId('preview-drawer')).toContainText(route.preview);
  await attachScreenshot(page, testInfo, `content-editor-${route.name}-desktop`);
  await expectNoAxeViolations(page, testInfo);

  await page.setViewportSize(mobileViewport);
  await page.goto(`${adminBaseUrl}${route.path}`);
  await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
  await expectShellRegions(page);
  await attachScreenshot(page, testInfo, `content-editor-${route.name}-mobile`);
  await expectNoAxeViolations(page, testInfo);
}

async function expectCdpLayoutForRoute(
  page: Page,
  testInfo: TestInfo,
  route: UnavailableRoute,
): Promise<void> {
  await page.setViewportSize(desktopViewport);
  await page.goto(`${adminBaseUrl}${route.path}`);
  await expectShellRegions(page);

  const client = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const [shell, canvas, rail] = await Promise.all([
    client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="content-editor-shell"]',
    }),
    client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[data-testid="editor-canvas"]',
    }),
    client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '[aria-label="Insert blocks"]',
    }),
  ]);

  const [shellBox, canvasBox, railBox] = await Promise.all([
    client.send('DOM.getBoxModel', { nodeId: shell.nodeId }),
    client.send('DOM.getBoxModel', { nodeId: canvas.nodeId }),
    client.send('DOM.getBoxModel', { nodeId: rail.nodeId }),
  ]);

  await testInfo.attach(`cdp-layout-boxes-${route.name}`, {
    body: JSON.stringify({ shellBox, canvasBox, railBox }, null, 2),
    contentType: 'application/json',
  });

  expect(shell.nodeId).toBeGreaterThan(0);
  expect(canvas.nodeId).toBeGreaterThan(0);
  expect(rail.nodeId).toBeGreaterThan(0);
  expect(widthOf(shellBox.model.content)).toBeGreaterThan(900);
  expect(widthOf(canvasBox.model.content)).toBeGreaterThan(route.minCanvasWidth);
  expect(widthOf(railBox.model.content)).toBeGreaterThan(40);
  await client.detach();
}

test.describe('admin content editor shell', () => {
  test('renders future-channel unavailable routes with axe and no-console gates', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await expectUnavailableRoute(page, testInfo, unavailableRoutes[0]);
    await expectUnavailableRoute(page, testInfo, unavailableRoutes[1]);
  });

  test('captures Chromium layout metrics through CDP', async ({ browserName, page }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await expectCdpLayoutForRoute(page, testInfo, unavailableRoutes[0]);
    await expectCdpLayoutForRoute(page, testInfo, unavailableRoutes[1]);
  });
});

function widthOf(quad: number[]): number {
  return Math.abs(quad[2] - quad[0]);
}
