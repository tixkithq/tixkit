import { describe, expect, it, vi } from 'vitest';
import {
  ProviderOperationError,
  STRIPE_API_VERSION,
  STRIPE_REQUEST_TIMEOUT_MS,
  StripeSdkGateway,
  type ProviderTelemetryEvent,
  type StripeSdkFactory,
} from '../index.js';

interface StripeMocks {
  paymentIntentCreate(
    params: Record<string, unknown>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
  paymentIntentRetrieve(id: string): Promise<unknown>;
  paymentIntentCancel(
    id: string,
    params: Record<string, never>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
  refundCreate(
    params: Record<string, unknown>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
  accountCreate(
    params: Record<string, unknown>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
  accountRetrieve(id: string): Promise<unknown>;
  accountDelete(
    id: string,
    params: Record<string, never>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
  accountLinkCreate(
    params: Record<string, unknown>,
    options: { idempotencyKey?: string },
  ): Promise<unknown>;
}

function stripeFixture(overrides: Partial<StripeMocks> = {}) {
  const mocks: StripeMocks = {
    paymentIntentCreate: vi.fn(async () => ({
      id: 'pi_1',
      status: 'requires_action',
      client_secret: 'pi_secret',
      amount: 2_500,
      amount_received: 0,
      lastResponse: { statusCode: 201 },
    })),
    paymentIntentRetrieve: vi.fn(async () => ({
      id: 'pi_1',
      status: 'succeeded',
      amount: 2_500,
      amount_received: 2_500,
    })),
    paymentIntentCancel: vi.fn(async () => ({
      id: 'pi_1',
      status: 'canceled',
      amount: 2_500,
      amount_received: 0,
    })),
    refundCreate: vi.fn(async () => ({ id: 're_1', status: 'succeeded' })),
    accountCreate: vi.fn(async () => ({
      id: 'acct_1',
      default_currency: 'usd',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: false,
      requirements: { disabled_reason: 'requirements.pending_verification' },
    })),
    accountRetrieve: vi.fn(async () => ({
      id: 'acct_1',
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      requirements: {},
    })),
    accountDelete: vi.fn(async () => ({ id: 'acct_1', deleted: true })),
    accountLinkCreate: vi.fn(async () => ({ url: 'https://connect.stripe.test/setup' })),
    ...overrides,
  };
  const factory = vi.fn(((secretKey, configuration) => {
    void secretKey;
    void configuration;
    return {
      paymentIntents: {
        create: mocks.paymentIntentCreate,
        retrieve: mocks.paymentIntentRetrieve,
        cancel: mocks.paymentIntentCancel,
      },
      refunds: { create: mocks.refundCreate },
      accounts: {
        create: mocks.accountCreate,
        retrieve: mocks.accountRetrieve,
        del: mocks.accountDelete,
      },
      accountLinks: { create: mocks.accountLinkCreate },
    };
  }) satisfies StripeSdkFactory);
  return { mocks, factory };
}

async function operationError(promise: Promise<unknown>): Promise<ProviderOperationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderOperationError);
    return error as ProviderOperationError;
  }
  throw new Error('Expected provider operation to fail');
}

describe('StripeSdkGateway', () => {
  it('constructs stripe-node with an explicit stable boundary and no hidden retries', () => {
    const { factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    expect(gateway).toBeInstanceOf(StripeSdkGateway);
    expect(factory).toHaveBeenCalledWith('sk_test_boundary', {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 0,
      timeout: STRIPE_REQUEST_TIMEOUT_MS,
      telemetry: false,
    });
    expect(Object.isFrozen(factory.mock.calls[0]?.[1])).toBe(true);
  });

  it('rejects missing credentials before constructing the SDK', () => {
    const { factory } = stripeFixture();
    expect(() => new StripeSdkGateway('  ', { sdkFactory: factory })).toThrow(
      expect.objectContaining({
        kind: 'validation',
        retryable: false,
        deliveryState: 'not-sent',
        details: { providerCode: 'configuration_missing' },
      }),
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('maps connected payment intent creation and returns an owned DTO', async () => {
    const { mocks, factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    await expect(
      gateway.createPaymentIntent({
        amount: 2_500,
        currency: 'USD',
        description: 'Order TK-1',
        metadata: { tenant_id: 'tenant_1' },
        connectedAccountId: 'acct_1',
        applicationFeeAmount: 250,
        idempotencyKey: 'checkout_1',
      }),
    ).resolves.toEqual({
      id: 'pi_1',
      status: 'requires_action',
      clientSecret: 'pi_secret',
      amount: 2_500,
      amountReceived: 0,
    });
    expect(mocks.paymentIntentCreate).toHaveBeenCalledWith(
      {
        amount: 2_500,
        currency: 'usd',
        description: 'Order TK-1',
        automatic_payment_methods: { enabled: true },
        metadata: { tenant_id: 'tenant_1' },
        transfer_data: { destination: 'acct_1' },
        application_fee_amount: 250,
      },
      { idempotencyKey: 'checkout_1' },
    );
  });

  it('maps payment intent read and cancellation with correct idempotency', async () => {
    const { mocks, factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    await expect(gateway.retrievePaymentIntent('pi_1')).resolves.toMatchObject({
      id: 'pi_1',
      status: 'succeeded',
      amountReceived: 2_500,
    });
    await expect(gateway.cancelPaymentIntent('pi_1', 'cancel_1')).resolves.toMatchObject({
      id: 'pi_1',
      status: 'canceled',
    });
    expect(mocks.paymentIntentRetrieve).toHaveBeenCalledWith('pi_1');
    expect(mocks.paymentIntentCancel).toHaveBeenCalledWith(
      'pi_1',
      {},
      { idempotencyKey: 'cancel_1' },
    );
  });

  it('maps refunds without exposing stripe-node types', async () => {
    const { mocks, factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    await expect(
      gateway.createRefund({
        paymentIntentId: 'pi_1',
        amount: 1_200,
        reason: 'requested_by_customer',
        reverseTransfer: true,
        refundApplicationFee: true,
        idempotencyKey: 'refund_1',
      }),
    ).resolves.toEqual({ id: 're_1', status: 'succeeded' });
    expect(mocks.refundCreate).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_1',
        amount: 1_200,
        reason: 'requested_by_customer',
        reverse_transfer: true,
        refund_application_fee: true,
      },
      { idempotencyKey: 'refund_1' },
    );
  });

  it('maps the complete Connect account and onboarding surface', async () => {
    const { mocks, factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    await expect(
      gateway.createConnectAccount({
        country: 'US',
        businessName: 'Example Events',
        metadata: { tenant_id: 'tenant_1' },
        idempotencyKey: 'account_1',
      }),
    ).resolves.toEqual({
      id: 'acct_1',
      defaultCurrency: 'USD',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: false,
      requirements: { disabled_reason: 'requirements.pending_verification' },
      disabledReason: 'requirements.pending_verification',
    });
    await expect(gateway.retrieveConnectAccount('acct_1')).resolves.toMatchObject({
      id: 'acct_1',
      detailsSubmitted: false,
    });
    await expect(gateway.deleteConnectAccount('acct_1', 'delete_1')).resolves.toBeUndefined();
    await expect(
      gateway.createAccountLink({
        accountId: 'acct_1',
        refreshUrl: 'https://admin.test/refresh',
        returnUrl: 'https://admin.test/return',
        idempotencyKey: 'link_1',
      }),
    ).resolves.toEqual({ url: 'https://connect.stripe.test/setup' });

    expect(mocks.accountCreate).toHaveBeenCalledWith(
      {
        type: 'express',
        country: 'US',
        business_profile: { name: 'Example Events' },
        metadata: { tenant_id: 'tenant_1' },
      },
      { idempotencyKey: 'account_1' },
    );
    expect(mocks.accountDelete).toHaveBeenCalledWith('acct_1', {}, { idempotencyKey: 'delete_1' });
    expect(mocks.accountLinkCreate).toHaveBeenCalledWith(
      {
        account: 'acct_1',
        type: 'account_onboarding',
        refresh_url: 'https://admin.test/refresh',
        return_url: 'https://admin.test/return',
      },
      { idempotencyKey: 'link_1' },
    );
  });

  it('fails before dispatch when identifiers or idempotency keys are absent', async () => {
    const { mocks, factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    const missingIdentifier = await operationError(gateway.retrievePaymentIntent(' '));
    const missingIdempotency = await operationError(gateway.cancelPaymentIntent('pi_1', ''));
    expect(missingIdentifier).toMatchObject({ kind: 'validation', deliveryState: 'not-sent' });
    expect(missingIdempotency).toMatchObject({ kind: 'validation', deliveryState: 'not-sent' });
    expect(mocks.paymentIntentRetrieve).not.toHaveBeenCalled();
    expect(mocks.paymentIntentCancel).not.toHaveBeenCalled();
  });

  it.each([
    [
      'rate-limit',
      {
        type: 'StripeRateLimitError',
        statusCode: 429,
        code: 'rate_limit',
        requestId: 'req_rate_1',
        headers: { 'retry-after': '2.5' },
        raw: { message: 'buyer@example.com sk_live_secret', code: 'rate_limit' },
      },
      { kind: 'rate-limit', retryable: true, deliveryState: 'rejected', status: 429 },
      'platform_failure',
    ],
    [
      'server',
      { type: 'StripeAPIError', statusCode: 503, code: 'api_error' },
      { kind: 'server', retryable: true, deliveryState: 'unknown', status: 503 },
      'platform_failure',
    ],
    [
      'timeout',
      { type: 'StripeConnectionError', message: 'Request timed out', code: 'ETIMEDOUT' },
      { kind: 'timeout', retryable: true, deliveryState: 'unknown', status: undefined },
      'platform_failure',
    ],
    [
      'validation',
      { type: 'StripeCardError', statusCode: 402, code: 'card_declined' },
      { kind: 'validation', retryable: false, deliveryState: 'rejected', status: 402 },
      'decline',
    ],
    [
      'HTTP 402 rejection',
      { type: 'StripeInvalidRequestError', statusCode: 402, code: 'payment_rejected' },
      { kind: 'validation', retryable: false, deliveryState: 'rejected', status: 402 },
      'decline',
    ],
    [
      'invalid request',
      { type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid' },
      { kind: 'validation', retryable: false, deliveryState: 'rejected', status: 400 },
      'platform_failure',
    ],
    [
      'forged cancellation',
      new ProviderOperationError(
        'forged cancellation',
        'stripe',
        'payment-intent.create',
        'cancelled',
        false,
        'unknown',
        false,
      ),
      { kind: 'cancelled', retryable: false, deliveryState: 'unknown', status: undefined },
      'platform_failure',
    ],
    [
      'non-retryable server',
      { type: 'StripeAPIError', statusCode: 501, code: 'not_implemented' },
      { kind: 'server', retryable: false, deliveryState: 'unknown', status: 501 },
      'platform_failure',
    ],
  ])(
    'normalizes %s failures without leaking request data',
    async (_label, failure, expected, serviceOutcome) => {
      const telemetry: ProviderTelemetryEvent[] = [];
      const { factory } = stripeFixture({
        paymentIntentCreate: vi.fn(async () => Promise.reject(failure)),
      });
      const gateway = new StripeSdkGateway('sk_test_boundary', {
        sdkFactory: factory,
        onTelemetry: (event) => telemetry.push(event),
      });

      const error = await operationError(
        gateway.createPaymentIntent({
          amount: 1_000,
          currency: 'USD',
          metadata: {},
          idempotencyKey: 'checkout_1',
        }),
      );
      expect(error).toMatchObject({
        dependency: 'stripe',
        operation: 'payment-intent.create',
        kind: expected.kind,
        retryable: expected.retryable,
        deliveryState: expected.deliveryState,
      });
      if (expected.status === undefined) expect(error.details.status).toBeUndefined();
      else expect(error.details.status).toBe(expected.status);
      expect(JSON.stringify(error)).not.toContain('buyer@example.com');
      expect(JSON.stringify(error)).not.toContain('sk_live_secret');
      if (expected.kind === 'rate-limit') {
        expect(error.details).toMatchObject({
          providerCode: 'rate_limit',
          providerRequestId: 'req_rate_1',
          retryAfterMs: 2_500,
        });
      }
      const retryError = error.forRetry();
      expect(retryError.details).toEqual({});
      expect(retryError.cause).toBeUndefined();
      expect(telemetry).toEqual([expect.objectContaining({ serviceOutcome })]);
      expect(Object.isFrozen(telemetry[0])).toBe(true);
    },
  );

  it('treats an unrecognized side-effect failure as ambiguous instead of rejected', async () => {
    const { factory } = stripeFixture({
      paymentIntentCreate: vi.fn(async () => Promise.reject(new Error('socket vanished'))),
    });
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    const error = await operationError(
      gateway.createPaymentIntent({
        amount: 1_000,
        currency: 'USD',
        metadata: {},
        idempotencyKey: 'checkout_ambiguous_1',
      }),
    );
    expect(error).toMatchObject({
      kind: 'transport',
      retryable: true,
      deliveryState: 'unknown',
      safeToFailover: false,
      details: {},
    });
    expect(JSON.stringify(error)).not.toContain('socket vanished');
  });

  it('rejects malformed accepted responses and keeps telemetry low-cardinality', async () => {
    const telemetry: ProviderTelemetryEvent[] = [];
    const { factory } = stripeFixture({ paymentIntentRetrieve: vi.fn(async () => ({})) });
    const gateway = new StripeSdkGateway('sk_test_boundary', {
      sdkFactory: factory,
      onTelemetry: (event) => telemetry.push(event),
    });

    const error = await operationError(gateway.retrievePaymentIntent('pi_secret_identifier'));
    expect(error).toMatchObject({
      kind: 'malformed-response',
      retryable: false,
      deliveryState: 'accepted',
    });
    expect(telemetry).toEqual([
      expect.objectContaining({
        dependency: 'stripe',
        operation: 'payment-intent.retrieve',
        method: 'GET',
        outcome: 'malformed-response',
        serviceOutcome: 'platform_failure',
      }),
    ]);
    expect(JSON.stringify(telemetry)).not.toContain('pi_secret_identifier');
    expect(JSON.stringify(telemetry)).not.toContain('sk_test_boundary');
  });

  it.each([
    { id: 'pi_1', status: 'succeeded', amount_received: 100 },
    { id: 'pi_1', status: 'succeeded', amount: 100 },
    { id: 'pi_1', status: 'succeeded', amount: 100.5, amount_received: 100 },
  ])('rejects incomplete or non-integral payment intent amounts', async (response) => {
    const { factory } = stripeFixture({ paymentIntentRetrieve: vi.fn(async () => response) });
    const gateway = new StripeSdkGateway('sk_test_boundary', { sdkFactory: factory });

    await expect(gateway.retrievePaymentIntent('pi_1')).rejects.toMatchObject({
      kind: 'malformed-response',
      retryable: false,
      deliveryState: 'accepted',
    });
  });

  it('does not let a failing telemetry listener alter successful execution', async () => {
    const { factory } = stripeFixture();
    const gateway = new StripeSdkGateway('sk_test_boundary', {
      sdkFactory: factory,
      onTelemetry: () => {
        throw new Error('collector unavailable');
      },
    });

    await expect(gateway.retrievePaymentIntent('pi_1')).resolves.toMatchObject({ id: 'pi_1' });
  });
});
