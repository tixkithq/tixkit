import { createHash } from 'node:crypto';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import Stripe from 'stripe';
import {
  parseRetryAfter,
  ProviderOperationError,
  type ProviderClientRuntime,
  type ProviderDeliveryState,
  type ProviderFailureKind,
  type ProviderServiceOutcome,
  type ProviderTelemetryEvent,
} from './index.js';

export const STRIPE_API_VERSION = '2026-06-24.dahlia' as const;
export const STRIPE_REQUEST_TIMEOUT_MS = 20_000;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const RETRYABLE_STRIPE_SERVER_STATUSES = new Set([500, 502, 503, 504]);
const STRIPE_WEBHOOK_VERIFIER_KEY = 'sk_test_tixkit_webhook_verifier';

export interface StripeWebhookObject {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly payment_intent?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly amount?: number;
  readonly currency?: string;
  readonly last_payment_error?: { readonly message?: string } | null;
  readonly default_currency?: string | null;
  readonly details_submitted?: boolean;
  readonly charges_enabled?: boolean;
  readonly payouts_enabled?: boolean;
  readonly requirements?: Readonly<Record<string, unknown>> & {
    readonly disabled_reason?: string | null;
  };
}

export interface StripeWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly account?: string;
  readonly data: { readonly object: StripeWebhookObject };
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface VerifyStripeWebhookInput {
  rawBody: string;
  signature: string;
  webhookSecret: string;
  secretKey?: string;
}

export interface StripeWebhookVerifierOptions {
  constructEvent?: (
    rawBody: string,
    signature: string,
    webhookSecret: string,
  ) => unknown | Promise<unknown>;
}

export async function verifyStripeWebhookEvent(
  input: Readonly<VerifyStripeWebhookInput>,
  options: Readonly<StripeWebhookVerifierOptions> = {},
): Promise<StripeWebhookEvent> {
  if (!input.rawBody || !input.signature || !input.webhookSecret) {
    throw stripeWebhookVerificationError();
  }
  try {
    let constructEvent = options.constructEvent;
    if (!constructEvent) {
      const stripe = new Stripe(input.secretKey?.trim() || STRIPE_WEBHOOK_VERIFIER_KEY, {
        apiVersion: STRIPE_API_VERSION,
        maxNetworkRetries: 0,
        timeout: STRIPE_REQUEST_TIMEOUT_MS,
        telemetry: false,
      });
      constructEvent = stripe.webhooks.constructEventAsync.bind(stripe.webhooks);
    }
    const event = await constructEvent(input.rawBody, input.signature, input.webhookSecret);
    if (!isRecord(event) || !stringValue(event.id) || !stringValue(event.type)) {
      throw malformedStripeResponse('webhook.verify');
    }
    const data = isRecord(event.data) ? event.data : undefined;
    const object = data && isRecord(data.object) ? data.object : undefined;
    if (!object) throw malformedStripeResponse('webhook.verify');
    const account = stringValue(event.account);
    return {
      id: stringValue(event.id) as string,
      type: stringValue(event.type) as string,
      ...(account ? { account } : {}),
      data: { object: object as StripeWebhookObject },
      payload: event,
    };
  } catch (error) {
    if (error instanceof ProviderOperationError) throw error;
    throw stripeWebhookVerificationError();
  }
}

export interface StripePaymentIntent {
  id: string;
  status: string;
  clientSecret?: string;
  amount: number;
  amountReceived: number;
}

export interface StripeRefund {
  id: string;
  status?: string;
}

export interface StripeConnectAccount {
  id: string;
  defaultCurrency?: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirements: Readonly<Record<string, unknown>>;
  disabledReason: string | null;
}

export interface StripeAccountLink {
  url: string;
}

export interface CreateStripePaymentIntentInput {
  amount: number;
  currency: string;
  description?: string;
  metadata: Readonly<Record<string, string>>;
  connectedAccountId?: string;
  applicationFeeAmount?: number;
  idempotencyKey: string;
}

export interface CreateStripeRefundInput {
  paymentIntentId: string;
  amount: number;
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  reverseTransfer?: boolean;
  refundApplicationFee?: boolean;
  idempotencyKey: string;
}

export interface CreateStripeConnectAccountInput {
  country: string;
  businessName: string;
  metadata: Readonly<Record<string, string>>;
  idempotencyKey: string;
}

export interface CreateStripeAccountLinkInput {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
  idempotencyKey: string;
}

export interface StripeGateway {
  createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntent>;
  retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent>;
  cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<StripePaymentIntent>;
  createRefund(input: CreateStripeRefundInput): Promise<StripeRefund>;
  createConnectAccount(input: CreateStripeConnectAccountInput): Promise<StripeConnectAccount>;
  retrieveConnectAccount(accountId: string): Promise<StripeConnectAccount>;
  deleteConnectAccount(accountId: string, idempotencyKey: string): Promise<void>;
  createAccountLink(input: CreateStripeAccountLinkInput): Promise<StripeAccountLink>;
}

type StripeRequestOptions = { idempotencyKey?: string };
type StripeSdkFacade = {
  paymentIntents: {
    create(params: Record<string, unknown>, options: StripeRequestOptions): Promise<unknown>;
    retrieve(id: string): Promise<unknown>;
    cancel(
      id: string,
      params: Record<string, never>,
      options: StripeRequestOptions,
    ): Promise<unknown>;
  };
  refunds: {
    create(params: Record<string, unknown>, options: StripeRequestOptions): Promise<unknown>;
  };
  accounts: {
    create(params: Record<string, unknown>, options: StripeRequestOptions): Promise<unknown>;
    retrieve(id: string): Promise<unknown>;
    del(id: string, params: Record<string, never>, options: StripeRequestOptions): Promise<unknown>;
  };
  accountLinks: {
    create(params: Record<string, unknown>, options: StripeRequestOptions): Promise<unknown>;
  };
};

export interface StripeSdkConfiguration {
  apiVersion: typeof STRIPE_API_VERSION;
  maxNetworkRetries: 0;
  timeout: typeof STRIPE_REQUEST_TIMEOUT_MS;
  telemetry: false;
}

export type StripeSdkFactory = (
  secretKey: string,
  configuration: Readonly<StripeSdkConfiguration>,
) => StripeSdkFacade;

export interface StripeGatewayOptions extends Pick<ProviderClientRuntime, 'onTelemetry'> {
  sdkFactory?: StripeSdkFactory;
}

export class StripeSdkGateway implements StripeGateway {
  private readonly sdk: StripeSdkFacade;
  private readonly runtime: ProviderClientRuntime;

  constructor(secretKey: string, options: StripeGatewayOptions = {}) {
    if (!secretKey.trim()) {
      throw stripeConfigurationError('construct-client');
    }
    const configuration: StripeSdkConfiguration = {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      telemetry: false,
    };
    this.sdk = options.sdkFactory
      ? options.sdkFactory(secretKey, Object.freeze(configuration))
      : (new Stripe(secretKey, configuration) as unknown as StripeSdkFacade);
    this.runtime = {
      onTelemetry: options.onTelemetry,
    };
  }

  async createPaymentIntent(input: CreateStripePaymentIntentInput): Promise<StripePaymentIntent> {
    requireIdempotencyKey(input.idempotencyKey, 'payment-intent.create');
    const params: Record<string, unknown> = {
      amount: input.amount,
      currency: input.currency.toLowerCase(),
      description: input.description,
      automatic_payment_methods: { enabled: true },
      metadata: input.metadata,
    };
    if (input.connectedAccountId) {
      params.transfer_data = { destination: input.connectedAccountId };
      if (input.applicationFeeAmount && input.applicationFeeAmount > 0) {
        params.application_fee_amount = input.applicationFeeAmount;
      }
    }
    return this.execute(
      'payment-intent.create',
      'POST',
      true,
      () => this.sdk.paymentIntents.create(params, { idempotencyKey: input.idempotencyKey }),
      paymentIntent,
    );
  }

  async retrievePaymentIntent(paymentIntentId: string): Promise<StripePaymentIntent> {
    requireIdentifier(paymentIntentId, 'payment-intent.retrieve');
    return this.execute(
      'payment-intent.retrieve',
      'GET',
      false,
      () => this.sdk.paymentIntents.retrieve(paymentIntentId),
      paymentIntent,
    );
  }

  async cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<StripePaymentIntent> {
    requireIdentifier(paymentIntentId, 'payment-intent.cancel');
    requireIdempotencyKey(idempotencyKey, 'payment-intent.cancel');
    return this.execute(
      'payment-intent.cancel',
      'POST',
      true,
      () => this.sdk.paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey }),
      paymentIntent,
    );
  }

  async createRefund(input: CreateStripeRefundInput): Promise<StripeRefund> {
    requireIdentifier(input.paymentIntentId, 'refund.create');
    requireIdempotencyKey(input.idempotencyKey, 'refund.create');
    return this.execute(
      'refund.create',
      'POST',
      true,
      () =>
        this.sdk.refunds.create(
          {
            payment_intent: input.paymentIntentId,
            amount: input.amount,
            reason: input.reason,
            reverse_transfer: input.reverseTransfer,
            refund_application_fee: input.refundApplicationFee,
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      refund,
    );
  }

  async createConnectAccount(
    input: CreateStripeConnectAccountInput,
  ): Promise<StripeConnectAccount> {
    requireIdempotencyKey(input.idempotencyKey, 'connect-account.create');
    return this.execute(
      'connect-account.create',
      'POST',
      true,
      () =>
        this.sdk.accounts.create(
          {
            type: 'express',
            country: input.country,
            business_profile: { name: input.businessName },
            metadata: input.metadata,
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      connectAccount,
    );
  }

  async retrieveConnectAccount(accountId: string): Promise<StripeConnectAccount> {
    requireIdentifier(accountId, 'connect-account.retrieve');
    return this.execute(
      'connect-account.retrieve',
      'GET',
      false,
      () => this.sdk.accounts.retrieve(accountId),
      connectAccount,
    );
  }

  async deleteConnectAccount(accountId: string, idempotencyKey: string): Promise<void> {
    requireIdentifier(accountId, 'connect-account.delete');
    requireIdempotencyKey(idempotencyKey, 'connect-account.delete');
    await this.execute(
      'connect-account.delete',
      'DELETE',
      true,
      () => this.sdk.accounts.del(accountId, {}, { idempotencyKey }),
      deletedConnectAccount,
    );
  }

  async createAccountLink(input: CreateStripeAccountLinkInput): Promise<StripeAccountLink> {
    requireIdentifier(input.accountId, 'account-link.create');
    requireIdempotencyKey(input.idempotencyKey, 'account-link.create');
    return this.execute(
      'account-link.create',
      'POST',
      true,
      () =>
        this.sdk.accountLinks.create(
          {
            account: input.accountId,
            type: 'account_onboarding',
            refresh_url: input.refreshUrl,
            return_url: input.returnUrl,
          },
          { idempotencyKey: input.idempotencyKey },
        ),
      accountLink,
    );
  }

  private async execute<T>(
    operation: string,
    method: 'GET' | 'POST' | 'DELETE',
    sideEffecting: boolean,
    invoke: () => Promise<unknown>,
    parse: (value: unknown, operation: string) => T,
  ): Promise<T> {
    const startedAt = performance.now();
    const span = trace
      .getTracer('tixkit-provider-clients')
      .startSpan(`provider.stripe.${operation}`, {
        kind: SpanKind.CLIENT,
        attributes: {
          'server.address': 'stripe',
          'http.request.method': method,
          'tixkit.provider.dependency': 'stripe',
          'tixkit.provider.operation': operation,
        },
      });
    try {
      const result = await invoke();
      const parsed = parse(result, operation);
      const response = lastResponse(result);
      const durationMs = elapsed(startedAt);
      span.setAttributes({
        'http.response.status_code': response.statusCode ?? 200,
        'tixkit.provider.outcome': 'success',
        'tixkit.provider.retryable': false,
        'tixkit.provider.duration_ms': durationMs,
      });
      span.setStatus({ code: SpanStatusCode.OK });
      emit(this.runtime, {
        dependency: 'stripe',
        operation,
        method,
        outcome: 'success',
        serviceOutcome: 'success',
        durationMs,
        retryable: false,
        status: response.statusCode ?? 200,
      });
      return parsed;
    } catch (cause) {
      const error = normalizeStripeError(operation, sideEffecting, cause);
      const serviceOutcome = stripeServiceOutcome(cause);
      const durationMs = elapsed(startedAt);
      span.setAttributes({
        'tixkit.provider.outcome': error.kind,
        'tixkit.provider.retryable': error.retryable,
        'tixkit.provider.duration_ms': durationMs,
        ...(error.details.status === undefined
          ? {}
          : { 'http.response.status_code': error.details.status }),
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      emit(this.runtime, {
        dependency: 'stripe',
        operation,
        method,
        outcome: error.kind,
        serviceOutcome,
        durationMs,
        retryable: error.retryable,
        ...(error.details.status === undefined ? {} : { status: error.details.status }),
      });
      throw error;
    } finally {
      span.end();
    }
  }
}

function stripeServiceOutcome(cause: unknown): ProviderServiceOutcome {
  if (cause instanceof ProviderOperationError) return 'platform_failure';
  const record = isRecord(cause) ? cause : {};
  const raw = isRecord(record.raw) ? record.raw : {};
  const type = stringValue(record.type) ?? stringValue(raw.type) ?? stringValue(record.name);
  const status = integerValue(record.statusCode) ?? integerValue(raw.statusCode);
  return type === 'StripeCardError' || status === 402 ? 'decline' : 'platform_failure';
}

function normalizeStripeError(
  operation: string,
  sideEffecting: boolean,
  cause: unknown,
): ProviderOperationError {
  if (cause instanceof ProviderOperationError) return cause;
  const record = isRecord(cause) ? cause : {};
  const raw = isRecord(record.raw) ? record.raw : {};
  const type = stringValue(record.type) ?? stringValue(raw.type) ?? stringValue(record.name);
  const status = integerValue(record.statusCode) ?? integerValue(raw.statusCode);
  const code = safeStripeCode(
    stringValue(record.code) ?? stringValue(raw.code) ?? stringValue(raw.decline_code),
  );
  const headers = headerRecord(record.headers) ?? headerRecord(raw.headers);
  const requestId =
    safeRequestId(stringValue(record.requestId)) ??
    safeRequestId(headers?.['request-id']) ??
    safeRequestId(headers?.['stripe-request-id']);
  const retryAfterMs = parseRetryAfter(headers?.['retry-after'] ?? null);
  const timeout =
    type === 'StripeConnectionError' && /time(?:d)?out|etimedout/iu.test(errorText(cause));
  const rateLimited = type === 'StripeRateLimitError' || status === 429;
  const server = type === 'StripeAPIError' || (status !== undefined && status >= 500);
  const transport = type === 'StripeConnectionError';
  const kind: ProviderFailureKind = timeout
    ? 'timeout'
    : rateLimited
      ? 'rate-limit'
      : server
        ? 'server'
        : transport || (status === undefined && !type?.startsWith('Stripe'))
          ? 'transport'
          : 'validation';
  const retryable =
    kind === 'timeout' ||
    kind === 'rate-limit' ||
    kind === 'transport' ||
    (kind === 'server' && (status === undefined || RETRYABLE_STRIPE_SERVER_STATUSES.has(status)));
  const deliveryState: ProviderDeliveryState =
    kind === 'validation' || kind === 'rate-limit'
      ? 'rejected'
      : sideEffecting
        ? 'unknown'
        : 'not-sent';
  return new ProviderOperationError(
    `stripe.${operation} failed: ${kind}${status === undefined ? '' : ` (HTTP ${status})`}`,
    'stripe',
    operation,
    kind,
    retryable,
    deliveryState,
    false,
    {
      ...(status === undefined ? {} : { status }),
      ...(code ? { providerCode: code } : {}),
      ...(requestId ? { providerRequestId: requestId } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

function paymentIntent(value: unknown, operation: string): StripePaymentIntent {
  const record = requiredRecord(value, operation);
  return {
    id: requiredString(record, 'id', operation),
    status: requiredString(record, 'status', operation),
    ...(stringValue(record.client_secret)
      ? { clientSecret: stringValue(record.client_secret) }
      : {}),
    amount: requiredInteger(record, 'amount', operation),
    amountReceived: requiredInteger(record, 'amount_received', operation),
  };
}

function refund(value: unknown, operation: string): StripeRefund {
  const record = requiredRecord(value, operation);
  return {
    id: requiredString(record, 'id', operation),
    ...(stringValue(record.status) ? { status: stringValue(record.status) } : {}),
  };
}

function connectAccount(value: unknown, operation: string): StripeConnectAccount {
  const record = requiredRecord(value, operation);
  const requirements = isRecord(record.requirements) ? record.requirements : {};
  return {
    id: requiredString(record, 'id', operation),
    ...(stringValue(record.default_currency)
      ? { defaultCurrency: stringValue(record.default_currency)?.toUpperCase() }
      : {}),
    detailsSubmitted: record.details_submitted === true,
    chargesEnabled: record.charges_enabled === true,
    payoutsEnabled: record.payouts_enabled === true,
    requirements,
    disabledReason: stringValue(requirements.disabled_reason) ?? null,
  };
}

function deletedConnectAccount(value: unknown, operation: string): void {
  const record = requiredRecord(value, operation);
  requiredString(record, 'id', operation);
  if (record.deleted !== true) throw malformedStripeResponse(operation);
}

function accountLink(value: unknown, operation: string): StripeAccountLink {
  const record = requiredRecord(value, operation);
  return { url: requiredString(record, 'url', operation) };
}

function requiredRecord(value: unknown, operation: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw malformedStripeResponse(operation);
}

function requiredString(record: Record<string, unknown>, key: string, operation: string): string {
  const value = stringValue(record[key]);
  if (value) return value;
  throw malformedStripeResponse(operation);
}

function requiredInteger(record: Record<string, unknown>, key: string, operation: string): number {
  const value = integerValue(record[key]);
  if (value !== undefined) return value;
  throw malformedStripeResponse(operation);
}

function malformedStripeResponse(operation: string): ProviderOperationError {
  return new ProviderOperationError(
    `stripe.${operation} failed: malformed-response`,
    'stripe',
    operation,
    'malformed-response',
    false,
    'accepted',
    false,
  );
}

function stripeConfigurationError(operation: string): ProviderOperationError {
  return new ProviderOperationError(
    `stripe.${operation} failed: validation`,
    'stripe',
    operation,
    'validation',
    false,
    'not-sent',
    false,
    { providerCode: 'configuration_missing' },
  );
}

function stripeWebhookVerificationError(): ProviderOperationError {
  return new ProviderOperationError(
    'stripe.webhook.verify failed: validation',
    'stripe',
    'webhook.verify',
    'validation',
    false,
    'rejected',
    false,
  );
}

function requireIdempotencyKey(value: unknown, operation: string): void {
  const invalid =
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (!invalid) return;
  throw new ProviderOperationError(
    `stripe.${operation} failed: validation`,
    'stripe',
    operation,
    'validation',
    false,
    'not-sent',
    false,
    { providerCode: 'idempotency_invalid' },
  );
}

function requireIdentifier(value: string, operation: string): void {
  if (value.trim()) return;
  throw stripeConfigurationError(operation);
}

function lastResponse(value: unknown): { statusCode?: number } {
  if (!isRecord(value) || !isRecord(value.lastResponse)) return {};
  return { statusCode: integerValue(value.lastResponse.statusCode) };
}

function headerRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') headers[key.toLowerCase()] = entry;
  }
  return headers;
}

function safeRequestId(value: string | undefined): string | undefined {
  return value ? `sha256:${createHash('sha256').update(value).digest('hex')}` : undefined;
}

function safeStripeCode(value: string | undefined): string | undefined {
  return value ? `sha256:${createHash('sha256').update(value).digest('hex')}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function errorText(error: unknown): string {
  if (!isRecord(error)) return '';
  return `${stringValue(error.message) ?? ''} ${stringValue(error.code) ?? ''}`;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1_000) / 1_000);
}

function emit(runtime: ProviderClientRuntime, event: ProviderTelemetryEvent): void {
  try {
    runtime.onTelemetry?.(Object.freeze({ ...event }));
  } catch {
    // Provider execution must not depend on telemetry delivery.
  }
}
