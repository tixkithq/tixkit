import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { canonicalJson } from '../performance-evidence.mjs';
import {
  createCapacityProofProjection,
  createReviewedTopologyFingerprint,
  createTopologyFingerprint,
  createTargetBinding,
  executeSupportedProfileCapacitySample,
  validateSupportedProfileCapacityConfig,
} from '../performance-profile-capacity.mjs';
import { runCheckoutReservationWorkload } from '../performance-profile-capacity-workload.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(
  readFileSync(path.join(root, 'performance-capacity.supported-profiles.json'), 'utf8'),
);
const workflow = readFileSync(
  path.join(root, '.github/workflows/performance-profile-capacity.yml'),
  'utf8',
);
const compose = readFileSync(path.join(root, 'infra/compact/compose.yml'), 'utf8');
const composeConfig = parseYaml(compose);
const digest = (character) => `sha256:${character.repeat(64)}`;
const fixtureServiceArtifactSha256 = 'f'.repeat(64);
const fixtureServiceDeploymentSha256 = 'd'.repeat(64);
const apiImageDigest = digest('a');
const fixtureChallenge = 'c'.repeat(64);
const { privateKey: fixtureIdentityPrivateKey, publicKey: fixtureIdentityPublicKey } =
  generateKeyPairSync('ed25519');
const fixtureIdentityPublicKeyPem = fixtureIdentityPublicKey
  .export({ type: 'spki', format: 'pem' })
  .toString();
const httpsTargetBinding = createTargetBinding({
  profile: 'production',
  apiOrigin: 'https://api.example.test',
  fixtureOrigin: 'https://fixture.example.test',
  apiImageDigest,
  fixtureServiceArtifactSha256,
  fixtureDeploymentSha256: fixtureServiceDeploymentSha256,
  fixtureIdentityPublicKeyPem,
});
const workloadIdentity = {
  deploymentProfile: 'production',
  apiImageDigest,
  fixtureServiceArtifactSha256,
  fixtureServiceDeploymentSha256,
  fixtureIdentityPublicKeyPem,
  targetBinding: httpsTargetBinding,
  challengeSource: () => fixtureChallenge,
};

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function signedFixture({ fixtureId, eventId, ticketTypeId, stateToken }, overrides = {}) {
  const signedIdentity = {
    challenge: fixtureChallenge,
    fixtureId,
    eventId,
    ticketTypeId,
    serviceArtifactSha256: fixtureServiceArtifactSha256,
    deploymentSha256: fixtureServiceDeploymentSha256,
  };
  return {
    fixtureId,
    eventId,
    ticketTypeId,
    stateToken,
    identity: {
      challenge: fixtureChallenge,
      serviceArtifactSha256: fixtureServiceArtifactSha256,
      deploymentSha256: fixtureServiceDeploymentSha256,
      signature: sign(
        null,
        Buffer.from(canonicalJson(signedIdentity)),
        fixtureIdentityPrivateKey,
      ).toString('base64'),
      ...overrides,
    },
  };
}

function streamedJsonResponse(status, value, onPull = () => undefined) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    status,
    headers: new Headers(),
    body: new ReadableStream({
      pull(controller) {
        onPull();
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

test('supported profile config and Compact runtime limits are truthful', () => {
  assert.equal(validateSupportedProfileCapacityConfig(config, { root }), config);
  for (const service of ['api', 'worker']) {
    assert.equal(composeConfig.services[service].cpus, 1);
    assert.equal(composeConfig.services[service].mem_limit, '1g');
  }
});

test('executor owns time and exact runtime identity while the workload emits metrics only', async () => {
  const profile = config.profiles[0];
  const topologyFingerprint = createTopologyFingerprint({
    profile: 'compact',
    instance: 'fixture',
  });
  const wall = new Date('2026-07-17T12:00:00.000Z');
  let monotonicCall = 0;
  const raw = await executeSupportedProfileCapacitySample({
    profile,
    releaseImages: { api: digest('a'), worker: digest('b') },
    topologyFingerprint,
    targetBinding: httpsTargetBinding,
    sequence: 1,
    concurrency: 16,
    clock: {
      wallNow: () => wall,
      monotonicNow: () => [100, 225][monotonicCall++],
    },
    executeWorkload: async () => ({
      startedAt: 'attacker-controlled',
      runtime: { profile: 'production' },
      fixtureSha256: 'c'.repeat(64),
      metrics: {
        attempts: 16,
        rounds: 1,
        reservationActiveLoadMs: 125,
        successes: 16,
        expectedInventoryDeclines: 0,
        platformFailures: 0,
        successfulReservationP95Ms: 25,
        finalHeld: 16,
      },
    }),
  });
  const value = JSON.parse(raw);
  assert.equal(value.startedAt, wall.toISOString());
  assert.equal(value.completedAt, '2026-07-17T12:00:00.125Z');
  assert.equal(value.elapsedMs, 125);
  assert.equal(value.runtime.profile, 'compact');
  assert.deepEqual(value.runtime.topologyFingerprint, topologyFingerprint);
  assert.equal('startedAt' in value.metrics, false);
});

test('HTTP workload accepts only exact inventory exhaustion and reconciles final holds', async () => {
  const responses = [
    jsonResponse(
      201,
      signedFixture({
        fixtureId: 'fixture-1',
        eventId: 'event-1',
        ticketTypeId: 'ticket-type-1',
        stateToken: 'state-token',
      }),
    ),
    jsonResponse(201, { id: 'session-1' }),
    jsonResponse(201, { id: 'session-2' }),
    jsonResponse(409, { error: { code: 'INVENTORY_EXHAUSTED', details: { available: 0 } } }),
    jsonResponse(200, { inventory: 2, held: 2 }),
  ];
  let tick = 0;
  const result = await runCheckoutReservationWorkload({
    apiOrigin: 'https://api.example.test',
    fixtureOrigin: 'https://fixture.example.test',
    ...workloadIdentity,
    authorization: 'Bearer fixture-secret',
    inventory: 2,
    concurrency: 3,
    fetchImpl: async () => responses.shift(),
    monotonicNow: () => (tick += 10),
  });
  assert.deepEqual(result.metrics, {
    attempts: 3,
    rounds: 1,
    reservationActiveLoadMs: 100,
    successes: 2,
    expectedInventoryDeclines: 1,
    platformFailures: 0,
    successfulReservationP95Ms: 50,
    finalHeld: 2,
  });
  assert.match(result.fixtureSha256, /^[a-f0-9]{64}$/u);
});

test('HTTP workload treats every noncanonical decline as a platform failure', async () => {
  const responses = [
    jsonResponse(
      201,
      signedFixture({
        fixtureId: 'fixture-2',
        eventId: 'event-2',
        ticketTypeId: 'ticket-type-2',
        stateToken: 'state-token',
      }),
    ),
    jsonResponse(400, { error: { code: 'INVENTORY_EXHAUSTED', details: { available: 0 } } }),
    jsonResponse(409, { error: { code: 'OTHER_CONFLICT' } }),
    jsonResponse(200, { inventory: 2, held: 0 }),
  ];
  const result = await runCheckoutReservationWorkload({
    apiOrigin: 'https://api.example.test',
    fixtureOrigin: 'https://fixture.example.test',
    ...workloadIdentity,
    authorization: 'Bearer fixture-secret',
    inventory: 2,
    concurrency: 2,
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result.metrics.platformFailures, 2);
  assert.equal(result.metrics.expectedInventoryDeclines, 0);
});

test('HTTP workload rejects credential-bearing and path-bearing origins before fetch', async () => {
  for (const apiOrigin of ['https://user:secret@api.example.test', 'https://api.example.test/v1']) {
    await assert.rejects(
      runCheckoutReservationWorkload({
        apiOrigin,
        fixtureOrigin: 'https://fixture.example.test',
        ...workloadIdentity,
        authorization: 'Bearer fixture-secret',
        inventory: 2,
        concurrency: 2,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
      }),
      /without credentials or a path/u,
    );
  }
});

test('workload rejects target substitution and non-loopback cleartext before fetch', async () => {
  let fetches = 0;
  const neverFetch = async () => {
    fetches += 1;
    throw new Error('must not fetch');
  };
  await assert.rejects(
    runCheckoutReservationWorkload({
      apiOrigin: 'https://substituted.example.test',
      fixtureOrigin: 'https://fixture.example.test',
      ...workloadIdentity,
      authorization: 'Bearer fixture-secret',
      inventory: 1,
      concurrency: 1,
      fetchImpl: neverFetch,
    }),
    /does not match the topology-bound identity/u,
  );
  for (const [deploymentProfile, apiOrigin, fixtureOrigin] of [
    ['production', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'],
    ['compact', 'http://api.example.test', 'http://fixture.example.test'],
  ]) {
    assert.throws(
      () =>
        createTargetBinding({
          profile: deploymentProfile,
          apiOrigin,
          fixtureOrigin,
          apiImageDigest,
          fixtureServiceArtifactSha256,
          fixtureDeploymentSha256: fixtureServiceDeploymentSha256,
          fixtureIdentityPublicKeyPem,
        }),
      /transport or origin is unsupported/u,
    );
  }
  assert.equal(
    createTargetBinding({
      profile: 'compact',
      apiOrigin: 'http://127.0.0.1:3000',
      fixtureOrigin: 'http://localhost:3001',
      apiImageDigest,
      fixtureServiceArtifactSha256,
      fixtureDeploymentSha256: fixtureServiceDeploymentSha256,
      fixtureIdentityPublicKeyPem,
    }).transport,
    'compact-loopback-http',
  );
  assert.equal(fetches, 0);
});

test('reservation latency includes complete bounded response body consumption', async () => {
  let clock = 0;
  const responses = [
    () =>
      streamedJsonResponse(
        201,
        signedFixture({
          fixtureId: 'fixture-latency',
          eventId: 'event-latency',
          ticketTypeId: 'ticket-latency',
          stateToken: 'state-token',
        }),
      ),
    () =>
      streamedJsonResponse(201, { id: 'session-latency' }, () => {
        clock = 75;
      }),
    () => streamedJsonResponse(200, { inventory: 1, held: 1 }),
  ];
  const result = await runCheckoutReservationWorkload({
    apiOrigin: 'https://api.example.test',
    fixtureOrigin: 'https://fixture.example.test',
    ...workloadIdentity,
    authorization: 'Bearer fixture-secret',
    inventory: 1,
    concurrency: 1,
    fetchImpl: async () => responses.shift()(),
    monotonicNow: () => clock,
  });
  assert.equal(result.metrics.successfulReservationP95Ms, 75);
});

test('workload rejects a fixture service artifact identity substitution', async () => {
  await assert.rejects(
    runCheckoutReservationWorkload({
      apiOrigin: 'https://api.example.test',
      fixtureOrigin: 'https://fixture.example.test',
      ...workloadIdentity,
      authorization: 'Bearer fixture-secret',
      inventory: 1,
      concurrency: 1,
      fetchImpl: async () =>
        jsonResponse(201, {
          fixtureId: 'fixture-substitution',
          eventId: 'event-substitution',
          ticketTypeId: 'ticket-substitution',
          stateToken: 'state-token',
          identity: signedFixture(
            {
              fixtureId: 'fixture-substitution',
              eventId: 'event-substitution',
              ticketTypeId: 'ticket-substitution',
              stateToken: 'state-token',
            },
            { serviceArtifactSha256: '0'.repeat(64) },
          ).identity,
        }),
    }),
    /fixture signed identity is malformed/u,
  );
});

test('a fixture service without the attested private key cannot forge identity', async () => {
  const { privateKey: attackerKey } = generateKeyPairSync('ed25519');
  const fixture = signedFixture({
    fixtureId: 'fixture-forged',
    eventId: 'event-forged',
    ticketTypeId: 'ticket-forged',
    stateToken: 'state-token',
  });
  const signedIdentity = {
    challenge: fixtureChallenge,
    fixtureId: fixture.fixtureId,
    eventId: fixture.eventId,
    ticketTypeId: fixture.ticketTypeId,
    serviceArtifactSha256: fixtureServiceArtifactSha256,
    deploymentSha256: fixtureServiceDeploymentSha256,
  };
  fixture.identity.signature = sign(
    null,
    Buffer.from(canonicalJson(signedIdentity)),
    attackerKey,
  ).toString('base64');
  await assert.rejects(
    runCheckoutReservationWorkload({
      apiOrigin: 'https://api.example.test',
      fixtureOrigin: 'https://fixture.example.test',
      ...workloadIdentity,
      authorization: 'Bearer fixture-secret',
      inventory: 1,
      concurrency: 1,
      fetchImpl: async () => jsonResponse(201, fixture),
    }),
    /signed identity is not trusted/u,
  );
});

test('reservation active load excludes fixture creation and reconciliation time', async () => {
  let clock = 0;
  const fixture = signedFixture({
    fixtureId: 'fixture-active-time',
    eventId: 'event-active-time',
    ticketTypeId: 'ticket-active-time',
    stateToken: 'state-token',
  });
  const result = await runCheckoutReservationWorkload({
    apiOrigin: 'https://api.example.test',
    fixtureOrigin: 'https://fixture.example.test',
    ...workloadIdentity,
    authorization: 'Bearer fixture-secret',
    inventory: 1,
    concurrency: 1,
    monotonicNow: () => clock,
    fetchImpl: async (url) => {
      if (url.pathname === '/capacity/v1/checkout-fixtures') {
        clock += 1000;
        return jsonResponse(201, fixture);
      }
      if (url.pathname === '/v1/checkout/sessions') {
        clock += 7;
        return jsonResponse(201, { id: 'session-active-time' });
      }
      clock += 2000;
      return jsonResponse(200, { inventory: 1, held: 1 });
    },
  });
  assert.equal(result.metrics.reservationActiveLoadMs, 7);
  assert.equal(clock, 3007);
});

test('proof projections reject arbitrary secret-bearing JSON and expose allowlisted fields only', () => {
  const fixtureArtifact = {
    schemaVersion: 'tixkit-capacity-fixture-service-artifact-v1',
    sourceCommit: 'a'.repeat(40),
    deploymentSha256: fixtureServiceDeploymentSha256,
    identityPublicKeyPem: fixtureIdentityPublicKeyPem,
  };
  const projected = createCapacityProofProjection(
    'fixture-service-artifact',
    fixtureArtifact,
    fixtureServiceArtifactSha256,
  );
  assert.deepEqual(Object.keys(projected).sort(), [
    'deploymentSha256',
    'identityPublicKeyPem',
    'schemaVersion',
    'sourceCommit',
    'sourceSha256',
  ]);
  assert.throws(
    () =>
      createCapacityProofProjection(
        'fixture-service-artifact',
        { ...fixtureArtifact, authorization: 'Bearer do-not-upload' },
        fixtureServiceArtifactSha256,
      ),
    /closed public-safe schema/u,
  );
  assert.throws(
    () =>
      createCapacityProofProjection(
        'external-ha-attestation',
        {
          schemaVersion: 'tixkit-external-ha-attestation-v1',
          databaseEngine: 'postgresql',
          topology: 'external-high-availability',
          observedAt: '2026-07-17T12:00:00Z',
          expiresAt: '2026-07-18T12:00:00Z',
          evidenceSha256: 'e'.repeat(64),
          password: 'do-not-upload',
        },
        'b'.repeat(64),
      ),
    /closed public-safe schema/u,
  );
  const productionProjection = createCapacityProofProjection(
    'production-profile',
    {
      schemaVersion: 'tixkit-production-profile-proof-v1',
      drillId: 'capacity-test',
      context: 'private-context',
      cluster: { server: 'https://private.example.test', password: 'do-not-upload' },
      namespace: 'private-namespace',
      namespaceUid: 'private-uid',
      release: 'private-release',
      helmRelease: { secretUid: 'private-secret-uid' },
      startedAt: '2026-07-17T12:00:00Z',
      completedAt: '2026-07-17T12:01:00Z',
      disruptionPerformed: false,
      before: [{ token: 'do-not-upload' }],
      after: [],
      disruptions: [],
    },
    'c'.repeat(64),
  );
  assert.doesNotMatch(canonicalJson(productionProjection), /private|password|token|secretUid/u);
});

test('external HA proof validity is current-time bound at both boundaries', () => {
  const proof = {
    schemaVersion: 'tixkit-external-ha-attestation-v1',
    databaseEngine: 'postgresql',
    topology: 'external-high-availability',
    observedAt: '2026-07-17T11:59:59.000Z',
    expiresAt: '2026-07-17T12:00:01.000Z',
    evidenceSha256: 'e'.repeat(64),
  };
  const atNoon = { now: () => new Date('2026-07-17T12:00:00.000Z') };
  assert.equal(
    createCapacityProofProjection('external-ha-attestation', proof, 'b'.repeat(64), atNoon)
      .expiresAt,
    '2026-07-17T12:00:01.000Z',
  );
  assert.throws(
    () =>
      createCapacityProofProjection(
        'external-ha-attestation',
        { ...proof, observedAt: '2026-07-17T12:00:00.001Z' },
        'b'.repeat(64),
        atNoon,
      ),
    /validity window/u,
  );
  assert.equal(
    createCapacityProofProjection(
      'external-ha-attestation',
      {
        ...proof,
        observedAt: '2026-07-16T12:00:00.000Z',
        expiresAt: '2026-07-17T12:00:01.000Z',
      },
      'b'.repeat(64),
      atNoon,
    ).observedAt,
    '2026-07-16T12:00:00.000Z',
  );
  assert.throws(
    () =>
      createCapacityProofProjection(
        'external-ha-attestation',
        {
          ...proof,
          observedAt: '2026-07-16T11:59:59.999Z',
          expiresAt: '2026-07-17T12:00:01.000Z',
        },
        'b'.repeat(64),
        atNoon,
      ),
    /validity window/u,
  );
  assert.equal(
    createCapacityProofProjection(
      'external-ha-attestation',
      {
        ...proof,
        observedAt: '2026-07-17T12:00:00.000Z',
        expiresAt: '2026-07-24T12:00:00.000Z',
      },
      'b'.repeat(64),
      atNoon,
    ).expiresAt,
    '2026-07-24T12:00:00.000Z',
  );
  assert.throws(
    () =>
      createCapacityProofProjection(
        'external-ha-attestation',
        {
          ...proof,
          observedAt: '2026-07-17T12:00:00.000Z',
          expiresAt: '2026-07-24T12:00:00.001Z',
        },
        'b'.repeat(64),
        atNoon,
      ),
    /validity window/u,
  );
  assert.throws(
    () =>
      createCapacityProofProjection(
        'external-ha-attestation',
        { ...proof, expiresAt: '2026-07-17T12:00:00.000Z' },
        'b'.repeat(64),
        atNoon,
      ),
    /validity window/u,
  );
  assert.throws(
    () =>
      createCapacityProofProjection('external-ha-attestation', proof, 'b'.repeat(64), {
        now: () => new Date(Number.NaN),
      }),
    /clock must return a valid Date/u,
  );
});

test('reviewed Production topology is stable across fresh observations while evidence identity changes', () => {
  const descriptor = {
    schemaVersion: 'tixkit-supported-profile-runtime-descriptor-v1',
    profile: 'production',
    cluster: { profileProofSha256: '1'.repeat(64), contextSha256: '2'.repeat(64) },
    api: {
      imageDigest: digest('a'),
      deploymentRevisionSha256: '3'.repeat(64),
      templateHashSha256: '4'.repeat(64),
      readyPodIdentitiesSha256: '5'.repeat(64),
    },
    worker: {
      imageDigest: digest('b'),
      deploymentRevisionSha256: '6'.repeat(64),
      templateHashSha256: '7'.repeat(64),
      readyPodIdentitiesSha256: '8'.repeat(64),
    },
  };
  const nextObservation = structuredClone(descriptor);
  nextObservation.cluster.profileProofSha256 = '9'.repeat(64);
  nextObservation.api.readyPodIdentitiesSha256 = 'a'.repeat(64);
  assert.deepEqual(
    createReviewedTopologyFingerprint(descriptor),
    createReviewedTopologyFingerprint(nextObservation),
  );
  assert.notDeepEqual(
    createTopologyFingerprint(descriptor),
    createTopologyFingerprint(nextObservation),
  );
  const substituted = structuredClone(nextObservation);
  substituted.api.imageDigest = digest('0');
  assert.notDeepEqual(
    createReviewedTopologyFingerprint(descriptor),
    createReviewedTopologyFingerprint(substituted),
  );
  delete nextObservation.worker.templateHashSha256;
  assert.throws(
    () => createReviewedTopologyFingerprint(nextObservation),
    /missing exact runtime observations/u,
  );
});

test('API responses do not need a self-asserted release identity header', async () => {
  const responses = [
    jsonResponse(
      201,
      signedFixture({
        fixtureId: 'fixture-api-substitution',
        eventId: 'event-api-substitution',
        ticketTypeId: 'ticket-api-substitution',
        stateToken: 'state-token',
      }),
    ),
    jsonResponse(201, { id: 'session-runner-bound' }),
    jsonResponse(200, { inventory: 1, held: 1 }),
  ];
  const result = await runCheckoutReservationWorkload({
    apiOrigin: 'https://api.example.test',
    fixtureOrigin: 'https://fixture.example.test',
    ...workloadIdentity,
    authorization: 'Bearer fixture-secret',
    inventory: 1,
    concurrency: 1,
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result.metrics.platformFailures, 0);
  assert.equal(result.metrics.successes, 1);
});

test('workload aborts oversized and deadline-stalled response streams', async () => {
  let oversizedCancelled = false;
  const oversized = {
    status: 201,
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(256 * 1024 + 1) }),
        cancel: async () => {
          oversizedCancelled = true;
        },
      }),
    },
  };
  await assert.rejects(
    runCheckoutReservationWorkload({
      apiOrigin: 'https://api.example.test',
      fixtureOrigin: 'https://fixture.example.test',
      ...workloadIdentity,
      authorization: 'Bearer fixture-secret',
      inventory: 1,
      concurrency: 1,
      fetchImpl: async () => oversized,
    }),
    /capacity fixture request failed/u,
  );
  assert.equal(oversizedCancelled, true);

  let stalledCancelled = false;
  const stalled = {
    status: 201,
    body: {
      getReader: () => ({
        read: async () => new Promise(() => undefined),
        cancel: async () => {
          stalledCancelled = true;
        },
      }),
    },
  };
  const started = Date.now();
  await assert.rejects(
    runCheckoutReservationWorkload({
      apiOrigin: 'https://api.example.test',
      fixtureOrigin: 'https://fixture.example.test',
      ...workloadIdentity,
      authorization: 'Bearer fixture-secret',
      inventory: 1,
      concurrency: 1,
      requestTimeoutMs: 10,
      fetchImpl: async () => stalled,
    }),
    /capacity fixture request failed/u,
  );
  assert.ok(Date.now() - started < 500);
  assert.equal(stalledCancelled, true);
});

test('protected workflow fails closed before load and keeps external proof explicit', () => {
  const invocation = workflow.indexOf('Reject an unreviewed invocation');
  const attestation = workflow.indexOf('Download and attest the immutable public release manifest');
  const setup = workflow.indexOf('uses: ./.github/actions/setup-js');
  const install = workflow.indexOf('run: bun install --frozen-lockfile');
  const productionPlacement = workflow.indexOf('Prove Production placement without disruption');
  const topology = workflow.indexOf('Attest runtime topology before output or load');
  const contracts = workflow.indexOf('Validate contracts before load');
  const load = workflow.indexOf('Run profile-owned checkout reservation workload');
  const upload = workflow.indexOf(
    'Upload checksum-bound evidence for independent signing and review',
  );
  assert.ok(
    invocation < attestation &&
      attestation < productionPlacement &&
      attestation < setup &&
      setup < install &&
      install < productionPlacement &&
      productionPlacement < topology &&
      topology < contracts,
  );
  assert.ok(contracts < load && load < upload);
  assert.match(workflow, /runs-on: \[self-hosted, tixkit-supported-profile-capacity/u);
  assert.match(workflow, /environment: supported-profile-capacity-/u);
  assert.match(workflow, /EXPECTED_TOPOLOGY_SHA256/u);
  assert.match(workflow, /EXTERNAL_HA_ATTESTATION_SHA256/u);
  assert.match(workflow, /verify-production-profile\.sh/u);
  assert.match(workflow, /profileProofSha256/u);
  assert.match(workflow, /fixture-service-artifact\.json/u);
  assert.match(workflow, /gh attestation verify "\$\{FIXTURE_SERVICE_ARTIFACT_PATH\}"/u);
  assert.match(workflow, /createCapacityProofProjection/u);
  assert.match(workflow, /runtime-descriptor\.json/u);
  assert.match(workflow, /namespaceSha256:sha256\(namespace\)/u);
  assert.match(workflow, /releaseSha256:sha256\(release\)/u);
  assert.doesNotMatch(workflow, /cluster:\{contextSha256:sha256\(context\),namespace,release,/u);
  assert.match(workflow, /containerStatuses\[0\]\.imageID/u);
  assert.match(workflow, /deployment\.kubernetes\.io\/revision/u);
  assert.match(workflow, /get','replicaset'/u);
  assert.match(workflow, /ownerReferences/u);
  assert.match(workflow, /spec\?\.containers\?\.\[0\]\?\.resources\?\.limits/u);
  assert.match(workflow, /pod-template-hash/u);
  assert.match(workflow, /external-ha-attestation\.json/u);
  assert.match(
    workflow,
    /dependencyScope:'runtime-topology-bound-dependencies-not-independently-characterized'/u,
  );
  assert.match(workflow, /hostCapacity:'not-characterized'/u);
  assert.doesNotMatch(workflow, /setTimeout as delay/u);
  assert.doesNotMatch(workflow, /writeFileSync\([^\n]*haAttestation\.bytes/u);
  assert.doesNotMatch(workflow, /writeFileSync\([^\n]*productionProof\.bytes/u);
  assert.doesNotMatch(workflow, /PRODUCTION_DISRUPTION_ACK/u);
  assert.match(workflow, /--deny-self-hosted-runners/u);
  assert.match(workflow, /checked_out_commit=.*git rev-parse HEAD/u);
  assert.match(workflow, /manifest_commit=.*\.core\.sourceCommit/u);
  assert.match(workflow, /checked_out_commit.*==.*manifest_commit/u);
  assert.match(workflow, /NetworkSettings\?\.Ports\?\.\['4000\/tcp'\]/u);
  assert.match(workflow, /inspected runner-bound endpoint/u);
  assert.match(workflow, /reviewedTopologyFingerprint=createReviewedTopologyFingerprint/u);
  assert.match(workflow, /tixkit-supported-profile-observed-topology-v1/u);
  assert.match(workflow, /createReviewedTopologyFingerprint\(descriptor\)/u);
  assert.doesNotMatch(workflow, /x-tixkit-release-image-digest/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /schedule:/u);
  assert.match(workflow, /independent signing and review/u);
});
