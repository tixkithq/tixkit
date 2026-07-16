import type { EmailTransport, SendEmailInput, SendEmailResult } from '@tixkit/domain';
import {
  createEmailProviderTransport,
  createSmsProviderTransport,
  discoverMessagingProviderExtensions,
  MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
  registerMessagingProviderExtension,
  type MessagingProviderRoute,
  type MessagingProviderRouteSelector,
  type SmsTransport,
  type SendSmsInput,
  type SendSmsResult,
} from '@tixkit/domain/messaging';
import {
  PlivoMessagingClient,
  ProviderOperationError,
  ResendMessagingClient,
  TelnyxMessagingClient,
  TwilioMessagingClient,
  VonageMessagingClient,
  type ProviderClientRuntime,
} from '@tixkit/provider-clients';
import { ulid } from 'ulid';

export {
  discoverMessagingProviderExtensions,
  DuplicateMessagingProviderExtensionError,
  MessagingProviderExtensionRegistry,
  registerMessagingProviderExtension,
} from '@tixkit/domain/messaging';
export type {
  EmailProviderExtensionContext,
  MessagingProviderExtension,
  SmsProviderExtensionContext,
} from '@tixkit/domain/messaging';

export class UnsupportedProviderRouteError extends Error {
  constructor(
    public readonly channel: 'email' | 'sms',
    public readonly providerType: string,
  ) {
    super(`Unsupported ${channel} provider route: ${providerType}`);
    this.name = 'UnsupportedProviderRouteError';
  }
}

/**
 * In-memory capture transport for testing.
 * Records all sends without making network calls.
 */
export class CaptureEmailTransport implements EmailTransport {
  providerName = 'capture';
  public sent: SendEmailInput[] = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: `cap_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }

  reset(): void {
    this.sent = [];
  }

  findByTo(email: string): SendEmailInput[] {
    return this.sent.filter((s) => s.to.some((r) => r.email === email));
  }

  findByTemplate(templateKey: string): SendEmailInput[] {
    return this.sent.filter((s) => s.templateKey === templateKey);
  }
}

export class CaptureSmsTransport implements SmsTransport {
  providerName = 'capture';
  public sent: SendSmsInput[] = [];

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    this.sent.push(input);
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: `capsms_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }

  reset(): void {
    this.sent = [];
  }

  findByTo(phone: string): SendSmsInput[] {
    return this.sent.filter((message) => message.to === phone);
  }
}

class UnconfiguredEmailTransport implements EmailTransport {
  providerName = 'unconfigured';

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    void input;
    throw new UnsupportedProviderRouteError('email', 'default-unconfigured');
  }
}

/**
 * Mock transport that can simulate failures for testing fallback behavior.
 */
export class MockEmailTransport implements EmailTransport {
  providerName: string;

  constructor(
    providerName: string = 'mock',
    private shouldFail = false,
  ) {
    this.providerName = providerName;
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (this.shouldFail) {
      throw new ProviderOperationError(
        `Mock transport ${this.providerName} configured to fail`,
        this.providerName,
        'send-email',
        'validation',
        false,
        'rejected',
        true,
      );
    }
    return {
      deliveryId: input.deliveryId,
      provider: this.providerName,
      providerMessageId: `mock_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }
}

/**
 * Fallback transport that tries primary, then fallback providers.
 * Implements the Email SDK fallback route pattern.
 */
export class FallbackEmailTransport implements EmailTransport {
  constructor(
    private primary: EmailTransport,
    private fallbacks: Array<EmailTransport & { providerName?: string }> = [],
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const attempted: string[] = [];
    let lastFailure: ProviderOperationError | undefined;

    try {
      const result = await this.primary.send(input);
      attempted.push(result.provider);
      return { ...result, attemptedFallbackProviders: attempted };
    } catch (error) {
      const name = (this.primary as { providerName?: string }).providerName ?? 'primary';
      attempted.push(name);
      if (!(error instanceof ProviderOperationError) || !error.safeToFailover) throw error;
      lastFailure = error;
    }

    for (const fallback of this.fallbacks) {
      try {
        // eslint-disable-next-line no-await-in-loop -- fallback providers must be attempted sequentially to avoid duplicate sends.
        const result = await fallback.send(input);
        attempted.push(result.provider);
        return { ...result, attemptedFallbackProviders: attempted };
      } catch (error) {
        const name = fallback.providerName ?? `fallback_${attempted.length}`;
        attempted.push(name);
        if (!(error instanceof ProviderOperationError) || !error.safeToFailover) throw error;
        lastFailure = error;
      }
    }
    if (lastFailure) throw lastFailure;
    throw new Error('Email fallback routing exhausted without a provider attempt');
  }
}

export class FallbackSmsTransport implements SmsTransport {
  constructor(
    private primary: SmsTransport,
    private fallbacks: Array<SmsTransport & { providerName?: string }> = [],
  ) {}

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const attempted: string[] = [];
    let lastFailure: ProviderOperationError | undefined;

    try {
      const result = await this.primary.send(input);
      attempted.push(result.provider);
      return { ...result, attemptedFallbackProviders: attempted };
    } catch (error) {
      const name = (this.primary as { providerName?: string }).providerName ?? 'primary';
      attempted.push(name);
      if (!(error instanceof ProviderOperationError) || !error.safeToFailover) throw error;
      lastFailure = error;
    }

    for (const fallback of this.fallbacks) {
      try {
        // eslint-disable-next-line no-await-in-loop -- fallback providers must be attempted sequentially to avoid duplicate sends.
        const result = await fallback.send(input);
        attempted.push(result.provider);
        return { ...result, attemptedFallbackProviders: attempted };
      } catch (error) {
        const name = fallback.providerName ?? `fallback_${attempted.length}`;
        attempted.push(name);
        if (!(error instanceof ProviderOperationError) || !error.safeToFailover) throw error;
        lastFailure = error;
      }
    }
    if (lastFailure) throw lastFailure;
    throw new Error('SMS fallback routing exhausted without a provider attempt');
  }
}

function sanitizeEnvCredential(value: string | undefined): string {
  if (!value) return '';
  // Strip inline comments and surrounding quotes that often leak from .env.local.
  return (
    value
      .split('#')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
      .trim() ?? ''
  );
}

function credentialValue(credentialsRef: string, fallbackEnvName: string): string {
  const fromRef = sanitizeEnvCredential(process.env[credentialsRef]);
  if (fromRef) return fromRef;
  const fromFallback = sanitizeEnvCredential(process.env[fallbackEnvName]);
  if (fromFallback) return fromFallback;
  // Unit tests may pass a raw sentinel to inspect the wire contract. Runtime
  // routes must resolve a named environment reference and never transmit a
  // misspelled reference name as though it were a credential.
  return process.env.NODE_ENV === 'test' && !credentialsRef.startsWith('secret://')
    ? sanitizeEnvCredential(credentialsRef)
    : '';
}

export class TelnyxSmsTransport implements SmsTransport {
  providerName = 'telnyx';
  private client: TelnyxMessagingClient;

  constructor(
    credentialsRef = 'TELNYX_API_KEY',
    baseUrl?: string,
    runtime: ProviderClientRuntime = {},
  ) {
    this.client = new TelnyxMessagingClient(
      {
        apiKey: credentialValue(credentialsRef, 'TELNYX_API_KEY'),
        baseUrl,
      },
      runtime,
    );
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const result = await this.client.sendSms({
      ...input,
      incidentScope: { tenantId: input.tenantId, organizationId: input.organizationId },
    });
    return {
      deliveryId: input.deliveryId,
      provider: 'telnyx',
      providerMessageId: result.providerMessageId,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class TwilioSmsTransport implements SmsTransport {
  providerName = 'twilio';
  private client: TwilioMessagingClient;

  constructor(
    accountSidRef = 'TWILIO_ACCOUNT_SID',
    authTokenRef = 'TWILIO_AUTH_TOKEN',
    baseUrl?: string,
    runtime: ProviderClientRuntime = {},
  ) {
    this.client = new TwilioMessagingClient(
      {
        accountSid: credentialValue(accountSidRef, 'TWILIO_ACCOUNT_SID'),
        authToken: credentialValue(authTokenRef, 'TWILIO_AUTH_TOKEN'),
        baseUrl,
      },
      runtime,
    );
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const result = await this.client.sendSms({
      ...input,
      incidentScope: { tenantId: input.tenantId, organizationId: input.organizationId },
    });
    return {
      deliveryId: input.deliveryId,
      provider: 'twilio',
      providerMessageId: result.providerMessageId,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class VonageSmsTransport implements SmsTransport {
  providerName = 'vonage';
  private client: VonageMessagingClient;

  constructor(
    apiKeyRef = 'VONAGE_API_KEY',
    apiSecretRef = 'VONAGE_API_SECRET',
    baseUrl?: string,
    runtime: ProviderClientRuntime = {},
  ) {
    this.client = new VonageMessagingClient(
      {
        apiKey: credentialValue(apiKeyRef, 'VONAGE_API_KEY'),
        apiSecret: credentialValue(apiSecretRef, 'VONAGE_API_SECRET'),
        baseUrl,
      },
      runtime,
    );
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const result = await this.client.sendSms({
      ...input,
      incidentScope: { tenantId: input.tenantId, organizationId: input.organizationId },
    });
    return {
      deliveryId: input.deliveryId,
      provider: 'vonage',
      providerMessageId: result.providerMessageId,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class PlivoSmsTransport implements SmsTransport {
  providerName = 'plivo';
  private client: PlivoMessagingClient;

  constructor(
    authIdRef = 'PLIVO_AUTH_ID',
    authTokenRef = 'PLIVO_AUTH_TOKEN',
    baseUrl?: string,
    runtime: ProviderClientRuntime = {},
  ) {
    this.client = new PlivoMessagingClient(
      {
        authId: credentialValue(authIdRef, 'PLIVO_AUTH_ID'),
        authToken: credentialValue(authTokenRef, 'PLIVO_AUTH_TOKEN'),
        baseUrl,
      },
      runtime,
    );
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const result = await this.client.sendSms({
      ...input,
      incidentScope: { tenantId: input.tenantId, organizationId: input.organizationId },
    });
    return {
      deliveryId: input.deliveryId,
      provider: 'plivo',
      providerMessageId: result.providerMessageId,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

/**
 * OpenCore Email SDK transport adapter.
 * Maps Tixkit message format to Email SDK message format.
 * In production, this wraps the actual @opencoredev/email-sdk package.
 */
export class OpenCoreEmailSdkTransport implements EmailTransport {
  private config: { credentialsRef: string; senderDomain: string };

  constructor(credentialsRef: string, senderDomain: string) {
    this.config = { credentialsRef, senderDomain };
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    void input;
    void this.config;
    throw new UnsupportedProviderRouteError('email', 'opencore_email_sdk');
  }
}

/**
 * SMTP transport adapter for direct SMTP sending.
 */
export class SmtpEmailTransport implements EmailTransport {
  private smtpConfig: { host: string; port: number; username: string; password: string };

  constructor(host: string, port: number, username: string, password: string) {
    this.smtpConfig = { host, port, username, password };
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    void input;
    void this.smtpConfig;
    throw new UnsupportedProviderRouteError('email', 'smtp');
  }
}

/**
 * Resend transport backed by the centralized outbound provider client.
 * credentialsRef may be an env var name (default RESEND_API_KEY) or a raw API key.
 */
export class ResendEmailTransport implements EmailTransport {
  providerName = 'resend';
  private client: ResendMessagingClient;

  constructor(
    credentialsRef = 'RESEND_API_KEY',
    baseUrl?: string,
    runtime: ProviderClientRuntime = {},
  ) {
    this.client = new ResendMessagingClient(
      {
        apiKey: credentialValue(credentialsRef, 'RESEND_API_KEY'),
        baseUrl,
      },
      runtime,
    );
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const from = input.from.name ? `${input.from.name} <${input.from.email}>` : input.from.email;
    const replyTo = input.replyTo
      ? input.replyTo.name
        ? `${input.replyTo.name} <${input.replyTo.email}>`
        : input.replyTo.email
      : undefined;

    const result = await this.client.sendEmail({
      from,
      to: input.to.map((recipient) =>
        recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email,
      ),
      subject: input.subject,
      html: input.html,
      idempotencyKey: input.idempotencyKey,
      text: input.text,
      replyTo,
      headers: input.headers,
      tags: input.tags,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachmentContentBase64(attachment.content, attachment.contentEncoding),
        contentType: attachment.contentType,
      })),
      incidentScope: { tenantId: input.tenantId, organizationId: input.organizationId },
    });

    return {
      deliveryId: input.deliveryId,
      provider: 'resend',
      providerMessageId: result.providerMessageId,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

function attachmentContentBase64(content: string | Uint8Array, contentEncoding?: 'base64'): string {
  if (typeof content === 'string') {
    if (contentEncoding === 'base64') return content;
    return Buffer.from(content, 'utf8').toString('base64');
  }
  return Buffer.from(content).toString('base64');
}

function builtInDescriptor(
  providerType: string,
  displayName: string,
  channels: Array<'email' | 'sms'>,
) {
  return {
    contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
    providerType,
    displayName,
    channels,
    operations: ['send'] as const,
  };
}

registerMessagingProviderExtension({
  descriptor: builtInDescriptor('capture', 'Capture', ['email', 'sms']),
  createEmail: () => new CaptureEmailTransport(),
  createSms: () => new CaptureSmsTransport(),
});
registerMessagingProviderExtension({
  descriptor: builtInDescriptor('resend', 'Resend', ['email']),
  createEmail: ({ credentialsRef }) => new ResendEmailTransport(credentialsRef),
});
registerMessagingProviderExtension({
  descriptor: builtInDescriptor('telnyx', 'Telnyx', ['sms']),
  createSms: ({ credentialsRef }) => new TelnyxSmsTransport(credentialsRef),
});
registerMessagingProviderExtension({
  descriptor: builtInDescriptor('twilio', 'Twilio', ['sms']),
  createSms: () => new TwilioSmsTransport(),
});
registerMessagingProviderExtension({
  descriptor: builtInDescriptor('vonage', 'Vonage', ['sms']),
  createSms: () => new VonageSmsTransport(),
});
registerMessagingProviderExtension({
  descriptor: builtInDescriptor('plivo', 'Plivo', ['sms']),
  createSms: () => new PlivoSmsTransport(),
});

/**
 * Build an email transport for a configured provider route.
 * Explicit provider routes fail closed when no public adapter exists. Capture is
 * available only when explicitly selected or when the runtime is sandboxed.
 */
export function buildEmailTransport(
  providerType: string,
  credentialsRef: string,
  senderDomain?: string,
  runtime: ProviderClientRuntime = {},
): EmailTransport & { providerName?: string } {
  if (process.env.TIXKIT_RUNTIME_MODE === 'sandbox') return new CaptureEmailTransport();
  if (providerType === 'resend')
    return new ResendEmailTransport(credentialsRef, undefined, runtime);
  const transport = createEmailProviderTransport(providerType, {
    credentialsRef,
    senderDomain,
  });
  if (!transport) throw new UnsupportedProviderRouteError('email', providerType);
  return transport;
}

export function buildSmsTransport(
  providerType: string,
  credentialsRef: string,
  runtime: ProviderClientRuntime = {},
): SmsTransport & { providerName?: string } {
  if (process.env.TIXKIT_RUNTIME_MODE === 'sandbox') return new CaptureSmsTransport();
  if (providerType === 'telnyx') return new TelnyxSmsTransport(credentialsRef, undefined, runtime);
  if (providerType === 'twilio')
    return new TwilioSmsTransport(undefined, undefined, undefined, runtime);
  if (providerType === 'vonage')
    return new VonageSmsTransport(undefined, undefined, undefined, runtime);
  if (providerType === 'plivo')
    return new PlivoSmsTransport(undefined, undefined, undefined, runtime);
  const transport = createSmsProviderTransport(providerType, { credentialsRef });
  if (!transport) throw new UnsupportedProviderRouteError('sms', providerType);
  return transport;
}

/**
 * Default API/worker transport: Resend when configured, capture only for
 * sandbox/development, and fail closed in production.
 */
export function createDefaultEmailTransport(
  runtime: ProviderClientRuntime = {},
): EmailTransport & { providerName?: string } {
  if (process.env.TIXKIT_RUNTIME_MODE === 'sandbox') return new CaptureEmailTransport();
  if (process.env.RESEND_API_KEY) {
    return new ResendEmailTransport('RESEND_API_KEY', undefined, runtime);
  }
  if (process.env.TIXKIT_RUNTIME_MODE === 'production') {
    return new UnconfiguredEmailTransport();
  }
  return new CaptureEmailTransport();
}

/**
 * Provider route selector. Chooses the appropriate transport based on
 * brand configuration, message category, and fallback rules.
 */
export class ProviderRouteSelector implements MessagingProviderRouteSelector<EmailTransport> {
  constructor(private routes: Array<MessagingProviderRoute<EmailTransport>>) {}

  select(category: 'transactional' | 'bulk' | 'staff' | 'system'): EmailTransport | null {
    const eligible = this.routes.filter((r) => r.allowedCategories.includes(category));

    // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh filtered array preserves configured route priority without mutating selector input.
    eligible.sort((a, b) => {
      if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
      return a.priority - b.priority;
    });

    return eligible[0]?.transport ?? null;
  }

  getFallbacks(category: 'transactional' | 'bulk' | 'staff' | 'system'): EmailTransport[] {
    const eligibleFallbacks = this.routes.filter(
      (r) => r.isFallback && r.allowedCategories.includes(category),
    );

    // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh filtered array preserves configured fallback priority without mutating selector input.
    eligibleFallbacks.sort((a, b) => a.priority - b.priority);

    return eligibleFallbacks.map((r) => r.transport);
  }
}

/**
 * Validates that a message's fields are supported by the selected provider.
 * Called before queueing irreversible sends.
 */
export function validateProviderFields(
  input: SendEmailInput,
  providerType: string,
): { valid: boolean; unsupportedFields: string[] } {
  const unsupported: string[] = [];

  // Different providers have different field support
  const providerCapabilities: Record<string, string[]> = {
    capture: ['attachments', 'tags', 'metadata', 'headers'],
    opencore_email_sdk: ['attachments', 'tags', 'metadata', 'headers'],
    resend: ['attachments', 'tags', 'metadata', 'headers'],
    postmark: ['attachments', 'metadata'],
    ses: ['attachments', 'tags', 'metadata', 'headers'],
    sendgrid: ['attachments', 'categories', 'custom_args'],
    mailgun: ['attachments', 'tags', 'variables'],
    smtp: ['attachments'],
  };

  const caps =
    providerCapabilities[providerType] ??
    (discoverMessagingProviderExtensions('email').some(
      (descriptor) => descriptor.providerType === providerType,
    )
      ? ['attachments', 'tags', 'metadata', 'headers']
      : []);

  if (input.attachments && input.attachments.length > 0 && !caps.includes('attachments')) {
    unsupported.push('attachments');
  }
  if (input.tags && input.tags.length > 0 && !caps.includes('tags')) {
    unsupported.push('tags');
  }
  if (Object.keys(input.metadata ?? {}).length > 0 && !caps.includes('metadata')) {
    unsupported.push('metadata');
  }
  if (input.headers && Object.keys(input.headers).length > 0 && !caps.includes('headers')) {
    unsupported.push('headers');
  }

  return { valid: unsupported.length === 0, unsupportedFields: unsupported };
}
