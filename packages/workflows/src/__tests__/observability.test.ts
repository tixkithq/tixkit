import type { Context as ActivityContext } from '@temporalio/activity';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTixkitMetrics } from '@tixkit/shared';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { TixkitActivityMetricsInterceptor } from '../observability.js';
import { createWorkflowExporterSink } from '../otel-workflow-exporter.js';

const execFileAsync = promisify(execFile);
const workflowRoot = fileURLToPath(new URL('../..', import.meta.url));

function activityContext(activityType: string): ActivityContext {
  return {
    info: {
      activityType,
    },
  } as ActivityContext;
}

describe('worker observability', () => {
  it('loads Temporal OpenTelemetry interceptors with the shared OTel runtime', async () => {
    const smokeScript = `
      import { OpenTelemetryActivityInboundInterceptor, makeWorkflowExporter } from '@temporalio/interceptors-opentelemetry';
      import { createTelemetryResource, createTraceExporter, startOpenTelemetry } from '@tixkit/shared';
      const resource = createTelemetryResource({ serviceName: 'smoke-worker', environment: 'test' });
      const exporter = createTraceExporter({ serviceName: 'smoke-worker', disabled: true });
      const sink = makeWorkflowExporter(exporter, resource);
      const runtime = startOpenTelemetry({ serviceName: 'smoke-worker', disabled: true });
      await runtime.shutdown();
      console.log(typeof OpenTelemetryActivityInboundInterceptor, typeof sink.export);
    `;

    const smokeFile = join(
      workflowRoot,
      `.smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    );
    writeFileSync(smokeFile, smokeScript);
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, [smokeFile], {
        cwd: workflowRoot,
      }));
    } finally {
      unlinkSync(smokeFile);
    }

    expect(stderr).toBe('');
    expect(stdout.trim()).toBe('function object');
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

    await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: true }));

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

    await interceptor.execute({ args: [], headers: {} as never }, async () => ({ ok: false }));

    const output = await metrics.registry.metrics();
    expect(output).toContain('tixkit_temporal_activity_events_total');
    expect(output).toContain('service="test-worker-error"');
    expect(output).toContain('activity="processRefundActivity"');
    expect(output).toContain('outcome="error"} 1');
  });
});
