import { type APIResponse, type CDPSession, type Page, type TestInfo } from '@playwright/test';
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
  const editorTools = page.getByRole('navigation', { name: 'Editor tools' });
  await expect(editorTools.getByRole('button', { name: 'Editor', exact: true })).toBeVisible();
  await expect(editorTools.getByRole('button', { name: 'Preview', exact: true })).toBeVisible();
  await expect(editorTools.getByRole('button', { name: 'Code', exact: true })).toBeVisible();
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
  await expect(frame.locator('[data-block-type="EventHeader"]').first()).toHaveAttribute(
    'data-block-id',
    new RegExp(`^event-header-${event.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
  );
  await expect(frame.getByRole('heading', { name: event.title, level: 1 })).toBeVisible();
  await expect(
    frame.getByRole('heading', { name: 'Tickets', level: 2, exact: true }),
  ).toBeVisible();
  await expect(frame.locator('[data-block-type="Tickets"]')).toHaveCount(1);
  await expect(frame.locator('[data-block-type="CheckoutCta"]')).toHaveCount(1);
  await expect(frame.locator('[data-block-type="BrandFooter"]')).toHaveCount(1);
  // Default template is full chrome, not a locked shell + middle Hero slot.
  await expect(frame.locator('.tk-ep-hero')).toHaveCount(0);
}

function expectFullPagePuckData(data: PuckData | null | undefined): asserts data is PuckData {
  expect(data).toBeTruthy();
  expect(data?.root).toHaveProperty('props');
  expect(Array.isArray(data?.content)).toBe(true);
  const componentTypes = data!.content.map((block) => block.type);
  expect(componentTypes).toEqual(
    expect.arrayContaining([
      'EventHeader',
      'Tickets',
      'ResaleTickets',
      'CheckoutCta',
      'BrandFooter',
    ]),
  );
  expect(componentTypes).not.toEqual(
    expect.arrayContaining(['tickets', 'resale_tickets', 'event_header', 'brand_footer', 'Footer']),
  );
  expect(componentTypes[0]).toBe('EventHeader');
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

type CdpPoint = {
  x: number;
  y: number;
};

async function puckContentCountViaCdp(client: CDPSession): Promise<number> {
  const result = await client.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const store = window.__PUCK_INTERNAL_DO_NOT_USE?.appStore;
      const content = store?.getState?.()?.state?.data?.content;
      return Array.isArray(content) ? content.length : -1;
    })()`,
  });
  return Number(result.result.value);
}

async function puckIsDraggingViaCdp(client: CDPSession): Promise<boolean> {
  const result = await client.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const store = window.__PUCK_INTERNAL_DO_NOT_USE?.appStore;
      return Boolean(store?.getState?.()?.state?.ui?.isDragging);
    })()`,
  });
  return Boolean(result.result.value);
}

async function eventPageSelectionStateViaCdp(client: CDPSession) {
  const result = await client.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const store = window.__PUCK_INTERNAL_DO_NOT_USE?.appStore;
      const state = store?.getState?.()?.state;
      const selector = state?.ui?.itemSelector;
      const selectedBlock =
        typeof selector?.index === 'number' ? state?.data?.content?.[selector.index] : undefined;
      const selectedOutline = document.querySelector(
        '[data-testid="event-page-document-outline-tree"] [aria-current="true"]',
      );
      const ancestorOutline = document.querySelector(
        '[data-testid="event-page-document-outline-tree"] [data-outline-role="ancestor"]',
      );
      const inspectorText =
        document.querySelector('[data-testid="event-page-inspector"]')?.textContent || '';
      const frame = document.querySelector('[data-testid="editor-canvas"] iframe');
      const frameDocument = frame?.contentDocument;
      const exactFrameLabels = frameDocument
        ? [...frameDocument.body.querySelectorAll('*')]
            .map((node) => node.textContent?.replace(/\\s+/g, ' ').trim())
            .filter((text) => text === 'Description')
        : [];

      return {
        selectedType: selectedBlock?.type || null,
        selectedId: selectedBlock?.props?.id || null,
        selectedOutlineText: selectedOutline?.textContent?.replace(/\\s+/g, ' ').trim() || null,
        ancestorOutlineText: ancestorOutline?.textContent?.replace(/\\s+/g, ' ').trim() || null,
        descriptionToolbarLabelVisible: exactFrameLabels.length > 0,
        inspectorHasDescriptionFields: inspectorText.includes(
          'Inline or background image for the event description',
        ),
        inspectorHasHeaderFields: inspectorText.includes(
          'Image, overlay, and focus controls for the event header',
        ),
      };
    })()`,
  });
  return result.result.value as {
    selectedType: string | null;
    selectedId: string | null;
    selectedOutlineText: string | null;
    ancestorOutlineText: string | null;
    descriptionToolbarLabelVisible: boolean;
    inspectorHasDescriptionFields: boolean;
    inspectorHasHeaderFields: boolean;
  };
}

async function seedDescriptionBackgroundImageViaCdp(client: CDPSession): Promise<string> {
  const result = await client.send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => {
      const store = window.__PUCK_INTERNAL_DO_NOT_USE?.appStore;
      const current = store?.getState?.();
      const dispatch = current?.dispatch;
      const content = current?.state?.data?.content;
      if (!store || typeof dispatch !== 'function' || !Array.isArray(content)) {
        return { ok: false, error: 'Puck app store is unavailable.' };
      }

      const existing = content.find((block) => block?.type === 'EventDescription');
      const descriptionId = existing?.props?.id || 'cdp-description-background';
      const descriptionBlock = {
        type: 'EventDescription',
        props: {
          ...(existing?.props || {}),
          id: descriptionId,
          title: 'CDP editable description',
          body: 'Overlay content should stay selectable until image editing is opened.',
          imageUrl:
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 680"%3E%3Cdefs%3E%3ClinearGradient id="g" x1="0" y1="0" x2="1" y2="1"%3E%3Cstop stop-color="%230f172a"/%3E%3Cstop offset=".55" stop-color="%23f59e0b"/%3E%3Cstop offset="1" stop-color="%23111827"/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width="1200" height="680" fill="url(%23g)"/%3E%3C/svg%3E',
          imageAlt: 'Gradient venue image',
          imageLayout: 'background',
          imageFit: 'cover',
          imagePlacement: { x: '50%', y: '50%', scale: '1' },
          imagePositionX: '50%',
          imagePositionY: '50%',
          overlayContentPosition: 'bottom',
          overlayContentHorizontalPosition: 'left',
          overlayMinHeight: '360px',
          overlayPadding: '28px',
          backgroundOverlayColor: '#111827',
          backgroundOverlayOpacity: '0.42',
          titleColor: '#ffffff',
          bodyColor: '#f8fafc',
          contentBackgroundColor: 'rgba(15, 23, 42, 0.68)',
          contentPadding: '18px',
          contentRadius: '14px',
          imageOverlay: [
            {
              type: 'Button',
              props: {
                id: 'cdp-overlay-button',
                label: 'Style overlay button',
                url: '#style-overlay',
                style: 'secondary',
                alignment: 'left',
              },
            },
          ],
        },
      };
      const nextContent = existing
        ? content.map((block) => (block === existing ? descriptionBlock : block))
        : [...content, descriptionBlock];

      dispatch({
        type: 'set',
        state: (state) => ({
          ...state,
          data: { ...state.data, content: nextContent },
          ui: { ...state.ui, itemSelector: null },
        }),
      });
      return { ok: true, descriptionId };
    })()`,
  });
  const value = result.result.value as { ok?: boolean; descriptionId?: string; error?: string };
  expect(value?.ok, value?.error ?? 'Unable to seed description background image').toBe(true);
  expect(value.descriptionId).toBeTruthy();
  return value.descriptionId!;
}

async function descriptionImageEditorStateViaCdp(client: CDPSession) {
  const result = await client.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const frame = document.querySelector('[data-testid="editor-canvas"] iframe');
      const doc = frame?.contentDocument;
      if (!doc) return { ok: false, error: 'Canvas iframe document unavailable.' };
      const section = doc.querySelector('[data-block-type="EventDescription"]');
      const overlayLink = doc.querySelector('[data-block-id="cdp-overlay-button"] a');
      const editor = doc.querySelector('[data-testid="hero-image-canvas-editor"]');
      const imageOpen = doc.querySelector('[aria-label="Edit image placement"]');
      const activeLayer = doc.querySelector('.tk-ep-image-editor__active-layer');
      const zoom = doc.querySelector('[aria-label="Image zoom"]');
      const hit = doc.querySelector('.tk-ep-image-editor__hit');
      const linkRect = overlayLink?.getBoundingClientRect();
      const hitTarget =
        linkRect && doc.elementFromPoint(linkRect.left + linkRect.width / 2, linkRect.top + linkRect.height / 2);
      return {
        ok: true,
        sectionClassName: section?.className || '',
        rootPortal: editor?.hasAttribute('data-puck-overlay-portal') || false,
        overlayLinkText: overlayLink?.textContent?.trim() || '',
        imageOpenPressed: imageOpen?.getAttribute('aria-pressed') || null,
        imageOpenPortal: imageOpen?.getAttribute('data-puck-overlay-portal') || null,
        activeLayerPortal: activeLayer?.getAttribute('data-puck-overlay-portal') || null,
        zoomVisible: Boolean(zoom),
        hitVisible: Boolean(hit),
        pointTargetClassName: hitTarget?.className || '',
        pointTargetText: hitTarget?.textContent?.trim() || '',
        placement: window.__PUCK_INTERNAL_DO_NOT_USE?.appStore
          ?.getState?.()
          ?.state?.data?.content?.find?.((block) => block?.type === 'EventDescription')?.props
          ?.imagePlacement,
      };
    })()`,
  });
  const value = result.result.value as Record<string, unknown>;
  expect(value?.ok, String(value?.error ?? 'Unable to inspect description image editor')).toBe(
    true,
  );
  return value;
}

async function dispatchCdpMouseDown(client: CDPSession, point: CdpPoint): Promise<void> {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    buttons: 1,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
}

async function dispatchCdpMouseMoves(client: CDPSession, points: CdpPoint[]): Promise<void> {
  for (const point of points) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: 'left',
      buttons: 1,
      x: point.x,
      y: point.y,
    });
  }
}

async function dispatchCdpMouseUp(client: CDPSession, point: CdpPoint): Promise<void> {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    buttons: 0,
    clickCount: 1,
    x: point.x,
    y: point.y,
  });
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
    const eventSummary =
      event.description ?? 'Seeded by Playwright for Puck event-page editor coverage.';

    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectPuckEditorCanvas(page, event);

    await saveDraftFromHeader(page);

    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('Preview opened from the saved Puck document')).toBeVisible();
    const canvasPreview = page.locator('[data-testid="editor-canvas"]');
    await expect(
      canvasPreview.locator('[data-testid="preview-surface"].tixkit-event-page-puck-scope'),
    ).toBeVisible();
    await expect(canvasPreview.locator('.tixkit-event-page')).toHaveAttribute(
      'data-schema-provider',
      puckProvider,
    );
    await expect(canvasPreview.getByRole('heading', { name: event.title, level: 1 })).toBeVisible();
    await expect(
      canvasPreview.getByRole('heading', { name: 'Tickets', level: 2, exact: true }),
    ).toBeVisible();
    await expect(canvasPreview.locator('.tk-ep-hero')).toHaveCount(0);
    await page.getByTestId('preview-drawer').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('preview-drawer')).toBeHidden();
    await page.getByRole('button', { name: 'Editor' }).click();
    await expectPuckEditorCanvas(page, event);

    // Outline + heading audit should surface the default chrome hierarchy.
    await page.getByRole('tab', { name: /Outline/i }).click();
    const outline = page.getByTestId('event-page-outline');
    await expect(outline).toBeVisible();
    await expect(outline.getByText('Event header')).toBeVisible();
    await expect(outline.getByText('Tickets', { exact: true })).toBeVisible();
    await expect(outline.getByText('Resale tickets')).toBeVisible();
    await expect(outline.getByText('Get tickets CTA')).toBeVisible();
    await expect(outline.getByText('Brand footer')).toBeVisible();
    await page.getByRole('tab', { name: /Audit/i }).click();
    await expect(page.getByTestId('event-page-heading-audit')).toBeVisible();

    await publishFromHeader(page);

    const persisted = await loadEventPageContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    const publishedVersion = persisted.versions.find((version) => version.status === 'published');
    expect(publishedVersion).toBeTruthy();
    expect(publishedVersion?.contentJson.schemaVersion).toBe(2);
    expect(publishedVersion?.contentJson.editor.provider).toBe(puckProvider);
    expect(publishedVersion?.contentJson.settings.discovery.summary).toBe(eventSummary);
    expectFullPagePuckData(publishedVersion?.contentJson.editor.data);

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
    expectFullPagePuckData(publicPage.page.puckData);

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
    await expect(
      page.locator('[data-testid="published-event-page"] [data-block-type="EventHeader"]'),
    ).toHaveAttribute(
      'data-block-id',
      new RegExp(`^event-header-${event.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    );
    await expect(page.getByRole('heading', { name: event.title, level: 1 })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Tickets', level: 2, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(event.ticketType.name, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Get tickets' })).toBeVisible();
    await expect(page.locator('[data-testid="published-event-page"] .tk-ep-hero')).toHaveCount(0);
    await attachScreenshot(page, testInfo, 'checkout-event-page-puck-content-desktop');
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const hostedSelectors = {
        main: 'main',
        puckScope: '[data-testid="published-event-page"] .tixkit-event-page-puck-scope',
        eventHeader: '[data-testid="published-event-page"] [data-block-type="EventHeader"]',
        tickets: '[data-testid="published-event-page"] [data-block-type="Tickets"]',
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
            expect(heightOf(box.model.content)).toBeGreaterThan(name === 'eventHeader' ? 40 : 20);
            return [name, box] as const;
          }),
        ),
      );
      const headingTree = await client.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          return Array.from(document.querySelectorAll('h1, h2')).map((node) => ({
            level: node.tagName.toLowerCase(),
            text: (node.textContent || '').trim(),
          }));
        })()`,
      });
      expect(headingTree.result.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: 'h1', text: event.title }),
          expect.objectContaining({ level: 'h2', text: 'Tickets' }),
        ]),
      );
      await testInfo.attach('cdp-layout-boxes-checkout-event-page-puck', {
        body: JSON.stringify({ hostedBoxes, headings: headingTree.result.value }, null, 2),
        contentType: 'application/json',
      });
      await client.detach();
    }

    await page.setViewportSize(mobileViewport);
    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByTestId('published-event-page')).toContainText(event.title);
    await expect(
      page.getByRole('heading', { name: 'Tickets', level: 2, exact: true }),
    ).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Page settings' })).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'Page settings' })).toBeHidden();

    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      iframe: '[data-testid="editor-canvas"] iframe',
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

    const iframeBox = await page
      .locator('[data-testid="editor-canvas"] iframe')
      .first()
      .boundingBox();
    const headerBox = await page
      .frameLocator('[data-testid="editor-canvas"] iframe')
      .locator('[data-block-type="EventHeader"]')
      .first()
      .boundingBox();
    const ticketsBox = await page
      .frameLocator('[data-testid="editor-canvas"] iframe')
      .locator('[data-block-type="Tickets"]')
      .first()
      .boundingBox();
    expect(iframeBox?.width).toBeGreaterThan(300);
    expect(iframeBox?.height).toBeGreaterThan(300);
    expect(headerBox?.width).toBeGreaterThan(250);
    expect(headerBox?.height).toBeGreaterThan(40);
    expect(ticketsBox?.width).toBeGreaterThan(250);
    expect(ticketsBox?.height).toBeGreaterThan(40);

    await testInfo.attach('cdp-layout-boxes-event-page-puck-editor', {
      body: JSON.stringify({ boxes, iframeBox, headerBox, ticketsBox }, null, 2),
      contentType: 'application/json',
    });
  });

  test('selects the description block from its H2 outline row via CDP', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP selection inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `outline-selection-cdp-${Date.now()}`);
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expectPuckEditorCanvas(page, event);

    const client = await page.context().newCDPSession(page);
    const beforeClick = await eventPageSelectionStateViaCdp(client);
    expect(beforeClick.selectedType).toBe('EventHeader');
    expect(beforeClick.inspectorHasHeaderFields).toBe(true);

    await page
      .getByTestId('event-page-outline')
      .getByRole('button', { name: /H2 title About this event/i })
      .click();

    await expect
      .poll(async () => eventPageSelectionStateViaCdp(client), {
        message: 'Description H2 outline row should select the owning canvas section.',
      })
      .toMatchObject({
        selectedType: 'EventDescription',
        selectedOutlineText: 'H2 titleAbout this event',
        ancestorOutlineText: 'Description',
        descriptionToolbarLabelVisible: true,
        inspectorHasDescriptionFields: true,
        inspectorHasHeaderFields: false,
      });
    await expect(page.getByTestId('event-page-inspector')).toContainText(
      'Inline or background image for the event description',
    );
    await expect(
      page
        .frameLocator('[data-testid="editor-canvas"] iframe')
        .getByText('Description', { exact: true }),
    ).toBeVisible();

    const afterClick = await eventPageSelectionStateViaCdp(client);
    await testInfo.attach('cdp-description-outline-selection', {
      body: JSON.stringify({ beforeClick, afterClick }, null, 2),
      contentType: 'application/json',
    });
    await client.detach();
  });

  test('keeps background description overlay controls editable outside explicit image mode via CDP', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP canvas inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `description-image-cdp-${Date.now()}`);
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expectPuckEditorCanvas(page, event);

    const client = await page.context().newCDPSession(page);
    const descriptionId = await seedDescriptionBackgroundImageViaCdp(client);
    const frame = page.frameLocator('[data-testid="editor-canvas"] iframe');
    await expect(
      frame.locator(`[data-block-id="${descriptionId}"].tk-ep-event-description--background`),
    ).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Style overlay button' })).toBeVisible();

    const beforeOpen = await descriptionImageEditorStateViaCdp(client);
    expect(beforeOpen).toEqual(
      expect.objectContaining({
        rootPortal: false,
        overlayLinkText: 'Style overlay button',
        imageOpenPressed: 'false',
        imageOpenPortal: 'true',
        activeLayerPortal: null,
        zoomVisible: false,
        hitVisible: false,
      }),
    );
    expect(String(beforeOpen.pointTargetText)).toContain('Style overlay button');

    await frame.getByRole('link', { name: 'Style overlay button' }).click();
    await expect
      .poll(
        async () =>
          page
            .locator('[data-testid="editor-canvas"] iframe')
            .evaluate((iframe) => (iframe as HTMLIFrameElement).contentWindow?.location.hash),
        { message: 'Overlay link should receive the click while image mode is closed.' },
      )
      .toBe('#style-overlay');

    await frame.getByRole('button', { name: 'Edit image placement' }).click();
    await expect(frame.getByRole('slider', { name: 'Image zoom' })).toBeVisible();
    const opened = await descriptionImageEditorStateViaCdp(client);
    expect(opened).toEqual(
      expect.objectContaining({
        rootPortal: false,
        imageOpenPressed: 'true',
        imageOpenPortal: 'true',
        activeLayerPortal: 'true',
        zoomVisible: true,
        hitVisible: true,
      }),
    );

    await frame.getByRole('button', { name: 'Top right' }).click();
    await frame.getByRole('slider', { name: 'Image zoom' }).fill('1.5');
    await expect
      .poll(async () => descriptionImageEditorStateViaCdp(client), {
        message: 'Canvas image controls should update the hidden Puck image placement fields.',
      })
      .toEqual(
        expect.objectContaining({
          placement: { x: '100%', y: '0%', scale: '1.5' },
        }),
      );

    await frame.getByRole('button', { name: 'Done' }).click();
    const closed = await descriptionImageEditorStateViaCdp(client);
    expect(closed).toEqual(
      expect.objectContaining({
        rootPortal: false,
        imageOpenPressed: 'false',
        imageOpenPortal: 'true',
        activeLayerPortal: null,
        zoomVisible: false,
        hitVisible: false,
      }),
    );
    expect(String(closed.pointTargetText)).toContain('Style overlay button');

    await testInfo.attach('cdp-description-background-image-editor-state', {
      body: JSON.stringify({ beforeOpen, opened, closed }, null, 2),
      contentType: 'application/json',
    });
    await client.detach();
  });

  test('cancels add-section drag when released outside the canvas via CDP', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP drag inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `drag-cancel-${Date.now()}`);
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expectPuckEditorCanvas(page, event);

    const client = await page.context().newCDPSession(page);
    const initialCount = await puckContentCountViaCdp(client);
    expect(initialCount).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Add page section' }).click();
    await expect(page.getByTestId('event-page-puck-components')).toBeVisible();
    const sourceBox = await page.getByTestId('drawer-item:RichText').boundingBox();
    const iframeBox = await page.locator('[data-testid="editor-canvas"] iframe').boundingBox();
    expect(sourceBox).toBeTruthy();
    expect(iframeBox).toBeTruthy();

    const sourcePoint = {
      x: sourceBox!.x + sourceBox!.width / 2,
      y: sourceBox!.y + sourceBox!.height / 2,
    };
    const canvasPoint = {
      x: iframeBox!.x + iframeBox!.width / 2,
      y: iframeBox!.y + Math.min(iframeBox!.height - 20, 180),
    };

    await dispatchCdpMouseDown(client, sourcePoint);
    await dispatchCdpMouseMoves(client, [canvasPoint]);
    await expect
      .poll(async () => puckIsDraggingViaCdp(client), {
        message: 'Puck should enter dragging state before the cancel release',
      })
      .toBe(true);
    await expect(page.getByTestId('event-page-drag-cancel-zone')).toBeVisible();

    const cancelBox = await page.getByTestId('event-page-drag-cancel-zone').boundingBox();
    expect(cancelBox).toBeTruthy();
    await dispatchCdpMouseMoves(client, [
      {
        x: cancelBox!.x + cancelBox!.width / 2,
        y: cancelBox!.y + cancelBox!.height / 2,
      },
    ]);
    await expect(page.getByTestId('event-page-drag-cancel-zone')).toHaveAttribute(
      'data-state',
      'active',
    );
    await expect(page.getByTestId('event-page-drag-cancel-zone')).toContainText(
      'Release to cancel',
    );
    await expect(page.getByTestId('event-page-canvas-cancel-shield')).toHaveCount(0);
    await expect(
      page.frameLocator('[data-testid="editor-canvas"] iframe').getByText('Add event story'),
    ).toHaveCount(0);

    await dispatchCdpMouseUp(client, {
      x: cancelBox!.x + cancelBox!.width / 2,
      y: cancelBox!.y + cancelBox!.height / 2,
    });

    await expect(page.getByTestId('event-page-puck-components')).toBeHidden();
    await expect
      .poll(async () => puckContentCountViaCdp(client), {
        message: 'Puck content count should not change after canceling add-section drag',
      })
      .toBe(initialCount);
    await expect(
      page.frameLocator('[data-testid="editor-canvas"] iframe').getByText('Add event story'),
    ).toHaveCount(0);

    await testInfo.attach('cdp-add-section-drag-cancel', {
      body: JSON.stringify({ initialCount, finalCount: await puckContentCountViaCdp(client) }),
      contentType: 'application/json',
    });
    await client.detach();
  });
});

function widthOf(quad: number[]): number {
  return Math.abs(quad[2] - quad[0]);
}

function heightOf(quad: number[]): number {
  return Math.abs(quad[5] - quad[1]);
}
