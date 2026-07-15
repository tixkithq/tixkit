export const MIGRATION_ENTITY_DEPENDENCY_ORDER = [
  'organization',
  'brand',
  'venue',
  'event',
  'content-document',
  'occurrence',
  'inventory-pool',
  'ticket-type',
  'product',
  'question',
  'discount',
  'access-code',
  'buyer',
  'attendee',
  'historical-order',
  'ticket',
  'historical-payment',
  'historical-refund',
  'check-in',
] as const;

export type MigrationEntityType = (typeof MIGRATION_ENTITY_DEPENDENCY_ORDER)[number];
export type MigrationIssueSeverity = 'fatal' | 'error' | 'warning' | 'info';
export type MigrationDisposition = 'create' | 'update' | 'skip' | 'conflict';

export type MigrationSource = {
  sourceSystem: string;
  sourceVersion?: string;
  accountId?: string;
};

export type MigrationDiscovery = {
  source: MigrationSource;
  entities: readonly { type: MigrationEntityType; estimatedRows?: number }[];
  unsupportedFeatures?: readonly string[];
};

export type ExtractedMigrationRow = {
  externalId: string;
  entityType: MigrationEntityType;
  sourcePosition: string;
  data: Readonly<Record<string, unknown>>;
};

export type FinancialSnapshot = {
  kind: 'historical-payment' | 'historical-refund';
  amountMinor: number;
  currency: string;
  providerReference?: string;
  occurredAt: string;
  provenance: { sourceSystem: string; sourceExternalId: string; importedAt: string };
  reconciliationStatus: 'unreconciled' | 'reconciled';
  sideEffects: 'suppressed';
};

export type NormalizedMigrationEntity = {
  externalId: string;
  entityType: MigrationEntityType;
  sourcePosition: string;
  attributes: Readonly<Record<string, unknown>>;
  dependencies?: readonly { entityType: MigrationEntityType; externalId: string }[];
  financialSnapshot?: FinancialSnapshot;
};

export type MigrationIssue = {
  code: string;
  severity: MigrationIssueSeverity;
  message: string;
  entityType?: MigrationEntityType;
  externalId?: string;
  sourcePosition?: string;
  field?: string;
};

export type AdapterContext = {
  tenantId: string;
  organizationId: string;
  signal?: AbortSignal;
};

export type MigrationCredentialReference = {
  id: string;
  tenantId: string;
  organizationId: string;
  sourceSystem: string;
  secretReference: string;
  expiresAt: string;
};

/** Resolve only inside a non-replayable activity; returned material must never be persisted. */
export interface MigrationCredentialResolver<Material = unknown> {
  resolve(
    reference: MigrationCredentialReference,
    context: { signal?: AbortSignal },
  ): Promise<{ material: Material; expiresAt: string }>;
}

export interface MigrationAdapter<Configuration = unknown, Cursor = string> {
  readonly id: string;
  readonly supportedVersions: readonly string[];
  discover(configuration: Configuration, context: AdapterContext): Promise<MigrationDiscovery>;
  extract(input: {
    configuration: Configuration;
    discovery: MigrationDiscovery;
    cursor?: Cursor;
    limit: number;
    context: AdapterContext;
  }): Promise<{ rows: readonly ExtractedMigrationRow[]; nextCursor?: Cursor }>;
  normalize(
    row: ExtractedMigrationRow,
    context: AdapterContext,
  ): Promise<NormalizedMigrationEntity>;
  validate(
    entity: NormalizedMigrationEntity,
    context: AdapterContext,
  ): Promise<readonly MigrationIssue[]>;
}

export type ExistingMapping = {
  tenantId: string;
  sourceSystem: string;
  entityType: MigrationEntityType;
  externalId: string;
  tixkitId: string;
};

export type DryRunRow = {
  entity: NormalizedMigrationEntity;
  disposition: MigrationDisposition;
  issues: readonly MigrationIssue[];
};

export type DryRunReport = {
  mode: 'dry-run';
  domainWrites: 0;
  counts: Readonly<Record<MigrationDisposition, number>>;
  severityCounts: Readonly<Record<MigrationIssueSeverity, number>>;
  rows: readonly DryRunRow[];
  issues: readonly MigrationIssue[];
  unsupportedFeatures: readonly string[];
  duplicateExternalIds: readonly string[];
  mappingFailures: readonly string[];
  timezoneIssues: number;
  currencyIssues: number;
  dateIssues: number;
  estimate: { runtimeMs: number; storageBytes: number };
};

const dependencyRank = new Map<MigrationEntityType, number>(
  MIGRATION_ENTITY_DEPENDENCY_ORDER.map((type, index) => [type, index]),
);

export function sortEntitiesByDependency(
  entities: readonly NormalizedMigrationEntity[],
): NormalizedMigrationEntity[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- copy preserves the caller's readonly array.
  return [...entities].sort((left, right) => {
    const rank =
      (dependencyRank.get(left.entityType) ?? Number.MAX_SAFE_INTEGER) -
      (dependencyRank.get(right.entityType) ?? Number.MAX_SAFE_INTEGER);
    return (
      rank ||
      left.externalId.localeCompare(right.externalId) ||
      left.sourcePosition.localeCompare(right.sourcePosition)
    );
  });
}

export function migrationIdempotencyKey(input: {
  tenantId: string;
  sourceSystem: string;
  entityType: MigrationEntityType;
  externalId: string;
}): string {
  return [input.tenantId, input.sourceSystem, input.entityType, input.externalId]
    .map((part) => encodeURIComponent(part.trim().normalize('NFC')))
    .join(':');
}

export function chunkMigrationEntities(
  entities: readonly NormalizedMigrationEntity[],
  chunkSize: number,
): NormalizedMigrationEntity[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new RangeError('chunkSize must be a positive safe integer');
  const sorted = sortEntitiesByDependency(entities);
  const chunks: NormalizedMigrationEntity[][] = [];
  for (let index = 0; index < sorted.length; index += chunkSize)
    chunks.push(sorted.slice(index, index + chunkSize));
  return chunks;
}

export function createHistoricalFinancialSnapshot(
  input: Omit<FinancialSnapshot, 'sideEffects'>,
): FinancialSnapshot {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0)
    throw new RangeError('amountMinor must be a non-negative safe integer');
  if (!/^[A-Z]{3}$/u.test(input.currency))
    throw new TypeError('currency must be an uppercase ISO 4217 code');
  if (
    !Number.isFinite(Date.parse(input.occurredAt)) ||
    !Number.isFinite(Date.parse(input.provenance.importedAt))
  )
    throw new TypeError('financial snapshot timestamps must be valid ISO timestamps');
  return { ...input, currency: input.currency, sideEffects: 'suppressed' };
}

export function assertHistoricalFinancialEntity(entity: NormalizedMigrationEntity): void {
  const financial =
    entity.entityType === 'historical-payment' || entity.entityType === 'historical-refund';
  if (!financial) {
    if (entity.financialSnapshot)
      throw new TypeError('financialSnapshot is only valid for historical financial entities');
    return;
  }
  if (
    !entity.financialSnapshot ||
    entity.financialSnapshot.kind !== entity.entityType ||
    entity.financialSnapshot.sideEffects !== 'suppressed'
  )
    throw new TypeError(
      'historical financial entities require a matching side-effect-suppressed snapshot',
    );
}

export function buildDryRunReport(input: {
  rows: readonly DryRunRow[];
  unsupportedFeatures?: readonly string[];
  bytesPerRow?: number;
  millisecondsPerRow?: number;
}): DryRunReport {
  const counts = { create: 0, update: 0, skip: 0, conflict: 0 };
  const severityCounts = { fatal: 0, error: 0, warning: 0, info: 0 };
  const issues: MigrationIssue[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of input.rows) {
    counts[row.disposition] += 1;
    const key = `${row.entity.entityType}:${row.entity.externalId}`;
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
    for (const issue of row.issues) {
      severityCounts[issue.severity] += 1;
      issues.push(issue);
    }
  }
  const bytesPerRow = input.bytesPerRow ?? 2048;
  const millisecondsPerRow = input.millisecondsPerRow ?? 3;
  if (
    !Number.isFinite(bytesPerRow) ||
    bytesPerRow < 0 ||
    !Number.isFinite(millisecondsPerRow) ||
    millisecondsPerRow < 0
  )
    throw new RangeError('estimate rates must be finite and non-negative');
  return {
    mode: 'dry-run',
    domainWrites: 0,
    counts,
    severityCounts,
    rows: [...input.rows],
    issues,
    // oxlint-disable-next-line unicorn/no-array-sort -- deterministic public report output.
    unsupportedFeatures: [...new Set(input.unsupportedFeatures ?? [])].sort(),
    // oxlint-disable-next-line unicorn/no-array-sort -- deterministic public report output.
    duplicateExternalIds: [...duplicates].sort(),
    mappingFailures: issues
      .filter((issue) => issue.code.startsWith('MAPPING_'))
      .map((issue) => issue.externalId ?? issue.sourcePosition ?? issue.code),
    timezoneIssues: issues.filter((issue) => issue.code.startsWith('TIMEZONE_')).length,
    currencyIssues: issues.filter((issue) => issue.code.startsWith('CURRENCY_')).length,
    dateIssues: issues.filter((issue) => issue.code.startsWith('DATE_')).length,
    estimate: {
      runtimeMs: Math.ceil(input.rows.length * millisecondsPerRow),
      storageBytes: Math.ceil(input.rows.length * bytesPerRow),
    },
  };
}

export type ImportedEntityActivity = {
  newSales: number;
  scans: number;
  transfers: number;
  edits: number;
  providerEvents: number;
  downstreamReferences: number;
};

export type RollbackAssessment =
  | {
      eligible: true;
      mode: 'cancel-before-commit' | 'delete-untouched-before-activation';
      entityIds: readonly string[];
    }
  | { eligible: false; mode: 'corrective-plan'; reasons: readonly string[] };

export function assessRollback(input: {
  committed: boolean;
  activated: boolean;
  createdEntities: readonly { id: string; activity?: Partial<ImportedEntityActivity> }[];
}): RollbackAssessment {
  if (!input.committed) return { eligible: true, mode: 'cancel-before-commit', entityIds: [] };
  const reasons: string[] = [];
  if (input.activated) reasons.push('job is activated');
  for (const entity of input.createdEntities) {
    if (!entity.activity) {
      reasons.push(`${entity.id}: activity state unavailable`);
      continue;
    }
    for (const field of [
      'newSales',
      'scans',
      'transfers',
      'edits',
      'providerEvents',
      'downstreamReferences',
    ] as const) {
      const count = entity.activity[field];
      if (count === undefined) reasons.push(`${entity.id}: ${field} not checked`);
      else if (!Number.isSafeInteger(count) || count < 0)
        reasons.push(`${entity.id}: invalid ${field} count`);
      else if (count > 0) reasons.push(`${entity.id}: has ${field}`);
    }
  }
  return reasons.length > 0
    ? { eligible: false, mode: 'corrective-plan', reasons }
    : {
        eligible: true,
        mode: 'delete-untouched-before-activation',
        entityIds: input.createdEntities.map(({ id }) => id),
      };
}

export * from './conformance.js';
export * from './credential-reference.js';
export * from './canonical.js';
export * from './preparation.js';

export function canCommitDryRun(report: DryRunReport): boolean {
  return (
    report.severityCounts.fatal === 0 &&
    report.severityCounts.error === 0 &&
    report.counts.conflict === 0
  );
}

export * from './adapters/generic-csv/index.js';
export * from './adapters/pretix/index.js';
export * from './adapters/hi-events/index.js';
export * from './adapters/eventbrite/index.js';
export * from './adapters/ticket-tailor/index.js';
export * from './adapters/bespoke/index.js';
export * from './adapters/registry.js';
export * from './adapters/tixkit-portable/index.js';
export { SANITIZED_PRETIX_OFFICIAL_API_FIXTURE } from './adapters/pretix/fixtures.js';
export { SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE } from './adapters/hi-events/fixtures.js';
export { eventbriteApiV3Fixture } from './adapters/eventbrite/fixture.js';
export { ticketTailorApiV1Fixture } from './adapters/ticket-tailor/fixture.js';
