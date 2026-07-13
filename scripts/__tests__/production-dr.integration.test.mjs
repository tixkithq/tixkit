import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const mysqlImage =
  'mysql:8.4@sha256:d36d39a64cd12a5c1cc9e6aa2bfb5f8d4c81a2f6586e0a04a9ae13939db02209';
const minioImage =
  'minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const mcImage =
  'minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';
const mysqlPassword = 'production-dr-test-password';
const minioUser = 'productiondr';
const minioPassword = 'production-dr-minio-password';
const manifestKey = 'production-dr-integration-manifest-key';
const providerKey = 'production-dr-integration-provider-key';

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    ...options,
  });
}

function waitForContainer(name, command) {
  const deadline = Date.now() + 90_000;
  let lastError = '';
  while (Date.now() < deadline) {
    const result = spawnSync('docker', ['exec', name, ...command], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout;
    const running = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', name], {
      cwd: root,
      encoding: 'utf8',
    });
    if (running.status === 0 && running.stdout.trim() === 'false') {
      const logs = spawnSync('docker', ['logs', name], {
        cwd: root,
        encoding: 'utf8',
      });
      throw new Error(
        `Container ${name} exited before readiness:\n${logs.stderr || logs.stdout || lastError}`,
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`Container ${name} did not become ready: ${lastError}`);
}

function mcShell(network, command, mounts = []) {
  return docker([
    'run',
    '--rm',
    '--network',
    network,
    ...mounts.flatMap(({ source, target }) => ['-v', `${source}:${target}`]),
    '--entrypoint',
    '/bin/sh',
    mcImage,
    '-c',
    command,
  ]);
}

function mysqlExec(container, sql) {
  return docker([
    'exec',
    container,
    'mysql',
    '--user=root',
    `--password=${mysqlPassword}`,
    '--database=tixkit',
    '--batch',
    '--skip-column-names',
    '--execute',
    sql,
  ]).trim();
}

function createTlsCertificates(directory, names) {
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
      '/CN=Tixkit Production DR Test CA',
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
    chmodSync(key, 0o644);
  }
  chmodSync(ca, 0o644);
  return ca;
}

function baseDrEnvironment(directory) {
  return {
    ...process.env,
    DR_MANIFEST_SIGNING_KEY: manifestKey,
    DR_MANIFEST_KEY_ID: 'production-dr-integration-key',
    DR_SOURCE_RELEASE: 'integration-source@sha256:' + 'a'.repeat(64),
    DR_TARGET_RELEASE: 'integration-target@sha256:' + 'b'.repeat(64),
    DR_BACKUP_ENCRYPTION: 'docker-integration-test-key',
    DR_BACKUP_DESTINATION_CLASS: 'independent',
    TEST_DIRECTORY: directory,
  };
}

function verifyArtifactAndEvidence(env, artifact, kind, evidence) {
  execFileSync(
    'bash',
    [
      '-c',
      'source "$DR_COMMON"; dr_verify_checksum "$ARTIFACT"; dr_verify_backup_manifest "$ARTIFACT" "$KIND"; dr_verify_restore_evidence "$EVIDENCE" "$KIND"',
    ],
    {
      cwd: root,
      env: {
        ...env,
        DR_COMMON: resolve(root, 'infra/scripts/lib/dr-common.sh'),
        ARTIFACT: artifact,
        KIND: kind,
        EVIDENCE: evidence,
      },
      stdio: 'pipe',
    },
  );
}

function runDrCheck(env, command, values) {
  return execFileSync('bash', ['-c', `source "$DR_COMMON"; ${command}`], {
    cwd: root,
    env: {
      ...env,
      ...values,
      DR_COMMON: resolve(root, 'infra/scripts/lib/dr-common.sh'),
    },
    stdio: 'pipe',
  });
}

function assertPrivateFile(path) {
  assert.equal(statSync(path).mode & 0o777, 0o600);
}

test(
  'Production DR restores real TLS MySQL and MinIO data with provider-owned authority',
  { skip: !enabled, timeout: 480_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'tixkit-production-dr-integration-'));
    chmodSync(directory, 0o700);
    const suffix = randomBytes(5).toString('hex');
    const network = `tixkit-dr-${suffix}`;
    const mysqlSource = `tixkit-dr-mysql-source-${suffix}`;
    const mysqlTarget = `tixkit-dr-mysql-target-${suffix}`;
    const minioSource = `tixkit-dr-minio-source-${suffix}`;
    const minioTarget = `tixkit-dr-minio-target-${suffix}`;
    const minioBroker = `tixkit-dr-minio-broker-${suffix}`;
    const containers = [mysqlSource, mysqlTarget, minioSource, minioTarget, minioBroker];
    const certs = join(directory, 'certs');
    const adapters = join(directory, 'adapters');
    mkdirSync(certs);
    mkdirSync(adapters);
    const ca = createTlsCertificates(certs, [
      'mysql-source',
      'mysql-target',
      'minio-source',
      'minio-target',
    ]);
    for (const name of ['minio-source', 'minio-target']) {
      const directory = join(certs, name);
      mkdirSync(directory);
      mkdirSync(join(directory, 'CAs'));
      copyFileSync(join(certs, `${name}-cert.pem`), join(directory, 'public.crt'));
      copyFileSync(join(certs, `${name}-key.pem`), join(directory, 'private.key'));
      copyFileSync(ca, join(directory, 'CAs/ca.crt'));
    }
    const mcTlsMount = `-v ${ca}:/root/.mc/certs/CAs/ca.crt:ro`;
    const env = baseDrEnvironment(directory);

    try {
      docker(['network', 'create', network]);
      for (const [name, hostname, certificatePrefix] of [
        [mysqlSource, 'mysql-source', 'mysql-source'],
        [mysqlTarget, 'mysql-target', 'mysql-target'],
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
          '/var/lib/mysql:rw,noexec,nosuid,size=768m',
          '-e',
          `MYSQL_ROOT_PASSWORD=${mysqlPassword}`,
          '-e',
          'MYSQL_DATABASE=tixkit',
          '-v',
          `${certs}:/certs:ro`,
          mysqlImage,
          `--ssl-ca=/certs/ca.pem`,
          `--ssl-cert=/certs/${certificatePrefix}-cert.pem`,
          `--ssl-key=/certs/${certificatePrefix}-key.pem`,
          '--require-secure-transport=ON',
        ]);
      }
      for (const name of [mysqlSource, mysqlTarget])
        waitForContainer(name, [
          'mysql',
          '--protocol=TCP',
          '--host=127.0.0.1',
          '--user=root',
          `--password=${mysqlPassword}`,
          '--batch',
          '--skip-column-names',
          '--execute',
          'SELECT 1;',
        ]);

      mysqlExec(
        mysqlSource,
        "CREATE TABLE proof (id INT PRIMARY KEY, payload VARCHAR(64) NOT NULL); INSERT INTO proof VALUES (1, 'real-mysql-round-trip');",
      );
      const mysqlBackup = execFileSync(resolve(root, 'infra/scripts/backup-mysql.sh'), {
        cwd: root,
        env: {
          ...env,
          DATABASE_URL_MYSQL: `mysql://root:${mysqlPassword}@mysql-source:3306/tixkit`,
          DR_PRODUCTION_BUNDLE: '1',
          MYSQL_TLS_MODE: 'VERIFY_IDENTITY',
          MYSQL_TLS_CA_FILE: ca,
          MYSQL_TOOL_DOCKER_NETWORK: network,
          BACKUP_DIR: join(directory, 'mysql-backup'),
          BACKUP_TIMESTAMP: '20260713T180000Z',
        },
        encoding: 'utf8',
      }).trim();
      assert.equal(existsSync(mysqlBackup), true);

      const targetServerUuid = mysqlExec(mysqlTarget, 'SELECT @@server_uuid;');
      assert.match(targetServerUuid, /^[a-f0-9-]{36}$/u);
      const provisionReceipt = join(directory, 'mysql-provision-receipt.json');
      const provisioningNonce = randomBytes(32).toString('hex');
      const writeProvisionReceipt = (path, nonce) => {
        const receiptPayload = {
          schemaVersion: 1,
          serverUuid: targetServerUuid,
          database: 'tixkit',
          provisioningNonce: nonce,
          exclusive: true,
          empty: true,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
        const providerSignature = createHmac('sha256', providerKey)
          .update(JSON.stringify(receiptPayload))
          .digest('hex');
        writeFileSync(path, JSON.stringify({ ...receiptPayload, providerSignature }), {
          mode: 0o600,
        });
      };
      writeProvisionReceipt(provisionReceipt, provisioningNonce);

      const leaseHolder = join(adapters, 'mysql-lease-holder');
      const leaseVerifier = join(adapters, 'mysql-lease-verifier');
      const mysqlCleanup = join(adapters, 'mysql-cleanup');
      const mysqlVerifier = join(adapters, 'mysql-verifier');
      executable(
        leaseHolder,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs');
const receipt=JSON.parse(readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT)); const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256',${JSON.stringify(providerKey)}).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
NODE
nonce="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT)).provisioningNonce)')"
lock_name="tixkit-restore-\${nonce:0:32}"
docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --execute="CREATE DATABASE IF NOT EXISTS tixkit_restore_control; CREATE TABLE IF NOT EXISTS tixkit_restore_control.claims (nonce VARCHAR(128) PRIMARY KEY, attempt_id VARCHAR(128) NOT NULL, artifact_sha CHAR(64) NOT NULL, target_id VARCHAR(128) NOT NULL); INSERT INTO tixkit_restore_control.claims VALUES ('\${nonce}', '\${DR_MYSQL_RESTORE_ATTEMPT_ID}', '\${DR_MYSQL_RESTORE_ARTIFACT_SHA256}', '\${DR_MYSQL_RESTORE_TARGET_ID}');"
docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names --execute="SELECT GET_LOCK('\${lock_name}',0); SELECT SLEEP(3600);" >/dev/null &
lock_pid=$!
cleanup() {
  owner="$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names --execute="SELECT IS_USED_LOCK('\${lock_name}');" 2>/dev/null || true)"
  if [[ "$owner" =~ ^[0-9]+$ ]]; then
    docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --execute="KILL $owner;" >/dev/null 2>&1 || true
  fi
  kill -TERM "\${lock_pid}" 2>/dev/null || true
  wait "\${lock_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
for _ in $(seq 1 100); do
  lock_owner="$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names --execute="SELECT IS_USED_LOCK('\${lock_name}');")"
  test -n "\${lock_owner}" && test "\${lock_owner}" != NULL && break
  kill -0 "\${lock_pid}" 2>/dev/null || exit 1
  sleep 0.05
done
test -n "\${lock_owner}" && test "\${lock_owner}" != NULL
HOLDER_PID=$$ node - <<'NODE'
const {readFileSync,writeFileSync}=require('node:fs');
const receipt=JSON.parse(readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT));
writeFileSync(process.env.DR_MYSQL_RESTORE_LEASE_FILE,JSON.stringify({schemaVersion:1,attemptId:process.env.DR_MYSQL_RESTORE_ATTEMPT_ID,artifactSha256:process.env.DR_MYSQL_RESTORE_ARTIFACT_SHA256,restoreTargetId:process.env.DR_MYSQL_RESTORE_TARGET_ID,serverUuid:receipt.serverUuid,database:receipt.database,provisioningNonce:receipt.provisioningNonce,holderPid:Number(process.env.HOLDER_PID),active:true,renewable:true,expiresAt:new Date(Date.now()+15*60*1000).toISOString()}),{flag:'wx',mode:0o600});
NODE
wait "\${lock_pid}"
`,
      );
      executable(
        leaseVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
nonce="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT)).provisioningNonce)')"
claim="$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --raw --skip-column-names --execute="SELECT CONCAT_WS(CHAR(9),attempt_id,artifact_sha,target_id) FROM tixkit_restore_control.claims WHERE nonce='\${nonce}';")"
test "\${claim}" = "\${DR_MYSQL_RESTORE_ATTEMPT_ID}"$'\t'"\${DR_MYSQL_RESTORE_ARTIFACT_SHA256}"$'\t'"\${DR_MYSQL_RESTORE_TARGET_ID}"
lock_owner="$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names --execute="SELECT IS_USED_LOCK('tixkit-restore-\${nonce:0:32}');")"
test -n "\${lock_owner}" && test "\${lock_owner}" != NULL
node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs');
const receipt=JSON.parse(readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT)); const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256',${JSON.stringify(providerKey)}).update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
const lease=JSON.parse(readFileSync(process.env.DR_MYSQL_RESTORE_LEASE_FILE)); lease.expiresAt=new Date(Date.now()+15*60*1000).toISOString(); process.stdout.write(JSON.stringify(lease));
NODE
`,
      );
      executable(
        mysqlCleanup,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --execute="DROP DATABASE IF EXISTS tixkit; CREATE DATABASE tixkit;"
`,
      );
      executable(
        mysqlVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test "$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names tixkit --execute='SELECT payload FROM proof WHERE id=1;')" = real-mysql-round-trip
`,
      );
      const mysqlEvidence = join(directory, 'evidence/mysql.json');
      execFileSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...env,
          DATABASE_URL_MYSQL: `mysql://root:${mysqlPassword}@mysql-target:3306/tixkit`,
          MYSQL_BACKUP_FILE: mysqlBackup,
          DR_ISOLATED_TARGET: '1',
          DR_PRODUCTION_BUNDLE: '1',
          MYSQL_TLS_MODE: 'VERIFY_IDENTITY',
          MYSQL_TLS_CA_FILE: ca,
          MYSQL_TOOL_DOCKER_NETWORK: network,
          DR_MYSQL_TARGET_SERVER_UUID: targetServerUuid,
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: mysqlCleanup,
          DR_RESTORE_TARGET_ID: 'real-mysql-target',
          DR_VERIFY_COMMAND: mysqlVerifier,
          DR_EVIDENCE_FILE: mysqlEvidence,
          DR_INCIDENT_AT: new Date().toISOString(),
        },
      });
      assert.equal(
        mysqlExec(mysqlTarget, 'SELECT payload FROM tixkit.proof WHERE id=1;'),
        'real-mysql-round-trip',
      );
      assert.equal(
        JSON.parse(readFileSync(mysqlEvidence, 'utf8')).verification,
        'command-completed',
      );
      verifyArtifactAndEvidence(env, mysqlBackup, 'mysql', mysqlEvidence);
      for (const path of [
        mysqlBackup,
        `${mysqlBackup}.sha256`,
        `${mysqlBackup}.manifest.json`,
        mysqlEvidence,
      ])
        assertPrivateFile(path);
      const mysqlEvidenceText = readFileSync(mysqlEvidence, 'utf8');
      for (const secret of [mysqlPassword, manifestKey, providerKey])
        assert.equal(mysqlEvidenceText.includes(secret), false);

      const mysqlTamperDirectory = join(directory, 'mysql-tamper');
      mkdirSync(mysqlTamperDirectory);
      const mysqlTampered = join(mysqlTamperDirectory, mysqlBackup.split('/').at(-1));
      for (const suffix of ['', '.sha256', '.manifest.json'])
        copyFileSync(`${mysqlBackup}${suffix}`, `${mysqlTampered}${suffix}`);
      writeFileSync(mysqlTampered, 'tamper', { flag: 'a' });
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_checksum "$ARTIFACT"', { ARTIFACT: mysqlTampered }),
      );
      copyFileSync(mysqlBackup, mysqlTampered);
      const mysqlManifest = JSON.parse(readFileSync(`${mysqlTampered}.manifest.json`, 'utf8'));
      mysqlManifest.signature.value = '0'.repeat(64);
      writeFileSync(`${mysqlTampered}.manifest.json`, JSON.stringify(mysqlManifest));
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_backup_manifest "$ARTIFACT" mysql', {
          ARTIFACT: mysqlTampered,
        }),
      );
      const tamperedMysqlEvidence = join(directory, 'mysql-evidence-tampered.json');
      const tamperedEvidencePayload = JSON.parse(mysqlEvidenceText);
      tamperedEvidencePayload.signature.value = '0'.repeat(64);
      writeFileSync(tamperedMysqlEvidence, JSON.stringify(tamperedEvidencePayload), {
        mode: 0o600,
      });
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_restore_evidence "$EVIDENCE" mysql', {
          EVIDENCE: tamperedMysqlEvidence,
        }),
      );
      const replayLease = join(directory, 'mysql-replay-lease.json');
      const replayLeaseResult = spawnSync(leaseHolder, [], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_RESTORE_ATTEMPT_ID: randomBytes(32).toString('hex'),
          DR_MYSQL_RESTORE_ARTIFACT_SHA256: createHash('sha256')
            .update(readFileSync(mysqlBackup))
            .digest('hex'),
          DR_MYSQL_RESTORE_TARGET_ID: 'real-mysql-target',
          DR_MYSQL_RESTORE_LEASE_FILE: replayLease,
        },
        encoding: 'utf8',
      });
      assert.notEqual(replayLeaseResult.status, 0);
      assert.match(replayLeaseResult.stderr, /Duplicate entry/u);
      assert.equal(existsSync(replayLease), false);

      mysqlExec(mysqlTarget, 'DROP DATABASE tixkit; CREATE DATABASE tixkit;');
      const cleanupNonce = randomBytes(32).toString('hex');
      const cleanupReceipt = join(directory, 'mysql-cleanup-provision-receipt.json');
      writeProvisionReceipt(cleanupReceipt, cleanupNonce);
      const failingMysqlVerifier = join(adapters, 'mysql-failing-verifier');
      executable(
        failingMysqlVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test "$(docker exec ${mysqlTarget} mysql --user=root --password=${mysqlPassword} --batch --skip-column-names tixkit --execute='SELECT payload FROM proof WHERE id=1;')" = real-mysql-round-trip
exit 42
`,
      );
      const failedMysqlEvidence = join(directory, 'evidence/mysql-failed.json');
      const failedMysqlRestore = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), [], {
        cwd: root,
        env: {
          ...env,
          DATABASE_URL_MYSQL: `mysql://root:${mysqlPassword}@mysql-target:3306/tixkit`,
          MYSQL_BACKUP_FILE: mysqlBackup,
          DR_ISOLATED_TARGET: '1',
          DR_PRODUCTION_BUNDLE: '1',
          MYSQL_TLS_MODE: 'VERIFY_IDENTITY',
          MYSQL_TLS_CA_FILE: ca,
          MYSQL_TOOL_DOCKER_NETWORK: network,
          DR_MYSQL_TARGET_SERVER_UUID: targetServerUuid,
          DR_MYSQL_TARGET_PROVISION_RECEIPT: cleanupReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: mysqlCleanup,
          DR_RESTORE_TARGET_ID: 'real-mysql-cleanup-target',
          DR_VERIFY_COMMAND: failingMysqlVerifier,
          DR_EVIDENCE_FILE: failedMysqlEvidence,
          DR_INCIDENT_AT: new Date().toISOString(),
        },
        encoding: 'utf8',
      });
      assert.notEqual(failedMysqlRestore.status, 0);
      assert.equal(mysqlExec(mysqlTarget, 'SHOW TABLES;'), '');
      assert.equal(mysqlExec(mysqlTarget, 'SELECT @@server_uuid;'), targetServerUuid);
      assert.equal(
        mysqlExec(
          mysqlTarget,
          `SELECT COUNT(*) FROM tixkit_restore_control.claims WHERE nonce='${cleanupNonce}';`,
        ),
        '1',
      );
      assert.equal(
        mysqlExec(
          mysqlTarget,
          `SELECT IS_USED_LOCK('tixkit-restore-${cleanupNonce.slice(0, 32)}');`,
        ),
        'NULL',
      );
      assert.equal(existsSync(failedMysqlEvidence), false);

      for (const [name, hostname] of [
        [minioSource, 'minio-source'],
        [minioTarget, 'minio-target'],
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
          '/data:rw,noexec,nosuid,size=128m',
          '-e',
          `MINIO_ROOT_USER=${minioUser}`,
          '-e',
          `MINIO_ROOT_PASSWORD=${minioPassword}`,
          '-v',
          `${certs}:/certs:ro`,
          minioImage,
          'server',
          '--certs-dir',
          `/certs/${hostname}`,
          '/data',
        ]);
        waitForContainer(name, [
          'curl',
          '--cacert',
          '/certs/ca.pem',
          '-fsS',
          `https://${hostname}:9000/minio/health/live`,
        ]);
      }
      const sourceObject = join(directory, 'event-poster.webp');
      writeFileSync(sourceObject, Buffer.from('real-minio-poster-content'));
      mcShell(
        network,
        `mc alias set source https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc mb source/tixkit-source && mc cp --attr 'Content-Type=image/webp;Cache-Control=public,max-age=3600;Content-Disposition=inline;Content-Encoding=identity;role=poster' /seed/event-poster.webp source/tixkit-source/event-poster.webp`,
        [
          { source: directory, target: '/seed' },
          { source: ca, target: '/root/.mc/certs/CAs/ca.crt' },
        ],
      );

      const sourcePolicy = join(directory, 'source-read-policy.json');
      const targetPolicy = join(directory, 'target-restore-policy.json');
      writeFileSync(
        sourcePolicy,
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:GetBucketLocation', 's3:ListBucket'],
              Resource: ['arn:aws:s3:::tixkit-source'],
            },
            {
              Effect: 'Allow',
              Action: ['s3:GetObject'],
              Resource: ['arn:aws:s3:::tixkit-source/*'],
            },
          ],
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        targetPolicy,
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['s3:*'],
              Resource: ['arn:aws:s3:::tixkit-*', 'arn:aws:s3:::tixkit-*/*'],
            },
          ],
        }),
        { mode: 0o600 },
      );
      docker([
        'run',
        '-d',
        '--name',
        minioBroker,
        '--network',
        network,
        '-v',
        `${ca}:/root/.mc/certs/CAs/ca.crt:ro`,
        '--entrypoint',
        '/bin/sh',
        mcImage,
        '-c',
        'sleep 600',
      ]);
      docker(['cp', sourcePolicy, `${minioBroker}:/tmp/source-policy.json`]);
      docker(['cp', targetPolicy, `${minioBroker}:/tmp/target-policy.json`]);
      const sourceParentAccess = `src${randomBytes(9).toString('hex')}`;
      const sourceParentSecret = randomBytes(24).toString('base64url');
      const targetParentAccess = `dst${randomBytes(9).toString('hex')}`;
      const targetParentSecret = randomBytes(24).toString('base64url');
      const sourceServiceAccess = `srvc${randomBytes(8).toString('hex')}`;
      const sourceServiceSecret = randomBytes(24).toString('base64url');
      const targetServiceAccess = `srvc${randomBytes(8).toString('hex')}`;
      const targetServiceSecret = randomBytes(24).toString('base64url');
      const serviceExpiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      for (const command of [
        `mc alias set source-admin https://minio-source:9000 ${minioUser} ${minioPassword}`,
        `mc alias set target-admin https://minio-target:9000 ${minioUser} ${minioPassword}`,
        'mc admin policy create source-admin tixkit-source-read /tmp/source-policy.json',
        'mc admin policy create target-admin tixkit-target-restore /tmp/target-policy.json',
        `mc admin user add source-admin ${sourceParentAccess} ${sourceParentSecret}`,
        `mc admin user add target-admin ${targetParentAccess} ${targetParentSecret}`,
        `mc admin policy attach source-admin tixkit-source-read --user ${sourceParentAccess}`,
        `mc admin policy attach target-admin tixkit-target-restore --user ${targetParentAccess}`,
        `mc admin user svcacct add source-admin ${sourceParentAccess} --access-key ${sourceServiceAccess} --secret-key ${sourceServiceSecret} --expiry ${serviceExpiry}`,
        `mc admin user svcacct add target-admin ${targetParentAccess} --access-key ${targetServiceAccess} --secret-key ${targetServiceSecret} --expiry ${serviceExpiry}`,
      ])
        docker(['exec', minioBroker, '/bin/sh', '-c', command], { timeout: 15_000 });
      const sourceCredential = join(directory, 'source-credential.env');
      const targetCredential = join(directory, 'target-credential.env');
      writeFileSync(
        sourceCredential,
        `MC_ACCESS_KEY=${sourceServiceAccess}\nMC_SECRET_KEY=${sourceServiceSecret}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        targetCredential,
        `MC_ACCESS_KEY=${targetServiceAccess}\nMC_SECRET_KEY=${targetServiceSecret}\n`,
        { mode: 0o600 },
      );
      docker(['cp', sourceCredential, `${minioBroker}:/tmp/source-credential.env`]);
      docker(['cp', targetCredential, `${minioBroker}:/tmp/target-credential.env`]);
      rmSync(sourceCredential);
      rmSync(targetCredential);
      mcShell(
        network,
        `mc alias set target https://minio-target:9000 ${minioUser} ${minioPassword} >/dev/null && mc mb target/sentinel && printf sentinel-unchanged >/tmp/sentinel && mc cp /tmp/sentinel target/sentinel/keep.txt`,
        [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
      );
      assert.throws(() =>
        mcShell(
          network,
          `mc alias set scoped https://minio-target:9000 ${targetServiceAccess} ${targetServiceSecret} >/dev/null && mc stat scoped/sentinel/keep.txt`,
          [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
        ),
      );
      assert.throws(() =>
        mcShell(
          network,
          `mc alias set plaintext http://minio-target:9000 ${targetServiceAccess} ${targetServiceSecret} >/dev/null && mc ls plaintext`,
        ),
      );
      assert.throws(() =>
        mcShell(
          network,
          `printf forbidden >/tmp/forbidden && mc alias set scoped https://minio-source:9000 ${sourceServiceAccess} ${sourceServiceSecret} >/dev/null && mc cp /tmp/forbidden scoped/tixkit-source/forbidden`,
          [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
        ),
      );

      const objectCredentials = join(adapters, 'object-credentials');
      const objectDownload = join(adapters, 'object-download');
      const objectMetadataExport = join(adapters, 'object-metadata-export');
      executable(
        objectCredentials,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
case "$MC_ENDPOINT" in
  https://minio-source:9000) credential=source-credential.env ;;
  https://minio-target:9000) credential=target-credential.env ;;
  *) echo 'Untrusted MinIO workload-identity audience' >&2; exit 1 ;;
esac
mkdir -p "$MC_CONFIG_DIR"
docker exec ${minioBroker} cat "/tmp/$credential" >"$MC_CONFIG_DIR/credentials.env"
chmod 0600 "$MC_CONFIG_DIR/credentials.env"
`,
      );
      executable(
        objectDownload,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer" --env MC_ACCESS_KEY --env MC_SECRET_KEY --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc mirror source/tixkit-source /transfer'
`,
      );
      executable(
        objectMetadataExport,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
stat_json="$(docker run --rm --network ${network} ${mcTlsMount} --env MC_ACCESS_KEY --env MC_SECRET_KEY --entrypoint /bin/sh ${mcImage} -c 'mc alias set source https://minio-source:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc stat --json source/tixkit-source/event-poster.webp')"
STAT_JSON="$stat_json" node - <<'NODE'
const {writeFileSync}=require('node:fs'); const stat=JSON.parse(process.env.STAT_JSON); const metadata=stat.metadata ?? {};
const find=(name)=>Object.entries(metadata).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1] ?? null;
const custom={}; for(const [key,value] of Object.entries(metadata)){ const match=/^x-amz-meta-(.+)$/i.exec(key); if(match) custom[match[1].toLowerCase()]=value; }
writeFileSync(process.env.DR_OBJECT_METADATA_FILE,JSON.stringify({objects:[{key:'event-poster.webp',contentType:find('content-type'),cacheControl:find('cache-control'),contentDisposition:find('content-disposition'),contentEncoding:find('content-encoding'),customMetadata:custom}]}),{flag:'wx',mode:0o600});
NODE
`,
      );
      const objectBackup = execFileSync(resolve(root, 'infra/scripts/backup-object-storage.sh'), {
        cwd: root,
        env: {
          ...env,
          DR_PRODUCTION_BUNDLE: '1',
          S3_ENDPOINT: 'https://minio-source:9000',
          S3_BUCKET: 'tixkit-source',
          S3_AUTH_MODE: 'workload-identity',
          S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
          S3_DOWNLOAD_COMMAND: objectDownload,
          DR_OBJECT_METADATA_EXPORT_COMMAND: objectMetadataExport,
          BACKUP_DIR: join(directory, 'object-backup'),
          BACKUP_TIMESTAMP: '20260713T180001Z',
        },
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .at(-1);
      assert.equal(existsSync(objectBackup), true);

      const objectUpload = join(adapters, 'object-upload');
      const objectOwnershipVerifier = join(adapters, 'object-ownership-verifier');
      const objectMetadataRestore = join(adapters, 'object-metadata-restore');
      const objectInventoryVerifier = join(adapters, 'object-inventory-verifier');
      const objectCleanup = join(adapters, 'object-cleanup');
      const objectAbsence = join(adapters, 'object-absence');
      const objectVerifier = join(adapters, 'object-verifier');
      executable(
        objectUpload,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer:ro" --env MC_ACCESS_KEY --env MC_SECRET_KEY --env DR_OBJECT_TRANSFER_BUCKET --env DR_OBJECT_RESTORE_RUN_ID --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc mb "destination/$DR_OBJECT_TRANSFER_BUCKET" && mc tag set "destination/$DR_OBJECT_TRANSFER_BUCKET" "tixkit-restore-run=$DR_OBJECT_RESTORE_RUN_ID" && mc cp /transfer/event-poster.webp "destination/$DR_OBJECT_TRANSFER_BUCKET/event-poster.webp"'
ENDPOINT="$S3_ENDPOINT" BUCKET="$DR_OBJECT_TRANSFER_BUCKET" RUN_ID="$DR_OBJECT_RESTORE_RUN_ID" node - <<'NODE'
const {writeFileSync}=require('node:fs'); writeFileSync(process.env.DR_OBJECT_BUCKET_OWNERSHIP_FILE,JSON.stringify({schemaVersion:1,endpoint:process.env.ENDPOINT,bucket:process.env.BUCKET,restoreRunId:process.env.RUN_ID,created:true}),{flag:'wx',mode:0o600});
NODE
`,
      );
      const ownershipCheck = `set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc tag list "destination/$RESTORE_S3_BUCKET"' | grep -F -- "$DR_OBJECT_RESTORE_RUN_ID"`;
      executable(
        objectOwnershipVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
${ownershipCheck}
`,
      );
      const statCheck = `set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc stat --json "destination/$RESTORE_S3_BUCKET/event-poster.webp"'`;
      executable(
        objectMetadataRestore,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
attributes="$(node - <<'NODE'
const {readFileSync}=require('node:fs'); const inventory=JSON.parse(readFileSync(process.env.DR_OBJECT_INVENTORY_FILE)); const object=inventory.objects.find(({key})=>key==='event-poster.webp'); if(!object) process.exit(1); const metadata=object.metadata;
const pairs=[['Content-Type',metadata.contentType],['Cache-Control',metadata.cacheControl],['Content-Disposition',metadata.contentDisposition],['Content-Encoding',metadata.contentEncoding],...Object.entries(metadata.customMetadata ?? {})];
for(const [,value] of pairs) if(value!=null && /[;\\r\\n]/u.test(value)) process.exit(1); process.stdout.write(pairs.filter(([,value])=>value!=null).map(([key,value])=>key+'='+value).join(';'));
NODE
)"
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} -v "$DR_OBJECT_TRANSFER_DIRECTORY:/transfer:ro" --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --env MC_ATTRIBUTES="$attributes" --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc cp --attr "$MC_ATTRIBUTES" /transfer/event-poster.webp "destination/$RESTORE_S3_BUCKET/event-poster.webp"' >/dev/null
`,
      );
      executable(
        objectInventoryVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
download="$(mktemp -d)"
cleanup() { rm -rf "$download"; }
trap cleanup EXIT
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} -v "$download:/download" --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc cp "destination/$RESTORE_S3_BUCKET/event-poster.webp" /download/event-poster.webp' >/dev/null
DOWNLOADED="$download/event-poster.webp" node - <<'NODE'
const {createHash}=require('node:crypto'); const {readFileSync}=require('node:fs');
const inventory=JSON.parse(readFileSync(process.env.DR_OBJECT_INVENTORY_FILE)); const object=inventory.objects.find(({key})=>key==='event-poster.webp'); const body=readFileSync(process.env.DOWNLOADED);
if(!object||object.sizeBytes!==body.length||object.sha256!==createHash('sha256').update(body).digest('hex')) process.exit(1);
NODE
printf '{"verified":true,"inventorySha256":"%s"}\n' "$DR_OBJECT_EXPECTED_INVENTORY_SHA256"
`,
      );
      executable(
        objectCleanup,
        `#!/usr/bin/env bash
set -euo pipefail
${ownershipCheck}
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
docker run --rm --network ${network} ${mcTlsMount} --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc rb --force "destination/$RESTORE_S3_BUCKET"'
`,
      );
      executable(
        objectAbsence,
        `#!/usr/bin/env bash
set -euo pipefail
set -a; source "$MC_CONFIG_DIR/credentials.env"; set +a
! docker run --rm --network ${network} ${mcTlsMount} --env MC_ACCESS_KEY --env MC_SECRET_KEY --env RESTORE_S3_BUCKET --entrypoint /bin/sh ${mcImage} -c 'mc alias set destination https://minio-target:9000 "$MC_ACCESS_KEY" "$MC_SECRET_KEY" >/dev/null && mc stat "destination/$RESTORE_S3_BUCKET"' >/dev/null 2>&1
`,
      );
      executable(
        objectVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
stat_json="$(${statCheck})"
STAT_JSON="$stat_json" node - <<'NODE'
const stat=JSON.parse(process.env.STAT_JSON); const metadata=stat.metadata ?? {}; const find=(name)=>Object.entries(metadata).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1] ?? null;
if(stat.size!==25||find('content-type')!=='image/webp'||find('cache-control')!=='public,max-age=3600'||find('content-disposition')!=='inline'||find('content-encoding')!=='identity'||find('x-amz-meta-role')!=='poster') throw new Error('Restored metadata mismatch: '+JSON.stringify({size:stat.size,metadata}));
const custom=Object.keys(metadata).filter((key)=>/^x-amz-meta-/iu.test(key)); if(custom.length!==1) throw new Error('Unexpected custom metadata: '+JSON.stringify(custom));
NODE
`,
      );
      const objectEvidence = join(directory, 'evidence/object-storage.json');
      const objectRestore = spawnSync(
        resolve(root, 'infra/scripts/restore-object-storage.sh'),
        [],
        {
          cwd: root,
          env: {
            ...env,
            DR_PRODUCTION_BUNDLE: '1',
            S3_ENDPOINT: 'https://minio-target:9000',
            S3_BUCKET: 'tixkit-source',
            RESTORE_S3_BUCKET: 'tixkit-restored',
            S3_AUTH_MODE: 'workload-identity',
            S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
            S3_UPLOAD_COMMAND: objectUpload,
            DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND: objectOwnershipVerifier,
            DR_OBJECT_METADATA_RESTORE_COMMAND: objectMetadataRestore,
            DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectInventoryVerifier,
            DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
            DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
            DR_OBJECT_VERIFY_COMMAND: objectVerifier,
            DR_VERIFY_COMMAND: objectVerifier,
            OBJECT_STORAGE_BACKUP_FILE: objectBackup,
            DR_ISOLATED_TARGET: '1',
            DR_RESTORE_TARGET_ID: 'real-minio-target',
            DR_EVIDENCE_FILE: objectEvidence,
            DR_INCIDENT_AT: new Date().toISOString(),
          },
          encoding: 'utf8',
        },
      );
      assert.equal(
        objectRestore.status,
        0,
        `Object restore failed\nstdout:\n${objectRestore.stdout}\nstderr:\n${objectRestore.stderr}`,
      );
      const restoredObject = join(directory, 'restored-event-poster.webp');
      mcShell(
        network,
        `mc alias set destination https://minio-target:9000 ${minioUser} ${minioPassword} >/dev/null && mc cp destination/tixkit-restored/event-poster.webp /verify/restored-event-poster.webp`,
        [
          { source: directory, target: '/verify' },
          { source: ca, target: '/root/.mc/certs/CAs/ca.crt' },
        ],
      );
      assert.equal(readFileSync(restoredObject, 'utf8'), 'real-minio-poster-content');
      assert.equal(
        JSON.parse(readFileSync(objectEvidence, 'utf8')).verification,
        'command-completed',
      );
      verifyArtifactAndEvidence(env, objectBackup, 'object-storage', objectEvidence);
      for (const path of [
        objectBackup,
        `${objectBackup}.sha256`,
        `${objectBackup}.manifest.json`,
        objectEvidence,
      ])
        assertPrivateFile(path);
      const objectEvidenceText = readFileSync(objectEvidence, 'utf8');
      for (const secret of [
        minioPassword,
        sourceServiceAccess,
        sourceServiceSecret,
        targetServiceAccess,
        targetServiceSecret,
        manifestKey,
      ])
        assert.equal(objectEvidenceText.includes(secret), false);
      const objectTamperDirectory = join(directory, 'object-tamper');
      mkdirSync(objectTamperDirectory);
      const objectTampered = join(objectTamperDirectory, objectBackup.split('/').at(-1));
      for (const suffix of ['', '.sha256', '.manifest.json'])
        copyFileSync(`${objectBackup}${suffix}`, `${objectTampered}${suffix}`);
      writeFileSync(objectTampered, 'tamper', { flag: 'a' });
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_checksum "$ARTIFACT"', { ARTIFACT: objectTampered }),
      );
      copyFileSync(objectBackup, objectTampered);
      const objectManifest = JSON.parse(readFileSync(`${objectTampered}.manifest.json`, 'utf8'));
      objectManifest.signature.value = '0'.repeat(64);
      writeFileSync(`${objectTampered}.manifest.json`, JSON.stringify(objectManifest));
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_backup_manifest "$ARTIFACT" object-storage', {
          ARTIFACT: objectTampered,
        }),
      );
      const tamperedObjectEvidence = join(directory, 'object-evidence-tampered.json');
      const tamperedObjectEvidencePayload = JSON.parse(objectEvidenceText);
      tamperedObjectEvidencePayload.signature.value = '0'.repeat(64);
      writeFileSync(tamperedObjectEvidence, JSON.stringify(tamperedObjectEvidencePayload), {
        mode: 0o600,
      });
      assert.throws(() =>
        runDrCheck(env, 'dr_verify_restore_evidence "$EVIDENCE" object-storage', {
          EVIDENCE: tamperedObjectEvidence,
        }),
      );
      const replayEvidence = join(directory, 'evidence/object-storage-replay.json');
      const replayRestore = spawnSync(
        resolve(root, 'infra/scripts/restore-object-storage.sh'),
        [],
        {
          cwd: root,
          env: {
            ...env,
            DR_PRODUCTION_BUNDLE: '1',
            S3_ENDPOINT: 'https://minio-target:9000',
            S3_BUCKET: 'tixkit-source',
            RESTORE_S3_BUCKET: 'tixkit-restored',
            S3_AUTH_MODE: 'workload-identity',
            S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
            S3_UPLOAD_COMMAND: objectUpload,
            DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND: objectOwnershipVerifier,
            DR_OBJECT_METADATA_RESTORE_COMMAND: objectMetadataRestore,
            DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectInventoryVerifier,
            DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
            DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
            DR_OBJECT_VERIFY_COMMAND: objectVerifier,
            DR_VERIFY_COMMAND: objectVerifier,
            OBJECT_STORAGE_BACKUP_FILE: objectBackup,
            DR_ISOLATED_TARGET: '1',
            DR_RESTORE_TARGET_ID: 'real-minio-target-replay',
            DR_EVIDENCE_FILE: replayEvidence,
            DR_INCIDENT_AT: new Date().toISOString(),
          },
          encoding: 'utf8',
        },
      );
      assert.notEqual(replayRestore.status, 0);
      assert.match(replayRestore.stderr, /already (?:exists|own it)/u);
      assert.equal(readFileSync(restoredObject, 'utf8'), 'real-minio-poster-content');
      assert.equal(existsSync(replayEvidence), false);

      const mutatingMetadataRestore = join(adapters, 'object-mutating-metadata-restore');
      executable(
        mutatingMetadataRestore,
        `#!/usr/bin/env bash
set -euo pipefail
${statCheck}
printf ' ' >>"$DR_OBJECT_INVENTORY_FILE"
`,
      );
      const failedObjectEvidence = join(directory, 'evidence/object-storage-failed.json');
      const failedObjectRestore = spawnSync(
        resolve(root, 'infra/scripts/restore-object-storage.sh'),
        [],
        {
          cwd: root,
          env: {
            ...env,
            DR_PRODUCTION_BUNDLE: '1',
            S3_ENDPOINT: 'https://minio-target:9000',
            S3_BUCKET: 'tixkit-source',
            RESTORE_S3_BUCKET: 'tixkit-failed',
            S3_AUTH_MODE: 'workload-identity',
            S3_CREDENTIAL_SETUP_COMMAND: objectCredentials,
            S3_UPLOAD_COMMAND: objectUpload,
            DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND: objectOwnershipVerifier,
            DR_OBJECT_METADATA_RESTORE_COMMAND: mutatingMetadataRestore,
            DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectInventoryVerifier,
            DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
            DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
            DR_OBJECT_VERIFY_COMMAND: objectVerifier,
            DR_VERIFY_COMMAND: objectVerifier,
            OBJECT_STORAGE_BACKUP_FILE: objectBackup,
            DR_ISOLATED_TARGET: '1',
            DR_RESTORE_TARGET_ID: 'real-minio-failure-target',
            DR_EVIDENCE_FILE: failedObjectEvidence,
            DR_INCIDENT_AT: new Date().toISOString(),
          },
          encoding: 'utf8',
        },
      );
      assert.notEqual(failedObjectRestore.status, 0);
      assert.match(failedObjectRestore.stderr, /Artifact identity changed/u);
      assert.equal(existsSync(failedObjectEvidence), false);
      assert.throws(() =>
        mcShell(
          network,
          `mc alias set target https://minio-target:9000 ${minioUser} ${minioPassword} >/dev/null && mc stat target/tixkit-failed`,
          [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
        ),
      );
      assert.equal(
        mcShell(
          network,
          `mc alias set source https://minio-source:9000 ${minioUser} ${minioPassword} >/dev/null && mc cat source/tixkit-source/event-poster.webp`,
          [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
        ),
        'real-minio-poster-content',
      );
      assert.equal(
        mcShell(
          network,
          `mc alias set target https://minio-target:9000 ${minioUser} ${minioPassword} >/dev/null && mc cat target/sentinel/keep.txt`,
          [{ source: ca, target: '/root/.mc/certs/CAs/ca.crt' }],
        ),
        'sentinel-unchanged',
      );
    } finally {
      for (const container of containers)
        spawnSync('docker', ['rm', '-f', container], { cwd: root, stdio: 'ignore' });
      spawnSync('docker', ['network', 'rm', network], { cwd: root, stdio: 'ignore' });
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
