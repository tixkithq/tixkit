import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkerStartupFailureMessage } from '../startup-diagnostics.js';

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
};

afterEach(() => {
  restoreEnv('DATABASE_URL', originalEnv.DATABASE_URL);
  restoreEnv('REDIS_URL', originalEnv.REDIS_URL);
  restoreEnv('TEMPORAL_ADDRESS', originalEnv.TEMPORAL_ADDRESS);
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
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
