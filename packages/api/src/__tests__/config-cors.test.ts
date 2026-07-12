import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorsOriginValidator } from '../app.js';
import { loadConfig, parseTrustProxy, resolveCorsAllowedOrigins } from '../config/index.js';

const ENV_KEYS = [
  'API_BASE_URL',
  'API_COMPRESSION_THRESHOLD_BYTES',
  'AUTH_PROVIDER',
  'CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SECRET',
  'CORS_ALLOWED_ORIGINS',
  'CUSTOM_DOMAIN_CORS_ENABLED',
  'DATABASE_URL',
  'DATABASE_URL_MYSQL',
  'DB_DRIVER',
  'METRICS_BEARER_TOKEN',
  'NODE_ENV',
  'OIDC_AUDIENCE',
  'OIDC_ISSUER_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_SDK_DISABLED',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_TIME_WINDOW',
  'REDIS_URL',
  'S3_ACCESS_KEY_ID',
  'S3_AUTH_MODE',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_SECRET_ACCESS_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_TASK_QUEUE',
  'TRUST_PROXY',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function setValidProductionConfig(): void {
  process.env.NODE_ENV = 'production';
  process.env.API_BASE_URL = 'https://api.example.com';
  process.env.AUTH_PROVIDER = 'clerk';
  process.env.CLERK_PUBLISHABLE_KEY = 'pk_live_example';
  process.env.CLERK_SECRET_KEY = 'sk_live_example';
  process.env.CLERK_WEBHOOK_SECRET = 'whsec_clerk_example';
  process.env.CORS_ALLOWED_ORIGINS = 'https://admin.example.com,https://checkout.example.com';
  process.env.DATABASE_URL = 'postgres://tixkit:secret@db.example.com:5432/tixkit';
  process.env.METRICS_BEARER_TOKEN = 'metrics-token';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
  process.env.REDIS_URL = 'rediss://redis.example.com:6379';
  process.env.S3_ACCESS_KEY_ID = 's3-production-key';
  process.env.S3_BUCKET = 'tixkit-production';
  process.env.S3_ENDPOINT = 'https://s3.example.com';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_SECRET_ACCESS_KEY = 's3-production-secret';
  process.env.STRIPE_SECRET_KEY = 'sk_live_stripe_example';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stripe_example';
  process.env.TEMPORAL_ADDRESS = 'temporal.example.com:7233';
  process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
  process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';
  process.env.TRUST_PROXY = '1';
}

describe('API CORS configuration', () => {
  it('allows configured credentialed origins and rejects attacker origins', async () => {
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: createCorsOriginValidator(['https://admin.example.com']),
      credentials: true,
    });
    app.get('/probe', async () => ({ ok: true }));

    const allowed = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://admin.example.com' },
    });
    const attacker = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://attacker.example' },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://admin.example.com');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(attacker.statusCode).toBe(200);
    expect(attacker.headers['access-control-allow-origin']).toBeUndefined();
    expect(attacker.headers['access-control-allow-credentials']).toBeUndefined();

    await app.close();
  });

  it('handles credentialed local browser preflights when local origins are configured', async () => {
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: createCorsOriginValidator(resolveCorsAllowedOrigins(undefined, 'development')),
      credentials: true,
    });
    app.get('/v1/events', async () => ({ items: [] }));

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/events',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');

    await app.close();
  });

  it('allows verified active custom checkout domains when dynamic domain CORS is enabled', async () => {
    const verifiedHosts: string[] = [];
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: createCorsOriginValidator(['https://admin.example.com'], {
        customDomainCorsEnabled: true,
        isVerifiedCustomDomainHost: async (host) => {
          verifiedHosts.push(host);
          return host === 'tickets.customer.example';
        },
      }),
      credentials: true,
    });
    app.get('/probe', async () => ({ ok: true }));

    const verified = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://tickets.customer.example' },
    });
    const attacker = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://attacker.customer.example' },
    });
    const insecure = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'http://tickets.customer.example' },
    });
    const portScoped = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://tickets.customer.example:8443' },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.headers['access-control-allow-origin']).toBe(
      'https://tickets.customer.example',
    );
    expect(verified.headers['access-control-allow-credentials']).toBe('true');
    expect(attacker.headers['access-control-allow-origin']).toBeUndefined();
    expect(insecure.headers['access-control-allow-origin']).toBeUndefined();
    expect(portScoped.headers['access-control-allow-origin']).toBeUndefined();
    expect(verifiedHosts).toEqual(['tickets.customer.example', 'attacker.customer.example']);

    await app.close();
  });

  it('keeps custom checkout domains disabled until explicitly enabled', async () => {
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: createCorsOriginValidator(['https://admin.example.com'], {
        customDomainCorsEnabled: false,
        isVerifiedCustomDomainHost: async () => true,
      }),
      credentials: true,
    });
    app.get('/probe', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { origin: 'https://tickets.customer.example' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });
});

describe('API exposure config parsing', () => {
  it('parses CORS_ALLOWED_ORIGINS, METRICS_BEARER_TOKEN, and TRUST_PROXY', () => {
    process.env.CORS_ALLOWED_ORIGINS =
      ' https://checkout.example.com,https://admin.example.com,,https://widget.example.com ';
    process.env.METRICS_BEARER_TOKEN = ' metrics-token ';
    process.env.TRUST_PROXY = '10.0.0.0/8,192.168.0.0/16';

    const config = loadConfig();

    expect(config.corsAllowedOrigins).toEqual([
      'https://checkout.example.com',
      'https://admin.example.com',
      'https://widget.example.com',
    ]);
    expect(config.metricsBearerToken).toBe('metrics-token');
    expect(config.trustProxy).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
    expect(config.customDomainCorsEnabled).toBe(false);
  });

  it('parses CUSTOM_DOMAIN_CORS_ENABLED strictly', () => {
    process.env.CUSTOM_DOMAIN_CORS_ENABLED = 'true';
    expect(loadConfig().customDomainCorsEnabled).toBe(true);

    process.env.CUSTOM_DOMAIN_CORS_ENABLED = 'false';
    expect(loadConfig().customDomainCorsEnabled).toBe(false);

    process.env.CUSTOM_DOMAIN_CORS_ENABLED = '1';
    expect(() => loadConfig()).toThrow('CUSTOM_DOMAIN_CORS_ENABLED must be true or false');
  });

  it('parses TRUST_PROXY booleans, hop counts, and single proxy CIDRs', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('192.168.0.10')).toBe('192.168.0.10');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy('2001:db8::/32')).toBe('2001:db8::/32');
    expect(parseTrustProxy(undefined)).toBe(false);
  });

  it('rejects malformed TRUST_PROXY values', () => {
    for (const value of [
      '0',
      '-1',
      '1.5',
      '01',
      'truee',
      '10.0.0.999',
      '10.0.0.0/99',
      '10.0.0.0/not-a-prefix',
      '10.0.0.0/8,not-a-proxy',
      ',',
    ]) {
      process.env.TRUST_PROXY = value;

      expect(() => loadConfig(), value).toThrow(
        'TRUST_PROXY must be false, true, a positive hop count, or an explicit proxy IP/CIDR list',
      );
    }
  });

  it('rejects TRUST_PROXY=true in production', () => {
    setValidProductionConfig();
    process.env.TRUST_PROXY = 'true';

    expect(() => loadConfig()).toThrow(
      'TRUST_PROXY=true is not allowed in production. Set TRUST_PROXY to a numeric hop count or an explicit proxy CIDR/list.',
    );
  });

  it('accepts bounded TRUST_PROXY values in production', () => {
    setValidProductionConfig();

    process.env.TRUST_PROXY = '1';
    expect(loadConfig().trustProxy).toBe(1);

    process.env.TRUST_PROXY = '10.0.0.0/8';
    expect(loadConfig().trustProxy).toBe('10.0.0.0/8');

    process.env.TRUST_PROXY = '10.0.0.0/8,192.168.0.0/16';
    expect(loadConfig().trustProxy).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('selects the MySQL connection URL for the MySQL production driver', () => {
    setValidProductionConfig();
    process.env.DB_DRIVER = 'mysql';
    process.env.DATABASE_URL_MYSQL = 'mysql://tixkit:secret@mysql.example.com:3306/tixkit';

    expect(loadConfig().databaseUrl).toBe('mysql://tixkit:secret@mysql.example.com:3306/tixkit');
  });

  it('rejects a MySQL production driver without its MySQL URL', () => {
    setValidProductionConfig();
    process.env.DB_DRIVER = 'mysql';
    delete process.env.DATABASE_URL_MYSQL;

    expect(() => loadConfig()).toThrow('Production config requires DATABASE_URL_MYSQL');
  });

  it('allows production object storage workload identity without static keys or an endpoint', () => {
    setValidProductionConfig();
    process.env.S3_AUTH_MODE = 'workload-identity';
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ENDPOINT;

    const config = loadConfig();
    expect(config.s3Endpoint).toBe('');
    expect(config.s3AccessKeyId).toBe('');
    expect(config.s3SecretAccessKey).toBe('');
  });

  it('requires an HTTPS OTLP collector whenever production telemetry is enabled', () => {
    setValidProductionConfig();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(() => loadConfig()).toThrow('Production config requires OTEL_EXPORTER_OTLP_ENDPOINT');

    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.example.com';
    expect(() => loadConfig()).toThrow(
      'effective OTLP traces endpoint must be an absolute HTTPS URL in production',
    );
  });

  it('validates the effective traces-specific OTLP override', () => {
    setValidProductionConfig();
    for (const value of ['http://otel.example.com/v1/traces', 'not-a-url']) {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = value;
      expect(() => loadConfig(), value).toThrow(
        'effective OTLP traces endpoint must be an absolute HTTPS URL in production',
      );
    }
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://traces.example.com/v1/traces';
    expect(loadConfig().nodeEnv).toBe('production');
  });

  it('rejects missing production Temporal config', () => {
    setValidProductionConfig();
    delete process.env.TEMPORAL_ADDRESS;
    delete process.env.TEMPORAL_NAMESPACE;
    delete process.env.TEMPORAL_TASK_QUEUE;

    expect(() => loadConfig()).toThrow(
      'Production Temporal config requires TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE',
    );
  });

  it('rejects localhost Temporal addresses in production', () => {
    setValidProductionConfig();

    for (const address of ['localhost:7233', '127.0.0.1:7233', '[::1]:7233']) {
      process.env.TEMPORAL_ADDRESS = address;

      expect(() => loadConfig(), address).toThrow(
        'TEMPORAL_ADDRESS must not point to localhost in production. Set it to the managed Temporal endpoint.',
      );
    }
  });

  it('accepts TRUST_PROXY=true outside production', () => {
    process.env.TRUST_PROXY = 'true';

    process.env.NODE_ENV = 'development';
    expect(loadConfig().trustProxy).toBe(true);

    process.env.NODE_ENV = 'test';
    expect(loadConfig().trustProxy).toBe(true);
  });

  it('rejects malformed RATE_LIMIT_MAX values', () => {
    for (const value of ['abc', '100abc', '0', '-1', '1.5', '', '9007199254740992']) {
      process.env.RATE_LIMIT_MAX = value;

      expect(() => loadConfig(), value).toThrow('RATE_LIMIT_MAX must be a positive integer');
    }
  });

  it('parses RATE_LIMIT_MAX strictly with environment defaults', () => {
    process.env.RATE_LIMIT_MAX = '250';
    expect(loadConfig().rateLimitMax).toBe(250);

    delete process.env.RATE_LIMIT_MAX;
    process.env.NODE_ENV = 'development';
    expect(loadConfig().rateLimitMax).toBe(1000);

    setValidProductionConfig();
    delete process.env.RATE_LIMIT_MAX;
    expect(loadConfig().rateLimitMax).toBe(100);
  });

  it('rejects malformed RATE_LIMIT_TIME_WINDOW values', () => {
    for (const value of ['abc', '0', '-1', '1.5 seconds', '', '9007199254740992 minutes']) {
      process.env.RATE_LIMIT_TIME_WINDOW = value;

      expect(() => loadConfig(), value).toThrow(
        'RATE_LIMIT_TIME_WINDOW must be a positive duration such as "1 minute", "30 seconds", or "100 ms"',
      );
    }
  });

  it('parses RATE_LIMIT_TIME_WINDOW strictly with normalized duration units', () => {
    process.env.RATE_LIMIT_TIME_WINDOW = '30 seconds';
    expect(loadConfig().rateLimitTimeWindow).toBe('30 seconds');

    process.env.RATE_LIMIT_TIME_WINDOW = '100ms';
    expect(loadConfig().rateLimitTimeWindow).toBe('100 milliseconds');

    process.env.RATE_LIMIT_TIME_WINDOW = '1h';
    expect(loadConfig().rateLimitTimeWindow).toBe('1 hour');

    delete process.env.RATE_LIMIT_TIME_WINDOW;
    expect(loadConfig().rateLimitTimeWindow).toBe('1 minute');
  });

  it('keeps parsed RATE_LIMIT_TIME_WINDOW compatible with Fastify rate limits', async () => {
    process.env.RATE_LIMIT_TIME_WINDOW = '100 milliseconds';
    const app = Fastify({ logger: false });
    await app.register(cors, {
      origin: createCorsOriginValidator(resolveCorsAllowedOrigins(undefined, 'development')),
      credentials: true,
    });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: loadConfig().rateLimitTimeWindow,
    });
    app.get('/limited', async () => ({ ok: true }));

    const first = await app.inject({ method: 'GET', url: '/limited' });
    const second = await app.inject({ method: 'GET', url: '/limited' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });

  it('defaults local CORS origins in development but not production resolver output', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'development';

    expect(loadConfig().corsAllowedOrigins).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
    ]);

    expect(resolveCorsAllowedOrigins(undefined, 'production')).toEqual([]);
  });

  it('rejects missing required production service configuration before defaults are applied', () => {
    setValidProductionConfig();

    for (const key of [
      'DATABASE_URL',
      'REDIS_URL',
      'METRICS_BEARER_TOKEN',
      'API_BASE_URL',
      'CORS_ALLOWED_ORIGINS',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_REGION',
      'CLERK_SECRET_KEY',
      'CLERK_PUBLISHABLE_KEY',
      'CLERK_WEBHOOK_SECRET',
    ] as const) {
      setValidProductionConfig();
      delete process.env[key];

      expect(() => loadConfig(), key).toThrow(`Production config requires ${key}`);
    }
  });

  it('rejects local production endpoints and default MinIO credentials', () => {
    setValidProductionConfig();

    for (const [key, value, message] of [
      ['DATABASE_URL', 'postgres://tixkit:tixkit@localhost:5432/tixkit', 'DATABASE_URL'],
      ['REDIS_URL', 'redis://127.0.0.1:6379', 'REDIS_URL'],
      ['API_BASE_URL', 'http://localhost:4000', 'API_BASE_URL'],
      ['S3_ENDPOINT', 'http://localhost:9000', 'S3_ENDPOINT'],
      ['S3_ACCESS_KEY_ID', 'minioadmin', 'local default credentials for S3_ACCESS_KEY_ID'],
      ['S3_SECRET_ACCESS_KEY', 'minioadmin', 'local default credentials for S3_SECRET_ACCESS_KEY'],
    ] as const) {
      setValidProductionConfig();
      process.env[key] = value;

      expect(() => loadConfig(), key).toThrow(message);
    }
  });

  it('rejects dev auth and requires OIDC settings when OIDC is selected in production', () => {
    setValidProductionConfig();
    process.env.AUTH_PROVIDER = 'dev';
    expect(() => loadConfig()).toThrow('AUTH_PROVIDER=dev is not allowed in production.');

    setValidProductionConfig();
    process.env.AUTH_PROVIDER = 'oidc';
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_AUDIENCE;
    expect(() => loadConfig()).toThrow('Production config requires OIDC_ISSUER_URL, OIDC_AUDIENCE');

    setValidProductionConfig();
    process.env.AUTH_PROVIDER = 'oidc';
    process.env.OIDC_ISSUER_URL = 'https://issuer.example.com';
    process.env.OIDC_AUDIENCE = 'tixkit-admin';
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_WEBHOOK_SECRET;

    expect(loadConfig()).toMatchObject({
      authProvider: 'oidc',
      oidcIssuerUrl: 'https://issuer.example.com',
      oidcAudience: 'tixkit-admin',
    });
  });
});
