#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import scenarioSchema from './performance-scenario.schema.json' with { type: 'json' };
import {
  aggregatePerformanceEvidence,
  canonicalJson,
  createPerformanceSample,
  sha256,
} from './performance-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_SCHEMA_VERSION = 'tixkit-performance-scenarios-v1';
const RUN_SCHEMA_VERSION = 'tixkit-performance-scenario-run-v1';
const FAILURE_SCHEMA_VERSION = 'tixkit-performance-scenario-failure-v1';
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
const ajv = new Ajv2020({ strict: true, formats: { 'date-time': true } });
const validateConfigSchema = ajv.compile(scenarioSchema);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireFiniteNumber(value, label, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}`);
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
    for (const [key, entry] of Object.entries(value)) requireJsonValue(entry, `${label}.${key}`);
    return;
  }
  throw new Error(`${label} must be JSON-compatible`);
}

function budgetMap(config) {
  if (!Array.isArray(config?.metrics) || config.metrics.length === 0) {
    throw new Error('budget config must contain metrics');
  }
  const budgets = new Map();
  for (const budget of config.metrics) {
    const metric = requireString(budget?.metric, 'budget metric');
    if (budgets.has(metric)) throw new Error(`duplicate budget metric ${metric}`);
    if (
      (typeof budget.max !== 'number' || !Number.isFinite(budget.max)) &&
      (typeof budget.min !== 'number' || !Number.isFinite(budget.min))
    ) {
      throw new Error(`budget ${metric} must define a finite min or max`);
    }
    budgets.set(metric, budget);
  }
  return budgets;
}

export function validateScenarioConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('scenario config must be an object');
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`scenario config must use ${CONFIG_SCHEMA_VERSION}`);
  }
  if (!validateConfigSchema(config)) {
    const issue = validateConfigSchema.errors?.[0];
    throw new Error(
      `scenario config schema violation at ${issue?.instancePath || '/'}: ${issue?.message || 'invalid value'}`,
    );
  }
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) {
    throw new Error('scenario config must contain scenarios');
  }
  const ids = new Set();
  for (const [index, scenario] of config.scenarios.entries()) {
    const label = `scenarios[${index}]`;
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error(`${label} must be an object`);
    }
    const id = requireString(scenario.id, `${label}.id`);
    if (!/^[a-z0-9](?:[-a-z0-9]{0,62})$/.test(id)) throw new Error(`${label}.id is invalid`);
    if (ids.has(id)) throw new Error(`duplicate scenario id ${id}`);
    ids.add(id);
    requireString(scenario.profile, `${label}.profile`);
    const duration = requireInteger(scenario.durationSeconds, `${label}.durationSeconds`, 1, 86400);
    const interval = requireInteger(
      scenario.sampleIntervalSeconds,
      `${label}.sampleIntervalSeconds`,
      1,
      21600,
    );
    const count = requireInteger(scenario.sampleCount, `${label}.sampleCount`, 3, 144);
    const timeout = requireInteger(scenario.timeoutSeconds, `${label}.timeoutSeconds`, 1, 21600);
    if (duration !== interval * (count - 1)) {
      throw new Error(`${label}.durationSeconds must equal interval times sampleCount minus one`);
    }
    if (timeout >= interval) {
      throw new Error(`${label}.timeoutSeconds must be less than sampleIntervalSeconds`);
    }
    requireFiniteNumber(scenario.maxRegressionPercent, `${label}.maxRegressionPercent`, 0, 100);
    requireString(scenario.runnerLabel, `${label}.runnerLabel`);
    if (!scenario.database || typeof scenario.database !== 'object') {
      throw new Error(`${label}.database must be an object`);
    }
    if (!['postgresql', 'mysql'].includes(scenario.database.engine)) {
      throw new Error(`${label}.database.engine must be postgresql or mysql`);
    }
    requireString(scenario.database.version, `${label}.database.version`);
    if (
      !scenario.workload ||
      typeof scenario.workload !== 'object' ||
      Array.isArray(scenario.workload)
    ) {
      throw new Error(`${label}.workload must be an object`);
    }
    if (Object.keys(scenario.workload).length === 0) throw new Error(`${label}.workload is empty`);
    requireJsonValue(scenario.workload, `${label}.workload`);
    if (scenario.workload.processSamples !== count) {
      throw new Error(`${label}.workload.processSamples must equal sampleCount`);
    }
    requireString(scenario.budgets, `${label}.budgets`);
    if (!scenario.command || typeof scenario.command !== 'object') {
      throw new Error(`${label}.command must be an object`);
    }
    requireString(scenario.command.executable, `${label}.command.executable`);
    if (!Array.isArray(scenario.command.args) || scenario.command.args.length === 0) {
      throw new Error(`${label}.command.args must not be empty`);
    }
    const commandValues = [...scenario.command.args, ...Object.values(scenario.command.env ?? {})];
    commandValues.forEach((value, valueIndex) =>
      requireString(value, `${label}.command value ${valueIndex}`),
    );
    if (scenario.command.args.some((value) => value.includes('{metricsPath}'))) {
      throw new Error(`${label}.command.args must not contain {metricsPath}`);
    }
    if (scenario.command.env?.PERFORMANCE_METRICS_PATH !== '{metricsPath}') {
      throw new Error(`${label}.command.env.PERFORMANCE_METRICS_PATH must equal {metricsPath}`);
    }
    if (
      Object.entries(scenario.command.env).some(
        ([name, value]) => name !== 'PERFORMANCE_METRICS_PATH' && value.includes('{metricsPath}'),
      )
    ) {
      throw new Error(`${label}.command.env must not contain another {metricsPath}`);
    }
  }
  return config;
}

function substitute(value, replacements) {
  return Object.entries(replacements).reduce(
    (result, [name, replacement]) => result.replaceAll(`{${name}}`, replacement),
    value,
  );
}

function defaultSleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('performance scenario interrupted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function childEnvironment(declared = {}) {
  const inherited = Object.fromEntries(
    CHILD_ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [
      name,
      process.env[name],
    ]),
  );
  return { ...inherited, ...declared };
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

export function executeSampleProcess({
  scenario,
  metricsPath,
  sampleNumber,
  timeoutMilliseconds,
  signal,
}) {
  if (signal.aborted) return Promise.reject(new Error('performance scenario interrupted'));
  return new Promise((resolve, reject) => {
    const replacements = { metricsPath, sampleNumber: String(sampleNumber) };
    const declaredEnvironment = Object.fromEntries(
      Object.entries(scenario.command.env ?? {}).map(([name, value]) => [
        name,
        substitute(value, replacements),
      ]),
    );
    const child = spawn(
      scenario.command.executable,
      scenario.command.args.map((argument) => substitute(argument, replacements)),
      {
        cwd: root,
        detached: process.platform !== 'win32',
        env: childEnvironment(declaredEnvironment),
        stdio: 'inherit',
      },
    );
    let settled = false;
    let requestedError;
    let killTimer;
    let settleTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        try {
          resolve(readFileSync(metricsPath));
        } catch (readError) {
          reject(
            new Error(
              `sample ${sampleNumber} completed without readable metrics: ${readError?.code ?? 'read failed'}`,
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
        settleTimer = setTimeout(() => finish(requestedError), 25);
      }, 1_000);
    };
    const abort = () => {
      terminate(new Error('performance scenario interrupted'));
    };
    const timer = setTimeout(() => {
      terminate(new Error(`sample ${sampleNumber} exceeded ${timeoutMilliseconds}ms timeout`));
    }, timeoutMilliseconds);
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, childSignal) => {
      if (requestedError) {
        // The leader may exit on TERM while descendants remain in the process
        // group. The escalation timer owns settlement after the whole group is
        // sent SIGKILL.
        return;
      }
      if (code !== 0) {
        finish(
          new Error(
            `sample ${sampleNumber} command failed with ${childSignal ? `signal ${childSignal}` : `exit ${code}`}`,
          ),
        );
      } else {
        finish();
      }
    });
    if (signal.aborted) abort();
  });
}

function writeExclusiveJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function sanitizeFailureText(value) {
  return String(value)
    .replaceAll(/\b(bearer)\s+\S+/gi, '$1 [redacted]')
    .replaceAll(
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*\S+/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\b(postgres(?:ql)?|mysql):\/\/[^@\s]+@/gi, '$1://[redacted]@')
    .replaceAll(/[\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function createFailureArtifact({ scope, scenarioId, phase, error, failedAt }) {
  const payload = {
    schemaVersion: FAILURE_SCHEMA_VERSION,
    status: 'failed',
    scope,
    scenarioId: sanitizeFailureText(scenarioId || 'unknown').slice(0, 63),
    phase: sanitizeFailureText(phase || 'unknown').slice(0, 64),
    failedAt: new Date(failedAt).toISOString(),
    error: sanitizeFailureText(error instanceof Error ? error.message : error) || 'unknown failure',
  };
  return { ...payload, failureSha256: sha256(canonicalJson(payload)) };
}

export function eligibleBaselineRuns(runs, { workflowPath, defaultBranch, currentRunId }) {
  return runs.filter(
    (run) =>
      run.id !== currentRunId &&
      run.path === workflowPath &&
      run.head_branch === defaultBranch &&
      ['schedule', 'workflow_dispatch'].includes(run.event) &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(run.head_sha),
  );
}

export async function runPerformanceScenario({
  scenario,
  outputDirectory,
  gitSha,
  baseline,
  baselineGitSha,
  executeSample = executeSampleProcess,
  sleep = defaultSleep,
  now = () => Date.now(),
  signal = new AbortController().signal,
}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) {
    throw new Error('gitSha must be a lowercase 40- or 64-character Git SHA');
  }
  if (baseline !== undefined && baseline.identity?.gitSha !== baselineGitSha) {
    throw new Error('baseline evidence Git SHA does not match its workflow run head SHA');
  }
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const rawDirectory = path.join(outputDirectory, 'raw');
  mkdirSync(rawDirectory, { mode: 0o700 });
  const budgetPath = path.resolve(root, scenario.budgets);
  const budgets = budgetMap(readJson(budgetPath));
  const identity = {
    gitSha,
    runnerLabel: scenario.runnerLabel,
    database: scenario.database,
    profile: scenario.profile,
    workload: scenario.workload,
  };
  const intervalMilliseconds = scenario.sampleIntervalSeconds * 1000;
  const scheduledDurationMilliseconds = scenario.durationSeconds * 1000;
  const started = now();
  const samples = [];
  const sampleNames = [];
  const sampleStartedAt = [];

  for (let index = 0; index < scenario.sampleCount; index += 1) {
    if (signal.aborted) throw new Error('performance scenario interrupted');
    const target = started + index * intervalMilliseconds;
    await sleep(Math.max(0, target - now()), signal);
    if (signal.aborted) throw new Error('performance scenario interrupted');
    if (now() < target)
      throw new Error(`sample ${index + 1} started before its scheduled interval`);
    const sampleNumber = index + 1;
    const metricsPath = path.resolve(rawDirectory, `metrics-${sampleNumber}.json`);
    sampleStartedAt.push(new Date(now()).toISOString());
    const sourceBytes = await executeSample({
      scenario,
      metricsPath,
      sampleNumber,
      timeoutMilliseconds: scenario.timeoutSeconds * 1000,
      signal,
    });
    if (existsSync(metricsPath)) {
      if (!readFileSync(metricsPath).equals(Buffer.from(sourceBytes))) {
        throw new Error(`sample ${sampleNumber} returned bytes that differ from its metrics file`);
      }
    } else {
      writeFileSync(metricsPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    }
    const metrics = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
    const sample = createPerformanceSample({
      metrics,
      identity,
      budgets,
      sourceBytes,
    });
    const sampleName = `sample-${sampleNumber}.json`;
    writeExclusiveJson(path.join(rawDirectory, sampleName), sample);
    samples.push(sample);
    sampleNames.push(sampleName);
  }

  const completed = now();
  const durationMilliseconds = completed - started;
  if (durationMilliseconds < scheduledDurationMilliseconds) {
    throw new Error(
      `scenario completed after ${durationMilliseconds}ms before required ${scheduledDurationMilliseconds}ms duration`,
    );
  }
  const aggregate = aggregatePerformanceEvidence({
    samples,
    sampleNames,
    budgets,
    baseline,
    maxRegressionPercent: baseline === undefined ? undefined : scenario.maxRegressionPercent,
  });
  writeExclusiveJson(path.join(outputDirectory, 'evidence.json'), aggregate);
  const payload = {
    schemaVersion: RUN_SCHEMA_VERSION,
    status: 'passed',
    scenarioId: scenario.id,
    profile: scenario.profile,
    scenarioSha256: sha256(canonicalJson(scenario)),
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMilliseconds,
    scheduledDurationMilliseconds,
    sampleIntervalMilliseconds: intervalMilliseconds,
    sampleCount: samples.length,
    sampleStartedAt,
    aggregateSha256: sha256(canonicalJson(aggregate)),
    ...(baseline === undefined ? {} : { baselineEvidenceSha256: baseline.evidenceSha256 }),
  };
  const result = { ...payload, resultSha256: sha256(canonicalJson(payload)) };
  writeExclusiveJson(path.join(outputDirectory, 'scenario-run.json'), result);
  return { aggregate, result };
}

function optionMap(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option ${key ?? '<missing>'}`);
    }
    options[key.slice(2).replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionMap(argv);
  const configPath = path.resolve(requireString(options.config, 'config'));
  const config = validateScenarioConfig(readJson(configPath));
  const scenarioId = requireString(options.scenario, 'scenario');
  const scenario = config.scenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  const outputDirectory = path.resolve(requireString(options.output, 'output'));
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    return await runPerformanceScenario({
      scenario,
      outputDirectory,
      gitSha: requireString(options.gitSha, 'git SHA'),
      baseline: options.baseline ? readJson(path.resolve(options.baseline)) : undefined,
      baselineGitSha: options.baselineGitSha,
      signal: abortController.signal,
    });
  } catch (error) {
    try {
      writeExclusiveJson(
        path.join(outputDirectory, 'runner-failure.json'),
        createFailureArtifact({
          scope: 'runner',
          scenarioId,
          phase: 'scenario-execution',
          failedAt: Date.now(),
          error,
        }),
      );
    } catch {
      // Output creation or overwrite denial can fail before an evidence directory exists.
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
