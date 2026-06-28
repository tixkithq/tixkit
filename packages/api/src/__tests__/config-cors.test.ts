import Fastify from 'fastify';
import cors from '@fastify/cors';
import { afterEach, describe, expect, it } from 'vitest';
import { createCorsOriginValidator } from '../app.js';
import { loadConfig, parseTrustProxy, resolveCorsAllowedOrigins } from '../config/index.js';

const ENV_KEYS = [
  'CORS_ALLOWED_ORIGINS',
  'METRICS_BEARER_TOKEN',
  'NODE_ENV',
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
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(parseTrustProxy(undefined)).toBe(false);
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

    expect(loadConfig().corsAllowedOrigins).toEqual([]);
  });
});
