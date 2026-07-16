import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-soak.schema.json' with { type: 'json' };
import {
  createSoakEvidence,
  executeSoakIteration,
  runSoak,
  soakChildEnvironment,
  validateSoakConfig,
  validateSoakEvidence,
  validateSoakEvidenceDirectory,
  writeSoakFailure,
} from '../performance-soak.mjs';
import { canonicalJson, sha256 } from '../performance-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const committed = JSON.parse(readFileSync(resolve(root, 'performance-soak.trusted.json')));
const budgetBytes = readFileSync(resolve(root, 'performance-budgets.integration.json'));
const workflow = readFileSync(resolve(root, '.github/workflows/performance-soak.yml'), 'utf8');

function assertSoakWorkflowContract(candidate) {
  const invocation = candidate.indexOf('      - name: Reject non-default or untrusted invocation');
  const checkout = candidate.indexOf('      - id: checkout');
  const migration = candidate.indexOf('      - name: Migrate only the selected database');
  const soak = candidate.indexOf('      - name: Run four-hour continuous integration soak');
  const recovery = candidate.indexOf(
    '      - name: Recover process group and verify selected database',
  );
  const workflowFailure = candidate.indexOf('      - name: Record bounded workflow failure');
  const successUpload = candidate.indexOf('      - name: Upload successful soak evidence');
  const failureUpload = candidate.indexOf('      - name: Upload failure evidence');
  assert.ok(
    invocation >= 0 &&
      invocation < checkout &&
      checkout < migration &&
      migration < soak &&
      soak < recovery &&
      recovery < workflowFailure &&
      workflowFailure < successUpload &&
      successUpload < failureUpload,
    'soak safety and evidence steps must retain their fail-closed order',
  );

  const service = /    services:\n      database:\n([\s\S]*?)\n    env:/u.exec(candidate)?.[1];
  assert.ok(service, 'selected database service block must exist');
  assert.match(
    service,
    /^        image: \$\{\{ matrix\.profile == 'postgresql-trusted-host-integration-soak' && 'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb' \|\| 'mysql:8\.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209' \}\}$/mu,
  );
  assert.match(
    service,
    /^        command: \$\{\{ matrix\.profile == 'mysql-trusted-host-integration-soak' && '--log-bin-trust-function-creators=1' \|\| '' \}\}$/mu,
  );

  const recoveryBlock = candidate.slice(recovery, workflowFailure);
  assert.match(recoveryBlock, /        if: always\(\)/u);
  assert.match(recoveryBlock, /active-process-group/u);
  assert.match(recoveryBlock, /job\.services\.database\.id/u);
  const successUploadBlock = candidate.slice(successUpload, failureUpload);
  assert.match(successUploadBlock, /        if: success\(\)/u);
  const failureUploadBlock = candidate.slice(failureUpload);
  assert.match(
    failureUploadBlock,
    /        if: \$\{\{ always\(\) && job\.status != 'success' \}\}/u,
  );
}

function metrics(multiplier = 1) {
  return Object.fromEntries(
    committed.profiles[0].metrics.map((metric, index) => [metric, (index + 1) * multiplier]),
  );
}

function samples(profile, multiplier = () => 1) {
  return Array.from({ length: profile.minimumIterations }, (_, index) => ({
    launchedMonotonicMs: index * 600_000,
    completedMonotonicMs: (index + 1) * 600_000,
    startedAt: new Date(Date.UTC(2026, 0, 1) + index * 600_000).toISOString(),
    completedAt: new Date(Date.UTC(2026, 0, 1) + (index + 1) * 600_000).toISOString(),
    rawBytes: Buffer.from(`${JSON.stringify(metrics(multiplier(index)))}\n`),
  }));
}

test('committed profiles encode the exact four-hour trusted-host integration soak', () => {
  assert.equal(validateSoakConfig(committed), committed);
  assert.deepEqual(
    committed.profiles.map(({ id }) => id),
    ['postgresql-trusted-host-integration-soak', 'mysql-trusted-host-integration-soak'],
  );
  for (const profile of committed.profiles) {
    assert.equal(profile.durationSeconds, 14_400);
    assert.equal(profile.minimumIterations, 24);
    assert.equal(profile.maximumIterations, 4_096);
    assert.equal(profile.maximumLaunchGapSeconds, 5);
    assert.equal(profile.windowSize, 6);
    assert.equal(profile.maximumAdverseMedianDriftPercent, 15);
    assert.equal(profile.budgets, 'performance-budgets.integration.json');
    assert.equal(profile.workload.checkoutCapacity, 25);
    assert.equal(profile.workload.checkoutConcurrency, 120);
    assert.equal(profile.workload.scannerConcurrency, 60);
    assert.equal(profile.workload.streamedExportRows, 2_500);
    assert.match(profile.database.image, /@sha256:[a-f0-9]{64}$/);
  }
});

test('schema accepts committed config and fully derived evidence', () => {
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  assert.equal(validate(committed), true, JSON.stringify(validate.errors));
  const profile = committed.profiles[0];
  const evidence = createSoakEvidence({
    config: committed,
    profile,
    gitSha: 'a'.repeat(40),
    budgetBytes,
    samples: samples(profile),
  });
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.controls.actualDurationMs, 14_400_000);
  assert.equal(evidence.controls.actualIterations, 24);
  assert.equal(evidence.identity.budgetSha256, sha256(budgetBytes));
  assert.equal(evidence.metricSummary.length, profile.metrics.length);
  assert.ok(
    evidence.iterations.every(({ sealedSampleSha256 }) =>
      /^[a-f0-9]{64}$/.test(sealedSampleSha256),
    ),
  );
  assert.deepEqual(evidence.denials, [
    'Production soak stability',
    'Cloud soak stability',
    'Compact soak stability',
    'same-process memory-leak proof',
    'provider resilience',
    'Temporal resilience',
    'capacity',
    'RUM',
    'SLA/SLO attainment',
    'immutable or publicly published evidence',
  ]);
  assert.equal(evidence.integrityModel, 'checksums-not-signatures');
});

test('exact command, environment, budget authority, metrics, and controls fail closed', () => {
  const mutations = [
    (config) => config.profiles[0].command.args.push('--changed'),
    (config) => (config.profiles[0].command.env.EXTRA = 'unsafe'),
    (config) => (config.profiles[0].budgets = 'alternate.json'),
    (config) => config.profiles[0].metrics.reverse(),
    (config) => (config.profiles[0].durationSeconds = 14_399),
    (config) => (config.profiles[0].maximumIterations = 4_095),
    (config) => (config.profiles[0].iterationTimeoutSeconds = 539),
    (config) => (config.profiles[0].windowSize = 5),
    (config) => (config.profiles[0].maximumLaunchGapSeconds = 5.01),
    (config) => (config.profiles[0].database.image = `postgres:16@sha256:${'a'.repeat(64)}`),
    (config) => (config.profiles[0].database.engine = 'sqlite'),
    (config) => config.profiles.pop(),
    (config) => (config.profiles[1] = structuredClone(config.profiles[0])),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(committed);
    mutate(candidate);
    assert.throws(() => validateSoakConfig(candidate));
  }
});

test('missing, non-finite, and absolute budget breaches fail every iteration closed', () => {
  const profile = committed.profiles[0];
  for (const mutate of [
    (value) => delete value.checkoutReservationP50Ms,
    (value) => (value.checkoutReservationP50Ms = null),
    (value) => (value.checkoutReservationP50Ms = 1_001),
  ]) {
    const candidate = samples(profile);
    const value = JSON.parse(candidate[7].rawBytes);
    mutate(value);
    candidate[7].rawBytes = Buffer.from(JSON.stringify(value));
    assert.throws(() =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: '6'.repeat(40),
        budgetBytes,
        samples: candidate,
      }),
    );
  }
});

test('minimum budgets treat falling first-to-last median as adverse drift', () => {
  const profile = committed.profiles[0];
  const minimumBudget = JSON.parse(budgetBytes);
  delete minimumBudget.metrics[0].max;
  minimumBudget.metrics[0].min = 1;
  assert.throws(
    () =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: '7'.repeat(40),
        budgetBytes: Buffer.from(JSON.stringify(minimumBudget)),
        samples: samples(profile, (index) => (index >= 18 ? 8 : 10)),
      }),
    /adverse median drift/,
  );
});

test('budget bytes and exact authoritative metric order are bound into evidence', () => {
  const profile = committed.profiles[0];
  const changedBudget = JSON.parse(budgetBytes);
  changedBudget.metrics.reverse();
  assert.throws(
    () =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: 'b'.repeat(40),
        budgetBytes: Buffer.from(JSON.stringify(changedBudget)),
        samples: samples(profile),
      }),
    /authoritative budget/,
  );
  const changedMetrics = samples(profile);
  const value = JSON.parse(changedMetrics[0].rawBytes);
  value.extraMetric = 1;
  changedMetrics[0].rawBytes = Buffer.from(JSON.stringify(value));
  assert.throws(
    () =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: 'c'.repeat(40),
        budgetBytes,
        samples: changedMetrics,
      }),
    /metric set or order/,
  );
});

test('duration, minimum iterations, monotonic ordering, and maximum launch gap fail closed', () => {
  const profile = committed.profiles[0];
  const cases = [
    samples(profile).slice(0, -1),
    samples(profile).map((sample, index) =>
      index === 23 ? { ...sample, completedMonotonicMs: 14_399_999 } : sample,
    ),
    samples(profile).map((sample, index) =>
      index === 2 ? { ...sample, launchedMonotonicMs: 1_205_001 } : sample,
    ),
    samples(profile).map((sample, index) =>
      index === 2 ? { ...sample, launchedMonotonicMs: 1_199_999 } : sample,
    ),
  ];
  for (const candidate of cases) {
    assert.throws(() =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: 'd'.repeat(40),
        budgetBytes,
        samples: candidate,
      }),
    );
  }
});

test('first and last six medians allow 15 percent and reject adverse drift above it', () => {
  const profile = committed.profiles[0];
  const boundary = createSoakEvidence({
    config: committed,
    profile,
    gitSha: 'e'.repeat(40),
    budgetBytes,
    samples: samples(profile, (index) => (index >= 18 ? 1.15 : 1)),
  });
  assert.ok(
    boundary.drift.every(({ adverseMedianDriftPercent }) => adverseMedianDriftPercent <= 15),
  );
  assert.throws(
    () =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: 'f'.repeat(40),
        budgetBytes,
        samples: samples(profile, (index) => (index >= 18 ? 1.151 : 1)),
      }),
    /adverse median drift/,
  );
});

test('zero baselines cannot hide later adverse values', () => {
  const profile = committed.profiles[0];
  const candidate = samples(profile);
  for (let index = 0; index < 6; index += 1) {
    const value = JSON.parse(candidate[index].rawBytes);
    value.checkoutReservationP50Ms = 0;
    candidate[index].rawBytes = Buffer.from(JSON.stringify(value));
  }
  assert.throws(
    () =>
      createSoakEvidence({
        config: committed,
        profile,
        gitSha: '1'.repeat(40),
        budgetBytes,
        samples: candidate,
      }),
    /zero baseline/,
  );
});

test('evidence verification detects raw tampering, sample reordering, and sealed/final checksum changes', () => {
  const profile = committed.profiles[0];
  const rawSamples = samples(profile);
  const evidence = createSoakEvidence({
    config: committed,
    profile,
    gitSha: '2'.repeat(40),
    budgetBytes,
    samples: rawSamples,
  });
  assert.equal(
    validateSoakEvidence({ config: committed, evidence, budgetBytes, samples: rawSamples }),
    evidence,
  );
  const mutations = [
    (value) => (value.iterations[0].metrics.checkoutReservationP50Ms += 1),
    (value) => value.iterations.reverse(),
    (value) => (value.iterations[0].sealedSampleSha256 = '0'.repeat(64)),
    (value) => (value.evidenceSha256 = '0'.repeat(64)),
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(evidence);
    mutate(candidate);
    assert.throws(() =>
      validateSoakEvidence({
        config: committed,
        evidence: candidate,
        budgetBytes,
        samples: rawSamples,
      }),
    );
  }
  const reorderedRaw = [...rawSamples];
  [reorderedRaw[0], reorderedRaw[1]] = [reorderedRaw[1], reorderedRaw[0]];
  assert.throws(() =>
    validateSoakEvidence({ config: committed, evidence, budgetBytes, samples: reorderedRaw }),
  );
});

test('fake monotonic clock runs 24 fresh iterations without executing the real workload', async () => {
  const profile = committed.profiles[0];
  const output = mkdtempSync(join(tmpdir(), 'tixkit-soak-test-'));
  rmSync(output, { recursive: true, force: true });
  let now = 0;
  let wall = Date.UTC(2026, 0, 1);
  let calls = 0;
  try {
    const evidence = await runSoak({
      config: committed,
      profile,
      outputDirectory: output,
      gitSha: '3'.repeat(40),
      budgetBytes,
      monotonicNow: () => now,
      wallNow: () => wall,
      executeIteration: async ({ metricsPath }) => {
        calls += 1;
        const bytes = Buffer.from(`${JSON.stringify(metrics())}\n`);
        writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
        now += 600_000;
        wall += 600_000;
        return bytes;
      },
    });
    assert.equal(calls, 24);
    assert.equal(evidence.controls.actualDurationMs, 14_400_000);
    assert.equal(statSync(join(output, 'evidence.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(output, 'raw')).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'sealed')).mode & 0o777, 0o700);
    assert.equal(existsSync(join(output, '.staging')), false);
    assert.equal(
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes })
        .evidenceSha256,
      evidence.evidenceSha256,
    );
    const rawPath = join(output, 'raw', 'iteration-0001.json');
    const originalRaw = readFileSync(rawPath);
    writeFileSync(rawPath, Buffer.concat([originalRaw, Buffer.from(' ')]), { mode: 0o600 });
    assert.throws(() =>
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes }),
    );
    writeFileSync(rawPath, originalRaw, { mode: 0o600 });

    chmodSync(output, 0o755);
    assert.throws(() =>
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes }),
    );
    chmodSync(output, 0o700);

    const evidencePath = join(output, 'evidence.json');
    chmodSync(evidencePath, 0o644);
    assert.throws(() =>
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes }),
    );
    chmodSync(evidencePath, 0o600);
    const evidenceBackup = join(output, 'evidence.backup');
    renameSync(evidencePath, evidenceBackup);
    symlinkSync(evidenceBackup, evidencePath);
    assert.throws(() =>
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes }),
    );
    unlinkSync(evidencePath);
    renameSync(evidenceBackup, evidencePath);

    const rawDirectory = join(output, 'raw');
    const rawBackup = join(output, 'raw.backup');
    renameSync(rawDirectory, rawBackup);
    symlinkSync(rawBackup, rawDirectory);
    assert.throws(() =>
      validateSoakEvidenceDirectory({ config: committed, outputDirectory: output, budgetBytes }),
    );
    unlinkSync(rawDirectory);
    renameSync(rawBackup, rawDirectory);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('runtime fails the first malformed or over-budget iteration before another launch', async () => {
  const profile = committed.profiles[0];
  for (const mode of ['malformed', 'over-budget']) {
    const output = join(mkdtempSync(join(tmpdir(), `tixkit-soak-immediate-${mode}-`)), 'run');
    let calls = 0;
    let now = 0;
    try {
      await assert.rejects(
        runSoak({
          config: committed,
          profile,
          outputDirectory: output,
          gitSha: '6'.repeat(40),
          budgetBytes,
          monotonicNow: () => now,
          wallNow: () => Date.UTC(2026, 0, 1) + now,
          executeIteration: async ({ metricsPath }) => {
            calls += 1;
            const value = metrics();
            if (mode === 'over-budget') value.checkoutReservationP50Ms = 1_001;
            const bytes = Buffer.from(mode === 'malformed' ? '{' : JSON.stringify(value));
            writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
            now += 100;
            return bytes;
          },
        }),
      );
      assert.equal(calls, 1);
      assert.equal(existsSync(join(output, 'failure.json')), true);
    } finally {
      rmSync(resolve(output, '..'), { recursive: true, force: true });
    }
  }
});

test('runtime rejects a late second launch before starting its child', async () => {
  const profile = committed.profiles[0];
  const output = join(mkdtempSync(join(tmpdir(), 'tixkit-soak-gap-')), 'run');
  const monotonicTimes = [0, 100, 6_101];
  let calls = 0;
  try {
    await assert.rejects(
      runSoak({
        config: committed,
        profile,
        outputDirectory: output,
        gitSha: '7'.repeat(40),
        budgetBytes,
        monotonicNow: () => monotonicTimes.shift() ?? 6_101,
        wallNow: () => Date.UTC(2026, 0, 1),
        executeIteration: async ({ metricsPath }) => {
          calls += 1;
          const bytes = Buffer.from(JSON.stringify(metrics()));
          writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
          return bytes;
        },
      }),
      /launch gap/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(resolve(output, '..'), { recursive: true, force: true });
  }
});

test('loop overhead crossing four hours cannot replace a completed soak iteration', async () => {
  const profile = committed.profiles[0];
  const output = join(mkdtempSync(join(tmpdir(), 'tixkit-soak-boundary-')), 'run');
  let calls = 0;
  const monotonicTimes = [];
  for (let index = 0; index < 24; index += 1) {
    monotonicTimes.push(index * 600_000, (index + 1) * 600_000 - (index === 23 ? 1 : 0));
  }
  monotonicTimes.push(14_400_001, 15_000_001);
  try {
    const evidence = await runSoak({
      config: committed,
      profile,
      outputDirectory: output,
      gitSha: '0'.repeat(40),
      budgetBytes,
      monotonicNow: () => monotonicTimes.shift(),
      wallNow: () => Date.UTC(2026, 0, 1),
      executeIteration: async ({ metricsPath }) => {
        calls += 1;
        const bytes = Buffer.from(JSON.stringify(metrics()));
        writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
        return bytes;
      },
    });
    assert.equal(calls, 25);
    assert.equal(evidence.controls.actualDurationMs, 15_000_001);
  } finally {
    rmSync(resolve(output, '..'), { recursive: true, force: true });
  }
});

test('finite injected iteration limit fails instead of idling before four hours', async () => {
  const profile = committed.profiles[0];
  const output = mkdtempSync(join(tmpdir(), 'tixkit-soak-limit-'));
  rmSync(output, { recursive: true, force: true });
  let now = 0;
  try {
    await assert.rejects(
      runSoak({
        config: committed,
        profile,
        outputDirectory: output,
        gitSha: '4'.repeat(40),
        budgetBytes,
        iterationLimit: 3,
        monotonicNow: () => now,
        wallNow: () => Date.UTC(2026, 0, 1) + now,
        executeIteration: async ({ metricsPath }) => {
          const bytes = Buffer.from(`${JSON.stringify(metrics())}\n`);
          writeFileSync(metricsPath, bytes, { flag: 'wx', mode: 0o600 });
          now += 1_000;
          return bytes;
        },
      }),
      /maximumIterations reached/,
    );
    const failure = JSON.parse(readFileSync(join(output, 'failure.json'), 'utf8'));
    assert.equal(failure.failureCode, 'iteration-limit-before-duration');
    assert.equal(failure.status, 'failed');
    assert.doesNotMatch(JSON.stringify(failure), /maximumIterations|Error|stack/);
    assert.equal(statSync(join(output, 'failure.json')).mode & 0o777, 0o600);
    const retained = writeSoakFailure({
      outputDirectory: output,
      config: committed,
      profile,
      gitSha: '4'.repeat(40),
      budgetBytes,
      error: new Error('secret second failure'),
      now: Date.UTC(2030, 0, 1),
    });
    assert.deepEqual(retained, failure);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('wall-clock rollback cannot substitute for the monotonic four-hour duration', () => {
  const profile = committed.profiles[0];
  const candidate = samples(profile).map((sample, index) => ({
    ...sample,
    startedAt: new Date(Date.UTC(2026, 0, 2) - index * 10_000).toISOString(),
    completedAt: new Date(Date.UTC(2026, 0, 2) - index * 10_000 - 1_000).toISOString(),
  }));
  const evidence = createSoakEvidence({
    config: committed,
    profile,
    gitSha: '8'.repeat(40),
    budgetBytes,
    samples: candidate,
  });
  assert.equal(evidence.controls.actualDurationMs, 14_400_000);
});

test('child environment exposes only the selected database and explicit allowlist', () => {
  const environment = {
    PATH: '/bin',
    DATABASE_URL: 'postgres://selected',
    DATABASE_URL_MYSQL: 'mysql://selected',
    TIXKIT_SENTINEL_SECRET: 'must-not-leak',
  };
  const postgres = soakChildEnvironment(committed.profiles[0], '/metrics.json', environment);
  const mysql = soakChildEnvironment(committed.profiles[1], '/metrics.json', environment);
  assert.equal(postgres.DATABASE_URL, 'postgres://selected');
  assert.equal(postgres.DATABASE_URL_MYSQL, undefined);
  assert.equal(mysql.DATABASE_URL_MYSQL, 'mysql://selected');
  assert.equal(mysql.DATABASE_URL, undefined);
  assert.equal(postgres.TIXKIT_SENTINEL_SECRET, undefined);
  assert.equal(mysql.TIXKIT_SENTINEL_SECRET, undefined);
});

test('output reuse, symlink metrics, and returned-byte drift fail without overwriting', async () => {
  const profile = committed.profiles[0];
  const reused = mkdtempSync(join(tmpdir(), 'tixkit-soak-reuse-'));
  const marker = join(reused, 'owned.txt');
  writeFileSync(marker, 'preserve');
  await assert.rejects(
    runSoak({
      config: committed,
      profile,
      outputDirectory: reused,
      gitSha: '9'.repeat(40),
      budgetBytes,
      iterationLimit: 1,
    }),
  );
  assert.equal(readFileSync(marker, 'utf8'), 'preserve');
  assert.equal(existsSync(join(reused, 'failure.json')), false);
  rmSync(reused, { recursive: true, force: true });

  for (const mode of ['symlink', 'mismatch']) {
    const output = mkdtempSync(join(tmpdir(), `tixkit-soak-${mode}-`));
    rmSync(output, { recursive: true, force: true });
    let now = 0;
    try {
      await assert.rejects(
        runSoak({
          config: committed,
          profile,
          outputDirectory: output,
          gitSha: 'a'.repeat(40),
          budgetBytes,
          iterationLimit: 1,
          monotonicNow: () => now,
          wallNow: () => Date.UTC(2026, 0, 1) + now,
          executeIteration: async ({ metricsPath }) => {
            const bytes = Buffer.from(`${JSON.stringify(metrics())}\n`);
            if (mode === 'symlink') {
              const target = join(output, 'target.json');
              writeFileSync(target, bytes);
              symlinkSync(target, metricsPath);
            } else {
              writeFileSync(metricsPath, Buffer.from('{}'));
            }
            now += 1_000;
            return bytes;
          },
        }),
      );
      assert.equal(existsSync(join(output, 'failure.json')), true);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});

test('timeout, abort, and nonzero parent exit kill SIGTERM-resistant descendants', async () => {
  const processAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  };
  for (const mode of ['timeout', 'abort', 'nonzero']) {
    const directory = mkdtempSync(join(tmpdir(), `tixkit-soak-process-${mode}-`));
    const profile = structuredClone(committed.profiles[0]);
    const descendantPath = join(directory, 'descendant.pid');
    profile.iterationTimeoutSeconds = mode === 'timeout' ? 0.2 : 10;
    profile.command = {
      executable: process.execPath,
      args: [
        '-e',
        "const{spawn}=require('child_process'),fs=require('fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(process.env.DESCENDANT_PID_PATH,String(child.pid));fs.writeFileSync(process.env.PERFORMANCE_METRICS_PATH,'{}');process.on('SIGTERM',()=>{});if(process.env.TEST_MODE==='nonzero')setTimeout(()=>process.exit(7),50);else setInterval(()=>{},1000)",
      ],
      env: {
        DESCENDANT_PID_PATH: descendantPath,
        PERFORMANCE_METRICS_PATH: '{metricsPath}',
        TEST_MODE: mode,
      },
    };
    const metricsPath = join(directory, 'metrics.json');
    const processGroupPath = join(directory, 'active-process-group');
    const controller = new AbortController();
    const execution = executeSoakIteration({
      profile,
      metricsPath,
      processGroupPath,
      signal: controller.signal,
    });
    if (mode === 'abort') setTimeout(() => controller.abort(), 200);
    await assert.rejects(execution, /timeout|interrupted|exit 7/);
    const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
    for (let attempt = 0; attempt < 50 && processAlive(descendantPid); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    assert.equal(processAlive(descendantPid), false, `${mode} left descendant ${descendantPid}`);
    assert.equal(existsSync(processGroupPath), false);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('trusted workflow is serial, selected-database-only, recoverable, and uploads failures independently', () => {
  assertSoakWorkflowContract(workflow);
  assert.match(workflow, /runs-on: tixkit-epyc-trusted/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /services:\n      database:/);
  assert.doesNotMatch(workflow, /services:\n      postgres:/);
  assert.doesNotMatch(workflow, /services:\n      mysql:/);
  assert.match(workflow, /timeout-minutes: 330/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /always\(\) && job\.status != 'success'/);
  assert.match(workflow, /active-process-group/);
  assert.match(workflow, /Upload failure evidence/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(
    workflow,
    /postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb/,
  );
  assert.match(
    workflow,
    /mysql:8\.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209/,
  );
  assert.match(workflow, /--log-bin-trust-function-creators=1/);
  assert.match(workflow, /Migrate only the selected database/);
  assert.match(workflow, /mkdir -m 700/);
  assert.match(workflow, /performance-soak\.test\.mjs/);
  assert.match(workflow, /performance-soak\.trusted\.json/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.doesNotMatch(workflow, /pull_request/);

  const invocation = workflow.indexOf('      - name: Reject non-default or untrusted invocation');
  const checkout = workflow.indexOf('      - id: checkout');
  const setup = workflow.indexOf('      - id: setup');
  const guardBlock = workflow.slice(invocation, checkout);
  const checkoutBlock = workflow.slice(checkout, setup);
  const checkoutBeforeGuard =
    workflow.slice(0, invocation) + checkoutBlock + guardBlock + workflow.slice(setup);
  assert.throws(() => assertSoakWorkflowContract(checkoutBeforeGuard));

  const commandLine =
    "        command: ${{ matrix.profile == 'mysql-trusted-host-integration-soak' && '--log-bin-trust-function-creators=1' || '' }}\n";
  const misplacedCommand = workflow
    .replace(commandLine, '')
    .replace(
      '    env:\n      DATABASE_URL:',
      "    command: ${{ matrix.profile == 'mysql-trusted-host-integration-soak' && '--log-bin-trust-function-creators=1' || '' }}\n    env:\n      DATABASE_URL:",
    );
  assert.throws(() => assertSoakWorkflowContract(misplacedCommand));
});

test('evidence hashes bind canonical workload, config, and final payload', () => {
  const profile = committed.profiles[0];
  const evidence = createSoakEvidence({
    config: committed,
    profile,
    gitSha: '5'.repeat(40),
    budgetBytes,
    samples: samples(profile),
  });
  const { evidenceSha256, ...payload } = evidence;
  assert.equal(evidenceSha256, sha256(canonicalJson(payload)));
  assert.equal(evidence.identity.configSha256, sha256(canonicalJson(committed)));
  assert.match(evidence.identity.workloadSha256, /^[a-f0-9]{64}$/);
});
