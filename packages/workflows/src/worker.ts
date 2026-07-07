import { Worker, NativeConnection, type ActivityInterceptorsFactory } from '@temporalio/worker';
import { Connection, Client } from '@temporalio/client';
import { createTelemetryResource, createTraceExporter } from '@tixkit/shared';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import * as allActivities from './activities/index.js';
import { closeActivityClients } from './activities/activity-clients.js';
import { holdExpirationWorkflow } from './workflows/index.js';
import { holdExpirationWorkflowId, HOLD_EXPIRATION_WORKFLOW_VERSION } from './shared/types.js';
import { buildWorkerStartupFailureMessage } from './startup-diagnostics.js';
import { TixkitActivityMetricsInterceptor, startWorkerObservability } from './observability.js';
import { createWorkflowExporterSink } from './otel-workflow-exporter.js';

const require = createRequire(import.meta.url);

type SchedulerConnection = {
  close(): Promise<void> | void;
};

type SchedulerClient = {
  workflow: {
    start(
      workflow: typeof holdExpirationWorkflow,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [{ version: typeof HOLD_EXPIRATION_WORKFLOW_VERSION }];
      },
    ): Promise<unknown>;
  };
};

type EnsureHoldExpirationSchedulerOptions = {
  connect?: () => Promise<SchedulerConnection>;
  createClient?: (connection: SchedulerConnection) => SchedulerClient;
  taskQueue?: string;
  workflowId?: string;
};

type RunWorkerOptions = {
  workflowsPath?: string;
};

function workerConcurrencyOptions() {
  return {
    ...(config.temporalWorkerMaxConcurrentActivityTaskExecutions !== undefined
      ? {
          maxConcurrentActivityTaskExecutions:
            config.temporalWorkerMaxConcurrentActivityTaskExecutions,
        }
      : {}),
    ...(config.temporalWorkerMaxConcurrentWorkflowTaskExecutions !== undefined
      ? {
          maxConcurrentWorkflowTaskExecutions:
            config.temporalWorkerMaxConcurrentWorkflowTaskExecutions,
        }
      : {}),
    ...(config.temporalWorkerMaxCachedWorkflows !== undefined
      ? { maxCachedWorkflows: config.temporalWorkerMaxCachedWorkflows }
      : {}),
  };
}

function isWorkflowExecutionAlreadyStartedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'WorkflowExecutionAlreadyStartedError' || err.message.includes('already started'))
  );
}

export async function ensureHoldExpirationScheduler(
  options: EnsureHoldExpirationSchedulerOptions = {},
): Promise<'started' | 'already_started'> {
  const clientConnection =
    options.connect === undefined
      ? await Connection.connect({ address: config.temporalAddress })
      : await options.connect();

  try {
    const client =
      options.createClient?.(clientConnection) ??
      new Client({
        connection: clientConnection as Connection,
        namespace: config.temporalNamespace,
      });
    try {
      await client.workflow.start(holdExpirationWorkflow, {
        taskQueue: options.taskQueue ?? config.temporalTaskQueue,
        workflowId: options.workflowId ?? holdExpirationWorkflowId(),
        args: [{ version: HOLD_EXPIRATION_WORKFLOW_VERSION }],
      });
      return 'started';
    } catch (err) {
      if (isWorkflowExecutionAlreadyStartedError(err)) {
        return 'already_started';
      }
      throw err;
    }
  } finally {
    await clientConnection.close();
  }
}

export async function runWorker(options: RunWorkerOptions = {}): Promise<void> {
  const observability = await startWorkerObservability();
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });
  try {
    const tracingDisabled = process.env.OTEL_SDK_DISABLED === 'true';
    const telemetryResource = tracingDisabled
      ? undefined
      : await createTelemetryResource({
          serviceName: 'tixkit-worker',
          serviceVersion: process.env.npm_package_version,
          environment: process.env.NODE_ENV ?? 'development',
          otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        });
    const workflowTraceExporter = tracingDisabled
      ? undefined
      : await createTraceExporter({ serviceName: 'tixkit-worker' });
    const activityInterceptors: ActivityInterceptorsFactory[] = [
      (ctx) => ({ inbound: new TixkitActivityMetricsInterceptor(ctx, observability.metrics) }),
    ];
    if (!tracingDisabled) {
      const { OpenTelemetryActivityInboundInterceptor } =
        await import('@temporalio/interceptors-opentelemetry');
      activityInterceptors.unshift((ctx) => ({
        inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
      }));
    }

    const workerOptions = {
      connection,
      namespace: config.temporalNamespace,
      workflowsPath: options.workflowsPath ?? require.resolve('./workflows/index.js'),
      activities: allActivities,
      enableSDKTracing: !tracingDisabled,
      ...workerConcurrencyOptions(),
      ...(workflowTraceExporter && telemetryResource
        ? {
            sinks: {
              exporter: createWorkflowExporterSink(workflowTraceExporter, telemetryResource),
            },
          }
        : {}),
      interceptors: {
        ...(tracingDisabled
          ? {}
          : { workflowModules: [require.resolve('./workflows/otel-interceptors.js')] }),
        activity: activityInterceptors,
      },
    };
    const workers = await Promise.all(
      config.temporalWorkerTaskQueues.map((taskQueue) =>
        Worker.create({
          ...workerOptions,
          taskQueue,
        }),
      ),
    );

    await ensureHoldExpirationScheduler();

    const workerRuns = workers.map((worker) => worker.run());
    console.log(`TIXKIT_WORKER_READY taskQueues=${config.temporalWorkerTaskQueues.join(',')}`);
    await Promise.all(workerRuns);
  } finally {
    await closeActivityClients();
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorker().catch((err) => {
    console.error(buildWorkerStartupFailureMessage(err));
    process.exit(1);
  });
}
