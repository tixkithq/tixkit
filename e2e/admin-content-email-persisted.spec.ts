import { type APIResponse, type Page, type TestInfo } from '@playwright/test';
import { createDb } from '../packages/db/src/client';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, apiBaseUrl, checkoutBaseUrl } from './helpers/env';
import {
  devBrandId,
  devOrganizationId,
  seedFreeCheckoutEvent,
  seedMessageConsentForEmail,
} from './helpers/seed';

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
  output: {
    html?: string;
    text?: string;
  };
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
  const senderIdentityId = 'bsi_content_email_e2e';
  const now = new Date();

  try {
    await db
      .insertInto('brand_sender_identities')
      .values({
        id: senderIdentityId,
        tenant_id: devTenantId,
        brand_id: devBrandId,
        email: 'tickets@example.test',
        name: 'Tixkit',
        reply_to_email: 'support@example.test',
        verified: true,
        verified_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('id').doUpdateSet({
          email: 'tickets@example.test',
          name: 'Tixkit',
          reply_to_email: 'support@example.test',
          verified: true,
          verified_at: now,
          updated_at: now,
        }),
      )
      .execute();

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

async function completeSeededFreeCheckout(input: {
  buyerEmail: string;
  eventId: string;
  eventTitle: string;
  page: Page;
  productName: string;
  ticketName: string;
}): Promise<void> {
  await input.page.goto(`${checkoutBaseUrl}/checkout?eventId=${input.eventId}`);

  await expect(input.page.getByRole('heading', { name: input.eventTitle })).toBeVisible();
  await input.page
    .getByRole('button', { name: `Increase ${input.ticketName} quantity` })
    .click();
  await input.page
    .getByRole('button', { name: `Increase ${input.productName} quantity` })
    .click();
  await input.page.getByLabel('Email').fill(input.buyerEmail);
  await input.page.getByLabel('First name').fill('Ada');
  await input.page.getByLabel('Last name').fill('Lovelace');
  await input.page.getByRole('button', { name: 'Continue' }).click();

  await expect(input.page.getByRole('button', { name: 'Place free order' })).toBeVisible();
  await input.page.getByRole('button', { name: 'Place free order' }).click();
  await expect(input.page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
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

async function expectPersistedEmailEditorRegions(
  page: Page,
  options: { compact?: boolean } = {},
): Promise<void> {
  if (options.compact) {
    await expect(page.getByRole('button', { name: 'Inspector' })).toBeVisible();
  } else {
    await expect(page.getByText('Page style')).toBeVisible();
    await expect(page.getByTestId('native-email-inspector-host')).toBeVisible();
    await expect(page.getByText('Applies to the selected paragraph or heading.')).toHaveCount(0);
  }
  await expect(page.getByLabel('Subject')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview text', exact: true })).toBeVisible();
  await expect(page.getByLabel('Email body')).toBeVisible();
  await expect(page.getByLabel('Verified sender')).toBeVisible();
  await expect(page.getByLabel('Reply-To')).toBeVisible();
  await expect(page.getByLabel('Audience')).toBeVisible();
  await expect(page.getByLabel('Send timing')).toBeVisible();
  await expect(page.locator('[data-testid="content-editor-shell"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="editor-canvas"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await expect(page.getByLabel('More actions')).toBeVisible();
}

async function expectEmailDocumentCanvasPresentation(page: Page): Promise<void> {
  const canvas = page.locator('[data-testid="editor-canvas"]').first();
  await expect(canvas).toHaveAttribute('aria-label', /email template editable document$/);
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
}

async function expectInspectorColorFieldsAreUnboxed(page: Page): Promise<void> {
  const inspector = page.getByTestId('native-email-inspector-host');
  await expect(inspector).toBeVisible();
  const snapshot = await inspector.evaluate((node) => {
    const colorTrigger = node.querySelector<HTMLElement>('[data-re-inspector-color-trigger]');
    const colorHex = node.querySelector<HTMLElement>('[data-re-inspector-color-hex]');
    const triggerStyles = colorTrigger ? window.getComputedStyle(colorTrigger) : null;
    const hexStyles = colorHex ? window.getComputedStyle(colorHex) : null;
    return {
      triggerBorderTopWidth: triggerStyles?.borderTopWidth ?? null,
      triggerPaddingTop: triggerStyles?.paddingTop ?? null,
      hexBorderTopWidth: hexStyles?.borderTopWidth ?? null,
      hexBackground: hexStyles?.backgroundColor ?? null,
    };
  });
  expect(snapshot.triggerBorderTopWidth).toBe('0px');
  expect(snapshot.triggerPaddingTop).toBe('0px');
  expect(snapshot.hexBorderTopWidth).toBe('0px');
  expect(snapshot.hexBackground).toBe('rgba(0, 0, 0, 0)');
}

async function expectFriendlyVariableChip(page: Page): Promise<void> {
  const chip = page.locator('.tixkit-email-variable-chip').first();
  const chipTextPoint = () =>
    chip.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const textRect = range.getClientRects()[0];
      const rect = textRect ?? element.getBoundingClientRect();
      range.detach();
      return {
        x: rect.left + Math.min(Math.max(rect.width / 2, 1), 8),
        y: rect.top + rect.height / 2,
      };
    });
  await expect(chip).toHaveAttribute('data-variable-key', 'recipient.name');
  await expect(chip).toHaveAttribute('data-variable-kind', 'recipient');
  await expect(chip).toHaveAttribute('data-variable-label', 'Attendee name');
  await expect(chip).toHaveAttribute('data-variable-preview', 'Ada Lovelace');
  await expect(chip).toHaveAttribute('data-variable-detail', 'Attendee name - {{recipient.name}}');
  const snapshot = await chip.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    const labelTooltip = window.getComputedStyle(element, '::before');
    return {
      text: element.textContent,
      color: styles.color,
      fontSize: styles.fontSize,
      background: styles.backgroundColor,
      textDecorationLine: styles.textDecorationLine,
      textDecorationStyle: styles.textDecorationStyle,
      labelTooltipContent: labelTooltip.content,
      labelTooltipDisplay: labelTooltip.display,
    };
  });
  expect(snapshot.text).toContain('Ada Lovelace');
  expect(snapshot.text).not.toContain('{{recipient.name}}');
  expect(snapshot.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(snapshot.fontSize).not.toBe('0px');
  expect(snapshot.background).toBe('rgba(0, 0, 0, 0)');
  expect(snapshot.textDecorationLine).toBe('underline');
  expect(snapshot.textDecorationStyle).toBe('dotted');
  expect(snapshot.labelTooltipContent).toBe('none');
  expect(snapshot.labelTooltipDisplay).toBe('none');

  await chip.scrollIntoViewIfNeeded();
  const hoverPoint = await chipTextPoint();
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await expect
    .poll(() => chip.evaluate((element) => window.getComputedStyle(element, '::before').display))
    .toBe('none');

  const clickPoint = await chipTextPoint();
  const packageTooltip = page.locator('[data-re-bubble-menu]').first();
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await expect(page.locator('.tixkit-email-variable-chip--active').first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toContain('Ada Lovelace');
  await expect(packageTooltip).toBeVisible();
  await expect(page.getByLabel('Inline text formatting')).toHaveCount(0);
  await expect(page.getByLabel('Edit variable')).toHaveCount(0);
  const menuSnapshot = await packageTooltip.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      fontSize: styles.fontSize,
      visibility: styles.visibility,
    };
  });
  expect(menuSnapshot.background).not.toBe('rgb(255, 255, 255)');
  expect(menuSnapshot.fontSize).toBe('13px');
  expect(menuSnapshot.visibility).toBe('visible');
  await expect(packageTooltip.getByRole('button', { name: 'Align center' })).toBeVisible();
  await expect(packageTooltip.getByLabel('Selection color')).toBeVisible();
  await expect(packageTooltip.getByLabel('Selection text size')).toBeVisible();
  await expect(packageTooltip.getByLabel('Selection line height')).toBeVisible();
  await expect(packageTooltip.getByLabel('Variable replacement')).toHaveCount(0);
  const variableOptionsButton = packageTooltip.getByRole('button', { name: 'Variable options' });
  await expect(variableOptionsButton).toBeVisible();

  const variableFirstClickSizeInput = packageTooltip.getByLabel('Selection text size');
  await variableFirstClickSizeInput.click();
  await expect(packageTooltip).toBeVisible();
  await expect(variableFirstClickSizeInput).toBeFocused();
  await variableFirstClickSizeInput.fill('16');
  await expect(packageTooltip).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).fontSize),
    )
    .toBe('16px');

  const variableFirstClickColorInput = packageTooltip.getByLabel('Selection color');
  await variableFirstClickColorInput.click();
  await expect(packageTooltip).toBeVisible();
  await variableFirstClickColorInput.fill('#b91c1c');
  await expect(packageTooltip).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).color),
    )
    .toBe('rgb(185, 28, 28)');

  await expect(page.getByLabel('Edit variable')).toHaveCount(0);
  await variableOptionsButton.click();
  const variableMenu = page.getByLabel('Edit variable');
  await expect(variableMenu).toBeVisible();
  const variableMenuSnapshot = await variableMenu.evaluate((element) => {
    const styles = window.getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      fontSize: styles.fontSize,
      position: styles.position,
    };
  });
  expect(variableMenuSnapshot.background).toBe('rgba(255, 255, 255, 0.98)');
  expect(variableMenuSnapshot.fontSize).toBe('14px');
  expect(variableMenuSnapshot.position).toBe('fixed');
  await expect(variableMenu.getByLabel('Variable replacement')).toBeVisible();
  await expect(variableMenu.getByRole('option', { name: 'Change variable to Event name' })).toBeVisible();
  await expect(variableMenu.getByRole('button', { name: 'Close variable menu' })).toHaveCount(0);
  await variableOptionsButton.click();
  await expect(page.getByLabel('Edit variable')).toHaveCount(0);

  const rowTextPoint = await page.getByLabel('Email body').evaluate((root) => {
    const plainTextNeedles = ['tickets for', 'tickets are ready'];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? '';
      const needle = plainTextNeedles.find((candidate) => text.includes(candidate));
      if (!needle) continue;
      const index = text.indexOf(needle);
      const range = document.createRange();
      range.setStart(node, index + 4);
      range.setEnd(node, Math.min(index + 10, text.length));
      const rect = range.getBoundingClientRect();
      range.detach();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error('Ready row text was not found');
  });
  await page.mouse.click(rowTextPoint.x, rowTextPoint.y);
  await expect(packageTooltip).toBeVisible();
  await expect(page.getByLabel('Edit variable')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  const firstClickSizeInput = packageTooltip.getByLabel('Selection text size');
  await firstClickSizeInput.click();
  await expect(packageTooltip).toBeVisible();
  await expect(firstClickSizeInput).toBeFocused();
  await firstClickSizeInput.fill('17');
  await expect(packageTooltip).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).fontSize),
    )
    .toBe('17px');

  const firstClickColorInput = packageTooltip.getByLabel('Selection color');
  await firstClickColorInput.click();
  await expect(packageTooltip).toBeVisible();
  await firstClickColorInput.fill('#b91c1c');
  await expect(packageTooltip).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).color),
    )
    .toBe('rgb(185, 28, 28)');

  await packageTooltip.getByRole('button', { name: 'Align center' }).click();
  await expect(packageTooltip).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

  await packageTooltip.getByLabel('Selection color').fill('#0f766e');
  await packageTooltip.getByLabel('Selection text size').fill('18');
  await packageTooltip.getByLabel('Selection line height').fill('140');
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).color),
    )
    .toBe('rgb(15, 118, 110)');
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).fontSize),
    )
    .toBe('18px');
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="recipient.name"]')
        .evaluate((element) => window.getComputedStyle(element).lineHeight),
    )
    .toMatch(/^25(\.2)?px$/);
  await expect(packageTooltip).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="ticket.type"]')
        .evaluate((element) => window.getComputedStyle(element).color),
    )
    .toBe('rgb(15, 118, 110)');
  await expect
    .poll(() =>
      page
        .locator('.tixkit-email-variable-chip[data-variable-key="ticket.type"]')
        .evaluate((element) => window.getComputedStyle(element).fontSize),
    )
    .toBe('18px');

  const styledClickPoint = await chipTextPoint();
  await page.mouse.click(styledClickPoint.x, styledClickPoint.y);
  await expect(page.getByLabel('Edit variable')).toHaveCount(0);
  await packageTooltip.getByRole('button', { name: 'Variable options' }).click();
  const replacementMenu = page.getByLabel('Edit variable');
  await expect(replacementMenu).toBeVisible();
  await replacementMenu.getByRole('option', { name: 'Change variable to Attendee name' }).click();
  await expect(page.getByLabel('Edit variable')).toHaveCount(0);

}

test.describe('persisted admin email content editor', () => {
  test.describe.configure({ timeout: 120_000 });

  test('saves, publishes, test-sends, and reloads a canonical email template', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await page.route('**/%7B%7Bticket.qrCodeUrl%7D%7D', async (route) => {
      await route.fulfill({
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64',
        ),
        contentType: 'image/png',
      });
    });
    await seedEmailCaptureProviderRoute();

    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const seeded = await seedFreeCheckoutEvent(page.request, suffix);
    const event = seeded.event;
    const buyerEmail = `content-email+${suffix}@example.com`;
    await completeSeededFreeCheckout({
      buyerEmail,
      eventId: event.id,
      eventTitle: event.title,
      page,
      productName: seeded.product.name,
      ticketName: seeded.ticketType.name,
    });
    await seedMessageConsentForEmail(event.id, buyerEmail, suffix);
    const subject = `Tickets for ${event.title}`;
    const body = `Hi {{recipient.name}}, your {{ticket.type}} tickets for ${event.title} are ready.`;
    const normalizedBody = body.replace(/\s+/g, ' ');
    const renderedBody = `Hi Ada Lovelace, your ${seeded.ticketType.name} tickets for ${event.title} are ready.`;
    const normalizedRenderedBody = renderedBody.replace(/\s+/g, ' ');

    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectEmailDocumentCanvasPresentation(page);
    await expectInspectorColorFieldsAreUnboxed(page);

    await page.getByLabel('Subject').fill(subject);
    await page.getByRole('button', { name: 'Preview text', exact: true }).click();
    await page.getByLabel('Preview text').fill('Everything you need before arrival.');
    const emailBody = page.getByLabel('Email body');
    await emailBody.click();
    await emailBody.press('ControlOrMeta+A');
    await page.keyboard.type(body);
    await expectFriendlyVariableChip(page);
    await page.getByLabel('Verified sender').selectOption({
      label: 'Tixkit <tickets@example.test>',
    });
    await page.getByLabel('Reply-To').selectOption('support@example.test');
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Ready to send?' })).toBeVisible();
    await expect(page.getByText('Content analysis complete')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send email' })).toBeDisabled();
    await page.getByLabel('Slide to confirm email campaign send').fill('100');
    await page.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email campaign queued')).toBeVisible();

    await page.getByLabel('More actions').click();
    await page.getByRole('menuitem', { name: 'Send test' }).click();
    await expect(page.getByRole('dialog', { name: 'Send test email' })).toBeVisible();
    await page
      .getByLabel('Test recipients')
      .fill('ada+email-e2e@example.test\ngrace+email-e2e@example.test');
    await page.getByLabel('Test recipients').press('ControlOrMeta+Enter');
    await expect(page.getByText('Captured 2 test sends')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Send test email' })).toBeHidden();

    const persisted = await loadEmailContentState(event.id, page);
    expect(persisted.document.status).toBe('published');
    expect(persisted.document.publishedVersionId).toBeTruthy();
    expect(
      persisted.versions.some(
        (version) =>
              version.status === 'published' &&
              version.contentJson.schemaVersion === 1 &&
              version.contentJson.editor?.provider === '@react-email/editor' &&
              /text-align:\s*center/.test(version.contentJson.editor.contentHtml ?? '') &&
              /color:\s*#0f766e/.test(version.contentJson.editor.contentHtml ?? '') &&
              /font-size:\s*18px/.test(version.contentJson.editor.contentHtml ?? '') &&
              /line-height:\s*140%/.test(version.contentJson.editor.contentHtml ?? '') &&
              version.contentJson.settings?.subject === subject &&
              version.contentJson.blocks?.some(
            (block) =>
              block.type === 'event_hero' &&
              typeof block.body === 'string' &&
              block.body.replace(/\s+/g, ' ') === normalizedBody,
          ),
      ),
    ).toBe(true);
    const publishedVersion = persisted.versions.find(
      (version) => version.id === persisted.document.publishedVersionId,
    );
    expect(publishedVersion?.contentJson.editor?.contentText).toContain('{{recipient.name}}');
    expect(publishedVersion?.contentJson.editor?.contentHtml).toContain('{{recipient.name}}');
    expect(publishedVersion?.contentJson.editor?.contentHtml).not.toContain(
      'data-tixkit-merge-tag',
    );
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
      ticket: { type: seeded.ticketType.name },
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
    expect(
      `${artifactPreview.output.text ?? ''}\n${artifactPreview.output.html ?? ''}`.replace(
        /\s+/g,
        ' ',
      ),
    ).toContain(normalizedRenderedBody);
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

    await page.reload();
    await expect(page.getByLabel('Subject')).toHaveValue(subject);
    const reloadedBody = page.getByLabel('Email body');
    await expect(reloadedBody.locator('.tixkit-email-variable-chip').first()).toHaveAttribute(
      'data-variable-key',
      'recipient.name',
    );
    await expect
      .poll(() => reloadedBody.innerText())
      .toContain('Ada Lovelace');
    expect((await reloadedBody.innerText()).replace(/\s+/g, ' ').trim()).not.toContain(
      '{{recipient.name}}',
    );
    expect((await reloadedBody.textContent())?.replace(/\s+/g, ' ').trim()).not.toContain(
      '{{recipient.name}}',
    );
    await attachScreenshot(page, testInfo, 'admin-content-email-persisted-desktop');
    await expectNoAxeViolations(page, testInfo);

    await page.setViewportSize(mobileViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page, { compact: true });
    await attachScreenshot(page, testInfo, 'admin-content-email-persisted-mobile');
    await expectNoAxeViolations(page, testInfo);

    await page.getByLabel('More actions').click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    await expect
      .poll(async () => (await loadEmailContentState(event.id, page)).document.status, {
        timeout: 30_000,
      })
      .toBe('archived');
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
    await page.getByLabel('More actions').click();
    await page.getByRole('menuitem', { name: 'Save draft' }).click();

    await expect(page.getByText(/Saved draft v\d+/)).toBeVisible();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByText('Resolve email review blockers before sending.')).toBeVisible();
    await expect(page.getByText('missing_subject').first()).toBeVisible();
    await expect(
      page.getByText('Email templates require a subject line before publishing').first(),
    ).toBeVisible();
    await expect(page.getByLabel('Subject')).toHaveValue('');
    await expect(page.getByLabel('Email body')).toBeVisible();

    await attachScreenshot(page, testInfo, `admin-content-email-publish-blockers-${browserName}`);
    await expectNoAxeViolations(page, testInfo);

    if (browserName === 'chromium') {
      const client = await page.context().newCDPSession(page);
      const blockerSnapshot = await client.send('Runtime.evaluate', {
        expression: `(() => {
          const issues = document.querySelector('aside[aria-label="Inspector"]');
          const text = issues?.textContent ?? '';
          return {
            hasBlockerPanel: Boolean(
              issues
              && text.includes('Review checks')
              && text.includes('missing_subject')
            ),
            blockerText: text,
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
      });
      expect(String(blockerSnapshot.result.value.blockerText)).toContain('missing_subject');
      await client.detach();
    }
  });

  test('inserts native slash blocks and exports email-safe alignment', async ({
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');
    await page.route('**/%7B%7Bticket.qrCodeUrl%7D%7D', async (route) => {
      await route.fulfill({
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64',
        ),
        contentType: 'image/png',
      });
    });

    async function openSeededEmailEditor(prefix: string) {
      const event = await seedContentEvent(
        page,
        `${prefix}-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}`,
      );
      await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
      await page.setViewportSize(desktopViewport);
      await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
      await expectPersistedEmailEditorRegions(page);
      return event;
    }

    async function runSlashCommand(title: string) {
      const emailBody = page.getByLabel('Email body');
      await emailBody.click();
      await emailBody.press('ControlOrMeta+A');
      await page.keyboard.type('/');
      await page.getByText(title, { exact: true }).click();
    }

    async function saveCurrentDraft() {
      await page.getByLabel('More actions').click();
      await page.getByRole('menuitem', { name: 'Save draft' }).click();
      await expect(page.getByText(/Saved draft v\d+/)).toBeVisible();
    }

    const buttonEvent = await openSeededEmailEditor('slash-button');
    await runSlashCommand('Button');
    await expect(page.locator('a[data-id="react-email-button"]')).toHaveText('Button');
    await page.locator('a[data-id="react-email-button"]').click();
    await page.getByRole('button', { name: 'Align center' }).click();
    await saveCurrentDraft();
    const buttonState = await loadEmailContentState(buttonEvent.id, page);
    const buttonHtml = buttonState.versions[0]?.contentJson.editor?.contentHtml ?? '';
    expect(buttonHtml).toContain('class="button"');
    expect(buttonHtml).toContain('mso-padding-alt');
    expect(buttonHtml).toMatch(/align="center"|align:center|text-align:\s*center/);

    const imageEvent = await openSeededEmailEditor('slash-image');
    await runSlashCommand('Ticket QR');
    await expect(page.locator('img[alt="Ticket QR code"]')).toBeVisible();
    await page.locator('img[alt="Ticket QR code"]').click();
    await page.getByRole('button', { name: 'Align right' }).click();
    await saveCurrentDraft();
    const imageState = await loadEmailContentState(imageEvent.id, page);
    const imageHtml = imageState.versions[0]?.contentJson.editor?.contentHtml ?? '';
    expect(imageHtml).toContain('src="{{ticket.qrCodeUrl}}"');
    expect(imageHtml).toMatch(/align="right"|align:right|text-align:\s*right/);

    const layoutEvent = await openSeededEmailEditor('slash-layout');
    await runSlashCommand('Section');
    await expect(page.locator('[data-type="section"]')).toBeVisible();
    await page.locator('[data-type="section"]').click();
    await page.getByRole('button', { name: 'Align right' }).click();
    await saveCurrentDraft();
    const sectionState = await loadEmailContentState(layoutEvent.id, page);
    const sectionHtml = sectionState.versions[0]?.contentJson.editor?.contentHtml ?? '';
    expect(sectionHtml).toMatch(/align="right"|align:right|text-align:\s*right/);

    const columnsEvent = await openSeededEmailEditor('slash-columns');
    await runSlashCommand('2 columns');
    await expect(page.locator('[data-type="two-columns"]')).toBeVisible();
    await page.locator('[data-type="column"]').first().click();
    await page.getByRole('button', { name: 'Align right' }).click();
    await saveCurrentDraft();
    const columnsState = await loadEmailContentState(columnsEvent.id, page);
    const columnsHtml = columnsState.versions[0]?.contentJson.editor?.contentHtml ?? '';
    expect(columnsHtml).toMatch(/<td align="right" data-id="__react-email-column">/);
    expect(layoutEvent.id).not.toBe(columnsEvent.id);
  });

  test('captures Chromium CDP layout metrics for the persisted email editor', async ({
    browserName,
    page,
  }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP layout inspection is Chromium-only.');
    await requireReachable(page, adminBaseUrl, 'admin dashboard');
    await requireReachable(page, `${apiBaseUrl}/health`, 'api');

    const event = await seedContentEvent(page, `cdp-${Date.now()}`);
    await page.addInitScript(() => window.localStorage.setItem('tixkit-theme', 'light'));
    await page.setViewportSize(desktopViewport);
    await page.goto(`${adminBaseUrl}/events/${event.id}/content/email`);
    await expectPersistedEmailEditorRegions(page);
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expectEmailDocumentCanvasPresentation(page);

    const client = await page.context().newCDPSession(page);
    const selectors = {
      shell: '[data-testid="content-editor-shell"]',
      canvas: '[data-testid="editor-canvas"]',
      body: '[aria-label="Email body"]',
      inspector: '[data-testid="native-email-inspector-host"]',
    } as const;
    const boxes = Object.fromEntries(
      await Promise.all(
        Object.entries(selectors).map(async ([name, selector]) => {
          const result = await client.send('Runtime.evaluate', {
            expression: `(() => {
              const element = document.querySelector(${JSON.stringify(selector)});
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            })()`,
            returnByValue: true,
          });
          const box = result.result.value as {
            x: number;
            y: number;
            width: number;
            height: number;
          } | null;
          expect(box).not.toBeNull();
          expect(box!.width).toBeGreaterThan(name === 'shell' ? 900 : 250);
          expect(box!.height).toBeGreaterThanOrEqual(name === 'body' ? 80 : 20);
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
