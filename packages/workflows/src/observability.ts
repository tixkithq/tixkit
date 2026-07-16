import type { Context as ActivityContext } from '@temporalio/activity';
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  Next,
} from '@temporalio/worker';
import type { Database } from '@tixkit/db';
import type { ProviderTelemetryEvent } from '@tixkit/provider-clients';
import {
  createTixkitMetrics,
  deleteMetricsFromGateway,
  observeTemporalActivity,
  observeMigrationOperation,
  observeProviderServiceAttempt,
  pushMetricsToGateway,
  startOpenTelemetry,
  type TixkitMetrics,
} from '@tixkit/shared';

export type WorkerObservability = {
  metrics: TixkitMetrics;
};

function workerMetricsInstance(): string | undefined {
  return process.env.POD_NAME ?? process.env.HOSTNAME;
}

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
    instance: workerMetricsInstance(),
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

export async function deleteWorkerMetricsGrouping(): Promise<void> {
  try {
    await deleteMetricsFromGateway({
      gatewayUrl: process.env.PROMETHEUS_PUSHGATEWAY_URL,
      jobName: 'tixkit-worker',
      instance: workerMetricsInstance(),
    });
  } catch {
    // Shutdown must continue; freshness-bounded alerts ignore a grouping left by hard loss.
  }
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

export function observePaymentProviderAttempt(
  metrics: TixkitMetrics,
  event: Pick<ProviderTelemetryEvent, 'serviceOutcome'>,
): void {
  observeProviderServiceAttempt(metrics, {
    surface: 'payment',
    outcome: event.serviceOutcome,
  });
}

export function paymentProviderTelemetry(event: Readonly<ProviderTelemetryEvent>): void {
  if (!observability) return;
  observePaymentProviderAttempt(observability.metrics, event);
  scheduleMetricsPush(observability.metrics);
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
    let migrationErrorCode = 'none';
    try {
      const result = await next(input);
      if (isWorkflowActivityErrorResult(result)) {
        outcome = 'error';
        migrationErrorCode = migrationErrorCodeFor(result);
      }
      return result;
    } catch (error) {
      outcome = 'exception';
      migrationErrorCode = migrationErrorCodeFor(error);
      throw error;
    } finally {
      observeTemporalActivity(this.metrics, {
        activity: this.ctx.info.activityType,
        outcome,
        durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
      });
      const migrationPhase = migrationPhaseForActivity(this.ctx.info.activityType);
      if (migrationPhase) {
        observeMigrationOperation(this.metrics, {
          phase: migrationPhase,
          outcome: outcome === 'ok' ? 'ok' : 'error',
          errorCode: migrationErrorCode,
        });
      }
      scheduleMetricsPush(this.metrics);
    }
  }
}

export type DurableMigrationProgress = {
  phase: 'prepare' | 'commit' | 'rollback';
  lastProgressAt: Date;
};

export async function loadDurableMigrationProgress(
  db: Database,
): Promise<DurableMigrationProgress[]> {
  const jobs = await db
    .selectFrom('import_jobs')
    .select(['id', 'status', 'updated_at'])
    .where('status', 'in', ['preparing', 'committing', 'rolling-back'])
    .execute();
  if (jobs.length === 0) return [];
  const latestEvents = await db
    .selectFrom('import_job_events')
    .select('import_job_id')
    .select(({ fn }) => fn.max<Date>('created_at').as('last_progress_at'))
    .where('type', 'in', [
      'preparation.progress',
      'preparation.completed',
      'commit.begin',
      'commit.progress',
      'commit.reconciled',
      'rollback.completed',
    ])
    .where(
      'import_job_id',
      'in',
      jobs.map((job) => job.id),
    )
    .groupBy('import_job_id')
    .execute();
  const eventByJob = new Map(
    latestEvents.map((event) => [event.import_job_id, event.last_progress_at]),
  );
  return jobs.map((job) => ({
    phase:
      job.status === 'preparing' ? 'prepare' : job.status === 'committing' ? 'commit' : 'rollback',
    lastProgressAt: new Date(eventByJob.get(job.id) ?? job.updated_at),
  }));
}

export async function refreshMigrationProgressAgeMetrics(
  metrics: TixkitMetrics,
  load: () => Promise<DurableMigrationProgress[]>,
  now: () => Date = () => new Date(),
): Promise<void> {
  const maximumAge = new Map<string, number>([
    ['prepare', 0],
    ['commit', 0],
    ['rollback', 0],
  ]);
  const current = now().getTime();
  for (const row of await load()) {
    const ageSeconds = Math.max(0, Math.floor((current - row.lastProgressAt.getTime()) / 1000));
    maximumAge.set(row.phase, Math.max(maximumAge.get(row.phase) ?? 0, ageSeconds));
  }
  for (const [phase, ageSeconds] of maximumAge) {
    metrics.metrics.migrationProgressAge.set({ phase }, ageSeconds);
  }
}

export function startMigrationProgressAgeRefresh(
  metrics: TixkitMetrics,
  db: Database,
  intervalMs = 30_000,
  load: () => Promise<DurableMigrationProgress[]> = () => loadDurableMigrationProgress(db),
): () => void {
  let stopped = false;
  let inFlight = false;
  const refresh = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await refreshMigrationProgressAgeMetrics(metrics, load);
      scheduleMetricsPush(metrics);
    } finally {
      inFlight = false;
    }
  };
  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function migrationErrorCodeFor(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error
        ? JSON.stringify(error)
        : String(error);
  if (/side.effect/i.test(message)) return 'side_effect_attempt';
  if (/scope|tenant|organization/i.test(message)) return 'scope_violation';
  if (/rollback.*refus|rollback.*ineligible/i.test(message)) return 'rollback_refused';
  if (/reconcil/i.test(message)) return 'reconciliation_required';
  if (/conflict/i.test(message)) return 'conflict';
  return 'failed';
}

function migrationPhaseForActivity(activity: string): string | undefined {
  if (!/migration/i.test(activity)) return undefined;
  if (/rollback/i.test(activity)) return 'rollback';
  if (/reconcil/i.test(activity)) return 'reconcile';
  if (/commit/i.test(activity)) return 'commit';
  return 'prepare';
}

function isWorkflowActivityErrorResult(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { ok?: unknown }).ok === false,
  );
}
