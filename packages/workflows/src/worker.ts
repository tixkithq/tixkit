import { Worker, NativeConnection } from '@temporalio/worker';
import { Connection, Client } from '@temporalio/client';
import { createRequire } from 'node:module';
import { config } from './config.js';
import * as allActivities from './activities/index.js';
import { holdExpirationWorkflow } from './workflows/index.js';
import { holdExpirationWorkflowId } from './shared/types.js';
import { buildWorkerStartupFailureMessage } from './startup-diagnostics.js';

const require = createRequire(import.meta.url);

async function runWorker(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  });

  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: 'gatekit',
    workflowsPath: require.resolve('./workflows/index.js'),
    activities: allActivities,
  });

  // Start the hold-expiration workflow on worker boot if not already running.
  // This is a long-running workflow that periodically expires stale holds.
  try {
    const clientConnection = await Connection.connect({ address: config.temporalAddress });
    const client = new Client({ connection: clientConnection, namespace: config.temporalNamespace });
    const workflowId = holdExpirationWorkflowId();
    try {
      await client.workflow.start(holdExpirationWorkflow, {
        taskQueue: 'gatekit',
        workflowId,
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
