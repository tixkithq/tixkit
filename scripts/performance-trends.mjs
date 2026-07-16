#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import trendSchema from './performance-trends.schema.json' with { type: 'json' };
import {
  aggregatePerformanceEvidence,
  canonicalJson,
  createPerformanceSample,
  sha256,
} from './performance-evidence.mjs';
import { validateScenarioConfig } from './performance-scenario.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_VERSION = 'tixkit-performance-trends-config-v1';
const HISTORY_VERSION = 'tixkit-performance-trend-history-v1';
const TREND_VERSION = 'tixkit-performance-trend-v1';
const FAILURE_VERSION = 'tixkit-performance-trend-failure-v1';
const CLAIM_SCOPE = 'trusted-single-host-cross-revision-trend';
const SCENARIO_RUN_VERSION = 'tixkit-performance-scenario-run-v1';
const EVIDENCE_VERSION = 'tixkit-performance-evidence-v1';
const ajv = new Ajv2020({ strict: true, formats: { 'date-time': true, uri: true } });
ajv.addSchema(trendSchema);
const validateConfigSchema = ajv.compile({ $ref: trendSchema.$id });
const validateHistorySchema = ajv.compile({ $ref: `${trendSchema.$id}#/$defs/history` });
const validateTrendSchema = ajv.compile({ $ref: `${trendSchema.$id}#/$defs/trend` });
const validateFailureSchema = ajv.compile({ $ref: `${trendSchema.$id}#/$defs/failure` });

function schemaViolation(validate, value, label) {
  if (validate(value)) return;
  const issue = validate.errors?.[0];
  throw new Error(
    `${label} schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid value'}`,
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${label} fields are not exact`);
  }
}

function validDate(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

function budgetMap(config) {
  if (!Array.isArray(config?.metrics) || config.metrics.length === 0) {
    throw new Error('budget config must contain metrics');
  }
  const budgets = new Map();
  for (const item of config.metrics) {
    const metric = item?.metric;
    if (typeof metric !== 'string' || metric === '' || budgets.has(metric)) {
      throw new Error(`invalid or duplicate budget metric ${metric ?? '<missing>'}`);
    }
    if (
      (typeof item.max !== 'number' || !Number.isFinite(item.max)) &&
      (typeof item.min !== 'number' || !Number.isFinite(item.min))
    ) {
      throw new Error(`budget ${metric} must define a finite min or max`);
    }
    budgets.set(metric, item);
  }
  return budgets;
}

export function validateAggregateEvidence(
  evidence,
  budgets,
  rawSamples,
  baseline,
  maxRegressionPercent,
) {
  if (evidence?.schemaVersion !== EVIDENCE_VERSION) {
    throw new Error('aggregate evidence schema version is unsupported');
  }
  const { evidenceSha256, ...payload } = evidence;
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256 ?? '')) {
    throw new Error('aggregate evidence checksum is invalid');
  }
  if (sha256(canonicalJson(payload)) !== evidenceSha256) {
    throw new Error('aggregate evidence checksum mismatch');
  }
  if (!Array.isArray(rawSamples) || rawSamples.length !== evidence.sampleCount) {
    throw new Error('aggregate evidence requires every raw metric and sealed sample');
  }
  const samples = rawSamples.map((raw, index) => {
    if (raw.name !== evidence.samples[index]?.name) throw new Error('raw sample ordering drifted');
    const expected = createPerformanceSample({
      metrics: JSON.parse(raw.metricsBytes.toString('utf8')),
      identity: evidence.identity,
      budgets,
      sourceBytes: raw.metricsBytes,
    });
    if (canonicalJson(expected) !== canonicalJson(raw.sample)) {
      throw new Error(`sealed sample ${raw.name} does not match its raw metric bytes`);
    }
    return raw.sample;
  });
  const rebuilt = aggregatePerformanceEvidence({
    samples,
    sampleNames: rawSamples.map(({ name }) => name),
    budgets,
    baseline,
    maxRegressionPercent: baseline === undefined ? undefined : maxRegressionPercent,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(evidence)) {
    throw new Error(
      'aggregate evidence does not match raw samples, identity, budgets, or baseline',
    );
  }
  return evidence;
}

function validateScenarioRun(run, evidence, scenario) {
  exactKeys(
    run,
    [
      'schemaVersion',
      'status',
      'scenarioId',
      'profile',
      'scenarioSha256',
      'startedAt',
      'completedAt',
      'durationMilliseconds',
      'scheduledDurationMilliseconds',
      'sampleIntervalMilliseconds',
      'sampleCount',
      'sampleStartedAt',
      'aggregateSha256',
      ...(run.baselineEvidenceSha256 === undefined ? [] : ['baselineEvidenceSha256']),
      'resultSha256',
    ],
    'scenario run',
  );
  if (run.schemaVersion !== SCENARIO_RUN_VERSION || run.status !== 'passed') {
    throw new Error('scenario run is not a passing v1 artifact');
  }
  const { resultSha256, ...payload } = run;
  if (sha256(canonicalJson(payload)) !== resultSha256) {
    throw new Error('scenario run checksum mismatch');
  }
  if (
    run.scenarioId !== scenario.id ||
    run.profile !== scenario.profile ||
    run.scenarioSha256 !== sha256(canonicalJson(scenario))
  ) {
    throw new Error('scenario run does not match the committed scenario');
  }
  if (run.aggregateSha256 !== sha256(canonicalJson(evidence))) {
    throw new Error('scenario run aggregate checksum mismatch');
  }
  if (run.sampleCount !== evidence.sampleCount) {
    throw new Error('scenario run sample count does not match aggregate evidence');
  }
  const startedAt = validDate(run.startedAt, 'scenario run startedAt');
  const completedAt = validDate(run.completedAt, 'scenario run completedAt');
  const expectedDuration = scenario.durationSeconds * 1_000;
  const expectedInterval = scenario.sampleIntervalSeconds * 1_000;
  if (
    completedAt < startedAt ||
    completedAt - startedAt !== run.durationMilliseconds ||
    run.durationMilliseconds < expectedDuration ||
    run.scheduledDurationMilliseconds !== expectedDuration ||
    run.sampleIntervalMilliseconds !== expectedInterval ||
    run.sampleCount !== scenario.sampleCount ||
    run.sampleStartedAt.length !== scenario.sampleCount
  ) {
    throw new Error('scenario run duration is inconsistent');
  }
  let previousSampleAt = -1;
  run.sampleStartedAt.forEach((timestamp, index) => {
    const sampleAt = validDate(timestamp, `scenario run sampleStartedAt[${index}]`);
    if (
      sampleAt < startedAt + index * expectedInterval ||
      sampleAt > completedAt ||
      sampleAt <= previousSampleAt
    ) {
      throw new Error('scenario run sample timing is inconsistent');
    }
    previousSampleAt = sampleAt;
  });
  return { startedAt, completedAt };
}

function safeInputFile(inputRoot, name, label) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name)) {
    throw new Error(`${label} has an unsafe file name`);
  }
  const file = path.join(inputRoot, name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return file;
}

function directionalRegression(previous, current, budget) {
  if (previous === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return typeof budget.min === 'number' && typeof budget.max !== 'number'
    ? ((previous - current) / Math.abs(previous)) * 100
    : ((current - previous) / Math.abs(previous)) * 100;
}

function validateRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? '')) {
    throw new Error('repository must be an owner/name pair');
  }
  return value;
}

function validateRunMetadata(entry, context) {
  const expectedUrl = `https://github.com/${context.repository}/actions/runs/${entry.runId}`;
  if (entry.runUrl !== expectedUrl) throw new Error(`run ${entry.runId} has an untrusted URL`);
  if (
    entry.workflowPath !== context.config.workflowPath ||
    entry.headBranch !== context.defaultBranch ||
    entry.artifactName !== `${context.config.artifactPrefix}${context.scenario.id}`
  ) {
    throw new Error(`run ${entry.runId} workflow, branch, or artifact identity drifted`);
  }
  if (entry.source === 'retained') {
    if (entry.status !== 'completed' || entry.conclusion !== 'success') {
      throw new Error(`retained run ${entry.runId} is not successful`);
    }
  } else if (entry.status !== 'in_progress' || entry.conclusion !== null) {
    throw new Error(`current run ${entry.runId} must still be in progress`);
  }
  const createdAt = validDate(entry.createdAt, `run ${entry.runId} createdAt`);
  const updatedAt = validDate(entry.updatedAt, `run ${entry.runId} updatedAt`);
  if (updatedAt < createdAt) throw new Error(`run ${entry.runId} timestamps are inconsistent`);
  return { createdAt, updatedAt };
}

export function validateTrendConfig(config) {
  schemaViolation(validateConfigSchema, config, 'trend config');
  if (config.schemaVersion !== CONFIG_VERSION || config.claimScope !== CLAIM_SCOPE) {
    throw new Error('trend config version or claim scope is unsupported');
  }
  return config;
}

export function validateTrendEvidence(trend) {
  schemaViolation(validateTrendSchema, trend, 'trend evidence');
  const { trendSha256, ...payload } = trend;
  if (sha256(canonicalJson(payload)) !== trendSha256) {
    throw new Error('trend evidence checksum mismatch');
  }
  if (trend.window.runCount !== trend.runs.length) {
    throw new Error('trend window runCount does not match runs');
  }
  if (
    trend.window.firstRunAt !== trend.runs[0]?.createdAt ||
    trend.window.lastRunAt !== trend.runs.at(-1)?.createdAt
  ) {
    throw new Error('trend window boundaries do not match runs');
  }
  if (
    canonicalJson([...trend.metricSet].sort()) !== canonicalJson(trend.metricSet) ||
    new Set(trend.metricSet).size !== trend.metricSet.length ||
    canonicalJson(Object.keys(trend.metricContracts).sort()) !== canonicalJson(trend.metricSet)
  ) {
    throw new Error('trend metric contract set drifted');
  }
  for (const [metric, contract] of Object.entries(trend.metricContracts)) {
    const valid =
      contract.direction === 'minimum'
        ? typeof contract.min === 'number' && Number.isFinite(contract.min) && contract.max === null
        : typeof contract.max === 'number' && Number.isFinite(contract.max);
    if (!valid) throw new Error(`trend metric contract ${metric} is inconsistent`);
  }
  if (trend.runs.filter(({ source }) => source === 'current').length !== 1) {
    throw new Error('trend must contain exactly one current run');
  }
  const generatedAt = validDate(trend.window.generatedAt, 'trend window generatedAt');
  const maximumGap = trend.window.maximumGapHours * 60 * 60 * 1_000;
  const retention = trend.window.retentionDays * 24 * 60 * 60 * 1_000;
  let derivedRegressed = false;
  for (const [index, run] of trend.runs.entries()) {
    if (canonicalJson(Object.keys(run.metrics).sort()) !== canonicalJson(trend.metricSet)) {
      throw new Error(`trend run ${index + 1} metric set drifted`);
    }
    const createdAt = validDate(run.createdAt, `trend run ${index + 1} createdAt`);
    if (createdAt > generatedAt || generatedAt - createdAt > retention) {
      throw new Error(`trend run ${index + 1} falls outside the retained window`);
    }
    const previous = trend.runs[index - 1];
    if (index === 0) {
      if (run.source !== (trend.runs.length === 1 ? 'current' : 'retained')) {
        throw new Error('trend first run source is inconsistent');
      }
    } else {
      const previousAt = validDate(previous.createdAt, `trend run ${index} createdAt`);
      if (
        run.runId <= previous.runId ||
        createdAt <= previousAt ||
        createdAt - previousAt > maximumGap
      ) {
        throw new Error('trend run ordering or gap is inconsistent');
      }
    }
    if (index === trend.runs.length - 1 && run.source !== 'current') {
      throw new Error('trend latest run must be current');
    }
    for (const metric of trend.metricSet) {
      const value = run.metrics[metric];
      if (
        !Number.isFinite(value.median) ||
        !Number.isFinite(value.p95) ||
        value.p95 < value.median
      ) {
        throw new Error(`trend run ${index + 1} metric ${metric} statistics are inconsistent`);
      }
      const expectedPercent = previous
        ? directionalRegression(
            previous.metrics[metric].median,
            value.median,
            trend.metricContracts[metric],
          )
        : null;
      const expectedUnbounded = expectedPercent !== null && !Number.isFinite(expectedPercent);
      const expectedStoredPercent = expectedUnbounded ? null : expectedPercent;
      const expectedStatus =
        expectedPercent === null
          ? 'candidate'
          : expectedUnbounded || expectedPercent > trend.identity.maxRegressionPercent
            ? 'regressed'
            : 'passing';
      if (
        value.regressionPercent !== expectedStoredPercent ||
        value.regressionUnbounded !== expectedUnbounded ||
        value.status !== expectedStatus
      ) {
        throw new Error(`trend run ${index + 1} metric ${metric} semantics are inconsistent`);
      }
      if (expectedStatus === 'regressed') derivedRegressed = true;
    }
  }
  const expectedStatus =
    trend.runs.length === 1 ? 'candidate' : derivedRegressed ? 'regressed' : 'passing';
  const expectedReason =
    expectedStatus === 'candidate'
      ? 'Only one verified revision exists; no trend can be calculated.'
      : null;
  if (trend.status !== expectedStatus || trend.candidateReason !== expectedReason) {
    throw new Error('trend overall status or candidate reason is inconsistent');
  }
  return trend;
}

export function createTrendEvidence({
  config,
  scenarioConfig,
  scenarioId,
  history,
  inputRoot,
  repository,
  defaultBranch,
  generatedAt,
}) {
  validateTrendConfig(config);
  validateScenarioConfig(scenarioConfig);
  schemaViolation(validateHistorySchema, history, 'trend history');
  if (history.schemaVersion !== HISTORY_VERSION)
    throw new Error('trend history version is invalid');
  repository = validateRepository(repository);
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new Error('default branch is required');
  }
  const generatedMilliseconds = validDate(generatedAt, 'generatedAt');
  if (history.runs.length > config.maximumRuns)
    throw new Error('trend history exceeds maximumRuns');
  const scenario = scenarioConfig.scenarios.find(({ id }) => id === scenarioId);
  if (!scenario) throw new Error(`unknown trend scenario ${scenarioId}`);
  if (config.scenarioConfig !== 'performance-scenarios.nightly.json') {
    throw new Error('trend config scenario authority drifted');
  }
  const budgetPath = path.resolve(root, scenario.budgets);
  const budgetBytes = readFileSync(budgetPath);
  const budgets = budgetMap(JSON.parse(budgetBytes.toString('utf8')));
  const seenRunIds = new Set();
  const seenUrls = new Set();
  const seenFiles = new Set();
  const normalized = history.runs.map((entry) => {
    if (seenRunIds.has(entry.runId) || seenUrls.has(entry.runUrl)) {
      throw new Error(`duplicate trend run ${entry.runId}`);
    }
    const referencedFiles = [
      entry.evidenceFile,
      entry.scenarioRunFile,
      ...(entry.baselineFile ? [entry.baselineFile] : []),
      ...entry.rawSamples.flatMap(({ metricsFile, sampleFile }) => [metricsFile, sampleFile]),
    ];
    for (const file of referencedFiles) {
      if (seenFiles.has(file)) throw new Error(`duplicate trend input file ${file}`);
      seenFiles.add(file);
    }
    seenRunIds.add(entry.runId);
    seenUrls.add(entry.runUrl);
    const metadata = validateRunMetadata(entry, {
      repository,
      defaultBranch,
      config,
      scenario,
    });
    if (metadata.createdAt > generatedMilliseconds) {
      throw new Error(`run ${entry.runId} is a future run`);
    }
    const evidence = readJson(safeInputFile(inputRoot, entry.evidenceFile, 'aggregate evidence'));
    const scenarioRun = readJson(
      safeInputFile(inputRoot, entry.scenarioRunFile, 'scenario run evidence'),
    );
    const baseline = entry.baselineFile
      ? readJson(safeInputFile(inputRoot, entry.baselineFile, 'baseline evidence'))
      : undefined;
    if (scenarioRun.baselineEvidenceSha256 !== undefined) {
      if (!baseline || baseline.evidenceSha256 !== scenarioRun.baselineEvidenceSha256) {
        throw new Error(`run ${entry.runId} baseline evidence is missing or mismatched`);
      }
      if (evidence.regression?.baselineSha256 !== sha256(canonicalJson(baseline))) {
        throw new Error(`run ${entry.runId} regression baseline is mismatched`);
      }
    } else if (baseline !== undefined || evidence.regression !== undefined) {
      throw new Error(`run ${entry.runId} has undeclared baseline evidence`);
    }
    const rawSamples = entry.rawSamples.map(({ name, metricsFile, sampleFile }) => ({
      name,
      metricsBytes: readFileSync(safeInputFile(inputRoot, metricsFile, 'raw metrics')),
      sample: readJson(safeInputFile(inputRoot, sampleFile, 'sealed sample')),
    }));
    validateAggregateEvidence(
      evidence,
      budgets,
      rawSamples,
      baseline,
      scenario.maxRegressionPercent,
    );
    const scenarioTiming = validateScenarioRun(scenarioRun, evidence, scenario);
    if (entry.headSha !== evidence.identity?.gitSha) {
      throw new Error(`run ${entry.runId} Git SHA does not match aggregate evidence`);
    }
    if (
      evidence.identity?.profile !== scenario.profile ||
      evidence.identity?.runnerLabel !== scenario.runnerLabel ||
      canonicalJson(evidence.identity?.database) !== canonicalJson(scenario.database) ||
      canonicalJson(evidence.identity?.workload) !== canonicalJson(scenario.workload)
    ) {
      throw new Error(`run ${entry.runId} aggregate identity drifted from the scenario`);
    }
    if (
      scenarioTiming.startedAt < metadata.createdAt ||
      (entry.source === 'retained' && scenarioTiming.completedAt > metadata.updatedAt) ||
      (entry.source === 'current' && scenarioTiming.completedAt > generatedMilliseconds)
    ) {
      throw new Error(`run ${entry.runId} scenario timing falls outside its workflow run`);
    }
    return { entry, evidence, scenarioRun, ...metadata };
  });
  normalized.sort(
    (left, right) => left.createdAt - right.createdAt || left.entry.runId - right.entry.runId,
  );
  const currentRuns = normalized.filter(({ entry }) => entry.source === 'current');
  if (currentRuns.length !== 1 || normalized.at(-1)?.entry.source !== 'current') {
    throw new Error('trend history requires exactly one latest current run');
  }
  const retentionMilliseconds = config.retentionDays * 24 * 60 * 60 * 1_000;
  const maximumGapMilliseconds = config.maximumGapHours * 60 * 60 * 1_000;
  for (let index = 0; index < normalized.length; index += 1) {
    const run = normalized[index];
    if (generatedMilliseconds - run.createdAt > retentionMilliseconds) {
      throw new Error(`run ${run.entry.runId} exceeds the configured retention window`);
    }
    if (index > 0) {
      const previous = normalized[index - 1];
      if (run.createdAt === previous.createdAt || run.entry.runId <= previous.entry.runId) {
        throw new Error('trend revision ordering is ambiguous');
      }
      if (run.createdAt - previous.createdAt > maximumGapMilliseconds) {
        throw new Error(`trend history gap exceeds ${config.maximumGapHours} hours`);
      }
    }
  }
  const metricSet = [...budgets.keys()].sort();
  const metricContracts = Object.fromEntries(
    metricSet.map((metric) => {
      const budget = budgets.get(metric);
      return [
        metric,
        {
          unit: budget.unit ?? '',
          direction:
            typeof budget.min === 'number' && typeof budget.max !== 'number'
              ? 'minimum'
              : 'maximum',
          min: typeof budget.min === 'number' ? budget.min : null,
          max: typeof budget.max === 'number' ? budget.max : null,
        },
      ];
    }),
  );
  let regressed = false;
  const runs = normalized.map((item, index) => {
    const previous = normalized[index - 1];
    const metrics = Object.fromEntries(
      metricSet.map((metric) => {
        const currentMetric = item.evidence.metrics[metric];
        const regressionPercent = previous
          ? directionalRegression(
              previous.evidence.metrics[metric].median,
              currentMetric.median,
              metricContracts[metric],
            )
          : null;
        const regressionUnbounded =
          regressionPercent !== null && !Number.isFinite(regressionPercent);
        const status =
          regressionPercent === null
            ? 'candidate'
            : regressionUnbounded || regressionPercent > scenario.maxRegressionPercent
              ? 'regressed'
              : 'passing';
        if (status === 'regressed') regressed = true;
        return [
          metric,
          {
            median: currentMetric.median,
            p95: currentMetric.p95,
            regressionPercent: regressionUnbounded ? null : regressionPercent,
            regressionUnbounded,
            status,
          },
        ];
      }),
    );
    return {
      runId: item.entry.runId,
      runAttempt: item.entry.runAttempt,
      runUrl: item.entry.runUrl,
      source: item.entry.source,
      gitSha: item.entry.headSha,
      createdAt: item.entry.createdAt,
      completedAt: item.scenarioRun.completedAt,
      evidenceSha256: item.evidence.evidenceSha256,
      scenarioRunSha256: item.scenarioRun.resultSha256,
      metrics,
    };
  });
  const status = runs.length === 1 ? 'candidate' : regressed ? 'regressed' : 'passing';
  const payload = {
    schemaVersion: TREND_VERSION,
    claimScope: CLAIM_SCOPE,
    status,
    candidateReason:
      status === 'candidate'
        ? 'Only one verified revision exists; no trend can be calculated.'
        : null,
    identity: {
      repository,
      defaultBranch,
      workflowPath: config.workflowPath,
      artifactName: `${config.artifactPrefix}${scenario.id}`,
      scenarioId: scenario.id,
      profile: scenario.profile,
      runnerLabel: scenario.runnerLabel,
      database: scenario.database,
      workloadSha256: sha256(canonicalJson(scenario.workload)),
      scenarioConfigSha256: sha256(canonicalJson(scenarioConfig)),
      scenarioSha256: sha256(canonicalJson(scenario)),
      budgetSha256: sha256(budgetBytes),
      maxRegressionPercent: scenario.maxRegressionPercent,
    },
    window: {
      generatedAt,
      retentionDays: config.retentionDays,
      maximumRuns: config.maximumRuns,
      maximumGapHours: config.maximumGapHours,
      runCount: runs.length,
      firstRunAt: runs[0].createdAt,
      lastRunAt: runs.at(-1).createdAt,
    },
    metricSet,
    metricContracts,
    runs,
  };
  const trend = { ...payload, trendSha256: sha256(canonicalJson(payload)) };
  return validateTrendEvidence(trend);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderTrendHtml(trend) {
  const rows = trend.runs
    .flatMap((run) =>
      trend.metricSet.map((metric) => {
        const value = run.metrics[metric];
        const percent = value.regressionUnbounded
          ? 'unbounded'
          : value.regressionPercent === null
            ? 'candidate'
            : `${value.regressionPercent.toFixed(2)}%`;
        return `<tr><td><a href="${escapeHtml(run.runUrl)}">${run.runId}</a></td><td><code>${escapeHtml(run.gitSha.slice(0, 12))}</code></td><td>${escapeHtml(metric)}</td><td>${value.median}</td><td>${value.p95}</td><td>${escapeHtml(percent)}</td><td>${escapeHtml(value.status)}</td></tr>`;
      }),
    )
    .join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tixkit performance trend: ${escapeHtml(trend.identity.scenarioId)}</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:.45rem;text-align:left}code{font-family:ui-monospace,monospace}.candidate{color:#555}</style></head><body><main><h1>Performance trend: ${escapeHtml(trend.identity.scenarioId)}</h1><p>Status: <strong>${escapeHtml(trend.status)}</strong></p>${trend.candidateReason ? `<p class="candidate">${escapeHtml(trend.candidateReason)}</p>` : ''}<p>Window: ${trend.window.runCount} run(s), at most ${trend.window.maximumRuns}, retained ${trend.window.retentionDays} days. Evidence checksum: <code>${trend.trendSha256}</code></p><table><thead><tr><th>Run</th><th>Git SHA</th><th>Metric</th><th>Median</th><th>p95</th><th>Regression</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>\n`;
}

export function createTrendFailure({ phase, error, failedAt }) {
  const sanitize = sanitizePublicError;
  const payload = {
    schemaVersion: FAILURE_VERSION,
    status: 'failed',
    phase: sanitize(phase || 'trend-generation', 64),
    failedAt: new Date(failedAt).toISOString(),
    error: sanitize(error instanceof Error ? error.message : error, 500) || 'unknown failure',
  };
  const failure = { ...payload, failureSha256: sha256(canonicalJson(payload)) };
  schemaViolation(validateFailureSchema, failure, 'trend failure');
  return failure;
}

export function sanitizePublicError(value, maximum = 500) {
  const boundedMaximum = Number.isInteger(maximum) && maximum > 0 ? Math.min(maximum, 2_000) : 500;
  return String(value)
    .replaceAll(/\b(bearer|basic)\s+\S+/giu, '$1 [redacted]')
    .replaceAll(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replaceAll(
      /([?&](?:access_token|token|api[_-]?key|secret|signature)=)[^&#\s]+/giu,
      '$1[redacted]',
    )
    .replaceAll(/\b(?:sk|rk)_(?:live|test)_[a-z0-9_-]+\b/giu, '[redacted]')
    .replaceAll(/\bgh[pousr]_[a-z0-9_]{12,}\b/giu, '[redacted]')
    .replaceAll(/\bxox[baprs]-[a-z0-9-]+\b/giu, '[redacted]')
    .replaceAll(/\bAKIA[A-Z0-9]{16}\b/gu, '[redacted]')
    .replaceAll(
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret)[_-][a-z0-9][a-z0-9._~+/-]{7,}\b/giu,
      '[redacted]',
    )
    .replaceAll(
      /(["']?[a-z0-9_.-]*(?:token|secret|password|api[_-]?key|private[_-]?key)[a-z0-9_.-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\r\n])*"?|'{1}(?:\\.|[^'\r\n])*'?|[^\s,}\]]+)/giu,
      '$1[redacted]',
    )
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .slice(0, boundedMaximum);
}

export function parseZipInfoTotal(output) {
  const matches = [
    ...String(output).matchAll(/^\s*\d+ files?,\s*([0-9][0-9,]*) bytes? uncompressed,.*$/gmu),
  ];
  if (matches.length !== 1) throw new Error('ZIP summary is missing or ambiguous');
  const value = matches[0][1].replaceAll(',', '');
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('ZIP summary size is invalid');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) throw new Error('ZIP summary size exceeds the safe range');
  return bytes;
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option ${name || '<missing>'}`);
    }
    result[name.slice(2).replaceAll(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] =
      value;
  }
  return result;
}

function writeExclusive(file, bytes) {
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

export function main(argv = process.argv.slice(2)) {
  const input = options(argv);
  const outputDirectory = path.resolve(input.output || '');
  let completeOutput = false;
  try {
    const config = validateTrendConfig(readJson(path.resolve(input.config || '')));
    const scenarioConfigPath = path.resolve(root, config.scenarioConfig);
    const historyPath = path.resolve(input.history || '');
    const inputRoot = path.dirname(historyPath);
    const trend = createTrendEvidence({
      config,
      scenarioConfig: readJson(scenarioConfigPath),
      scenarioId: input.scenario,
      history: readJson(historyPath),
      inputRoot,
      repository: input.repository,
      defaultBranch: input.defaultBranch,
      generatedAt: input.generatedAt,
    });
    mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
    writeExclusive(path.join(outputDirectory, 'trend.json'), `${JSON.stringify(trend, null, 2)}\n`);
    writeExclusive(path.join(outputDirectory, 'index.html'), renderTrendHtml(trend));
    completeOutput = true;
    if (trend.status === 'regressed') throw new Error('cross-revision performance trend regressed');
    return trend;
  } catch (error) {
    if (!completeOutput) rmSync(outputDirectory, { recursive: true, force: true });
    if (input.failureDirectory) {
      try {
        writeExclusive(
          path.join(path.resolve(input.failureDirectory), 'trend-failure.json'),
          `${JSON.stringify(createTrendFailure({ phase: 'trend-generation', error, failedAt: Date.now() }), null, 2)}\n`,
        );
      } catch {
        // The workflow still has its independent bounded failure marker.
      }
    }
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv[2] === 'zipinfo-total' && process.argv.length === 3) {
      process.stdout.write(`${parseZipInfoTotal(readFileSync(0, 'utf8'))}\n`);
    } else {
      main();
    }
  } catch (error) {
    process.stderr.write(
      `${sanitizePublicError(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 1;
  }
}
