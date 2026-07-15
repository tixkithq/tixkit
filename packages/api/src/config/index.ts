import { isIP } from 'node:net';

import type { FastifyServerOptions } from 'fastify';

export type TrustProxyConfig = NonNullable<FastifyServerOptions['trustProxy']>;

export type AppConfig = {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  databaseUrlMysql?: string;
  redisUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  authProvider: 'clerk' | 'dev' | 'oidc';
  clerkSecretKey: string;
  clerkPublishableKey: string;
  clerkWebhookSecret: string;
  oidcIssuerUrl: string;
  oidcAudience: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Region: string;
  apiBaseUrl: string;
  corsAllowedOrigins: string[];
  customDomainCorsEnabled: boolean;
  metricsBearerToken: string;
  dashboardCursorSigningKey: string;
  rateLimitMax: number;
  rateLimitTimeWindow: string;
  compressionThresholdBytes: number;
  trustProxy: TrustProxyConfig;
};

function databaseUrl(): string {
  return process.env.DB_DRIVER === 'mysql'
    ? (process.env.DATABASE_URL_MYSQL ?? '')
    : (process.env.DATABASE_URL ?? '');
}

export function parseCommaSeparatedList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function defaultCorsAllowedOrigins(nodeEnv: string): string[] {
  if (nodeEnv === 'production') return [];

  return [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ];
}

export function resolveCorsAllowedOrigins(value: string | undefined, nodeEnv: string): string[] {
  const configured = parseCommaSeparatedList(value);
  return configured.length > 0 ? configured : defaultCorsAllowedOrigins(nodeEnv);
}

function envValue(name: string): string | undefined {
  return process.env[name]?.trim();
}

function requireEnvValues(names: readonly string[]): string[] {
  return names.filter((name) => !envValue(name));
}

function hostnameFromUrlLike(value: string): string {
  const candidate = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  const endpoint = candidate.toLowerCase().split('/')[0];
  return endpoint.startsWith('[') && endpoint.includes(']')
    ? endpoint.slice(1, endpoint.indexOf(']'))
    : (endpoint.split(':')[0] ?? '');
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.')
  );
}

function isLocalEndpoint(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return isLocalHostname(hostnameFromUrlLike(value));
}

function isLocalTemporalAddress(value: string): boolean {
  return isLocalEndpoint(value);
}

function requireProductionTemporalConfig(): void {
  const missing = requireEnvValues([
    'TEMPORAL_ADDRESS',
    'TEMPORAL_NAMESPACE',
    'TEMPORAL_TASK_QUEUE',
  ]);

  if (missing.length > 0) {
    throw new Error(`Production Temporal config requires ${missing.join(', ')}`);
  }

  if (isLocalTemporalAddress(process.env.TEMPORAL_ADDRESS ?? '')) {
    throw new Error(
      'TEMPORAL_ADDRESS must not point to localhost in production. Set it to the managed Temporal endpoint.',
    );
  }
}

function requireHttpsEndpoint(name: string, value: string | undefined): void {
  try {
    if (new URL(value ?? '').protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL in production`);
  }
}

function requireProductionConfig(nodeEnv: string, trustProxy: TrustProxyConfig): void {
  if (nodeEnv !== 'production') return;

  if (trustProxy === true) {
    throw new Error(
      'TRUST_PROXY=true is not allowed in production. Set TRUST_PROXY to a numeric hop count or an explicit proxy CIDR/list.',
    );
  }

  requireProductionTemporalConfig();

  const authProvider = parseAuthProvider(process.env.AUTH_PROVIDER, nodeEnv);
  if (authProvider === 'dev') {
    throw new Error('AUTH_PROVIDER=dev is not allowed in production.');
  }

  const requiredDatabaseVariable =
    process.env.DB_DRIVER === 'mysql' ? 'DATABASE_URL_MYSQL' : 'DATABASE_URL';
  const required = [
    requiredDatabaseVariable,
    'REDIS_URL',
    'METRICS_BEARER_TOKEN',
    'DASHBOARD_CURSOR_SIGNING_KEY',
    'API_BASE_URL',
    'CORS_ALLOWED_ORIGINS',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'S3_BUCKET',
    'S3_REGION',
    ...(process.env.OTEL_SDK_DISABLED === 'true' ? [] : ['OTEL_EXPORTER_OTLP_ENDPOINT']),
    ...(process.env.S3_AUTH_MODE === 'workload-identity'
      ? []
      : ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']),
    ...(authProvider === 'clerk'
      ? ['CLERK_SECRET_KEY', 'CLERK_PUBLISHABLE_KEY', 'CLERK_WEBHOOK_SECRET']
      : ['OIDC_ISSUER_URL', 'OIDC_AUDIENCE']),
  ];
  const missing = requireEnvValues(required);
  if (missing.length > 0) {
    throw new Error(`Production config requires ${missing.join(', ')}`);
  }
  if ((process.env.DASHBOARD_CURSOR_SIGNING_KEY?.length ?? 0) < 32) {
    throw new Error('DASHBOARD_CURSOR_SIGNING_KEY must contain at least 32 characters');
  }
  if (process.env.OTEL_SDK_DISABLED !== 'true') {
    requireHttpsEndpoint(
      'effective OTLP traces endpoint',
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    );
  }

  const localEndpoints = [
    [requiredDatabaseVariable, databaseUrl()],
    ['REDIS_URL', process.env.REDIS_URL],
    ['API_BASE_URL', process.env.API_BASE_URL],
    ['S3_ENDPOINT', process.env.S3_ENDPOINT],
    ['S3_PUBLIC_ENDPOINT', process.env.S3_PUBLIC_ENDPOINT],
  ]
    .filter(([, value]) => isLocalEndpoint(value))
    .map(([name]) => name);
  if (localEndpoints.length > 0) {
    throw new Error(
      `Production config must not point to localhost for ${localEndpoints.join(', ')}`,
    );
  }

  const defaultSecrets = [
    ['S3_ACCESS_KEY_ID', process.env.S3_ACCESS_KEY_ID],
    ['S3_SECRET_ACCESS_KEY', process.env.S3_SECRET_ACCESS_KEY],
  ]
    .filter(([, value]) => value?.trim() === 'minioadmin')
    .map(([name]) => name);
  if (defaultSecrets.length > 0) {
    throw new Error(
      `Production config must not use local default credentials for ${defaultSecrets.join(', ')}`,
    );
  }
}

function isValidProxyAddressEntry(entry: string): boolean {
  const [address, prefix, extra] = entry.split('/');
  const ipVersion = isIP(address ?? '');
  if (extra !== undefined || ipVersion === 0) return false;
  if (prefix === undefined) return true;
  if (!/^(0|[1-9]\d*)$/.test(prefix)) return false;

  const prefixLength = Number(prefix);
  return prefixLength <= (ipVersion === 4 ? 32 : 128);
}

export function parseTrustProxy(value: string | undefined): TrustProxyConfig {
  const trimmed = value?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  if (/^[1-9]\d*$/.test(trimmed)) {
    const hopCount = Number(trimmed);
    if (!Number.isSafeInteger(hopCount)) {
      throw new Error(
        'TRUST_PROXY must be false, true, a positive hop count, or an explicit proxy IP/CIDR list',
      );
    }

    return hopCount;
  }

  const entries = parseCommaSeparatedList(trimmed);
  if (entries.length > 0 && entries.every(isValidProxyAddressEntry)) {
    return entries.length > 1 ? entries : entries[0];
  }

  throw new Error(
    'TRUST_PROXY must be false, true, a positive hop count, or an explicit proxy IP/CIDR list',
  );
}

function parsePositiveIntegerConfig(
  name: string,
  value: string | undefined,
  fallback: string,
): number {
  const candidate = value === undefined ? fallback : value.trim();
  if (!/^[1-9]\d*$/.test(candidate)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseBooleanConfig(name: string, value: string | undefined, fallback: boolean): boolean {
  const candidate = value?.trim().toLowerCase();
  if (!candidate) return fallback;
  if (candidate === 'true') return true;
  if (candidate === 'false') return false;

  throw new Error(`${name} must be true or false`);
}

function parseRateLimitTimeWindow(value: string | undefined, fallback: string): string {
  const candidate = value === undefined ? fallback : value.trim().toLowerCase();
  const match = /^([1-9]\d*)\s*(milliseconds?|ms|seconds?|s|minutes?|m|hours?|h|days?|d)$/.exec(
    candidate,
  );
  if (!match) {
    throw new Error(
      'RATE_LIMIT_TIME_WINDOW must be a positive duration such as "1 minute", "30 seconds", or "100 ms"',
    );
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(
      'RATE_LIMIT_TIME_WINDOW must be a positive duration such as "1 minute", "30 seconds", or "100 ms"',
    );
  }

  const unit = match[2];
  const normalizedUnit =
    unit === 'ms' || unit.startsWith('millisecond')
      ? 'millisecond'
      : unit === 's' || unit.startsWith('second')
        ? 'second'
        : unit === 'm' || unit.startsWith('minute')
          ? 'minute'
          : unit === 'h' || unit.startsWith('hour')
            ? 'hour'
            : 'day';

  return `${amount} ${normalizedUnit}${amount === 1 ? '' : 's'}`;
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

  requireProductionConfig(nodeEnv, trustProxy);

  return {
    port: parseInt(process.env.PORT ?? '4000', 10),
    nodeEnv,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    databaseUrl: databaseUrl() || 'postgres://tixkit:tixkit@localhost:5432/tixkit',
    databaseUrlMysql: process.env.DATABASE_URL_MYSQL,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    temporalTaskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit',
    authProvider: parseAuthProvider(process.env.AUTH_PROVIDER, nodeEnv),
    clerkSecretKey: process.env.CLERK_SECRET_KEY ?? '',
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
    clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET ?? '',
    oidcIssuerUrl: process.env.OIDC_ISSUER_URL ?? '',
    oidcAudience: process.env.OIDC_AUDIENCE ?? '',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    s3Endpoint:
      process.env.S3_ENDPOINT ?? (nodeEnv === 'production' ? '' : 'http://localhost:9000'),
    s3Bucket: process.env.S3_BUCKET ?? 'tixkit',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? (nodeEnv === 'production' ? '' : 'minioadmin'),
    s3SecretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ?? (nodeEnv === 'production' ? '' : 'minioadmin'),
    s3Region: process.env.S3_REGION ?? 'us-east-1',
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:4000',
    corsAllowedOrigins: resolveCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS, nodeEnv),
    customDomainCorsEnabled: parseBooleanConfig(
      'CUSTOM_DOMAIN_CORS_ENABLED',
      process.env.CUSTOM_DOMAIN_CORS_ENABLED,
      false,
    ),
    metricsBearerToken: process.env.METRICS_BEARER_TOKEN?.trim() ?? '',
    dashboardCursorSigningKey:
      process.env.DASHBOARD_CURSOR_SIGNING_KEY ?? 'tixkit-local-dashboard-cursor-signing-key',
    rateLimitMax: parsePositiveIntegerConfig(
      'RATE_LIMIT_MAX',
      process.env.RATE_LIMIT_MAX,
      nodeEnv === 'production' ? '100' : '1000',
    ),
    rateLimitTimeWindow: parseRateLimitTimeWindow(process.env.RATE_LIMIT_TIME_WINDOW, '1 minute'),
    compressionThresholdBytes: parsePositiveIntegerConfig(
      'API_COMPRESSION_THRESHOLD_BYTES',
      process.env.API_COMPRESSION_THRESHOLD_BYTES,
      '1024',
    ),
    trustProxy,
  };
}

function parseAuthProvider(value: string | undefined, nodeEnv: string): 'clerk' | 'dev' | 'oidc' {
  const provider = (value ?? (nodeEnv === 'development' ? 'dev' : 'clerk')).toLowerCase();
  if (provider === 'clerk' || provider === 'dev' || provider === 'oidc') return provider;
  throw new Error(`Unsupported AUTH_PROVIDER: ${value}`);
}

export const config = loadConfig();
