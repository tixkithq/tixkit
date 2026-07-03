import type { BaseEntity, ISO8601Date, TenantScopedEntity, Ulid } from '../shared/index.js';
import type { TemplateKey } from './template-lifecycles.js';

export * from './merge-tags.js';
export * from './short-links.js';
export * from './template-lifecycles.js';

export type EmailTransportStatus =
  | 'accepted'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'failed'
  | 'complained';

export interface EmailTransport {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface SmsTransport {
  send(input: SendSmsInput): Promise<SendSmsResult>;
}

export type SendEmailInput = {
  tenantId: Ulid;
  organizationId: Ulid;
  brandId: Ulid;
  templateKey: string;
  templateVersionId: Ulid;
  deliveryId: Ulid;
  from: { email: string; name?: string };
  to: { email: string; name?: string }[];
  replyTo?: { email: string; name?: string };
  subject: string;
  html: string;
  text?: string;
  attachments?: {
    filename: string;
    contentType: string;
    content: string | Uint8Array;
    contentEncoding?: 'base64';
  }[];
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
  metadata: {
    orderId?: Ulid;
    eventId?: Ulid;
    attendeeId?: Ulid;
    ticketId?: Ulid;
    notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
  };
  providerRouteId: Ulid;
  idempotencyKey: string;
};

export type SendEmailResult = {
  deliveryId: Ulid;
  provider: string;
  providerMessageId?: string;
  status: EmailTransportStatus;
  attemptedFallbackProviders: string[];
  sentAt: ISO8601Date;
};

export type SmsTransportStatus = 'accepted' | 'queued' | 'sent' | 'delivered' | 'failed';

export type SendSmsInput = {
  tenantId: Ulid;
  organizationId: Ulid;
  brandId: Ulid;
  jobId: Ulid;
  deliveryId: Ulid;
  from: string;
  to: string;
  body: string;
  providerRouteId: Ulid;
  idempotencyKey: string;
  notificationType: 'transactional' | 'bulk' | 'staff' | 'system';
  webhookUrl?: string;
  metadata?: {
    orderId?: Ulid;
    eventId?: Ulid;
    attendeeId?: Ulid;
    ticketId?: Ulid;
  };
};

export type SendSmsResult = {
  deliveryId: Ulid;
  provider: 'telnyx' | 'twilio' | 'vonage' | 'plivo' | 'capture' | 'none';
  providerMessageId?: string;
  status: SmsTransportStatus;
  attemptedFallbackProviders: string[];
  sentAt: ISO8601Date;
};

export type NotificationTemplate = TenantScopedEntity & {
  brandId?: Ulid;
  key: string;
  name: string;
  description?: string;
  category: 'transactional' | 'bulk' | 'staff' | 'system';
  variables: string[];
  currentVersionId?: Ulid;
};

export type NotificationTemplateVersion = BaseEntity & {
  templateId: Ulid;
  version: number;
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate?: string;
  locale: string;
  isDefault: boolean;
  publishedAt?: ISO8601Date;
};

export type BrandSenderIdentity = TenantScopedEntity & {
  brandId: Ulid;
  email: string;
  name: string;
  replyToEmail?: string;
  verified: boolean;
  verifiedAt?: ISO8601Date;
};

export type EmailProviderRoute = TenantScopedEntity & {
  brandId: Ulid;
  providerType:
    | 'opencore_email_sdk'
    | 'resend'
    | 'postmark'
    | 'ses'
    | 'sendgrid'
    | 'mailgun'
    | 'smtp';
  credentialsRef: string;
  senderDomain: string;
  priority: number;
  isFallback: boolean;
  rateLimitPerHour?: number;
  allowedCategories: ('transactional' | 'bulk' | 'staff' | 'system')[];
  status: 'pending' | 'verified' | 'active' | 'disabled';
  smokeSendVerified: boolean;
};

export type SmsProviderRoute = TenantScopedEntity & {
  brandId: Ulid;
  providerType: 'telnyx' | 'twilio' | 'vonage' | 'plivo' | 'capture';
  credentialsRef: string;
  senderIdentityId: Ulid;
  priority: number;
  isFallback: boolean;
  rateLimitPerHour?: number;
  allowedCategories: ('transactional' | 'bulk' | 'staff' | 'system')[];
  status: 'pending' | 'verified' | 'active' | 'disabled';
  smokeSendVerified: boolean;
  webhookUrl?: string;
};

export type SmsSenderIdentity = TenantScopedEntity & {
  brandId: Ulid;
  sender: string;
  kind: 'phone_number' | 'short_code' | 'alphanumeric';
  providerType: 'telnyx' | 'twilio' | 'vonage' | 'plivo' | 'capture';
  providerSenderId?: string;
  verified: boolean;
  verifiedAt?: ISO8601Date;
};

export type EmailJob = TenantScopedEntity & {
  brandId: Ulid;
  templateKey: string;
  templateVersionId: Ulid;
  toEmail: string;
  toName?: string;
  variables: Record<string, unknown>;
  providerRouteId: Ulid;
  status: 'queued' | 'processing' | 'sent' | 'failed' | 'suppressed';
  priority: 'high' | 'normal' | 'low';
  scheduledAt?: ISO8601Date;
  idempotencyKey: string;
  workflowId?: string;
};

export type EmailDelivery = TenantScopedEntity & {
  jobId: Ulid;
  provider: string;
  providerMessageId?: string;
  status: EmailTransportStatus;
  attemptedProviders: string[];
  acceptedProvider?: string;
  sentAt?: ISO8601Date;
  deliveredAt?: ISO8601Date;
  bouncedAt?: ISO8601Date;
  bounceReason?: string;
  metadata: Record<string, unknown>;
};

export type EmailProviderEvent = BaseEntity & {
  provider: string;
  providerEventId: string;
  eventType: string;
  providerMessageId?: string;
  rawPayload: Record<string, unknown>;
  processedAt?: ISO8601Date;
  deliveryId?: Ulid;
};

export type EmailSuppression = TenantScopedEntity & {
  email: string;
  reason: 'bounce' | 'complaint' | 'unsubscribe' | 'manual';
  bounceType?: 'hard' | 'soft';
  source: string;
};

export type SmsJob = TenantScopedEntity & {
  brandId: Ulid;
  toPhone: string;
  body: string;
  templateKey?: string;
  variables?: Record<string, unknown>;
  providerRouteId: Ulid;
  status: 'queued' | 'processing' | 'sent' | 'failed' | 'suppressed';
  priority: 'high' | 'normal' | 'low';
  scheduledAt?: ISO8601Date;
  idempotencyKey: string;
  workflowId?: string;
};

export type SmsDelivery = TenantScopedEntity & {
  jobId: Ulid;
  provider: SendSmsResult['provider'];
  providerMessageId?: string;
  status: SmsTransportStatus;
  attemptedProviders: string[];
  acceptedProvider?: SendSmsResult['provider'];
  sentAt?: ISO8601Date;
  deliveredAt?: ISO8601Date;
  failedAt?: ISO8601Date;
  failureReason?: string;
  metadata: Record<string, unknown>;
};

export type SmsProviderEvent = BaseEntity & {
  tenantId?: Ulid;
  provider: SendSmsResult['provider'];
  providerEventId: string;
  eventType: string;
  providerMessageId?: string;
  rawPayload: Record<string, unknown>;
  processedAt?: ISO8601Date;
};

export type MessageConsent = TenantScopedEntity & {
  attendeeId: Ulid;
  email: string;
  phone?: string;
  emailOptIn: boolean;
  smsOptIn: boolean;
  consentText: string;
  consentVersion: string;
  consentedAt: ISO8601Date;
  revokedAt?: ISO8601Date;
};

export type MessageCampaignChannel = 'email' | 'sms' | 'both';
export type MessageCampaignStatus =
  | 'queued'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'suppressed'
  | 'no_recipients';

export type MessageCampaignSummary = {
  id: string;
  eventId: Ulid;
  tenantId: Ulid;
  brandId: Ulid;
  templateKey: TemplateKey | string;
  channel: MessageCampaignChannel;
  status: MessageCampaignStatus;
  audience?: 'all_attendees' | 'checked_in' | 'not_checked_in' | 'custom';
  audienceKey?: 'all' | 'checked_in' | 'not_checked_in' | 'specific';
  audienceAttendeeIds?: Ulid[];
  audienceLabel?: string;
  audienceCount: number;
  queuedEmailJobs: number;
  queuedSmsJobs: number;
  suppressedRecipients: number;
  consentExclusions: number;
  skippedRecipients: number;
  createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
};

export type MessageCampaignDetail = MessageCampaignSummary & {
  emailJobs: EmailJob[];
  smsJobs: SmsJob[];
  emailDeliveries: EmailDelivery[];
  smsDeliveries: SmsDelivery[];
};

export type MessageCampaignJob = (
  | { channel: 'email'; job: EmailJob }
  | { channel: 'sms'; job: SmsJob }
) & {
  campaignId: string;
  eventId: Ulid;
};

export type MessageDeliveryLog = (
  | { channel: 'email'; delivery: EmailDelivery }
  | { channel: 'sms'; delivery: SmsDelivery }
) & {
  campaignId: string;
  eventId: Ulid;
};

export type MessageProviderEventLog = {
  channel: 'sms';
  campaignId: string;
  eventId: Ulid;
  event: SmsProviderEvent;
};

export type SendMessageInput = {
  eventId: Ulid;
  templateKey: TemplateKey;
  audience: 'all' | 'checked_in' | 'not_checked_in' | 'specific';
  attendeeIds?: Ulid[];
  scheduledAt?: ISO8601Date;
  variables?: Record<string, unknown>;
  channel: 'email' | 'sms' | 'both';
};
