import { createHash } from 'node:crypto';
import {
  ContentRepository,
  EmailProviderRouteRepository,
  BrandSenderIdentityRepository,
  EmailJobRepository,
  EmailDeliveryRepository,
  SmsProviderRouteRepository,
  SmsSenderIdentityRepository,
  SmsJobRepository,
  SmsDeliveryRepository,
  type Database,
} from '@tixkit/db';
import {
  buildEmailTransport,
  createDefaultEmailTransport,
  FallbackEmailTransport,
  TelnyxSmsTransport,
  TwilioSmsTransport,
  VonageSmsTransport,
  PlivoSmsTransport,
  CaptureSmsTransport,
  FallbackSmsTransport,
  ProviderRouteSelector,
  UnsupportedProviderRouteError,
  validateProviderFields,
} from '@tixkit/email-transport';
import {
  createDefaultEmailTemplateForKey,
  normalizeEmailTemplateDocument,
  renderEmailTemplate,
} from '@tixkit/content-email';
import { normalizeSmsTemplateDocument, renderSmsTemplate } from '@tixkit/content-message';
import type { EmailTransport, TemplateKey } from '@tixkit/domain';
import type { SmsTransport } from '@tixkit/domain/messaging';
import { ulid } from 'ulid';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import { getActivityDb } from './activity-clients.js';

type SendRenderOutput = {
  subject?: string;
  html?: string;
  text?: string;
  segments?: number;
};

function normalizeForChecksum(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForChecksum(item));
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys: string[] = [];
    for (const key of Object.keys(object)) {
      const index = keys.findIndex((candidate) => key.localeCompare(candidate) < 0);
      if (index === -1) {
        keys.push(key);
      } else {
        keys.splice(index, 0, key);
      }
    }
    return Object.fromEntries(keys.map((key) => [key, normalizeForChecksum(object[key])]));
  }
  return value;
}

function checksumRenderOutput(output: SendRenderOutput): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeForChecksum(output)))
    .digest('hex');
}

function parseJobVariables(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function recordSendRenderArtifact(input: {
  db: Database;
  tenantId: string;
  brandId: string;
  channel: 'email' | 'sms';
  versionId?: string | null;
  artifactRef: string;
  output: SendRenderOutput;
}): Promise<void> {
  if (!input.versionId) return;

  const contentRepo = new ContentRepository(input.db);
  const content = await contentRepo.findPublishedVersionById({
    tenantId: input.tenantId,
    brandId: input.brandId,
    versionId: input.versionId,
    channel: input.channel,
  });
  if (!content) return;

  await contentRepo.recordRenderArtifact({
    tenantId: input.tenantId,
    documentId: content.document.id,
    versionId: content.version.id,
    channel: input.channel,
    outputType: 'send',
    artifactRef: input.artifactRef,
    checksum: checksumRenderOutput(input.output),
  });
}

export async function checkSuppressionActivity(input: {
  email: string;
  tenantId: string;
}): Promise<WorkflowActivityResult<{ suppressed: boolean }>> {
  const db = getActivityDb();
  try {
    const suppression = await db
      .selectFrom('email_suppressions')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('email', '=', input.email)
      .executeTakeFirst();
    return okResult({ suppressed: !!suppression });
  } catch (err) {
    return errResult(
      'SUPPRESSION_CHECK_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function checkConsentActivity(input: {
  email: string;
  tenantId: string;
  notificationType: string;
}): Promise<WorkflowActivityResult<{ allowed: boolean }>> {
  const db = getActivityDb();
  try {
    // Only bulk marketing mail requires opt-in. Transactional, staff, and
    // system lifecycle messages are operational and must not depend on a
    // marketing-consent row existing for a new recipient.
    if (input.notificationType !== 'bulk') {
      return okResult({ allowed: true });
    }

    // Look up the most recent consent record for this email in the tenant.
    const consent = await db
      .selectFrom('message_consents')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('email', '=', input.email)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    // If no consent record exists, bulk sends are not allowed (opt-in required).
    if (!consent) {
      return okResult({ allowed: false });
    }

    // If consent was revoked, the send is not allowed.
    if (consent.revoked_at) {
      return okResult({ allowed: false });
    }

    // If email opt-in is false, the send is not allowed.
    if (!consent.email_opt_in) {
      return okResult({ allowed: false });
    }

    return okResult({ allowed: true });
  } catch (err) {
    return errResult(
      'CONSENT_CHECK_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function markEmailJobSuppressedActivity(input: {
  jobId: string;
  tenantId: string;
  reason: 'suppression' | 'consent';
}): Promise<WorkflowActivityResult<{ suppressed: true }>> {
  const db = getActivityDb();
  try {
    const jobRepo = new EmailJobRepository(db);
    const job = await jobRepo.findById(input.jobId);
    if (!job || job.tenant_id !== input.tenantId) {
      return errResult('EMAIL_JOB_NOT_FOUND', 'Email job not found', false);
    }

    if (job.status === 'sent') {
      return errResult('EMAIL_JOB_ALREADY_SENT', 'Email job was already sent', false);
    }

    await jobRepo.update(input.jobId, { status: 'suppressed' });
    return okResult({ suppressed: true });
  } catch (err) {
    return errResult(
      'EMAIL_JOB_SUPPRESSION_UPDATE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function markEmailJobFailedActivity(input: {
  jobId: string;
  tenantId: string;
  activityContext: string;
  errorCode: string;
  message: string;
}): Promise<WorkflowActivityResult<{ failed: true; errorCode: string; message: string }>> {
  const db = getActivityDb();
  try {
    const jobRepo = new EmailJobRepository(db);
    const job = await jobRepo.findById(input.jobId);
    if (!job || job.tenant_id !== input.tenantId) {
      return errResult('EMAIL_JOB_NOT_FOUND', 'Email job not found', false);
    }

    if (job.status === 'sent') {
      return errResult('EMAIL_JOB_ALREADY_SENT', 'Email job was already sent', false);
    }

    if (job.status === 'suppressed') {
      return errResult('EMAIL_JOB_ALREADY_SUPPRESSED', 'Email job was already suppressed', false);
    }

    if (job.status !== 'failed') {
      await jobRepo.update(input.jobId, { status: 'failed' });
    }

    return okResult({ failed: true, errorCode: input.errorCode, message: input.message });
  } catch (err) {
    return errResult(
      'EMAIL_JOB_FAILURE_UPDATE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function checkSmsConsentActivity(input: {
  phone: string;
  tenantId: string;
  notificationType: string;
}): Promise<WorkflowActivityResult<{ allowed: boolean }>> {
  const db = getActivityDb();
  try {
    const consent = await db
      .selectFrom('message_consents')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('phone', '=', input.phone)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (!consent || consent.revoked_at) {
      return okResult({ allowed: false });
    }

    if (input.notificationType !== 'transactional') {
      return okResult({ allowed: consent.sms_opt_in === true });
    }

    return okResult({ allowed: consent.sms_opt_in === true });
  } catch (err) {
    return errResult(
      'SMS_CONSENT_CHECK_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function renderTemplateActivity(input: {
  tenantId?: string;
  brandId?: string;
  channel?: 'email' | 'sms';
  templateKey: string;
  templateVersionId: string;
  variables: Record<string, unknown>;
  optOutToken?: string;
}): Promise<
  WorkflowActivityResult<{ subject: string; html: string; text?: string; segments?: number }>
> {
  const db = getActivityDb();
  try {
    if (!input.tenantId) {
      return errResult(
        'CONTENT_TEMPLATE_SCOPE_REQUIRED',
        'Tenant scope is required to render a content template version',
        false,
      );
    }
    const channel = input.channel ?? 'email';
    const contentVersion = await new ContentRepository(db).findPublishedVersionById({
      tenantId: input.tenantId,
      brandId: input.brandId,
      versionId: input.templateVersionId,
      channel,
    });
    const systemEmailDocument =
      !contentVersion &&
      channel === 'email' &&
      input.templateVersionId === `system_${input.templateKey.replaceAll('-', '_')}_v1`
        ? createDefaultEmailTemplateForKey(input.templateKey as TemplateKey)
        : undefined;
    if (!contentVersion && !systemEmailDocument) {
      return errResult(
        'CONTENT_TEMPLATE_NOT_PUBLISHED',
        `Published ${channel} content version not found: ${input.templateVersionId}`,
        false,
      );
    }
    if (channel === 'sms') {
      const document = normalizeSmsTemplateDocument(contentVersion!.version.contentJson);
      if (!document) {
        return errResult(
          'SMS_TEMPLATE_INVALID',
          'Published SMS content version is not canonical SMS template JSON',
          false,
        );
      }
      const rendered = renderSmsTemplate(document, input.variables, {
        optOutToken: input.optOutToken,
      });
      if (!rendered.validation.valid) {
        return errResult(
          'SMS_TEMPLATE_RENDER_BLOCKED',
          'Published SMS content version has render blockers',
          false,
        );
      }
      return okResult({
        subject: '',
        html: '',
        text: rendered.text,
        segments: rendered.segments,
      });
    }
    const document =
      systemEmailDocument ?? normalizeEmailTemplateDocument(contentVersion?.version.contentJson);
    if (!document) {
      return errResult(
        'EMAIL_TEMPLATE_INVALID',
        'Published email content version is not canonical React Email template JSON',
        false,
      );
    }
    const rendered = await renderEmailTemplate(document, input.variables);
    if (!rendered.validation.valid) {
      return errResult(
        'EMAIL_TEMPLATE_RENDER_BLOCKED',
        'Published email content version has render blockers',
        false,
      );
    }
    return okResult({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch (err) {
    return errResult(
      'TEMPLATE_RENDER_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

function buildTransport(
  providerType: string,
  credentialsRef: string,
  senderDomain: string,
): EmailTransport & { providerName?: string } {
  return buildEmailTransport(providerType, credentialsRef, senderDomain);
}

function buildSmsTransport(providerType: string, credentialsRef: string): SmsTransport {
  if (process.env.TIXKIT_RUNTIME_MODE === 'sandbox') return new CaptureSmsTransport();
  switch (providerType) {
    case 'telnyx':
      return new TelnyxSmsTransport(credentialsRef);
    case 'twilio':
      return new TwilioSmsTransport();
    case 'vonage':
      return new VonageSmsTransport();
    case 'plivo':
      return new PlivoSmsTransport();
    case 'capture':
      return new CaptureSmsTransport();
    default:
      throw new UnsupportedProviderRouteError('sms', providerType);
  }
}

export async function sendEmailActivity(input: {
  jobId: string;
  providerRouteId: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>> {
  const db = getActivityDb();
  try {
    const jobRepo = new EmailJobRepository(db);
    const job = await jobRepo.findById(input.jobId);
    if (!job) {
      return errResult('EMAIL_JOB_NOT_FOUND', 'Email job not found', false);
    }

    const variables = JSON.parse(job.variables as string) as Record<string, unknown>;
    const notificationType =
      (variables.notificationType as 'transactional' | 'bulk' | 'staff' | 'system') ??
      'transactional';
    const attachments = variables.attachments as
      | {
          filename: string;
          contentType: string;
          content: string | Uint8Array;
          contentEncoding?: 'base64';
        }[]
      | undefined;

    const routeRepo = new EmailProviderRouteRepository(db);
    const senderRepo = new BrandSenderIdentityRepository(db);
    const deliveryRepo = new EmailDeliveryRepository(db);

    const configuredRoutes = await routeRepo.findByBrand(job.brand_id);
    const routes = await routeRepo.findActiveByBrand(job.brand_id);
    if (configuredRoutes.length > 0 && routes.length === 0) {
      return errResult(
        'EMAIL_PROVIDER_ROUTE_NOT_VERIFIED',
        'Email provider route requires active status, verified sender identity, and smoke-send evidence',
        false,
      );
    }
    if (routes.length === 0) {
      const senderDomain =
        process.env.EMAIL_SENDER_DOMAIN ??
        process.env.RESEND_FROM_EMAIL?.split('@')[1] ??
        'resend.dev';
      const fromEmail =
        process.env.RESEND_FROM_EMAIL ?? process.env.EMAIL_FROM_EMAIL ?? `noreply@${senderDomain}`;
      const fromName = process.env.RESEND_FROM_NAME ?? process.env.EMAIL_FROM_NAME ?? 'Tixkit';
      const transport = createDefaultEmailTransport();
      const deliveryId = `emd_${ulid()}`;
      const result = await transport.send({
        tenantId: job.tenant_id,
        organizationId: job.tenant_id,
        brandId: job.brand_id,
        templateKey: job.template_key,
        templateVersionId: job.template_version_id,
        deliveryId,
        from: { email: fromEmail, name: fromName },
        to: [{ email: job.to_email, name: job.to_name ?? undefined }],
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments,
        providerRouteId: input.providerRouteId,
        idempotencyKey: input.jobId,
        metadata: { notificationType },
      });

      await deliveryRepo.create({
        tenantId: job.tenant_id,
        jobId: input.jobId,
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: result.status,
        attemptedProviders: [result.provider],
        acceptedProvider:
          result.status === 'accepted' || result.status === 'sent' ? result.provider : undefined,
      });
      await jobRepo.update(input.jobId, {
        status: result.status === 'failed' ? 'failed' : 'sent',
      });
      if (result.status === 'failed') {
        return errResult('EMAIL_SEND_FAILED', 'Default email provider failed', true);
      }
      await recordSendRenderArtifact({
        db,
        tenantId: job.tenant_id,
        brandId: job.brand_id,
        channel: 'email',
        versionId: job.template_version_id,
        artifactRef: `email-delivery:${result.deliveryId}`,
        output: { subject: input.subject, html: input.html, text: input.text },
      });
      return okResult({ deliveryId: result.deliveryId, provider: result.provider });
    }

    const routeSenderPairs = await Promise.all(
      routes.map(async (route) => {
        const senderIdentity = await senderRepo.findVerifiedByBrandAndDomain(
          job.brand_id,
          route.sender_domain,
        );
        if (!senderIdentity) return undefined;
        return { route, senderIdentity };
      }),
    );
    const deliverableRoutePairs = routeSenderPairs.filter(
      (pair): pair is NonNullable<(typeof routeSenderPairs)[number]> => Boolean(pair),
    );
    if (deliverableRoutePairs.length === 0) {
      return errResult(
        'EMAIL_SENDER_NOT_VERIFIED',
        'Email provider route requires a verified sender identity for its sender domain',
        false,
      );
    }

    const eligibleRoutePairs = deliverableRoutePairs.filter(({ route }) =>
      (JSON.parse(route.allowed_categories as string) as string[]).includes(notificationType),
    );
    if (eligibleRoutePairs.length === 0) {
      return errResult(
        'NO_PROVIDER_ROUTE',
        'No active provider route for this notification type',
        false,
      );
    }

    const selectorRoutes = eligibleRoutePairs.map(({ route, senderIdentity }) => ({
      id: route.id,
      transport: buildTransport(route.provider_type, route.credentials_ref, route.sender_domain),
      providerType: route.provider_type,
      senderIdentity,
      priority: route.priority,
      isFallback: route.is_fallback,
      allowedCategories: JSON.parse(route.allowed_categories as string) as string[],
      rateLimitPerHour: route.rate_limit_per_hour ?? undefined,
    }));

    const selector = new ProviderRouteSelector(selectorRoutes);
    const primaryTransport = selector.select(notificationType);
    const fallbackTransports = selector.getFallbacks(notificationType);

    if (!primaryTransport) {
      return errResult(
        'NO_PROVIDER_ROUTE',
        'No active provider route for this notification type',
        false,
      );
    }
    const primarySelection = selectorRoutes.find(
      (candidate) => candidate.transport === primaryTransport,
    );
    if (!primarySelection) {
      return errResult('NO_PROVIDER_ROUTE', 'Selected provider route is unavailable', false);
    }
    const fromEmail = primarySelection.senderIdentity.email;
    const fromName = primarySelection.senderIdentity.name;
    const replyTo = primarySelection.senderIdentity.reply_to_email
      ? { email: primarySelection.senderIdentity.reply_to_email, name: fromName }
      : undefined;

    const transport =
      fallbackTransports.length > 0
        ? new FallbackEmailTransport(
            primaryTransport,
            fallbackTransports as Array<EmailTransport & { providerName?: string }>,
          )
        : primaryTransport;

    const deliveryId = `emd_${ulid()}`;
    const sendInput = {
      tenantId: job.tenant_id,
      organizationId: job.tenant_id,
      brandId: job.brand_id,
      templateKey: job.template_key,
      templateVersionId: job.template_version_id,
      deliveryId,
      from: { email: fromEmail, name: fromName },
      to: [{ email: job.to_email, name: job.to_name ?? undefined }],
      replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      attachments,
      providerRouteId: input.providerRouteId,
      idempotencyKey: input.jobId,
      metadata: { notificationType },
    };

    const validation = validateProviderFields(sendInput, primarySelection.providerType);
    if (!validation.valid) {
      return errResult(
        'PROVIDER_FIELD_VALIDATION_FAILED',
        `Unsupported fields: ${validation.unsupportedFields.join(', ')}`,
        false,
      );
    }

    const result = await transport.send(sendInput);

    await deliveryRepo.create({
      tenantId: job.tenant_id,
      jobId: input.jobId,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: result.status,
      attemptedProviders: result.attemptedFallbackProviders,
      acceptedProvider:
        result.status === 'accepted' || result.status === 'sent' ? result.provider : undefined,
      metadata: { attemptedProviders: result.attemptedFallbackProviders },
    });
    await jobRepo.update(input.jobId, {
      status: result.status === 'failed' ? 'failed' : 'sent',
    });

    if (result.status === 'failed') {
      return errResult('EMAIL_SEND_FAILED', 'All providers failed', true);
    }

    await recordSendRenderArtifact({
      db,
      tenantId: job.tenant_id,
      brandId: job.brand_id,
      channel: 'email',
      versionId: job.template_version_id,
      artifactRef: `email-delivery:${result.deliveryId}`,
      output: { subject: input.subject, html: input.html, text: input.text },
    });

    return okResult({ deliveryId: result.deliveryId, provider: result.provider });
  } catch (err) {
    if (err instanceof UnsupportedProviderRouteError) {
      return errResult('EMAIL_PROVIDER_UNSUPPORTED', err.message, false);
    }
    return errResult(
      'EMAIL_SEND_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function sendSmsActivity(input: {
  jobId: string;
  providerRouteId: string;
  notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
}): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>> {
  const db = getActivityDb();
  try {
    const jobRepo = new SmsJobRepository(db);
    const job = await jobRepo.findById(input.jobId);
    if (!job) {
      return errResult('SMS_JOB_NOT_FOUND', 'SMS job not found', false);
    }

    const variables = parseJobVariables(job.variables);
    const contentVersionId =
      typeof variables.contentVersionId === 'string'
        ? variables.contentVersionId
        : typeof variables.templateVersionId === 'string'
          ? variables.templateVersionId
          : undefined;

    const consentResult = await checkSmsConsentActivity({
      phone: job.to_phone,
      tenantId: job.tenant_id,
      notificationType: input.notificationType,
    });

    if (!consentResult.ok) {
      return consentResult;
    }

    if (!consentResult.value.allowed) {
      await jobRepo.update(input.jobId, { status: 'suppressed' });
      return errResult('SMS_CONSENT_REQUIRED', 'SMS consent is required before sending', false);
    }

    const routeRepo = new SmsProviderRouteRepository(db);
    const senderRepo = new SmsSenderIdentityRepository(db);
    const deliveryRepo = new SmsDeliveryRepository(db);
    const routes = await routeRepo.findActiveByBrand(job.brand_id);

    if (routes.length === 0) {
      return errResult(
        'NO_SMS_PROVIDER_ROUTE',
        'No active SMS provider route for this brand',
        false,
      );
    }

    const selectorRouteCandidates = await Promise.all(
      routes.map(async (route) => {
        if (route.tenant_id !== job.tenant_id || route.brand_id !== job.brand_id) return undefined;
        const allowedCategories = JSON.parse(route.allowed_categories as string) as string[];
        if (!allowedCategories.includes(input.notificationType)) return undefined;
        const sender = await senderRepo.findById(route.sender_identity_id);
        if (
          !sender ||
          !sender.verified ||
          sender.tenant_id !== job.tenant_id ||
          sender.brand_id !== job.brand_id
        ) {
          return undefined;
        }
        return {
          id: route.id,
          transport: buildSmsTransport(route.provider_type, route.credentials_ref),
          priority: route.priority,
          isFallback: route.is_fallback,
          allowedCategories,
          rateLimitPerHour: route.rate_limit_per_hour ?? undefined,
          sender: sender.sender,
          webhookUrl: route.webhook_url ?? undefined,
        };
      }),
    );
    const selectorRoutes = selectorRouteCandidates.filter(
      (route): route is NonNullable<(typeof selectorRouteCandidates)[number]> => Boolean(route),
    );

    const eligibleRoutes = selectorRoutes
      .filter((route) => route.allowedCategories.includes(input.notificationType))
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a freshly filtered route list preserves provider priority order.
      .sort((a, b) => {
        if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
        return a.priority - b.priority;
      });

    const primaryRoute = eligibleRoutes.find((route) => !route.isFallback) ?? eligibleRoutes[0];
    if (!primaryRoute) {
      return errResult(
        'NO_SMS_PROVIDER_ROUTE',
        'No active SMS provider route for this notification type',
        false,
      );
    }

    const fallbackRoutes = eligibleRoutes.filter(
      (route) => route.isFallback && route.id !== primaryRoute.id,
    );
    const transport =
      fallbackRoutes.length > 0
        ? new FallbackSmsTransport(
            primaryRoute.transport,
            fallbackRoutes.map((route) => route.transport),
          )
        : primaryRoute.transport;

    const deliveryId = `smd_${ulid()}`;
    const result = await transport.send({
      tenantId: job.tenant_id,
      organizationId: job.tenant_id,
      brandId: job.brand_id,
      jobId: input.jobId,
      deliveryId,
      from: primaryRoute.sender,
      to: job.to_phone,
      body: job.body,
      providerRouteId: input.providerRouteId,
      idempotencyKey: job.idempotency_key,
      notificationType: input.notificationType,
      webhookUrl: primaryRoute.webhookUrl,
      metadata: {},
    });

    await deliveryRepo.create({
      tenantId: job.tenant_id,
      jobId: input.jobId,
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      status: result.status,
      attemptedProviders: result.attemptedFallbackProviders,
      acceptedProvider: result.status === 'failed' ? undefined : result.provider,
      metadata: { attemptedProviders: result.attemptedFallbackProviders },
    });
    await jobRepo.update(input.jobId, {
      status: result.status === 'failed' ? 'failed' : 'sent',
    });

    if (result.status === 'failed') {
      return errResult('SMS_SEND_FAILED', 'All SMS providers failed', true);
    }

    await recordSendRenderArtifact({
      db,
      tenantId: job.tenant_id,
      brandId: job.brand_id,
      channel: 'sms',
      versionId: contentVersionId,
      artifactRef: `sms-delivery:${result.deliveryId}`,
      output: { text: job.body },
    });

    return okResult({ deliveryId: result.deliveryId, provider: result.provider });
  } catch (err) {
    if (err instanceof UnsupportedProviderRouteError) {
      return errResult('SMS_PROVIDER_UNSUPPORTED', err.message, false);
    }
    return errResult('SMS_SEND_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  }
}
