import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyLike } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import { parsePortableJson } from './safe-json.js';

const manifestSchemaV1 = JSON.parse(
  readFileSync(new URL('../schemas/portable-bundle-2026-07-12.json', import.meta.url), 'utf8'),
) as object;
const manifestSchemaV2 = JSON.parse(
  readFileSync(new URL('../schemas/portable-bundle-2026-07-14.json', import.meta.url), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin;
addFormats(ajv);
const validateManifestSchemaV1 = ajv.compile(manifestSchemaV1);
const validateManifestSchemaV2 = ajv.compile(manifestSchemaV2);

export const PORTABLE_BUNDLE_SCHEMA_VERSION = 2 as const;
export const PORTABLE_BUNDLE_FORMAT = 'tixkit-portable-bundle-v2' as const;
export const PORTABLE_BUNDLE_LEGACY_SCHEMA_VERSION = 1 as const;
export const PORTABLE_BUNDLE_LEGACY_FORMAT = 'tixkit-portable-bundle-v1' as const;

export type PortableBundleMode = 'configuration' | 'historical';
export type TixkitOperatingModel = 'cloud' | 'self-hosted';

export const PORTABLE_SECTIONS = [
  'organizations',
  'brands',
  'venues',
  'events',
  'occurrences',
  'inventory',
  'ticket_types',
  'products',
  'checkout_questions',
  'discounts',
  'access_codes',
  'policies',
  'content',
  'templates',
  'webhooks',
  'oauth_applications',
  'configuration',
  'buyers',
  'attendees',
  'orders',
  'payments',
  'refunds',
  'tickets',
  'scans',
  'audit_logs',
  'consent',
  'delivery_history',
  'financial_snapshots',
] as const;
export type PortableSection = (typeof PORTABLE_SECTIONS)[number];
const PORTABLE_SECTION_SET: ReadonlySet<string> = new Set(PORTABLE_SECTIONS);

export const HISTORICAL_SECTIONS: ReadonlySet<PortableSection> = new Set([
  'buyers',
  'attendees',
  'orders',
  'payments',
  'refunds',
  'tickets',
  'scans',
  'audit_logs',
  'consent',
  'delivery_history',
  'financial_snapshots',
]);

export interface PortableBundleFile {
  path: string;
  section: PortableSection | 'assets';
  sha256: string;
  bytes: number;
  records: number;
  contentType: 'application/jsonl' | 'application/json' | 'application/octet-stream';
}

export interface PortableLogicalRecord {
  portableId: string;
  attributes: Readonly<Record<string, unknown>>;
  dependencies?: Array<{ section: PortableSection; portableId: string }>;
  financialSnapshot?: {
    kind: 'historical-payment' | 'historical-refund';
    amountMinor: number;
    currency: string;
    providerReference?: string;
    occurredAt: string;
    provenance: { sourceSystem: string; sourceExternalId: string; importedAt: string };
    reconciliationStatus: 'unreconciled' | 'reconciled';
    sideEffects: 'suppressed';
  };
}

export interface PortableAsset {
  portableId: string;
  path: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  role: string;
}

export interface HistoricalExportAuthorization {
  authorizationId: string;
  tenantId: string;
  grantedByPrincipalId: string;
  grantedAt: string;
  expiresAt: string;
  scope: 'tenant-historical-portability';
}

export interface PortableBundleManifest {
  schemaVersion:
    | typeof PORTABLE_BUNDLE_SCHEMA_VERSION
    | typeof PORTABLE_BUNDLE_LEGACY_SCHEMA_VERSION;
  format: typeof PORTABLE_BUNDLE_FORMAT | typeof PORTABLE_BUNDLE_LEGACY_FORMAT;
  bundleId: string;
  mode: PortableBundleMode;
  source: {
    operatingModel: TixkitOperatingModel;
    deploymentId: string;
    tenantId: string;
    exportSequence: number;
    changeCursor: string;
    frozenAt?: string;
  };
  apiVersion: string;
  dataSchemaVersion: string;
  exportedAt: string;
  lineage: {
    kind: 'full' | 'delta';
    fromChangeCursor?: string;
    toChangeCursor: string;
    parentBundleId?: string;
    parentManifestSha256?: string;
    cutoverFreeze?: { frozenAt: string; receiptSha256: string };
  };
  compatibility: {
    minimumApiVersion: string;
    maximumApiVersion: string;
    minimumDataSchemaVersion: string;
    maximumDataSchemaVersion: string;
    requiredCapabilities: string[];
    requiredEntitlements: string[];
  };
  entityCounts: Partial<Record<PortableSection, number>>;
  files: PortableBundleFile[];
  payloadSafety: {
    policyVersion: 'tixkit-portable-secret-policy-v1';
    scannedFiles: PortablePayloadSafetyAttestation[];
    findings: 0;
  };
  assetSafety: {
    policyVersion: 'tixkit-portable-media-policy-v1';
    scannedFiles: Array<PortableMediaSafetyAttestation>;
    findings: 0;
  };
  assets: PortableAsset[];
  identity: {
    namespace: string;
    preserveSafeIds: true;
    mappingRequired: true;
  };
  dependencies: Array<{ section: PortableSection; dependsOn: PortableSection[] }>;
  rebindings: Array<{
    kind:
      | 'custom_domain'
      | 'provider_account'
      | 'payment_provider_account'
      | 'email_delivery_route'
      | 'sms_delivery_route'
      | 'marketing_integration'
      | 'tax_registration'
      | 'sending_identity'
      | 'wallet_credential'
      | 'oauth_redirect_origin'
      | 'webhook_endpoint';
    portableId: string;
    required: boolean;
  }>;
  historicalAuthorization?: HistoricalExportAuthorization;
}

export interface PortableBundleSignature {
  algorithm: 'Ed25519';
  keyId: string;
  manifestSha256: string;
  signature: string;
}

export interface SignedPortableBundle {
  manifest: PortableBundleManifest;
  signature: PortableBundleSignature;
}

export interface PortableCutoverProof {
  tenantId: string;
  deploymentId: string;
  sourceChangeCursor: string;
  observedAt: string;
  sourceFrozen: boolean;
  bundleId: string;
  manifestSha256: string;
  destinationId: string;
  operationId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  receiptSha256: string;
  keyId: string;
  signature: string;
}

export interface PortableMediaSafetyAttestation {
  path: string;
  sha256: string;
  bytes: number;
  policyVersion: 'tixkit-portable-media-policy-v1';
  policySha256: string;
  scannerId: string;
  detectedMediaType: string;
  width: number;
  height: number;
  malwareStatus: 'clean';
  metadataStripped: true;
  decompressionSafe: true;
  pixelLimitsSafe: true;
  keyId: string;
  signature: string;
}

export interface PortablePayloadSafetyPolicy {
  schemaId: string;
  schemaSha256: string;
  policySha256: string;
  scannerId: string;
  validateRecord: (section: PortableSection, record: unknown) => boolean;
}

export interface PortablePayloadSafetyAttestation {
  path: string;
  section: PortableSection;
  sha256: string;
  records: number;
  portableIdsSha256: string;
  schemaId: string;
  schemaSha256: string;
  policySha256: string;
  scannerId: string;
  keyId: string;
  signature: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;

export function isPortableProtocolId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'apikey',
  'apikeyplaintext',
  'clientsecret',
  'accesstoken',
  'clusterid',
  'connectionstring',
  'credential',
  'credentials',
  'infrastructureid',
  'instanceid',
  'password',
  'paymenttoken',
  'privatekey',
  'privatesigningkey',
  'providersecret',
  'providerapitoken',
  'refreshtoken',
  'secret',
  'signingkey',
  'webhooksecret',
  'webhooksigningsecret',
]);
const HIGH_CONFIDENCE_SECRET_VALUE =
  /(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|tok_(?:live|test)_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const FORBIDDEN_PAYLOAD_KEY_PATTERN =
  /(?:token|secret|password|privatekey|privatematerial|credential|signingmaterial|walletkey|accesskey|mnemonic|seed|seedphrase|bearer|auth|authorization|session|sessionid|sessionkey)$/u;
const ALLOWED_REFERENCE_KEYS = new Set(['provideraccountid', 'portableid']);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalPortableManifest(manifest: PortableBundleManifest): string {
  return `${JSON.stringify(canonicalize(manifest))}\n`;
}

export function canonicalPortableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function portableManifestSha256(manifest: PortableBundleManifest): string {
  return createHash('sha256').update(canonicalPortableManifest(manifest)).digest('hex');
}

export function signPortableManifest(
  manifest: PortableBundleManifest,
  keyId: string,
  privateKey: KeyLike,
): PortableBundleSignature {
  validatePortableManifest(manifest);
  if (!ID_PATTERN.test(keyId)) throw new Error('portable signing key id is invalid');
  const bytes = Buffer.from(canonicalPortableManifest(manifest));
  return {
    algorithm: 'Ed25519',
    keyId,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    signature: cryptoSign(null, bytes, privateKey).toString('base64'),
  };
}

export function verifyPortableManifestSignature(
  manifest: PortableBundleManifest,
  signature: PortableBundleSignature,
  publicKey: KeyLike,
): boolean {
  try {
    validatePortableManifest(manifest);
  } catch {
    return false;
  }
  if (signature.algorithm !== 'Ed25519' || !ID_PATTERN.test(signature.keyId)) return false;
  const bytes = Buffer.from(canonicalPortableManifest(manifest));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== signature.manifestSha256) return false;
  try {
    return cryptoVerify(null, bytes, publicKey, Buffer.from(signature.signature, 'base64'));
  } catch {
    return false;
  }
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validatePortableManifest(manifest: PortableBundleManifest): void {
  const validateManifestSchema =
    manifest.schemaVersion === PORTABLE_BUNDLE_SCHEMA_VERSION &&
    manifest.format === PORTABLE_BUNDLE_FORMAT
      ? validateManifestSchemaV2
      : manifest.schemaVersion === PORTABLE_BUNDLE_LEGACY_SCHEMA_VERSION &&
          manifest.format === PORTABLE_BUNDLE_LEGACY_FORMAT
        ? validateManifestSchemaV1
        : undefined;
  if (!validateManifestSchema) throw new Error('unsupported portable bundle format');
  if (!validateManifestSchema(manifest)) {
    throw new Error(
      `portable manifest schema validation failed: ${ajv.errorsText(validateManifestSchema.errors)}`,
    );
  }
  for (const [label, value] of [
    ['bundle id', manifest.bundleId],
    ['source deployment id', manifest.source.deploymentId],
    ['tenant id', manifest.source.tenantId],
  ] as const) {
    if (!ID_PATTERN.test(value)) throw new Error(`portable ${label} is invalid`);
  }
  if (!Number.isSafeInteger(manifest.source.exportSequence) || manifest.source.exportSequence < 1) {
    throw new Error('portable export sequence must be a positive safe integer');
  }
  if (!manifest.source.changeCursor || !validDate(manifest.exportedAt)) {
    throw new Error('portable export cursor or timestamp is invalid');
  }
  if (manifest.lineage.toChangeCursor !== manifest.source.changeCursor) {
    throw new Error('portable lineage cursor must match the source change cursor');
  }
  if (manifest.lineage.kind === 'delta') {
    if (
      !manifest.lineage.fromChangeCursor ||
      !manifest.lineage.parentBundleId ||
      !SHA256_PATTERN.test(manifest.lineage.parentManifestSha256 ?? '')
    ) {
      throw new Error('portable delta bundles require complete parent lineage');
    }
  } else if (
    manifest.lineage.fromChangeCursor ||
    manifest.lineage.parentBundleId ||
    manifest.lineage.parentManifestSha256
  ) {
    throw new Error('portable full bundles cannot claim delta lineage');
  }
  if (manifest.lineage.cutoverFreeze) {
    if (
      !validDate(manifest.lineage.cutoverFreeze.frozenAt) ||
      !SHA256_PATTERN.test(manifest.lineage.cutoverFreeze.receiptSha256)
    ) {
      throw new Error('portable cutover freeze proof is invalid');
    }
  }
  if (manifest.source.frozenAt && !validDate(manifest.source.frozenAt)) {
    throw new Error('portable cutover freeze timestamp is invalid');
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (!SAFE_PATH_PATTERN.test(file.path) || paths.has(file.path)) {
      throw new Error(`portable file path is unsafe or duplicated: ${file.path}`);
    }
    paths.add(file.path);
    if (file.section !== 'assets' && !PORTABLE_SECTION_SET.has(file.section)) {
      throw new Error(`portable file section is unknown: ${String(file.section)}`);
    }
    if (
      !SHA256_PATTERN.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !Number.isSafeInteger(file.records) ||
      file.records < 0
    ) {
      throw new Error(`portable file integrity metadata is invalid: ${file.path}`);
    }
  }
  const payloadFiles = manifest.files.filter(({ section }) => section !== 'assets');
  const safetyFiles = new Map(manifest.payloadSafety.scannedFiles.map((file) => [file.path, file]));
  if (
    manifest.payloadSafety.policyVersion !== 'tixkit-portable-secret-policy-v1' ||
    manifest.payloadSafety.findings !== 0 ||
    safetyFiles.size !== manifest.payloadSafety.scannedFiles.length ||
    payloadFiles.some((file) => {
      const receipt = safetyFiles.get(file.path);
      return (
        receipt?.sha256 !== file.sha256 ||
        receipt.section !== file.section ||
        receipt.records !== file.records ||
        !SHA256_PATTERN.test(receipt.portableIdsSha256) ||
        !ID_PATTERN.test(receipt.schemaId) ||
        !SHA256_PATTERN.test(receipt.schemaSha256) ||
        !SHA256_PATTERN.test(receipt.policySha256) ||
        !ID_PATTERN.test(receipt.scannerId) ||
        !ID_PATTERN.test(receipt.keyId) ||
        receipt.signature.length < 80
      );
    }) ||
    safetyFiles.size !== payloadFiles.length
  ) {
    throw new Error('portable payload safety receipt is incomplete or does not match bundle files');
  }
  const assetSafetyFiles = new Map(
    manifest.assetSafety.scannedFiles.map((file) => [file.path, file]),
  );
  const assetFiles = manifest.files.filter(({ section }) => section === 'assets');
  if (
    manifest.assetSafety.policyVersion !== 'tixkit-portable-media-policy-v1' ||
    manifest.assetSafety.findings !== 0 ||
    assetSafetyFiles.size !== manifest.assetSafety.scannedFiles.length ||
    assetFiles.some((file) => {
      const receipt = assetSafetyFiles.get(file.path);
      return (
        receipt?.sha256 !== file.sha256 ||
        receipt.bytes !== file.bytes ||
        receipt.policyVersion !== 'tixkit-portable-media-policy-v1' ||
        !SHA256_PATTERN.test(receipt.policySha256) ||
        !ID_PATTERN.test(receipt.scannerId) ||
        !ID_PATTERN.test(receipt.keyId) ||
        receipt.signature.length < 80 ||
        !Number.isSafeInteger(receipt.width) ||
        receipt.width < 1 ||
        !Number.isSafeInteger(receipt.height) ||
        receipt.height < 1 ||
        receipt.malwareStatus !== 'clean' ||
        receipt.metadataStripped !== true ||
        receipt.decompressionSafe !== true ||
        receipt.pixelLimitsSafe !== true
      );
    }) ||
    assetSafetyFiles.size !== assetFiles.length
  ) {
    throw new Error('portable asset safety receipt is incomplete or does not match bundle files');
  }
  for (const asset of manifest.assets) {
    if (
      !SAFE_PATH_PATTERN.test(asset.path) ||
      !SHA256_PATTERN.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0
    ) {
      throw new Error(`portable asset integrity metadata is invalid: ${asset.path}`);
    }
    const file = manifest.files.find(({ path }) => path === asset.path);
    const mediaReceipt = assetSafetyFiles.get(asset.path);
    if (!file || file.section !== 'assets' || file.sha256 !== asset.sha256) {
      throw new Error(`portable asset is not bound to a matching bundle file: ${asset.path}`);
    }
    if (
      asset.bytes !== file.bytes ||
      mediaReceipt?.detectedMediaType !== asset.mediaType ||
      mediaReceipt.bytes !== asset.bytes
    ) {
      throw new Error(
        `portable asset metadata does not match its media attestation: ${asset.path}`,
      );
    }
  }
  if (
    Object.values(manifest.entityCounts).some((count) => !Number.isSafeInteger(count) || count! < 0)
  ) {
    throw new Error('portable entity counts must be non-negative safe integers');
  }
  const sections = new Set(manifest.files.map(({ section }) => section));
  if (
    new Set(manifest.rebindings.map(({ portableId }) => portableId)).size !==
    manifest.rebindings.length
  )
    throw new Error('portable rebindings contain duplicate identities');
  if (
    !ID_PATTERN.test(manifest.identity.namespace) ||
    manifest.identity.preserveSafeIds !== true ||
    manifest.identity.mappingRequired !== true
  ) {
    throw new Error('portable identity and mapping policy is invalid');
  }
  const dependencySections = new Set<PortableSection>();
  const dependencyGraph = new Map<PortableSection, PortableSection[]>();
  for (const dependency of manifest.dependencies) {
    if (
      dependencySections.has(dependency.section) ||
      !PORTABLE_SECTION_SET.has(dependency.section) ||
      dependency.dependsOn.some((section) => !PORTABLE_SECTION_SET.has(section))
    ) {
      throw new Error('portable dependency order contains unknown or duplicate sections');
    }
    if (new Set(dependency.dependsOn).size !== dependency.dependsOn.length) {
      throw new Error('portable dependency order contains duplicate dependencies');
    }
    dependencySections.add(dependency.section);
    dependencyGraph.set(dependency.section, dependency.dependsOn);
  }
  const visiting = new Set<PortableSection>();
  const visited = new Set<PortableSection>();
  const visit = (section: PortableSection): void => {
    if (visiting.has(section)) throw new Error('portable dependency order contains a cycle');
    if (visited.has(section)) return;
    visiting.add(section);
    for (const dependency of dependencyGraph.get(section) ?? []) visit(dependency);
    visiting.delete(section);
    visited.add(section);
  };
  for (const section of dependencyGraph.keys()) {
    visit(section);
  }
  const presentSections = new Set(
    manifest.files
      .filter(({ section }) => section !== 'assets')
      .map(({ section }) => section as PortableSection),
  );
  if (
    dependencySections.size !== presentSections.size ||
    [...presentSections].some((section) => !dependencySections.has(section)) ||
    [...dependencyGraph.values()].some((dependencies) =>
      dependencies.some((section) => !presentSections.has(section)),
    )
  ) {
    throw new Error('portable dependency order must cover exactly the exported sections');
  }
  if (
    manifest.mode === 'configuration' &&
    [...sections].some((item) => HISTORICAL_SECTIONS.has(item as PortableSection))
  ) {
    throw new Error('configuration-only portable bundles cannot contain historical sections');
  }
  if (manifest.mode === 'historical') {
    const authorization = manifest.historicalAuthorization;
    if (
      !authorization ||
      authorization.scope !== 'tenant-historical-portability' ||
      authorization.tenantId !== manifest.source.tenantId ||
      !ID_PATTERN.test(authorization.authorizationId) ||
      !ID_PATTERN.test(authorization.grantedByPrincipalId) ||
      !validDate(authorization.grantedAt) ||
      !validDate(authorization.expiresAt) ||
      Date.parse(authorization.grantedAt) > Date.parse(manifest.exportedAt) ||
      Date.parse(authorization.expiresAt) <= Date.parse(manifest.exportedAt) ||
      Date.parse(authorization.expiresAt) - Date.parse(authorization.grantedAt) > 86_400_000
    ) {
      throw new Error('historical portable bundles require current explicit authorization');
    }
  } else if (manifest.historicalAuthorization) {
    throw new Error('configuration-only bundles cannot carry historical authorization');
  }
}

export function portableOperationId(
  manifest: PortableBundleManifest,
  destinationId: string,
): string {
  if (!ID_PATTERN.test(destinationId)) throw new Error('portable destination id is invalid');
  return createHash('sha256')
    .update(`${portableManifestSha256(manifest)}\0${destinationId}`)
    .digest('hex');
}

export function assertPortablePayloadSafe(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (HIGH_CONFIDENCE_SECRET_VALUE.test(value)) {
      throw new Error(`portable payload contains secret material at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertPortablePayloadSafe(child, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
    if (
      FORBIDDEN_PAYLOAD_KEYS.has(normalized) ||
      (!ALLOWED_REFERENCE_KEYS.has(normalized) && FORBIDDEN_PAYLOAD_KEY_PATTERN.test(normalized))
    ) {
      throw new Error(`portable payload contains forbidden field ${path}.${key}`);
    }
    assertPortablePayloadSafe(child, `${path}.${key}`);
  }
}

export function scanPortablePayload(
  file: Pick<
    PortableBundleFile,
    'path' | 'sha256' | 'section' | 'contentType' | 'records' | 'bytes'
  >,
  bytes: Uint8Array,
  policy: PortablePayloadSafetyPolicy,
  keyId: string,
  privateKey: KeyLike,
): PortablePayloadSafetyAttestation {
  if (file.section === 'assets') throw new Error('binary assets require the media safety pipeline');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== file.bytes) {
    throw new Error(`portable payload byte size does not match ${file.path}`);
  }
  if (digest !== file.sha256) throw new Error(`portable payload bytes do not match ${file.path}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const records: unknown[] =
    file.contentType === 'application/jsonl'
      ? text
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => parsePortableJson(line))
      : [parsePortableJson(text)];
  if (records.length !== file.records) {
    throw new Error(`portable payload record count does not match ${file.path}`);
  }
  const portableIds = records.map((record, index) => {
    assertPortablePayloadSafe(record, `${file.path}[${index}]`);
    if (
      file.section === 'assets' ||
      !ID_PATTERN.test(policy.schemaId) ||
      !SHA256_PATTERN.test(policy.schemaSha256) ||
      !SHA256_PATTERN.test(policy.policySha256) ||
      !ID_PATTERN.test(policy.scannerId) ||
      !policy.validateRecord(file.section, record)
    ) {
      throw new Error(
        `portable payload violates its closed section schema: ${file.path}[${index}]`,
      );
    }
    const portableId =
      record && typeof record === 'object' && !Array.isArray(record)
        ? (record as Record<string, unknown>).portableId
        : undefined;
    if (!isPortableProtocolId(portableId)) {
      throw new Error(`portable payload record lacks a valid portableId at ${file.path}[${index}]`);
    }
    return portableId;
  });
  if (new Set(portableIds).size !== portableIds.length) {
    throw new Error(`portable payload contains duplicate portable IDs: ${file.path}`);
  }
  const attestation = {
    path: file.path,
    section: file.section,
    sha256: digest,
    records: records.length,
    portableIdsSha256: createHash('sha256')
      .update(`${JSON.stringify([...portableIds].sort())}\n`)
      .digest('hex'),
    schemaId: policy.schemaId,
    schemaSha256: policy.schemaSha256,
    policySha256: policy.policySha256,
    scannerId: policy.scannerId,
  };
  return signPortablePayloadAttestation(attestation, keyId, privateKey);
}

function payloadAttestationPayload(
  attestation: Omit<PortablePayloadSafetyAttestation, 'keyId' | 'signature'>,
): string {
  return `${JSON.stringify(canonicalize(attestation))}\n`;
}

export function signPortablePayloadAttestation(
  attestation: Omit<PortablePayloadSafetyAttestation, 'keyId' | 'signature'>,
  keyId: string,
  privateKey: KeyLike,
): PortablePayloadSafetyAttestation {
  return {
    ...attestation,
    keyId,
    signature: cryptoSign(
      null,
      Buffer.from(payloadAttestationPayload(attestation)),
      privateKey,
    ).toString('base64'),
  };
}

export function verifyPortablePayloadAttestation(
  attestation: PortablePayloadSafetyAttestation,
  trustedPayloadKeys: ReadonlyMap<string, KeyLike>,
): boolean {
  const key = trustedPayloadKeys.get(attestation.keyId);
  if (!key) return false;
  const { keyId: _keyId, signature, ...payload } = attestation;
  try {
    return cryptoVerify(
      null,
      Buffer.from(payloadAttestationPayload(payload)),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function scanPortableAsset(
  file: Pick<PortableBundleFile, 'path' | 'sha256' | 'section' | 'bytes'>,
  bytes: Uint8Array,
  maximumBytes: number,
  attestation: PortableMediaSafetyAttestation,
  trustedMediaKeys: ReadonlyMap<string, KeyLike>,
): PortableMediaSafetyAttestation {
  if (file.section !== 'assets') throw new Error('portable media scanner requires an asset file');
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    bytes.byteLength !== file.bytes ||
    bytes.byteLength > maximumBytes
  ) {
    throw new Error(`portable asset byte size is invalid: ${file.path}`);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== file.sha256) throw new Error(`portable asset bytes do not match ${file.path}`);
  if (
    attestation.path !== file.path ||
    attestation.sha256 !== digest ||
    attestation.bytes !== bytes.byteLength ||
    attestation.policyVersion !== 'tixkit-portable-media-policy-v1' ||
    !SHA256_PATTERN.test(attestation.policySha256) ||
    !ID_PATTERN.test(attestation.scannerId) ||
    !Number.isSafeInteger(attestation.width) ||
    attestation.width < 1 ||
    !Number.isSafeInteger(attestation.height) ||
    attestation.height < 1 ||
    attestation.malwareStatus !== 'clean' ||
    attestation.metadataStripped !== true ||
    attestation.decompressionSafe !== true ||
    attestation.pixelLimitsSafe !== true ||
    !verifyPortableMediaAttestation(attestation, trustedMediaKeys)
  ) {
    throw new Error(`portable asset lacks a valid hardened media safety attestation: ${file.path}`);
  }
  return attestation;
}

function mediaAttestationPayload(
  attestation: Omit<PortableMediaSafetyAttestation, 'keyId' | 'signature'>,
): string {
  return `${JSON.stringify(canonicalize(attestation))}\n`;
}

export function signPortableMediaAttestation(
  attestation: Omit<PortableMediaSafetyAttestation, 'keyId' | 'signature'>,
  keyId: string,
  privateKey: KeyLike,
): PortableMediaSafetyAttestation {
  return {
    ...attestation,
    keyId,
    signature: cryptoSign(
      null,
      Buffer.from(mediaAttestationPayload(attestation)),
      privateKey,
    ).toString('base64'),
  };
}

export function verifyPortableMediaAttestation(
  attestation: PortableMediaSafetyAttestation,
  trustedMediaKeys: ReadonlyMap<string, KeyLike>,
): boolean {
  const key = trustedMediaKeys.get(attestation.keyId);
  if (!key) return false;
  const { keyId: _keyId, signature, ...payload } = attestation;
  try {
    return cryptoVerify(
      null,
      Buffer.from(mediaAttestationPayload(payload)),
      key,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function trustedManifest(
  envelope: SignedPortableBundle,
  trustedKeys: ReadonlyMap<string, KeyLike>,
): PortableBundleManifest {
  const key = trustedKeys.get(envelope.signature.keyId);
  if (!key || !verifyPortableManifestSignature(envelope.manifest, envelope.signature, key)) {
    throw new Error('portable bundle is not signed by a trusted key');
  }
  return envelope.manifest;
}

export function validatePortableLineage(
  envelope: SignedPortableBundle,
  trustedKeys: ReadonlyMap<string, KeyLike>,
  trustedParentEnvelope?: SignedPortableBundle,
): void {
  const manifest = trustedManifest(envelope, trustedKeys);
  if (manifest.lineage.kind === 'full') {
    if (trustedParentEnvelope) throw new Error('portable full bundle cannot have a parent');
    return;
  }
  const trustedParent = trustedParentEnvelope
    ? trustedManifest(trustedParentEnvelope, trustedKeys)
    : undefined;
  if (
    !trustedParent ||
    manifest.lineage.parentBundleId !== trustedParent.bundleId ||
    manifest.lineage.parentManifestSha256 !== portableManifestSha256(trustedParent) ||
    manifest.lineage.fromChangeCursor !== trustedParent.lineage.toChangeCursor ||
    manifest.source.tenantId !== trustedParent.source.tenantId ||
    manifest.source.deploymentId !== trustedParent.source.deploymentId
  ) {
    throw new Error('portable delta lineage does not match its trusted parent');
  }
}

function cutoverProofPayload(
  proof: Pick<
    PortableCutoverProof,
    | 'tenantId'
    | 'deploymentId'
    | 'sourceChangeCursor'
    | 'observedAt'
    | 'sourceFrozen'
    | 'bundleId'
    | 'manifestSha256'
    | 'destinationId'
    | 'operationId'
    | 'issuedAt'
    | 'expiresAt'
    | 'nonce'
  >,
): string {
  return `${JSON.stringify({
    deploymentId: proof.deploymentId,
    destinationId: proof.destinationId,
    bundleId: proof.bundleId,
    expiresAt: proof.expiresAt,
    issuedAt: proof.issuedAt,
    manifestSha256: proof.manifestSha256,
    nonce: proof.nonce,
    observedAt: proof.observedAt,
    operationId: proof.operationId,
    sourceChangeCursor: proof.sourceChangeCursor,
    sourceFrozen: proof.sourceFrozen,
    tenantId: proof.tenantId,
  })}\n`;
}

export function createPortableCutoverProof(
  input: Omit<PortableCutoverProof, 'receiptSha256' | 'keyId' | 'signature'>,
  keyId: string,
  privateKey: KeyLike,
): PortableCutoverProof {
  const payload = cutoverProofPayload(input);
  return {
    ...input,
    receiptSha256: createHash('sha256').update(payload).digest('hex'),
    keyId,
    signature: cryptoSign(null, Buffer.from(payload), privateKey).toString('base64'),
  };
}

export function validatePortableFinalCutover(
  envelope: SignedPortableBundle,
  proof: PortableCutoverProof,
  trustedKeys: ReadonlyMap<string, KeyLike>,
  trustedCutoverKeys: ReadonlyMap<string, KeyLike>,
  destinationId: string,
  now: string,
  consumeNonce: (nonce: string) => boolean,
  trustedParentEnvelope?: SignedPortableBundle,
): void {
  validatePortableLineage(envelope, trustedKeys, trustedParentEnvelope);
  const manifest = envelope.manifest;
  const payload = cutoverProofPayload(proof);
  const cutoverKey = trustedCutoverKeys.get(proof.keyId);
  if (
    !validDate(now) ||
    !validDate(proof.observedAt) ||
    !validDate(proof.issuedAt) ||
    !validDate(proof.expiresAt) ||
    proof.tenantId !== manifest.source.tenantId ||
    proof.deploymentId !== manifest.source.deploymentId ||
    proof.bundleId !== manifest.bundleId ||
    proof.manifestSha256 !== portableManifestSha256(manifest) ||
    proof.destinationId !== destinationId ||
    proof.operationId !== portableOperationId(manifest, destinationId) ||
    Date.parse(proof.issuedAt) > Date.parse(now) ||
    Date.parse(proof.observedAt) < Date.parse(proof.issuedAt) ||
    Date.parse(proof.observedAt) > Date.parse(now) ||
    Date.parse(now) - Date.parse(proof.observedAt) > 60_000 ||
    Date.parse(proof.expiresAt) <= Date.parse(now) ||
    Date.parse(proof.expiresAt) - Date.parse(proof.issuedAt) > 300_000 ||
    !ID_PATTERN.test(proof.nonce) ||
    proof.receiptSha256 !== createHash('sha256').update(payload).digest('hex') ||
    !cutoverKey ||
    !cryptoVerify(null, Buffer.from(payload), cutoverKey, Buffer.from(proof.signature, 'base64')) ||
    proof.sourceChangeCursor !== manifest.lineage.toChangeCursor ||
    (!proof.sourceFrozen && manifest.lineage.kind !== 'delta')
  ) {
    throw new Error('portable final cutover requires a matching freeze or delta source proof');
  }
  if (!consumeNonce(proof.nonce)) {
    throw new Error('portable final cutover proof was already consumed');
  }
}
