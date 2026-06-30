import { type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId, seedSmsCaptureProviderRoute } from './helpers/seed';

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
    contentJson: {
      editor?: {
        body?: string;
      };
    };
  }>;
};

type ContentRenderArtifact = {
  id: string;
  outputType: 'preview' | 'test_send' | 'send';
  artifactRef: string;
  checksum: string;
};

type ContentPreviewResponse = {
  renderArtifact: ContentRenderArtifact;
};

type ContentTestSendResponse = {
  renderArtifact: ContentRenderArtifact;
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
  return jsonResponse<SeededContentEvent>(
    await page.request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-content-sms-${suffix}`,
        title: `E2E SMS Studio ${suffix}`,
        description: 'Seeded by Playwright for persisted SMS content editor coverage.',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-11-17T23:00:00.000Z',
        endsAt: '2026-11-18T02:00:00.000Z',
        visibility: 'public',
      },
    }),
    201,
  );
}

async function loadSmsContentState(eventId: string, page: Page) {
  const documents = await jsonResponse<ContentDocumentList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents`, {
      params: {
        channel: 'sms',
        brandId: devBrandId,
        eventId,
        limit: '10',
      },
    }),
    200,
  );
  const document = documents.items.find(
    (item) => item.channel === 'sms' && item.eventId === eventId,
  );
  expect(document).toBeTruthy();
  const versions = await jsonResponse<ContentVersionList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents/${document!.id}/versions`),
    200,
  );
  return { document: document!, versions: versions.items };
}

async function expectPersistedSmsEditorRegions(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'SMS template editor' })).toBeVisible();
  await expect(page.getByLabel('SMS body')).toBeVisible();
  await expect(page.getByLabel('Test recipient')).toBeVisible();
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await expect(page.getByLabel('More actions')).toBeVisible();
}

test.describe('persisted admin SMS content editor', () => {
  test('saves, previews, publishes, test-sends, and reloads a compliant SMS template', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await seedSmsCaptureProviderRoute();

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const event = await seedContentEvent(page, suffix);
    const smsBody = `Hi {{recipient.name}}, ${event.title} is live at {{event.checkoutUrl}}.`;

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/sms`);
    await expectPersistedSmsEditorRegions(page);

    await page.getByLabel('SMS body').fill(smsBody);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByText('Preview rendered from the saved content version')).toBeVisible();
    await page.getByRole('button', { name: 'Open preview' }).click();
    await expect(page.getByTestId('preview-drawer')).toContainText(
      `Hi Ada Lovelace, ${event.title}`,
    );
    await expect(page.getByTestId('preview-drawer')).toContainText('Reply STOP to opt out');
    await expect(page.getByTestId('preview-drawer')).toContainText('Segments:');

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published v\d+/)).toBeVisible();

    await page.getByLabel('Test recipient').fill('+15550000002');
    await page.getByRole('button', { name: 'Send test' }).first().click();
    await expect(page.getByText('Captured test send to +15550000002')).toBeVisible();

    const persisted = await loadSmsContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    expect(
      persisted.versions.some(
        (version) => version.status === 'published' && version.contentJson.editor?.body === smsBody,
      ),
    ).toBe(true);
    expect(
      persisted.versions.some(
        (version) => version.status === 'draft' && version.contentJson.editor?.body === smsBody,
      ),
    ).toBe(true);

    const publishedVersionId = persisted.document.publishedVersionId!;
    const renderContext = {
      event: { title: event.title, checkoutUrl: `https://checkout.test/e/${event.id}` },
      recipient: { name: 'Ada Lovelace' },
    };
    const artifactPreview = await jsonResponse<ContentPreviewResponse>(
      await page.request.post(
        `${apiBaseUrl}/v1/content-documents/${persisted.document.id}/preview`,
        {
          data: {
            versionId: publishedVersionId,
            context: renderContext,
            optOutToken: 'Reply STOP to opt out',
          },
        },
      ),
      200,
    );
    expect(artifactPreview.renderArtifact).toMatchObject({
      outputType: 'preview',
      artifactRef: expect.stringContaining(
        `content-preview:${persisted.document.id}:${publishedVersionId}:`,
      ),
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const artifactTestSend = await jsonResponse<ContentTestSendResponse>(
      await page.request.post(
        `${apiBaseUrl}/v1/content-documents/${persisted.document.id}/test-sends`,
        {
          data: {
            versionId: publishedVersionId,
            recipient: '+15550000003',
            context: renderContext,
            optOutToken: 'Reply STOP to opt out',
          },
        },
      ),
      202,
    );
    expect(artifactTestSend.renderArtifact).toMatchObject({
      outputType: 'test_send',
      artifactRef: expect.stringMatching(/^content-test-send:cts_/),
      checksum: artifactPreview.renderArtifact.checksum,
    });

    await attachScreenshot(page, testInfo, 'admin-content-sms-persisted-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.reload();
    await expect(page.getByLabel('SMS body')).toHaveValue(smsBody);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/sms`);
    await expectPersistedSmsEditorRegions(page);
    await attachScreenshot(page, testInfo, 'admin-content-sms-persisted-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.getByLabel('More actions').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Archive template' }).click();
    await expect(page.getByText('Archived SMS template')).toBeVisible();
    const archived = await loadSmsContentState(event.id, page);
    expect(archived.document.status).toBe('archived');
  });

  test('captures Chromium CDP layout metrics for the persisted SMS editor', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `cdp-${Date.now()}`);
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/sms`);
    await expectPersistedSmsEditorRegions(page);

    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      body: 'textarea',
      recipient: 'input[type="tel"]',
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
          expect(heightOf(box.model.content)).toBeGreaterThanOrEqual(name === 'body' ? 100 : 20);
          return [name, box] as const;
        }),
      ),
    );

    await testInfo.attach('cdp-layout-boxes-sms-persisted', {
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
