import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-fault.schema.json' with { type: 'json' };
import {
  createFaultEvidence,
  executeFaultScenario,
  parseFaultOptions,
  runFaultCharacterization,
  validateFaultConfig,
  validateFaultEvidence,
} from '../performance-fault.mjs';
import { probeRunnerFingerprint } from '../performance-capacity.mjs';
import { canonicalJson, sha256 } from '../performance-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const committed = JSON.parse(readFileSync(resolve(root, 'performance-faults.trusted.json')));
const workflow = readFileSync(resolve(root, '.github/workflows/performance-fault.yml'), 'utf8');
const authorization =
  'I authorize controlled database service interruption on the dedicated trusted runner';
const runnerFingerprint = probeRunnerFingerprint({
  platform: 'linux',
  architecture: 'x64',
  cpuModels: ['AMD EPYC test', 'AMD EPYC test'],
  logicalCpuCount: 2,
  totalMemoryBytes: 64 * 1024 * 1024 * 1024,
});
const expectedRunnerFingerprintSha256 = runnerFingerprint.sha256;

function identityInput() {
  return {
    runnerFingerprint,
    expectedRunnerFingerprintSha256,
  };
}

function configFixture() {
  return structuredClone(committed);
}

function metrics(profile) {
  const identitySha = '1'.repeat(64);
  return Buffer.from(
    `${JSON.stringify({
      providerScope: 'not-exercised',
      faultPhase: {
        attempts: profile.faultAttempts,
        successes: 0,
        expectedInventoryDeclines: 0,
        dependencyFailures: profile.faultAttempts,
        providerFailures: 0,
        unexpectedPlatformFailures: 0,
      },
      replayPhase: {
        attempts: profile.faultAttempts,
        successes: profile.faultAttempts,
        expectedInventoryDeclines: 0,
        dependencyFailures: 0,
        providerFailures: 0,
        unexpectedPlatformFailures: 0,
      },
      reconciliation: {
        preReplayActiveHolds: 0,
        totalCapacity: profile.inventory,
        activeHeldQuantity: profile.faultAttempts,
        uniqueSessions: profile.faultAttempts,
        duplicateIdentities: 0,
        partialStatusCount: 0,
        unknownStatusCount: 0,
        soldCount: 0,
        oversold: false,
      },
      identitySets: { originalSha256: identitySha, replaySha256: identitySha, identical: true },
    })}\n`,
  );
}

function proof(profile) {
  return {
    databaseStopped: true,
    databaseRecovered: true,
    injectionAfterReady: true,
    restorationAfterFaultObserved: true,
    databaseStopDurationMs: 125,
    databaseRecoveryDurationMs: 850,
    recoveryThresholdSeconds: profile.markerTimeoutSeconds,
    sameDatabaseContainer: true,
  };
}

function fakeRuntime({ bunSource, stateOverrides = {} }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-fault-fake-'));
  const bin = join(temporaryRoot, 'bin');
  const controlDirectory = join(temporaryRoot, 'control');
  const statePath = join(temporaryRoot, 'docker-state.json');
  const descendantPath = join(temporaryRoot, 'descendant.pid');
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(controlDirectory, { mode: 0o700 });
  const profile = { ...committed.profiles[0], timeoutSeconds: 4, markerTimeoutSeconds: 1 };
  const containerId = 'f'.repeat(64);
  writeFileSync(
    statePath,
    JSON.stringify({
      id: containerId,
      image: profile.database.image,
      running: true,
      healthy: true,
      operations: [],
      ...stateOverrides,
    }),
  );
  const dockerPath = join(bin, 'docker');
  writeFileSync(
    dockerPath,
    `#!/usr/bin/env node
const fs=require('node:fs'); const p=process.env.DOCKER_HOST; const s=JSON.parse(fs.readFileSync(p)); const a=process.argv.slice(2); const save=()=>fs.writeFileSync(p,JSON.stringify(s));
if(a[0]==='inspect') process.stdout.write(JSON.stringify([{Id:s.id,Image:'sha256:${'e'.repeat(64)}',Config:{Image:s.image},State:{Running:s.running,Health:{Status:s.healthy?'healthy':'unhealthy'}}}]));
else if(a[0]==='stop'){s.running=false;s.healthy=false;s.operations.push('stop');save();if(s.failStop)process.exit(7);}
else if(a[0]==='start'){s.operations.push('start');if(s.failStart){save();process.exit(8);}s.running=true;s.healthy=s.recoverHealthy!==false;save();process.stdout.write(s.id);}
else process.exit(9);
`,
    { mode: 0o700 },
  );
  chmodSync(dockerPath, 0o700);
  const bunPath = join(bin, 'bun');
  writeFileSync(
    bunPath,
    `#!/usr/bin/env node\n${bunSource.replaceAll('{descendantPath}', JSON.stringify(descendantPath))}\n`,
    { mode: 0o700 },
  );
  chmodSync(bunPath, 0o700);
  const previousPath = process.env.PATH;
  const previousDockerHost = process.env.DOCKER_HOST;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.DOCKER_HOST = statePath;
  return {
    profile,
    containerId,
    controlDirectory,
    statePath,
    descendantPath,
    metricsPath: join(temporaryRoot, 'metrics.json'),
    ...identityInput(),
    cleanup() {
      process.env.PATH = previousPath;
      if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousDockerHost;
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

test('committed profiles are exact authorized 64-attempt pinned-digest contracts', () => {
  assert.equal(validateFaultConfig(committed), committed);
  assert.deepEqual(
    committed.profiles.map(({ id }) => id),
    ['postgresql-trusted-host-database-loss', 'mysql-trusted-host-database-loss'],
  );
  for (const profile of committed.profiles) {
    assert.equal(profile.runnerLabel, 'tixkit-epyc-trusted');
    assert.equal(profile.inventory, 64);
    assert.equal(profile.faultAttempts, 64);
    assert.equal(profile.authorizationPhrase, authorization);
    assert.match(profile.database.image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(profile.command.env.FAULT_LOAD, '1');
  }
});

test('schema accepts committed config and fully derived evidence', () => {
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(committed), true, JSON.stringify(validate.errors));
  const profile = committed.profiles[0];
  const evidence = createFaultEvidence({
    config: committed,
    profile,
    gitSha: 'a'.repeat(40),
    rawMetrics: metrics(profile),
    faultProof: proof(profile),
    ...identityInput(),
  });
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(evidence.schemaVersion, 'tixkit-performance-fault-evidence-v2');
  assert.equal(
    validate({ ...evidence, schemaVersion: 'tixkit-performance-fault-evidence-v1' }),
    false,
  );
  assert.deepEqual(evidence.denials, [
    'Production availability',
    'Production fault tolerance',
    'Cloud availability',
    'Compact availability',
    'provider resilience',
    'Temporal resilience',
    'SLA or RTO claim',
  ]);
});

test('evidence binds config, workload, raw metrics, orchestration, and payload checksums', () => {
  const profile = committed.profiles[0];
  const rawMetrics = metrics(profile);
  const evidence = createFaultEvidence({
    config: committed,
    profile,
    gitSha: 'b'.repeat(40),
    rawMetrics,
    faultProof: proof(profile),
    ...identityInput(),
  });
  assert.equal(evidence.identity.configSha256, sha256(canonicalJson(committed)));
  assert.deepEqual(evidence.identity.runnerFingerprint, runnerFingerprint);
  assert.equal(evidence.rawSha256, sha256(rawMetrics));
  const { evidenceSha256, ...payload } = evidence;
  assert.equal(evidenceSha256, sha256(canonicalJson(payload)));
  assert.equal(
    validateFaultEvidence({
      config: committed,
      evidence,
      rawMetrics,
      expectedRunnerFingerprintSha256,
    }),
    evidence,
  );
  const tampered = structuredClone(evidence);
  tampered.metrics.reconciliation.activeHeldQuantity -= 1;
  assert.throws(() =>
    validateFaultEvidence({
      config: committed,
      evidence: tampered,
      rawMetrics,
      expectedRunnerFingerprintSha256,
    }),
  );
  const tamperedRunner = structuredClone(evidence);
  tamperedRunner.identity.runnerFingerprint.sha256 = '0'.repeat(64);
  assert.throws(
    () =>
      validateFaultEvidence({
        config: committed,
        evidence: tamperedRunner,
        rawMetrics,
        expectedRunnerFingerprintSha256,
      }),
    /does not match/u,
  );
});

test('fault and replay phase categories, identity sets, and reconciliation fail closed', () => {
  const profile = committed.profiles[0];
  const mutations = [
    (value) => (value.faultPhase.dependencyFailures -= 1),
    (value) => (value.faultPhase.unexpectedPlatformFailures = 1),
    (value) => (value.replayPhase.successes -= 1),
    (value) => (value.replayPhase.providerFailures = 1),
    (value) => (value.reconciliation.preReplayActiveHolds = 1),
    (value) => (value.reconciliation.duplicateIdentities = 1),
    (value) => (value.reconciliation.partialStatusCount = 1),
    (value) => (value.reconciliation.unknownStatusCount = 1),
    (value) => (value.reconciliation.oversold = true),
    (value) => (value.identitySets.replaySha256 = '2'.repeat(64)),
    (value) => (value.extra = true),
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(metrics(profile));
    mutate(value);
    assert.throws(() =>
      createFaultEvidence({
        config: committed,
        profile,
        gitSha: 'c'.repeat(40),
        rawMetrics: Buffer.from(JSON.stringify(value)),
        faultProof: proof(profile),
        ...identityInput(),
      }),
    );
  }
});

test('ordering, same-container recovery, duration, and recovery threshold proof fail closed', () => {
  const profile = committed.profiles[0];
  for (const mutate of [
    (value) => (value.injectionAfterReady = false),
    (value) => (value.restorationAfterFaultObserved = false),
    (value) => (value.sameDatabaseContainer = false),
    (value) => (value.databaseStopDurationMs = 0),
    (value) => (value.databaseRecoveryDurationMs = profile.markerTimeoutSeconds * 1_000 + 1),
    (value) => (value.recoveryThresholdSeconds -= 1),
  ]) {
    const candidate = proof(profile);
    mutate(candidate);
    assert.throws(() =>
      createFaultEvidence({
        config: committed,
        profile,
        gitSha: 'd'.repeat(40),
        rawMetrics: metrics(profile),
        faultProof: candidate,
        ...identityInput(),
      }),
    );
  }
});

test('config rejects scope, schema, authorization, workload, env, and duplicate drift', () => {
  for (const mutate of [
    (value) => (value.claimScope = 'general-fault'),
    (value) => (value.$schema = 'elsewhere.json'),
    (value) => (value.profiles[0].runnerLabel = 'untrusted-runner'),
    (value) => (value.profiles[0].authorizationPhrase = 'yes'),
    (value) => (value.profiles[0].inventory = 63),
    (value) => (value.profiles[0].faultAttempts = 63),
    (value) => (value.profiles[0].command.env.EXTRA = '1'),
    (value) => value.profiles.push(structuredClone(value.profiles[0])),
  ]) {
    const candidate = configFixture();
    mutate(candidate);
    assert.throws(() => validateFaultConfig(candidate));
  }
});

test('runner identity fails before output creation or scenario execution', async () => {
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tixkit-fault-identity-')));
  const profile = committed.profiles[0];
  let executions = 0;
  try {
    for (const expected of [undefined, 'not-a-digest', '0'.repeat(64)]) {
      const outputDirectory = join(temporaryRoot, `evidence-${executions}`);
      await assert.rejects(
        runFaultCharacterization({
          config: committed,
          profile,
          outputDirectory,
          gitSha: 'e'.repeat(40),
          containerId: 'a'.repeat(64),
          authorization,
          expectedRunnerFingerprintSha256: expected,
          probeRunner: () => runnerFingerprint,
          executeScenario: async () => {
            executions += 1;
            assert.fail('scenario must not execute before runner identity validation');
          },
        }),
        expected === '0'.repeat(64) ? /does not match/u : /lowercase SHA-256 digest/u,
      );
      assert.throws(() => statSync(outputDirectory), /ENOENT/u);
    }
    assert.equal(executions, 0);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('CLI requires one well-formed value for every supported fault option', () => {
  const argv = [
    '--config',
    'performance-faults.trusted.json',
    '--profile',
    'postgresql-trusted-host-database-loss',
    '--output',
    '/tmp/fault-evidence',
    '--git-sha',
    'a'.repeat(40),
    '--container-id',
    'b'.repeat(64),
    '--authorization',
    authorization,
    '--expected-runner-fingerprint',
    'c'.repeat(64),
  ];
  assert.deepEqual(parseFaultOptions(argv), {
    config: 'performance-faults.trusted.json',
    profile: 'postgresql-trusted-host-database-loss',
    output: '/tmp/fault-evidence',
    gitSha: 'a'.repeat(40),
    containerId: 'b'.repeat(64),
    authorization,
    expectedRunnerFingerprint: 'c'.repeat(64),
  });
  assert.throws(
    () => parseFaultOptions(argv.slice(0, -2)),
    /missing required fault option --expected-runner-fingerprint/u,
  );
  assert.throws(
    () => parseFaultOptions([...argv, '--profile', 'mysql-trusted-host-database-loss']),
    /duplicate fault option/u,
  );
  assert.throws(() => parseFaultOptions([...argv, '--unknown', 'value']), /unknown fault option/u);
  assert.throws(() => parseFaultOptions(argv.slice(0, -1)), /require a value for every flag/u);
});

test('low-level executor rejects runner drift before launching or injecting a fault', async () => {
  const runtime = fakeRuntime({
    bunSource: `throw new Error('fault harness must not launch');`,
  });
  try {
    await assert.rejects(
      executeFaultScenario({
        ...runtime,
        expectedRunnerFingerprintSha256: '0'.repeat(64),
        signal: new AbortController().signal,
      }),
      /does not match/u,
    );
    const state = JSON.parse(readFileSync(runtime.statePath));
    assert.deepEqual(state.operations, []);
    assert.equal(state.running, true);
  } finally {
    runtime.cleanup();
  }
});

test('runner requires exact authorization, private exclusive output, and source-identical metrics', async () => {
  const profile = committed.profiles[0];
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tixkit-fault-')));
  const output = join(temporaryRoot, 'evidence');
  try {
    await assert.rejects(
      runFaultCharacterization({
        config: committed,
        profile,
        outputDirectory: output,
        gitSha: 'e'.repeat(40),
        containerId: 'a'.repeat(64),
        authorization: 'wrong',
        expectedRunnerFingerprintSha256,
        probeRunner: () => runnerFingerprint,
        executeScenario: async () => assert.fail('must not execute without authorization'),
      }),
      /authorization/,
    );
    const executeScenario = async ({ metricsPath }) => {
      const rawMetrics = metrics(profile);
      writeFileSync(metricsPath, rawMetrics, { flag: 'wx', mode: 0o600 });
      return { rawMetrics, faultProof: proof(profile) };
    };
    const evidence = await runFaultCharacterization({
      config: committed,
      profile,
      outputDirectory: output,
      gitSha: 'e'.repeat(40),
      containerId: 'a'.repeat(64),
      authorization,
      expectedRunnerFingerprintSha256,
      probeRunner: () => runnerFingerprint,
      executeScenario,
    });
    assert.equal(evidence.metrics.replayPhase.successes, 64);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'raw-metrics.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(output, 'evidence.json')).mode & 0o777, 0o600);
    await assert.rejects(
      runFaultCharacterization({
        config: committed,
        profile,
        outputDirectory: output,
        gitSha: 'e'.repeat(40),
        containerId: 'a'.repeat(64),
        authorization,
        expectedRunnerFingerprintSha256,
        probeRunner: () => runnerFingerprint,
        executeScenario,
      }),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('workflow is serial, trusted, default-branch-only, digest-pinned, authorized, and retains failures', () => {
  assert.match(workflow, /runs-on: tixkit-epyc-trusted/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /default branch/);
  assert.match(workflow, /job\.services\.database\.id/);
  assert.match(workflow, /--authorization/);
  assert.match(
    workflow,
    /I authorize controlled database service interruption on the dedicated trusted runner/,
  );
  assert.match(workflow, /@sha256:[a-f0-9]{64}/);
  assert.match(
    workflow,
    /command: \$\{\{ matrix\.profile == 'mysql-trusted-host-database-loss' && '--log-bin-trust-function-creators=1'/,
  );
  assert.match(workflow, /id: recovery\n\s+if: always\(\)/);
  assert.match(workflow, /DATABASE_CONTAINER_ID: \$\{\{ job\.services\.database\.id \}\}/);
  assert.match(workflow, /database did not recover healthy within 90 seconds/);
  assert.match(workflow, /RECOVERY_OUTCOME: \$\{\{ steps\.recovery\.outcome \}\}/);
  assert.match(
    workflow,
    /EXPECTED_RUNNER_FINGERPRINT_SHA256: \$\{\{ vars\.TIXKIT_EPYC_RUNNER_FINGERPRINT_SHA256 \}\}/u,
  );
  assert.match(workflow, /probeRunnerFingerprint/u);
  assert.match(workflow, /assertExpectedRunnerFingerprint/u);
  assert.match(workflow, /RUNNER_FINGERPRINT_SHA256=\$\{actual\.sha256\}/u);
  assert.match(workflow, /--expected-runner-fingerprint/u);
  assert.match(workflow, /IDENTITY_OUTCOME: \$\{\{ steps\.identity\.outcome \}\}/u);
  assert.match(
    workflow,
    /runnerFingerprint=runnerFingerprintSha256\?\{version:'tixkit-runner-fingerprint-v2',sha256:runnerFingerprintSha256\}:null/u,
  );
  assert.match(workflow, /schemaVersion:'tixkit-performance-fault-failure-v2'/u);
  assert.doesNotMatch(workflow, /pull_request|push:/);
});

test(
  'a stop command that fails after stopping still restores healthy and terminates the child',
  { timeout: 15_000 },
  async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-fault-runtime-'));
    const bin = join(temporaryRoot, 'bin');
    const controlDirectory = join(temporaryRoot, 'control');
    const statePath = join(temporaryRoot, 'docker-state.json');
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(controlDirectory, { mode: 0o700 });
    const profile = { ...committed.profiles[0], timeoutSeconds: 6, markerTimeoutSeconds: 3 };
    const containerId = 'a'.repeat(64);
    writeFileSync(
      statePath,
      JSON.stringify({
        id: containerId,
        image: profile.database.image,
        running: true,
        healthy: true,
        failStop: true,
        operations: [],
      }),
    );
    const dockerPath = join(bin, 'docker');
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env node
const fs=require('node:fs');
const statePath=process.env.DOCKER_HOST;
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const args=process.argv.slice(2);
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
if(args[0]==='inspect') {
  process.stdout.write(JSON.stringify([{Id:state.id,Image:'sha256:${'b'.repeat(64)}',Config:{Image:state.image},State:{Running:state.running,Health:{Status:state.healthy?'healthy':'unhealthy'}}}]));
} else if(args[0]==='stop') {
  state.running=false; state.healthy=false; state.operations.push('stop'); save();
  if(state.failStop) process.exit(7);
} else if(args[0]==='start') {
  state.running=true; state.healthy=true; state.operations.push('start'); save(); process.stdout.write(state.id);
} else { process.exit(9); }
`,
      { mode: 0o700 },
    );
    chmodSync(dockerPath, 0o700);
    const bunPath = join(bin, 'bun');
    writeFileSync(
      bunPath,
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.FAULT_CONTROL_DIRECTORY,'fault-ready'),'',{flag:'wx',mode:0o600});
setInterval(()=>{},1000);
`,
      { mode: 0o700 },
    );
    chmodSync(bunPath, 0o700);
    const previousPath = process.env.PATH;
    const previousDockerHost = process.env.DOCKER_HOST;
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.DOCKER_HOST = statePath;
    try {
      await assert.rejects(
        executeFaultScenario({
          profile,
          containerId,
          controlDirectory,
          metricsPath: join(temporaryRoot, 'metrics.json'),
          ...identityInput(),
          signal: new AbortController().signal,
        }),
      );
      const state = JSON.parse(readFileSync(statePath));
      assert.equal(state.running, true);
      assert.equal(state.healthy, true);
      assert.deepEqual(state.operations, ['stop', 'start']);
    } finally {
      process.env.PATH = previousPath;
      if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousDockerHost;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  'a post-recovery child hang is interrupted while the same database remains healthy',
  { timeout: 10_000 },
  async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-fault-hang-'));
    const bin = join(temporaryRoot, 'bin');
    const controlDirectory = join(temporaryRoot, 'control');
    const statePath = join(temporaryRoot, 'docker-state.json');
    mkdirSync(bin, { mode: 0o700 });
    mkdirSync(controlDirectory, { mode: 0o700 });
    const profile = { ...committed.profiles[0], timeoutSeconds: 2, markerTimeoutSeconds: 1 };
    const containerId = 'c'.repeat(64);
    writeFileSync(
      statePath,
      JSON.stringify({
        id: containerId,
        image: profile.database.image,
        running: true,
        healthy: true,
        operations: [],
      }),
    );
    const dockerPath = join(bin, 'docker');
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env node
const fs=require('node:fs'); const p=process.env.DOCKER_HOST; const s=JSON.parse(fs.readFileSync(p)); const a=process.argv.slice(2); const save=()=>fs.writeFileSync(p,JSON.stringify(s));
if(a[0]==='inspect') process.stdout.write(JSON.stringify([{Id:s.id,Image:'sha256:${'d'.repeat(64)}',Config:{Image:s.image},State:{Running:s.running,Health:{Status:s.healthy?'healthy':'unhealthy'}}}]));
else if(a[0]==='stop'){s.running=false;s.healthy=false;s.operations.push('stop');save();}
else if(a[0]==='start'){s.running=true;s.healthy=true;s.operations.push('start');save();process.stdout.write(s.id);}
else process.exit(9);
`,
      { mode: 0o700 },
    );
    chmodSync(dockerPath, 0o700);
    const bunPath = join(bin, 'bun');
    writeFileSync(
      bunPath,
      `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'); const dir=process.env.FAULT_CONTROL_DIRECTORY;
const wait=async name=>{while(!fs.existsSync(path.join(dir,name)))await new Promise(r=>setTimeout(r,20));};
(async()=>{fs.writeFileSync(path.join(dir,'fault-ready'),'',{flag:'wx',mode:0o600});await wait('fault-injected');const token=fs.readFileSync(path.join(dir,'fault-injected'),'utf8');fs.writeFileSync(path.join(dir,'fault-observed'),token,{flag:'wx',mode:0o600});await wait('database-recovered');if(fs.readFileSync(path.join(dir,'database-recovered'),'utf8')!==token)process.exit(8);setInterval(()=>{},1000);})();
`,
      { mode: 0o700 },
    );
    chmodSync(bunPath, 0o700);
    const previousPath = process.env.PATH;
    const previousDockerHost = process.env.DOCKER_HOST;
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.DOCKER_HOST = statePath;
    try {
      await assert.rejects(
        executeFaultScenario({
          profile,
          containerId,
          controlDirectory,
          metricsPath: join(temporaryRoot, 'metrics.json'),
          ...identityInput(),
          signal: new AbortController().signal,
        }),
        /timeout/,
      );
      const state = JSON.parse(readFileSync(statePath));
      assert.equal(state.running, true);
      assert.equal(state.healthy, true);
      assert.deepEqual(state.operations, ['stop', 'start']);
    } finally {
      process.env.PATH = previousPath;
      if (previousDockerHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousDockerHost;
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test(
  'an early observed marker fails before database interruption',
  { timeout: 10_000 },
  async () => {
    const runtime = fakeRuntime({
      bunSource: `const fs=require('node:fs'),path=require('node:path');const d=process.env.FAULT_CONTROL_DIRECTORY;fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(d,'fault-observed'),'early',{flag:'wx',mode:0o600});setInterval(()=>{},1000);`,
    });
    try {
      await assert.rejects(
        executeFaultScenario({ ...runtime, signal: new AbortController().signal }),
        /existed before its authorized protocol phase/,
      );
      const state = JSON.parse(readFileSync(runtime.statePath));
      assert.deepEqual(state.operations, []);
      assert.equal(state.running, true);
      assert.equal(state.healthy, true);
    } finally {
      runtime.cleanup();
    }
  },
);

test(
  'post-stop marker timeout and child exit both restore the exact database',
  { timeout: 15_000 },
  async () => {
    const cases = [
      `const fs=require('node:fs'),path=require('node:path');const d=process.env.FAULT_CONTROL_DIRECTORY;fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});const wait=async()=>{while(!fs.existsSync(path.join(d,'fault-injected')))await new Promise(r=>setTimeout(r,20));};(async()=>{await wait();setInterval(()=>{},1000)})();`,
      `const fs=require('node:fs'),path=require('node:path');const d=process.env.FAULT_CONTROL_DIRECTORY;fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});const wait=async()=>{while(!fs.existsSync(path.join(d,'fault-injected')))await new Promise(r=>setTimeout(r,20));};(async()=>{await wait();process.exit(7)})();`,
    ];
    for (const bunSource of cases) {
      const runtime = fakeRuntime({ bunSource });
      try {
        await assert.rejects(
          executeFaultScenario({ ...runtime, signal: new AbortController().signal }),
        );
        const state = JSON.parse(readFileSync(runtime.statePath));
        assert.deepEqual(state.operations, ['stop', 'start']);
        assert.equal(state.running, true);
        assert.equal(state.healthy, true);
      } finally {
        runtime.cleanup();
      }
    }
  },
);

test('external abort restores the database before rejecting', { timeout: 10_000 }, async () => {
  const runtime = fakeRuntime({
    bunSource: `const fs=require('node:fs'),path=require('node:path');const d=process.env.FAULT_CONTROL_DIRECTORY;fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});setInterval(()=>{},1000);`,
  });
  const controller = new AbortController();
  try {
    const scenario = executeFaultScenario({ ...runtime, signal: controller.signal });
    let stopped = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = JSON.parse(readFileSync(runtime.statePath));
      if (state.operations.includes('stop')) {
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(stopped, true, 'fault injection must begin before the external abort');
    controller.abort();
    await assert.rejects(scenario, /interrupted|timed out/);
    const state = JSON.parse(readFileSync(runtime.statePath));
    assert.deepEqual(state.operations, ['stop', 'start']);
    assert.equal(state.running, true);
    assert.equal(state.healthy, true);
  } finally {
    runtime.cleanup();
  }
});

test('primary and mandatory recovery failures are aggregated', { timeout: 10_000 }, async () => {
  const runtime = fakeRuntime({
    bunSource: `const fs=require('node:fs'),path=require('node:path');const d=process.env.FAULT_CONTROL_DIRECTORY;fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});setInterval(()=>{},1000);`,
    stateOverrides: { failStart: true },
  });
  try {
    await assert.rejects(
      executeFaultScenario({ ...runtime, signal: new AbortController().signal }),
      (error) => error instanceof AggregateError && error.errors.length >= 2,
    );
    const state = JSON.parse(readFileSync(runtime.statePath));
    assert.deepEqual(state.operations, ['stop', 'start']);
    assert.equal(state.running, false);
  } finally {
    runtime.cleanup();
  }
});

test(
  'SIGTERM-resistant descendants are killed with the harness process group',
  { timeout: 10_000 },
  async () => {
    const runtime = fakeRuntime({
      bunSource: `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');const d=process.env.FAULT_CONTROL_DIRECTORY;const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync({descendantPath},String(child.pid));fs.writeFileSync(path.join(d,'fault-ready'),'',{flag:'wx',mode:0o600});fs.writeFileSync(path.join(d,'fault-observed'),'early',{flag:'wx',mode:0o600});setInterval(()=>{},1000);`,
    });
    try {
      await assert.rejects(
        executeFaultScenario({ ...runtime, signal: new AbortController().signal }),
        /existed before its authorized protocol phase/,
      );
      const descendantPid = Number.parseInt(readFileSync(runtime.descendantPath, 'utf8'), 10);
      assert.throws(
        () => process.kill(descendantPid, 0),
        (error) => error?.code === 'ESRCH',
      );
    } finally {
      runtime.cleanup();
    }
  },
);

test('the workflow independent recovery command starts and health-checks the service', () => {
  const runtime = fakeRuntime({
    bunSource: '',
    stateOverrides: { running: false, healthy: false },
  });
  try {
    const command = workflow.match(
      /Always restore and verify the exact database service[\s\S]*?node -e "([^"\n]+)"/,
    )?.[1];
    assert.ok(command, 'workflow recovery command must remain directly executable');
    execFileSync(process.execPath, ['-e', command], {
      env: {
        ...process.env,
        DATABASE_CONTAINER_ID: runtime.containerId,
        EXPECTED_DATABASE_IMAGE: runtime.profile.database.image,
      },
      timeout: 5_000,
    });
    const state = JSON.parse(readFileSync(runtime.statePath));
    assert.deepEqual(state.operations, ['start']);
    assert.equal(state.running, true);
    assert.equal(state.healthy, true);
  } finally {
    runtime.cleanup();
  }
});
