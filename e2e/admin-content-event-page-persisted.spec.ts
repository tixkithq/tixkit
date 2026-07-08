import { type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId } from './helpers/seed';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;
const puckProvider = '@puckeditor/core';

type SeededContentEvent = {
  id: string;
  title: string;
  description?: string;
  ticketType: {
    id: string;
    name: string;
  };
};

type PuckComponent = {
  type: string;
  props: Record<string, unknown>;
};

type PuckData = {
  root: { props: Record<string, unknown> };
  content: PuckComponent[];
  zones?: Record<string, PuckComponent[]>;
};

type EventPageDocumentV2 = {
  schemaVersion: 2;
  editor: {
    provider: typeof puckProvider;
    data: PuckData;
  };
  settings: {
    locale: string;
    discovery: {
      title?: string;
      summary: string;
      tags: string[];
      seoTitle?: string;
      seoDescription?: string;
    };
  };
};

type ContentDocumentList = {
  items: Array<{
    id: string;
    channel: string;
    status: string;
    eventId: string | null;
    publishedVersionId?: string | null;
    currentDraftVersionId?: string | null;
  }>;
};

type ContentVersionList = {
  items: Array<{
    id: string;
    status: string;
    versionNumber: number;
    subject?: string;
    previewText?: string;
    contentJson: EventPageDocumentV2;
  }>;
};

type PublicContentPage = {
  document: {
    eventId: string;
    channel: string;
    key: string;
    locale: string;
  };
  version: {
    versionNumber: number;
    subject?: string;
    previewText?: string;
    publishedAt?: string;
  };
  page: {
    provider: typeof puckProvider;
    puckData: PuckData | null;
    settings?: Record<string, unknown>;
    discovery: {
      title: string;
      summary: string;
      tags: string[];
    };
  } & Record<string, unknown>;
};

async function jsonResponse<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  const body = await response.json().catch(async () => ({
    raw: await response.text(),
  }));
  expect(response.status(), JSON.stringify(body, null, 2)).toBe(expectedStatus);
  return body as T;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function seedContentEvent(page: Page, suffix: string): Promise<SeededContentEvent> {
  const event = await jsonResponse<Omit<SeededContentEvent, 'ticketType'>>(
    await page.request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-content-event-page-${suffix}`,
        title: `E2E Event Page Studio ${suffix}`,
        description: 'Seeded by Playwright for Puck event-page editor coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-11-17T23:00:00.000Z',
        endsAt: '2026-11-18T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  );
  const pool = await jsonResponse<{ id: string }>(
    await page.request.post(`${apiBaseUrl}/v1/events/${event.id}/inventory-pools`, {
      data: {
        name: 'General admission',
        totalCapacity: 25,
        holdTtlSeconds: 600,
      },
    }),
    201,
  );
  const ticketType = await jsonResponse<{ id: string; name: string }>(
    await page.request.post(`${apiBaseUrl}/v1/events/${event.id}/ticket-types`, {
      data: {
        name: 'General Admission',
        kind: 'free',
        visibility: 'public',
        currency: 'USD',
        priceCents: 0,
        inventoryPoolId: pool.id,
        minPerOrder: 1,
        maxPerOrder: 4,
      },
    }),
    201,
  );
  await jsonResponse<Omit<SeededContentEvent, 'ticketType'>>(
    await page.request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );
  return { ...event, ticketType };
}

async function loadEventPageContentState(eventId: string, page: Page) {
  const documents = await jsonResponse<ContentDocumentList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents`, {
      params: {
        channel: 'event_page',
        brandId: devBrandId,
        eventId,
        limit: '10',
      },
    }),
    200,
  );
  const document = documents.items.find(
    (item) => item.channel === 'event_page' && item.eventId === eventId,
  );
  expect(document).toBeTruthy();
  const versions = await jsonResponse<ContentVersionList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents/${document!.id}/versions`),
    200,
  );
  return { document: document!, versions: versions.items };
}

async function expectPersistedEventPageEditorRegions(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Editor header' })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Event page editable document' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Editor tools' })).toBeVisible();
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Editor' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await expect(page.getByLabel('More actions')).toBeVisible();
}

async function expectPuckEditorCanvas(page: Page, event: SeededContentEvent): Promise<void> {
  const canvas = page.locator('[data-testid="editor-canvas"]').first();
  await expect(canvas).toHaveAttribute('aria-label', 'Event page editable document');
  await expect(canvas.locator('iframe').first()).toBeVisible();

  const frame = page.frameLocator('[data-testid="editor-canvas"] iframe');
  await expect(frame.locator('.tixkit-event-page').first()).toBeVisible();
  await expect(frame.locator('.tixkit-event-page').first()).toHaveAttribute(
    'data-schema-provider',
    puckProvider,
  );
  await expect(frame.locator('.tk-ep-hero').first()).toHaveAttribute(
    'data-block-id',
    new RegExp(`^hero-${event.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
  );
  await expect(frame.getByRole('heading', { name: event.title, level: 1 })).toBeVisible();
  await expect(frame.locator('.tk-ep-tickets')).toHaveCount(0);
  await expect(frame.locator('.tk-ep-resale-tickets')).toHaveCount(0);
}

function expectContentOnlyPuckData(data: PuckData | null | undefined): asserts data is PuckData {
  expect(data).toBeTruthy();
  expect(data?.root).toHaveProperty('props');
  expect(Array.isArray(data?.content)).toBe(true);
  const componentTypes = data!.content.map((block) => block.type);
  expect(componentTypes).toEqual(
    expect.arrayContaining(['Hero', 'EventDetails', 'Schedule', 'Venue', 'FAQ']),
  );
  expect(componentTypes).not.toEqual(
    expect.arrayContaining(['Tickets', 'ResaleTickets', 'Footer', 'tickets', 'resale_tickets']),
  );
}

async function saveDraftFromHeader(page: Page): Promise<void> {
  const header = page.getByRole('region', { name: 'Editor header' });
  await header.getByLabel('More actions').click();
  await page.getByRole('menuitem', { name: 'Save draft' }).click();
  await expect(page.getByText(/Saved draft v\d+/)).toBeVisible();
}

async function publishFromHeader(page: Page): Promise<void> {
  const header = page.getByRole('region', { name: 'Editor header' });
  await header.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();
}

test.describe('persisted admin event-page Puck editor', () => {
  test.setTimeout(180_000);

  test('saves, previews, publishes, renders publicly, and reloads a canonical Puck event page', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const event = await seedContentEvent(page, suffix);
    const eventSummary = event.description ?? 'Seeded by Playwright for Puck event-page editor coverage.';

    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectPuckEditorCanvas(page, event);

    await saveDraftFromHeader(page);

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('Preview opened from the saved Puck document')).toBeVisible();
    const canvasPreview = page.locator(
      '[data-testid="editor-canvas"] [data-testid="preview-surface"]',
    );
    await expect(canvasPreview.locator('.tixkit-event-page-puck-scope')).toBeVisible();
    await expect(canvasPreview.locator('.tixkit-event-page')).toHaveAttribute(
      'data-schema-provider',
      puckProvider,
    );
    await expect(canvasPreview.locator('.tk-ep-hero')).toContainText(event.title);
    await expect(canvasPreview.locator('.tk-ep-tickets')).toHaveCount(0);
    await page.getByTestId('preview-drawer').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('preview-drawer')).toBeHidden();
    await page.getByRole('button', { name: 'Editor' }).click();
    await expectPuckEditorCanvas(page, event);

    await publishFromHeader(page);

    const persisted = await loadEventPageContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    const publishedVersion = persisted.versions.find((version) => version.status === 'published');
    expect(publishedVersion).toBeTruthy();
    expect(publishedVersion?.contentJson.schemaVersion).toBe(2);
    expect(publishedVersion?.contentJson.editor.provider).toBe(puckProvider);
    expect(publishedVersion?.contentJson.settings.discovery.summary).toBe(eventSummary);
    expectContentOnlyPuckData(publishedVersion?.contentJson.editor.data);

    const publicPage = await jsonResponse<PublicContentPage>(
      await page.request.get(`${apiBaseUrl}/v1/public/events/${event.id}/page`),
      200,
    );
    expect(publicPage.document.eventId).toBe(event.id);
    expect(publicPage.document.channel).toBe('event_page');
    expect(publicPage.version.subject).toBe(event.title);
    expect(publicPage.page.provider).toBe(puckProvider);
    expect(publicPage.page.discovery.summary).toBe(eventSummary);
    expect(publicPage.page).not.toHaveProperty('html');
    expect(publicPage.page).not.toHaveProperty('text');
    expect(publicPage.page).not.toHaveProperty('headless');
    expect(publicPage.page).not.toHaveProperty('renderModel');
    expectContentOnlyPuckData(publicPage.page.puckData);

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByText(event.title, { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('published-event-page')).toContainText(event.title);
    await expect(page.getByTestId('published-event-page')).toContainText(eventSummary);
    await expect(
      page.locator('[data-testid="published-event-page"] .tixkit-event-page-puck-scope'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="published-event-page"] .tixkit-event-page'),
    ).toHaveAttribute('data-schema-provider', puckProvider);
    await expect(page.locator('[data-testid="published-event-page"] .tk-ep-hero')).toHaveAttribute(
      'data-block-id',
      new RegExp(`^hero-${event.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    );
    await expect(page.locator('[data-testid="published-event-page"] .tk-ep-tickets')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Tickets', level: 2 })).toBeVisible();
    await expect(page.getByText(event.ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get tickets' })).toBeVisible();
    await attachScreenshot(page, testInfo, 'checkout-event-page-puck-content-desktop');
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const hostedSelectors = {
        main: 'main',
        puckScope: '[data-testid="published-event-page"] .tixkit-event-page-puck-scope',
        hero: '[data-testid="published-event-page"] .tk-ep-hero',
      } as const;
      const hostedBoxes = Object.fromEntries(
        await Promise.all(
          Object.entries(hostedSelectors).map(async ([name, selector]) => {
            const node = await client.send('DOM.querySelector', {
              nodeId: root.nodeId,
              selector,
            });
            expect(node.nodeId).toBeGreaterThan(0);
            const box = await client.send('DOM.getBoxModel', { nodeId: node.nodeId });
            expect(widthOf(box.model.content)).toBeGreaterThan(name === 'main' ? 600 : 300);
            expect(heightOf(box.model.content)).toBeGreaterThan(name === 'hero' ? 40 : 20);
            return [name, box] as const;
          }),
        ),
      );
      await testInfo.attach('cdp-layout-boxes-checkout-event-page-puck', {
        body: JSON.stringify(hostedBoxes, null, 2),
        contentType: 'application/json',
      });
      await client.detach();
    }

    await page.setViewportSize(mobileViewport);
    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByTestId('published-event-page')).toContainText(event.title);
    await expect(page.getByRole('heading', { name: 'Tickets', level: 2 })).toBeVisible();
    await attachScreenshot(page, testInfo, 'checkout-event-page-puck-content-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expectPuckEditorCanvas(page, event);
    await attachScreenshot(page, testInfo, 'admin-content-event-page-puck-desktop');
    await expectNoAxeViolations(page, testInfo, undefined, [], ['landmark-unique']);

    await page.reload();
    await expectPersistedEventPageEditorRegions(page);
    await expectPuckEditorCanvas(page, event);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await attachScreenshot(page, testInfo, 'admin-content-event-page-puck-mobile');
    await expectNoAxeViolations(page, testInfo, undefined, [], ['landmark-unique']);

    await page.getByLabel('More actions').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menuitem', { name: 'Archive page' }).click();
    await expect(page.getByText('Event page archived')).toBeVisible();
    const archived = await loadEventPageContentState(event.id, page);
    expect(archived.document.status).toBe('archived');
  });

  test('captures Chromium CDP layout metrics for the admin-hosted Puck editor', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `cdp-${Date.now()}`);
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectPuckEditorCanvas(page, event);

    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      iframe: '[data-testid="editor-canvas"] iframe',
      inspector: 'aside',
    } as const;
    const boxes = Object.fromEntries(
      await Promise.all(
        Object.entries(selectors).map(async ([name, selector]) => {
          const node = await client.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector,
          });
          expect(node.nodeId).toBeGreaterThan(0);
          const box = await client.send('DOM.getBoxModel', { nodeId: node.nodeId });
          expect(widthOf(box.model.content)).toBeGreaterThan(name === 'shell' ? 900 : 40);
          expect(heightOf(box.model.content)).toBeGreaterThan(name === 'iframe' ? 300 : 20);
          return [name, box] as const;
        }),
      ),
    );
    await client.detach();

    const iframeBox = await page.locator('[data-testid="editor-canvas"] iframe').first().boundingBox();
    const heroBox = await page
      .frameLocator('[data-testid="editor-canvas"] iframe')
      .locator('.tk-ep-hero')
      .first()
      .boundingBox();
    expect(iframeBox?.width).toBeGreaterThan(300);
    expect(iframeBox?.height).toBeGreaterThan(300);
    expect(heroBox?.width).toBeGreaterThan(250);
    expect(heroBox?.height).toBeGreaterThan(40);

    await testInfo.attach('cdp-layout-boxes-event-page-puck-editor', {
      body: JSON.stringify({ boxes, iframeBox, heroBox }, null, 2),
      contentType: 'application/json',
    });
  });
});

function widthOf(quad: number[]): number {
  return Math.abs(quad[2] - quad[0]);
}

function heightOf(quad: number[]): number {
  return Math.abs(quad[5] - quad[1]);
}
