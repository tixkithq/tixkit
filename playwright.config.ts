import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const useWalletPasses = process.env.E2E_WALLET_PASSES === '1' || isCI;
process.env.ADMIN_DASHBOARD_URL ??= adminUrl;
process.env.TIXKIT_API_URL ??= apiUrl;
process.env.CHECKOUT_URL ??= checkoutUrl;
if (useWalletPasses) process.env.E2E_WALLET_PASSES = '1';
const stripeSecretKey = useStripeProvider ? (process.env.STRIPE_SECRET_KEY ?? '') : '';
const stripeWebhookSecret = useStripeProvider ? (process.env.STRIPE_WEBHOOK_SECRET ?? '') : '';
const stripePublishableKey = useStripeProvider
  ? (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '')
  : '';
const walletPassEnv = useWalletPasses ? createWalletPassEnv(apiUrl) : {};
const localApiEnv = {
  NODE_ENV: 'development',
  PORT: apiPort,
  DATABASE_URL: '***************************************/tixkit',
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
  OTEL_SDK_DISABLED: 'true',
  QR_SIGNING_SECRET: process.env.QR_SIGNING_SECRET ?? 'ci-qr-signing-secret',
  OFFLINE_MANIFEST_SIGNING_KEY:
    process.env.OFFLINE_MANIFEST_SIGNING_KEY ?? 'ci-offline-manifest-signing-key',
  OFFLINE_MANIFEST_KEY_ID: process.env.OFFLINE_MANIFEST_KEY_ID ?? 'manifest:ci',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_BUCKET: process.env.S3_BUCKET ?? 'tixkit',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  ...walletPassEnv,
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
  DATABASE_URL: '***************************************/tixkit',
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  TEMPORAL_TASK_QUEUE: temporalTaskQueue,
  STRIPE_SECRET_KEY: stripeSecretKey,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: stripePublishableKey,
  OTEL_SDK_DISABLED: 'true',
  ...walletPassEnv,
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
          reuseExistingServer: !isCI && !useWalletPasses,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command:
            'bun run --filter @tixkit/workflows build && bun run --filter @tixkit/workflows start',
          env: localWorkerEnv,
          timeout: 120_000,
          reuseExistingServer: !isCI && !useWalletPasses,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: `bun run --filter @tixkit/checkout build && bun run --filter @tixkit/checkout start -- -p ${checkoutPort}`,
          env: checkoutPublicEnv,
          url: checkoutUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: `bun run --filter @tixkit/admin-dashboard build && bun run --filter @tixkit/admin-dashboard start -- -p ${adminPort}`,
          env: adminPublicEnv,
          url: adminUrl,
          timeout: 120_000,
          reuseExistingServer: !isCI,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ]
    : undefined,
});
