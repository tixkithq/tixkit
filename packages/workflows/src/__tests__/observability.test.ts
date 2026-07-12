import type { Context as ActivityContext } from '@temporalio/activity';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTixkitMetrics } from '@tixkit/shared';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { describe, expect, it, vi } from 'vitest';
import {
  TixkitActivityMetricsInterceptor,
  refreshMigrationProgressAgeMetrics,
} from '../observability.js';
import { createWorkflowExporterSink } from '../otel-workflow-exporter.js';

vi.mock('@temporalio/interceptors-opentelemetry', () => ({
  OpenTelemetryActivityInboundInterceptor: vi.fn(),
  OpenTelemetryWorkflowInboundInterceptor: vi.fn(),
}));

const pushMetricsToGatewayMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@tixkit/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tixkit/shared')>();
  return {
    ...actual,
    pushMetricsToGateway: pushMetricsToGatewayMock,
    startOpenTelemetry: () => ({ shutdown: async () => undefined }),
  };
});

function activityContext(activityType: string): ActivityContext {
  return {
    info: {
      activityType,
    },
  } as ActivityContext;
}

describe('worker observability', () => {
  it('reports durable wall-clock migration stall age and resets only after persisted progress', async () => {
    const metrics = createTixkitMetrics('test-worker-migration-age');
    let now = new Date('2026-07-11T12:15:01.000Z');
    let durableProgress = new Date('2026-07-11T12:00:00.000Z');
    const load = vi.fn(async () => [
      { phase: 'prepare' as const, lastProgressAt: durableProgress },
    ]);

    await refreshMigrationProgressAgeMetrics(metrics, load, () => now);
    let output = await metrics.registry.metrics();
    expect(output).toMatch(
      /tixkit_migration_progress_age_seconds\{[^}]*phase="prepare"[^}]*\} 901/,
    );

    now = new Date('2026-07-11T12:20:00.000Z');
    await refreshMigrationProgressAgeMetrics(metrics, load, () => now);
    output = await metrics.registry.metrics();
    expect(output).toMatch(
      /tixkit_migration_progress_age_seconds\{[^}]*phase="prepare"[^}]*\} 1200/,
    );

    durableProgress = new Date('2026-07-11T12:19:55.000Z');
    await refreshMigrationProgressAgeMetrics(metrics, load, () => now);
    output = await metrics.registry.metrics();
    expect(output).toMatch(/tixkit_migration_progress_age_seconds\{[^}]*phase="prepare"[^}]*\} 5/);
  });

  it('loads Temporal OpenTelemetry interceptors with the shared OTel runtime', async () => {
    const { OpenTelemetryActivityInboundInterceptor } =
      await import('@temporalio/interceptors-opentelemetry');
    const { startOpenTelemetry } = await import('@tixkit/shared');

    expect(typeof OpenTelemetryActivityInboundInterceptor).toBe('function');
    expect(typeof startOpenTelemetry).toBe('function');
  });

  it('exports serialized workflow spans through the OTel 2.x exporter shape', async () => {
    const exported: ReadableSpan[][] = [];
    const exporter: SpanExporter = {
      export: (spans, callback) => {
        exported.push(spans);
        callback({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const sink = createWorkflowExporterSink(
      exporter,
      resourceFromAttributes({ 'service.name': 'test-workflow-exporter' }),
    );

    await sink.export.fn({ workflowType: 'checkoutSessionWorkflow' } as never, [
      {
        name: 'RunWorkflow:checkoutSessionWorkflow',
        kind: SpanKind.INTERNAL,
        spanContext: {
          traceId: '0af7651916cd43dd8448eb211c80319c',
          spanId: 'b7ad6b7169203331',
          traceFlags: 1,
          traceState: 'vendor=value',
        },
        startTime: [0, 1],
        endTime: [0, 2],
        status: { code: SpanStatusCode.OK },
        attributes: { 'temporal.workflow_id': 'wf_1' },
        links: [],
        events: [],
        duration: [0, 1],
        ended: true,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
        instrumentationLibrary: { name: '@temporalio/interceptor-workflow' },
      },
    ]);

    expect(exported).toHaveLength(1);
    expect(exported[0]?.[0]?.resource.attributes).toMatchObject({
      'service.name': 'test-workflow-exporter',
    });
    expect(exported[0]?.[0]?.instrumentationScope.name).toBe('@temporalio/interceptor-workflow');
    expect(exported[0]?.[0]?.spanContext().traceState?.serialize()).toBe('vendor=value');
  });

  it('records successful Temporal activity outcomes', async () => {
    const metrics = createTixkitMetrics('test-worker');
    const interceptor = new TixkitActivityMetricsInterceptor(
      activityContext('finalizeOrderActivity'),
      metrics,
    );

    await interceptor.execute({ args: [], headers: {} as never }, async () => ({
      ok: true,
    }));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_temporal_activity_events_total');
    expect(output).toContain('service="test-worker"');
    expect(output).toContain('activity="finalizeOrderActivity"');
    expect(output).toContain('outcome="ok"} 1');
  });

  it('records failed activity result envelopes as errors', async () => {
    const metrics = createTixkitMetrics('test-worker-error');
    const interceptor = new TixkitActivityMetricsInterceptor(
      activityContext('processRefundActivity'),
      metrics,
    );

    await interceptor.execute({ args: [], headers: {} as never }, async () => ({
      ok: false,
    }));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_temporal_activity_events_total');
    expect(output).toContain('service="test-worker-error"');
    expect(output).toContain('activity="processRefundActivity"');
    expect(output).toContain('outcome="error"} 1');
  });

  it('does not overlap metrics pushes when the gateway never settles', async () => {
    const originalGatewayUrl = process.env.PROMETHEUS_PUSHGATEWAY_URL;
    process.env.PROMETHEUS_PUSHGATEWAY_URL = 'http://pushgateway.test';
    pushMetricsToGatewayMock.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const interceptor = new TixkitActivityMetricsInterceptor(
      activityContext('hungGatewayActivity'),
      createTixkitMetrics('test-worker-hung-gateway'),
    );

    try {
      await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: true }));
      await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: true }));
      await vi.waitFor(() => expect(pushMetricsToGatewayMock).toHaveBeenCalledTimes(1));
    } finally {
      if (originalGatewayUrl === undefined) delete process.env.PROMETHEUS_PUSHGATEWAY_URL;
      else process.env.PROMETHEUS_PUSHGATEWAY_URL = originalGatewayUrl;
    }
  });
});
