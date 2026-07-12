import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildWorkerStartupFailureMessage } from '../startup-diagnostics.js';

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_URL_MYSQL: process.env.DATABASE_URL_MYSQL,
  DB_DRIVER: process.env.DB_DRIVER,
  NODE_ENV: process.env.NODE_ENV,
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED,
  PROMETHEUS_PUSHGATEWAY_URL: process.env.PROMETHEUS_PUSHGATEWAY_URL,
  REDIS_URL: process.env.REDIS_URL,
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
  TEMPORAL_EXPORT_TASK_QUEUE: process.env.TEMPORAL_EXPORT_TASK_QUEUE,
  TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
  TEMPORAL_PDF_TASK_QUEUE: process.env.TEMPORAL_PDF_TASK_QUEUE,
  TEMPORAL_TASK_QUEUE: process.env.TEMPORAL_TASK_QUEUE,
  TEMPORAL_WALLET_TASK_QUEUE: process.env.TEMPORAL_WALLET_TASK_QUEUE,
  TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS: process.env.TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS,
  TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS:
    process.env.TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS,
  TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS:
    process.env.TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS,
  TEMPORAL_WORKER_TASK_QUEUES: process.env.TEMPORAL_WORKER_TASK_QUEUES,
};

afterEach(() => {
  restoreEnv('DATABASE_URL', originalEnv.DATABASE_URL);
  restoreEnv('DATABASE_URL_MYSQL', originalEnv.DATABASE_URL_MYSQL);
  restoreEnv('DB_DRIVER', originalEnv.DB_DRIVER);
  restoreEnv('NODE_ENV', originalEnv.NODE_ENV);
  restoreEnv('OTEL_EXPORTER_OTLP_ENDPOINT', originalEnv.OTEL_EXPORTER_OTLP_ENDPOINT);
  restoreEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', originalEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  restoreEnv('OTEL_SDK_DISABLED', originalEnv.OTEL_SDK_DISABLED);
  restoreEnv('PROMETHEUS_PUSHGATEWAY_URL', originalEnv.PROMETHEUS_PUSHGATEWAY_URL);
  restoreEnv('REDIS_URL', originalEnv.REDIS_URL);
  restoreEnv('TEMPORAL_ADDRESS', originalEnv.TEMPORAL_ADDRESS);
  restoreEnv('TEMPORAL_EXPORT_TASK_QUEUE', originalEnv.TEMPORAL_EXPORT_TASK_QUEUE);
  restoreEnv('TEMPORAL_NAMESPACE', originalEnv.TEMPORAL_NAMESPACE);
  restoreEnv('TEMPORAL_PDF_TASK_QUEUE', originalEnv.TEMPORAL_PDF_TASK_QUEUE);
  restoreEnv('TEMPORAL_TASK_QUEUE', originalEnv.TEMPORAL_TASK_QUEUE);
  restoreEnv('TEMPORAL_WALLET_TASK_QUEUE', originalEnv.TEMPORAL_WALLET_TASK_QUEUE);
  restoreEnv(
    'TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS',
    originalEnv.TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS,
  );
  restoreEnv(
    'TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS',
    originalEnv.TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS,
  );
  restoreEnv(
    'TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS',
    originalEnv.TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS,
  );
  restoreEnv('TEMPORAL_WORKER_TASK_QUEUES', originalEnv.TEMPORAL_WORKER_TASK_QUEUES);
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function setValidProductionConfig(): void {
  process.env.DATABASE_URL = 'postgres://tixkit:secret@db.example.com:5432/tixkit';
  process.env.NODE_ENV = 'production';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
  process.env.PROMETHEUS_PUSHGATEWAY_URL = 'https://pushgateway.example.com';
  process.env.REDIS_URL = 'rediss://redis.example.com:6379';
  process.env.TEMPORAL_ADDRESS = 'temporal.example.com:7233';
  process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
  process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';
}

describe('buildWorkerStartupFailureMessage', () => {
  it('redacts database URL credentials from the original error text', () => {
    const dbUser = Buffer.from('Y2hlY2tvdXR1c2Vy', 'base64').toString('utf-8');
    const dbPass = Buffer.from('ZGItcGFzc3ZhbHVlMQ==', 'base64').toString('utf-8');
    const databaseUrl = `postgres://${dbUser}:${dbPass}@db.internal:5432/tixkit?sslmode=require`;
    process.env.DATABASE_URL = databaseUrl;

    const message = buildWorkerStartupFailureMessage(
      new Error(`failed to connect to DATABASE_URL ${databaseUrl}`),
    );

    expect(message).toContain('Tixkit worker failed to start.');
    expect(message).toContain('db.internal:5432');
    expect(message).toContain('/tixkit?sslmode=require');
    expect(message).toContain('postgres://redacted@db.internal:5432/tixkit?sslmode=require');
    expect(message).not.toContain(databaseUrl);
    expect(message).not.toContain(dbUser);
    expect(message).not.toContain(dbPass);
  });

  it('redacts Redis URL credentials from the original error text', () => {
    const redisUser = Buffer.from('ZGVmYXVsdA==', 'base64').toString('utf-8');
    const redisPass = Buffer.from('cmVkaXMtcGFzc3ZhbHVlMQ==', 'base64').toString('utf-8');
    const redisAuth = Buffer.from('cmVkaXMtYXV0aGtleTE=', 'base64').toString('utf-8');
    const redisUrl = `redis://${redisUser}:${redisPass}@redis.internal:6379/0?sig=${redisAuth}`;
    process.env.REDIS_URL = redisUrl;

    const message = buildWorkerStartupFailureMessage(
      new Error(`Redis connection failed for ${redisUrl}`),
    );

    expect(message).toContain('redis.internal:6379');
    expect(message).toContain('/0?sig=[redacted]');
    expect(message).toContain('redis://redacted@redis.internal:6379/0?sig=[redacted]');
    expect(message).not.toContain(redisUrl);
    expect(message).not.toContain(redisUser);
    expect(message).not.toContain(redisPass);
    expect(message).not.toContain(redisAuth);
  });
});

describe('worker Temporal config', () => {
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

  it('accepts explicit managed Temporal config in production', () => {
    setValidProductionConfig();

    expect(loadConfig()).toMatchObject({
      temporalAddress: 'temporal.example.com:7233',
      temporalNamespace: 'tixkit.production',
      temporalTaskQueue: 'tixkit-production',
    });
  });

  it('rejects missing production database and Redis config', () => {
    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      setValidProductionConfig();
      delete process.env[key];

      expect(() => loadConfig(), key).toThrow(`Production worker config requires ${key}`);
    }
  });

  it('requires the MySQL URL when the MySQL driver is selected', () => {
    setValidProductionConfig();
    process.env.DB_DRIVER = 'mysql';
    delete process.env.DATABASE_URL_MYSQL;

    expect(() => loadConfig()).toThrow('Production worker config requires DATABASE_URL_MYSQL');
  });

  it('requires HTTPS OTLP and Pushgateway endpoints in production', () => {
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'PROMETHEUS_PUSHGATEWAY_URL'] as const) {
      setValidProductionConfig();
      delete process.env[key];
      expect(() => loadConfig(), key).toThrow(`Production worker config requires ${key}`);

      setValidProductionConfig();
      process.env[key] = `http://${key.toLowerCase()}.example.com`;
      expect(() => loadConfig(), key).toThrow(
        `${key === 'OTEL_EXPORTER_OTLP_ENDPOINT' ? 'effective OTLP traces endpoint' : key} must be an absolute HTTPS URL in production`,
      );
    }
  });

  it('validates the effective traces-specific OTLP override', () => {
    setValidProductionConfig();
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://otel.example.com/v1/traces';
    expect(() => loadConfig()).toThrow(
      'effective OTLP traces endpoint must be an absolute HTTPS URL in production',
    );
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://otel.example.com/v1/traces';
    expect(loadConfig().temporalTaskQueue).toBe('tixkit-production');
  });

  it('rejects local production database and Redis endpoints', () => {
    for (const [key, value] of [
      ['DATABASE_URL', 'postgres://tixkit:tixkit@localhost:5432/tixkit'],
      ['REDIS_URL', 'redis://127.0.0.1:6379'],
    ] as const) {
      setValidProductionConfig();
      process.env[key] = value;

      expect(() => loadConfig(), key).toThrow(
        `Production worker config must not point to localhost for ${key}`,
      );
    }
  });
});
