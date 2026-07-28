import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import { parse } from 'yaml';
import {
  initializeCompactEnvironment,
  parseCompactCliArguments,
  runRecoveryActions,
  upgradeCompactEnvironment,
  validateCompactEnvironment,
} from '../compact.mjs';
import {
  assertCompactProofSchema,
  parseComposeServices,
  validateCompleteServiceState,
  validateDockerEnvelope,
  validateHostEnvelope,
  validateOperatingEnvironment,
  writeCompactProofArtifact,
} from '../prove-compact-profile.mjs';

const root = resolve(import.meta.dirname, '../..');
const composePath = resolve(root, 'infra/compact/compose.yml');

test('Compact forwards provider incident evidence settings with capture disabled by default', () => {
  const composeSource = readFileSync(composePath, 'utf8');
  assert.match(
    composeSource,
    /PROVIDER_INCIDENT_SINK_ENABLED: \$\{PROVIDER_INCIDENT_SINK_ENABLED:-false\}/u,
  );
  assert.match(composeSource, /PROVIDER_INCIDENT_KEYRING_JSON:/u);
  assert.doesNotMatch(composeSource, /PROVIDER_INCIDENT_KEYRING_JSON: ['"]?\{/u);
});

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
    'clamav',
    'admin',
  ])
    assert.ok(services.has(required), `missing Compact service ${required}`);
  assert.equal(services.has('mysql'), false);
  assert.equal(compose.services.api.depends_on.migrate.condition, 'service_completed_successfully');
  assert.equal(compose.services.api.depends_on.seed.condition, 'service_completed_successfully');
  assert.equal(compose.services.api.depends_on.clamav.condition, 'service_healthy');
  assert.equal(
    compose.services.api.depends_on['storage-init'].condition,
    'service_completed_successfully',
  );
  assert.equal(compose.services.worker.depends_on.api.condition, 'service_healthy');
  assert.equal(compose.services.api.environment.UPLOAD_MALWARE_SCANNER, 'clamav');
  assert.equal(compose.services.api.environment.CLAMAV_HOST, 'clamav');
  assert.equal(compose.services.api.environment.CLAMAV_PORT, '3310');
  assert.equal(compose.services.api.environment.CLAMAV_TIMEOUT_MS, '30000');
  assert.equal(compose.services.clamav.environment.CLAMD_CONF_StreamMaxLength, '50M');
  assert.deepEqual(compose.services.clamav.volumes, ['clamav-data:/var/lib/clamav']);
  assert.equal(compose.services.clamav.ports, undefined);
  assert.equal(
    compose.services.clamav.image,
    'clamav/clamav:1.4.5-debian@sha256:0542880c8abebb7430be5366657aec561f03693ed7be4e64a45fd2ee60b08d02',
  );
  for (const service of ['storage-init', 'migrate', 'seed', 'worker', 'checkout', 'admin']) {
    assert.equal(compose.services[service].environment.UPLOAD_MALWARE_SCANNER, undefined);
    assert.equal(compose.services[service].environment.CLAMAV_HOST, undefined);
    assert.equal(compose.services[service].environment.CLAMAV_PORT, undefined);
    assert.equal(compose.services[service].environment.CLAMAV_TIMEOUT_MS, undefined);
  }
  assert.equal(compose['x-app-environment'].UPLOAD_MALWARE_SCANNER, undefined);
  assert.equal(compose['x-app-environment'].CLAMAV_HOST, undefined);
  assert.equal(compose['x-app-environment'].CLAMAV_PORT, undefined);
  assert.equal(compose['x-app-environment'].CLAMAV_TIMEOUT_MS, undefined);
  assert.deepEqual(compose.services.worker.healthcheck.test, [
    'CMD',
    'node',
    'packages/workflows/dist/healthcheck.js',
  ]);
  assert.equal(compose['x-app-environment'].TIXKIT_RUNTIME_MODE, 'development');
  assert.equal(compose['x-app-environment'].TIXKIT_MIGRATION_CURSOR_ACTIVE_KEY_ID, 'compact-v1');
  assert.match(compose['x-app-environment'].TIXKIT_MIGRATION_CURSOR_KEYS, /compact-v1/u);
  assert.match(
    compose['x-app-environment'].DASHBOARD_CURSOR_SIGNING_KEY,
    /DASHBOARD_CURSOR_SIGNING_KEY/u,
  );
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

test('Compact proof validates the minimum host envelope and exact 14-service state', () => {
  assert.doesNotThrow(() =>
    validateHostEnvelope({
      cpuCores: 4,
      memoryBytes: 12 * 1024 ** 3,
      diskBytes: 30 * 1024 ** 3,
      architecture: 'x64',
    }),
  );
  for (const invalid of [
    { cpuCores: 3, memoryBytes: 12 * 1024 ** 3, diskBytes: 30 * 1024 ** 3 },
    { cpuCores: 4, memoryBytes: 12 * 1024 ** 3 - 1, diskBytes: 30 * 1024 ** 3 },
    { cpuCores: 4, memoryBytes: 12 * 1024 ** 3, diskBytes: 30 * 1024 ** 3 - 1 },
  ])
    assert.throws(
      () => validateHostEnvelope({ ...invalid, architecture: 'x64' }),
      /Compact proof requires/u,
    );
  assert.throws(
    () =>
      validateHostEnvelope({
        cpuCores: 4,
        memoryBytes: 12 * 1024 ** 3,
        diskBytes: 30 * 1024 ** 3,
        architecture: 'ia32',
      }),
    /supported 64-bit architecture/u,
  );
  assert.deepEqual(
    validateDockerEnvelope({
      NCPU: 4,
      MemTotal: 12 * 1024 ** 3,
      Architecture: 'aarch64',
      OperatingSystem: 'Docker Desktop',
      ServerVersion: '1.2.3',
      diskBytes: 30 * 1024 ** 3,
      contextName: 'desktop-linux',
      endpointKind: 'local-unix',
      endpointSha256: 'a'.repeat(64),
    }),
    {
      cpuCores: 4,
      memoryBytes: 12 * 1024 ** 3,
      architecture: 'arm64',
      operatingSystem: 'Docker Desktop',
      serverVersion: '1.2.3',
      diskBytes: 30 * 1024 ** 3,
      diskScope: 'docker-writable-layer',
      contextName: 'desktop-linux',
      endpointKind: 'local-unix',
      endpointSha256: 'a'.repeat(64),
    },
  );
  assert.throws(
    () =>
      validateDockerEnvelope({
        NCPU: 2,
        MemTotal: 12 * 1024 ** 3,
        Architecture: 'x86_64',
        diskBytes: 30 * 1024 ** 3,
        contextName: 'default',
        endpointKind: 'local-unix',
        endpointSha256: 'a'.repeat(64),
      }),
    /Docker cpuCores/u,
  );
  assert.doesNotThrow(() =>
    validateOperatingEnvironment({ platform: 'darwin' }, { operatingSystem: 'Docker Desktop 4.0' }),
  );
  assert.throws(
    () =>
      validateOperatingEnvironment({ platform: 'win32' }, { operatingSystem: 'Docker Desktop' }),
    /requires Linux or macOS/u,
  );

  const rows = [
    ...[
      'admin',
      'api',
      'checkout',
      'clamav',
      'minio',
      'postgres',
      'redis',
      'temporal',
      'temporal-postgres',
      'temporal-ui',
      'worker',
    ].map((Service) => ({
      Service,
      State: 'running',
      Health: Service === 'temporal-ui' ? '' : 'healthy',
      ExitCode: 0,
    })),
    ...['migrate', 'seed', 'storage-init'].map((Service) => ({
      Service,
      State: 'exited',
      Health: '',
      ExitCode: 0,
    })),
  ];
  const services = parseComposeServices(rows.map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(validateCompleteServiceState(services).length, 14);
  assert.throws(
    () => validateCompleteServiceState(services.filter((service) => service.service !== 'seed')),
    /exact 14-service profile/u,
  );
  assert.throws(
    () =>
      validateCompleteServiceState(
        services.map((service) =>
          service.service === 'worker' ? { ...service, health: 'unhealthy' } : service,
        ),
      ),
    /worker is not in its expected running health state/u,
  );
});

test('Compact proof artifacts are exclusive, non-symlink, and mode 0600', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-proof-artifact-'));
  const artifact = join(directory, 'proof.json');
  const target = join(directory, 'target.json');
  const link = join(directory, 'link.json');
  try {
    writeCompactProofArtifact(artifact, { result: 'passed' });
    assert.equal(statSync(artifact).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(artifact, 'utf8')), { result: 'passed' });
    assert.throws(() => writeCompactProofArtifact(artifact, { result: 'replaced' }), /EEXIST/u);
    writeFileSync(target, 'preserve', { mode: 0o600 });
    symlinkSync(target, link);
    assert.throws(() => writeCompactProofArtifact(link, { result: 'followed' }), /EEXIST/u);
    assert.equal(readFileSync(target, 'utf8'), 'preserve');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact proof schema is strict and covers every lifecycle assertion', () => {
  const schema = JSON.parse(readFileSync(resolve(root, 'infra/compact/proof.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    new Set(schema.required),
    new Set([
      'schemaVersion',
      'schema',
      'kind',
      'result',
      'startedFromFreshEnvironment',
      'authoritativePublicRepository',
      'source',
      'remote',
      'host',
      'docker',
      'minimum',
      'phases',
      'negativeRestoreProof',
      'backup',
      'upgradeBackup',
      'malwareScannerProof',
      'workerDependencyFailureObserved',
      'seedPersistenceChecks',
      'commands',
      'transcript',
      'finishedAt',
      'limitations',
    ]),
  );
  assert.equal(schema.$defs.command.additionalProperties, false);
  assert.equal(schema.$defs.backupManifest.additionalProperties, false);
  assert.equal(schema.$defs.serviceState.minItems, 14);
  assert.equal(schema.$defs.serviceState.maxItems, 14);
  assert.deepEqual(
    schema.properties.negativeRestoreProof.prefixItems.map((item) => item.$ref),
    [
      '#/$defs/negativeSourceCommit',
      '#/$defs/negativeVersion',
      '#/$defs/negativeIncomplete',
      '#/$defs/negativeChecksum',
      '#/$defs/negativeSql',
      '#/$defs/negativeArchive',
    ],
  );
  const negativeIds = [
    'incompatible-source-commit',
    'incompatible-version',
    'incomplete-artifact-set',
    'checksum-mismatch',
    'checksummed-invalid-sql',
    'checksummed-unsafe-archive',
  ];
  const digest = 'a'.repeat(64);
  const commit = 'b'.repeat(40);
  const date = '2026-07-14T12:00:00.000Z';
  const serviceState = [
    ...[
      'admin',
      'api',
      'checkout',
      'clamav',
      'minio',
      'postgres',
      'redis',
      'temporal',
      'temporal-postgres',
      'worker',
    ].map((service) => ({ service, state: 'running', health: 'healthy', exitCode: 0 })),
    { service: 'temporal-ui', state: 'running', health: '', exitCode: 0 },
    ...['migrate', 'seed', 'storage-init'].map((service) => ({
      service,
      state: 'exited',
      health: '',
      exitCode: 0,
    })),
  ].sort((left, right) => left.service.localeCompare(right.service));
  const manifest = {
    schemaVersion: 2,
    profile: 'compact',
    scope: 'application-object-and-temporal-logical-snapshot',
    createdAt: date,
    tixkitVersion: '1.0.0',
    sourceCommit: commit,
    files: ['postgres.sql', 'temporal.sql', 'temporal-visibility.sql', 'minio.tar.gz'].map(
      (name) => ({ name, sha256: digest, size: 1 }),
    ),
  };
  const manifestSha256 = createHash('sha256')
    .update(`${JSON.stringify(manifest, null, 2)}\n`)
    .digest('hex');
  const command = {
    command: ['bun', 'run', 'compact:up'],
    expectedOutcome: 'success',
    assertion: 'fixture-command',
    failurePattern: null,
    failureMatched: null,
    startedAt: date,
    finishedAt: date,
    durationMs: 0,
    exitCode: 0,
    signal: null,
    stdoutSha256: digest,
    stdoutBytes: 0,
    stderrSha256: digest,
    stderrBytes: 0,
  };
  const scannerCommandIndexes = {
    classificationCommandIndex: 6,
    maximumUploadCommandIndex: 7,
    dependencyFailureCommandIndex: 8,
    recoveryCommandIndex: 9,
  };
  const scannerAssertions = new Map([
    [6, 'malware-scanner-clean-and-eicar-classification'],
    [7, 'malware-scanner-maximum-upload-classification'],
    [8, 'malware-scanner-dependency-fails-closed'],
    [9, 'malware-scanner-recovered-after-dependency-restart'],
  ]);
  const evidence = {
    schemaVersion: 2,
    schema: 'https://tixkit.com/schemas/compact-clean-host-proof-v2.json',
    kind: 'tixkit-compact-clean-host-proof',
    result: 'passed',
    startedFromFreshEnvironment: true,
    authoritativePublicRepository: 'github.com/tixkithq/tixkit',
    source: { commit, tree: commit },
    remote: {
      url: 'https://github.com/tixkithq/tixkit.git',
      ref: 'refs/heads/main',
      refObject: commit,
      object: commit,
    },
    host: {
      cpuCores: 4,
      memoryBytes: 12 * 1024 ** 3,
      diskBytes: 30 * 1024 ** 3,
      architecture: 'x64',
      platform: 'linux',
      platformRelease: 'fixture',
    },
    docker: {
      cpuCores: 4,
      memoryBytes: 12 * 1024 ** 3,
      architecture: 'x86_64',
      operatingSystem: 'Linux',
      serverVersion: 'fixture',
      diskBytes: 30 * 1024 ** 3,
      diskScope: 'docker-writable-layer',
      contextName: 'default',
      endpointKind: 'local-unix',
      endpointSha256: digest,
    },
    minimum: { cpuCores: 4, memoryBytes: 12 * 1024 ** 3, diskBytes: 30 * 1024 ** 3 },
    phases: Object.fromEntries(
      ['initial', 'restarted', 'restored', 'recovered', 'upgraded'].map((phase) => [
        phase,
        serviceState,
      ]),
    ),
    negativeRestoreProof: negativeIds.map((id, commandIndex) => ({
      id,
      commandIndex,
      expectedExitCode: 1,
      before: {
        databaseSha256: digest,
        objectInventorySha256: digest,
        objectInventoryCount: 1,
        objectInventoryBytes: 1,
      },
      after: {
        databaseSha256: digest,
        objectInventorySha256: digest,
        objectInventoryCount: 1,
        objectInventoryBytes: 1,
      },
      liveStatePreserved: true,
    })),
    backup: { manifest, manifestSha256 },
    upgradeBackup: { manifest, manifestSha256 },
    malwareScannerProof: {
      cleanAccepted: true,
      eicarRejected: true,
      maximumUploadAccepted: true,
      dependencyFailureObserved: true,
      recovered: true,
      ...scannerCommandIndexes,
    },
    workerDependencyFailureObserved: true,
    seedPersistenceChecks: 5,
    commands: Array.from({ length: 25 }, (_, index) =>
      index < negativeIds.length
        ? {
            ...command,
            expectedOutcome: 'failure',
            assertion: `negative-restore-${negativeIds[index]}`,
            failurePattern: 'expected fixture failure',
            failureMatched: true,
            exitCode: 1,
          }
        : scannerAssertions.has(index)
          ? { ...command, assertion: scannerAssertions.get(index) }
          : command,
    ),
    transcript: { path: 'command-transcript.log', bytes: 1, sha256: digest },
    finishedAt: date,
    limitations: [
      'This proof covers one Compact host and does not establish high availability.',
      'This proof does not establish legal approval, hosted publication, or production DR.',
    ],
  };
  assert.doesNotThrow(() => assertCompactProofSchema(evidence));
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        schemaVersion: 1,
        schema: 'https://tixkit.com/schemas/compact-clean-host-proof-v1.json',
      }),
    /violates its schema/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        malwareScannerProof: {
          ...evidence.malwareScannerProof,
          maximumUploadCommandIndex: evidence.malwareScannerProof.classificationCommandIndex,
        },
      }),
    /reuse one command outcome/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        malwareScannerProof: {
          ...evidence.malwareScannerProof,
          dependencyFailureCommandIndex: 100,
        },
      }),
    /not bound/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        commands: evidence.commands.map((item, index) =>
          index === evidence.malwareScannerProof.recoveryCommandIndex
            ? { ...item, assertion: 'substituted-scanner-proof' }
            : item,
        ),
      }),
    /not bound/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        schema: 'https://tixkit.com/schemas/compact-clean-host-proof-v1.json',
      }),
    /violates its schema/u,
  );
  assert.throws(
    () => assertCompactProofSchema({ ...evidence, unexpected: true }),
    /violates its schema/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        malwareScannerProof: { ...evidence.malwareScannerProof, recovered: false },
      }),
    /violates its schema/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        phases: { ...evidence.phases, initial: serviceState.slice(1) },
      }),
    /violates its schema/u,
  );
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        commands: evidence.commands.map((item, index) =>
          index === 10 ? { ...item, exitCode: 1 } : item,
        ),
      }),
    /outcome differs/u,
  );
  const duplicateManifest = {
    ...manifest,
    files: manifest.files.map((file, index) =>
      index === 3 ? { ...file, name: 'postgres.sql' } : file,
    ),
  };
  assert.throws(
    () =>
      assertCompactProofSchema({
        ...evidence,
        backup: {
          manifest: duplicateManifest,
          manifestSha256: createHash('sha256')
            .update(`${JSON.stringify(duplicateManifest, null, 2)}\n`)
            .digest('hex'),
        },
      }),
    /exact artifact set/u,
  );
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

test('Compact rejects every offline manifest registry that the API runtime rejects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-manifest-validation-'));
  const environmentPath = resolve(directory, '.env');
  try {
    initializeCompactEnvironment({ environmentPath });
    const validEnvironment = readFileSync(environmentPath, 'utf8');
    const registryLine = /^OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=(.+)$/mu.exec(
      validEnvironment,
    );
    assert.ok(registryLine);
    const [key] = JSON.parse(registryLine[1]);
    const registries = [
      [key, { ...key }],
      [{ ...key, notBefore: '2020-01-01T00:00:00Z' }],
      [{ ...key, notBefore: new Date(Date.now() + 60_000).toISOString() }],
      [{ ...key, notAfter: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString() }],
    ];
    for (const registry of registries) {
      writeFileSync(
        environmentPath,
        validEnvironment.replace(
          /^OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=.*$/mu,
          `OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=${JSON.stringify(registry)}`,
        ),
        { mode: 0o600 },
      );
      assert.throws(
        () => validateCompactEnvironment({ environmentPath }),
        /invalid offline manifest V2 key registry/u,
      );
    }
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
      'DASHBOARD_CURSOR_SIGNING_KEY',
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

test('Compact upgrades an existing environment with a unique dashboard cursor key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-dashboard-key-upgrade-'));
  const first = resolve(directory, '.env');
  const second = resolve(directory, '.env-second');
  try {
    initializeCompactEnvironment({ environmentPath: first });
    initializeCompactEnvironment({ environmentPath: second });
    for (const environmentPath of [first, second]) {
      writeFileSync(
        environmentPath,
        readFileSync(environmentPath, 'utf8').replace(/^DASHBOARD_CURSOR_SIGNING_KEY=.*\n/mu, ''),
        { mode: 0o600 },
      );
    }
    const firstBefore = readFileSync(first, 'utf8');
    assert.equal(upgradeCompactEnvironment({ environmentPath: first }), true);
    assert.equal(upgradeCompactEnvironment({ environmentPath: second }), true);
    const firstAfter = readFileSync(first, 'utf8');
    const secondAfter = readFileSync(second, 'utf8');
    assert.ok(firstAfter.startsWith(firstBefore));
    const firstKey = /^DASHBOARD_CURSOR_SIGNING_KEY=(.+)$/mu.exec(firstAfter)?.[1];
    const secondKey = /^DASHBOARD_CURSOR_SIGNING_KEY=(.+)$/mu.exec(secondAfter)?.[1];
    assert.ok(firstKey && firstKey.length >= 32);
    assert.ok(secondKey && secondKey.length >= 32);
    assert.notEqual(firstKey, secondKey);
    assert.equal(statSync(first).mode & 0o777, 0o600);
    assert.doesNotThrow(() => validateCompactEnvironment({ environmentPath: first }));
    assert.equal(upgradeCompactEnvironment({ environmentPath: first }), false);
    assert.equal(readFileSync(first, 'utf8'), firstAfter);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Compact upgrades legacy V2 manifest keys atomically and rejects partial key state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-compact-manifest-key-upgrade-'));
  const legacy = resolve(directory, '.env-legacy');
  const missingActive = resolve(directory, '.env-missing-active');
  const missingRegistry = resolve(directory, '.env-missing-registry');
  try {
    initializeCompactEnvironment({ environmentPath: legacy });
    const complete = readFileSync(legacy, 'utf8');
    const withoutActive = complete.replace(/^OFFLINE_MANIFEST_ACTIVE_KEY_ID=.*\n/mu, '');
    const withoutRegistry = complete.replace(
      /^OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=.*\n/mu,
      '',
    );
    writeFileSync(
      legacy,
      withoutActive.replace(/^OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=.*\n/mu, ''),
      { mode: 0o600 },
    );
    writeFileSync(missingActive, withoutActive, { mode: 0o600 });
    writeFileSync(missingRegistry, withoutRegistry, { mode: 0o600 });

    assert.equal(upgradeCompactEnvironment({ environmentPath: legacy }), true);
    const upgraded = readFileSync(legacy, 'utf8');
    assert.equal((upgraded.match(/^OFFLINE_MANIFEST_ACTIVE_KEY_ID=/gmu) ?? []).length, 1);
    assert.equal(
      (upgraded.match(/^OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON=/gmu) ?? []).length,
      1,
    );
    assert.doesNotThrow(() => validateCompactEnvironment({ environmentPath: legacy }));
    assert.equal(upgradeCompactEnvironment({ environmentPath: legacy }), false);

    for (const environmentPath of [missingActive, missingRegistry]) {
      const before = readFileSync(environmentPath, 'utf8');
      assert.throws(
        () => upgradeCompactEnvironment({ environmentPath }),
        /refusing a destructive partial upgrade/u,
      );
      assert.equal(readFileSync(environmentPath, 'utf8'), before);
    }
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
    assert.equal(rendered.services.checkout.build.args, undefined);
    assert.equal(secondRendered.services.checkout.build.args, undefined);
    assert.equal(rendered.services.checkout.environment.API_BASE_URL, 'http://localhost:4000');
    assert.equal(
      secondRendered.services.checkout.environment.API_BASE_URL,
      'http://localhost:4100',
    );
    assert.equal(rendered.services.checkout.environment.INTERNAL_API_BASE_URL, 'http://api:4000');
    assert.equal(
      secondRendered.services.api.environment.S3_PUBLIC_ENDPOINT,
      'http://localhost:9100',
    );
    assert.equal(String(secondRendered.services.minio.ports[0].published), '9100');
    assert.deepEqual(
      Object.values(rendered.volumes).map(({ name }) => name),
      [
        'tixkit-compact-isolated-test_clamav-data',
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
    for (const variable of [
      'OFFLINE_MANIFEST_SIGNING_KEY',
      'OFFLINE_MANIFEST_KEY_ID',
      'OFFLINE_MANIFEST_ACTIVE_KEY_ID',
      'OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON',
    ]) {
      assert.ok(rendered.services.api.environment[variable]);
      for (const service of ['storage-init', 'migrate', 'seed', 'worker', 'checkout', 'admin']) {
        assert.equal(rendered.services[service].environment[variable], undefined, service);
      }
    }
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
    run('restart', ...selector);
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
      sourceComposeInvocations.some((line) => line.endsWith(' down')) &&
        sourceComposeInvocations.some((line) => line.endsWith(' up -d --no-build --wait')),
    );
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

test('Compact injects admin deployment settings at runtime into a generic image', () => {
  const adminDockerfile = readFileSync(resolve(root, 'Dockerfile.admin'), 'utf8');
  const compactCompose = readFileSync(resolve(root, 'infra/compact/compose.yml'), 'utf8');
  const compose = parse(compactCompose);
  const admin = compose.services.admin;

  assert.equal(admin.build.args, undefined);
  assert.equal(admin.environment.TIXKIT_DEPLOYMENT_PROFILE, 'compact');
  assert.match(admin.environment.TIXKIT_BUILD_REVISION, /TIXKIT_VERSION.*local/u);
  assert.match(admin.environment.API_BASE_URL, /localhost.*API_PORT/u);
  assert.equal(admin.environment.INTERNAL_API_BASE_URL, 'http://api:4000');
  assert.match(admin.environment.TIXKIT_CHECKOUT_URL, /localhost.*CHECKOUT_PORT/u);
  assert.match(admin.environment.S3_PUBLIC_ENDPOINT, /S3_PUBLIC_ENDPOINT/u);
  assert.equal(admin.environment.AUTH_PROVIDER, 'dev');
  assert.equal(admin.environment.ALLOW_INSECURE_LOCAL_ORIGINS, '1');
  assert.equal(
    Object.keys(admin.environment).some((key) => key.startsWith('NEXT_PUBLIC_')),
    false,
  );
  assert.match(admin.healthcheck.test.at(-1), /localhost:3001\/ready/u);
  assert.doesNotMatch(adminDockerfile, /^(?:ARG|ENV) NEXT_PUBLIC_/mu);
  assert.doesNotMatch(adminDockerfile, /ALLOW_INSECURE_LOCAL_ORIGINS/u);
  assert.doesNotMatch(adminDockerfile, /^(?:ARG|ENV) TIXKIT_BUILD_REVISION/mu);
  assert.doesNotMatch(adminDockerfile, /https?:\/\//u);
  assert.match(adminDockerfile, /node_modules/u);

  const releaseWorkflow = readFileSync(
    resolve(root, '.github/workflows/public-artifact-release.yml'),
    'utf8',
  );
  assert.match(
    releaseWorkflow,
    /docker build --file "\$DOCKERFILE" --tag "\$\{repository\}:\$\{candidate\}" \./u,
  );
  assert.doesNotMatch(releaseWorkflow, /docker build[^\n]*--build-arg/u);
});

test('Checkout injects bounded loopback settings at runtime into a generic image', () => {
  const content = readFileSync(resolve(root, 'Dockerfile.checkout'), 'utf8');
  const checkout = parse(readFileSync(resolve(root, 'infra/compact/compose.yml'), 'utf8')).services
    .checkout;
  assert.equal(checkout.build.args, undefined);
  assert.equal(checkout.environment.TIXKIT_DEPLOYMENT_PROFILE, 'compact');
  assert.match(checkout.environment.TIXKIT_BUILD_REVISION, /TIXKIT_VERSION.*local/u);
  assert.match(checkout.environment.API_BASE_URL, /localhost.*API_PORT/u);
  assert.equal(checkout.environment.INTERNAL_API_BASE_URL, 'http://api:4000');
  assert.match(checkout.environment.TIXKIT_CHECKOUT_URL, /localhost.*CHECKOUT_PORT/u);
  assert.equal(checkout.environment.ALLOW_INSECURE_LOCAL_ORIGINS, '1');
  assert.equal(
    Object.keys(checkout.environment).some((key) => key.startsWith('NEXT_PUBLIC_')),
    false,
  );
  assert.match(checkout.healthcheck.test.at(-1), /localhost:3000\/ready/u);
  assert.doesNotMatch(content, /^(?:ARG|ENV) NEXT_PUBLIC_/mu);
  assert.doesNotMatch(content, /ALLOW_INSECURE_LOCAL_ORIGINS/u);
  assert.doesNotMatch(content, /https?:\/\//u);
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

test('Compact clean-host proof exercises the API malware scanner transport and dependency recovery', () => {
  const content = readFileSync(resolve(root, 'scripts/prove-compact-profile.mjs'), 'utf8');
  assert.match(content, /scanUploadBuffer/u);
  assert.match(content, /malware-scanner-clean-and-eicar-classification/u);
  assert.match(content, /malware-scanner-maximum-upload-classification/u);
  assert.match(content, /malware-scanner-dependency-fails-closed/u);
  assert.match(content, /malware-scanner-recovered-after-dependency-restart/u);
  assert.match(content, /malware-scanner-best-effort-failure-recovery/u);
  assert.match(content, /malware-scanner-best-effort-profile-recovery/u);
  assert.match(content, /composeArguments\('stop', 'clamav'\)/u);
  assert.match(content, /compact-clean-host-proof-v2\.json/u);
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
