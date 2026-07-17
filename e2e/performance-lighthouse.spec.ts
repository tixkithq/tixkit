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

// Three full Lighthouse audits plus warmup navigation cannot fit within the
// repository-wide 30-second UI-test timeout on an isolated CI runner. The
// workflow retains its 45-minute outer bound and every Lighthouse budget is
// still enforced below.
test.describe.configure({ timeout: 10 * 60_000 });

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
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    expect(response?.ok(), `${report.label} warmup should load ${url}`).toBe(true);
    runLighthouse({ label: report.label, url, outputPath: report.outputPath });
  }

  execFileSync('bun', ['run', 'check:lighthouse-budgets'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/u.test(gitSha)) {
    throw new Error('Lighthouse evidence requires an exact lowercase 40-hex HEAD revision');
  }
  if (process.env.GITHUB_SHA !== undefined && process.env.GITHUB_SHA !== gitSha) {
    throw new Error('GITHUB_SHA must exactly match git rev-parse HEAD for Lighthouse evidence');
  }
  execFileSync(
    'node',
    [
      'scripts/performance-lighthouse-evidence.mjs',
      'generate',
      '--root',
      process.cwd(),
      '--config',
      'performance-budgets.lighthouse.json',
      '--output',
      'artifacts/performance/lighthouse/evidence.json',
      '--git-sha',
      gitSha,
    ],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
});
