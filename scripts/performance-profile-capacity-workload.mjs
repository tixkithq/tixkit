#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, sha256 } from './performance-evidence.mjs';
import { createTargetBinding, validateTargetBinding } from './performance-profile-capacity.mjs';

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function exactOrigin(value, label) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`${label} must be a bounded absolute HTTP origin`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP origin`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value.replace(/\/$/u, '')
  ) {
    throw new Error(`${label} must be an absolute HTTP origin without credentials or a path`);
  }
  return url.origin;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

async function requestJson(fetchImpl, url, init, label, timeoutMs, monotonicNow) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`${label} deadline exceeded`)),
    timeoutMs,
  );
  const started = monotonicNow();
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(controller.signal.reason ?? new Error(`${label} aborted`));
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  let reader;
  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      aborted,
    ]);
    if (!response?.body) throw new Error(`${label} response body is absent`);
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort(new Error(`${label} response exceeds bounded size`));
        void reader.cancel().catch(() => undefined);
        throw new Error(`${label} response exceeds bounded size`);
      }
      chunks.push(chunk);
    }
    if (size < 1) throw new Error(`${label} response body is empty`);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new Error(`${label} response must be JSON`);
    }
    return {
      status: response.status,
      headers: response.headers,
      body,
      elapsedMs: Math.max(0, monotonicNow() - started),
    };
  } catch (error) {
    throw new Error(`${label} request failed: ${error instanceof Error ? error.name : 'unknown'}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    if (controller.signal.aborted && reader) void reader.cancel().catch(() => undefined);
  }
}

async function runCheckoutReservationRound({
  apiOrigin,
  fixtureOrigin,
  deploymentProfile,
  apiImageDigest,
  fixtureServiceArtifactSha256,
  fixtureServiceDeploymentSha256,
  fixtureIdentityPublicKeyPem,
  targetBinding,
  authorization,
  inventory,
  concurrency,
  fetchImpl = fetch,
  monotonicNow = () => performance.now(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  challengeSource = () => randomBytes(32).toString('hex'),
}) {
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 120_000
  ) {
    throw new Error('capacity request timeout must be a bounded positive integer');
  }
  const checkedApiOrigin = exactOrigin(apiOrigin, 'capacity API origin');
  const checkedFixtureOrigin = exactOrigin(fixtureOrigin, 'capacity fixture origin');
  const expectedTargetBinding = validateTargetBinding(targetBinding);
  const observedTargetBinding = createTargetBinding({
    profile: deploymentProfile,
    apiOrigin: checkedApiOrigin,
    fixtureOrigin: checkedFixtureOrigin,
    apiImageDigest,
    fixtureServiceArtifactSha256,
    fixtureDeploymentSha256: fixtureServiceDeploymentSha256,
    fixtureIdentityPublicKeyPem,
  });
  if (canonicalJson(observedTargetBinding) !== canonicalJson(expectedTargetBinding)) {
    throw new Error('capacity target does not match the topology-bound identity');
  }
  if (
    typeof authorization !== 'string' ||
    authorization.length < 1 ||
    authorization.length > 8192
  ) {
    throw new Error('capacity workload requires bounded fixture authorization');
  }
  if (
    !Number.isSafeInteger(inventory) ||
    inventory < 1 ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  ) {
    throw new Error('capacity workload inventory and concurrency must be positive integers');
  }
  const challenge = challengeSource();
  if (!/^[a-f0-9]{64}$/u.test(challenge ?? '')) {
    throw new Error('capacity fixture challenge must be 32 random bytes');
  }
  const fixtureResponse = await requestJson(
    fetchImpl,
    new URL('/capacity/v1/checkout-fixtures', checkedFixtureOrigin),
    {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ inventory, concurrency, challenge }),
    },
    'capacity fixture',
    requestTimeoutMs,
    monotonicNow,
  );
  if (fixtureResponse.status !== 201) throw new Error('capacity fixture creation failed');
  const fixture = fixtureResponse.body;
  if (
    typeof fixture?.fixtureId !== 'string' ||
    typeof fixture?.eventId !== 'string' ||
    typeof fixture?.ticketTypeId !== 'string' ||
    typeof fixture?.stateToken !== 'string' ||
    !fixture?.identity ||
    fixture.fixtureId.length > 256 ||
    fixture.eventId.length > 256 ||
    fixture.ticketTypeId.length > 256 ||
    fixture.stateToken.length > 8192
  ) {
    throw new Error('capacity fixture identity is malformed');
  }
  const fixtureIdentity = {
    challenge,
    fixtureId: fixture.fixtureId,
    eventId: fixture.eventId,
    ticketTypeId: fixture.ticketTypeId,
    serviceArtifactSha256: fixtureServiceArtifactSha256,
    deploymentSha256: fixtureServiceDeploymentSha256,
  };
  const identityFields = Object.keys(fixture.identity).sort();
  if (
    canonicalJson(identityFields) !==
      canonicalJson(['challenge', 'deploymentSha256', 'serviceArtifactSha256', 'signature']) ||
    fixture.identity.challenge !== challenge ||
    fixture.identity.serviceArtifactSha256 !== fixtureServiceArtifactSha256 ||
    fixture.identity.deploymentSha256 !== fixtureServiceDeploymentSha256 ||
    typeof fixture.identity.signature !== 'string' ||
    fixture.identity.signature.length > 1024
  ) {
    throw new Error('capacity fixture signed identity is malformed');
  }
  let identityKey;
  try {
    identityKey = createPublicKey(fixtureIdentityPublicKeyPem);
  } catch {
    throw new Error('capacity fixture identity key is invalid');
  }
  let signature;
  try {
    signature = Buffer.from(fixture.identity.signature, 'base64');
  } catch {
    throw new Error('capacity fixture identity signature is malformed');
  }
  if (
    identityKey.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    !verify(null, Buffer.from(canonicalJson(fixtureIdentity)), identityKey, signature)
  ) {
    throw new Error('capacity fixture signed identity is not trusted');
  }

  const reservationBatchStarted = monotonicNow();
  const attempts = await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const reservationStarted = monotonicNow();
      try {
        const response = await requestJson(
          fetchImpl,
          new URL('/v1/checkout/sessions', checkedApiOrigin),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `capacity-${fixture.fixtureId}-${index}`,
            },
            body: JSON.stringify({
              eventId: fixture.eventId,
              items: [{ ticketTypeId: fixture.ticketTypeId, quantity: 1 }],
              buyer: { email: `capacity-${index}@example.invalid` },
            }),
          },
          'checkout reservation',
          requestTimeoutMs,
          monotonicNow,
        );
        const elapsedMs = response.elapsedMs;
        const body = response.body;
        if ((response.status === 200 || response.status === 201) && typeof body?.id === 'string') {
          return { outcome: 'success', elapsedMs };
        }
        if (
          response.status === 409 &&
          body?.error?.code === 'INVENTORY_EXHAUSTED' &&
          body?.error?.details?.available === 0
        ) {
          return { outcome: 'expected-decline', elapsedMs };
        }
        return { outcome: 'platform-failure', elapsedMs };
      } catch {
        return {
          outcome: 'platform-failure',
          elapsedMs: Math.max(0, monotonicNow() - reservationStarted),
        };
      }
    }),
  );
  const reservationActiveLoadMs = Math.max(1, Math.ceil(monotonicNow() - reservationBatchStarted));

  const stateResponse = await requestJson(
    fetchImpl,
    new URL(
      `/capacity/v1/checkout-fixtures/${encodeURIComponent(fixture.fixtureId)}`,
      checkedFixtureOrigin,
    ),
    { headers: { authorization: `Bearer ${fixture.stateToken}` } },
    'capacity fixture reconciliation',
    requestTimeoutMs,
    monotonicNow,
  );
  if (stateResponse.status !== 200) throw new Error('capacity fixture reconciliation failed');
  const state = stateResponse.body;
  const successes = attempts.filter(({ outcome }) => outcome === 'success').length;
  const expectedInventoryDeclines = attempts.filter(
    ({ outcome }) => outcome === 'expected-decline',
  ).length;
  const platformFailures = attempts.filter(({ outcome }) => outcome === 'platform-failure').length;
  if (
    state?.inventory !== inventory ||
    state?.held !== successes ||
    !Number.isSafeInteger(state.held) ||
    state.held > inventory
  ) {
    throw new Error('capacity fixture final inventory reconciliation failed');
  }
  const successfulDurations = attempts
    .filter(({ outcome }) => outcome === 'success')
    .map(({ elapsedMs }) => elapsedMs);
  return {
    fixtureSha256: sha256(
      canonicalJson({
        fixtureId: fixture.fixtureId,
        eventId: fixture.eventId,
        ticketTypeId: fixture.ticketTypeId,
      }),
    ),
    successfulLatencies: successfulDurations,
    metrics: {
      attempts: concurrency,
      rounds: 1,
      reservationActiveLoadMs,
      successes,
      expectedInventoryDeclines,
      platformFailures,
      successfulReservationP95Ms: Number(percentile(successfulDurations, 0.95).toFixed(2)),
      finalHeld: state.held,
    },
  };
}

export async function runCheckoutReservationWorkload(input) {
  const minimumReservationActiveLoadMs = input.minimumReservationActiveLoadMs ?? 0;
  if (
    !Number.isSafeInteger(minimumReservationActiveLoadMs) ||
    minimumReservationActiveLoadMs < 0 ||
    minimumReservationActiveLoadMs > 60 * 60 * 1000
  ) {
    throw new Error('minimum reservation active load duration must be a bounded integer');
  }
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const rounds = [];
  let reservationActiveLoadMs = 0;
  do {
    if (rounds.length >= 10_000) {
      throw new Error('minimum active load duration exceeded the bounded round count');
    }
    const round = await runCheckoutReservationRound({ ...input, monotonicNow });
    rounds.push(round);
    reservationActiveLoadMs += round.metrics.reservationActiveLoadMs;
  } while (reservationActiveLoadMs < minimumReservationActiveLoadMs);
  const fixtureIdentities = rounds.map(({ fixtureSha256 }) => fixtureSha256);
  if (new Set(fixtureIdentities).size !== fixtureIdentities.length) {
    throw new Error('capacity workload reused a fixture identity');
  }
  const successfulLatencies = rounds.flatMap(({ successfulLatencies }) => successfulLatencies);
  return {
    fixtureSha256: sha256(canonicalJson(fixtureIdentities)),
    metrics: {
      attempts: rounds.reduce((total, { metrics }) => total + metrics.attempts, 0),
      rounds: rounds.length,
      reservationActiveLoadMs,
      successes: rounds.reduce((total, { metrics }) => total + metrics.successes, 0),
      expectedInventoryDeclines: rounds.reduce(
        (total, { metrics }) => total + metrics.expectedInventoryDeclines,
        0,
      ),
      platformFailures: rounds.reduce((total, { metrics }) => total + metrics.platformFailures, 0),
      successfulReservationP95Ms: Number(percentile(successfulLatencies, 0.95).toFixed(2)),
      finalHeld: rounds.reduce((total, { metrics }) => total + metrics.finalHeld, 0),
    },
  };
}

export async function main(environment = process.env) {
  const input = JSON.parse(readFileSync(environment.TIXKIT_CAPACITY_WORKLOAD_INPUT, 'utf8'));
  const result = await runCheckoutReservationWorkload({
    apiOrigin: environment.TIXKIT_CAPACITY_API_ORIGIN,
    fixtureOrigin: environment.TIXKIT_CAPACITY_FIXTURE_ORIGIN,
    deploymentProfile: input.deploymentProfile,
    apiImageDigest: input.apiImageDigest,
    fixtureServiceArtifactSha256: input.fixtureServiceArtifactSha256,
    fixtureServiceDeploymentSha256: input.fixtureServiceDeploymentSha256,
    fixtureIdentityPublicKeyPem: input.fixtureIdentityPublicKeyPem,
    targetBinding: input.targetBinding,
    authorization: environment.TIXKIT_CAPACITY_FIXTURE_AUTHORIZATION,
    inventory: input.inventory,
    concurrency: input.concurrency,
    minimumReservationActiveLoadMs: input.minimumReservationActiveLoadMs,
  });
  const output = path.resolve(environment.TIXKIT_CAPACITY_WORKLOAD_OUTPUT);
  writeFileSync(output, `${canonicalJson(result)}\n`, { flag: 'wx', mode: 0o600 });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
