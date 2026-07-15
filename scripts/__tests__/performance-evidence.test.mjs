import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-evidence.schema.json' with { type: 'json' };
import {
  aggregatePerformanceEvidence,
  canonicalJson,
  createPerformanceSample,
  sha256,
} from '../performance-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const cli = resolve(root, 'scripts/performance-evidence.mjs');

const budgets = new Map([
  ['latencyMs', { metric: 'latencyMs', max: 100, unit: 'ms' }],
  ['throughput', { metric: 'throughput', min: 10, unit: 'requests/second' }],
]);
const identity = {
  gitSha: 'a'.repeat(40),
  runnerLabel: 'tixkit-epyc-trusted',
  database: { engine: 'postgresql', version: '16.4' },
  workload: { checkoutReservations: 40, concurrency: 8, scannerCheckIns: 100 },
};

function sample(latencyMs, throughput, overrides = {}) {
  const metrics = { latencyMs, throughput, ...overrides.metrics };
  const sourceBytes = Buffer.from(`${JSON.stringify(metrics)}\n`);
  return createPerformanceSample({
    metrics,
    identity: overrides.identity ?? identity,
    budgets,
    sourceBytes,
  });
}

function aggregate(samples, options = {}) {
  return aggregatePerformanceEvidence({
    samples,
    sampleNames: samples.map((_, index) => `sample-${index + 1}.json`),
    budgets,
    ...options,
  });
}

function rechecksumEvidence(evidence, mutate) {
  const forged = structuredClone(evidence);
  mutate(forged);
  const { evidenceSha256: _checksum, ...payload } = forged;
  return { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
}

function validators() {
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(schema);
  return {
    evidence: ajv.getSchema(schema.$id),
    sample: ajv.getSchema(`${schema.$id}#/$defs/sampleArtifact`),
  };
}

test('builds deterministic versioned evidence with complete statistics and checksums', () => {
  const samples = [sample(30, 15), sample(10, 30), sample(20, 20)];
  const first = aggregate(samples);
  const second = aggregate(samples);

  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.schemaVersion, 'tixkit-performance-evidence-v1');
  assert.equal(first.sampleCount, 3);
  assert.deepEqual(first.identity, identity);
  assert.deepEqual(first.metricSet, ['latencyMs', 'throughput']);
  assert.deepEqual(first.metrics.latencyMs, {
    unit: 'ms',
    budget: { max: 100 },
    samples: [30, 10, 20],
    min: 10,
    median: 20,
    p95: 30,
    max: 30,
  });
  assert.deepEqual(first.metrics.throughput, {
    unit: 'requests/second',
    budget: { min: 10 },
    samples: [15, 30, 20],
    min: 15,
    median: 20,
    p95: 30,
    max: 30,
  });
  assert.match(first.samples[0].payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(first.samples[0].sourceMetricsSha256, /^[a-f0-9]{64}$/);
  const { evidenceSha256, ...evidencePayload } = first;
  assert.equal(evidenceSha256, sha256(canonicalJson(evidencePayload)));

  const validate = validators().evidence;
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
});

test('rejects fewer than three complete samples', () => {
  assert.throws(() => aggregate([sample(10, 20), sample(11, 21)]), /at least 3 complete/);
});

test('rejects a missing or unexpected metric', () => {
  assert.throws(
    () =>
      createPerformanceSample({
        metrics: { latencyMs: 20 },
        identity,
        budgets,
        sourceBytes: Buffer.from('{}'),
      }),
    /metric set mismatch; missing: throughput/,
  );
  assert.throws(
    () =>
      createPerformanceSample({
        metrics: { latencyMs: 20, throughput: 20, surprise: 1 },
        identity,
        budgets,
        sourceBytes: Buffer.from('{}'),
      }),
    /extra: surprise/,
  );
});

test('rejects NaN and Infinity before evidence generation', () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () =>
        createPerformanceSample({
          metrics: { latencyMs: invalid, throughput: 20 },
          identity,
          budgets,
          sourceBytes: Buffer.from('{}'),
        }),
      /must be a finite number/,
    );
  }
});

test('rejects sample identity mismatch', () => {
  const mismatched = sample(12, 22, {
    identity: { ...identity, database: { engine: 'mysql', version: '8.4.0' } },
  });
  assert.throws(
    () => aggregate([sample(10, 20), mismatched, sample(14, 24)]),
    /sample-2.json identity mismatch/,
  );
});

test('rejects a tampered sample checksum', () => {
  const tampered = {
    ...sample(12, 22),
    metrics: { latencyMs: 99, throughput: 22 },
  };
  assert.throws(
    () => aggregate([sample(10, 20), tampered, sample(14, 24)]),
    /payload checksum mismatch/,
  );
});

test('fails when any individual sample breaches an absolute max or min budget', () => {
  assert.throws(
    () => aggregate([sample(10, 20), sample(101, 20), sample(12, 22)]),
    /sample-2.json latencyMs=101 breaches max budget 100/,
  );
  assert.throws(
    () => aggregate([sample(10, 20), sample(11, 9), sample(12, 22)]),
    /sample-2.json throughput=9 breaches min budget 10/,
  );
});

test('requires an explicit baseline when a regression threshold is requested', () => {
  assert.throws(
    () =>
      aggregate([sample(10, 20), sample(11, 21), sample(12, 22)], {
        maxRegressionPercent: 5,
      }),
    /baseline is required/,
  );
});

test('requires an explicit regression threshold when a baseline is provided', () => {
  const baseline = aggregate([sample(10, 20), sample(11, 21), sample(12, 22)]);
  assert.throws(
    () => aggregate([sample(10, 20), sample(11, 21), sample(12, 22)], { baseline }),
    /max regression percent is required when a baseline is set/,
  );
});

test('accepts a compatible baseline and records bounded median comparisons', () => {
  const baselineIdentity = { ...identity, gitSha: 'b'.repeat(40) };
  const baseline = aggregate([
    sample(10, 20, { identity: baselineIdentity }),
    sample(11, 21, { identity: baselineIdentity }),
    sample(12, 22, { identity: baselineIdentity }),
  ]);
  const current = aggregate([sample(10.4, 19.5), sample(11.4, 20.5), sample(12.4, 21.5)], {
    baseline,
    maxRegressionPercent: 5,
  });

  assert.equal(current.regression.maxRegressionPercent, 5);
  assert.equal(current.regression.baselineSha256, sha256(canonicalJson(baseline)));
  assert.ok(current.regression.comparisons.latencyMs.percent < 5);
  assert.ok(current.regression.comparisons.throughput.percent < 5);
  const validate = validators().evidence;
  assert.equal(validate(current), true, JSON.stringify(validate.errors));
});

test('rejects aggregate median regression beyond the committed threshold', () => {
  const baseline = aggregate([sample(10, 20), sample(11, 21), sample(12, 22)]);
  assert.throws(
    () =>
      aggregate([sample(15, 20), sample(16, 21), sample(17, 22)], {
        baseline,
        maxRegressionPercent: 10,
      }),
    /aggregate median latencyMs regressed 45.45% beyond 10%/,
  );
  assert.throws(
    () =>
      aggregate([sample(10, 15), sample(11, 16), sample(12, 17)], {
        baseline,
        maxRegressionPercent: 10,
      }),
    /aggregate median throughput regressed 23.81% beyond 10%/,
  );
});

test('rejects a baseline from another database identity or metric set', () => {
  const baseline = aggregate([sample(10, 20), sample(11, 21), sample(12, 22)]);
  const wrongIdentityPayload = {
    ...baseline,
    identity: { ...baseline.identity, runnerLabel: 'other-runner' },
  };
  const { evidenceSha256: _identityChecksum, ...wrongIdentityEvidence } = wrongIdentityPayload;
  const wrongIdentity = {
    ...wrongIdentityEvidence,
    evidenceSha256: sha256(canonicalJson(wrongIdentityEvidence)),
  };
  assert.throws(
    () =>
      aggregate([sample(10, 20), sample(11, 21), sample(12, 22)], {
        baseline: wrongIdentity,
        maxRegressionPercent: 5,
      }),
    /baseline identity mismatch/,
  );
  const wrongMetricsPayload = { ...baseline, metricSet: ['latencyMs'] };
  const { evidenceSha256: _metricChecksum, ...wrongMetricsEvidence } = wrongMetricsPayload;
  const wrongMetrics = {
    ...wrongMetricsEvidence,
    evidenceSha256: sha256(canonicalJson(wrongMetricsEvidence)),
  };
  assert.throws(
    () =>
      aggregate([sample(10, 20), sample(11, 21), sample(12, 22)], {
        baseline: wrongMetrics,
        maxRegressionPercent: 5,
      }),
    /baseline metric set mismatch/,
  );
});

test('rejects tampered baseline evidence before regression comparison', () => {
  const baseline = aggregate([sample(10, 20), sample(11, 21), sample(12, 22)]);
  baseline.metrics.latencyMs.median = 1;
  assert.throws(
    () =>
      aggregate([sample(10, 20), sample(11, 21), sample(12, 22)], {
        baseline,
        maxRegressionPercent: 5,
      }),
    /baseline evidence checksum mismatch/,
  );
});

test('rejects forged and rechecksummed baseline statistics and structure', () => {
  const baseline = aggregate([sample(10, 20), sample(11, 21), sample(12, 22)]);
  const currentSamples = [sample(10, 20), sample(11, 21), sample(12, 22)];
  const assertRejected = (forged, pattern) =>
    assert.throws(
      () =>
        aggregate(currentSamples, {
          baseline: forged,
          maxRegressionPercent: 5,
        }),
      pattern,
    );

  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.metrics.latencyMs.median = 1;
    }),
    /latencyMs median is inconsistent with samples/,
  );
  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.sampleCount = 4;
    }),
    /sampleCount does not match samples length/,
  );
  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.metrics.uncommittedMetric = structuredClone(forged.metrics.latencyMs);
    }),
    /baseline metrics keys do not match the committed metric set/,
  );
  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.metrics.latencyMs.samples.pop();
    }),
    /sample length does not match sampleCount/,
  );
  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.metrics.latencyMs.budget.max = 1_000;
    }),
    /budget does not match committed budget/,
  );
  assertRejected(
    rechecksumEvidence(baseline, (forged) => {
      forged.metrics.latencyMs.samples = [100, 100, 100];
      forged.metrics.latencyMs.min = 100;
      forged.metrics.latencyMs.median = 100;
      forged.metrics.latencyMs.p95 = 100;
      forged.metrics.latencyMs.max = 100;
    }),
    /payload checksum does not match aggregate metrics/,
  );
});

test('rejects sample fields that are not part of the sealed v1 payload', () => {
  const malformed = sample(10, 20);
  malformed.unsealedMetadata = 'runner-controlled';
  const { payloadSha256: _oldChecksum, ...payload } = malformed;
  malformed.payloadSha256 = sha256(canonicalJson(payload));

  assert.throws(
    () => aggregate([malformed, sample(11, 21), sample(12, 22)]),
    /keys do not match the committed metric set/,
  );
});

test('rejects malformed sample identity and duplicate per-run sample names', () => {
  const malformed = sample(10, 20);
  malformed.identity.gitSha = 'not-a-git-sha';
  const { payloadSha256: _oldChecksum, ...payload } = malformed;
  malformed.payloadSha256 = sha256(canonicalJson(payload));
  assert.throws(
    () => aggregate([malformed, sample(11, 21), sample(12, 22)]),
    /gitSha must be a 40- or 64-character lowercase Git SHA/,
  );

  const samples = [sample(10, 20), sample(11, 21), sample(12, 22)];
  assert.throws(
    () =>
      aggregatePerformanceEvidence({
        samples,
        sampleNames: ['sample.json', 'sample.json', 'sample-3.json'],
        budgets,
      }),
    /sample names must be unique/,
  );
});

test('CLI seals samples, aggregates both evidence variants, and rejects a baseline without threshold', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-performance-evidence-'));
  try {
    const config = join(directory, 'budgets.json');
    writeFileSync(config, `${JSON.stringify({ metrics: [...budgets.values()] })}\n`);
    const samplePaths = [];
    const { evidence: validateEvidence, sample: validateSample } = validators();
    for (let index = 0; index < 3; index += 1) {
      const metricsPath = join(directory, `metrics-${index + 1}.json`);
      const samplePath = join(directory, `sample-${index + 1}.json`);
      writeFileSync(
        metricsPath,
        `${JSON.stringify({ latencyMs: 10 + index, throughput: 20 + index })}\n`,
      );
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'sample',
          '--budgets',
          config,
          '--metrics',
          metricsPath,
          '--output',
          samplePath,
          '--git-sha',
          identity.gitSha,
          '--runner-label',
          identity.runnerLabel,
          '--db-engine',
          identity.database.engine,
          '--db-version',
          identity.database.version,
          '--workload',
          JSON.stringify(identity.workload),
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const sealedSample = JSON.parse(readFileSync(samplePath, 'utf8'));
      assert.equal(validateSample(sealedSample), true, JSON.stringify(validateSample.errors));
      samplePaths.push(samplePath);
    }

    const aggregatePath = join(directory, 'evidence.json');
    const aggregateArgs = [
      cli,
      'aggregate',
      '--budgets',
      config,
      ...samplePaths.flatMap((samplePath) => ['--sample', samplePath]),
      '--output',
      aggregatePath,
    ];
    const aggregateResult = spawnSync(process.execPath, aggregateArgs, {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(aggregateResult.status, 0, aggregateResult.stderr);
    const evidence = JSON.parse(readFileSync(aggregatePath, 'utf8'));
    assert.equal(validateEvidence(evidence), true, JSON.stringify(validateEvidence.errors));

    const missingThreshold = spawnSync(
      process.execPath,
      [...aggregateArgs, '--baseline', aggregatePath],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(missingThreshold.status, 1);
    assert.match(missingThreshold.stderr, /max regression percent is required/);

    const regressionPath = join(directory, 'regression-evidence.json');
    const regressionResult = spawnSync(
      process.execPath,
      [
        ...aggregateArgs.slice(0, -1),
        regressionPath,
        '--baseline',
        aggregatePath,
        '--max-regression-percent',
        '0',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(regressionResult.status, 0, regressionResult.stderr);
    const regressionEvidence = JSON.parse(readFileSync(regressionPath, 'utf8'));
    assert.equal(
      validateEvidence(regressionEvidence),
      true,
      JSON.stringify(validateEvidence.errors),
    );
    assert.equal(regressionEvidence.regression.maxRegressionPercent, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
