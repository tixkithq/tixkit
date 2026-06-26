import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for GateKit E2E and accessibility tests.
 *
 * The webServer starts the admin dashboard in production mode (next start)
 * after building it. Tests run against the built app for visual fidelity.
 *
 * For development-mode E2E, set ADMIN_DASHBOARD_URL to point at a running
 * `next dev` instance and set USE_WEBSERVER=false.
 */
const isCI = !!process.env.CI;
const useWebServer = process.env.USE_WEBSERVER !== 'false';
const adminUrl = process.env.ADMIN_DASHBOARD_URL ?? 'http://localhost:3202';
const apiUrl = process.env.GATEKIT_API_URL ?? 'http://localhost:4200';
const checkoutUrl = process.env.CHECKOUT_URL ?? 'http://localhost:3201';
const adminPort = new URL(adminUrl).port || '3202';
const apiPort = new URL(apiUrl).port || '4200';
const checkoutPort = new URL(checkoutUrl).port || '3201';
process.env.ADMIN_DASHBOARD_URL ??= adminUrl;
process.env.GATEKIT_API_URL ??= apiUrl;
process.env.CHECKOUT_URL ??= checkoutUrl;
const localApiEnv =
  `NODE_ENV=development PORT=${apiPort} DATABASE_URL=postgres://gatekit:gatekit@localhost:5432/gatekit REDIS_URL=redis://localhost:6379 TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=default CLERK_SECRET_KEY= CLERK_PUBLISHABLE_KEY= CLERK_WEBHOOK_SECRET=`;
const localWorkerEnv =
  'NODE_ENV=development DATABASE_URL=postgres://gatekit:gatekit@localhost:5432/gatekit REDIS_URL=redis://localhost:6379 TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=default';
const checkoutPublicEnv = `NODE_ENV=production NEXT_PUBLIC_GATEKIT_API_BASE_URL=${apiUrl}/v1 NEXT_PUBLIC_ADMIN_API_BASE_URL=${apiUrl}`;
const adminPublicEnv = `NODE_ENV=production NEXT_PUBLIC_GATEKIT_API_BASE_URL=${apiUrl}/v1 NEXT_PUBLIC_ADMIN_API_BASE_URL=${apiUrl} NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: adminUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: useWebServer
    ? [
        {
          command: `${localApiEnv} bun run --filter @gatekit/api build && ${localApiEnv} bun run --filter @gatekit/api start`,
          url: `${apiUrl}/health`,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command: `${localWorkerEnv} bun run --filter @gatekit/workflows build && ${localWorkerEnv} bun run --filter @gatekit/workflows start`,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command: `${checkoutPublicEnv} bun run --filter @gatekit/checkout build && ${checkoutPublicEnv} bun run --filter @gatekit/checkout start -- -p ${checkoutPort}`,
          url: checkoutUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command: `${adminPublicEnv} bun run --filter @gatekit/admin-dashboard build && ${adminPublicEnv} bun run --filter @gatekit/admin-dashboard start -- -p ${adminPort}`,
          url: adminUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
      ]
    : undefined,
});
