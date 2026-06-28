import Fastify from 'fastify';
import { createTixkitMetrics } from '@tixkit/shared';
import type { Database } from '@tixkit/db';
import { describe, expect, it, vi } from 'vitest';
import {
  refreshInventoryHoldGauge,
  registerMetricsRoute,
  registerObservability,
  type ApiObservability,
} from '../observability.js';

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

  it('can refresh the inventory gauge independently for integration tests', async () => {
    const metrics = createTixkitMetrics('test-api-refresh');
    await refreshInventoryHoldGauge(metrics, createHoldDb([{ quantity: 4 }]));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_inventory_active_holds');
    expect(output).toContain('service="test-api-refresh"');
    expect(output).toMatch(/tixkit_inventory_active_holds\{[^}]*scope="global"[^}]*\} 4/);
  });
});
