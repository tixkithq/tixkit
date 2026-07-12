import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production backup quiesces once and binds database, objects, and Temporal to one recovery point', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-dr-production-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'lifecycle.log');
  const env = environment(directory);
  try {
    execFileSync('mkdir', ['-p', bin]);
    const quiesce = join(directory, 'quiesce');
    const resume = join(directory, 'resume');
    const checkpoint = join(directory, 'checkpoint');
    const publisher = join(directory, 'publish');
    const retriever = join(directory, 'retrieve');
    const receiptVerifier = join(directory, 'verify-receipt');
    const ciphertext = join(directory, 'independent-storage.ciphertext');
    writeFileSync(quiesce, `#!/usr/bin/env bash\nprintf 'quiesce\\n' >>${JSON.stringify(log)}\n`);
    writeFileSync(resume, `#!/usr/bin/env bash\nprintf 'resume\\n' >>${JSON.stringify(log)}\n`);
    writeFileSync(
      checkpoint,
      `#!/usr/bin/env bash
node -e 'require("node:fs").writeFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE, JSON.stringify({immutableId:"temporal-123",namespace:"tixkit",recoveryPointAt:process.env.DR_RECOVERY_POINT_AT,verified:true}))'
`,
    );
    writeFileSync(
      publisher,
      `#!/usr/bin/env bash
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
      retriever,
      `#!/usr/bin/env bash
node -e 'const f=require("node:fs"); f.writeFileSync(process.env.DR_RETRIEVE_OUTPUT,Buffer.from(f.readFileSync(${JSON.stringify(ciphertext)})).reverse()); f.writeFileSync(process.env.DR_RETRIEVE_MANIFEST_OUTPUT,f.readFileSync(${JSON.stringify(`${ciphertext}.manifest.json`)})); f.writeFileSync(process.env.DR_RETRIEVE_CHECKSUM_OUTPUT,f.readFileSync(${JSON.stringify(`${ciphertext}.sha256`)}))'
`,
    );
    writeFileSync(
      receiptVerifier,
      `#!/usr/bin/env bash
node - <<'NODE'
const {createHmac,timingSafeEqual}=require('node:crypto'); const {readFileSync}=require('node:fs');
const receipt=JSON.parse(readFileSync(process.env.DR_RECEIPT_FILE)); const {providerSignature,...payload}=receipt;
const expected=createHmac('sha256','test-provider-key').update(JSON.stringify(payload)).digest(); const actual=Buffer.from(providerSignature,'hex');
if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) process.exit(1);
NODE
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
      publisher,
      retriever,
      receiptVerifier,
      join(bin, 'pg_dump'),
      join(bin, 'pg_restore'),
      join(bin, 'psql'),
      join(bin, 'mc'),
    ])
      chmodSync(file, 0o755);

    const output = execFileSync(resolve(root, 'infra/scripts/production-backup.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        DB_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://source.example/tixkit',
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'tixkit',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
        DR_QUIESCE_COMMAND: quiesce,
        DR_RESUME_COMMAND: resume,
        DR_TEMPORAL_CHECKPOINT_COMMAND: checkpoint,
        DR_BACKUP_PUBLISH_COMMAND: publisher,
        DR_BACKUP_RETRIEVE_COMMAND: retriever,
        DR_BACKUP_RECEIPT_VERIFY_COMMAND: receiptVerifier,
        POSTGRES_GLOBALS_BACKUP_REFERENCE: 'vault://postgres/roles/checkpoint-123',
        BACKUP_DIR: join(directory, 'output'),
        BACKUP_TIMESTAMP: '20260712T000000Z',
      },
      encoding: 'utf8',
    });
    const receipt = output.trim();
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['quiesce', 'resume']);
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).immutable, true);
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
      writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(file, 0o755);
    }
    writeFileSync(
      temporalRestore,
      `#!/usr/bin/env bash
node -e 'const f=require("node:fs"); const c=JSON.parse(f.readFileSync(process.env.DR_TEMPORAL_CHECKPOINT_FILE)); f.writeFileSync(process.env.DR_TEMPORAL_RESTORE_EVIDENCE,JSON.stringify({verified:true,immutableId:c.immutableId,namespace:c.namespace,recoveryPointAt:c.recoveryPointAt}))'
`,
    );
    chmodSync(temporalRestore, 0o755);
    execFileSync(resolve(root, 'infra/scripts/production-restore.sh'), {
      cwd: root,
      env: {
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        PRODUCTION_BUNDLE_FILE: retrieved,
        DB_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://restore.example/tixkit',
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'tixkit',
        RESTORE_S3_BUCKET: 'tixkit-restore',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: 'secret',
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
      },
    });
    assert.equal(existsSync(join(directory, 'restore-evidence/database.json')), true);
    assert.equal(existsSync(join(directory, 'restore-evidence/object-storage.json')), true);
    assert.equal(existsSync(join(directory, 'restore-evidence/temporal.json')), true);
    const aggregateEvidence = readFileSync(
      join(directory, 'restore-evidence/production.json'),
      'utf8',
    );
    assert.equal(JSON.parse(aggregateEvidence).kind, 'production-bundle');
    assert.doesNotMatch(aggregateEvidence, /postgres:\/\/|password|secret/i);

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
      DR_EVIDENCE_DIR: join(directory, 'restore-evidence'),
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
