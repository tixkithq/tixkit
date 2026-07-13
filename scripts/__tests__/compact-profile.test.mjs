import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  initializeCompactEnvironment,
  runRecoveryActions,
  validateCompactEnvironment,
} from '../compact.mjs';

const root = resolve(import.meta.dirname, '../..');
const composePath = resolve(root, 'infra/compact/compose.yml');

test('Compact topology contains the complete single-database application stack', () => {
  const compose = parse(readFileSync(composePath, 'utf8'));
  const services = new Set(Object.keys(compose.services));
  for (const required of [
    'postgres',
    'redis',
    'temporal-postgres',
    'temporal',
    'temporal-ui',
    'minio',
    'storage-init',
    'migrate',
    'seed',
    'api',
    'worker',
    'checkout',
    'admin',
  ])
    assert.ok(services.has(required), `missing Compact service ${required}`);
  assert.equal(services.has('mysql'), false);
  assert.equal(compose.services.api.depends_on.migrate.condition, 'service_completed_successfully');
  assert.equal(compose.services.api.depends_on.seed.condition, 'service_completed_successfully');
  assert.equal(
    compose.services.api.depends_on['storage-init'].condition,
    'service_completed_successfully',
  );
  assert.equal(compose.services.worker.depends_on.api.condition, 'service_healthy');
  assert.deepEqual(compose.services.worker.healthcheck.test, [
    'CMD',
    'node',
    'packages/workflows/dist/healthcheck.js',
  ]);
  assert.equal(compose['x-app-environment'].TIXKIT_RUNTIME_MODE, 'development');
  assert.equal(compose['x-app-environment'].TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID, 'compact-v1');
  assert.match(compose['x-app-environment'].TIXKIT_MIGRATION_CURSOR_KEYS, /compact-v1/u);
  assert.match(compose.services.api.environment.TIXKIT_DEPLOYMENT_ID, /TIXKIT_DEPLOYMENT_ID/u);
  assert.match(
    compose.services.api.environment.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64,
    /PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64/u,
  );
  assert.match(
    compose.services.api.environment.PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS,
    /PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS/u,
  );
  for (const service of ['storage-init', 'migrate', 'seed', 'worker']) {
    assert.equal(
      compose.services[service].environment.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64,
      undefined,
    );
    assert.equal(
      compose.services[service].environment.PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64,
      undefined,
    );
    assert.equal(
      compose.services[service].environment.PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64,
      undefined,
    );
    assert.equal(
      compose.services[service].environment.PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64,
      undefined,
    );
  }
  assert.equal(
    compose.services.api.environment.PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64,
    undefined,
  );
  assert.match(compose['x-app-environment'].ADMIN_DASHBOARD_URL, /ADMIN_PORT/u);
  assert.match(compose['x-app-environment'].CHECKOUT_URL, /CHECKOUT_PORT/u);
  assert.match(compose.services.postgres.image, /@sha256:[a-f0-9]{64}$/u);
  assert.match(compose.services.minio.image, /@sha256:[a-f0-9]{64}$/u);
});

test('Compact rejects weak, placeholder, and permissive existing environments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-validation-'));
  const environmentPath = resolve(directory, '.env');
  try {
    initializeCompactEnvironment({ environmentPath });
    assert.doesNotThrow(() => validateCompactEnvironment({ environmentPath }));
    chmodSync(environmentPath, 0o644);
    assert.throws(() => validateCompactEnvironment({ environmentPath }), /must have mode 0600/u);
    chmodSync(environmentPath, 0o600);
    writeFileSync(
      environmentPath,
      readFileSync(environmentPath, 'utf8').replace(
        /^POSTGRES_PASSWORD=.*$/mu,
        'POSTGRES_PASSWORD=replace-with-generated-value',
      ),
    );
    assert.throws(
      () => validateCompactEnvironment({ environmentPath }),
      /unsafe value for POSTGRES_PASSWORD/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact environment generation creates unique non-placeholder secrets with mode 0600', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-env-'));
  const first = resolve(directory, '.env');
  const second = resolve(directory, '.env-second');
  try {
    initializeCompactEnvironment({ environmentPath: first });
    initializeCompactEnvironment({ environmentPath: second });
    const firstValues = Object.fromEntries(
      readFileSync(first, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/su).slice(0, 2)),
    );
    const secondValues = Object.fromEntries(
      readFileSync(second, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(/=(.*)/su).slice(0, 2)),
    );
    for (const key of [
      'POSTGRES_PASSWORD',
      'TEMPORAL_POSTGRES_PASSWORD',
      'MINIO_ROOT_PASSWORD',
      'QR_SIGNING_SECRET',
      'OFFLINE_MANIFEST_SIGNING_KEY',
      'WIDGET_IMPRESSION_HASH_SECRET',
      'TIXKIT_MIGRATION_CURSOR_KEY',
    ]) {
      assert.ok(firstValues[key].length >= 32);
      assert.notEqual(firstValues[key], secondValues[key]);
      assert.doesNotMatch(firstValues[key], /replace|password|secret/i);
    }
    assert.match(firstValues.TIXKIT_DEPLOYMENT_ID, /^compact_[a-f0-9]{32}$/u);
    assert.notEqual(firstValues.TIXKIT_DEPLOYMENT_ID, secondValues.TIXKIT_DEPLOYMENT_ID);
    assert.equal(firstValues.TIXKIT_OPERATING_MODEL, 'self-hosted');
    for (const [keyIdName, privateKeyName] of [
      ['PORTABILITY_BUNDLE_SIGNING_KEY_ID', 'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64'],
      ['PORTABILITY_PAYLOAD_SIGNING_KEY_ID', 'PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64'],
      ['PORTABILITY_DRY_RUN_SIGNING_KEY_ID', 'PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64'],
      ['PORTABILITY_CUTOVER_SIGNING_KEY_ID', 'PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64'],
    ]) {
      assert.notEqual(firstValues[keyIdName], secondValues[keyIdName]);
      const privateKey = createPrivateKey(
        Buffer.from(firstValues[privateKeyName], 'base64').toString('utf8'),
      );
      assert.equal(privateKey.asymmetricKeyType, 'ed25519');
    }
    assert.deepEqual(JSON.parse(firstValues.PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS), {});
    const cutoverTrust = JSON.parse(firstValues.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS);
    assert.deepEqual(Object.keys(cutoverTrust), [firstValues.PORTABILITY_CUTOVER_SIGNING_KEY_ID]);
    const cutoverPrivateKey = createPrivateKey(
      Buffer.from(firstValues.PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64, 'base64').toString(
        'utf8',
      ),
    );
    assert.ok(
      createPublicKey(cutoverTrust[firstValues.PORTABILITY_CUTOVER_SIGNING_KEY_ID]).equals(
        createPublicKey(cutoverPrivateKey),
      ),
    );
    assert.doesNotMatch(firstValues.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS, /PRIVATE KEY/u);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.throws(
      () => initializeCompactEnvironment({ environmentPath: first }),
      /refusing to overwrite/u,
    );
    const validSecondEnvironment = readFileSync(second, 'utf8');
    writeFileSync(
      second,
      validSecondEnvironment.replace(
        /^PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64=.*$/mu,
        'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64=not-canonical-base64',
      ),
    );
    assert.throws(
      () => validateCompactEnvironment({ environmentPath: second }),
      /invalid PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64/u,
    );
    writeFileSync(
      second,
      validSecondEnvironment.replace(
        /^PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS=.*$/mu,
        'PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS={}',
      ),
    );
    assert.throws(
      () => validateCompactEnvironment({ environmentPath: second }),
      /cutover trust contains invalid Ed25519 public-key entries/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact-generated portability environment satisfies runtime parsers and Compose isolation', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-portability-'));
  const environmentPath = resolve(directory, '.env');
  try {
    initializeCompactEnvironment({ environmentPath });
    execFileSync(
      'bun',
      [
        '-e',
        `import { readFileSync } from 'node:fs';
import { portableExportSigningFromEnvironment } from './src/services/portable-export.ts';
import { portableCutoverTrustFromEnvironment, portableDryRunAttestationFromEnvironment } from './src/services/portable-import-control.ts';
const environment = Object.fromEntries(readFileSync(process.env.COMPACT_ENV_PATH, 'utf8').split('\\n').filter(Boolean).map((line) => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)]; }));
portableExportSigningFromEnvironment(environment);
portableDryRunAttestationFromEnvironment(environment);
portableCutoverTrustFromEnvironment(environment);`,
      ],
      {
        cwd: resolve(root, 'packages/api'),
        env: { ...process.env, COMPACT_ENV_PATH: environmentPath },
        stdio: 'pipe',
      },
    );
    if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
      context.skip('Docker Compose is unavailable');
      return;
    }
    const rendered = JSON.parse(
      execFileSync(
        'docker',
        ['compose', '--env-file', environmentPath, '-f', composePath, 'config', '--format', 'json'],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    assert.equal(rendered.services.api.environment.TIXKIT_OPERATING_MODEL, 'self-hosted');
    assert.match(
      rendered.services.api.environment.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64,
      /^[A-Za-z0-9+/]+=*$/u,
    );
    for (const service of ['storage-init', 'migrate', 'seed', 'worker']) {
      assert.equal(
        rendered.services[service].environment.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64,
        undefined,
      );
      assert.equal(
        rendered.services[service].environment.PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64,
        undefined,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact-only insecure frontend build escape stays limited to loopback URLs', () => {
  for (const dockerfile of ['Dockerfile.admin', 'Dockerfile.checkout']) {
    const content = readFileSync(resolve(root, dockerfile), 'utf8');
    assert.match(content, /ARG ALLOW_INSECURE_LOCAL_ORIGINS=0/u);
    assert.match(content, /http:\/\/localhost:\*\|http:\/\/127\.0\.0\.1:\*/u);
    assert.doesNotMatch(content, /http:\/\/0\.0\.0\.0/u);
    assert.match(content, /node_modules/u);
  }
});

test('Compact lifecycle builds application images sequentially before startup', () => {
  const content = readFileSync(resolve(root, 'scripts/compact.mjs'), 'utf8');
  assert.match(content, /for \(const service of \['api', 'worker', 'checkout', 'admin'\]\)/u);
  assert.match(content, /buildApplications\(\);/u);
  assert.match(content, /buildApplications\(\{ pull: true \}\);/u);
  assert.doesNotMatch(content, /compose\(\['build', '--pull'\]\)/u);
});

test('Compact recovery stages and validates complete snapshots before cutover', () => {
  const content = readFileSync(resolve(root, 'scripts/compact.mjs'), 'utf8');
  assert.match(content, /schemaVersion: 2/u);
  assert.match(content, /application-object-and-temporal-logical-snapshot/u);
  assert.match(content, /Compact backup destination must be empty/u);
  assert.match(content, /Compact object archive contains an unsafe entry/u);
  assert.match(content, /Restore staging failed/u);
  assert.match(content, /_rollback_/u);
  assert.match(content, /temporal-visibility\.sql/u);
  assert.match(content, /manifest\.sourceCommit !== currentCommit/u);
  assert.match(content, /objectRollbackReady/u);
});

test('Compact recovery attempts every rollback and restart action and aggregates failures', () => {
  const attempted = [];
  const primary = new Error('cutover failed');
  assert.throws(
    () =>
      runRecoveryActions(primary, [
        () => {
          attempted.push('database-one');
          throw new Error('database rollback failed');
        },
        () => attempted.push('database-two'),
        () => {
          attempted.push('objects');
          throw new Error('object rollback failed');
        },
        () => attempted.push('restart'),
      ]),
    (error) => error instanceof AggregateError && error.errors.length === 3,
  );
  assert.deepEqual(attempted, ['database-one', 'database-two', 'objects', 'restart']);
});
