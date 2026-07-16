import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const rehearsal = resolve(root, 'infra/scripts/migration-rehearsal.sh');
const verifier = resolve(root, 'scripts/verify-migration-rehearsal.mjs');
const oldRelease = `ghcr.io/tixkit/migrations@sha256:${'a'.repeat(64)}`;
const newRelease = `ghcr.io/tixkit/migrations@sha256:${'b'.repeat(64)}`;
const signingKey = 'migration-proof-test-signing-key';
const signingKeyId = 'migration-proof-test-key';
const environmentExample = resolve(root, 'infra/production/migration-rehearsal.env.example');
const validationRunbook = resolve(root, 'docs/completion/validation-runbook.md');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function signedDocument(path, payload) {
  const value = createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest('hex');
  writeFileSync(
    path,
    `${JSON.stringify({ ...payload, signature: { algorithm: 'hmac-sha256', keyId: signingKeyId, value } })}\n`,
    { mode: 0o600 },
  );
}

test('published rehearsal environment contract covers both drivers without storing the signing key', () => {
  const contents = readFileSync(environmentExample, 'utf8');
  for (const name of [
    'DR_OLD_RELEASE_MANIFEST',
    'DR_NEW_RELEASE_MANIFEST',
    'DR_DATABASE_IDENTITY_COMMAND',
    'POSTGRES_SOURCE_DATABASE_URL',
    'POSTGRES_FORWARD_DATABASE_URL',
    'POSTGRES_ROLLBACK_DATABASE_URL',
    'MYSQL_SOURCE_DATABASE_URL',
    'MYSQL_FORWARD_DATABASE_URL',
    'MYSQL_ROLLBACK_DATABASE_URL',
  ])
    assert.match(contents, new RegExp(`^${name}=`, 'mu'));
  assert.doesNotMatch(contents, /^DR_MANIFEST_SIGNING_KEY=/mu);
  const runbook = readFileSync(validationRunbook, 'utf8');
  assert.match(runbook, /set -a; \. \/absolute\/path\/to\/migration-rehearsal\.env; set \+a/u);
  assert.match(
    runbook,
    /DR_RECOVERY_POINT_AT="\$REHEARSAL_ANCHOR" DR_INCIDENT_AT="\$REHEARSAL_ANCHOR"/u,
  );
});

function executable(path, contents) {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function harness(driver, { expectedFailure = false, rehearsalId } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `tixkit-migration-proof-${driver}-`)));
  const bin = join(directory, 'bin');
  const backup = join(directory, 'backup');
  const evidence = join(directory, 'evidence');
  mkdirSync(bin);
  mkdirSync(backup);
  mkdirSync(evidence);
  chmodSync(backup, 0o700);
  chmodSync(evidence, 0o700);
  executable(
    join(bin, 'pg_dump'),
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\nfor argument in "$@"; do case "$argument" in --file=*) printf backup >"${argument#--file=}" ;; esac; done\n',
  );
  executable(
    join(bin, 'pg_restore'),
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\nexit 0\n',
  );
  executable(
    join(bin, 'psql'),
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\nprintf \'0\\n\'\n',
  );
  executable(
    join(bin, 'mysql'),
    `#!/usr/bin/env bash
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
if [[ "$*" == *"--execute="* ]]; then printf '0\\n'; else cat >/dev/null; fi
`,
  );
  executable(
    join(bin, 'mysqldump'),
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\nprintf \'CREATE TABLE proof (id int);\\n\'\n',
  );
  const oldVerifier = join(directory, 'verify-old');
  const newVerifier = join(directory, 'verify-new');
  const migrationCommand = join(directory, 'migrate');
  const databaseIdentityCommand = join(directory, 'database-identity');
  const migrationArtifact = join(directory, 'migration-artifact.json');
  executable(
    oldVerifier,
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\ntest -z "${SOURCE_DATABASE_URL:-}"\ntest -z "${ROLLBACK_DATABASE_URL:-}"\nprintf old-version-verified\n',
  );
  executable(
    newVerifier,
    '#!/usr/bin/env bash\ntest -z "${DR_MANIFEST_SIGNING_KEY:-}"\ntest -z "${SOURCE_DATABASE_URL:-}"\ntest -z "${ROLLBACK_DATABASE_URL:-}"\nprintf new-version-verified\n',
  );
  executable(
    migrationCommand,
    `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${SOURCE_DATABASE_URL:-}"
test -z "\${ROLLBACK_DATABASE_URL:-}"
test -z "\${UNRELATED_SENTINEL_SECRET:-}"
printf migration-attempted
if test -n "\${TIXKIT_MIGRATION_FAILURE_INJECTION_MANIFEST:-}"; then
  INJECTION="\${TIXKIT_MIGRATION_FAILURE_INJECTION_MANIFEST}" CHALLENGE="\${TIXKIT_MIGRATION_FAILURE_CHALLENGE}" RESULT="\${TIXKIT_MIGRATION_FAILURE_RESULT_FILE}" node <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const injection = JSON.parse(readFileSync(process.env.INJECTION, 'utf8'));
writeFileSync(process.env.RESULT, JSON.stringify({schemaVersion: 1, id: injection.id, type: injection.type,
  challenge: process.env.CHALLENGE, observedPoint: 'after-schema-apply', exitCode: injection.expectedExitCode}), {flag: 'wx', mode: 0o600});
NODE
  exit 42
fi
`,
  );
  executable(
    databaseIdentityCommand,
    `#!/usr/bin/env bash
set -euo pipefail
test -z "\${DR_MANIFEST_SIGNING_KEY:-}"
test -z "\${SOURCE_DATABASE_URL:-}"
test -z "\${ROLLBACK_DATABASE_URL:-}"
test -z "\${UNRELATED_SENTINEL_SECRET:-}"
ROLE="\${TIXKIT_DATABASE_IDENTITY_ROLE}" DRIVER="\${DB_DRIVER}" node <<'NODE'
const physical = {source: 'cluster-source/database', forward: 'cluster-forward/database', rollback: 'cluster-rollback/database'};
process.stdout.write(JSON.stringify({schemaVersion: 1, driver: process.env.DRIVER, role: process.env.ROLE,
  physicalId: physical[process.env.ROLE], database: 'tixkit', nonEmpty: true, stateDigest: 'c'.repeat(64)}));
NODE
`,
  );
  writeFileSync(migrationArtifact, '{"migration":"immutable"}\n', {
    mode: 0o600,
  });
  const oldReleaseManifest = join(directory, 'old-release-attestation.json');
  const newReleaseManifest = join(directory, 'new-release-attestation.json');
  const failureInjectionManifest = join(directory, 'failure-injection.json');
  signedDocument(oldReleaseManifest, {
    schemaVersion: 1,
    kind: 'migration-release-attestation',
    release: oldRelease,
    components: {
      oldVerifierSha256: sha256(oldVerifier),
      databaseIdentityCommandSha256: sha256(databaseIdentityCommand),
    },
  });
  signedDocument(newReleaseManifest, {
    schemaVersion: 1,
    kind: 'migration-release-attestation',
    release: newRelease,
    components: {
      migrationCommandSha256: sha256(migrationCommand),
      migrationArtifactSha256: sha256(migrationArtifact),
      newVerifierSha256: sha256(newVerifier),
    },
  });
  signedDocument(failureInjectionManifest, {
    schemaVersion: 1,
    kind: 'migration-failure-injection',
    id: 'schema-apply-fault',
    type: 'bounded-migration-fault',
    expectedExitCode: 42,
  });
  const now = Date.now();
  const id = rehearsalId ?? `${driver}-${expectedFailure ? 'failure' : 'success'}`;
  const urls =
    driver === 'postgres'
      ? {
          source: 'postgres://source.example/tixkit',
          forward: 'postgres://forward.example/tixkit',
          rollback: 'postgres://rollback.example/tixkit',
        }
      : {
          source: 'mysql://user:password@source.example/tixkit',
          forward: 'mysql://user:password@forward.example/tixkit',
          rollback: 'mysql://user:password@rollback.example/tixkit',
        };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    DB_DRIVER: driver,
    SOURCE_DATABASE_URL: urls.source,
    FORWARD_DATABASE_URL: urls.forward,
    ROLLBACK_DATABASE_URL: urls.rollback,
    FORWARD_TARGET_ID: `${driver}-forward-clone`,
    ROLLBACK_TARGET_ID: `${driver}-rollback-clone`,
    DR_OLD_VERSION_VERIFY_COMMAND: oldVerifier,
    DR_NEW_VERSION_VERIFY_COMMAND: newVerifier,
    DR_MIGRATION_COMMAND: migrationCommand,
    DR_MIGRATION_ARTIFACT: migrationArtifact,
    DR_DATABASE_IDENTITY_COMMAND: databaseIdentityCommand,
    DR_OLD_RELEASE_MANIFEST: oldReleaseManifest,
    DR_NEW_RELEASE_MANIFEST: newReleaseManifest,
    DR_REHEARSAL_ID: id,
    DR_INCIDENT_AT: new Date(now - 1_000).toISOString(),
    DR_RECOVERY_POINT_AT: new Date(now - 2_000).toISOString(),
    DR_SOURCE_RELEASE: oldRelease,
    DR_OLD_RELEASE: oldRelease,
    DR_NEW_RELEASE: newRelease,
    DR_EXPECT_FORWARD_FAILURE: expectedFailure ? '1' : '0',
    ...(expectedFailure
      ? {
          DR_FAILURE_INJECTION_MANIFEST: failureInjectionManifest,
          DR_EXPECTED_MIGRATION_EXIT_CODE: '42',
        }
      : {}),
    UNRELATED_SENTINEL_SECRET: 'must-not-leak',
    DR_MANIFEST_SIGNING_KEY: signingKey,
    DR_MANIFEST_KEY_ID: signingKeyId,
    DR_BACKUP_ENCRYPTION: 'test-kms-key',
    DR_BACKUP_DESTINATION_CLASS: 'independent',
    BACKUP_DIR: backup,
    DR_EVIDENCE_DIR: evidence,
    BACKUP_TIMESTAMP: '20260716T120000Z',
  };
  const evidencePath = join(evidence, 'migration-rehearsal.json');
  const extension = driver === 'postgres' ? 'dump' : 'sql.gz';
  const backupPath = join(backup, `tixkit-${driver}-${env.BACKUP_TIMESTAMP}.${extension}`);
  const verifierArguments = [
    '--evidence',
    evidencePath,
    '--backup',
    backupPath,
    '--backup-manifest',
    `${backupPath}.manifest.json`,
    '--forward-receipt',
    join(evidence, 'forward-restore.json'),
    '--rollback-receipt',
    join(evidence, 'rollback-restore.json'),
    '--migration-command',
    migrationCommand,
    '--migration-artifact',
    migrationArtifact,
    '--old-verifier',
    oldVerifier,
    '--new-verifier',
    newVerifier,
    '--database-identity-command',
    databaseIdentityCommand,
    '--source-identity',
    join(evidence, 'source-identity.json'),
    '--forward-identity',
    join(evidence, 'forward-identity.json'),
    '--rollback-identity',
    join(evidence, 'rollback-identity.json'),
    '--old-release-manifest',
    oldReleaseManifest,
    '--new-release-manifest',
    newReleaseManifest,
    '--expected-rehearsal-id',
    id,
    '--expected-evidence-directory-identity',
    `${statSync(evidence).dev}:${statSync(evidence).ino}:${realpathSync(evidence)}`,
  ];
  if (expectedFailure)
    verifierArguments.push('--failure-injection-manifest', failureInjectionManifest);
  return {
    directory,
    env,
    evidencePath,
    evidence,
    migrationArtifact,
    newReleaseManifest,
    oldReleaseManifest,
    oldVerifier,
    newVerifier,
    databaseIdentityCommand,
    verifierArguments,
  };
}

function runRehearsal(context) {
  return spawnSync(rehearsal, {
    cwd: root,
    env: context.env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function verify(context, argumentsOverride = context.verifierArguments) {
  return spawnSync(verifier, argumentsOverride, {
    cwd: root,
    env: context.env,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

for (const driver of ['postgres', 'mysql']) {
  for (const expectedFailure of [false, true]) {
    test(
      `${driver} produces a signed aggregate for ${expectedFailure ? 'injected failure' : 'forward success'} and restore rollback`,
      { timeout: 60_000 },
      () => {
        const context = harness(driver, { expectedFailure });
        try {
          const result = runRehearsal(context);
          assert.equal(result.status, 0, result.stderr);
          assert.match(result.stdout, /Migration rehearsal passed/u);
          const proof = JSON.parse(readFileSync(context.evidencePath, 'utf8'));
          assert.equal(proof.driver, driver);
          assert.equal(
            proof.mode,
            expectedFailure ? 'forward-failure-injected' : 'forward-success',
          );
          assert.equal(proof.oldRelease, oldRelease);
          assert.equal(proof.newRelease, newRelease);
          assert.equal(proof.steps.migration.exitCode === 0, !expectedFailure);
          assert.equal(
            proof.steps.newVersionVerification.result,
            expectedFailure ? 'not-run-expected-failure' : 'passed',
          );
          assert.equal(statSync(context.evidencePath).mode & 0o777, 0o600);
          assert.equal(lstatSync(context.evidencePath).isSymbolicLink(), false);
          const verified = verify(context);
          assert.equal(verified.status, 0, verified.stderr);
        } finally {
          rmSync(context.directory, { recursive: true, force: true });
        }
      },
    );
  }
}

test('rejects source-release mismatch and mutable or equal release labels before backup', () => {
  for (const mutate of [
    (env) => (env.DR_SOURCE_RELEASE = newRelease),
    (env) => (env.DR_NEW_RELEASE = env.DR_OLD_RELEASE),
    (env) => (env.DR_NEW_RELEASE = 'v2.0.0'),
  ]) {
    const context = harness('postgres');
    try {
      mutate(context.env);
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /release|immutable|differ/iu);
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  }
});

test('refuses pre-existing and symlink aggregate paths', () => {
  for (const kind of ['file', 'symlink']) {
    const context = harness('postgres');
    try {
      if (kind === 'file') writeFileSync(context.evidencePath, 'preexisting');
      else symlinkSync(join(context.directory, 'elsewhere'), context.evidencePath);
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing existing migration evidence path/u);
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  }
});

test('refuses an evidence directory writable by other principals', () => {
  const context = harness('postgres');
  try {
    chmodSync(context.evidence, 0o755);
    const result = runRehearsal(context);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /caller-owned and mode 0700 or stricter/u);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test(
  'verifier rejects proof tampering, replay, receipt substitution, and artifact substitution',
  { timeout: 60_000 },
  () => {
    const cases = [
      {
        name: 'proof tampering',
        mutate(context) {
          const proof = JSON.parse(readFileSync(context.evidencePath, 'utf8'));
          proof.driver = proof.driver === 'postgres' ? 'mysql' : 'postgres';
          writeFileSync(context.evidencePath, `${JSON.stringify(proof)}\n`);
        },
        pattern: /signature mismatch/u,
      },
      {
        name: 'replay under another reviewed ID',
        mutate(context) {
          const index = context.verifierArguments.indexOf('--expected-rehearsal-id');
          context.verifierArguments[index + 1] = 'different-reviewed-run';
        },
        pattern: /ID does not match/u,
      },
      {
        name: 'restore receipt substitution',
        mutate(context) {
          copyFileSync(
            join(context.evidence, 'forward-restore.json'),
            join(context.evidence, 'rollback-restore.json'),
          );
        },
        pattern: /rollback restore receipt does not match/u,
      },
      {
        name: 'migration artifact substitution',
        mutate(context) {
          writeFileSync(context.migrationArtifact, '{"migration":"substituted"}\n');
        },
        pattern: /artifact.*binding mismatch|release attestation does not bind/iu,
      },
      {
        name: 'public proof permissions',
        mutate(context) {
          chmodSync(context.evidencePath, 0o644);
        },
        pattern: /mode 0600 or stricter/u,
      },
    ];
    for (const scenario of cases) {
      const context = harness('postgres', {
        rehearsalId: `hostile-${scenario.name.toLowerCase().replaceAll(' ', '-')}`,
      });
      try {
        const result = runRehearsal(context);
        assert.equal(result.status, 0, result.stderr);
        scenario.mutate(context);
        const rejected = verify(context);
        assert.notEqual(rejected.status, 0, scenario.name);
        assert.match(rejected.stderr, scenario.pattern);
      } finally {
        rmSync(context.directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  'detects migration artifact mutation during execution after completing restore rollback',
  { timeout: 60_000 },
  () => {
    const context = harness('postgres');
    try {
      executable(
        context.env.DR_MIGRATION_COMMAND,
        '#!/usr/bin/env bash\nprintf changed >"$DR_MIGRATION_ARTIFACT"\n',
      );
      signedDocument(context.newReleaseManifest, {
        schemaVersion: 1,
        kind: 'migration-release-attestation',
        release: newRelease,
        components: {
          migrationCommandSha256: sha256(context.env.DR_MIGRATION_COMMAND),
          migrationArtifactSha256: sha256(context.migrationArtifact),
          newVerifierSha256: sha256(context.newVerifier),
        },
      });
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Executed migration artifact changed during rehearsal/u);
      assert.doesNotMatch(result.stdout, /Migration rehearsal passed/u);
      assert.equal(
        readFileSync(join(context.evidence, 'rollback-restore.json'), 'utf8').length > 0,
        true,
      );
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  },
);

test('verifier refuses a symlinked linked input', { timeout: 60_000 }, () => {
  const context = harness('postgres');
  try {
    const result = runRehearsal(context);
    assert.equal(result.status, 0, result.stderr);
    const replacement = join(context.directory, 'artifact-replacement');
    copyFileSync(context.migrationArtifact, replacement);
    rmSync(context.migrationArtifact);
    symlinkSync(replacement, context.migrationArtifact);
    const rejected = verify(context);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ELOOP|non-symlink/iu);
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test(
  'rejects aliased physical database identities even when URL strings differ',
  { timeout: 60_000 },
  () => {
    const context = harness('postgres');
    try {
      executable(
        context.databaseIdentityCommand,
        `#!/usr/bin/env bash
ROLE="\${TIXKIT_DATABASE_IDENTITY_ROLE}" DRIVER="\${DB_DRIVER}" node <<'NODE'
process.stdout.write(JSON.stringify({schemaVersion: 1, driver: process.env.DRIVER, role: process.env.ROLE,
  physicalId: 'same-cluster/database', database: 'tixkit', nonEmpty: true, stateDigest: 'c'.repeat(64)}));
NODE
`,
      );
      signedDocument(context.oldReleaseManifest, {
        schemaVersion: 1,
        kind: 'migration-release-attestation',
        release: oldRelease,
        components: {
          oldVerifierSha256: sha256(context.oldVerifier),
          databaseIdentityCommandSha256: sha256(context.databaseIdentityCommand),
        },
      });
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /distinct authenticated physical identities/u);
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  },
);

test(
  'migration timeout is never accepted as injection and rollback still runs',
  { timeout: 60_000 },
  () => {
    const context = harness('postgres', { expectedFailure: true });
    try {
      executable(context.env.DR_MIGRATION_COMMAND, "#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n");
      signedDocument(context.newReleaseManifest, {
        schemaVersion: 1,
        kind: 'migration-release-attestation',
        release: newRelease,
        components: {
          migrationCommandSha256: sha256(context.env.DR_MIGRATION_COMMAND),
          migrationArtifactSha256: sha256(context.migrationArtifact),
          newVerifierSha256: sha256(context.newVerifier),
        },
      });
      context.env.DR_MIGRATION_TIMEOUT_MS = '100';
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /timed out|exact injected failure exit code/iu);
      assert.equal(
        readFileSync(join(context.evidence, 'rollback-restore.json'), 'utf8').length > 0,
        true,
      );
      assert.equal(statSync(context.evidencePath, { throwIfNoEntry: false }), undefined);
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  },
);

test('standalone verifier rejects runner-reserved timeout exit codes', { timeout: 60_000 }, () => {
  const context = harness('postgres', { expectedFailure: true });
  try {
    const result = runRehearsal(context);
    assert.equal(result.status, 0, result.stderr);
    for (const exitCode of [124, 125]) {
      const document = JSON.parse(readFileSync(context.evidencePath, 'utf8'));
      const { signature: _signature, ...payload } = document;
      payload.steps.migration.exitCode = exitCode;
      payload.steps.migration.injection.result.exitCode = exitCode;
      signedDocument(context.evidencePath, payload);
      const rejected = verify(context);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /invalid migration rehearsal proof/u);
    }
  } finally {
    rmSync(context.directory, { recursive: true, force: true });
  }
});

test(
  'fails closed when the evidence directory identity changes during execution',
  { timeout: 60_000 },
  () => {
    const context = harness('postgres');
    const movedEvidence = `${context.evidence}-moved`;
    try {
      executable(
        context.env.DR_MIGRATION_COMMAND,
        `#!/usr/bin/env bash
mv ${JSON.stringify(context.evidence)} ${JSON.stringify(movedEvidence)}
ln -s ${JSON.stringify(movedEvidence)} ${JSON.stringify(context.evidence)}
`,
      );
      signedDocument(context.newReleaseManifest, {
        schemaVersion: 1,
        kind: 'migration-release-attestation',
        release: newRelease,
        components: {
          migrationCommandSha256: sha256(context.env.DR_MIGRATION_COMMAND),
          migrationArtifactSha256: sha256(context.migrationArtifact),
          newVerifierSha256: sha256(context.newVerifier),
        },
      });
      const result = runRehearsal(context);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /evidence directory identity changed/u);
      assert.equal(
        statSync(join(movedEvidence, 'migration-rehearsal.json'), {
          throwIfNoEntry: false,
        }),
        undefined,
      );
    } finally {
      rmSync(context.evidence, { recursive: true, force: true });
      rmSync(movedEvidence, { recursive: true, force: true });
      rmSync(context.directory, { recursive: true, force: true });
    }
  },
);
