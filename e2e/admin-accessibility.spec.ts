import fs from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, requireReachable } from './fixtures/validation-test';
import { expectNoAxeViolations } from './helpers/axe';
import { adminBaseUrl, checkoutBaseUrl, checkoutEventId, widgetBundlePath } from './helpers/env';
import { seedFreeCheckoutEvent } from './helpers/seed';

type SemanticSnapshot = {
  mainCount: number;
  headingTexts: string[];
  headingIssues: string[];
  unnamedButtons: string[];
  unlabeledFields: string[];
  navNames: string[];
};

type ShadowModalSnapshot = {
  role: string | null;
  ariaModal: string | null;
  labelledBy: string | null;
  titleText: string;
  closeLabel: string | null;
  frameTitle: string | null;
};

async function checkoutEventForTest(
  request: Parameters<typeof seedFreeCheckoutEvent>[0],
  suffix: string,
): Promise<{ id: string; title: string; ticketName: string }> {
  if (checkoutEventId) {
    return {
      id: checkoutEventId,
      title: 'Checkout',
      ticketName: 'General Admission',
    };
  }
  const seeded = await seedFreeCheckoutEvent(request, suffix);
  return {
    id: seeded.event.id,
    title: seeded.event.title,
    ticketName: seeded.ticketType.name,
  };
}

async function expectScreenReaderSemantics(
  page: Page,
  options: { requireNavigation?: boolean; requireFormLabels?: boolean } = {},
): Promise<void> {
  const snapshot = await page.evaluate<SemanticSnapshot>(
    ({ requireFormLabels }) => {
      function accessibleText(element: Element): string {
        const ariaLabel = element.getAttribute('aria-label')?.trim();
        if (ariaLabel) return ariaLabel;
        const labelledBy = element.getAttribute('aria-labelledby')?.trim();
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ')
            .trim();
          if (text) return text;
        }
        const title = element.getAttribute('title')?.trim();
        if (title) return title;
        return element.textContent?.trim() ?? '';
      }

      function hasFieldName(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
        if (accessibleText(field)) return true;
        if (field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`)) {
          return true;
        }
        return Boolean(field.closest('label'));
      }

      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(
        (heading) => ({
          level: Number(heading.tagName.slice(1)),
          text: heading.textContent?.trim() ?? '',
        }),
      );
      const headingIssues: string[] = [];
      let previousLevel = 0;
      for (const heading of headings) {
        if (!heading.text) headingIssues.push('empty heading');
        if (previousLevel > 0 && heading.level > previousLevel + 1) {
          headingIssues.push(`heading level skipped from ${previousLevel} to ${heading.level}`);
        }
        previousLevel = heading.level;
      }
      if (!headings.some((heading) => heading.level === 1)) headingIssues.push('missing h1');

      const fields = requireFormLabels
        ? Array.from(document.querySelectorAll('input, select, textarea')).filter(
            (field) => !(field as HTMLInputElement).disabled,
          )
        : [];

      return {
        mainCount: document.querySelectorAll('main').length,
        headingTexts: headings.map((heading) => heading.text),
        headingIssues,
        unnamedButtons: Array.from(document.querySelectorAll('button'))
          .filter((button) => !button.disabled && !accessibleText(button))
          .map((button) => button.outerHTML.slice(0, 160)),
        unlabeledFields: fields
          .filter(
            (field) =>
              !hasFieldName(field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement),
          )
          .map((field) => field.outerHTML.slice(0, 160)),
        navNames: Array.from(document.querySelectorAll('nav'))
          .map((nav) => accessibleText(nav))
          .filter(Boolean),
      };
    },
    { requireFormLabels: Boolean(options.requireFormLabels) },
  );

  expect(snapshot.mainCount).toBeGreaterThanOrEqual(1);
  expect(snapshot.headingTexts.length).toBeGreaterThan(0);
  expect(snapshot.headingIssues).toEqual([]);
  expect(snapshot.unnamedButtons).toEqual([]);
  expect(snapshot.unlabeledFields).toEqual([]);
  if (options.requireNavigation) {
    expect(snapshot.navNames.length).toBeGreaterThan(0);
  }
}

async function expectKeyboardTraversal(
  page: Page,
  minimumStops: number,
  browserName: string,
): Promise<void> {
  const focusedStops: string[] = [];
  const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  for (let i = 0; i < minimumStops; i += 1) {
    await page.keyboard.press(tabKey);
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return '';
      const label =
        element.getAttribute('aria-label') ??
        element.textContent?.trim() ??
        element.getAttribute('name') ??
        element.tagName;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? `${element.tagName}:${label}` : '';
    });
    if (focused) focusedStops.push(focused);
  }
  expect(focusedStops.length).toBeGreaterThanOrEqual(minimumStops);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function loadWidgetAuditHost(page: Page, eventId: string): Promise<void> {
  const checkoutUrl = new URL(checkoutBaseUrl);
  const hostBase =
    checkoutUrl.hostname === 'localhost'
      ? `${checkoutUrl.protocol}//127.0.0.1${checkoutUrl.port ? `:${checkoutUrl.port}` : ''}`
      : checkoutBaseUrl;
  const url = `${hostBase}/__e2e_wcag_widget`;

  await page.route(`${hostBase}/v1/public/events/**/widget-impressions`, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ tracked: true, deduped: false }),
    }),
  );
  await page.route(`${hostBase}/v1/public/events/**/marketing-integrations`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `
        <!doctype html>
        <html lang="en">
          <head>
            <title>Tixkit WCAG widget audit</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
          </head>
          <body>
            <main>
              <h1>Tixkit WCAG widget audit</h1>
              <tixkit-widget
                id="modal-widget"
                api-base-url="${checkoutBaseUrl}"
                reporting-api-url="${hostBase}"
                brand="brd_dev_local"
                event="${eventId}"
                checkout-mode="modal"
              ></tixkit-widget>
              <tixkit-button
                id="modal-button"
                api-base-url="${checkoutBaseUrl}"
                reporting-api-url="${hostBase}"
                brand="brd_dev_local"
                event="${eventId}"
                checkout-mode="modal"
              >Buy with button</tixkit-button>
            </main>
          </body>
        </html>
      `,
    }),
  );
  await page.goto(url);
  await page.addScriptTag({ path: widgetBundlePath, type: 'module' });
  await page.waitForFunction(
    () => customElements.get('tixkit-widget') && customElements.get('tixkit-button'),
  );
}

async function openShadowModal(page: Page, hostSelector: string): Promise<ShadowModalSnapshot> {
  return page.evaluate((selector) => {
    const host = document.querySelector<HTMLElement>(selector);
    const button = host?.shadowRoot?.querySelector<HTMLButtonElement>(
      'button:not(.tk-modal-close)',
    );
    button?.focus();
    button?.click();
    const modal = host?.shadowRoot?.querySelector<HTMLElement>('.tk-modal');
    const close = host?.shadowRoot?.querySelector<HTMLButtonElement>('.tk-modal-close');
    const frame = host?.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    return {
      role: modal?.getAttribute('role') ?? null,
      ariaModal: modal?.getAttribute('aria-modal') ?? null,
      labelledBy: modal?.getAttribute('aria-labelledby') ?? null,
      titleText: host?.shadowRoot?.querySelector('.tk-modal-title')?.textContent?.trim() ?? '',
      closeLabel: close?.getAttribute('aria-label') ?? null,
      frameTitle: frame?.getAttribute('title') ?? null,
    };
  }, hostSelector);
}

async function expectShadowModalClosesWithEscape(page: Page, hostSelector: string): Promise<void> {
  await page.keyboard.press('Escape');
  await expect
    .poll(async () =>
      page.evaluate((selector) => {
        const host = document.querySelector<HTMLElement>(selector);
        const modalOpen = Boolean(host?.shadowRoot?.querySelector('.tk-modal'));
        const triggerFocused =
          host?.shadowRoot?.activeElement ===
          host?.shadowRoot?.querySelector('button:not(.tk-modal-close)');
        return { modalOpen, triggerFocused };
      }, hostSelector),
    )
    .toEqual({ modalOpen: false, triggerFocused: true });
}

test.describe('WCAG 2.2 AA certification audit', () => {
  test('admin dashboard supports axe, landmarks, screen-reader names, and keyboard traversal', async ({
    browserName,
    page,
  }, testInfo) => {
    await requireReachable(page, adminBaseUrl, 'admin dashboard');

    await page.goto(`${adminBaseUrl}/dashboard`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to Main' })).toBeAttached();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('complementary', { name: /sidebar|workspace/i })).toBeVisible();

    await expectNoAxeViolations(page, testInfo);
    await expectScreenReaderSemantics(page, { requireNavigation: true });
    await expectKeyboardTraversal(page, 5, browserName);
    await attachScreenshot(page, testInfo, 'wcag-admin-dashboard');
  });

  test('hosted checkout supports axe, form labels, landmarks, and keyboard-only purchase entry', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    const event = await checkoutEventForTest(
      request,
      `wcag-checkout-${testInfo.workerIndex}-${Date.now()}`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');

    await page.goto(`${checkoutBaseUrl}/e/${encodeURIComponent(event.id)}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await expectScreenReaderSemantics(page);

    await page.goto(`${checkoutBaseUrl}/checkout?eventId=${encodeURIComponent(event.id)}`);
    await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: `Increase ${event.ticketName} quantity`,
      }),
    ).toBeVisible();

    await expectNoAxeViolations(page, testInfo);
    await expectScreenReaderSemantics(page, { requireFormLabels: true });
    await expectKeyboardTraversal(page, 7, browserName);
    await attachScreenshot(page, testInfo, 'wcag-checkout-flow');
  });

  test('embedded widget modal exposes dialog semantics, keyboard close, focus return, and axe coverage', async ({
    browserName,
    page,
    request,
  }, testInfo) => {
    test.skip(
      !fs.existsSync(widgetBundlePath),
      `Widget bundle not found at ${widgetBundlePath}; run bun --filter @tixkit/widget build.`,
    );
    const event = await checkoutEventForTest(
      request,
      `wcag-widget-${testInfo.workerIndex}-${Date.now()}`,
    );
    await requireReachable(page, checkoutBaseUrl, 'checkout app');
    await loadWidgetAuditHost(page, event.id);

    await expectScreenReaderSemantics(page);
    await expectKeyboardTraversal(page, 2, browserName);

    const widgetModal = await openShadowModal(page, '#modal-widget');
    expect(widgetModal).toEqual({
      role: 'dialog',
      ariaModal: 'true',
      labelledBy: 'tk-widget-modal-title',
      titleText: 'Checkout',
      closeLabel: 'Close checkout',
      frameTitle: 'Tixkit Checkout',
    });
    await expectShadowModalClosesWithEscape(page, '#modal-widget');

    const buttonModal = await openShadowModal(page, '#modal-button');
    expect(buttonModal).toEqual({
      role: 'dialog',
      ariaModal: 'true',
      labelledBy: 'tk-button-modal-title',
      titleText: 'Checkout',
      closeLabel: 'Close checkout',
      frameTitle: 'Tixkit Checkout',
    });

    await expectNoAxeViolations(
      page,
      testInfo,
      'body',
      ['iframe'],
      ['landmark-unique', 'landmark-one-main', 'page-has-heading-one'],
    );
    await expectShadowModalClosesWithEscape(page, '#modal-button');
    await attachScreenshot(page, testInfo, 'wcag-widget-modal');
  });
});
