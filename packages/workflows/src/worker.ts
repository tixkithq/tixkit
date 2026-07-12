import { Worker, NativeConnection, type ActivityInterceptorsFactory } from '@temporalio/worker';
import { Connection, Client } from '@temporalio/client';
import { createTelemetryResource, createTraceExporter } from '@tixkit/shared';
import { assertSandboxRuntimeBinding, createDb } from '@tixkit/db';
import { createRequire } from 'node:module';
import { rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { temporalConnectionOptions } from './temporal-connection.js';
import * as allActivities from './activities/index.js';
import { closeActivityClients } from './activities/activity-clients.js';
import { holdExpirationWorkflow, providerEventRecoveryWorkflow } from './workflows/index.js';
import {
  holdExpirationWorkflowId,
  providerEventRecoveryWorkflowId,
  HOLD_EXPIRATION_WORKFLOW_VERSION,
  PROVIDER_EVENT_RECOVERY_WORKFLOW_VERSION,
} from './shared/types.js';
import { buildWorkerStartupFailureMessage } from './startup-diagnostics.js';
import {
  TixkitActivityMetricsInterceptor,
  deleteWorkerMetricsGrouping,
  startMigrationProgressAgeRefresh,
  startWorkerObservability,
} from './observability.js';
import { createWorkflowExporterSink } from './otel-workflow-exporter.js';
import { registerMigrationActivityService } from './activities/migration.js';
import { createRepositoryMigrationActivityService } from './activities/migration-repository-service.js';
import { createProductionMigrationCommitters } from './activities/migration-domain-committers.js';
import { BindingRegistryMigrationCredentialResolver } from './activities/migration-credential-resolver.js';
import {
  createMigrationPreparationService,
  migrationCursorKeyringFromEnvironment,
  registerMigrationPreparationService,
} from './activities/migration-preparation.js';

const require = createRequire(import.meta.url);

type SchedulerConnection = {
  close(): Promise<void> | void;
};

type SchedulerClient = {
  workflow: {
    start(
      workflow: typeof holdExpirationWorkflow | typeof providerEventRecoveryWorkflow,
      options: {
        taskQueue: string;
        workflowId: string;
        args: [{ version: number }];
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
  return ensureScheduledWorkflow({
    ...options,
    workflow: holdExpirationWorkflow,
    workflowId: options.workflowId ?? holdExpirationWorkflowId(),
    version: HOLD_EXPIRATION_WORKFLOW_VERSION,
  });
}

export async function ensureProviderEventRecoveryScheduler(
  options: EnsureHoldExpirationSchedulerOptions = {},
): Promise<'started' | 'already_started'> {
  return ensureScheduledWorkflow({
    ...options,
    workflow: providerEventRecoveryWorkflow,
    workflowId: options.workflowId ?? providerEventRecoveryWorkflowId(),
    version: PROVIDER_EVENT_RECOVERY_WORKFLOW_VERSION,
  });
}

async function ensureScheduledWorkflow(
  options: EnsureHoldExpirationSchedulerOptions & {
    workflow: typeof holdExpirationWorkflow | typeof providerEventRecoveryWorkflow;
    workflowId: string;
    version: number;
  },
): Promise<'started' | 'already_started'> {
  const clientConnection =
    options.connect === undefined
      ? await Connection.connect(temporalConnectionOptions(config.temporalAddress))
      : await options.connect();

  try {
    const client =
      options.createClient?.(clientConnection) ??
      new Client({
        connection: clientConnection as Connection,
        namespace: config.temporalNamespace,
      });
    try {
      await client.workflow.start(options.workflow, {
        taskQueue: options.taskQueue ?? config.temporalTaskQueue,
        workflowId: options.workflowId,
        args: [{ version: options.version }],
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
  const migrationCursorKeyring = migrationCursorKeyringFromEnvironment();
  const startupDb = createDb(config.databaseUrl);
  try {
    await assertSandboxRuntimeBinding(startupDb, {
      runtimeMode: process.env.TIXKIT_RUNTIME_MODE,
      epoch: process.env.TIXKIT_SANDBOX_EPOCH,
      taskQueues: config.temporalWorkerTaskQueues,
    });
  } finally {
    await startupDb.destroy();
  }
  const observability = await startWorkerObservability();
  const activityDb = createDb(config.databaseUrl);
  const stopMigrationProgressAgeRefresh = startMigrationProgressAgeRefresh(
    observability.metrics,
    activityDb,
  );
  const migrationCredentialResolver = new BindingRegistryMigrationCredentialResolver();
  const unregisterMigrationService = registerMigrationActivityService(
    createRepositoryMigrationActivityService(
      activityDb,
      createProductionMigrationCommitters(activityDb),
      migrationCredentialResolver,
    ),
  );
  const unregisterMigrationPreparationService = registerMigrationPreparationService(
    createMigrationPreparationService(activityDb, migrationCredentialResolver, {
      cursorEncryptionKeyring: {
        currentKeyId: migrationCursorKeyring.currentKeyId,
        keys: Object.fromEntries(
          Object.entries(migrationCursorKeyring.keys).map(([keyId, key]) => [
            keyId,
            key.toString('base64'),
          ]),
        ),
      },
    }),
  );
  const connection = await NativeConnection.connect(
    temporalConnectionOptions(config.temporalAddress),
  );
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
      (ctx) => ({
        inbound: new TixkitActivityMetricsInterceptor(ctx, observability.metrics),
      }),
    ];
    if (!tracingDisabled) {
      try {
        const { OpenTelemetryActivityInboundInterceptor } =
          await import('@temporalio/interceptors-opentelemetry');
        activityInterceptors.unshift((ctx) => ({
          inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
        }));
      } catch (err) {
        if (process.env.NODE_ENV === 'production') {
          throw err;
        }
      }
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
          : {
              workflowModules: [require.resolve('./workflows/otel-interceptors.js')],
            }),
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

    const schedulerEpoch =
      process.env.TIXKIT_RUNTIME_MODE === 'sandbox' ? process.env.TIXKIT_SANDBOX_EPOCH : undefined;
    await ensureHoldExpirationScheduler({
      workflowId: holdExpirationWorkflowId(schedulerEpoch),
    });
    await ensureProviderEventRecoveryScheduler({
      workflowId: providerEventRecoveryWorkflowId(schedulerEpoch),
    });

    const workerRuns = workers.map((worker) => worker.run());
    const writeHeartbeat = () =>
      writeFile(
        '/tmp/tixkit-worker-ready',
        `${JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() })}\n`,
        { mode: 0o600 },
      );
    await writeHeartbeat();
    const heartbeat = setInterval(
      () => void writeHeartbeat().catch((error) => console.error('Worker heartbeat failed', error)),
      5_000,
    );
    console.log(`TIXKIT_WORKER_READY taskQueues=${config.temporalWorkerTaskQueues.join(',')}`);
    try {
      await Promise.all(workerRuns);
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await rm('/tmp/tixkit-worker-ready', { force: true });
    stopMigrationProgressAgeRefresh();
    await deleteWorkerMetricsGrouping();
    unregisterMigrationPreparationService();
    unregisterMigrationService();
    await activityDb.destroy();
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
