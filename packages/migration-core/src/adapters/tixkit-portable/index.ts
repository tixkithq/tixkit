import { createHash } from 'node:crypto';
import {
  parsePortableJson,
  verifyAndPreflightPortableImport,
  type PortableBundleManifest,
  type PortableBundleFile,
  type PortableSection,
  type SignedPortableBundle,
} from '@tixkit/portability';
import {
  assertHistoricalFinancialEntity,
  createHistoricalFinancialSnapshot,
  validateCanonicalMigrationEntity,
  type AdapterContext,
  type ExtractedMigrationRow,
  type MigrationAdapter,
  type MigrationDiscovery,
  type MigrationEntityType,
  type MigrationIssue,
  type NormalizedMigrationEntity,
} from '../../index.js';
const sectionToEntity = new Map<PortableSection, MigrationEntityType>([
  ['organizations', 'organization'],
  ['brands', 'brand'],
  ['venues', 'venue'],
  ['events', 'event'],
  ['occurrences', 'occurrence'],
  ['inventory', 'inventory-pool'],
  ['products', 'product'],
  ['checkout_questions', 'question'],
  ['orders', 'historical-order'],
  ['payments', 'historical-payment'],
  ['refunds', 'historical-refund'],
  ['tickets', 'ticket'],
  ['scans', 'check-in'],
]);

const verifiedConfiguration = Symbol('verified-portable-migration-configuration');

export interface TixkitPortableAdapterConfiguration {
  readonly [verifiedConfiguration]: true;
}

export type TixkitPortableImportTrust = Pick<
  Parameters<typeof prepareTixkitPortableMigration>[0],
  | 'destination'
  | 'trustedBundleKeys'
  | 'trustedPayloadKeys'
  | 'trustedPayloadPolicies'
  | 'trustedMediaKeys'
  | 'trustedMediaPolicies'
  | 'destinationTenantId'
  | 'destinationOrganizationId'
>;

interface VerifiedPortableMigrationState {
  manifest: PortableBundleManifest;
  payloads: ReadonlyMap<string, Uint8Array>;
  destinationTenantId: string;
  destinationOrganizationId: string;
}

const verifiedStates = new WeakMap<
  TixkitPortableAdapterConfiguration,
  VerifiedPortableMigrationState
>();
interface VerifiedExtractedRowState {
  destinationTenantId: string;
  destinationOrganizationId: string;
  externalId: string;
  entityType: MigrationEntityType;
  sourcePosition: string;
  record: PortableMigrationRecord;
}

const extractedRowStates = new WeakMap<ExtractedMigrationRow, VerifiedExtractedRowState>();

function verifiedState(
  configuration: TixkitPortableAdapterConfiguration,
): VerifiedPortableMigrationState {
  const state = verifiedStates.get(configuration);
  if (!state) throw new Error('portable migration configuration was not prepared by Tixkit');
  return state;
}

function assertContext(
  state: Pick<VerifiedPortableMigrationState, 'destinationTenantId' | 'destinationOrganizationId'>,
  context: AdapterContext,
): void {
  if (
    context.tenantId !== state.destinationTenantId ||
    context.organizationId !== state.destinationOrganizationId
  ) {
    throw new Error('portable migration destination context does not match its authorization');
  }
}

export function prepareTixkitPortableMigration(input: {
  envelope: SignedPortableBundle;
  destination: Parameters<typeof verifyAndPreflightPortableImport>[1];
  trustedBundleKeys: Parameters<typeof verifyAndPreflightPortableImport>[2];
  trustedPayloadKeys: Parameters<typeof verifyAndPreflightPortableImport>[3];
  trustedPayloadPolicies: Parameters<typeof verifyAndPreflightPortableImport>[4];
  trustedMediaKeys: Parameters<typeof verifyAndPreflightPortableImport>[5];
  trustedMediaPolicies: Parameters<typeof verifyAndPreflightPortableImport>[6];
  destinationTenantId: string;
  destinationOrganizationId: string;
  payloads: ReadonlyMap<string, Uint8Array>;
}): TixkitPortableAdapterConfiguration {
  const envelope = structuredClone(input.envelope);
  const payloads = new Map(
    [...input.payloads].map(([path, bytes]) => [path, Uint8Array.from(bytes)]),
  );
  const preflight = verifyAndPreflightPortableImport(
    envelope,
    input.destination,
    input.trustedBundleKeys,
    input.trustedPayloadKeys,
    input.trustedPayloadPolicies,
    input.trustedMediaKeys,
    input.trustedMediaPolicies,
  );
  if (!preflight.compatible) {
    throw new Error(`portable migration preflight failed: ${preflight.errors.join('; ')}`);
  }
  if (!input.destinationTenantId.trim() || !input.destinationOrganizationId.trim()) {
    throw new Error('portable migration destination tenant and organization are required');
  }
  const aggregateCounts = new Map<PortableSection, number>();
  for (const file of envelope.manifest.files) {
    if (file.section !== 'assets') {
      aggregateCounts.set(file.section, (aggregateCounts.get(file.section) ?? 0) + file.records);
    }
  }
  const declaredCounts = new Map(
    Object.entries(envelope.manifest.entityCounts).filter(
      (entry): entry is [PortableSection, number] => Number.isSafeInteger(entry[1]),
    ),
  );
  if (
    aggregateCounts.size !== declaredCounts.size ||
    [...aggregateCounts].some(([section, count]) => declaredCounts.get(section) !== count)
  ) {
    throw new Error('portable migration entity counts do not match its exact payload files');
  }
  const unsupported = envelope.manifest.files.filter(
    (file) => file.section === 'assets' || !sectionToEntity.has(file.section),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `portable migration contains unsupported sections: ${[
        ...new Set(unsupported.map(({ section }) => section)),
      ].join(', ')}`,
    );
  }
  for (const file of envelope.manifest.files) {
    const bytes = payloads.get(file.path);
    if (
      !bytes ||
      bytes.byteLength !== file.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    ) {
      throw new Error(`portable migration payload integrity failed: ${file.path}`);
    }
  }
  if (payloads.size !== envelope.manifest.files.length) {
    throw new Error('portable migration contains unexpected payload files');
  }
  const configuration: TixkitPortableAdapterConfiguration = Object.freeze({
    [verifiedConfiguration]: true as const,
  });
  verifiedStates.set(configuration, {
    manifest: envelope.manifest,
    payloads,
    destinationTenantId: input.destinationTenantId,
    destinationOrganizationId: input.destinationOrganizationId,
  });
  return configuration;
}

export function prepareTixkitPortableUpload(
  bytes: Uint8Array,
  trust: TixkitPortableImportTrust,
): TixkitPortableAdapterConfiguration {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = parsePortableJson(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('portable migration upload must be an object');
  }
  const upload = parsed as { envelope?: unknown; payloads?: unknown };
  if (
    Object.keys(upload).some((key) => key !== 'envelope' && key !== 'payloads') ||
    !upload.envelope ||
    typeof upload.envelope !== 'object' ||
    Array.isArray(upload.envelope) ||
    !upload.payloads ||
    typeof upload.payloads !== 'object' ||
    Array.isArray(upload.payloads)
  ) {
    throw new Error('portable migration upload shape is invalid');
  }
  const payloads = new Map<string, Uint8Array>();
  let decodedBytes = 0;
  for (const [path, encoded] of Object.entries(upload.payloads)) {
    if (
      typeof encoded !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)
    ) {
      throw new Error(`portable migration payload encoding is invalid: ${path}`);
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64') !== encoded) {
      throw new Error(`portable migration payload encoding is not canonical: ${path}`);
    }
    decodedBytes += decoded.byteLength;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 50 * 1024 * 1024) {
      throw new Error('portable migration decoded payloads exceed the import limit');
    }
    payloads.set(path, decoded);
  }
  return prepareTixkitPortableMigration({
    ...trust,
    envelope: upload.envelope as SignedPortableBundle,
    payloads,
  });
}

interface PortableMigrationRecord {
  portableId: string;
  attributes: Readonly<Record<string, unknown>>;
  dependencies?: Array<{ section: PortableSection; portableId: string }>;
  financialSnapshot?: NormalizedMigrationEntity['financialSnapshot'];
}

function records(file: PortableBundleFile, bytes: Uint8Array): PortableMigrationRecord[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (file.contentType === 'application/octet-stream') {
    throw new Error(`portable logical section cannot be binary: ${file.path}`);
  }
  const parsed =
    file.contentType === 'application/jsonl'
      ? text
          .split('\n')
          .filter(Boolean)
          .map((line) => parsePortableJson(line))
      : [parsePortableJson(text)];
  if (parsed.length !== file.records) {
    throw new Error(`portable payload record count does not match ${file.path}`);
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`portable record must be an object: ${file.path}:${index + 1}`);
    }
    const record = value as unknown as PortableMigrationRecord;
    if (
      typeof record.portableId !== 'string' ||
      !record.portableId.trim() ||
      !record.attributes ||
      typeof record.attributes !== 'object' ||
      Array.isArray(record.attributes) ||
      (record.dependencies !== undefined &&
        (!Array.isArray(record.dependencies) ||
          record.dependencies.some(
            (dependency) =>
              !dependency ||
              typeof dependency !== 'object' ||
              !sectionToEntity.has(dependency.section) ||
              typeof dependency.portableId !== 'string' ||
              !dependency.portableId.trim(),
          )))
    ) {
      throw new Error(`portable record shape is invalid: ${file.path}:${index + 1}`);
    }
    return record;
  });
}

export class TixkitPortableMigrationAdapter implements MigrationAdapter<
  TixkitPortableAdapterConfiguration,
  string
> {
  readonly id = 'tixkit-portable';
  readonly supportedVersions = ['tixkit-portable-bundle-v1'];

  async discover(
    configuration: TixkitPortableAdapterConfiguration,
    _context: AdapterContext,
  ): Promise<MigrationDiscovery> {
    const state = verifiedState(configuration);
    assertContext(state, _context);
    const { manifest } = state;
    const entityCounts = new Map<MigrationEntityType, number>();
    for (const file of manifest.files) {
      if (file.section === 'assets') continue;
      const entityType = sectionToEntity.get(file.section);
      if (entityType)
        entityCounts.set(entityType, (entityCounts.get(entityType) ?? 0) + file.records);
    }
    const entities = [...entityCounts].map(([type, estimatedRows]) => ({ type, estimatedRows }));
    const unsupportedFeatures = [
      ...new Set(
        manifest.files
          .filter((file) => file.section !== 'assets' && !sectionToEntity.has(file.section))
          .map((file) => `portable-section:${file.section}`),
      ),
    ];
    return {
      source: {
        sourceSystem: this.id,
        sourceVersion: manifest.format,
        accountId: manifest.source.deploymentId,
      },
      entities,
      unsupportedFeatures,
    };
  }

  async extract(input: {
    configuration: TixkitPortableAdapterConfiguration;
    discovery: MigrationDiscovery;
    cursor?: string;
    limit: number;
    context: AdapterContext;
  }): Promise<{ rows: readonly ExtractedMigrationRow[]; nextCursor?: string }> {
    const state = verifiedState(input.configuration);
    assertContext(state, input.context);
    const { manifest, payloads } = state;
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('portable extraction limit must be a positive safe integer');
    }
    const allRows: ExtractedMigrationRow[] = [];
    const seen = new Set<string>();
    for (const file of manifest.files) {
      if (file.section === 'assets') continue;
      const entityType = sectionToEntity.get(file.section);
      if (!entityType) continue;
      const bytes = payloads.get(file.path);
      if (!bytes) throw new Error(`portable payload is missing: ${file.path}`);
      for (const [index, record] of records(file, bytes).entries()) {
        const identity = `${entityType}:${record.portableId}`;
        if (seen.has(identity)) {
          throw new Error(`portable migration contains duplicate identity: ${identity}`);
        }
        seen.add(identity);
        const verifiedRecord = structuredClone(record);
        const row: ExtractedMigrationRow = {
          externalId: record.portableId,
          entityType,
          sourcePosition: `${file.path}:${index + 1}`,
          data: structuredClone(record) as unknown as Readonly<Record<string, unknown>>,
        };
        extractedRowStates.set(row, {
          destinationTenantId: state.destinationTenantId,
          destinationOrganizationId: state.destinationOrganizationId,
          externalId: row.externalId,
          entityType: row.entityType,
          sourcePosition: row.sourcePosition,
          record: verifiedRecord,
        });
        allRows.push(row);
      }
    }
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('portable cursor is invalid');
    const rows = allRows.slice(offset, offset + input.limit);
    const nextOffset = offset + rows.length;
    return {
      rows,
      ...(nextOffset < allRows.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async normalize(
    row: ExtractedMigrationRow,
    context: AdapterContext,
  ): Promise<NormalizedMigrationEntity> {
    const state = extractedRowStates.get(row);
    if (!state) throw new Error('portable migration row was not produced by verified extraction');
    assertContext(state, context);
    const { externalId, entityType, sourcePosition } = state;
    const record = structuredClone(state.record);
    if (
      record.financialSnapshot &&
      (record.financialSnapshot.provenance.sourceSystem !== this.id ||
        record.financialSnapshot.provenance.sourceExternalId !== externalId)
    ) {
      throw new Error('portable financial snapshot provenance does not match its signed record');
    }
    return {
      externalId,
      entityType,
      sourcePosition,
      attributes: record.attributes,
      ...(record.dependencies
        ? {
            dependencies: record.dependencies.flatMap((dependency) => {
              const entityType = sectionToEntity.get(dependency.section);
              return entityType ? [{ entityType, externalId: dependency.portableId }] : [];
            }),
          }
        : {}),
      ...(record.financialSnapshot
        ? {
            financialSnapshot: createHistoricalFinancialSnapshot({
              ...record.financialSnapshot,
              kind: record.financialSnapshot.kind,
            }),
          }
        : {}),
    };
  }

  async validate(entity: NormalizedMigrationEntity): Promise<readonly MigrationIssue[]> {
    const issues: MigrationIssue[] = [...validateCanonicalMigrationEntity(entity)];
    if (!entity.attributes || typeof entity.attributes !== 'object') {
      issues.push({
        code: 'portable.attributes.invalid',
        severity: 'fatal',
        message: 'Portable entity attributes must be an object.',
        entityType: entity.entityType,
        externalId: entity.externalId,
      });
    }
    if (
      (entity.entityType === 'historical-payment' || entity.entityType === 'historical-refund') &&
      !entity.financialSnapshot
    ) {
      issues.push({
        code: 'portable.financial_snapshot.required',
        severity: 'fatal',
        message: 'Historical financial entities require a side-effect-suppressed snapshot.',
        entityType: entity.entityType,
        externalId: entity.externalId,
      });
    }
    try {
      assertHistoricalFinancialEntity(entity);
      if (entity.financialSnapshot) {
        createHistoricalFinancialSnapshot(entity.financialSnapshot);
      }
    } catch (error) {
      issues.push({
        code: 'portable.financial_snapshot.invalid',
        severity: 'fatal',
        message: error instanceof Error ? error.message : 'Financial snapshot is invalid.',
        entityType: entity.entityType,
        externalId: entity.externalId,
      });
    }
    return issues;
  }
}

export const tixkitPortableMigrationAdapter = new TixkitPortableMigrationAdapter();
