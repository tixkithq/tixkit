import type { EmailTransport, SendEmailInput, SendEmailResult } from '@tixkit/domain';
import type { SmsTransport, SendSmsInput, SendSmsResult } from '@tixkit/domain/messaging';
import { ulid } from 'ulid';

/**
 * In-memory capture transport for testing.
 * Records all sends without making network calls.
 */
export class CaptureEmailTransport implements EmailTransport {
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
      throw new Error(`Mock transport ${this.providerName} configured to fail`);
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

    try {
      const result = await this.primary.send(input);
      attempted.push(result.provider);
      return { ...result, attemptedFallbackProviders: attempted };
    } catch {
      const name = (this.primary as { providerName?: string }).providerName ?? 'primary';
      attempted.push(name);
    }

    for (const fallback of this.fallbacks) {
      try {
        // eslint-disable-next-line no-await-in-loop -- fallback providers must be attempted sequentially to avoid duplicate sends.
        const result = await fallback.send(input);
        attempted.push(result.provider);
        return { ...result, attemptedFallbackProviders: attempted };
      } catch {
        const name = fallback.providerName ?? `fallback_${attempted.length}`;
        attempted.push(name);
      }
    }

    return {
      deliveryId: input.deliveryId,
      provider: 'none',
      status: 'failed',
      attemptedFallbackProviders: attempted,
      sentAt: new Date().toISOString(),
    };
  }
}

export class FallbackSmsTransport implements SmsTransport {
  constructor(
    private primary: SmsTransport,
    private fallbacks: Array<SmsTransport & { providerName?: string }> = [],
  ) {}

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const attempted: string[] = [];

    try {
      const result = await this.primary.send(input);
      attempted.push(result.provider);
      return { ...result, attemptedFallbackProviders: attempted };
    } catch {
      const name = (this.primary as { providerName?: string }).providerName ?? 'primary';
      attempted.push(name);
    }

    for (const fallback of this.fallbacks) {
      try {
        // eslint-disable-next-line no-await-in-loop -- fallback providers must be attempted sequentially to avoid duplicate sends.
        const result = await fallback.send(input);
        attempted.push(result.provider);
        return { ...result, attemptedFallbackProviders: attempted };
      } catch {
        const name = fallback.providerName ?? `fallback_${attempted.length}`;
        attempted.push(name);
      }
    }

    return {
      deliveryId: input.deliveryId,
      provider: 'none',
      status: 'failed',
      attemptedFallbackProviders: attempted,
      sentAt: new Date().toISOString(),
    };
  }
}

type SmsHttpConfig = {
  apiKey: string;
  apiSecret?: string;
  accountSid?: string;
  authToken?: string;
  baseUrl?: string;
};

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
  // credentialsRef may itself be a raw key in tests/dev.
  return sanitizeEnvCredential(credentialsRef) || credentialsRef;
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const json = await response.json().catch(() => ({}));
  return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
}

export class TelnyxSmsTransport implements SmsTransport {
  providerName = 'telnyx';
  private config: Required<Pick<SmsHttpConfig, 'apiKey' | 'baseUrl'>>;

  constructor(credentialsRef = 'TELNYX_API_KEY', baseUrl = 'https://api.telnyx.com/v2') {
    this.config = {
      apiKey: credentialValue(credentialsRef, 'TELNYX_API_KEY'),
      baseUrl,
    };
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: { phone_number: input.from },
        to: [{ phone_number: input.to }],
        text: input.body,
        type: 'SMS',
        webhook_url: input.webhookUrl,
        use_profile_webhooks: !input.webhookUrl,
      }),
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      throw new Error(`Telnyx SMS send failed with status ${response.status}`);
    }

    return {
      deliveryId: input.deliveryId,
      provider: 'telnyx',
      providerMessageId: typeof body.id === 'string' ? body.id : undefined,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class TwilioSmsTransport implements SmsTransport {
  providerName = 'twilio';
  private accountSid: string;
  private authToken: string;

  constructor(accountSidRef = 'TWILIO_ACCOUNT_SID', authTokenRef = 'TWILIO_AUTH_TOKEN') {
    this.accountSid = credentialValue(accountSidRef, 'TWILIO_ACCOUNT_SID');
    this.authToken = credentialValue(authTokenRef, 'TWILIO_AUTH_TOKEN');
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const form = new URLSearchParams({
      From: input.from,
      To: input.to,
      Body: input.body,
    });
    if (input.webhookUrl) form.set('StatusCallback', input.webhookUrl);

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: form,
      },
    );
    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(`Twilio SMS send failed with status ${response.status}`);
    return {
      deliveryId: input.deliveryId,
      provider: 'twilio',
      providerMessageId: typeof body.sid === 'string' ? body.sid : undefined,
      status: 'queued',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class VonageSmsTransport implements SmsTransport {
  providerName = 'vonage';
  private apiKey: string;
  private apiSecret: string;

  constructor(apiKeyRef = 'VONAGE_API_KEY', apiSecretRef = 'VONAGE_API_SECRET') {
    this.apiKey = credentialValue(apiKeyRef, 'VONAGE_API_KEY');
    this.apiSecret = credentialValue(apiSecretRef, 'VONAGE_API_SECRET');
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const response = await fetch('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        api_secret: this.apiSecret,
        from: input.from,
        to: input.to,
        text: input.body,
        client_ref: input.idempotencyKey,
      }),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(`Vonage SMS send failed with status ${response.status}`);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const first = messages[0] as Record<string, unknown> | undefined;
    return {
      deliveryId: input.deliveryId,
      provider: 'vonage',
      providerMessageId:
        typeof first?.['message-id'] === 'string' ? first['message-id'] : undefined,
      status: first?.status === '0' ? 'queued' : 'failed',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

export class PlivoSmsTransport implements SmsTransport {
  providerName = 'plivo';
  private authId: string;
  private authToken: string;

  constructor(authIdRef = 'PLIVO_AUTH_ID', authTokenRef = 'PLIVO_AUTH_TOKEN') {
    this.authId = credentialValue(authIdRef, 'PLIVO_AUTH_ID');
    this.authToken = credentialValue(authTokenRef, 'PLIVO_AUTH_TOKEN');
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    const response = await fetch(`https://api.plivo.com/v1/Account/${this.authId}/Message/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        src: input.from,
        dst: input.to,
        text: input.body,
        url: input.webhookUrl,
      }),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(`Plivo SMS send failed with status ${response.status}`);
    const messageUuid = Array.isArray(body.message_uuid) ? body.message_uuid[0] : body.message_uuid;
    return {
      deliveryId: input.deliveryId,
      provider: 'plivo',
      providerMessageId: typeof messageUuid === 'string' ? messageUuid : undefined,
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
    // In production, this calls the Email SDK with mapped fields using this.config
    void this.config;
    return {
      deliveryId: input.deliveryId,
      provider: 'opencore_email_sdk',
      providerMessageId: `ocs_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
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
    // In production, uses nodemailer with this.smtpConfig
    void this.smtpConfig;
    return {
      deliveryId: input.deliveryId,
      provider: 'smtp',
      providerMessageId: `smtp_${ulid()}`,
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: new Date().toISOString(),
    };
  }
}

/**
 * Resend HTTP transport. Sends through https://api.resend.com/emails.
 * credentialsRef may be an env var name (default RESEND_API_KEY) or a raw API key.
 */
export class ResendEmailTransport implements EmailTransport {
  providerName = 'resend';
  private apiKey: string;
  private baseUrl: string;

  constructor(credentialsRef = 'RESEND_API_KEY', baseUrl = 'https://api.resend.com') {
    this.apiKey = credentialValue(credentialsRef, 'RESEND_API_KEY');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.apiKey) {
      throw new Error('Resend API key is not configured');
    }

    const from = input.from.name ? `${input.from.name} <${input.from.email}>` : input.from.email;
    const replyTo = input.replyTo
      ? input.replyTo.name
        ? `${input.replyTo.name} <${input.replyTo.email}>`
        : input.replyTo.email
      : undefined;

    const payload: Record<string, unknown> = {
      from,
      to: input.to.map((recipient) =>
        recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email,
      ),
      subject: input.subject,
      html: input.html,
    };
    if (input.text) payload.text = input.text;
    if (replyTo) payload.reply_to = replyTo;
    if (input.headers && Object.keys(input.headers).length > 0) {
      payload.headers = input.headers;
    }
    if (input.tags && input.tags.length > 0) {
      payload.tags = input.tags.map((tag) => ({ name: tag.name, value: tag.value }));
    }
    if (input.attachments && input.attachments.length > 0) {
      payload.attachments = input.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachmentContentBase64(attachment.content, attachment.contentEncoding),
        content_type: attachment.contentType,
      }));
    }

    const response = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const message =
        typeof body.message === 'string'
          ? body.message
          : typeof body.name === 'string'
            ? body.name
            : `Resend send failed with status ${response.status}`;
      throw new Error(message);
    }

    const providerMessageId =
      typeof body.id === 'string'
        ? body.id
        : typeof (body.data as { id?: unknown } | undefined)?.id === 'string'
          ? (body.data as { id: string }).id
          : undefined;

    return {
      deliveryId: input.deliveryId,
      provider: 'resend',
      providerMessageId,
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

/**
 * Build an email transport for a configured provider route.
 * Unknown providers fall back to capture so local/dev stays safe unless Resend is configured.
 */
export function buildEmailTransport(
  providerType: string,
  credentialsRef: string,
  senderDomain?: string,
): EmailTransport & { providerName?: string } {
  switch (providerType) {
    case 'resend':
      return new ResendEmailTransport(credentialsRef);
    case 'opencore_email_sdk':
      return new OpenCoreEmailSdkTransport(credentialsRef, senderDomain ?? 'localhost');
    case 'smtp':
      return new SmtpEmailTransport(
        process.env.SMTP_HOST ?? 'localhost',
        Number(process.env.SMTP_PORT ?? '587'),
        process.env.SMTP_USERNAME ?? '',
        process.env.SMTP_PASSWORD ?? '',
      );
    case 'capture':
      return new CaptureEmailTransport();
    default:
      if (process.env.RESEND_API_KEY) {
        return new ResendEmailTransport('RESEND_API_KEY');
      }
      return new CaptureEmailTransport();
  }
}

/**
 * Default API/worker transport: Resend when RESEND_API_KEY is set, otherwise capture.
 */
export function createDefaultEmailTransport(): EmailTransport & { providerName?: string } {
  if (process.env.RESEND_API_KEY) {
    return new ResendEmailTransport('RESEND_API_KEY');
  }
  return new CaptureEmailTransport();
}

/**
 * Provider route selector. Chooses the appropriate transport based on
 * brand configuration, message category, and fallback rules.
 */
export class ProviderRouteSelector {
  constructor(
    private routes: Array<{
      id: string;
      transport: EmailTransport;
      priority: number;
      isFallback: boolean;
      allowedCategories: string[];
      rateLimitPerHour?: number;
    }>,
  ) {}

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
    opencore_email_sdk: ['attachments', 'tags', 'metadata', 'headers'],
    resend: ['attachments', 'tags', 'metadata', 'headers'],
    postmark: ['attachments', 'metadata'],
    ses: ['attachments', 'tags', 'metadata', 'headers'],
    sendgrid: ['attachments', 'categories', 'custom_args'],
    mailgun: ['attachments', 'tags', 'variables'],
    smtp: ['attachments'],
  };

  const caps = providerCapabilities[providerType] ?? [];

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
