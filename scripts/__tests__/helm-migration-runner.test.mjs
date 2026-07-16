import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const runner = resolve(root, 'infra/scripts/run-helm-migration.sh');

function harness({ realHelm = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-helm-migration-'));
  const helm = join(directory, 'helm');
  const kubectl = join(directory, 'kubectl');
  writeFileSync(
    helm,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$MOCK_HELM_ARGS"
if [[ "$*" == *"templates/external-secret.yaml"* ]]; then
  printf '%s\\n' 'apiVersion: external-secrets.io/v1' 'kind: ExternalSecret' 'spec:' '  data:' '    - remoteRef:' '        key: database' '      secretKey: DATABASE_URL' '    - remoteRef:' '        key: redis' '      secretKey: REDIS_URL' '    - remoteRef:' '        key: temporal' '      secretKey: TEMPORAL_ADDRESS'
elif [[ "$*" == *"templates/migration-network-policy.yaml"* ]]; then
  printf '%s\\n' 'apiVersion: networking.k8s.io/v1' 'kind: NetworkPolicy' 'metadata:' '  name: tixkit-tixkit-migration-egress'
else
  invocation=missing
  previous=
  for argument in "$@"; do
    if [[ "$previous" == --set && "$argument" == migrations.invocation=* ]]; then
      invocation="\${argument#*=}"
    fi
    previous="$argument"
  done
  printf '%s\\n' 'apiVersion: batch/v1' 'kind: Job' 'metadata:' "  name: tixkit-tixkit-migrate-\${invocation}"
fi
`,
  );
  writeFileSync(
    kubectl,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *" create configmap "* ]]; then
  [[ "\${MOCK_LOCK_FAIL:-0}" != 1 ]]
elif [[ "$args" == *" delete configmap "* ]]; then
  exit 0
elif [[ "$args" == *" get secret "* && "$args" == *"jsonpath="* ]]; then
  if [[ -z "\${MOCK_MISSING:-}" || "$args" != *".data.\${MOCK_MISSING}"* ]]; then
    printf c2VjcmV0
  fi
elif [[ "$args" == *" create -f -"* ]]; then
  manifest="$(cat)"
  printf '%s\\n' "$manifest" >"$MOCK_APPLIED"
  name="$(printf '%s\\n' "$manifest" | awk '/^[[:space:]]*name:/ { print $2; exit }')"
  printf 'job.batch/%s\\n' "$name"
  printf '%s\\n' "$name" >>"$MOCK_EXECUTIONS"
elif [[ "$args" == *" apply -f -"* ]]; then
  cat >/dev/null
  printf 'networkpolicy.networking.k8s.io/tixkit-tixkit-migration-egress\\n'
elif [[ "$args" == *" logs "* ]]; then
  printf 'migration complete\\n'
fi
`,
  );
  chmodSync(helm, 0o755);
  chmodSync(kubectl, 0o755);
  const values = join(directory, 'production.yaml');
  const productionValues = parse(
    readFileSync(resolve(root, 'infra/helm/tixkit/values-production.yaml'), 'utf8'),
  );
  productionValues.global = { imageRegistry: 'ghcr.io/tixkit/tixkit' };
  for (const [component, digest] of Object.entries({
    api: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    worker: 'sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0',
    checkout: 'sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
    admin: 'sha256:3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012',
  }))
    productionValues[component].imageDigest = digest;
  productionValues.migrations.imageDigest =
    'sha256:456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123';
  productionValues.migrations.strategy = 'manual';
  productionValues.uploads.malwareScanner.host = 'clamav.security.svc.cluster.local';
  productionValues.networkPolicy.externalEgressCidrs = ['192.0.2.0/24'];
  productionValues.networkPolicy.databaseEgressCidrs = ['198.51.100.0/24'];
  productionValues.secrets = {
    mode: 'external',
    name: 'tixkit-production-secrets',
    s3ServerSideEncryption: 'AES256',
    externalSecret: {
      secretStoreName: 'production-store',
      data: externalSecretKeysForValues().map((key) => ({
        secretKey: key,
        remoteRef: { key: `tixkit/${key.toLowerCase()}` },
      })),
    },
  };
  writeFileSync(values, stringify(productionValues));
  const env = {
    ...process.env,
    HELM: realHelm ? 'helm' : helm,
    KUBECTL: kubectl,
    VALUES_FILE: values,
    SECRET_NAME: 'tixkit-production-secrets',
    MOCK_HELM_ARGS: join(directory, 'helm-args'),
    MOCK_APPLIED: join(directory, 'applied.yaml'),
    MOCK_EXECUTIONS: join(directory, 'executions'),
  };
  return { directory, env };
}

function externalSecretKeysForValues() {
  return [
    'DATABASE_URL',
    'REDIS_URL',
    'TEMPORAL_ADDRESS',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PUBLISHABLE_KEY',
    'METRICS_BEARER_TOKEN',
    'DASHBOARD_CURSOR_SIGNING_KEY',
    'CLERK_SECRET_KEY',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_WEBHOOK_SECRET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'PROMETHEUS_PUSHGATEWAY_URL',
  ];
}

test('manual migration waits for required secrets and applies only the migration Job', () => {
  const { directory, env } = harness();
  try {
    const output = execFileSync(runner, {
      cwd: root,
      env: { ...env, MIGRATION_INVOCATION: 'run-one' },
      encoding: 'utf8',
    });
    assert.match(output, /migration complete/);
    assert.match(
      readFileSync(env.MOCK_HELM_ARGS, 'utf8'),
      /--show-only templates\/migrations.yaml/,
    );
    assert.match(readFileSync(env.MOCK_HELM_ARGS, 'utf8'), /migrations.execution=manual-run/);
    assert.match(readFileSync(env.MOCK_HELM_ARGS, 'utf8'), /migrations.invocation=run-one/);
    assert.match(readFileSync(env.MOCK_APPLIED, 'utf8'), /kind: Job/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual migration parses the required inventory from the real Helm chart', () => {
  const { directory, env } = harness({ realHelm: true });
  try {
    execFileSync(runner, {
      cwd: root,
      env: { ...env, MIGRATION_INVOCATION: 'real-chart' },
    });
    assert.match(
      readFileSync(env.MOCK_APPLIED, 'utf8'),
      /name: tixkit-tixkit-migrate-[0-9a-f]{8}-real-chart/,
    );
    assert.match(
      readFileSync(env.MOCK_EXECUTIONS, 'utf8').trim(),
      /^tixkit-tixkit-migrate-[0-9a-f]{8}-real-chart$/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual migration creates a fresh immutable Job for each invocation', () => {
  const { directory, env } = harness();
  try {
    execFileSync(runner, { cwd: root, env: { ...env, MIGRATION_INVOCATION: 'run-one' } });
    execFileSync(runner, { cwd: root, env: { ...env, MIGRATION_INVOCATION: 'run-two' } });
    assert.deepEqual(readFileSync(env.MOCK_EXECUTIONS, 'utf8').trim().split('\n'), [
      'tixkit-tixkit-migrate-run-one',
      'tixkit-tixkit-migrate-run-two',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual migration rejects an overlapping invocation before rendering a Job', () => {
  const { directory, env } = harness();
  try {
    const result = spawnSync(runner, {
      cwd: root,
      env: { ...env, MOCK_LOCK_FAIL: '1' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /another migration owns lock/);
    assert.throws(() => readFileSync(env.MOCK_EXECUTIONS));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual migration fails before rendering or creating a Job when the reconciled Secret is incomplete', () => {
  const { directory, env } = harness();
  try {
    const result = spawnSync(runner, {
      cwd: root,
      env: { ...env, MOCK_MISSING: 'REDIS_URL' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing REDIS_URL/);
    assert.doesNotMatch(readFileSync(env.MOCK_HELM_ARGS, 'utf8'), /templates\/migrations.yaml/);
    assert.throws(() => readFileSync(env.MOCK_APPLIED));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
