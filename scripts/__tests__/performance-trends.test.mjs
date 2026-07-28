import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createTrendEvidence,
  createTrendFailure,
  main,
  parseZipInfoTotal,
  renderTrendHtml,
  sanitizePublicError,
  validateAggregateEvidence,
  validateTrendConfig,
  validateTrendEvidence,
} from '../performance-trends.mjs';
import {
  aggregatePerformanceEvidence,
  canonicalJson,
  createPerformanceSample,
  sha256,
} from '../performance-evidence.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const config = JSON.parse(readFileSync(path.join(root, 'performance-trends.trusted.json'), 'utf8'));
const scenarioConfig = JSON.parse(
  readFileSync(path.join(root, 'performance-scenarios.nightly.json'), 'utf8'),
);
const budgetConfig = JSON.parse(
  readFileSync(path.join(root, 'performance-budgets.integration.json'), 'utf8'),
);
const scenario = scenarioConfig.scenarios[0];
const repository = 'tixkithq/tixkit';
const defaultBranch = 'main';
const temporaryDirectories = new Set();

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'tixkit-performance-trends-'));
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function budgets() {
  return new Map(budgetConfig.metrics.map((entry) => [entry.metric, entry]));
}

function metricValues(multiplier = 1) {
  return Object.fromEntries(
    budgetConfig.metrics.map((entry, index) => {
      const base = typeof entry.max === 'number' ? entry.max / 10 : entry.min * 2;
      return [entry.metric, Number((base * multiplier + index / 100).toFixed(2))];
    }),
  );
}

function aggregate(gitSha, multiplier = 1, collected = [], baseline) {
  const identity = {
    gitSha,
    runnerLabel: scenario.runnerLabel,
    database: scenario.database,
    profile: scenario.profile,
    workload: scenario.workload,
  };
  const samples = Array.from({ length: scenario.sampleCount }, () => {
    const metrics = metricValues(multiplier);
    const sourceBytes = Buffer.from(JSON.stringify(metrics));
    const sample = createPerformanceSample({ metrics, identity, budgets: budgets(), sourceBytes });
    collected.push({ metricsBytes: sourceBytes, sample });
    return sample;
  });
  return aggregatePerformanceEvidence({
    samples,
    sampleNames: samples.map((_sample, index) => `sample-${index + 1}.json`),
    budgets: budgets(),
    baseline,
    maxRegressionPercent: baseline ? scenario.maxRegressionPercent : undefined,
  });
}

function scenarioRun(evidence, day, baseline) {
  const startedAt = `2026-07-${String(day).padStart(2, '0')}T00:01:00.000Z`;
  const completedAt = `2026-07-${String(day).padStart(2, '0')}T00:31:00.000Z`;
  const payload = {
    schemaVersion: 'tixkit-performance-scenario-run-v1',
    status: 'passed',
    scenarioId: scenario.id,
    profile: scenario.profile,
    scenarioSha256: sha256(canonicalJson(scenario)),
    startedAt,
    completedAt,
    durationMilliseconds: 1_800_000,
    scheduledDurationMilliseconds: 1_800_000,
    sampleIntervalMilliseconds: 600_000,
    sampleCount: scenario.sampleCount,
    sampleStartedAt: [
      startedAt,
      `2026-07-${String(day).padStart(2, '0')}T00:11:00.000Z`,
      `2026-07-${String(day).padStart(2, '0')}T00:21:00.000Z`,
      completedAt,
    ],
    aggregateSha256: sha256(canonicalJson(evidence)),
    ...(baseline ? { baselineEvidenceSha256: baseline.evidenceSha256 } : {}),
  };
  return { ...payload, resultSha256: sha256(canonicalJson(payload)) };
}

function runFixture(directory, { runId, day, source, gitSha, multiplier = 1, baseline }) {
  const collected = [];
  const evidence = aggregate(gitSha, multiplier, collected, baseline);
  const run = scenarioRun(evidence, day, baseline);
  const evidenceFile = `${runId}-evidence.json`;
  const scenarioRunFile = `${runId}-scenario-run.json`;
  writeFileSync(path.join(directory, evidenceFile), `${JSON.stringify(evidence)}\n`);
  writeFileSync(path.join(directory, scenarioRunFile), `${JSON.stringify(run)}\n`);
  const baselineFile = baseline ? `${runId}-baseline.json` : undefined;
  if (baselineFile) writeFileSync(path.join(directory, baselineFile), JSON.stringify(baseline));
  const rawSamples = collected.map((raw, index) => {
    const metricsFile = `${runId}-metrics-${index + 1}.json`;
    const sampleFile = `${runId}-sample-${index + 1}.json`;
    writeFileSync(path.join(directory, metricsFile), raw.metricsBytes);
    writeFileSync(path.join(directory, sampleFile), JSON.stringify(raw.sample));
    return { name: `sample-${index + 1}.json`, metricsFile, sampleFile };
  });
  return {
    source,
    runId,
    runAttempt: 1,
    runUrl: `https://github.com/${repository}/actions/runs/${runId}`,
    workflowPath: config.workflowPath,
    event: 'schedule',
    headBranch: defaultBranch,
    headSha: gitSha,
    status: source === 'current' ? 'in_progress' : 'completed',
    conclusion: source === 'current' ? null : 'success',
    createdAt: `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: `2026-07-${String(day).padStart(2, '0')}T00:40:00.000Z`,
    artifactName: `${config.artifactPrefix}${scenario.id}`,
    evidenceFile,
    scenarioRunFile,
    ...(baselineFile ? { baselineFile } : {}),
    rawSamples,
  };
}

function buildTrend(directory, runs, generatedAt = '2026-07-16T01:00:00.000Z') {
  return createTrendEvidence({
    config,
    scenarioConfig,
    scenarioId: scenario.id,
    history: { schemaVersion: 'tixkit-performance-trend-history-v1', runs },
    inputRoot: directory,
    repository,
    defaultBranch,
    generatedAt,
  });
}

test('committed trend config is bounded and schema-valid', () => {
  assert.equal(validateTrendConfig(config), config);
  assert.equal(config.maximumRuns, 30);
  assert.equal(config.retentionDays, 90);
  assert.equal(config.maximumGapHours, 48);
});

test('one fully verified current run emits an explicit candidate with no trend', () => {
  const directory = temporaryDirectory();
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'a'.repeat(40),
  });
  const trend = buildTrend(directory, [current]);
  assert.equal(trend.status, 'candidate');
  assert.match(trend.candidateReason, /one verified revision/i);
  assert.equal(trend.window.runCount, 1);
  assert.ok(Object.values(trend.runs[0].metrics).every(({ status }) => status === 'candidate'));
  const payload = { ...trend };
  delete payload.trendSha256;
  assert.equal(trend.trendSha256, sha256(canonicalJson(payload)));
});

test('trend schema rejects every unknown or missing nested identity, window, run and metric field', () => {
  const directory = temporaryDirectory();
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'a'.repeat(40),
  });
  const trend = buildTrend(directory, [current]);
  for (const mutate of [
    (value) => (value.identity.unknown = true),
    (value) => delete value.identity.budgetSha256,
    (value) => (value.window.unknown = true),
    (value) => delete value.window.runCount,
    (value) => (value.runs[0].unknown = true),
    (value) => delete value.runs[0].scenarioRunSha256,
    (value) => (value.runs[0].metrics.checkoutReservationP50Ms.unknown = true),
    (value) => delete value.runs[0].metrics.checkoutReservationP50Ms.p95,
    (value) => (value.metricContracts.checkoutReservationP50Ms.unknown = true),
    (value) => delete value.metricContracts.checkoutReservationP50Ms.direction,
  ]) {
    const changed = structuredClone(trend);
    mutate(changed);
    const payload = { ...changed };
    delete payload.trendSha256;
    changed.trendSha256 = sha256(canonicalJson(payload));
    assert.throws(() => validateTrendEvidence(changed), /schema violation/);
  }
});

test('trend verification rejects recomputed-checksum semantic status, regression, statistic and window forgery', () => {
  const directory = temporaryDirectory();
  const prior = runFixture(directory, {
    runId: 100,
    day: 15,
    source: 'retained',
    gitSha: 'a'.repeat(40),
  });
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'b'.repeat(40),
    multiplier: 1.05,
  });
  const trend = buildTrend(directory, [prior, current]);
  for (const mutate of [
    (value) => (value.status = 'regressed'),
    (value) => (value.candidateReason = 'forged'),
    (value) => (value.runs[1].metrics.checkoutReservationP50Ms.status = 'candidate'),
    (value) => (value.runs[1].metrics.checkoutReservationP50Ms.regressionPercent = 0),
    (value) => (value.runs[1].metrics.checkoutReservationP50Ms.regressionUnbounded = true),
    (value) => (value.runs[1].metrics.checkoutReservationP50Ms.median += 1),
    (value) =>
      (value.runs[1].metrics.checkoutReservationP50Ms.p95 =
        value.runs[1].metrics.checkoutReservationP50Ms.median - 1),
    (value) => (value.window.runCount = 1),
    (value) => (value.window.firstRunAt = value.runs[1].createdAt),
    (value) => (value.runs[0].source = 'current'),
    (value) => (value.metricContracts.checkoutReservationP50Ms.direction = 'minimum'),
  ]) {
    const changed = structuredClone(trend);
    mutate(changed);
    const payload = { ...changed };
    delete payload.trendSha256;
    changed.trendSha256 = sha256(canonicalJson(payload));
    assert.throws(() => validateTrendEvidence(changed));
  }
});

test('two ordered compatible revisions emit median, p95, regression, status, URL and hashes', () => {
  const directory = temporaryDirectory();
  const prior = runFixture(directory, {
    runId: 100,
    day: 15,
    source: 'retained',
    gitSha: 'a'.repeat(40),
  });
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'b'.repeat(40),
    multiplier: 1.05,
  });
  const trend = buildTrend(directory, [current, prior]);
  assert.equal(trend.status, 'passing');
  assert.equal(trend.runs[1].metrics.checkoutReservationP50Ms.status, 'passing');
  assert.ok(trend.runs[1].metrics.checkoutReservationP50Ms.regressionPercent > 4.9);
  assert.equal(trend.runs[1].runUrl, current.runUrl);
  assert.equal(trend.identity.scenarioSha256, sha256(canonicalJson(scenario)));
  assert.equal(
    trend.identity.budgetSha256,
    sha256(readFileSync(path.join(root, scenario.budgets))),
  );
  const html = renderTrendHtml(trend);
  assert.match(html, /Performance trend/);
  assert.match(html, /checkoutReservationP50Ms/);
  assert.match(html, /actions\/runs\/101/);
});

test('relative regression beyond the scenario threshold is retained and fails closed', () => {
  const directory = temporaryDirectory();
  const prior = runFixture(directory, {
    runId: 100,
    day: 15,
    source: 'retained',
    gitSha: 'a'.repeat(40),
  });
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'b'.repeat(40),
    multiplier: 1.2,
  });
  const trend = buildTrend(directory, [prior, current]);
  assert.equal(trend.status, 'regressed');
  assert.ok(Object.values(trend.runs[1].metrics).some(({ status }) => status === 'regressed'));
});

test('aggregate validation rejects checksum, raw bytes, sealed sample, statistic, metric-set and budget tampering', () => {
  const collected = [];
  const evidence = aggregate('a'.repeat(40), 1, collected);
  const rawSamples = collected.map((raw, index) => ({
    name: `sample-${index + 1}.json`,
    ...raw,
  }));
  assert.equal(validateAggregateEvidence(evidence, budgets(), rawSamples), evidence);
  const checksumTampered = structuredClone(evidence);
  checksumTampered.evidenceSha256 = '0'.repeat(64);
  assert.throws(
    () => validateAggregateEvidence(checksumTampered, budgets(), rawSamples),
    /checksum mismatch/,
  );
  for (const mutate of [
    (value) => (value.samples[0].payloadSha256 = '0'.repeat(64)),
    (value) => (value.metrics.checkoutReservationP50Ms.median += 1),
    (value) => value.metricSet.pop(),
    (value) => (value.metrics.checkoutReservationP50Ms.budget.max += 1),
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    const payload = { ...changed };
    delete payload.evidenceSha256;
    changed.evidenceSha256 = sha256(canonicalJson(payload));
    assert.throws(() => validateAggregateEvidence(changed, budgets(), rawSamples));
  }
  const rawChanged = structuredClone(rawSamples);
  rawChanged[0].metricsBytes = Buffer.from('{"forged":true}');
  assert.throws(() => validateAggregateEvidence(evidence, budgets(), rawChanged));
  const sealedChanged = structuredClone(rawSamples);
  sealedChanged[0].sample.payloadSha256 = '0'.repeat(64);
  assert.throws(() => validateAggregateEvidence(evidence, budgets(), sealedChanged));
});

test('run and scenario binding reject config, budget, identity, checksum and timing drift', () => {
  const directory = temporaryDirectory();
  const entry = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'a'.repeat(40),
  });
  const cases = [
    (value) => (value.runUrl = 'https://evil.example/actions/runs/101'),
    (value) => (value.workflowPath = '.github/workflows/other.yml'),
    (value) => (value.headBranch = 'feature'),
    (value) => (value.artifactName = 'nightly-performance-other'),
    (value) => (value.headSha = 'b'.repeat(40)),
    (value) => (value.status = 'completed'),
  ];
  for (const mutate of cases) {
    const changed = structuredClone(entry);
    mutate(changed);
    assert.throws(() => buildTrend(directory, [changed]));
  }
  const runPath = path.join(directory, entry.scenarioRunFile);
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  run.scenarioSha256 = '0'.repeat(64);
  const payload = { ...run };
  delete payload.resultSha256;
  run.resultSha256 = sha256(canonicalJson(payload));
  writeFileSync(runPath, JSON.stringify(run));
  assert.throws(() => buildTrend(directory, [entry]), /committed scenario/);
});

test('scenario timing and optional baseline are rederived and fail closed', () => {
  const directory = temporaryDirectory();
  const baseline = aggregate('a'.repeat(40));
  const entry = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'b'.repeat(40),
    multiplier: 1.05,
    baseline,
  });
  assert.equal(buildTrend(directory, [entry]).status, 'candidate');
  const runPath = path.join(directory, entry.scenarioRunFile);
  const original = JSON.parse(readFileSync(runPath, 'utf8'));
  for (const mutate of [
    (value) => (value.sampleIntervalMilliseconds += 1),
    (value) => (value.scheduledDurationMilliseconds -= 1),
    (value) => (value.sampleStartedAt[1] = value.sampleStartedAt[0]),
    (value) => (value.durationMilliseconds -= 1),
    (value) => (value.baselineEvidenceSha256 = '0'.repeat(64)),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    const payload = { ...changed };
    delete payload.resultSha256;
    changed.resultSha256 = sha256(canonicalJson(payload));
    writeFileSync(runPath, JSON.stringify(changed));
    assert.throws(() => buildTrend(directory, [entry]));
  }
  writeFileSync(runPath, JSON.stringify(original));
  const baselinePath = path.join(directory, entry.baselineFile);
  const changedBaseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  changedBaseline.evidenceSha256 = '0'.repeat(64);
  writeFileSync(baselinePath, JSON.stringify(changedBaseline));
  assert.throws(() => buildTrend(directory, [entry]), /baseline/);
});

test('history rejects duplicates, ambiguous ordering, gaps, stale/future runs and missing latest current', () => {
  const directory = temporaryDirectory();
  const prior = runFixture(directory, {
    runId: 100,
    day: 15,
    source: 'retained',
    gitSha: 'a'.repeat(40),
  });
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'b'.repeat(40),
  });
  assert.throws(() => buildTrend(directory, [current, structuredClone(current)]), /duplicate/);
  const ambiguous = structuredClone(current);
  ambiguous.runId = 99;
  ambiguous.runUrl = `https://github.com/${repository}/actions/runs/99`;
  assert.throws(() => buildTrend(directory, [prior, ambiguous]), /ordering is ambiguous/);
  const gap = structuredClone(prior);
  gap.createdAt = '2026-07-12T00:00:00.000Z';
  gap.updatedAt = '2026-07-15T00:40:00.000Z';
  assert.throws(() => buildTrend(directory, [gap, current]), /gap exceeds/);
  assert.throws(() => buildTrend(directory, [current], '2026-07-15T23:00:00.000Z'), /future run/);
  assert.throws(
    () => buildTrend(directory, [current], '2026-10-16T01:00:00.000Z'),
    /retention window/,
  );
  assert.throws(() => buildTrend(directory, [prior]), /latest current/);
});

test('CLI creates JSON and HTML exclusively and writes bounded failure diagnostics', () => {
  const directory = temporaryDirectory();
  const current = runFixture(directory, {
    runId: 101,
    day: 16,
    source: 'current',
    gitSha: 'a'.repeat(40),
  });
  const historyPath = path.join(directory, 'history.json');
  writeFileSync(
    historyPath,
    JSON.stringify({ schemaVersion: 'tixkit-performance-trend-history-v1', runs: [current] }),
  );
  const output = path.join(directory, 'output');
  const result = main([
    '--config',
    path.join(root, 'performance-trends.trusted.json'),
    '--scenario',
    scenario.id,
    '--history',
    historyPath,
    '--output',
    output,
    '--failure-directory',
    directory,
    '--repository',
    repository,
    '--default-branch',
    defaultBranch,
    '--generated-at',
    '2026-07-16T01:00:00.000Z',
  ]);
  assert.equal(result.status, 'candidate');
  assert.equal(
    JSON.parse(readFileSync(path.join(output, 'trend.json'), 'utf8')).status,
    'candidate',
  );
  assert.match(
    readFileSync(path.join(output, 'index.html'), 'utf8'),
    /no trend can be calculated/i,
  );
  assert.throws(() =>
    main([
      '--config',
      path.join(root, 'performance-trends.trusted.json'),
      '--scenario',
      scenario.id,
      '--history',
      historyPath,
      '--output',
      output,
      '--failure-directory',
      directory,
      '--repository',
      repository,
      '--default-branch',
      defaultBranch,
      '--generated-at',
      '2026-07-16T01:00:00.000Z',
    ]),
  );
  const failure = JSON.parse(readFileSync(path.join(directory, 'trend-failure.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  const failurePayload = { ...failure };
  delete failurePayload.failureSha256;
  assert.equal(failure.failureSha256, sha256(canonicalJson(failurePayload)));
});

test('failure diagnostics redact credentials and remain checksum-bound', () => {
  const failure = createTrendFailure({
    phase: 'download',
    error:
      'Bearer bearer-secret Basic basic-secret https://user:password@example.test/path?token=query-secret&api_key=key-secret API_TOKEN=assignment-secret password: another-secret',
    failedAt: Date.parse('2026-07-16T00:00:00.000Z'),
  });
  assert.doesNotMatch(
    failure.error,
    /bearer-secret|basic-secret|user:password|query-secret|key-secret|assignment-secret|another-secret/,
  );
  const payload = { ...failure };
  delete payload.failureSha256;
  assert.equal(failure.failureSha256, sha256(canonicalJson(payload)));
});

test('public diagnostics redact standalone credentials and malformed assignments', () => {
  const secrets = [
    'sk_live_DO_NOT_EXPOSE_123456',
    'sk_test_DO_NOT_EXPOSE_123456',
    'ghp_DO_NOT_EXPOSE_1234567890',
    'api_key-DO_NOT_EXPOSE_123456',
    'malformed-json-secret',
  ];
  const diagnostic = sanitizePublicError(
    `provider failed ${secrets[0]} ${secrets[1]} ${secrets[2]} ${secrets[3]} {"apiToken":"${secrets[4]}`,
  );
  for (const secret of secrets) assert.doesNotMatch(diagnostic, new RegExp(secret, 'u'));
  assert.ok(diagnostic.length <= 500);

  const directory = temporaryDirectory();
  const history = path.join(directory, 'history.json');
  writeFileSync(history, `{"api_key":"${secrets[0]}`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/performance-trends.mjs'),
      '--config',
      path.join(root, 'performance-trends.trusted.json'),
      '--scenario',
      scenario.id,
      '--history',
      history,
      '--output',
      path.join(directory, 'output'),
      '--repository',
      repository,
      '--default-branch',
      defaultBranch,
      '--generated-at',
      '2026-07-16T01:00:00.000Z',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, new RegExp(secrets[0], 'u'));
  assert.ok(result.stderr.trim().length <= 500);
});

test('Info-ZIP total parser matches the summary emitted for a real archive', (context) => {
  const directory = temporaryDirectory();
  mkdirSync(path.join(directory, 'nested'));
  writeFileSync(path.join(directory, 'first.txt'), 'abc');
  writeFileSync(path.join(directory, 'nested/second.txt'), '12345');
  const archive = path.join(directory, 'fixture.zip');
  const zipped = spawnSync('zip', ['-q', archive, 'first.txt', 'nested/second.txt'], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (zipped.error?.code === 'ENOENT') return context.skip('Info-ZIP is unavailable');
  assert.equal(zipped.status, 0, zipped.stderr);
  const summary = spawnSync('zipinfo', ['-t', archive], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.equal(parseZipInfoTotal(summary.stdout), 8);
  const cli = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/performance-trends.mjs'), 'zipinfo-total'],
    {
      input: summary.stdout,
      encoding: 'utf8',
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, '8\n');
  assert.throws(() => parseZipInfoTotal(`${summary.stdout}${summary.stdout}`), /ambiguous/u);
});

test('nightly workflow owns bounded downloads, trend generation and unconditional evidence upload', () => {
  const workflow = readFileSync(
    path.join(root, '.github/workflows/performance-nightly.yml'),
    'utf8',
  );
  assert.match(workflow, /performance-trends\.trusted\.json/);
  assert.match(workflow, /scripts\/performance-trends\.mjs/);
  assert.match(workflow, /TREND_MAXIMUM_RUNS/);
  assert.match(workflow, /slice\(0,Number\(process\.env\.MAXIMUM_RUNS\)-1\)/);
  assert.match(workflow, /expired == false/);
  assert.doesNotMatch(workflow, /head -n 1/);
  assert.match(workflow, /size_in_bytes/);
  assert.match(workflow, /ulimit -f 102400/);
  assert.match(workflow, /entry_count/);
  assert.match(workflow, /uncompressed_size/);
  assert.match(workflow, /performance-trends\.mjs zipinfo-total/g);
  assert.match(workflow, /contains an unsafe entry/);
  assert.match(workflow, /scenario\/raw\/metrics-/);
  assert.match(workflow, /baseline-evidence\\.json/);
  assert.match(workflow, /performance-baseline-\*\.zip/);
  assert.match(workflow, /exceeds its declared or 50 MiB bound/);
  assert.match(workflow, /tixkit-performance-trend-history-v1/);
  assert.match(workflow, /--failure-directory/);
  assert.match(workflow, /trap cleanup_trend_history EXIT/);
  assert.match(workflow, /trap 'rm -rf "\$\{EVIDENCE_ROOT\}\/trend-input"' EXIT/);
  assert.match(workflow, /Remove transient historical inputs/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /retention-days: 90/);
});
