#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-temporal-fault.schema.json' with { type: 'json' };

const CONFIG_VERSION = 'tixkit-performance-temporal-fault-config-v1';
const EVIDENCE_VERSION = 'tixkit-performance-temporal-fault-evidence-v1';
const CLAIM_SCOPE = 'trusted-single-host-temporal-service-dependency-fault';
const AUTHORIZATION =
  'I authorize controlled Temporal service interruption on the dedicated trusted runner';
const DENIALS = [
  'Production Temporal availability',
  'Cloud Temporal availability',
  'Compact or Production profile resilience',
  'multi-node failover',
  'managed Temporal behavior',
  'database or migration-data correctness',
  'provider, webhook, or scanner resilience',
  'exactly-once external side effects',
  'capacity or soak',
  'SLA, RTO, or RPO',
  'immutable or publicly published evidence',
];
const MIGRATION_STAGES = [
  'organizations_brands',
  'venues',
  'events_occurrences',
  'content',
  'inventory_pools',
  'ticket_types_products',
  'questions',
  'discounts_access_codes',
  'buyers_attendees',
  'historical_orders',
  'tickets',
  'historical_payments_refunds',
  'check_in_history',
];
const RUNNER_SEQUENCE = [
  'workload-ready',
  'stop-confirmed',
  'activities-released',
  'restart-requested',
  'docker-healthy',
  'grpc-reachable',
  'recovery-released',
  'workload-complete',
];
const WORKLOAD_SEQUENCE = ['workload-ready', 'fault-start', 'recovery-ready', 'workload-complete'];
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'RUNNER_OS',
  'RUNNER_ARCH',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_NAMESPACE',
];
const ajv = new Ajv2020({ strict: true });
const validateSchema = ajv.compile(schema);
const requireFromWorkflows = createRequire(
  new URL('../packages/workflows/package.json', import.meta.url),
);
const { Connection } = requireFromWorkflows('@temporalio/client');

export function canonicalJson(value) {
  if (Array.isArray(value))
    return JSON.stringify(value.map((entry) => JSON.parse(canonicalJson(entry))));
  if (value && typeof value === 'object') {
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, JSON.parse(canonicalJson(value[key]))]),
      ),
    );
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function schemaViolation(value, label) {
  if (validateSchema(value)) return;
  const issue = validateSchema.errors?.[0];
  throw new Error(
    `${label} schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid'}`,
  );
}

export function validateTemporalFaultConfig(config) {
  schemaViolation(config, 'Temporal fault config');
  if (
    config.schemaVersion !== CONFIG_VERSION ||
    config.claimScope !== CLAIM_SCOPE ||
    config.authorization !== AUTHORIZATION
  ) {
    throw new Error('Temporal fault config authority is unsupported');
  }
  const ids = new Set();
  for (const profile of config.profiles) {
    if (ids.has(profile.id)) throw new Error(`duplicate Temporal fault profile ${profile.id}`);
    ids.add(profile.id);
    if (profile.workloadTimeoutSeconds <= profile.outageSeconds) {
      throw new Error(`${profile.id} workload timeout must exceed the outage`);
    }
    if (
      profile.command.args.join(' ') !==
      'vitest run src/__tests__/temporal-dependency-fault.integration.test.ts --no-file-parallelism --maxWorkers=1'
    ) {
      throw new Error(`${profile.id} command must select only the Temporal fault integration test`);
    }
  }
  return config;
}

function requireRaw(raw, profile, nonce, markers) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('raw metrics missing');
  const expectedRawKeys = [
    'schemaVersion',
    'namespace',
    'taskQueueSha256',
    'workflowCount',
    'completedCount',
    'failedCount',
    'openCount',
    'timedOutCount',
    'cancelledCount',
    'terminatedCount',
    'expectedLogicalEffectsPerWorkflow',
    'protocol',
    'workflows',
  ].sort();
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(expectedRawKeys)) {
    throw new Error('raw metrics keys are not closed');
  }
  if (raw.schemaVersion !== 'tixkit-temporal-fault-raw-v1') throw new Error('raw version invalid');
  if (profile.workflowCount !== 16 || raw.workflowCount !== 16 || raw.completedCount !== 16) {
    throw new Error('not every original workflow completed');
  }
  if (
    raw.failedCount !== 0 ||
    raw.openCount !== 0 ||
    raw.timedOutCount !== 0 ||
    raw.cancelledCount !== 0 ||
    raw.terminatedCount !== 0
  )
    throw new Error('workflow remained non-completed');
  if (
    !/^[a-zA-Z0-9._-]{1,255}$/.test(raw.namespace) ||
    !/^[a-f0-9]{64}$/.test(raw.taskQueueSha256)
  ) {
    throw new Error('Temporal namespace or task queue identity invalid');
  }
  if (raw.expectedLogicalEffectsPerWorkflow !== 29)
    throw new Error('logical effect contract drift');
  const protocolKeys = [
    'nonceSha256',
    'readyMarkerSha256',
    'startMarkerSha256',
    'recoveryMarkerSha256',
    'readyObservedAt',
    'startObservedAt',
    'recoveryObservedAt',
    'sequence',
  ].sort();
  if (
    !raw.protocol ||
    canonicalJson(Object.keys(raw.protocol).sort()) !== canonicalJson(protocolKeys) ||
    raw.protocol.nonceSha256 !== sha256(nonce) ||
    raw.protocol.readyMarkerSha256 !== sha256(markers.ready) ||
    raw.protocol.startMarkerSha256 !== sha256(markers.start) ||
    raw.protocol.recoveryMarkerSha256 !== sha256(markers.recovery) ||
    canonicalJson(raw.protocol.sequence) !== canonicalJson(WORKLOAD_SEQUENCE)
  ) {
    throw new Error('workload recovery protocol integrity failed');
  }
  const observed = ['readyObservedAt', 'startObservedAt', 'recoveryObservedAt'].map((key) =>
    Date.parse(raw.protocol[key]),
  );
  if (
    observed.some((value) => !Number.isFinite(value)) ||
    observed[0] > observed[1] ||
    observed[1] > observed[2]
  ) {
    throw new Error('workload recovery protocol ordering failed');
  }
  const stageOrderSha256 = sha256(canonicalJson(MIGRATION_STAGES));
  if (!Array.isArray(raw.workflows) || raw.workflows.length !== profile.workflowCount) {
    throw new Error('raw workflow count mismatch');
  }
  const identities = new Set();
  const workflowIds = new Set();
  const runIds = new Set();
  for (const workflow of raw.workflows) {
    for (const digest of [
      workflow.workflowIdSha256,
      workflow.runIdSha256,
      workflow.stageOrderSha256,
      workflow.historySha256,
    ]) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('workflow digest invalid');
    }
    const identity = `${workflow.workflowIdSha256}:${workflow.runIdSha256}`;
    if (
      identities.has(identity) ||
      workflowIds.has(workflow.workflowIdSha256) ||
      runIds.has(workflow.runIdSha256)
    )
      throw new Error('duplicate workflow identity');
    identities.add(identity);
    workflowIds.add(workflow.workflowIdSha256);
    runIds.add(workflow.runIdSha256);
    if (
      workflow.status !== 'completed' ||
      workflow.replayVerified !== true ||
      !Number.isSafeInteger(workflow.activityAttempts) ||
      !Number.isSafeInteger(workflow.logicalEffects) ||
      workflow.logicalEffects !== raw.expectedLogicalEffectsPerWorkflow ||
      workflow.stageOrderSha256 !== stageOrderSha256 ||
      workflow.reconciliationEffects !== 1 ||
      workflow.completionEffects !== 1 ||
      workflow.failureEffects !== 0 ||
      workflow.activityAttempts < workflow.logicalEffects
    ) {
      throw new Error('workflow recovery, replay, or idempotency invariant failed');
    }
  }
  return raw;
}

export function createTemporalFaultEvidence({
  config,
  profile,
  gitSha,
  containerId,
  rawBytes,
  outageMilliseconds,
  recoveryMilliseconds,
  nonce,
  markers,
  runnerSequence,
  processGroupBytes,
}) {
  validateTemporalFaultConfig(config);
  const configured = config.profiles.find(({ id }) => id === profile?.id);
  if (!configured || canonicalJson(configured) !== canonicalJson(profile)) {
    throw new Error('profile differs from the committed config');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) throw new Error('git SHA invalid');
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('container ID invalid');
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error('fault nonce invalid');
  if (canonicalJson(runnerSequence) !== canonicalJson(RUNNER_SEQUENCE))
    throw new Error('runner causal ordering invalid');
  const raw = requireRaw(
    JSON.parse(Buffer.from(rawBytes).toString('utf8')),
    profile,
    nonce,
    markers,
  );
  if (
    !Number.isSafeInteger(outageMilliseconds) ||
    outageMilliseconds < profile.outageSeconds * 1_000 ||
    !Number.isSafeInteger(recoveryMilliseconds) ||
    recoveryMilliseconds < 0 ||
    recoveryMilliseconds > profile.recoveryTimeoutSeconds * 1_000
  ) {
    throw new Error('fault timing invariant failed');
  }
  const workflows = [...raw.workflows].sort((left, right) =>
    left.workflowIdSha256.localeCompare(right.workflowIdSha256),
  );
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
      namespace: raw.namespace,
      taskQueueSha256: raw.taskQueueSha256,
      temporalImage: profile.temporalImage,
      persistenceImage: profile.persistenceImage,
      containerIdentitySha256: sha256(containerId),
      workflowIdentitySetSha256: sha256(
        canonicalJson(
          workflows.map(({ workflowIdSha256, runIdSha256 }) => ({ workflowIdSha256, runIdSha256 })),
        ),
      ),
    },
    measurements: {
      workflowCount: profile.workflowCount,
      stoppedBeforeRelease: true,
      sameContainerRestored: true,
      dockerHealthy: true,
      grpcReachable: true,
      outageMilliseconds,
      recoveryMilliseconds,
      recoveryThresholdMilliseconds: profile.recoveryTimeoutSeconds * 1_000,
    },
    outcomes: {
      completed: raw.completedCount,
      failed: raw.failedCount,
      open: raw.openCount,
      timedOut: raw.timedOutCount,
      cancelled: raw.cancelledCount,
      terminated: raw.terminatedCount,
    },
    protocol: raw.protocol,
    ordering: runnerSequence,
    workflows,
    rawSha256: sha256(rawBytes),
    configSha256: sha256(canonicalJson(config)),
    workloadSha256: sha256(
      canonicalJson({
        workflowCount: profile.workflowCount,
        outageSeconds: profile.outageSeconds,
        command: profile.command,
      }),
    ),
    processGroupSha256: sha256(processGroupBytes),
  };
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaViolation(evidence, 'Temporal fault evidence');
  return evidence;
}

export function validateTemporalFaultEvidence({
  config,
  profile,
  evidence,
  containerId,
  rawBytes,
  nonce,
  markers,
  processGroupBytes,
}) {
  schemaViolation(evidence, 'Temporal fault evidence');
  const expected = createTemporalFaultEvidence({
    config,
    profile,
    gitSha: evidence.identity.gitSha,
    containerId,
    rawBytes,
    outageMilliseconds: evidence.measurements.outageMilliseconds,
    recoveryMilliseconds: evidence.measurements.recoveryMilliseconds,
    nonce,
    markers,
    runnerSequence: evidence.ordering,
    processGroupBytes,
  });
  if (canonicalJson(expected) !== canonicalJson(evidence)) throw new Error('evidence mismatch');
  return evidence;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new Error('Temporal fault interrupted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function readPrivateFile(file, earliestMtime = 0) {
  const before = lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777) !== 0o600 ||
    before.mtimeMs < earliestMtime
  )
    throw new Error(`unsafe file: ${path.basename(file)}`);
  const bytes = readFileSync(file);
  const after = lstatSync(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`file changed while reading: ${path.basename(file)}`);
  }
  return bytes;
}

function parseMarker(bytes, token, nonce, sequence) {
  let marker;
  try {
    marker = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('invalid marker JSON');
  }
  if (
    canonicalJson(Object.keys(marker).sort()) !==
      canonicalJson(['nonce', 'observedAt', 'sequence', 'token']) ||
    marker.token !== token ||
    marker.nonce !== nonce ||
    marker.sequence !== sequence ||
    !Number.isFinite(Date.parse(marker.observedAt))
  )
    throw new Error(`invalid marker: ${token}`);
  return marker;
}

function writeMarker(file, token, nonce, sequence) {
  const marker = { token, nonce, sequence, observedAt: new Date().toISOString() };
  writeFileSync(file, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 });
  return readPrivateFile(file);
}

async function waitForFile(file, timeoutSeconds, signal, token, nonce, sequence, earliestMtime) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`marker timeout: ${path.basename(file)}`);
    await wait(50, signal);
  }
  const bytes = readPrivateFile(file, earliestMtime);
  parseMarker(bytes, token, nonce, sequence);
  return bytes;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} timed out`));
    }, 10_000);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4_096) stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) =>
      finish(
        code === 0 ? undefined : new Error(stderr.trim() || `${command} failed`),
        stdout.trim(),
      ),
    );
  });
}

function processGroupExists(pid) {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function terminateProcessGroup(pid, waitFor = wait) {
  if (process.platform === 'win32') return;
  const signal = (name) => {
    try {
      process.kill(-pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  if (!processGroupExists(pid)) return;
  signal('SIGTERM');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await waitFor(50, new AbortController().signal);
    if (!processGroupExists(pid)) return;
  }
  signal('SIGKILL');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await waitFor(50, new AbortController().signal);
    if (!processGroupExists(pid)) return;
  }
  throw new Error(`process group ${pid} survived SIGKILL`);
}

function linuxStartTimeTicks(pid) {
  if (process.platform !== 'linux') return null;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] ?? null;
}

function linuxProcessIdentity(pid) {
  if (process.platform !== 'linux') return null;
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { processGroup: Number(fields[2]), startTimeTicks: fields[19] };
}

export async function cleanupRecordedProcessGroup(markerPath) {
  if (!existsSync(markerPath)) return;
  const marker = JSON.parse(readPrivateFile(markerPath).toString('utf8'));
  if (
    canonicalJson(Object.keys(marker).sort()) !==
      canonicalJson(['pid', 'schemaVersion', 'startTimeTicks']) ||
    marker.schemaVersion !== 'tixkit-temporal-fault-process-group-v1' ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid < 2 ||
    (process.platform === 'linux' && !/^\d+$/.test(marker.startTimeTicks))
  )
    throw new Error('unsafe process-group marker');
  if (process.platform !== 'linux') {
    if (processGroupExists(marker.pid))
      throw new Error('cannot authenticate process group on this host');
    return;
  }
  let identity;
  try {
    identity = linuxProcessIdentity(marker.pid);
  } catch (error) {
    if (error.code === 'ENOENT' && !processGroupExists(marker.pid)) return;
    throw error;
  }
  if (identity.startTimeTicks !== marker.startTimeTicks || identity.processGroup !== marker.pid)
    throw new Error('process-group identity changed; refusing cleanup');
  await terminateProcessGroup(marker.pid);
}

export const dockerAdapter = {
  image: (containerId) => run('docker', ['inspect', '--format', '{{.Config.Image}}', containerId]),
  state: (containerId) => run('docker', ['inspect', '--format', '{{.State.Status}}', containerId]),
  health: (containerId) =>
    run('docker', [
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      containerId,
    ]),
  stop: (containerId) => run('docker', ['stop', '--time', '0', containerId]),
  start: (containerId) => run('docker', ['start', containerId]),
};

export async function temporalNamespaceReachable(
  address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  namespace = process.env.TEMPORAL_NAMESPACE ?? 'default',
  connector = (options) => Connection.connect(options),
) {
  let connection;
  try {
    connection = await connector({ address, connectTimeout: '3 seconds' });
    await connection.workflowService.describeNamespace({ namespace });
    return true;
  } catch (error) {
    const causes = [];
    for (let current = error; current && !causes.includes(current); current = current.cause) {
      causes.push(current);
    }
    const transient = causes.some(
      (cause) =>
        [4, 14, 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(
          cause.code,
        ) || /unavailable|deadline exceeded|connection refused/i.test(cause.message ?? ''),
    );
    if (transient) return false;
    throw error;
  } finally {
    await connection?.close();
  }
}

export function executeWorkload(profile, paths, signal, dependencies = {}) {
  const inherited = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [
      name,
      process.env[name],
    ]),
  );
  const child = spawn(profile.command.executable, profile.command.args, {
    cwd: path.resolve(import.meta.dirname, '../packages/workflows'),
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: {
      ...inherited,
      TEMPORAL_FAULT_WORKFLOW_COUNT: String(profile.workflowCount),
      TEMPORAL_FAULT_READY_PATH: paths.ready,
      TEMPORAL_FAULT_START_PATH: paths.start,
      TEMPORAL_FAULT_RECOVERY_PATH: paths.recovery,
      TEMPORAL_FAULT_METRICS_PATH: paths.raw,
      TEMPORAL_FAULT_NONCE: paths.nonce,
    },
  });
  if (!child.pid) throw new Error('Temporal fault workload has no process id');
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminating = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = async (error) => {
      if (terminating || settled) return;
      terminating = true;
      try {
        await terminateProcessGroup(child.pid);
        finish(error);
      } catch (terminationError) {
        finish(new AggregateError([error, terminationError], 'workload termination failed'));
      }
    };
    const abort = () => {
      void terminate(new Error('Temporal fault interrupted'));
    };
    child.once('error', (error) => void terminate(error));
    child.once('exit', (code) => {
      if (terminating) return;
      const leaked = processGroupExists(child.pid);
      if (leaked) {
        void terminate(new Error(`Temporal fault workload exited ${code} with live descendants`));
      } else {
        finish(code === 0 ? undefined : new Error(`Temporal fault workload exited ${code}`));
      }
    });
    try {
      const startTime = (dependencies.linuxStartTimeTicks ?? linuxStartTimeTicks)(child.pid);
      (dependencies.writeProcessGroup ?? writeFileSync)(
        paths.processGroup,
        `${JSON.stringify({
          schemaVersion: 'tixkit-temporal-fault-process-group-v1',
          pid: child.pid,
          startTimeTicks: startTime,
        })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      void terminate(error);
      return;
    }
    timer = setTimeout(() => {
      void terminate(new Error('Temporal fault workload timed out'));
    }, profile.workloadTimeoutSeconds * 1_000);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runTemporalFault({
  config,
  profile,
  outputDirectory,
  gitSha,
  containerId,
  authorization,
  adapter = dockerAdapter,
  workload = executeWorkload,
  sleep = wait,
  reachable = () => temporalNamespaceReachable(),
  now = () => Date.now(),
  signal = new AbortController().signal,
}) {
  validateTemporalFaultConfig(config);
  const configuredProfile = config.profiles.find(({ id }) => id === profile?.id);
  if (!configuredProfile || canonicalJson(configuredProfile) !== canonicalJson(profile)) {
    throw new Error('profile differs from the committed config');
  }
  if (authorization !== AUTHORIZATION)
    throw new Error('exact Temporal fault authorization required');
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error('container ID invalid');
  const resolvedOutput = path.resolve(outputDirectory);
  mkdirSync(resolvedOutput, { recursive: false, mode: 0o700 });
  const outputStat = lstatSync(resolvedOutput);
  if (
    !outputStat.isDirectory() ||
    outputStat.isSymbolicLink() ||
    (outputStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('output directory must be a private regular directory');
  }
  const paths = Object.fromEntries(
    ['ready', 'start', 'recovery', 'raw', 'processGroup'].map((name) => [
      name,
      path.join(resolvedOutput, `${name}.json`),
    ]),
  );
  if (Object.values(paths).some((file) => path.dirname(file) !== resolvedOutput)) {
    throw new Error('fault path escapes output directory');
  }
  paths.nonce = randomBytes(32).toString('hex');
  const controller = new AbortController();
  const callerAbort = () => controller.abort();
  signal.addEventListener('abort', callerAbort, { once: true });
  if (signal.aborted) controller.abort();
  const workloadOutcome = Promise.resolve()
    .then(() => {
      if (controller.signal.aborted) throw new Error('Temporal fault interrupted');
      return workload(profile, paths, controller.signal);
    })
    .then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    );
  let recoveryRequired = false;
  let primaryError;
  let outageStarted;
  let outageMilliseconds;
  let recoveryMilliseconds;
  let recoveryError;
  const runnerSequence = [];
  let readyBytes;
  let startBytes;
  let recoveryBytes;
  try {
    readyBytes = await Promise.race([
      waitForFile(
        paths.ready,
        profile.markerTimeoutSeconds,
        controller.signal,
        'workload-ready-v1',
        paths.nonce,
        1,
        outputStat.mtimeMs,
      ),
      workloadOutcome.then(({ error }) => {
        throw error ?? new Error('Temporal fault workload completed before readiness');
      }),
    ]);
    runnerSequence.push('workload-ready');
    if ((await adapter.image(containerId)) !== profile.temporalImage)
      throw new Error('Temporal image mismatch');
    recoveryRequired = true;
    await adapter.stop(containerId);
    if ((await adapter.state(containerId)) !== 'exited') throw new Error('Temporal did not stop');
    runnerSequence.push('stop-confirmed');
    outageStarted = now();
    startBytes = writeMarker(paths.start, 'fault-start-v1', paths.nonce, 2);
    runnerSequence.push('activities-released');
    await sleep(profile.outageSeconds * 1_000, controller.signal);
  } catch (error) {
    primaryError = error;
  }
  if (recoveryRequired) {
    const recoveryStarted = now();
    try {
      runnerSequence.push('restart-requested');
      await adapter.start(containerId);
      const deadline = now() + profile.recoveryTimeoutSeconds * 1_000;
      while ((await adapter.health(containerId)) !== 'healthy') {
        if (now() >= deadline) throw new Error('Temporal recovery threshold exceeded');
        await sleep(250, new AbortController().signal);
      }
      runnerSequence.push('docker-healthy');
      while (!(await reachable())) {
        if (now() >= deadline) throw new Error('Temporal recovery threshold exceeded');
        await sleep(250, new AbortController().signal);
      }
      runnerSequence.push('grpc-reachable');
      if ((await adapter.image(containerId)) !== profile.temporalImage)
        throw new Error('restored Temporal image mismatch');
      recoveryMilliseconds = now() - recoveryStarted;
      outageMilliseconds = now() - outageStarted;
      recoveryBytes = writeMarker(paths.recovery, 'recovery-ready-v1', paths.nonce, 3);
      runnerSequence.push('recovery-released');
    } catch (caughtRecoveryError) {
      recoveryError = caughtRecoveryError;
    }
  }
  if (primaryError || recoveryError) controller.abort();
  const completedWorkload = await workloadOutcome;
  signal.removeEventListener('abort', callerAbort);
  if (primaryError || recoveryError || completedWorkload.error) {
    throw new AggregateError(
      [
        ...(primaryError ? [primaryError] : []),
        ...(recoveryError ? [recoveryError] : []),
        ...(completedWorkload.error ? [completedWorkload.error] : []),
      ],
      'Temporal fault workload failed',
    );
  }
  runnerSequence.push('workload-complete');
  const markerBytes = {
    ready: readPrivateFile(paths.ready, outputStat.mtimeMs),
    start: readPrivateFile(paths.start, outputStat.mtimeMs),
    recovery: readPrivateFile(paths.recovery, outputStat.mtimeMs),
  };
  if (
    !readyBytes?.equals(markerBytes.ready) ||
    !startBytes?.equals(markerBytes.start) ||
    !recoveryBytes?.equals(markerBytes.recovery)
  )
    throw new Error('fault marker replaced after observation');
  const rawBytes = readPrivateFile(paths.raw, outputStat.mtimeMs);
  const processGroupBytes = readPrivateFile(paths.processGroup, outputStat.mtimeMs);
  const expectedFiles = [
    'processGroup.json',
    'raw.json',
    'ready.json',
    'recovery.json',
    'start.json',
  ];
  if (canonicalJson(readdirSync(resolvedOutput).sort()) !== canonicalJson(expectedFiles))
    throw new Error('unexpected Temporal fault evidence file inventory');
  const evidence = createTemporalFaultEvidence({
    config,
    profile,
    gitSha,
    containerId,
    rawBytes,
    outageMilliseconds,
    recoveryMilliseconds,
    nonce: paths.nonce,
    markers: markerBytes,
    runnerSequence,
    processGroupBytes,
  });
  writeFileSync(
    path.join(resolvedOutput, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  const finalFiles = ['evidence.json', ...expectedFiles].sort();
  if (canonicalJson(readdirSync(resolvedOutput).sort()) !== canonicalJson(finalFiles))
    throw new Error('final Temporal fault evidence file inventory changed');
  for (const name of finalFiles)
    readPrivateFile(path.join(resolvedOutput, name), outputStat.mtimeMs);
  return evidence;
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`invalid option ${key || '<missing>'}`);
    result[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const input = options(argv);
  if (input.cleanupMarker) return cleanupRecordedProcessGroup(path.resolve(input.cleanupMarker));
  const config = validateTemporalFaultConfig(
    JSON.parse(readFileSync(path.resolve(input.config), 'utf8')),
  );
  const profile = config.profiles.find(({ id }) => id === input.profile);
  if (!profile) throw new Error('unknown Temporal fault profile');
  return runTemporalFault({
    config,
    profile,
    outputDirectory: path.resolve(input.output),
    gitSha: input.gitSha,
    containerId: input.containerId,
    authorization: input.authorization,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
