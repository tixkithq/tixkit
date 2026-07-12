import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyLike } from 'node:crypto';
import {
  canonicalPortableJson,
  portableManifestSha256,
  portableOperationId,
  validatePortableManifest,
  verifyPortableMediaAttestation,
  verifyPortablePayloadAttestation,
  verifyPortableManifestSignature,
  type PortableBundleManifest,
  type SignedPortableBundle,
} from './manifest.js';

export interface PortabilityDestination {
  deploymentId: string;
  apiVersion: string;
  dataSchemaVersion: string;
  capabilities: string[];
  entitlements: string[];
  availableStorageBytes: number;
  acceptedSourceOperatingModels: Array<'cloud' | 'self-hosted'>;
}

export interface PortabilityPreflightResult {
  compatible: boolean;
  errors: string[];
  requiredRebindings: PortableBundleManifest['rebindings'];
  operationId: string;
}

export interface TrustedPortablePayloadPolicy {
  schemaId: string;
  schemaSha256: string;
  policySha256: string;
  scannerId: string;
  keyId: string;
}

export interface TrustedPortableMediaPolicy {
  policySha256: string;
  scannerId: string;
  keyId: string;
  detectedMediaTypes: string[];
}

function versionParts(value: string): number[] | null {
  if (!/^\d+(?:[.-]\d+)*$/u.test(value)) return null;
  const parts = value.split(/[.-]/u).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersion(left: string, right: string): number | null {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function versionWithin(value: string, minimum: string, maximum: string): boolean {
  const fromMinimum = compareVersion(value, minimum);
  const toMaximum = compareVersion(value, maximum);
  return fromMinimum !== null && toMaximum !== null && fromMinimum >= 0 && toMaximum <= 0;
}

function evaluatePortableImport(
  manifest: PortableBundleManifest,
  destination: PortabilityDestination,
): PortabilityPreflightResult {
  validatePortableManifest(manifest);
  const errors: string[] = [];
  if (!destination.acceptedSourceOperatingModels.includes(manifest.source.operatingModel)) {
    errors.push(`source operating model ${manifest.source.operatingModel} is unsupported`);
  }
  if (
    !versionWithin(
      destination.apiVersion,
      manifest.compatibility.minimumApiVersion,
      manifest.compatibility.maximumApiVersion,
    )
  ) {
    errors.push(`destination API version ${destination.apiVersion} is incompatible`);
  }
  if (
    !versionWithin(
      destination.dataSchemaVersion,
      manifest.compatibility.minimumDataSchemaVersion,
      manifest.compatibility.maximumDataSchemaVersion,
    )
  ) {
    errors.push(`destination data schema ${destination.dataSchemaVersion} is incompatible`);
  }
  for (const capability of manifest.compatibility.requiredCapabilities) {
    if (!destination.capabilities.includes(capability))
      errors.push(`missing capability: ${capability}`);
  }
  for (const entitlement of manifest.compatibility.requiredEntitlements) {
    if (!destination.entitlements.includes(entitlement))
      errors.push(`missing entitlement: ${entitlement}`);
  }
  const requiredBytes = manifest.files.reduce((total, file) => total + file.bytes, 0);
  if (
    !Number.isSafeInteger(destination.availableStorageBytes) ||
    destination.availableStorageBytes < requiredBytes
  ) {
    errors.push(`insufficient destination storage: requires ${requiredBytes} bytes`);
  }
  return {
    compatible: errors.length === 0,
    errors,
    requiredRebindings: manifest.rebindings.filter(({ required }) => required),
    operationId: portableOperationId(manifest, destination.deploymentId),
  };
}

export function verifyAndPreflightPortableImport(
  envelope: SignedPortableBundle,
  destination: PortabilityDestination,
  trustedKeys: ReadonlyMap<string, KeyLike>,
  trustedPayloadKeys: ReadonlyMap<string, KeyLike>,
  trustedPayloadPolicies: ReadonlyMap<string, TrustedPortablePayloadPolicy>,
  trustedMediaKeys: ReadonlyMap<string, KeyLike>,
  trustedMediaPolicies: ReadonlyMap<string, TrustedPortableMediaPolicy>,
): PortabilityPreflightResult {
  const trustedKey = trustedKeys.get(envelope.signature.keyId);
  if (!trustedKey) throw new Error('portable bundle signing key is not trusted');
  if (!verifyPortableManifestSignature(envelope.manifest, envelope.signature, trustedKey)) {
    throw new Error('portable bundle signature or manifest is invalid');
  }
  if (
    envelope.manifest.payloadSafety.scannedFiles.some((attestation) => {
      const policy = trustedPayloadPolicies.get(attestation.section);
      return (
        !verifyPortablePayloadAttestation(attestation, trustedPayloadKeys) ||
        !policy ||
        policy.schemaId !== attestation.schemaId ||
        policy.schemaSha256 !== attestation.schemaSha256 ||
        policy.policySha256 !== attestation.policySha256 ||
        policy.scannerId !== attestation.scannerId ||
        policy.keyId !== attestation.keyId
      );
    })
  ) {
    throw new Error('portable bundle payload safety attestation is not trusted');
  }
  if (
    envelope.manifest.assetSafety.scannedFiles.some((attestation) => {
      const policy = trustedMediaPolicies.get(attestation.scannerId);
      return (
        !verifyPortableMediaAttestation(attestation, trustedMediaKeys) ||
        !policy ||
        policy.policySha256 !== attestation.policySha256 ||
        policy.keyId !== attestation.keyId ||
        !policy.detectedMediaTypes.includes(attestation.detectedMediaType)
      );
    })
  ) {
    throw new Error('portable bundle media safety attestation is not trusted');
  }
  return evaluatePortableImport(envelope.manifest, destination);
}

export interface PortableImportCheckpoint {
  operationId: string;
  manifestSha256: string;
  completedFiles: Array<{ path: string; sha256: string }>;
  lastSourceChangeCursor: string;
  destinationId: string;
  dryRunReceiptSha256: string;
  mappings: Array<{
    filePath: string;
    section: PortableBundleManifest['files'][number]['section'];
    sourcePortableId: string;
    destinationId: string;
    provenanceSha256: string;
  }>;
  completedRebindings: Array<{
    portableId: string;
    destinationReference: string;
    provenanceSha256: string;
  }>;
  status: 'dry-run' | 'importing' | 'rebind-required' | 'reconciling' | 'complete' | 'failed';
}

type PortableIdentityMapping = PortableImportCheckpoint['mappings'][number];

export function portableMappingProvenanceSha256(
  mapping: Omit<PortableIdentityMapping, 'provenanceSha256'>,
): string {
  return createHash('sha256')
    .update(
      `${JSON.stringify({
        destinationId: mapping.destinationId,
        filePath: mapping.filePath,
        section: mapping.section,
        sourcePortableId: mapping.sourcePortableId,
      })}\n`,
    )
    .digest('hex');
}

export function portableRebindingProvenanceSha256(input: {
  portableId: string;
  destinationReference: string;
}): string {
  return createHash('sha256')
    .update(
      `${JSON.stringify({
        destinationReference: input.destinationReference,
        portableId: input.portableId,
      })}\n`,
    )
    .digest('hex');
}

export function portableImportControlInputSha256(input: {
  configuration: unknown;
  files: Array<{ id: string; sha256: string; byteSize: string }>;
  mappings: Array<{ id: string; version: number; mapping: unknown }>;
  rows: Array<{ id: string; source: unknown; normalized: unknown }>;
}): string {
  const hash = (value: unknown) =>
    createHash('sha256').update(canonicalPortableJson(value)).digest('hex');
  return hash({
    configuration: input.configuration,
    files: input.files,
    mappings: input.mappings.map((mapping) => ({
      id: mapping.id,
      version: mapping.version,
      mapping: hash(mapping.mapping),
    })),
    rows: input.rows.map((row) => ({
      id: row.id,
      source: hash(row.source),
      normalized: hash(row.normalized),
    })),
  });
}

export interface PortableDryRunReceipt {
  operationId: string;
  manifestSha256: string;
  destinationId: string;
  sourceChangeCursor: string;
  inputSha256: string;
  artifactSha256: string;
  checkedAt: string;
  compatible: true;
  requiredRebindings: string[];
  sha256: string;
  attestationKeyId: string;
  signature: string;
}

export function portableDryRunReceiptPayload(
  receipt: Omit<PortableDryRunReceipt, 'sha256' | 'attestationKeyId' | 'signature'>,
): string {
  return `${JSON.stringify({
    checkedAt: receipt.checkedAt,
    compatible: receipt.compatible,
    destinationId: receipt.destinationId,
    manifestSha256: receipt.manifestSha256,
    operationId: receipt.operationId,
    requiredRebindings: [...receipt.requiredRebindings].sort(),
    sourceChangeCursor: receipt.sourceChangeCursor,
    inputSha256: receipt.inputSha256,
    artifactSha256: receipt.artifactSha256,
  })}\n`;
}

export function createPortableDryRunReceipt(
  preflight: PortabilityPreflightResult,
  manifest: PortableBundleManifest,
  destinationId: string,
  inputSha256: string,
  artifactSha256: string,
  checkedAt: string,
  attestationKeyId: string,
  privateKey: KeyLike,
): PortableDryRunReceipt {
  if (
    !preflight.compatible ||
    preflight.operationId !== portableOperationId(manifest, destinationId)
  ) {
    throw new Error('incompatible or mismatched portable preflight cannot produce a receipt');
  }
  if (
    new Date(checkedAt).toISOString() !== checkedAt ||
    !/^[a-f0-9]{64}$/u.test(inputSha256) ||
    !/^[a-f0-9]{64}$/u.test(artifactSha256)
  ) {
    throw new Error('portable dry-run receipt timestamp is invalid');
  }
  const payload = {
    operationId: preflight.operationId,
    manifestSha256: portableManifestSha256(manifest),
    destinationId,
    sourceChangeCursor: manifest.lineage.toChangeCursor,
    inputSha256,
    artifactSha256,
    checkedAt,
    compatible: true as const,
    requiredRebindings: preflight.requiredRebindings.map(({ portableId }) => portableId),
  };
  return {
    ...payload,
    sha256: createHash('sha256').update(portableDryRunReceiptPayload(payload)).digest('hex'),
    attestationKeyId,
    signature: cryptoSign(
      null,
      Buffer.from(portableDryRunReceiptPayload(payload)),
      privateKey,
    ).toString('base64'),
  };
}

export function verifyPortableDryRunReceipt(
  receipt: PortableDryRunReceipt,
  publicKey: KeyLike,
): boolean {
  try {
    const payload = {
      operationId: receipt.operationId,
      manifestSha256: receipt.manifestSha256,
      destinationId: receipt.destinationId,
      sourceChangeCursor: receipt.sourceChangeCursor,
      inputSha256: receipt.inputSha256,
      artifactSha256: receipt.artifactSha256,
      checkedAt: receipt.checkedAt,
      compatible: receipt.compatible,
      requiredRebindings: receipt.requiredRebindings,
    };
    const encoded = portableDryRunReceiptPayload(payload);
    return (
      receipt.compatible === true &&
      new Date(receipt.checkedAt).toISOString() === receipt.checkedAt &&
      /^[a-f0-9]{64}$/u.test(receipt.inputSha256) &&
      /^[a-f0-9]{64}$/u.test(receipt.artifactSha256) &&
      createHash('sha256').update(encoded).digest('hex') === receipt.sha256 &&
      cryptoVerify(null, Buffer.from(encoded), publicKey, Buffer.from(receipt.signature, 'base64'))
    );
  } catch {
    return false;
  }
}

export function validatePortableResume(
  checkpoint: PortableImportCheckpoint,
  manifest: PortableBundleManifest,
  destinationId: string,
  dryRunReceipt: PortableDryRunReceipt,
  trustedDryRunKeys: ReadonlyMap<string, KeyLike>,
): void {
  const manifestSha256 = portableManifestSha256(manifest);
  const requiredRebindings = manifest.rebindings
    .filter(({ required }) => required)
    .map(({ portableId }) => portableId)
    .sort();
  if (checkpoint.manifestSha256 !== manifestSha256) {
    throw new Error('portable import checkpoint belongs to a different manifest');
  }
  if (
    checkpoint.operationId !== portableOperationId(manifest, destinationId) ||
    checkpoint.destinationId !== destinationId ||
    checkpoint.lastSourceChangeCursor !== manifest.lineage.toChangeCursor ||
    checkpoint.dryRunReceiptSha256 !== dryRunReceipt.sha256 ||
    dryRunReceipt.sha256 !==
      createHash('sha256')
        .update(
          portableDryRunReceiptPayload({
            operationId: dryRunReceipt.operationId,
            manifestSha256: dryRunReceipt.manifestSha256,
            destinationId: dryRunReceipt.destinationId,
            sourceChangeCursor: dryRunReceipt.sourceChangeCursor,
            inputSha256: dryRunReceipt.inputSha256,
            artifactSha256: dryRunReceipt.artifactSha256,
            checkedAt: dryRunReceipt.checkedAt,
            compatible: dryRunReceipt.compatible,
            requiredRebindings: dryRunReceipt.requiredRebindings,
          }),
        )
        .digest('hex') ||
    dryRunReceipt.operationId !== checkpoint.operationId ||
    dryRunReceipt.manifestSha256 !== manifestSha256 ||
    dryRunReceipt.destinationId !== destinationId ||
    dryRunReceipt.sourceChangeCursor !== manifest.lineage.toChangeCursor ||
    JSON.stringify([...dryRunReceipt.requiredRebindings].sort()) !==
      JSON.stringify(requiredRebindings) ||
    !trustedDryRunKeys.has(dryRunReceipt.attestationKeyId) ||
    !cryptoVerify(
      null,
      Buffer.from(
        portableDryRunReceiptPayload({
          operationId: dryRunReceipt.operationId,
          manifestSha256: dryRunReceipt.manifestSha256,
          destinationId: dryRunReceipt.destinationId,
          sourceChangeCursor: dryRunReceipt.sourceChangeCursor,
          inputSha256: dryRunReceipt.inputSha256,
          artifactSha256: dryRunReceipt.artifactSha256,
          checkedAt: dryRunReceipt.checkedAt,
          compatible: dryRunReceipt.compatible,
          requiredRebindings: dryRunReceipt.requiredRebindings,
        }),
      ),
      trustedDryRunKeys.get(dryRunReceipt.attestationKeyId)!,
      Buffer.from(dryRunReceipt.signature, 'base64'),
    ) ||
    !['importing', 'rebind-required', 'reconciling'].includes(checkpoint.status)
  ) {
    throw new Error(
      'portable import checkpoint identity, cursor, dry-run receipt or status is invalid',
    );
  }
  const completedRebindings = new Set<string>();
  for (const rebinding of checkpoint.completedRebindings) {
    const expectedProvenance = portableRebindingProvenanceSha256(rebinding);
    if (
      completedRebindings.has(rebinding.portableId) ||
      !requiredRebindings.includes(rebinding.portableId) ||
      rebinding.provenanceSha256 !== expectedProvenance
    ) {
      throw new Error('portable import checkpoint contains invalid rebinding provenance');
    }
    completedRebindings.add(rebinding.portableId);
  }
  if (
    checkpoint.status === 'reconciling' &&
    requiredRebindings.some((portableId) => !completedRebindings.has(portableId))
  ) {
    throw new Error('portable import cannot reconcile before required rebindings complete');
  }
  const mappingKeys = new Set<string>();
  const destinationMappingKeys = new Set<string>();
  const mappingsByFile = new Map<string, number>();
  const sourceIdsByFile = new Map<string, string[]>();
  for (const mapping of checkpoint.mappings) {
    const key = `${mapping.section}\0${mapping.sourcePortableId}`;
    const destinationKey = `${mapping.section}\0${mapping.destinationId}`;
    if (
      mappingKeys.has(key) ||
      destinationMappingKeys.has(destinationKey) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(mapping.sourcePortableId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(mapping.destinationId) ||
      mapping.provenanceSha256 !==
        portableMappingProvenanceSha256({
          filePath: mapping.filePath,
          section: mapping.section,
          sourcePortableId: mapping.sourcePortableId,
          destinationId: mapping.destinationId,
        }) ||
      !manifest.files.some(
        (file) => file.path === mapping.filePath && file.section === mapping.section,
      )
    ) {
      throw new Error('portable import checkpoint contains duplicate or invalid mappings');
    }
    mappingKeys.add(key);
    destinationMappingKeys.add(destinationKey);
    mappingsByFile.set(mapping.filePath, (mappingsByFile.get(mapping.filePath) ?? 0) + 1);
    const sourceIds = sourceIdsByFile.get(mapping.filePath) ?? [];
    sourceIds.push(mapping.sourcePortableId);
    sourceIdsByFile.set(mapping.filePath, sourceIds);
  }
  const files = manifest.files;
  const expected = new Map(files.map((file) => [file.path, file.sha256]));
  const completedPaths = new Set<string>();
  for (const file of checkpoint.completedFiles) {
    if (completedPaths.has(file.path) || expected.get(file.path) !== file.sha256) {
      throw new Error(`portable import checkpoint file drift: ${file.path}`);
    }
    completedPaths.add(file.path);
    const manifestFile = files.find(({ path }) => path === file.path)!;
    if (
      manifestFile.section !== 'assets' &&
      (mappingsByFile.get(file.path) !== manifestFile.records ||
        createHash('sha256')
          .update(`${JSON.stringify([...(sourceIdsByFile.get(file.path) ?? [])].sort())}\n`)
          .digest('hex') !==
          manifest.payloadSafety.scannedFiles.find(({ path }) => path === file.path)
            ?.portableIdsSha256)
    ) {
      throw new Error(`portable import checkpoint mapping is incomplete: ${file.path}`);
    }
  }
}
