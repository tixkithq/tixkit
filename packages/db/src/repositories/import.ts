import type { Selectable } from 'kysely';
import type {
  ExternalReferenceTable,
  ImportJobEventTable,
  ImportJobFileTable,
  ImportJobRowTable,
  ImportJobTable,
  MigrationCredentialTable,
} from '../types/db.js';
import { BaseRepository } from './base.js';

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

export interface RollbackEligibility {
  eligible: boolean;
  mode: 'cancel' | 'delete-created' | 'corrective-plan';
  blockers: Array<{
    entityType: string;
    tixkitId: string | null;
    reason: string;
  }>;
}

export class ImportRepository extends BaseRepository {
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
        status: 'pending',
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
    const existing = await this.findJobByIdempotencyKey(
      input.tenantId,
      input.organizationId,
      input.idempotencyKey,
    );
    if (existing) return existing;

    const id = this.generateId('imp');
    const now = new Date();
    try {
      return await this.insertReturning(
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
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findJobByIdempotencyKey(
        input.tenantId,
        input.organizationId,
        input.idempotencyKey,
      );
      if (!raced) throw error;
      return raced;
    }
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
    return query.orderBy('updated_at', 'desc').execute();
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
          if (existing) return existing;
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
        if (replay) return replay;
      }
    }
    throw new Error('Import event sequence allocation exhausted');
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
      .limit(Math.min(Math.max(input.limit ?? 500, 1), 5_000))
      .offset(Math.max(input.offset ?? 0, 0))
      .execute();
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
  }): Promise<boolean> {
    const result = await this.db
      .updateTable('import_job_rows')
      .set({
        status: input.outcome,
        severity: input.severity,
        tixkit_id: input.tixkitId,
        created_entity: input.createdEntity,
        rollback_blocked_reason: input.rollbackBlockedReason,
        claim_owner: null,
        claim_expires_at: null,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('import_job_id', '=', input.jobId)
      .where('id', '=', input.rowId)
      .where('status', '=', input.claimedStatus)
      .where('claim_owner', '=', input.ownerToken)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
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
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) {
        throw new Error('Import row claim was lost before completion');
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
