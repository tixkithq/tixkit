import type { Selectable } from 'kysely';
import type { Database } from '../client.js';
import type { PortableExportJobTable } from '../types/db.js';
import { BaseRepository } from './base.js';

export interface BeginPortableExportInput {
  tenantId: string;
  organizationId: string;
  requestedBy: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export class PortableExportRepository extends BaseRepository {
  constructor(db: Database) {
    super(db);
  }

  private async existing(input: BeginPortableExportInput) {
    return this.db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();
  }

  private assertReplay(
    existing: Selectable<PortableExportJobTable>,
    input: BeginPortableExportInput,
  ): Selectable<PortableExportJobTable> {
    if (existing.request_fingerprint !== input.requestFingerprint) {
      throw new Error('PORTABLE_EXPORT_IDEMPOTENCY_CONFLICT');
    }
    return existing;
  }

  private async ensureSequence(input: BeginPortableExportInput): Promise<void> {
    const existing = await this.db
      .selectFrom('portable_export_sequences')
      .select('tenant_id')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .executeTakeFirst();
    if (existing) return;
    try {
      await this.db
        .insertInto('portable_export_sequences')
        .values({
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          next_sequence: 1,
          updated_at: new Date(),
        })
        .execute();
    } catch (error) {
      const raced = await this.db
        .selectFrom('portable_export_sequences')
        .select('tenant_id')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst();
      if (!raced) throw error;
    }
  }

  async begin(input: BeginPortableExportInput): Promise<Selectable<PortableExportJobTable>> {
    if (
      !input.tenantId.trim() ||
      input.tenantId.length > 32 ||
      !input.organizationId.trim() ||
      input.organizationId.length > 32 ||
      !input.requestedBy.trim() ||
      input.requestedBy.length > 128 ||
      input.idempotencyKey !== input.idempotencyKey.trim() ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 255 ||
      !/^[a-f0-9]{64}$/u.test(input.requestFingerprint)
    ) {
      throw new Error('PORTABLE_EXPORT_REQUEST_INVALID');
    }
    const replay = await this.existing(input);
    if (replay) return this.assertReplay(replay, input);
    await this.ensureSequence(input);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const created = await this.db.transaction().execute(async (transaction) => {
          const concurrentReplay = await transaction
            .selectFrom('portable_export_jobs')
            .selectAll()
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('idempotency_key', '=', input.idempotencyKey)
            .executeTakeFirst();
          if (concurrentReplay) return this.assertReplay(concurrentReplay, input);

          const row = await transaction
            .selectFrom('portable_export_sequences')
            .select('next_sequence')
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .executeTakeFirstOrThrow();
          const sequence = Number(row.next_sequence);
          if (!Number.isSafeInteger(sequence) || sequence < 1)
            throw new Error('PORTABLE_EXPORT_SEQUENCE_INVALID');
          const allocation = await transaction
            .updateTable('portable_export_sequences')
            .set({ next_sequence: sequence + 1, updated_at: new Date() })
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('next_sequence', '=', row.next_sequence)
            .executeTakeFirst();
          if (Number(allocation.numUpdatedRows) !== 1) return undefined;

          const now = new Date();
          const id = this.generateId('pex');
          const bundleId = `bundle_${id.slice(4)}`;
          await transaction
            .insertInto('portable_export_jobs')
            .values({
              id,
              tenant_id: input.tenantId,
              organization_id: input.organizationId,
              export_sequence: sequence,
              mode: 'configuration',
              status: 'building',
              bundle_id: bundleId,
              source_change_cursor: null,
              build_owner_sha256: null,
              build_lease_expires_at: null,
              manifest_sha256: null,
              artifact_sha256: null,
              artifact_bytes: null,
              requested_by: input.requestedBy,
              idempotency_key: input.idempotencyKey,
              request_fingerprint: input.requestFingerprint,
              error_code: null,
              created_at: now,
              completed_at: null,
            })
            .execute();
          return transaction
            .selectFrom('portable_export_jobs')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        });
        if (created) return created;
      } catch (error) {
        const raced = await this.existing(input);
        if (raced) return this.assertReplay(raced, input);
        throw error;
      }
    }
    throw new Error('PORTABLE_EXPORT_SEQUENCE_CONTENTION');
  }

  async claimBuild(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    ownerSha256: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.ownerSha256) ||
      !Number.isFinite(input.now.getTime()) ||
      !Number.isFinite(input.leaseExpiresAt.getTime()) ||
      input.leaseExpiresAt <= input.now
    )
      throw new Error('PORTABLE_EXPORT_BUILD_CLAIM_INVALID');
    const result = await this.db
      .updateTable('portable_export_jobs')
      .set({
        build_owner_sha256: input.ownerSha256,
        build_lease_expires_at: input.leaseExpiresAt,
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', '=', 'building')
      .where((expression) =>
        expression.or([
          expression('build_owner_sha256', 'is', null),
          expression('build_owner_sha256', '=', input.ownerSha256),
          expression('build_lease_expires_at', '<=', input.now),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async recordSnapshotCursor(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    ownerSha256: string;
    sourceChangeCursor: string;
    now: Date;
  }): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.ownerSha256) ||
      !/^snapshot-sha256:[a-f0-9]{64}$/u.test(input.sourceChangeCursor) ||
      !Number.isFinite(input.now.getTime())
    )
      throw new Error('PORTABLE_EXPORT_SNAPSHOT_CURSOR_INVALID');
    const result = await this.db
      .updateTable('portable_export_jobs')
      .set({ source_change_cursor: input.sourceChangeCursor })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', '=', 'building')
      .where('build_owner_sha256', '=', input.ownerSha256)
      .where('build_lease_expires_at', '>', input.now)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error('PORTABLE_EXPORT_BUILD_LEASE_LOST');
  }

  async complete(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    manifestSha256: string;
    artifactSha256: string;
    artifactBytes: number;
    ownerSha256: string;
  }): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/u.test(input.manifestSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.artifactSha256) ||
      !/^[a-f0-9]{64}$/u.test(input.ownerSha256) ||
      !Number.isSafeInteger(input.artifactBytes) ||
      input.artifactBytes < 1 ||
      input.artifactBytes > 50 * 1024 * 1024
    )
      throw new Error('PORTABLE_EXPORT_COMPLETION_INVALID');
    const completed = await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const job = await transaction
        .selectFrom('portable_export_jobs')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.jobId)
        .where('status', '=', 'building')
        .where('build_owner_sha256', '=', input.ownerSha256)
        .where('build_lease_expires_at', '>', now)
        .executeTakeFirst();
      if (!job?.source_change_cursor) return false;
      const result = await transaction
        .updateTable('portable_export_jobs')
        .set({
          status: 'completed',
          manifest_sha256: input.manifestSha256,
          artifact_sha256: input.artifactSha256,
          artifact_bytes: input.artifactBytes,
          error_code: null,
          completed_at: now,
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.jobId)
        .where('status', '=', 'building')
        .where('build_owner_sha256', '=', input.ownerSha256)
        .where('build_lease_expires_at', '>', now)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) return false;
      await transaction
        .insertInto('portable_export_events')
        .values({
          id: this.generateId('pev'),
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          export_job_id: input.jobId,
          bundle_id: job.bundle_id,
          export_sequence: job.export_sequence,
          source_change_cursor: job.source_change_cursor,
          manifest_sha256: input.manifestSha256,
          artifact_sha256: input.artifactSha256,
          artifact_bytes: input.artifactBytes,
          occurred_at: now,
        })
        .execute();
      return true;
    });
    if (completed) return;
    const existing = await this.db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .executeTakeFirst();
    if (
      existing?.status === 'completed' &&
      existing.manifest_sha256 === input.manifestSha256 &&
      existing.artifact_sha256 === input.artifactSha256 &&
      Number(existing.artifact_bytes) === input.artifactBytes
    ) {
      const event = await this.db
        .selectFrom('portable_export_events')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('export_job_id', '=', input.jobId)
        .executeTakeFirst();
      if (
        event?.bundle_id === existing.bundle_id &&
        Number(event.export_sequence) === Number(existing.export_sequence) &&
        event.source_change_cursor === existing.source_change_cursor &&
        event.manifest_sha256 === input.manifestSha256 &&
        event.artifact_sha256 === input.artifactSha256 &&
        Number(event.artifact_bytes) === input.artifactBytes
      )
        return;
    }
    throw new Error('PORTABLE_EXPORT_COMPLETION_CONFLICT');
  }

  async fail(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    errorCode: string;
  }): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(input.errorCode)) {
      throw new Error('PORTABLE_EXPORT_FAILURE_INVALID');
    }
    await this.db
      .updateTable('portable_export_jobs')
      .set({
        status: 'failed',
        error_code: input.errorCode,
        completed_at: new Date(),
      })
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .where('status', '=', 'building')
      .execute();
  }
}
