import { sql, type Selectable } from 'kysely';
import { createHash } from 'node:crypto';
import type {
  ExternalReferenceTable,
  ImportJobEventTable,
  ImportJobFileTable,
  ImportJobRowTable,
  ImportJobTable,
  MigrationLifecycleAction,
  MigrationLifecycleCommandTable,
  MigrationLifecycleDispatchKind,
  MigrationCredentialTable,
  PortableDestinationResourceTable,
  UploadArtifactTable,
} from '../types/db.js';
import { BaseRepository } from './base.js';
import { getDriver, type Database } from '../client.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MIGRATION_JOB_STATUSES = new Set<ImportJobStatus>([
  'pending',
  'preparing',
  'prepared',
  'discovering',
  'extracting',
  'normalizing',
  'validating',
  'ready',
  'committing',
  'committed',
  'activated',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
  'rolling-back',
  'rolled-back',
]);

export type MigrationLifecycleOutcome =
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'rollback_refused'
  | 'rolled_back';

function assertTransactionOwned(database: Database): void {
  if ((database as Database & { isTransaction?: boolean }).isTransaction !== true) {
    throw new Error('MIGRATION_LIFECYCLE_TRANSACTION_REQUIRED');
  }
}

function assertLifecycleIdentity(value: string, code: string): void {
  if (!value || value.length > 128) throw new Error(code);
}

function assertLifecycleCommandInput(input: {
  action: MigrationLifecycleAction;
  dispatchKind: MigrationLifecycleDispatchKind;
  idempotencyKeySha256: string;
  requestFingerprint: string;
  expectedJobStatus: ImportJobStatus;
  expectedLifecycleVersion: number;
  actorId: string;
  auditCorrelationId: string;
}): void {
  if (!SHA256_HEX.test(input.idempotencyKeySha256)) {
    throw new Error('MIGRATION_LIFECYCLE_IDEMPOTENCY_DIGEST_INVALID');
  }
  if (!SHA256_HEX.test(input.requestFingerprint)) {
    throw new Error('MIGRATION_LIFECYCLE_REQUEST_FINGERPRINT_INVALID');
  }
  if (!MIGRATION_JOB_STATUSES.has(input.expectedJobStatus)) {
    throw new Error('MIGRATION_LIFECYCLE_EXPECTED_STATUS_INVALID');
  }
  if (!Number.isSafeInteger(input.expectedLifecycleVersion) || input.expectedLifecycleVersion < 0) {
    throw new Error('MIGRATION_LIFECYCLE_VERSION_INVALID');
  }
  assertLifecycleIdentity(input.actorId, 'MIGRATION_LIFECYCLE_ACTOR_INVALID');
  assertLifecycleIdentity(input.auditCorrelationId, 'MIGRATION_LIFECYCLE_CORRELATION_INVALID');
  if (input.action === 'rollback' && input.dispatchKind !== 'rollback-start') {
    throw new Error('MIGRATION_LIFECYCLE_DISPATCH_INVALID');
  }
  if (input.action !== 'rollback' && input.dispatchKind === 'rollback-start') {
    throw new Error('MIGRATION_LIFECYCLE_DISPATCH_INVALID');
  }
  if (input.dispatchKind === 'none' && input.action !== 'cancel') {
    throw new Error('MIGRATION_LIFECYCLE_DISPATCH_INVALID');
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; number?: number };
  return (
    candidate.code === '23505' ||
    candidate.code === 'ER_DUP_ENTRY' ||
    candidate.number === 2601 ||
    candidate.number === 2627
  );
}

export type ImportJobStatus =
  | 'pending'
  | 'preparing'
  | 'prepared'
  | 'discovering'
  | 'extracting'
  | 'normalizing'
  | 'validating'
  | 'ready'
  | 'committing'
  | 'committed'
  | 'activated'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'rolling-back'
  | 'rolled-back';

export const MIGRATION_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const MIGRATION_IMPORT_INITIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MIGRATION_IMPORT_PREPARATION_LEASE_MS = 24 * 60 * 60 * 1000;
export const MIGRATION_IMPORT_MAX_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface RollbackEligibility {
  eligible: boolean;
  mode: 'cancel' | 'delete-created' | 'corrective-plan';
  blockers: Array<{
    entityType: string;
    tixkitId: string | null;
    reason: string;
  }>;
}

type ImportRowCompletionEvent = {
  eventKey: string;
  type: string;
  severity: 'fatal' | 'error' | 'warning' | 'info';
  message: string;
  data?: unknown;
};

export class ImportRepository extends BaseRepository {
  private findMigrationArtifactForUpdate(input: {
    tenantId: string;
    organizationId: string;
    artifactId: string;
  }) {
    if (process.env.DB_DRIVER === 'mssql') {
      return sql<Selectable<UploadArtifactTable>>`
        select * from upload_artifacts with (updlock, holdlock)
        where id = ${input.artifactId}
          and tenant_id = ${input.tenantId}
          and organization_id = ${input.organizationId}
          and purpose = 'migration_import'
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    return this.db
      .selectFrom('upload_artifacts')
      .selectAll()
      .where('id', '=', input.artifactId)
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('purpose', '=', 'migration_import')
      .forUpdate()
      .executeTakeFirst();
  }

  async acquireMigrationArtifactsForStateInTransaction(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    artifactIds: readonly string[];
    targetState: 'preparing' | 'committing';
    transition: boolean;
    now?: Date;
  }): Promise<void> {
    if (
      input.artifactIds.length === 0 ||
      new Set(input.artifactIds).size !== input.artifactIds.length
    ) {
      throw new Error('MIGRATION_ARTIFACT_SELECTION_INVALID');
    }
    if ((this.db as Database & { isTransaction?: boolean }).isTransaction !== true) {
      throw new Error('MIGRATION_ARTIFACT_LEASE_TRANSACTION_REQUIRED');
    }
    const now = input.now ?? new Date();
    const allowedStatuses: ImportJobStatus[] =
      input.targetState === 'preparing'
        ? ['pending', 'failed', 'paused', 'preparing']
        : ['ready', 'committing'];
    const job = await this.findJobForUpdate(input.tenantId, input.organizationId, input.jobId);
    if (!job || !allowedStatuses.includes(job.status as ImportJobStatus)) {
      throw new Error(
        input.targetState === 'preparing'
          ? 'MIGRATION_JOB_NOT_PREPARABLE'
          : 'MIGRATION_JOB_NOT_COMMITTABLE',
      );
    }
    for (const artifactId of [...input.artifactIds].sort()) {
      const artifact = await this.findMigrationArtifactForUpdate({ ...input, artifactId });
      if (
        !artifact ||
        artifact.status !== 'uploaded' ||
        artifact.scan_status !== 'clean' ||
        !artifact.consumed_at ||
        !artifact.checksum_sha256 ||
        artifact.size_bytes > MIGRATION_IMPORT_MAX_BYTES
      ) {
        throw new Error('MIGRATION_ARTIFACT_NOT_AVAILABLE');
      }
      const registeredFiles = await this.db
        .selectFrom('import_job_files')
        .select(['import_job_id', 'object_key', 'media_type', 'byte_size', 'sha256', 'status'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('object_key', '=', artifact.object_key)
        .execute();
      if (
        registeredFiles.length !== 1 ||
        registeredFiles[0]!.import_job_id !== input.jobId ||
        registeredFiles[0]!.sha256 !== artifact.checksum_sha256 ||
        Number(registeredFiles[0]!.byte_size) !== artifact.size_bytes ||
        registeredFiles[0]!.media_type !== artifact.content_type ||
        registeredFiles[0]!.status !== 'ready'
      ) {
        throw new Error('MIGRATION_ARTIFACT_NOT_REGISTERED_WITH_JOB');
      }
      const maximumRetentionAt =
        new Date(artifact.consumed_at).getTime() + MIGRATION_IMPORT_MAX_RETENTION_MS;
      if (now.getTime() >= maximumRetentionAt) {
        throw new Error('MIGRATION_ARTIFACT_RETENTION_EXPIRED');
      }
      const leaseExpiresAt = new Date(
        Math.min(
          maximumRetentionAt,
          Math.max(
            new Date(artifact.expires_at).getTime(),
            now.getTime() + MIGRATION_IMPORT_PREPARATION_LEASE_MS,
          ),
        ),
      );
      const renewed = await this.db
        .updateTable('upload_artifacts')
        .set({ expires_at: leaseExpiresAt, updated_at: now })
        .where('id', '=', artifact.id)
        .where('status', '=', 'uploaded')
        .executeTakeFirst();
      if (Number(renewed.numUpdatedRows) !== 1) {
        throw new Error('MIGRATION_ARTIFACT_NOT_AVAILABLE');
      }
    }
    if (input.transition && job.status !== input.targetState) {
      const transitioned = await this.transitionJob({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        from: [job.status as ImportJobStatus],
        to: input.targetState,
      });
      if (!transitioned) throw new Error('MIGRATION_JOB_STATE_CHANGED');
    }
  }

  async acquireMigrationArtifactsForState(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    artifactIds: readonly string[];
    targetState: 'preparing' | 'committing';
    transition: boolean;
    now?: Date;
  }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await new ImportRepository(
        transaction as Database,
      ).acquireMigrationArtifactsForStateInTransaction(input);
    });
  }

  async registerPortableDestinationResource(input: {
    tenantId: string;
    organizationId: string;
    kind: string;
    resourceId: string;
    registeredBy: string;
    now?: Date;
  }) {
    const existing = await this.findPortableDestinationResource(input);
    if (existing) return existing;
    const values = {
      id: this.generateId('pdr'),
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      kind: input.kind,
      resource_id: input.resourceId,
      registered_by: input.registeredBy,
      created_at: input.now ?? new Date(),
      revoked_at: null,
    };
    try {
      await this.db.insertInto('portable_destination_resources').values(values).execute();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    return this.db
      .selectFrom('portable_destination_resources')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('kind', '=', input.kind)
      .where('resource_id', '=', input.resourceId)
      .where('revoked_at', 'is', null)
      .executeTakeFirstOrThrow();
  }

  findPortableDestinationResource(input: {
    tenantId: string;
    organizationId: string;
    kind: string;
    resourceId: string;
    lockForAuthorization?: boolean;
  }) {
    if (input.lockForAuthorization && process.env.DB_DRIVER === 'mssql') {
      return sql<Selectable<PortableDestinationResourceTable>>`
        select * from portable_destination_resources with (updlock, holdlock)
        where tenant_id = ${input.tenantId}
          and organization_id = ${input.organizationId}
          and kind = ${input.kind}
          and resource_id = ${input.resourceId}
          and revoked_at is null
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    let query = this.db
      .selectFrom('portable_destination_resources')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('kind', '=', input.kind)
      .where('resource_id', '=', input.resourceId)
      .where('revoked_at', 'is', null);
    if (input.lockForAuthorization) query = query.forShare();
    return query.executeTakeFirst();
  }

  async revokePortableDestinationResource(input: {
    tenantId: string;
    organizationId: string;
    kind: string;
    resourceId: string;
    now?: Date;
  }): Promise<boolean> {
    return this.db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (transaction) => {
        const repository = new ImportRepository(transaction as Database);
        const resource = await repository.findPortableDestinationResourceForUpdate(input);
        if (!resource) return false;
        const executing = await transaction
          .selectFrom('portable_import_rebindings as rebinding')
          .innerJoin('import_jobs as job', (join) =>
            join
              .onRef('job.tenant_id', '=', 'rebinding.tenant_id')
              .onRef('job.organization_id', '=', 'rebinding.organization_id')
              .onRef('job.id', '=', 'rebinding.import_job_id'),
          )
          .select('job.id')
          .where('rebinding.tenant_id', '=', input.tenantId)
          .where('rebinding.organization_id', '=', input.organizationId)
          .where('rebinding.kind', '=', input.kind)
          .where('rebinding.destination_reference', '=', input.resourceId)
          .where('job.status', 'in', ['committing', 'committed', 'activated'])
          .executeTakeFirst();
        if (executing) throw new Error('PORTABLE_DESTINATION_RESOURCE_EXECUTION_STARTED');
        const result = await transaction
          .updateTable('portable_destination_resources')
          .set({ revoked_at: input.now ?? new Date() })
          .where('id', '=', resource.id)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      });
  }

  private findPortableDestinationResourceForUpdate(input: {
    tenantId: string;
    organizationId: string;
    kind: string;
    resourceId: string;
  }) {
    if (process.env.DB_DRIVER === 'mssql') {
      return sql<Selectable<PortableDestinationResourceTable>>`
        select * from portable_destination_resources with (updlock, holdlock)
        where tenant_id = ${input.tenantId}
          and organization_id = ${input.organizationId}
          and kind = ${input.kind}
          and resource_id = ${input.resourceId}
          and revoked_at is null
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    return this.db
      .selectFrom('portable_destination_resources')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('kind', '=', input.kind)
      .where('resource_id', '=', input.resourceId)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
  }

  findJobForUpdate(tenantId: string, organizationId: string, jobId: string) {
    if (process.env.DB_DRIVER === 'mssql') {
      return sql<Selectable<ImportJobTable>>`
        select * from import_jobs with (updlock, holdlock)
        where tenant_id = ${tenantId}
          and organization_id = ${organizationId}
          and id = ${jobId}
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    return this.db
      .selectFrom('import_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', jobId)
      .forUpdate()
      .executeTakeFirst();
  }

  findPortableImportCommitAuthorization(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('portable_import_commit_authorizations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .executeTakeFirst();
  }

  findPortableImportCutoverProof(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('portable_import_cutover_proofs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .executeTakeFirst();
  }

  async recordPortableImportCutoverProof(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    keyId: string;
    nonce: string;
    receiptSha256: string;
    proofJson: string;
    validatedBy: string;
    validatedAt: Date;
  }) {
    try {
      await this.db
        .insertInto('portable_import_cutover_proofs')
        .values({
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          import_job_id: input.jobId,
          key_id: input.keyId,
          nonce: input.nonce,
          receipt_sha256: input.receiptSha256,
          proof_json: input.proofJson,
          validated_by: input.validatedBy,
          validated_at: input.validatedAt,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error))
        throw new Error('PORTABLE_IMPORT_CUTOVER_PROOF_ALREADY_CONSUMED', { cause: error });
      throw error;
    }
    return this.findPortableImportCutoverProof(
      input.tenantId,
      input.organizationId,
      input.jobId,
    ).then((proof) => {
      if (!proof) throw new Error('PORTABLE_IMPORT_CUTOVER_PROOF_NOT_FOUND');
      return proof;
    });
  }

  async authorizePortableImportCommit(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    approvalId: string;
    approvalDigest: string;
    inputSha256: string;
    rebindingsSha256: string;
    authorizedBy: string;
    authorizedAt: Date;
  }) {
    const values = {
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      import_job_id: input.jobId,
      approval_id: input.approvalId,
      approval_digest: input.approvalDigest,
      input_sha256: input.inputSha256,
      rebindings_sha256: input.rebindingsSha256,
      authorized_by: input.authorizedBy,
      authorized_at: input.authorizedAt,
    };
    await this.db.insertInto('portable_import_commit_authorizations').values(values).execute();
    const promoted = await this.db
      .updateTable('import_jobs')
      .set({ mode: 'commit', updated_at: input.authorizedAt })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('source_system', '=', 'tixkit-portable')
      .where('mode', '=', 'dry-run')
      .where('status', '=', 'ready')
      .executeTakeFirst();
    if (Number(promoted.numUpdatedRows) !== 1)
      throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_JOB_CHANGED');
    return this.findPortableImportCommitAuthorization(
      input.tenantId,
      input.organizationId,
      input.jobId,
    ).then((authorization) => {
      if (!authorization) throw new Error('PORTABLE_IMPORT_COMMIT_AUTHORIZATION_NOT_FOUND');
      return authorization;
    });
  }

  listPortableImportRebindings(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('portable_import_rebindings')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .orderBy('portable_id', 'asc')
      .execute();
  }

  async upsertPortableImportRebinding(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    portableId: string;
    kind: string;
    destinationReference: string;
    provenanceSha256: string;
    boundBy: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const update = () =>
      this.db
        .updateTable('portable_import_rebindings')
        .set({
          kind: input.kind,
          destination_reference: input.destinationReference,
          provenance_sha256: input.provenanceSha256,
          bound_by: input.boundBy,
          updated_at: now,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('portable_id', '=', input.portableId)
        .executeTakeFirst();
    const updated = await update();
    if (Number(updated.numUpdatedRows) === 0) {
      try {
        await this.db
          .insertInto('portable_import_rebindings')
          .values({
            id: this.generateId('pir'),
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            import_job_id: input.jobId,
            portable_id: input.portableId,
            kind: input.kind,
            destination_reference: input.destinationReference,
            provenance_sha256: input.provenanceSha256,
            bound_by: input.boundBy,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await update();
      }
    }
    return this.db
      .selectFrom('portable_import_rebindings')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('portable_id', '=', input.portableId)
      .executeTakeFirstOrThrow();
  }

  async recordPortablePreflight(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    operationId: string;
    bundleId: string;
    manifestSha256: string;
    artifactSha256: string;
    sourceDeploymentId: string;
    sourceChangeCursor: string;
    destinationId: string;
    manifestJson: string;
    preflightJson: string;
    expectedCounts: string;
    expectedAssets: string;
    requiredRebindings: string;
  }): Promise<void> {
    if (
      !input.tenantId.trim() ||
      !input.organizationId.trim() ||
      !input.jobId.trim() ||
      !input.operationId.trim() ||
      !input.bundleId.trim() ||
      !/^[a-f0-9]{64}$/u.test(input.manifestSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.artifactSha256) ||
      !input.sourceDeploymentId.trim() ||
      !input.sourceChangeCursor.trim() ||
      !input.destinationId.trim() ||
      !input.manifestJson.trim() ||
      !input.preflightJson.trim() ||
      !input.expectedCounts.trim() ||
      !input.expectedAssets.trim() ||
      !input.requiredRebindings.trim()
    )
      throw new Error('PORTABLE_IMPORT_PREFLIGHT_INVALID');
    const values = {
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      import_job_id: input.jobId,
      operation_id: input.operationId,
      bundle_id: input.bundleId,
      manifest_sha256: input.manifestSha256,
      artifact_sha256: input.artifactSha256,
      source_deployment_id: input.sourceDeploymentId,
      source_change_cursor: input.sourceChangeCursor,
      destination_id: input.destinationId,
      manifest_json: input.manifestJson,
      preflight_json: input.preflightJson,
      expected_counts: input.expectedCounts,
      expected_assets: input.expectedAssets,
      required_rebindings: input.requiredRebindings,
      created_at: new Date(),
    };
    try {
      await this.db.insertInto('portable_import_preflights').values(values).execute();
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPortablePreflight(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (!existing) throw error;
      const comparable = { ...values, created_at: existing.created_at };
      if (
        Object.entries(comparable).some(
          ([key, value]) => String(existing[key as keyof typeof existing]) !== String(value),
        )
      )
        throw new Error('PORTABLE_IMPORT_PREFLIGHT_CONFLICT', { cause: error });
    }
  }

  findPortablePreflight(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('portable_import_preflights')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .executeTakeFirst();
  }

  findPortableImportLineageCheckpoint(input: {
    tenantId: string;
    organizationId: string;
    destinationId: string;
    sourceDeploymentId: string;
    sourceTenantId: string;
    sourceOrganizationId?: string;
    lock?: boolean;
  }) {
    let query = this.db
      .selectFrom('portable_import_lineage_checkpoints')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('destination_id', '=', input.destinationId)
      .where('source_deployment_id', '=', input.sourceDeploymentId)
      .where('source_tenant_id', '=', input.sourceTenantId)
      .where('source_organization_id', '=', input.sourceOrganizationId ?? '');
    if (input.lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  async assertPortableImportLineageEligible(input: {
    tenantId: string;
    organizationId: string;
    destinationId: string;
    sourceDeploymentId: string;
    sourceTenantId: string;
    sourceOrganizationId?: string;
    lineageKind: 'full' | 'delta';
    exportSequence: number;
    parentBundleId?: string;
    parentManifestSha256?: string;
    fromChangeCursor?: string;
  }): Promise<void> {
    const checkpoint = await this.findPortableImportLineageCheckpoint(input);
    if (checkpoint?.cutover_frozen_at) throw new Error('PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED');
    if (input.lineageKind === 'full') {
      if (checkpoint) throw new Error('PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED');
      return;
    }
    if (
      !checkpoint ||
      checkpoint.last_bundle_id !== input.parentBundleId ||
      checkpoint.last_manifest_sha256 !== input.parentManifestSha256 ||
      checkpoint.last_change_cursor !== input.fromChangeCursor ||
      input.exportSequence <= checkpoint.last_export_sequence
    )
      throw new Error('PORTABLE_IMPORT_LINEAGE_PARENT_NOT_ACTIVATED');
  }

  async advancePortableImportLineageCheckpoint(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    destinationId: string;
    sourceDeploymentId: string;
    sourceTenantId: string;
    sourceOrganizationId?: string;
    lineageKind: 'full' | 'delta';
    bundleId: string;
    manifestSha256: string;
    changeCursor: string;
    exportSequence: number;
    parentBundleId?: string;
    parentManifestSha256?: string;
    fromChangeCursor?: string;
    cutoverFrozenAt?: Date;
    activatedAt: Date;
  }): Promise<void> {
    if (
      !Number.isSafeInteger(input.exportSequence) ||
      input.exportSequence < 1 ||
      !/^[a-f0-9]{64}$/u.test(input.manifestSha256)
    )
      throw new Error('PORTABLE_IMPORT_LINEAGE_INVALID');
    const checkpoint = await this.findPortableImportLineageCheckpoint({ ...input, lock: true });
    if (checkpoint?.cutover_frozen_at) throw new Error('PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED');
    if (input.lineageKind === 'delta') {
      if (
        !checkpoint ||
        checkpoint.last_bundle_id !== input.parentBundleId ||
        checkpoint.last_manifest_sha256 !== input.parentManifestSha256 ||
        checkpoint.last_change_cursor !== input.fromChangeCursor ||
        input.exportSequence <= checkpoint.last_export_sequence
      )
        throw new Error('PORTABLE_IMPORT_LINEAGE_STALE');
    } else if (checkpoint) {
      throw new Error('PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED');
    }
    const now = input.activatedAt;
    if (!checkpoint) {
      const scopeSha256 = createHash('sha256')
        .update(
          [
            input.tenantId,
            input.organizationId,
            input.destinationId,
            input.sourceDeploymentId,
            input.sourceTenantId,
            input.sourceOrganizationId ?? '',
          ].join('\0'),
        )
        .digest('hex');
      try {
        await this.db
          .insertInto('portable_import_lineage_checkpoints')
          .values({
            id: `pil_${scopeSha256.slice(0, 32)}`,
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            destination_id: input.destinationId,
            source_deployment_id: input.sourceDeploymentId,
            source_tenant_id: input.sourceTenantId,
            source_organization_id: input.sourceOrganizationId ?? '',
            scope_sha256: scopeSha256,
            last_bundle_id: input.bundleId,
            last_manifest_sha256: input.manifestSha256,
            last_change_cursor: input.changeCursor,
            last_export_sequence: input.exportSequence,
            last_import_job_id: input.jobId,
            cutover_frozen_at: input.cutoverFrozenAt ?? null,
            activated_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error))
          throw new Error('PORTABLE_IMPORT_LINEAGE_STALE', { cause: error });
        throw error;
      }
      return;
    }
    const result = await this.db
      .updateTable('portable_import_lineage_checkpoints')
      .set({
        last_bundle_id: input.bundleId,
        last_manifest_sha256: input.manifestSha256,
        last_change_cursor: input.changeCursor,
        last_export_sequence: input.exportSequence,
        last_import_job_id: input.jobId,
        cutover_frozen_at: input.cutoverFrozenAt ?? null,
        activated_at: now,
        updated_at: now,
      })
      .where('id', '=', checkpoint.id)
      .where('last_manifest_sha256', '=', checkpoint.last_manifest_sha256)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error('PORTABLE_IMPORT_LINEAGE_STALE');
  }

  async recordPortableDryRunReceipt(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    operationId: string;
    manifestSha256: string;
    inputSha256: string;
    receiptSha256: string;
    receiptJson: string;
    createdBy: string;
  }): Promise<void> {
    if (
      !input.tenantId.trim() ||
      !input.organizationId.trim() ||
      !input.jobId.trim() ||
      !input.operationId.trim() ||
      !/^[a-f0-9]{64}$/u.test(input.manifestSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.inputSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.receiptSha256) ||
      !input.receiptJson.trim() ||
      createHash('sha256').update(input.receiptJson).digest('hex') !== input.receiptSha256 ||
      !input.createdBy.trim()
    )
      throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_INVALID');
    const values = {
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      import_job_id: input.jobId,
      operation_id: input.operationId,
      manifest_sha256: input.manifestSha256,
      input_sha256: input.inputSha256,
      receipt_sha256: input.receiptSha256,
      receipt_json: input.receiptJson,
      created_by: input.createdBy,
      created_at: new Date(),
    };
    try {
      await this.db.insertInto('portable_import_dry_run_receipts').values(values).execute();
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPortableDryRunReceipt(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (!existing) throw error;
      const {
        created_at: _existingCreatedAt,
        created_by: _existingCreatedBy,
        ...existingEvidence
      } = existing;
      const { created_at: _createdAt, created_by: _createdBy, ...comparable } = values;
      if (
        Object.entries(comparable).some(
          ([key, value]) =>
            String(existingEvidence[key as keyof typeof existingEvidence]) !== String(value),
        )
      )
        throw new Error('PORTABLE_IMPORT_DRY_RUN_RECEIPT_CONFLICT', { cause: error });
    }
  }

  findPortableDryRunReceipt(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('portable_import_dry_run_receipts')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .executeTakeFirst();
  }

  async createPortableImportApproval(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    operationId: string;
    manifestSha256: string;
    artifactSha256: string;
    inputSha256: string;
    receiptSha256: string;
    rebindingsSha256: string;
    approvalDigest: string;
    approvedBy: string;
    idempotencyKeySha256: string;
    requestFingerprint: string;
    expiresAt: Date;
    now: Date;
  }) {
    if (
      !input.tenantId.trim() ||
      !input.organizationId.trim() ||
      !input.jobId.trim() ||
      !input.operationId.trim() ||
      !/^[a-f0-9]{64}$/u.test(input.manifestSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.artifactSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.inputSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.receiptSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.rebindingsSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.approvalDigest) ||
      !input.approvedBy.trim() ||
      !/^[a-f0-9]{64}$/u.test(input.idempotencyKeySha256) ||
      !/^[a-f0-9]{64}$/u.test(input.requestFingerprint) ||
      !Number.isFinite(input.now.getTime()) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= input.now ||
      input.expiresAt.getTime() - input.now.getTime() > 15 * 60 * 1000
    )
      throw new Error('PORTABLE_IMPORT_APPROVAL_INVALID');
    const values = {
      id: this.generateId('pia'),
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      import_job_id: input.jobId,
      operation_id: input.operationId,
      manifest_sha256: input.manifestSha256,
      artifact_sha256: input.artifactSha256,
      input_sha256: input.inputSha256,
      receipt_sha256: input.receiptSha256,
      rebindings_sha256: input.rebindingsSha256,
      approval_digest: input.approvalDigest,
      approved_by: input.approvedBy,
      idempotency_key_sha256: input.idempotencyKeySha256,
      request_fingerprint: input.requestFingerprint,
      expires_at: input.expiresAt,
      created_at: input.now,
    };
    await this.db.insertInto('portable_import_approvals').values(values).execute();
    return this.db
      .selectFrom('portable_import_approvals')
      .selectAll()
      .where('id', '=', values.id)
      .executeTakeFirstOrThrow();
  }

  findPortableImportApprovalByDigest(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    approvalDigest: string;
  }) {
    return this.db
      .selectFrom('portable_import_approvals')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('approval_digest', '=', input.approvalDigest)
      .executeTakeFirst();
  }

  findLatestPortableImportApproval(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
  }) {
    return this.db
      .selectFrom('portable_import_approvals')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  findPortableImportApproval(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    approvalId: string;
  }) {
    return this.db
      .selectFrom('portable_import_approvals')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('id', '=', input.approvalId)
      .executeTakeFirst();
  }

  findPortableImportApprovalByIdempotency(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    idempotencyKeySha256: string;
  }) {
    return this.db
      .selectFrom('portable_import_approvals')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('idempotency_key_sha256', '=', input.idempotencyKeySha256)
      .executeTakeFirst();
  }

  findActivePortableImportApproval(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    now: Date;
  }) {
    return this.db
      .selectFrom('portable_import_approvals as approval')
      .leftJoin('portable_import_approval_revocations as revocation', (join) =>
        join
          .onRef('revocation.tenant_id', '=', 'approval.tenant_id')
          .onRef('revocation.organization_id', '=', 'approval.organization_id')
          .onRef('revocation.approval_id', '=', 'approval.id'),
      )
      .selectAll('approval')
      .where('approval.tenant_id', '=', input.tenantId)
      .where('approval.organization_id', '=', input.organizationId)
      .where('approval.import_job_id', '=', input.jobId)
      .where('approval.expires_at', '>', input.now)
      .where('revocation.id', 'is', null)
      .orderBy('approval.created_at', 'desc')
      .executeTakeFirst();
  }

  findPortableImportApprovalRevocation(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    approvalId: string;
  }) {
    return this.db
      .selectFrom('portable_import_approval_revocations')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('approval_id', '=', input.approvalId)
      .executeTakeFirst();
  }

  async revokePortableImportApproval(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    approvalId: string;
    revokedBy: string;
    reason?: string;
    now: Date;
  }) {
    if (
      !input.revokedBy.trim() ||
      (input.reason !== undefined &&
        (input.reason !== input.reason.trim() || input.reason.length > 500)) ||
      !Number.isFinite(input.now.getTime())
    )
      throw new Error('PORTABLE_IMPORT_APPROVAL_REVOCATION_INVALID');
    const approval = await this.findPortableImportApproval(input);
    if (!approval) throw new Error('PORTABLE_IMPORT_APPROVAL_NOT_FOUND');
    const values = {
      id: this.generateId('pir'),
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      import_job_id: input.jobId,
      approval_id: input.approvalId,
      revoked_by: input.revokedBy,
      reason: input.reason ?? null,
      created_at: input.now,
    };
    try {
      await this.db.insertInto('portable_import_approval_revocations').values(values).execute();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPortableImportApprovalRevocation(input);
      if (
        !existing ||
        existing.revoked_by !== input.revokedBy ||
        existing.reason !== (input.reason ?? null)
      )
        throw new Error('PORTABLE_IMPORT_APPROVAL_REVOCATION_CONFLICT', { cause: error });
    }
    return this.findPortableImportApprovalRevocation(input).then((revocation) => {
      if (!revocation) throw new Error('PORTABLE_IMPORT_APPROVAL_REVOCATION_NOT_FOUND');
      return revocation;
    });
  }

  async preparationProgress(
    tenantId: string,
    organizationId: string,
    jobId: string,
  ): Promise<{ cursor?: string; rowNumber: number; completed: boolean }> {
    const job = await this.db
      .selectFrom('import_jobs')
      .select(['preparation_cursor', 'preparation_row_number', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!job) return { rowNumber: 0, completed: false };
    return {
      cursor: job.preparation_cursor ?? undefined,
      rowNumber: job.preparation_row_number,
      completed: job.status === 'prepared',
    };
  }

  findImportedEntity(tenantId: string, organizationId: string, tixkitId: string) {
    return this.db
      .selectFrom('imported_domain_entities')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', tixkitId)
      .executeTakeFirst();
  }

  async persistPreparationChunk(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    cursorKey: string;
    nextCursor?: string;
    startRowNumber: number;
    completed: boolean;
    rows: Array<{
      entityType: string;
      externalId: string;
      sourceData: unknown;
      normalizedData: unknown;
      severity?: string;
      issues: Array<{ code: string; severity: string; message: string; details?: unknown }>;
    }>;
  }): Promise<{ inserted: number; rowNumber: number }> {
    return this.db.transaction().execute(async (transaction) => {
      let inserted = 0;
      for (const [offset, row] of input.rows.entries()) {
        const rowNumber = input.startRowNumber + offset + 1;
        let stored = await transaction
          .selectFrom('import_job_rows')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('import_job_id', '=', input.jobId)
          .where('entity_type', '=', row.entityType)
          .where('row_number', '=', rowNumber)
          .executeTakeFirst();
        if (!stored) {
          const id = this.generateId('imr');
          await transaction
            .insertInto('import_job_rows')
            .values({
              id,
              tenant_id: input.tenantId,
              organization_id: input.organizationId,
              import_job_id: input.jobId,
              import_job_file_id: null,
              entity_type: row.entityType,
              external_id: row.externalId,
              row_number: rowNumber,
              status: row.issues.some(
                ({ severity }) => severity === 'fatal' || severity === 'error',
              )
                ? 'conflict'
                : 'validated',
              claim_owner: null,
              claim_attempt: 0,
              claim_expires_at: null,
              severity: row.severity ?? null,
              source_data: JSON.stringify(row.sourceData),
              normalized_data: JSON.stringify(row.normalizedData),
              tixkit_id: null,
              created_entity: false,
              domain_activity_at: null,
              rollback_blocked_reason: null,
              created_at: new Date(),
              updated_at: new Date(),
            })
            .execute();
          stored = { id };
          inserted += 1;
        }
        for (const issue of row.issues) {
          const exists = await transaction
            .selectFrom('import_conflicts')
            .select('id')
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('import_job_id', '=', input.jobId)
            .where('import_job_row_id', '=', stored.id)
            .where('code', '=', issue.code)
            .executeTakeFirst();
          if (exists) continue;
          await transaction
            .insertInto('import_conflicts')
            .values({
              id: this.generateId('imc'),
              tenant_id: input.tenantId,
              organization_id: input.organizationId,
              import_job_id: input.jobId,
              import_job_row_id: stored.id,
              code: issue.code,
              severity: issue.severity,
              entity_type: row.entityType,
              external_id: row.externalId,
              message: issue.message,
              details: issue.details === undefined ? null : JSON.stringify(issue.details),
              resolution: null,
              resolved_at: null,
              created_at: new Date(),
            })
            .execute();
        }
      }
      const rowNumber = input.startRowNumber + input.rows.length;
      const eventKey = `preparation:${input.cursorKey}`;
      const existingEvent = await transaction
        .selectFrom('import_job_events')
        .select('id')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('event_key', '=', eventKey)
        .executeTakeFirst();
      if (!existingEvent) {
        const maximum = await transaction
          .selectFrom('import_job_events')
          .select(({ fn }) => fn.max<number>('sequence').as('maximum'))
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('import_job_id', '=', input.jobId)
          .executeTakeFirst();
        await transaction
          .insertInto('import_job_events')
          .values({
            id: this.generateId('ime'),
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            import_job_id: input.jobId,
            sequence: Number(maximum?.maximum ?? 0) + 1,
            event_key: eventKey,
            type: input.completed ? 'preparation.completed' : 'preparation.progress',
            severity: 'info',
            message: input.completed
              ? 'Source preparation completed.'
              : 'Source preparation progressed.',
            data: JSON.stringify({
              cursorHash: input.nextCursor
                ? createHash('sha256').update(input.nextCursor).digest('hex')
                : null,
              rowNumber,
            }),
            created_at: new Date(),
          })
          .execute();
      }
      await transaction
        .updateTable('import_jobs')
        .set({
          preparation_cursor: input.completed ? null : (input.nextCursor ?? null),
          preparation_row_number: rowNumber,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.jobId)
        .where('status', '=', 'preparing')
        .execute();
      if (input.completed) {
        await transaction
          .updateTable('import_jobs')
          .set({ status: 'prepared', completed_at: new Date(), updated_at: new Date() })
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('id', '=', input.jobId)
          .where('status', '=', 'preparing')
          .execute();
      }
      return { inserted, rowNumber };
    });
  }
  async createCredential(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    secretReference: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<Selectable<MigrationCredentialTable>> {
    const id = this.generateId('mcred');
    const now = new Date();
    return this.insertReturning(
      'migration_credentials',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        source_system: input.sourceSystem,
        secret_reference: input.secretReference,
        status: 'active',
        expires_at: input.expiresAt,
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findActiveCredential(input: {
    tenantId: string;
    organizationId: string;
    credentialId: string;
    sourceSystem: string;
    at?: Date;
  }): Promise<Selectable<MigrationCredentialTable> | undefined> {
    const at = input.at ?? new Date();
    const credential = await this.db
      .selectFrom('migration_credentials')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.credentialId)
      .where('source_system', '=', input.sourceSystem)
      .where('status', '=', 'active')
      .where('expires_at', '>', at)
      .executeTakeFirst();
    return credential && credential.expires_at.getTime() > at.getTime() ? credential : undefined;
  }

  async revokeCredential(input: {
    tenantId: string;
    organizationId: string;
    credentialId: string;
  }): Promise<boolean> {
    const result = await this.db
      .updateTable('migration_credentials')
      .set({ status: 'revoked', updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.credentialId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async beginCommit(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
  }): Promise<void> {
    const result = await this.db
      .updateTable('import_jobs')
      .set({ status: 'committing', updated_at: new Date() })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('mode', '=', 'commit')
      .where('status', '=', 'ready')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 1) return;
    const job = await this.findJob(input.tenantId, input.organizationId, input.jobId);
    if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
    if (job.mode !== 'commit') throw new Error('MIGRATION_DRY_RUN_CANNOT_COMMIT');
    if (job.status === 'committing') return;
    throw new Error(`MIGRATION_JOB_NOT_READY:${job.status}`);
  }

  addFile(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    objectKey: string;
    originalName: string;
    mediaType: string;
    byteSize: number | bigint;
    sha256: string;
  }): Promise<Selectable<ImportJobFileTable>> {
    const id = this.generateId('imf');
    return this.insertReturning(
      'import_job_files',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        import_job_id: input.jobId,
        object_key: input.objectKey,
        original_name: input.originalName,
        media_type: input.mediaType,
        byte_size: input.byteSize,
        sha256: input.sha256,
        status: 'ready',
        created_at: new Date(),
      },
      id,
    );
  }

  async addRows(
    tenantId: string,
    organizationId: string,
    jobId: string,
    rows: Array<{
      fileId?: string;
      entityType: string;
      externalId?: string;
      rowNumber: number;
      sourceData: unknown;
      normalizedData?: unknown;
      status?: string;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date();
    await this.db
      .insertInto('import_job_rows')
      .values(
        rows.map((row) => ({
          id: this.generateId('imr'),
          tenant_id: tenantId,
          organization_id: organizationId,
          import_job_id: jobId,
          import_job_file_id: row.fileId ?? null,
          entity_type: row.entityType,
          external_id: row.externalId ?? null,
          row_number: row.rowNumber,
          status: row.status ?? 'extracted',
          severity: null,
          source_data: JSON.stringify(row.sourceData),
          normalized_data:
            row.normalizedData === undefined ? null : JSON.stringify(row.normalizedData),
          tixkit_id: null,
          created_entity: false,
          domain_activity_at: null,
          rollback_blocked_reason: null,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
  }

  async createJob(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    adapterVersion: string;
    mode: 'dry-run' | 'commit';
    idempotencyKey: string;
    requestedBy: string;
    configuration?: unknown;
  }): Promise<Selectable<ImportJobTable>> {
    return (await this.createJobWithDisposition(input)).job;
  }

  async createJobWithDisposition(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    adapterVersion: string;
    mode: 'dry-run' | 'commit';
    idempotencyKey: string;
    requestedBy: string;
    configuration?: unknown;
  }): Promise<{ created: boolean; job: Selectable<ImportJobTable> }> {
    const existing = await this.findJobByIdempotencyKey(
      input.tenantId,
      input.organizationId,
      input.idempotencyKey,
    );
    if (existing) return { created: false, job: existing };

    const id = this.generateId('imp');
    const now = new Date();
    try {
      const job = await this.insertReturning(
        'import_jobs',
        {
          id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          source_system: input.sourceSystem,
          adapter_version: input.adapterVersion,
          mode: input.mode,
          status: 'pending',
          idempotency_key: input.idempotencyKey,
          requested_by: input.requestedBy,
          configuration:
            input.configuration === undefined ? null : JSON.stringify(input.configuration),
          preparation_cursor: null,
          preparation_row_number: 0,
          summary: null,
          error_code: null,
          error_message: null,
          started_at: null,
          completed_at: null,
          activated_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        },
        id,
      );
      return { created: true, job };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findJobByIdempotencyKey(
        input.tenantId,
        input.organizationId,
        input.idempotencyKey,
      );
      if (!raced) throw error;
      return { created: false, job: raced };
    }
  }

  private findMigrationLifecycleCommandForUpdate(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
  }) {
    if (getDriver() === 'mssql') {
      return sql<Selectable<MigrationLifecycleCommandTable>>`
        select * from migration_lifecycle_commands with (updlock, holdlock)
        where tenant_id = ${input.tenantId}
          and organization_id = ${input.organizationId}
          and id = ${input.commandId}
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    return this.db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.commandId)
      .forUpdate()
      .executeTakeFirst();
  }

  private findMigrationLifecycleCommandByIdempotencyForUpdate(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    idempotencyKeySha256: string;
  }) {
    if (getDriver() === 'mssql') {
      return sql<Selectable<MigrationLifecycleCommandTable>>`
        select * from migration_lifecycle_commands with (updlock, holdlock)
        where tenant_id = ${input.tenantId}
          and organization_id = ${input.organizationId}
          and import_job_id = ${input.jobId}
          and idempotency_key_sha256 = ${input.idempotencyKeySha256}
      `
        .execute(this.db)
        .then((result) => result.rows[0]);
    }
    return this.db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('idempotency_key_sha256', '=', input.idempotencyKeySha256)
      .forUpdate()
      .executeTakeFirst();
  }

  async reserveMigrationLifecycleCommand(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    action: MigrationLifecycleAction;
    dispatchKind: MigrationLifecycleDispatchKind;
    idempotencyKeySha256: string;
    requestFingerprint: string;
    expectedJobStatus: ImportJobStatus;
    expectedLifecycleVersion: number;
    actorId: string;
    auditCorrelationId: string;
    now?: Date;
  }): Promise<{ created: boolean; command: Selectable<MigrationLifecycleCommandTable> }> {
    assertTransactionOwned(this.db);
    assertLifecycleCommandInput(input);
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('MIGRATION_LIFECYCLE_TIME_INVALID');

    const job = await this.findJobForUpdate(input.tenantId, input.organizationId, input.jobId);
    if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
    const existing = await this.findMigrationLifecycleCommandByIdempotencyForUpdate({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      idempotencyKeySha256: input.idempotencyKeySha256,
    });
    if (existing) {
      if (existing.request_fingerprint !== input.requestFingerprint) {
        throw new Error('MIGRATION_LIFECYCLE_IDEMPOTENCY_CONFLICT');
      }
      return { created: false, command: existing };
    }
    if (
      job.status !== input.expectedJobStatus ||
      Number(job.lifecycle_version) !== input.expectedLifecycleVersion
    ) {
      throw new Error('MIGRATION_LIFECYCLE_VERSION_CONFLICT');
    }
    if (input.expectedLifecycleVersion > 0) {
      const predecessor = await this.db
        .selectFrom('migration_lifecycle_commands')
        .select(['id', 'completed_at'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('lifecycle_sequence', '=', input.expectedLifecycleVersion)
        .executeTakeFirst();
      if (!predecessor || predecessor.completed_at === null) {
        throw new Error('MIGRATION_LIFECYCLE_PREDECESSOR_INCOMPLETE');
      }
    }
    const lifecycleSequence = input.expectedLifecycleVersion + 1;
    const advanced = await this.db
      .updateTable('import_jobs')
      .set({ lifecycle_version: lifecycleSequence, updated_at: now })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', '=', input.expectedJobStatus)
      .where('lifecycle_version', '=', input.expectedLifecycleVersion)
      .executeTakeFirst();
    if (Number(advanced.numUpdatedRows) !== 1) {
      throw new Error('MIGRATION_LIFECYCLE_VERSION_CONFLICT');
    }
    const id = this.generateId('mlc');
    await this.db
      .insertInto('migration_lifecycle_commands')
      .values({
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        import_job_id: input.jobId,
        action: input.action,
        dispatch_kind: input.dispatchKind,
        idempotency_key_sha256: input.idempotencyKeySha256,
        request_fingerprint: input.requestFingerprint,
        expected_job_status: input.expectedJobStatus,
        lifecycle_sequence: lifecycleSequence,
        status: 'pending',
        attempts: 0,
        next_attempt_at: now,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
        actor_id: input.actorId,
        audit_correlation_id: input.auditCorrelationId,
        created_at: now,
        updated_at: now,
        dispatched_at: null,
        completed_at: null,
      })
      .execute();
    const command = await this.findMigrationLifecycleCommand({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      commandId: id,
    });
    if (!command) throw new Error('MIGRATION_LIFECYCLE_COMMAND_NOT_FOUND');
    return { created: true, command };
  }

  findMigrationLifecycleCommand(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
  }): Promise<Selectable<MigrationLifecycleCommandTable> | undefined> {
    return this.db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.commandId)
      .executeTakeFirst();
  }

  findMigrationLifecycleCommandByIdempotency(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    idempotencyKeySha256: string;
  }): Promise<Selectable<MigrationLifecycleCommandTable> | undefined> {
    if (!SHA256_HEX.test(input.idempotencyKeySha256)) {
      throw new Error('MIGRATION_LIFECYCLE_IDEMPOTENCY_DIGEST_INVALID');
    }
    return this.db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('idempotency_key_sha256', '=', input.idempotencyKeySha256)
      .executeTakeFirst();
  }

  listMigrationLifecycleCommands(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<Array<Selectable<MigrationLifecycleCommandTable>>> {
    const afterSequence = input.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('MIGRATION_LIFECYCLE_SEQUENCE_INVALID');
    }
    return this.db
      .selectFrom('migration_lifecycle_commands')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('lifecycle_sequence', '>', afterSequence)
      .orderBy('lifecycle_sequence', 'asc')
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
      .execute();
  }

  async claimDueMigrationLifecycleCommands(input: {
    workerId: string;
    limit?: number;
    leaseMs: number;
    now?: Date;
  }): Promise<Array<Selectable<MigrationLifecycleCommandTable>>> {
    assertLifecycleIdentity(input.workerId, 'MIGRATION_LIFECYCLE_WORKER_INVALID');
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 15 * 60_000) {
      throw new Error('MIGRATION_LIFECYCLE_LEASE_INVALID');
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('MIGRATION_LIFECYCLE_TIME_INVALID');
    const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
    return this.db.transaction().execute(async (transaction) => {
      const candidates =
        getDriver() === 'mssql'
          ? (
              await sql<Selectable<MigrationLifecycleCommandTable>>`
                select top (${limit}) command.*
                from migration_lifecycle_commands command with (updlock, readpast, rowlock)
                where (
                  (command.status = 'pending' and command.next_attempt_at <= ${now})
                  or (command.status = 'dispatching' and command.lease_expires_at <= ${now})
                )
                and not exists (
                  select 1 from migration_lifecycle_commands earlier
                  where earlier.tenant_id = command.tenant_id
                    and earlier.organization_id = command.organization_id
                    and earlier.import_job_id = command.import_job_id
                    and earlier.lifecycle_sequence < command.lifecycle_sequence
                    and earlier.completed_at is null
                )
                order by command.next_attempt_at, command.created_at, command.id
              `.execute(transaction)
            ).rows
          : await transaction
              .selectFrom('migration_lifecycle_commands as command')
              .selectAll('command')
              .where((eb) =>
                eb.or([
                  eb.and([
                    eb('command.status', '=', 'pending'),
                    eb('command.next_attempt_at', '<=', now),
                  ]),
                  eb.and([
                    eb('command.status', '=', 'dispatching'),
                    eb('command.lease_expires_at', '<=', now),
                  ]),
                ]),
              )
              .where(
                sql<boolean>`not exists (
                  select 1 from migration_lifecycle_commands earlier
                  where earlier.tenant_id = command.tenant_id
                    and earlier.organization_id = command.organization_id
                    and earlier.import_job_id = command.import_job_id
                    and earlier.lifecycle_sequence < command.lifecycle_sequence
                    and earlier.completed_at is null
                )`,
              )
              .orderBy('command.next_attempt_at', 'asc')
              .orderBy('command.created_at', 'asc')
              .orderBy('command.id', 'asc')
              .limit(limit)
              .forUpdate()
              .skipLocked()
              .execute();
      const claimed: Array<Selectable<MigrationLifecycleCommandTable>> = [];
      for (const candidate of candidates) {
        const updated = await transaction
          .updateTable('migration_lifecycle_commands')
          .set((eb) => ({
            status: 'dispatching',
            attempts: eb('attempts', '+', 1),
            lease_owner: input.workerId,
            lease_expires_at: leaseExpiresAt,
            last_error_code: null,
            updated_at: now,
          }))
          .where('id', '=', candidate.id)
          .where('tenant_id', '=', candidate.tenant_id)
          .where('organization_id', '=', candidate.organization_id)
          .where((eb) =>
            eb.or([
              eb.and([eb('status', '=', 'pending'), eb('next_attempt_at', '<=', now)]),
              eb.and([eb('status', '=', 'dispatching'), eb('lease_expires_at', '<=', now)]),
            ]),
          )
          .executeTakeFirst();
        if (Number(updated.numUpdatedRows) !== 1) continue;
        const row = await transaction
          .selectFrom('migration_lifecycle_commands')
          .selectAll()
          .where('id', '=', candidate.id)
          .executeTakeFirstOrThrow();
        claimed.push(row);
      }
      return claimed;
    });
  }

  async markMigrationLifecycleCommandDispatched(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
    workerId: string;
    now?: Date;
  }): Promise<boolean> {
    assertLifecycleIdentity(input.workerId, 'MIGRATION_LIFECYCLE_WORKER_INVALID');
    const now = input.now ?? new Date();
    const result = await this.db
      .updateTable('migration_lifecycle_commands')
      .set({
        status: 'dispatched',
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: null,
        dispatched_at: now,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.commandId)
      .where('status', '=', 'dispatching')
      .where('lease_owner', '=', input.workerId)
      .where('lease_expires_at', '>', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async rescheduleMigrationLifecycleCommand(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
    workerId: string;
    errorCode: string;
    nextAttemptAt: Date;
    now?: Date;
  }): Promise<boolean> {
    return this.releaseMigrationLifecycleCommand({ ...input, status: 'pending' });
  }

  async markMigrationLifecycleCommandFailed(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
    workerId: string;
    errorCode: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    return this.releaseMigrationLifecycleCommand({
      ...input,
      status: 'failed',
      nextAttemptAt: now,
    });
  }

  private async releaseMigrationLifecycleCommand(input: {
    tenantId: string;
    organizationId: string;
    commandId: string;
    workerId: string;
    errorCode: string;
    nextAttemptAt: Date;
    status: 'pending' | 'failed';
    now?: Date;
  }): Promise<boolean> {
    assertLifecycleIdentity(input.workerId, 'MIGRATION_LIFECYCLE_WORKER_INVALID');
    if (!SAFE_ERROR_CODE.test(input.errorCode)) {
      throw new Error('MIGRATION_LIFECYCLE_ERROR_CODE_INVALID');
    }
    const now = input.now ?? new Date();
    if (
      !Number.isFinite(now.getTime()) ||
      !Number.isFinite(input.nextAttemptAt.getTime()) ||
      input.nextAttemptAt < now
    ) {
      throw new Error('MIGRATION_LIFECYCLE_RETRY_TIME_INVALID');
    }
    const result = await this.db
      .updateTable('migration_lifecycle_commands')
      .set({
        status: input.status,
        next_attempt_at: input.nextAttemptAt,
        lease_owner: null,
        lease_expires_at: null,
        last_error_code: input.errorCode,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.commandId)
      .where('status', '=', 'dispatching')
      .where('lease_owner', '=', input.workerId)
      .where('lease_expires_at', '>', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async persistMigrationLifecycleCommandOutcome(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    commandId: string;
    lifecycleSequence: number;
    outcome: MigrationLifecycleOutcome;
    now?: Date;
  }): Promise<{
    job: Selectable<ImportJobTable>;
    command: Selectable<MigrationLifecycleCommandTable>;
    event: Selectable<ImportJobEventTable>;
  }> {
    assertTransactionOwned(this.db);
    if (!Number.isSafeInteger(input.lifecycleSequence) || input.lifecycleSequence < 1) {
      throw new Error('MIGRATION_LIFECYCLE_SEQUENCE_INVALID');
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error('MIGRATION_LIFECYCLE_TIME_INVALID');
    const job = await this.findJobForUpdate(input.tenantId, input.organizationId, input.jobId);
    if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');
    const command = await this.findMigrationLifecycleCommandForUpdate(input);
    if (
      !command ||
      command.import_job_id !== input.jobId ||
      command.lifecycle_sequence !== input.lifecycleSequence
    ) {
      throw new Error('MIGRATION_LIFECYCLE_COMMAND_NOT_FOUND');
    }
    const expectedAction: Record<MigrationLifecycleOutcome, MigrationLifecycleAction> = {
      paused: 'pause',
      resumed: 'resume',
      cancelled: 'cancel',
      rollback_refused: 'rollback',
      rolled_back: 'rollback',
    };
    if (command.action !== expectedAction[input.outcome]) {
      throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
    }
    let targetStatus: ImportJobStatus;
    let allowedStatuses: ImportJobStatus[];
    switch (input.outcome) {
      case 'paused':
        targetStatus = 'paused';
        allowedStatuses = [command.expected_job_status as ImportJobStatus, 'paused'];
        break;
      case 'resumed':
        if (command.dispatch_kind === 'preparation-signal') targetStatus = 'preparing';
        else if (command.dispatch_kind === 'commit-signal') targetStatus = 'committing';
        else throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
        allowedStatuses = ['paused', targetStatus];
        break;
      case 'cancelled':
        targetStatus = 'cancelled';
        allowedStatuses = [
          command.expected_job_status as ImportJobStatus,
          'cancelling',
          'cancelled',
        ];
        break;
      case 'rollback_refused':
        targetStatus = command.expected_job_status as ImportJobStatus;
        allowedStatuses = ['rolling-back', targetStatus];
        break;
      case 'rolled_back':
        targetStatus = 'rolled-back';
        allowedStatuses = [
          command.expected_job_status as ImportJobStatus,
          'rolling-back',
          'rolled-back',
        ];
        break;
    }
    if (!MIGRATION_JOB_STATUSES.has(targetStatus)) {
      throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
    }
    const eventInput = {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      eventKey: `lifecycle:${command.id}:${command.lifecycle_sequence}:${input.outcome}`,
      type: `migration.lifecycle.${input.outcome}`,
      severity: (input.outcome === 'rollback_refused' ? 'warning' : 'info') as 'warning' | 'info',
      message: `Migration lifecycle command outcome: ${input.outcome}.`,
      data: {
        commandId: command.id,
        lifecycleSequence: command.lifecycle_sequence,
        outcome: input.outcome,
        actorId: command.actor_id,
        auditCorrelationId: command.audit_correlation_id,
      },
    };
    const outcomeEvents = await this.listEventsByKeyPrefix({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      eventKeyPrefix: `lifecycle:${command.id}:${command.lifecycle_sequence}:`,
    });
    const existingEvent = outcomeEvents.find(({ event_key }) => event_key === eventInput.eventKey);
    if (outcomeEvents.length > 0 && !existingEvent) {
      throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
    }
    if (existingEvent) {
      const event = await this.appendIdempotentEventInCurrentTransaction(eventInput);
      const replayJob = await this.findJob(input.tenantId, input.organizationId, input.jobId);
      if (!replayJob) throw new Error('MIGRATION_JOB_NOT_FOUND');
      return { job: replayJob, command, event };
    }
    if (!allowedStatuses.includes(job.status as ImportJobStatus)) {
      throw new Error('MIGRATION_LIFECYCLE_JOB_STATUS_CONFLICT');
    }
    if (command.dispatch_kind === 'none') {
      if (command.status !== 'pending') throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
      const dispatched = await this.db
        .updateTable('migration_lifecycle_commands')
        .set({ status: 'dispatched', dispatched_at: now, completed_at: now, updated_at: now })
        .where('id', '=', command.id)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (Number(dispatched.numUpdatedRows) !== 1) {
        throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
      }
    } else if (command.status !== 'dispatched') {
      throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
    }
    const transitioned = await this.db
      .updateTable('import_jobs')
      .set({
        status: targetStatus,
        completed_at: ['cancelled', 'rolled-back'].includes(targetStatus) ? now : undefined,
        cancelled_at: targetStatus === 'cancelled' ? now : undefined,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', 'in', allowedStatuses)
      .executeTakeFirst();
    if (Number(transitioned.numUpdatedRows) !== 1) {
      throw new Error('MIGRATION_LIFECYCLE_JOB_STATUS_CONFLICT');
    }
    if (command.dispatch_kind !== 'none') {
      const completed = await this.db
        .updateTable('migration_lifecycle_commands')
        .set({ completed_at: now, updated_at: now })
        .where('id', '=', command.id)
        .where('status', '=', 'dispatched')
        .where('completed_at', 'is', null)
        .executeTakeFirst();
      if (Number(completed.numUpdatedRows) !== 1) {
        throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
      }
    }
    const event = await this.appendIdempotentEventInCurrentTransaction(eventInput);
    const updatedJob = await this.findJob(input.tenantId, input.organizationId, input.jobId);
    const updatedCommand = await this.findMigrationLifecycleCommand(input);
    if (!updatedJob || !updatedCommand) throw new Error('MIGRATION_LIFECYCLE_OUTCOME_CONFLICT');
    return { job: updatedJob, command: updatedCommand, event };
  }

  findJob(
    tenantId: string,
    organizationId: string,
    jobId: string,
  ): Promise<Selectable<ImportJobTable> | undefined> {
    return this.db
      .selectFrom('import_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', jobId)
      .executeTakeFirst();
  }

  findJobByIdempotencyKey(
    tenantId: string,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<Selectable<ImportJobTable> | undefined> {
    return this.db
      .selectFrom('import_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  listJobs(input: { tenantId: string; organizationId: string; limit?: number; offset?: number }) {
    return this.db
      .selectFrom('import_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .orderBy('created_at', 'desc')
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 200))
      .offset(Math.max(input.offset ?? 0, 0))
      .execute();
  }

  listFiles(tenantId: string, organizationId: string, jobId: string) {
    return this.db
      .selectFrom('import_job_files')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  listConflicts(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    limit?: number;
    offset?: number;
  }) {
    return this.db
      .selectFrom('import_conflicts')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .orderBy('created_at', 'asc')
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500))
      .offset(Math.max(input.offset ?? 0, 0))
      .execute();
  }

  listMappings(tenantId: string, organizationId: string, sourceSystem?: string) {
    let query = this.db.selectFrom('import_mappings').selectAll().where('tenant_id', '=', tenantId);
    query = query.where('organization_id', '=', organizationId);
    if (sourceSystem) query = query.where('source_system', '=', sourceSystem);
    return query.orderBy('updated_at', 'desc').orderBy('id', 'asc').execute();
  }

  saveMapping(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    name: string;
    entityType: string;
    mapping: unknown;
    createdBy: string;
  }) {
    const id = this.generateId('imm');
    const now = new Date();
    return this.insertReturning(
      'import_mappings',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        source_system: input.sourceSystem,
        name: input.name,
        entity_type: input.entityType,
        mapping: JSON.stringify(input.mapping),
        version: 1,
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async transitionJob(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    from: ImportJobStatus[];
    to: ImportJobStatus;
    summary?: unknown;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean> {
    if (input.from.length === 0) throw new Error('At least one source status is required');
    const now = new Date();
    const result = await this.db
      .updateTable('import_jobs')
      .set({
        status: input.to,
        summary: input.summary === undefined ? undefined : JSON.stringify(input.summary),
        error_code: input.errorCode,
        error_message: input.errorMessage,
        started_at: input.to === 'discovering' ? now : undefined,
        completed_at: ['committed', 'failed', 'cancelled', 'rolled-back'].includes(input.to)
          ? now
          : undefined,
        activated_at: input.to === 'activated' ? now : undefined,
        cancelled_at: input.to === 'cancelled' ? now : undefined,
        updated_at: now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', 'in', input.from)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  appendEvent(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    sequence: number;
    type: string;
    severity: 'fatal' | 'error' | 'warning' | 'info';
    message: string;
    data?: unknown;
  }): Promise<Selectable<ImportJobEventTable>> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new Error('Import event sequence must be a positive safe integer');
    }
    const id = this.generateId('ime');
    return this.insertReturning(
      'import_job_events',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        import_job_id: input.jobId,
        sequence: input.sequence,
        event_key: `legacy:${input.sequence}:${input.type}`,
        type: input.type,
        severity: input.severity,
        message: input.message,
        data: input.data === undefined ? null : JSON.stringify(input.data),
        created_at: new Date(),
      },
      id,
    );
  }

  async appendIdempotentEvent(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    eventKey: string;
    type: string;
    severity: 'fatal' | 'error' | 'warning' | 'info';
    message: string;
    data?: unknown;
  }): Promise<Selectable<ImportJobEventTable>> {
    if (!input.eventKey || input.eventKey.length > 255)
      throw new Error('Import event key is required');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.db.transaction().execute(async (transaction) => {
          const existing = await transaction
            .selectFrom('import_job_events')
            .selectAll()
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('import_job_id', '=', input.jobId)
            .where('event_key', '=', input.eventKey)
            .executeTakeFirst();
          if (existing) {
            const expectedData = input.data === undefined ? null : JSON.stringify(input.data);
            if (
              existing.type !== input.type ||
              existing.severity !== input.severity ||
              existing.message !== input.message ||
              existing.data !== expectedData
            )
              throw new Error('IMPORT_EVENT_IDEMPOTENCY_CONFLICT');
            return existing;
          }
          const maximum = await transaction
            .selectFrom('import_job_events')
            .select(({ fn }) => fn.max<number>('sequence').as('maximum'))
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('import_job_id', '=', input.jobId)
            .executeTakeFirst();
          const id = this.generateId('ime');
          await transaction
            .insertInto('import_job_events')
            .values({
              id,
              tenant_id: input.tenantId,
              organization_id: input.organizationId,
              import_job_id: input.jobId,
              sequence: Number(maximum?.maximum ?? 0) + 1,
              event_key: input.eventKey,
              type: input.type,
              severity: input.severity,
              message: input.message,
              data: input.data === undefined ? null : JSON.stringify(input.data),
              created_at: new Date(),
            })
            .execute();
          return transaction
            .selectFrom('import_job_events')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) throw error;
        const replay = await this.db
          .selectFrom('import_job_events')
          .selectAll()
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('import_job_id', '=', input.jobId)
          .where('event_key', '=', input.eventKey)
          .executeTakeFirst();
        if (replay) {
          const expectedData = input.data === undefined ? null : JSON.stringify(input.data);
          if (
            replay.type !== input.type ||
            replay.severity !== input.severity ||
            replay.message !== input.message ||
            replay.data !== expectedData
          )
            throw new Error('IMPORT_EVENT_IDEMPOTENCY_CONFLICT', { cause: error });
          return replay;
        }
      }
    }
    throw new Error('Import event sequence allocation exhausted');
  }

  findEventByKey(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    eventKey: string;
  }): Promise<Selectable<ImportJobEventTable> | undefined> {
    return this.db
      .selectFrom('import_job_events')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('event_key', '=', input.eventKey)
      .executeTakeFirst();
  }

  listEventsByKeyPrefix(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    eventKeyPrefix: string;
  }): Promise<Array<Selectable<ImportJobEventTable>>> {
    if (!input.eventKeyPrefix || input.eventKeyPrefix.length > 240)
      throw new Error('Import event key prefix is required');
    return this.db
      .selectFrom('import_job_events')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('event_key', 'like', `${input.eventKeyPrefix}%`)
      .orderBy('sequence', 'asc')
      .execute();
  }

  async appendIdempotentEventInCurrentTransaction(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    eventKey: string;
    type: string;
    severity: 'fatal' | 'error' | 'warning' | 'info';
    message: string;
    data?: unknown;
  }): Promise<Selectable<ImportJobEventTable>> {
    const existing = await this.db
      .selectFrom('import_job_events')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('event_key', '=', input.eventKey)
      .executeTakeFirst();
    if (existing) {
      const expectedData = input.data === undefined ? null : JSON.stringify(input.data);
      if (
        existing.type !== input.type ||
        existing.severity !== input.severity ||
        existing.message !== input.message ||
        existing.data !== expectedData
      )
        throw new Error('IMPORT_EVENT_IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const maximum = await this.db
      .selectFrom('import_job_events')
      .select(({ fn }) => fn.max<number>('sequence').as('maximum'))
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .executeTakeFirst();
    const id = this.generateId('ime');
    await this.db
      .insertInto('import_job_events')
      .values({
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        import_job_id: input.jobId,
        sequence: Number(maximum?.maximum ?? 0) + 1,
        event_key: input.eventKey,
        type: input.type,
        severity: input.severity,
        message: input.message,
        data: input.data === undefined ? null : JSON.stringify(input.data),
        created_at: new Date(),
      })
      .execute();
    return this.db
      .selectFrom('import_job_events')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  listEvents(
    tenantId: string,
    organizationId: string,
    jobId: string,
    afterSequence = 0,
  ): Promise<Array<Selectable<ImportJobEventTable>>> {
    return this.db
      .selectFrom('import_job_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .where('sequence', '>', afterSequence)
      .orderBy('sequence', 'asc')
      .execute();
  }

  listRows(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    entityTypes?: string[];
    statuses?: string[];
    limit?: number;
    offset?: number;
  }): Promise<Array<Selectable<ImportJobRowTable>>> {
    let query = this.db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId);
    if (input.entityTypes?.length) query = query.where('entity_type', 'in', input.entityTypes);
    if (input.statuses?.length) query = query.where('status', 'in', input.statuses);
    return query
      .orderBy('row_number', 'asc')
      .orderBy('id', 'asc')
      .limit(Math.min(Math.max(input.limit ?? 500, 1), 5_000))
      .offset(Math.max(input.offset ?? 0, 0))
      .execute();
  }

  listRowsByIds(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    rowIds: string[];
  }): Promise<Array<Selectable<ImportJobRowTable>>> {
    if (input.rowIds.length === 0) return Promise.resolve([]);
    return this.db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('id', 'in', input.rowIds)
      .orderBy('row_number', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  listClaimedRowsByOwner(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    claimedStatus: string;
    ownerToken: string;
  }): Promise<Array<Selectable<ImportJobRowTable>>> {
    return this.db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('status', '=', input.claimedStatus)
      .where('claim_owner', '=', input.ownerToken)
      .orderBy('row_number', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }

  async releaseExpiredClaimsByOwner(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    claimedStatus: string;
    returnToStatus: string;
    ownerToken: string;
    now: Date;
  }): Promise<number> {
    const result = await this.db
      .updateTable('import_job_rows')
      .set({
        status: input.returnToStatus,
        claim_owner: null,
        claim_expires_at: null,
        updated_at: input.now,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('status', '=', input.claimedStatus)
      .where('claim_owner', '=', input.ownerToken)
      .where('claim_expires_at', '<=', input.now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async releaseClaimsByOwner(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    claimedStatus: string;
    returnToStatus: string;
    ownerToken: string;
  }): Promise<number> {
    const result = await this.db
      .updateTable('import_job_rows')
      .set({
        status: input.returnToStatus,
        claim_owner: null,
        claim_expires_at: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('status', '=', input.claimedStatus)
      .where('claim_owner', '=', input.ownerToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async claimRows(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    entityTypes: string[];
    fromStatus: string;
    claimStatus: string;
    ownerToken: string;
    leaseExpiresAt: Date;
    limit: number;
  }): Promise<Array<Selectable<ImportJobRowTable>>> {
    if (input.entityTypes.length === 0) return [];
    if (!input.ownerToken || input.ownerToken.length > 255)
      throw new Error('Import row claim owner token is required');
    if (!Number.isFinite(input.leaseExpiresAt.getTime()) || input.leaseExpiresAt <= new Date())
      throw new Error('Import row claim lease must expire in the future');
    await this.db
      .updateTable('import_job_rows')
      .set({
        status: input.fromStatus,
        claim_owner: null,
        claim_expires_at: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('status', '=', input.claimStatus)
      .where('claim_expires_at', '<', new Date())
      .execute();
    const candidates = await this.listRows({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      entityTypes: input.entityTypes,
      statuses: [input.fromStatus],
      limit: input.limit,
    });
    const claimedIds: string[] = [];
    for (const candidate of candidates) {
      const result = await this.db
        .updateTable('import_job_rows')
        .set({
          status: input.claimStatus,
          claim_owner: input.ownerToken,
          claim_attempt: candidate.claim_attempt + 1,
          claim_expires_at: input.leaseExpiresAt,
          updated_at: new Date(),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('id', '=', candidate.id)
        .where('status', '=', input.fromStatus)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 1) claimedIds.push(candidate.id);
    }
    if (claimedIds.length === 0) return [];
    return this.db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('id', 'in', claimedIds)
      .orderBy('row_number', 'asc')
      .execute();
  }

  async claimRowsByIds(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    rowIds: string[];
    fromStatus: string;
    claimStatus: string;
    ownerToken: string;
    leaseExpiresAt: Date;
  }): Promise<Array<Selectable<ImportJobRowTable>>> {
    if (
      input.rowIds.length === 0 ||
      new Set(input.rowIds).size !== input.rowIds.length ||
      !input.ownerToken ||
      input.ownerToken.length > 255 ||
      !Number.isFinite(input.leaseExpiresAt.getTime()) ||
      input.leaseExpiresAt <= new Date()
    )
      throw new Error('Import exact row claim is invalid');
    return this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      for (const rowId of input.rowIds) {
        const result = await transaction
          .updateTable('import_job_rows')
          .set((eb) => ({
            status: input.claimStatus,
            claim_owner: input.ownerToken,
            claim_attempt: eb('claim_attempt', '+', 1),
            claim_expires_at: input.leaseExpiresAt,
            updated_at: now,
          }))
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('import_job_id', '=', input.jobId)
          .where('id', '=', rowId)
          .where((eb) =>
            eb.or([
              eb('status', '=', input.fromStatus),
              eb.and([eb('status', '=', input.claimStatus), eb('claim_expires_at', '<=', now)]),
            ]),
          )
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) throw new Error('IMPORT_ROW_EXACT_CLAIM_CONFLICT');
      }
      return transaction
        .selectFrom('import_job_rows')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('id', 'in', input.rowIds)
        .orderBy('row_number', 'asc')
        .orderBy('id', 'asc')
        .execute();
    });
  }

  async completeRow(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    rowId: string;
    claimedStatus: string;
    ownerToken: string;
    outcome: 'created' | 'updated' | 'skipped' | 'conflict' | 'failed';
    tixkitId?: string;
    createdEntity?: boolean;
    severity?: 'fatal' | 'error' | 'warning' | 'info';
    rollbackBlockedReason?: string;
    completionEvent?: ImportRowCompletionEvent;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const result = await transaction
        .updateTable('import_job_rows')
        .set({
          status: input.outcome,
          severity: input.severity,
          tixkit_id: input.tixkitId,
          created_entity: input.createdEntity,
          rollback_blocked_reason: input.rollbackBlockedReason,
          claim_owner: null,
          claim_expires_at: null,
          updated_at: now,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('id', '=', input.rowId)
        .where('status', '=', input.claimedStatus)
        .where('claim_owner', '=', input.ownerToken)
        .where('claim_expires_at', '>', now)
        .executeTakeFirst();
      const completed = Number(result.numUpdatedRows) === 1;
      if (completed && input.completionEvent) {
        await new ImportRepository(transaction).appendIdempotentEventInCurrentTransaction({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          ...input.completionEvent,
        });
      }
      return completed;
    });
  }

  async completeRowWithExternalReference(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    rowId: string;
    claimedStatus: string;
    ownerToken: string;
    outcome: 'created' | 'updated' | 'skipped';
    sourceSystem: string;
    entityType: string;
    externalId: string;
    tixkitId: string;
    createdEntity: boolean;
    provenance?: unknown;
    completionEvent?: ImportRowCompletionEvent;
  }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const tenantIdentity = await transaction
        .selectFrom('external_references')
        .select(['id', 'organization_id', 'tixkit_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('source_system', '=', input.sourceSystem)
        .where('entity_type', '=', input.entityType)
        .where('external_id', '=', input.externalId)
        .executeTakeFirst();
      if (tenantIdentity && tenantIdentity.organization_id !== input.organizationId) {
        throw new Error('External reference belongs to another organization in this tenant');
      }
      const existing = tenantIdentity;
      const now = new Date();
      if (existing && existing.tixkit_id !== input.tixkitId) {
        throw new Error('External reference already maps to a different Tixkit entity');
      }
      if (existing) {
        await transaction
          .updateTable('external_references')
          .set({
            last_seen_import_job_id: input.jobId,
            source_provenance:
              input.provenance === undefined ? undefined : JSON.stringify(input.provenance),
            updated_at: now,
          })
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('id', '=', existing.id)
          .execute();
      } else {
        await transaction
          .insertInto('external_references')
          .values({
            id: this.generateId('xref'),
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            source_system: input.sourceSystem,
            entity_type: input.entityType,
            external_id: input.externalId,
            tixkit_id: input.tixkitId,
            created_by_import_job_id: input.createdEntity ? input.jobId : null,
            last_seen_import_job_id: input.jobId,
            source_provenance:
              input.provenance === undefined ? null : JSON.stringify(input.provenance),
            rollback_blocked_at: null,
            rollback_blocked_reason: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      const result = await transaction
        .updateTable('import_job_rows')
        .set({
          status: input.outcome,
          tixkit_id: input.tixkitId,
          created_entity: input.createdEntity,
          claim_owner: null,
          claim_expires_at: null,
          updated_at: now,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('id', '=', input.rowId)
        .where('status', '=', input.claimedStatus)
        .where('claim_owner', '=', input.ownerToken)
        .where('claim_expires_at', '>', now)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error('Import row claim was lost before completion');
      }
      if (input.completionEvent) {
        await new ImportRepository(transaction).appendIdempotentEventInCurrentTransaction({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          jobId: input.jobId,
          ...input.completionEvent,
        });
      }
    });
  }

  async releaseClaims(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    claimedStatus: string;
    returnToStatus: string;
  }): Promise<number> {
    const result = await this.db
      .updateTable('import_job_rows')
      .set({
        status: input.returnToStatus,
        claim_owner: null,
        claim_expires_at: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('status', '=', input.claimedStatus)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  listRowsForReconciliation(
    tenantId: string,
    organizationId: string,
    jobId: string,
    limit = 500,
    offset = 0,
  ) {
    return this.db
      .selectFrom('import_job_rows')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .where('status', 'not in', ['created', 'updated', 'skipped', 'rolled-back'])
      .orderBy('row_number', 'asc')
      .limit(Math.min(Math.max(limit, 1), 5_000))
      .offset(Math.max(offset, 0))
      .execute();
  }

  requestCancellation(tenantId: string, organizationId: string, jobId: string): Promise<boolean> {
    return this.transitionJob({
      tenantId,
      organizationId,
      jobId,
      from: [
        'pending',
        'discovering',
        'extracting',
        'normalizing',
        'validating',
        'ready',
        'committing',
        'paused',
      ],
      to: 'cancelling',
    });
  }

  async recordExternalReference(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    entityType: string;
    externalId: string;
    tixkitId: string;
    importJobId: string;
    createdByJob: boolean;
    provenance?: unknown;
  }): Promise<Selectable<ExternalReferenceTable>> {
    const tenantIdentity = await this.findExternalReferenceInTenant(input);
    if (tenantIdentity && tenantIdentity.organization_id !== input.organizationId) {
      throw new Error('External reference belongs to another organization in this tenant');
    }
    const existing = await this.findExternalReference(input);
    if (existing) {
      if (existing.tixkit_id !== input.tixkitId) {
        throw new Error('External reference already maps to a different Tixkit entity');
      }
      return this.updateReturning('external_references', existing.id, {
        last_seen_import_job_id: input.importJobId,
        source_provenance:
          input.provenance === undefined
            ? existing.source_provenance
            : JSON.stringify(input.provenance),
        updated_at: new Date(),
      });
    }

    const id = this.generateId('xref');
    const now = new Date();
    try {
      return await this.insertReturning(
        'external_references',
        {
          id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          source_system: input.sourceSystem,
          entity_type: input.entityType,
          external_id: input.externalId,
          tixkit_id: input.tixkitId,
          created_by_import_job_id: input.createdByJob ? input.importJobId : null,
          last_seen_import_job_id: input.importJobId,
          source_provenance:
            input.provenance === undefined ? null : JSON.stringify(input.provenance),
          rollback_blocked_at: null,
          rollback_blocked_reason: null,
          created_at: now,
          updated_at: now,
        },
        id,
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findExternalReference(input);
      if (!raced || raced.tixkit_id !== input.tixkitId) throw error;
      return raced;
    }
  }

  findExternalReference(input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    entityType: string;
    externalId: string;
  }): Promise<Selectable<ExternalReferenceTable> | undefined> {
    return this.db
      .selectFrom('external_references')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('source_system', '=', input.sourceSystem)
      .where('entity_type', '=', input.entityType)
      .where('external_id', '=', input.externalId)
      .executeTakeFirst();
  }

  private findExternalReferenceInTenant(input: {
    tenantId: string;
    sourceSystem: string;
    entityType: string;
    externalId: string;
  }): Promise<Selectable<ExternalReferenceTable> | undefined> {
    return this.db
      .selectFrom('external_references')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('source_system', '=', input.sourceSystem)
      .where('entity_type', '=', input.entityType)
      .where('external_id', '=', input.externalId)
      .executeTakeFirst();
  }

  async markRollbackBlocked(input: {
    tenantId: string;
    organizationId: string;
    entityType: string;
    tixkitId: string;
    reason: string;
  }): Promise<number> {
    const result = await this.db
      .updateTable('external_references')
      .set({
        rollback_blocked_at: new Date(),
        rollback_blocked_reason: input.reason,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('entity_type', '=', input.entityType)
      .where('tixkit_id', '=', input.tixkitId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async getRollbackEligibility(
    tenantId: string,
    organizationId: string,
    jobId: string,
  ): Promise<RollbackEligibility> {
    const job = await this.findJob(tenantId, organizationId, jobId);
    if (!job) throw new Error('Import job not found');
    if (!['committed', 'activated', 'failed'].includes(job.status)) {
      return { eligible: true, mode: 'cancel', blockers: [] };
    }

    const references = await this.db
      .selectFrom('external_references')
      .select(['entity_type', 'tixkit_id', 'rollback_blocked_at', 'rollback_blocked_reason'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('created_by_import_job_id', '=', jobId)
      .execute();
    const rows = await this.db
      .selectFrom('import_job_rows')
      .select(['entity_type', 'tixkit_id', 'domain_activity_at', 'rollback_blocked_reason'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', jobId)
      .where((eb) =>
        eb.or([
          eb('domain_activity_at', 'is not', null),
          eb('rollback_blocked_reason', 'is not', null),
        ]),
      )
      .execute();
    const blockers = [
      ...references
        .filter((reference) => reference.rollback_blocked_at !== null)
        .map((reference) => ({
          entityType: reference.entity_type,
          tixkitId: reference.tixkit_id,
          reason: reference.rollback_blocked_reason ?? 'Downstream activity recorded',
        })),
      ...rows.map((row) => ({
        entityType: row.entity_type,
        tixkitId: row.tixkit_id,
        reason: row.rollback_blocked_reason ?? 'Domain activity recorded after import',
      })),
    ];
    const activated = job.status === 'activated' || job.activated_at !== null;
    return {
      eligible: !activated && blockers.length === 0,
      mode: activated || blockers.length > 0 ? 'corrective-plan' : 'delete-created',
      blockers,
    };
  }

  async deleteRollbackMetadata(
    tenantId: string,
    organizationId: string,
    jobId: string,
  ): Promise<void> {
    const eligibility = await this.getRollbackEligibility(tenantId, organizationId, jobId);
    if (!eligibility.eligible || eligibility.mode !== 'delete-created') {
      throw new Error('Import rollback is not eligible for destructive cleanup');
    }
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom('external_references')
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('created_by_import_job_id', '=', jobId)
        .execute();
      await transaction
        .updateTable('import_job_rows')
        .set({ status: 'rolled-back', updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('import_job_id', '=', jobId)
        .where('created_entity', '=', true)
        .execute();
      await transaction
        .updateTable('import_jobs')
        .set({
          status: 'rolled-back',
          completed_at: new Date(),
          updated_at: new Date(),
        })
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('id', '=', jobId)
        .execute();
    });
  }
}
