import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const browserErrors = new WeakMap<object, { console: string[]; page: string[] }>();

test.beforeEach(async ({ page }) => {
  const errors = { console: [] as string[], page: [] as string[] };
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
});

test.afterEach(async ({ page }) => {
  const errors = browserErrors.get(page);
  expect(errors?.console ?? [], 'browser console errors').toEqual([]);
  expect(errors?.page ?? [], 'uncaught page errors').toEqual([]);
});

test('task guide has complete navigation and no accessibility violations', async ({
  page,
}, testInfo) => {
  await page.goto('/getting-started/local-quickstart');
  await expect(page.getByRole('heading', { level: 1, name: 'Run Tixkit locally' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  if (!testInfo.project.name.startsWith('mobile-')) {
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();
  } else {
    const contents = page.locator('details.mobile-table-of-contents');
    await contents.getByText('On this page').click();
    const link = contents.getByRole('link').first();
    const href = await link.getAttribute('href');
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href?.replace('#', '#')}$`));
  }
  await expect(
    page.getByRole('navigation', { name: 'Previous and next documentation' }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('local search supports keyboard use and audience filtering', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /Search documentation/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const input = page.getByRole('searchbox', {
    name: 'Documentation search query',
  });
  await expect(input).toBeFocused();
  await page.getByLabel('Audience').selectOption('developer');
  await input.fill('webhook signature');
  await expect(page.getByRole('link', { name: /Verify webhook signatures/ }).first()).toBeVisible();
  await input.fill('android troubleshoot');
  await expect(page.getByRole('link', { name: /Android SDK/ }).first()).toHaveAttribute(
    'href',
    '/sdks/android#troubleshoot',
  );
  await page.getByRole('button', { name: 'Close search' }).click();
  await expect(page.getByRole('button', { name: /Search documentation/ })).toBeFocused();
});

test('search failure is announced and retry recovers without page errors', async ({ page }) => {
  let attempts = 0;
  await page.route('**/search-index.json', async (route) => {
    attempts += 1;
    if (attempts === 1)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{}',
      });
    else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Search documentation/ }).click();
  await expect(
    page.getByRole('dialog', { name: 'Search Tixkit documentation' }).getByRole('alert'),
  ).toContainText('Search is temporarily unavailable');
  await page.getByRole('button', { name: 'Retry search' }).click();
  const input = page.getByRole('searchbox', {
    name: 'Documentation search query',
  });
  await expect(input).toBeEnabled();
  await input.fill('webhook signature');
  await expect(page.getByRole('link', { name: /Verify webhook signatures/ }).first()).toBeVisible();
});

test('framework tabs support arrow, Home, and End keyboard navigation', async ({ page }) => {
  await page.goto('/sdks/javascript');
  const bun = page.getByRole('tab', { name: 'Bun' });
  const npm = page.getByRole('tab', { name: 'npm', exact: true });
  const pnpm = page.getByRole('tab', { name: 'pnpm' });
  await bun.focus();
  await page.keyboard.press('ArrowRight');
  await expect(npm).toBeFocused();
  await expect(npm).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(pnpm).toBeFocused();
  await page.keyboard.press('Home');
  await expect(bun).toBeFocused();
});

for (const [label, route] of [
  ['server', '/sdks/javascript'],
  ['framework', '/sdks/nextjs'],
  ['native', '/sdks/android'],
] as const) {
  test(`${label} SDK guide completes the first-request path`, async ({ page }, testInfo) => {
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 2, name: 'Install' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Configure securely' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Make the first request' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Troubleshoot' })).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Verify and continue' }),
    ).toBeVisible();
    if (!testInfo.project.name.startsWith('mobile-')) {
      await expect(
        page.getByRole('navigation', { name: 'On this page' }).getByRole('link', {
          name: 'Troubleshoot',
        }),
      ).toHaveAttribute('href', '#troubleshoot');
    }
  });
}

test('generated API reference exposes stable deep links and downloadable contract', async ({
  page,
  request,
}) => {
  await page.goto('/reference/api');
  const operation = page.locator('article.operation').first();
  await expect(operation).toBeVisible();
  const operationId = await operation.getAttribute('id');
  expect(operationId).toMatch(/^operation-/);
  const contract = await request.get('/openapi.json');
  expect(contract.ok()).toBe(true);
  expect(contract.headers()['content-type']).toContain('application/json');
  const json = await contract.json();
  expect(json.openapi).toBe('3.1.0');
  expect(Object.keys(json.paths).length).toBeGreaterThan(100);
});

test('mobile navigation remains operable without horizontal page overflow', async ({
  page,
}, testInfo) => {
  if (!testInfo.project.name.startsWith('mobile-')) return;
  await page.goto('/operators/events');
  const menu = page.locator('details.mobile-navigation');
  await menu.getByText('Menu').click();
  await expect(menu.getByRole('navigation', { name: 'Mobile documentation' })).toBeVisible();
  const current = menu.getByRole('link', { name: 'Events', exact: true });
  await expect(current).toHaveAttribute('aria-current', 'page');
  await menu.getByRole('link', { name: 'Create the first event', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Create and publish the first event',
    }),
  ).toBeVisible();
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(page.locator('main')).toBeFocused();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

for (const journey of [
  {
    persona: 'Operator',
    stages: [
      ['/operators/events', 'Operate events', 'Work in dependency order'],
      ['/getting-started/first-event', 'Create and publish the first event', 'Create the event'],
      ['/getting-started/test-checkout', 'Complete a test checkout', 'Confirm the payment mode'],
    ],
  },
  {
    persona: 'Integrator',
    stages: [
      ['/getting-started/first-api-call', 'Make the first API call', 'Create a scoped key'],
      [
        '/developers/webhooks/verify-signatures',
        'Verify webhook signatures',
        'Verify before parsing',
      ],
      ['/reference/api', 'API endpoint reference', 'Download OpenAPI JSON'],
    ],
  },
  {
    persona: 'Self-hoster',
    stages: [
      ['/self-hosting/configuration', 'Configure services and secrets', 'Validate by mode'],
      ['/self-hosting/deployment', 'Deploy Tixkit', 'Release order'],
      ['/self-hosting/observability', 'Configure observability', 'Correlate safely'],
    ],
  },
  {
    persona: 'Contributor',
    stages: [
      ['/contributing/repository-setup', 'Set up the repository', 'Work safely'],
      ['/contributing/add-documentation', 'Add documentation', 'Author a page'],
      ['/contributing/testing', 'Run validation and tests', 'bun run docs:check'],
    ],
  },
] as const) {
  for (const [stageIndex, [route, heading, task]] of journey.stages.entries()) {
    test(`${journey.persona} exposes canonical stage ${stageIndex + 1}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('.prose').getByText(task, { exact: false }).first()).toBeVisible();
      await expect(
        page.getByRole('navigation', {
          name: 'Previous and next documentation',
        }),
      ).toBeVisible();
      await expect(page.locator('article a').first()).toHaveAttribute('href', /.+/);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `${journey.persona} stage ${stageIndex + 1} violations`).toEqual(
        [],
      );
    });
  }
}

test('Operator follows the event-to-checkout-to-check-in journey', async ({ page }) => {
  await page.goto('/getting-started/first-event');
  await page.locator('.prose').getByRole('link', { name: 'Complete a test checkout' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Complete a test checkout' }),
  ).toBeVisible();
  await page.locator('.prose').getByRole('link', { name: 'check-in', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Run check-in' })).toBeVisible();
});

test('Integrator follows first request through verification and generated reference', async ({
  page,
}) => {
  await page.goto('/getting-started/first-api-call');
  await page.getByRole('link', { name: 'webhook signature verification' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Verify webhook signatures' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'generated API reference' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'API endpoint reference' }),
  ).toBeVisible();
});

test('Self-hoster follows configuration through deployment and observability', async ({ page }) => {
  await page.goto('/self-hosting/configuration');
  await page.getByRole('link', { name: 'deployment runbook' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Deploy Tixkit' })).toBeVisible();
  await page.getByRole('link', { name: 'observability configuration' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Configure observability' }),
  ).toBeVisible();
});

test('Contributor follows setup through authoring and validation', async ({ page }) => {
  await page.goto('/contributing/repository-setup');
  await page.getByRole('link', { name: 'adding documentation' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Add documentation' })).toBeVisible();
  await page.getByRole('link', { name: 'validation and test guide' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Run validation and tests' }),
  ).toBeVisible();
});
