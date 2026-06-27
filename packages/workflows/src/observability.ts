import type { Context as ActivityContext } from '@temporalio/activity';
import type { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next } from '@temporalio/worker';
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

export function startWorkerObservability(): WorkerObservability {
  startOpenTelemetry({
    serviceName: 'tixkit-worker',
    serviceVersion: process.env.npm_package_version,
    environment: process.env.NODE_ENV ?? 'development',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  observability ??= { metrics: createTixkitMetrics('tixkit-worker') };
  return observability;
}

export class TixkitActivityMetricsInterceptor implements ActivityInboundCallsInterceptor {
  constructor(private readonly ctx: ActivityContext, private readonly metrics: TixkitMetrics) {}

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
      await pushMetricsToGateway(this.metrics, {
        gatewayUrl: process.env.PROMETHEUS_PUSHGATEWAY_URL,
        jobName: 'tixkit-worker',
      }).catch(() => undefined);
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
