import { Connection, Client } from '@temporalio/client';
import {
  checkoutSessionWorkflow,
  paymentReconciliationWorkflow,
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
  CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
  WEBHOOK_DELIVERY_WORKFLOW_VERSION,
  EXPORT_WORKFLOW_VERSION,
  checkoutWorkflowId,
  refundWorkflowId,
  paymentReconciliationWorkflowId,
  clerkIdentitySyncWorkflowId,
  webhookDeliveryWorkflowId,
  exportWorkflowId,
  notificationWorkflowId,
  smsDeliveryWorkflowId,
  holdExpirationWorkflowId,
  type CheckoutSessionWorkflowInput,
  type PaymentReconciliationWorkflowInput,
  type RefundWorkflowInput,
  type ClerkIdentitySyncWorkflowInput,
  type WebhookDeliveryWorkflowInput,
  type ExportWorkflowInput,
  type NotificationDeliveryWorkflowInput,
  type SmsDeliveryWorkflowInput,
  type CheckoutState,
} from '@gatekit/workflows';
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
    const client = new Client({
      connection,
      namespace: config.temporalNamespace,
    });
    return new TemporalClient(client);
  }

  async startCheckoutSession(input: Omit<CheckoutSessionWorkflowInput, 'version'> & { holdId: string }) {
    const workflowId = checkoutWorkflowId(input.checkoutSessionId);
    try {
      return await this.client.workflow.start(checkoutSessionWorkflow, {
        taskQueue: 'gatekit',
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

  async getCheckoutState(workflowId: string) {
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
        taskQueue: 'gatekit',
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
        taskQueue: 'gatekit',
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
    const workflowId = clerkIdentitySyncWorkflowId(input.clerkUserId ?? input.clerkOrgId ?? 'unknown');
    return this.client.workflow.start(clerkIdentitySyncWorkflow, {
      taskQueue: 'gatekit',
      workflowId,
      args: [
        {
          version: CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
          ...input,
        } satisfies ClerkIdentitySyncWorkflowInput,
      ],
    });
  }

  async startWebhookDelivery(input: Omit<WebhookDeliveryWorkflowInput, 'version'>) {
    const workflowId = webhookDeliveryWorkflowId(input.eventId, input.endpointId);
    return this.client.workflow.start(webhookDeliveryWorkflow, {
      taskQueue: 'gatekit',
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
    return this.client.workflow.start(exportWorkflow, {
      taskQueue: 'gatekit',
      workflowId,
      args: [
        {
          version: EXPORT_WORKFLOW_VERSION,
          ...input,
        } satisfies ExportWorkflowInput,
      ],
    });
  }

  async waitForExport(exportId: string): Promise<{ status: string; fileUrl?: string }> {
    const handle = this.client.workflow.getHandle(exportWorkflowId(exportId));
    return handle.result();
  }

  async startNotificationDelivery(input: Omit<NotificationDeliveryWorkflowInput, 'version'>) {
    const workflowId = notificationWorkflowId(input.jobId);
    try {
      return await this.client.workflow.start(notificationDeliveryWorkflow, {
        taskQueue: 'gatekit',
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
        taskQueue: 'gatekit',
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
        taskQueue: 'gatekit',
        workflowId,
      });
    } catch (err) {
      if (isWorkflowAlreadyStartedError(err)) {
        return this.client.workflow.getHandle(workflowId);
      }
      throw err;
    }
  }
}

function isWorkflowAlreadyStartedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'WorkflowExecutionAlreadyStartedError' || err.message.includes('Workflow execution already started');
}
