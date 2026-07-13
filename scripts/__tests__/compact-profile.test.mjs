import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  initializeCompactEnvironment,
  parseCompactCliArguments,
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
  assert.match(compose['x-app-environment'].S3_PUBLIC_ENDPOINT, /S3_PUBLIC_ENDPOINT/u);
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

test('Compact retains historical default image behavior without rewriting its environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-legacy-images-'));
  const environmentPath = resolve(directory, '.env');
  try {
    initializeCompactEnvironment({ environmentPath });
    writeFileSync(
      environmentPath,
      readFileSync(environmentPath, 'utf8').replace(
        /^(?:COMPOSE_PROJECT_NAME|TIXKIT_IMAGE_MODE|TIXKIT_(?:API|WORKER|CHECKOUT|ADMIN)_IMAGE)=.*\n/gmu,
        '',
      ),
      { mode: 0o600 },
    );
    assert.doesNotThrow(() => validateCompactEnvironment({ environmentPath }));
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
    assert.equal(firstValues.COMPOSE_PROJECT_NAME, 'tixkit-compact');
    assert.notEqual(firstValues.TIXKIT_DEPLOYMENT_ID, secondValues.TIXKIT_DEPLOYMENT_ID);
    assert.equal(firstValues.TIXKIT_OPERATING_MODEL, 'self-hosted');
    assert.equal(firstValues.S3_PUBLIC_ENDPOINT, 'http://localhost:9000');
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
  const secondEnvironmentPath = resolve(directory, '.env-second');
  const releaseEnvironmentPath = resolve(directory, '.env-release');
  try {
    initializeCompactEnvironment({
      environmentPath,
      projectName: 'tixkit-compact-isolated-test',
    });
    initializeCompactEnvironment({
      environmentPath: secondEnvironmentPath,
      projectName: 'tixkit-compact-isolated-second',
    });
    initializeCompactEnvironment({
      environmentPath: releaseEnvironmentPath,
      imageMode: 'release',
      version: '1.2.3',
    });
    assert.doesNotThrow(() =>
      validateCompactEnvironment({ environmentPath: releaseEnvironmentPath }),
    );
    writeFileSync(
      secondEnvironmentPath,
      readFileSync(secondEnvironmentPath, 'utf8')
        .replace(/^API_PORT=.*$/mu, 'API_PORT=4100')
        .replace(/^CHECKOUT_PORT=.*$/mu, 'CHECKOUT_PORT=3100')
        .replace(/^ADMIN_PORT=.*$/mu, 'ADMIN_PORT=3101')
        .replace(/^MINIO_API_PORT=.*$/mu, 'MINIO_API_PORT=9100')
        .replace(/^MINIO_CONSOLE_PORT=.*$/mu, 'MINIO_CONSOLE_PORT=9101')
        .replace(/^S3_PUBLIC_ENDPOINT=.*$/mu, 'S3_PUBLIC_ENDPOINT=http://localhost:9100'),
    );
    assert.doesNotThrow(() =>
      validateCompactEnvironment({ environmentPath: secondEnvironmentPath }),
    );
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
    assert.equal(rendered.name, 'tixkit-compact-isolated-test');
    const secondRendered = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          '--env-file',
          secondEnvironmentPath,
          '-f',
          composePath,
          'config',
          '--format',
          'json',
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    assert.equal(secondRendered.name, 'tixkit-compact-isolated-second');
    for (const service of ['api', 'worker', 'checkout', 'admin']) {
      assert.notEqual(rendered.services[service].image, secondRendered.services[service].image);
    }
    const releaseRendered = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          '--env-file',
          releaseEnvironmentPath,
          '-f',
          composePath,
          'config',
          '--format',
          'json',
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    for (const service of ['api', 'worker', 'checkout', 'admin']) {
      assert.equal(releaseRendered.services[service].image, `tixkit/${service}:1.2.3`);
      assert.equal(releaseRendered.services[service].image.includes(releaseRendered.name), false);
    }
    assert.equal(
      rendered.services.checkout.build.args.NEXT_PUBLIC_TIXKIT_API_BASE_URL,
      'http://localhost:4000/v1',
    );
    assert.equal(
      secondRendered.services.checkout.build.args.NEXT_PUBLIC_TIXKIT_API_BASE_URL,
      'http://localhost:4100/v1',
    );
    assert.equal(
      secondRendered.services.api.environment.S3_PUBLIC_ENDPOINT,
      'http://localhost:9100',
    );
    assert.equal(String(secondRendered.services.minio.ports[0].published), '9100');
    assert.deepEqual(
      Object.values(rendered.volumes).map(({ name }) => name),
      [
        'tixkit-compact-isolated-test_minio-data',
        'tixkit-compact-isolated-test_postgres-data',
        'tixkit-compact-isolated-test_redis-data',
        'tixkit-compact-isolated-test_temporal-data',
      ],
    );
    assert.ok(
      Object.values(secondRendered.volumes).every(({ name }) =>
        name.startsWith('tixkit-compact-isolated-second_'),
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
    writeFileSync(
      releaseEnvironmentPath,
      readFileSync(releaseEnvironmentPath, 'utf8').replace(/^API_PORT=.*$/mu, 'API_PORT=4100'),
    );
    assert.throws(
      () => validateCompactEnvironment({ environmentPath: releaseEnvironmentPath }),
      /release image mode currently requires the default project and ports/u,
    );
    writeFileSync(
      environmentPath,
      readFileSync(environmentPath, 'utf8').replace(
        /^TIXKIT_VERSION=.*$/mu,
        'TIXKIT_VERSION=1.2.3',
      ),
    );
    assert.throws(
      () => validateCompactEnvironment({ environmentPath }),
      /source image mode must use the local version identity/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact CLI selects an isolated environment and project without consuming lifecycle flags', () => {
  const selected = parseCompactCliArguments([
    '--env-file',
    './tmp/source.env',
    '--project-name',
    'tixkit-compact-source',
    '--volumes',
  ]);
  assert.equal(selected.environmentPath, resolve('./tmp/source.env'));
  assert.equal(selected.projectName, 'tixkit-compact-source');
  assert.deepEqual(selected.remaining, ['--volumes']);
  assert.throws(
    () => parseCompactCliArguments(['--project-name', 'Invalid Project']),
    /project name must use/u,
  );
  assert.throws(() => parseCompactCliArguments(['--env-file']), /requires a value/u);
  assert.throws(
    () => parseCompactCliArguments(['--env-file', './one.env', '--env-file', './two.env']),
    /--env-file may only be provided once/u,
  );
  assert.throws(
    () => parseCompactCliArguments(['--project-name', 'one', '--project-name', 'two']),
    /--project-name may only be provided once/u,
  );
  assert.deepEqual(parseCompactCliArguments(['--image-mode', 'release', '--version', '1.2.3']), {
    environmentPath: resolve(root, 'infra/compact/.env'),
    projectName: undefined,
    imageMode: 'release',
    version: '1.2.3',
    remaining: [],
  });
  assert.throws(
    () => parseCompactCliArguments(['--image-mode', 'source', '--image-mode', 'release']),
    /--image-mode may only be provided once/u,
  );
  assert.throws(
    () =>
      initializeCompactEnvironment({
        environmentPath: resolve(tmpdir(), `tixkit-invalid-source-version-${Date.now()}.env`),
        imageMode: 'source',
        version: '1.2.3',
      }),
    /source image mode must use the local version identity/u,
  );
  assert.throws(
    () =>
      initializeCompactEnvironment({
        environmentPath: resolve(tmpdir(), `tixkit-invalid-release-project-${Date.now()}.env`),
        projectName: 'another-project',
        imageMode: 'release',
        version: '1.2.3',
      }),
    /release image mode currently requires the default project and ports/u,
  );
});

test('Compact lifecycle routes one environment and project through Docker, recovery, and deletion', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-cli-routing-'));
  const binaryDirectory = resolve(directory, 'bin');
  const dockerPath = resolve(binaryDirectory, 'docker');
  const logPath = resolve(directory, 'docker.log');
  const sourceEnvironment = resolve(directory, 'source.env');
  const otherEnvironment = resolve(directory, 'other.env');
  const releaseEnvironment = resolve(directory, 'release.env');
  const legacyEnvironment = resolve(directory, 'legacy.env');
  const backupDirectory = resolve(directory, 'backup');
  const failedBackupDirectory = resolve(directory, 'failed-backup');
  const upgradeBackupDirectory = resolve(directory, 'upgrade-backup');
  const projectName = 'tixkit-compact-routing-source';
  try {
    mkdirSync(binaryDirectory, { recursive: true });
    writeFileSync(
      dockerPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "$COMPACT_DOCKER_LOG"
case "$*" in
  *"$COMPACT_DOCKER_FAIL_MATCH"*)
    if [ -n "$COMPACT_DOCKER_FAIL_MATCH" ]; then exit 23; fi
    ;;
esac
printf 'fixture\n'
`,
    );
    chmodSync(dockerPath, 0o700);
    initializeCompactEnvironment({ environmentPath: sourceEnvironment, projectName });
    initializeCompactEnvironment({
      environmentPath: otherEnvironment,
      projectName: 'tixkit-compact-routing-other',
    });
    initializeCompactEnvironment({
      environmentPath: releaseEnvironment,
      imageMode: 'release',
      version: '1.2.3',
    });
    initializeCompactEnvironment({ environmentPath: legacyEnvironment });
    writeFileSync(
      legacyEnvironment,
      readFileSync(legacyEnvironment, 'utf8').replace(
        /^(?:COMPOSE_PROJECT_NAME|TIXKIT_IMAGE_MODE|TIXKIT_(?:API|WORKER|CHECKOUT|ADMIN)_IMAGE)=.*\n/gmu,
        '',
      ),
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      PATH: `${binaryDirectory}:${process.env.PATH}`,
      COMPACT_DOCKER_LOG: logPath,
    };
    const run = (...arguments_) =>
      execFileSync('node', ['--', resolve(root, 'scripts/compact.mjs'), ...arguments_], {
        cwd: root,
        env: environment,
        stdio: 'pipe',
      });
    const selector = ['--env-file', sourceEnvironment, '--project-name', projectName];

    run('up', ...selector);
    run('status', ...selector);
    run('logs', ...selector, 'api', 'worker');
    run('backup', ...selector, backupDirectory);
    run('restore', ...selector, backupDirectory);

    const failedBackup = spawnSync(
      'node',
      ['--', resolve(root, 'scripts/compact.mjs'), 'backup', ...selector, failedBackupDirectory],
      {
        cwd: root,
        env: { ...environment, COMPACT_DOCKER_FAIL_MATCH: ' up -d --no-build --wait' },
        encoding: 'utf8',
      },
    );
    assert.equal(failedBackup.status, 1);
    assert.equal(existsSync(failedBackupDirectory), false);

    const failedRestore = spawnSync(
      'node',
      ['--', resolve(root, 'scripts/compact.mjs'), 'restore', ...selector, backupDirectory],
      {
        cwd: root,
        env: {
          ...environment,
          COMPACT_DOCKER_FAIL_MATCH: 'mirror --overwrite --remove tixkit/tixkit-restore-',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(failedRestore.status, 1);
    assert.match(failedRestore.stderr, /Command failed/u);

    run('upgrade', ...selector, upgradeBackupDirectory);
    assert.equal(existsSync(resolve(upgradeBackupDirectory, 'manifest.json')), true);

    run('up', '--env-file', releaseEnvironment);
    run('status', '--env-file', legacyEnvironment);

    const beforeMismatch = readFileSync(logPath, 'utf8');
    const mismatch = spawnSync(
      'node',
      [
        '--',
        resolve(root, 'scripts/compact.mjs'),
        'status',
        '--env-file',
        sourceEnvironment,
        '--project-name',
        'tixkit-compact-routing-other',
      ],
      { cwd: root, env: environment, encoding: 'utf8' },
    );
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /does not own environment/u);
    assert.equal(readFileSync(logPath, 'utf8'), beforeMismatch);

    const failedUninstall = spawnSync(
      'node',
      ['--', resolve(root, 'scripts/compact.mjs'), 'uninstall', ...selector, '--volumes'],
      {
        cwd: root,
        env: { ...environment, COMPACT_DOCKER_FAIL_MATCH: ' down ' },
        encoding: 'utf8',
      },
    );
    assert.equal(failedUninstall.status, 1);
    assert.equal(existsSync(sourceEnvironment), true);
    assert.equal(existsSync(otherEnvironment), true);

    run('uninstall', ...selector, '--volumes');
    assert.equal(existsSync(sourceEnvironment), false);
    assert.equal(existsSync(otherEnvironment), true);

    const invocations = readFileSync(logPath, 'utf8').trim().split('\n');
    const composeInvocations = invocations.filter((line) => line.startsWith('compose '));
    const sourceComposeInvocations = composeInvocations.filter((line) =>
      line.includes(`--env-file ${sourceEnvironment}`),
    );
    assert.ok(composeInvocations.length > 50);
    assert.ok(
      sourceComposeInvocations.every(
        (line) =>
          line.includes(`--project-name ${projectName}`) &&
          line.includes(`--env-file ${sourceEnvironment}`),
      ),
    );
    assert.ok(invocations.some((line) => line.includes(`--network ${projectName}_default`)));
    assert.ok(
      invocations.some(
        (line) =>
          line.includes('build --pull api') && line.includes(`--project-name ${projectName}`),
      ),
    );
    assert.ok(
      invocations.some(
        (line) =>
          line.includes('mirror --overwrite --remove tixkit/tixkit-rollback-') &&
          line.includes(`--network ${projectName}_default`),
      ),
    );
    assert.ok(invocations.every((line) => !line.includes(otherEnvironment)));
    const releaseInvocations = invocations.filter((line) => line.includes(releaseEnvironment));
    assert.equal(releaseInvocations.filter((line) => line.includes(' pull ')).length, 4);
    assert.equal(
      releaseInvocations.some((line) => line.includes(' build ')),
      false,
    );
    assert.ok(releaseInvocations.every((line) => line.includes('--project-name tixkit-compact')));
    const legacyInvocations = invocations.filter((line) => line.includes(legacyEnvironment));
    assert.equal(legacyInvocations.length, 1);
    assert.ok(legacyInvocations[0].includes('--project-name tixkit-compact'));
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

test('Compact application images install only their build dependency closures', () => {
  for (const [dockerfile, filters] of [
    ['Dockerfile.api', '--filter=./ --filter=./packages/api --filter=./packages/cli'],
    ['Dockerfile.worker', '--filter=./ --filter=./packages/workflows'],
    ['Dockerfile.checkout', '--filter=./ --filter=./apps/checkout'],
    ['Dockerfile.admin', '--filter=./ --filter=./apps/admin-dashboard'],
  ]) {
    const content = readFileSync(resolve(root, dockerfile), 'utf8');
    assert.match(content, new RegExp(`RUN bun install --frozen-lockfile ${filters}`, 'u'));
    assert.doesNotMatch(content, /^RUN bun install --frozen-lockfile$/mu);
    assert.ok(content.includes('${package_dir}/schemas'));
  }
});

test('Compact lifecycle builds application images sequentially before startup', () => {
  const content = readFileSync(resolve(root, 'scripts/compact.mjs'), 'utf8');
  assert.match(content, /for \(const service of \['api', 'worker', 'checkout', 'admin'\]\)/u);
  assert.match(content, /prepareApplications\(runtime\);/u);
  assert.match(content, /prepareApplications\(\{ \.\.\.runtime, pull: true \}\);/u);
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
