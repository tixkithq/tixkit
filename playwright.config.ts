import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Tixkit E2E and accessibility tests.
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
const apiUrl = process.env.TIXKIT_API_URL ?? 'http://localhost:4200';
const checkoutUrl = process.env.CHECKOUT_URL ?? 'http://localhost:3201';
const adminPort = new URL(adminUrl).port || '3202';
const apiPort = new URL(apiUrl).port || '4200';
const checkoutPort = new URL(checkoutUrl).port || '3201';
const temporalTaskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit-e2e';
const useStripeProvider = process.env.E2E_STRIPE_PROVIDER === '1';
process.env.ADMIN_DASHBOARD_URL ??= adminUrl;
process.env.TIXKIT_API_URL ??= apiUrl;
process.env.CHECKOUT_URL ??= checkoutUrl;
const stripeSecretKey = useStripeProvider ? (process.env.STRIPE_SECRET_KEY ?? '') : '';
const stripeWebhookSecret = useStripeProvider ? (process.env.STRIPE_WEBHOOK_SECRET ?? '') : '';
const stripePublishableKey = useStripeProvider
  ? (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '')
  : '';
const localApiEnv = {
  NODE_ENV: 'development',
  PORT: apiPort,
  DATABASE_URL: 'postgres://tixkit:tixkit@localhost:5432/tixkit',
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: temporalTaskQueue,
  CLERK_SECRET_KEY: '',
  CLERK_PUBLISHABLE_KEY: '',
  CLERK_WEBHOOK_SECRET: '',
  STRIPE_SECRET_KEY: stripeSecretKey,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
  CORS_ALLOWED_ORIGINS: [
    checkoutUrl,
    adminUrl,
    'http://localhost:3000',
    'http://localhost:3001',
  ].join(','),
  RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_TIME_WINDOW: '1 minute',
};
const localWorkerEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://tixkit:tixkit@localhost:5432/tixkit',
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: temporalTaskQueue,
  STRIPE_SECRET_KEY: stripeSecretKey,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
};
const checkoutPublicEnv = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_TIXKIT_API_BASE_URL: `${apiUrl}/v1`,
  NEXT_PUBLIC_ADMIN_API_BASE_URL: apiUrl,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
};
const adminPublicEnv = {
  NODE_ENV: 'production',
  NEXT_PUBLIC_TIXKIT_API_BASE_URL: `${apiUrl}/v1`,
  NEXT_PUBLIC_ADMIN_API_BASE_URL: apiUrl,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
};

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
          command: 'bun run --filter @tixkit/api build && bun run --filter @tixkit/api start',
          env: localApiEnv,
          url: `${apiUrl}/health`,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command:
            'bun run --filter @tixkit/workflows build && bun run --filter @tixkit/workflows start',
          env: localWorkerEnv,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command: `bun run --filter @tixkit/checkout build && bun run --filter @tixkit/checkout start -- -p ${checkoutPort}`,
          env: checkoutPublicEnv,
          url: checkoutUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
        {
          command: `bun run --filter @tixkit/admin-dashboard build && bun run --filter @tixkit/admin-dashboard start -- -p ${adminPort}`,
          env: adminPublicEnv,
          url: adminUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
        },
      ]
    : undefined,
});
