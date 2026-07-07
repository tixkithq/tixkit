import { Client, Connection } from '@temporalio/client';
import { createDb, type Database } from '@tixkit/db';
import { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } from '../shared/types.js';
import { notificationDeliveryWorkflow } from '../workflows/notification.js';
import type { NotificationDeliveryWorkflowInput } from '../workflows/notification.js';

type TemporalConnection = Awaited<ReturnType<typeof Connection.connect>>;

let cachedNotificationConnection: TemporalConnection | null = null;
let cachedNotificationClient: Client | null = null;
let notificationClientPromise: Promise<Client> | null = null;
let cachedDb: Database | null = null;

function temporalAddress(): string {
  return process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
}

function temporalNamespace(): string {
  return process.env.TEMPORAL_NAMESPACE ?? 'default';
}

function temporalTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit';
}

function isWorkflowAlreadyStartedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'WorkflowExecutionAlreadyStartedError' || err.message.includes('already started'))
  );
}

async function getNotificationTemporalClient(): Promise<Client> {
  if (cachedNotificationClient) return cachedNotificationClient;
  if (notificationClientPromise) return notificationClientPromise;

  notificationClientPromise = Connection.connect({ address: temporalAddress() })
    .then((connection) => {
      cachedNotificationConnection = connection;
      cachedNotificationClient = new Client({
        connection,
        namespace: temporalNamespace(),
      });
      return cachedNotificationClient;
    })
    .finally(() => {
      notificationClientPromise = null;
    });

  return notificationClientPromise;
}

export function getActivityDb(): Database {
  cachedDb ??= createDb();
  return cachedDb;
}

export async function startNotificationDeliveryWorkflow(
  input: Omit<NotificationDeliveryWorkflowInput, 'version'>,
): Promise<void> {
  try {
    const client = await getNotificationTemporalClient();
    await client.workflow.start(notificationDeliveryWorkflow, {
      taskQueue: temporalTaskQueue(),
      workflowId: notificationWorkflowId(input.jobId),
      args: [{ version: NOTIFICATION_WORKFLOW_VERSION, ...input }],
    });
  } catch (err) {
    if (!isWorkflowAlreadyStartedError(err)) {
      // Non-fatal: the email job row is queued and a poller or manual retry can drain it.
    }
  }
}

export async function closeActivityClients(): Promise<void> {
  const connection = cachedNotificationConnection;
  const db = cachedDb;
  cachedNotificationConnection = null;
  cachedNotificationClient = null;
  notificationClientPromise = null;
  cachedDb = null;
  await Promise.all([connection?.close(), db?.destroy()]);
}
