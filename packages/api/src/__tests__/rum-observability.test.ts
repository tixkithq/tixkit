import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import { createTixkitMetrics, RUM_SCHEMA_VERSION } from '@tixkit/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUM_JSON_BODY_LIMIT_BYTES,
  RUM_RATE_LIMIT_PER_MINUTE,
  rumRoutes,
} from '../routes/modules/rum.js';

const apps: ReturnType<typeof Fastify>[] = [];

async function setup() {
  const app = Fastify({ logger: false });
  apps.push(app);
  const metrics = createTixkitMetrics('test-rum-api');
  app.decorate('observability', { metrics });
  await app.register(rateLimit);
  await app.register(rumRoutes, { prefix: '/v1' });
  return { app, metrics };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('privacy-safe RUM endpoint', () => {
  it('contains no raw-sample persistence or application logging path', () => {
    const source = readFileSync(new URL('../routes/modules/rum.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.db\b|insertInto|updateTable|request\.log|console\./u);
  });

  it('accepts only bounded web-vital samples and records no identifying labels', async () => {
    const { app, metrics } = await setup();
    for (const payload of [
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'LCP', value: 2.5 },
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'event-page', metric: 'INP', value: 0.2 },
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'CLS', value: 0.1 },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/public/rum', payload });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
    }

    const output = await metrics.registry.metrics();
    expect(output).toMatch(/tixkit_rum_lcp_seconds_count\{[^}]*surface="checkout"[^}]*\} 1/u);
    expect(output).toMatch(/tixkit_rum_inp_seconds_count\{[^}]*surface="event-page"[^}]*\} 1/u);
    expect(output).toMatch(/tixkit_rum_cls_score_count\{[^}]*surface="checkout"[^}]*\} 1/u);
    const samples = output
      .split('\n')
      .filter((line) => line.startsWith('tixkit_rum_'))
      .join('\n');
    expect(samples).not.toMatch(/event_id|tenant|user|session|route|url|referrer|host=/iu);
  });

  it.each([
    [
      'unknown schema',
      { schemaVersion: 'tixkit-rum-v2', surface: 'checkout', metric: 'LCP', value: 1 },
    ],
    [
      'unknown surface',
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'event-123', metric: 'LCP', value: 1 },
    ],
    [
      'unknown metric',
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'FCP', value: 1 },
    ],
    [
      'negative value',
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'LCP', value: -1 },
    ],
    [
      'oversized metric value',
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'INP', value: 10.01 },
    ],
    [
      'identifying field',
      {
        schemaVersion: RUM_SCHEMA_VERSION,
        surface: 'checkout',
        metric: 'CLS',
        value: 0.1,
        sessionId: 'secret-session',
      },
    ],
    [
      'context field',
      {
        schemaVersion: RUM_SCHEMA_VERSION,
        surface: 'checkout',
        metric: 'LCP',
        value: 1,
        url: 'https://example.test/private?token=secret',
      },
    ],
  ])('rejects %s without recording a sample', async (_label, payload) => {
    const { app, metrics } = await setup();
    const response = await app.inject({ method: 'POST', url: '/v1/public/rum', payload });
    expect(response.statusCode).toBe(400);
    const output = await metrics.registry.metrics();
    expect(output).not.toMatch(/tixkit_rum_(?:lcp_seconds|inp_seconds|cls_score)_count\{/u);
  });

  it('rejects oversized bodies before metric collection', async () => {
    const { app, metrics } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/public/rum',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        schemaVersion: RUM_SCHEMA_VERSION,
        surface: 'checkout',
        metric: 'LCP',
        value: 1,
        padding: 'x'.repeat(RUM_JSON_BODY_LIMIT_BYTES),
      }),
    });
    expect(response.statusCode).toBe(413);
    expect(await metrics.registry.metrics()).not.toMatch(
      /tixkit_rum_(?:lcp_seconds|inp_seconds|cls_score)_count\{/u,
    );
  });

  it('applies a tighter public endpoint rate limit', async () => {
    const { app } = await setup();
    const payload = {
      schemaVersion: RUM_SCHEMA_VERSION,
      surface: 'checkout',
      metric: 'CLS',
      value: 0.01,
    };
    for (let index = 0; index < RUM_RATE_LIMIT_PER_MINUTE; index += 1) {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/public/rum', payload })).statusCode,
      ).toBe(202);
    }
    expect((await app.inject({ method: 'POST', url: '/v1/public/rum', payload })).statusCode).toBe(
      429,
    );
  });
});
