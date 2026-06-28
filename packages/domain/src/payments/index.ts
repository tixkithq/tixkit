import type { BaseEntity, CurrencyCode, ISO8601Date, Ulid } from '../shared/index.js';

export type PaymentProviderType = 'stripe' | 'stripe_connect' | 'mock';

export type PaymentIntent = BaseEntity & {
  orderId?: Ulid;
  checkoutSessionId: Ulid;
  provider: PaymentProviderType;
  providerIntentId: string;
  amountCents: number;
  currency: CurrencyCode;
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'succeeded'
    | 'canceled'
    | 'failed';
  clientSecret?: string;
  metadata: Record<string, string>;
};

export type Refund = BaseEntity & {
  orderId: Ulid;
  paymentIntentId: Ulid;
  provider: PaymentProviderType;
  providerRefundId: string;
  amountCents: number;
  currency: CurrencyCode;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string;
  metadata: Record<string, string>;
};

export type Dispute = BaseEntity & {
  orderId: Ulid;
  paymentIntentId: Ulid;
  provider: PaymentProviderType;
  providerDisputeId: string;
  amountCents: number;
  currency: CurrencyCode;
  status: 'open' | 'challenged' | 'won' | 'lost' | 'warning' | 'expired';
  reason: string;
};

export type PaymentEvent = BaseEntity & {
  provider: PaymentProviderType;
  providerEventId: string;
  eventType: string;
  rawPayload: Record<string, unknown>;
  processedAt?: ISO8601Date;
  idempotencyKey: string;
};

export type CreatePaymentIntentInput = {
  checkoutSessionId: Ulid;
  amountCents: number;
  currency: CurrencyCode;
  description?: string;
  metadata?: Record<string, string>;
  customerId?: string;
};

export type PaymentIntentResult = {
  providerIntentId: string;
  clientSecret?: string;
  status: PaymentIntent['status'];
};

export type CapturePaymentInput = {
  providerIntentId: string;
  amountCents?: number;
};

export type CapturePaymentResult = {
  providerIntentId: string;
  status: PaymentIntent['status'];
};

export type RefundPaymentInput = {
  providerIntentId: string;
  amountCents: number;
  reason?: string;
  metadata?: Record<string, string>;
};

export type RefundResult = {
  providerRefundId: string;
  status: Refund['status'];
};

export type VerifyWebhookInput = {
  rawBody: string;
  signature: string;
  timestamp?: string;
};

export type VerifiedPaymentEvent = {
  provider: PaymentProviderType;
  providerEventId: string;
  eventType: string;
  data: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly type: PaymentProviderType;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
  capturePayment(input: CapturePaymentInput): Promise<CapturePaymentResult>;
  refundPayment(input: RefundPaymentInput): Promise<RefundResult>;
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedPaymentEvent>;
}
