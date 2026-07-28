import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAdminDistDir } from './scripts/playwright-clean-admin-dist.mjs';

/**
 * Playwright configuration for Tixkit E2E and accessibility tests.
 *
 * The webServer starts the admin dashboard in production mode when live Clerk
 * is enabled. The default local harness uses next dev so the dashboard can use
 * the same fail-closed local-dev auth contract as the API without weakening
 * production auth behavior.
 *
 * For development-mode E2E, set ADMIN_DASHBOARD_URL to point at a running
 * `next dev` instance and set USE_WEBSERVER=false.
 */
const isCI = !!process.env.CI;
const useWebServer = process.env.USE_WEBSERVER !== 'false';
const adminUrl = process.env.ADMIN_DASHBOARD_URL ?? 'http://localhost:3202';
const apiUrl = process.env.TIXKIT_API_URL ?? 'http://localhost:4200';
const checkoutUrl = process.env.CHECKOUT_URL ?? 'http://localhost:3201';
const workerHealthUrl = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:4299';
const adminPort = new URL(adminUrl).port || '3202';
const apiPort = new URL(apiUrl).port || '4200';
const checkoutPort = new URL(checkoutUrl).port || '3201';
const workerHealthPort = new URL(workerHealthUrl).port || '4299';
const temporalTaskQueue = process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit-e2e';
const playwrightRunId =
  process.env.PLAYWRIGHT_RUN_ID ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
const requestedAdminNextDistDir =
  process.env.ADMIN_DASHBOARD_NEXT_DIST_DIR ?? `.next/e2e-${adminPort}-${playwrightRunId}`;
const { relativePath: adminNextDistDir } = resolveAdminDistDir(requestedAdminNextDistDir);
const webServerTimeout = Number.parseInt(process.env.PLAYWRIGHT_WEB_SERVER_TIMEOUT_MS ?? '', 10);
const webServerTimeoutMs = Number.isFinite(webServerTimeout) ? webServerTimeout : 240_000;
const useStripeProvider = process.env.E2E_STRIPE_PROVIDER === '1';
const useWalletPasses = process.env.E2E_WALLET_PASSES === '1' || isCI;
const useLiveClerk = process.env.E2E_LIVE_CLERK === '1';
const reuseDefaultServer = !isCI && !useLiveClerk;
const reuseServerWithoutGeneratedEnv = reuseDefaultServer && !useWalletPasses;
const defaultDatabaseUrl = ['postgres://tixkit', ':', 'tixkit', '@localhost:5432/tixkit'].join('');
const databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;
const migrationCursorKeyId = `e2e-${playwrightRunId}`.replaceAll(/[^A-Za-z0-9_-]/gu, '_');
const migrationCursorKeys = JSON.stringify({
  [migrationCursorKeyId]: randomBytes(32).toString('base64'),
});
process.env.ADMIN_DASHBOARD_URL ??= adminUrl;
process.env.TIXKIT_API_URL ??= apiUrl;
process.env.CHECKOUT_URL ??= checkoutUrl;
if (useWalletPasses) process.env.E2E_WALLET_PASSES = '1';
const stripeSecretKey = useStripeProvider ? (process.env.STRIPE_SECRET_KEY ?? '') : '';
const stripeWebhookSecret = useStripeProvider ? (process.env.STRIPE_WEBHOOK_SECRET ?? '') : '';
const stripePublishableKey = useStripeProvider
  ? (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '')
  : '';
const clerkSecretKey = useLiveClerk ? (process.env.CLERK_SECRET_KEY ?? '') : '';
const clerkPublishableKey = useLiveClerk
  ? (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY ?? '')
  : '';
const clerkWebhookSecret = useLiveClerk ? (process.env.CLERK_WEBHOOK_SECRET ?? '') : '';
const useAdminDevServer = !useLiveClerk && process.env.E2E_ADMIN_DEV_SERVER !== '0';
const walletPassEnv = useWalletPasses ? createWalletPassEnv(apiUrl) : {};
const s3Env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_BUCKET: process.env.S3_BUCKET ?? 'tixkit',
  S3_EXPORT_BUCKET: process.env.S3_EXPORT_BUCKET ?? 'tixkit-exports',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_EXPORT_REGION: process.env.S3_EXPORT_REGION ?? process.env.S3_REGION ?? 'us-east-1',
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? 'true',
};
const localApiEnv = {
  NODE_ENV: 'development',
  API_BASE_URL: apiUrl,
  E2E_MEDIA_REPLACEMENT_BARRIER: '1',
  PORT: apiPort,
  DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: temporalTaskQueue,
  CLERK_SECRET_KEY: clerkSecretKey,
  CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
  CLERK_WEBHOOK_SECRET: clerkWebhookSecret,
  STRIPE_SECRET_KEY: stripeSecretKey,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
  PAYMENT_PROVIDER_TEST_MODE: useStripeProvider ? '1' : '',
  E2E_PAID_CAPTURE_MODE: useStripeProvider ? '' : '1',
  OTEL_SDK_DISABLED: 'true',
  QR_SIGNING_SECRET: process.env.QR_SIGNING_SECRET ?? 'ci-qr-signing-secret',
  OFFLINE_MANIFEST_SIGNING_KEY:
    process.env.OFFLINE_MANIFEST_SIGNING_KEY ?? 'ci-offline-manifest-signing-key',
  OFFLINE_MANIFEST_KEY_ID: process.env.OFFLINE_MANIFEST_KEY_ID ?? 'manifest:ci',
  OFFLINE_MANIFEST_ACTIVE_KEY_ID: process.env.OFFLINE_MANIFEST_ACTIVE_KEY_ID ?? 'manifest-v2-ci',
  OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON:
    process.env.OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON ??
    JSON.stringify([
      {
        keyId: 'manifest-v2-ci',
        privateKeyPem:
          '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguuqSuoL6HAyrMjU7\nQqbeBD0vTTJjUyVvjYCenHz2YnahRANCAATBXJgyEdtghsSJWFjGH55lEfbPnMZk\nI3FQVU+ihGu0ZWb3laTbq8k9W2H2B3BIZ+BLtbL6QRIsfcYecnFXq+W4\n-----END PRIVATE KEY-----',
        notBefore: '2020-01-01T00:00:00.000Z',
        notAfter: '2100-01-01T00:00:00.000Z',
      },
    ]),
  TIXKIT_PREVIEW_TOKEN_SECRET: process.env.TIXKIT_PREVIEW_TOKEN_SECRET ?? 'ci-preview-token-secret',
  TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID: migrationCursorKeyId,
  TIXKIT_MIGRATION_CURSOR_KEYS: migrationCursorKeys,
  PUBLIC_CHECKOUT_URL: checkoutUrl,
  CHECKOUT_PUBLIC_URL: checkoutUrl,
  ...s3Env,
  ...walletPassEnv,
  CORS_ALLOWED_ORIGINS: [
    checkoutUrl,
    adminUrl,
    'http://localhost:3000',
    'http://localhost:3001',
  ].join(','),
  RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_TIME_WINDOW: '1 minute',
  ...(useLiveClerk && clerkSecretKey ? { AUTH_PROVIDER: 'clerk' } : {}),
};
const localWorkerEnv = {
  NODE_ENV: 'development',
  E2E_PAID_CAPTURE_MODE: useStripeProvider ? '' : '1',
  DATABASE_URL: databaseUrl,
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: temporalTaskQueue,
  WORKER_HEALTH_PORT: workerHealthPort,
  STRIPE_SECRET_KEY: stripeSecretKey,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
  QR_SIGNING_SECRET: process.env.QR_SIGNING_SECRET ?? 'ci-qr-signing-secret',
  TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID: migrationCursorKeyId,
  TIXKIT_MIGRATION_CURSOR_KEYS: migrationCursorKeys,
  ...(process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE === '1'
    ? {
        E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE: '1',
        E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE_KEY:
          process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE_KEY ?? '',
      }
    : {}),
  ...s3Env,
  OTEL_SDK_DISABLED: 'true',
  ...walletPassEnv,
};
const checkoutPublicEnv = {
  NODE_ENV: 'production',
  TIXKIT_DEPLOYMENT_PROFILE: 'test',
  API_BASE_URL: apiUrl,
  INTERNAL_API_BASE_URL: apiUrl,
  TIXKIT_CHECKOUT_URL: checkoutUrl,
  S3_PUBLIC_ENDPOINT: process.env.S3_PUBLIC_ENDPOINT ?? 'http://localhost:9000',
  TIXKIT_BUILD_REVISION: `e2e-${playwrightRunId}`,
  STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
  NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS: '1',
  NEXT_PUBLIC_TIXKIT_API_BASE_URL: `${apiUrl}/v1`,
  NEXT_PUBLIC_ADMIN_API_BASE_URL: apiUrl,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
};
const adminPublicEnv = {
  NODE_ENV: useAdminDevServer ? 'development' : 'production',
  TIXKIT_DEPLOYMENT_PROFILE: useLiveClerk
    ? 'production'
    : useAdminDevServer
      ? 'development'
      : 'test',
  API_BASE_URL: apiUrl,
  INTERNAL_API_BASE_URL: apiUrl,
  TIXKIT_CHECKOUT_URL: checkoutUrl,
  S3_PUBLIC_ENDPOINT: s3Env.S3_ENDPOINT,
  TIXKIT_BUILD_REVISION: `e2e-${playwrightRunId}`,
  NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS: '1',
  NEXT_PUBLIC_TIXKIT_API_BASE_URL: `${apiUrl}/v1`,
  NEXT_PUBLIC_ADMIN_API_BASE_URL: apiUrl,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: clerkPublishableKey,
  PUBLIC_CHECKOUT_URL: checkoutUrl,
  NEXT_PUBLIC_CHECKOUT_URL: checkoutUrl,
  ...(useAdminDevServer ? { NEXT_DIST_DIR: adminNextDistDir } : {}),
  ...(!useLiveClerk ? { AUTH_PROVIDER: 'dev', NEXT_PUBLIC_AUTH_PROVIDER: 'dev' } : {}),
  ...(useLiveClerk && clerkPublishableKey ? { NEXT_PUBLIC_AUTH_PROVIDER: 'clerk' } : {}),
};

function createWalletPassEnv(apiBaseUrl: string): Record<string, string> {
  const runId = randomUUID();
  const dir = mkdtempSync(join(tmpdir(), 'tixkit-e2e-wallet-pass-'));
  const keyPath = join(dir, 'signer.key');
  const certPath = join(dir, 'signer.crt');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=Tixkit E2E Wallet Pass',
    ],
    { stdio: 'ignore' },
  );

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const googlePrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signerCert = readFileSync(certPath, 'utf8');

  return {
    API_BASE_URL: apiBaseUrl,
    APPLE_WALLET_ENABLED: 'true',
    APPLE_WALLET_PASS_TYPE_ID: `pass.test.tixkit.e2e.${runId}`,
    APPLE_WALLET_TEAM_ID: 'TEAM123456',
    APPLE_WALLET_ORGANIZATION_NAME: 'Tixkit E2E',
    APPLE_WALLET_SIGNER_CERT: signerCert,
    APPLE_WALLET_SIGNER_KEY: readFileSync(keyPath, 'utf8'),
    APPLE_WALLET_WWDR_CERT: signerCert,
    GOOGLE_WALLET_ENABLED: 'true',
    GOOGLE_WALLET_ISSUER_ID: 'issuer123',
    GOOGLE_WALLET_CLASS_SUFFIX: `tixkit_e2e_event_${runId.replaceAll('-', '_')}`,
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: `wallet-e2e-${runId}@example.iam.gserviceaccount.com`,
    GOOGLE_WALLET_PRIVATE_KEY: googlePrivateKey,
    GOOGLE_WALLET_ORIGIN: new URL(apiBaseUrl).origin,
  };
}

export default defineConfig({
  testDir: './e2e',
  tsconfig: './tsconfig.base.json',
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
    {
      name: 'mobile-chromium-event-media',
      testMatch: /event-media-journeys\.spec\.ts/u,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-webkit-event-media',
      testMatch: /event-media-journeys\.spec\.ts/u,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'mobile-chromium-buyer-event-day',
      testMatch: /(admin-checkin-workflows|checkout-paid-capture-workflow)\.spec\.ts/u,
      grep: /completes a paid order through hosted checkout UI in local capture mode|validates online scanning, duplicate detection, offline manifest, and offline sync/u,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-chromium-checkout-recovery',
      testMatch: /checkout-(cross-browser-recovery|payment-auth-navigation)\.spec\.ts/u,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-webkit-checkout-recovery',
      testMatch: /checkout-(cross-browser-recovery|payment-auth-navigation)\.spec\.ts/u,
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'mobile-chromium-checkin-recovery',
      testMatch: /checkin-cross-browser-recovery\.spec\.ts/u,
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'mobile-webkit-checkin-recovery',
      testMatch: /checkin-cross-browser-recovery\.spec\.ts/u,
      use: { ...devices['iPhone 13'] },
    },
  ],

  webServer: useWebServer
    ? [
        {
          command:
            'node scripts/playwright-ensure-s3-bucket.mjs && bun run --filter @tixkit/db migrate && bun run --filter @tixkit/api build && bun run --filter @tixkit/api start',
          env: localApiEnv,
          url: `${apiUrl}/health`,
          timeout: webServerTimeoutMs,
          reuseExistingServer: reuseServerWithoutGeneratedEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'node scripts/playwright-worker-webserver.mjs',
          env: localWorkerEnv,
          url: workerHealthUrl,
          timeout: webServerTimeoutMs,
          reuseExistingServer: reuseServerWithoutGeneratedEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: `bunx turbo run build --filter=@tixkit/checkout && bun run --filter @tixkit/checkout start -- -p ${checkoutPort}`,
          env: checkoutPublicEnv,
          url: checkoutUrl,
          timeout: webServerTimeoutMs,
          reuseExistingServer: reuseDefaultServer,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: useAdminDevServer
            ? `node scripts/playwright-clean-admin-dist.mjs && bun run --filter @tixkit/admin-dashboard dev -- -p ${adminPort}`
            : `bun run --filter @tixkit/admin-dashboard build && bun run --filter @tixkit/admin-dashboard start -- -p ${adminPort}`,
          env: adminPublicEnv,
          url: adminUrl,
          timeout: webServerTimeoutMs,
          reuseExistingServer: reuseDefaultServer,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ]
    : undefined,
});
