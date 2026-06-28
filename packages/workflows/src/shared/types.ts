export type WorkflowActivityResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: string; retryable: boolean; message: string };

export function okResult<T>(value: T): WorkflowActivityResult<T> {
  return { ok: true, value };
}

export function errResult(
  errorCode: string,
  message: string,
  retryable = false,
): WorkflowActivityResult<never> {
  return { ok: false, errorCode, message, retryable };
}

// Workflow input versions - must be versioned because workflows persist across deploys
export const CHECKOUT_WORKFLOW_VERSION = 1;
export const REFUND_WORKFLOW_VERSION = 1;
export const NOTIFICATION_WORKFLOW_VERSION = 1;
export const SMS_DELIVERY_WORKFLOW_VERSION = 1;
export const WEBHOOK_DELIVERY_WORKFLOW_VERSION = 1;
export const HOLD_EXPIRATION_WORKFLOW_VERSION = 1;
export const EXPORT_WORKFLOW_VERSION = 1;
export const CLERK_IDENTITY_SYNC_WORKFLOW_VERSION = 1;
export const PAYMENT_RECONCILIATION_WORKFLOW_VERSION = 1;
export const PRIVACY_REQUEST_WORKFLOW_VERSION = 1;

// Workflow ID conventions
export function checkoutWorkflowId(sessionId: string): string {
  return `checkout-session:${sessionId}`;
}

export function refundWorkflowId(orderId: string, nonce: string): string {
  return `order-refund:${orderId}:${nonce}`;
}

export function webhookDeliveryWorkflowId(eventId: string, endpointId: string): string {
  return `webhook-delivery:${eventId}:${endpointId}`;
}

export function webhookDeliveryReplayWorkflowId(
  eventId: string,
  endpointId: string,
  replayNonce: string,
): string {
  return `webhook-delivery:${eventId}:${endpointId}:replay:${replayNonce}`;
}

export function notificationWorkflowId(jobId: string): string {
  return `notification:${jobId}`;
}

export function smsDeliveryWorkflowId(jobId: string): string {
  return `sms-delivery:${jobId}`;
}

export function exportWorkflowId(exportId: string): string {
  return `export:${exportId}`;
}

export function holdExpirationWorkflowId(): string {
  return `hold-expiration:scheduled`;
}

export function clerkIdentitySyncWorkflowId(providerEventId: string): string {
  return `clerk-identity-sync:${providerEventId}`;
}

export function paymentReconciliationWorkflowId(providerEventId: string): string {
  return `payment-reconciliation:${providerEventId}`;
}

export function privacyRequestWorkflowId(requestId: string): string {
  return `privacy-request:${requestId}`;
}
