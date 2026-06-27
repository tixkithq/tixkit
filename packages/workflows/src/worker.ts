import { Worker, NativeConnection } from '@temporalio/worker';
import { Connection, Client } from '@temporalio/client';
import { OpenTelemetryActivityInboundInterceptor } from '@temporalio/interceptors-opentelemetry';
import { createTelemetryResource, createTraceExporter } from '@tixkit/shared';
import { createRequire } from 'node:module';
import { config } from './config.js';
import * as allActivities from './activities/index.js';
import { holdExpirationWorkflow } from './workflows/index.js';
import { holdExpirationWorkflowId, HOLD_EXPIRATION_WORKFLOW_VERSION } from './shared/types.js';
import { buildWorkerStartupFailureMessage } from './startup-diagnostics.js';
import { TixkitActivityMetricsInterceptor, startWorkerObservability } from './observability.js';
import { createWorkflowExporterSink } from './otel-workflow-exporter.js';

const require = createRequire(import.meta.url);

async function runWorker(): Promise<void> {
  const observability = startWorkerObservability();
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });
  const telemetryResource = createTelemetryResource({
    serviceName: 'tixkit-worker',
    serviceVersion: process.env.npm_package_version,
    environment: process.env.NODE_ENV ?? 'development',
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });
  const workflowTraceExporter = createTraceExporter({ serviceName: 'tixkit-worker' });

  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.temporalTaskQueue,
    workflowsPath: require.resolve('./workflows/index.js'),
    activities: allActivities,
    enableSDKTracing: true,
    sinks: {
      exporter: createWorkflowExporterSink(workflowTraceExporter, telemetryResource),
    },
    interceptors: {
      workflowModules: [require.resolve('./workflows/otel-interceptors.js')],
      activity: [
        (ctx) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx) }),
        (ctx) => ({ inbound: new TixkitActivityMetricsInterceptor(ctx, observability.metrics) }),
      ],
    },
  });

  // Start the hold-expiration workflow on worker boot if not already running.
  // This is a long-running workflow that periodically expires stale holds.
  try {
    const clientConnection = await Connection.connect({ address: config.temporalAddress });
    const client = new Client({ connection: clientConnection, namespace: config.temporalNamespace });
    const workflowId = holdExpirationWorkflowId();
    try {
      await client.workflow.start(holdExpirationWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [{ version: HOLD_EXPIRATION_WORKFLOW_VERSION }],
      });
    } catch (err) {
      // Already running is fine.
      if (!(err instanceof Error && (err.name === 'WorkflowExecutionAlreadyStartedError' || err.message.includes('already started')))) {
        throw err;
      }
    }
  } catch {
    // Non-fatal: hold expiration also runs via lazy cleanup in checkout activities.
  }

  await worker.run();
}

runWorker().catch((err) => {
  console.error(buildWorkerStartupFailureMessage(err));
  process.exit(1);
});
