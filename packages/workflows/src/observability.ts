import type { Context as ActivityContext } from '@temporalio/activity';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  Next,
} from '@temporalio/worker';
import {
  createTixkitMetrics,
  observeTemporalActivity,
  pushMetricsToGateway,
  startOpenTelemetry,
  type TixkitMetrics,
} from '@tixkit/shared';

export type WorkerObservability = {
  metrics: TixkitMetrics;
};

let observability: WorkerObservability | undefined;
let metricsPushInFlight: Promise<void> | undefined;
let metricsPushQueued = false;

function scheduleMetricsPush(metrics: TixkitMetrics): void {
  const gatewayUrl = process.env.PROMETHEUS_PUSHGATEWAY_URL;
  if (!gatewayUrl) return;
  if (metricsPushInFlight) {
    metricsPushQueued = true;
    return;
  }
  // Activity execution never awaits this promise. Keep the actual network
  // request as the guard so a hung gateway cannot accumulate parallel pushes.
  metricsPushInFlight = pushMetricsToGateway(metrics, {
    gatewayUrl,
    jobName: 'tixkit-worker',
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      metricsPushInFlight = undefined;
      if (metricsPushQueued) {
        metricsPushQueued = false;
        scheduleMetricsPush(metrics);
      }
    });
}

export async function startWorkerObservability(): Promise<WorkerObservability> {
  await startOpenTelemetry({
    serviceName: 'tixkit-worker',
    serviceVersion: process.env.npm_package_version,
    environment: process.env.NODE_ENV ?? 'development',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  observability ??= { metrics: createTixkitMetrics('tixkit-worker') };
  return observability;
}

export class TixkitActivityMetricsInterceptor implements ActivityInboundCallsInterceptor {
  constructor(
    private readonly ctx: ActivityContext,
    private readonly metrics: TixkitMetrics,
  ) {}

  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    const startedAt = process.hrtime.bigint();
    let outcome = 'ok';
    try {
      const result = await next(input);
      if (isWorkflowActivityErrorResult(result)) {
        outcome = 'error';
      }
      return result;
    } catch (error) {
      outcome = 'exception';
      throw error;
    } finally {
      observeTemporalActivity(this.metrics, {
        activity: this.ctx.info.activityType,
        outcome,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      scheduleMetricsPush(this.metrics);
    }
  }
}

function isWorkflowActivityErrorResult(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { ok?: unknown }).ok === false,
  );
}
