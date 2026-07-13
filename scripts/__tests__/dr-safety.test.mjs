import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const common = resolve(root, 'infra/scripts/lib/dr-common.sh');

function environment(directory) {
  return {
    ...process.env,
    DR_MANIFEST_SIGNING_KEY: 'test-signing-key-not-for-production',
    DR_MANIFEST_KEY_ID: 'test-key-1',
    DR_SOURCE_RELEASE: 'test-release@sha256:abc',
    DR_BACKUP_ENCRYPTION: 'test-kms-key',
    DR_BACKUP_DESTINATION_CLASS: 'independent',
    TEST_DIRECTORY: directory,
  };
}

function signArtifact(artifact, kind, env) {
  execFileSync(
    'bash',
    [
      '-c',
      `source "$DR_COMMON"; dr_write_checksum "$ARTIFACT"; dr_write_backup_manifest "$ARTIFACT" "$KIND" 2026-07-12T00:00:00Z`,
    ],
    { cwd: root, env: { ...env, DR_COMMON: common, ARTIFACT: artifact, KIND: kind } },
  );
}

function runShell(command, env) {
  return new Promise((resolveRun) => {
    const child = spawn('bash', ['-c', command], { cwd: root, env });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolveRun({ code, stderr }));
  });
}

function productionBackupTest(name, fn) {
  test(name, { timeout: 30_000 }, fn);
}

const productionBackupTestName =
  'production backup quiesces once and binds database, objects, and Temporal to one recovery point';

test('signed backup manifests bind artifact integrity and durability metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-manifest-'));
  const artifact = join(directory, 'backup.dump');
  const env = environment(directory);
  try {
    writeFileSync(artifact, 'database-backup');
    signArtifact(artifact, 'postgres', env);
    execFileSync(
      'bash',
      [
        '-c',
        `source "$DR_COMMON"; dr_verify_checksum "$ARTIFACT"; dr_verify_backup_manifest "$ARTIFACT" postgres`,
      ],
      { cwd: root, env: { ...env, DR_COMMON: common, ARTIFACT: artifact } },
    );
    const manifest = JSON.parse(readFileSync(`${artifact}.manifest.json`, 'utf8'));
    assert.equal(manifest.destinationClass, 'independent');
    assert.equal(manifest.signature.algorithm, 'hmac-sha256');

    manifest.sourceRelease = 'tampered-release';
    writeFileSync(`${artifact}.manifest.json`, JSON.stringify(manifest));
    const result = spawnSync(
      'bash',
      ['-c', `source "$DR_COMMON"; dr_verify_backup_manifest "$ARTIFACT" postgres`],
      { cwd: root, env: { ...env, DR_COMMON: common, ARTIFACT: artifact }, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /signature mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backup publication is exclusive, symlink-safe, and mode 0600', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-publication-'));
  const output = join(directory, 'backup.dump');
  const first = join(directory, '.first');
  const second = join(directory, '.second');
  const env = { ...process.env, DR_COMMON: common, OUTPUT: output };
  try {
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    const command = 'source "$DR_COMMON"; dr_publish_staged_file "$STAGED" "$OUTPUT"';
    const results = await Promise.all([
      runShell(command, { ...env, STAGED: first }),
      runShell(command, { ...env, STAGED: second }),
    ]);
    assert.deepEqual(results.map(({ code }) => code).sort(), [0, 1]);
    assert.match(readFileSync(output, 'utf8'), /^(first|second)$/u);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const identity = execFileSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_file_identity "$OUTPUT"'],
      { cwd: root, env, encoding: 'utf8' },
    );
    rmSync(output);
    writeFileSync(output, 'substituted');
    const substituted = spawnSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_assert_file_identity "$OUTPUT" "$IDENTITY"'],
      { cwd: root, env: { ...env, IDENTITY: identity }, encoding: 'utf8' },
    );
    assert.notEqual(substituted.status, 0);
    assert.match(substituted.stderr, /Artifact identity changed/u);

    const unsafeDirectory = join(directory, 'unsafe-output');
    mkdirSync(unsafeDirectory);
    chmodSync(unsafeDirectory, 0o777);
    const unsafe = spawnSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_prepare_output_directory "$UNSAFE_DIRECTORY"'],
      {
        cwd: root,
        env: { ...env, UNSAFE_DIRECTORY: unsafeDirectory },
        encoding: 'utf8',
      },
    );
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /caller-owned and mode 0700 or stricter/u);

    const target = join(directory, 'target');
    const linkedOutput = join(directory, 'linked.dump');
    writeFileSync(target, 'sentinel');
    symlinkSync(target, linkedOutput);
    const linked = spawnSync('bash', ['-c', command], {
      cwd: root,
      env: { ...env, OUTPUT: linkedOutput, STAGED: existsSync(first) ? first : second },
      encoding: 'utf8',
    });
    assert.notEqual(linked.status, 0);
    assert.equal(readFileSync(target, 'utf8'), 'sentinel');

    const artifact = join(directory, 'sidecar-source');
    const sidecarTarget = join(directory, 'sidecar-target');
    writeFileSync(artifact, 'artifact');
    writeFileSync(sidecarTarget, 'sentinel');
    symlinkSync(sidecarTarget, `${artifact}.sha256`);
    const sidecar = spawnSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_write_checksum "$ARTIFACT"'],
      {
        cwd: root,
        env: { ...env, ARTIFACT: artifact },
        encoding: 'utf8',
      },
    );
    assert.notEqual(sidecar.status, 0);
    assert.equal(readFileSync(sidecarTarget, 'utf8'), 'sentinel');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restore evidence exclusively binds the verifier content that executed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-evidence-'));
  const artifact = join(directory, 'backup.dump');
  const verifier = join(directory, 'verify');
  const evidence = join(directory, 'evidence/restore.json');
  const env = {
    ...environment(directory),
    ARTIFACT: artifact,
    DR_COMMON: common,
    DR_EVIDENCE_FILE: evidence,
    DR_INCIDENT_AT: '2026-07-12T00:00:01Z',
    DR_RESTORE_TARGET_ID: 'isolated-target',
    DR_TARGET_RELEASE: 'v1.1.0',
    DR_VERIFY_COMMAND: verifier,
  };
  const command =
    'source "$DR_COMMON"; dr_reserve_restore_evidence; dr_run_restore_verifier postgres; dr_record_restore_evidence "$ARTIFACT" postgres "$(date +%s)"';
  try {
    writeFileSync(artifact, 'database-backup');
    signArtifact(artifact, 'postgres', env);
    writeFileSync(
      verifier,
      `#!/usr/bin/env bash
set -euo pipefail
test "\${DR_RESTORE_KIND:-}" = postgres
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${DATABASE_URL:-}"
test -z "\${DATABASE_URL_MYSQL:-}"
test -z "\${S3_ACCESS_KEY_ID:-}"
test -z "\${S3_SECRET_ACCESS_KEY:-}"
`,
    );
    chmodSync(verifier, 0o755);
    execFileSync('bash', ['-c', command], { cwd: root, env });
    const original = readFileSync(evidence, 'utf8');
    assert.match(JSON.parse(original).verifierSha256, /^[a-f0-9]{64}$/u);

    const replay = spawnSync('bash', ['-c', command], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(replay.status, 0);
    assert.match(replay.stderr, /Refusing existing DR evidence path/u);
    assert.equal(readFileSync(evidence, 'utf8'), original);

    const symlinkEvidence = join(directory, 'evidence/linked.json');
    const symlinkTarget = join(directory, 'symlink-target');
    writeFileSync(symlinkTarget, 'sentinel');
    symlinkSync(symlinkTarget, symlinkEvidence);
    const linked = spawnSync('bash', ['-c', command], {
      cwd: root,
      env: { ...env, DR_EVIDENCE_FILE: symlinkEvidence },
      encoding: 'utf8',
    });
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /Refusing existing DR evidence path/u);
    assert.equal(readFileSync(symlinkTarget, 'utf8'), 'sentinel');

    const mutatingVerifier = join(directory, 'mutating-verifier');
    writeFileSync(
      mutatingVerifier,
      '#!/usr/bin/env bash\nprintf "#!/usr/bin/env bash\\nexit 0\\n" >"$0"\n',
    );
    chmodSync(mutatingVerifier, 0o755);
    const mutationEvidence = join(directory, 'evidence/mutation.json');
    const mutation = spawnSync('bash', ['-c', command], {
      cwd: root,
      env: {
        ...env,
        DR_EVIDENCE_FILE: mutationEvidence,
        DR_VERIFY_COMMAND: mutatingVerifier,
      },
      encoding: 'utf8',
    });
    assert.notEqual(mutation.status, 0);
    assert.match(mutation.stderr, /Restore verifier changed during execution/u);
    assert.equal(existsSync(mutationEvidence), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Postgres restore rejects missing integrity evidence and non-empty targets before mutation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-postgres-'));
  const artifact = join(directory, 'backup.dump');
  const bin = join(directory, 'bin');
  const env = environment(directory);
  try {
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(artifact, 'database-backup');
    let result = spawnSync(resolve(root, 'infra/scripts/restore-postgres.sh'), {
      cwd: root,
      env: {
        ...env,
        DATABASE_URL: 'postgres://restore.example/tixkit_staging',
        POSTGRES_BACKUP_FILE: artifact,
        DR_ISOLATED_TARGET: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Required checksum is missing/);

    signArtifact(artifact, 'postgres', env);
    for (const [name, body] of [
      ['pg_restore', '#!/usr/bin/env bash\nexit 0\n'],
      ['psql', '#!/usr/bin/env bash\nprintf 1\\n\n'],
    ]) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    result = spawnSync(resolve(root, 'infra/scripts/restore-postgres.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        DATABASE_URL: 'postgres://restore.example/tixkit_staging',
        POSTGRES_BACKUP_FILE: artifact,
        DR_ISOLATED_TARGET: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not empty; refusing in-place restore/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('object restore rejects traversal archives before creating a destination bucket', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-object-'));
  const artifact = join(directory, 'objects.tar.gz');
  const escape = join(directory, 'escape.txt');
  const env = environment(directory);
  try {
    execFileSync('python3', [
      '-c',
      `import io,tarfile; t=tarfile.open(${JSON.stringify(artifact)},'w:gz'); i=tarfile.TarInfo('../escape.txt'); b=b'owned'; i.size=len(b); t.addfile(i,io.BytesIO(b)); t.close()`,
    ]);
    signArtifact(artifact, 'object-storage', env);
    const result = spawnSync(resolve(root, 'infra/scripts/restore-object-storage.sh'), {
      cwd: root,
      env: {
        ...env,
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'source',
        RESTORE_S3_BUCKET: 'restore-staging',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        OBJECT_STORAGE_BACKUP_FILE: artifact,
        DR_ISOLATED_TARGET: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe or duplicate archive path/);
    assert.equal(existsSync(escape), false);

    const normalized = join(directory, 'normalized.tar.gz');
    execFileSync('python3', [
      '-c',
      `import io,tarfile; t=tarfile.open(${JSON.stringify(normalized)},'w:gz'); d=tarfile.TarInfo('tixkit'); d.type=tarfile.DIRTYPE; t.addfile(d); b=b'one'; a=tarfile.TarInfo('tixkit/item'); a.size=len(b); t.addfile(a,io.BytesIO(b)); c=tarfile.TarInfo('tixkit//item'); c.size=len(b); t.addfile(c,io.BytesIO(b)); t.close()`,
    ]);
    signArtifact(normalized, 'object-storage', env);
    const normalizedResult = spawnSync(resolve(root, 'infra/scripts/restore-object-storage.sh'), {
      cwd: root,
      env: {
        ...env,
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'tixkit',
        RESTORE_S3_BUCKET: 'restore-staging',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        OBJECT_STORAGE_BACKUP_FILE: normalized,
        DR_ISOLATED_TARGET: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(normalizedResult.status, 0);
    assert.match(normalizedResult.stderr, /Unsafe or duplicate archive path/);

    const boundedResult = spawnSync(resolve(root, 'infra/scripts/restore-object-storage.sh'), {
      cwd: root,
      env: {
        ...env,
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'tixkit',
        RESTORE_S3_BUCKET: 'restore-staging',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        OBJECT_STORAGE_BACKUP_FILE: normalized,
        OBJECT_RESTORE_MAX_MEMBERS: '1',
        DR_ISOLATED_TARGET: '1',
      },
      encoding: 'utf8',
    });
    assert.notEqual(boundedResult.status, 0);
    assert.match(boundedResult.stderr, /exceeds OBJECT_RESTORE_MAX_MEMBERS/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('object backup supports a workload-identity credential adapter without static keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-workload-identity-'));
  const bin = join(directory, 'bin');
  const setup = join(directory, 'setup-identity');
  const env = environment(directory);
  try {
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(setup, '#!/usr/bin/env bash\ntest "$MC_ALIAS_NAME" = tixkit-backup\n');
    writeFileSync(
      join(bin, 'mc'),
      `#!/usr/bin/env bash
if [[ "\${1:-}" == mirror ]]; then destination="\${@: -1}"; mkdir -p "$destination"; printf object >"$destination/item"; fi
`,
    );
    chmodSync(setup, 0o755);
    chmodSync(join(bin, 'mc'), 0o755);
    const invalidBucket = spawnSync(resolve(root, 'infra/scripts/backup-object-storage.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: '../escaped',
        S3_AUTH_MODE: 'workload-identity',
        S3_CREDENTIAL_SETUP_COMMAND: setup,
        BACKUP_DIR: join(directory, 'invalid-backup'),
      },
      encoding: 'utf8',
    });
    assert.notEqual(invalidBucket.status, 0);
    assert.match(invalidBucket.stderr, /Invalid S3 bucket name/u);
    const artifact = execFileSync(resolve(root, 'infra/scripts/backup-object-storage.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'tixkit',
        S3_AUTH_MODE: 'workload-identity',
        S3_CREDENTIAL_SETUP_COMMAND: setup,
        BACKUP_DIR: join(directory, 'backup'),
      },
      encoding: 'utf8',
    }).trim();
    assert.equal(existsSync(artifact), true);
    assert.equal(existsSync(`${artifact}.manifest.json`), true);
    const extracted = join(directory, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', artifact, '-C', extracted]);
    const inventory = join(extracted, 'object-inventory.json');
    const archivedObject = join(extracted, 'tixkit/item');
    writeFileSync(archivedObject, 'tamper');
    const corrupted = spawnSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_verify_object_inventory "$OBJECT_ROOT" tixkit "$INVENTORY"'],
      {
        cwd: root,
        env: {
          ...env,
          DR_COMMON: common,
          INVENTORY: inventory,
          OBJECT_ROOT: join(extracted, 'tixkit'),
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(corrupted.status, 0);
    assert.match(corrupted.stderr, /Object inventory does not match archived content/u);
    writeFileSync(archivedObject, 'object');
    const forgedInventory = JSON.parse(readFileSync(inventory, 'utf8'));
    forgedInventory.objects[0].metadata.contentType = 'text/html';
    writeFileSync(inventory, JSON.stringify(forgedInventory));
    const forged = spawnSync(
      'bash',
      ['-c', 'source "$DR_COMMON"; dr_verify_object_inventory "$OBJECT_ROOT" tixkit "$INVENTORY"'],
      {
        cwd: root,
        env: {
          ...env,
          DR_COMMON: common,
          INVENTORY: inventory,
          OBJECT_ROOT: join(extracted, 'tixkit'),
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(forged.status, 0);
    assert.match(forged.stderr, /Object inventory signature mismatch/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'Production MySQL binds verified TLS and cleans a failed isolated import',
  { timeout: 45_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-mysql-production-'));
    const bin = join(directory, 'bin');
    const calls = join(directory, 'mysql-calls.log');
    const targetState = join(directory, 'target-state');
    const cleanupLog = join(directory, 'cleanup.log');
    const ca = join(directory, 'ca.pem');
    const cleanup = join(directory, 'cleanup');
    const verifier = join(directory, 'verify');
    const provisionReceipt = join(directory, 'mysql-provision-receipt.json');
    const leaseHolder = join(directory, 'hold-mysql-restore-lease');
    const leaseVerifier = join(directory, 'verify-mysql-restore-lease');
    const leaseRegistry = join(directory, 'lease-registry');
    const forceLeaseExpiry = join(directory, 'force-lease-expiry');
    const forceLeaseExit = join(directory, 'force-lease-exit');
    const forceWrongLeaseNonce = join(directory, 'force-wrong-lease-nonce');
    const env = environment(directory);
    try {
      mkdirSync(bin);
      writeFileSync(ca, 'test-ca');
      writeFileSync(
        join(bin, 'mysql'),
        `#!/usr/bin/env bash
set -euo pipefail
printf 'mysql:%s\n' "$*" >>${JSON.stringify(calls)}
if [[ "$*" == *'select @@server_uuid;'* ]]; then
  printf 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n'
elif [[ "$*" == *'select count('* ]]; then
  test -f ${JSON.stringify(targetState)} && cat ${JSON.stringify(targetState)} || printf '0\n'
elif [[ "\${MOCK_IMPORT_FAIL:-0}" == 1 ]]; then
  cat >/dev/null
  printf '1\n' >${JSON.stringify(targetState)}
  exit 23
else
  printf 'import\n' >>${JSON.stringify(calls)}
  if test -n "\${MOCK_FORCE_LEASE_EXIT_FILE:-}"; then
    printf '1\n' >${JSON.stringify(targetState)}
    printf exit >"$MOCK_FORCE_LEASE_EXIT_FILE"
  fi
  test -z "\${MOCK_FORCE_LEASE_EXPIRY_FILE:-}" || printf expired >"$MOCK_FORCE_LEASE_EXPIRY_FILE"
  test -z "\${MOCK_IMPORT_DELAY_SECONDS:-}" || sleep "$MOCK_IMPORT_DELAY_SECONDS"
  cat >/dev/null
  printf '1\n' >${JSON.stringify(targetState)}
fi
`,
      );
      writeFileSync(
        join(bin, 'mysqldump'),
        `#!/usr/bin/env bash
printf 'mysqldump:%s\n' "$*" >>${JSON.stringify(calls)}
printf 'CREATE TABLE proof (value VARBINARY(16));\n'
`,
      );
      writeFileSync(
        cleanup,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
printf '0\n' >${JSON.stringify(targetState)}
printf '%s\n' "\${DATABASE_URL_MYSQL:-}" >${JSON.stringify(cleanupLog)}
`,
      );
      writeFileSync(verifier, '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        leaseHolder,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
exec node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto');
const {existsSync,mkdirSync,readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const receipt=JSON.parse(readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT));
const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256','test-provider-key').update(JSON.stringify(payload)).digest();
const actual=Buffer.from(providerSignature ?? '', 'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
mkdirSync(${JSON.stringify(leaseRegistry)}, {recursive:true});
const claim=join(${JSON.stringify(leaseRegistry)}, receipt.provisioningNonce);
try { writeFileSync(claim, process.env.DR_MYSQL_RESTORE_ATTEMPT_ID, {flag:'wx'}); }
catch (error) { if(error.code!=='EEXIST'||readFileSync(claim,'utf8')!==process.env.DR_MYSQL_RESTORE_ATTEMPT_ID) process.exit(31); }
const leaseNonce=existsSync(${JSON.stringify(forceWrongLeaseNonce)})?'9'.repeat(64):receipt.provisioningNonce;
const lease={schemaVersion:1,attemptId:process.env.DR_MYSQL_RESTORE_ATTEMPT_ID,artifactSha256:process.env.DR_MYSQL_RESTORE_ARTIFACT_SHA256,restoreTargetId:process.env.DR_MYSQL_RESTORE_TARGET_ID,serverUuid:receipt.serverUuid,database:receipt.database,provisioningNonce:leaseNonce,holderPid:process.pid,active:true,renewable:true,expiresAt:new Date(Date.now()+15*60*1000).toISOString()};
writeFileSync(process.env.DR_MYSQL_RESTORE_LEASE_FILE,JSON.stringify(lease),{flag:'wx',mode:0o600});
const timer=setInterval(()=>{ if(existsSync(${JSON.stringify(forceLeaseExit)})) process.exit(42); },20);
process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
NODE
`,
      );
      writeFileSync(
        leaseVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto');
const {existsSync,readFileSync}=require('node:fs');
const {join}=require('node:path');
const receipt=JSON.parse(readFileSync(process.env.DR_MYSQL_TARGET_PROVISION_RECEIPT));
const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256','test-provider-key').update(JSON.stringify(payload)).digest();
const actual=Buffer.from(providerSignature ?? '', 'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
const claim=join(${JSON.stringify(leaseRegistry)},receipt.provisioningNonce);
if(readFileSync(claim,'utf8')!==process.env.DR_MYSQL_RESTORE_ATTEMPT_ID) process.exit(32);
const lease=JSON.parse(readFileSync(process.env.DR_MYSQL_RESTORE_LEASE_FILE));
if(existsSync(${JSON.stringify(forceLeaseExpiry)})) lease.expiresAt=new Date(Date.now()-1000).toISOString();
process.stdout.write(JSON.stringify(lease));
NODE
`,
      );
      for (const file of [
        join(bin, 'mysql'),
        join(bin, 'mysqldump'),
        cleanup,
        verifier,
        leaseHolder,
        leaseVerifier,
      ])
        chmodSync(file, 0o755);

      const writeProvisionReceipt = (serverUuid, nonceCharacter = 'a') => {
        const createdAt = new Date();
        const payload = {
          schemaVersion: 1,
          serverUuid,
          database: 'tixkit',
          provisioningNonce: nonceCharacter.repeat(64),
          exclusive: true,
          empty: true,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1000).toISOString(),
        };
        const providerSignature = createHmac('sha256', 'test-provider-key')
          .update(JSON.stringify(payload))
          .digest('hex');
        writeFileSync(provisionReceipt, JSON.stringify({ ...payload, providerSignature }));
      };

      const backupEnv = {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        DATABASE_URL_MYSQL: 'mysql://tixkit:secret@mysql.example:3306/tixkit',
        DR_PRODUCTION_BUNDLE: '1',
        MYSQL_TLS_MODE: 'VERIFY_IDENTITY',
        MYSQL_TLS_CA_FILE: ca,
        BACKUP_DIR: join(directory, 'backup'),
        BACKUP_TIMESTAMP: '20260713T000000Z',
        TIXKIT_TEST_SECRET: 'must-not-reach-hooks',
      };
      const backup = execFileSync(resolve(root, 'infra/scripts/backup-mysql.sh'), {
        cwd: root,
        env: backupEnv,
        encoding: 'utf8',
      }).trim();
      assert.equal(existsSync(backup), true);
      const callLog = readFileSync(calls, 'utf8');
      assert.match(callLog, /--ssl-mode=VERIFY_IDENTITY/u);
      assert.match(callLog, new RegExp(`--ssl-ca=${ca.replaceAll('/', '\\/')}`, 'u'));

      const weakTls = spawnSync(resolve(root, 'infra/scripts/backup-mysql.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          BACKUP_TIMESTAMP: '20260713T000001Z',
          MYSQL_TLS_MODE: 'REQUIRED',
        },
        encoding: 'utf8',
      });
      assert.notEqual(weakTls.status, 0);
      assert.match(weakTls.stderr, /requires MYSQL_TLS_MODE=VERIFY_IDENTITY/u);

      writeProvisionReceipt('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');
      const replayedTarget = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          MOCK_IMPORT_FAIL: '1',
          MYSQL_BACKUP_FILE: backup,
          DR_ISOLATED_TARGET: '1',
          DR_MYSQL_TARGET_SERVER_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: cleanup,
          DR_RESTORE_TARGET_ID: 'mysql-isolated-target',
          DR_VERIFY_COMMAND: verifier,
        },
        encoding: 'utf8',
      });
      assert.notEqual(replayedTarget.status, 0);
      assert.match(replayedTarget.stderr, /provisioning receipt server UUID mismatch/u);
      assert.equal(existsSync(targetState), false);

      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'f');
      writeFileSync(forceWrongLeaseNonce, 'wrong');
      const mismatchedLeaseNonce = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          MYSQL_BACKUP_FILE: backup,
          DR_ISOLATED_TARGET: '1',
          DR_MYSQL_TARGET_SERVER_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: cleanup,
          DR_RESTORE_TARGET_ID: 'mysql-isolated-target',
          DR_VERIFY_COMMAND: verifier,
        },
        encoding: 'utf8',
      });
      assert.notEqual(mismatchedLeaseNonce.status, 0);
      assert.match(mismatchedLeaseNonce.stderr, /lease provisioning nonce mismatch/u);
      assert.equal(existsSync(targetState), false);
      rmSync(forceWrongLeaseNonce, { force: true });

      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const restore = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          MOCK_IMPORT_FAIL: '1',
          MYSQL_BACKUP_FILE: backup,
          DR_ISOLATED_TARGET: '1',
          DR_MYSQL_TARGET_SERVER_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: cleanup,
          DR_RESTORE_TARGET_ID: 'mysql-isolated-target',
          DR_VERIFY_COMMAND: verifier,
        },
        encoding: 'utf8',
      });
      assert.notEqual(restore.status, 0);
      assert.equal(
        readFileSync(cleanupLog, 'utf8').trim(),
        'mysql://tixkit:secret@mysql.example:3306/tixkit',
      );
      assert.equal(readFileSync(targetState, 'utf8').trim(), '0');

      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'b');
      const noOpCleanup = join(directory, 'no-op-cleanup');
      writeFileSync(noOpCleanup, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(noOpCleanup, 0o755);
      const uncleaned = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          MOCK_IMPORT_FAIL: '1',
          MYSQL_BACKUP_FILE: backup,
          DR_ISOLATED_TARGET: '1',
          DR_MYSQL_TARGET_SERVER_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
          DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
          DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
          DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: noOpCleanup,
          DR_RESTORE_TARGET_ID: 'mysql-isolated-target',
          DR_VERIFY_COMMAND: verifier,
        },
        encoding: 'utf8',
      });
      assert.notEqual(uncleaned.status, 0);
      assert.match(uncleaned.stderr, /CRITICAL: failed to clean/u);

      writeFileSync(targetState, '0\n');
      const alternateBackup = join(directory, 'tixkit-mysql-alternate.sql.gz');
      execFileSync(
        'bash',
        ['-c', 'printf "CREATE TABLE alternate (value INT);\n" | gzip >"$OUTPUT"'],
        {
          env: { ...process.env, OUTPUT: alternateBackup },
        },
      );
      signArtifact(alternateBackup, 'mysql', env);
      assert.notEqual(
        createHash('sha256').update(readFileSync(alternateBackup)).digest('hex'),
        createHash('sha256').update(readFileSync(backup)).digest('hex'),
      );
      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'c');
      const concurrentBase = {
        ...backupEnv,
        MYSQL_BACKUP_FILE: backup,
        DR_ISOLATED_TARGET: '1',
        DR_MYSQL_TARGET_SERVER_UUID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        DR_MYSQL_TARGET_PROVISION_RECEIPT: provisionReceipt,
        DR_MYSQL_TARGET_LEASE_COMMAND: leaseHolder,
        DR_MYSQL_TARGET_LEASE_VERIFY_COMMAND: leaseVerifier,
        DR_MYSQL_FAILED_RESTORE_CLEANUP_COMMAND: cleanup,
        DR_RESTORE_TARGET_ID: 'mysql-isolated-target',
        DR_VERIFY_COMMAND: verifier,
        MOCK_IMPORT_DELAY_SECONDS: '2',
      };
      const firstRestore = spawn(resolve(root, 'infra/scripts/restore-mysql.sh'), [], {
        cwd: root,
        env: concurrentBase,
      });
      let firstRestoreStderr = '';
      firstRestore.stderr.on('data', (chunk) => {
        firstRestoreStderr += chunk;
      });
      const claimFile = join(leaseRegistry, 'c'.repeat(64));
      const claimDeadline = Date.now() + 5_000;
      while (!existsSync(claimFile) && Date.now() < claimDeadline)
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      assert.equal(existsSync(claimFile), true);
      const competingRestore = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: { ...concurrentBase, MYSQL_BACKUP_FILE: alternateBackup },
        encoding: 'utf8',
      });
      assert.notEqual(competingRestore.status, 0);
      assert.match(competingRestore.stderr, /lease acquisition failed/u);
      const firstRestoreCode = await new Promise((resolveClose) =>
        firstRestore.on('close', resolveClose),
      );
      assert.equal(firstRestoreCode, 0, firstRestoreStderr);
      assert.equal(
        readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line === 'import').length,
        1,
      );

      writeFileSync(targetState, '0\n');
      rmSync(forceLeaseExpiry, { force: true });
      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'd');
      const expiredDuringImport = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...concurrentBase,
          MOCK_IMPORT_DELAY_SECONDS: '2',
          MOCK_FORCE_LEASE_EXPIRY_FILE: forceLeaseExpiry,
          DR_MYSQL_LEASE_VERIFY_INTERVAL_SECONDS: '1',
        },
        encoding: 'utf8',
      });
      assert.notEqual(expiredDuringImport.status, 0);
      assert.match(expiredDuringImport.stderr, /lease is expired or too close to expiry/u);
      assert.equal(readFileSync(targetState, 'utf8').trim(), '0');

      writeFileSync(targetState, '0\n');
      rmSync(forceLeaseExpiry, { force: true });
      rmSync(forceLeaseExit, { force: true });
      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'e');
      const abandonedLease = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...concurrentBase,
          MOCK_IMPORT_DELAY_SECONDS: '1',
          MOCK_FORCE_LEASE_EXIT_FILE: forceLeaseExit,
        },
        encoding: 'utf8',
      });
      assert.notEqual(abandonedLease.status, 0);
      assert.match(abandonedLease.stderr, /lease was lost during import/u);
      assert.equal(readFileSync(targetState, 'utf8').trim(), '0');

      rmSync(forceLeaseExit, { force: true });
      writeFileSync(targetState, '0\n');
      writeProvisionReceipt('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '0');
      const leaseKillingVerifier = join(directory, 'lease-killing-verifier');
      writeFileSync(
        leaseKillingVerifier,
        `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
printf exit >${JSON.stringify(forceLeaseExit)}
sleep 2
`,
      );
      chmodSync(leaseKillingVerifier, 0o755);
      const verifierLossEvidence = join(directory, 'verifier-loss-evidence/restore.json');
      const leaseLostDuringVerifier = spawnSync(resolve(root, 'infra/scripts/restore-mysql.sh'), {
        cwd: root,
        env: {
          ...concurrentBase,
          MOCK_IMPORT_DELAY_SECONDS: '0.1',
          DR_VERIFY_COMMAND: leaseKillingVerifier,
          DR_EVIDENCE_FILE: verifierLossEvidence,
          DR_INCIDENT_AT: new Date().toISOString(),
          DR_TARGET_RELEASE: 'v1.1.0',
        },
        encoding: 'utf8',
      });
      assert.notEqual(leaseLostDuringVerifier.status, 0);
      assert.match(leaseLostDuringVerifier.stderr, /lease was lost during application verifier/u);
      assert.equal(existsSync(verifierLossEvidence), false);
      assert.equal(readFileSync(targetState, 'utf8').trim(), '0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

productionBackupTest(productionBackupTestName, () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-production-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'lifecycle.log');
  const env = environment(directory);
  try {
    execFileSync('mkdir', ['-p', bin]);
    const quiesce = join(directory, 'quiesce');
    const resume = join(directory, 'resume');
    const checkpoint = join(directory, 'checkpoint');
    const checkpointVerifier = join(directory, 'verify-checkpoint');
    const publisher = join(directory, 'publish');
    const retriever = join(directory, 'retrieve');
    const receiptVerifier = join(directory, 'verify-receipt');
    const storageIdentity = join(directory, 'storage-identity');
    const objectMetadataAdapter = join(directory, 'object-metadata-adapter');
    const objectInventoryVerifier = join(directory, 'object-inventory-verifier');
    const objectOwnershipVerifier = join(directory, 'object-ownership-verifier');
    const ciphertext = join(directory, 'independent-storage.ciphertext');
    writeFileSync(
      quiesce,
      `#!/usr/bin/env bash\ntest -z "\${TIXKIT_TEST_SECRET:-}"\nprintf 'quiesce\\n' >>${JSON.stringify(log)}\n`,
    );
    writeFileSync(
      resume,
      `#!/usr/bin/env bash\ntest -z "\${TIXKIT_TEST_SECRET:-}"\nprintf 'resume\\n' >>${JSON.stringify(log)}\n`,
    );
    writeFileSync(
      checkpoint,
      `#!/usr/bin/env bash
test -z "\${TIXKIT_TEST_SECRET:-}"
node -e 'require("node:fs").writeFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE, JSON.stringify({immutableId:"temporal-123",namespace:"tixkit",recoveryPointAt:process.env.DR_RECOVERY_POINT_AT,verified:true}))'
`,
    );
    writeFileSync(
      publisher,
      `#!/usr/bin/env bash
test -z "\${TIXKIT_TEST_SECRET:-}"
node - <<'NODE'
const {createHash,createHmac}=require('node:crypto'); const {readFileSync,writeFileSync}=require('node:fs');
const plain=readFileSync(process.env.DR_PUBLISH_ARTIFACT); const cipher=Buffer.from(plain).reverse();
writeFileSync(${JSON.stringify(ciphertext)},cipher);
writeFileSync(${JSON.stringify(`${ciphertext}.manifest.json`)},readFileSync(process.env.DR_PUBLISH_MANIFEST));
writeFileSync(${JSON.stringify(`${ciphertext}.sha256`)},readFileSync(process.env.DR_PUBLISH_CHECKSUM));
const payload={schemaVersion:1,immutable:true,storageId:'independent://backup-123',retentionUntil:'2099-01-01T00:00:00Z',plaintextSha256:createHash('sha256').update(plain).digest('hex'),ciphertextSha256:createHash('sha256').update(cipher).digest('hex')};
payload.providerSignature=createHmac('sha256','test-provider-key').update(JSON.stringify(payload)).digest('hex');
writeFileSync(process.env.DR_PUBLISH_RECEIPT,JSON.stringify(payload));
NODE
`,
    );
    writeFileSync(
      checkpointVerifier,
      `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
node -e 'const f=require("node:fs"); const value=JSON.parse(f.readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); if(value.immutableId!=="temporal-123"||value.verified!==true) process.exit(1)'
`,
    );
    writeFileSync(
      retriever,
      `#!/usr/bin/env bash
test -z "\${TIXKIT_TEST_SECRET:-}"
node -e 'const f=require("node:fs"); f.writeFileSync(process.env.DR_RETRIEVE_OUTPUT,Buffer.from(f.readFileSync(${JSON.stringify(ciphertext)})).reverse()); f.writeFileSync(process.env.DR_RETRIEVE_MANIFEST_OUTPUT,f.readFileSync(${JSON.stringify(`${ciphertext}.manifest.json`)})); f.writeFileSync(process.env.DR_RETRIEVE_CHECKSUM_OUTPUT,f.readFileSync(${JSON.stringify(`${ciphertext}.sha256`)}))'
`,
    );
    writeFileSync(
      receiptVerifier,
      `#!/usr/bin/env bash
test -z "\${TIXKIT_TEST_SECRET:-}"
node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs');
const receipt=JSON.parse(readFileSync(process.env.DR_RECEIPT_FILE)); const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256','test-provider-key').update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
NODE
`,
    );
    writeFileSync(
      storageIdentity,
      '#!/usr/bin/env bash\ntest -z "${TIXKIT_TEST_SECRET:-}"\ntest -n "$MC_CONFIG_DIR"\ntest -n "$MC_ALIAS_NAME"\n',
    );
    writeFileSync(
      objectMetadataAdapter,
      `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
if test -n "\${DR_OBJECT_METADATA_FILE:-}"; then
  printf '%s\n' '{"objects":[{"key":"event-poster.webp","contentType":"image/webp","cacheControl":"public, max-age=31536000, immutable","customMetadata":{"role":"poster"}}]}' >"$DR_OBJECT_METADATA_FILE"
else
  test -f "$DR_OBJECT_INVENTORY_FILE"
  test -z "\${DR_OBJECT_RECONCILIATION_FILE:-}"
  test -z "\${DR_OBJECT_EXPECTED_INVENTORY_SHA256:-}"
fi
`,
    );
    writeFileSync(
      objectInventoryVerifier,
      `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
test -z "\${DR_OBJECT_RECONCILIATION_FILE:-}"
printf '{"verified":true,"inventorySha256":"%s"}\n' "$DR_OBJECT_EXPECTED_INVENTORY_SHA256"
`,
    );
    writeFileSync(
      objectOwnershipVerifier,
      `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${TIXKIT_TEST_SECRET:-}"
node -e 'const f=require("node:fs"); const r=JSON.parse(f.readFileSync(process.env.DR_OBJECT_BUCKET_OWNERSHIP_FILE)); if(r.restoreRunId!==process.env.DR_OBJECT_RESTORE_RUN_ID||r.bucket!==process.env.RESTORE_S3_BUCKET||r.created!==true) process.exit(1)'
`,
    );
    writeFileSync(
      join(bin, 'pg_dump'),
      `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in --file=*) output="\${argument#--file=}" ;; esac
done
printf database >"$output"
`,
    );
    writeFileSync(
      join(bin, 'mc'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == mb && "\${MOCK_EXISTING_BUCKET:-0}" == 1 ]]; then
  exit 17
fi
if [[ "\${1:-}" == mirror ]]; then
  destination="\${@: -1}"
  if [[ "$destination" == /* ]]; then
    mkdir -p "$destination"
    printf object >"$destination/event-poster.webp"
  fi
fi
`,
    );
    writeFileSync(join(bin, 'pg_restore'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(bin, 'psql'), "#!/usr/bin/env bash\nprintf '0\\n'\n");
    for (const file of [
      quiesce,
      resume,
      checkpoint,
      checkpointVerifier,
      publisher,
      retriever,
      receiptVerifier,
      storageIdentity,
      objectMetadataAdapter,
      objectInventoryVerifier,
      objectOwnershipVerifier,
      join(bin, 'pg_dump'),
      join(bin, 'pg_restore'),
      join(bin, 'psql'),
      join(bin, 'mc'),
    ])
      chmodSync(file, 0o755);

    const backupEnv = {
      ...env,
      TIXKIT_TEST_SECRET: 'must-not-reach-hooks',
      PATH: `${bin}:${process.env.PATH}`,
      DB_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://source.example/tixkit',
      S3_ENDPOINT: 'https://storage.example.com',
      S3_BUCKET: 'tixkit',
      S3_AUTH_MODE: 'workload-identity',
      S3_CREDENTIAL_SETUP_COMMAND: storageIdentity,
      DR_OBJECT_METADATA_EXPORT_COMMAND: objectMetadataAdapter,
      DR_OBJECT_METADATA_RESTORE_COMMAND: objectMetadataAdapter,
      DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectMetadataAdapter,
      DR_QUIESCE_COMMAND: quiesce,
      DR_RESUME_COMMAND: resume,
      DR_TEMPORAL_CHECKPOINT_COMMAND: checkpoint,
      DR_TEMPORAL_CHECKPOINT_VERIFY_COMMAND: checkpointVerifier,
      DR_BACKUP_PUBLISH_COMMAND: publisher,
      DR_BACKUP_RETRIEVE_COMMAND: retriever,
      DR_BACKUP_RECEIPT_VERIFY_COMMAND: receiptVerifier,
      POSTGRES_GLOBALS_BACKUP_REFERENCE: 'vault://postgres/roles/checkpoint-123',
      BACKUP_DIR: join(directory, 'output'),
      BACKUP_TIMESTAMP: '20260712T000000Z',
    };
    const output = execFileSync(resolve(root, 'infra/scripts/production-backup.sh'), {
      cwd: root,
      env: backupEnv,
      encoding: 'utf8',
    });
    const receipt = output.trim();
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['quiesce', 'resume']);
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).immutable, true);
    assert.equal(statSync(receipt).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(backupEnv.BACKUP_DIR), [receipt.split('/').pop()]);

    const failingHook = join(directory, 'fail-hook');
    writeFileSync(failingHook, '#!/usr/bin/env bash\nexit 1\n');
    chmodSync(failingHook, 0o755);
    for (const [failure, override] of [
      ['publish', { DR_BACKUP_PUBLISH_COMMAND: failingHook }],
      ['receipt', { DR_BACKUP_RECEIPT_VERIFY_COMMAND: failingHook }],
      ['retrieve', { DR_BACKUP_RETRIEVE_COMMAND: failingHook }],
    ]) {
      const failureOutput = join(directory, `failure-${failure}`);
      const result = spawnSync(resolve(root, 'infra/scripts/production-backup.sh'), {
        cwd: root,
        env: {
          ...backupEnv,
          ...override,
          BACKUP_DIR: failureOutput,
          BACKUP_TIMESTAMP: `20260712T00000${failure.length}Z`,
        },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.deepEqual(readdirSync(failureOutput), []);
    }
    const forgedReceipt = join(directory, 'forged-receipt.json');
    const forgedPayload = JSON.parse(readFileSync(receipt, 'utf8'));
    forgedPayload.storageId = 'independent://attacker-substitution';
    writeFileSync(forgedReceipt, JSON.stringify(forgedPayload));
    const forgedVerification = spawnSync(receiptVerifier, {
      env: { ...env, DR_RECEIPT_FILE: forgedReceipt },
      encoding: 'utf8',
    });
    assert.notEqual(forgedVerification.status, 0);
    assert.equal(
      readFileSync(ciphertext)
        .subarray(0, 2)
        .equals(Buffer.from([0x1f, 0x8b])),
      false,
    );
    const retrieved = join(directory, 'retrieved.tar.gz');
    execFileSync(retriever, {
      env: {
        ...env,
        DR_RETRIEVE_OUTPUT: retrieved,
        DR_RETRIEVE_MANIFEST_OUTPUT: `${retrieved}.manifest.json`,
        DR_RETRIEVE_CHECKSUM_OUTPUT: `${retrieved}.sha256`,
      },
    });
    const listing = execFileSync('tar', ['-tzf', retrieved], { encoding: 'utf8' });
    assert.match(listing, /temporal-checkpoint\.json/);
    assert.match(listing, /redis-recovery-boundary\.txt/);
    assert.match(listing, /tixkit-postgres-.+\.manifest\.json/);
    assert.match(listing, /tixkit-object-storage-.+\.manifest\.json/);

    const databaseVerifier = join(directory, 'verify-database');
    const objectVerifier = join(directory, 'verify-object');
    const finalVerifier = join(directory, 'verify-final');
    const temporalRestore = join(directory, 'restore-temporal');
    const temporalEvidenceVerifier = join(directory, 'verify-temporal-evidence');
    for (const file of [
      databaseVerifier,
      objectVerifier,
      finalVerifier,
      temporalEvidenceVerifier,
    ]) {
      writeFileSync(file, '#!/usr/bin/env bash\ntest -z "${TIXKIT_TEST_SECRET:-}"\n');
      chmodSync(file, 0o755);
    }
    writeFileSync(
      temporalRestore,
      `#!/usr/bin/env bash
test -z "\${TIXKIT_TEST_SECRET:-}"
node -e 'const f=require("node:fs"); const c=JSON.parse(f.readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); f.writeFileSync(process.env.DR_TEMPORAL_RESTORE_EVIDENCE,JSON.stringify({verified:true,immutableId:c.immutableId,namespace:c.namespace,recoveryPointAt:c.recoveryPointAt}))'
`,
    );
    chmodSync(temporalRestore, 0o755);
    const restoreEnv = {
      ...env,
      TIXKIT_TEST_SECRET: 'must-not-reach-hooks',
      PATH: `${bin}:${process.env.PATH}`,
      PRODUCTION_BUNDLE_FILE: retrieved,
      DB_DRIVER: 'postgres',
      DATABASE_URL: 'postgres://restore.example/tixkit',
      S3_ENDPOINT: 'https://storage.example.com',
      S3_BUCKET: 'tixkit',
      RESTORE_S3_BUCKET: 'tixkit-restore',
      S3_AUTH_MODE: 'workload-identity',
      S3_CREDENTIAL_SETUP_COMMAND: storageIdentity,
      DR_OBJECT_METADATA_RESTORE_COMMAND: objectMetadataAdapter,
      DR_OBJECT_INVENTORY_VERIFY_COMMAND: objectInventoryVerifier,
      DR_OBJECT_BUCKET_OWNERSHIP_VERIFY_COMMAND: objectOwnershipVerifier,
      DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectMetadataAdapter,
      DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectMetadataAdapter,
      DR_DATABASE_VERIFY_COMMAND: databaseVerifier,
      DR_OBJECT_VERIFY_COMMAND: objectVerifier,
      DR_TEMPORAL_RESTORE_COMMAND: temporalRestore,
      DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND: temporalEvidenceVerifier,
      DR_FINAL_VERIFY_COMMAND: finalVerifier,
      DR_DATABASE_TARGET_ID: 'postgres-staging',
      DR_OBJECT_TARGET_ID: 'object-staging',
      DR_PRODUCTION_TARGET_ID: 'production-staging',
      DR_EVIDENCE_DIR: join(directory, 'restore-evidence'),
      DR_INCIDENT_AT: new Date().toISOString(),
      DR_TARGET_RELEASE: 'v1.1.0',
    };
    const successfulProductionRestore = spawnSync(
      resolve(root, 'infra/scripts/production-restore.sh'),
      {
        cwd: root,
        env: restoreEnv,
        encoding: 'utf8',
      },
    );
    assert.equal(successfulProductionRestore.status, 0, successfulProductionRestore.stderr);
    assert.equal(existsSync(join(directory, 'restore-evidence/database.json')), true);
    assert.equal(existsSync(join(directory, 'restore-evidence/object-storage.json')), true);
    assert.equal(existsSync(join(directory, 'restore-evidence/temporal.json')), true);
    const aggregateEvidence = readFileSync(
      join(directory, 'restore-evidence/production.json'),
      'utf8',
    );
    assert.equal(JSON.parse(aggregateEvidence).kind, 'production-bundle');
    assert.doesNotMatch(aggregateEvidence, /postgres:\/\/|password|secret/i);

    const mutatingMetadata = join(directory, 'mutating-metadata');
    const objectCleanup = join(directory, 'object-cleanup');
    const objectAbsence = join(directory, 'object-absence');
    const cleanupMarker = join(directory, 'object-cleaned');
    writeFileSync(
      mutatingMetadata,
      '#!/usr/bin/env bash\nprintf " " >>"$DR_OBJECT_INVENTORY_FILE"\n',
    );
    writeFileSync(
      objectCleanup,
      `#!/usr/bin/env bash\nprintf cleaned >${JSON.stringify(cleanupMarker)}\n`,
    );
    writeFileSync(
      objectAbsence,
      `#!/usr/bin/env bash\ntest "$(cat ${JSON.stringify(cleanupMarker)})" = cleaned\n`,
    );
    for (const file of [mutatingMetadata, objectCleanup, objectAbsence]) chmodSync(file, 0o755);
    const mutatedRestore = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: {
        ...restoreEnv,
        DR_EVIDENCE_DIR: join(directory, 'mutated-object-evidence'),
        DR_OBJECT_METADATA_RESTORE_COMMAND: mutatingMetadata,
        DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
        DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
      },
      encoding: 'utf8',
    });
    assert.notEqual(mutatedRestore.status, 0);
    assert.match(mutatedRestore.stderr, /Artifact identity changed|Object inventory changed/u);
    assert.equal(readFileSync(cleanupMarker, 'utf8'), 'cleaned');

    const preforgingMetadata = join(directory, 'preforging-metadata');
    writeFileSync(
      preforgingMetadata,
      `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_OBJECT_RECONCILIATION_FILE:-}"
test -z "\${DR_OBJECT_EXPECTED_INVENTORY_SHA256:-}"
printf '{"verified":true,"inventorySha256":"forged"}' >"$(dirname "$DR_OBJECT_INVENTORY_FILE")/remote-reconciliation.json"
`,
    );
    chmodSync(preforgingMetadata, 0o755);
    const preforgedRestore = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: {
        ...restoreEnv,
        DR_EVIDENCE_DIR: join(directory, 'preforged-object-evidence'),
        DR_OBJECT_METADATA_RESTORE_COMMAND: preforgingMetadata,
        DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
        DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
      },
      encoding: 'utf8',
    });
    assert.notEqual(preforgedRestore.status, 0);
    assert.match(preforgedRestore.stderr, /EEXIST|file already exists/u);

    rmSync(cleanupMarker, { force: true });
    const existingBucketSentinel = join(directory, 'preexisting-object');
    writeFileSync(existingBucketSentinel, 'must-survive');
    const existingBucketRestore = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: {
        ...restoreEnv,
        MOCK_EXISTING_BUCKET: '1',
        DR_EVIDENCE_DIR: join(directory, 'existing-bucket-evidence'),
        DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
        DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
      },
      encoding: 'utf8',
    });
    assert.notEqual(existingBucketRestore.status, 0);
    assert.equal(existsSync(cleanupMarker), false);
    assert.equal(readFileSync(existingBucketSentinel, 'utf8'), 'must-survive');

    const preCreateUploadFailure = join(directory, 'pre-create-upload-failure');
    writeFileSync(preCreateUploadFailure, '#!/usr/bin/env bash\nexit 29\n');
    chmodSync(preCreateUploadFailure, 0o755);
    const failedBeforeCreate = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: {
        ...restoreEnv,
        S3_UPLOAD_COMMAND: preCreateUploadFailure,
        DR_EVIDENCE_DIR: join(directory, 'pre-create-upload-evidence'),
        DR_OBJECT_FAILED_RESTORE_CLEANUP_COMMAND: objectCleanup,
        DR_OBJECT_ABSENCE_VERIFY_COMMAND: objectAbsence,
      },
      encoding: 'utf8',
    });
    assert.notEqual(failedBeforeCreate.status, 0);
    assert.equal(existsSync(cleanupMarker), false);

    const substitutedEvidence = join(directory, 'substituted-evidence');
    mkdirSync(substitutedEvidence);
    for (const name of ['database.json', 'object-storage.json', 'temporal.json'])
      copyFileSync(join(directory, 'restore-evidence', name), join(substitutedEvidence, name));
    const substitutedDatabase = JSON.parse(
      readFileSync(join(substitutedEvidence, 'database.json'), 'utf8'),
    );
    substitutedDatabase.restoreTargetId = 'attacker-target';
    const { signature: ignoredSignature, ...substitutedDatabasePayload } = substitutedDatabase;
    void ignoredSignature;
    substitutedDatabase.signature = {
      algorithm: 'hmac-sha256',
      keyId: env.DR_MANIFEST_KEY_ID,
      value: createHmac('sha256', env.DR_MANIFEST_SIGNING_KEY)
        .update(JSON.stringify(substitutedDatabasePayload))
        .digest('hex'),
    };
    writeFileSync(join(substitutedEvidence, 'database.json'), JSON.stringify(substitutedDatabase));
    const substitutedObject = JSON.parse(
      readFileSync(join(substitutedEvidence, 'object-storage.json'), 'utf8'),
    );
    const writeComponentManifest = (name, evidence) => {
      const path = join(substitutedEvidence, `${name}.manifest.json`);
      writeFileSync(
        path,
        JSON.stringify({
          recoveryPointAt: evidence.recoveryPointAt,
          sha256: evidence.artifactSha256,
          sourceRelease: evidence.sourceRelease,
        }),
      );
      return path;
    };
    const databaseManifest = writeComponentManifest('database', substitutedDatabase);
    const objectManifest = writeComponentManifest('object', substitutedObject);
    const substitution = spawnSync(
      'bash',
      [
        '-c',
        'source "$DR_COMMON"; export DR_TEMPORAL_EVIDENCE_SHA256="$(dr_sha256 "$DR_EVIDENCE_DIR/temporal.json")"; dr_reserve_restore_evidence; dr_run_restore_verifier production-bundle; dr_record_restore_evidence "$PRODUCTION_BUNDLE_FILE" production-bundle "$(date +%s)"',
      ],
      {
        cwd: root,
        env: {
          ...env,
          DR_COMMON: common,
          DR_EVIDENCE_DIR: substitutedEvidence,
          DR_EVIDENCE_FILE: join(substitutedEvidence, 'production.json'),
          DR_FINAL_VERIFY_COMMAND: finalVerifier,
          DR_INCIDENT_AT: new Date().toISOString(),
          DR_RESTORE_COMPONENT_FILES: ['database.json', 'object-storage.json', 'temporal.json']
            .map((name) => join(substitutedEvidence, name))
            .join(','),
          DR_RESTORE_DATABASE_MANIFEST: databaseManifest,
          DR_RESTORE_OBJECT_MANIFEST: objectManifest,
          DR_EXPECTED_DATABASE_TARGET_ID: 'postgres-staging',
          DR_EXPECTED_OBJECT_TARGET_ID: 'object-staging',
          DR_RESTORE_TARGET_ID: 'production-substitution-test',
          DR_TARGET_RELEASE: 'v1.1.0',
          DR_VERIFY_COMMAND: finalVerifier,
          PRODUCTION_BUNDLE_FILE: retrieved,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(
      substitution.status,
      0,
      existsSync(join(substitutedEvidence, 'production.json'))
        ? readFileSync(join(substitutedEvidence, 'production.json'), 'utf8')
        : substitution.stderr,
    );
    assert.match(substitution.stderr, /Component restore evidence does not match this drill/u);
    assert.equal(existsSync(join(substitutedEvidence, 'production.json')), false);

    const tamperDirectory = join(directory, 'tampered');
    execFileSync('mkdir', ['-p', join(tamperDirectory, '__MACOSX')]);
    execFileSync('tar', ['-xzf', retrieved, '-C', tamperDirectory]);
    writeFileSync(join(tamperDirectory, '__MACOSX/._artifact'), 'unexpected');
    const tamperedBundle = join(directory, 'tampered.tar.gz');
    execFileSync('tar', ['-czf', tamperedBundle, '-C', tamperDirectory, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    signArtifact(tamperedBundle, 'production-bundle', env);
    const restoreGateEnv = {
      ...env,
      PRODUCTION_BUNDLE_FILE: tamperedBundle,
      DB_DRIVER: 'postgres',
      DR_TEMPORAL_RESTORE_COMMAND: checkpoint,
      DR_TEMPORAL_EVIDENCE_VERIFY_COMMAND: checkpoint,
      DR_FINAL_VERIFY_COMMAND: checkpoint,
      DR_DATABASE_TARGET_ID: 'postgres-staging',
      DR_OBJECT_TARGET_ID: 'object-staging',
      DR_PRODUCTION_TARGET_ID: 'production-staging',
      DR_EVIDENCE_DIR: join(directory, 'tampered-evidence'),
      DR_INCIDENT_AT: '2026-07-12T00:00:01Z',
      DR_TARGET_RELEASE: 'v1.1.0',
    };
    const rejected = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: restoreGateEnv,
      encoding: 'utf8',
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Non-canonical production bundle entry/);

    for (const [limit, value, message] of [
      ['PRODUCTION_RESTORE_MAX_MEMBERS', '1', /exceeds member limit/],
      ['PRODUCTION_RESTORE_MAX_BYTES', '1', /exceeds expansion limit/],
    ]) {
      const limited = spawnSync(resolve(root, 'infra/scripts/production-restore.sh'), {
        cwd: root,
        env: { ...restoreGateEnv, PRODUCTION_BUNDLE_FILE: retrieved, [limit]: value },
        encoding: 'utf8',
      });
      assert.notEqual(limited.status, 0);
      assert.match(limited.stderr, message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('migration rehearsal executes forward verification and restore-based rollback on isolated clones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-migration-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'rehearsal.log');
  const env = environment(directory);
  try {
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(
      join(bin, 'pg_dump'),
      `#!/usr/bin/env bash
for argument in "$@"; do case "$argument" in --file=*) printf backup >"\${argument#--file=}" ;; esac; done
`,
    );
    writeFileSync(join(bin, 'pg_restore'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(bin, 'psql'), "#!/usr/bin/env bash\nprintf '0\\n'\n");
    writeFileSync(
      join(bin, 'bun'),
      `#!/usr/bin/env bash
printf 'migrate:%s\\n' "\${DATABASE_URL:-}" >>${JSON.stringify(log)}
[[ "\${MOCK_MIGRATION_FAIL:-0}" != 1 ]]
`,
    );
    const oldVerifier = join(directory, 'verify-old');
    const newVerifier = join(directory, 'verify-new');
    writeFileSync(
      oldVerifier,
      `#!/usr/bin/env bash\nprintf 'old:%s\\n' "\${DATABASE_URL:-}" >>${JSON.stringify(log)}\n`,
    );
    writeFileSync(
      newVerifier,
      `#!/usr/bin/env bash\nprintf 'new:%s\\n' "\${DATABASE_URL:-}" >>${JSON.stringify(log)}\n`,
    );
    for (const file of [
      join(bin, 'pg_dump'),
      join(bin, 'pg_restore'),
      join(bin, 'psql'),
      join(bin, 'bun'),
      oldVerifier,
      newVerifier,
    ])
      chmodSync(file, 0o755);

    execFileSync(resolve(root, 'infra/scripts/migration-rehearsal.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        DB_DRIVER: 'postgres',
        SOURCE_DATABASE_URL: 'postgres://source.example/tixkit',
        FORWARD_DATABASE_URL: 'postgres://forward.example/tixkit',
        ROLLBACK_DATABASE_URL: 'postgres://rollback.example/tixkit',
        FORWARD_TARGET_ID: 'forward-clone',
        ROLLBACK_TARGET_ID: 'rollback-clone',
        DR_OLD_VERSION_VERIFY_COMMAND: oldVerifier,
        DR_NEW_VERSION_VERIFY_COMMAND: newVerifier,
        DR_INCIDENT_AT: '2026-07-12T00:00:01Z',
        DR_RECOVERY_POINT_AT: '2026-07-12T00:00:00Z',
        DR_OLD_RELEASE: 'v1.0.0',
        DR_NEW_RELEASE: 'v1.1.0',
        BACKUP_DIR: join(directory, 'backup'),
        DR_EVIDENCE_DIR: join(directory, 'evidence'),
      },
    });
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'old:postgres://forward.example/tixkit',
      'migrate:postgres://forward.example/tixkit',
      'new:postgres://forward.example/tixkit',
      'old:postgres://rollback.example/tixkit',
    ]);
    assert.equal(existsSync(join(directory, 'evidence/forward-restore.json')), true);
    assert.equal(existsSync(join(directory, 'evidence/rollback-restore.json')), true);

    writeFileSync(log, '');
    execFileSync(resolve(root, 'infra/scripts/migration-rehearsal.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        DB_DRIVER: 'postgres',
        SOURCE_DATABASE_URL: 'postgres://source.example/tixkit',
        FORWARD_DATABASE_URL: 'postgres://forward-failure.example/tixkit',
        ROLLBACK_DATABASE_URL: 'postgres://rollback-failure.example/tixkit',
        FORWARD_TARGET_ID: 'forward-failure-clone',
        ROLLBACK_TARGET_ID: 'rollback-failure-clone',
        DR_OLD_VERSION_VERIFY_COMMAND: oldVerifier,
        DR_NEW_VERSION_VERIFY_COMMAND: newVerifier,
        DR_INCIDENT_AT: '2026-07-12T00:00:01Z',
        DR_RECOVERY_POINT_AT: '2026-07-12T00:00:00Z',
        DR_OLD_RELEASE: 'v1.0.0',
        DR_NEW_RELEASE: 'v1.1.0',
        DR_EXPECT_FORWARD_FAILURE: '1',
        MOCK_MIGRATION_FAIL: '1',
        BACKUP_DIR: join(directory, 'failure-backup'),
        DR_EVIDENCE_DIR: join(directory, 'failure-evidence'),
      },
    });
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'old:postgres://forward-failure.example/tixkit',
      'migrate:postgres://forward-failure.example/tixkit',
      'old:postgres://rollback-failure.example/tixkit',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('restore promotion rolls the binding back when the promoted runtime fails verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-promotion-'));
  const log = join(directory, 'promotion.log');
  const evidence = join(directory, 'restore.json');
  try {
    const payload = {
      schemaVersion: 1,
      kind: 'production-bundle',
      verification: 'command-completed',
      restoreTargetId: 'production-staging',
      targetRelease: 'v1.1.0',
      verifierSha256: 'abc123',
      componentEvidenceSha256: [
        { file: 'database.json', sha256: '1'.repeat(64) },
        { file: 'object-storage.json', sha256: '2'.repeat(64) },
        { file: 'temporal.json', sha256: '3'.repeat(64) },
      ],
    };
    const signature = createHmac('sha256', 'test-signing-key-not-for-production')
      .update(JSON.stringify(payload))
      .digest('hex');
    writeFileSync(
      evidence,
      JSON.stringify({
        ...payload,
        signature: { algorithm: 'hmac-sha256', keyId: 'test-key-1', value: signature },
      }),
    );
    const invalidComponentSets = [
      { label: 'missing', components: undefined, error: /bind exactly three component results/ },
      {
        label: 'duplicate',
        components: [
          { file: 'database.json', sha256: '1'.repeat(64) },
          { file: 'database.json', sha256: '2'.repeat(64) },
          { file: 'temporal.json', sha256: '3'.repeat(64) },
        ],
        error: /component set is invalid/,
      },
      {
        label: 'wrong-hash',
        components: payload.componentEvidenceSha256.map((component, index) => ({
          ...component,
          sha256: index === 0 ? 'not-a-hash' : component.sha256,
        })),
        error: /component hashes are invalid/,
      },
    ];
    for (const invalid of invalidComponentSets) {
      const { componentEvidenceSha256: _components, ...basePayload } = payload;
      const invalidPayload =
        invalid.components === undefined
          ? basePayload
          : { ...basePayload, componentEvidenceSha256: invalid.components };
      const invalidEvidence = join(directory, `${invalid.label}-restore.json`);
      const invalidSignature = createHmac('sha256', 'test-signing-key-not-for-production')
        .update(JSON.stringify(invalidPayload))
        .digest('hex');
      writeFileSync(
        invalidEvidence,
        JSON.stringify({
          ...invalidPayload,
          signature: {
            algorithm: 'hmac-sha256',
            keyId: 'test-key-1',
            value: invalidSignature,
          },
        }),
      );
      const invalidResult = spawnSync(
        'bash',
        ['-c', 'source "$DR_COMMON"; dr_verify_restore_evidence "$EVIDENCE" production-bundle'],
        {
          cwd: root,
          env: { ...environment(directory), DR_COMMON: common, EVIDENCE: invalidEvidence },
          encoding: 'utf8',
        },
      );
      assert.notEqual(invalidResult.status, 0);
      assert.match(invalidResult.stderr, invalid.error);
    }
    const commands = {};
    for (const [name, status] of [
      ['cutover', 0],
      ['verify-cutover', 1],
      ['rollback', 0],
      ['verify-rollback', 0],
    ]) {
      const path = join(directory, name);
      writeFileSync(
        path,
        `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(name)} >>${JSON.stringify(log)}\nexit ${status}\n`,
      );
      chmodSync(path, 0o755);
      commands[name] = path;
    }
    const promotionEvidence = join(directory, 'promotion.json');
    const result = spawnSync(resolve(root, 'infra/scripts/promote-restored-target.sh'), {
      cwd: root,
      env: {
        ...process.env,
        DR_MANIFEST_SIGNING_KEY: 'test-signing-key-not-for-production',
        DR_MANIFEST_KEY_ID: 'test-key-1',
        DR_RESTORE_EVIDENCE_FILE: evidence,
        DR_CUTOVER_COMMAND: commands.cutover,
        DR_CUTOVER_VERIFY_COMMAND: commands['verify-cutover'],
        DR_ROLLBACK_COMMAND: commands.rollback,
        DR_ROLLBACK_VERIFY_COMMAND: commands['verify-rollback'],
        DR_PROMOTION_EVIDENCE_FILE: promotionEvidence,
      },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'cutover',
      'verify-cutover',
      'rollback',
      'verify-rollback',
    ]);
    const promotion = JSON.parse(readFileSync(promotionEvidence, 'utf8'));
    assert.equal(promotion.outcome, 'rolled-back');
    assert.match(promotion.restoreEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.match(promotion.cutoverCommandSha256, /^[a-f0-9]{64}$/);

    writeFileSync(
      commands.cutover,
      `#!/usr/bin/env bash\nprintf 'cutover\\n' >>${JSON.stringify(log)}\nexit 1\n`,
    );
    writeFileSync(log, '');
    const partialCutover = spawnSync(resolve(root, 'infra/scripts/promote-restored-target.sh'), {
      cwd: root,
      env: {
        ...process.env,
        DR_MANIFEST_SIGNING_KEY: 'test-signing-key-not-for-production',
        DR_MANIFEST_KEY_ID: 'test-key-1',
        DR_RESTORE_EVIDENCE_FILE: evidence,
        DR_CUTOVER_COMMAND: commands.cutover,
        DR_CUTOVER_VERIFY_COMMAND: commands['verify-cutover'],
        DR_ROLLBACK_COMMAND: commands.rollback,
        DR_ROLLBACK_VERIFY_COMMAND: commands['verify-rollback'],
        DR_PROMOTION_EVIDENCE_FILE: join(directory, 'partial-cutover.json'),
      },
      encoding: 'utf8',
    });
    assert.notEqual(partialCutover.status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'cutover',
      'rollback',
      'verify-rollback',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
