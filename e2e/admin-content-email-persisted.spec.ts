import { type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '../packages/db/src/client';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl } from './helpers/env';
import { devBrandId, devOrganizationId } from './helpers/seed';

const devTenantId = 'tnt_dev_local';
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
    contentJson: {
      schemaVersion?: number;
      editor?: {
        provider?: string;
        contentHtml?: string;
      };
      settings?: {
        subject?: string;
        previewText?: string;
        sender?: {
          fromEmail?: string;
          replyToEmail?: string;
        };
      };
      blocks?: Array<{
        type?: string;
        body?: string;
      }>;
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

async function seedEmailCaptureProviderRoute(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://tixkit:tixkit@localhost:5432/tixkit');
  const providerRouteId = 'epr_content_email_e2e';
  const now = new Date();

  try {
    const existingRoute = await db
      .selectFrom('email_provider_routes')
      .select('id')
      .where('id', '=', providerRouteId)
      .executeTakeFirst();

    if (existingRoute) {
      await db
        .updateTable('email_provider_routes')
        .set({
          allowed_categories: JSON.stringify(['transactional']),
          status: 'active',
          smoke_send_verified: true,
          updated_at: now,
        })
        .where('id', '=', providerRouteId)
        .execute();
      return;
    }

    await db
      .insertInto('email_provider_routes')
      .values({
        id: providerRouteId,
        tenant_id: devTenantId,
        brand_id: devBrandId,
        provider_type: 'capture',
        credentials_ref: 'capture',
        sender_domain: 'example.test',
        priority: 0,
        is_fallback: false,
        rate_limit_per_hour: null,
        allowed_categories: JSON.stringify(['transactional']),
        status: 'active',
        smoke_send_verified: true,
        created_at: now,
        updated_at: now,
      })
      .execute();
  } finally {
    await db.destroy();
  }
}

async function seedContentEvent(page: Page, suffix: string): Promise<SeededContentEvent> {
  return jsonResponse<SeededContentEvent>(
    await page.request.post(`${apiBaseUrl}/v1/events`, {
      data: {
        organizationId: devOrganizationId,
        brandId: devBrandId,
        slug: `e2e-content-email-${suffix}`,
        title: `E2E Email Studio ${suffix}`,
        description: 'Seeded by Playwright for persisted email content editor coverage.',
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

async function loadEmailContentState(eventId: string, page: Page) {
  const documents = await jsonResponse<ContentDocumentList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents`, {
      params: {
        channel: 'email',
        brandId: devBrandId,
        eventId,
        limit: '10',
      },
    }),
    200,
  );
  const document = documents.items.find(
    (item) => item.channel === 'email' && item.eventId === eventId,
  );
  expect(document).toBeTruthy();
  const versions = await jsonResponse<ContentVersionList>(
    await page.request.get(`${apiBaseUrl}/v1/content-documents/${document!.id}/versions`),
    200,
  );
  return { document: document!, versions: versions.items };
}

async function expectPersistedEmailEditorRegions(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Email template editor' })).toBeVisible();
  await expect(page.getByLabel('Subject')).toBeVisible();
  await expect(page.getByLabel('Preview text')).toBeVisible();
  await expect(page.getByLabel('Email body')).toBeVisible();
  await expect(page.getByLabel('From', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Reply-To')).toBeVisible();
  await expect(page.getByLabel('Test recipient')).toBeVisible();
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await expect(page.getByLabel('More actions')).toBeVisible();
}

test.describe('persisted admin email content editor', () => {
  test('saves, previews, publishes, test-sends, and reloads a canonical email template', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await seedEmailCaptureProviderRoute();

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const event = await seedContentEvent(page, suffix);
    const subject = `Tickets for ${event.title}`;
    const body = `Hi {{recipient.name}}, ${event.title} tickets are ready.`;

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);

    await page.getByLabel('Subject').fill(subject);
    await page.getByLabel('Preview text').fill('Everything you need before arrival.');
    await page.getByLabel('Email body').fill(body);
    await page.getByLabel('From', { exact: true }).fill('tickets@example.test');
    await page.getByLabel('Reply-To').fill('support@example.test');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.getByText('Preview rendered from the saved content version')).toBeVisible();
    await page.getByRole('button', { name: 'Open preview' }).click();
    await expect(page.getByTestId('preview-drawer')).toContainText(`Subject: ${subject}`);
    await expect(page.getByTestId('preview-drawer')).toContainText(
      `Hi Ada Lovelace, ${event.title}`,
    );
    await expect(page.getByTestId('preview-drawer')).toContainText(/ticket summary/i);

    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published v\d+/)).toBeVisible();

    await page.getByLabel('Test recipient').fill('ada+email-e2e@example.test');
    await page.getByRole('button', { name: 'Send test' }).first().click();
    await expect(page.getByText('Captured test send to ada+email-e2e@example.test')).toBeVisible();

    const persisted = await loadEmailContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    expect(
      persisted.versions.some(
        (version) =>
          version.status === 'published' &&
          version.contentJson.schemaVersion === 1 &&
          version.contentJson.editor?.provider === '@react-email/editor' &&
          version.contentJson.settings?.subject === subject &&
          version.contentJson.blocks?.some(
            (block) => block.type === 'event_hero' && block.body === body,
          ),
      ),
    ).toBe(true);
    expect(
      persisted.versions.some(
        (version) =>
          version.status === 'draft' && version.contentJson.settings?.subject === subject,
      ),
    ).toBe(true);

    const publishedVersionId = persisted.document.publishedVersionId!;
    const renderContext = {
      event: { title: event.title },
      recipient: { name: 'Ada Lovelace' },
    };
    const artifactPreview = await jsonResponse<ContentPreviewResponse>(
      await page.request.post(
        `${apiBaseUrl}/v1/content-documents/${persisted.document.id}/preview`,
        {
          data: {
            versionId: publishedVersionId,
            context: renderContext,
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
            recipient: 'ada+artifact-email-e2e@example.test',
            context: renderContext,
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

    await attachScreenshot(page, testInfo, 'admin-content-email-persisted-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.reload();
    await expect(page.getByLabel('Subject')).toHaveValue(subject);
    await expect(page.getByLabel('Email body')).toHaveValue(body);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);
    await attachScreenshot(page, testInfo, 'admin-content-email-persisted-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.getByLabel('More actions').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Archive template' }).click();
    await expect(page.getByText('Archived email template')).toBeVisible();
    const archived = await loadEmailContentState(event.id, page);
    expect(archived.document.status).toBe('archived');
  });

  test('surfaces publish blockers for invalid email content with axe and CDP proof', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(
      page,
      `blockers-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`,
    );

    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);

    await page.getByLabel('Subject').fill('');
    await page
      .getByLabel('Email body')
      .fill(`Hi {{recipient.name}}, ${event.title} is almost here.`);
    await page.getByRole('button', { name: 'Save draft' }).click();

    await expect(page.getByText(/Saved draft v\d+/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resolve publish blockers' })).toBeDisabled();
    await page.getByRole('button', { name: 'Issues', exact: true }).click();
    await expect(page.getByText('missing_subject')).toBeVisible();
    await expect(
      page.getByText('Email templates require a subject line before publishing'),
    ).toBeVisible();
    await expect(page.getByLabel('Subject')).toHaveValue('');
    await expect(page.getByLabel('Email body')).toBeVisible();

    await attachScreenshot(page, testInfo, `admin-content-email-publish-blockers-${browserName}`);
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const blockerSnapshot = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const issues = [...document.querySelectorAll('section')]
            .find((section) =>
              section.textContent?.includes('Issues')
              && section.textContent?.includes('missing_subject')
            );
          const issuesTab = [...document.querySelectorAll('button')]
            .find((candidate) => candidate.textContent?.trim() === 'Issues');
          return {
            hasBlockerPanel: Boolean(issues),
            blockerText: issues?.textContent ?? '',
            blockerTabPressed: issuesTab?.getAttribute('aria-pressed') === 'true',
          };
        })()`,
        returnByValue: true,
      });
      await testInfo.attach('cdp-email-publish-blockers', {
        body: JSON.stringify(blockerSnapshot.result.value, null, 2),
        contentType: 'application/json',
      });
      expect(blockerSnapshot.result.value).toMatchObject({
        hasBlockerPanel: true,
        blockerTabPressed: true,
      });
      expect(String(blockerSnapshot.result.value.blockerText)).toContain('missing_subject');
      await client.detach();
    }
  });

  test('captures Chromium CDP layout metrics for the persisted email editor', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `cdp-${Date.now()}`);
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);

    const client = await page.context().newCDPSession(page);
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      body: 'textarea',
      recipient: 'input[type="email"]',
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
          expect(heightOf(box.model.content)).toBeGreaterThanOrEqual(name === 'body' ? 80 : 20);
          return [name, box] as const;
        }),
      ),
    );

    await testInfo.attach('cdp-layout-boxes-email-persisted', {
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
