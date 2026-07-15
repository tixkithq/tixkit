import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-scenario.schema.json' with { type: 'json' };
import {
  createFailureArtifact,
  eligibleBaselineRuns,
  executeSampleProcess,
  runPerformanceScenario,
  validateScenarioConfig,
} from '../performance-scenario.mjs';
import { canonicalJson, sha256 } from '../performance-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const committedConfig = JSON.parse(
  readFileSync(resolve(root, 'performance-scenarios.nightly.json'), 'utf8'),
);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-performance-scenario-'));
  const budgets = join(directory, 'budgets.json');
  writeFileSync(
    budgets,
    `${JSON.stringify({
      metrics: [
        { metric: 'latencyMs', max: 100, unit: 'ms' },
        { metric: 'throughput', min: 10, unit: 'requests/second' },
      ],
    })}\n`,
  );
  const scenario = {
    id: 'fixture-soak',
    profile: 'trusted-single-host-regression',
    durationSeconds: 4,
    sampleIntervalSeconds: 2,
    sampleCount: 3,
    timeoutSeconds: 1,
    maxRegressionPercent: 10,
    runnerLabel: 'fixture-runner',
    database: { engine: 'postgresql', version: '16-fixture' },
    workload: { concurrency: 8, processSamples: 3 },
    budgets,
    command: {
      executable: 'fixture',
      args: ['--output'],
      env: { PERFORMANCE_METRICS_PATH: '{metricsPath}' },
    },
  };
  return {
    directory,
    scenario,
    config: {
      schemaVersion: 'tixkit-performance-scenarios-v1',
      scenarios: [scenario],
    },
  };
}

function fakeRuntime(
  values = [
    [20, 20],
    [21, 21],
    [22, 22],
  ],
) {
  let milliseconds = Date.parse('2026-07-15T00:00:00.000Z');
  return {
    now: () => milliseconds,
    sleep: async (duration, signal) => {
      if (signal.aborted) throw new Error('performance scenario interrupted');
      milliseconds += duration;
    },
    executeSample: async ({ sampleNumber, signal }) => {
      if (signal.aborted) throw new Error('performance scenario interrupted');
      milliseconds += 10;
      const [latencyMs, throughput] = values[sampleNumber - 1];
      return Buffer.from(`${JSON.stringify({ latencyMs, throughput })}\n`);
    },
  };
}

function validateRunArtifact(value) {
  const ajv = new Ajv2020({ strict: true, formats: { 'date-time': true } });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/runArtifact`);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

function validateFailureArtifact(value) {
  const ajv = new Ajv2020({ strict: true, formats: { 'date-time': true } });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/failureArtifact`);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}

test('committed nightly scenarios satisfy the fail-closed schema and relational invariants', () => {
  assert.equal(validateScenarioConfig(committedConfig), committedConfig);
  assert.deepEqual(
    committedConfig.scenarios.map((scenario) => scenario.id),
    ['postgresql-trusted-soak', 'mysql-trusted-soak'],
  );
});

test('rejects underspecified, inconsistent, duplicate, and unbounded scenarios', () => {
  const { directory, config } = fixture();
  try {
    const missingProfile = structuredClone(config);
    delete missingProfile.scenarios[0].profile;
    assert.throws(() => validateScenarioConfig(missingProfile), /required property 'profile'/);

    const wrongDuration = structuredClone(config);
    wrongDuration.scenarios[0].durationSeconds = 5;
    assert.throws(() => validateScenarioConfig(wrongDuration), /durationSeconds must equal/);

    const wrongProcessSamples = structuredClone(config);
    wrongProcessSamples.scenarios[0].workload.processSamples = 4;
    assert.throws(() => validateScenarioConfig(wrongProcessSamples), /processSamples must equal/);

    const overlappingTimeout = structuredClone(config);
    overlappingTimeout.scenarios[0].timeoutSeconds = 2;
    assert.throws(() => validateScenarioConfig(overlappingTimeout), /must be less than/);

    const duplicate = structuredClone(config);
    duplicate.scenarios.push(structuredClone(duplicate.scenarios[0]));
    assert.throws(() => validateScenarioConfig(duplicate), /duplicate scenario id/);

    const noMetricsPath = structuredClone(config);
    noMetricsPath.scenarios[0].command.env.PERFORMANCE_METRICS_PATH = 'fixed.json';
    assert.throws(() => validateScenarioConfig(noMetricsPath), /must equal \{metricsPath\}/);

    for (const unsafe of [
      '{metricsPath}',
      "prefix-'\n{metricsPath}",
      '{metricsPath}{metricsPath}',
    ]) {
      const argumentInjection = structuredClone(config);
      argumentInjection.scenarios[0].command.args.push(unsafe);
      assert.throws(
        () => validateScenarioConfig(argumentInjection),
        /command\.args must not contain \{metricsPath\}/,
      );
    }

    const secondPlaceholder = structuredClone(config);
    secondPlaceholder.scenarios[0].command.env.UNRELATED = "prefix-'\n{metricsPath}";
    assert.throws(
      () => validateScenarioConfig(secondPlaceholder),
      /must not contain another \{metricsPath\}/,
    );

    const unknownField = structuredClone(config);
    unknownField.scenarios[0].unbounded = true;
    assert.throws(() => validateScenarioConfig(unknownField), /additional properties/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runs complete interval-bound samples and seals scenario, source, profile, and revision identity', async () => {
  const { directory, scenario } = fixture();
  const output = join(directory, 'run');
  try {
    const { aggregate, result } = await runPerformanceScenario({
      scenario,
      outputDirectory: output,
      gitSha: 'a'.repeat(40),
      ...fakeRuntime(),
    });
    assert.equal(result.sampleCount, 3);
    assert.ok(result.durationMilliseconds >= 4_000);
    assert.equal(result.profile, scenario.profile);
    assert.equal(aggregate.identity.profile, scenario.profile);
    assert.equal(aggregate.identity.gitSha, 'a'.repeat(40));
    assert.deepEqual(aggregate.identity.workload, scenario.workload);
    assert.equal(result.aggregateSha256, sha256(canonicalJson(aggregate)));
    const { resultSha256, ...payload } = result;
    assert.equal(resultSha256, sha256(canonicalJson(payload)));
    assert.equal(result.sampleStartedAt.length, 3);
    assert.equal(readFileSync(join(output, 'raw', 'metrics-1.json'), 'utf8').length > 0, true);
    validateRunArtifact(result);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts only a compatible checksum-valid baseline and fails median regression', async () => {
  const { directory, scenario } = fixture();
  try {
    const baselineRun = await runPerformanceScenario({
      scenario,
      outputDirectory: join(directory, 'baseline'),
      gitSha: 'a'.repeat(40),
      ...fakeRuntime([
        [20, 20],
        [20, 20],
        [20, 20],
      ]),
    });
    const current = await runPerformanceScenario({
      scenario,
      outputDirectory: join(directory, 'current'),
      gitSha: 'b'.repeat(40),
      baseline: baselineRun.aggregate,
      baselineGitSha: 'a'.repeat(40),
      ...fakeRuntime([
        [21, 20],
        [21, 20],
        [21, 20],
      ]),
    });
    assert.equal(current.aggregate.regression.maxRegressionPercent, 10);
    assert.equal(current.result.baselineEvidenceSha256, baselineRun.aggregate.evidenceSha256);

    await assert.rejects(
      runPerformanceScenario({
        scenario,
        outputDirectory: join(directory, 'wrong-run-sha'),
        gitSha: 'b'.repeat(40),
        baseline: baselineRun.aggregate,
        baselineGitSha: 'd'.repeat(40),
        ...fakeRuntime(),
      }),
      /does not match its workflow run head SHA/,
    );

    const tampered = structuredClone(baselineRun.aggregate);
    tampered.metrics.latencyMs.median = 1;
    await assert.rejects(
      runPerformanceScenario({
        scenario,
        outputDirectory: join(directory, 'tampered'),
        gitSha: 'b'.repeat(40),
        baseline: tampered,
        baselineGitSha: 'a'.repeat(40),
        ...fakeRuntime(),
      }),
      /baseline evidence checksum mismatch/,
    );

    await assert.rejects(
      runPerformanceScenario({
        scenario,
        outputDirectory: join(directory, 'regressed'),
        gitSha: 'b'.repeat(40),
        baseline: baselineRun.aggregate,
        baselineGitSha: 'a'.repeat(40),
        ...fakeRuntime([
          [30, 20],
          [30, 20],
          [30, 20],
        ]),
      }),
      /aggregate median latencyMs regressed 50.00% beyond 10%/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selects only prior successful exact-workflow default-branch baselines', () => {
  const valid = {
    id: 8,
    path: '.github/workflows/performance-nightly.yml',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
  };
  const failedNewer = { ...valid, id: 10, conclusion: 'failure', head_sha: 'b'.repeat(40) };
  const eligibleOlder = { ...valid, id: 9, event: 'workflow_dispatch', head_sha: 'c'.repeat(40) };
  const candidates = eligibleBaselineRuns(
    [failedNewer, eligibleOlder, valid, { ...valid, id: 7, path: '.github/workflows/other.yml' }],
    {
      workflowPath: '.github/workflows/performance-nightly.yml',
      defaultBranch: 'main',
      currentRunId: 8,
    },
  );
  assert.deepEqual(
    candidates.map((run) => run.id),
    [9],
    'a failed newest run must not poison recovery from the prior successful run',
  );
  for (const invalid of [
    { ...valid, id: 11, head_branch: 'feature' },
    { ...valid, id: 12, event: 'pull_request' },
    { ...valid, id: 13, status: 'in_progress' },
    { ...valid, id: 14, head_sha: 'invalid' },
  ]) {
    assert.deepEqual(
      eligibleBaselineRuns([invalid], {
        workflowPath: '.github/workflows/performance-nightly.yml',
        defaultBranch: 'main',
        currentRunId: 99,
      }),
      [],
    );
  }
});

test('workflow and scenarios keep runner, database, selection, and early-evidence contracts aligned', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/performance-nightly.yml'), 'utf8');
  assert.match(workflow, /runs-on: tixkit-epyc-trusted/);
  assert.ok(
    workflow.indexOf('Create unique evidence root') <
      workflow.indexOf('Reject untrusted invocation before checkout'),
  );
  assert.ok(
    workflow.indexOf('Reject untrusted invocation before checkout') <
      workflow.indexOf('actions/checkout@'),
  );
  assert.match(workflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /schedule\|workflow_dispatch/);
  assert.match(workflow, /INVOCATION_OUTCOME: \$\{\{ steps\.invocation\.outcome \}\}/);
  assert.match(
    workflow,
    /actions\/workflows\/performance-nightly\.yml\/runs\?branch=\$\{default_branch\}&status=success/,
  );
  assert.match(workflow, /actions\/runs\/\$\{run_id\}\/artifacts/);
  assert.doesNotMatch(workflow, /\n      GH_TOKEN:/, 'GH_TOKEN must not be job-scoped');
  assert.match(workflow, /if: \$\{\{ always\(\) && job\.status != 'success' \}\}/);
  for (const scenario of committedConfig.scenarios) {
    assert.equal(scenario.runnerLabel, 'tixkit-epyc-trusted');
    assert.match(workflow, new RegExp(scenario.id, 'u'));
    assert.match(
      workflow,
      new RegExp(scenario.database.version.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'),
    );
    assert.equal(scenario.workload.processSamples, scenario.sampleCount);
    assert.ok(Object.values(scenario.command.env).some((value) => value === '{metricsPath}'));
    assert.ok(scenario.command.args.every((value) => !value.includes('{metricsPath}')));
  }
});

test('failure artifacts are bounded, sanitized, checksummed, and schema-valid', () => {
  const failure = createFailureArtifact({
    scope: 'workflow',
    scenarioId: `scenario\n${'x'.repeat(100)}`,
    phase: `migration\n${'y'.repeat(100)}`,
    failedAt: '2026-07-15T00:00:00.000Z',
    error: `TOKEN=super-secret postgres://user:password@localhost/db\n${'z'.repeat(600)}`,
  });
  assert.ok(failure.error.length <= 500);
  assert.doesNotMatch(failure.error, /[\r\n]/);
  assert.doesNotMatch(failure.error, /super-secret|user:password/);
  assert.ok(failure.phase.length <= 64);
  const { failureSha256, ...payload } = failure;
  assert.equal(failureSha256, sha256(canonicalJson(payload)));
  validateFailureArtifact(failure);
});

test('real child execution isolates environment and safely passes hostile metrics paths', async () => {
  const directory = mkdtempSync(join(tmpdir(), "tixkit-performance-'hostile\n"));
  const metricsPath = join(directory, "metrics-'unsafe\n.json");
  const previous = process.env.TIXKIT_SENTINEL_SECRET;
  process.env.TIXKIT_SENTINEL_SECRET = 'must-not-leak';
  try {
    const scenario = {
      command: {
        executable: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs'); fs.writeFileSync(process.env.PERFORMANCE_METRICS_PATH, JSON.stringify({latencyMs:20,throughput:20,sentinelPresent:'TIXKIT_SENTINEL_SECRET' in process.env})+'\\n')",
        ],
        env: { PERFORMANCE_METRICS_PATH: '{metricsPath}' },
      },
    };
    const bytes = await executeSampleProcess({
      scenario,
      metricsPath,
      sampleNumber: 1,
      timeoutMilliseconds: 2_000,
      signal: new AbortController().signal,
    });
    assert.deepEqual(JSON.parse(bytes), {
      latencyMs: 20,
      throughput: 20,
      sentinelPresent: false,
    });
  } finally {
    if (previous === undefined) delete process.env.TIXKIT_SENTINEL_SECRET;
    else process.env.TIXKIT_SENTINEL_SECRET = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real child timeout and abort await escalation and kill SIGTERM-resistant descendants', async () => {
  if (process.platform === 'win32') return;
  for (const mode of ['timeout', 'abort']) {
    const directory = mkdtempSync(join(tmpdir(), `tixkit-performance-${mode}-`));
    const pidPath = join(directory, 'descendant.pid');
    const abortController = new AbortController();
    const scenario = {
      command: {
        executable: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs'),{spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)\"],{stdio:'ignore'}); fs.writeFileSync(process.env.PID_PATH,String(child.pid)); setInterval(()=>{},1000)",
        ],
        env: { PID_PATH: pidPath, PERFORMANCE_METRICS_PATH: '{metricsPath}' },
      },
    };
    const execution = executeSampleProcess({
      scenario,
      metricsPath: join(directory, 'missing.json'),
      sampleNumber: 1,
      timeoutMilliseconds: mode === 'timeout' ? 200 : 5_000,
      signal: abortController.signal,
    });
    if (mode === 'abort') setTimeout(() => abortController.abort(), 200);
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await delay(350);
    assert.equal(
      settled,
      false,
      'termination must remain pending through the SIGKILL grace period',
    );
    await assert.rejects(execution, mode === 'abort' ? /interrupted/ : /exceeded 200ms timeout/);
    const descendantPid = Number(readFileSync(pidPath, 'utf8'));
    await delay(50);
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real exit-zero missing metrics reaches main and writes distinct runner failure evidence', () => {
  const { directory, config } = fixture();
  const configPath = join(directory, 'config.json');
  const output = join(directory, 'failed-run');
  config.scenarios[0].command = {
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { PERFORMANCE_METRICS_PATH: '{metricsPath}' },
  };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/performance-scenario.mjs'),
        '--config',
        configPath,
        '--scenario',
        'fixture-soak',
        '--output',
        output,
        '--git-sha',
        'a'.repeat(40),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /completed without readable metrics/);
    assert.equal(existsSync(join(output, 'failure.json')), false);
    const failure = JSON.parse(readFileSync(join(output, 'runner-failure.json'), 'utf8'));
    assert.equal(failure.scope, 'runner');
    validateFailureArtifact(failure);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects missing and extra metrics, source tampering, and identity drift', async () => {
  const cases = [
    ['missing', { latencyMs: 20 }, /missing: throughput/],
    ['extra', { latencyMs: 20, throughput: 20, surprise: 1 }, /extra: surprise/],
  ];
  for (const [name, metrics, pattern] of cases) {
    const { directory, scenario } = fixture();
    try {
      await assert.rejects(
        runPerformanceScenario({
          scenario,
          outputDirectory: join(directory, name),
          gitSha: 'a'.repeat(40),
          ...fakeRuntime(),
          executeSample: async () => Buffer.from(`${JSON.stringify(metrics)}\n`),
        }),
        pattern,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const source = fixture();
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: source.scenario,
        outputDirectory: join(source.directory, 'source-tamper'),
        gitSha: 'a'.repeat(40),
        ...fakeRuntime(),
        executeSample: async ({ metricsPath }) => {
          const returned = Buffer.from('{"latencyMs":20,"throughput":20}\n');
          writeFileSync(metricsPath, '{"latencyMs":99,"throughput":20}\n');
          return returned;
        },
      }),
      /returned bytes that differ/,
    );
  } finally {
    rmSync(source.directory, { recursive: true, force: true });
  }

  const drift = fixture();
  const runtime = fakeRuntime();
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: drift.scenario,
        outputDirectory: join(drift.directory, 'identity-drift'),
        gitSha: 'a'.repeat(40),
        ...runtime,
        executeSample: async (input) => {
          if (input.sampleNumber === 2) drift.scenario.database.engine = 'mysql';
          return runtime.executeSample(input);
        },
      }),
      /sample-2.json identity mismatch/,
    );
  } finally {
    rmSync(drift.directory, { recursive: true, force: true });
  }
});

test('fails closed on interruption, timeout, early completion, and output overwrite', async () => {
  const interrupted = fixture();
  const abortController = new AbortController();
  const runtime = fakeRuntime();
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: interrupted.scenario,
        outputDirectory: join(interrupted.directory, 'interrupted'),
        gitSha: 'a'.repeat(40),
        signal: abortController.signal,
        ...runtime,
        executeSample: async (input) => {
          const result = await runtime.executeSample(input);
          abortController.abort();
          return result;
        },
      }),
      /interrupted/,
    );
  } finally {
    rmSync(interrupted.directory, { recursive: true, force: true });
  }

  const timedOut = fixture();
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: timedOut.scenario,
        outputDirectory: join(timedOut.directory, 'timeout'),
        gitSha: 'a'.repeat(40),
        ...fakeRuntime(),
        executeSample: async ({ timeoutMilliseconds }) => {
          throw new Error(`sample exceeded ${timeoutMilliseconds}ms timeout`);
        },
      }),
      /exceeded 1000ms timeout/,
    );
  } finally {
    rmSync(timedOut.directory, { recursive: true, force: true });
  }

  const early = fixture();
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: early.scenario,
        outputDirectory: join(early.directory, 'early'),
        gitSha: 'a'.repeat(40),
        now: () => Date.parse('2026-07-15T00:00:00.000Z'),
        sleep: async () => {},
        executeSample: async () => Buffer.from('{"latencyMs":20,"throughput":20}\n'),
      }),
      /started before its scheduled interval/,
    );
  } finally {
    rmSync(early.directory, { recursive: true, force: true });
  }

  const overwrite = fixture();
  const output = join(overwrite.directory, 'existing');
  writeFileSync(output, 'reserved');
  try {
    await assert.rejects(
      runPerformanceScenario({
        scenario: overwrite.scenario,
        outputDirectory: output,
        gitSha: 'a'.repeat(40),
        ...fakeRuntime(),
      }),
      /EEXIST/,
    );
  } finally {
    rmSync(overwrite.directory, { recursive: true, force: true });
  }
});
