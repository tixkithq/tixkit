import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const verifier = resolve(root, 'infra/scripts/verify-production-profile.sh');

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-production-profile-'));
  const kubectl = join(directory, 'kubectl');
  const calls = join(directory, 'calls.log');
  const state = join(directory, 'state');
  const evidence = join(directory, 'evidence');
  writeFileSync(
    kubectl,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MOCK_KUBECTL_CALLS"
args="$*"
if [[ "$args" == "config current-context" ]]; then
  printf '%s\n' "${'${'}MOCK_CONTEXT:-proof-cluster}"
elif [[ "$args" == *" get namespace "* ]]; then
  printf '%s\n' tixkit
elif [[ "$args" == *" get deployments "* ]]; then
  component="$(printf '%s' "$args" | sed -n 's/.*app.kubernetes.io\/component=\([^ ,]*\).*/\1/p')"
  replicas="${'${'}MOCK_REPLICAS:-2}"
  printf '{"items":[{"metadata":{"name":"tixkit-%s","generation":2},"spec":{"replicas":%s,"minReadySeconds":10,"progressDeadlineSeconds":600,"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":0,"maxSurge":1}},"template":{"spec":{"containers":[{"image":"ghcr.io/tixkit/tixkit/%s@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}},"status":{"observedGeneration":2,"availableReplicas":%s,"readyReplicas":%s,"updatedReplicas":%s,"unavailableReplicas":0}}]}\n' "$component" "$replicas" "$component" "$replicas" "$replicas" "$replicas"
elif [[ "$args" == *" get poddisruptionbudgets "* ]]; then
  printf '%s\n' '{"items":[{"spec":{"minAvailable":1},"status":{"currentHealthy":2,"disruptionsAllowed":1}}]}'
elif [[ "$args" == *" get pods "* ]]; then
  component="$(printf '%s' "$args" | sed -n 's/.*app.kubernetes.io\/component=\([^ ,]*\).*/\1/p')"
  if [[ "${'${'}MOCK_NO_REPLACEMENT:-0}" != 1 ]] && grep -qx "$component" "$MOCK_STATE" 2>/dev/null; then
    printf '{"items":[{"metadata":{"name":"tixkit-%s-new","uid":"uid-%s-new"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"tixkit-%s-b","uid":"uid-%s-b"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}\n' "$component" "$component" "$component" "$component"
  else
    printf '{"items":[{"metadata":{"name":"tixkit-%s-a","uid":"uid-%s-a"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"tixkit-%s-b","uid":"uid-%s-b"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}\n' "$component" "$component" "$component" "$component"
  fi
elif [[ "$args" == *" create -f -"* ]]; then
  manifest="$(cat)"
  pod_name="$(printf '%s\n' "$manifest" | awk '/^[[:space:]]*name:/ { print $2; exit }')"
  component="${'${'}pod_name#tixkit-}"
  component="${'${'}component%-a}"
  printf '%s\n' "$component" >>"$MOCK_STATE"
  printf 'eviction.policy/%s\n' "$pod_name"
fi
`,
  );
  chmodSync(kubectl, 0o755);
  return {
    directory,
    evidence,
    env: {
      ...process.env,
      KUBECTL: kubectl,
      MOCK_KUBECTL_CALLS: calls,
      MOCK_STATE: state,
      EXPECTED_KUBE_CONTEXT: 'proof-cluster',
      NAMESPACE: 'tixkit-proof',
      RELEASE_NAME: 'tixkit-proof',
      DRILL_ID: 'replacement-001',
      EVIDENCE_DIR: evidence,
    },
    calls,
    state,
  };
}

function runVerifier(env) {
  return new Promise((resolveRun) => {
    const child = spawn(verifier, { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveRun({ code, stderr, stdout }));
  });
}

test('production verifier records read-only readiness evidence without disruption by default', () => {
  const { directory, evidence, env, calls } = harness();
  try {
    const output = execFileSync(verifier, { cwd: root, env, encoding: 'utf8' }).trim();
    assert.equal(output, join(evidence, 'replacement-001.json'));
    const proof = JSON.parse(readFileSync(output, 'utf8'));
    assert.deepEqual(
      proof.before.map(({ component, replicas, readyReplicas }) => ({
        component,
        replicas,
        readyReplicas,
      })),
      ['api', 'worker', 'checkout', 'admin'].map((component) => ({
        component,
        replicas: 2,
        readyReplicas: 2,
      })),
    );
    assert.deepEqual(proof.after, proof.before);
    assert.equal(proof.disruptionPerformed, false);
    assert.equal(statSync(output).mode & 0o777, 0o400);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), / create -f -|rollout status /u);
    const replay = spawnSync(verifier, { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /refusing to overwrite evidence/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production verifier requires explicit context and disruption acknowledgement', () => {
  const { directory, env, calls } = harness();
  try {
    const mismatch = spawnSync(verifier, {
      cwd: root,
      env: { ...env, MOCK_CONTEXT: 'wrong-cluster' },
      encoding: 'utf8',
    });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /does not match EXPECTED_KUBE_CONTEXT/u);

    execFileSync(verifier, {
      cwd: root,
      env: {
        ...env,
        DRILL_ID: 'replacement-002',
        PRODUCTION_DISRUPTION_ACK: 'evict-one-pod-per-component',
      },
    });
    const callLog = readFileSync(calls, 'utf8');
    for (const component of ['api', 'worker', 'checkout', 'admin']) {
      assert.match(callLog, new RegExp(`rollout status deployment/tixkit-${component}`, 'u'));
    }
    assert.equal(callLog.match(/ create -f -/gu)?.length, 4);
    const proof = JSON.parse(readFileSync(join(env.EVIDENCE_DIR, 'replacement-002.json'), 'utf8'));
    assert.equal(proof.disruptionPerformed, true);
    assert.deepEqual(
      proof.disruptions.map(({ component, oldPodUid, newPodUid }) => ({
        component,
        oldPodUid,
        newPodUid,
      })),
      ['api', 'worker', 'checkout', 'admin'].map((component) => ({
        component,
        oldPodUid: `uid-${component}-a`,
        newPodUid: `uid-${component}-new`,
      })),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production verifier fails when eviction does not produce a new Ready pod UID', () => {
  const { directory, env, calls } = harness();
  try {
    const result = spawnSync(verifier, {
      cwd: root,
      env: {
        ...env,
        MOCK_NO_REPLACEMENT: '1',
        PRODUCTION_DISRUPTION_ACK: 'evict-one-pod-per-component',
        REPLACEMENT_POLL_SECONDS: '0.1',
        REPLACEMENT_TIMEOUT_SECONDS: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out waiting for a distinct Ready replacement pod for api/u);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /rollout status/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production verifier rejects a dangling evidence symlink without touching its target', () => {
  const { directory, evidence, env } = harness();
  try {
    const target = join(directory, 'missing-target');
    const link = join(evidence, 'dangling.json');
    mkdirSync(evidence, { recursive: true });
    symlinkSync(target, link);
    const result = spawnSync(verifier, {
      cwd: root,
      env: { ...env, DRILL_ID: 'dangling' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing symlink evidence path/u);
    assert.throws(() => readFileSync(target));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production verifier exclusively reserves a drill ID across concurrent runs', async () => {
  const { directory, evidence, env } = harness();
  try {
    const concurrentEnv = { ...env, DRILL_ID: 'concurrent' };
    const results = await Promise.all([runVerifier(concurrentEnv), runVerifier(concurrentEnv)]);
    assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
    assert.match(results.find(({ code }) => code !== 0).stderr, /refusing to overwrite evidence/u);
    const proof = JSON.parse(readFileSync(join(evidence, 'concurrent.json'), 'utf8'));
    assert.equal(proof.drillId, 'concurrent');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production verifier fails before disruption when a workload is not highly available', () => {
  const { directory, env, calls } = harness();
  try {
    const result = spawnSync(verifier, {
      cwd: root,
      env: {
        ...env,
        MOCK_REPLICAS: '1',
        PRODUCTION_DISRUPTION_ACK: 'evict-one-pod-per-component',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment invariant failed for api/u);
    assert.doesNotMatch(readFileSync(calls, 'utf8'), / create -f -/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
