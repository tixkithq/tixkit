import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEnvFile, formatValidationResult, ENV_RULES } from '../setup-check.js';

function makeCompleteEnv(extra: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '4000',
    LOG_LEVEL: 'debug',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    OTEL_SDK_DISABLED: 'false',
    API_BASE_URL: 'http://localhost:4000',
    NEXT_PUBLIC_TIXKIT_API_BASE_URL: 'http://localhost:4000/v1',
    NEXT_PUBLIC_ADMIN_API_BASE_URL: 'http://localhost:4000',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:3001',
    TRUST_PROXY: 'false',
    DATABASE_URL: 'postgres://tixkit:tixkit@localhost:5432/tixkit',
    DATABASE_URL_MYSQL: 'mysql://tixkit:tixkit@localhost:3306/tixkit',
    REDIS_URL: 'redis://localhost:6379',
    QR_SIGNING_SECRET: 'qr-local-secret',
    OFFLINE_MANIFEST_SIGNING_KEY: 'offline-local-key',
    OFFLINE_MANIFEST_KEY_ID: 'manifest:v1',
    WIDGET_IMPRESSION_HASH_SECRET: 'widget-hash-local-secret',
    DASHBOARD_CURSOR_SIGNING_KEY: 'local-dashboard-cursor-signing-key',
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    CLERK_SECRET_KEY: '',
    CLERK_PUBLISHABLE_KEY: '',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '',
    CLERK_WEBHOOK_SECRET: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '',
    EMAIL_WEBHOOK_SECRET: '',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'tixkit',
    S3_ACCESS_KEY_ID: 'minioadmin',
    S3_SECRET_ACCESS_KEY: 'minioadmin',
    S3_REGION: 'us-east-1',
  };
  return Object.entries({ ...base, ...extra })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

async function writeEnvFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tixkit-cli-test-'));
  const path = join(dir, '.env.test');
  await writeFile(path, content, 'utf-8');
  return path;
}

describe('validateEnvFile', () => {
  it('passes for a complete local env file', async () => {
    const path = await writeEnvFile(makeCompleteEnv());
    const result = await validateEnvFile(path, 'local');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('local');
    expect(result.issues).toHaveLength(0);
    expect(formatValidationResult(result)).toContain('setup:check passed');
  });

  it('detects missing required variables in a stripped env file', async () => {
    const path = await writeEnvFile('NODE_ENV=development\nPORT=4000');
    const result = await validateEnvFile(path, 'local');
    expect(result.ok).toBe(false);
    const missingVariables = result.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.variable);
    expect(missingVariables).toContain('DATABASE_URL');
    expect(missingVariables).toContain('REDIS_URL');
    expect(missingVariables).toContain('TEMPORAL_ADDRESS');
    expect(missingVariables).toContain('S3_BUCKET');
  });

  it('reports provider-mode errors when Stripe keys are present but incomplete', async () => {
    const path = await writeEnvFile(
      makeCompleteEnv({
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: '',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: '',
      }),
    );
    const result = await validateEnvFile(path, 'provider');
    expect(result.ok).toBe(false);
    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toContain('STRIPE_WEBHOOK_SECRET');
    expect(variables).toContain('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
  });

  it('requires signing secrets in production mode', async () => {
    const path = await writeEnvFile(
      makeCompleteEnv({
        NODE_ENV: 'production',
        QR_SIGNING_SECRET: '',
        OFFLINE_MANIFEST_SIGNING_KEY: '',
        WIDGET_IMPRESSION_HASH_SECRET: '',
        EMAIL_WEBHOOK_SECRET: '',
      }),
    );
    const result = await validateEnvFile(path, 'production');
    expect(result.ok).toBe(false);
    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toContain('QR_SIGNING_SECRET');
    expect(variables).toContain('OFFLINE_MANIFEST_SIGNING_KEY');
    expect(variables).toContain('WIDGET_IMPRESSION_HASH_SECRET');
    expect(variables).toContain('EMAIL_WEBHOOK_SECRET');
  });

  it('auto-detects provider mode when a real provider key is present', async () => {
    const path = await writeEnvFile(
      makeCompleteEnv({
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
      }),
    );
    const result = await validateEnvFile(path);
    expect(result.mode).toBe('provider');
  });

  it('detects malformed connection strings', async () => {
    const path = await writeEnvFile(
      makeCompleteEnv({
        DATABASE_URL: 'not-a-url',
        DATABASE_URL_MYSQL: 'also-not-a-url',
      }),
    );
    const result = await validateEnvFile(path, 'local');
    expect(result.ok).toBe(false);
    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toContain('DATABASE_URL');
    expect(variables).toContain('DATABASE_URL_MYSQL');
  });

  it('fails closed for incomplete provider incident evidence and accepts a bounded keyring', async () => {
    const incompletePath = await writeEnvFile(
      makeCompleteEnv({ PROVIDER_INCIDENT_SINK_ENABLED: 'true' }),
    );
    const incomplete = await validateEnvFile(incompletePath, 'local');
    expect(incomplete.ok).toBe(false);
    expect(incomplete.issues.map((issue) => issue.variable)).toContain(
      'PROVIDER_INCIDENT_KEYRING_JSON',
    );

    const completePath = await writeEnvFile(
      makeCompleteEnv({
        PROVIDER_INCIDENT_SINK_ENABLED: 'true',
        PROVIDER_INCIDENT_CAPTURE_UNTIL: new Date(Date.now() + 60_000).toISOString(),
        PROVIDER_INCIDENT_RETENTION_MINUTES: '60',
        PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT: '100',
        PROVIDER_INCIDENT_ACTIVE_KEY_ID: 'incident-test',
        PROVIDER_INCIDENT_KEYRING_JSON: JSON.stringify({
          'incident-test': Buffer.alloc(32, 3).toString('base64'),
        }),
      }),
    );
    await expect(validateEnvFile(completePath, 'local')).resolves.toMatchObject({ ok: true });
  });

  it('rejects a malformed retained provider incident key even when the active key is valid', async () => {
    const path = await writeEnvFile(
      makeCompleteEnv({
        PROVIDER_INCIDENT_SINK_ENABLED: 'true',
        PROVIDER_INCIDENT_CAPTURE_UNTIL: new Date(Date.now() + 60_000).toISOString(),
        PROVIDER_INCIDENT_RETENTION_MINUTES: '60',
        PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT: '100',
        PROVIDER_INCIDENT_ACTIVE_KEY_ID: 'incident-current',
        PROVIDER_INCIDENT_KEYRING_JSON: JSON.stringify({
          'incident-current': Buffer.alloc(32, 3).toString('base64'),
          'incident-retained': Buffer.alloc(31, 4).toString('base64'),
        }),
      }),
    );

    const result = await validateEnvFile(path, 'local');
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variable: 'PROVIDER_INCIDENT_KEYRING_JSON', severity: 'error' }),
      ]),
    );
  });

  it('every rule has a message and a known required-for list', () => {
    for (const rule of ENV_RULES) {
      expect(rule.variable).toBeTruthy();
      expect(rule.message).toBeTruthy();
      expect(Array.isArray(rule.requiredFor)).toBe(true);
      for (const mode of rule.requiredFor) {
        expect(['local', 'provider', 'production']).toContain(mode);
      }
      if (rule.guide) {
        expect(rule.guide).toMatch(/^docs\/public\/.+\.mdx$/);
      }
    }
  });
});
