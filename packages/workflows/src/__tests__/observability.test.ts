import type { Context as ActivityContext } from '@temporalio/activity';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTixkitMetrics } from '@tixkit/shared';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { describe, expect, it, vi } from 'vitest';
import {
  TixkitActivityMetricsInterceptor,
  deleteWorkerMetricsGrouping,
  refreshMigrationProgressAgeMetrics,
  startMigrationProgressAgeRefresh,
  observePaymentProviderAttempt,
} from '../observability.js';
import { createWorkflowExporterSink } from '../otel-workflow-exporter.js';

vi.mock('@temporalio/interceptors-opentelemetry', () => ({
  OpenTelemetryActivityInboundInterceptor: vi.fn(),
  OpenTelemetryWorkflowInboundInterceptor: vi.fn(),
}));

const pushMetricsToGatewayMock = vi.hoisted(() => vi.fn(async () => undefined));
const deleteMetricsFromGatewayMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@tixkit/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tixkit/shared')>();
  return {
    ...actual,
    observeProviderServiceAttempt: (
      metrics: ReturnType<typeof createTixkitMetrics>,
      input: { surface: 'payment'; outcome: string },
    ) => metrics.metrics.providerServiceAttempts.inc(input),
    deleteMetricsFromGateway: deleteMetricsFromGatewayMock,
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

  it('pushes advancing durable migration age without requiring new activity execution', async () => {
    const originalGatewayUrl = process.env.PROMETHEUS_PUSHGATEWAY_URL;
    process.env.PROMETHEUS_PUSHGATEWAY_URL = 'https://pushgateway.test';
    pushMetricsToGatewayMock.mockClear();
    const stop = startMigrationProgressAgeRefresh(
      createTixkitMetrics('test-worker-stall-push'),
      {} as never,
      10,
      async () => [{ phase: 'commit', lastProgressAt: new Date(Date.now() - 901_000) }],
    );
    try {
      await vi.waitFor(() => expect(pushMetricsToGatewayMock).toHaveBeenCalled());
    } finally {
      stop();
      if (originalGatewayUrl === undefined) delete process.env.PROMETHEUS_PUSHGATEWAY_URL;
      else process.env.PROMETHEUS_PUSHGATEWAY_URL = originalGatewayUrl;
    }
  });

  it('deletes the exact per-pod Pushgateway grouping during graceful shutdown', async () => {
    const originalGatewayUrl = process.env.PROMETHEUS_PUSHGATEWAY_URL;
    const originalPodName = process.env.POD_NAME;
    process.env.PROMETHEUS_PUSHGATEWAY_URL = 'https://pushgateway.test';
    process.env.POD_NAME = 'worker-7';
    deleteMetricsFromGatewayMock.mockClear();
    try {
      await deleteWorkerMetricsGrouping();
      expect(deleteMetricsFromGatewayMock).toHaveBeenCalledWith({
        gatewayUrl: 'https://pushgateway.test',
        jobName: 'tixkit-worker',
        instance: 'worker-7',
      });
    } finally {
      if (originalGatewayUrl === undefined) delete process.env.PROMETHEUS_PUSHGATEWAY_URL;
      else process.env.PROMETHEUS_PUSHGATEWAY_URL = originalGatewayUrl;
      if (originalPodName === undefined) delete process.env.POD_NAME;
      else process.env.POD_NAME = originalPodName;
    }
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

  it('records each provider callback as one payment attempt including retry attempts', async () => {
    const metrics = createTixkitMetrics('test-worker-provider-attempts');
    observePaymentProviderAttempt(metrics, { serviceOutcome: 'platform_failure' });
    observePaymentProviderAttempt(metrics, { serviceOutcome: 'success' });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /tixkit_provider_service_attempts_total\{[^}]*surface="payment"[^}]*outcome="platform_failure"[^}]*service="test-worker-provider-attempts"[^}]*\} 1/u,
    );
    expect(output).toMatch(
      /tixkit_provider_service_attempts_total\{[^}]*surface="payment"[^}]*outcome="success"[^}]*service="test-worker-provider-attempts"[^}]*\} 1/u,
    );
  });

  it('does not overlap metrics pushes when the gateway never settles', async () => {
    const originalGatewayUrl = process.env.PROMETHEUS_PUSHGATEWAY_URL;
    const originalPodName = process.env.POD_NAME;
    process.env.PROMETHEUS_PUSHGATEWAY_URL = 'http://pushgateway.test';
    process.env.POD_NAME = 'worker-0';
    pushMetricsToGatewayMock.mockClear();
    pushMetricsToGatewayMock.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const interceptor = new TixkitActivityMetricsInterceptor(
      activityContext('hungGatewayActivity'),
      createTixkitMetrics('test-worker-hung-gateway'),
    );

    try {
      await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: true }));
      await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: true }));
      await vi.waitFor(() => expect(pushMetricsToGatewayMock).toHaveBeenCalledTimes(1));
      expect(pushMetricsToGatewayMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ instance: 'worker-0' }),
      );
    } finally {
      if (originalGatewayUrl === undefined) delete process.env.PROMETHEUS_PUSHGATEWAY_URL;
      else process.env.PROMETHEUS_PUSHGATEWAY_URL = originalGatewayUrl;
      if (originalPodName === undefined) delete process.env.POD_NAME;
      else process.env.POD_NAME = originalPodName;
    }
  });
});
