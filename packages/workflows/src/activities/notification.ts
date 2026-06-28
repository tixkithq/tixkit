import { createDb } from '@tixkit/db';
import {
  NotificationTemplateVersionRepository,
  EmailProviderRouteRepository,
  BrandSenderIdentityRepository,
  EmailJobRepository,
  EmailDeliveryRepository,
  SmsProviderRouteRepository,
  SmsSenderIdentityRepository,
  SmsJobRepository,
  SmsDeliveryRepository,
} from '@tixkit/db';
import {
  OpenCoreEmailSdkTransport,
  SmtpEmailTransport,
  FallbackEmailTransport,
  TelnyxSmsTransport,
  TwilioSmsTransport,
  VonageSmsTransport,
  PlivoSmsTransport,
  CaptureSmsTransport,
  FallbackSmsTransport,
  ProviderRouteSelector,
  validateProviderFields,
} from '@tixkit/email-transport';
import type { EmailTransport } from '@tixkit/domain';
import type { SmsTransport } from '@tixkit/domain/messaging';
import { ulid } from 'ulid';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

function renderTemplateString(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });
}

export async function checkSuppressionActivity(input: {
  email: string;
  tenantId: string;
}): Promise<WorkflowActivityResult<{ suppressed: boolean }>> {
  const db = createDb();
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
  } finally {
    await db.destroy();
  }
}

export async function checkConsentActivity(input: {
  email: string;
  tenantId: string;
  notificationType: string;
}): Promise<WorkflowActivityResult<{ allowed: boolean }>> {
  const db = createDb();
  try {
    // Transactional emails always pass consent checks.
    if (input.notificationType === 'transactional') {
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
  } finally {
    await db.destroy();
  }
}

export async function checkSmsConsentActivity(input: {
  phone: string;
  tenantId: string;
  notificationType: string;
}): Promise<WorkflowActivityResult<{ allowed: boolean }>> {
  const db = createDb();
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
  } finally {
    await db.destroy();
  }
}

export async function renderTemplateActivity(input: {
  templateKey: string;
  templateVersionId: string;
  variables: Record<string, unknown>;
}): Promise<WorkflowActivityResult<{ subject: string; html: string; text?: string }>> {
  const db = createDb();
  try {
    const versionRepo = new NotificationTemplateVersionRepository(db);

    const version = await versionRepo.findById(input.templateVersionId);

    if (!version) {
      return okResult({
        subject: renderTemplateString('Tixkit Notification', input.variables),
        html: renderTemplateString('<p>You have a new notification.</p>', input.variables),
        text: 'You have a new notification.',
      });
    }

    return okResult({
      subject: renderTemplateString(version.subject_template, input.variables),
      html: renderTemplateString(version.html_template, input.variables),
      text: version.text_template
        ? renderTemplateString(version.text_template, input.variables)
        : undefined,
    });
  } catch (err) {
    return errResult(
      'TEMPLATE_RENDER_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

function buildTransport(
  providerType: string,
  credentialsRef: string,
  senderDomain: string,
): EmailTransport {
  switch (providerType) {
    case 'opencore_email_sdk':
      return new OpenCoreEmailSdkTransport(credentialsRef, senderDomain);
    case 'smtp':
      return new SmtpEmailTransport(
        process.env.SMTP_HOST ?? 'localhost',
        Number(process.env.SMTP_PORT ?? '587'),
        process.env.SMTP_USERNAME ?? '',
        process.env.SMTP_PASSWORD ?? '',
      );
    default:
      return new OpenCoreEmailSdkTransport(credentialsRef, senderDomain);
  }
}

function buildSmsTransport(providerType: string, credentialsRef: string): SmsTransport {
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
      return new TelnyxSmsTransport(credentialsRef);
  }
}

export async function sendEmailActivity(input: {
  jobId: string;
  providerRouteId: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>> {
  const db = createDb();
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
      const senderDomain = process.env.EMAIL_SENDER_DOMAIN ?? 'tixkit.com';
      const transport = new OpenCoreEmailSdkTransport(
        process.env.EMAIL_SDK_CREDENTIALS_REF ?? 'default',
        senderDomain,
      );
      const deliveryId = `emd_${ulid()}`;
      const result = await transport.send({
        tenantId: job.tenant_id,
        organizationId: job.tenant_id,
        brandId: job.brand_id,
        templateKey: job.template_key,
        templateVersionId: job.template_version_id,
        deliveryId,
        from: { email: `noreply@${senderDomain}`, name: 'Tixkit' },
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
        acceptedProvider: result.provider,
      });
      await jobRepo.update(input.jobId, { status: 'sent' });
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

    const firstSenderIdentity = deliverableRoutePairs[0].senderIdentity;
    const fromEmail = firstSenderIdentity.email;
    const fromName = firstSenderIdentity.name;
    const replyTo = firstSenderIdentity.reply_to_email
      ? { email: firstSenderIdentity.reply_to_email, name: fromName }
      : undefined;

    const selectorRoutes = deliverableRoutePairs.map(({ route }) => ({
      id: route.id,
      transport: buildTransport(route.provider_type, route.credentials_ref, route.sender_domain),
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

    const validation = validateProviderFields(sendInput, deliverableRoutePairs[0].route.provider_type);
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

    return okResult({ deliveryId: result.deliveryId, provider: result.provider });
  } catch (err) {
    return errResult(
      'EMAIL_SEND_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function sendSmsActivity(input: {
  jobId: string;
  providerRouteId: string;
  notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
}): Promise<WorkflowActivityResult<{ deliveryId: string; provider: string }>> {
  const db = createDb();
  try {
    const jobRepo = new SmsJobRepository(db);
    const job = await jobRepo.findById(input.jobId);
    if (!job) {
      return errResult('SMS_JOB_NOT_FOUND', 'SMS job not found', false);
    }

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
        const sender = await senderRepo.findById(route.sender_identity_id);
        if (!sender || !sender.verified) return undefined;
        return {
          id: route.id,
          transport: buildSmsTransport(route.provider_type, route.credentials_ref),
          priority: route.priority,
          isFallback: route.is_fallback,
          allowedCategories: JSON.parse(route.allowed_categories as string) as string[],
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

    return okResult({ deliveryId: result.deliveryId, provider: result.provider });
  } catch (err) {
    return errResult('SMS_SEND_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}
