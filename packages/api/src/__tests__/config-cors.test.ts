import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorsOriginValidator } from '../app.js';
import { loadConfig, parseTrustProxy, resolveCorsAllowedOrigins } from '../config/index.js';

const ENV_KEYS = [
  'CORS_ALLOWED_ORIGINS',
  'METRICS_BEARER_TOKEN',
  'NODE_ENV',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_TIME_WINDOW',
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
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = 'true';

    expect(() => loadConfig()).toThrow(
      'TRUST_PROXY=true is not allowed in production. Set TRUST_PROXY to a numeric hop count or an explicit proxy CIDR/list.',
    );
  });

  it('accepts bounded TRUST_PROXY values in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.TEMPORAL_ADDRESS = 'temporal.example.com:7233';
    process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
    process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';

    process.env.TRUST_PROXY = '1';
    expect(loadConfig().trustProxy).toBe(1);

    process.env.TRUST_PROXY = '10.0.0.0/8';
    expect(loadConfig().trustProxy).toBe('10.0.0.0/8');

    process.env.TRUST_PROXY = '10.0.0.0/8,192.168.0.0/16';
    expect(loadConfig().trustProxy).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('rejects missing production Temporal config', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = '1';
    delete process.env.TEMPORAL_ADDRESS;
    delete process.env.TEMPORAL_NAMESPACE;
    delete process.env.TEMPORAL_TASK_QUEUE;

    expect(() => loadConfig()).toThrow(
      'Production Temporal config requires TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TASK_QUEUE',
    );
  });

  it('rejects localhost Temporal addresses in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUST_PROXY = '1';
    process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
    process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';

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

    process.env.NODE_ENV = 'production';
    process.env.TEMPORAL_ADDRESS = 'temporal.example.com:7233';
    process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
    process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';
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

  it('defaults local CORS origins in development but not production', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.NODE_ENV = 'development';

    expect(loadConfig().corsAllowedOrigins).toEqual([
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
    ]);

    process.env.NODE_ENV = 'production';
    process.env.TEMPORAL_ADDRESS = 'temporal.example.com:7233';
    process.env.TEMPORAL_NAMESPACE = 'tixkit.production';
    process.env.TEMPORAL_TASK_QUEUE = 'tixkit-production';

    expect(loadConfig().corsAllowedOrigins).toEqual([]);
  });
});
