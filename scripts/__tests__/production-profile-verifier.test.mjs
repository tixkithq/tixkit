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
elif [[ "$args" == *" config view --minify -o jsonpath={.clusters[0].cluster.server}" ]]; then
  printf '%s' 'https://proof.example'
elif [[ "$args" == *" config view --minify --raw --flatten -o jsonpath={.clusters[0].cluster.certificate-authority-data}" ]]; then
  printf '%s' 'cHJvb2YtY2E='
elif [[ "$args" == *" get namespace kube-system -o json" ]]; then
  printf '%s\n' '{"metadata":{"name":"kube-system","uid":"namespace-kube-system"}}'
elif [[ "$args" == *" get namespace "*" -o json" ]]; then
  printf '%s\n' '{"metadata":{"name":"tixkit-proof","uid":"namespace-tixkit-proof"}}'
elif [[ "$args" == *" get secrets "* ]]; then
  printf '%s\n' '{"items":[{"metadata":{"uid":"helm-secret-uid","labels":{"version":"7","status":"deployed","chart":"tixkit-1.2.3","appVersion":"1.2.3"}},"data":{"release":"helm-release-payload"}}]}'
elif [[ "$args" == *" get nodes -o json" ]]; then
  if [[ "${'${'}MOCK_MISSING_ZONE:-0}" == 1 ]]; then zone_b=''; else zone_b=',"topology.kubernetes.io/zone":"zone-b"'; fi
  printf '{"items":[{"metadata":{"name":"node-a","uid":"node-uid-a","labels":{"topology.kubernetes.io/zone":"zone-a"}}},{"metadata":{"name":"node-b","uid":"node-uid-b","labels":{%s}}}]}\n' "${'${'}zone_b#,}"
elif [[ "$args" == *" get deployments "* ]]; then
  component="$(printf '%s' "$args" | sed -n 's/.*app.kubernetes.io\/component=\([^ ,]*\).*/\1/p')"
  replicas="${'${'}MOCK_REPLICAS:-2}"
  topology_min="${'${'}MOCK_TOPOLOGY_MIN_DOMAINS:-2}"
  printf '{"items":[{"metadata":{"name":"tixkit-%s","generation":2,"labels":{"helm.sh/chart":"tixkit-1.2.3","app.kubernetes.io/version":"1.2.3"}},"spec":{"replicas":%s,"minReadySeconds":10,"progressDeadlineSeconds":600,"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":0,"maxSurge":1}},"template":{"spec":{"topologySpreadConstraints":[{"maxSkew":1,"minDomains":%s,"topologyKey":"topology.kubernetes.io/zone","whenUnsatisfiable":"DoNotSchedule"}],"containers":[{"image":"ghcr.io/tixkit/tixkit/%s@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}}},"status":{"observedGeneration":2,"availableReplicas":%s,"readyReplicas":%s,"updatedReplicas":%s,"unavailableReplicas":0}}]}\n' "$component" "$replicas" "$topology_min" "$component" "$replicas" "$replicas" "$replicas"
elif [[ "$args" == *" get horizontalpodautoscalers "* ]]; then
  min="${'${'}MOCK_HPA_MIN:-2}"
  max="${'${'}MOCK_HPA_MAX:-6}"
  desired="${'${'}MOCK_HPA_DESIRED:-2}"
  component="$(printf '%s' "$args" | sed -n 's/.*app.kubernetes.io\/component=\([^ ,]*\).*/\1/p')"
  printf '{"items":[{"metadata":{"uid":"hpa-uid"},"spec":{"scaleTargetRef":{"kind":"Deployment","name":"tixkit-%s"},"minReplicas":%s,"maxReplicas":%s},"status":{"desiredReplicas":%s}}]}\n' "$component" "$min" "$max" "$desired"
elif [[ "$args" == *" get poddisruptionbudgets "* ]]; then
  disruptions="${'${'}MOCK_DISRUPTIONS_ALLOWED:-1}"
  minimum="${'${'}MOCK_PDB_MIN:-1}"
  printf '{"items":[{"metadata":{"uid":"pdb-uid"},"spec":{"minAvailable":%s},"status":{"currentHealthy":2,"disruptionsAllowed":%s}}]}\n' "$minimum" "$disruptions"
elif [[ "$args" == *" get pods "* ]]; then
  component="$(printf '%s' "$args" | sed -n 's/.*app.kubernetes.io\/component=\([^ ,]*\).*/\1/p')"
  if [[ "${'${'}MOCK_NO_REPLACEMENT:-0}" != 1 ]] && grep -qx "$component" "$MOCK_STATE" 2>/dev/null; then
    printf '{"items":[{"metadata":{"name":"tixkit-%s-new","uid":"uid-%s-new"},"spec":{"nodeName":"node-a"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"tixkit-%s-b","uid":"uid-%s-b"},"spec":{"nodeName":"node-b"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}\n' "$component" "$component" "$component" "$component"
  else
    node_b="node-b"; [[ "${'${'}MOCK_SINGLE_ZONE:-0}" == 1 ]] && node_b="node-a"
    printf '{"items":[{"metadata":{"name":"tixkit-%s-a","uid":"uid-%s-a"},"spec":{"nodeName":"node-a"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"tixkit-%s-b","uid":"uid-%s-b"},"spec":{"nodeName":"%s"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}\n' "$component" "$component" "$component" "$component" "$node_b"
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
    const output = execFileSync(verifier, {
      cwd: root,
      env,
      encoding: 'utf8',
    }).trim();
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
    assert.deepEqual(proof.cluster, {
      server: 'https://proof.example',
      caSha256: '313aa2469a1dc6308b1041090bd7e5933f351657a7a92487c4f1a36a71d18427',
      kubeSystemNamespaceUid: 'namespace-kube-system',
    });
    assert.equal(proof.namespaceUid, 'namespace-tixkit-proof');
    assert.deepEqual(proof.before[0].readyPods, [
      {
        name: 'tixkit-api-a',
        uid: 'uid-api-a',
        nodeName: 'node-a',
        nodeUid: 'node-uid-a',
        zone: 'zone-a',
      },
      {
        name: 'tixkit-api-b',
        uid: 'uid-api-b',
        nodeName: 'node-b',
        nodeUid: 'node-uid-b',
        zone: 'zone-b',
      },
    ]);
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

for (const [name, overrides, message] of [
  ['single-zone Ready pods', { MOCK_SINGLE_ZONE: '1' }, /zone-spread invariant failed for api/u],
  [
    'a live topology constraint with fewer than two domains',
    { MOCK_TOPOLOGY_MIN_DOMAINS: '1' },
    /deployment invariant failed for api/u,
  ],
  [
    'a missing node zone label',
    { MOCK_MISSING_ZONE: '1' },
    /zone-spread invariant failed for api/u,
  ],
  ['an HPA minimum below two', { MOCK_HPA_MIN: '1' }, /autoscaler invariant failed for api/u],
  [
    'an HPA desired replica count above its maximum',
    { MOCK_HPA_DESIRED: '7' },
    /autoscaler invariant failed for api/u,
  ],
  [
    'a PDB that consumes all desired replicas',
    { MOCK_PDB_MIN: '2' },
    /disruption-budget invariant failed for api/u,
  ],
  [
    'a PDB with no currently allowed disruption in read-only mode',
    { MOCK_DISRUPTIONS_ALLOWED: '0' },
    /disruption-budget invariant failed for api/u,
  ],
]) {
  test(`production verifier rejects ${name}`, () => {
    const { directory, env, calls } = harness();
    try {
      const result = spawnSync(verifier, {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.doesNotMatch(readFileSync(calls, 'utf8'), / create -f -/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
