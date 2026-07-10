import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  sendEmailActivity,
  sendSmsActivity,
  checkSuppressionActivity,
  checkConsentActivity,
  renderTemplateActivity,
  markEmailJobSuppressedActivity,
  markEmailJobFailedActivity,
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
  markEmailJobSuppressedActivity(input: {
    jobId: string;
    tenantId: string;
    reason: 'suppression' | 'consent';
  }): Promise<WorkflowActivityResult<{ suppressed: true }>>;
  markEmailJobFailedActivity(input: {
    jobId: string;
    tenantId: string;
    activityContext: string;
    errorCode: string;
    message: string;
  }): Promise<WorkflowActivityResult<{ failed: true; errorCode: string; message: string }>>;
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

async function handleEmailDeliveryActivityFailure(
  input: Pick<NotificationDeliveryWorkflowInput, 'jobId' | 'tenantId'>,
  activityContext: string,
  result: Extract<WorkflowActivityResult<unknown>, { ok: false }>,
): Promise<{ status: 'failed' }> {
  if (result.retryable) {
    throw new Error(`${activityContext} failed (${result.errorCode}): ${result.message}`);
  }

  const markResult = await markEmailJobFailedActivity({
    jobId: input.jobId,
    tenantId: input.tenantId,
    activityContext,
    errorCode: result.errorCode,
    message: result.message,
  });

  if (!markResult.ok) {
    return handleDeliveryActivityFailure('Email failure status update', markResult);
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
    return handleEmailDeliveryActivityFailure(input, 'Email suppression check', suppressionResult);
  }

  if (suppressionResult.value.suppressed && input.notificationType !== 'transactional') {
    const markResult = await markEmailJobSuppressedActivity({
      jobId: input.jobId,
      tenantId: input.tenantId,
      reason: 'suppression',
    });
    if (!markResult.ok) {
      return handleEmailDeliveryActivityFailure(
        input,
        'Email suppression status update',
        markResult,
      );
    }
    return { status: 'suppressed' };
  }

  // Marketing consent is required only for bulk lifecycle messages. Staff and
  // system lifecycle emails (such as account invitations) are operational.
  if (input.notificationType === 'bulk') {
    const consentResult = await checkConsentActivity({
      email: input.toEmail,
      tenantId: input.tenantId,
      notificationType: input.notificationType,
    });

    if (!consentResult.ok) {
      return handleEmailDeliveryActivityFailure(input, 'Email consent check', consentResult);
    }

    if (!consentResult.value.allowed) {
      const markResult = await markEmailJobSuppressedActivity({
        jobId: input.jobId,
        tenantId: input.tenantId,
        reason: 'consent',
      });
      if (!markResult.ok) {
        return handleEmailDeliveryActivityFailure(
          input,
          'Email suppression status update',
          markResult,
        );
      }
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
    return handleEmailDeliveryActivityFailure(input, 'Email render', renderResult);
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
    return handleEmailDeliveryActivityFailure(input, 'Email delivery', sendResult);
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
