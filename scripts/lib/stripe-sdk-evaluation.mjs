import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { relative, resolve, sep } from 'node:path';

export const STRIPE_EVALUATION_PATH = 'distribution/stripe-sdk-decision.json';
export const STRIPE_EVALUATION_SCHEMA_PATH = 'distribution/stripe-sdk-decision.schema.json';
export const STARTUP_WARMUPS = 5;
export const STARTUP_SAMPLES = 30;

export const BENEFIT_THRESHOLDS = Object.freeze({
  minimumDependencyBytesRemoved: 1_048_576,
  minimumDependencyPercentRemoved: 25,
  minimumStartupMedianMsReduction: 10,
  minimumStartupPercentReduction: 20,
  minimumNewDiagnosticFields: 4,
});

export const STRIPE_OPERATIONS = Object.freeze([
  Object.freeze({
    id: 'account-link.create',
    method: 'POST',
    path: '/v1/account_links',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'connect-account.create',
    method: 'POST',
    path: '/v1/accounts',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'connect-account.delete',
    method: 'DELETE',
    path: '/v1/accounts/{accountId}',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'connect-account.retrieve',
    method: 'GET',
    path: '/v1/accounts/{accountId}',
    sideEffecting: false,
    idempotencyRequired: false,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'payment-intent.cancel',
    method: 'POST',
    path: '/v1/payment_intents/{paymentIntentId}/cancel',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'payment-intent.create',
    method: 'POST',
    path: '/v1/payment_intents',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'payment-intent.retrieve',
    method: 'GET',
    path: '/v1/payment_intents/{paymentIntentId}',
    sideEffecting: false,
    idempotencyRequired: false,
    localRequestShapeProof: true,
  }),
  Object.freeze({
    id: 'refund.create',
    method: 'POST',
    path: '/v1/refunds',
    sideEffecting: true,
    idempotencyRequired: true,
    localRequestShapeProof: true,
  }),
]);

const PASSED_LOCAL_GATES = Object.freeze([
  ['api-version-header-local', 'scripts/__tests__/stripe-sdk-evaluation.test.mjs'],
  ['connect-transfer-local', 'scripts/__tests__/stripe-sdk-evaluation.test.mjs'],
  ['form-encoding-local', 'scripts/__tests__/stripe-sdk-evaluation.test.mjs'],
  ['idempotency-header-local', 'scripts/__tests__/stripe-sdk-evaluation.test.mjs'],
]);

const UNPROVEN_EXTERNAL_GATES = Object.freeze([
  'api-version-upgrade-provider',
  'connect-provider',
  'hosted-elements-provider',
  'malformed-wire-diagnostics-provider',
  'orphan-compensation-provider',
  'payment-intent-provider',
  'refund-provider',
  'retry-replay-provider',
  'webhook-provider',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function encodeSegment(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return encodeURIComponent(value);
}

function appendRecord(form, prefix, values = {}) {
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    if (value !== undefined) form.append(`${prefix}[${key}]`, String(value));
  }
}

function requiredPrototypeString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requiredPrototypeAmount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function serializeStripeForm(form) {
  return [...form]
    .map(([key, value]) => {
      const encodedKey = encodeURIComponent(key).replaceAll('%5B', '[').replaceAll('%5D', ']');
      return `${encodedKey}=${encodeURIComponent(value)}`;
    })
    .join('&');
}

function requireIdempotencyKey(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > 255 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new Error('idempotencyKey is invalid');
  }
}

/**
 * Non-shipping request-construction prototype. It deliberately performs no I/O and owns no
 * response parsing; its only purpose is to make the direct-HTTP protocol surface measurable.
 */
export function buildStripeWirePrototype(operation, input = {}) {
  const descriptor = STRIPE_OPERATIONS.find(({ id }) => id === operation);
  if (!descriptor) throw new Error(`unsupported Stripe prototype operation: ${operation}`);
  if (descriptor.idempotencyRequired) requireIdempotencyKey(input.idempotencyKey);

  let path = descriptor.path;
  if (path.includes('{paymentIntentId}')) {
    path = path.replace(
      '{paymentIntentId}',
      encodeSegment(input.paymentIntentId, 'paymentIntentId'),
    );
  }
  if (path.includes('{accountId}')) {
    path = path.replace('{accountId}', encodeSegment(input.accountId, 'accountId'));
  }

  const form = new URLSearchParams();
  if (operation === 'payment-intent.create') {
    form.append('amount', String(requiredPrototypeAmount(input.amount, 'amount')));
    form.append('currency', requiredPrototypeString(input.currency, 'currency').toLowerCase());
    if (input.description !== undefined) form.append('description', String(input.description));
    form.append('automatic_payment_methods[enabled]', 'true');
    appendRecord(form, 'metadata', input.metadata);
    if (input.connectedAccountId) {
      form.append(
        'transfer_data[destination]',
        requiredPrototypeString(input.connectedAccountId, 'connectedAccountId'),
      );
      if (input.applicationFeeAmount > 0) {
        form.append('application_fee_amount', String(input.applicationFeeAmount));
      }
    }
  } else if (operation === 'refund.create') {
    form.append(
      'payment_intent',
      requiredPrototypeString(input.paymentIntentId, 'paymentIntentId'),
    );
    form.append('amount', String(requiredPrototypeAmount(input.amount, 'amount')));
    if (input.reason !== undefined) form.append('reason', String(input.reason));
    if (input.reverseTransfer !== undefined) {
      form.append('reverse_transfer', String(input.reverseTransfer));
    }
    if (input.refundApplicationFee !== undefined) {
      form.append('refund_application_fee', String(input.refundApplicationFee));
    }
  } else if (operation === 'connect-account.create') {
    form.append('type', 'express');
    form.append('country', requiredPrototypeString(input.country, 'country'));
    form.append(
      'business_profile[name]',
      requiredPrototypeString(input.businessName, 'businessName'),
    );
    appendRecord(form, 'metadata', input.metadata);
  } else if (operation === 'account-link.create') {
    form.append('account', requiredPrototypeString(input.accountId, 'accountId'));
    form.append('type', 'account_onboarding');
    form.append('refresh_url', requiredPrototypeString(input.refreshUrl, 'refreshUrl'));
    form.append('return_url', requiredPrototypeString(input.returnUrl, 'returnUrl'));
  }

  const body = form.size === 0 ? '' : serializeStripeForm(form);
  return Object.freeze({
    method: descriptor.method,
    path,
    headers: Object.freeze({
      Authorization: 'Bearer <redacted>',
      ...(descriptor.method === 'POST' ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2026-06-24.dahlia',
      ...(descriptor.idempotencyRequired ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    }),
    body,
  });
}

export function logicalPackageMetrics(packagePath) {
  const root = realpathSync(packagePath);
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      const logicalPath = relative(root, path).split(sep).join('/');
      if (metadata.isSymbolicLink()) {
        throw new Error(`Stripe installed package contains a symbolic link: ${logicalPath}`);
      }
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push({ logicalPath, path, size: metadata.size });
      else throw new Error(`Stripe installed package contains a non-file entry: ${logicalPath}`);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const content = readFileSync(file.path);
    if (content.byteLength !== file.size)
      throw new Error(`Stripe file changed: ${file.logicalPath}`);
    bytes += content.byteLength;
    hash.update(file.logicalPath);
    hash.update('\0');
    hash.update(String(content.byteLength));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  if (files.length === 0) throw new Error('Stripe installed package is empty');
  return {
    logicalInstalledBytes: bytes,
    logicalInstalledFiles: files.length,
    logicalContentSha256: hash.digest('hex'),
  };
}

export function stripeLockResolution(lockfile) {
  const matches = [
    ...lockfile.matchAll(
      /^\s{4}"stripe": \["stripe@([^"]+)",.*"(sha512-[A-Za-z0-9+/]+={0,2})"\],?$/gmu,
    ),
  ];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Stripe lock resolution, found ${matches.length}`);
  }
  return { resolvedVersion: matches[0][1], lockIntegrity: matches[0][2] };
}

function timingSummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const value = (number) => Math.round(number * 1_000) / 1_000;
  return {
    samples: samples.map(value),
    median: value(sorted[Math.floor(sorted.length / 2)]),
    p95: value(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    minimum: value(sorted[0]),
    maximum: value(sorted.at(-1)),
  };
}

function timingSummaryMatches(value) {
  return (
    Array.isArray(value?.samples) &&
    value.samples.length === STARTUP_SAMPLES &&
    value.samples.every((sample) => Number.isFinite(sample) && sample > 0) &&
    equal(value, timingSummary(value.samples))
  );
}

function assertGatewaySourceSurface(source) {
  for (const operation of STRIPE_OPERATIONS) {
    if (!source.includes(`'${operation.id}'`)) {
      throw new Error(`Stripe gateway source is missing operation ${operation.id}`);
    }
  }
  if (!source.includes("export const STRIPE_API_VERSION = '2026-06-24.dahlia'")) {
    throw new Error('Stripe gateway API version does not match the bounded prototype');
  }
}

function runIsolated(runtime, code, cwd) {
  const startedAt = performance.now();
  const child = spawnSync(runtime, ['--input-type=module', '--eval', code], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const duration = performance.now() - startedAt;
  if (child.status !== 0 || child.signal) {
    throw new Error(`startup probe failed: ${child.stderr || child.signal || child.status}`);
  }
  return duration;
}

export function measureStartup(root, { runtime = process.execPath } = {}) {
  const providerRoot = resolve(root, 'packages/provider-clients');
  const containedCode = "await import('stripe')";
  const candidateCode =
    "void fetch; new URLSearchParams([['amount','100'],['currency','usd']]).toString()";
  const containedSdkMs = [];
  const directCandidateMs = [];
  for (let index = 0; index < STARTUP_WARMUPS + STARTUP_SAMPLES; index += 1) {
    const firstContained = index % 2 === 0;
    const first = firstContained
      ? runIsolated(runtime, containedCode, providerRoot)
      : runIsolated(runtime, candidateCode, providerRoot);
    const second = firstContained
      ? runIsolated(runtime, candidateCode, providerRoot)
      : runIsolated(runtime, containedCode, providerRoot);
    if (index >= STARTUP_WARMUPS) {
      containedSdkMs.push(firstContained ? first : second);
      directCandidateMs.push(firstContained ? second : first);
    }
  }
  return {
    runtime: `${process.release.name}@${process.versions.node} ${process.platform}-${process.arch}`,
    warmups: STARTUP_WARMUPS,
    samplesPerCase: STARTUP_SAMPLES,
    containedSdkMs: timingSummary(containedSdkMs),
    directCandidateMs: timingSummary(directCandidateMs),
  };
}

function parityGates() {
  return [
    ...PASSED_LOCAL_GATES.map(([id, evidence]) => ({
      id,
      required: true,
      status: 'passed',
      evidence,
    })),
    ...UNPROVEN_EXTERNAL_GATES.map((id) => ({
      id,
      required: true,
      status: 'not-run',
      evidence: null,
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export function expectedDecision(evaluation) {
  const allParityPassed = evaluation.parityGates.every(
    ({ required, status, evidence }) => !required || (status === 'passed' && evidence),
  );
  const directDiagnosticsProven = evaluation.directCandidate.diagnostics.providerBackedProof;
  const canMigrate =
    evaluation.directCandidate.shippingRuntime &&
    allParityPassed &&
    directDiagnosticsProven &&
    evaluation.benefitMeasurements.materialBenefitPass;
  return canMigrate ? 'migrate-to-direct-http' : 'retain-contained-sdk';
}

function benefitMeasurements(containedSdk, directCandidate, startupMeasurement) {
  // Stripe remains a production dependency for webhook verification and the package root eagerly
  // exports that boundary. A server-call-only prototype therefore removes no runtime bytes or
  // startup work, regardless of its isolated best-case microbenchmark.
  const dependencyBytesRemoved = directCandidate.stripeRuntimeDependencyStillRequired
    ? 0
    : containedSdk.logicalInstalledBytes;
  const dependencyPercentRemoved =
    Math.round((dependencyBytesRemoved / containedSdk.logicalInstalledBytes) * 10_000) / 100;
  const startupMedianMsReduction = directCandidate.stripeRuntimeDependencyStillRequired
    ? 0
    : Math.max(
        0,
        Math.round(
          (startupMeasurement.containedSdkMs.median - startupMeasurement.directCandidateMs.median) *
            1_000,
        ) / 1_000,
      );
  const startupPercentReduction =
    startupMeasurement.containedSdkMs.median === 0
      ? 0
      : Math.round((startupMedianMsReduction / startupMeasurement.containedSdkMs.median) * 10_000) /
        100;
  const diagnosticKeys = Object.keys(containedSdk.diagnostics).filter(
    (key) => key !== 'providerBackedProof',
  );
  const newDiagnosticFields = diagnosticKeys.filter(
    (key) => directCandidate.diagnostics[key] && !containedSdk.diagnostics[key],
  ).length;
  const dependencyBenefitPass =
    dependencyBytesRemoved >= BENEFIT_THRESHOLDS.minimumDependencyBytesRemoved &&
    dependencyPercentRemoved >= BENEFIT_THRESHOLDS.minimumDependencyPercentRemoved;
  const startupBenefitPass =
    startupMedianMsReduction >= BENEFIT_THRESHOLDS.minimumStartupMedianMsReduction &&
    startupPercentReduction >= BENEFIT_THRESHOLDS.minimumStartupPercentReduction;
  const diagnosticBenefitPass =
    directCandidate.diagnostics.providerBackedProof &&
    newDiagnosticFields >= BENEFIT_THRESHOLDS.minimumNewDiagnosticFields;
  return {
    dependencyBytesRemoved,
    dependencyPercentRemoved,
    startupMedianMsReduction,
    startupPercentReduction,
    newDiagnosticFields,
    dependencyBenefitPass,
    startupBenefitPass,
    diagnosticBenefitPass,
    materialBenefitPass: dependencyBenefitPass || startupBenefitPass || diagnosticBenefitPass,
  };
}

export function buildStripeSdkEvaluation(root, { startupMeasurement = measureStartup(root) } = {}) {
  const registryBytes = readFileSync(
    resolve(root, 'distribution/provider-integration-registry.json'),
  );
  const lockfileBytes = readFileSync(resolve(root, 'bun.lock'));
  const stripeSourceBytes = readFileSync(resolve(root, 'packages/provider-clients/src/stripe.ts'));
  const providerManifestBytes = readFileSync(
    resolve(root, 'packages/provider-clients/package.json'),
  );
  const evaluationImplementationBytes = readFileSync(
    resolve(root, 'scripts/lib/stripe-sdk-evaluation.mjs'),
  );
  const localEvidenceBytes = readFileSync(
    resolve(root, 'scripts/__tests__/stripe-sdk-evaluation.test.mjs'),
  );
  const providerManifest = JSON.parse(providerManifestBytes);
  const stripeSource = stripeSourceBytes.toString('utf8');
  assertGatewaySourceSurface(stripeSource);
  const resolution = stripeLockResolution(lockfileBytes.toString('utf8'));
  const installedManifest = JSON.parse(
    readFileSync(
      resolve(root, 'packages/provider-clients/node_modules/stripe/package.json'),
      'utf8',
    ),
  );
  if (installedManifest.version !== resolution.resolvedVersion) {
    throw new Error('installed Stripe version does not match bun.lock');
  }
  const metrics = logicalPackageMetrics(
    resolve(root, 'packages/provider-clients/node_modules/stripe'),
  );
  const bindings = {
    providerRegistrySha256: sha256(registryBytes),
    lockfileSha256: sha256(lockfileBytes),
    stripeGatewaySourceSha256: sha256(stripeSourceBytes),
    providerManifestSha256: sha256(providerManifestBytes),
    evaluationImplementationSha256: sha256(evaluationImplementationBytes),
    localEvidenceSha256: sha256(localEvidenceBytes),
  };
  bindings.decisionInputsSha256 = sha256(canonicalJson(bindings));

  const containedSdk = {
    package: 'stripe',
    declaredRange: providerManifest.dependencies?.stripe,
    ...resolution,
    dependencyClass: 'dependencies',
    runtimeImportPath: 'packages/provider-clients/src/stripe.ts',
    testOnlyPlacements: [
      {
        manifest: 'packages/api/package.json',
        dependencyClass: 'devDependencies',
        importPath:
          'packages/api/src/__tests__/integration/stripe-connect-provider.integration.test.ts',
      },
      {
        manifest: 'packages/workflows/package.json',
        dependencyClass: 'devDependencies',
        importPath: 'packages/workflows/src/__tests__/stripe-provider.integration.test.ts',
      },
    ],
    ...metrics,
    operations: STRIPE_OPERATIONS.map((operation) => ({ ...operation })),
    diagnostics: {
      status: true,
      statusText: false,
      contentType: false,
      responseSize: false,
      responseClassification: false,
      bodyDigest: false,
      retryAfter: true,
      hashedRequestId: true,
      exactRequestIdIncidentSink:
        stripeSource.includes('onExactRequestId') &&
        stripeSource.includes('validateExactProviderRequestId'),
      providerBackedProof: false,
    },
    retainedRuntimeResponsibilities: [
      'api-error-deserialization',
      'api-version-compatibility',
      'authentication-header-construction',
      'form-encoding',
      'http-transport',
      'webhook-signature-verification',
    ],
  };
  const directCandidate = {
    state: 'bounded-wire-prototype-unproven',
    shippingRuntime: false,
    networkCallsPerformed: false,
    operations: STRIPE_OPERATIONS.map((operation) => ({ ...operation })),
    diagnostics: {
      status: false,
      statusText: false,
      contentType: false,
      responseSize: false,
      responseClassification: false,
      bodyDigest: false,
      retryAfter: false,
      hashedRequestId: false,
      exactRequestIdIncidentSink: false,
      providerBackedProof: false,
    },
    stripeRuntimeDependencyStillRequired: true,
    stripeRuntimeDependencyReason: 'webhook-signature-verification-runtime-boundary',
  };
  const evaluation = {
    schemaVersion: 1,
    decision: 'retain-contained-sdk',
    bindings,
    containedSdk,
    directCandidate,
    parityGates: parityGates(),
    benefitThresholds: { ...BENEFIT_THRESHOLDS },
    benefitMeasurements: benefitMeasurements(containedSdk, directCandidate, startupMeasurement),
    startupMeasurement,
    maintenanceSurface: {
      containedSdkOwnedResponsibilities: [
        'gateway-input-validation',
        'normalized-domain-response-mapping',
        'redacted-error-normalization',
        'workflow-retry-and-compensation-policy',
      ],
      directCandidateOwnedResponsibilities: [
        'api-error-deserialization',
        'api-version-upgrade-compatibility',
        'authentication-header-construction',
        'connected-account-semantics',
        'form-encoding',
        'gateway-input-validation',
        'http-transport-and-deadlines',
        'normalized-domain-response-mapping',
        'redacted-error-normalization',
        'response-bounding-and-classification',
        'retry-after-and-idempotency-semantics',
        'workflow-retry-and-compensation-policy',
      ],
    },
    decisionReasons: [
      'direct candidate is non-shipping and has no provider-backed parity evidence',
      'Stripe remains a production dependency for webhook signature verification',
      'direct candidate has no provider-backed diagnostic proof',
      'no material dependency, startup, or diagnostic benefit is proven',
    ],
  };
  evaluation.decision = expectedDecision(evaluation);
  return evaluation;
}

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function stripeSdkEvaluationViolations(evaluation, current) {
  const violations = [];
  if (!equal(evaluation.bindings, current.bindings)) {
    violations.push(
      'evaluation input bindings do not match the current registry, lock, source, and manifest',
    );
  }
  for (const key of [
    'package',
    'declaredRange',
    'resolvedVersion',
    'lockIntegrity',
    'dependencyClass',
    'runtimeImportPath',
    'testOnlyPlacements',
    'logicalInstalledBytes',
    'logicalInstalledFiles',
    'logicalContentSha256',
    'operations',
    'diagnostics',
    'retainedRuntimeResponsibilities',
  ]) {
    if (!equal(evaluation.containedSdk?.[key], current.containedSdk[key])) {
      violations.push(`contained SDK measurement is stale or altered: ${key}`);
    }
  }
  if (!equal(evaluation.directCandidate, current.directCandidate)) {
    violations.push('direct candidate state or local proof does not match the bounded prototype');
  }
  if (!equal(evaluation.parityGates, current.parityGates)) {
    violations.push('parity gates do not match current local and external evidence');
  }
  if (!equal(evaluation.maintenanceSurface, current.maintenanceSurface)) {
    violations.push('maintenance surface does not match the measured candidate and contained SDK');
  }
  if (!equal(evaluation.decisionReasons, current.decisionReasons)) {
    violations.push('decision reasons do not match the fail-closed evaluation');
  }
  if (!equal(evaluation.benefitThresholds, BENEFIT_THRESHOLDS)) {
    violations.push('material-benefit thresholds were changed');
  }
  if (!timingSummaryMatches(evaluation.startupMeasurement?.containedSdkMs)) {
    violations.push('contained SDK startup summary does not match its raw samples');
  }
  if (!timingSummaryMatches(evaluation.startupMeasurement?.directCandidateMs)) {
    violations.push('direct candidate startup summary does not match its raw samples');
  }
  for (const gate of evaluation.parityGates ?? []) {
    if (gate.status === 'passed' && !gate.evidence) {
      violations.push(`passed parity gate has no evidence: ${gate.id}`);
    }
    if (gate.status !== 'passed' && gate.evidence !== null) {
      violations.push(`unpassed parity gate must not claim evidence: ${gate.id}`);
    }
  }
  const expectedBenefits = benefitMeasurements(
    current.containedSdk,
    current.directCandidate,
    evaluation.startupMeasurement,
  );
  if (!equal(evaluation.benefitMeasurements, expectedBenefits)) {
    violations.push('material-benefit measurements or verdict do not follow the fixed thresholds');
  }
  const decision = expectedDecision(evaluation);
  if (evaluation.decision !== decision) {
    violations.push(`decision must be ${decision} for the recorded evidence`);
  }
  if (
    evaluation.decision === 'migrate-to-direct-http' &&
    evaluation.maintenanceSurface.directCandidateOwnedResponsibilities.length <=
      evaluation.maintenanceSurface.containedSdkOwnedResponsibilities.length
  ) {
    violations.push('migration evidence understates the direct candidate maintenance surface');
  }
  return [...new Set(violations)].sort();
}

export function currentEvaluationWithoutTiming(root, startupMeasurement) {
  return buildStripeSdkEvaluation(root, { startupMeasurement });
}

export function assertStripePackagePlacement(root) {
  const provider = JSON.parse(
    readFileSync(resolve(root, 'packages/provider-clients/package.json'), 'utf8'),
  );
  const api = JSON.parse(readFileSync(resolve(root, 'packages/api/package.json'), 'utf8'));
  const workflows = JSON.parse(
    readFileSync(resolve(root, 'packages/workflows/package.json'), 'utf8'),
  );
  if (!provider.dependencies?.stripe) throw new Error('provider-clients must own runtime Stripe');
  for (const [name, manifest] of [
    ['api', api],
    ['workflows', workflows],
  ]) {
    if (manifest.dependencies?.stripe) throw new Error(`${name} must not ship test-only Stripe`);
    if (!manifest.devDependencies?.stripe)
      throw new Error(`${name} must declare Stripe for provider tests`);
  }
  const installed = statSync(
    resolve(root, 'packages/provider-clients/node_modules/stripe/package.json'),
  );
  if (!installed.isFile()) throw new Error('provider-clients Stripe installation is unavailable');
}
