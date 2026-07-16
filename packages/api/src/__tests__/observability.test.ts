import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { trace, type Span, type SpanAttributes, type Tracer } from '@opentelemetry/api';
import { createTixkitMetrics } from '@tixkit/shared';
import type { Database } from '@tixkit/db';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshInventoryHoldGauge,
  observeApiPaymentProviderAttempt,
  registerMetricsRoute,
  registerObservability,
  type ApiObservability,
} from '../observability.js';
import { config } from '../config/index.js';

type HoldQuery = {
  executeTakeFirst: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
};

type HoldDb = Database & {
  query: HoldQuery;
};

function createHoldDb(quantity: number | string | null): HoldDb {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: vi.fn(async () => ({ quantity })),
    execute: vi.fn(async () => {
      throw new Error('refreshInventoryHoldGauge should use an aggregate query');
    }),
  };
  return Object.assign(
    {
      selectFrom: () => query,
    } as unknown as Database,
    { query },
  );
}

describe('API observability', () => {
  it('records API-owned Stripe Connect attempts in the bounded payment service signal', async () => {
    const metrics = createTixkitMetrics('test-api-provider-attempts');
    observeApiPaymentProviderAttempt(metrics, { serviceOutcome: 'platform_failure' });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /tixkit_provider_service_attempts_total\{[^}]*surface="payment"[^}]*outcome="platform_failure"[^}]*service="test-api-provider-attempts"[^}]*\} 1/u,
    );
  });

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
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-secret-path'),
    };

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

  it('redacts error messages recorded on request spans', async () => {
    const recordedExceptions: unknown[] = [];
    const recordedStatuses: unknown[] = [];
    const span = {
      setAttributes: vi.fn(() => span as unknown as Span),
      setStatus: vi.fn((status: unknown) => {
        recordedStatuses.push(status);
        return span as unknown as Span;
      }),
      recordException: vi.fn((error: unknown) => {
        recordedExceptions.push(error);
        return span as unknown as Span;
      }),
      end: vi.fn(),
    };
    const startSpan: Tracer['startSpan'] = vi.fn(() => span as unknown as Span);
    const getTracerSpy = vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan,
    } as Tracer);
    const app = Fastify({ logger: false, genReqId: () => 'req_secret_error' });
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-secret-error'),
    };

    try {
      registerObservability(app, observability);
      app.get('/boom', async () => {
        throw new Error('provider failed for buyer@example.com with Bearer tk_live_secret');
      });

      const response = await app.inject({ method: 'GET', url: '/boom' });
      const recordedError = recordedExceptions[0] as Error;
      const serializedTelemetry = JSON.stringify({
        exceptionMessage: recordedError.message,
        exceptionStack: recordedError.stack,
        recordedStatuses,
      });

      expect(response.statusCode).toBe(500);
      expect(serializedTelemetry).not.toContain('buyer@example.com');
      expect(serializedTelemetry).not.toContain('tk_live_secret');
      expect(serializedTelemetry).toContain('[REDACTED]');
    } finally {
      getTracerSpy.mockRestore();
      await app.close();
    }
  });

  it('refreshes active inventory hold gauge before metrics are scraped', async () => {
    const app = Fastify({ logger: false });
    const observability: ApiObservability = { metrics: createTixkitMetrics('test-api-metrics') };
    const db = createHoldDb('5');
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
    expect(db.query.executeTakeFirst).toHaveBeenCalledTimes(1);
    expect(db.query.execute).not.toHaveBeenCalled();

    await app.close();
  });

  it('requires a metrics bearer token before querying inventory holds', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_metrics_auth' });
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-metrics-auth'),
    };
    const dbProvider = vi.fn(() => createHoldDb(7));
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

  it('exempts authorized metrics scrapes from global rate limiting', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_metrics_rate_limit' });
    await app.register(rateLimit, { max: 1, timeWindow: '1 minute' });
    const observability: ApiObservability = {
      metrics: createTixkitMetrics('test-api-metrics-rate-limit'),
    };
    const dbProvider = vi.fn(() => createHoldDb(7));
    registerMetricsRoute(app, observability, dbProvider, {
      bearerToken: 'metrics-token',
      requireBearerToken: true,
    });
    app.get('/normal', async () => ({ ok: true }));

    const firstMetrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    });
    const secondMetrics = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-token' },
    });
    const firstNormal = await app.inject({ method: 'GET', url: '/normal' });
    const secondNormal = await app.inject({ method: 'GET', url: '/normal' });

    expect(firstMetrics.statusCode).toBe(200);
    expect(secondMetrics.statusCode).toBe(200);
    expect(firstNormal.statusCode).toBe(200);
    expect(secondNormal.statusCode).toBe(429);
    expect(dbProvider).toHaveBeenCalledTimes(2);
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
    const dbProvider = vi.fn(() => createHoldDb(7));

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
    await refreshInventoryHoldGauge(metrics, createHoldDb(4));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_inventory_active_holds');
    expect(output).toContain('service="test-api-refresh"');
    expect(output).toMatch(/tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 4/);
  });

  it('sets the inventory gauge to zero when no active holds are present', async () => {
    const metrics = createTixkitMetrics('test-api-refresh-empty');
    await refreshInventoryHoldGauge(metrics, createHoldDb(null));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_inventory_active_holds');
    expect(output).toMatch(/tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 0/);
  });
});
