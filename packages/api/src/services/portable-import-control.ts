import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { ImportRepository, type Database } from '@tixkit/db';
import {
  canonicalPortableJson,
  createPortableDryRunReceipt,
  parsePortableJson,
  portableManifestSha256,
  verifyPortableDryRunReceipt,
  type PortableBundleManifest,
  type PortableDryRunReceipt,
  type PortabilityPreflightResult,
} from '@tixkit/portability';

export interface PortableDryRunAttestationConfiguration {
  keyId: string;
  privateKey: KeyObject;
  trustedPublicKeys: ReadonlyMap<string, KeyObject>;
}

export function portableDryRunAttestationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PortableDryRunAttestationConfiguration {
  if (environment.TIXKIT_OPERATING_MODEL?.trim() !== 'self-hosted')
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_OPERATING_MODEL_INVALID');
  const keyId = environment.PORTABILITY_DRY_RUN_SIGNING_KEY_ID?.trim() ?? '';
  const encoded = environment.PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(keyId))
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_KEY_ID_INVALID');
  if (!encoded?.trim()) throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_REQUIRED');
  let privateKey: KeyObject;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded)
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
    privateKey = createPrivateKey(bytes.toString('utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
  } catch {
    throw new Error('PORTABLE_DRY_RUN_ATTESTATION_PRIVATE_KEY_INVALID');
  }
  const trustedPublicKeys = new Map<string, KeyObject>([[keyId, createPublicKey(privateKey)]]);
  const serializedTrust = environment.PORTABILITY_DRY_RUN_TRUSTED_PUBLIC_KEYS;
  if (serializedTrust) {
    try {
      const parsed = JSON.parse(serializedTrust) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid trust object');
      for (const [trustedKeyId, pem] of Object.entries(parsed)) {
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(trustedKeyId) || typeof pem !== 'string')
          throw new Error('invalid trust entry');
        const publicKey = createPublicKey(pem);
        if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid trust key');
        trustedPublicKeys.set(trustedKeyId, publicKey);
      }
    } catch {
      throw new Error('PORTABLE_DRY_RUN_ATTESTATION_TRUST_INVALID');
    }
  }
  return { keyId, privateKey, trustedPublicKeys };
}

export async function attestPortableDryRun(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  jobId: string;
  inputSha256: string;
  createdBy: string;
  attestation: PortableDryRunAttestationConfiguration;
  checkedAt?: string;
}) {
  if (!/^[a-f0-9]{64}$/u.test(input.inputSha256))
    throw new Error('PORTABLE_DRY_RUN_INPUT_DIGEST_INVALID');
  const repository = new ImportRepository(input.db);
  const evidence = await repository.findPortablePreflight(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!evidence) throw new Error('PORTABLE_IMPORT_PREFLIGHT_NOT_FOUND');
  const manifest = parsePortableJson(evidence.manifest_json) as PortableBundleManifest;
  const preflight = parsePortableJson(evidence.preflight_json) as PortabilityPreflightResult;
  const expectedAssets = manifest.assets.map(({ portableId, sha256 }) => ({
    portableId,
    sha256,
  }));
  if (
    portableManifestSha256(manifest) !== evidence.manifest_sha256 ||
    manifest.bundleId !== evidence.bundle_id ||
    manifest.source.deploymentId !== evidence.source_deployment_id ||
    manifest.lineage.toChangeCursor !== evidence.source_change_cursor ||
    !preflight.compatible ||
    preflight.operationId !== evidence.operation_id ||
    canonicalPortableJson(manifest.entityCounts) !== evidence.expected_counts ||
    canonicalPortableJson(expectedAssets) !== evidence.expected_assets ||
    canonicalPortableJson(preflight.requiredRebindings) !== evidence.required_rebindings
  )
    throw new Error('PORTABLE_IMPORT_PREFLIGHT_EVIDENCE_INVALID');
  const files = await repository.listFiles(input.tenantId, input.organizationId, input.jobId);
  if (
    files.length !== 1 ||
    files[0]!.sha256 !== evidence.artifact_sha256 ||
    files[0]!.status !== 'ready'
  )
    throw new Error('PORTABLE_IMPORT_ARTIFACT_EVIDENCE_INVALID');

  const validateReceipt = (stored: {
    receipt_json: string;
    receipt_sha256: string;
    input_sha256: string;
    operation_id: string;
    manifest_sha256: string;
  }) => {
    const { receipt_json: receiptJson, receipt_sha256: receiptSha256 } = stored;
    const receipt = parsePortableJson(receiptJson) as PortableDryRunReceipt;
    const trustedKey = input.attestation.trustedPublicKeys.get(receipt.attestationKeyId);
    if (
      createHash('sha256').update(receiptJson).digest('hex') !== receiptSha256 ||
      !trustedKey ||
      !verifyPortableDryRunReceipt(receipt, trustedKey) ||
      receipt.operationId !== evidence.operation_id ||
      receipt.manifestSha256 !== evidence.manifest_sha256 ||
      receipt.destinationId !== evidence.destination_id ||
      receipt.sourceChangeCursor !== evidence.source_change_cursor ||
      receipt.artifactSha256 !== evidence.artifact_sha256 ||
      receipt.inputSha256 !== stored.input_sha256 ||
      stored.operation_id !== evidence.operation_id ||
      stored.manifest_sha256 !== evidence.manifest_sha256 ||
      canonicalPortableJson(receipt.requiredRebindings) !==
        canonicalPortableJson(preflight.requiredRebindings.map(({ portableId }) => portableId))
    )
      throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_INVALID');
    if (receipt.inputSha256 !== input.inputSha256)
      throw new Error('PORTABLE_IMPORT_DRY_RUN_INPUT_CHANGED');
    return { receipt, receiptSha256 };
  };
  const existingReceipt = await repository.findPortableDryRunReceipt(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (existingReceipt) return validateReceipt(existingReceipt);
  const receipt = createPortableDryRunReceipt(
    preflight,
    manifest,
    evidence.destination_id,
    input.inputSha256,
    evidence.artifact_sha256,
    input.checkedAt ?? new Date(evidence.created_at).toISOString(),
    input.attestation.keyId,
    input.attestation.privateKey,
  );
  const receiptJson = canonicalPortableJson(receipt);
  const receiptSha256 = createHash('sha256').update(receiptJson).digest('hex');
  await repository.recordPortableDryRunReceipt({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    jobId: input.jobId,
    operationId: evidence.operation_id,
    manifestSha256: evidence.manifest_sha256,
    inputSha256: input.inputSha256,
    receiptSha256,
    receiptJson,
    createdBy: input.createdBy,
  });
  const persisted = await repository.findPortableDryRunReceipt(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  if (!persisted) throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_NOT_FOUND');
  return validateReceipt(persisted);
}
