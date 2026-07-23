import type { ConsoleMessage, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export type ExpectedConsoleErrorMatcher = {
  message: RegExp;
  url: RegExp;
};

export type ExpectedBrowserErrorScope = {
  phase: string;
  console?: ExpectedConsoleErrorMatcher[];
};

export type BrowserErrorCollector = {
  consoleErrors: string[];
  pageErrors: string[];
  beginExpectedErrorScope: (scope: ExpectedBrowserErrorScope) => () => void;
  assertClean: () => void;
  dispose: () => void;
};

type ActiveScope = ExpectedBrowserErrorScope & { closed: boolean };

const BASELINE_CONSOLE_PATTERNS = [/Download the React DevTools/i, /\[HMR\]/i];

/**
 * Collect unexpected browser errors. Expected failures must be declared for a
 * narrow phase; this deliberately does not hide broad HTTP, network, or Stripe
 * failures that can otherwise mask a regression.
 */
export function attachBrowserErrorCollectors(page: Page): BrowserErrorCollector {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const scopes: ActiveScope[] = [];

  const isExpectedConsole = (message: ConsoleMessage) => {
    const text = message.text();
    const url = message.location().url;
    const embeddedUrls = (text.match(/https?:\/\/[^\s"')\]]+/gu) ?? []).map((value) =>
      value.replace(/[.,;:]$/u, ''),
    );
    return scopes.some(
      (scope) =>
        !scope.closed &&
        scope.console?.some(
          (matcher) =>
            matcher.message.test(text) &&
            // Firefox reports some CORS/network failures without a console
            // location, but includes the exact resource URL in the message.
            (matcher.url.test(url) ||
              (!url && embeddedUrls.some((value) => matcher.url.test(value)))),
        ),
    );
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (BASELINE_CONSOLE_PATTERNS.some((pattern) => pattern.test(text))) return;
    if (!isExpectedConsole(message)) {
      const location = message.location();
      const source = location.url
        ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
        : '';
      consoleErrors.push(`[console.error] ${text}${source}`);
    }
  };
  const onPageError = (error: Error) => {
    pageErrors.push(error.message);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    consoleErrors,
    pageErrors,
    beginExpectedErrorScope: (scope) => {
      const active: ActiveScope = { ...scope, closed: false };
      scopes.push(active);
      return () => {
        active.closed = true;
      };
    },
    assertClean: () => {
      expect(consoleErrors, 'unexpected browser console errors').toEqual([]);
      expect(pageErrors, 'uncaught page errors').toEqual([]);
    },
    dispose: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    `horizontal overflow: ${scrollWidth}px > ${clientWidth}px`,
  ).toBeLessThanOrEqual(clientWidth + 1);
}

export async function expectElementReachable(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box, `expected ${selector} to have a bounding box`).not.toBeNull();
  expect(viewport, 'expected an emulated viewport').not.toBeNull();
  if (!box || !viewport) return;
  expect(box.y).toBeLessThan(viewport.height);
  expect(box.y + box.height).toBeGreaterThan(0);
  expect(box.x).toBeLessThan(viewport.width);
  expect(box.x + box.width).toBeGreaterThan(0);
}
