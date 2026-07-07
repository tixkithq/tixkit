import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, expect, test, type TestInfo } from '@playwright/test';
import { adminBaseUrl, checkoutBaseUrl } from './helpers/env';
import { seedFreeCheckoutEvent } from './helpers/seed';

const lighthouseReports = [
  {
    label: 'checkout flow Lighthouse',
    outputPath: 'artifacts/performance/lighthouse/checkout-flow.json',
    url: (eventId: string) => `${checkoutBaseUrl}/checkout?eventId=${encodeURIComponent(eventId)}`,
  },
  {
    label: 'hosted event page Lighthouse',
    outputPath: 'artifacts/performance/lighthouse/hosted-event-page.json',
    url: (eventId: string) => `${checkoutBaseUrl}/e/${encodeURIComponent(eventId)}`,
  },
  {
    label: 'admin shell Lighthouse',
    outputPath: 'artifacts/performance/lighthouse/admin-shell.json',
    url: () => `${adminBaseUrl}/dashboard`,
  },
] as const;

test.skip(
  process.env.RUN_LIGHTHOUSE_BUDGETS !== '1',
  'Lighthouse budgets are generated only when RUN_LIGHTHOUSE_BUDGETS=1',
);

function uniqueSuffix(testInfo: TestInfo): string {
  return `lh-${Date.now()}-${testInfo.workerIndex}-${testInfo.retry}`;
}

function runLighthouse(input: { label: string; url: string; outputPath: string }): void {
  const outputPath = resolve(process.cwd(), input.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });

  execFileSync(
    'bunx',
    [
      'lighthouse@12.8.2',
      input.url,
      '--quiet',
      '--preset=desktop',
      '--only-categories=performance',
      '--output=json',
      `--output-path=${outputPath}`,
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHROME_PATH: chromium.executablePath(),
      },
      stdio: 'inherit',
    },
  );
}

test('generates Lighthouse reports and enforces performance budgets', async ({
  page,
  request,
}, testInfo) => {
  const seeded = await seedFreeCheckoutEvent(request, uniqueSuffix(testInfo));

  for (const report of lighthouseReports) {
    const url = report.url(seeded.event.id);
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    expect(response?.ok(), `${report.label} warmup should load ${url}`).toBe(true);
    runLighthouse({ label: report.label, url, outputPath: report.outputPath });
  }

  execFileSync('bun', ['run', 'check:lighthouse-budgets'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
});
