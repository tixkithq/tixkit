import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '../..');
const prove = resolve(root, 'scripts/prove-production-rehearsal.mjs');
const verify = resolve(root, 'scripts/verify-production-rehearsal.mjs');
const verifyHosted = resolve(root, 'scripts/verify-hosted-production-dr.mjs');
const createHostedReceipt = resolve(root, 'scripts/create-hosted-production-dr-receipt.mjs');
const { writeAll } = await import('../prove-production-rehearsal.mjs');
const { verifyHostedProductionDr } = await import('../verify-hosted-production-dr.mjs');
const { verifyProductionRehearsal } = await import('../verify-production-rehearsal.mjs');
const { stageProductionDrBundle } = await import('../stage-production-dr-bundle.mjs');
const { canonicalHostedTrustJson, hostedTrustReceiptSigningBytes } =
  await import('../lib/hosted-trust-receipt.mjs');
const hostedProductionDrReceiptSchema = JSON.parse(
  readFileSync(resolve(root, 'distribution/hosted-production-dr-receipt.schema.json'), 'utf8'),
);
const validateHostedProductionDrReceipt = new Ajv2020({
  allErrors: true,
  ownProperties: true,
  strict: true,
}).compile(hostedProductionDrReceiptSchema);
const beforeImages = {
  api: 'ghcr.io/tixkithq/tixkit-api@sha256:' + '1'.repeat(64),
  worker: 'ghcr.io/tixkithq/tixkit-worker@sha256:' + '2'.repeat(64),
  checkout: 'ghcr.io/tixkithq/tixkit-checkout@sha256:' + '3'.repeat(64),
  admin: 'ghcr.io/tixkithq/tixkit-admin@sha256:' + '4'.repeat(64),
};
const targetImages = {
  api: 'ghcr.io/tixkithq/tixkit-api@sha256:' + '5'.repeat(64),
  worker: 'ghcr.io/tixkithq/tixkit-worker@sha256:' + '6'.repeat(64),
  checkout: 'ghcr.io/tixkithq/tixkit-checkout@sha256:' + '7'.repeat(64),
  admin: 'ghcr.io/tixkithq/tixkit-admin@sha256:' + '8'.repeat(64),
};

function releaseManifest(images) {
  return {
    schemaVersion: 1,
    releaseVersion: '1.2.3',
    core: {
      sourceCommit: 'a'.repeat(40),
      sourceTreeSha256: 'b'.repeat(64),
      apiVersion: '2026-07-26',
      migrationRange: { minimum: '0001', maximum: '0080' },
      agentProtocol: { status: 'supported', version: '1.0.0' },
      packages: [
        {
          name: '@tixkit/domain',
          version: '1.2.3',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
          contentSha256: 'c'.repeat(64),
          fileCount: 1,
        },
      ],
      images: Object.entries(images).map(([name, reference]) => ({
        name,
        reference,
        digest: reference.slice(reference.indexOf('sha256:')),
      })),
      contracts: [{ name: 'openapi', version: '2026-07-26', sha256: 'd'.repeat(64) }],
    },
  };
}

function executable(path, content) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`);
  chmodSync(path, 0o700);
}

function fixture(kind = 'dependency-loss') {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-production-rehearsal-'));
  const evidence = join(directory, 'evidence');
  const state = join(directory, 'state');
  const calls = join(directory, 'calls');
  mkdirSync(evidence, { mode: 0o700 });
  writeFileSync(state, 'before\n');
  writeFileSync(calls, '');
  const before = join(directory, 'before.json');
  const target = join(directory, 'target.json');
  writeFileSync(before, JSON.stringify(releaseManifest(beforeImages)));
  writeFileSync(target, JSON.stringify(releaseManifest(targetImages)));

  const baselineProbe = join(directory, 'baseline');
  const inject = join(directory, 'inject');
  const duringProbe = join(directory, 'during');
  const recover = join(directory, 'recover');
  const recoveredProbe = join(directory, 'recovered');
  executable(
    baselineProbe,
    String.raw`printf baseline >>"$MOCK_CALLS"; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
  );
  executable(
    inject,
    String.raw`printf inject >>"$MOCK_CALLS"; if [[ "$TIXKIT_PRODUCTION_DRILL_KIND" == release-upgrade-rollback ]]; then printf target >"$MOCK_STATE"; else printf fault >"$MOCK_STATE"; fi; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
  );
  executable(
    duringProbe,
    String.raw`printf during >>"$MOCK_CALLS"; [[ "${'${'}MOCK_DURING_FAILURE:-0}" != 1 ]] || exit 9; if [[ "$TIXKIT_PRODUCTION_DRILL_KIND" == dependency-loss ]]; then printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":false,"outageMilliseconds":25,"observationCount":3}'; exit 1; fi; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":3}'`,
  );
  executable(
    recover,
    String.raw`printf recover >>"$MOCK_CALLS"; if [[ "$TIXKIT_PRODUCTION_DRILL_KIND" == release-upgrade-rollback ]]; then printf rollback >"$MOCK_STATE"; else printf before >"$MOCK_STATE"; fi; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
  );
  executable(
    recoveredProbe,
    String.raw`printf recovered >>"$MOCK_CALLS"; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
  );

  const kubectl = join(directory, 'kubectl');
  executable(
    kubectl,
    String.raw`args="$*"
if [[ "$args" == "config current-context" ]]; then printf proof-cluster; exit; fi
if [[ "$args" == "config view --minify -o json" ]]; then printf '%s' '{"clusters":[{"cluster":{"server":"https://cluster.example","certificate-authority-data":"Y2E="}}]}'; exit; fi
if [[ "$args" == *"get namespace kube-system -o json"* ]]; then printf '%s' '{"metadata":{"uid":"system-uid"}}'; exit; fi
if [[ "$args" == *"get namespace tixkit-proof -o json"* ]]; then printf '%s' '{"metadata":{"uid":"namespace-uid"}}'; exit; fi
if [[ "$args" == *"get nodes -o json"* ]]; then
  if [[ "${'${'}MOCK_SINGLE_ZONE:-0}" == 1 ]]; then zone_b=zone-a; else zone_b=zone-b; fi
  printf '{"items":[{"metadata":{"name":"node-a","uid":"node-a-uid","labels":{"topology.kubernetes.io/zone":"zone-a"}}},{"metadata":{"name":"node-b","uid":"node-b-uid","labels":{"topology.kubernetes.io/zone":"%s"}}}]}' "$zone_b"; exit
fi
phase="$(tr -d '\n' <"$MOCK_STATE")"
if [[ "$phase" == target ]]; then prefix=(5 6 7 8); else prefix=(1 2 3 4); fi
components=(api worker checkout admin)
if [[ "$args" == *"get deployments"* ]]; then
  if [[ "$phase" == target ]]; then revision=2; elif [[ "$phase" == rollback ]]; then revision=3; else revision=1; fi
  printf '{"items":['
  for index in 0 1 2 3; do component="${'${'}components[$index]}"; digest="$(printf '%064d' 0 | tr 0 "${'${'}prefix[$index]}")"; [[ $index == 0 ]] || printf ','; printf '{"metadata":{"uid":"deployment-%s","generation":2,"annotations":{"deployment.kubernetes.io/revision":"%s"},"labels":{"app.kubernetes.io/component":"%s"}},"spec":{"replicas":2,"template":{"spec":{"containers":[{"image":"ghcr.io/tixkithq/tixkit-%s@sha256:%s"}]}}},"status":{"observedGeneration":2,"availableReplicas":2,"readyReplicas":2,"updatedReplicas":2,"unavailableReplicas":0}}' "$component" "$revision" "$component" "$component" "$digest"; done
  printf ']}'
  exit
fi
if [[ "$args" == *"get replicasets"* ]]; then
  if [[ "$phase" == target ]]; then revision=2; elif [[ "$phase" == rollback ]]; then revision=3; else revision=1; fi
  printf '{"items":['
  for index in 0 1 2 3; do component="${'${'}components[$index]}"; digest="$(printf '%064d' 0 | tr 0 "${'${'}prefix[$index]}")"; [[ $index == 0 ]] || printf ','; printf '{"metadata":{"uid":"replicaset-%s-%s","annotations":{"deployment.kubernetes.io/revision":"%s"},"labels":{"app.kubernetes.io/component":"%s"},"ownerReferences":[{"kind":"Deployment","uid":"deployment-%s","controller":true}]},"spec":{"replicas":2,"template":{"spec":{"containers":[{"image":"ghcr.io/tixkithq/tixkit-%s@sha256:%s"}]}}},"status":{"readyReplicas":2,"availableReplicas":2}}' "$component" "$revision" "$revision" "$component" "$component" "$component" "$digest"; done
  printf ']}'
  exit
fi
if [[ "$args" == *"get pods"* ]]; then
  pod_phase="$phase"; [[ "${'${'}MOCK_STALE_PODS:-0}" != 1 ]] || pod_phase=before
  if [[ "$pod_phase" == target ]]; then pod_prefix=(5 6 7 8); else pod_prefix=(1 2 3 4); fi
  printf '{"items":['; first=1
  if [[ "$phase" == target ]]; then pod_revision=2; elif [[ "$phase" == rollback ]]; then pod_revision=3; else pod_revision=1; fi
  for index in 0 1 2 3; do component="${'${'}components[$index]}"; digest="$(printf '%064d' 0 | tr 0 "${'${'}pod_prefix[$index]}")"; for suffix in a b; do [[ $first == 1 ]] || printf ','; first=0; printf '{"metadata":{"uid":"uid-%s-%s","ownerReferences":[{"kind":"ReplicaSet","uid":"replicaset-%s-%s","controller":true}],"labels":{"app.kubernetes.io/component":"%s"}},"spec":{"nodeName":"node-%s","containers":[{"image":"ghcr.io/tixkithq/tixkit-%s@sha256:%s"}]},"status":{"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"ready":true,"image":"ghcr.io/tixkithq/tixkit-%s@sha256:%s","imageID":"containerd://ghcr.io/tixkithq/tixkit-%s@sha256:%s"}]}}' "$component" "$suffix" "$component" "$pod_revision" "$component" "$suffix" "$component" "$digest" "$component" "$digest" "$component" "$digest"; done; done
  printf ']}'
  exit
fi
exit 2`,
  );

  const helm = join(directory, 'helm');
  executable(
    helm,
    String.raw`phase="$(tr -d '\n' <"$MOCK_STATE")"
if [[ "$*" == "get metadata"* ]]; then if [[ "$phase" == target ]]; then revision=2; app=2.0.0; elif [[ "$phase" == rollback ]]; then revision=3; app=1.0.0; else revision=1; app=1.0.0; fi; printf '{"version":%s,"chart":"tixkit-1.0.0","appVersion":"%s"}' "$revision" "$app"
elif [[ "$*" == "get values"* ]]; then printf '{"phase":"%s"}' "$phase"
elif [[ "$*" == "get manifest"* ]]; then printf 'manifest-%s' "$phase"
else exit 2; fi`,
  );

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPath = join(directory, 'private.pem');
  const publicKeyPath = join(directory, 'public.pem');
  writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  const acknowledgement = {
    'zone-loss': 'I authorize production zone-loss fault injection and recovery',
    'dependency-loss': 'I authorize production dependency-loss fault injection and recovery',
    'release-upgrade-rollback': 'I authorize production release upgrade and application rollback',
  }[kind];
  const config = {
    schemaVersion: 'tixkit-production-rehearsal-config-v1',
    drillId: `${kind}-001`,
    kind,
    acknowledgement,
    expectedContext: 'proof-cluster',
    namespace: 'tixkit-proof',
    release: 'tixkit-proof',
    ...(kind === 'dependency-loss' ? { dependency: 'temporal' } : {}),
    beforeReleaseManifest: before,
    ...(kind === 'release-upgrade-rollback' ? { targetReleaseManifest: target } : {}),
    thresholds: {
      adapterTimeoutSeconds: 5,
      maxOutageSeconds: 5,
      maxRecoverySeconds: 5,
    },
    adapters: { baselineProbe, inject, duringProbe, recover, recoveredProbe },
  };
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const expectations = {
    schemaVersion: 'tixkit-production-rehearsal-expectations-v1',
    drillId: config.drillId,
    kind: config.kind,
    ...(config.dependency ? { dependency: config.dependency } : {}),
    context: config.expectedContext,
    clusterServer: 'https://cluster.example',
    clusterCaSha256: createHash('sha256').update('ca').digest('hex'),
    systemNamespaceUid: 'system-uid',
    namespaceName: config.namespace,
    namespaceUid: 'namespace-uid',
    release: config.release,
    beforeReleaseSha256: hashFile(before),
    beforeImages,
    ...(config.targetReleaseManifest ? { targetReleaseSha256: hashFile(target) } : {}),
    ...(config.targetReleaseManifest ? { targetImages } : {}),
    thresholds: config.thresholds,
    adapterSha256: Object.fromEntries(
      Object.entries(config.adapters).map(([name, path]) => [name, hashFile(path)]),
    ),
  };
  const expectationsPath = join(directory, 'expectations.json');
  writeFileSync(expectationsPath, JSON.stringify(expectations), {
    mode: 0o600,
  });
  return {
    directory,
    evidence,
    calls,
    config,
    configPath,
    kubectl,
    helm,
    privateKeyPath,
    publicKeyPath,
    expectations,
    expectationsPath,
    env: { ...process.env, MOCK_STATE: state, MOCK_CALLS: calls },
  };
}

function proveArgs(value) {
  return [
    '--config',
    value.configPath,
    '--evidence-dir',
    value.evidence,
    '--private-key',
    value.privateKeyPath,
    '--expectations',
    value.expectationsPath,
    '--kubectl',
    value.kubectl,
    '--helm',
    value.helm,
  ];
}

function writeConfig(value) {
  writeFileSync(value.configPath, JSON.stringify(value.config));
}

function writeExpectations(value) {
  writeFileSync(value.expectationsPath, JSON.stringify(value.expectations));
}

function updateAdapterExpectation(value, name) {
  value.expectations.adapterSha256[name] = createHash('sha256')
    .update(readFileSync(value.config.adapters[name]))
    .digest('hex');
  writeExpectations(value);
}

function verifyArgs(value, evidencePath) {
  return [
    '--evidence',
    evidencePath,
    '--signature',
    `${evidencePath}.sig`,
    '--checksum',
    `${evidencePath}.sha256`,
    '--public-key',
    value.publicKeyPath,
    '--expectations',
    value.expectationsPath,
  ];
}

test('artifact writes complete every short write or fail on zero progress', () => {
  const payloads = {
    evidence: Buffer.from('{"status":"passed"}\n'),
    signature: Buffer.from('c2lnbmF0dXJlCg==\n'),
    checksum: Buffer.from(`${'a'.repeat(64)}  evidence.json\n`),
  };
  for (const [name, payload] of Object.entries(payloads)) {
    const chunks = [];
    const written = writeAll(0, payload, (_descriptor, bytes, offset, length) => {
      const count = Math.min(name.length % 4 || 1, length);
      chunks.push(Buffer.from(bytes.subarray(offset, offset + count)));
      return count;
    });
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.deepEqual(written, payload);
  }
  assert.throws(() => writeAll(0, Buffer.from('proof'), () => 0), /write made invalid progress/u);
});

test('rehearsal rejects unreviewed inputs and unsafe evidence directories before adapters run', async (t) => {
  const cases = [
    {
      name: 'missing expectations',
      mutate(value, args) {
        const index = args.indexOf('--expectations');
        args.splice(index, 2);
      },
      message: /--expectations is required/u,
    },
    {
      name: 'changed inject adapter',
      mutate(value) {
        executable(
          value.config.adapters.inject,
          `printf unreviewed >>"$MOCK_CALLS"; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
        );
      },
      message: /do not exactly match the reviewed expectations/u,
    },
    {
      name: 'weakened outage threshold',
      mutate(value) {
        value.config.thresholds.maxOutageSeconds = 10;
        writeConfig(value);
      },
      message: /do not exactly match the reviewed expectations/u,
    },
    {
      name: 'changed prior manifest and image map',
      mutate(value) {
        const manifest = JSON.parse(readFileSync(value.config.beforeReleaseManifest, 'utf8'));
        const image = manifest.core.images.find(({ name }) => name === 'api');
        image.reference = 'ghcr.io/tixkithq/tixkit-api@sha256:' + '9'.repeat(64);
        image.digest = 'sha256:' + '9'.repeat(64);
        writeFileSync(value.config.beforeReleaseManifest, JSON.stringify(manifest));
      },
      message: /do not exactly match the reviewed expectations/u,
    },
    {
      name: 'changed target manifest and image map',
      kind: 'release-upgrade-rollback',
      mutate(value) {
        const manifest = JSON.parse(readFileSync(value.config.targetReleaseManifest, 'utf8'));
        const image = manifest.core.images.find(({ name }) => name === 'worker');
        image.reference = 'ghcr.io/tixkithq/tixkit-worker@sha256:' + '9'.repeat(64);
        image.digest = 'sha256:' + '9'.repeat(64);
        writeFileSync(value.config.targetReleaseManifest, JSON.stringify(manifest));
      },
      message: /do not exactly match the reviewed expectations/u,
    },
    {
      name: 'actual cluster identity mismatch',
      mutate(value) {
        value.expectations.namespaceUid = 'different-namespace-uid';
        writeExpectations(value);
      },
      message: /do not exactly match the reviewed expectations/u,
    },
    {
      name: 'mode 0755 evidence directory',
      mutate(value) {
        chmodSync(value.evidence, 0o755);
      },
      message: /must not be group\/world accessible/u,
    },
    {
      name: 'mode 0777 evidence directory',
      mutate(value) {
        chmodSync(value.evidence, 0o777);
      },
      message: /must not be group\/world accessible/u,
    },
    {
      name: 'group-readable expectations',
      mutate(value) {
        chmodSync(value.expectationsPath, 0o640);
      },
      message: /must not be group\/world accessible/u,
    },
    {
      name: 'symlinked expectations',
      mutate(value) {
        const target = `${value.expectationsPath}.target`;
        writeFileSync(target, JSON.stringify(value.expectations), { mode: 0o600 });
        rmSync(value.expectationsPath);
        symlinkSync(target, value.expectationsPath);
      },
      message: /invalid production expectations/u,
    },
    {
      name: 'oversized expectations',
      mutate(value) {
        writeFileSync(value.expectationsPath, ' '.repeat(1024 * 1024 + 1), { mode: 0o600 });
      },
      message: /exceeds the 1048576-byte safety limit/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const value = fixture(entry.kind);
      try {
        const args = proveArgs(value);
        entry.mutate(value, args);
        const result = spawnSync(process.execPath, [prove, ...args], {
          cwd: root,
          env: value.env,
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, entry.message);
        assert.equal(readFileSync(value.calls, 'utf8'), '');
      } finally {
        rmSync(value.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      }
    });
  }
});

test('rehearsal refuses artifact or evidence-directory substitution before publication', async (t) => {
  const cases = [
    {
      name: 'artifact inode replacement',
      command:
        'rm -f "$MOCK_ARTIFACT"; printf substituted >"$MOCK_ARTIFACT"; chmod 400 "$MOCK_ARTIFACT"',
      message: /artifact identity changed/u,
    },
    {
      name: 'artifact permission change',
      command: 'chmod 600 "$MOCK_ARTIFACT"',
      message: /artifact identity changed/u,
    },
    {
      name: 'artifact hard link',
      command: 'ln "$MOCK_ARTIFACT" "$MOCK_ARTIFACT.link"',
      message: /artifact identity changed/u,
    },
    {
      name: 'evidence directory pathname exchange',
      command: 'mv "$MOCK_EVIDENCE" "$MOCK_EVIDENCE.moved"; mkdir -m 700 "$MOCK_EVIDENCE"',
      message: /evidence-dir identity changed|ENOENT.*reviewed-adapters/su,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const value = fixture('zone-loss');
      try {
        executable(
          value.config.adapters.recoveredProbe,
          `printf recovered >>"$MOCK_CALLS"; ${entry.command}; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
        );
        updateAdapterExpectation(value, 'recoveredProbe');
        const evidencePath = join(value.evidence, `${value.config.drillId}.json`);
        const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
          cwd: root,
          env: {
            ...value.env,
            MOCK_ARTIFACT: evidencePath,
            MOCK_EVIDENCE: value.evidence,
          },
          encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, entry.message);
        assert.notEqual(
          spawnSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)]).status,
          0,
        );
      } finally {
        const movedEvidence = `${value.evidence}.moved`;
        if (existsSync(movedEvidence))
          for (const name of readdirSync(movedEvidence))
            if (name.startsWith('.tixkit-reviewed-adapters-'))
              chmodSync(join(movedEvidence, name), 0o700);
        rmSync(value.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      }
    });
  }
});

test('dependency-loss rehearsal publishes signed, threshold-bound recovery evidence', () => {
  const value = fixture();
  try {
    const evidencePath = execFileSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
    }).trim();
    execFileSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)], { cwd: root });
    const proof = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(proof.kind, 'dependency-loss');
    assert.equal(proof.dependency, 'temporal');
    assert.deepEqual(
      proof.steps.map(({ name, exitCode }) => [name, exitCode]),
      [
        ['baseline-probe', 0],
        ['inject', 0],
        ['during-probe', 1],
        ['recover', 0],
        ['recovered-probe', 0],
      ],
    );
    assert.deepEqual(
      proof.snapshots.map(({ phase }) => phase),
      ['before', 'recovered'],
    );
    assert.equal(proof.measurements.outageSeconds, 0.025);
    assert.equal(proof.snapshots[0].placements.api[0].nodeUid, 'node-a-uid');
    assert.equal(statSync(evidencePath).mode & 0o777, 0o400);

    for (const mutate of [
      (expected) => {
        expected.dependency = 'redis';
      },
      (expected) => {
        expected.thresholds.maxOutageSeconds = 1;
      },
      (expected) => {
        expected.adapterSha256.inject = 'f'.repeat(64);
      },
      (expected) => {
        expected.clusterServer = 'https://substituted.example';
      },
    ]) {
      const substituted = structuredClone(value.expectations);
      mutate(substituted);
      writeFileSync(value.expectationsPath, JSON.stringify(substituted));
      const refusal = spawnSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)], {
        encoding: 'utf8',
      });
      assert.notEqual(refusal.status, 0);
    }
    writeFileSync(value.expectationsPath, JSON.stringify(value.expectations));
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('release rehearsal binds target release and always performs verified rollback', () => {
  const value = fixture('release-upgrade-rollback');
  try {
    const evidencePath = execFileSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
    }).trim();
    execFileSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)], { cwd: root });
    const proof = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.deepEqual(
      proof.snapshots.map(({ phase }) => phase),
      ['before', 'target', 'rollback'],
    );
    assert.equal(proof.snapshots[0].images.api, beforeImages.api);
    assert.equal(proof.snapshots[1].images.api, targetImages.api);
    assert.equal(proof.snapshots[2].images.api, beforeImages.api);
    assert.match(readFileSync(value.calls, 'utf8'), /injectduringrecoverrecovered/u);
    value.expectations.drillId = 'different-drill';
    writeFileSync(value.expectationsPath, JSON.stringify(value.expectations));
    const stale = spawnSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)], {
      encoding: 'utf8',
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /does not match the reviewed expectations/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('failed target probe still runs rollback and publishes no valid proof', () => {
  const value = fixture('release-upgrade-rollback');
  try {
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: { ...value.env, MOCK_DURING_FAILURE: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(readFileSync(value.calls, 'utf8'), /injectduringrecoverrecovered/u);
    const evidencePath = join(value.evidence, 'release-upgrade-rollback-001.json');
    assert.equal(readFileSync(evidencePath).length, 0);
    assert.notEqual(
      spawnSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)]).status,
      0,
    );
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('target template cannot pass while Ready pods still run the prior image', () => {
  const value = fixture('release-upgrade-rollback');
  try {
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: { ...value.env, MOCK_STALE_PODS: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Ready pod does not run the reviewed image and digest/u);
    assert.match(readFileSync(value.calls, 'utf8'), /injectduringrecoverrecovered/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('reviewed adapter bytes are staged before a source path swap', () => {
  const value = fixture('zone-loss');
  try {
    const malicious = join(value.directory, 'malicious');
    executable(
      malicious,
      String.raw`printf malicious >>"$MOCK_CALLS"; printf fault >"$MOCK_STATE"; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
    );
    executable(
      value.config.adapters.baselineProbe,
      String.raw`printf baseline >>"$MOCK_CALLS"; cp "$MOCK_MALICIOUS" "$MOCK_INJECT_SOURCE"; printf '%s' '{"schemaVersion":"tixkit-production-adapter-result-v1","healthy":true,"outageMilliseconds":0,"observationCount":2}'`,
    );
    value.expectations.adapterSha256.baselineProbe = createHash('sha256')
      .update(readFileSync(value.config.adapters.baselineProbe))
      .digest('hex');
    writeFileSync(value.expectationsPath, JSON.stringify(value.expectations));
    const evidencePath = execFileSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: {
        ...value.env,
        MOCK_MALICIOUS: malicious,
        MOCK_INJECT_SOURCE: value.config.adapters.inject,
      },
      encoding: 'utf8',
    }).trim();
    execFileSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)]);
    assert.doesNotMatch(readFileSync(value.calls, 'utf8'), /malicious/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('SIGTERM after fault injection triggers bounded verified recovery', () => {
  const value = fixture('zone-loss');
  try {
    executable(
      value.config.adapters.inject,
      'printf inject >>"$MOCK_CALLS"; printf fault >"$MOCK_STATE"; kill -TERM "$PPID"; sleep 10',
    );
    updateAdapterExpectation(value, 'inject');
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interrupted|terminated|drill or verified recovery failed/u);
    assert.equal(readFileSync(join(value.directory, 'state'), 'utf8'), 'before');
    assert.match(readFileSync(value.calls, 'utf8'), /injectrecoverrecovered/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('SIGTERM in the final safe probe prevents destructive injection', () => {
  const value = fixture('zone-loss');
  try {
    executable(
      value.config.adapters.baselineProbe,
      'printf baseline >>"$MOCK_CALLS"; kill -TERM "$PPID"; sleep 10',
    );
    updateAdapterExpectation(value, 'baselineProbe');
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(readFileSync(value.calls, 'utf8'), /inject|recover/u);
    assert.equal(readFileSync(join(value.directory, 'state'), 'utf8'), 'before\n');
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('adapter timeout terminates the full process group before recovery', async () => {
  const value = fixture('zone-loss');
  try {
    const orphan = join(value.directory, 'orphan');
    executable(
      value.config.adapters.inject,
      '(trap "" TERM; exec </dev/null >/dev/null 2>&1; sleep 2; printf orphan >"$MOCK_ORPHAN") & printf inject >>"$MOCK_CALLS"; printf fault >"$MOCK_STATE"; sleep 10',
    );
    value.config.thresholds.adapterTimeoutSeconds = 1;
    value.expectations.thresholds.adapterTimeoutSeconds = 1;
    updateAdapterExpectation(value, 'inject');
    writeConfig(value);
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: { ...value.env, MOCK_ORPHAN: orphan },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out after 1s|drill or verified recovery failed/u);
    await delay(1_700);
    assert.equal(existsSync(orphan), false);
    assert.equal(readFileSync(join(value.directory, 'state'), 'utf8'), 'before');
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('rehearsal rejects a single-zone cluster before fault injection', () => {
  const value = fixture('zone-loss');
  try {
    const result = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: { ...value.env, MOCK_SINGLE_ZONE: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must span at least two zones/u);
    assert.doesNotMatch(readFileSync(value.calls, 'utf8'), /inject/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test('rehearsal refuses acknowledgement drift and evidence tampering', () => {
  const value = fixture('zone-loss');
  try {
    value.config.acknowledgement = 'yes';
    writeConfig(value);
    const refusal = spawnSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
    });
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, /acknowledgement must exactly equal/u);

    value.config.acknowledgement = 'I authorize production zone-loss fault injection and recovery';
    value.config.drillId = 'zone-loss-002';
    value.expectations.drillId = value.config.drillId;
    writeConfig(value);
    writeExpectations(value);
    const evidencePath = execFileSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
    }).trim();
    const proof = JSON.parse(readFileSync(evidencePath, 'utf8'));
    proof.measurements.recoverySeconds = 999;
    chmodSync(evidencePath, 0o600);
    writeFileSync(evidencePath, JSON.stringify(proof));
    const tampered = spawnSync(process.execPath, [verify, ...verifyArgs(value, evidencePath)], {
      encoding: 'utf8',
    });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /checksum mismatch/u);
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});

function hostedInput(value, evidencePath) {
  const evidenceBytes = readFileSync(evidencePath);
  const hostedKeys = generateKeyPairSync('ed25519');
  const hostedPublicKeyPem = hostedKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const tree = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8',
  }).trim();
  const receipt = {
    $schema: 'https://tixkit.com/schemas/hosted-production-dr-receipt.schema.json',
    schemaVersion: 1,
    kind: 'tixkit.hosted-production-dr-receipt',
    trustRecordId: 'dr-evidence',
    scope: 'self-hosted',
    source: { repository: 'tixkithq/tixkit', commit, tree },
    workflow: {
      repository: 'tixkithq/tixkit',
      path: '.github/workflows/production-dr.yml',
      runId: '123456789',
      attempt: 1,
      url: 'https://github.com/tixkithq/tixkit/actions/runs/123456789',
    },
    artifact: {
      kind: 'production-dr',
      sizeBytes: evidenceBytes.byteLength,
      sha256: createHash('sha256').update(evidenceBytes).digest('hex'),
    },
    validation: {
      validator: 'scripts/verify-production-rehearsal.mjs#verifyProductionRehearsal',
      version: 1,
      outcome: 'passed',
      expectationsSha256: createHash('sha256')
        .update(readFileSync(value.expectationsPath))
        .digest('hex'),
    },
    observedAt: JSON.parse(evidenceBytes).completedAt,
    signature: { algorithm: 'Ed25519', keyId: 'hosted-dr-2026', value: '' },
  };
  const resign = () => {
    receipt.signature.value = sign(
      null,
      hostedTrustReceiptSigningBytes(receipt),
      hostedKeys.privateKey,
    ).toString('base64');
  };
  resign();
  return {
    evidenceBytes,
    signatureBytes: readFileSync(`${evidencePath}.sig`),
    checksumBytes: readFileSync(`${evidencePath}.sha256`),
    publicKeyBytes: readFileSync(value.publicKeyPath),
    expectationsBytes: readFileSync(value.expectationsPath),
    receipt,
    keyring: {
      schemaVersion: 1,
      purpose: 'tixkit.hosted-trust-receipt',
      keys: {
        'hosted-dr-2026': {
          algorithm: 'Ed25519',
          publicKeyPem: hostedPublicKeyPem,
        },
      },
    },
    hostedPrivateKeyPem: hostedKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    root,
    now: Date.parse(receipt.observedAt),
    resign,
  };
}

test('hosted production DR combines semantic and receipt proof over one exact artifact', async (t) => {
  const value = fixture('zone-loss');
  try {
    const evidencePath = execFileSync(process.execPath, [prove, ...proveArgs(value)], {
      cwd: root,
      env: value.env,
      encoding: 'utf8',
    }).trim();
    const input = hostedInput(value, evidencePath);
    assert.equal(
      validateHostedProductionDrReceipt(input.receipt),
      true,
      JSON.stringify(validateHostedProductionDrReceipt.errors),
    );
    const result = verifyHostedProductionDr(input);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(result, {
      eligibleForReview: true,
      drillId: 'zone-loss-001',
      kind: 'zone-loss',
      sourceCommit: input.receipt.source.commit,
      sourceTree: input.receipt.source.tree,
      evidenceSha256: input.receipt.artifact.sha256,
      workflowRunId: '123456789',
      observedAt: input.receipt.observedAt,
    });

    await t.test('semantic pass cannot mask receipt signature failure', () => {
      const changed = { ...input, receipt: structuredClone(input.receipt) };
      changed.receipt.signature.value = `${'A'.repeat(86)}==`;
      assert.throws(() => verifyHostedProductionDr(changed), /receipt signature is invalid/u);
    });

    await t.test('receipt pass cannot mask semantic expectations failure', () => {
      const changed = { ...input, expectationsBytes: Buffer.from(input.expectationsBytes) };
      const expectations = JSON.parse(changed.expectationsBytes);
      expectations.drillId = 'substituted-drill';
      changed.expectationsBytes = Buffer.from(JSON.stringify(expectations));
      assert.throws(
        () => verifyHostedProductionDr(changed),
        /does not match the reviewed expectations/u,
      );
    });

    await t.test('signed receipt binds the exact reviewed expectations bytes', () => {
      const reformatted = Buffer.from(
        `${JSON.stringify(JSON.parse(input.expectationsBytes), null, 2)}\n`,
      );
      assert.equal(
        verifyProductionRehearsal({
          evidenceBytes: input.evidenceBytes,
          signatureBytes: input.signatureBytes,
          checksumBytes: input.checksumBytes,
          publicKeyBytes: input.publicKeyBytes,
          expectationsBytes: reformatted,
        }).verified,
        true,
      );
      assert.throws(
        () => verifyHostedProductionDr({ ...input, expectationsBytes: reformatted }),
        /does not match the dedicated contract/u,
      );
    });

    await t.test('receipt cannot bind different evidence bytes', () => {
      input.receipt.artifact.sha256 = 'f'.repeat(64);
      input.resign();
      assert.throws(
        () => verifyHostedProductionDr(input),
        /does not bind the verified evidence bytes/u,
      );
      input.receipt.artifact.sha256 = createHash('sha256')
        .update(input.evidenceBytes)
        .digest('hex');
      input.resign();
    });

    await t.test('semantic signature, checksum, and proof key substitutions fail closed', () => {
      assert.throws(
        () =>
          verifyHostedProductionDr({
            ...input,
            signatureBytes: Buffer.from(`${'A'.repeat(86)}==`),
          }),
        /signature mismatch/u,
      );
      assert.throws(
        () =>
          verifyHostedProductionDr({
            ...input,
            checksumBytes: Buffer.from(`${'0'.repeat(64)}  evidence.json`),
          }),
        /checksum mismatch/u,
      );
      const alternate = generateKeyPairSync('ed25519').publicKey.export({
        type: 'spki',
        format: 'pem',
      });
      assert.throws(
        () => verifyHostedProductionDr({ ...input, publicKeyBytes: Buffer.from(alternate) }),
        /signature mismatch/u,
      );
    });

    await t.test('receipt key confusion fails closed', () => {
      const alternate = generateKeyPairSync('ed25519').publicKey.export({
        type: 'spki',
        format: 'pem',
      });
      const keyring = structuredClone(input.keyring);
      keyring.keys['hosted-dr-2026'].publicKeyPem = alternate.toString();
      assert.throws(
        () => verifyHostedProductionDr({ ...input, keyring }),
        /receipt signature is invalid/u,
      );

      const confusedReceipt = structuredClone(input.receipt);
      const proofPublicKeyPem = readFileSync(value.publicKeyPath, 'utf8');
      const confusedKeyring = {
        schemaVersion: 1,
        purpose: 'tixkit.hosted-trust-receipt',
        keys: {
          'hosted-dr-2026': { algorithm: 'Ed25519', publicKeyPem: proofPublicKeyPem },
        },
      };
      confusedReceipt.signature.value = sign(
        null,
        hostedTrustReceiptSigningBytes(confusedReceipt),
        readFileSync(value.privateKeyPath),
      ).toString('base64');
      assert.throws(
        () =>
          verifyHostedProductionDr({
            ...input,
            receipt: confusedReceipt,
            keyring: confusedKeyring,
          }),
        /must use distinct signing keys/u,
      );
    });

    await t.test('source commit and tree must match the authoritative checkout', () => {
      for (const field of ['commit', 'tree']) {
        input.receipt.source[field] = 'f'.repeat(40);
        input.resign();
        assert.throws(
          () => verifyHostedProductionDr(input),
          /does not bind the authoritative checkout/u,
        );
        input.receipt.source[field] =
          field === 'commit'
            ? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
            : execFileSync('git', ['-C', root, 'rev-parse', 'HEAD^{tree}'], {
                encoding: 'utf8',
              }).trim();
      }
      input.resign();
    });

    await t.test(
      'unrelated repositories and inherited Git or PATH substitution cannot alter source',
      () => {
        const sourceRoot = join(value.directory, 'authoritative-source');
        mkdirSync(sourceRoot);
        const git = (arguments_, options = {}) =>
          execFileSync('/usr/bin/git', ['-C', sourceRoot, ...arguments_], {
            encoding: 'utf8',
            env: {
              ...process.env,
              GIT_NO_REPLACE_OBJECTS: options.replacements ? '0' : '1',
            },
          }).trim();
        git(['init', '--quiet']);
        writeFileSync(join(sourceRoot, 'identity.txt'), 'authoritative\n');
        git(['add', 'identity.txt']);
        git([
          '-c',
          'user.name=Tixkit Test',
          '-c',
          'user.email=test@tixkit.invalid',
          'commit',
          '-m',
          'authoritative',
          '--quiet',
        ]);
        const authoritativeCommit = git(['rev-parse', 'HEAD']);
        const authoritativeTree = git(['rev-parse', 'HEAD^{tree}']);
        writeFileSync(join(sourceRoot, 'identity.txt'), 'replacement\n');
        git(['add', 'identity.txt']);
        git([
          '-c',
          'user.name=Tixkit Test',
          '-c',
          'user.email=test@tixkit.invalid',
          'commit',
          '-m',
          'replacement',
          '--quiet',
        ]);
        const replacementCommit = git(['rev-parse', 'HEAD']);
        git(['checkout', '--detach', '--quiet', authoritativeCommit]);
        git(['replace', authoritativeCommit, replacementCommit]);

        const fakeBin = join(value.directory, 'fake-bin');
        mkdirSync(fakeBin);
        executable(join(fakeBin, 'git'), 'printf malicious-git >&2; exit 99');
        const originalEnvironment = {
          GIT_DIR: process.env.GIT_DIR,
          GIT_NO_REPLACE_OBJECTS: process.env.GIT_NO_REPLACE_OBJECTS,
          GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
          GIT_WORK_TREE: process.env.GIT_WORK_TREE,
          PATH: process.env.PATH,
        };
        const mainCommit = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const mainTree = execFileSync(
          '/usr/bin/git',
          ['-C', root, 'rev-parse', `${mainCommit}^{tree}`],
          {
            encoding: 'utf8',
            env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
          },
        ).trim();
        try {
          process.env.GIT_DIR = join(value.directory, 'missing-git-dir');
          process.env.GIT_NO_REPLACE_OBJECTS = '0';
          process.env.GIT_OBJECT_DIRECTORY = join(value.directory, 'missing-objects');
          process.env.GIT_WORK_TREE = join(value.directory, 'missing-worktree');
          process.env.PATH = fakeBin;
          input.receipt.source.commit = authoritativeCommit;
          input.receipt.source.tree = authoritativeTree;
          input.root = sourceRoot;
          input.resign();
          assert.throws(
            () => verifyHostedProductionDr(input),
            /must use its own repository checkout/u,
          );
          input.receipt.source.commit = mainCommit;
          input.receipt.source.tree = mainTree;
          input.root = root;
          input.resign();
          const protectedResult = verifyHostedProductionDr(input);
          assert.equal(protectedResult.sourceCommit, mainCommit);
          assert.equal(protectedResult.sourceTree, mainTree);
        } finally {
          for (const [name, prior] of Object.entries(originalEnvironment)) {
            if (prior === undefined) delete process.env[name];
            else process.env[name] = prior;
          }
          input.receipt.source.commit = execFileSync(
            '/usr/bin/git',
            ['-C', root, 'rev-parse', 'HEAD'],
            {
              encoding: 'utf8',
            },
          ).trim();
          input.receipt.source.tree = execFileSync(
            '/usr/bin/git',
            ['-C', root, 'rev-parse', 'HEAD^{tree}'],
            {
              encoding: 'utf8',
              env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
            },
          ).trim();
          input.root = root;
          input.resign();
        }
      },
    );

    await t.test('modified verifier and schema bytes cannot claim the committed source', () => {
      for (const path of [
        resolve(root, 'scripts/verify-hosted-production-dr.mjs'),
        resolve(root, 'distribution/hosted-production-dr-receipt.schema.json'),
      ]) {
        const original = readFileSync(path);
        try {
          writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
          assert.throws(
            () => verifyHostedProductionDr(input),
            /verifier source must be clean and tracked/u,
          );
        } finally {
          writeFileSync(path, original);
        }
      }
    });

    await t.test('dedicated record, artifact, workflow, and validator tuple is exact', () => {
      const cases = [
        ['trustRecordId', 'release-provenance'],
        ['artifact.kind', 'release-bundle'],
        ['workflow.path', '.github/workflows/public-artifact-release.yml'],
        ['validation.validator', 'scripts/verify-public-artifact-release.mjs'],
      ];
      for (const [path, replacement] of cases) {
        const [parent, child] = path.split('.');
        const original = child ? input.receipt[parent][child] : input.receipt[parent];
        if (child) input.receipt[parent][child] = replacement;
        else input.receipt[parent] = replacement;
        input.resign();
        assert.throws(
          () => verifyHostedProductionDr(input),
          /does not match the dedicated contract/u,
        );
        if (child) input.receipt[parent][child] = original;
        else input.receipt[parent] = original;
      }
      input.resign();
    });

    await t.test('observation must follow completion by no more than 24 hours', () => {
      const completedAt = Date.parse(JSON.parse(input.evidenceBytes).completedAt);
      for (const observedAt of [completedAt - 1, completedAt + 24 * 60 * 60 * 1_000 + 1]) {
        input.receipt.observedAt = new Date(observedAt).toISOString();
        input.now = observedAt;
        input.resign();
        assert.throws(
          () => verifyHostedProductionDr(input),
          /must follow completion within 24 hours/u,
        );
      }
      input.receipt.observedAt = new Date(completedAt).toISOString();
      input.now = completedAt;
      input.resign();
    });

    await t.test('CLI rejects duplicate arguments and symlink indirection without writes', () => {
      const receiptPath = join(value.directory, 'hosted-receipt.json');
      const keyringPath = join(value.directory, 'hosted-keyring.json');
      writeFileSync(receiptPath, `${canonicalHostedTrustJson(input.receipt)}\n`);
      writeFileSync(keyringPath, `${canonicalHostedTrustJson(input.keyring)}\n`);
      const args = [
        '--evidence',
        evidencePath,
        '--signature',
        `${evidencePath}.sig`,
        '--checksum',
        `${evidencePath}.sha256`,
        '--public-key',
        value.publicKeyPath,
        '--expectations',
        value.expectationsPath,
        '--receipt',
        receiptPath,
        '--trusted-keyring',
        keyringPath,
      ];
      const before = readdirSync(value.directory, { recursive: true }).sort();
      const output = execFileSync(process.execPath, [verifyHosted, ...args], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(JSON.parse(output).eligibleForReview, true);
      assert.deepEqual(readdirSync(value.directory, { recursive: true }).sort(), before);
      const duplicate = spawnSync(
        process.execPath,
        [verifyHosted, ...args, '--receipt', receiptPath],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
      assert.notEqual(duplicate.status, 0);
      const linked = join(value.directory, 'linked-receipt.json');
      symlinkSync(receiptPath, linked);
      const linkedArgs = [...args];
      linkedArgs[linkedArgs.indexOf(receiptPath)] = linked;
      const refused = spawnSync(process.execPath, [verifyHosted, ...linkedArgs], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /non-symlink regular file/u);
    });

    await t.test(
      'independent producer creates one canonical verified receipt and refuses overwrite',
      () => {
        const privateKeyPath = join(value.directory, 'hosted-private-key.pem');
        const keyringPath = join(value.directory, 'producer-keyring.json');
        const outputPath = join(value.directory, 'produced-hosted-receipt.json');
        writeFileSync(privateKeyPath, input.hostedPrivateKeyPem, { mode: 0o640 });
        writeFileSync(keyringPath, `${canonicalHostedTrustJson(input.keyring)}\n`, { mode: 0o400 });
        const args = [
          '--evidence',
          evidencePath,
          '--signature',
          `${evidencePath}.sig`,
          '--checksum',
          `${evidencePath}.sha256`,
          '--public-key',
          value.publicKeyPath,
          '--expectations',
          value.expectationsPath,
          '--receipt-private-key',
          privateKeyPath,
          '--receipt-key-id',
          'hosted-dr-2026',
          '--trusted-keyring',
          keyringPath,
          '--run-id',
          '123456789',
          '--run-attempt',
          '1',
          '--output',
          outputPath,
        ];
        const insecure = spawnSync(process.execPath, [createHostedReceipt, ...args], {
          cwd: root,
          encoding: 'utf8',
        });
        assert.notEqual(insecure.status, 0);
        assert.match(insecure.stderr, /direct owner-only file/u);
        assert.equal(existsSync(outputPath), false);
        chmodSync(privateKeyPath, 0o400);
        const created = JSON.parse(
          execFileSync(process.execPath, [createHostedReceipt, ...args], {
            cwd: root,
            encoding: 'utf8',
          }),
        );
        assert.equal(created.output, join(realpathSync(value.directory), basename(outputPath)));
        assert.equal(statSync(outputPath).mode & 0o777, 0o400);
        const receiptBytes = readFileSync(outputPath);
        const produced = JSON.parse(receiptBytes);
        assert.deepEqual(receiptBytes, Buffer.from(`${canonicalHostedTrustJson(produced)}\n`));
        assert.equal(produced.artifact.sha256, input.receipt.artifact.sha256);
        const duplicate = spawnSync(process.execPath, [createHostedReceipt, ...args], {
          cwd: root,
          encoding: 'utf8',
        });
        assert.notEqual(duplicate.status, 0);
        assert.match(duplicate.stderr, /EEXIST|file already exists/u);
        chmodSync(outputPath, 0o600);
      },
    );

    await t.test('staging closes the bundle and rejects adapter-created extra files', () => {
      const staged = join(value.directory, 'closed-intermediate');
      mkdirSync(staged, { mode: 0o700 });
      const stageArgs = [
        '--evidence-dir',
        dirname(evidencePath),
        '--drill-id',
        'zone-loss-001',
        '--kind',
        'zone-loss',
        '--dependency',
        'none',
        '--config',
        value.configPath,
        '--config-sha256',
        createHash('sha256').update(readFileSync(value.configPath)).digest('hex'),
        '--expectations',
        value.expectationsPath,
        '--expectations-sha256',
        createHash('sha256').update(readFileSync(value.expectationsPath)).digest('hex'),
        '--public-key',
        value.publicKeyPath,
        '--public-key-sha256',
        createHash('sha256').update(readFileSync(value.publicKeyPath)).digest('hex'),
        '--stage-output',
        realpathSync(staged),
      ];
      const result = stageProductionDrBundle(stageArgs);
      assert.equal(result.drillId, 'zone-loss-001');
      assert.deepEqual(readdirSync(staged).sort(), [
        'config.json',
        'expectations.json',
        'proof-public-key.pem',
        'zone-loss-001.json',
        'zone-loss-001.json.sha256',
        'zone-loss-001.json.sig',
      ]);
      const leaked = join(dirname(evidencePath), 'adapter-leak.txt');
      writeFileSync(leaked, 'sensitive adapter output');
      const refusedOutput = join(value.directory, 'refused-intermediate');
      mkdirSync(refusedOutput, { mode: 0o700 });
      const refusedArgs = [...stageArgs];
      refusedArgs[refusedArgs.lastIndexOf(realpathSync(staged))] = realpathSync(refusedOutput);
      assert.throws(() => stageProductionDrBundle(refusedArgs), /missing or additional files/u);
      assert.deepEqual(readdirSync(refusedOutput), []);
      rmSync(leaked);
    });
  } finally {
    rmSync(value.directory, { recursive: true, force: true });
  }
});
