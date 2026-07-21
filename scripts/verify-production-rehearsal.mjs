#!/usr/bin/env node

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readBoundedRegularFile } from './lib/hosted-trust-receipt.mjs';

const root = resolve(import.meta.dirname, '..');
const expectedAcknowledgements = {
  'zone-loss': 'I authorize production zone-loss fault injection and recovery',
  'dependency-loss': 'I authorize production dependency-loss fault injection and recovery',
  'release-upgrade-rollback': 'I authorize production release upgrade and application rollback',
};

const inputLimits = Object.freeze({
  evidence: 64 * 1024 * 1024,
  signature: 1_024,
  checksum: 1_024,
  publicKey: 16 * 1_024,
  expectations: 1024 * 1_024,
});

const allowedArguments = new Set([
  '--evidence',
  '--signature',
  '--checksum',
  '--public-key',
  '--expectations',
]);

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error(
      '--evidence, --signature, --checksum, --public-key, and --expectations are required exactly once',
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('production rehearsal arguments are missing, duplicated, or unsupported');
    }
    const absolute = resolve(value);
    values.set(name, resolve(realpathSync(dirname(absolute)), basename(absolute)));
  }
  return Object.fromEntries(values);
}

function requiredBytes(bytes, label, maxBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes} bytes`);
  }
  return bytes;
}

export function verifyProductionRehearsal({
  evidenceBytes,
  signatureBytes,
  checksumBytes,
  publicKeyBytes,
  expectationsBytes,
}) {
  const evidence = requiredBytes(evidenceBytes, 'production evidence', inputLimits.evidence);
  const signatureText = requiredBytes(
    signatureBytes,
    'production evidence signature',
    inputLimits.signature,
  )
    .toString()
    .trim();
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(signatureText)) {
    throw new Error('production evidence signature encoding is invalid');
  }
  const signature = Buffer.from(signatureText, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== signatureText) {
    throw new Error('production evidence signature encoding is invalid');
  }
  const checksumLine = requiredBytes(
    checksumBytes,
    'production evidence checksum',
    inputLimits.checksum,
  )
    .toString()
    .trim();
  const digest = createHash('sha256').update(evidence).digest('hex');
  if (checksumLine !== `${digest}  evidence.json`)
    throw new Error('production evidence checksum mismatch');
  const publicKey = createPublicKey(
    requiredBytes(publicKeyBytes, 'production evidence public key', inputLimits.publicKey),
  );
  if (publicKey.asymmetricKeyType !== 'ed25519')
    throw new Error('trusted public key must be Ed25519');
  if (!verify(null, evidence, publicKey, signature))
    throw new Error('production evidence signature mismatch');
  const proof = JSON.parse(evidence);
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (proof.signingKeyFingerprint !== fingerprint)
    throw new Error('production evidence signing key fingerprint mismatch');
  const schema = JSON.parse(
    readFileSync(resolve(root, 'infra/production/rehearsal-proof.schema.json'), 'utf8'),
  );
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(proof))
    throw new Error(`invalid production evidence: ${ajv.errorsText(validate.errors)}`);
  const expectations = JSON.parse(
    requiredBytes(expectationsBytes, 'production rehearsal expectations', inputLimits.expectations),
  );
  const expectationsSchema = JSON.parse(
    readFileSync(resolve(root, 'infra/production/rehearsal-expectations.schema.json'), 'utf8'),
  );
  const expectationsAjv = new Ajv({ allErrors: true, strict: true });
  addFormats(expectationsAjv);
  expectationsAjv.addSchema(schema);
  const validateExpectations = expectationsAjv.compile(expectationsSchema);
  if (!validateExpectations(expectations))
    throw new Error(
      `invalid production expectations: ${expectationsAjv.errorsText(validateExpectations.errors)}`,
    );
  if (
    proof.drillId !== expectations.drillId ||
    proof.kind !== expectations.kind ||
    proof.cluster.context !== expectations.context ||
    proof.cluster.server !== expectations.clusterServer ||
    proof.cluster.caSha256 !== expectations.clusterCaSha256 ||
    proof.cluster.systemNamespaceUid !== expectations.systemNamespaceUid ||
    proof.namespace.name !== expectations.namespaceName ||
    proof.namespace.uid !== expectations.namespaceUid ||
    proof.release !== expectations.release ||
    proof.releaseManifests.before.sha256 !== expectations.beforeReleaseSha256 ||
    proof.thresholds.adapterTimeoutSeconds !== expectations.thresholds.adapterTimeoutSeconds ||
    proof.thresholds.maxOutageSeconds !== expectations.thresholds.maxOutageSeconds ||
    proof.thresholds.maxRecoverySeconds !== expectations.thresholds.maxRecoverySeconds
  )
    throw new Error('production evidence does not match the reviewed expectations');
  if (
    (proof.kind === 'release-upgrade-rollback' &&
      proof.releaseManifests.target?.sha256 !== expectations.targetReleaseSha256) ||
    (proof.kind !== 'release-upgrade-rollback' && proof.releaseManifests.target) ||
    proof.dependency !== expectations.dependency
  )
    throw new Error('production target release evidence does not match the reviewed expectation');
  const expectedSteps = [
    ['baseline-probe', 'baselineProbe', 0, true],
    ['inject', 'inject', 0, true],
    [
      'during-probe',
      'duringProbe',
      proof.kind === 'dependency-loss' ? 1 : 0,
      proof.kind !== 'dependency-loss',
    ],
    ['recover', 'recover', 0, true],
    ['recovered-probe', 'recoveredProbe', 0, true],
  ];
  if (
    proof.acknowledgement !== expectedAcknowledgements[proof.kind] ||
    proof.steps.length !== expectedSteps.length ||
    expectedSteps.some(
      ([name, adapter, exitCode, healthy], index) =>
        proof.steps[index].name !== name ||
        proof.steps[index].adapterSha256 !== expectations.adapterSha256[adapter] ||
        proof.steps[index].exitCode !== exitCode ||
        proof.steps[index].result.healthy !== healthy,
    )
  )
    throw new Error('production evidence step semantics do not match the reviewed drill');
  const expectedPhases =
    proof.kind === 'release-upgrade-rollback'
      ? ['before', 'target', 'rollback']
      : ['before', 'recovered'];
  if (
    proof.snapshots.length !== expectedPhases.length ||
    expectedPhases.some((phase, index) => proof.snapshots[index].phase !== phase)
  )
    throw new Error('production evidence snapshot sequence does not match the reviewed drill');
  const expectedImages =
    proof.kind === 'release-upgrade-rollback'
      ? [expectations.beforeImages, expectations.targetImages, expectations.beforeImages]
      : [expectations.beforeImages, expectations.beforeImages];
  if (
    proof.snapshots.some((snapshot, index) =>
      ['api', 'worker', 'checkout', 'admin'].some(
        (component) => snapshot.images[component] !== expectedImages[index][component],
      ),
    )
  )
    throw new Error('production evidence runtime images do not match reviewed release manifests');
  if (proof.kind === 'release-upgrade-rollback') {
    const [before, target, rollback] = proof.snapshots;
    if (
      !(
        target.helm.revision > before.helm.revision && rollback.helm.revision > target.helm.revision
      )
    )
      throw new Error('production Helm upgrade and rollback revisions are not monotonic');
    for (const component of ['api', 'worker', 'checkout', 'admin'])
      if (
        !(
          target.rollouts[component].revision > before.rollouts[component].revision &&
          rollback.rollouts[component].revision > target.rollouts[component].revision
        )
      )
        throw new Error('production workload upgrade and rollback revisions are not monotonic');
  } else {
    const [before, recovered] = proof.snapshots;
    if (
      before.helm.revision !== recovered.helm.revision ||
      before.helm.manifestSha256 !== recovered.helm.manifestSha256 ||
      before.helm.valuesSha256 !== recovered.helm.valuesSha256
    )
      throw new Error('production failure recovery unexpectedly changed the Helm release');
  }
  const computedOutageSeconds =
    proof.steps.reduce((total, step) => total + step.result.outageMilliseconds, 0) / 1000;
  const minimumRecoverySeconds =
    (proof.steps[3].durationMilliseconds + proof.steps[4].durationMilliseconds) / 1000;
  if (
    proof.measurements.outageSeconds !== computedOutageSeconds ||
    proof.measurements.recoverySeconds + 0.01 < minimumRecoverySeconds
  )
    throw new Error('production evidence measurements do not match signed step results');
  if (new Date(proof.completedAt) < new Date(proof.startedAt))
    throw new Error('production evidence completion precedes start');
  if (proof.measurements.outageSeconds > proof.thresholds.maxOutageSeconds)
    throw new Error('production outage threshold exceeded');
  if (proof.measurements.recoverySeconds > proof.thresholds.maxRecoverySeconds)
    throw new Error('production recovery threshold exceeded');

  return Object.freeze({
    verified: true,
    drillId: proof.drillId,
    kind: proof.kind,
    completedAt: proof.completedAt,
    evidenceSha256: digest,
  });
}

export function verifyProductionRehearsalCli(argv = process.argv.slice(2)) {
  const values = argumentsFrom(argv);
  const evidencePath = values['--evidence'];
  const result = verifyProductionRehearsal({
    evidenceBytes: readBoundedRegularFile(
      evidencePath,
      'production evidence',
      inputLimits.evidence,
    ),
    signatureBytes: readBoundedRegularFile(
      values['--signature'],
      'production evidence signature',
      inputLimits.signature,
    ),
    checksumBytes: readBoundedRegularFile(
      values['--checksum'],
      'production evidence checksum',
      inputLimits.checksum,
    ),
    publicKeyBytes: readBoundedRegularFile(
      values['--public-key'],
      'production evidence public key',
      inputLimits.publicKey,
    ),
    expectationsBytes: readBoundedRegularFile(
      values['--expectations'],
      'production rehearsal expectations',
      inputLimits.expectations,
    ),
  });
  return Object.freeze({ ...result, evidencePath });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = verifyProductionRehearsalCli();
    process.stdout.write(`${result.evidencePath}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
