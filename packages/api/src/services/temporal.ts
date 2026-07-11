import { Connection, Client } from '@temporalio/client';
import {
  checkoutSessionWorkflow,
  paymentReconciliationWorkflow,
  privacyRequestWorkflow,
  refundWorkflow,
  clerkIdentitySyncWorkflow,
  webhookDeliveryWorkflow,
  exportWorkflow,
  notificationDeliveryWorkflow,
  smsDeliveryWorkflow,
  holdExpirationWorkflow,
  paymentSucceededSignal,
  paymentFailedSignal,
  getCheckoutStateQuery,
  CHECKOUT_WORKFLOW_VERSION,
  REFUND_WORKFLOW_VERSION,
  NOTIFICATION_WORKFLOW_VERSION,
  SMS_DELIVERY_WORKFLOW_VERSION,
  PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
  PRIVACY_REQUEST_WORKFLOW_VERSION,
  CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
  WEBHOOK_DELIVERY_WORKFLOW_VERSION,
  EXPORT_WORKFLOW_VERSION,
  checkoutWorkflowId,
  refundWorkflowId,
  paymentReconciliationWorkflowId,
  privacyRequestWorkflowId,
  clerkIdentitySyncWorkflowId,
  webhookDeliveryWorkflowId,
  webhookDeliveryReplayWorkflowId,
  exportWorkflowId,
  notificationWorkflowId,
  smsDeliveryWorkflowId,
  holdExpirationWorkflowId,
  HOLD_EXPIRATION_WORKFLOW_VERSION,
  type CheckoutSessionWorkflowInput,
  type PaymentReconciliationWorkflowInput,
  type PrivacyRequestWorkflowInput,
  type RefundWorkflowInput,
  type ClerkIdentitySyncWorkflowInput,
  type WebhookDeliveryWorkflowInput,
  type ExportWorkflowInput,
  type NotificationDeliveryWorkflowInput,
  type SmsDeliveryWorkflowInput,
  type CheckoutState,
  migrationCommitWorkflow,
  migrationRollbackWorkflow,
  migrationPreparationWorkflow,
  migrationCommitWorkflowId,
  migrationRollbackWorkflowId,
  migrationPreparationWorkflowId,
  MIGRATION_COMMIT_WORKFLOW_VERSION,
  MIGRATION_ROLLBACK_WORKFLOW_VERSION,
  MIGRATION_PREPARATION_WORKFLOW_VERSION,
  pauseMigrationPreparationSignal,
  resumeMigrationPreparationSignal,
  cancelMigrationPreparationSignal,
  pauseMigrationSignal,
  resumeMigrationSignal,
  cancelMigrationSignal,
  requestMigrationRollbackSignal,
  getMigrationStateQuery,
  type MigrationWorkflowInput,
  type MigrationWorkflowState,
  type MigrationRollbackWorkflowInput,
  type MigrationPreparationWorkflowInput,
} from '@tixkit/workflows';
import { config } from '../config/index.js';

export type { CheckoutState };

export class TemporalClient {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  static async connect(): Promise<TemporalClient> {
    const connection = await Connection.connect({
      address: config.temporalAddress,
    });
    const workflowInterceptors = await createWorkflowClientInterceptors();
    const client = new Client({
      connection,
      namespace: config.temporalNamespace,
      ...(workflowInterceptors.length > 0
        ? {
            interceptors: {
              workflow: workflowInterceptors,
            },
          }
        : {}),
    });
    return new TemporalClient(client);
  }

  async startCheckoutSession(input: Omit<CheckoutSessionWorkflowInput, 'version'>) {
    const workflowId = checkoutWorkflowId(input.checkoutSessionId);
    try {
      return await this.client.workflow.start(checkoutSessionWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: CHECKOUT_WORKFLOW_VERSION,
            ...input,
          } satisfies CheckoutSessionWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async getCheckoutState(workflowId: string): Promise<CheckoutState> {
    const handle = this.client.workflow.getHandle(workflowId);
    return handle.query(getCheckoutStateQuery);
  }

  async signalPaymentSucceeded(sessionId: string, providerIntentId: string) {
    const handle = this.client.workflow.getHandle(checkoutWorkflowId(sessionId));
    await handle.signal(paymentSucceededSignal, providerIntentId);
  }

  async signalPaymentFailed(sessionId: string, errorMessage: string) {
    const handle = this.client.workflow.getHandle(checkoutWorkflowId(sessionId));
    await handle.signal(paymentFailedSignal, errorMessage);
  }

  async startRefund(input: Omit<RefundWorkflowInput, 'version'>) {
    const workflowId = refundWorkflowId(input.orderId, input.nonce);
    try {
      return await this.client.workflow.start(refundWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: REFUND_WORKFLOW_VERSION,
            ...input,
          } satisfies RefundWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startPaymentReconciliation(input: Omit<PaymentReconciliationWorkflowInput, 'version'>) {
    const workflowId = paymentReconciliationWorkflowId(input.providerEventId);
    try {
      return await this.client.workflow.start(paymentReconciliationWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
            ...input,
          } satisfies PaymentReconciliationWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startClerkIdentitySync(input: Omit<ClerkIdentitySyncWorkflowInput, 'version'>) {
    const workflowId = clerkIdentitySyncWorkflowId(input.providerEventId);
    try {
      return await this.client.workflow.start(clerkIdentitySyncWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
            ...input,
          } satisfies ClerkIdentitySyncWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startWebhookDelivery(
    input: Omit<WebhookDeliveryWorkflowInput, 'version'> & {
      replayNonce?: string;
    },
  ) {
    const baseWorkflowId = webhookDeliveryWorkflowId(input.eventId, input.endpointId);
    const workflowId = input.replayNonce
      ? webhookDeliveryReplayWorkflowId(input.eventId, input.endpointId, input.replayNonce)
      : baseWorkflowId;
    return this.client.workflow.start(webhookDeliveryWorkflow, {
      taskQueue: config.temporalTaskQueue,
      workflowId,
      args: [
        {
          version: WEBHOOK_DELIVERY_WORKFLOW_VERSION,
          ...input,
        } satisfies WebhookDeliveryWorkflowInput,
      ],
    });
  }

  async startExport(input: Omit<ExportWorkflowInput, 'version'>) {
    const workflowId = exportWorkflowId(input.exportId);
    try {
      return await this.client.workflow.start(exportWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: EXPORT_WORKFLOW_VERSION,
            ...input,
          } satisfies ExportWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async waitForExport(exportId: string): Promise<{ status: string }> {
    const handle = this.client.workflow.getHandle(exportWorkflowId(exportId));
    return handle.result();
  }

  async startPrivacyRequest(input: Omit<PrivacyRequestWorkflowInput, 'version'>) {
    const workflowId = privacyRequestWorkflowId(input.requestId);
    try {
      return await this.client.workflow.start(privacyRequestWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: PRIVACY_REQUEST_WORKFLOW_VERSION,
            ...input,
          } satisfies PrivacyRequestWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startNotificationDelivery(input: Omit<NotificationDeliveryWorkflowInput, 'version'>) {
    const workflowId = notificationWorkflowId(input.jobId);
    try {
      return await this.client.workflow.start(notificationDeliveryWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: NOTIFICATION_WORKFLOW_VERSION,
            ...input,
          } satisfies NotificationDeliveryWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startSmsDelivery(input: Omit<SmsDeliveryWorkflowInput, 'version'>) {
    const workflowId = smsDeliveryWorkflowId(input.jobId);
    try {
      return await this.client.workflow.start(smsDeliveryWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [
          {
            version: SMS_DELIVERY_WORKFLOW_VERSION,
            ...input,
          } satisfies SmsDeliveryWorkflowInput,
        ],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startHoldExpiration() {
    const workflowId = holdExpirationWorkflowId();
    try {
      return await this.client.workflow.start(holdExpirationWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [{ version: HOLD_EXPIRATION_WORKFLOW_VERSION }],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }

  async startMigrationCommit(input: Omit<MigrationWorkflowInput, 'version'>) {
    const workflowId = migrationCommitWorkflowId(input.tenantId, input.organizationId, input.jobId);
    try {
      return await this.client.workflow.start(migrationCommitWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [{ version: MIGRATION_COMMIT_WORKFLOW_VERSION, ...input }],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) return this.client.workflow.getHandle(workflowId);
      throw err;
    }
  }

  async startMigrationPreparation(input: Omit<MigrationPreparationWorkflowInput, 'version'>) {
    const workflowId = migrationPreparationWorkflowId(
      input.tenantId,
      input.organizationId,
      input.jobId,
    );
    try {
      return await this.client.workflow.start(migrationPreparationWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [{ version: MIGRATION_PREPARATION_WORKFLOW_VERSION, ...input }],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) return this.client.workflow.getHandle(workflowId);
      throw err;
    }
  }

  async signalMigrationPreparation(
    tenantId: string,
    organizationId: string,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    const handle = this.client.workflow.getHandle(
      migrationPreparationWorkflowId(tenantId, organizationId, jobId),
    );
    await handle.signal(
      action === 'pause'
        ? pauseMigrationPreparationSignal
        : action === 'resume'
          ? resumeMigrationPreparationSignal
          : cancelMigrationPreparationSignal,
    );
  }

  async startMigrationRollback(input: Omit<MigrationRollbackWorkflowInput, 'version'>) {
    const workflowId = migrationRollbackWorkflowId(
      input.tenantId,
      input.organizationId,
      input.jobId,
    );
    try {
      return await this.client.workflow.start(migrationRollbackWorkflow, {
        taskQueue: config.temporalTaskQueue,
        workflowId,
        args: [{ version: MIGRATION_ROLLBACK_WORKFLOW_VERSION, ...input }],
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) return this.client.workflow.getHandle(workflowId);
      throw err;
    }
  }

  async signalMigration(
    tenantId: string,
    organizationId: string,
    jobId: string,
    action: 'pause' | 'resume' | 'cancel' | 'rollback',
  ): Promise<void> {
    const handle = this.client.workflow.getHandle(
      migrationCommitWorkflowId(tenantId, organizationId, jobId),
    );
    const signal = {
      pause: pauseMigrationSignal,
      resume: resumeMigrationSignal,
      cancel: cancelMigrationSignal,
      rollback: requestMigrationRollbackSignal,
    }[action];
    await handle.signal(signal);
  }

  getMigrationState(
    tenantId: string,
    organizationId: string,
    jobId: string,
  ): Promise<MigrationWorkflowState> {
    return this.client.workflow
      .getHandle(migrationCommitWorkflowId(tenantId, organizationId, jobId))
      .query(getMigrationStateQuery);
  }
}

async function createWorkflowClientInterceptors() {
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    return [];
  }

  try {
    const { OpenTelemetryWorkflowClientInterceptor } =
      await import('@temporalio/interceptors-opentelemetry');
    return [new OpenTelemetryWorkflowClientInterceptor()];
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      throw err;
    }
    return [];
  }
}

function isWorkflowAlreadyStartedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'WorkflowExecutionAlreadyStartedError' ||
    err.message.includes('Workflow execution already started')
  );
}
