#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-capacity.schema.json' with { type: 'json' };
import { canonicalJson, sha256 } from './performance-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_VERSION = 'tixkit-performance-capacity-config-v1';
const EVIDENCE_VERSION = 'tixkit-performance-capacity-evidence-v2';
const CLAIM_SCOPE = 'trusted-single-host-capacity-characterization';
export const RUNNER_FINGERPRINT_VERSION = 'tixkit-runner-fingerprint-v2';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const METRICS = [
  'attempts',
  'successes',
  'expectedInventoryDeclines',
  'platformFailures',
  'elapsedMs',
  'requestThroughputPerSecond',
  'successfulReservationThroughputPerSecond',
  'successfulReservationP50Ms',
  'successfulReservationP95Ms',
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
  'DATABASE_URL',
  'DATABASE_URL_MYSQL',
];
const ajv = new Ajv2020({ strict: true });
const validateSchema = ajv.compile(schema);

function schemaViolation(value, kind) {
  if (validateSchema(value)) return;
  const issue = validateSchema.errors?.[0];
  throw new Error(
    `${kind} schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid value'}`,
  );
}

export function validateCapacityConfig(config) {
  schemaViolation(config, 'capacity config');
  if (config.schemaVersion !== CONFIG_VERSION || config.claimScope !== CLAIM_SCOPE) {
    throw new Error('capacity config version or claim scope is unsupported');
  }
  const ids = new Set();
  for (const profile of config.profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate capacity profile ${profile.id}`);
    ids.add(profile.id);
    for (let index = 1; index < profile.concurrencyPoints.length; index += 1) {
      if (profile.concurrencyPoints[index] <= profile.concurrencyPoints[index - 1]) {
        throw new Error(`${profile.id} concurrencyPoints must be strictly increasing`);
      }
    }
    if (!profile.concurrencyPoints.includes(profile.inventory)) {
      throw new Error(`${profile.id} concurrencyPoints must include the exact inventory point`);
    }
    if (!profile.concurrencyPoints.some((concurrency) => concurrency > profile.inventory)) {
      throw new Error(`${profile.id} concurrencyPoints must include a point above inventory`);
    }
    const environmentNames = Object.keys(profile.command.env).sort();
    const requiredNames = [
      'CAPACITY_CHECKOUT_CONCURRENCY',
      'CAPACITY_CHECKOUT_INVENTORY',
      'CAPACITY_METRICS_PATH',
    ];
    if (canonicalJson(environmentNames) !== canonicalJson(requiredNames)) {
      throw new Error(`${profile.id} command.env must contain only capacity harness variables`);
    }
    const placeholders = {
      CAPACITY_METRICS_PATH: '{metricsPath}',
      CAPACITY_CHECKOUT_INVENTORY: '{inventory}',
      CAPACITY_CHECKOUT_CONCURRENCY: '{concurrency}',
    };
    for (const [name, value] of Object.entries(placeholders)) {
      if (profile.command.env[name] !== value) {
        throw new Error(`${profile.id} command.env.${name} must equal ${value}`);
      }
    }
  }
  return config;
}

function validateRunnerFingerprint(fingerprint) {
  const descriptors =
    fingerprint && typeof fingerprint === 'object'
      ? Object.getOwnPropertyDescriptors(fingerprint)
      : undefined;
  const ownKeys =
    fingerprint && typeof fingerprint === 'object' ? Reflect.ownKeys(fingerprint) : [];
  const versionDescriptor = descriptors?.version;
  const sha256Descriptor = descriptors?.sha256;
  if (
    !fingerprint ||
    typeof fingerprint !== 'object' ||
    Array.isArray(fingerprint) ||
    Object.getPrototypeOf(fingerprint) !== Object.prototype ||
    ownKeys.length !== 2 ||
    ownKeys.some((key) => typeof key !== 'string') ||
    canonicalJson([...ownKeys].sort()) !== canonicalJson(['sha256', 'version']) ||
    !versionDescriptor ||
    !sha256Descriptor ||
    !Object.hasOwn(versionDescriptor, 'value') ||
    !Object.hasOwn(sha256Descriptor, 'value') ||
    versionDescriptor.value !== RUNNER_FINGERPRINT_VERSION ||
    !SHA256_PATTERN.test(sha256Descriptor.value)
  ) {
    throw new Error('runner fingerprint must contain the supported version and a SHA-256 digest');
  }
  return Object.freeze({
    version: versionDescriptor.value,
    sha256: sha256Descriptor.value,
  });
}

export function probeRunnerFingerprint(system) {
  const processors = system === undefined ? cpus() : undefined;
  const detected = system ?? {
    platform: platform(),
    architecture: arch(),
    cpuModels: processors.map(({ model }) => model),
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
  };
  const cpuModels = Array.isArray(detected.cpuModels)
    ? detected.cpuModels.map((model) =>
        typeof model === 'string' ? model.trim().replaceAll(/\s+/gu, ' ') : '',
      )
    : [];
  const cpuModelCounts = new Map();
  for (const model of cpuModels) {
    cpuModelCounts.set(model, (cpuModelCounts.get(model) ?? 0) + 1);
  }
  const cpuModelHistogram = [...cpuModelCounts]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([model, count]) => ({ model, count }));
  if (
    typeof detected.platform !== 'string' ||
    !detected.platform ||
    typeof detected.architecture !== 'string' ||
    !detected.architecture ||
    cpuModels.length === 0 ||
    cpuModels.some((model) => !model) ||
    !Number.isSafeInteger(detected.logicalCpuCount) ||
    detected.logicalCpuCount < 1 ||
    cpuModels.length !== detected.logicalCpuCount ||
    !Number.isSafeInteger(detected.totalMemoryBytes) ||
    detected.totalMemoryBytes < 1
  ) {
    throw new Error('runner fingerprint probe returned incomplete stable hardware identity');
  }
  const descriptor = {
    version: RUNNER_FINGERPRINT_VERSION,
    platform: detected.platform,
    architecture: detected.architecture,
    cpuModelHistogram,
    logicalCpuCount: detected.logicalCpuCount,
    totalMemoryBytes: detected.totalMemoryBytes,
  };
  return Object.freeze({
    version: RUNNER_FINGERPRINT_VERSION,
    sha256: sha256(canonicalJson(descriptor)),
  });
}

export function assertExpectedRunnerFingerprint(expectedSha256, actualFingerprint) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? '')) {
    throw new Error('expected runner fingerprint must be a lowercase SHA-256 digest');
  }
  const actual = validateRunnerFingerprint(actualFingerprint);
  const matches = timingSafeEqual(
    Buffer.from(expectedSha256, 'hex'),
    Buffer.from(actual.sha256, 'hex'),
  );
  if (!matches) throw new Error('trusted runner fingerprint does not match the expected identity');
  return actual;
}

function validateMetrics(metrics, profile, concurrency) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('capacity metrics must be an object');
  }
  const names = Object.keys(metrics).sort();
  if (canonicalJson(names) !== canonicalJson([...METRICS].sort())) {
    throw new Error(`capacity metrics must contain exactly ${METRICS.join(', ')}`);
  }
  for (const name of METRICS) {
    if (typeof metrics[name] !== 'number' || !Number.isFinite(metrics[name]) || metrics[name] < 0) {
      throw new Error(`capacity metric ${name} must be a finite non-negative number`);
    }
  }
  for (const name of ['attempts', 'successes', 'expectedInventoryDeclines', 'platformFailures']) {
    if (!Number.isSafeInteger(metrics[name])) throw new Error(`${name} must be an integer`);
  }
  if (
    metrics.elapsedMs <= 0 ||
    metrics.requestThroughputPerSecond <= 0 ||
    metrics.successfulReservationThroughputPerSecond <= 0
  ) {
    throw new Error('elapsedMs and throughput values must be positive');
  }
  if (metrics.successfulReservationP50Ms > metrics.successfulReservationP95Ms) {
    throw new Error('successfulReservationP50Ms must not exceed successfulReservationP95Ms');
  }
  if (metrics.attempts !== concurrency)
    throw new Error('attempts must equal the configured concurrency');
  if (
    metrics.attempts !==
    metrics.successes + metrics.expectedInventoryDeclines + metrics.platformFailures
  ) {
    throw new Error('attempts must equal successes + expectedInventoryDeclines + platformFailures');
  }
  const maximumSuccesses = Math.min(profile.inventory, concurrency);
  const maximumExpectedDeclines = Math.max(0, concurrency - profile.inventory);
  if (metrics.successes > maximumSuccesses) throw new Error('success count violates inventory');
  if (metrics.expectedInventoryDeclines > maximumExpectedDeclines) {
    throw new Error('expected inventory decline is valid only after inventory is exhausted');
  }
  if (metrics.expectedInventoryDeclines > 0 && metrics.successes !== profile.inventory) {
    throw new Error('expected inventory decline is valid only after inventory is exhausted');
  }
  const calculatedRequestThroughput = (metrics.attempts / metrics.elapsedMs) * 1_000;
  if (metrics.requestThroughputPerSecond !== Number(calculatedRequestThroughput.toFixed(2))) {
    throw new Error('requestThroughputPerSecond must equal attempts divided by burst wall time');
  }
  const calculatedSuccessThroughput = (metrics.successes / metrics.elapsedMs) * 1_000;
  if (
    metrics.successfulReservationThroughputPerSecond !==
    Number(calculatedSuccessThroughput.toFixed(2))
  ) {
    throw new Error(
      'successfulReservationThroughputPerSecond must equal successes divided by burst wall time',
    );
  }
  return metrics;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function createCapacityEvidence({
  config,
  profile,
  gitSha,
  rawSamples,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
}) {
  validateCapacityConfig(config);
  const verifiedRunnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    runnerFingerprint,
  );
  const configuredProfile = config.profiles.find(({ id }) => id === profile?.id);
  if (!configuredProfile || canonicalJson(configuredProfile) !== canonicalJson(profile)) {
    throw new Error('capacity profile must exactly match its config entry');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new Error('gitSha must be a lowercase 40- or 64-character Git SHA');
  }
  if (!Array.isArray(rawSamples) || rawSamples.length !== profile.concurrencyPoints.length) {
    throw new Error('raw sample point count does not match config');
  }
  let saturated = false;
  const points = rawSamples.map((samples, pointIndex) => {
    const concurrency = profile.concurrencyPoints[pointIndex];
    if (!Array.isArray(samples) || samples.length !== profile.samplesPerPoint) {
      throw new Error(`concurrency ${concurrency} requires ${profile.samplesPerPoint} samples`);
    }
    const sealed = samples.map((rawBytes, sampleIndex) => {
      const bytes = Buffer.from(rawBytes);
      const metrics = validateMetrics(JSON.parse(bytes.toString('utf8')), profile, concurrency);
      return { sample: sampleIndex + 1, rawSha256: sha256(bytes), metrics };
    });
    const medianSuccessfulReservationThroughputPerSecond = median(
      sealed.map(({ metrics }) => metrics.successfulReservationThroughputPerSecond),
    );
    const medianSuccessfulReservationP95Ms = median(
      sealed.map(({ metrics }) => metrics.successfulReservationP95Ms),
    );
    const basePublishable = sealed.every(
      ({ metrics }) =>
        metrics.platformFailures === 0 &&
        metrics.successfulReservationP95Ms <= profile.saturationP95Ms,
    );
    const previousThroughput =
      pointIndex === 0
        ? null
        : median(
            rawSamples[pointIndex - 1].map(
              (raw) =>
                JSON.parse(Buffer.from(raw).toString('utf8'))
                  .successfulReservationThroughputPerSecond,
            ),
          );
    const throughputGainPercent =
      previousThroughput === null
        ? null
        : ((medianSuccessfulReservationThroughputPerSecond - previousThroughput) /
            previousThroughput) *
          100;
    const gainPublishable =
      throughputGainPercent === null || throughputGainPercent >= profile.minThroughputGainPercent;
    const publishable = !saturated && basePublishable && gainPublishable;
    if (!publishable) saturated = true;
    return {
      concurrency,
      publishable,
      throughputGainPercent,
      medianSuccessfulReservationThroughputPerSecond,
      medianSuccessfulReservationP95Ms,
      samples: sealed,
    };
  });
  const saturationIndex = points.findIndex((point) => !point.publishable);
  const saturation =
    saturationIndex < 0
      ? null
      : {
          concurrency: points[saturationIndex].concurrency,
          reason: points[saturationIndex].samples.some(
            ({ metrics }) => metrics.platformFailures !== 0,
          )
            ? 'platform-failure'
            : points[saturationIndex].samples.some(
                  ({ metrics }) => metrics.successfulReservationP95Ms > profile.saturationP95Ms,
                )
              ? 'p95-threshold'
              : 'throughput-gain-threshold',
        };
  const capacityClaim =
    saturationIndex > 0
      ? {
          maxPublishableConcurrency: points[saturationIndex - 1].concurrency,
          saturationObservedAtConcurrency: points[saturationIndex].concurrency,
        }
      : null;
  const workload = {
    inventory: profile.inventory,
    concurrencyPoints: profile.concurrencyPoints,
    samplesPerPoint: profile.samplesPerPoint,
    timeoutSeconds: profile.timeoutSeconds,
    saturationP95Ms: profile.saturationP95Ms,
    minThroughputGainPercent: profile.minThroughputGainPercent,
    command: profile.command,
  };
  const payload = {
    schemaVersion: EVIDENCE_VERSION,
    claimScope: CLAIM_SCOPE,
    denials: ['Production capacity', 'Cloud capacity', 'Compact capacity', 'general capacity'],
    integrityModel: 'checksums-not-signatures',
    identity: {
      gitSha,
      runnerLabel: profile.runnerLabel,
      runnerFingerprint: verifiedRunnerFingerprint,
      profile: profile.id,
      database: profile.database,
      workloadSha256: sha256(canonicalJson(workload)),
      configSha256: sha256(canonicalJson(config)),
    },
    points,
    saturation,
    capacityClaim,
  };
  const evidence = {
    ...payload,
    evidenceSha256: sha256(canonicalJson(payload)),
  };
  schemaViolation(evidence, 'capacity evidence');
  return evidence;
}

export function validateCapacityEvidence({
  config,
  evidence,
  rawSamples,
  expectedRunnerFingerprintSha256,
}) {
  schemaViolation(evidence, 'capacity evidence');
  const profile = config?.profiles?.find(({ id }) => id === evidence.identity.profile);
  if (!profile) throw new Error('capacity evidence profile is absent from config');
  const expected = createCapacityEvidence({
    config,
    profile,
    gitSha: evidence.identity.gitSha,
    rawSamples,
    runnerFingerprint: evidence.identity.runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(evidence)) {
    throw new Error('capacity evidence does not match config, raw samples, or derived relations');
  }
  return evidence;
}

function substitute(value, replacements) {
  return Object.entries(replacements).reduce(
    (result, [name, replacement]) => result.replaceAll(`{${name}}`, replacement),
    value,
  );
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

export function executeCapacitySample({ profile, concurrency, metricsPath, signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('capacity characterization interrupted'));
    const replacements = {
      metricsPath,
      inventory: String(profile.inventory),
      concurrency: String(concurrency),
    };
    const inherited = Object.fromEntries(
      CHILD_ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [
        name,
        process.env[name],
      ]),
    );
    const declared = Object.fromEntries(
      Object.entries(profile.command.env).map(([name, value]) => [
        name,
        substitute(value, replacements),
      ]),
    );
    declared.DB_INTEGRATION_DRIVER = profile.database.engine === 'mysql' ? 'mysql' : 'postgres';
    const child = spawn(profile.command.executable, profile.command.args, {
      cwd: path.join(root, 'packages/api'),
      detached: process.platform !== 'win32',
      env: { ...inherited, ...declared },
      stdio: 'inherit',
    });
    let requestedError;
    let killTimer;
    let settleTimer;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        try {
          resolve(readFileSync(metricsPath));
        } catch (readError) {
          reject(
            new Error(`capacity sample completed without readable metrics: ${readError.code}`),
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
        settleTimer = setTimeout(() => finish(requestedError), 25);
      }, 1_000);
    };
    const abort = () => terminate(new Error('capacity characterization interrupted'));
    const timeoutTimer = setTimeout(
      () => terminate(new Error(`capacity sample exceeded ${profile.timeoutSeconds}s timeout`)),
      profile.timeoutSeconds * 1_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', finish);
    child.once('exit', (code, childSignal) => {
      if (requestedError) return;
      if (code === 0) finish();
      else finish(new Error(`capacity sample failed with ${childSignal || `exit ${code}`}`));
    });
    if (signal.aborted) abort();
  });
}

export async function runCapacityCharacterization({
  config,
  profile,
  outputDirectory,
  gitSha,
  executeSample = executeCapacitySample,
  signal = new AbortController().signal,
  expectedRunnerFingerprintSha256,
  probeRunner = probeRunnerFingerprint,
}) {
  validateCapacityConfig(config);
  const runnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    probeRunner(),
  );
  const configuredProfile = config.profiles.find(({ id }) => id === profile?.id);
  if (!configuredProfile || canonicalJson(configuredProfile) !== canonicalJson(profile)) {
    throw new Error('capacity profile must exactly match its config entry');
  }
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const rawDirectory = path.join(outputDirectory, 'raw');
  mkdirSync(rawDirectory, { mode: 0o700 });
  const rawSamples = [];
  for (const concurrency of profile.concurrencyPoints) {
    const pointDirectory = path.join(rawDirectory, String(concurrency));
    mkdirSync(pointDirectory, { mode: 0o700 });
    const samples = [];
    for (let sample = 1; sample <= profile.samplesPerPoint; sample += 1) {
      if (signal.aborted) throw new Error('capacity characterization interrupted');
      const metricsPath = path.join(pointDirectory, `sample-${sample}.json`);
      const bytes = await executeSample({
        profile,
        concurrency,
        metricsPath,
        signal,
      });
      if (readFileSync(metricsPath).compare(Buffer.from(bytes)) !== 0) {
        throw new Error(`capacity sample ${concurrency}/${sample} bytes differ from output file`);
      }
      samples.push(bytes);
    }
    rawSamples.push(samples);
  }
  const evidence = createCapacityEvidence({
    config,
    profile,
    gitSha,
    rawSamples,
    runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const serializedEvidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  validateCapacityEvidence({
    config,
    evidence: serializedEvidence,
    rawSamples,
    expectedRunnerFingerprintSha256,
  });
  return serializedEvidence;
}

const CLI_OPTIONS = new Set([
  'config',
  'profile',
  'output',
  'git-sha',
  'expected-runner-fingerprint',
]);

export function parseCapacityOptions(argv) {
  const result = {};
  const seen = new Set();
  if (argv.length % 2 !== 0) throw new Error('capacity options require a value for every flag');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option ${name || '<missing>'}`);
    }
    const flag = name.slice(2);
    if (!CLI_OPTIONS.has(flag)) throw new Error(`unknown capacity option --${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate capacity option --${flag}`);
    seen.add(flag);
    result[flag.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const required of CLI_OPTIONS) {
    if (!seen.has(required)) throw new Error(`missing required capacity option --${required}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseCapacityOptions(argv);
  const config = validateCapacityConfig(
    JSON.parse(readFileSync(path.resolve(input.config || ''), 'utf8')),
  );
  const profile = config.profiles.find(({ id }) => id === input.profile);
  if (!profile) throw new Error(`unknown capacity profile ${input.profile || '<missing>'}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await runCapacityCharacterization({
      config,
      profile,
      outputDirectory: path.resolve(input.output || ''),
      gitSha: input.gitSha,
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
