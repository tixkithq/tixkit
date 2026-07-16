import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-capacity.schema.json' with { type: 'json' };
import {
  createCapacityEvidence,
  executeCapacitySample,
  runCapacityCharacterization,
  validateCapacityEvidence,
  validateCapacityConfig,
} from '../performance-capacity.mjs';
import { canonicalJson, sha256 } from '../performance-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const committed = JSON.parse(readFileSync(resolve(root, 'performance-capacity.trusted.json')));
const workflow = readFileSync(resolve(root, '.github/workflows/performance-capacity.yml'), 'utf8');

function configFixture() {
  return structuredClone(committed);
}

function metrics(concurrency, inventory, throughput, p95 = 100, platformFailures = 0) {
  const successes = Math.min(concurrency, inventory) - platformFailures;
  const expectedInventoryDeclines = Math.max(0, concurrency - inventory);
  const attempts = successes + expectedInventoryDeclines + platformFailures;
  const elapsedMs = Number(((attempts / throughput) * 1_000).toFixed(2));
  return Buffer.from(
    `${JSON.stringify({
      attempts,
      successes,
      expectedInventoryDeclines,
      platformFailures,
      elapsedMs,
      requestThroughputPerSecond: Number(((attempts / elapsedMs) * 1_000).toFixed(2)),
      successfulReservationThroughputPerSecond: Number(
        ((successes / elapsedMs) * 1_000).toFixed(2),
      ),
      successfulReservationP50Ms: p95 / 2,
      successfulReservationP95Ms: p95,
    })}\n`,
  );
}

function samplesFor(profile, throughputs, options = {}) {
  return profile.concurrencyPoints.map((concurrency, point) =>
    Array.from({ length: profile.samplesPerPoint }, () =>
      metrics(
        concurrency,
        profile.inventory,
        throughputs[point],
        options.p95?.[point] ?? 100,
        options.platformFailures?.[point] ?? 0,
      ),
    ),
  );
}

test('committed trusted-host capacity profiles satisfy strict schema and relational invariants', () => {
  assert.equal(validateCapacityConfig(committed), committed);
  assert.deepEqual(
    committed.profiles.map(({ id }) => id),
    ['postgresql-trusted-host', 'mysql-trusted-host'],
  );
  for (const profile of committed.profiles) {
    assert.ok(profile.concurrencyPoints.length >= 3);
    assert.ok(profile.samplesPerPoint >= 3);
    assert.equal(profile.runnerLabel, 'tixkit-epyc-trusted');
    assert.match(profile.database.image, /@sha256:[a-f0-9]{64}$/);
  }
});

test('schema accepts both committed config and produced evidence', () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(committed), true, JSON.stringify(validate.errors));
  const profile = committed.profiles[0];
  const evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: 'a'.repeat(40),
    rawSamples: samplesFor(profile, [100, 160, 162, 160]),
  });
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
});

test('first throughput-gain breach is saturation and requires one lower publishable point', () => {
  const profile = committed.profiles[0];
  const evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: 'b'.repeat(40),
    rawSamples: samplesFor(profile, [100, 160, 162, 170]),
  });
  assert.equal(evidence.points[0].throughputGainPercent, null);
  assert.deepEqual(evidence.saturation, {
    concurrency: 64,
    reason: 'throughput-gain-threshold',
  });
  assert.deepEqual(evidence.capacityClaim, {
    maxPublishableConcurrency: 32,
    saturationObservedAtConcurrency: 64,
  });
  assert.equal(evidence.points[3].publishable, false);
  assert.equal(evidence.claimScope, 'trusted-single-host-capacity-characterization');
  assert.deepEqual(evidence.denials, [
    'Production capacity',
    'Cloud capacity',
    'Compact capacity',
    'general capacity',
  ]);
  assert.equal(evidence.integrityModel, 'checksums-not-signatures');
});

test('absence of saturation produces no capacity claim', () => {
  const profile = committed.profiles[0];
  const evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: 'c'.repeat(40),
    rawSamples: samplesFor(profile, [100, 160, 260, 840]),
  });
  assert.equal(evidence.saturation, null);
  assert.equal(evidence.capacityClaim, null);
  assert.ok(evidence.points.every(({ publishable }) => publishable));
});

test('p95 and platform failures are fail-closed saturation reasons', () => {
  const profile = committed.profiles[0];
  const p95Evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: 'd'.repeat(40),
    rawSamples: samplesFor(profile, [100, 160, 260, 420], { p95: [100, 100, 2100, 100] }),
  });
  assert.equal(p95Evidence.saturation.reason, 'p95-threshold');

  const platformEvidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: 'e'.repeat(40),
    rawSamples: samplesFor(profile, [100, 160, 260, 420], {
      platformFailures: [0, 0, 1, 0],
    }),
  });
  assert.equal(platformEvidence.saturation.reason, 'platform-failure');
  assert.equal(platformEvidence.points[2].publishable, false);
});

test('one p95 breach among repeated samples establishes first saturation', () => {
  const profile = committed.profiles[0];
  const rawSamples = samplesFor(profile, [100, 160, 260, 420]);
  const breached = JSON.parse(rawSamples[1][0]);
  breached.successfulReservationP50Ms = 100;
  breached.successfulReservationP95Ms = profile.saturationP95Ms + 1;
  rawSamples[1][0] = Buffer.from(JSON.stringify(breached));

  const evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: '8'.repeat(40),
    rawSamples,
  });
  assert.equal(evidence.points[1].medianSuccessfulReservationP95Ms, 100);
  assert.equal(evidence.points[1].publishable, false);
  assert.deepEqual(evidence.saturation, {
    concurrency: profile.concurrencyPoints[1],
    reason: 'p95-threshold',
  });
  assert.deepEqual(evidence.capacityClaim, {
    maxPublishableConcurrency: profile.concurrencyPoints[0],
    saturationObservedAtConcurrency: profile.concurrencyPoints[1],
  });
});

test('metrics reject equation drift, unexpected fields, false inventory declines, and wall-time drift', () => {
  const profile = committed.profiles[0];
  const base = samplesFor(profile, [100, 160, 260, 420]);
  const mutations = [
    (value) => (value.successes -= 1),
    (value) => (value.extra = 1),
    (value) => (value.expectedInventoryDeclines = 1),
    (value) => (value.requestThroughputPerSecond += 0.01),
    (value) => (value.successfulReservationThroughputPerSecond += 0.01),
  ];
  for (const mutate of mutations) {
    const candidate = base.map((point) => [...point]);
    const value = JSON.parse(candidate[0][0]);
    mutate(value);
    candidate[0][0] = Buffer.from(JSON.stringify(value));
    assert.throws(() =>
      createCapacityEvidence({
        config: committed,
        profile,
        gitSha: 'f'.repeat(40),
        rawSamples: candidate,
      }),
    );
  }
});

test('producer precision and two-decimal rates revalidate at short wall times', () => {
  const profile = committed.profiles[0];
  const rawSamples = samplesFor(profile, [100, 160, 260, 840]);
  const value = JSON.parse(rawSamples[0][0]);
  value.elapsedMs = 1.23456789;
  value.requestThroughputPerSecond = Number(
    ((value.attempts / value.elapsedMs) * 1_000).toFixed(2),
  );
  value.successfulReservationThroughputPerSecond = Number(
    ((value.successes / value.elapsedMs) * 1_000).toFixed(2),
  );
  rawSamples[0] = rawSamples[0].map(() => Buffer.from(JSON.stringify(value)));
  assert.doesNotThrow(() =>
    createCapacityEvidence({
      config: committed,
      profile,
      gitSha: '9'.repeat(40),
      rawSamples,
    }),
  );
});

test('config rejects duplicate profiles, non-monotonic points, missing samples, and threshold drift', () => {
  const duplicate = configFixture();
  duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  assert.throws(() => validateCapacityConfig(duplicate), /duplicate capacity profile/);

  const nonMonotonic = configFixture();
  nonMonotonic.profiles[0].concurrencyPoints = [16, 16, 64];
  assert.throws(() => validateCapacityConfig(nonMonotonic));

  const threshold = configFixture();
  threshold.profiles[0].minThroughputGainPercent = 101;
  assert.throws(() => validateCapacityConfig(threshold));

  const missingInventory = configFixture();
  missingInventory.profiles[0].concurrencyPoints = [16, 32, 63, 128];
  assert.throws(() => validateCapacityConfig(missingInventory), /exact inventory point/);

  const missingExhaustion = configFixture();
  missingExhaustion.profiles[0].concurrencyPoints = [16, 32, 64];
  assert.throws(() => validateCapacityConfig(missingExhaustion), /point above inventory/);

  const profile = committed.profiles[0];
  const tooFew = samplesFor(profile, [100, 160, 260, 420]);
  tooFew[0].pop();
  assert.throws(
    () =>
      createCapacityEvidence({
        config: committed,
        profile,
        gitSha: '1'.repeat(40),
        rawSamples: tooFew,
      }),
    /requires 3 samples/,
  );
});

test('evidence binds config, workload, raw hashes, and its complete payload checksum', () => {
  const profile = committed.profiles[0];
  const rawSamples = samplesFor(profile, [100, 160, 162, 170]);
  const evidence = createCapacityEvidence({
    config: committed,
    profile,
    gitSha: '2'.repeat(40),
    rawSamples,
  });
  assert.equal(evidence.identity.configSha256, sha256(canonicalJson(committed)));
  assert.equal(evidence.points[0].samples[0].rawSha256, sha256(rawSamples[0][0]));
  const { evidenceSha256, ...payload } = evidence;
  assert.equal(evidenceSha256, sha256(canonicalJson(payload)));
  assert.equal(validateCapacityEvidence({ config: committed, evidence, rawSamples }), evidence);

  const tampered = structuredClone(evidence);
  tampered.points[0].medianSuccessfulReservationThroughputPerSecond += 1;
  assert.throws(
    () => validateCapacityEvidence({ config: committed, evidence: tampered, rawSamples }),
    /does not match|schema violation/,
  );
  const tamperedRaw = rawSamples.map((point) => [...point]);
  tamperedRaw[0][0] = metrics(profile.concurrencyPoints[0], profile.inventory, 101);
  assert.throws(() =>
    validateCapacityEvidence({ config: committed, evidence, rawSamples: tamperedRaw }),
  );
});

test('profile drift, malformed raw shape, and percentile inversion fail closed', () => {
  const profile = structuredClone(committed.profiles[0]);
  const rawSamples = samplesFor(profile, [100, 160, 260, 420]);
  profile.saturationP95Ms += 1;
  assert.throws(
    () =>
      createCapacityEvidence({
        config: committed,
        profile,
        gitSha: '4'.repeat(40),
        rawSamples,
      }),
    /exactly match/,
  );
  assert.throws(() =>
    createCapacityEvidence({
      config: committed,
      profile: committed.profiles[0],
      gitSha: '4'.repeat(40),
      rawSamples: null,
    }),
  );
  const inverted = samplesFor(committed.profiles[0], [100, 160, 260, 420]);
  const value = JSON.parse(inverted[0][0]);
  value.successfulReservationP50Ms = value.successfulReservationP95Ms + 1;
  inverted[0][0] = Buffer.from(JSON.stringify(value));
  assert.throws(
    () =>
      createCapacityEvidence({
        config: committed,
        profile: committed.profiles[0],
        gitSha: '4'.repeat(40),
        rawSamples: inverted,
      }),
    /must not exceed/,
  );
});

test('runner creates exclusive 0700 output and never overwrites evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-capacity-'));
  const output = join(directory, 'evidence');
  const config = configFixture();
  const profile = config.profiles[0];
  profile.concurrencyPoints = [16, 32, 64];
  profile.inventory = 32;
  try {
    const executeSample = async ({ concurrency, metricsPath }) => {
      const bytes = metrics(concurrency, profile.inventory, concurrency * 10);
      writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
      return bytes;
    };
    await runCapacityCharacterization({
      config,
      profile,
      outputDirectory: output,
      gitSha: '3'.repeat(40),
      executeSample,
    });
    assert.equal(readFileSync(join(output, 'evidence.json'), 'utf8').endsWith('\n'), true);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'raw')).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'raw', '16')).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'raw', '16', 'sample-1.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(output, 'evidence.json')).mode & 0o777, 0o600);
    await assert.rejects(
      runCapacityCharacterization({
        config,
        profile,
        outputDirectory: output,
        gitSha: '3'.repeat(40),
        executeSample,
      }),
      /EEXIST/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('child process inherits only allowlisted environment and receives the selected database driver', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-capacity-env-'));
  const metricsPath = join(directory, 'metrics ; $(touch should-not-exist).json');
  const controller = new AbortController();
  const previous = process.env.CAPACITY_SECRET_SENTINEL;
  process.env.CAPACITY_SECRET_SENTINEL = 'must-not-leak';
  try {
    const profile = {
      ...structuredClone(committed.profiles[0]),
      command: {
        executable: process.execPath,
        args: [
          '-e',
          "require('node:fs').writeFileSync(process.env.CAPACITY_METRICS_PATH, JSON.stringify({sentinel:process.env.CAPACITY_SECRET_SENTINEL??null,driver:process.env.DB_INTEGRATION_DRIVER}), {flag:'wx'})",
        ],
        env: committed.profiles[0].command.env,
      },
    };
    const bytes = await executeCapacitySample({
      profile,
      concurrency: 16,
      metricsPath,
      signal: controller.signal,
    });
    assert.deepEqual(JSON.parse(bytes), { sentinel: null, driver: 'postgres' });
    assert.throws(() => readFileSync(join(directory, 'should-not-exist')));
  } finally {
    if (previous === undefined) delete process.env.CAPACITY_SECRET_SENTINEL;
    else process.env.CAPACITY_SECRET_SENTINEL = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nonzero child exit is never converted into capacity evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-capacity-child-failure-'));
  const profile = structuredClone(committed.profiles[0]);
  profile.command = {
    executable: process.execPath,
    args: [
      '-e',
      "require('node:fs').writeFileSync(process.env.CAPACITY_METRICS_PATH, JSON.stringify({platformFailures:1}), {flag:'wx'}); process.exitCode=1",
    ],
    env: profile.command.env,
  };
  try {
    await assert.rejects(
      executeCapacitySample({
        profile,
        concurrency: 16,
        metricsPath: join(directory, 'rejected.json'),
        signal: new AbortController().signal,
      }),
      /exit 1/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('timeout escalates through a SIGTERM-resistant process group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-capacity-abort-'));
  const controller = new AbortController();
  const profile = {
    ...structuredClone(committed.profiles[0]),
    timeoutSeconds: 0.02,
    command: {
      executable: process.execPath,
      args: [
        '-e',
        "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
      ],
      env: committed.profiles[0].command.env,
    },
  };
  try {
    const started = Date.now();
    const execution = executeCapacitySample({
      profile,
      concurrency: 16,
      metricsPath: join(directory, 'never.json'),
      signal: controller.signal,
    });
    await assert.rejects(execution, /exceeded 0.02s timeout/);
    assert.ok(Date.now() - started >= 1_000, 'SIGKILL escalation must own final settlement');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('abort escalates through a SIGTERM-resistant process group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-capacity-interrupt-'));
  const controller = new AbortController();
  const profile = {
    ...structuredClone(committed.profiles[0]),
    timeoutSeconds: 10,
    command: {
      executable: process.execPath,
      args: [
        '-e',
        "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
      ],
      env: committed.profiles[0].command.env,
    },
  };
  try {
    const started = Date.now();
    const execution = executeCapacitySample({
      profile,
      concurrency: 16,
      metricsPath: join(directory, 'never.json'),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(execution, /interrupted/);
    assert.ok(Date.now() - started >= 1_000, 'SIGKILL escalation must own final settlement');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('weekly/manual trusted workflow is default-branch-only, serial, pinned, private, and always uploads', () => {
  assert.match(workflow, /cron: '41 6 \* \* 0'/);
  assert.match(workflow, /schedule\|workflow_dispatch/);
  assert.match(workflow, /GITHUB_REF_NAME.*DEFAULT_BRANCH/s);
  assert.match(workflow, /GITHUB_REF_TYPE.*branch/);
  assert.match(workflow, /GITHUB_REF.*EXPECTED_REF/);
  assert.match(workflow, /runs-on: tixkit-epyc-trusted/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /postgres:16-alpine@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /mysql:8\.4@sha256:[a-f0-9]{64}/);
  assert.match(
    workflow,
    /command: \$\{\{ matrix\.profile == 'mysql-trusted-host' && '--log-bin-trust-function-creators=1'/,
  );
  assert.match(workflow, /mkdir -m 700/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /checksums-not-signatures/);
  assert.match(workflow, /INVOCATION_OUTCOME: \$\{\{ steps\.invocation\.outcome \}\}/);
  assert.match(workflow, /CAPACITY_OUTCOME: \$\{\{ steps\.capacity\.outcome \}\}/);
  assert.match(workflow, /const phase=names\.find/);
  assert.match(workflow, /runnerLabel:'tixkit-epyc-trusted'/);
  assert.match(workflow, /databaseImage:process\.env\.DATABASE_IMAGE/);
  assert.match(workflow, /configSha256=outcomes\.checkout==='success'&&fs\.existsSync/);
  for (const profile of committed.profiles) {
    assert.match(workflow, new RegExp(profile.id));
    assert.match(
      workflow,
      new RegExp(profile.database.image.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(profile.runnerLabel, 'tixkit-epyc-trusted');
  }
});
