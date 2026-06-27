import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

type ValidationFixtures = {
  consoleErrors: string[];
};

const ignoredConsoleErrorFragments = (process.env.E2E_ALLOWED_CONSOLE_ERRORS ?? '')
  .split('\n')
  .map((fragment) => fragment.trim())
  .filter(Boolean);

function isIgnoredConsoleError(message: string): boolean {
  return ignoredConsoleErrorFragments.some((fragment) => message.includes(fragment));
}

async function attachConsoleErrors(testInfo: TestInfo, errors: string[]): Promise<void> {
  if (errors.length === 0) return;
  await testInfo.attach('console-errors', {
    body: errors.join('\n\n'),
    contentType: 'text/plain',
  });
}

export const test = base.extend<ValidationFixtures>({
  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];

      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const location = message.location();
        const source = location.url
          ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
          : '';
        const text = `[console.error] ${message.text()}${source}`;
        if (!isIgnoredConsoleError(text)) errors.push(text);
      });

      page.on('pageerror', (error) => {
        const text = `[pageerror] ${error.message}`;
        if (!isIgnoredConsoleError(text)) errors.push(text);
      });

      await use(errors);
      await attachConsoleErrors(testInfo, errors);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function canReach(page: Page, url: string): Promise<boolean> {
  const response = await page.request.get(url, {
    failOnStatusCode: false,
    timeout: 5_000,
  }).catch(() => null);
  return Boolean(response && response.status() < 500);
}

export async function requireReachable(page: Page, url: string, serviceName: string): Promise<void> {
  test.skip(!(await canReach(page, url)), `${serviceName} is not reachable at ${url}`);
}
