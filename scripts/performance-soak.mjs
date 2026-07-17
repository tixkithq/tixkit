#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-soak.schema.json' with { type: 'json' };
import {
  assertExpectedRunnerFingerprint,
  probeRunnerFingerprint,
} from './performance-capacity.mjs';
import { canonicalJson, sha256 } from './performance-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_VERSION = 'tixkit-performance-soak-config-v1';
const EVIDENCE_VERSION = 'tixkit-performance-soak-evidence-v2';
const CLAIM_SCOPE = 'trusted-single-host-continuous-integration-soak';
const COMMAND =
  'cd packages/api && bun vitest run src/__tests__/integration/inventory-concurrency.integration.test.ts src/__tests__/integration/load-harness.integration.test.ts --no-file-parallelism --maxWorkers=1 && cd ../.. && bun run --cwd packages/workflows test:unit -- export-activity.test.ts';
const METRICS = [
  'checkoutReservationP50Ms',
  'checkoutReservationP95Ms',
  'checkoutReservationQueryCount',
  'checkoutReservationHeapDeltaBytes',
  'scannerCheckInP50Ms',
  'scannerCheckInP95Ms',
  'scannerCheckInQueryCount',
  'scannerCheckInHeapDeltaBytes',
  'exportStreamHeapDeltaBytes',
];
const DENIALS = [
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
];
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'RUNNER_TEMP',
];
const IMAGES = {
  postgresql:
    'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb',
  mysql: 'mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209',
};
const validateSchema = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(
  schema,
);

function schemaViolation(value, kind) {
  if (validateSchema(value)) return;
  const issue = validateSchema.errors?.[0];
  throw new Error(
    `${kind} schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid value'}`,
  );
}

function expectedEnvironment(engine) {
  return engine === 'mysql'
    ? { DB_INTEGRATION_DRIVER: 'mysql', PERFORMANCE_METRICS_PATH: '{metricsPath}' }
    : { PERFORMANCE_METRICS_PATH: '{metricsPath}' };
}

export function validateSoakConfig(config) {
  schemaViolation(config, 'soak config');
  if (config.schemaVersion !== CONFIG_VERSION || config.claimScope !== CLAIM_SCOPE) {
    throw new Error('soak config version or claim scope is unsupported');
  }
  if (config.profiles.length !== 2) throw new Error('soak config requires exactly two profiles');
  const ids = new Set();
  for (const profile of config.profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate soak profile ${profile.id}`);
    ids.add(profile.id);
    const prefix = profile.database.engine === 'mysql' ? 'mysql' : 'postgresql';
    if (profile.id !== `${prefix}-trusted-host-integration-soak`) {
      throw new Error(`${profile.id} database/profile mapping drifted`);
    }
    if (
      profile.durationSeconds !== 14_400 ||
      profile.minimumIterations !== 24 ||
      profile.maximumIterations !== 4_096 ||
      profile.maximumLaunchGapSeconds !== 5 ||
      profile.windowSize !== 6 ||
      profile.maximumAdverseMedianDriftPercent !== 15 ||
      profile.iterationTimeoutSeconds !== 540
    ) {
      throw new Error(`${profile.id} committed soak controls drifted`);
    }
    if (profile.database.image !== IMAGES[profile.database.engine]) {
      throw new Error(`${profile.id} database image drifted`);
    }
    if (canonicalJson(profile.metrics) !== canonicalJson(METRICS)) {
      throw new Error(`${profile.id} metric set or order drifted`);
    }
    if (
      profile.command.executable !== 'bash' ||
      canonicalJson(profile.command.args) !== canonicalJson(['-c', COMMAND]) ||
      canonicalJson(profile.command.env) !==
        canonicalJson(expectedEnvironment(profile.database.engine))
    ) {
      throw new Error(
        `${profile.id} must use the exact current integration command and environment`,
      );
    }
  }
  return config;
}

function validateBudget(config, profile, budgetBytes) {
  const budget = JSON.parse(Buffer.from(budgetBytes).toString('utf8'));
  const metrics = budget?.metrics;
  if (!Array.isArray(metrics) || metrics.length !== profile.metrics.length) {
    throw new Error('soak budget metric count drifted');
  }
  const names = metrics.map((entry) => entry?.metric);
  if (canonicalJson(names) !== canonicalJson(profile.metrics)) {
    throw new Error('soak metrics must exactly equal the authoritative budget file');
  }
  if (
    metrics.some(
      (entry) =>
        (entry.min !== undefined && !Number.isFinite(entry.min)) ||
        (entry.max !== undefined && !Number.isFinite(entry.max)) ||
        (entry.min === undefined && entry.max === undefined) ||
        (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max),
    )
  ) {
    throw new Error('soak budgets require a valid finite min, max, or range');
  }
  if (config.$schema !== './scripts/performance-soak.schema.json') {
    throw new Error('soak config schema authority drifted');
  }
  return new Map(metrics.map((entry) => [entry.metric, entry]));
}

function validateMetrics(value, expectedMetrics) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('soak metrics must be an object');
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expectedMetrics].sort())) {
    throw new Error('soak iteration metric set or order drifted');
  }
  for (const [metric, number] of Object.entries(value)) {
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
      throw new Error(`soak metric ${metric} must be finite and non-negative`);
    }
  }
  return Object.fromEntries(expectedMetrics.map((metric) => [metric, value[metric]]));
}

function validateIterationMetrics(rawBytes, profile, budgets, iterationNumber) {
  const metrics = validateMetrics(
    JSON.parse(Buffer.from(rawBytes).toString('utf8')),
    profile.metrics,
  );
  for (const [metric, value] of Object.entries(metrics)) {
    const budget = budgets.get(metric);
    if (
      (budget.min !== undefined && value < budget.min) ||
      (budget.max !== undefined && value > budget.max)
    ) {
      throw new Error(`soak iteration ${iterationNumber} exceeded the absolute ${metric} budget`);
    }
  }
  return metrics;
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function createSoakEvidence({
  config,
  profile,
  gitSha,
  budgetBytes,
  samples,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
}) {
  validateSoakConfig(config);
  const verifiedRunnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    runnerFingerprint,
  );
  const configured = config.profiles.find(({ id }) => id === profile?.id);
  if (!configured || canonicalJson(configured) !== canonicalJson(profile)) {
    throw new Error('soak profile must exactly match its config entry');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new Error('gitSha must be a lowercase 40- or 64-character Git SHA');
  }
  const budgets = validateBudget(config, profile, budgetBytes);
  if (
    !Array.isArray(samples) ||
    samples.length < profile.minimumIterations ||
    samples.length > profile.maximumIterations
  ) {
    throw new Error('soak iteration count is outside committed controls');
  }
  const origin = samples[0]?.launchedMonotonicMs;
  if (!Number.isFinite(origin)) throw new Error('first monotonic launch is required');
  let previousCompletion;
  const iterations = samples.map((sample, index) => {
    const launched = sample.launchedMonotonicMs;
    const completed = sample.completedMonotonicMs;
    const launchGapMs = index === 0 ? null : launched - previousCompletion;
    if (
      !Number.isFinite(launched) ||
      !Number.isFinite(completed) ||
      completed <= launched ||
      (launchGapMs !== null &&
        (launchGapMs < 0 || launchGapMs > profile.maximumLaunchGapSeconds * 1_000))
    ) {
      throw new Error(`soak iteration ${index + 1} monotonic ordering or launch gap failed`);
    }
    if (
      typeof sample.startedAt !== 'string' ||
      typeof sample.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(sample.startedAt)) ||
      !Number.isFinite(Date.parse(sample.completedAt))
    ) {
      throw new Error(`soak iteration ${index + 1} wall timestamps are invalid`);
    }
    const bytes = Buffer.from(sample.rawBytes);
    const metrics = validateIterationMetrics(bytes, profile, budgets, index + 1);
    const sealed = {
      number: index + 1,
      startedAt: sample.startedAt,
      completedAt: sample.completedAt,
      launchedAtOffsetMs: launched - origin,
      completedAtOffsetMs: completed - origin,
      durationMs: completed - launched,
      launchGapMs,
      rawSha256: sha256(bytes),
      metrics,
    };
    previousCompletion = completed;
    return { ...sealed, sealedSampleSha256: sha256(canonicalJson(sealed)) };
  });
  const actualDurationMs = iterations.at(-1).completedAtOffsetMs;
  if (actualDurationMs < profile.durationSeconds * 1_000) {
    throw new Error('soak completed before the required continuous duration');
  }
  const metricSummary = profile.metrics.map((metric) => {
    const values = iterations.map((iteration) => iteration.metrics[metric]);
    return {
      metric,
      min: Math.min(...values),
      median: median(values),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
    };
  });
  const first = iterations.slice(0, profile.windowSize);
  const last = iterations.slice(-profile.windowSize);
  const drift = profile.metrics.map((metric) => {
    const firstWindowMedian = median(first.map((iteration) => iteration.metrics[metric]));
    const lastWindowMedian = median(last.map((iteration) => iteration.metrics[metric]));
    if (firstWindowMedian === 0) {
      throw new Error(`${metric} zero baseline makes first-window drift ambiguous`);
    }
    const budget = budgets.get(metric);
    const risingDrift = Math.max(
      0,
      ((lastWindowMedian - firstWindowMedian) / firstWindowMedian) * 100,
    );
    const fallingDrift = Math.max(
      0,
      ((firstWindowMedian - lastWindowMedian) / firstWindowMedian) * 100,
    );
    const adverseMedianDriftPercent = Math.max(
      budget.max === undefined ? 0 : risingDrift,
      budget.min === undefined ? 0 : fallingDrift,
    );
    if (adverseMedianDriftPercent > profile.maximumAdverseMedianDriftPercent) {
      throw new Error(`${metric} adverse median drift exceeded the committed threshold`);
    }
    return {
      metric,
      firstWindowMedian,
      lastWindowMedian,
      adverseMedianDriftPercent,
      withinThreshold: true,
    };
  });
  const workload = {
    durationSeconds: profile.durationSeconds,
    minimumIterations: profile.minimumIterations,
    maximumIterations: profile.maximumIterations,
    maximumLaunchGapSeconds: profile.maximumLaunchGapSeconds,
    windowSize: profile.windowSize,
    maximumAdverseMedianDriftPercent: profile.maximumAdverseMedianDriftPercent,
    iterationTimeoutSeconds: profile.iterationTimeoutSeconds,
    workload: profile.workload,
    budgets: profile.budgets,
    metrics: profile.metrics,
    command: profile.command,
  };
  const gaps = iterations.slice(1).map(({ launchGapMs }) => launchGapMs);
  const payload = {
    schemaVersion: EVIDENCE_VERSION,
    status: 'passed',
    claimScope: CLAIM_SCOPE,
    denials: DENIALS,
    integrityModel: 'checksums-not-signatures',
    identity: {
      gitSha,
      runnerLabel: profile.runnerLabel,
      profile: profile.id,
      database: profile.database,
      workloadSha256: sha256(canonicalJson(workload)),
      configSha256: sha256(canonicalJson(config)),
      budgetSha256: sha256(Buffer.from(budgetBytes)),
      runnerFingerprint: verifiedRunnerFingerprint,
    },
    controls: {
      requiredDurationSeconds: profile.durationSeconds,
      actualDurationMs,
      minimumIterations: profile.minimumIterations,
      actualIterations: iterations.length,
      maximumIterations: profile.maximumIterations,
      maximumLaunchGapSeconds: profile.maximumLaunchGapSeconds,
      maximumObservedLaunchGapMs: gaps.length === 0 ? 0 : Math.max(...gaps),
      windowSize: profile.windowSize,
      maximumAdverseMedianDriftPercent: profile.maximumAdverseMedianDriftPercent,
      freshProcessPerIteration: true,
    },
    iterations,
    metricSummary,
    drift,
  };
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaViolation(evidence, 'soak evidence');
  return evidence;
}

export function validateSoakEvidence({
  config,
  evidence,
  budgetBytes,
  samples,
  expectedRunnerFingerprintSha256,
}) {
  schemaViolation(evidence, 'soak evidence');
  const profile = config?.profiles?.find(({ id }) => id === evidence.identity.profile);
  if (!profile) throw new Error('soak evidence profile is absent from config');
  const expected = createSoakEvidence({
    config,
    profile,
    gitSha: evidence.identity.gitSha,
    budgetBytes,
    samples,
    runnerFingerprint: evidence.identity.runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(evidence)) {
    throw new Error('soak evidence does not match config, budget, samples, ordering, or checksums');
  }
  return evidence;
}

export function validateSoakEvidenceDirectory({
  config,
  outputDirectory,
  budgetBytes,
  expectedRunnerFingerprintSha256,
}) {
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  const rawDirectory = path.join(outputDirectory, 'raw');
  const sealedDirectory = path.join(outputDirectory, 'sealed');
  for (const [target, kind, mode] of [
    [outputDirectory, 'directory', 0o700],
    [rawDirectory, 'directory', 0o700],
    [sealedDirectory, 'directory', 0o700],
    [evidencePath, 'file', 0o600],
  ]) {
    const stat = lstatSync(target);
    const expectedKind = kind === 'directory' ? stat.isDirectory() : stat.isFile();
    if (!expectedKind || stat.isSymbolicLink() || (stat.mode & 0o777) !== mode) {
      throw new Error(`retained soak ${kind} must be private, direct, and non-symlinked`);
    }
  }
  if (
    canonicalJson(readdirSync(outputDirectory).sort()) !==
    canonicalJson(['evidence.json', 'raw', 'sealed'])
  ) {
    throw new Error('retained soak output file set drifted');
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const expectedNames = evidence.iterations.map(
    ({ number }) => `iteration-${String(number).padStart(4, '0')}.json`,
  );
  if (
    canonicalJson(readdirSync(rawDirectory).sort()) !== canonicalJson(expectedNames) ||
    canonicalJson(readdirSync(sealedDirectory).sort()) !== canonicalJson(expectedNames)
  ) {
    throw new Error('retained soak raw or sealed file set drifted');
  }
  const samples = evidence.iterations.map((iteration, index) => {
    const name = expectedNames[index];
    const rawPath = path.join(rawDirectory, name);
    const sealedPath = path.join(sealedDirectory, name);
    for (const target of [rawPath, sealedPath]) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('retained soak evidence must be private regular files');
      }
    }
    const rawBytes = readFileSync(rawPath);
    const sealed = JSON.parse(readFileSync(sealedPath, 'utf8'));
    if (
      canonicalJson(sealed) !== canonicalJson(iteration) ||
      sealed.rawSha256 !== sha256(rawBytes)
    ) {
      throw new Error(`retained soak iteration ${iteration.number} was tampered`);
    }
    return {
      launchedMonotonicMs: iteration.launchedAtOffsetMs,
      completedMonotonicMs: iteration.completedAtOffsetMs,
      startedAt: iteration.startedAt,
      completedAt: iteration.completedAt,
      rawBytes,
    };
  });
  return validateSoakEvidence({
    config,
    evidence,
    budgetBytes,
    samples,
    expectedRunnerFingerprintSha256,
  });
}

function signalProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function processGroupAlive(pid) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export function soakChildEnvironment(profile, metricsPath, environment = process.env) {
  const inherited = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.filter((name) => environment[name] !== undefined).map((name) => [
      name,
      environment[name],
    ]),
  );
  const databaseVariable =
    profile.database.engine === 'mysql' ? 'DATABASE_URL_MYSQL' : 'DATABASE_URL';
  if (environment[databaseVariable] !== undefined) {
    inherited[databaseVariable] = environment[databaseVariable];
  }
  const declared = Object.fromEntries(
    Object.entries(profile.command.env).map(([name, value]) => [
      name,
      value.replaceAll('{metricsPath}', metricsPath),
    ]),
  );
  return { ...inherited, ...declared };
}

export function executeSoakIteration({
  profile,
  metricsPath,
  processGroupPath,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
  signal,
}) {
  assertExpectedRunnerFingerprint(expectedRunnerFingerprintSha256, runnerFingerprint);
  if (signal.aborted) return Promise.reject(new Error('performance soak interrupted'));
  return new Promise((resolve, reject) => {
    const child = spawn(profile.command.executable, profile.command.args, {
      cwd: root,
      detached: process.platform !== 'win32',
      env: soakChildEnvironment(profile, metricsPath),
      stdio: 'inherit',
    });
    let requestedError;
    let killTimer;
    let settleTimer;
    let settled = false;
    const clearProcessGroup = () => {
      try {
        unlinkSync(processGroupPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    };
    const finish = (error, { preserveProcessGroup = false } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal.removeEventListener('abort', abort);
      if (!preserveProcessGroup) {
        try {
          clearProcessGroup();
        } catch (cleanupError) {
          reject(cleanupError);
          return;
        }
      }
      if (error) reject(error);
      else {
        try {
          const stat = lstatSync(metricsPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('soak metrics are not a regular file');
          }
          chmodSync(metricsPath, 0o600);
          resolve(readFileSync(metricsPath));
        } catch (readError) {
          reject(
            new Error(
              `soak iteration completed without safe metrics: ${readError.code || readError.message}`,
            ),
          );
        }
      }
    };
    const terminate = (error) => {
      if (requestedError) return;
      requestedError = error;
      signalProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        signalProcessGroup(child, 'SIGKILL');
        settleTimer = setTimeout(() => {
          if (processGroupAlive(child.pid)) {
            finish(new Error('soak iteration left a surviving process-group descendant'), {
              preserveProcessGroup: true,
            });
            return;
          }
          finish(requestedError);
        }, 50);
      }, 2_000);
    };
    const abort = () => terminate(new Error('performance soak interrupted'));
    const timeoutTimer = setTimeout(
      () =>
        terminate(new Error(`soak iteration exceeded ${profile.iterationTimeoutSeconds}s timeout`)),
      profile.iterationTimeoutSeconds * 1_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    child.once('spawn', () => {
      try {
        writeFileSync(processGroupPath, `${child.pid}\n`, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        terminate(error);
      }
    });
    child.once('error', (error) => {
      if (child.pid) terminate(error);
      else finish(error);
    });
    child.once('exit', (code, childSignal) => {
      if (requestedError) return;
      signalProcessGroup(child, 'SIGTERM');
      if (code !== 0) {
        terminate(new Error(`soak iteration failed with ${childSignal || `exit ${code}`}`));
        return;
      }
      settleTimer = setTimeout(() => {
        if (processGroupAlive(child.pid)) signalProcessGroup(child, 'SIGKILL');
        settleTimer = setTimeout(() => {
          const alive = processGroupAlive(child.pid);
          finish(
            alive
              ? new Error('soak iteration left a surviving process-group descendant')
              : undefined,
            {
              preserveProcessGroup: alive,
            },
          );
        }, 50);
      }, 50);
    });
    if (signal.aborted) abort();
  });
}

async function runSoakBody({
  config,
  profile,
  outputDirectory,
  gitSha,
  budgetBytes,
  executeIteration = executeSoakIteration,
  monotonicNow = () => performance.now(),
  wallNow = () => Date.now(),
  iterationLimit = profile.maximumIterations,
  signal = new AbortController().signal,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
}) {
  validateSoakConfig(config);
  const configured = config.profiles.find(({ id }) => id === profile?.id);
  if (!configured || canonicalJson(configured) !== canonicalJson(profile)) {
    throw new Error('soak profile must exactly match its config entry');
  }
  const budgets = validateBudget(config, profile, budgetBytes);
  if (
    !Number.isSafeInteger(iterationLimit) ||
    iterationLimit < 1 ||
    iterationLimit > profile.maximumIterations
  ) {
    throw new Error(
      'iterationLimit must be a positive test/runtime bound within maximumIterations',
    );
  }
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const rawDirectory = path.join(outputDirectory, 'raw');
  mkdirSync(rawDirectory, { mode: 0o700 });
  const sealedDirectory = path.join(outputDirectory, 'sealed');
  mkdirSync(sealedDirectory, { mode: 0o700 });
  const stagingDirectory = path.join(outputDirectory, '.staging');
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const processGroupPath = path.join(outputDirectory, 'active-process-group');
  const samples = [];
  let origin;
  while (true) {
    const measuredDuration = samples.at(-1)?.completedMonotonicMs - origin;
    if (
      samples.length >= profile.minimumIterations &&
      measuredDuration >= profile.durationSeconds * 1_000
    ) {
      break;
    }
    if (samples.length >= iterationLimit) {
      throw new Error('maximumIterations reached before the required soak duration');
    }
    if (signal.aborted) throw new Error('performance soak interrupted');
    const number = samples.length + 1;
    const rawPath = path.join(rawDirectory, `iteration-${String(number).padStart(4, '0')}.json`);
    const metricsPath = path.join(
      stagingDirectory,
      `iteration-${String(number).padStart(4, '0')}.json`,
    );
    const launchedMonotonicMs = monotonicNow();
    if (origin === undefined) origin = launchedMonotonicMs;
    const previousCompletion = samples.at(-1)?.completedMonotonicMs;
    if (
      previousCompletion !== undefined &&
      (launchedMonotonicMs < previousCompletion ||
        launchedMonotonicMs - previousCompletion > profile.maximumLaunchGapSeconds * 1_000)
    ) {
      throw new Error(`soak iteration ${number} launch gap exceeded the committed maximum`);
    }
    const startedAt = new Date(wallNow()).toISOString();
    const rawBytes = await executeIteration({
      profile,
      metricsPath,
      processGroupPath,
      iterationNumber: number,
      runnerFingerprint,
      expectedRunnerFingerprintSha256,
      signal,
    });
    const completedMonotonicMs = monotonicNow();
    if (!Number.isFinite(completedMonotonicMs) || completedMonotonicMs <= launchedMonotonicMs) {
      throw new Error(`soak iteration ${number} monotonic duration is invalid`);
    }
    const completedAt = new Date(wallNow()).toISOString();
    const bytes = Buffer.from(rawBytes);
    const stat = lstatSync(metricsPath);
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(metricsPath).compare(bytes) !== 0) {
      throw new Error(`soak iteration ${number} output file differs from returned metrics`);
    }
    chmodSync(metricsPath, 0o600);
    const canonicalRawPath = realpathSync(metricsPath);
    if (!canonicalRawPath.startsWith(`${realpathSync(stagingDirectory)}${path.sep}`)) {
      throw new Error('soak metrics escaped the private staging directory');
    }
    validateIterationMetrics(bytes, profile, budgets, number);
    writeFileSync(rawPath, bytes, { flag: 'wx', mode: 0o600 });
    unlinkSync(metricsPath);
    samples.push({
      launchedMonotonicMs,
      completedMonotonicMs,
      startedAt,
      completedAt,
      rawBytes: bytes,
    });
  }
  rmdirSync(stagingDirectory);
  const evidence = createSoakEvidence({
    config,
    profile,
    gitSha,
    budgetBytes,
    samples,
    runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  for (const iteration of evidence.iterations) {
    const sealedPath = path.join(
      sealedDirectory,
      `iteration-${String(iteration.number).padStart(4, '0')}.json`,
    );
    writeFileSync(sealedPath, `${JSON.stringify(iteration, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const { sealedSampleSha256, ...sealedPayload } = JSON.parse(readFileSync(sealedPath, 'utf8'));
    if (sealedSampleSha256 !== sha256(canonicalJson(sealedPayload))) {
      throw new Error(`sealed soak iteration ${iteration.number} checksum failed after write`);
    }
  }
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  validateSoakEvidenceDirectory({
    config,
    outputDirectory,
    budgetBytes,
    expectedRunnerFingerprintSha256,
  });
  return evidence;
}

function failureCode(error) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('maximumIterations')) return 'iteration-limit-before-duration';
  if (message.includes('interrupted')) return 'interrupted';
  if (message.includes('timeout')) return 'iteration-timeout';
  if (message.includes('budget')) return 'budget-violation';
  if (message.includes('drift')) return 'drift-violation';
  if (message.includes('process-group')) return 'process-cleanup-failure';
  if (message.includes('metrics')) return 'metrics-contract-failure';
  return 'soak-execution-failure';
}

export function writeSoakFailure({
  outputDirectory,
  config,
  profile,
  gitSha,
  budgetBytes,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
  error,
  now = Date.now(),
}) {
  if (!existsSync(outputDirectory)) return null;
  const verifiedRunnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    runnerFingerprint,
  );
  const target = path.join(outputDirectory, 'failure.json');
  if (existsSync(target)) return JSON.parse(readFileSync(target, 'utf8'));
  const payload = {
    schemaVersion: 'tixkit-performance-soak-failure-v2',
    status: 'failed',
    claimScope: CLAIM_SCOPE,
    profile: typeof profile?.id === 'string' ? profile.id.slice(0, 63) : 'unknown',
    gitSha: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha || '') ? gitSha : null,
    configSha256: config ? sha256(canonicalJson(config)) : null,
    budgetSha256: budgetBytes ? sha256(Buffer.from(budgetBytes)) : null,
    runnerFingerprint: verifiedRunnerFingerprint,
    failureCode: failureCode(error),
    failedAt: new Date(now).toISOString(),
    integrityModel: 'checksums-not-signatures',
  };
  const failure = { ...payload, failureSha256: sha256(canonicalJson(payload)) };
  writeFileSync(target, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return failure;
}

export async function runSoak(input) {
  const runnerFingerprint = assertExpectedRunnerFingerprint(
    input.expectedRunnerFingerprintSha256,
    (input.probeRunner ?? probeRunnerFingerprint)(),
  );
  const verifiedInput = { ...input, runnerFingerprint };
  const outputExisted = existsSync(input.outputDirectory);
  try {
    return await runSoakBody(verifiedInput);
  } catch (error) {
    if (!outputExisted) writeSoakFailure({ ...verifiedInput, error });
    throw error;
  }
}

export function options(argv) {
  const result = {};
  if (argv.length % 2 !== 0) throw new Error('every soak option requires exactly one value');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option ${name || '<missing>'}`);
    }
    const key = name.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option ${name}`);
    result[key] = value;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const input = options(argv);
  const config = validateSoakConfig(
    JSON.parse(readFileSync(path.resolve(input.config || ''), 'utf8')),
  );
  const profile = config.profiles.find(({ id }) => id === input.profile);
  if (!profile) throw new Error(`unknown soak profile ${input.profile || '<missing>'}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await runSoak({
      config,
      profile,
      outputDirectory: path.resolve(input.output || ''),
      gitSha: input.gitSha,
      budgetBytes: readFileSync(path.resolve(root, profile.budgets)),
      expectedRunnerFingerprintSha256: input.expectedRunnerFingerprint,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
