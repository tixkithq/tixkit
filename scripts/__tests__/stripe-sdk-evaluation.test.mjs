import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  assertStripePackagePlacement,
  BENEFIT_THRESHOLDS,
  buildStripeSdkEvaluation,
  buildStripeWirePrototype,
  expectedDecision,
  logicalPackageMetrics,
  STARTUP_SAMPLES,
  stripeLockResolution,
  stripeSdkEvaluationViolations,
  STRIPE_EVALUATION_PATH,
  STRIPE_EVALUATION_SCHEMA_PATH,
  STRIPE_OPERATIONS,
} from '../lib/stripe-sdk-evaluation.mjs';

const root = resolve(import.meta.dirname, '../..');

function timing(median) {
  const samples = Array.from({ length: STARTUP_SAMPLES }, (_, index) => median + index / 100);
  return {
    samples,
    median: samples[Math.floor(samples.length / 2)],
    p95: samples[Math.ceil(samples.length * 0.95) - 1],
    minimum: samples[0],
    maximum: samples.at(-1),
  };
}

function stableStartupMeasurement() {
  return {
    runtime: 'node@test test-platform',
    warmups: 5,
    samplesPerCase: STARTUP_SAMPLES,
    containedSdkMs: timing(50),
    directCandidateMs: timing(25),
  };
}

function currentEvaluation() {
  return buildStripeSdkEvaluation(root, { startupMeasurement: stableStartupMeasurement() });
}

function capturedStripeGatewayWire() {
  const runner = String.raw`
import Stripe from './packages/provider-clients/node_modules/stripe/esm/stripe.esm.node.js';
import { StripeSdkGateway } from './packages/provider-clients/src/stripe.ts';
const captures = [];
let operation = '';
const response = () => {
  if (operation.startsWith('payment-intent.')) return { id: 'pi_1', status: 'succeeded', amount: 1200, amount_received: 1200 };
  if (operation === 'refund.create') return { id: 're_1', status: 'succeeded' };
  if (operation === 'connect-account.delete') return { id: 'acct_1', deleted: true };
  if (operation.startsWith('connect-account.')) return { id: 'acct_1', details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: {} };
  return { url: 'https://connect.stripe.example/setup' };
};
const httpClient = {
  getClientName: () => 'tixkit-evaluation-capture',
  makeRequest: async (host, port, path, method, headers, requestData, protocol, timeout) => {
    captures.push({ operation, host, port, path, method, headers, requestData, protocol, timeout });
    return {
      getStatusCode: () => 200,
      getHeaders: () => ({ 'request-id': 'req_local_capture' }),
      getRawResponse: () => ({}),
      toJSON: async () => response(),
    };
  },
};
let factoryEvidence;
const gateway = new StripeSdkGateway('sk_test_evaluation_capture', {
  sdkFactory: (key, configuration) => {
    factoryEvidence = { keyMatches: key === 'sk_test_evaluation_capture', configuration };
    return new Stripe(key, { ...configuration, httpClient });
  },
});
const cases = [
  ['account-link.create', () => gateway.createAccountLink({ accountId: 'acct_1', refreshUrl: 'https://admin.example/refresh', returnUrl: 'https://admin.example/return', idempotencyKey: 'idem_link' })],
  ['connect-account.create', () => gateway.createConnectAccount({ country: 'US', businessName: 'Example Events', metadata: { tenant_id: 'tenant_1' }, idempotencyKey: 'idem_account' })],
  ['connect-account.delete', () => gateway.deleteConnectAccount('acct_1', 'idem_delete')],
  ['connect-account.retrieve', () => gateway.retrieveConnectAccount('acct_1')],
  ['payment-intent.cancel', () => gateway.cancelPaymentIntent('pi_1', 'idem_cancel')],
  ['payment-intent.create', () => gateway.createPaymentIntent({ amount: 1200, currency: 'USD', description: 'Admission', metadata: { order_id: 'order_1', tenant_id: 'tenant_1' }, connectedAccountId: 'acct_1', applicationFeeAmount: 120, idempotencyKey: 'idem_payment' })],
  ['payment-intent.retrieve', () => gateway.retrievePaymentIntent('pi_1')],
  ['refund.create', () => gateway.createRefund({ paymentIntentId: 'pi_1', amount: 500, reason: 'requested_by_customer', reverseTransfer: true, refundApplicationFee: true, idempotencyKey: 'idem_refund' })],
];
for (const [id, invoke] of cases) { operation = id; await invoke(); }
process.stdout.write(JSON.stringify({ captures, factoryEvidence }));
`;
  const result = spawnSync('bun', ['--eval', runner], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('checked-in evaluation is strict, current, and retains the contained SDK', () => {
  const evaluation = JSON.parse(readFileSync(resolve(root, STRIPE_EVALUATION_PATH), 'utf8'));
  const schema = JSON.parse(readFileSync(resolve(root, STRIPE_EVALUATION_SCHEMA_PATH), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(evaluation), true, JSON.stringify(validate.errors));
  const current = buildStripeSdkEvaluation(root, {
    startupMeasurement: evaluation.startupMeasurement,
  });
  assert.deepEqual(stripeSdkEvaluationViolations(evaluation, current), []);
  assert.equal(evaluation.decision, 'retain-contained-sdk');
  assert.equal(evaluation.directCandidate.shippingRuntime, false);
  assert.equal(evaluation.directCandidate.networkCallsPerformed, false);
  assert.equal(evaluation.directCandidate.stripeRuntimeDependencyStillRequired, true);
  assert.equal(evaluation.benefitMeasurements.materialBenefitPass, false);
  assert.ok(evaluation.parityGates.some(({ status }) => status === 'not-run'));
});

test('Stripe runtime and test-only dependency placements are exact', () => {
  assert.doesNotThrow(() => assertStripePackagePlacement(root));
  const evaluation = currentEvaluation();
  assert.equal(evaluation.containedSdk.dependencyClass, 'dependencies');
  assert.deepEqual(
    evaluation.containedSdk.testOnlyPlacements.map(
      ({ manifest, dependencyClass }) => `${manifest}:${dependencyClass}`,
    ),
    [
      'packages/api/package.json:devDependencies',
      'packages/workflows/package.json:devDependencies',
    ],
  );
});

test('lock and installed package measurements are deterministic logical content', () => {
  const lockfile = readFileSync(resolve(root, 'bun.lock'), 'utf8');
  const resolution = stripeLockResolution(lockfile);
  assert.match(resolution.resolvedVersion, /^\d+\.\d+\.\d+/u);
  assert.match(resolution.lockIntegrity, /^sha512-/u);
  const first = logicalPackageMetrics(
    resolve(root, 'packages/provider-clients/node_modules/stripe'),
  );
  const second = logicalPackageMetrics(
    resolve(root, 'packages/provider-clients/node_modules/stripe'),
  );
  assert.deepEqual(first, second);
  assert.ok(first.logicalInstalledBytes > 0);
  assert.ok(first.logicalInstalledFiles > 0);
  assert.match(first.logicalContentSha256, /^[a-f0-9]{64}$/u);
});

test('bounded prototype covers the exact gateway operation surface without I/O', () => {
  assert.deepEqual(
    STRIPE_OPERATIONS.map(({ id }) => id),
    [
      'account-link.create',
      'connect-account.create',
      'connect-account.delete',
      'connect-account.retrieve',
      'payment-intent.cancel',
      'payment-intent.create',
      'payment-intent.retrieve',
      'refund.create',
    ],
  );
  const inputs = {
    'account-link.create': {
      accountId: 'acct_1',
      refreshUrl: 'https://admin.example/refresh',
      returnUrl: 'https://admin.example/return',
      idempotencyKey: 'idem_link',
    },
    'connect-account.create': {
      country: 'US',
      businessName: 'Example Events',
      metadata: { tenant_id: 'tenant_1' },
      idempotencyKey: 'idem_account',
    },
    'connect-account.delete': { accountId: 'acct_1', idempotencyKey: 'idem_delete' },
    'connect-account.retrieve': { accountId: 'acct_1' },
    'payment-intent.cancel': { paymentIntentId: 'pi_1', idempotencyKey: 'idem_cancel' },
    'payment-intent.create': {
      amount: 1200,
      currency: 'USD',
      description: 'Admission',
      metadata: { order_id: 'order_1', tenant_id: 'tenant_1' },
      connectedAccountId: 'acct_1',
      applicationFeeAmount: 120,
      idempotencyKey: 'idem_payment',
    },
    'payment-intent.retrieve': { paymentIntentId: 'pi_1' },
    'refund.create': {
      paymentIntentId: 'pi_1',
      amount: 500,
      reason: 'requested_by_customer',
      reverseTransfer: true,
      refundApplicationFee: true,
      idempotencyKey: 'idem_refund',
    },
  };
  const { captures, factoryEvidence } = capturedStripeGatewayWire();
  assert.deepEqual(factoryEvidence, {
    keyMatches: true,
    configuration: {
      apiVersion: '2026-06-24.dahlia',
      maxNetworkRetries: 0,
      timeout: 20_000,
      telemetry: false,
    },
  });
  assert.equal(captures.length, STRIPE_OPERATIONS.length);
  for (const descriptor of STRIPE_OPERATIONS) {
    const request = buildStripeWirePrototype(descriptor.id, inputs[descriptor.id]);
    const sdkRequest = captures.find(({ operation }) => operation === descriptor.id);
    assert.ok(sdkRequest, `missing Stripe SDK capture for ${descriptor.id}`);
    assert.equal(request.method, descriptor.method);
    assert.equal(request.method, sdkRequest.method);
    assert.equal(request.path, sdkRequest.path);
    assert.equal(request.body, sdkRequest.requestData);
    assert.equal(request.headers['Stripe-Version'], '2026-06-24.dahlia');
    assert.equal(request.headers['Stripe-Version'], sdkRequest.headers['Stripe-Version']);
    assert.equal(request.headers['Content-Type'], sdkRequest.headers['Content-Type']);
    assert.equal(
      request.headers['Content-Length'],
      sdkRequest.headers['Content-Length'],
      descriptor.id,
    );
    assert.equal(request.headers.Authorization, 'Bearer <redacted>');
    assert.equal(sdkRequest.headers.Authorization, 'Bearer sk_test_evaluation_capture');
    assert.equal(Object.hasOwn(request.headers, 'Idempotency-Key'), descriptor.idempotencyRequired);
    assert.equal(request.headers['Idempotency-Key'], sdkRequest.headers['Idempotency-Key']);
    assert.equal(sdkRequest.host, 'api.stripe.com');
    assert.equal(sdkRequest.protocol, 'https');
    assert.equal(sdkRequest.timeout, 20_000);
  }
});

test('prototype form encoding matches current Stripe gateway semantics', () => {
  const payment = buildStripeWirePrototype('payment-intent.create', {
    amount: 1200,
    currency: 'USD',
    description: 'Admission & fees',
    metadata: { tenant_id: 'tenant 1', order_id: 'order/1' },
    connectedAccountId: 'acct_1',
    applicationFeeAmount: 120,
    idempotencyKey: 'idem_payment',
  });
  assert.equal(payment.path, '/v1/payment_intents');
  assert.deepEqual(
    [...new URLSearchParams(payment.body)],
    [
      ['amount', '1200'],
      ['currency', 'usd'],
      ['description', 'Admission & fees'],
      ['automatic_payment_methods[enabled]', 'true'],
      ['metadata[order_id]', 'order/1'],
      ['metadata[tenant_id]', 'tenant 1'],
      ['transfer_data[destination]', 'acct_1'],
      ['application_fee_amount', '120'],
    ],
  );

  const refund = buildStripeWirePrototype('refund.create', {
    paymentIntentId: 'pi_1',
    amount: 500,
    reason: 'requested_by_customer',
    reverseTransfer: true,
    refundApplicationFee: false,
    idempotencyKey: 'idem_refund',
  });
  assert.deepEqual(
    [...new URLSearchParams(refund.body)],
    [
      ['payment_intent', 'pi_1'],
      ['amount', '500'],
      ['reason', 'requested_by_customer'],
      ['reverse_transfer', 'true'],
      ['refund_application_fee', 'false'],
    ],
  );
});

test('prototype rejects unsupported operations, unsafe identifiers, and invalid idempotency', () => {
  assert.throws(() => buildStripeWirePrototype('charges.create', {}), /unsupported/u);
  assert.throws(
    () => buildStripeWirePrototype('payment-intent.retrieve', { paymentIntentId: ' ' }),
    /paymentIntentId/u,
  );
  assert.throws(
    () =>
      buildStripeWirePrototype('payment-intent.cancel', {
        paymentIntentId: 'pi_1',
        idempotencyKey: 'unsafe\nkey',
      }),
    /idempotencyKey/u,
  );
  for (const [operation, input, expected] of [
    ['account-link.create', { idempotencyKey: 'idem' }, /accountId/u],
    ['connect-account.create', { idempotencyKey: 'idem' }, /country/u],
    ['payment-intent.create', { amount: 100, metadata: {}, idempotencyKey: 'idem' }, /currency/u],
    [
      'payment-intent.create',
      { amount: 1.5, currency: 'usd', metadata: {}, idempotencyKey: 'idem' },
      /amount/u,
    ],
    ['refund.create', { amount: 100, idempotencyKey: 'idem' }, /paymentIntentId/u],
  ]) {
    assert.throws(() => buildStripeWirePrototype(operation, input), expected);
  }
});

test('decision fails closed on missing parity, unproven diagnostics, and retained dependency', () => {
  const evaluation = currentEvaluation();
  assert.equal(expectedDecision(evaluation), 'retain-contained-sdk');
  assert.equal(evaluation.benefitMeasurements.dependencyBytesRemoved, 0);
  assert.equal(evaluation.benefitMeasurements.startupMedianMsReduction, 0);
  assert.equal(evaluation.benefitMeasurements.newDiagnosticFields, 0);
  assert.deepEqual(evaluation.benefitThresholds, BENEFIT_THRESHOLDS);
});

test('semantic validation rejects stale bindings, weakened thresholds, forged gates and migration', () => {
  const current = currentEvaluation();
  const cases = [
    (candidate) => (candidate.bindings.providerRegistrySha256 = '0'.repeat(64)),
    (candidate) => (candidate.benefitThresholds.minimumDependencyBytesRemoved = 0),
    (candidate) => {
      const gate = candidate.parityGates.find(({ status }) => status === 'not-run');
      gate.status = 'passed';
      gate.evidence = null;
    },
    (candidate) => (candidate.benefitMeasurements.materialBenefitPass = true),
    (candidate) => (candidate.decision = 'migrate-to-direct-http'),
    (candidate) => (candidate.directCandidate.shippingRuntime = true),
    (candidate) => (candidate.startupMeasurement.containedSdkMs.median += 1),
    (candidate) => candidate.maintenanceSurface.directCandidateOwnedResponsibilities.pop(),
    (candidate) => candidate.decisionReasons.pop(),
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(current);
    mutate(candidate);
    assert.ok(stripeSdkEvaluationViolations(candidate, current).length > 0);
  }
});
