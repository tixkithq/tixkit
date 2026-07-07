import { type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId } from './helpers/seed';

const desktopViewport = { width: 1440, height: 1000 } as const;
const mobileViewport = { width: 390, height: 844 } as const;

type SeededContentEvent = {
  id: string;
  title: string;
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
    contentJson: {
      schemaVersion?: number;
      editor?: {
        provider?: string;
      };
      settings?: {
        ticketCtaLabel?: string;
        discovery?: {
          summary?: string;
        };
      };
      blocks?: Array<{
        type?: string;
        headline?: string;
        body?: string;
        ctaLabel?: string;
      }>;
    };
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
    renderedHtml: string;
    renderedText: string;
  };
  page: {
    html: string;
    text: string;
    headless: Array<{
      type: string;
      title?: string;
      body?: string;
      label?: string;
    }>;
    renderModel: {
      schemaVersion: number;
      blocks: Array<{
        type: string;
        id: string;
        headline?: string;
        body?: string;
        ctaLabel?: string;
        html?: string;
        text?: string;
      }>;
      validation: { valid: boolean; issues: Array<{ severity: string; message: string }> };
    };
    discovery: {
      title: string;
      summary: string;
    };
  };
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
  const event = await jsonResponse<SeededContentEvent>(
    await page.request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-content-event-page-${suffix}`,
        title: `E2E Event Page Studio ${suffix}`,
        description: 'Seeded by Playwright for persisted event-page content editor coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-11-17T23:00:00.000Z',
        endsAt: '2026-11-18T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  );
  await jsonResponse<SeededContentEvent>(
    await page.request.post(`${apiBaseUrl}/v1/events/${event.id}/publish`, { data: {} }),
    200,
  );
  return event;
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
  const editorFrame = page.frameLocator('[data-testid="editor-iframe"]');
  await expect(page.getByRole('heading', { name: 'Event-page editor' })).toBeVisible();
  await expect(editorFrame.getByLabel('Page headline')).toBeVisible();
  await expect(editorFrame.getByLabel('Page summary')).toBeVisible();
  await expect(editorFrame.getByLabel('Ticket CTA label')).toBeVisible();
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test send unavailable' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await expect(page.getByLabel('More actions')).toBeVisible();
}

async function expectEventPageDocumentCanvasPresentation(page: Page): Promise<void> {
  const canvas = page.locator('[data-testid="editor-canvas"]').first();
  const editorFrame = page.frameLocator('[data-testid="editor-iframe"]');
  await expect(canvas).toHaveAttribute('aria-label', /event page editable document$/);
  await expect(canvas.getByRole('button', { name: /Select content region|Selected/i })).toHaveCount(
    0,
  );
  const snapshot = await canvas.evaluate((node) => {
    const legacyCard = [...node.querySelectorAll<HTMLElement>('*')].find((element) => {
      const className = element.getAttribute('class') ?? '';
      return (
        className.includes('group') &&
        className.includes('rounded-md') &&
        className.includes('border') &&
        className.includes('p-4')
      );
    });
    return {
      legacyCardClass: legacyCard?.getAttribute('class') ?? null,
      background: window.getComputedStyle(node).backgroundColor,
    };
  });
  expect(snapshot.legacyCardClass).toBeNull();
  expect(snapshot.background).not.toBe('rgb(9, 9, 11)');
  // The admin canvas renders through the shared .tk-ep-* class contract (inside the edit iframe).
  await expect(editorFrame.locator('.tixkit-event-page').first()).toBeVisible();
  await expect(editorFrame.locator('.tk-ep-hero').first()).toHaveAttribute('data-block-id', 'hero');
  await expect(editorFrame.locator('body')).toContainText('Tickets');
}

/**
 * Fill a contenteditable editable field inside the editor iframe.
 * SurfaceText commits on input, so set textContent and dispatch a native input event.
 */
async function fillEditableText(page: Page, label: string, text: string): Promise<void> {
  const editorFrame = page.frameLocator('[data-testid="editor-iframe"]');
  const el = editorFrame.getByLabel(label);
  await el.click();
  await el.evaluate((node, value) => {
    node.textContent = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}

test.describe('persisted admin event-page content editor', () => {
  test('saves, previews, publishes, renders publicly, and reloads a canonical event page', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const event = await seedContentEvent(page, suffix);
    const headline = `Updated hosted page ${suffix}`;
    const summary = `Updated public page copy for ${event.title}.`;
    const ctaLabel = 'Reserve tickets';

    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectEventPageDocumentCanvasPresentation(page);

    await fillEditableText(page, 'Page headline', headline);
    await fillEditableText(page, 'Page summary', summary);
    await fillEditableText(page, 'Ticket CTA label', ctaLabel);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByText('Preview rendered from the saved content version')).toBeVisible();
    await page.getByRole('button', { name: 'Open preview' }).click();
    await expect(page.getByTestId('preview-drawer')).toContainText(headline);
    await expect(page.getByTestId('preview-drawer')).toContainText(summary);
    // The admin preview renders the shared event-page surface (parity with checkout).
    await expect(page.getByTestId('preview-surface').locator('.tixkit-event-page')).toBeVisible();
    await expect(
      page.getByTestId('preview-surface').locator('.tk-ep-hero'),
    ).toHaveAttribute('data-block-id', 'hero');

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published v\d+/)).toBeVisible();

    const persisted = await loadEventPageContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    expect(
      persisted.versions.some(
        (version) =>
          version.status === 'published' &&
          version.contentJson.schemaVersion === 1 &&
          version.contentJson.editor?.provider === '@tiptap/core' &&
          version.contentJson.blocks?.some(
            (block) =>
              block.type === 'hero' && block.headline === headline && block.body === summary,
          ) &&
          version.contentJson.blocks?.some(
            (block) => block.type === 'tickets' && block.ctaLabel === ctaLabel,
          ),
      ),
    ).toBe(true);
    expect(
      persisted.versions.some(
        (version) =>
          version.status === 'draft' &&
          version.contentJson.blocks?.some(
            (block) => block.type === 'hero' && block.headline === headline,
          ),
      ),
    ).toBe(true);

    const publicPage = await jsonResponse<PublicContentPage>(
      await page.request.get(`${apiBaseUrl}/v1/public/events/${event.id}/page`),
      200,
    );
    expect(publicPage.document.eventId).toBe(event.id);
    expect(publicPage.document.channel).toBe('event_page');
    expect(publicPage.version.subject).toBe(headline);
    expect(publicPage.page.html).toContain(headline);
    expect(publicPage.page.text).toContain(summary);
    expect(publicPage.page.text).toContain(ctaLabel);
    expect(publicPage.page.discovery.summary).toBe(summary);
    expect(
      publicPage.page.headless.some((block) => block.type === 'hero' && block.title === headline),
    ).toBe(true);
    // The public API returns the canonical render model shared by every surface.
    expect(publicPage.page.renderModel.schemaVersion).toBe(1);
    expect(publicPage.page.renderModel.validation.valid).toBe(true);
    expect(
      publicPage.page.renderModel.blocks.some(
        (block) => block.type === 'hero' && block.id === 'hero',
      ),
    ).toBe(true);
    expect(
      publicPage.page.renderModel.blocks.some((block) => block.type === 'tickets'),
    ).toBe(true);

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByText(event.title, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: headline, level: 1 })).toBeVisible();
    await expect(page.getByTestId('published-event-page')).toContainText(headline);
    await expect(page.getByTestId('published-event-page')).toContainText(summary);
    await expect(page.getByTestId('published-event-page')).toContainText(ctaLabel);
    // The checkout public page renders the shared event-page surface from renderModel.
    await expect(page.locator('[data-testid="published-event-page"] .tixkit-event-page')).toBeVisible();
    await expect(
      page.locator('[data-testid="published-event-page"] .tk-ep-hero'),
    ).toHaveAttribute('data-block-id', 'hero');
    await expect(
      page.locator('[data-testid="published-event-page"] .tk-ep-tickets'),
    ).toHaveAttribute('data-block-id', 'tickets');
    await attachScreenshot(page, testInfo, 'checkout-event-page-published-content-desktop');
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const hostedSelectors = {
        main: 'main',
        publishedArticle: '[data-testid="published-event-page"]',
        contentCta: '[data-testid="published-event-page"] .tk-ep-button',
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
            expect(widthOf(box.model.content)).toBeGreaterThan(name === 'contentCta' ? 60 : 300);
            expect(heightOf(box.model.content)).toBeGreaterThan(name === 'contentCta' ? 12 : 40);
            return [name, box] as const;
          }),
        ),
      );
      await testInfo.attach('cdp-layout-boxes-checkout-event-page-published', {
        body: JSON.stringify(hostedBoxes, null, 2),
        contentType: 'application/json',
      });
      await client.detach();
    }

    await page.setViewportSize(mobileViewport);
    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByTestId('published-event-page')).toContainText(headline);
    await attachScreenshot(page, testInfo, 'checkout-event-page-published-content-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await attachScreenshot(page, testInfo, 'admin-content-event-page-persisted-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.reload();
    const editorFrame = page.frameLocator('[data-testid="editor-iframe"]');
    await expect(editorFrame.getByLabel('Page headline')).toHaveText(headline);
    await expect(editorFrame.getByLabel('Page summary')).toHaveText(summary);
    await expect(editorFrame.getByLabel('Ticket CTA label')).toHaveText(ctaLabel);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/event-page`);
    await expectPersistedEventPageEditorRegions(page);
    await attachScreenshot(page, testInfo, 'admin-content-event-page-persisted-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.getByLabel('More actions').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Archive page' }).click();
    await expect(page.getByText('Archived event page')).toBeVisible();
    const archived = await loadEventPageContentState(event.id, page);
    expect(archived.document.status).toBe('archived');
  });

  test('captures Chromium CDP layout metrics for the persisted event-page editor', async ({
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
    await expectEventPageDocumentCanvasPresentation(page);

    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      headline: '[aria-label="Page headline"]',
      summary: '[aria-label="Page summary"]',
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
          expect(widthOf(box.model.content)).toBeGreaterThan(name === 'shell' ? 900 : 250);
          expect(heightOf(box.model.content)).toBeGreaterThanOrEqual(name === 'summary' ? 80 : 20);
          return [name, box] as const;
        }),
      ),
    );

    await testInfo.attach('cdp-layout-boxes-event-page-persisted', {
      body: JSON.stringify(boxes, null, 2),
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
