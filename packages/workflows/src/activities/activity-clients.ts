import { Client, Connection } from '@temporalio/client';
import { createDb, EmailJobRepository, type Database } from '@tixkit/db';
import type { ProviderClientRuntime } from '@tixkit/provider-clients';
import { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } from '../shared/types.js';
import { notificationDeliveryWorkflow } from '../workflows/notification.js';
import type { NotificationDeliveryWorkflowInput } from '../workflows/notification.js';
import { temporalConnectionOptions } from '../temporal-connection.js';
import { createProviderIncidentEvidenceRuntime } from '../services/provider-incident-evidence.js';

type TemporalConnection = Awaited<ReturnType<typeof Connection.connect>>;

let cachedNotificationConnection: TemporalConnection | null = null;
let cachedNotificationClient: Client | null = null;
let notificationClientPromise: Promise<Client> | null = null;
let cachedDb: Database | null = null;
let cachedProviderClientRuntime: ProviderClientRuntime | null = null;

export type EmailJobNotificationHandoffRow = {
  id: string;
  tenant_id: string;
  brand_id: string;
  template_key: string;
  template_version_id: string;
  to_email: string;
  to_name?: string | null;
  variables: unknown;
  provider_route_id: string;
  status: string;
  workflow_id?: string | null;
  scheduled_at?: Date | string | null;
};

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

  notificationClientPromise = Connection.connect(temporalConnectionOptions(temporalAddress()))
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

export function getActivityProviderClientRuntime(): ProviderClientRuntime {
  cachedProviderClientRuntime ??=
    createProviderIncidentEvidenceRuntime(getActivityDb()).providerClientRuntime;
  return cachedProviderClientRuntime;
}

export async function startNotificationDeliveryWorkflow(
  input: Omit<NotificationDeliveryWorkflowInput, 'version'>,
): Promise<string> {
  const workflowId = notificationWorkflowId(input.jobId);
  try {
    const client = await getNotificationTemporalClient();
    await client.workflow.start(notificationDeliveryWorkflow, {
      taskQueue: temporalTaskQueue(),
      workflowId,
      args: [{ version: NOTIFICATION_WORKFLOW_VERSION, ...input }],
    });
    return workflowId;
  } catch (err) {
    if (isWorkflowAlreadyStartedError(err)) {
      return workflowId;
    }
    throw err;
  }
}

function parseEmailJobVariables(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function notificationTypeFromVariables(
  variables: Record<string, unknown>,
): NotificationDeliveryWorkflowInput['notificationType'] {
  const value = variables.notificationType;
  if (value === 'bulk' || value === 'staff' || value === 'system') return value;
  return 'transactional';
}

export async function durablyStartNotificationDeliveryWorkflow(
  db: Database,
  input: Omit<NotificationDeliveryWorkflowInput, 'version'>,
): Promise<void> {
  const jobRepo = new EmailJobRepository(db);
  try {
    const workflowId = await startNotificationDeliveryWorkflow(input);
    await jobRepo.update(input.jobId, { status: 'queued', workflow_id: workflowId });
  } catch (err) {
    await jobRepo.update(input.jobId, { status: 'start_failed', workflow_id: null });
    throw err;
  }
}

export async function restartQueuedNotificationDeliveryWorkflow(
  db: Database,
  job: EmailJobNotificationHandoffRow,
): Promise<void> {
  if ((job.status !== 'queued' && job.status !== 'start_failed') || job.workflow_id) return;
  const variables = parseEmailJobVariables(job.variables);
  await durablyStartNotificationDeliveryWorkflow(db, {
    jobId: job.id,
    tenantId: job.tenant_id,
    brandId: job.brand_id,
    templateKey: job.template_key,
    templateVersionId: job.template_version_id,
    toEmail: job.to_email,
    toName: job.to_name ?? undefined,
    variables,
    providerRouteId: job.provider_route_id,
    notificationType: notificationTypeFromVariables(variables),
    scheduledAt: job.scheduled_at ? new Date(job.scheduled_at).toISOString() : undefined,
  });
}

export async function closeActivityClients(): Promise<void> {
  const connection = cachedNotificationConnection;
  const db = cachedDb;
  cachedNotificationConnection = null;
  cachedNotificationClient = null;
  notificationClientPromise = null;
  cachedDb = null;
  cachedProviderClientRuntime = null;
  await Promise.all([connection?.close(), db?.destroy()]);
}
