#!/usr/bin/env node

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = resolve(import.meta.dirname, '..');
const sha256Pattern = /^[a-f0-9]{64}$/u;
const releasePattern = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,191}@sha256:[a-f0-9]{64}$/u;

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return process.argv[index + 1];
}

function pathOption(name) {
  return resolve(option(name));
}

function safeRead(path, { privateFile = false } = {}) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${path} must be a regular non-symlink file`);
    if (privateFile && (before.mode & 0o077) !== 0)
      throw new Error(`${path} must be mode 0600 or stricter`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error(`${path} changed while it was being read`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function safeJson(path, options) {
  return JSON.parse(safeRead(path, options).toString('utf8'));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(path) {
  return digest(safeRead(path));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name, { nullable = false } = {}) {
  const raw = process.env[name];
  if (nullable && raw === 'null') return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw ?? '')) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 2_147_483_647)
    throw new Error(`${name} is outside the supported range`);
  return value;
}

function hmacPayload(payload, key) {
  return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
}

function validateSignedDocument(document, keyId, key, label) {
  const { signature, ...payload } = document;
  if (
    signature?.algorithm !== 'hmac-sha256' ||
    signature.keyId !== keyId ||
    !sha256Pattern.test(signature.value ?? '')
  )
    throw new Error(`${label} signature metadata mismatch`);
  const expected = Buffer.from(hmacPayload(payload, key), 'hex');
  const actual = Buffer.from(signature.value, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error(`${label} signature mismatch`);
  return payload;
}

function validateSchema(proof) {
  const schema = JSON.parse(
    readFileSync(resolve(root, 'infra/production/migration-rehearsal-proof.schema.json'), 'utf8'),
  );
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(proof))
    throw new Error(`invalid migration rehearsal proof: ${ajv.errorsText(validate.errors)}`);
}

function linkedInputs() {
  const paths = {
    evidencePath: pathOption('evidence'),
    backupPath: pathOption('backup'),
    backupManifestPath: pathOption('backup-manifest'),
    forwardReceiptPath: pathOption('forward-receipt'),
    rollbackReceiptPath: pathOption('rollback-receipt'),
    migrationCommandPath: pathOption('migration-command'),
    migrationArtifactPath: pathOption('migration-artifact'),
    oldVerifierPath: pathOption('old-verifier'),
    newVerifierPath: pathOption('new-verifier'),
    databaseIdentityCommandPath: pathOption('database-identity-command'),
    sourceIdentityPath: pathOption('source-identity'),
    forwardIdentityPath: pathOption('forward-identity'),
    rollbackIdentityPath: pathOption('rollback-identity'),
    oldReleaseManifestPath: pathOption('old-release-manifest'),
    newReleaseManifestPath: pathOption('new-release-manifest'),
    expectedRehearsalId: option('expected-rehearsal-id'),
    expectedEvidenceDirectoryIdentity: option('expected-evidence-directory-identity'),
  };
  if (process.argv.includes('--failure-injection-manifest'))
    paths.failureInjectionManifestPath = pathOption('failure-injection-manifest');
  return paths;
}

function assertEvidenceDirectoryIdentity(paths) {
  const directory = dirname(paths.evidencePath);
  const stat = lstatSync(directory);
  const actual = `${stat.dev}:${stat.ino}:${directory}`;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    actual !== paths.expectedEvidenceDirectoryIdentity
  )
    throw new Error('migration evidence directory identity changed');
}

function validateLinkedEvidence(proof, paths, keyId, key) {
  if (proof.rehearsalId !== paths.expectedRehearsalId)
    throw new Error('migration rehearsal ID does not match the reviewed invocation');
  if (!releasePattern.test(proof.oldRelease) || !releasePattern.test(proof.newRelease))
    throw new Error('migration releases must be immutable sha256 references');
  if (proof.oldRelease === proof.newRelease)
    throw new Error('migration old and new releases must differ');

  const oldReleaseManifest = validateSignedDocument(
    safeJson(paths.oldReleaseManifestPath),
    keyId,
    key,
    'old release manifest',
  );
  const newReleaseManifest = validateSignedDocument(
    safeJson(paths.newReleaseManifestPath),
    keyId,
    key,
    'new release manifest',
  );
  if (
    oldReleaseManifest.schemaVersion !== 1 ||
    oldReleaseManifest.kind !== 'migration-release-attestation' ||
    oldReleaseManifest.release !== proof.oldRelease ||
    oldReleaseManifest.components?.oldVerifierSha256 !== fileDigest(paths.oldVerifierPath) ||
    oldReleaseManifest.components?.databaseIdentityCommandSha256 !==
      fileDigest(paths.databaseIdentityCommandPath) ||
    Object.keys(oldReleaseManifest.components ?? {}).length !== 2
  )
    throw new Error('old release attestation does not bind the old verifier');
  if (
    newReleaseManifest.schemaVersion !== 1 ||
    newReleaseManifest.kind !== 'migration-release-attestation' ||
    newReleaseManifest.release !== proof.newRelease ||
    newReleaseManifest.components?.newVerifierSha256 !== fileDigest(paths.newVerifierPath) ||
    newReleaseManifest.components?.migrationCommandSha256 !==
      fileDigest(paths.migrationCommandPath) ||
    newReleaseManifest.components?.migrationArtifactSha256 !==
      fileDigest(paths.migrationArtifactPath) ||
    Object.keys(newReleaseManifest.components ?? {}).length !== 3
  )
    throw new Error('new release attestation does not bind the migration inputs and verifier');
  if (
    proof.artifacts.oldReleaseManifestSha256 !== fileDigest(paths.oldReleaseManifestPath) ||
    proof.artifacts.newReleaseManifestSha256 !== fileDigest(paths.newReleaseManifestPath)
  )
    throw new Error('release attestation digest mismatch');

  const identityPaths = {
    source: paths.sourceIdentityPath,
    forward: paths.forwardIdentityPath,
    rollback: paths.rollbackIdentityPath,
  };
  const physicalIdentities = new Set();
  const stateDigests = new Set();
  for (const [role, path] of Object.entries(identityPaths)) {
    const bytes = safeRead(path, { privateFile: true });
    const identity = JSON.parse(bytes.toString('utf8'));
    const expected = proof.databaseIdentities[role];
    if (
      identity.schemaVersion !== 1 ||
      identity.driver !== proof.driver ||
      identity.role !== role ||
      identity.nonEmpty !== true ||
      !sha256Pattern.test(identity.stateDigest ?? '') ||
      expected?.evidenceSha256 !== digest(bytes) ||
      JSON.stringify(expected) !== JSON.stringify({ ...identity, evidenceSha256: digest(bytes) })
    )
      throw new Error(`database identity evidence mismatch for ${role}`);
    physicalIdentities.add(`${identity.physicalId}/${identity.database}`);
    stateDigests.add(identity.stateDigest);
  }
  if (physicalIdentities.size !== 3 || stateDigests.size !== 1)
    throw new Error('database identities are not physically distinct and reconciled');

  const backup = safeRead(paths.backupPath);
  const manifestDocument = safeJson(paths.backupManifestPath);
  const manifest = validateSignedDocument(manifestDocument, keyId, key, 'backup manifest');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== proof.driver ||
    manifest.sha256 !== digest(backup) ||
    manifest.sourceRelease !== proof.oldRelease ||
    manifest.artifact !== basename(paths.backupPath) ||
    manifest.destinationClass !== 'independent' ||
    !Number.isFinite(Date.parse(manifest.recoveryPointAt)) ||
    manifest.rehearsalId !== proof.rehearsalId ||
    manifest.rehearsalNonce !== proof.runNonce
  )
    throw new Error('backup manifest does not match the migration rehearsal');

  const oldVerifierSha256 = fileDigest(paths.oldVerifierPath);
  const receipts = [
    ['forward', paths.forwardReceiptPath, proof.targets.forward, proof.steps.forwardRestore],
    ['rollback', paths.rollbackReceiptPath, proof.targets.rollback, proof.steps.rollbackRestore],
  ];
  for (const [label, path, targetId, step] of receipts) {
    const receiptDocument = safeJson(path);
    const receipt = validateSignedDocument(receiptDocument, keyId, key, `${label} restore receipt`);
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== proof.driver ||
      receipt.verification !== 'command-completed' ||
      receipt.artifactSha256 !== manifest.sha256 ||
      receipt.sourceRelease !== proof.oldRelease ||
      receipt.targetRelease !== proof.oldRelease ||
      receipt.restoreTargetId !== targetId ||
      receipt.recoveryPointAt !== manifest.recoveryPointAt ||
      receipt.verifierSha256 !== oldVerifierSha256 ||
      receipt.rehearsalId !== proof.rehearsalId ||
      receipt.rehearsalNonce !== proof.runNonce ||
      receipt.rehearsalPhase !== label ||
      (label === 'forward' && receipt.predecessorSha256 !== null) ||
      (label === 'rollback' &&
        receipt.predecessorSha256 !== fileDigest(paths.forwardReceiptPath)) ||
      step.targetId !== targetId ||
      step.receiptSha256 !== fileDigest(path) ||
      step.verifierSha256 !== oldVerifierSha256 ||
      step.result !== 'passed'
    )
      throw new Error(`${label} restore receipt does not match the migration rehearsal`);
  }
  if (proof.steps.forwardRestore.receiptSha256 === proof.steps.rollbackRestore.receiptSha256)
    throw new Error('forward and rollback restore receipts must be distinct');

  if (
    proof.artifacts.backupSha256 !== manifest.sha256 ||
    proof.artifacts.backupManifestSha256 !== fileDigest(paths.backupManifestPath) ||
    proof.artifacts.migrationCommandSha256 !== fileDigest(paths.migrationCommandPath) ||
    proof.artifacts.migrationArtifactSha256 !== fileDigest(paths.migrationArtifactPath) ||
    proof.steps.newVersionVerification.verifierSha256 !== fileDigest(paths.newVerifierPath)
  )
    throw new Error('migration command, artifact, verifier, or backup binding mismatch');

  const expectedFailure = proof.mode === 'forward-failure-injected';
  const migration = proof.steps.migration;
  const newVerification = proof.steps.newVersionVerification;
  if (
    (expectedFailure &&
      (migration.exitCode === 0 ||
        migration.expectedOutcome !== 'failure' ||
        migration.result !== 'failed-as-injected' ||
        newVerification.exitCode !== null ||
        newVerification.result !== 'not-run-expected-failure')) ||
    (!expectedFailure &&
      (migration.exitCode !== 0 ||
        migration.expectedOutcome !== 'success' ||
        migration.result !== 'passed' ||
        newVerification.exitCode !== 0 ||
        newVerification.result !== 'passed'))
  )
    throw new Error('migration execution semantics do not match the rehearsal mode');
  if (expectedFailure) {
    if (!paths.failureInjectionManifestPath)
      throw new Error('failure injection manifest is required');
    const injection = validateSignedDocument(
      safeJson(paths.failureInjectionManifestPath),
      keyId,
      key,
      'failure injection manifest',
    );
    if (
      migration.exitCode < 1 ||
      migration.exitCode > 123 ||
      injection.schemaVersion !== 1 ||
      injection.kind !== 'migration-failure-injection' ||
      injection.id !== migration.injection?.id ||
      injection.type !== migration.injection?.type ||
      injection.expectedExitCode !== migration.exitCode ||
      fileDigest(paths.failureInjectionManifestPath) !== migration.injection.manifestSha256 ||
      migration.injection.challengeSha256 !== digest(migration.injection.challenge) ||
      migration.injection.result?.schemaVersion !== 1 ||
      migration.injection.result.id !== injection.id ||
      migration.injection.result.type !== injection.type ||
      migration.injection.result.challenge !== migration.injection.challenge ||
      migration.injection.result.exitCode !== migration.exitCode ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(migration.injection.result.observedPoint ?? '')
    )
      throw new Error('authenticated failure injection result mismatch');
  } else if (migration.injection !== null || paths.failureInjectionManifestPath) {
    throw new Error('success proof must not contain failure injection evidence');
  }

  const recoveryPoint = Date.parse(proof.timing.recoveryPointAt);
  const incident = Date.parse(proof.timing.incidentAt);
  const started = Date.parse(proof.timing.startedAt);
  const completed = Date.parse(proof.timing.completedAt);
  const forwardReceipt = safeJson(paths.forwardReceiptPath);
  const rollbackReceipt = safeJson(paths.rollbackReceiptPath);
  const backupCompleted = Date.parse(manifest.completedAt);
  const forwardStarted = Date.parse(forwardReceipt.restoreStartedAt);
  const forwardCompleted = Date.parse(forwardReceipt.restoreCompletedAt);
  const migrationStarted = Date.parse(migration.startedAt);
  const migrationCompleted = Date.parse(migration.completedAt);
  const verificationStarted =
    newVerification.startedAt === null ? migrationCompleted : Date.parse(newVerification.startedAt);
  const verificationCompleted =
    newVerification.completedAt === null
      ? migrationCompleted
      : Date.parse(newVerification.completedAt);
  const rollbackStarted = Date.parse(rollbackReceipt.restoreStartedAt);
  const rollbackCompleted = Date.parse(rollbackReceipt.restoreCompletedAt);
  if (
    proof.timing.recoveryPointAt !== manifest.recoveryPointAt ||
    ![recoveryPoint, incident, started, completed].every(Number.isFinite) ||
    incident < recoveryPoint ||
    incident > started ||
    completed < started ||
    incident > completed ||
    proof.timing.measuredRpoSeconds !== Math.floor((incident - recoveryPoint) / 1000) ||
    proof.timing.measuredRtoSeconds !== Math.max(0, Math.ceil((completed - incident) / 1000)) ||
    proof.timing.durationMilliseconds !== Math.max(0, completed - started) ||
    ![
      backupCompleted,
      forwardStarted,
      forwardCompleted,
      migrationStarted,
      migrationCompleted,
      verificationStarted,
      verificationCompleted,
      rollbackStarted,
      rollbackCompleted,
    ].every(Number.isFinite) ||
    !(
      started <= backupCompleted &&
      backupCompleted <= forwardStarted &&
      forwardStarted <= forwardCompleted &&
      forwardCompleted <= migrationStarted &&
      migrationStarted <= migrationCompleted &&
      migrationCompleted <= verificationStarted &&
      verificationStarted <= verificationCompleted &&
      verificationCompleted <= rollbackStarted &&
      rollbackStarted <= rollbackCompleted &&
      rollbackCompleted <= completed
    )
  )
    throw new Error('migration rehearsal timing is inconsistent');
}

function writeReserved(paths, reservationToken, bytes) {
  const path = paths.evidencePath;
  assertEvidenceDirectoryIdentity(paths);
  const reservationPath = `${path}.in-progress`;
  const reservation = safeRead(reservationPath).toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(reservationToken) || reservation !== reservationToken)
    throw new Error('migration evidence reservation token mismatch');
  let descriptor;
  try {
    assertEvidenceDirectoryIdentity(paths);
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertEvidenceDirectoryIdentity(paths);
  unlinkSync(reservationPath);
}

function createProof(paths, keyId, key) {
  const driver = requiredEnvironment('DR_PROOF_DRIVER');
  const mode = requiredEnvironment('DR_PROOF_MODE');
  const oldRelease = requiredEnvironment('DR_OLD_RELEASE');
  const newRelease = requiredEnvironment('DR_NEW_RELEASE');
  if (!['postgres', 'mysql'].includes(driver)) throw new Error('DR_PROOF_DRIVER is invalid');
  if (!['forward-success', 'forward-failure-injected'].includes(mode))
    throw new Error('DR_PROOF_MODE is invalid');
  if (requiredEnvironment('DR_SOURCE_RELEASE') !== oldRelease)
    throw new Error('DR_SOURCE_RELEASE must equal DR_OLD_RELEASE');
  if (
    !releasePattern.test(oldRelease) ||
    !releasePattern.test(newRelease) ||
    oldRelease === newRelease
  )
    throw new Error('old and new releases must be distinct immutable sha256 references');

  const forwardReceipt = safeJson(paths.forwardReceiptPath);
  const rollbackReceipt = safeJson(paths.rollbackReceiptPath);
  const manifest = safeJson(paths.backupManifestPath);
  const startedAt = requiredEnvironment('DR_PROOF_STARTED_AT');
  const completedAt = requiredEnvironment('DR_PROOF_COMPLETED_AT');
  const incidentAt = requiredEnvironment('DR_INCIDENT_AT');
  const expectedFailure = mode === 'forward-failure-injected';
  const migrationExitCode = integerEnvironment('DR_MIGRATION_EXIT_CODE');
  const newVerifierExitCode = integerEnvironment('DR_NEW_VERIFIER_EXIT_CODE', {
    nullable: true,
  });
  const payload = {
    schemaVersion: 'tixkit-migration-rehearsal-proof-v1',
    status: 'passed',
    kind: 'restore-based-migration-rollback',
    rehearsalId: paths.expectedRehearsalId,
    runNonce: requiredEnvironment('DR_REHEARSAL_NONCE'),
    driver,
    mode,
    oldRelease,
    newRelease,
    targets: {
      forward: requiredEnvironment('FORWARD_TARGET_ID'),
      rollback: requiredEnvironment('ROLLBACK_TARGET_ID'),
    },
    artifacts: {
      backupSha256: manifest.sha256,
      backupManifestSha256: fileDigest(paths.backupManifestPath),
      migrationCommandSha256: fileDigest(paths.migrationCommandPath),
      migrationArtifactSha256: fileDigest(paths.migrationArtifactPath),
      databaseIdentityCommandSha256: fileDigest(paths.databaseIdentityCommandPath),
      oldReleaseManifestSha256: fileDigest(paths.oldReleaseManifestPath),
      newReleaseManifestSha256: fileDigest(paths.newReleaseManifestPath),
    },
    databaseIdentities: JSON.parse(requiredEnvironment('DR_DATABASE_IDENTITIES')),
    steps: {
      forwardRestore: {
        targetId: requiredEnvironment('FORWARD_TARGET_ID'),
        receiptSha256: fileDigest(paths.forwardReceiptPath),
        verifierSha256: forwardReceipt.verifierSha256,
        result: 'passed',
      },
      migration: {
        exitCode: migrationExitCode,
        expectedOutcome: expectedFailure ? 'failure' : 'success',
        result: expectedFailure ? 'failed-as-injected' : 'passed',
        durationMilliseconds: integerEnvironment('DR_MIGRATION_DURATION_MS'),
        stdoutSha256: requiredEnvironment('DR_MIGRATION_STDOUT_SHA256'),
        stderrSha256: requiredEnvironment('DR_MIGRATION_STDERR_SHA256'),
        startedAt: requiredEnvironment('DR_MIGRATION_STARTED_AT'),
        completedAt: requiredEnvironment('DR_MIGRATION_COMPLETED_AT'),
        injection: expectedFailure
          ? JSON.parse(requiredEnvironment('DR_FAILURE_INJECTION_RESULT'))
          : null,
      },
      newVersionVerification: {
        verifierSha256: fileDigest(paths.newVerifierPath),
        exitCode: newVerifierExitCode,
        result: expectedFailure ? 'not-run-expected-failure' : 'passed',
        durationMilliseconds: integerEnvironment('DR_NEW_VERIFIER_DURATION_MS'),
        stdoutSha256: requiredEnvironment('DR_NEW_VERIFIER_STDOUT_SHA256'),
        stderrSha256: requiredEnvironment('DR_NEW_VERIFIER_STDERR_SHA256'),
        startedAt:
          requiredEnvironment('DR_NEW_VERIFIER_STARTED_AT') === 'null'
            ? null
            : requiredEnvironment('DR_NEW_VERIFIER_STARTED_AT'),
        completedAt:
          requiredEnvironment('DR_NEW_VERIFIER_COMPLETED_AT') === 'null'
            ? null
            : requiredEnvironment('DR_NEW_VERIFIER_COMPLETED_AT'),
      },
      rollbackRestore: {
        targetId: requiredEnvironment('ROLLBACK_TARGET_ID'),
        receiptSha256: fileDigest(paths.rollbackReceiptPath),
        verifierSha256: rollbackReceipt.verifierSha256,
        result: 'passed',
      },
    },
    timing: {
      recoveryPointAt: manifest.recoveryPointAt,
      incidentAt: new Date(incidentAt).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      measuredRpoSeconds: Math.floor(
        (Date.parse(incidentAt) - Date.parse(manifest.recoveryPointAt)) / 1000,
      ),
      measuredRtoSeconds: Math.max(
        0,
        Math.ceil((Date.parse(completedAt) - Date.parse(incidentAt)) / 1000),
      ),
      durationMilliseconds: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    },
  };
  const proof = {
    ...payload,
    signature: {
      algorithm: 'hmac-sha256',
      keyId,
      value: hmacPayload(payload, key),
    },
  };
  validateSchema(proof);
  validateLinkedEvidence(proof, paths, keyId, key);
  writeReserved(
    paths,
    requiredEnvironment('DR_EVIDENCE_RESERVATION_TOKEN'),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
}

try {
  const paths = linkedInputs();
  assertEvidenceDirectoryIdentity(paths);
  const key = requiredEnvironment('DR_MANIFEST_SIGNING_KEY');
  const keyId = requiredEnvironment('DR_MANIFEST_KEY_ID');
  if (process.argv.includes('--create')) createProof(paths, keyId, key);
  const proofDocument = safeJson(paths.evidencePath, { privateFile: true });
  validateSchema(proofDocument);
  const proof = validateSignedDocument(proofDocument, keyId, key, 'migration rehearsal proof');
  validateLinkedEvidence({ ...proof, signature: proofDocument.signature }, paths, keyId, key);
  assertEvidenceDirectoryIdentity(paths);
  process.stdout.write(`${paths.evidencePath}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
