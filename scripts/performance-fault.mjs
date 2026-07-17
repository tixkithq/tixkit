#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-fault.schema.json' with { type: 'json' };
import {
  assertExpectedRunnerFingerprint,
  probeRunnerFingerprint,
} from './performance-capacity.mjs';
import { canonicalJson, sha256 } from './performance-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const CONFIG_VERSION = 'tixkit-performance-fault-config-v1';
const EVIDENCE_VERSION = 'tixkit-performance-fault-evidence-v2';
const CLAIM_SCOPE = 'trusted-single-host-database-dependency-fault';
const AUTHORIZATION =
  'I authorize controlled database service interruption on the dedicated trusted runner';
const DENIALS = [
  'Production availability',
  'Production fault tolerance',
  'Cloud availability',
  'Compact availability',
  'provider resilience',
  'Temporal resilience',
  'SLA or RTO claim',
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
const validateSchema = new Ajv2020({ strict: true }).compile(schema);

function schemaViolation(value, kind) {
  if (validateSchema(value)) return;
  const issue = validateSchema.errors?.[0];
  throw new Error(
    `${kind} schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid value'}`,
  );
}

export function validateFaultConfig(config) {
  schemaViolation(config, 'fault config');
  if (config.schemaVersion !== CONFIG_VERSION || config.claimScope !== CLAIM_SCOPE) {
    throw new Error('fault config version or claim scope is unsupported');
  }
  const ids = new Set();
  for (const profile of config.profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate fault profile ${profile.id}`);
    ids.add(profile.id);
    if (profile.runnerLabel !== 'tixkit-epyc-trusted') {
      throw new Error(`${profile.id} runnerLabel must be tixkit-epyc-trusted`);
    }
    if (profile.inventory !== profile.faultAttempts) {
      throw new Error(`${profile.id} inventory must equal faultAttempts for exact reconciliation`);
    }
    if (profile.inventory !== 64 || profile.faultAttempts !== 64) {
      throw new Error(`${profile.id} must use the committed 64-attempt fault workload`);
    }
    if (profile.authorizationPhrase !== AUTHORIZATION) {
      throw new Error(`${profile.id} authorization phrase is unsupported`);
    }
    const expectedId = `${profile.database.engine === 'mysql' ? 'mysql' : 'postgresql'}-trusted-host-database-loss`;
    const expectedArgs = [
      'vitest',
      'run',
      'src/__tests__/integration/load-harness.integration.test.ts',
      '-t',
      'reconciles exact reservation attempts after a controlled database dependency loss',
      '--no-file-parallelism',
      '--maxWorkers=1',
    ];
    if (
      profile.id !== expectedId ||
      profile.command.executable !== 'bun' ||
      canonicalJson(profile.command.args) !== canonicalJson(expectedArgs)
    ) {
      throw new Error(`${profile.id} command or database/profile mapping drifted`);
    }
    const expectedEnvironment = {
      FAULT_CHECKOUT_ATTEMPTS: '{faultAttempts}',
      FAULT_CHECKOUT_INVENTORY: '{inventory}',
      FAULT_CONTROL_DIRECTORY: '{controlDirectory}',
      FAULT_LOAD: '1',
      FAULT_MARKER_TIMEOUT_MS: '{markerTimeoutMs}',
      FAULT_METRICS_PATH: '{metricsPath}',
    };
    if (canonicalJson(profile.command.env) !== canonicalJson(expectedEnvironment)) {
      throw new Error(`${profile.id} command.env must equal the fault protocol environment`);
    }
  }
  return config;
}

function validateMetrics(metrics, profile) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('fault metrics must be an object');
  }
  const expectedTopLevel = [
    'faultPhase',
    'identitySets',
    'providerScope',
    'reconciliation',
    'replayPhase',
  ];
  if (canonicalJson(Object.keys(metrics).sort()) !== canonicalJson(expectedTopLevel)) {
    throw new Error('fault metrics contain missing or unexpected top-level fields');
  }
  if (metrics.providerScope !== 'not-exercised')
    throw new Error('provider scope must be not-exercised');
  const phaseNames = [
    'attempts',
    'dependencyFailures',
    'expectedInventoryDeclines',
    'providerFailures',
    'successes',
    'unexpectedPlatformFailures',
  ];
  for (const [phaseName, phase] of [
    ['faultPhase', metrics.faultPhase],
    ['replayPhase', metrics.replayPhase],
  ]) {
    if (!phase || canonicalJson(Object.keys(phase).sort()) !== canonicalJson(phaseNames)) {
      throw new Error(`${phaseName} fields are incomplete`);
    }
    for (const name of phaseNames) {
      if (!Number.isSafeInteger(phase[name]) || phase[name] < 0)
        throw new Error(`${phaseName}.${name} must be a non-negative safe integer`);
    }
    if (
      phase.attempts !==
      phase.successes +
        phase.expectedInventoryDeclines +
        phase.dependencyFailures +
        phase.providerFailures +
        phase.unexpectedPlatformFailures
    ) {
      throw new Error(`${phaseName} accounting is incomplete`);
    }
    if (phase.attempts !== profile.faultAttempts)
      throw new Error(`${phaseName} attempt count drifted`);
  }
  if (
    metrics.faultPhase.dependencyFailures !== profile.faultAttempts ||
    metrics.faultPhase.successes !== 0 ||
    metrics.faultPhase.expectedInventoryDeclines !== 0 ||
    metrics.faultPhase.providerFailures !== 0 ||
    metrics.faultPhase.unexpectedPlatformFailures !== 0
  ) {
    throw new Error('every fault-phase attempt must fail because the verified database is down');
  }
  if (metrics.reconciliation.preReplayActiveHolds !== 0) {
    throw new Error('ambiguous or partial fault-phase commits make replay unsafe');
  }
  if (
    metrics.replayPhase.successes !== profile.faultAttempts ||
    metrics.replayPhase.expectedInventoryDeclines !== 0 ||
    metrics.replayPhase.dependencyFailures !== 0 ||
    metrics.replayPhase.providerFailures !== 0 ||
    metrics.replayPhase.unexpectedPlatformFailures !== 0
  ) {
    throw new Error('recovery must replay every exact attempt successfully once');
  }
  if (
    metrics.reconciliation.totalCapacity !== profile.inventory ||
    metrics.reconciliation.activeHeldQuantity !== profile.faultAttempts ||
    metrics.reconciliation.uniqueSessions !== profile.faultAttempts ||
    metrics.reconciliation.duplicateIdentities !== 0 ||
    metrics.reconciliation.partialStatusCount !== 0 ||
    metrics.reconciliation.unknownStatusCount !== 0 ||
    metrics.reconciliation.soldCount !== 0 ||
    metrics.reconciliation.oversold !== false
  ) {
    throw new Error('durable reconciliation or inventory invariant failed');
  }
  if (
    metrics.identitySets.originalSha256 !== metrics.identitySets.replaySha256 ||
    metrics.identitySets.identical !== true
  ) {
    throw new Error('replay identity set differs from the original exact attempt set');
  }
  return metrics;
}

export function createFaultEvidence({
  config,
  profile,
  gitSha,
  rawMetrics,
  faultProof,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
}) {
  const verifiedRunnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    runnerFingerprint,
  );
  validateFaultConfig(config);
  const configured = config.profiles.find(({ id }) => id === profile?.id);
  if (!configured || canonicalJson(configured) !== canonicalJson(profile)) {
    throw new Error('fault profile must exactly match its config entry');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new Error('gitSha must be a lowercase 40- or 64-character Git SHA');
  }
  if (faultProof?.databaseStopped !== true || faultProof?.databaseRecovered !== true) {
    throw new Error('database stop and recovery must both be independently observed');
  }
  if (
    faultProof.injectionAfterReady !== true ||
    faultProof.restorationAfterFaultObserved !== true ||
    faultProof.sameDatabaseContainer !== true ||
    !Number.isFinite(faultProof.databaseStopDurationMs) ||
    faultProof.databaseStopDurationMs <= 0 ||
    !Number.isFinite(faultProof.databaseRecoveryDurationMs) ||
    faultProof.databaseRecoveryDurationMs <= 0 ||
    faultProof.recoveryThresholdSeconds !== profile.markerTimeoutSeconds ||
    faultProof.databaseRecoveryDurationMs > profile.markerTimeoutSeconds * 1_000
  ) {
    throw new Error('fault injection/restoration ordering or bounded recovery proof is invalid');
  }
  const bytes = Buffer.from(rawMetrics);
  const metrics = validateMetrics(JSON.parse(bytes.toString('utf8')), profile);
  const workload = {
    inventory: profile.inventory,
    faultAttempts: profile.faultAttempts,
    authorizationPhrase: profile.authorizationPhrase,
    timeoutSeconds: profile.timeoutSeconds,
    markerTimeoutSeconds: profile.markerTimeoutSeconds,
    command: profile.command,
  };
  const payload = {
    schemaVersion: EVIDENCE_VERSION,
    claimScope: CLAIM_SCOPE,
    denials: DENIALS,
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
    metrics,
    rawSha256: sha256(bytes),
    faultProof: {
      ...faultProof,
      exactAttemptReplay: true,
      durableReconciliation: true,
      noOversell: true,
    },
  };
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaViolation(evidence, 'fault evidence');
  return evidence;
}

export function validateFaultEvidence({
  config,
  evidence,
  rawMetrics,
  expectedRunnerFingerprintSha256,
}) {
  schemaViolation(evidence, 'fault evidence');
  const profile = config?.profiles?.find(({ id }) => id === evidence.identity.profile);
  if (!profile) throw new Error('fault evidence profile is absent from config');
  const expected = createFaultEvidence({
    config,
    profile,
    gitSha: evidence.identity.gitSha,
    rawMetrics,
    faultProof: evidence.faultProof,
    runnerFingerprint: evidence.identity.runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  if (canonicalJson(expected) !== canonicalJson(evidence)) {
    throw new Error('fault evidence does not match config, raw metrics, or derived relations');
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

function processGroupExists(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function assertMarkerAbsent(markerPath) {
  try {
    lstatSync(markerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${path.basename(markerPath)} existed before its authorized protocol phase`);
}

async function waitForMarker(markerPath, timeoutMs, signal, expectedContent = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('fault characterization interrupted');
    try {
      const stat = lstatSync(markerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600)
        throw new Error(`${markerPath} is not a private regular file`);
      const content = readFileSync(markerPath, 'utf8');
      if (content !== expectedContent) {
        throw new Error(`${path.basename(markerPath)} has an invalid protocol token`);
      }
      return content;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${path.basename(markerPath)}`);
}

async function docker(args, timeoutMs = 30_000) {
  const { stdout } = await execFileAsync('docker', args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: Object.fromEntries(
      ['PATH', 'HOME', 'DOCKER_HOST'].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ),
  });
  return stdout.trim();
}

async function inspectContainer(containerId) {
  const output = await docker(['inspect', containerId]);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new Error('docker inspect was ambiguous');
  return parsed[0];
}

async function containerMatchesPinnedImage(inspect, expectedImage) {
  if (inspect?.Config?.Image === expectedImage) return true;
  const expectedDigest = expectedImage.slice(expectedImage.indexOf('@') + 1);
  if (typeof inspect?.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(inspect.Image))
    return false;
  const output = await docker(['image', 'inspect', inspect.Image]);
  const images = JSON.parse(output);
  return Array.isArray(images) && images.length === 1 && Array.isArray(images[0]?.RepoDigests)
    ? images[0].RepoDigests.some(
        (value) => value === expectedImage || value.endsWith(`@${expectedDigest}`),
      )
    : false;
}

async function waitForContainer(containerId, predicate, timeoutMs, description, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('fault characterization interrupted');
    const inspect = await inspectContainer(containerId);
    if (predicate(inspect)) return inspect;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for database container ${description}`);
}

export async function executeFaultScenario({
  profile,
  containerId,
  controlDirectory,
  metricsPath,
  runnerFingerprint,
  expectedRunnerFingerprintSha256,
  signal,
}) {
  assertExpectedRunnerFingerprint(expectedRunnerFingerprintSha256, runnerFingerprint);
  if (signal.aborted) throw new Error('fault characterization interrupted');
  const replacements = {
    controlDirectory,
    metricsPath,
    inventory: String(profile.inventory),
    faultAttempts: String(profile.faultAttempts),
    markerTimeoutMs: String(profile.markerTimeoutSeconds * 1_000),
  };
  const inherited = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
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
  let stopAttempted = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeoutTimer = setTimeout(abort, profile.timeoutSeconds * 1_000);
  const childExit = new Promise((childResolve, childReject) => {
    child.once('error', childReject);
    child.once('exit', (code, childSignal) => {
      if (code === 0) childResolve();
      else childReject(new Error(`fault scenario failed with ${childSignal || `exit ${code}`}`));
    });
  });
  const raceChild = async (operation) =>
    Promise.race([
      operation,
      childExit.then(() => {
        throw new Error('fault harness exited before completing the control protocol');
      }),
    ]);
  const terminateChild = async () => {
    signalProcessGroup(child, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (processGroupExists(child)) {
      signalProcessGroup(child, 'SIGKILL');
    }
    await childExit.catch(() => undefined);
    const cleanupDeadline = Date.now() + 2_000;
    while (processGroupExists(child) && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (processGroupExists(child)) throw new Error('fault harness process group survived cleanup');
  };
  const markerTimeoutMs = profile.markerTimeoutSeconds * 1_000;
  const protocolToken = randomBytes(32).toString('hex');
  let primaryError;
  let stopDurationMs;
  let recoveryDurationMs;
  try {
    const initial = await inspectContainer(containerId);
    if (!(await containerMatchesPinnedImage(initial, profile.database.image))) {
      throw new Error(
        'database service container does not prove the committed digest-pinned image',
      );
    }
    await raceChild(
      waitForMarker(path.join(controlDirectory, 'fault-ready'), markerTimeoutMs, controller.signal),
    );
    assertMarkerAbsent(path.join(controlDirectory, 'fault-injected'));
    assertMarkerAbsent(path.join(controlDirectory, 'fault-observed'));
    assertMarkerAbsent(path.join(controlDirectory, 'database-recovered'));
    const stopStartedAt = performance.now();
    stopAttempted = true;
    await docker(['stop', '--time', '0', containerId], 15_000);
    await raceChild(
      waitForContainer(
        containerId,
        (value) => value?.State?.Running === false,
        markerTimeoutMs,
        'to stop',
        controller.signal,
      ),
    );
    stopDurationMs = performance.now() - stopStartedAt;
    writeFileSync(path.join(controlDirectory, 'fault-injected'), protocolToken, {
      flag: 'wx',
      mode: 0o600,
    });
    await raceChild(
      waitForMarker(
        path.join(controlDirectory, 'fault-observed'),
        markerTimeoutMs,
        controller.signal,
        protocolToken,
      ),
    );
  } catch (error) {
    primaryError = controller.signal.aborted
      ? new Error('fault characterization interrupted or timed out', { cause: error })
      : error;
  }

  let recoveryError;
  if (stopAttempted) {
    try {
      const recoveryStartedAt = performance.now();
      const afterStopAttempt = await inspectContainer(containerId);
      if (afterStopAttempt?.State?.Running !== true) {
        await docker(['start', containerId], 30_000);
      }
      const recovered = await waitForContainer(
        containerId,
        (value) => value?.State?.Running === true && value?.State?.Health?.Status === 'healthy',
        markerTimeoutMs,
        'to become healthy',
        new AbortController().signal,
      );
      recoveryDurationMs = performance.now() - recoveryStartedAt;
      if (
        !String(recovered.Id).startsWith(containerId) ||
        !(await containerMatchesPinnedImage(recovered, profile.database.image))
      ) {
        throw new Error('recovered database container image identity drifted');
      }
    } catch (error) {
      recoveryError = error;
    }
  }

  if (primaryError || recoveryError) {
    controller.abort();
    let cleanupError;
    try {
      await terminateChild();
    } catch (error) {
      cleanupError = error;
    }
    clearTimeout(timeoutTimer);
    signal.removeEventListener('abort', abort);
    const failures = [primaryError, recoveryError, cleanupError].filter(Boolean);
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        'fault scenario, mandatory database recovery, or process cleanup failed',
      );
    throw failures[0];
  }

  try {
    writeFileSync(path.join(controlDirectory, 'database-recovered'), protocolToken, {
      flag: 'wx',
      mode: 0o600,
    });
    await Promise.race([
      childExit,
      new Promise((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('fault harness exceeded its total timeout')),
          { once: true },
        ),
      ),
    ]);
  } catch (error) {
    try {
      await terminateChild();
    } catch (cleanupError) {
      // eslint-disable-next-line preserve-caught-error -- AggregateError retains both failures and sets the primary error as cause below.
      throw new AggregateError(
        [error, cleanupError],
        'fault harness completion and process cleanup both failed',
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutTimer);
    signal.removeEventListener('abort', abort);
  }
  const metricsStat = lstatSync(metricsPath);
  if (
    !metricsStat.isFile() ||
    metricsStat.isSymbolicLink() ||
    (metricsStat.mode & 0o777) !== 0o600
  ) {
    throw new Error('fault metrics must be a private regular create-once file');
  }
  const rawMetrics = readFileSync(metricsPath);
  return {
    rawMetrics,
    faultProof: {
      databaseStopped: true,
      databaseRecovered: true,
      injectionAfterReady: true,
      restorationAfterFaultObserved: true,
      databaseStopDurationMs: stopDurationMs,
      databaseRecoveryDurationMs: recoveryDurationMs,
      recoveryThresholdSeconds: profile.markerTimeoutSeconds,
      sameDatabaseContainer: true,
    },
  };
}

export async function runFaultCharacterization({
  config,
  profile,
  outputDirectory,
  gitSha,
  containerId,
  authorization,
  expectedRunnerFingerprintSha256,
  probeRunner = probeRunnerFingerprint,
  executeScenario = executeFaultScenario,
  signal = new AbortController().signal,
}) {
  const runnerFingerprint = assertExpectedRunnerFingerprint(
    expectedRunnerFingerprintSha256,
    probeRunner(),
  );
  validateFaultConfig(config);
  const configured = config.profiles.find(({ id }) => id === profile?.id);
  if (!configured || canonicalJson(configured) !== canonicalJson(profile)) {
    throw new Error('fault profile must exactly match its config entry');
  }
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('containerId has an unsafe format');
  if (authorization !== AUTHORIZATION || authorization !== profile.authorizationPhrase) {
    throw new Error('exact destructive-test authorization phrase is required');
  }
  if (!path.isAbsolute(outputDirectory) || outputDirectory === path.parse(outputDirectory).root) {
    throw new Error('outputDirectory must be a non-root absolute path');
  }
  const outputParent = path.dirname(outputDirectory);
  if (realpathSync(outputParent) !== outputParent) {
    throw new Error('outputDirectory parent must not traverse symbolic links');
  }
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const outputStat = lstatSync(outputDirectory);
  if (
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink() ||
    (outputStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('outputDirectory must be a private newly created directory');
  }
  const controlDirectory = path.join(outputDirectory, 'control');
  mkdirSync(controlDirectory, { mode: 0o700 });
  const metricsPath = path.join(outputDirectory, 'raw-metrics.json');
  const result = await executeScenario({
    profile,
    containerId,
    controlDirectory,
    metricsPath,
    runnerFingerprint,
    expectedRunnerFingerprintSha256,
    signal,
  });
  const bytes = Buffer.from(result.rawMetrics);
  if (readFileSync(metricsPath).compare(bytes) !== 0) {
    throw new Error('fault metrics bytes differ from the harness output file');
  }
  const evidence = createFaultEvidence({
    config,
    profile,
    gitSha,
    rawMetrics: bytes,
    faultProof: result.faultProof,
    runnerFingerprint,
    expectedRunnerFingerprintSha256,
  });
  const evidencePath = path.join(outputDirectory, 'evidence.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  validateFaultEvidence({
    config,
    evidence: JSON.parse(readFileSync(evidencePath)),
    rawMetrics: bytes,
    expectedRunnerFingerprintSha256,
  });
  return evidence;
}

const CLI_OPTIONS = new Set([
  'config',
  'profile',
  'output',
  'git-sha',
  'container-id',
  'authorization',
  'expected-runner-fingerprint',
]);

export function parseFaultOptions(argv) {
  const result = {};
  const seen = new Set();
  if (argv.length % 2 !== 0) throw new Error('fault options require a value for every flag');
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--'))
      throw new Error(`invalid option ${name || '<missing>'}`);
    const flag = name.slice(2);
    if (!CLI_OPTIONS.has(flag)) throw new Error(`unknown fault option --${flag}`);
    if (seen.has(flag)) throw new Error(`duplicate fault option --${flag}`);
    seen.add(flag);
    result[flag.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const required of CLI_OPTIONS) {
    if (!seen.has(required)) throw new Error(`missing required fault option --${required}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const input = parseFaultOptions(argv);
  const config = validateFaultConfig(
    JSON.parse(readFileSync(path.resolve(input.config || ''), 'utf8')),
  );
  const profile = config.profiles.find(({ id }) => id === input.profile);
  if (!profile) throw new Error(`unknown fault profile ${input.profile || '<missing>'}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await runFaultCharacterization({
      config,
      profile,
      outputDirectory: path.resolve(input.output || ''),
      gitSha: input.gitSha,
      containerId: input.containerId,
      authorization: input.authorization,
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
