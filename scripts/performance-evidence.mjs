#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_SCHEMA_VERSION = 'tixkit-performance-sample-v1';
const EVIDENCE_SCHEMA_VERSION = 'tixkit-performance-evidence-v1';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireJsonValue(value, label) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite numbers`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => requireJsonValue(entry, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      requireJsonValue(entry, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} must be JSON-compatible`);
}

function requireFiniteMetrics(value, label = 'metrics') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error(`${label} must not be empty`);
  for (const [metric, number] of entries) {
    if (!metric || typeof number !== 'number' || !Number.isFinite(number)) {
      throw new Error(`${label}.${metric || '<empty>'} must be a finite number`);
    }
  }
  return Object.fromEntries(entries);
}

function parseWorkload(value) {
  const workload = JSON.parse(value);
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) {
    throw new Error('workload must be a JSON object');
  }
  requireJsonValue(workload, 'workload');
  return canonicalize(workload);
}

function validateIdentity(identity, label = 'identity') {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(identity, ['gitSha', 'runnerLabel', 'database', 'workload'], label);
  assertExactKeys(identity.database, ['engine', 'version'], `${label}.database`);
  const gitSha = requireString(identity.gitSha, `${label}.gitSha`);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new Error(`${label}.gitSha must be a 40- or 64-character lowercase Git SHA`);
  }
  const workload = identity.workload;
  if (!workload || typeof workload !== 'object' || Array.isArray(workload)) {
    throw new Error(`${label}.workload must be an object`);
  }
  requireJsonValue(workload, `${label}.workload`);
  return canonicalize({
    gitSha,
    runnerLabel: requireString(identity.runnerLabel, `${label}.runnerLabel`),
    database: {
      engine: requireString(identity.database?.engine, `${label}.database.engine`),
      version: requireString(identity.database?.version, `${label}.database.version`),
    },
    workload,
  });
}

function identityFromOptions(options) {
  return {
    gitSha: requireString(options.gitSha, 'git SHA'),
    runnerLabel: requireString(options.runnerLabel, 'runner label'),
    database: {
      engine: requireString(options.dbEngine, 'database engine'),
      version: requireString(options.dbVersion, 'database version'),
    },
    workload: parseWorkload(requireString(options.workload, 'workload')),
  };
}

function budgetMap(config) {
  if (!Array.isArray(config?.metrics) || config.metrics.length === 0) {
    throw new Error('budget config must contain metrics');
  }
  const result = new Map();
  for (const budget of config.metrics) {
    requireString(budget.metric, 'budget metric');
    if (result.has(budget.metric)) throw new Error(`duplicate budget metric ${budget.metric}`);
    if (
      (typeof budget.max !== 'number' || !Number.isFinite(budget.max)) &&
      (typeof budget.min !== 'number' || !Number.isFinite(budget.min))
    ) {
      throw new Error(`budget ${budget.metric} must define a finite min or max`);
    }
    result.set(budget.metric, budget);
  }
  return result;
}

function assertMetricSet(metrics, budgets, label) {
  const actual = Object.keys(metrics).sort();
  const expected = [...budgets.keys()].sort();
  const missing = expected.filter((metric) => !actual.includes(metric));
  const extra = actual.filter((metric) => !expected.includes(metric));
  if (missing.length || extra.length) {
    throw new Error(
      `${label} metric set mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
    );
  }
}

export function createPerformanceSample({ metrics, identity, budgets, sourceBytes }) {
  const normalizedMetrics = requireFiniteMetrics(metrics);
  assertMetricSet(normalizedMetrics, budgets, 'sample');
  const payload = {
    schemaVersion: SAMPLE_SCHEMA_VERSION,
    identity: validateIdentity(identity),
    sourceMetricsSha256: sha256(sourceBytes),
    metrics: normalizedMetrics,
  };
  return { ...payload, payloadSha256: sha256(canonicalJson(payload)) };
}

function validateSample(sample, budgets, label) {
  assertExactKeys(
    sample,
    ['schemaVersion', 'identity', 'sourceMetricsSha256', 'metrics', 'payloadSha256'],
    label,
  );
  if (sample?.schemaVersion !== SAMPLE_SCHEMA_VERSION) {
    throw new Error(`${label} has unsupported schemaVersion`);
  }
  const metrics = requireFiniteMetrics(sample.metrics, `${label}.metrics`);
  assertMetricSet(metrics, budgets, label);
  requireSha256(sample.sourceMetricsSha256, `${label}.sourceMetricsSha256`);
  requireSha256(sample.payloadSha256, `${label}.payloadSha256`);
  const identity = validateIdentity(sample.identity, `${label}.identity`);
  const { payloadSha256, ...payload } = sample;
  const expected = sha256(canonicalJson(payload));
  if (payloadSha256 !== expected) throw new Error(`${label} payload checksum mismatch`);
  return { ...sample, identity, metrics };
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function assertWithinBudget(metric, value, budget, label) {
  if (typeof budget.max === 'number' && value > budget.max) {
    throw new Error(`${label} ${metric}=${value} breaches max budget ${budget.max}`);
  }
  if (typeof budget.min === 'number' && value < budget.min) {
    throw new Error(`${label} ${metric}=${value} breaches min budget ${budget.min}`);
  }
}

function expectedBudget(budget) {
  return canonicalize({
    ...(typeof budget.min === 'number' ? { min: budget.min } : {}),
    ...(typeof budget.max === 'number' ? { max: budget.max } : {}),
  });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
    throw new Error(`${label} keys do not match the committed metric set`);
  }
}

function validateBaseline(baseline, identity, metricSet, budgets) {
  if (baseline?.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error('baseline has unsupported schemaVersion');
  }
  const { evidenceSha256, ...baselinePayload } = baseline;
  requireSha256(evidenceSha256, 'baseline.evidenceSha256');
  if (sha256(canonicalJson(baselinePayload)) !== evidenceSha256) {
    throw new Error('baseline evidence checksum mismatch');
  }
  assertExactKeys(
    baseline,
    [
      'schemaVersion',
      'identity',
      'sampleCount',
      'metricSet',
      'samples',
      'metrics',
      'evidenceSha256',
      ...(baseline.regression === undefined ? [] : ['regression']),
    ],
    'baseline evidence',
  );
  const baselineIdentity = validateIdentity(baseline.identity, 'baseline.identity');
  const { gitSha: _baselineGitSha, ...baselineEnvironment } = baselineIdentity;
  const { gitSha: _currentGitSha, ...currentEnvironment } = identity;
  if (canonicalJson(baselineEnvironment) !== canonicalJson(currentEnvironment)) {
    throw new Error('baseline identity mismatch');
  }
  if (canonicalJson(baseline.metricSet) !== canonicalJson(metricSet)) {
    throw new Error('baseline metric set mismatch');
  }

  if (!Number.isInteger(baseline.sampleCount) || baseline.sampleCount < 3) {
    throw new Error('baseline sampleCount must be an integer of at least 3');
  }
  if (!Array.isArray(baseline.samples) || baseline.samples.length !== baseline.sampleCount) {
    throw new Error('baseline sampleCount does not match samples length');
  }
  const sampleNames = new Set();
  for (const [index, sample] of baseline.samples.entries()) {
    const label = `baseline.samples[${index}]`;
    assertExactKeys(sample, ['name', 'payloadSha256', 'sourceMetricsSha256'], label);
    const name = requireString(sample?.name, `${label}.name`);
    if (sampleNames.has(name)) throw new Error('baseline sample names must be unique');
    sampleNames.add(name);
    requireSha256(sample.payloadSha256, `${label}.payloadSha256`);
    requireSha256(sample.sourceMetricsSha256, `${label}.sourceMetricsSha256`);
  }

  assertExactKeys(baseline.metrics, metricSet, 'baseline metrics');
  for (const metric of metricSet) {
    const metricEvidence = baseline.metrics[metric];
    const budget = budgets.get(metric);
    assertExactKeys(
      metricEvidence,
      ['unit', 'budget', 'samples', 'min', 'median', 'p95', 'max'],
      `baseline metric ${metric}`,
    );
    if (!Array.isArray(metricEvidence?.samples)) {
      throw new Error(`baseline metric ${metric} samples must be an array`);
    }
    if (metricEvidence.samples.length !== baseline.sampleCount) {
      throw new Error(`baseline metric ${metric} sample length does not match sampleCount`);
    }
    const values = metricEvidence.samples.map((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`baseline metric ${metric} sample ${index} must be finite`);
      }
      assertWithinBudget(metric, value, budget, `baseline sample ${index + 1}`);
      return value;
    });
    const expectedStatistics = statistics(values);
    for (const statistic of ['min', 'median', 'p95', 'max']) {
      if (metricEvidence[statistic] !== expectedStatistics[statistic]) {
        throw new Error(`baseline metric ${metric} ${statistic} is inconsistent with samples`);
      }
    }
    if (metricEvidence.unit !== (budget.unit ?? '')) {
      throw new Error(`baseline metric ${metric} unit does not match committed budget`);
    }
    if (canonicalJson(metricEvidence.budget) !== canonicalJson(expectedBudget(budget))) {
      throw new Error(`baseline metric ${metric} budget does not match committed budget`);
    }
  }

  for (const [index, sample] of baseline.samples.entries()) {
    const metrics = Object.fromEntries(
      metricSet.map((metric) => [metric, baseline.metrics[metric].samples[index]]),
    );
    const payload = {
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      identity: baselineIdentity,
      sourceMetricsSha256: sample.sourceMetricsSha256,
      metrics,
    };
    if (sha256(canonicalJson(payload)) !== sample.payloadSha256) {
      throw new Error(
        `baseline.samples[${index}] payload checksum does not match aggregate metrics`,
      );
    }
  }

  if (baseline.regression !== undefined) {
    assertExactKeys(
      baseline.regression,
      ['baselineSha256', 'maxRegressionPercent', 'comparisons'],
      'baseline regression',
    );
    requireSha256(baseline.regression?.baselineSha256, 'baseline.regression.baselineSha256');
    if (
      typeof baseline.regression.maxRegressionPercent !== 'number' ||
      !Number.isFinite(baseline.regression.maxRegressionPercent) ||
      baseline.regression.maxRegressionPercent < 0
    ) {
      throw new Error('baseline regression threshold must be finite and non-negative');
    }
    assertExactKeys(baseline.regression.comparisons, metricSet, 'baseline regression comparisons');
    for (const metric of metricSet) {
      const comparison = baseline.regression.comparisons[metric];
      assertExactKeys(
        comparison,
        ['baselineMedian', 'currentMedian', 'percent'],
        `baseline regression comparison ${metric}`,
      );
      if (
        !Number.isFinite(comparison?.baselineMedian) ||
        !Number.isFinite(comparison?.currentMedian) ||
        !Number.isFinite(comparison?.percent)
      ) {
        throw new Error(`baseline regression comparison ${metric} must be finite`);
      }
      if (comparison.currentMedian !== baseline.metrics[metric].median) {
        throw new Error(`baseline regression comparison ${metric} current median is inconsistent`);
      }
      const expectedPercent = regressionPercent(
        comparison.baselineMedian,
        comparison.currentMedian,
        budgets.get(metric),
      );
      if (comparison.percent !== expectedPercent) {
        throw new Error(`baseline regression comparison ${metric} percent is inconsistent`);
      }
    }
  }
}

function regressionPercent(previous, current, budget) {
  return previous === 0
    ? current === 0
      ? 0
      : Number.POSITIVE_INFINITY
    : typeof budget.min === 'number' && typeof budget.max !== 'number'
      ? ((previous - current) / Math.abs(previous)) * 100
      : ((current - previous) / Math.abs(previous)) * 100;
}

export function aggregatePerformanceEvidence({
  samples,
  sampleNames,
  budgets,
  baseline,
  maxRegressionPercent,
}) {
  if (!Array.isArray(samples) || samples.length < 3) {
    throw new Error('at least 3 complete performance samples are required');
  }
  if (new Set(sampleNames).size !== sampleNames.length) {
    throw new Error('performance sample names must be unique');
  }
  if (baseline === undefined && maxRegressionPercent !== undefined) {
    throw new Error('a baseline is required when max regression percent is set');
  }
  if (baseline !== undefined && maxRegressionPercent === undefined) {
    throw new Error('max regression percent is required when a baseline is set');
  }
  if (
    maxRegressionPercent !== undefined &&
    (typeof maxRegressionPercent !== 'number' ||
      !Number.isFinite(maxRegressionPercent) ||
      maxRegressionPercent < 0)
  ) {
    throw new Error('max regression percent must be a finite non-negative number');
  }

  const validated = samples.map((sample, index) =>
    validateSample(sample, budgets, sampleNames[index] ?? `sample ${index + 1}`),
  );
  const identity = validated[0].identity;
  const identityJson = canonicalJson(identity);
  for (let index = 1; index < validated.length; index += 1) {
    if (canonicalJson(validated[index].identity) !== identityJson) {
      throw new Error(`${sampleNames[index] ?? `sample ${index + 1}`} identity mismatch`);
    }
  }

  const metricSet = [...budgets.keys()].sort();
  const metrics = {};
  for (const metric of metricSet) {
    const budget = budgets.get(metric);
    const values = validated.map((sample, index) => {
      const value = sample.metrics[metric];
      assertWithinBudget(metric, value, budget, sampleNames[index] ?? `sample ${index + 1}`);
      return value;
    });
    metrics[metric] = {
      unit: budget.unit ?? '',
      budget: expectedBudget(budget),
      ...statistics(values),
    };
  }

  let regression;
  if (baseline !== undefined) {
    validateBaseline(baseline, identity, metricSet, budgets);
    const comparisons = {};
    for (const metric of metricSet) {
      const previous = baseline.metrics[metric].median;
      const current = metrics[metric].median;
      const budget = budgets.get(metric);
      const percent = regressionPercent(previous, current, budget);
      if (!Number.isFinite(percent) || percent > maxRegressionPercent) {
        throw new Error(
          `aggregate median ${metric} regressed ${Number.isFinite(percent) ? percent.toFixed(2) : 'inf'}% beyond ${maxRegressionPercent}%`,
        );
      }
      comparisons[metric] = {
        baselineMedian: previous,
        currentMedian: current,
        percent,
      };
    }
    regression = {
      baselineSha256: sha256(canonicalJson(baseline)),
      maxRegressionPercent,
      comparisons,
    };
  }

  const payload = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    identity,
    sampleCount: validated.length,
    metricSet,
    samples: validated.map((sample, index) => ({
      name: sampleNames[index] ?? `sample-${index + 1}.json`,
      payloadSha256: sample.payloadSha256,
      sourceMetricsSha256: sample.sourceMetricsSha256,
    })),
    metrics,
    ...(regression ? { regression } : {}),
  };
  return { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
}

function optionMap(args) {
  const options = { sample: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`);
    const key = token.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    index += 1;
    if (key === 'sample') options.sample.push(value);
    else options[key] = value;
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const options = optionMap(args);
  const configPath = path.resolve(
    options.budgets ?? path.join(root, 'performance-budgets.integration.json'),
  );
  const budgets = budgetMap(readJson(configPath));
  const output = path.resolve(requireString(options.output, 'output'));

  if (command === 'sample') {
    const metricsPath = path.resolve(requireString(options.metrics, 'metrics'));
    const sourceBytes = readFileSync(metricsPath);
    const sample = createPerformanceSample({
      metrics: JSON.parse(sourceBytes.toString('utf8')),
      identity: identityFromOptions(options),
      budgets,
      sourceBytes,
    });
    writeFileSync(output, `${JSON.stringify(sample, null, 2)}\n`);
    return sample;
  }

  if (command === 'aggregate') {
    if (options.sample.length < 3) throw new Error('at least 3 --sample paths are required');
    const paths = options.sample.map((file) => path.resolve(file));
    const evidence = aggregatePerformanceEvidence({
      samples: paths.map(readJson),
      sampleNames: paths.map((file) => path.basename(file)),
      budgets,
      baseline: options.baseline ? readJson(path.resolve(options.baseline)) : undefined,
      maxRegressionPercent:
        options.maxRegressionPercent === undefined
          ? undefined
          : Number(options.maxRegressionPercent),
    });
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  }

  throw new Error('usage: performance-evidence.mjs <sample|aggregate> [options]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
