import { createHash, type KeyLike } from 'node:crypto';
import {
  PORTABLE_BUNDLE_FORMAT,
  PORTABLE_BUNDLE_SCHEMA_VERSION,
  PORTABLE_SECTIONS,
  canonicalPortableJson,
  isPortableProtocolId,
  scanPortablePayload,
  signPortableMediaAttestation,
  signPortableManifest,
  type PortableBundleManifest,
  type PortableLogicalRecord,
  type PortableAsset,
  type PortablePayloadSafetyPolicy,
  type PortableSection,
  type SignedPortableBundle,
  type TixkitOperatingModel,
} from './manifest.js';

const MAX_PORTABLE_EXPORT_RECORDS = 100_000;
const MAX_PORTABLE_EXPORT_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_PORTABLE_EXPORT_TRANSPORT_BYTES = 50 * 1024 * 1024;
const sectionRank = new Map(PORTABLE_SECTIONS.map((section, index) => [section, index]));

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sections that the current public importer can persist without silent loss. */
export const PORTABLE_RUNTIME_EXPORT_SECTIONS: ReadonlySet<PortableSection> = new Set([
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
]);

export interface PortableLogicalExportInput {
  bundleId: string;
  mode: 'configuration';
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
  currentTime: string;
  compatibility: PortableBundleManifest['compatibility'];
  rebindings?: PortableBundleManifest['rebindings'];
  sections: ReadonlyMap<PortableSection, readonly PortableLogicalRecord[]>;
  bundleSigning: { keyId: string; privateKey: KeyLike };
  payloadSigning: { keyId: string; privateKey: KeyLike };
  payloadPolicies: ReadonlyMap<PortableSection, PortablePayloadSafetyPolicy>;
  assets?: readonly PortableLogicalAssetInput[];
}

export interface PortableLogicalAssetInput {
  portableId: string;
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  role: string;
  width: number;
  height: number;
  policySha256: string;
  scannerId: string;
}

export interface BuiltPortableLogicalExport {
  envelope: SignedPortableBundle;
  payloads: ReadonlyMap<string, Uint8Array>;
  transport: Uint8Array;
}

function sectionOrder(left: PortableSection, right: PortableSection): number {
  return (
    (sectionRank.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (sectionRank.get(right) ?? Number.MAX_SAFE_INTEGER) || compareCodeUnits(left, right)
  );
}

function encodeTransport(
  envelope: SignedPortableBundle,
  payloads: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalPortableJson({
      envelope,
      payloads: Object.fromEntries(
        [...payloads].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]),
      ),
    }),
  );
}

export function buildPortableLogicalExport(
  input: PortableLogicalExportInput,
): BuiltPortableLogicalExport {
  if (input.sections.size === 0) throw new Error('portable export requires at least one section');
  if (!input.source.tenantId.trim()) throw new Error('portable export source tenant is invalid');
  const exportedAt = Date.parse(input.exportedAt);
  const currentTime = Date.parse(input.currentTime);
  if (
    !Number.isFinite(exportedAt) ||
    !Number.isFinite(currentTime) ||
    Math.abs(exportedAt - currentTime) > 5 * 60 * 1000
  ) {
    throw new Error('portable export timestamp exceeds the signing clock-skew boundary');
  }
  if (
    new Set(input.compatibility.requiredCapabilities).size !==
      input.compatibility.requiredCapabilities.length ||
    new Set(input.compatibility.requiredEntitlements).size !==
      input.compatibility.requiredEntitlements.length
  ) {
    throw new Error('portable export compatibility sets contain duplicates');
  }

  const payloads = new Map<string, Uint8Array>();
  const files: PortableBundleManifest['files'] = [];
  const attestations: PortableBundleManifest['payloadSafety']['scannedFiles'] = [];
  const entityCounts: PortableBundleManifest['entityCounts'] = {};
  const dependencyGraph = new Map<PortableSection, Set<PortableSection>>();
  const presentSections = new Set(input.sections.keys());
  const orderedSections = [...input.sections].sort(([left], [right]) => sectionOrder(left, right));
  const availableIdentities = new Set<string>();
  for (const [section, records] of orderedSections) {
    for (const record of records) {
      if (!isPortableProtocolId(record.portableId)) {
        throw new Error(`portable export identity is invalid: ${section}`);
      }
      const identity = `${section}:${record.portableId}`;
      if (availableIdentities.has(identity)) {
        throw new Error(`portable export identity is duplicated: ${identity}`);
      }
      availableIdentities.add(identity);
    }
  }
  let totalRecords = 0;
  let totalDecodedBytes = 0;

  for (const [section, sourceRecords] of orderedSections) {
    if (!PORTABLE_RUNTIME_EXPORT_SECTIONS.has(section)) {
      throw new Error(`portable runtime export does not yet support ${section}`);
    }
    const policy = input.payloadPolicies.get(section);
    if (!policy) throw new Error(`portable export safety policy is missing for ${section}`);
    const records = [...sourceRecords]
      .map((record) => {
        const dependencies = record.dependencies
          ? [...record.dependencies].sort(
              (left, right) =>
                sectionOrder(left.section, right.section) ||
                compareCodeUnits(left.portableId, right.portableId),
            )
          : undefined;
        const dependencyIdentities = dependencies?.map(
          ({ section: dependencySection, portableId }) => `${dependencySection}:${portableId}`,
        );
        if (
          dependencyIdentities &&
          new Set(dependencyIdentities).size !== dependencyIdentities.length
        ) {
          throw new Error(`portable export record contains duplicate dependencies: ${section}`);
        }
        return { ...record, ...(dependencies ? { dependencies } : {}) };
      })
      .sort((left, right) => compareCodeUnits(left.portableId, right.portableId));
    totalRecords += records.length;
    if (totalRecords > MAX_PORTABLE_EXPORT_RECORDS) {
      throw new Error('portable export exceeds the logical record limit');
    }
    for (const record of records) {
      const sectionDependencies = dependencyGraph.get(section) ?? new Set<PortableSection>();
      for (const dependency of record.dependencies ?? []) {
        if (!isPortableProtocolId(dependency.portableId)) {
          throw new Error(`portable export dependency identity is invalid: ${section}`);
        }
        if (!presentSections.has(dependency.section)) {
          throw new Error(
            `portable export dependency section is absent: ${section}:${dependency.section}`,
          );
        }
        if (!availableIdentities.has(`${dependency.section}:${dependency.portableId}`)) {
          throw new Error(
            `portable export dependency identity is absent: ${section}:${dependency.section}:${dependency.portableId}`,
          );
        }
        sectionDependencies.add(dependency.section);
      }
      dependencyGraph.set(section, sectionDependencies);
    }
    const path = `data/${section}.jsonl`;
    const bytes = new TextEncoder().encode(
      records.length === 0
        ? ''
        : `${records.map((record) => canonicalPortableJson(record)).join('\n')}\n`,
    );
    totalDecodedBytes += bytes.byteLength;
    if (totalDecodedBytes > MAX_PORTABLE_EXPORT_DECODED_BYTES) {
      throw new Error('portable export exceeds the decoded payload limit');
    }
    const file = {
      path,
      section,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
      records: records.length,
      contentType: 'application/jsonl' as const,
    };
    payloads.set(path, bytes);
    files.push(file);
    attestations.push(
      scanPortablePayload(
        file,
        bytes,
        policy,
        input.payloadSigning.keyId,
        input.payloadSigning.privateKey,
      ),
    );
    entityCounts[section] = records.length;
  }

  const assets: PortableAsset[] = [];
  const mediaAttestations: PortableBundleManifest['assetSafety']['scannedFiles'] = [];
  const assetPaths = new Set<string>();
  const assetIds = new Set<string>();
  for (const asset of [...(input.assets ?? [])].sort((left, right) =>
    compareCodeUnits(left.portableId, right.portableId),
  )) {
    if (
      !isPortableProtocolId(asset.portableId) ||
      !asset.path.startsWith('assets/') ||
      asset.path.includes('..') ||
      assetPaths.has(asset.path) ||
      assetIds.has(asset.portableId) ||
      !Number.isSafeInteger(asset.width) ||
      asset.width < 1 ||
      !Number.isSafeInteger(asset.height) ||
      asset.height < 1 ||
      !/^[a-f0-9]{64}$/u.test(asset.policySha256) ||
      !isPortableProtocolId(asset.scannerId)
    )
      throw new Error(`portable export asset is invalid: ${asset.portableId}`);
    const bytes = new Uint8Array(asset.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assetPaths.add(asset.path);
    assetIds.add(asset.portableId);
    payloads.set(asset.path, bytes);
    files.push({
      path: asset.path,
      section: 'assets',
      sha256,
      bytes: bytes.byteLength,
      records: 1,
      contentType: 'application/octet-stream',
    });
    assets.push({
      portableId: asset.portableId,
      path: asset.path,
      sha256,
      bytes: bytes.byteLength,
      mediaType: asset.mediaType,
      role: asset.role,
    });
    mediaAttestations.push(
      signPortableMediaAttestation(
        {
          path: asset.path,
          sha256,
          bytes: bytes.byteLength,
          policyVersion: 'tixkit-portable-media-policy-v1',
          policySha256: asset.policySha256,
          scannerId: asset.scannerId,
          detectedMediaType: asset.mediaType,
          width: asset.width,
          height: asset.height,
          malwareStatus: 'clean',
          metadataStripped: true,
          decompressionSafe: true,
          pixelLimitsSafe: true,
        },
        input.payloadSigning.keyId,
        input.payloadSigning.privateKey,
      ),
    );
    totalDecodedBytes += bytes.byteLength;
    if (totalDecodedBytes > MAX_PORTABLE_EXPORT_DECODED_BYTES)
      throw new Error('portable export decoded bytes exceed the limit');
  }

  const manifest: PortableBundleManifest = {
    schemaVersion: PORTABLE_BUNDLE_SCHEMA_VERSION,
    format: PORTABLE_BUNDLE_FORMAT,
    bundleId: input.bundleId,
    mode: input.mode,
    source: input.source,
    apiVersion: input.apiVersion,
    dataSchemaVersion: input.dataSchemaVersion,
    exportedAt: input.exportedAt,
    lineage: { kind: 'full', toChangeCursor: input.source.changeCursor },
    compatibility: {
      ...input.compatibility,
      requiredCapabilities: [...input.compatibility.requiredCapabilities].sort(),
      requiredEntitlements: [...input.compatibility.requiredEntitlements].sort(),
    },
    entityCounts,
    files,
    payloadSafety: {
      policyVersion: 'tixkit-portable-secret-policy-v1',
      scannedFiles: attestations,
      findings: 0,
    },
    assetSafety: {
      policyVersion: 'tixkit-portable-media-policy-v1',
      scannedFiles: mediaAttestations,
      findings: 0,
    },
    assets,
    identity: {
      namespace: input.source.tenantId,
      preserveSafeIds: true,
      mappingRequired: true,
    },
    dependencies: orderedSections.map(([section]) => ({
      section,
      dependsOn: [...(dependencyGraph.get(section) ?? [])].sort(sectionOrder),
    })),
    rebindings: [...(input.rebindings ?? [])].sort((left, right) =>
      compareCodeUnits(left.portableId, right.portableId),
    ),
  };
  const envelope = {
    manifest,
    signature: signPortableManifest(
      manifest,
      input.bundleSigning.keyId,
      input.bundleSigning.privateKey,
    ),
  };
  const transport = encodeTransport(envelope, payloads);
  if (transport.byteLength > MAX_PORTABLE_EXPORT_TRANSPORT_BYTES) {
    throw new Error('portable export exceeds the transport limit');
  }
  return { envelope, payloads, transport };
}
