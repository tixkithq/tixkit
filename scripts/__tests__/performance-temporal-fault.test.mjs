import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  canonicalJson,
  createTemporalFaultEvidence,
  executeWorkload,
  runTemporalFault,
  sha256,
  temporalNamespaceReachable,
  validateTemporalFaultConfig,
  validateTemporalFaultEvidence,
} from '../performance-temporal-fault.mjs';

const root = resolve(import.meta.dirname, '../..');
const committed = JSON.parse(
  readFileSync(resolve(root, 'performance-temporal-fault.trusted.json')),
);
const profile = committed.profiles[0];
const containerId = 'a'.repeat(64);
const nonce = 'e'.repeat(64);
const stages = [
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

function marker(token, sequence, observedAt, markerNonce = nonce) {
  return Buffer.from(`${JSON.stringify({ token, nonce: markerNonce, sequence, observedAt })}\n`);
}
const markers = {
  ready: marker('workload-ready-v1', 1, '2026-01-01T00:00:00.000Z'),
  start: marker('fault-start-v1', 2, '2026-01-01T00:00:01.000Z'),
  recovery: marker('recovery-ready-v1', 3, '2026-01-01T00:00:02.000Z'),
};
const runnerSequence = [
  'workload-ready',
  'stop-confirmed',
  'activities-released',
  'restart-requested',
  'docker-healthy',
  'grpc-reachable',
  'recovery-released',
  'workload-complete',
];
const processGroupBytes = Buffer.from(
  '{"schemaVersion":"tixkit-temporal-fault-process-group-v1","pid":999999,"startTimeTicks":null}\n',
);

function rawBytes(protocolMarkers = markers, protocolNonce = nonce) {
  const readyMarker = JSON.parse(protocolMarkers.ready);
  const startMarker = JSON.parse(protocolMarkers.start);
  const recoveryMarker = JSON.parse(protocolMarkers.recovery);
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 'tixkit-temporal-fault-raw-v1',
      namespace: 'default',
      taskQueueSha256: 'b'.repeat(64),
      workflowCount: 16,
      completedCount: 16,
      failedCount: 0,
      openCount: 0,
      timedOutCount: 0,
      cancelledCount: 0,
      terminatedCount: 0,
      expectedLogicalEffectsPerWorkflow: 29,
      protocol: {
        nonceSha256: sha256(protocolNonce),
        readyMarkerSha256: sha256(protocolMarkers.ready),
        startMarkerSha256: sha256(protocolMarkers.start),
        recoveryMarkerSha256: sha256(protocolMarkers.recovery),
        readyObservedAt: readyMarker.observedAt,
        startObservedAt: startMarker.observedAt,
        recoveryObservedAt: recoveryMarker.observedAt,
        sequence: ['workload-ready', 'fault-start', 'recovery-ready', 'workload-complete'],
      },
      workflows: Array.from({ length: 16 }, (_, index) => ({
        workflowIdSha256: sha256(`workflow-${index}`),
        runIdSha256: sha256(`run-${index}`),
        status: 'completed',
        stageOrderSha256: sha256(canonicalJson(stages)),
        activityAttempts: 29,
        logicalEffects: 29,
        reconciliationEffects: 1,
        completionEffects: 1,
        failureEffects: 0,
        historySha256: sha256(`history-${index}`),
        replayVerified: true,
      })),
    })}\n`,
  );
}

test('committed Temporal fault contract is exact and fail-closed', () => {
  assert.equal(validateTemporalFaultConfig(committed), committed);
  for (const mutate of [
    (value) => (value.profiles[0].workflowCount = 15),
    (value) =>
      (value.profiles[0].temporalImage = value.profiles[0].temporalImage.replace(/.$/, '0')),
    (value) => value.profiles.push(structuredClone(value.profiles[0])),
    (value) => value.profiles[0].command.args.push('--reporter=verbose'),
  ]) {
    const changed = structuredClone(committed);
    mutate(changed);
    assert.throws(() => validateTemporalFaultConfig(changed), /schema violation|duplicate|command/);
  }
});

test('evidence binds all histories, outcomes, effects, identities, timing, and exact denials', () => {
  const raw = rawBytes();
  const evidence = createTemporalFaultEvidence({
    config: committed,
    profile,
    gitSha: 'c'.repeat(40),
    containerId,
    rawBytes: raw,
    outageMilliseconds: 5_250,
    recoveryMilliseconds: 1_250,
    nonce,
    markers,
    runnerSequence,
    processGroupBytes,
  });
  assert.equal(evidence.workflows.length, 16);
  assert.equal(evidence.outcomes.completed, 16);
  assert.deepEqual(evidence.ordering, [
    'workload-ready',
    'stop-confirmed',
    'activities-released',
    'restart-requested',
    'docker-healthy',
    'grpc-reachable',
    'recovery-released',
    'workload-complete',
  ]);
  assert.equal(
    validateTemporalFaultEvidence({
      config: committed,
      profile,
      evidence,
      containerId,
      rawBytes: raw,
      nonce,
      markers,
      processGroupBytes,
    }),
    evidence,
  );
  const tampered = structuredClone(evidence);
  tampered.workflows[0].historySha256 = '0'.repeat(64);
  assert.throws(
    () =>
      validateTemporalFaultEvidence({
        config: committed,
        profile,
        evidence: tampered,
        containerId,
        rawBytes: raw,
        nonce,
        markers,
        processGroupBytes,
      }),
    /evidence mismatch/,
  );
});

test('raw evidence rejects outcome, stage, effect, identity, and open-object drift', () => {
  for (const mutate of [
    (raw) => (raw.timedOutCount = 1),
    (raw) => (raw.expectedLogicalEffectsPerWorkflow = 28),
    (raw) => (raw.workflows[0].stageOrderSha256 = '0'.repeat(64)),
    (raw) => (raw.workflows[0].completionEffects = 0),
    (raw) => (raw.workflows[1].runIdSha256 = raw.workflows[0].runIdSha256),
    (raw) =>
      ([raw.protocol.sequence[1], raw.protocol.sequence[2]] = [
        raw.protocol.sequence[2],
        raw.protocol.sequence[1],
      ]),
    (raw) => delete raw.protocol.recoveryMarkerSha256,
    (raw) => (raw.protocol.readyMarkerSha256 = '0'.repeat(64)),
    (raw) => (raw.extra = true),
  ]) {
    const changed = JSON.parse(rawBytes());
    mutate(changed);
    assert.throws(
      () =>
        createTemporalFaultEvidence({
          config: committed,
          profile,
          gitSha: 'c'.repeat(40),
          containerId,
          rawBytes: Buffer.from(JSON.stringify(changed)),
          outageMilliseconds: 5_000,
          recoveryMilliseconds: 1,
          nonce,
          markers,
          runnerSequence,
          processGroupBytes,
        }),
      /non-completed|logical effect|stage|idempotency|duplicate|closed|protocol/,
    );
  }
});

test('activity retries above logical effects remain valid', () => {
  const raw = JSON.parse(rawBytes());
  raw.workflows[0].activityAttempts = 31;
  assert.doesNotThrow(() =>
    createTemporalFaultEvidence({
      config: committed,
      profile,
      gitSha: 'c'.repeat(40),
      containerId,
      rawBytes: Buffer.from(JSON.stringify(raw)),
      outageMilliseconds: 5_000,
      recoveryMilliseconds: 1,
      nonce,
      markers,
      runnerSequence,
      processGroupBytes,
    }),
  );
});

test('runner stops only after readiness, restores before recovery, and seals evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-fault-'));
  const output = join(directory, 'run');
  const calls = [];
  let clock = 0;
  let reachabilityAttempts = 0;
  const adapter = {
    image: async () => (calls.push('image'), profile.temporalImage),
    stop: async () => calls.push('stop'),
    state: async () => (calls.push('state'), 'exited'),
    start: async () => calls.push('start'),
    health: async () => (calls.push('health'), 'healthy'),
  };
  const workload = async (_profile, paths, signal) => {
    writeFileSync(
      paths.ready,
      marker('workload-ready-v1', 1, new Date().toISOString(), paths.nonce),
      { flag: 'wx', mode: 0o600 },
    );
    const ready = readFileSync(paths.ready);
    while (!signal.aborted && !readFileIfPresent(paths.recovery)) await delay(2);
    if (signal.aborted) throw new Error('aborted');
    const actualMarkers = {
      ready,
      start: readFileSync(paths.start),
      recovery: readFileSync(paths.recovery),
    };
    writeFileSync(paths.raw, rawBytes(actualMarkers, paths.nonce), { flag: 'wx', mode: 0o600 });
    writeFileSync(paths.processGroup, processGroupBytes, { flag: 'wx', mode: 0o600 });
  };
  try {
    const evidence = await runTemporalFault({
      config: committed,
      profile,
      outputDirectory: output,
      gitSha: 'd'.repeat(40),
      containerId,
      authorization: committed.authorization,
      adapter,
      workload,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      reachable: async () => ++reachabilityAttempts >= 3,
      now: () => clock,
    });
    assert.equal(evidence.status, 'passed');
    assert.equal(reachabilityAttempts, 3);
    assert.ok(calls.indexOf('stop') < calls.indexOf('start'));
    assert.ok(calls.indexOf('start') < calls.indexOf('health'));
    assert.equal(
      JSON.parse(readFileSync(join(output, 'evidence.json'))).evidenceSha256,
      evidence.evidenceSha256,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('namespace probe converts only transient connection and RPC failures to false', async () => {
  let closed = 0;
  assert.equal(
    await temporalNamespaceReachable('temporal:7233', 'default', async () => {
      const error = new Error('connection refused');
      error.code = 'ECONNREFUSED';
      throw error;
    }),
    false,
  );
  assert.equal(
    await temporalNamespaceReachable('temporal:7233', 'default', async () => ({
      workflowService: {
        describeNamespace: async () => {
          const error = new Error('UNAVAILABLE');
          error.code = 14;
          throw error;
        },
      },
      close: async () => {
        closed += 1;
      },
    })),
    false,
  );
  assert.equal(closed, 1);
  await assert.rejects(
    temporalNamespaceReachable('temporal:7233', 'default', async () => {
      throw new Error('invalid credentials');
    }),
    /invalid credentials/,
  );
});

test('runner retries unavailable namespace probes only until the recovery threshold', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-threshold-'));
  let clock = 0;
  let attempts = 0;
  try {
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: join(directory, 'run'),
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: async (_profile, paths, signal) => {
          writeFileSync(
            paths.ready,
            marker('workload-ready-v1', 1, new Date().toISOString(), paths.nonce),
            { flag: 'wx', mode: 0o600 },
          );
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        },
        adapter: {
          image: async () => profile.temporalImage,
          stop: async () => {},
          state: async () => 'exited',
          start: async () => {},
          health: async () => 'healthy',
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
        reachable: async () => {
          attempts += 1;
          return false;
        },
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => /recovery threshold exceeded/.test(entry.message)),
    );
    assert.equal(attempts, profile.recoveryTimeoutSeconds * 4 + 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runner aborts children before injection and restores after stop or recovery failures', async () => {
  for (const failure of ['wrong-image', 'bad-state', 'restore']) {
    const directory = mkdtempSync(join(tmpdir(), `tixkit-temporal-${failure}-`));
    const output = join(directory, 'run');
    let starts = 0;
    let stopped = 0;
    let childAborted = false;
    const adapter = {
      image: async () => (failure === 'wrong-image' ? 'wrong@sha256:0' : profile.temporalImage),
      stop: async () => {
        stopped += 1;
      },
      state: async () => (failure === 'bad-state' ? 'running' : 'exited'),
      start: async () => {
        starts += 1;
        if (failure === 'restore') throw new Error('RESTORE_FAILED');
      },
      health: async () => 'healthy',
    };
    const workload = async (_profile, paths, signal) => {
      writeFileSync(
        paths.ready,
        marker('workload-ready-v1', 1, new Date().toISOString(), paths.nonce),
        { flag: 'wx', mode: 0o600 },
      );
      await new Promise((_, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            childAborted = true;
            reject(new Error('CHILD_ABORTED'));
          },
          { once: true },
        ),
      );
    };
    try {
      await assert.rejects(
        runTemporalFault({
          config: committed,
          profile,
          outputDirectory: output,
          gitSha: 'd'.repeat(40),
          containerId,
          authorization: committed.authorization,
          adapter,
          workload,
          sleep: async () => {},
          reachable: async () => true,
        }),
        /Temporal fault workload failed|Temporal fault and recovery failed/,
      );
      assert.equal(childAborted, true);
      assert.equal(stopped, failure === 'wrong-image' ? 0 : 1);
      assert.equal(starts, failure === 'wrong-image' ? 0 : 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('runner rejects unsafe markers and existing or symlink output paths without stopping', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-paths-'));
  try {
    const existing = join(directory, 'existing');
    mkdirSync(existing, { mode: 0o700 });
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: existing,
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: async () => {},
        adapter: {},
      }),
      /EEXIST/,
    );
    const target = join(directory, 'target');
    mkdirSync(target, { mode: 0o700 });
    const link = join(directory, 'link');
    symlinkSync(target, link);
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: link,
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: async () => {},
        adapter: {},
      }),
      /EEXIST/,
    );
    let stops = 0;
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: join(directory, 'unsafe'),
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: async (_profile, paths, signal) => {
          writeFileSync(
            paths.ready,
            marker('workload-ready-v1', 1, new Date().toISOString(), paths.nonce),
            { flag: 'wx', mode: 0o644 },
          );
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          );
        },
        adapter: {
          stop: async () => {
            stops += 1;
          },
        },
      }),
      /unsafe file|Temporal fault workload failed/,
    );
    assert.equal(stops, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('runner rejects wrong nonces before injection and replaced or additional files after recovery', async () => {
  for (const mode of ['wrong-nonce', 'replaced', 'additional']) {
    const directory = mkdtempSync(join(tmpdir(), `tixkit-temporal-integrity-${mode}-`));
    let stops = 0;
    const output = join(directory, 'run');
    const workload = async (_profile, paths, signal) => {
      const readyNonce = mode === 'wrong-nonce' ? '0'.repeat(64) : paths.nonce;
      writeFileSync(
        paths.ready,
        marker('workload-ready-v1', 1, new Date().toISOString(), readyNonce),
        { flag: 'wx', mode: 0o600 },
      );
      if (mode === 'wrong-nonce') {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
        return;
      }
      while (!readFileIfPresent(paths.recovery)) await delay(2);
      const actual = {
        ready: readFileSync(paths.ready),
        start: readFileSync(paths.start),
        recovery: readFileSync(paths.recovery),
      };
      writeFileSync(paths.raw, rawBytes(actual, paths.nonce), { flag: 'wx', mode: 0o600 });
      writeFileSync(paths.processGroup, processGroupBytes, { flag: 'wx', mode: 0o600 });
      if (mode === 'replaced')
        writeFileSync(
          paths.ready,
          marker('workload-ready-v1', 1, new Date(Date.now() + 1_000).toISOString(), paths.nonce),
          { mode: 0o600 },
        );
      if (mode === 'additional')
        writeFileSync(join(output, 'unexpected.json'), '{}\n', { flag: 'wx', mode: 0o600 });
    };
    try {
      await assert.rejects(
        runTemporalFault({
          config: committed,
          profile,
          outputDirectory: output,
          gitSha: 'd'.repeat(40),
          containerId,
          authorization: committed.authorization,
          workload,
          adapter: {
            image: async () => profile.temporalImage,
            stop: async () => {
              stops += 1;
            },
            state: async () => 'exited',
            start: async () => {},
            health: async () => 'healthy',
          },
          sleep: async () => {},
          reachable: async () => true,
        }),
        /invalid marker|replaced|inventory|Temporal fault workload failed/,
      );
      assert.equal(stops, mode === 'wrong-nonce' ? 0 : 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('profile mismatch fails before filesystem, workload, or adapter effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-profile-'));
  let effects = 0;
  const changed = { ...profile, outageSeconds: profile.outageSeconds + 1 };
  try {
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile: changed,
        outputDirectory: join(directory, 'must-not-exist'),
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: async () => {
          effects += 1;
        },
        adapter: {
          stop: async () => {
            effects += 1;
          },
        },
      }),
      /profile differs/,
    );
    assert.equal(effects, 0);
    assert.equal(readFileIfPresent(join(directory, 'must-not-exist')), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('synchronous injected workload failure is orchestrated and stops no service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-sync-workload-'));
  let stops = 0;
  try {
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: join(directory, 'run'),
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        workload: () => {
          throw new Error('SYNC_WORKLOAD_FAILURE');
        },
        adapter: {
          stop: async () => {
            stops += 1;
          },
        },
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => entry.message === 'SYNC_WORKLOAD_FAILURE'),
    );
    assert.equal(stops, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('caller abort before deferred workload invocation starts no workload or service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-abort-before-'));
  const controller = new AbortController();
  let stopped = 0;
  let workloadStarts = 0;
  try {
    const execution = runTemporalFault({
      config: committed,
      profile,
      outputDirectory: join(directory, 'run'),
      gitSha: 'd'.repeat(40),
      containerId,
      authorization: committed.authorization,
      signal: controller.signal,
      adapter: {
        stop: async () => {
          stopped += 1;
        },
      },
      workload: async () => {
        workloadStarts += 1;
        throw new Error('WORKLOAD_MUST_NOT_START');
      },
    });
    controller.abort();
    await assert.rejects(
      execution,
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) => entry.message === 'Temporal fault interrupted') &&
        error.errors.every((entry) => entry.message !== 'WORKLOAD_MUST_NOT_START'),
    );
    assert.equal(stopped, 0);
    assert.equal(workloadStarts, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('caller abort after stop still restores the exact service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-abort-after-'));
  const controller = new AbortController();
  let starts = 0;
  let childAborted = false;
  const adapter = {
    image: async () => profile.temporalImage,
    stop: async () => {},
    state: async () => {
      controller.abort();
      return 'exited';
    },
    start: async () => {
      starts += 1;
    },
    health: async () => 'healthy',
  };
  try {
    await assert.rejects(
      runTemporalFault({
        config: committed,
        profile,
        outputDirectory: join(directory, 'run'),
        gitSha: 'd'.repeat(40),
        containerId,
        authorization: committed.authorization,
        signal: controller.signal,
        adapter,
        workload: async (_profile, paths, signal) => {
          writeFileSync(
            paths.ready,
            marker('workload-ready-v1', 1, new Date().toISOString(), paths.nonce),
            { flag: 'wx', mode: 0o600 },
          );
          await new Promise((_, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                childAborted = true;
                reject(new Error('CHILD_ABORTED'));
              },
              { once: true },
            ),
          );
        },
        sleep: async () => {},
        reachable: async () => true,
      }),
      /Temporal fault workload failed/,
    );
    assert.equal(starts, 1);
    assert.equal(childAborted, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workload does not settle until SIGTERM-resistant descendant groups are dead', async () => {
  if (process.platform === 'win32') return;
  for (const mode of ['timeout', 'nonzero', 'abort']) {
    const directory = mkdtempSync(join(tmpdir(), `tixkit-temporal-group-${mode}-`));
    const descendantPath = join(directory, 'descendant.pid');
    const controller = new AbortController();
    const childScript = `
      const {spawn}=require('node:child_process');
      const fs=require('node:fs');
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(descendantPath)},String(child.pid));
      process.on('SIGTERM',()=>{});
      ${mode === 'nonzero' ? 'setTimeout(()=>process.exit(7),50)' : 'setInterval(()=>{},1000)'};
    `;
    const paths = {
      ready: join(directory, 'ready.json'),
      start: join(directory, 'start.json'),
      recovery: join(directory, 'recovery.json'),
      raw: join(directory, 'raw.json'),
      processGroup: join(directory, 'processGroup.json'),
      nonce,
    };
    const execution = executeWorkload(
      {
        ...profile,
        command: { executable: process.execPath, args: ['-e', childScript] },
        workloadTimeoutSeconds: 0.2,
      },
      paths,
      controller.signal,
    );
    try {
      while (!readFileIfPresent(descendantPath)) await delay(5);
      if (mode === 'abort') controller.abort();
      await assert.rejects(execution, /timed out|interrupted|live descendants/);
      const group = JSON.parse(readFileSync(paths.processGroup));
      assert.throws(() => process.kill(-group.pid, 0), { code: 'ESRCH' });
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('process-marker initialization failure terminates resistant descendants before rejection', async () => {
  if (process.platform === 'win32') return;
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-temporal-marker-init-'));
  const descendantPath = join(directory, 'descendant.pid');
  const childScript = `
    const {spawn}=require('node:child_process');
    const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(descendantPath)},String(child.pid));
    process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);
  `;
  const paths = {
    ready: join(directory, 'ready.json'),
    start: join(directory, 'start.json'),
    recovery: join(directory, 'recovery.json'),
    raw: join(directory, 'raw.json'),
    processGroup: join(directory, 'processGroup.json'),
    nonce,
  };
  let processGroupPid;
  try {
    const execution = executeWorkload(
      {
        ...profile,
        command: { executable: process.execPath, args: ['-e', childScript] },
        workloadTimeoutSeconds: 5,
      },
      paths,
      new AbortController().signal,
      {
        writeProcessGroup: (_file, bytes) => {
          processGroupPid = JSON.parse(bytes).pid;
          const deadline = Date.now() + 2_000;
          while (!readFileIfPresent(descendantPath) && Date.now() < deadline) {
            // The child runs in a separate OS process while initialization remains synchronous.
          }
          if (!readFileIfPresent(descendantPath)) throw new Error('DESCENDANT_START_TIMEOUT');
          throw new Error('PROCESS_MARKER_WRITE_FAILED');
        },
      },
    );
    await assert.rejects(execution, /PROCESS_MARKER_WRITE_FAILED/);
    assert.equal(readFileIfPresent(paths.processGroup), undefined);
    assert.throws(() => process.kill(-processGroupPid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(Number(readFileSync(descendantPath, 'utf8')), 0), {
      code: 'ESRCH',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFileIfPresent(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function serviceBlocks(workflow) {
  const lines = workflow.split('\n');
  const servicesStart = lines.findIndex((line) => line === '    services:');
  assert.notEqual(servicesStart, -1);
  const blocks = {};
  let current;
  for (const line of lines.slice(servicesStart + 1)) {
    if (/^    \S/.test(line)) break;
    const service = /^      ([a-z0-9-]+):$/.exec(line)?.[1];
    if (service) {
      current = service;
      blocks[current] = [];
    } else if (current) blocks[current].push(line);
  }
  return Object.fromEntries(
    Object.entries(blocks).map(([name, lines]) => [name, lines.join('\n')]),
  );
}

function assertWorkflowTopology(workflow) {
  const services = serviceBlocks(workflow);
  assert.deepEqual(Object.keys(services).sort(), ['temporal', 'temporal-postgresql']);
  assert.match(
    services['temporal-postgresql'],
    new RegExp(`image: ${profile.persistenceImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(
    services['temporal-postgresql'],
    /POSTGRES_USER: temporal[\s\S]*POSTGRES_PASSWORD: temporal/,
  );
  assert.doesNotMatch(services['temporal-postgresql'], /POSTGRES_SEEDS|7233/);
  assert.match(
    services.temporal,
    new RegExp(`image: ${profile.temporalImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(
    services.temporal,
    /ports:[\s\S]*7233:7233[\s\S]*POSTGRES_SEEDS: temporal-postgresql/,
  );
  const fault = workflow.slice(
    workflow.indexOf('- name: Execute controlled Temporal service interruption'),
    workflow.indexOf('- name: Restore Temporal after any failure'),
  );
  const restore = workflow.slice(
    workflow.indexOf('- name: Restore Temporal after any failure'),
    workflow.indexOf('- name: Record bounded workflow failure'),
  );
  for (const step of [fault, restore]) {
    assert.match(step, /TEMPORAL_SERVICE_CONTAINER_ID: \$\{\{ job\.services\.temporal\.id \}\}/);
    assert.doesNotMatch(step, /job\.services\.temporal-postgresql\.id/);
  }
  assert.ok(workflow.indexOf('adapter.stop(containerId)') === -1);
  assert.ok(
    workflow.indexOf('- name: Execute controlled Temporal service interruption') <
      workflow.indexOf('- name: Restore Temporal after any failure'),
  );
}

function assertRestoreAggregation(workflow) {
  const restore = workflow.slice(
    workflow.indexOf('- name: Restore Temporal after any failure'),
    workflow.indexOf('- name: Record bounded workflow failure'),
  );
  const relaxed = restore.indexOf('set +e');
  const cleanup = restore.indexOf('--cleanup-marker');
  const cleanupStatus = restore.indexOf('cleanup_status=$?');
  const restoration = restore.lastIndexOf('\n          restore_temporal\n');
  const restoreStatus = restore.indexOf('restore_status=$?', restoration);
  const aggregate = restore.indexOf(
    'cleanup_status=${cleanup_status} restore_status=${restore_status}',
  );
  assert.ok(relaxed >= 0 && relaxed < cleanup);
  assert.ok(cleanup < cleanupStatus && cleanupStatus < restoration);
  assert.ok(restoration < restoreStatus && restoreStatus < aggregate);
  assert.match(restore, /for attempt in \$\(seq 1 36\); do[\s\S]*describeNamespace[\s\S]*sleep 5/);
}

test('workflow pins PostgreSQL persistence, Temporal image, destructive authority, and recovery', () => {
  const workflow = readFileSync(
    resolve(root, '.github/workflows/performance-temporal-fault.yml'),
    'utf8',
  );
  assertWorkflowTopology(workflow);
  assertRestoreAggregation(workflow);
  assert.match(
    workflow,
    new RegExp(profile.temporalImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(
    workflow,
    new RegExp(profile.persistenceImage.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(workflow, /job\.services\.temporal\.id/);
  assert.match(workflow, /if: always\(\)/);
  assert.ok(
    workflow.indexOf('Reject untrusted invocation') < workflow.indexOf('actions/checkout@'),
  );
  assert.match(workflow, /GITHUB_REF_NAME.*DEFAULT_BRANCH/);
  assert.match(workflow, /Record bounded workflow failure[\s\S]*failureSha256/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /tixkit-epyc-trusted/);
  assert.doesNotMatch(workflow, /pull_request/);
  for (const changed of [
    workflow.replace(profile.temporalImage, profile.persistenceImage),
    workflow.replace('job.services.temporal.id', 'job.services.temporal-postgresql.id'),
    workflow.replace('POSTGRES_SEEDS: temporal-postgresql', 'POSTGRES_SEEDS: temporal'),
  ])
    assert.throws(() => assertWorkflowTopology(changed));
  for (const changed of [
    workflow.replace('set +e', 'set -e'),
    workflow.replace('cleanup_status=$?', 'cleanup_status=0'),
    workflow.replace('\n          restore_temporal\n', '\n          true\n'),
  ])
    assert.throws(() => assertRestoreAggregation(changed));
});
