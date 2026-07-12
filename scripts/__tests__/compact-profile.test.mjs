import assert from 'node:assert/strict';
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
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.throws(
      () => initializeCompactEnvironment({ environmentPath: first }),
      /refusing to overwrite/u,
    );
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
