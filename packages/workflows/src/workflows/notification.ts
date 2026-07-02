import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  sendEmailActivity,
  sendSmsActivity,
  checkSuppressionActivity,
  checkConsentActivity,
  renderTemplateActivity,
} = proxyActivities<{
  sendEmailActivity(input: {
    jobId: string;
    providerRouteId: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>>;
  sendSmsActivity(input: {
    jobId: string;
    providerRouteId: string;
    notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
  }): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>>;
  checkSuppressionActivity(input: {
    email: string;
    tenantId: string;
  }): Promise<WorkflowActivityResult<{ suppressed: boolean }>>;
  checkConsentActivity(input: {
    email: string;
    tenantId: string;
    notificationType: string;
  }): Promise<WorkflowActivityResult<{ allowed: boolean }>>;
  renderTemplateActivity(input: {
    tenantId?: string;
    brandId?: string;
    channel?: 'email' | 'sms';
    templateKey: string;
    templateVersionId: string;
    variables: Record<string, unknown>;
    optOutToken?: string;
  }): Promise<
    WorkflowActivityResult<{ subject: string; html: string; text?: string; segments?: number }>
  >;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

export type NotificationDeliveryWorkflowInput = {
  version: number;
  jobId: string;
  tenantId: string;
  brandId: string;
  templateKey: string;
  templateVersionId: string;
  toEmail: string;
  toName?: string;
  variables: Record<string, unknown>;
  providerRouteId: string;
  notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
  scheduledAt?: string;
};

export type SmsDeliveryWorkflowInput = {
  version: number;
  jobId: string;
  tenantId: string;
  brandId: string;
  providerRouteId: string;
  notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
  scheduledAt?: string;
};

async function waitForSchedule(scheduledAt?: string) {
  if (!scheduledAt) return;
  const delayMs = new Date(scheduledAt).getTime() - Date.now();
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

function handleDeliveryActivityFailure(
  activityContext: string,
  result: Extract<WorkflowActivityResult<unknown>, { ok: false }>,
): { status: 'failed' } {
  if (result.retryable) {
    throw new Error(`${activityContext} failed (${result.errorCode}): ${result.message}`);
  }

  return { status: 'failed' };
}

function handleSmsDeliveryActivityFailure(
  result: Extract<WorkflowActivityResult<unknown>, { ok: false }>,
): { status: 'failed' | 'suppressed' } {
  if (result.errorCode === 'SMS_CONSENT_REQUIRED') {
    return { status: 'suppressed' };
  }

  return handleDeliveryActivityFailure('SMS delivery', result);
}

export async function notificationDeliveryWorkflow(
  input: NotificationDeliveryWorkflowInput,
): Promise<{ status: string }> {
  await waitForSchedule(input.scheduledAt);

  // Step 1: Check suppression
  const suppressionResult = await checkSuppressionActivity({
    email: input.toEmail,
    tenantId: input.tenantId,
  });

  if (!suppressionResult.ok) {
    return handleDeliveryActivityFailure('Email suppression check', suppressionResult);
  }

  if (suppressionResult.value.suppressed && input.notificationType !== 'transactional') {
    return { status: 'suppressed' };
  }

  // Step 1b: Check consent for non-transactional sends
  if (input.notificationType !== 'transactional') {
    const consentResult = await checkConsentActivity({
      email: input.toEmail,
      tenantId: input.tenantId,
      notificationType: input.notificationType,
    });

    if (!consentResult.ok) {
      return handleDeliveryActivityFailure('Email consent check', consentResult);
    }

    if (!consentResult.value.allowed) {
      return { status: 'suppressed' };
    }
  }

  // Step 2: Render template
  const renderResult = await renderTemplateActivity({
    tenantId: input.tenantId,
    brandId: input.brandId,
    templateKey: input.templateKey,
    templateVersionId: input.templateVersionId,
    variables: input.variables,
  });

  if (!renderResult.ok) {
    return handleDeliveryActivityFailure('Email render', renderResult);
  }

  // Step 3: Send email with rendered content
  const sendResult = await sendEmailActivity({
    jobId: input.jobId,
    providerRouteId: input.providerRouteId,
    subject: renderResult.value.subject,
    html: renderResult.value.html,
    text: renderResult.value.text,
  });

  if (!sendResult.ok) {
    return handleDeliveryActivityFailure('Email delivery', sendResult);
  }

  return { status: 'sent' };
}

export async function smsDeliveryWorkflow(
  input: SmsDeliveryWorkflowInput,
): Promise<{ status: string }> {
  await waitForSchedule(input.scheduledAt);

  const sendResult = await sendSmsActivity({
    jobId: input.jobId,
    providerRouteId: input.providerRouteId,
    notificationType: input.notificationType,
  });

  if (!sendResult.ok) {
    return handleSmsDeliveryActivityFailure(sendResult);
  }

  return { status: 'sent' };
}
