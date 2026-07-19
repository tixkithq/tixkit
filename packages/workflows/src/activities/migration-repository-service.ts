import { ImportRepository, type Database } from '@tixkit/db';
import {
  canonicalPortableJson,
  portableImportControlInputSha256,
  portableRebindingProvenanceSha256,
  reconcilePortableImport,
  type PortableBundleManifest,
  type PortableCutoverProof,
  type PortableSection,
  type PortabilityFinancialTotals,
} from '@tixkit/portability';
import { createHash } from 'node:crypto';
import {
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  assertHistoricalFinancialEntity,
  parseMigrationPreparationConfiguration,
  portableSectionForMigrationEntity,
  type MigrationCredentialResolver,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import type {
  MigrationActivityContext,
  MigrationActivityService,
  MigrationCommitStage,
  MigrationFailure,
  MigrationRollbackAssessment,
  MigrationStageResult,
  MigrationWorkflowProgress,
  MigrationTerminalProgressSummary,
} from './migration.js';
import { MIGRATION_COMMIT_STAGES } from './migration.js';
import { resolvePortableCanonicalAdoption } from './migration-domain-committers.js';

export type MigrationCommitOutcome = {
  disposition: 'created' | 'updated' | 'skipped' | 'conflict';
  tixkitId?: string;
};

export interface MigrationDomainCommitter {
  assessReconciled(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    tixkitId: string;
    externalId: string;
    entity: NormalizedMigrationEntity;
  }): Promise<{ reconciled: boolean; reason?: string }>;
  assessUntouched(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    tixkitId: string;
  }): Promise<{ eligible: boolean; reason?: string }>;
  commit(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    entity: NormalizedMigrationEntity;
    sideEffects: MigrationActivityContext['sideEffects'];
  }): Promise<MigrationCommitOutcome>;
  deleteUntouched(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    tixkitId: string;
  }): Promise<boolean>;
}

export type MigrationCommitterRegistry = ReadonlyMap<MigrationEntityType, MigrationDomainCommitter>;

export type MigrationRepositoryActivityHooks = {
  claimLeaseMs?: number;
  afterRowsClaimed?(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    stage: MigrationCommitStage;
    rowIds: string[];
  }): Promise<void> | void;
  afterRowCompletion?(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    stage: MigrationCommitStage;
    rowId: string;
  }): Promise<void> | void;
};

const STAGE_ENTITIES: Record<MigrationCommitStage, readonly MigrationEntityType[]> = {
  organizations_brands: ['organization', 'brand'],
  venues: ['venue'],
  events_occurrences: ['event', 'occurrence'],
  content: ['content-document'],
  inventory_pools: ['inventory-pool'],
  ticket_types_products: ['ticket-type', 'product'],
  questions: ['question'],
  discounts_access_codes: ['discount', 'access-code'],
  buyers_attendees: ['buyer', 'attendee'],
  historical_orders: ['historical-order'],
  tickets: ['ticket'],
  historical_payments_refunds: ['historical-payment', 'historical-refund'],
  check_in_history: ['check-in'],
};

export function assertMigrationCommittersRegistered(registry: MigrationCommitterRegistry): void {
  const missing = MIGRATION_ENTITY_DEPENDENCY_ORDER.filter((type) => !registry.has(type));
  if (missing.length > 0) {
    throw new Error(`MIGRATION_COMMITTERS_MISSING:${missing.join(',')}`);
  }
}

function parseEntity(serialized: string | null): NormalizedMigrationEntity {
  if (!serialized) throw new Error('MIGRATION_NORMALIZED_DATA_REQUIRED');
  const parsed = JSON.parse(serialized) as NormalizedMigrationEntity;
  if (!parsed || typeof parsed !== 'object' || !parsed.entityType || !parsed.externalId) {
    throw new Error('MIGRATION_NORMALIZED_DATA_INVALID');
  }
  assertHistoricalFinancialEntity(parsed);
  return parsed;
}

function progressSummary(progress: MigrationWorkflowProgress): MigrationWorkflowProgress {
  return {
    ...(progress.stage === undefined ? {} : { stage: progress.stage }),
    stageIndex: progress.stageIndex,
    stageCount: progress.stageCount,
    processed: progress.processed,
    created: progress.created,
    updated: progress.updated,
    skipped: progress.skipped,
    conflicts: progress.conflicts,
    failed: progress.failed,
  };
}

const MIGRATION_PROGRESS_COUNTERS = [
  'processed',
  'created',
  'updated',
  'skipped',
  'conflicts',
  'failed',
] as const;

const MIGRATION_COMMITTING_SUMMARY_KEYS = [
  'status',
  'stage',
  'stageIndex',
  'stageCount',
  ...MIGRATION_PROGRESS_COUNTERS,
] as const;

const MIGRATION_TERMINAL_SUMMARY_KEYS = [
  'status',
  'stageIndex',
  'stageCount',
  ...MIGRATION_PROGRESS_COUNTERS,
] as const;

type MigrationCommittingProgressSummary = MigrationWorkflowProgress & {
  stage: MigrationCommitStage;
  status: 'committing';
};

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    [...expectedKeys].sort().every((key, index) => actualKeys[index] === key)
  );
}

function parseCommitProgressSummary(
  serialized: string | null,
  expectedStatus: 'committing',
): MigrationCommittingProgressSummary;
function parseCommitProgressSummary(
  serialized: string | null,
  expectedStatus: 'completed',
): MigrationTerminalProgressSummary;
function parseCommitProgressSummary(
  serialized: string | null,
  expectedStatus: 'committing' | 'completed',
): MigrationCommittingProgressSummary | MigrationTerminalProgressSummary {
  let parsed: unknown;
  try {
    parsed = serialized ? JSON.parse(serialized) : undefined;
  } catch {
    throw new Error('MIGRATION_PROGRESS_SUMMARY_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('MIGRATION_PROGRESS_SUMMARY_INVALID');
  const progress = parsed as Record<string, unknown>;
  if (progress.status !== expectedStatus)
    throw new Error('MIGRATION_PROGRESS_SUMMARY_STATUS_INVALID');
  const expectedKeys =
    expectedStatus === 'committing'
      ? MIGRATION_COMMITTING_SUMMARY_KEYS
      : MIGRATION_TERMINAL_SUMMARY_KEYS;
  if (!hasExactKeys(progress, expectedKeys))
    throw new Error('MIGRATION_PROGRESS_SUMMARY_KEYS_INVALID');
  for (const field of MIGRATION_PROGRESS_COUNTERS) {
    if (!Number.isSafeInteger(progress[field]) || Number(progress[field]) < 0)
      throw new Error(`MIGRATION_PROGRESS_SUMMARY_COUNTER_INVALID:${field}`);
  }
  if (
    Number(progress.processed) !==
    Number(progress.created) +
      Number(progress.updated) +
      Number(progress.skipped) +
      Number(progress.conflicts) +
      Number(progress.failed)
  )
    throw new Error('MIGRATION_PROGRESS_SUMMARY_TOTAL_INVALID');
  if (progress.stageCount !== MIGRATION_COMMIT_STAGES.length)
    throw new Error('MIGRATION_PROGRESS_SUMMARY_STAGE_COUNT_INVALID');
  if (
    expectedStatus === 'committing' &&
    (progress.stageIndex !== MIGRATION_COMMIT_STAGES.length - 1 ||
      progress.stage !== MIGRATION_COMMIT_STAGES.at(-1))
  )
    throw new Error('MIGRATION_PROGRESS_SUMMARY_FINAL_STAGE_INVALID');
  if (
    expectedStatus === 'completed' &&
    (progress.stageIndex !== MIGRATION_COMMIT_STAGES.length || 'stage' in progress)
  )
    throw new Error('MIGRATION_PROGRESS_SUMMARY_TERMINAL_STAGE_INVALID');
  return progress as MigrationCommittingProgressSummary | MigrationTerminalProgressSummary;
}

function stageCheckpointKey(claimOwner: string): string {
  return `commit:stage-result:${createHash('sha256').update(claimOwner).digest('hex')}`;
}

function stageRowEventPrefix(claimOwnerSha256: string): string {
  return `commit:stage-row:${claimOwnerSha256}:`;
}

function stageRowEventKey(claimOwnerSha256: string, rowId: string): string {
  return `${stageRowEventPrefix(claimOwnerSha256)}${createHash('sha256').update(rowId).digest('hex')}`;
}

type StageRowLedger = {
  version: 1;
  stage: MigrationCommitStage;
  claimOwnerSha256: string;
  rowId: string;
  batchRowIds: string[];
  outcome: 'created' | 'updated' | 'skipped' | 'conflict' | 'failed';
  complete: boolean;
  nextCursor?: string;
};

function parseStageRowLedger(
  serialized: string | null,
  expectedStage: MigrationCommitStage,
  expectedClaimOwnerSha256: string,
): StageRowLedger {
  let ledger: Partial<StageRowLedger>;
  try {
    ledger = JSON.parse(serialized ?? '') as Partial<StageRowLedger>;
  } catch (error) {
    throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID', { cause: error });
  }
  const outcomes = new Set(['created', 'updated', 'skipped', 'conflict', 'failed']);
  if (
    ledger.version !== 1 ||
    ledger.stage !== expectedStage ||
    ledger.claimOwnerSha256 !== expectedClaimOwnerSha256 ||
    typeof ledger.rowId !== 'string' ||
    !Array.isArray(ledger.batchRowIds) ||
    ledger.batchRowIds.length === 0 ||
    ledger.batchRowIds.some((rowId) => typeof rowId !== 'string') ||
    new Set(ledger.batchRowIds).size !== ledger.batchRowIds.length ||
    !ledger.batchRowIds.includes(ledger.rowId) ||
    typeof ledger.outcome !== 'string' ||
    !outcomes.has(ledger.outcome) ||
    typeof ledger.complete !== 'boolean' ||
    (ledger.nextCursor !== undefined && typeof ledger.nextCursor !== 'string')
  )
    throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
  return ledger as StageRowLedger;
}

function resultFromStageRowLedgers(ledgers: StageRowLedger[]): MigrationStageResult {
  const first = ledgers[0];
  if (!first) throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
  const batchIdentity = JSON.stringify({
    batchRowIds: first.batchRowIds,
    complete: first.complete,
    nextCursor: first.nextCursor,
  });
  const seenRows = new Set<string>();
  const result: MigrationStageResult = {
    processed: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    complete: first.complete,
    ...(first.nextCursor ? { nextCursor: first.nextCursor } : {}),
  };
  for (const ledger of ledgers) {
    if (
      JSON.stringify({
        batchRowIds: ledger.batchRowIds,
        complete: ledger.complete,
        nextCursor: ledger.nextCursor,
      }) !== batchIdentity ||
      seenRows.has(ledger.rowId)
    )
      throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
    seenRows.add(ledger.rowId);
    result.processed += 1;
    if (ledger.outcome === 'conflict') result.conflicts += 1;
    else result[ledger.outcome] += 1;
  }
  return result;
}

function parseStageCheckpoint(
  serialized: string | null,
  expectedStage: MigrationCommitStage,
  expectedClaimOwnerSha256: string,
): MigrationStageResult {
  let checkpoint: {
    version?: unknown;
    stage?: unknown;
    claimOwnerSha256?: unknown;
    result?: Record<string, unknown>;
  };
  try {
    checkpoint = JSON.parse(serialized ?? '') as typeof checkpoint;
  } catch (error) {
    throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID', { cause: error });
  }
  if (
    checkpoint.version !== 1 ||
    checkpoint.stage !== expectedStage ||
    checkpoint.claimOwnerSha256 !== expectedClaimOwnerSha256 ||
    !checkpoint.result ||
    typeof checkpoint.result.complete !== 'boolean'
  )
    throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID');
  const numericKeys = [
    'processed',
    'created',
    'updated',
    'skipped',
    'conflicts',
    'failed',
  ] as const;
  for (const key of numericKeys) {
    const value = checkpoint.result[key];
    if (!Number.isInteger(value) || (value as number) < 0)
      throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID');
  }
  if (
    checkpoint.result.nextCursor !== undefined &&
    typeof checkpoint.result.nextCursor !== 'string'
  )
    throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID');
  return checkpoint.result as MigrationStageResult;
}

type ImportRow = Awaited<ReturnType<ImportRepository['listRows']>>[number];

function parsePortableEvidence<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`PORTABLE_IMPORT_RECONCILIATION_${label}_INVALID`, {
      cause: error,
    });
  }
}

function financialTotals(
  values: Array<{
    kind: string;
    amountMinor: string | number | bigint;
    currency: string;
  }>,
): PortabilityFinancialTotals[] {
  const totals = new Map<string, { gross: bigint; refunded: bigint }>();
  for (const value of values) {
    const currency = value.currency.toUpperCase();
    if (!/^[A-Z]{3}$/u.test(currency))
      throw new Error('PORTABLE_IMPORT_RECONCILIATION_FINANCIAL_CURRENCY_INVALID');
    let amount: bigint;
    try {
      amount = BigInt(value.amountMinor);
    } catch (error) {
      throw new Error('PORTABLE_IMPORT_RECONCILIATION_FINANCIAL_AMOUNT_INVALID', {
        cause: error,
      });
    }
    if (amount < 0n) throw new Error('PORTABLE_IMPORT_RECONCILIATION_FINANCIAL_AMOUNT_INVALID');
    const total = totals.get(currency) ?? { gross: 0n, refunded: 0n };
    if (value.kind === 'historical-payment') total.gross += amount;
    else if (value.kind === 'historical-refund') total.refunded += amount;
    else throw new Error('PORTABLE_IMPORT_RECONCILIATION_FINANCIAL_KIND_INVALID');
    totals.set(currency, total);
  }
  return [...totals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({
      currency,
      grossMinor: String(total.gross),
      refundedMinor: String(total.refunded),
      netMinor: String(total.gross - total.refunded),
    }));
}

export async function portableReconciliationReport(input: {
  db: Database;
  repository: ImportRepository;
  context: Pick<MigrationActivityContext, 'tenantId' | 'organizationId' | 'jobId'>;
  rows: ImportRow[];
  unresolvedRows: ImportRow[];
  committers: MigrationCommitterRegistry;
}) {
  const preflight = await input.repository.findPortablePreflight(
    input.context.tenantId,
    input.context.organizationId,
    input.context.jobId,
  );
  if (!preflight) throw new Error('PORTABLE_IMPORT_RECONCILIATION_PREFLIGHT_REQUIRED');
  const expectedCounts = parsePortableEvidence<Partial<Record<PortableSection, number>>>(
    preflight.expected_counts,
    'COUNTS',
  );
  const expectedAssets = parsePortableEvidence<Array<{ portableId: string; sha256: string }>>(
    preflight.expected_assets,
    'ASSETS',
  );
  const manifest = parsePortableEvidence<PortableBundleManifest>(
    preflight.manifest_json,
    'MANIFEST',
  );
  const expectedAssetIds = new Set(expectedAssets.map(({ portableId }) => portableId));
  const successfulRows = input.rows.filter((row) =>
    ['created', 'updated', 'skipped'].includes(row.status),
  );
  const actualCounts: Partial<Record<PortableSection, number>> = {};
  const canonicalIdentities = new Set<string>();
  const assessmentCandidates: Array<{
    row: ImportRow & { external_id: string; tixkit_id: string };
    entityType: MigrationEntityType;
    entity: NormalizedMigrationEntity;
  }> = [];
  const unresolvedDependencies = input.unresolvedRows.map((row) => ({
    portableId: row.external_id ?? row.id,
    reason: `Import row ended in ${row.status}`,
  }));
  for (const row of successfulRows) {
    const entityType = row.entity_type as MigrationEntityType;
    const section = portableSectionForMigrationEntity(entityType);
    const entity = row.normalized_data
      ? parsePortableEvidence<NormalizedMigrationEntity>(row.normalized_data, 'ROW')
      : undefined;
    if (!section || !row.tixkit_id || !row.external_id || !entity) {
      unresolvedDependencies.push({
        portableId: row.external_id ?? row.id,
        reason: !section
          ? `Unsupported entity type ${row.entity_type}`
          : !row.tixkit_id
            ? 'Canonical ID is missing'
            : !row.external_id
              ? 'Source identity is missing'
              : 'Normalized entity is missing',
      });
      continue;
    }
    const canonicalIdentity = `${section}:${row.tixkit_id}`;
    if (canonicalIdentities.has(canonicalIdentity)) {
      unresolvedDependencies.push({
        portableId: row.external_id,
        reason: `Multiple source rows map to ${canonicalIdentity}`,
      });
      continue;
    }
    canonicalIdentities.add(canonicalIdentity);
    actualCounts[section] = (actualCounts[section] ?? 0) + 1;
    assessmentCandidates.push({
      row: row as ImportRow & { external_id: string; tixkit_id: string },
      entityType,
      entity,
    });
  }
  for (let offset = 0; offset < assessmentCandidates.length; offset += 16) {
    const assessments = await Promise.all(
      assessmentCandidates.slice(offset, offset + 16).map(async ({ row, entityType, entity }) => {
        const committer = input.committers.get(entityType);
        const assessment = committer
          ? await committer.assessReconciled({
              tenantId: input.context.tenantId,
              organizationId: input.context.organizationId,
              jobId: input.context.jobId,
              tixkitId: row.tixkit_id,
              externalId: row.external_id,
              entity,
            })
          : {
              reconciled: false,
              reason: `Missing committer for ${entityType}`,
            };
        return { row, assessment };
      }),
    );
    for (const { row, assessment } of assessments) {
      if (!assessment.reconciled)
        unresolvedDependencies.push({
          portableId: row.external_id,
          reason: assessment.reason ?? 'Canonical entity failed reconciliation',
        });
    }
  }

  const eventIds = successfulRows
    .filter((row) => row.entity_type === 'event' && row.tixkit_id)
    .map((row) => row.tixkit_id!);
  const actualAssets: Array<{ portableId: string; sha256: string }> = [];
  for (let offset = 0; offset < eventIds.length; offset += 500) {
    const assets = await input.db
      .selectFrom('event_media_assets as asset')
      .innerJoin('upload_artifacts as upload', 'upload.id', 'asset.upload_artifact_id')
      .select(['asset.id', 'asset.checksum_sha256', 'upload.metadata'])
      .where('asset.tenant_id', '=', input.context.tenantId)
      .where('asset.organization_id', '=', input.context.organizationId)
      .where('asset.event_id', 'in', eventIds.slice(offset, offset + 500))
      .execute();
    for (const asset of assets) {
      const metadata = parsePortableEvidence<{ portableId?: unknown }>(asset.metadata, 'ASSET');
      const portableId =
        typeof metadata.portableId === 'string' && metadata.portableId.trim()
          ? metadata.portableId
          : `destination:${asset.id}`;
      if (manifest.lineage.kind === 'full' || expectedAssetIds.has(portableId))
        actualAssets.push({ portableId, sha256: asset.checksum_sha256 });
    }
  }

  const expectedFinancial = successfulRows.flatMap((row) => {
    const entity = row.normalized_data
      ? parsePortableEvidence<NormalizedMigrationEntity>(row.normalized_data, 'ROW')
      : undefined;
    return entity?.financialSnapshot
      ? [
          {
            kind: entity.financialSnapshot.kind,
            amountMinor: entity.financialSnapshot.amountMinor,
            currency: entity.financialSnapshot.currency,
          },
        ]
      : [];
  });
  const financialIds = successfulRows
    .filter(
      (row) =>
        ['historical-payment', 'historical-refund'].includes(row.entity_type) && row.tixkit_id,
    )
    .map((row) => row.tixkit_id!);
  const actualFinancial: Array<{
    kind: string;
    amountMinor: string | number | bigint;
    currency: string;
  }> = [];
  for (let offset = 0; offset < financialIds.length; offset += 500) {
    const snapshots = await input.db
      .selectFrom('historical_financial_snapshots')
      .select(['kind', 'amount_minor', 'currency'])
      .where('tenant_id', '=', input.context.tenantId)
      .where('organization_id', '=', input.context.organizationId)
      .where('id', 'in', financialIds.slice(offset, offset + 500))
      .execute();
    actualFinancial.push(
      ...snapshots.map((snapshot) => ({
        kind: snapshot.kind,
        amountMinor: snapshot.amount_minor,
        currency: snapshot.currency,
      })),
    );
  }

  const required = parsePortableEvidence<
    Array<{ portableId?: unknown; kind?: unknown; required?: unknown }>
  >(preflight.required_rebindings, 'REBINDINGS').filter(
    (candidate): candidate is { portableId: string; kind: string; required: true } =>
      candidate.required === true &&
      typeof candidate.portableId === 'string' &&
      candidate.portableId.length > 0 &&
      typeof candidate.kind === 'string' &&
      candidate.kind.length > 0,
  );
  const completed = await input.repository.listPortableImportRebindings(
    input.context.tenantId,
    input.context.organizationId,
    input.context.jobId,
  );
  const completedIds = new Set<string>();
  for (const item of completed) {
    if (
      await input.repository.findPortableDestinationResource({
        tenantId: input.context.tenantId,
        organizationId: input.context.organizationId,
        kind: item.kind,
        resourceId: item.destination_reference,
      })
    )
      completedIds.add(item.portable_id);
  }
  return reconcilePortableImport({
    expectedCounts,
    actualCounts,
    expectedAssets,
    actualAssets,
    expectedFinancialTotals: financialTotals(expectedFinancial),
    actualFinancialTotals: financialTotals(actualFinancial),
    unresolvedDependencies,
    requiredRebindingsRemaining: required
      .filter(({ portableId }) => !completedIds.has(portableId))
      .map(({ portableId }) => portableId),
  });
}

async function listAllCreatedRows(repository: ImportRepository, context: MigrationActivityContext) {
  const rows: Awaited<ReturnType<ImportRepository['listRows']>> = [];
  for (let offset = 0; ; offset += 5_000) {
    const page = await repository.listRows({
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      jobId: context.jobId,
      statuses: ['created'],
      limit: 5_000,
      offset,
    });
    rows.push(...page);
    if (page.length < 5_000) return rows;
  }
}

export async function validatePortableCommitCutoverEvidence(
  repository: ImportRepository,
  context: Pick<MigrationActivityContext, 'tenantId' | 'organizationId' | 'jobId'>,
): Promise<void> {
  const authorization = await repository.findPortableImportCommitAuthorization(
    context.tenantId,
    context.organizationId,
    context.jobId,
  );
  if (!authorization) throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_REQUIRED');
  const cutover = await repository.findPortableImportCutoverProof(
    context.tenantId,
    context.organizationId,
    context.jobId,
  );
  const preflight = await repository.findPortablePreflight(
    context.tenantId,
    context.organizationId,
    context.jobId,
  );
  if (!cutover || !preflight) throw new Error('PORTABILITY_COMMIT_CUTOVER_PROOF_REQUIRED');
  let cutoverProof: PortableCutoverProof;
  let manifest: PortableBundleManifest;
  try {
    cutoverProof = JSON.parse(cutover.proof_json) as PortableCutoverProof;
    manifest = JSON.parse(preflight.manifest_json) as PortableBundleManifest;
  } catch {
    throw new Error('PORTABILITY_COMMIT_CUTOVER_PROOF_INVALID');
  }
  if (
    canonicalPortableJson(cutoverProof) !== cutover.proof_json ||
    cutover.validated_by !== authorization.authorized_by ||
    cutover.key_id !== cutoverProof.keyId ||
    cutover.nonce !== cutoverProof.nonce ||
    cutover.receipt_sha256 !== cutoverProof.receiptSha256 ||
    cutoverProof.tenantId !== manifest.source.tenantId ||
    cutoverProof.deploymentId !== preflight.source_deployment_id ||
    cutoverProof.sourceChangeCursor !== preflight.source_change_cursor ||
    cutoverProof.bundleId !== preflight.bundle_id ||
    cutoverProof.manifestSha256 !== preflight.manifest_sha256 ||
    cutoverProof.destinationId !== preflight.destination_id ||
    cutoverProof.operationId !== preflight.operation_id
  )
    throw new Error('PORTABILITY_COMMIT_CUTOVER_PROOF_INVALID');
}

export function createRepositoryMigrationActivityService(
  db: Database,
  committers: MigrationCommitterRegistry,
  credentialResolver?: MigrationCredentialResolver,
  hooks: MigrationRepositoryActivityHooks = {},
): MigrationActivityService {
  assertMigrationCommittersRegistered(committers);
  const repository = new ImportRepository(db);
  const claimedStatus = 'committing';
  const claimLeaseMs = hooks.claimLeaseMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 10)
    throw new Error('MIGRATION_CLAIM_LEASE_INVALID');
  const persistLifecycleOutcome = (
    input: Parameters<ImportRepository['persistMigrationLifecycleCommandOutcome']>[0],
  ) =>
    db
      .transaction()
      .setIsolationLevel('serializable')
      .execute((transaction) =>
        new ImportRepository(transaction as Database).persistMigrationLifecycleCommandOutcome(
          input,
        ),
      );

  return {
    async beginCommit(context) {
      const pendingJob = await repository.findJob(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (!pendingJob) throw new Error('MIGRATION_JOB_NOT_FOUND');
      if (pendingJob.source_system === 'tixkit-portable') {
        await db
          .transaction()
          .setIsolationLevel('serializable')
          .execute(async (transaction) => {
            const transactionRepository = new ImportRepository(transaction as Database);
            const job = await transactionRepository.findJobForUpdate(
              context.tenantId,
              context.organizationId,
              context.jobId,
            );
            const authorization = await transactionRepository.findPortableImportCommitAuthorization(
              context.tenantId,
              context.organizationId,
              context.jobId,
            );
            if (!job || job.source_system !== 'tixkit-portable' || job.mode !== 'commit')
              throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_INVALID');
            if (!authorization) throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_REQUIRED');
            await validatePortableCommitCutoverEvidence(transactionRepository, context);
            const approval = await transactionRepository.findPortableImportApproval({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              approvalId: authorization.approval_id,
            });
            const revocation = approval
              ? await transactionRepository.findPortableImportApprovalRevocation({
                  tenantId: context.tenantId,
                  organizationId: context.organizationId,
                  jobId: context.jobId,
                  approvalId: approval.id,
                })
              : undefined;
            if (
              !approval ||
              revocation ||
              approval.approval_digest !== authorization.approval_digest ||
              approval.rebindings_sha256 !== authorization.rebindings_sha256 ||
              approval.approved_by !== authorization.authorized_by ||
              new Date(authorization.authorized_at) < new Date(approval.created_at) ||
              new Date(authorization.authorized_at) > new Date(approval.expires_at)
            )
              throw new Error('PORTABILITY_COMMIT_AUTHORIZATION_INVALID');
            const rebindings = await transactionRepository.listPortableImportRebindings(
              context.tenantId,
              context.organizationId,
              context.jobId,
            );
            for (const rebinding of rebindings) {
              if (
                rebinding.provenance_sha256 !==
                  portableRebindingProvenanceSha256({
                    kind: rebinding.kind as Parameters<
                      typeof portableRebindingProvenanceSha256
                    >[0]['kind'],
                    portableId: rebinding.portable_id,
                    destinationReference: rebinding.destination_reference,
                  }) ||
                !(await transactionRepository.findPortableDestinationResource({
                  tenantId: context.tenantId,
                  organizationId: context.organizationId,
                  kind: rebinding.kind,
                  resourceId: rebinding.destination_reference,
                  lockForAuthorization: true,
                }))
              )
                throw new Error('PORTABILITY_COMMIT_REBINDING_INVALID');
            }
            const rebindingsSha256 = createHash('sha256')
              .update(
                canonicalPortableJson(
                  rebindings.map((rebinding) => ({
                    portableId: rebinding.portable_id,
                    kind: rebinding.kind,
                    destinationReference: rebinding.destination_reference,
                    provenanceSha256: rebinding.provenance_sha256,
                  })),
                ),
              )
              .digest('hex');
            if (rebindingsSha256 !== authorization.rebindings_sha256)
              throw new Error('PORTABILITY_COMMIT_REBINDING_INVALID');
            const rows = [];
            for (let offset = 0; ; offset += 5_000) {
              const page = await transactionRepository.listRows({
                tenantId: context.tenantId,
                organizationId: context.organizationId,
                jobId: context.jobId,
                limit: 5_000,
                offset,
              });
              rows.push(...page);
              if (page.length < 5_000) break;
            }
            const files = await transactionRepository.listFiles(
              context.tenantId,
              context.organizationId,
              context.jobId,
            );
            const mappings = await transactionRepository.listMappings(
              context.tenantId,
              context.organizationId,
              job.source_system,
            );
            const canonicalAdoptions = [];
            for (const row of rows) {
              if (!row.normalized_data) continue;
              const adoption = await resolvePortableCanonicalAdoption(transaction as Database, {
                tenantId: context.tenantId,
                organizationId: context.organizationId,
                sourceSystem: job.source_system,
                entity: JSON.parse(row.normalized_data) as NormalizedMigrationEntity,
                lock: true,
              });
              if (adoption) canonicalAdoptions.push(adoption);
            }
            const inputSha256 = portableImportControlInputSha256({
              configuration: job.configuration ? JSON.parse(job.configuration) : null,
              files: files.map((file) => ({
                id: file.id,
                sha256: file.sha256,
                byteSize: String(file.byte_size),
              })),
              mappings: mappings.map((mapping) => ({
                id: mapping.id,
                version: mapping.version,
                mapping: JSON.parse(mapping.mapping),
              })),
              rows: rows.map((row) => ({
                id: row.id,
                source: JSON.parse(row.source_data),
                normalized: row.normalized_data ? JSON.parse(row.normalized_data) : null,
              })),
              ...(canonicalAdoptions.length > 0 ? { canonicalAdoptions } : {}),
            });
            const dryRunSummary = job.summary
              ? (JSON.parse(job.summary) as {
                  accepted?: boolean;
                  inputHash?: string;
                })
              : null;
            if (
              inputSha256 !== authorization.input_sha256 ||
              inputSha256 !== approval.input_sha256 ||
              dryRunSummary?.accepted !== true ||
              dryRunSummary.inputHash !== inputSha256
            )
              throw new Error('PORTABILITY_COMMIT_INPUT_CHANGED');
            const rawConfiguration = job.configuration
              ? (JSON.parse(job.configuration) as Record<string, unknown>)
              : {};
            const { credentialId: _credentialId, ...sourceConfiguration } = rawConfiguration;
            let preparationConfiguration;
            try {
              preparationConfiguration = parseMigrationPreparationConfiguration(
                { ...sourceConfiguration, sourceSystem: job.source_system },
                job.source_system,
              );
            } catch (error) {
              throw new Error(
                `PORTABILITY_COMMIT_ARTIFACT_CONFIGURATION_INVALID:${JSON.stringify({
                  sourceSystem: job.source_system,
                  sourceConfiguration,
                })}`,
                { cause: error },
              );
            }
            if (preparationConfiguration.sourceMode !== 'official-export') {
              throw new Error('PORTABILITY_COMMIT_ARTIFACT_CONFIGURATION_INVALID');
            }
            await transactionRepository.acquireMigrationArtifactsForStateInTransaction({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              artifactIds: preparationConfiguration.artifactIds,
              targetState: 'committing',
              transition: false,
            });
            await transactionRepository.beginCommit({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
            });
          });
        await repository.appendIdempotentEvent({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          eventKey: 'commit:begin',
          type: 'commit.begin',
          severity: 'info',
          message: 'Authorized portable migration commit started.',
        });
        return;
      }
      const configuration = pendingJob.configuration
        ? (JSON.parse(pendingJob.configuration) as Record<string, unknown>)
        : {};
      if (typeof configuration.credentialId === 'string') {
        try {
          if (!credentialResolver) throw new Error('resolver unavailable');
          const credential = await repository.findActiveCredential({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            credentialId: configuration.credentialId,
            sourceSystem: pendingJob.source_system,
          });
          if (!credential) throw new Error('credential inactive');
          const resolved = await credentialResolver.resolve(
            {
              id: credential.id,
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              sourceSystem: pendingJob.source_system,
              secretReference: credential.secret_reference,
              expiresAt: credential.expires_at.toISOString(),
            },
            {},
          );
          if (
            !resolved.material ||
            !Number.isFinite(Date.parse(resolved.expiresAt)) ||
            Date.parse(resolved.expiresAt) <= Date.now()
          )
            throw new Error('credential expired');
          void resolved.material;
        } catch {
          throw new Error('MIGRATION_CREDENTIAL_UNAVAILABLE');
        }
      }
      const { credentialId: _credentialId, ...sourceConfiguration } = configuration;
      if (configuration.sourceMode === 'official-export') {
        const preparationConfiguration = parseMigrationPreparationConfiguration(
          { ...sourceConfiguration, sourceSystem: pendingJob.source_system },
          pendingJob.source_system,
        );
        if (preparationConfiguration.sourceMode !== 'official-export') {
          throw new Error('MIGRATION_ARTIFACT_CONFIGURATION_INVALID');
        }
        await repository.acquireMigrationArtifactsForState({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          artifactIds: preparationConfiguration.artifactIds,
          targetState: 'committing',
          transition: true,
        });
      } else {
        await repository.beginCommit({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
        });
      }
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'commit:begin',
        type: 'commit.begin',
        severity: 'info',
        message: 'Migration commit started.',
      });
    },

    async processStage(context, input): Promise<MigrationStageResult> {
      const entityTypes = STAGE_ENTITIES[input.stage];
      const job = await repository.findJob(context.tenantId, context.organizationId, context.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      if (job.mode !== 'commit') throw new Error('MIGRATION_DRY_RUN_CANNOT_COMMIT');
      if (job.status !== 'committing')
        throw new Error(`MIGRATION_JOB_NOT_COMMITTING:${job.status}`);
      const claimOwnerSha256 = createHash('sha256').update(input.claimOwner).digest('hex');
      const checkpointKey = stageCheckpointKey(input.claimOwner);
      const checkpoint = await repository.findEventByKey({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: checkpointKey,
      });
      if (checkpoint) {
        if (checkpoint.type !== 'commit.stage.completed')
          throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID');
        return parseStageCheckpoint(checkpoint.data, input.stage, claimOwnerSha256);
      }
      const rowEvents = await repository.listEventsByKeyPrefix({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKeyPrefix: stageRowEventPrefix(claimOwnerSha256),
      });
      const ledgers = rowEvents.map((event) => {
        if (event.type !== 'commit.stage.row.completed')
          throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
        return parseStageRowLedger(event.data, input.stage, claimOwnerSha256);
      });
      const activeClaims = await repository.listClaimedRowsByOwner({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        ownerToken: input.claimOwner,
      });
      if (activeClaims.length > 0) {
        const now = new Date();
        if (
          activeClaims.some(
            (row) =>
              !row.claim_expires_at || new Date(row.claim_expires_at).getTime() > now.getTime(),
          )
        )
          throw new Error('MIGRATION_STAGE_CLAIM_IN_PROGRESS');
        const released = await repository.releaseExpiredClaimsByOwner({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          claimedStatus,
          returnToStatus: 'validated',
          ownerToken: input.claimOwner,
          now,
        });
        if (released !== activeClaims.length) throw new Error('MIGRATION_STAGE_RETRY_REQUIRED');
      }
      let rows: ImportRow[];
      let result: MigrationStageResult;
      let batchRowIds: string[];
      if (ledgers.length > 0) {
        result = resultFromStageRowLedgers(ledgers);
        batchRowIds = ledgers[0]!.batchRowIds;
        const durableRows = await repository.listRowsByIds({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          rowIds: batchRowIds,
        });
        if (durableRows.length !== batchRowIds.length)
          throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
        const ledgerByRow = new Map(ledgers.map((ledger) => [ledger.rowId, ledger]));
        const claimValidationTime = Date.now();
        for (const row of durableRows) {
          const ledger = ledgerByRow.get(row.id);
          const entity = parseEntity(row.normalized_data);
          if (!STAGE_ENTITIES[input.stage].includes(entity.entityType))
            throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
          if (ledger) {
            if (ledger.outcome !== row.status)
              throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
            continue;
          }
          if (row.status === 'validated') continue;
          if (
            row.status === claimedStatus &&
            row.claim_expires_at &&
            new Date(row.claim_expires_at).getTime() <= claimValidationTime
          )
            continue;
          if (row.status === claimedStatus) throw new Error('MIGRATION_STAGE_CLAIM_IN_PROGRESS');
          throw new Error('MIGRATION_STAGE_ROW_LEDGER_INVALID');
        }
        if (result.failed > 0) throw new Error('MIGRATION_STAGE_ROW_FAILED');
        if (result.processed === batchRowIds.length) {
          await repository.appendIdempotentEvent({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            eventKey: checkpointKey,
            type: 'commit.stage.completed',
            severity: 'info',
            message: `Migration stage ${input.stage} durably completed a chunk.`,
            data: { version: 1, stage: input.stage, claimOwnerSha256, result },
          });
          return result;
        }
        const pendingRowIds = batchRowIds.filter((rowId) => !ledgerByRow.has(rowId));
        rows = await repository.claimRowsByIds({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          rowIds: pendingRowIds,
          fromStatus: 'validated',
          claimStatus: claimedStatus,
          ownerToken: input.claimOwner,
          leaseExpiresAt: new Date(Date.now() + claimLeaseMs),
        });
      } else {
        rows = await repository.claimRows({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          entityTypes: [...entityTypes],
          fromStatus: 'validated',
          claimStatus: claimedStatus,
          ownerToken: input.claimOwner,
          leaseExpiresAt: new Date(Date.now() + claimLeaseMs),
          limit: input.chunkSize,
        });
        batchRowIds = rows.map((row) => row.id);
        result = {
          processed: 0,
          created: 0,
          updated: 0,
          skipped: 0,
          conflicts: 0,
          failed: 0,
          complete: rows.length < input.chunkSize,
          ...(rows.length === input.chunkSize ? { nextCursor: rows.at(-1)!.id } : {}),
        };
      }
      if (rows.length === 0 && ledgers.length === 0) {
        const checkpointAfterClaim = await repository.findEventByKey({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          eventKey: checkpointKey,
        });
        if (checkpointAfterClaim) {
          if (checkpointAfterClaim.type !== 'commit.stage.completed')
            throw new Error('MIGRATION_STAGE_CHECKPOINT_INVALID');
          return parseStageCheckpoint(checkpointAfterClaim.data, input.stage, claimOwnerSha256);
        }
        const claimsAfterClaim = await repository.listClaimedRowsByOwner({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          claimedStatus,
          ownerToken: input.claimOwner,
        });
        if (claimsAfterClaim.length > 0) throw new Error('MIGRATION_STAGE_CLAIM_IN_PROGRESS');
        const rowEventsAfterClaim = await repository.listEventsByKeyPrefix({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          eventKeyPrefix: stageRowEventPrefix(claimOwnerSha256),
        });
        if (rowEventsAfterClaim.length > 0) throw new Error('MIGRATION_STAGE_RETRY_REQUIRED');
      }
      const completionEvent = (rowId: string, outcome: StageRowLedger['outcome']) => ({
        eventKey: stageRowEventKey(claimOwnerSha256, rowId),
        type: 'commit.stage.row.completed',
        severity: 'info' as const,
        message: `Migration stage ${input.stage} durably completed a row.`,
        data: {
          version: 1,
          stage: input.stage,
          claimOwnerSha256,
          rowId,
          batchRowIds,
          outcome,
          complete: result.complete,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        } satisfies StageRowLedger,
      });
      if (rows.length > 0)
        await hooks.afterRowsClaimed?.({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          stage: input.stage,
          rowIds: rows.map((row) => row.id),
        });

      /* eslint-disable no-await-in-loop -- row commits and claim outcomes are intentionally ordered for idempotent recovery. */
      for (const row of rows) {
        const entity = parseEntity(row.normalized_data);
        if (!entityTypes.includes(entity.entityType)) {
          throw new Error(`MIGRATION_STAGE_ENTITY_MISMATCH:${entity.entityType}`);
        }
        const committer = committers.get(entity.entityType);
        if (!committer) throw new Error(`MIGRATION_COMMITTER_MISSING:${entity.entityType}`);
        try {
          const outcome = await committer.commit({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            entity,
            sideEffects: context.sideEffects,
          });
          if (
            (outcome.disposition === 'created' || outcome.disposition === 'updated') &&
            !outcome.tixkitId
          ) {
            throw new Error(`MIGRATION_COMMIT_RESULT_ID_REQUIRED:${row.id}`);
          }
          let completed: boolean;
          if (outcome.disposition !== 'conflict' && outcome.tixkitId && row.external_id) {
            await repository.completeRowWithExternalReference({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              rowId: row.id,
              claimedStatus,
              ownerToken: input.claimOwner,
              outcome: outcome.disposition,
              sourceSystem: job.source_system,
              entityType: entity.entityType,
              externalId: row.external_id,
              tixkitId: outcome.tixkitId,
              createdEntity: outcome.disposition === 'created',
              provenance: entity,
              completionEvent: completionEvent(row.id, outcome.disposition),
            });
            completed = true;
          } else {
            completed = await repository.completeRow({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              rowId: row.id,
              claimedStatus,
              ownerToken: input.claimOwner,
              outcome: outcome.disposition,
              tixkitId: outcome.tixkitId,
              createdEntity: outcome.disposition === 'created',
              completionEvent: completionEvent(row.id, outcome.disposition),
            });
          }
          if (!completed) throw new Error(`MIGRATION_ROW_CLAIM_LOST:${row.id}`);
          await hooks.afterRowCompletion?.({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            stage: input.stage,
            rowId: row.id,
          });
          if (outcome.disposition === 'conflict') result.conflicts += 1;
          else result[outcome.disposition] += 1;
        } catch (error) {
          await repository.completeRow({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            rowId: row.id,
            claimedStatus,
            ownerToken: input.claimOwner,
            outcome: 'failed',
            severity: 'error',
            rollbackBlockedReason:
              error instanceof Error ? error.message.slice(0, 500) : 'Commit failed',
            completionEvent: completionEvent(row.id, 'failed'),
          });
          result.failed += 1;
          throw error;
        } finally {
          result.processed += 1;
        }
      }
      /* eslint-enable no-await-in-loop */
      if (result.processed > 0) {
        await repository.appendIdempotentEvent({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          eventKey: checkpointKey,
          type: 'commit.stage.completed',
          severity: 'info',
          message: `Migration stage ${input.stage} durably completed a chunk.`,
          data: {
            version: 1,
            stage: input.stage,
            claimOwnerSha256,
            result,
          },
        });
      }
      return result;
    },

    async recordProgress(context, progress) {
      const persistedProgress = {
        ...progressSummary(progress),
        status: 'committing' as const,
      };
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['committing'],
        to: 'committing',
        summary: persistedProgress,
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:progress:${progress.stage ?? 'none'}:${progress.processed}`,
        type: 'commit.progress',
        severity: progress.failed > 0 || progress.conflicts > 0 ? 'warning' : 'info',
        message: `Migration processed ${progress.processed} rows.`,
        data: persistedProgress,
      });
    },

    async markPaused(context, paused, lifecycleSequence, lifecycleCommand) {
      if (lifecycleCommand) {
        await persistLifecycleOutcome({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          commandId: lifecycleCommand.commandId,
          lifecycleSequence: lifecycleCommand.lifecycleSequence,
          outcome: paused ? 'paused' : 'resumed',
        });
        return;
      }
      const changed = await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: paused ? ['committing'] : ['paused'],
        to: paused ? 'paused' : 'committing',
      });
      if (!changed) throw new Error('MIGRATION_PAUSE_TRANSITION_REJECTED');
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:${paused ? 'pause' : 'resume'}:${lifecycleSequence}`,
        type: paused ? 'commit.paused' : 'commit.resumed',
        severity: 'info',
        message: paused ? 'Migration commit paused.' : 'Migration commit resumed.',
      });
    },

    async cancelCommit(context, lifecycleCommand) {
      await repository.requestCancellation(context.tenantId, context.organizationId, context.jobId);
      await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      if (lifecycleCommand) {
        await persistLifecycleOutcome({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          commandId: lifecycleCommand.commandId,
          lifecycleSequence: lifecycleCommand.lifecycleSequence,
          outcome: 'cancelled',
        });
        return;
      }
      const changed = await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['cancelling'],
        to: 'cancelled',
      });
      if (!changed) throw new Error('MIGRATION_CANCEL_TRANSITION_REJECTED');
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'commit:cancelled',
        type: 'commit.cancelled',
        severity: 'warning',
        message: 'Migration commit cancelled.',
      });
    },

    async reconcile(context) {
      const rows: Awaited<ReturnType<ImportRepository['listRowsForReconciliation']>> = [];
      for (let offset = 0; ; offset += 5_000) {
        const page = await repository.listRowsForReconciliation(
          context.tenantId,
          context.organizationId,
          context.jobId,
          5_000,
          offset,
        );
        rows.push(...page);
        if (page.length < 5_000) break;
      }
      const repaired = await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      const job = await repository.findJob(context.tenantId, context.organizationId, context.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      let portableReport: Awaited<ReturnType<typeof portableReconciliationReport>> | undefined;
      if (job.source_system === 'tixkit-portable') {
        const allRows: ImportRow[] = [];
        for (let offset = 0; ; offset += 5_000) {
          const page = await repository.listRows({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            limit: 5_000,
            offset,
          });
          allRows.push(...page);
          if (page.length < 5_000) break;
        }
        portableReport = await portableReconciliationReport({
          db,
          repository,
          context,
          rows: allRows,
          unresolvedRows: rows,
          committers,
        });
      }
      const portableUnresolved = portableReport
        ? portableReport.countMismatches.length +
          portableReport.assetMismatches.length +
          portableReport.financialMismatches.length +
          portableReport.unresolvedDependencies.length +
          portableReport.requiredRebindingsRemaining.length
        : 0;
      const unresolved = Math.max(rows.length, portableUnresolved);
      const reportSha256 = portableReport
        ? createHash('sha256').update(canonicalPortableJson(portableReport)).digest('hex')
        : undefined;
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:reconcile:${repaired}:${unresolved}${reportSha256 ? `:${reportSha256}` : ''}`,
        type: 'commit.reconciled',
        severity: unresolved > 0 ? 'error' : 'info',
        message:
          unresolved > 0
            ? `Migration reconciliation found ${unresolved} unresolved items.`
            : 'Migration reconciliation completed with no unresolved items.',
        data: portableReport
          ? {
              evidenceVersion: 'tixkit-portable-reconciliation-v1',
              repaired,
              unresolved,
              ready: portableReport.ready,
              reportSha256,
              mismatchCounts: {
                counts: portableReport.countMismatches.length,
                assets: portableReport.assetMismatches.length,
                financial: portableReport.financialMismatches.length,
                dependencies: portableReport.unresolvedDependencies.length,
                rebindings: portableReport.requiredRebindingsRemaining.length,
              },
              samples: {
                counts: portableReport.countMismatches.slice(0, 25),
                assets: portableReport.assetMismatches.slice(0, 25),
                financial: portableReport.financialMismatches.slice(0, 25),
                dependencies: portableReport.unresolvedDependencies.slice(0, 25),
                rebindings: portableReport.requiredRebindingsRemaining.slice(0, 25),
              },
            }
          : { repaired, unresolved },
      });
      return {
        repaired,
        unresolved,
      };
    },

    async assessRollback(context, lifecycleCommand): Promise<MigrationRollbackAssessment> {
      const persistRefusal = async (
        assessment: Extract<MigrationRollbackAssessment, { eligible: false }>,
      ): Promise<MigrationRollbackAssessment> => {
        if (lifecycleCommand) {
          await persistLifecycleOutcome({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            commandId: lifecycleCommand.commandId,
            lifecycleSequence: lifecycleCommand.lifecycleSequence,
            outcome: 'rollback_refused',
          });
        }
        return assessment;
      };
      const eligibility = await repository.getRollbackEligibility(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (eligibility.eligible) {
        const rows = await listAllCreatedRows(repository, context);
        const reasons: string[] = [];
        for (const row of rows) {
          if (!row.tixkit_id) {
            reasons.push(`Missing canonical ID for ${row.id}`);
            continue;
          }
          const committer = committers.get(row.entity_type as MigrationEntityType);
          if (!committer) {
            reasons.push(`Missing committer for ${row.entity_type}`);
            continue;
          }
          const probe = await committer.assessUntouched({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            tixkitId: row.tixkit_id,
          });
          if (!probe.eligible)
            reasons.push(
              probe.reason ?? `Authoritative activity on ${row.entity_type}:${row.tixkit_id}`,
            );
        }
        if (reasons.length > 0)
          return persistRefusal({
            eligible: false,
            mode: 'corrective_plan',
            reasons,
            correctivePlanId: `corrective-plan:${context.jobId}`,
          });
        return {
          eligible: true,
          mode: 'pre_activation',
          entityCount: rows.length,
        };
      }
      const job = await repository.findJob(context.tenantId, context.organizationId, context.jobId);
      if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
      const mappings = await repository.listMappings(
        context.tenantId,
        context.organizationId,
        job.source_system,
      );
      return persistRefusal({
        eligible: false,
        mode: 'corrective_plan',
        reasons: eligibility.blockers.map((blocker) => blocker.reason),
        correctivePlanId: (
          await repository.appendIdempotentEvent({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            eventKey: 'rollback:corrective-plan',
            type: 'rollback.corrective-plan',
            severity: 'warning',
            message: 'Destructive rollback was refused; follow the persisted corrective plan.',
            data: {
              immutable: true,
              blockers: eligibility.blockers,
              impactedEntities: eligibility.blockers.map((blocker) => ({
                entityType: blocker.entityType,
                tixkitId: blocker.tixkitId,
              })),
              impactedMappings: mappings.map((mapping) => ({
                id: mapping.id,
                entityType: mapping.entity_type,
                name: mapping.name,
                version: mapping.version,
              })),
              safeActions: [
                'Keep imported entities inactive while reconciling source mappings.',
                'Apply tenant-scoped corrective edits or additive mappings.',
                'Record compensating historical snapshots instead of provider events.',
                'Re-run rollback assessment only after every blocker is independently resolved.',
              ],
            },
          })
        ).id,
      });
    },

    async executeRollback(context, assessment, lifecycleCommand) {
      const eligibility = await repository.getRollbackEligibility(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (!eligibility.eligible || eligibility.mode !== 'delete-created') {
        throw new Error('MIGRATION_ROLLBACK_NO_LONGER_ELIGIBLE');
      }
      const rows = await listAllCreatedRows(repository, context);
      rows.sort(
        (left, right) =>
          MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf(right.entity_type as MigrationEntityType) -
          MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf(left.entity_type as MigrationEntityType),
      );
      if (rows.length > assessment.entityCount) throw new Error('MIGRATION_ROLLBACK_SET_CHANGED');
      let deleted = 0;
      /* eslint-disable no-await-in-loop -- rollback rechecks and deletes one entity at a time to fail closed on new activity. */
      for (const row of rows) {
        if (!row.tixkit_id) throw new Error(`MIGRATION_ROLLBACK_ID_MISSING:${row.id}`);
        const committer = committers.get(row.entity_type as MigrationEntityType);
        if (!committer) throw new Error(`MIGRATION_COMMITTER_MISSING:${row.entity_type}`);
        if (
          !(await committer.deleteUntouched({
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            tixkitId: row.tixkit_id,
          }))
        )
          throw new Error(`MIGRATION_ROLLBACK_DELETE_REFUSED:${row.id}`);
        deleted += 1;
      }
      /* eslint-enable no-await-in-loop */
      await repository.deleteRollbackMetadata(
        context.tenantId,
        context.organizationId,
        context.jobId,
      );
      if (lifecycleCommand) {
        await persistLifecycleOutcome({
          tenantId: context.tenantId,
          organizationId: context.organizationId,
          jobId: context.jobId,
          commandId: lifecycleCommand.commandId,
          lifecycleSequence: lifecycleCommand.lifecycleSequence,
          outcome: 'rolled_back',
        });
        return { deleted };
      }
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['rolling-back', 'committed', 'failed'],
        to: 'rolled-back',
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: 'rollback:completed',
        type: 'rollback.completed',
        severity: 'info',
        message: `Migration rollback deleted ${deleted} untouched entities.`,
        data: { deleted },
      });
      return { deleted };
    },

    async completeCommit(context) {
      await db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (transaction) => {
          const transactionRepository = new ImportRepository(transaction as Database);
          const job = await transactionRepository.findJobForUpdate(
            context.tenantId,
            context.organizationId,
            context.jobId,
          );
          if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');

          const completionEvent = {
            tenantId: context.tenantId,
            organizationId: context.organizationId,
            jobId: context.jobId,
            eventKey: 'commit:completed',
            type: 'commit.completed',
            severity: 'info' as const,
            message: 'Migration commit completed.',
          };
          if (job.status === 'committing') {
            const persistedProgress = parseCommitProgressSummary(job.summary, 'committing');
            const terminalProgress: MigrationTerminalProgressSummary = {
              status: 'completed',
              stageIndex: MIGRATION_COMMIT_STAGES.length,
              stageCount: MIGRATION_COMMIT_STAGES.length,
              processed: persistedProgress.processed,
              created: persistedProgress.created,
              updated: persistedProgress.updated,
              skipped: persistedProgress.skipped,
              conflicts: persistedProgress.conflicts,
              failed: persistedProgress.failed,
            };
            const changed = await transactionRepository.transitionJob({
              tenantId: context.tenantId,
              organizationId: context.organizationId,
              jobId: context.jobId,
              from: ['committing'],
              to: 'committed',
              summary: terminalProgress,
            });
            if (!changed) throw new Error('MIGRATION_COMPLETE_TRANSITION_REJECTED');
            await transactionRepository.appendIdempotentEventInCurrentTransaction(completionEvent);
            return;
          }

          if (job.status === 'committed' || job.status === 'activated') {
            parseCommitProgressSummary(job.summary, 'completed');
            const existingEvent = await transactionRepository.findEventByKey(completionEvent);
            if (!existingEvent && job.status === 'activated')
              throw new Error('MIGRATION_COMPLETE_REPLAY_EVIDENCE_MISSING');
            await transactionRepository.appendIdempotentEventInCurrentTransaction(completionEvent);
            return;
          }
          throw new Error('MIGRATION_COMPLETE_TRANSITION_REJECTED');
        });
    },

    async failCommit(context, failure: MigrationFailure) {
      await repository.releaseClaims({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        claimedStatus,
        returnToStatus: 'validated',
      });
      await repository.transitionJob({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        from: ['committing', 'paused', 'rolling-back'],
        to: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      await repository.appendIdempotentEvent({
        tenantId: context.tenantId,
        organizationId: context.organizationId,
        jobId: context.jobId,
        eventKey: `commit:failed:${failure.stage ?? 'none'}:${failure.code}`,
        type: 'commit.failed',
        severity: 'fatal',
        message: failure.message,
        data: { stage: failure.stage, code: failure.code },
      });
    },
  };
}
