#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const composeFile = resolve(root, 'infra/compact/compose.yml');
const envFile = resolve(root, 'infra/compact/.env');
const minioClientImage =
  'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';

function secret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function portabilityKey(prefix, deploymentSuffix) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    keyId: `${prefix}_${deploymentSuffix}`,
    privateKeyBase64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
      'base64',
    ),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function parseEd25519PrivateKey(name, encoded) {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (!encoded || bytes.toString('base64') !== encoded) throw new Error('non-canonical');
    const privateKey = createPrivateKey(bytes.toString('utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('wrong type');
    return privateKey;
  } catch {
    throw new Error(`Compact environment contains an invalid ${name}.`);
  }
}

function compose(arguments_, options = {}) {
  return execFileSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...arguments_],
    {
      cwd: root,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      encoding: 'utf8',
    },
  );
}

function buildApplications({ pull = false } = {}) {
  for (const service of ['api', 'worker', 'checkout', 'admin'])
    compose(['build', ...(pull ? ['--pull'] : []), service]);
}

export function initializeCompactEnvironment({ environmentPath = envFile } = {}) {
  if (existsSync(environmentPath))
    throw new Error(
      'Compact environment already exists; refusing to overwrite persistent-service secrets.',
    );
  const deploymentSuffix = randomUUID().replaceAll('-', '');
  const bundleKey = portabilityKey('compact_bundle', deploymentSuffix);
  const payloadKey = portabilityKey('compact_payload', deploymentSuffix);
  const dryRunKey = portabilityKey('compact_dry_run', deploymentSuffix);
  const cutoverKey = portabilityKey('compact_cutover', deploymentSuffix);
  const contents = [
    'TIXKIT_VERSION=local',
    `TIXKIT_SANDBOX_EPOCH=${randomUUID()}`,
    `TIXKIT_DEPLOYMENT_ID=compact_${deploymentSuffix}`,
    'TIXKIT_OPERATING_MODEL=self-hosted',
    `POSTGRES_PASSWORD=${secret()}`,
    `TEMPORAL_POSTGRES_PASSWORD=${secret()}`,
    `MINIO_ROOT_USER=compact-${randomBytes(8).toString('hex')}`,
    `MINIO_ROOT_PASSWORD=${secret()}`,
    `QR_SIGNING_SECRET=${secret(48)}`,
    `OFFLINE_MANIFEST_SIGNING_KEY=${secret(48)}`,
    `WIDGET_IMPRESSION_HASH_SECRET=${secret(48)}`,
    `TIXKIT_MIGRATION_CURSOR_KEY=${secret(32)}`,
    `PORTABILITY_BUNDLE_SIGNING_KEY_ID=${bundleKey.keyId}`,
    `PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64=${bundleKey.privateKeyBase64}`,
    `PORTABILITY_PAYLOAD_SIGNING_KEY_ID=${payloadKey.keyId}`,
    `PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64=${payloadKey.privateKeyBase64}`,
    `PORTABILITY_DRY_RUN_SIGNING_KEY_ID=${dryRunKey.keyId}`,
    `PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64=${dryRunKey.privateKeyBase64}`,
    'PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS={}',
    `PORTABILITY_CUTOVER_SIGNING_KEY_ID=${cutoverKey.keyId}`,
    `PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64=${cutoverKey.privateKeyBase64}`,
    `PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS=${JSON.stringify({ [cutoverKey.keyId]: cutoverKey.publicKeyPem })}`,
    '',
    'API_PORT=4000',
    'CHECKOUT_PORT=3000',
    'ADMIN_PORT=3001',
    'POSTGRES_PORT=5432',
    'REDIS_PORT=6379',
    'TEMPORAL_UI_PORT=8080',
    'MINIO_API_PORT=9000',
    'MINIO_CONSOLE_PORT=9001',
    '',
  ].join('\n');
  writeFileSync(environmentPath, contents, { mode: 0o600 });
  chmodSync(environmentPath, 0o600);
  return environmentPath;
}

function requireEnvironment() {
  if (!existsSync(envFile))
    throw new Error('Compact is not initialized. Run `bun run compact:init`.');
  validateCompactEnvironment({ environmentPath: envFile });
}

export function validateCompactEnvironment({ environmentPath = envFile } = {}) {
  if (!existsSync(environmentPath)) throw new Error('Compact environment does not exist.');
  const mode = statSync(environmentPath).mode & 0o777;
  if (mode !== 0o600)
    throw new Error(`Compact environment must have mode 0600; found ${mode.toString(8)}.`);
  const environment = compactEnvironment(environmentPath);
  if (!/^compact_[a-f0-9]{32}$/u.test(environment.TIXKIT_DEPLOYMENT_ID ?? ''))
    throw new Error('Compact environment contains an invalid TIXKIT_DEPLOYMENT_ID.');
  if (environment.TIXKIT_OPERATING_MODEL !== 'self-hosted')
    throw new Error('Compact environment must use the self-hosted operating model.');
  for (const key of [
    'POSTGRES_PASSWORD',
    'TEMPORAL_POSTGRES_PASSWORD',
    'MINIO_ROOT_PASSWORD',
    'QR_SIGNING_SECRET',
    'OFFLINE_MANIFEST_SIGNING_KEY',
    'WIDGET_IMPRESSION_HASH_SECRET',
    'TIXKIT_MIGRATION_CURSOR_KEY',
  ]) {
    const value = environment[key] ?? '';
    if (value.length < 32 || /replace|placeholder|password|secret/i.test(value))
      throw new Error(`Compact environment contains an unsafe value for ${key}.`);
  }
  if (
    (environment.MINIO_ROOT_USER ?? '').length < 16 ||
    /replace|placeholder/i.test(environment.MINIO_ROOT_USER ?? '')
  )
    throw new Error('Compact environment contains an unsafe value for MINIO_ROOT_USER.');
  if (Buffer.from(environment.TIXKIT_MIGRATION_CURSOR_KEY, 'base64').byteLength !== 32)
    throw new Error('Compact migration cursor key must decode to exactly 32 bytes.');
  for (const [purpose, keyIdName, privateKeyName, trustName, activeTrustMode] of [
    [
      'dry-run',
      'PORTABILITY_DRY_RUN_SIGNING_KEY_ID',
      'PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64',
      'PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS',
      'excluded',
    ],
    [
      'cutover',
      'PORTABILITY_CUTOVER_SIGNING_KEY_ID',
      'PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64',
      'PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS',
      'required',
    ],
  ]) {
    const keyId = environment[keyIdName] ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(keyId))
      throw new Error(`Compact environment contains an invalid ${keyIdName}.`);
    const privateKey = parseEd25519PrivateKey(privateKeyName, environment[privateKeyName]);
    try {
      const trust = JSON.parse(environment[trustName] ?? '');
      if (!trust || typeof trust !== 'object' || Array.isArray(trust)) throw new Error('invalid');
      const trustedKeys = new Map(
        Object.entries(trust).map(([trustedKeyId, trustedPem]) => {
          if (
            !/^[A-Za-z0-9_-]{1,128}$/u.test(trustedKeyId) ||
            typeof trustedPem !== 'string' ||
            /PRIVATE KEY/u.test(trustedPem)
          )
            throw new Error('invalid');
          const trustedKey = createPublicKey(trustedPem);
          if (trustedKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid');
          return [trustedKeyId, trustedKey];
        }),
      );
      const trustedKey = trustedKeys.get(keyId);
      const expectedKey = createPublicKey(privateKey);
      if (
        (activeTrustMode === 'required' && !trustedKey?.equals(expectedKey)) ||
        (activeTrustMode === 'excluded' && trustedKey)
      )
        throw new Error('invalid');
    } catch {
      throw new Error(
        `Compact ${purpose} trust contains invalid Ed25519 public-key entries or active-key configuration.`,
      );
    }
  }
  for (const [keyIdName, privateKeyName] of [
    ['PORTABILITY_BUNDLE_SIGNING_KEY_ID', 'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64'],
    ['PORTABILITY_PAYLOAD_SIGNING_KEY_ID', 'PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64'],
  ]) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(environment[keyIdName] ?? ''))
      throw new Error(`Compact environment contains an invalid ${keyIdName}.`);
    parseEd25519PrivateKey(privateKeyName, environment[privateKeyName]);
  }
  for (const key of [
    'API_PORT',
    'CHECKOUT_PORT',
    'ADMIN_PORT',
    'POSTGRES_PORT',
    'REDIS_PORT',
    'TEMPORAL_UI_PORT',
    'MINIO_API_PORT',
    'MINIO_CONSOLE_PORT',
  ]) {
    const port = Number(environment[key]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`Compact environment contains an invalid ${key}.`);
  }
}

function pipeCompose(arguments_, { input, output }) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '-f', composeFile, ...arguments_],
    { cwd: root, input, encoding: null, maxBuffer: 1024 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(result.stderr?.toString('utf8') || `docker compose exited ${result.status}`);
  writeFileSync(output, result.stdout);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function runRecoveryActions(primaryError, actions) {
  const errors = primaryError ? [primaryError] : [];
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Compact recovery encountered errors.');
}

function compactEnvironment(environmentPath = envFile) {
  return Object.fromEntries(
    readFileSync(environmentPath, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function compactUrl(service) {
  const environment = compactEnvironment();
  const ports = {
    admin: environment.ADMIN_PORT || '3001',
    checkout: environment.CHECKOUT_PORT || '3000',
  };
  return `http://localhost:${ports[service]}`;
}

function minioClient(arguments_, mount) {
  const environment = compactEnvironment();
  const user = encodeURIComponent(environment.MINIO_ROOT_USER);
  const password = encodeURIComponent(environment.MINIO_ROOT_PASSWORD);
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'tixkit-compact_default',
      '--env',
      `MC_HOST_tixkit=http://${user}:${password}@minio:9000`,
      '--volume',
      `${mount}:/backup`,
      minioClientImage,
      ...arguments_,
    ],
    { cwd: root, stdio: 'inherit' },
  );
}

export function backupCompact(destination) {
  requireEnvironment();
  const directory = resolve(destination);
  if (existsSync(directory) && readdirSync(directory).length)
    throw new Error('Compact backup destination must be empty.');
  const staging = `${directory}.partial-${randomUUID()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const paths = [
    resolve(staging, 'postgres.sql'),
    resolve(staging, 'temporal.sql'),
    resolve(staging, 'temporal-visibility.sql'),
    resolve(staging, 'minio.tar.gz'),
  ];
  const objectDirectory = resolve(staging, '.objects');
  mkdirSync(resolve(objectDirectory, 'tixkit'), {
    recursive: true,
    mode: 0o700,
  });
  compose(['stop', 'api', 'worker', 'admin', 'checkout', 'temporal-ui', 'temporal']);
  try {
    pipeCompose(['exec', '-T', 'postgres', 'pg_dump', '-U', 'tixkit', '-d', 'tixkit'], {
      output: paths[0],
    });
    pipeCompose(
      ['exec', '-T', 'temporal-postgres', 'pg_dump', '-U', 'temporal', '-d', 'temporal'],
      { output: paths[1] },
    );
    pipeCompose(
      ['exec', '-T', 'temporal-postgres', 'pg_dump', '-U', 'temporal', '-d', 'temporal_visibility'],
      { output: paths[2] },
    );
    minioClient(['mirror', 'tixkit/tixkit', '/backup/tixkit'], objectDirectory);
    execFileSync('tar', ['-C', objectDirectory, '-czf', paths[3], 'tixkit']);
    rmSync(objectDirectory, { recursive: true, force: true });
    const environment = compactEnvironment();
    const metadata = {
      schemaVersion: 2,
      profile: 'compact',
      scope: 'application-object-and-temporal-logical-snapshot',
      createdAt: new Date().toISOString(),
      tixkitVersion: environment.TIXKIT_VERSION,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      files: paths.map((path) => ({
        name: basename(path),
        sha256: sha256(path),
        size: statSync(path).size,
      })),
    };
    writeFileSync(resolve(staging, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    runRecoveryActions(error, [
      () => compose(['up', '-d', '--no-build', '--wait']),
      () => rmSync(staging, { recursive: true, force: true }),
    ]);
  }
  try {
    compose(['up', '-d', '--no-build', '--wait']);
  } catch (error) {
    runRecoveryActions(error, [() => rmSync(staging, { recursive: true, force: true })]);
  }
  if (existsSync(directory)) rmSync(directory, { recursive: true });
  renameSync(staging, directory);
  return directory;
}

export function restoreCompact(source) {
  requireEnvironment();
  const directory = resolve(source);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 2 ||
    manifest.profile !== 'compact' ||
    manifest.scope !== 'application-object-and-temporal-logical-snapshot'
  )
    throw new Error('Unsupported Compact backup manifest.');
  const expectedFiles = ['minio.tar.gz', 'postgres.sql', 'temporal-visibility.sql', 'temporal.sql'];
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== expectedFiles.length ||
    manifest.files
      .map((file) => file.name)
      .sort()
      .some((name, index) => name !== expectedFiles[index])
  )
    throw new Error('Compact backup manifest has an invalid artifact set.');
  const currentVersion = compactEnvironment().TIXKIT_VERSION;
  const currentCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (manifest.tixkitVersion !== currentVersion)
    throw new Error('Compact backup version is incompatible with this installation.');
  if (currentVersion === 'local' && manifest.sourceCommit !== currentCommit)
    throw new Error('Compact local backup commit is incompatible with this checkout.');
  for (const file of manifest.files) {
    const path = resolve(directory, file.name);
    if (
      dirname(path) !== directory ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      statSync(path).size !== file.size
    )
      throw new Error(`Compact backup artifact is invalid: ${file.name}`);
    if (sha256(path) !== file.sha256) throw new Error(`Backup checksum mismatch: ${file.name}`);
  }
  const archive = resolve(directory, 'minio.tar.gz');
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const verboseMembers = execFileSync('tar', ['-tvzf', archive], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  if (
    members.some(
      (member) =>
        member.startsWith('/') ||
        member.split('/').includes('..') ||
        (member !== 'tixkit' && !member.startsWith('tixkit/')),
    ) ||
    verboseMembers.some((member) => !['-', 'd'].includes(member[0]))
  )
    throw new Error('Compact object archive contains an unsafe entry.');

  const restoreId = randomBytes(6).toString('hex');
  const databases = [
    ['postgres', 'tixkit', 'tixkit', 'postgres.sql', "to_regclass('public.events')"],
    [
      'temporal-postgres',
      'temporal',
      'temporal',
      'temporal.sql',
      "to_regclass('public.executions')",
    ],
    [
      'temporal-postgres',
      'temporal',
      'temporal_visibility',
      'temporal-visibility.sql',
      "to_regclass('public.executions_visibility')",
    ],
  ].map(([service, user, current, dump, relation]) => ({
    service,
    user,
    current,
    dump: resolve(directory, dump),
    relation,
    stage: `${current}_restore_${restoreId}`,
    rollback: `${current}_rollback_${restoreId}`,
  }));
  try {
    for (const database of databases) {
      compose([
        'exec',
        '-T',
        database.service,
        'dropdb',
        '--if-exists',
        '--force',
        '-U',
        database.user,
        database.stage,
      ]);
      compose(['exec', '-T', database.service, 'createdb', '-U', database.user, database.stage]);
      const staged = spawnSync(
        'docker',
        [
          'compose',
          '--env-file',
          envFile,
          '-f',
          composeFile,
          'exec',
          '-T',
          database.service,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          database.user,
          '-d',
          database.stage,
        ],
        {
          cwd: root,
          input: readFileSync(database.dump),
          stdio: ['pipe', 'ignore', 'inherit'],
        },
      );
      if (staged.status !== 0) throw new Error(`Restore staging failed for ${database.current}.`);
      compose([
        'exec',
        '-T',
        database.service,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        database.user,
        '-d',
        database.stage,
        '-c',
        `DO $$ BEGIN IF ${database.relation} IS NULL THEN RAISE EXCEPTION 'required relation missing'; END IF; END $$;`,
      ]);
    }
  } catch (error) {
    for (const database of databases)
      compose([
        'exec',
        '-T',
        database.service,
        'dropdb',
        '--if-exists',
        '--force',
        '-U',
        database.user,
        database.stage,
      ]);
    throw error;
  }
  const objectDirectory = resolve(directory, '.restore-objects');
  rmSync(objectDirectory, { recursive: true, force: true });
  mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-C', objectDirectory, '-xzf', archive]);
  const stageBucket = `tixkit-restore-${restoreId}`;
  const rollbackBucket = `tixkit-rollback-${restoreId}`;
  minioClient(['mb', '--ignore-existing', `tixkit/${stageBucket}`], objectDirectory);
  minioClient(
    ['mirror', '--overwrite', '--remove', '/backup/tixkit', `tixkit/${stageBucket}`],
    objectDirectory,
  );

  const renameDatabase = (database, from, to) =>
    compose([
      'exec',
      '-T',
      database.service,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      database.user,
      '-d',
      'postgres',
      '-c',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${from}' AND pid <> pg_backend_pid(); ALTER DATABASE ${from} RENAME TO ${to};`,
    ]);
  let swapped = 0;
  let objectRollbackReady = false;
  compose(['stop', 'api', 'worker', 'admin', 'checkout', 'temporal-ui', 'temporal']);
  try {
    for (const database of databases) {
      renameDatabase(database, database.current, database.rollback);
      try {
        renameDatabase(database, database.stage, database.current);
      } catch (error) {
        runRecoveryActions(error, [
          () => renameDatabase(database, database.rollback, database.current),
        ]);
      }
      swapped += 1;
    }
    minioClient(['mb', '--ignore-existing', `tixkit/${rollbackBucket}`], objectDirectory);
    minioClient(
      ['mirror', '--overwrite', 'tixkit/tixkit', `tixkit/${rollbackBucket}`],
      objectDirectory,
    );
    objectRollbackReady = true;
    minioClient(
      ['mirror', '--overwrite', '--remove', `tixkit/${stageBucket}`, 'tixkit/tixkit'],
      objectDirectory,
    );
    compose(['up', '-d', '--no-build', '--wait']);
  } catch (error) {
    const recoveryActions = [];
    for (const database of databases.slice(0, swapped).toReversed()) {
      recoveryActions.push(
        () =>
          compose([
            'exec',
            '-T',
            database.service,
            'dropdb',
            '--if-exists',
            '--force',
            '-U',
            database.user,
            database.current,
          ]),
        () => renameDatabase(database, database.rollback, database.current),
      );
    }
    if (objectRollbackReady)
      recoveryActions.push(() =>
        minioClient(
          ['mirror', '--overwrite', '--remove', `tixkit/${rollbackBucket}`, 'tixkit/tixkit'],
          objectDirectory,
        ),
      );
    recoveryActions.push(() => compose(['up', '-d', '--no-build', '--wait']));
    runRecoveryActions(error, recoveryActions);
  }
  for (const database of databases)
    compose([
      'exec',
      '-T',
      database.service,
      'dropdb',
      '--if-exists',
      '--force',
      '-U',
      database.user,
      database.rollback,
    ]);
  minioClient(['rb', '--force', `tixkit/${stageBucket}`], objectDirectory);
  minioClient(['rb', '--force', `tixkit/${rollbackBucket}`], objectDirectory);
  rmSync(objectDirectory, { recursive: true, force: true });
}

function usage() {
  return 'Usage: bun run compact:<init|up|status|logs|backup|restore|upgrade|uninstall> [options]';
}

const [command, ...arguments_] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    switch (command) {
      case 'init':
        console.log(`Generated ${initializeCompactEnvironment()}`);
        break;
      case 'up':
        requireEnvironment();
        buildApplications();
        compose(['up', '-d', '--no-build', '--wait']);
        console.log(
          `Compact is healthy: admin ${compactUrl('admin')}, checkout ${compactUrl('checkout')}`,
        );
        break;
      case 'status':
        requireEnvironment();
        compose(['ps']);
        break;
      case 'logs':
        requireEnvironment();
        compose(['logs', '--tail', '200', ...arguments_]);
        break;
      case 'backup': {
        const destination =
          arguments_[0] ?? resolve(root, 'backups', new Date().toISOString().replaceAll(':', '-'));
        console.log(`Compact backup written to ${backupCompact(destination)}`);
        break;
      }
      case 'restore':
        if (!arguments_[0]) throw new Error('compact:restore requires a backup directory.');
        restoreCompact(arguments_[0]);
        console.log('Compact restore completed and services are healthy.');
        break;
      case 'upgrade':
        requireEnvironment();
        backupCompact(resolve(root, 'backups', `pre-upgrade-${Date.now()}`));
        buildApplications({ pull: true });
        compose(['up', '-d', '--no-build', '--wait']);
        console.log('Compact upgrade completed after a pre-upgrade backup.');
        break;
      case 'uninstall':
        requireEnvironment();
        compose(['down', ...(arguments_.includes('--volumes') ? ['--volumes'] : [])]);
        if (arguments_.includes('--volumes')) rmSync(envFile, { force: true });
        break;
      default:
        throw new Error(usage());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
