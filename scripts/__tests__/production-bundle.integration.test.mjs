import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
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

const root = resolve(import.meta.dirname, '../..');
const enabled = process.env.TIXKIT_RUN_PRODUCTION_DR_INTEGRATION === '1';
const postgresImage =
  'postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const temporalImage =
  'temporalio/auto-setup:1.24@sha256:98cdb6b5e02d64cb933864a9ba91cb66065eb320623a0dafdf44beba535bca88';
const minioImage =
  'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const mcImage =
  'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';
const appPassword = 'outer-bundle-app-postgres-password';
const temporalPassword = 'outer-bundle-temporal-postgres-password';
const minioUser = 'outerbundle';
const minioPassword = 'outer-bundle-minio-password';
const minioApplicationUser = 'outerbundleapp';
const minioApplicationPassword = 'outer-bundle-app-writer-password';
const manifestKey = 'outer-bundle-manifest-key';
const providerKey = 'outer-bundle-provider-key';
const publicationPassword = 'outer-bundle-publication-password';

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    ...options,
  });
}

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runProcess(command, args, options) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

function waitFor(name, command, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = spawnSync('docker', ['exec', name, ...command], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout;
    const state = spawnSync('docker', ['inspect', '--format', '{{.State.Status}}', name], {
      cwd: root,
      encoding: 'utf8',
    });
    if (state.status === 0 && ['dead', 'exited'].includes(state.stdout.trim())) {
      const logs = spawnSync('docker', ['logs', name], {
        cwd: root,
        encoding: 'utf8',
      });
      throw new Error(
        `Container ${name} exited before readiness:\n${logs.stderr || logs.stdout || lastError}`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  throw new Error(`Container ${name} did not become ready: ${lastError}`);
}

function startPostgres(name, hostname, network, user, password, database, publish = false) {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    hostname,
    '--network',
    network,
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=768m',
    ...(publish ? ['-p', '127.0.0.1::5432'] : []),
    '-e',
    `POSTGRES_USER=${user}`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    postgresImage,
  ]);
  waitFor(name, ['pg_isready', '-U', user, '-d', database]);
}

function postgresUrl(name, user, password, database) {
  const port = docker(['port', name, '5432/tcp'])
    .trim()
    .match(/:(\d+)$/u)?.[1];
  assert.match(port, /^\d+$/u);
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
}

function createTemporal(name, hostname, network, postgresHostname) {
  docker([
    'create',
    '--name',
    name,
    '--hostname',
    hostname,
    '--network',
    network,
    '-e',
    'DB=postgres12',
    '-e',
    'DB_PORT=5432',
    '-e',
    'POSTGRES_USER=temporal',
    '-e',
    `POSTGRES_PWD=${temporalPassword}`,
    '-e',
    `POSTGRES_SEEDS=${postgresHostname}`,
    temporalImage,
  ]);
}

function startTemporal(name) {
  docker(['start', name]);
  waitFor(name, ['temporal', 'operator', 'cluster', 'health', '--address', `${name}:7233`]);
}

function temporal(name, args) {
  return docker(['exec', name, 'temporal', ...args]).trim();
}

function mcShell(network, command, mounts = []) {
  return docker([
    'run',
    '--rm',
    '--network',
    network,
    ...mcHostOverrides.flatMap(({ hostname, address }) => ['--add-host', `${hostname}:${address}`]),
    ...(mcCertificateAuthority
      ? ['-v', `${mcCertificateAuthority}:/root/.mc/certs/CAs/ca.crt:ro`]
      : []),
    ...mounts.flatMap(({ source, target, readOnly = false }) => [
      '-v',
      `${source}:${target}${readOnly ? ':ro' : ''}`,
    ]),
    '--entrypoint',
    '/bin/sh',
    mcImage,
    '-c',
    command,
  ]);
}

function waitForMcShell(network, command, mounts = [], timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return mcShell(network, command, mounts);
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  throw lastError;
}

let mcCertificateAuthority = '';
let mcHostOverrides = [];

function createMinioTlsCertificates(directory, names) {
  const caKey = join(directory, 'ca-key.pem');
  const ca = join(directory, 'ca.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      ca,
      '-days',
      '2',
      '-subj',
      '/CN=Tixkit Outer DR Test CA',
    ],
    { stdio: 'ignore' },
  );
  for (const name of names) {
    const key = join(directory, `${name}-key.pem`);
    const request = join(directory, `${name}.csr`);
    const certificate = join(directory, `${name}-cert.pem`);
    const extensions = join(directory, `${name}.ext`);
    writeFileSync(extensions, `subjectAltName=DNS:${name}\nextendedKeyUsage=serverAuth\n`);
    execFileSync(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        request,
        '-subj',
        `/CN=${name}`,
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        request,
        '-CA',
        ca,
        '-CAkey',
        caKey,
        '-CAcreateserial',
        '-out',
        certificate,
        '-days',
        '2',
        '-extfile',
        extensions,
      ],
      { stdio: 'ignore' },
    );
    const serverDirectory = join(directory, name);
    mkdirSync(serverDirectory);
    mkdirSync(join(serverDirectory, 'CAs'));
    copyFileSync(certificate, join(serverDirectory, 'public.crt'));
    copyFileSync(key, join(serverDirectory, 'private.key'));
    copyFileSync(ca, join(serverDirectory, 'CAs/ca.crt'));
    chmodSync(join(serverDirectory, 'private.key'), 0o644);
  }
  chmodSync(ca, 0o644);
  return ca;
}

function baseEnvironment(directory) {
  return {
    ...process.env,
    DR_MANIFEST_SIGNING_KEY: manifestKey,
    DR_MANIFEST_KEY_ID: 'outer-bundle-integration-key',
    DR_SOURCE_RELEASE: 'outer-source@sha256:' + 'a'.repeat(64),
    DR_TARGET_RELEASE: 'outer-target@sha256:' + 'b'.repeat(64),
    DR_BACKUP_ENCRYPTION: 'aes-256-gcm',
    DR_BACKUP_DESTINATION_CLASS: 'independent',
    TEST_DIRECTORY: directory,
  };
}

test(
  'Production outer bundle restores PostgreSQL, MinIO, and Temporal with aggregate reconciliation',
  { skip: !enabled, timeout: 600_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tixkit-production-bundle-'));
    chmodSync(directory, 0o700);
    const adapters = join(directory, 'adapters');
    const snapshots = join(directory, 'temporal-snapshots');
    const provider = join(directory, 'independent-provider');
    const minioCertificates = join(directory, 'minio-certificates');
    mkdirSync(adapters, { mode: 0o700 });
    mkdirSync(snapshots, { mode: 0o700 });
    mkdirSync(provider, { mode: 0o700 });
    mkdirSync(minioCertificates, { mode: 0o700 });
    const minioCa = createMinioTlsCertificates(minioCertificates, [
      'minio-source',
      'minio-target',
      'minio-provider',
    ]);
    mcCertificateAuthority = minioCa;
    const mcTlsMount = `-v ${JSON.stringify(minioCa)}:/root/.mc/certs/CAs/ca.crt:ro`;
    const suffix = randomBytes(5).toString('hex');
    const network = `tixkit-outer-${suffix}`;
    const appSource = `tixkit-outer-app-source-${suffix}`;
    const appTarget = `tixkit-outer-app-target-${suffix}`;
    const temporalPostgresSource = `tixkit-outer-temporal-pg-source-${suffix}`;
    const temporalPostgresTarget = `tixkit-outer-temporal-pg-target-${suffix}`;
    const temporalSource = `tixkit-outer-temporal-source-${suffix}`;
    const temporalTarget = `tixkit-outer-temporal-target-${suffix}`;
    const minioSource = `tixkit-outer-minio-source-${suffix}`;
    const minioTarget = `tixkit-outer-minio-target-${suffix}`;
    const minioProvider = `tixkit-outer-minio-provider-${suffix}`;
    const containers = [
      temporalSource,
      temporalTarget,
      appSource,
      appTarget,
      temporalPostgresSource,
      temporalPostgresTarget,
      minioSource,
      minioTarget,
      minioProvider,
    ];
    const namespace = `tixkit-outer-${suffix}`;
    const workflowId = `outer-bundle-workflow-${suffix}`;
    const sourceBucket = `tixkit-source-${suffix}`;
    const targetBucket = `tixkit-target-${suffix}`;
    const providerBucket = `tixkit-provider-${suffix}`;
    const serviceExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
    const roleCredential = (prefix) => ({
      parentAccess: `${prefix}p${randomBytes(7).toString('hex')}`,
      parentSecret: `${prefix}P${randomBytes(24).toString('base64url')}`,
      access: `${prefix}s${randomBytes(7).toString('hex')}`,
      secret: `${prefix}S${randomBytes(24).toString('base64url')}`,
    });
    const sourceReader = roleCredential('src');
    const targetWriter = roleCredential('dstw');
    const targetVerifier = roleCredential('dstv');
    const providerPublisher = roleCredential('pub');
    const providerRetriever = roleCredential('ret');
    const providerVerifier = roleCredential('ver');
    const targetReceipt = join(directory, 'temporal-target-receipt.json');
    const productionTargetReceipt = join(directory, 'production-target-receipt.json');
    const ciphertext = join(provider, 'production-bundle.enc');
    const env = baseEnvironment(directory);

    try {
      docker(['network', 'create', network]);
      startPostgres(appSource, 'app-source', network, 'tixkit', appPassword, 'tixkit', true);
      startPostgres(appTarget, 'app-target', network, 'tixkit', appPassword, 'tixkit', true);
      startPostgres(
        temporalPostgresSource,
        'temporal-pg-source',
        network,
        'temporal',
        temporalPassword,
        'temporal',
      );
      startPostgres(
        temporalPostgresTarget,
        'temporal-pg-target',
        network,
        'temporal',
        temporalPassword,
        'temporal',
      );
      const sourceUrl = postgresUrl(appSource, 'tixkit', appPassword, 'tixkit');
      const targetUrl = postgresUrl(appTarget, 'tixkit', appPassword, 'tixkit');
      execFileSync('psql', [targetUrl, '-c', 'CREATE DATABASE restore_control'], {
        cwd: root,
        stdio: 'pipe',
      });
      const targetControlUrl = targetUrl.replace(/\/tixkit\?/, '/restore_control?');
      execFileSync(
        'psql',
        [
          targetControlUrl,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          "CREATE TABLE production_restore_claims (production_target_id text PRIMARY KEY, attempt_id text NOT NULL UNIQUE, bundle_sha256 char(64) NOT NULL, target_receipt_sha256 char(64) NOT NULL, publication_receipt_sha256 char(64) NOT NULL, holder_pid integer NOT NULL, provider_backend_pid integer NOT NULL, fencing_generation bigint NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'active', lease_expires_at timestamptz NOT NULL, restore_evidence_sha256 char(64), completed_at timestamptz, quarantined_at timestamptz, claimed_at timestamptz NOT NULL DEFAULT now())",
          '-c',
          'CREATE TABLE production_restore_claim_audit (production_target_id text NOT NULL, attempt_id text NOT NULL, fencing_generation bigint NOT NULL, previous_status text, transition text NOT NULL, transitioned_at timestamptz NOT NULL DEFAULT now())',
        ],
        { cwd: root, stdio: 'pipe' },
      );
      execFileSync('bun', ['--filter', '@tixkit/db', 'migrate'], {
        cwd: root,
        env: { ...process.env, DATABASE_URL: sourceUrl, DB_DRIVER: 'postgres' },
        stdio: 'pipe',
      });
      execFileSync(
        'psql',
        [
          sourceUrl,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `INSERT INTO tenants (id,name) VALUES ('ten_outer','Outer tenant');
INSERT INTO organizations (id,tenant_id,name,slug) VALUES ('org_outer','ten_outer','Outer organization','outer-org');
INSERT INTO brands (id,tenant_id,organization_id,name,slug,status,theme,legal_urls) VALUES ('brd_outer','ten_outer','org_outer','Outer brand','outer-brand','active','{}','{}');
INSERT INTO events (id,tenant_id,organization_id,brand_id,slug,title,status,currency,timezone,starts_at,visibility,seo,cover_image_url,cover_image_alt,seo_use_cover_image)
VALUES ('evt_outer','ten_outer','org_outer','brd_outer','outer-event','Outer bundle proof','published','USD','UTC','2027-01-01T00:00:00Z','public','{}','s3://${sourceBucket}/poster.webp','Accessible outer proof poster',true);`,
        ],
        { cwd: root, stdio: 'pipe' },
      );

      createTemporal(temporalSource, 'temporal-source', network, 'temporal-pg-source');
      createTemporal(temporalTarget, 'temporal-target', network, 'temporal-pg-target');
      startTemporal(temporalSource);
      temporal(temporalSource, [
        'operator',
        'namespace',
        'create',
        '--address',
        `${temporalSource}:7233`,
        '--namespace',
        namespace,
        '--retention',
        '24h',
      ]);
      const startedWorkflow = JSON.parse(
        temporal(temporalSource, [
          'workflow',
          'start',
          '--address',
          `${temporalSource}:7233`,
          '--namespace',
          namespace,
          '--workflow-id',
          workflowId,
          '--type',
          'outerBundleProofWorkflow',
          '--task-queue',
          'outer-bundle-unavailable-worker',
          '--input',
          JSON.stringify({
            tenantId: 'ten_outer',
            eventId: 'evt_outer',
            mediaObject: `s3://${sourceBucket}/poster.webp`,
          }),
          '--output',
          'json',
        ]),
      );

      for (const [name, hostname] of [
        [minioSource, 'minio-source'],
        [minioTarget, 'minio-target'],
        [minioProvider, 'minio-provider'],
      ]) {
        docker([
          'run',
          '-d',
          '--name',
          name,
          '--hostname',
          hostname,
          '--network',
          network,
          '--tmpfs',
          '/data:rw,noexec,nosuid,size=256m',
          '-e',
          `MINIO_ROOT_USER=${minioUser}`,
          '-e',
          `MINIO_ROOT_PASSWORD=${minioPassword}`,
          '-v',
          `${minioCertificates}:/certs:ro`,
          minioImage,
          'server',
          '--certs-dir',
          `/certs/${hostname}`,
          '/data',
        ]);
      }
      for (const [name, hostname] of [
        [minioSource, 'minio-source'],
        [minioTarget, 'minio-target'],
        [minioProvider, 'minio-provider'],
      ])
        waitFor(
          name,
          [
            'curl',
            '--cacert',
            '/certs/ca.pem',
            '-fsS',
            `https://${hostname}:9000/minio/health/live`,
          ],
          90_000,
        );
      mcHostOverrides = [
        [minioSource, 'minio-source'],
        [minioTarget, 'minio-target'],
        [minioProvider, 'minio-provider'],
      ].map(([name, hostname]) => ({
        hostname,
        address: docker([
          'inspect',
          '--format',
          `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
          name,
        ]).trim(),
      }));
      const mcHostFlags = mcHostOverrides
        .map(({ hostname, address }) => `--add-host ${hostname}:${address}`)
        .join(' ');
      mcShell(
        network,
        `mc alias set source-admin https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc mb source-admin/${sourceBucket} && printf outer-poster-content >/tmp/poster && mc cp --attr 'Content-Type=image/webp;Cache-Control=public,max-age=3600;role=poster' /tmp/poster source-admin/${sourceBucket}/poster.webp`,
      );
      const applicationObjectPolicy = join(directory, 'application-object-policy.json');
      writeFileSync(
        applicationObjectPolicy,
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
              Resource: [`arn:aws:s3:::${sourceBucket}`, `arn:aws:s3:::${sourceBucket}/*`],
            },
          ],
        }),
        { mode: 0o600 },
      );
      mcShell(
        network,
        `mc alias set source-admin https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc admin user add source-admin ${minioApplicationUser} ${minioApplicationPassword} && mc admin policy create source-admin outer-app-writer /config/application-object-policy.json && mc admin policy attach source-admin outer-app-writer --user ${minioApplicationUser}`,
        [{ source: directory, target: '/config' }],
      );
      mcShell(
        network,
        `mc alias set provider-admin https://minio-provider:9000 ${minioUser} ${minioPassword} >/dev/null && mc mb --with-lock provider-admin/${providerBucket} && mc retention set --default GOVERNANCE 1d provider-admin/${providerBucket}`,
      );
      const rolePolicies = [
        {
          name: 'outer-source-reader',
          endpoint: 'minio-source',
          bucket: sourceBucket,
          credential: sourceReader,
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject'],
        },
        {
          name: 'outer-target-writer',
          endpoint: 'minio-target',
          bucket: targetBucket,
          credential: targetWriter,
          actions: [
            's3:CreateBucket',
            's3:DeleteBucket',
            's3:GetBucketLocation',
            's3:ListBucket',
            's3:PutObject',
            's3:DeleteObject',
            's3:GetBucketTagging',
            's3:PutBucketTagging',
          ],
        },
        {
          name: 'outer-target-verifier',
          endpoint: 'minio-target',
          bucket: targetBucket,
          credential: targetVerifier,
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject', 's3:GetBucketTagging'],
        },
        {
          name: 'outer-provider-publisher',
          endpoint: 'minio-provider',
          bucket: providerBucket,
          credential: providerPublisher,
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:PutObject'],
        },
        {
          name: 'outer-provider-retriever',
          endpoint: 'minio-provider',
          bucket: providerBucket,
          credential: providerRetriever,
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject', 's3:GetObjectVersion'],
        },
        {
          name: 'outer-provider-verifier',
          endpoint: 'minio-provider',
          bucket: providerBucket,
          credential: providerVerifier,
          actions: ['s3:GetBucketLocation', 's3:ListBucket', 's3:GetObject', 's3:GetObjectVersion'],
        },
      ];
      for (const role of rolePolicies) {
        const policyFile = join(directory, `${role.name}.json`);
        writeFileSync(
          policyFile,
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: role.actions,
                Resource: [`arn:aws:s3:::${role.bucket}`, `arn:aws:s3:::${role.bucket}/*`],
              },
            ],
          }),
          { mode: 0o600 },
        );
        waitForMcShell(
          network,
          `mc alias set admin https://${role.endpoint}:9000 ${minioUser} ${minioPassword} >/dev/null && mc admin policy create admin ${role.name} /policy/${role.name}.json && mc admin user add admin ${role.credential.parentAccess} ${role.credential.parentSecret} && mc admin policy attach admin ${role.name} --user ${role.credential.parentAccess} && mc admin user svcacct add admin ${role.credential.parentAccess} --access-key ${role.credential.access} --secret-key ${role.credential.secret} --expiry ${serviceExpiry}`,
          [{ source: directory, target: '/policy', readOnly: true }],
        );
      }
      waitForMcShell(
        network,
        `mc alias set target-admin https://minio-target:9000 ${minioUser} ${minioPassword} >/dev/null && mc mb --ignore-existing target-admin/unrelated-${suffix} && printf sentinel | mc pipe target-admin/unrelated-${suffix}/sentinel`,
      );
      assert.throws(
        () =>
          mcShell(
            network,
            `mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && printf forbidden | mc pipe source/${sourceBucket}/forbidden`,
          ),
        /Command failed/u,
      );
      assert.throws(
        () =>
          mcShell(
            network,
            `mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc cat target/unrelated-${suffix}/sentinel`,
          ),
        /Command failed/u,
      );
      assert.throws(
        () =>
          mcShell(
            network,
            `mc alias set provider https://minio-provider:9000 ${providerRetriever.access} ${providerRetriever.secret} >/dev/null && printf forbidden | mc pipe provider/${providerBucket}/forbidden`,
          ),
        /Command failed/u,
      );

      docker([
        'exec',
        temporalPostgresTarget,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'temporal',
        '-d',
        'temporal',
        '-c',
        'CREATE DATABASE temporal_restore_control',
      ]);
      docker([
        'exec',
        temporalPostgresTarget,
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'temporal',
        '-d',
        'temporal_restore_control',
        '-c',
        'CREATE TABLE claims (immutable_id char(64) PRIMARY KEY, target_identity varchar(64) NOT NULL, nonce char(64) NOT NULL UNIQUE)',
      ]);
      const temporalTargetSystemId = docker([
        'exec',
        temporalPostgresTarget,
        'pg_controldata',
        '/var/lib/postgresql/data',
      ]).match(/Database system identifier:\s+(\d+)/u)?.[1];
      assert.match(temporalTargetSystemId, /^\d{10,}$/u);
      const applicationTargetSystemId = docker([
        'exec',
        appTarget,
        'pg_controldata',
        '/var/lib/postgresql/data',
      ]).match(/Database system identifier:\s+(\d+)/u)?.[1];
      assert.match(applicationTargetSystemId, /^\d{10,}$/u);
      const objectTargetSystemId = docker(['inspect', '--format', '{{.Id}}', minioTarget]).trim();
      const productionTargetPayload = {
        schemaVersion: 1,
        productionTargetId: 'outer-production-target',
        databaseTargetId: 'outer-postgres-target',
        objectTargetId: 'outer-object-target',
        applicationDatabaseSystemId: applicationTargetSystemId,
        temporalDatabaseSystemId: temporalTargetSystemId,
        objectSystemId: objectTargetSystemId,
        provisioningNonce: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
      writeFileSync(
        productionTargetReceipt,
        JSON.stringify({
          ...productionTargetPayload,
          providerSignature: createHmac('sha256', providerKey)
            .update(JSON.stringify(productionTargetPayload))
            .digest('hex'),
        }),
        { mode: 0o600 },
      );

      const quiesce = join(adapters, 'quiesce');
      const resume = join(adapters, 'resume');
      const checkpoint = join(adapters, 'temporal-checkpoint');
      const checkpointVerifier = join(adapters, 'verify-temporal-checkpoint');
      const backupConsistencyVerifier = join(adapters, 'verify-backup-consistency');
      const temporalRestore = join(adapters, 'restore-temporal');
      const temporalEvidenceVerifier = join(adapters, 'verify-temporal-evidence');
      const objectCredentials = join(adapters, 'object-credentials');
      const objectDownload = join(adapters, 'object-download');
      const objectMetadataExport = join(adapters, 'object-metadata-export');
      const objectUpload = join(adapters, 'object-upload');
      const objectOwnershipVerifier = join(adapters, 'object-ownership-verifier');
      const objectMetadataRestore = join(adapters, 'object-metadata-restore');
      const objectInventoryVerifier = join(adapters, 'object-inventory-verifier');
      const objectCleanup = join(adapters, 'object-cleanup');
      const objectAbsence = join(adapters, 'object-absence');
      const databaseVerifier = join(adapters, 'database-verifier');
      const objectVerifier = join(adapters, 'object-verifier');
      const finalVerifier = join(adapters, 'final-verifier');
      const publisher = join(adapters, 'publisher');
      const retriever = join(adapters, 'retriever');
      const receiptVerifier = join(adapters, 'receipt-verifier');
      const productionLeaseHolder = join(adapters, 'production-lease-holder');
      const productionLeaseVerifier = join(adapters, 'production-lease-verifier');
      const productionClaimCompleter = join(adapters, 'production-claim-completer');
      const productionClaimVerifier = join(adapters, 'production-claim-verifier');

      executable(
        quiesce,
        `#!/usr/bin/env bash
set -euo pipefail
psql ${JSON.stringify(sourceUrl)} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET default_transaction_read_only = on" >/dev/null
psql ${JSON.stringify(sourceUrl)} -v ON_ERROR_STOP=1 -c "SELECT pg_reload_conf()" >/dev/null
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source-admin https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc admin policy detach source-admin outer-app-writer --user ${minioApplicationUser}' >/dev/null
docker stop ${temporalSource} >/dev/null
`,
      );
      executable(
        resume,
        `#!/usr/bin/env bash
set -euo pipefail
docker start ${temporalSource} >/dev/null
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source-admin https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc admin policy attach source-admin outer-app-writer --user ${minioApplicationUser}' >/dev/null
psql ${JSON.stringify(sourceUrl)} -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET default_transaction_read_only = off" >/dev/null
psql ${JSON.stringify(sourceUrl)} -v ON_ERROR_STOP=1 -c "SELECT pg_reload_conf()" >/dev/null
`,
      );
      executable(
        checkpoint,
        `#!/usr/bin/env bash
set -euo pipefail
test "$(docker inspect --format '{{.State.Running}}' ${temporalSource})" = false
rm -f ${snapshots}/temporal.dump ${snapshots}/temporal_visibility.dump
docker exec ${temporalPostgresSource} pg_dump -U temporal -Fc -d temporal >${snapshots}/temporal.dump
docker exec ${temporalPostgresSource} pg_dump -U temporal -Fc -d temporal_visibility >${snapshots}/temporal_visibility.dump
chmod 600 ${snapshots}/temporal.dump ${snapshots}/temporal_visibility.dump
workflow_state_sha="$(docker exec ${temporalPostgresSource} psql -U temporal -d temporal -Atq -c \"COPY (SELECT kind,row_value FROM (SELECT 'current_executions' AS kind,row_to_json(t)::text AS row_value FROM current_executions t UNION ALL SELECT 'executions',row_to_json(t)::text FROM executions t UNION ALL SELECT 'history_node',row_to_json(t)::text FROM history_node t) state ORDER BY kind,row_value) TO STDOUT\" | shasum -a 256 | awk '{print $1}')"
application_state_sha="$(psql ${JSON.stringify(sourceUrl)} -Atq -c \"SELECT row_to_json(t)::text FROM (SELECT id,tenant_id,organization_id,brand_id,slug,title,status,cover_image_url,cover_image_alt,seo_use_cover_image FROM events WHERE id='evt_outer') t\" | shasum -a 256 | awk '{print $1}')"
object_body_sha="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && mc cat source/${sourceBucket}/poster.webp' | shasum -a 256 | awk '{print $1}')"
SNAPSHOT_DIR=${JSON.stringify(snapshots)} PROVIDER_DIR=${JSON.stringify(provider)} ENCRYPTION_PASSWORD=${JSON.stringify(publicationPassword)} TARGET_RECEIPT=${JSON.stringify(targetReceipt)} PROVIDER_KEY=${JSON.stringify(providerKey)} TARGET_SYSTEM=${JSON.stringify(temporalTargetSystemId)} TARGET_SERVICE=${JSON.stringify(temporalTarget)} NAMESPACE=${JSON.stringify(namespace)} WORKFLOW_ID=${JSON.stringify(workflowId)} RUN_ID=${JSON.stringify(startedWorkflow.runId)} WORKFLOW_STATE_SHA="$workflow_state_sha" APPLICATION_STATE_SHA="$application_state_sha" OBJECT_BODY_SHA="$object_body_sha" node - <<'NODE'
const {createCipheriv,createHash,createHmac,randomBytes}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const {join}=require('node:path');
const plaintextFiles=['temporal.dump','temporal_visibility.dump'].map(name=>({name,body:readFileSync(join(process.env.SNAPSHOT_DIR,name))})); const immutableId=createHash('sha256').update(plaintextFiles.map(file=>createHash('sha256').update(file.body).digest('hex')).join(':')).digest('hex'); const key=createHash('sha256').update(process.env.ENCRYPTION_PASSWORD).digest(); const files=plaintextFiles.map(({name,body})=>{const nonce=randomBytes(12); const encryptor=createCipheriv('aes-256-gcm',key,nonce); const encrypted=Buffer.concat([encryptor.update(body),encryptor.final()]); const cipher=Buffer.concat([nonce,encryptor.getAuthTag(),encrypted]); const providerObject=immutableId+'-'+name+'.enc'; writeFileSync(join(process.env.PROVIDER_DIR,providerObject),cipher,{flag:'wx',mode:0o600}); return {name,providerObject,sha256:createHash('sha256').update(body).digest('hex'),ciphertextSha256:createHash('sha256').update(cipher).digest('hex'),encryption:'aes-256-gcm'};});
const payload={schemaVersion:1,immutableId,namespace:process.env.NAMESPACE,workflowId:process.env.WORKFLOW_ID,runId:process.env.RUN_ID,recoveryPointAt:process.env.DR_RECOVERY_POINT_AT,verified:true,files,workflowStateSha256:process.env.WORKFLOW_STATE_SHA,applicationStateSha256:process.env.APPLICATION_STATE_SHA,objectBodySha256:process.env.OBJECT_BODY_SHA}; payload.providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE,JSON.stringify(payload),{flag:'wx',mode:0o600});
const receiptPayload={schemaVersion:1,targetSystemId:process.env.TARGET_SYSTEM,targetService:process.env.TARGET_SERVICE,immutableId,recoveryPointAt:payload.recoveryPointAt,namespace:payload.namespace,runId:payload.runId,nonce:require('node:crypto').randomBytes(32).toString('hex'),expiresAt:new Date(Date.now()+30*60*1000).toISOString()}; receiptPayload.providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(receiptPayload)).digest('hex'); writeFileSync(process.env.TARGET_RECEIPT,JSON.stringify(receiptPayload),{flag:'wx',mode:0o600});
NODE
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v ${JSON.stringify(provider)}:/staging --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerPublisher.access} ${providerPublisher.secret} >/dev/null && mc mirror /staging provider/${providerBucket}/temporal' >/dev/null
first_object="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[0].providerObject)')"
second_object="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[1].providerObject)')"
first_version="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c "mc alias set provider https://minio-provider:9000 ${providerVerifier.access} ${providerVerifier.secret} >/dev/null && mc stat --json provider/${providerBucket}/temporal/$first_object" | node -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value.trim().split(String.fromCharCode(10))[0]).versionID))')"
second_version="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c "mc alias set provider https://minio-provider:9000 ${providerVerifier.access} ${providerVerifier.secret} >/dev/null && mc stat --json provider/${providerBucket}/temporal/$second_object" | node -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value.trim().split(String.fromCharCode(10))[0]).versionID))')"
FIRST_VERSION="$first_version" SECOND_VERSION="$second_version" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const {providerSignature,...payload}=checkpoint; void providerSignature; payload.files[0].objectVersionId=process.env.FIRST_VERSION; payload.files[1].objectVersionId=process.env.SECOND_VERSION; const signature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE,JSON.stringify({...payload,providerSignature:signature}),{mode:0o600});
NODE
rm -f ${provider}/*.enc
`,
      );
      executable(
        checkpointVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
if test -z "\${DR_TEMPORAL_CHECKPOINT_JSON:-}"; then
  export DR_TEMPORAL_CHECKPOINT_JSON="$(cat "$DR_TEMPORAL_CHECKPOINT_FILE")"
fi
verification_dir="$(mktemp -d)"; trap 'rm -rf "$verification_dir"' EXIT
for index in 0 1; do
  object="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[Number(process.argv[1])].providerObject)' "$index")"
  version="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[Number(process.argv[1])].objectVersionId)' "$index")"
  docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$verification_dir:/verification" --env OBJECT="$object" --env VERSION="$version" --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerVerifier.access} ${providerVerifier.secret} >/dev/null && mc cp --version-id "$VERSION" "provider/${providerBucket}/temporal/$OBJECT" "/verification/$OBJECT"' >/dev/null
done
SNAPSHOT_DIR=${JSON.stringify(snapshots)} PROVIDER_DIR="$verification_dir" ENCRYPTION_PASSWORD=${JSON.stringify(publicationPassword)} PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createDecipheriv,createHash,createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync,rmSync}=require('node:fs'); const {join}=require('node:path'); const checkpoint=JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const {providerSignature,...payload}=checkpoint; const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) throw new Error('checkpoint signature mismatch'); const key=createHash('sha256').update(process.env.ENCRYPTION_PASSWORD).digest(); for(const file of payload.files){const cipher=readFileSync(join(process.env.PROVIDER_DIR,file.providerObject)); if(createHash('sha256').update(cipher).digest('hex')!==file.ciphertextSha256||file.encryption!=='aes-256-gcm') throw new Error('checkpoint ciphertext mismatch'); const decryptor=createDecipheriv('aes-256-gcm',key,cipher.subarray(0,12)); decryptor.setAuthTag(cipher.subarray(12,28)); const plain=Buffer.concat([decryptor.update(cipher.subarray(28)),decryptor.final()]); if(createHash('sha256').update(plain).digest('hex')!==file.sha256) throw new Error('checkpoint snapshot mismatch');} for(const name of ['temporal.dump','temporal_visibility.dump']) rmSync(join(process.env.SNAPSHOT_DIR,name),{force:true});
NODE
`,
      );
      executable(
        temporalRestore,
        `#!/usr/bin/env bash
set -euo pipefail
export DR_TEMPORAL_CHECKPOINT_JSON="$(cat "$DR_TEMPORAL_CHECKPOINT_FILE")"
${checkpointVerifier}
claim_file="$DR_TEMPORAL_RESTORE_EVIDENCE.claim"
RECEIPT="$DR_TEMPORAL_TARGET_RECEIPT" CLAIM_FILE="$claim_file" PROVIDER_KEY=${JSON.stringify(providerKey)} EXPECTED_SYSTEM=${JSON.stringify(temporalTargetSystemId)} EXPECTED_SERVICE=${JSON.stringify(temporalTarget)} node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const receipt=JSON.parse(readFileSync(process.env.RECEIPT)); const {providerSignature,...payload}=receipt; const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); const expires=Date.parse(payload.expiresAt); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.schemaVersion!==1||!Number.isFinite(expires)||expires<=Date.now()||payload.targetSystemId!==process.env.EXPECTED_SYSTEM||payload.targetService!==process.env.EXPECTED_SERVICE||payload.immutableId!==checkpoint.immutableId||payload.recoveryPointAt!==checkpoint.recoveryPointAt||payload.namespace!==checkpoint.namespace||payload.runId!==checkpoint.runId||!/^[a-f0-9]{64}$/.test(payload.nonce)) throw new Error('target receipt mismatch'); writeFileSync(process.env.CLAIM_FILE,[payload.immutableId,payload.targetSystemId,payload.nonce].join('|')+'\\n',{flag:'wx',mode:0o600});
NODE
IFS='|' read -r immutable_id target_system nonce <"$claim_file"; rm -f "$claim_file"
test "$(docker exec ${temporalPostgresTarget} pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier:[[:space:]]*//p')" = "$target_system"
docker exec ${temporalPostgresTarget} psql -v ON_ERROR_STOP=1 -U temporal -d temporal_restore_control -c "INSERT INTO claims VALUES ('$immutable_id','$target_system','$nonce')" >/dev/null
docker exec ${temporalPostgresTarget} psql -v ON_ERROR_STOP=1 -U temporal -d temporal -c 'CREATE DATABASE temporal_visibility' >/dev/null
restore_snapshots="$(mktemp -d)"; trap 'rm -rf "$restore_snapshots"' EXIT
provider_snapshots="$(mktemp -d)"
for index in 0 1; do
  object="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[Number(process.argv[1])].providerObject)' "$index")"
  version="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).files[Number(process.argv[1])].objectVersionId)' "$index")"
  docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$provider_snapshots:/provider" --env OBJECT="$object" --env VERSION="$version" --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerRetriever.access} ${providerRetriever.secret} >/dev/null && mc cp --version-id "$VERSION" "provider/${providerBucket}/temporal/$OBJECT" "/provider/$OBJECT"' >/dev/null
done
PROVIDER_DIR="$provider_snapshots" OUTPUT_DIR="$restore_snapshots" ENCRYPTION_PASSWORD=${JSON.stringify(publicationPassword)} node - <<'NODE'
const {createDecipheriv,createHash}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const {join}=require('node:path'); const checkpoint=JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const key=createHash('sha256').update(process.env.ENCRYPTION_PASSWORD).digest(); for(const file of checkpoint.files){const cipher=readFileSync(join(process.env.PROVIDER_DIR,file.providerObject)); if(createHash('sha256').update(cipher).digest('hex')!==file.ciphertextSha256) throw new Error('provider snapshot ciphertext mismatch'); const decryptor=createDecipheriv('aes-256-gcm',key,cipher.subarray(0,12)); decryptor.setAuthTag(cipher.subarray(12,28)); const plain=Buffer.concat([decryptor.update(cipher.subarray(28)),decryptor.final()]); if(createHash('sha256').update(plain).digest('hex')!==file.sha256) throw new Error('provider snapshot plaintext mismatch'); writeFileSync(join(process.env.OUTPUT_DIR,file.name),plain,{flag:'wx',mode:0o600});}
NODE
rm -rf "$provider_snapshots"
docker cp "$restore_snapshots/temporal.dump" ${temporalPostgresTarget}:/tmp/temporal.dump
docker cp "$restore_snapshots/temporal_visibility.dump" ${temporalPostgresTarget}:/tmp/temporal_visibility.dump
docker exec ${temporalPostgresTarget} pg_restore --exit-on-error --clean --if-exists -U temporal -d temporal /tmp/temporal.dump >/dev/null
docker exec ${temporalPostgresTarget} pg_restore --exit-on-error --clean --if-exists -U temporal -d temporal_visibility /tmp/temporal_visibility.dump >/dev/null
docker exec ${temporalPostgresTarget} rm -f /tmp/temporal.dump /tmp/temporal_visibility.dump
expected_state="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).workflowStateSha256)')"
actual_state="$(docker exec ${temporalPostgresTarget} psql -U temporal -d temporal -Atq -c \"COPY (SELECT kind,row_value FROM (SELECT 'current_executions' AS kind,row_to_json(t)::text AS row_value FROM current_executions t UNION ALL SELECT 'executions',row_to_json(t)::text FROM executions t UNION ALL SELECT 'history_node',row_to_json(t)::text FROM history_node t) state ORDER BY kind,row_value) TO STDOUT\" | shasum -a 256 | awk '{print $1}')"
test "$actual_state" = "$expected_state"
docker start ${temporalTarget} >/dev/null
for _ in $(seq 1 300); do docker exec ${temporalTarget} temporal operator cluster health --address ${temporalTarget}:7233 >/dev/null 2>&1 && break; sleep 0.2; done
description="$(docker exec ${temporalTarget} temporal workflow describe --address ${temporalTarget}:7233 --namespace ${namespace} --workflow-id ${workflowId} --output json)"
DESCRIPTION="$description" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const checkpoint=JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); const description=JSON.parse(process.env.DESCRIPTION); const runId=description.execution?.runId??description.workflowExecutionInfo?.execution?.runId; if(runId!==checkpoint.runId) throw new Error('restored run mismatch'); const payload={schemaVersion:1,verified:true,immutableId:checkpoint.immutableId,namespace:checkpoint.namespace,workflowId:checkpoint.workflowId,runId:checkpoint.runId,recoveryPointAt:checkpoint.recoveryPointAt,targetService:${JSON.stringify(temporalTarget)}}; payload.providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.DR_TEMPORAL_RESTORE_EVIDENCE,JSON.stringify(payload),{flag:'wx',mode:0o600});
NODE
`,
      );
      executable(
        backupConsistencyVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
${checkpointVerifier}
expected_application="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).applicationStateSha256)')"
actual_application="$(psql "$DATABASE_URL" -Atq -c \"SELECT row_to_json(t)::text FROM (SELECT id,tenant_id,organization_id,brand_id,slug,title,status,cover_image_url,cover_image_alt,seo_use_cover_image FROM events WHERE id='evt_outer') t\" | shasum -a 256 | awk '{print $1}')"
test "$actual_application" = "$expected_application"
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO events (id,tenant_id,organization_id,brand_id,slug,title,currency,timezone,starts_at,seo) VALUES ('evt_forbidden','ten_outer','org_outer','brd_outer','forbidden','Forbidden write','USD','UTC',now(),'{}')" >/dev/null 2>&1; then
  echo 'Application database accepted a write during the recovery boundary' >&2
  exit 1
fi
expected_object="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON ?? require("node:fs").readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)).objectBodySha256)')"
actual_object=''
for _ in $(seq 1 20); do
  actual_object="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && mc cat source/${sourceBucket}/poster.webp' | shasum -a 256 | awk '{print $1}')" && break
  sleep 0.5
done
test "$actual_object" = "$expected_object"
if docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set application https://minio-source:9000 ${minioApplicationUser} ${minioApplicationPassword} >/dev/null && printf forbidden | mc pipe application/${sourceBucket}/forbidden-during-backup' >/dev/null 2>&1; then
  echo 'Application object credential accepted a write during the recovery boundary' >&2
  exit 1
fi
! docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && mc stat source/${sourceBucket}/forbidden-during-backup' >/dev/null 2>&1
test "$(docker inspect --format '{{.State.Running}}' ${temporalSource})" = false
`,
      );
      executable(
        temporalEvidenceVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs'); const evidence=JSON.parse(readFileSync(process.env.DR_TEMPORAL_EVIDENCE_FILE)); const {providerSignature,...payload}=evidence; const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.targetService!==${JSON.stringify(temporalTarget)}) throw new Error('temporal evidence mismatch');
NODE
docker exec ${temporalTarget} temporal workflow describe --address ${temporalTarget}:7233 --namespace ${namespace} --workflow-id ${workflowId} >/dev/null
`,
      );

      executable(
        objectCredentials,
        '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p "$MC_CONFIG_DIR"\n',
      );
      executable(
        objectDownload,
        `#!/usr/bin/env bash
set -euo pipefail
for _ in $(seq 1 20); do
  docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer" --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && mc mirror source/${sourceBucket} /transfer' && exit 0
  sleep 0.5
done
exit 1
`,
      );
      executable(
        objectMetadataExport,
        `#!/usr/bin/env bash
set -euo pipefail
stat_json=''
for _ in $(seq 1 20); do
  stat_json="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 ${sourceReader.access} ${sourceReader.secret} >/dev/null && mc stat --json source/${sourceBucket}/poster.webp')" && break
  sleep 0.5
done
test -n "$stat_json"
STAT_JSON="$stat_json" node - <<'NODE'
const {writeFileSync}=require('node:fs'); const stat=JSON.parse(process.env.STAT_JSON); const metadata=stat.metadata??{}; const find=name=>Object.entries(metadata).find(([key])=>key.toLowerCase()===name)?.[1]??null; const custom={}; for(const [key,value] of Object.entries(metadata)){const match=/^x-amz-meta-(.+)$/i.exec(key); if(match) custom[match[1].toLowerCase()]=value;} writeFileSync(process.env.DR_OBJECT_METADATA_FILE,JSON.stringify({objects:[{key:'poster.webp',contentType:find('content-type'),cacheControl:find('cache-control'),customMetadata:custom}]}),{flag:'wx',mode:0o600});
NODE
`,
      );
      executable(
        objectUpload,
        `#!/usr/bin/env bash
set -euo pipefail
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer:ro" --env DR_OBJECT_TRANSFER_BUCKET --env DR_OBJECT_RESTORE_RUN_ID --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetWriter.access} ${targetWriter.secret} >/dev/null && mc mb "target/$DR_OBJECT_TRANSFER_BUCKET" && mc tag set "target/$DR_OBJECT_TRANSFER_BUCKET" "tixkit-restore-run=$DR_OBJECT_RESTORE_RUN_ID" && mc cp /transfer/poster.webp "target/$DR_OBJECT_TRANSFER_BUCKET/poster.webp"'
ENDPOINT="$S3_ENDPOINT" BUCKET="$DR_OBJECT_TRANSFER_BUCKET" RUN_ID="$DR_OBJECT_RESTORE_RUN_ID" node - <<'NODE'
require('node:fs').writeFileSync(process.env.DR_OBJECT_BUCKET_OWNERSHIP_FILE,JSON.stringify({schemaVersion:1,endpoint:process.env.ENDPOINT,bucket:process.env.BUCKET,restoreRunId:process.env.RUN_ID,created:true}),{flag:'wx',mode:0o600});
NODE
`,
      );
      const remoteOwnership = `docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc tag list "target/$RESTORE_S3_BUCKET"' | grep -F -- "$DR_OBJECT_RESTORE_RUN_ID"`;
      executable(
        objectOwnershipVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
${remoteOwnership}
`,
      );
      executable(
        objectMetadataRestore,
        `#!/usr/bin/env bash
set -euo pipefail
attributes="$(node - <<'NODE'
const inventory=JSON.parse(require('node:fs').readFileSync(process.env.DR_OBJECT_INVENTORY_FILE)); const metadata=inventory.objects.find(value=>value.key==='poster.webp').metadata; const pairs=[['Content-Type',metadata.contentType],['Cache-Control',metadata.cacheControl],...Object.entries(metadata.customMetadata??{})]; process.stdout.write(pairs.filter(([,value])=>value!=null).map(([key,value])=>key+'='+value).join(';'));
NODE
)"
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer:ro" --env RESTORE_S3_BUCKET --env ATTRIBUTES="$attributes" --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetWriter.access} ${targetWriter.secret} >/dev/null && mc cp --attr "$ATTRIBUTES" /transfer/poster.webp "target/$RESTORE_S3_BUCKET/poster.webp"' >/dev/null
`,
      );
      executable(
        objectInventoryVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
download="$(mktemp -d)"; trap 'rm -rf "$download"' EXIT
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$download:/download" --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc cp "target/$RESTORE_S3_BUCKET/poster.webp" /download/poster.webp' >/dev/null
DOWNLOADED="$download/poster.webp" node - <<'NODE'
const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs'); const inventory=JSON.parse(readFileSync(process.env.DR_OBJECT_INVENTORY_FILE)); const object=inventory.objects.find(value=>value.key==='poster.webp'); const body=readFileSync(process.env.DOWNLOADED); if(object.sizeBytes!==body.length||object.sha256!==createHash('sha256').update(body).digest('hex')) process.exit(1);
NODE
printf '{"verified":true,"inventorySha256":"%s"}\n' "$DR_OBJECT_EXPECTED_INVENTORY_SHA256"
`,
      );
      executable(
        objectCleanup,
        `#!/usr/bin/env bash
set -euo pipefail
${remoteOwnership}
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetWriter.access} ${targetWriter.secret} >/dev/null && mc rb --force "target/$RESTORE_S3_BUCKET"'
`,
      );
      executable(
        objectAbsence,
        `#!/usr/bin/env bash
set -euo pipefail
! docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc stat "target/$RESTORE_S3_BUCKET"' >/dev/null 2>&1
`,
      );
      executable(
        databaseVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
export DR_TEMPORAL_CHECKPOINT_JSON="$(cat "$DR_TEMPORAL_CHECKPOINT_FILE")"
expected="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON).applicationStateSha256)')"
actual="$(psql "$DATABASE_URL" -Atq -c \"SELECT row_to_json(t)::text FROM (SELECT id,tenant_id,organization_id,brand_id,slug,title,status,cover_image_url,cover_image_alt,seo_use_cover_image FROM events WHERE id='evt_outer') t\" | shasum -a 256 | awk '{print $1}')"
test "$actual" = "$expected"
`,
      );
      executable(
        objectVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
export DR_TEMPORAL_CHECKPOINT_JSON="$(cat "$DR_TEMPORAL_CHECKPOINT_FILE")"
expected="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON).objectBodySha256)')"
actual="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc cat "target/$RESTORE_S3_BUCKET/poster.webp"' | shasum -a 256 | awk '{print $1}')"
test "$actual" = "$expected"
`,
      );
      executable(
        finalVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
export DR_TEMPORAL_CHECKPOINT_JSON="$(cat "$DR_TEMPORAL_CHECKPOINT_FILE")"
expected_application="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON).applicationStateSha256)')"
actual_application="$(psql ${JSON.stringify(targetUrl)} -Atq -c \"SELECT row_to_json(t)::text FROM (SELECT id,tenant_id,organization_id,brand_id,slug,title,status,cover_image_url,cover_image_alt,seo_use_cover_image FROM events WHERE id='evt_outer') t\" | shasum -a 256 | awk '{print $1}')"
test "$actual_application" = "$expected_application"
expected_object="$(node -e 'process.stdout.write(JSON.parse(process.env.DR_TEMPORAL_CHECKPOINT_JSON).objectBodySha256)')"
actual_object="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc cat target/${targetBucket}/poster.webp' | shasum -a 256 | awk '{print $1}')"
test "$actual_object" = "$expected_object"
docker exec ${temporalTarget} temporal workflow describe --address ${temporalTarget}:7233 --namespace ${namespace} --workflow-id ${workflowId} >/dev/null
`,
      );

      executable(
        publisher,
        `#!/usr/bin/env bash
set -euo pipefail
cp "$DR_PUBLISH_MANIFEST" ${JSON.stringify(`${ciphertext}.manifest.json`)}
cp "$DR_PUBLISH_CHECKSUM" ${JSON.stringify(`${ciphertext}.sha256`)}
ARTIFACT="$DR_PUBLISH_ARTIFACT" CIPHERTEXT=${JSON.stringify(ciphertext)} PROVIDER_KEY=${JSON.stringify(providerKey)} ENCRYPTION_PASSWORD=${JSON.stringify(publicationPassword)} node - <<'NODE'
const {createCipheriv,createHash,createHmac,randomBytes}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const plain=readFileSync(process.env.ARTIFACT); const nonce=randomBytes(12); const key=createHash('sha256').update(process.env.ENCRYPTION_PASSWORD).digest(); const encryptor=createCipheriv('aes-256-gcm',key,nonce); const encrypted=Buffer.concat([encryptor.update(plain),encryptor.final()]); const cipher=Buffer.concat([nonce,encryptor.getAuthTag(),encrypted]); writeFileSync(process.env.CIPHERTEXT,cipher,{flag:'wx',mode:0o600}); const payload={schemaVersion:1,immutable:true,storageId:'independent://outer-bundle',retentionUntil:new Date(Date.now()+86400000).toISOString(),encryption:'aes-256-gcm',plaintextSha256:createHash('sha256').update(plain).digest('hex'),ciphertextSha256:createHash('sha256').update(cipher).digest('hex')}; payload.providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.DR_PUBLISH_RECEIPT,JSON.stringify(payload),{flag:'wx',mode:0o600});
NODE
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v ${JSON.stringify(provider)}:/staging:ro --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerPublisher.access} ${providerPublisher.secret} >/dev/null && mc cp /staging/production-bundle.enc provider/${providerBucket}/production-bundle.enc && mc cp /staging/production-bundle.enc.manifest.json provider/${providerBucket}/production-bundle.enc.manifest.json && mc cp /staging/production-bundle.enc.sha256 provider/${providerBucket}/production-bundle.enc.sha256' >/dev/null
provider_version="$(docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerVerifier.access} ${providerVerifier.secret} >/dev/null && mc stat --json provider/${providerBucket}/production-bundle.enc' | node -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk).on("end",()=>process.stdout.write(JSON.parse(value.trim().split(String.fromCharCode(10))[0]).versionID))')"
test -n "$provider_version"
RECEIPT="$DR_PUBLISH_RECEIPT" PROVIDER_VERSION="$provider_version" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const receipt=JSON.parse(readFileSync(process.env.RECEIPT)); const {providerSignature,...payload}=receipt; void providerSignature; payload.objectVersionId=process.env.PROVIDER_VERSION; const signature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); writeFileSync(process.env.RECEIPT,JSON.stringify({...payload,providerSignature:signature}),{mode:0o600});
NODE
rm -f ${JSON.stringify(ciphertext)} ${JSON.stringify(`${ciphertext}.manifest.json`)} ${JSON.stringify(`${ciphertext}.sha256`)}
`,
      );
      executable(
        receiptVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
provider_download="$(mktemp)"; trap 'rm -f "$provider_download"' EXIT
provider_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_RECEIPT_FILE)).objectVersionId)')"
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$(dirname "$provider_download"):/download" --env PROVIDER_VERSION="$provider_version" --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerVerifier.access} ${providerVerifier.secret} >/dev/null && mc cp --version-id "$PROVIDER_VERSION" provider/${providerBucket}/production-bundle.enc /download/'"$(basename "$provider_download")" >/dev/null
RECEIPT="$DR_RECEIPT_FILE" CIPHERTEXT="$provider_download" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHash,createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs'); const receipt=JSON.parse(readFileSync(process.env.RECEIPT)); const {providerSignature,...payload}=receipt; const signature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex'); const cipher=readFileSync(process.env.CIPHERTEXT); if(actual.length!==signature.length||!timingSafeEqual(actual,signature)||payload.encryption!=='aes-256-gcm'||payload.ciphertextSha256!==createHash('sha256').update(cipher).digest('hex')||Date.parse(payload.retentionUntil)<=Date.now()) throw new Error('publication receipt mismatch');
NODE
`,
      );
      executable(
        retriever,
        `#!/usr/bin/env bash
set -euo pipefail
DR_RECEIPT_FILE="$DR_RETRIEVE_RECEIPT" ${receiptVerifier}
provider_download="$(mktemp)"; trap 'rm -f "$provider_download"' EXIT
provider_version="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_RETRIEVE_RECEIPT)).objectVersionId)')"
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$(dirname "$provider_download"):/download" --env PROVIDER_VERSION="$provider_version" --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerRetriever.access} ${providerRetriever.secret} >/dev/null && mc cp --version-id "$PROVIDER_VERSION" provider/${providerBucket}/production-bundle.enc /download/'"$(basename "$provider_download")" >/dev/null
INPUT="$provider_download" OUTPUT="$DR_RETRIEVE_OUTPUT" ENCRYPTION_PASSWORD=${JSON.stringify(publicationPassword)} node - <<'NODE'
const {createDecipheriv,createHash}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs'); const input=readFileSync(process.env.INPUT); const key=createHash('sha256').update(process.env.ENCRYPTION_PASSWORD).digest(); const decryptor=createDecipheriv('aes-256-gcm',key,input.subarray(0,12)); decryptor.setAuthTag(input.subarray(12,28)); writeFileSync(process.env.OUTPUT,Buffer.concat([decryptor.update(input.subarray(28)),decryptor.final()]),{flag:'wx',mode:0o600});
NODE
docker run --rm --network ${network} ${mcHostFlags} ${mcTlsMount} -v "$(dirname "$DR_RETRIEVE_MANIFEST_OUTPUT"):/download" --entrypoint /bin/sh ${mcImage} -c 'mc alias set provider https://minio-provider:9000 ${providerRetriever.access} ${providerRetriever.secret} >/dev/null && mc cp provider/${providerBucket}/production-bundle.enc.manifest.json /download/'"$(basename "$DR_RETRIEVE_MANIFEST_OUTPUT")"' && mc cp provider/${providerBucket}/production-bundle.enc.sha256 /download/'"$(basename "$DR_RETRIEVE_CHECKSUM_OUTPUT")" >/dev/null 2>&1
`,
      );
      executable(
        productionLeaseHolder,
        `#!/usr/bin/env bash
set -euo pipefail
RECEIPT="$DR_PRODUCTION_TARGET_RECEIPT" PROVIDER_KEY=${JSON.stringify(providerKey)} EXPECTED_APPLICATION_SYSTEM=${JSON.stringify(applicationTargetSystemId)} EXPECTED_TEMPORAL_SYSTEM=${JSON.stringify(temporalTargetSystemId)} EXPECTED_OBJECT_SYSTEM=${JSON.stringify(objectTargetSystemId)} node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs'); const receipt=JSON.parse(readFileSync(process.env.RECEIPT)); const {providerSignature,...payload}=receipt; const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature??'','hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.productionTargetId!==process.env.DR_PRODUCTION_TARGET_ID||payload.databaseTargetId!==process.env.DR_DATABASE_TARGET_ID||payload.objectTargetId!==process.env.DR_OBJECT_TARGET_ID||payload.applicationDatabaseSystemId!==process.env.EXPECTED_APPLICATION_SYSTEM||payload.temporalDatabaseSystemId!==process.env.EXPECTED_TEMPORAL_SYSTEM||payload.objectSystemId!==process.env.EXPECTED_OBJECT_SYSTEM||Date.parse(payload.expiresAt)<=Date.now()) throw new Error('outer target receipt mismatch');
NODE
test "$(docker exec ${appTarget} pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier:[[:space:]]*//p')" = ${JSON.stringify(applicationTargetSystemId)}
test "$(docker exec ${temporalPostgresTarget} pg_controldata /var/lib/postgresql/data | sed -n 's/^Database system identifier:[[:space:]]*//p')" = ${JSON.stringify(temporalTargetSystemId)}
test "$(docker inspect --format '{{.Id}}' ${minioTarget})" = ${JSON.stringify(objectTargetSystemId)}
lease_db_pid=''
cleanup() {
  test -z "$lease_db_pid" || psql ${JSON.stringify(targetControlUrl)} -v ON_ERROR_STOP=1 -c "UPDATE production_restore_claims SET status='quarantined',quarantined_at=clock_timestamp() WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND status='active'" >/dev/null 2>&1 || true
  test -z "$lease_db_pid" || psql ${JSON.stringify(targetControlUrl)} -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(provider_backend_pid) FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID'" >/dev/null 2>&1 || true
  test -z "$lease_db_pid" || kill -TERM "$lease_db_pid" 2>/dev/null || true
  test -z "$lease_db_pid" || wait "$lease_db_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
psql ${JSON.stringify(targetControlUrl)} -v ON_ERROR_STOP=1 >/dev/null <<SQL &
SELECT pg_advisory_lock(hashtextextended('$DR_PRODUCTION_TARGET_ID', 0));
WITH previous AS (
  SELECT status FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID'
), claimed AS (
  INSERT INTO production_restore_claims (production_target_id,attempt_id,bundle_sha256,target_receipt_sha256,publication_receipt_sha256,holder_pid,provider_backend_pid,lease_expires_at)
  VALUES ('$DR_PRODUCTION_TARGET_ID','$DR_PRODUCTION_RESTORE_ATTEMPT_ID','$DR_PRODUCTION_BUNDLE_SHA256','$DR_PRODUCTION_TARGET_RECEIPT_SHA256','$DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256',$$,pg_backend_pid(),clock_timestamp()+interval '20 minutes')
  ON CONFLICT (production_target_id) DO UPDATE SET
    attempt_id=EXCLUDED.attempt_id,bundle_sha256=EXCLUDED.bundle_sha256,target_receipt_sha256=EXCLUDED.target_receipt_sha256,
    publication_receipt_sha256=EXCLUDED.publication_receipt_sha256,holder_pid=EXCLUDED.holder_pid,
    provider_backend_pid=EXCLUDED.provider_backend_pid,fencing_generation=production_restore_claims.fencing_generation+1,
    status='active',lease_expires_at=EXCLUDED.lease_expires_at,restore_evidence_sha256=NULL,completed_at=NULL,
    quarantined_at=NULL,claimed_at=clock_timestamp()
  WHERE production_restore_claims.status='quarantined' OR (
    production_restore_claims.status='active' AND production_restore_claims.lease_expires_at<=clock_timestamp()
  )
  RETURNING production_target_id,attempt_id,fencing_generation
)
INSERT INTO production_restore_claim_audit (production_target_id,attempt_id,fencing_generation,previous_status,transition)
SELECT claimed.production_target_id,claimed.attempt_id,claimed.fencing_generation,previous.status,
  CASE WHEN previous.status IS NULL THEN 'initial-claim' ELSE 'authorized-retry' END
FROM claimed LEFT JOIN previous ON true;
SELECT pg_sleep(1200);
SQL
lease_db_pid=$!
for _ in {1..100}; do
  psql ${JSON.stringify(targetControlUrl)} -Atqc "SELECT 1 FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND status='active'" | grep -qx 1 && break
  kill -0 "$lease_db_pid" 2>/dev/null || { wait "$lease_db_pid"; exit 1; }
  sleep 0.05
done
test "$(psql ${JSON.stringify(targetControlUrl)} -Atqc "SELECT count(*) FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND status='active'")" = 1
claim_state="$(psql ${JSON.stringify(targetControlUrl)} -Atqc "SELECT fencing_generation||'|'||extract(epoch FROM lease_expires_at) FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND status='active'")"
IFS='|' read -r fencing_generation lease_expires_epoch <<<"$claim_state"
HOLDER_PID="$$" FENCING_GENERATION="$fencing_generation" LEASE_EXPIRES_EPOCH="$lease_expires_epoch" node - <<'NODE'
const {writeFileSync}=require('node:fs'); const lease={schemaVersion:1,active:true,renewable:true,holderPid:Number(process.env.HOLDER_PID),fencingGeneration:Number(process.env.FENCING_GENERATION),attemptId:process.env.DR_PRODUCTION_RESTORE_ATTEMPT_ID,bundleSha256:process.env.DR_PRODUCTION_BUNDLE_SHA256,targetReceiptSha256:process.env.DR_PRODUCTION_TARGET_RECEIPT_SHA256,publicationReceiptSha256:process.env.DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256,productionTargetId:process.env.DR_PRODUCTION_TARGET_ID,databaseTargetId:process.env.DR_DATABASE_TARGET_ID,objectTargetId:process.env.DR_OBJECT_TARGET_ID,temporalImmutableId:process.env.DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID,recoveryPointAt:process.env.DR_PRODUCTION_RECOVERY_POINT_AT,sourceRelease:process.env.DR_PRODUCTION_SOURCE_RELEASE,targetRelease:process.env.DR_TARGET_RELEASE,provisioningNonce:${JSON.stringify(productionTargetPayload.provisioningNonce)},expiresAt:new Date(Number(process.env.LEASE_EXPIRES_EPOCH)*1000).toISOString()}; writeFileSync(process.env.DR_PRODUCTION_RESTORE_LEASE_FILE,JSON.stringify(lease),{flag:'wx',mode:0o600});
NODE
while :; do sleep 1; done
`,
      );
      executable(
        productionLeaseVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
row="$(psql ${JSON.stringify(targetControlUrl)} -At -v ON_ERROR_STOP=1 -c "SELECT attempt_id||'|'||bundle_sha256||'|'||target_receipt_sha256||'|'||publication_receipt_sha256||'|'||holder_pid||'|'||fencing_generation||'|'||provider_backend_pid||'|'||extract(epoch FROM lease_expires_at) FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND status='active'")"
IFS='|' read -r attempt bundle target_receipt publication_receipt holder_pid generation backend_pid lease_expires_epoch <<<"$row"
test "$attempt" = "$DR_PRODUCTION_RESTORE_ATTEMPT_ID"
test "$bundle" = "$DR_PRODUCTION_BUNDLE_SHA256"
test "$target_receipt" = "$DR_PRODUCTION_TARGET_RECEIPT_SHA256"
test "$publication_receipt" = "$DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256"
test "$generation" = "$DR_PRODUCTION_FENCING_GENERATION"
node -e 'if(Number(process.argv[1])*1000<=Date.now()) process.exit(1)' "$lease_expires_epoch"
test "$(psql ${JSON.stringify(targetControlUrl)} -Atqc "SELECT count(*) FROM pg_locks WHERE pid=$backend_pid AND locktype='advisory' AND granted")" -ge 1
kill -0 "$holder_pid"
cat "$DR_PRODUCTION_RESTORE_LEASE_FILE"
`,
      );
      executable(
        productionClaimCompleter,
        `#!/usr/bin/env bash
set -euo pipefail
row="$(psql ${JSON.stringify(targetControlUrl)} -qAt -v ON_ERROR_STOP=1 -c "WITH transitioned AS (UPDATE production_restore_claims SET status='completed',restore_evidence_sha256='$DR_PRODUCTION_RESTORE_EVIDENCE_SHA256',completed_at=clock_timestamp() WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND bundle_sha256='$DR_PRODUCTION_BUNDLE_SHA256' AND holder_pid=$DR_PRODUCTION_LEASE_HOLDER_PID AND fencing_generation=$DR_PRODUCTION_FENCING_GENERATION AND status='active' AND lease_expires_at>clock_timestamp() AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=production_restore_claims.provider_backend_pid AND locktype='advisory' AND granted) RETURNING fencing_generation,completed_at) SELECT fencing_generation||'|'||extract(epoch FROM completed_at) FROM transitioned UNION ALL SELECT fencing_generation||'|'||extract(epoch FROM completed_at) FROM production_restore_claims WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND bundle_sha256='$DR_PRODUCTION_BUNDLE_SHA256' AND fencing_generation=$DR_PRODUCTION_FENCING_GENERATION AND status='completed' AND restore_evidence_sha256='$DR_PRODUCTION_RESTORE_EVIDENCE_SHA256' LIMIT 1")"
test -n "$row"
IFS='|' read -r generation completed_epoch <<<"$row"
GENERATION="$generation" COMPLETED_EPOCH="$completed_epoch" PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac}=require('node:crypto'); const payload={schemaVersion:1,status:'completed',active:false,restoreEvidenceSha256:process.env.DR_PRODUCTION_RESTORE_EVIDENCE_SHA256,bundleSha256:process.env.DR_PRODUCTION_BUNDLE_SHA256,productionTargetId:process.env.DR_PRODUCTION_TARGET_ID,fencingGeneration:Number(process.env.GENERATION),completedAt:new Date(Number(process.env.COMPLETED_EPOCH)*1000).toISOString()}; payload.providerSignature=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest('hex'); process.stdout.write(JSON.stringify(payload));
NODE
`,
      );
      const productionClaimQuarantiner = join(adapters, 'production-claim-quarantiner');
      executable(
        productionClaimQuarantiner,
        `#!/usr/bin/env bash
set -euo pipefail
psql ${JSON.stringify(targetControlUrl)} -v ON_ERROR_STOP=1 -c "UPDATE production_restore_claims SET status='quarantined',quarantined_at=clock_timestamp() WHERE production_target_id='$DR_PRODUCTION_TARGET_ID' AND attempt_id='$DR_PRODUCTION_RESTORE_ATTEMPT_ID' AND bundle_sha256='$DR_PRODUCTION_BUNDLE_SHA256' AND holder_pid=$DR_PRODUCTION_LEASE_HOLDER_PID AND fencing_generation=$DR_PRODUCTION_FENCING_GENERATION AND status='active' AND EXISTS (SELECT 1 FROM pg_locks WHERE pid=production_restore_claims.provider_backend_pid AND locktype='advisory' AND granted)" >/dev/null
`,
      );
      executable(
        productionClaimVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
PROVIDER_KEY=${JSON.stringify(providerKey)} node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs'); const receipt=JSON.parse(readFileSync(process.env.DR_PRODUCTION_TARGET_CLAIM_RECEIPT)); const {providerSignature,...payload}=receipt; const expected=createHmac('sha256',process.env.PROVIDER_KEY).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature??'','hex'); if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||payload.restoreEvidenceSha256!==process.env.DR_PRODUCTION_RESTORE_EVIDENCE_SHA256) process.exit(1);
NODE
row="$(psql ${JSON.stringify(targetControlUrl)} -At -v ON_ERROR_STOP=1 -c "SELECT status||'|'||restore_evidence_sha256||'|'||fencing_generation FROM production_restore_claims WHERE production_target_id='outer-production-target'")"
IFS='|' read -r status evidence_sha generation <<<"$row"
test "$status" = completed
test "$evidence_sha" = "$DR_PRODUCTION_RESTORE_EVIDENCE_SHA256"
test "$generation" = "$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.env.DR_PRODUCTION_TARGET_CLAIM_RECEIPT)).fencingGeneration))')"
`,
      );

      const backupDirectory = join(directory, 'backup-output');
      const backupEnv = {
        ...env,
        DB_DRIVER: 'postgres',
        DATABASE_URL: sourceUrl,
        POSTGRES_GLOBALS_BACKUP_REFERENCE: 'vault://outer/postgres-roles/v1',
        S3_ENDPOINT: 'https://minio-source:9000',
        S3_BUCKET: sourceBucket,
        S3_AUTH_MODE: 'workload-identity',
        S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
        S3_DOWNLOAD_COMMAND: objectDownload,
        DR_OBJECT_METADATA_EXPORT_COMMAND: objectMetadataExport,
        DR_QUIESCE_COMMAND: quiesce,
        DR_RESUME_COMMAND: resume,
        DR_TEMPORAL_CHECKPOINT_COMMAND: checkpoint,
        DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND: checkpointVerifier,
        DR_BACKUP_CONSISTENCY_VERIFY_COMMAND: backupConsistencyVerifier,
        DR_BACKUP_PUBLISH_COMMAND: publisher,
        DR_BACKUP_RETRIEVE_COMMAND: retriever,
        DR_BACKUP_RECEIPT_VERIFY_COMMAND: receiptVerifier,
        BACKUP_DIR: backupDirectory,
        BACKUP_TIMESTAMP: '20260713T220000Z',
      };
      const backupOutput = execFileSync(resolve(root, 'infra/scripts/production-backup.sh'), {
        cwd: root,
        env: backupEnv,
        encoding: 'utf8',
      }).trim();
      const receipt = backupOutput.split('\n').at(-1);
      assert.ok(receipt);
      assert.equal(existsSync(receipt), true);
      assert.equal(statSync(receipt).mode & 0o777, 0o600);
      waitFor(temporalSource, [
        'temporal',
        'operator',
        'cluster',
        'health',
        '--address',
        `${temporalSource}:7233`,
      ]);
      for (const sourceContainer of [
        temporalSource,
        appSource,
        temporalPostgresSource,
        minioSource,
      ])
        docker(['rm', '-f', sourceContainer]);

      const retrieved = join(directory, 'retrieved-production-bundle.tar.gz');
      execFileSync(retriever, {
        cwd: root,
        env: {
          ...env,
          DR_RETRIEVE_RECEIPT: receipt,
          DR_RETRIEVE_OUTPUT: retrieved,
          DR_RETRIEVE_MANIFEST_OUTPUT: `${retrieved}.manifest.json`,
          DR_RETRIEVE_CHECKSUM_OUTPUT: `${retrieved}.sha256`,
        },
      });
      const primaryEvidenceDirectory = join(directory, 'restore-evidence-primary');
      const competingEvidenceDirectory = join(directory, 'restore-evidence-competing');
      const restoreEnv = {
        ...env,
        PRODUCTION_BUNDLE_FILE: retrieved,
        DB_DRIVER: 'postgres',
        DATABASE_URL: targetUrl,
        S3_ENDPOINT: 'https://minio-target:9000',
        S3_BUCKET: sourceBucket,
        RESTORE_S3_BUCKET: targetBucket,
        S3_AUTH_MODE: 'workload-identity',
        S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
        S3_UPLOAD_COMMAND: objectUpload,
        DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND: objectOwnershipVerifier,
        DR_OBJECT_METADATA_RESTORE_COMMAND: objectMetadataRestore,
        DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectInventoryVerifier,
        DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
        DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
        DR_DATABASE_VERIFY_COMMAND: databaseVerifier,
        DR_OBJECT_VERIFY_COMMAND: objectVerifier,
        DR_TEMPORAL_RESTORE_COMMAND: temporalRestore,
        DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND: temporalEvidenceVerifier,
        DR_FINAL_VERIFY_COMMAND: finalVerifier,
        DR_PRODUCTION_RETRIEVAL_RECEIPT: receipt,
        DR_BACKUP_RECEIPT_VERIFY_COMMAND: receiptVerifier,
        DR_TEMPORAL_TARGET_RECEIPT: targetReceipt,
        DR_PRODUCTION_TARGET_RECEIPT: productionTargetReceipt,
        DR_PRODUCTION_TARGET_LEASE_COMMAND: productionLeaseHolder,
        DR_PRODUCTION_TARGET_LEASE_VERIFY_COMMAND: productionLeaseVerifier,
        DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND: productionClaimCompleter,
        DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND: productionClaimVerifier,
        DR_PRODUCTION_TARGET_CLAIM_QUARANTINE_COMMAND: productionClaimQuarantiner,
        DR_DATABASE_TARGET_ID: 'outer-postgres-target',
        DR_OBJECT_TARGET_ID: 'outer-object-target',
        DR_PRODUCTION_TARGET_ID: 'outer-production-target',
        DR_EVIDENCE_DIR: primaryEvidenceDirectory,
        DR_INCIDENT_AT: new Date().toISOString(),
      };
      const restoreCommand = resolve(root, 'infra/scripts/production-restore.sh');
      const orphanLeaseDirectory = join(directory, 'orphan-provider-lease');
      mkdirSync(orphanLeaseDirectory, { mode: 0o700 });
      const orphanLeaseFile = join(orphanLeaseDirectory, 'lease.json');
      const orphanHolderLog = join(orphanLeaseDirectory, 'holder.log');
      const orphanAttemptId = randomBytes(32).toString('hex');
      const orphanHolder = spawn(
        'bash',
        ['-c', 'exec "$1" >"$2" 2>&1', '_', productionLeaseHolder, orphanHolderLog],
        {
          cwd: root,
          env: {
            ...env,
            DR_PRODUCTION_TARGET_RECEIPT: productionTargetReceipt,
            DR_PRODUCTION_RESTORE_ATTEMPT_ID: orphanAttemptId,
            DR_PRODUCTION_BUNDLE_SHA256: createHash('sha256')
              .update(readFileSync(retrieved))
              .digest('hex'),
            DR_PRODUCTION_RESTORE_LEASE_FILE: orphanLeaseFile,
            DR_PRODUCTION_TARGET_ID: restoreEnv.DR_PRODUCTION_TARGET_ID,
            DR_DATABASE_TARGET_ID: restoreEnv.DR_DATABASE_TARGET_ID,
            DR_OBJECT_TARGET_ID: restoreEnv.DR_OBJECT_TARGET_ID,
            DR_PRODUCTION_TEMPORAL_IMMUTABLE_ID: 'f'.repeat(64),
            DR_PRODUCTION_RECOVERY_POINT_AT: JSON.parse(
              readFileSync(`${retrieved}.manifest.json`, 'utf8'),
            ).recoveryPointAt,
            DR_PRODUCTION_TARGET_RECEIPT_SHA256: createHash('sha256')
              .update(readFileSync(productionTargetReceipt))
              .digest('hex'),
            DR_PRODUCTION_PUBLICATION_RECEIPT_SHA256: createHash('sha256')
              .update(readFileSync(receipt))
              .digest('hex'),
            DR_PRODUCTION_SOURCE_RELEASE: env.DR_SOURCE_RELEASE,
            DR_TARGET_RELEASE: env.DR_TARGET_RELEASE,
          },
          stdio: 'ignore',
        },
      );
      const orphanDeadline = Date.now() + 10_000;
      while (!existsSync(orphanLeaseFile) && Date.now() < orphanDeadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      assert.equal(
        existsSync(orphanLeaseFile),
        true,
        existsSync(orphanHolderLog)
          ? readFileSync(orphanHolderLog, 'utf8')
          : 'holder produced no log',
      );
      orphanHolder.kill('SIGKILL');
      execFileSync(
        'psql',
        [
          targetControlUrl,
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          `SELECT pg_terminate_backend(provider_backend_pid) FROM production_restore_claims WHERE production_target_id='outer-production-target'; UPDATE production_restore_claims SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE production_target_id='outer-production-target' AND status='active';`,
        ],
        { stdio: 'ignore' },
      );
      assert.equal(
        execFileSync(
          'psql',
          [
            targetControlUrl,
            '-Atqc',
            "SELECT status FROM production_restore_claims WHERE production_target_id='outer-production-target'",
          ],
          { encoding: 'utf8' },
        ).trim(),
        'active',
      );

      const orphanRetryEvidence = join(directory, 'orphan-retry-evidence');
      const orphanRetry = spawnSync(restoreCommand, [], {
        cwd: root,
        env: {
          ...restoreEnv,
          DATABASE_URL: 'postgres://postgres:unreachable@127.0.0.1:1/tixkit?connect_timeout=1',
          DR_EVIDENCE_DIR: orphanRetryEvidence,
          DR_INCIDENT_AT: new Date().toISOString(),
        },
        encoding: 'utf8',
      });
      assert.notEqual(orphanRetry.status, 0);
      assert.equal(existsSync(join(orphanRetryEvidence, 'database.json')), false);
      assert.equal(
        execFileSync(
          'psql',
          [
            targetControlUrl,
            '-Atqc',
            "SELECT status||'|'||fencing_generation FROM production_restore_claims WHERE production_target_id='outer-production-target'",
          ],
          { encoding: 'utf8' },
        ).trim(),
        'quarantined|2',
      );

      const restoreAttempts = await Promise.all([
        runProcess(restoreCommand, [], { cwd: root, env: restoreEnv }),
        runProcess(restoreCommand, [], {
          cwd: root,
          env: {
            ...restoreEnv,
            DR_EVIDENCE_DIR: competingEvidenceDirectory,
            DR_INCIDENT_AT: new Date().toISOString(),
          },
        }),
      ]);
      assert.deepEqual(
        restoreAttempts.map(({ status }) => status).sort(),
        [0, 1],
        restoreAttempts.map(({ stderr }) => stderr).join('\n---\n'),
      );
      const winnerIndex = restoreAttempts.findIndex(({ status }) => status === 0);
      const evidenceDirectory =
        winnerIndex === 0 ? primaryEvidenceDirectory : competingEvidenceDirectory;
      const loserDirectory =
        winnerIndex === 0 ? competingEvidenceDirectory : primaryEvidenceDirectory;
      assert.equal(existsSync(join(loserDirectory, 'database.json')), false);
      assert.match(
        restoreAttempts[1 - winnerIndex].stderr,
        /duplicate key|lease acquisition failed|Timed out acquiring/u,
      );
      for (const name of [
        'database.json',
        'object-storage.json',
        'temporal.json',
        'production.json',
      ])
        assert.equal(existsSync(join(evidenceDirectory, name)), true);
      const aggregateEvidence = readFileSync(join(evidenceDirectory, 'production.json'), 'utf8');
      for (const secret of [appPassword, temporalPassword, minioPassword, manifestKey, providerKey])
        assert.equal(aggregateEvidence.includes(secret), false);
      assert.equal(JSON.parse(aggregateEvidence).componentEvidenceSha256.length, 3);
      const parsedAggregateEvidence = JSON.parse(aggregateEvidence);
      assert.equal(
        parsedAggregateEvidence.publication.plaintextSha256,
        parsedAggregateEvidence.artifactSha256,
      );
      assert.equal(
        parsedAggregateEvidence.outerTargetClaim.publicationReceiptSha256,
        parsedAggregateEvidence.publication.receiptSha256,
      );
      assert.equal(
        parsedAggregateEvidence.outerTargetClaim.productionTargetId,
        'outer-production-target',
      );
      for (const name of [
        'database.json',
        'object-storage.json',
        'temporal.json',
        'production-target-lease.json',
        'production.json',
        'production-target-claim.json',
      ])
        assert.equal(statSync(join(evidenceDirectory, name)).mode & 0o777, 0o600);
      const completedClaim = JSON.parse(
        readFileSync(join(evidenceDirectory, 'production-target-claim.json'), 'utf8'),
      );
      const completedLease = JSON.parse(
        readFileSync(join(evidenceDirectory, 'production-target-lease.json'), 'utf8'),
      );
      const completionRecoveryEnv = {
        ...env,
        DR_PRODUCTION_TARGET_ID: completedLease.productionTargetId,
        DR_PRODUCTION_RESTORE_ATTEMPT_ID: completedLease.attemptId,
        DR_PRODUCTION_BUNDLE_SHA256: completedLease.bundleSha256,
        DR_PRODUCTION_LEASE_HOLDER_PID: String(completedLease.holderPid),
        DR_PRODUCTION_FENCING_GENERATION: String(completedLease.fencingGeneration),
        DR_PRODUCTION_RESTORE_EVIDENCE_SHA256: createHash('sha256')
          .update(aggregateEvidence)
          .digest('hex'),
      };
      const recoveredAfterProviderCommit = JSON.parse(
        execFileSync(productionClaimCompleter, [], {
          env: completionRecoveryEnv,
          encoding: 'utf8',
        }),
      );
      const recoveredAgain = JSON.parse(
        execFileSync(productionClaimCompleter, [], {
          env: completionRecoveryEnv,
          encoding: 'utf8',
        }),
      );
      assert.deepEqual(recoveredAfterProviderCommit, completedClaim);
      assert.deepEqual(recoveredAgain, completedClaim);
      assert.match(
        execFileSync(resolve(root, 'infra/scripts/finalize-production-restore-claim.sh'), [], {
          cwd: root,
          env: {
            ...env,
            DR_EVIDENCE_DIR: evidenceDirectory,
            DR_PRODUCTION_TARGET_CLAIM_COMPLETE_COMMAND: productionClaimCompleter,
            DR_PRODUCTION_TARGET_CLAIM_VERIFY_COMMAND: productionClaimVerifier,
          },
          encoding: 'utf8',
        }),
        /Production restore claim finalized/u,
      );
      assert.equal(existsSync(join(snapshots, 'temporal.dump')), false);
      assert.equal(existsSync(join(snapshots, 'temporal_visibility.dump')), false);

      const replay = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), [], {
        cwd: root,
        env: {
          ...restoreEnv,
          DR_EVIDENCE_DIR: join(directory, 'replay-evidence'),
          DR_INCIDENT_AT: new Date().toISOString(),
        },
        encoding: 'utf8',
      });
      assert.notEqual(replay.status, 0);
      assert.match(replay.stderr, /duplicate key|lease acquisition failed|Timed out acquiring/u);
      assert.equal(existsSync(join(directory, 'replay-evidence/database.json')), false);
      assert.equal(
        execFileSync(
          'psql',
          [targetControlUrl, '-Atqc', 'SELECT count(*) FROM production_restore_claims'],
          {
            encoding: 'utf8',
          },
        ).trim(),
        '1',
      );
      assert.equal(
        execFileSync(
          'psql',
          [
            targetControlUrl,
            '-Atqc',
            "SELECT count(*) FROM production_restore_claim_audit WHERE production_target_id='outer-production-target' AND transition='authorized-retry'",
          ],
          { encoding: 'utf8' },
        ).trim(),
        '2',
      );

      const wrongKeyRetriever = join(adapters, 'wrong-key-retriever');
      executable(
        wrongKeyRetriever,
        readFileSync(retriever, 'utf8').replaceAll(
          publicationPassword,
          'incorrect-publication-password',
        ),
      );
      const wrongKeyResult = spawnSync(wrongKeyRetriever, [], {
        cwd: root,
        env: {
          ...env,
          DR_RETRIEVE_RECEIPT: receipt,
          DR_RETRIEVE_OUTPUT: join(directory, 'wrong-key.tar.gz'),
          DR_RETRIEVE_MANIFEST_OUTPUT: join(directory, 'wrong-key.manifest.json'),
          DR_RETRIEVE_CHECKSUM_OUTPUT: join(directory, 'wrong-key.sha256'),
        },
        encoding: 'utf8',
      });
      assert.notEqual(wrongKeyResult.status, 0);
      assert.match(wrongKeyResult.stderr, /authenticate data|Unsupported state/u);

      const forgedReceipt = join(directory, 'forged-publication-receipt.json');
      const forgedReceiptPayload = JSON.parse(readFileSync(receipt, 'utf8'));
      forgedReceiptPayload.storageId = 'independent://substituted-outer-bundle';
      writeFileSync(forgedReceipt, JSON.stringify(forgedReceiptPayload), {
        mode: 0o600,
      });
      const forgedReceiptResult = spawnSync(receiptVerifier, [], {
        cwd: root,
        env: { ...env, DR_RECEIPT_FILE: forgedReceipt },
        encoding: 'utf8',
      });
      assert.notEqual(forgedReceiptResult.status, 0);

      mcShell(
        network,
        `mc alias set provider https://minio-provider:9000 ${providerRetriever.access} ${providerRetriever.secret} >/dev/null && mc cp provider/${providerBucket}/production-bundle.enc /provider/production-bundle.enc`,
        [{ source: provider, target: '/provider' }],
      );
      const originalCiphertext = readFileSync(ciphertext);
      const corruptedCiphertext = Buffer.from(originalCiphertext);
      corruptedCiphertext[corruptedCiphertext.length - 1] ^= 0xff;
      writeFileSync(ciphertext, corruptedCiphertext);
      mcShell(
        network,
        `mc alias set provider https://minio-provider:9000 ${providerPublisher.access} ${providerPublisher.secret} >/dev/null && mc cp /provider/production-bundle.enc provider/${providerBucket}/production-bundle.enc`,
        [{ source: provider, target: '/provider' }],
      );
      const corruptedRetrieval = spawnSync(retriever, [], {
        cwd: root,
        env: {
          ...env,
          DR_RETRIEVE_RECEIPT: receipt,
          DR_RETRIEVE_OUTPUT: join(directory, 'corrupted.tar.gz'),
          DR_RETRIEVE_MANIFEST_OUTPUT: join(directory, 'corrupted.manifest.json'),
          DR_RETRIEVE_CHECKSUM_OUTPUT: join(directory, 'corrupted.sha256'),
        },
        encoding: 'utf8',
      });
      assert.equal(corruptedRetrieval.status, 0, corruptedRetrieval.stderr);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(directory, 'corrupted.tar.gz')))
          .digest('hex'),
        createHash('sha256').update(readFileSync(retrieved)).digest('hex'),
      );
      const signedProviderVersion = JSON.parse(readFileSync(receipt, 'utf8')).objectVersionId;
      assert.throws(
        () =>
          mcShell(
            network,
            `mc alias set provider-admin https://minio-provider:9000 ${minioUser} ${minioPassword} >/dev/null && mc rm --version-id ${signedProviderVersion} provider-admin/${providerBucket}/production-bundle.enc`,
          ),
        /Command failed/u,
      );
      writeFileSync(ciphertext, originalCiphertext);
      assert.equal(
        execFileSync(
          'psql',
          [targetUrl, '-Atqc', "SELECT title FROM events WHERE id='evt_outer'"],
          {
            encoding: 'utf8',
          },
        ).trim(),
        'Outer bundle proof',
      );
      assert.equal(
        mcShell(
          network,
          `mc alias set target https://minio-target:9000 ${targetVerifier.access} ${targetVerifier.secret} >/dev/null && mc cat target/${targetBucket}/poster.webp`,
        ),
        'outer-poster-content',
      );
      assert.equal(
        JSON.parse(
          temporal(temporalTarget, [
            'workflow',
            'describe',
            '--address',
            `${temporalTarget}:7233`,
            '--namespace',
            namespace,
            '--workflow-id',
            workflowId,
            '--output',
            'json',
          ]),
        ).workflowExecutionInfo.execution.runId,
        startedWorkflow.runId,
      );
    } finally {
      mcCertificateAuthority = '';
      mcHostOverrides = [];
      for (const container of containers)
        spawnSync('docker', ['rm', '-f', container], {
          cwd: root,
          stdio: 'ignore',
        });
      spawnSync('docker', ['network', 'rm', network], {
        cwd: root,
        stdio: 'ignore',
      });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
