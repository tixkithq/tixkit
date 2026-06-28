import Fastify from 'fastify';
import { trace, type Span, type SpanAttributes, type Tracer } from '@opentelemetry/api';
import { createTixkitMetrics } from '@tixkit/shared';
import type { Database } from '@tixkit/db';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshInventoryHoldGauge,
  registerMetricsRoute,
  registerObservability,
  type ApiObservability,
} from '../observability.js';
import { config } from '../config/index.js';

function createHoldDb(rows: Array<{ quantity: number | string }>): Database {
  const query = {
    select: () => query,
    where: () => query,
    execute: async () => rows,
  };
  return {
    selectFrom: () => query,
  } as unknown as Database;
}

describe('API observability', () => {
  it('records HTTP and checkout route metrics with request correlation', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_observability' });
    const observability: ApiObservability = { metrics: createTixkitMetrics('test-api') };
    registerObservability(app, observability);
    app.get('/v1/checkout/:sessionId', async (request) => {
      request.principal = {
        type: 'user',
        id: 'usr_1',
        clerkUserId: 'clerk_1',
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        brandIds: ['brd_1'],
        scopes: ['orders.read'],
      };
      return { ok: true };
    });

    const response = await app.inject({ method: 'GET', url: '/v1/checkout/cs_1' });
    const output = await observability.metrics.registry.metrics();

    expect(response.statusCode).toBe(200);
    expect(output).toContain('tixkit_http_request_duration_seconds_count');
    expect(output).toContain('route="/v1/checkout/:sessionId"');
    expect(output).toContain('tixkit_checkout_events_total');
    expect(output).toContain('service="test-api"');
    expect(output).toContain('operation="api"');
    expect(output).toContain('outcome="ok"');

    await app.close();
  });

  it('records request span url.path without query secrets', async () => {
    const recordedAttributes: SpanAttributes = {};
    const span = {
      setAttributes: vi.fn((attributes: SpanAttributes) => {
        Object.assign(recordedAttributes, attributes);
        return span as unknown as Span;
      }),
      setStatus: vi.fn(() => span as unknown as Span),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    const startSpan: Tracer['startSpan'] = vi.fn((_name, options) => {
      Object.assign(recordedAttributes, options?.attributes);
      return span as unknown as Span;
    });
    const getTracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan,
    } as Tracer);
    const app = Fastify({ logger: false, genReqId: () => 'req_secret_path' });
    const observability: ApiObservability = { metrics: createTixkitMetrics('test-api-secret-path') };

    try {
      registerObservability(app, observability);
      app.get('/v1/checkout/:sessionId', async () => ({ ok: true }));

      const response = await app.inject({
        method: 'GET',
        url: '/v1/checkout/cs_1?payment_intent_client_secret=testvalue&state=ok#token=fragment-token',
      });

      expect(response.statusCode).toBe(200);
      expect(recordedAttributes['url.path']).toBe('/v1/checkout/cs_1');
      expect(JSON.stringify(recordedAttributes)).not.toContain('payment_intent_client_secret');
      expect(JSON.stringify(recordedAttributes)).not.toContain('pi_123_secret_leak');
    } finally {
      getTracerSpy.mockRestore();
      await app.close();
    }
  });

  it('refreshes active inventory hold gauge before metrics are scraped', async () => {
    const app = Fastify({ logger: false });
    const observability: ApiObservability = { metrics: createTixkitMetrics('test-api-metrics') };
    const db = createHoldDb([{ quantity: 2 }, { quantity: '3' }]);
    registerMetricsRoute(app, observability, () => db, {
      bearerToken: 'metrics-token',
      requireBearerToken: true,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('tixkit_inventory_active_holds');
    expect(response.body).toContain('service="test-api-metrics"');
    expect(response.body).toMatch(/tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 5/);

    await app.close();
  });

  it('requires a metrics bearer token before querying inventory holds', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_metrics_auth' });
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-metrics-auth'),
    };
    const dbProvider = vi.fn(() => createHoldDb([{ quantity: 7 }]));
    registerMetricsRoute(app, observability, dbProvider, {
      bearerToken: 'metrics-token',
      requireBearerToken: true,
    });

    const missingToken = await app.inject({ method: 'GET', url: '/metrics' });
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(missingToken.statusCode).toBe(401);
    expect(wrongToken.statusCode).toBe(401);
    expect(dbProvider).not.toHaveBeenCalled();

    const correctToken = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    });

    expect(correctToken.statusCode).toBe(200);
    expect(correctToken.body).toContain('tixkit_inventory_active_holds');
    expect(correctToken.body).toMatch(
      /tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 7/,
    );
    expect(dbProvider).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('requires metrics auth by default outside development and test before querying inventory holds', async () => {
    const previousNodeEnv = config.nodeEnv;
    const previousMetricsBearerToken = config.metricsBearerToken;
    config.nodeEnv = 'staging';
    config.metricsBearerToken = '';

    const app = Fastify({ logger: false, genReqId: () => 'req_metrics_default_auth' });
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-metrics-default-auth'),
    };
    const dbProvider = vi.fn(() => createHoldDb([{ quantity: 7 }]));

    try {
      registerMetricsRoute(app, observability, dbProvider);

      const response = await app.inject({ method: 'GET', url: '/metrics' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          requestId: 'req_metrics_default_auth',
        },
      });
      expect(dbProvider).not.toHaveBeenCalled();
    } finally {
      config.nodeEnv = previousNodeEnv;
      config.metricsBearerToken = previousMetricsBearerToken;
      await app.close();
    }
  });

  it('can refresh the inventory gauge independently for integration tests', async () => {
    const metrics = createTixkitMetrics('test-api-refresh');
    await refreshInventoryHoldGauge(metrics, createHoldDb([{ quantity: 4 }]));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_inventory_active_holds');
    expect(output).toContain('service="test-api-refresh"');
    expect(output).toMatch(/tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 4/);
  });
});
