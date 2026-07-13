import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createDb,
  ImportRepository,
  OrganizationRepository,
  TenantRepository,
  type Database,
} from '@tixkit/db';
import { ulid } from 'ulid';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const s3Send = vi.fn(async () => ({}));
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send;
  }
  class DeleteObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return { S3Client, DeleteObjectCommand };
});

const { cleanupExpiredUploadArtifacts } = await import('../../services/uploads.js');

describeWithIntegrationDatabase('upload cleanup conditional claims', () => {
  let db: Database;
  let previousDriver: string | undefined;
  let artifactId: string;
  let tenantId: string;
  let organizationId: string;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const suffix = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({ name: `Upload cleanup ${suffix}` });
    tenantId = tenant.id;
    const organization = await new OrganizationRepository(db).create({
      tenantId,
      name: `Upload cleanup ${suffix}`,
      slug: `upload-cleanup-${suffix}`,
    });
    organizationId = organization.id;
    artifactId = `upl_cleanup_${suffix}`;
    const now = new Date();
    await db
      .insertInto('upload_artifacts')
      .values({
        id: artifactId,
        tenant_id: tenant.id,
        organization_id: null,
        brand_id: null,
        event_id: null,
        created_by_user_id: null,
        purpose: 'checkout_answer',
        status: 'pending',
        scan_status: 'pending',
        scan_result: null,
        bucket: 'tixkit',
        object_key: `uploads/${tenant.id}/staging/${artifactId}.txt`,
        file_name: 'cleanup.txt',
        content_type: 'text/plain',
        size_bytes: 1,
        checksum_sha256: null,
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        expires_at: new Date(now.getTime() - 60_000),
        created_at: now,
        updated_at: now,
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('deletes once and reaches a terminal state across concurrent workers', async () => {
    const now = new Date();
    const results = await Promise.all([
      cleanupExpiredUploadArtifacts(db, now),
      cleanupExpiredUploadArtifacts(db, now),
    ]);

    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select(['status', 'scan_status'])
        .where('id', '=', artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'cleanup_complete', scan_status: 'blocked' });
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).toHaveBeenCalledTimes(1);

    s3Send.mockClear();
    const staleArtifactId = `${artifactId}_stale`;
    await db
      .insertInto('upload_artifacts')
      .values({
        id: staleArtifactId,
        tenant_id: tenantId,
        organization_id: null,
        brand_id: null,
        event_id: null,
        created_by_user_id: null,
        purpose: 'checkout_answer',
        status: 'cleanup_pending',
        scan_status: 'pending',
        scan_result: null,
        bucket: 'tixkit',
        object_key: `uploads/${tenantId}/staging/${staleArtifactId}.txt`,
        file_name: 'stale-cleanup.txt',
        content_type: 'text/plain',
        size_bytes: 1,
        checksum_sha256: null,
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        expires_at: new Date(now.getTime() - 60_000),
        created_at: now,
        updated_at: new Date(now.getTime() - 16 * 60_000),
      })
      .execute();

    const staleResults = await Promise.all([
      cleanupExpiredUploadArtifacts(db, now),
      cleanupExpiredUploadArtifacts(db, now),
    ]);
    expect(staleResults.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select('status')
        .where('id', '=', staleArtifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'cleanup_complete' });
  });

  it('serializes migration preparation leases with cleanup and holds immutable linkage drift', async () => {
    const repository = new ImportRepository(db);
    const now = new Date();
    const waitForBarrier = async (barrier: Promise<void>, label: string) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          barrier,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} barrier timed out`)), 5_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    let sequence = 0;
    const fixture = async (input: {
      consumedDaysAgo: number;
      jobStatus?: 'pending' | 'preparing' | 'ready';
    }) => {
      const suffix = `${ulid().slice(-8).toLowerCase()}_${sequence++}`;
      const checksum = `${sequence}`.repeat(64).slice(0, 64);
      const job = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem: 'tixkit-portable',
        adapterVersion: 'v2',
        mode: 'dry-run',
        idempotencyKey: `cleanup-retention-${suffix}`,
        requestedBy: 'usr_cleanup',
        configuration: {},
      });
      if (input.jobStatus && input.jobStatus !== 'pending') {
        await repository.transitionJob({
          tenantId,
          organizationId,
          jobId: job.id,
          from: ['pending'],
          to: input.jobStatus,
        });
      }
      const artifactId = `upl_retention_${suffix}`;
      const objectKey = `uploads/${tenantId}/migration-imports/${organizationId}/final/${artifactId}.json`;
      await db
        .insertInto('upload_artifacts')
        .values({
          id: artifactId,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: null,
          event_id: null,
          created_by_user_id: 'usr_cleanup',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          scan_result: null,
          bucket: 'tixkit',
          object_key: objectKey,
          file_name: `${artifactId}.json`,
          content_type: 'application/vnd.tixkit.portable+json',
          size_bytes: 10,
          checksum_sha256: checksum,
          client_token_hash: null,
          metadata: '{}',
          consumed_by_checkout_session_id: null,
          consumed_at: new Date(now.getTime() - input.consumedDaysAgo * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
          created_at: now,
          updated_at: now,
        })
        .execute();
      const file = await repository.addFile({
        tenantId,
        organizationId,
        jobId: job.id,
        objectKey,
        originalName: `${artifactId}.json`,
        mediaType: 'application/vnd.tixkit.portable+json',
        byteSize: 10,
        sha256: checksum,
      });
      return { artifactId, fileId: file.id, jobId: job.id };
    };

    s3Send.mockClear();
    const preparationWins = await fixture({ consumedDaysAgo: 31 });
    let releasePreparation!: () => void;
    const preparationRelease = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let preparationLocked!: () => void;
    const preparationHasLocks = new Promise<void>((resolve) => {
      preparationLocked = resolve;
    });
    const preparation = db.transaction().execute(async (transaction) => {
      await new ImportRepository(
        transaction as Database,
      ).acquireMigrationArtifactsForStateInTransaction({
        tenantId,
        organizationId,
        jobId: preparationWins.jobId,
        artifactIds: [preparationWins.artifactId],
        targetState: 'preparing',
        transition: true,
        now,
      });
      preparationLocked();
      await preparationRelease;
    });
    let preparationLockEstablished = false;
    try {
      await waitForBarrier(preparationHasLocks, 'preparation lock');
      preparationLockEstablished = true;
    } finally {
      if (!preparationLockEstablished) {
        releasePreparation();
        await Promise.allSettled([preparation]);
      }
    }
    let releasePreparationClaim!: () => void;
    const preparationClaimRelease = new Promise<void>((resolve) => {
      releasePreparationClaim = resolve;
    });
    let preparationClaimStarted!: () => void;
    const preparationClaimHasStarted = new Promise<void>((resolve) => {
      preparationClaimStarted = resolve;
    });
    const concurrentCleanup = cleanupExpiredUploadArtifacts(db, now, 100, {
      async artifactClaimStarted(artifactId) {
        if (artifactId !== preparationWins.artifactId) return;
        preparationClaimStarted();
        await preparationClaimRelease;
      },
    });
    try {
      await waitForBarrier(preparationClaimHasStarted, 'preparation cleanup claim');
    } finally {
      releasePreparation();
      try {
        await preparation;
      } finally {
        releasePreparationClaim();
      }
    }
    await expect(concurrentCleanup).resolves.toBe(0);
    await db
      .updateTable('upload_artifacts')
      .set({ expires_at: new Date(now.getTime() - 1) })
      .where('id', '=', preparationWins.artifactId)
      .execute();
    await expect(cleanupExpiredUploadArtifacts(db, new Date(now.getTime() + 1_000))).resolves.toBe(
      0,
    );
    const retained = await db
      .selectFrom('upload_artifacts')
      .select(['status', 'expires_at'])
      .where('id', '=', preparationWins.artifactId)
      .executeTakeFirstOrThrow();
    expect(retained.status).toBe('uploaded');
    expect(new Date(retained.expires_at).getTime()).toBeGreaterThan(now.getTime());
    expect(s3Send).not.toHaveBeenCalled();

    const cleanupWins = await fixture({ consumedDaysAgo: 31 });
    let releaseCleanup!: () => void;
    const cleanupRelease = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupClaimed!: () => void;
    const cleanupHasClaim = new Promise<void>((resolve) => {
      cleanupClaimed = resolve;
    });
    const cleanup = cleanupExpiredUploadArtifacts(db, now, 100, {
      async artifactClaimed(artifactId) {
        if (artifactId !== cleanupWins.artifactId) return;
        cleanupClaimed();
        await cleanupRelease;
      },
    });
    let cleanupResult: number | undefined;
    try {
      await waitForBarrier(cleanupHasClaim, 'cleanup-first claim');
      await expect(
        repository.acquireMigrationArtifactsForState({
          tenantId,
          organizationId,
          jobId: cleanupWins.jobId,
          artifactIds: [cleanupWins.artifactId],
          targetState: 'preparing',
          transition: true,
          now,
        }),
      ).rejects.toThrow('MIGRATION_ARTIFACT_NOT_AVAILABLE');
    } finally {
      releaseCleanup();
      cleanupResult = await cleanup;
    }
    expect(cleanupResult).toBe(1);
    await expect(
      repository.findJob(tenantId, organizationId, cleanupWins.jobId),
    ).resolves.toMatchObject({ status: 'pending' });

    const commitWins = await fixture({ consumedDaysAgo: 31, jobStatus: 'ready' });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitLocked!: () => void;
    const commitHasLocks = new Promise<void>((resolve) => {
      commitLocked = resolve;
    });
    const commit = db.transaction().execute(async (transaction) => {
      await new ImportRepository(
        transaction as Database,
      ).acquireMigrationArtifactsForStateInTransaction({
        tenantId,
        organizationId,
        jobId: commitWins.jobId,
        artifactIds: [commitWins.artifactId],
        targetState: 'committing',
        transition: true,
        now,
      });
      commitLocked();
      await commitRelease;
    });
    let commitLockEstablished = false;
    try {
      await waitForBarrier(commitHasLocks, 'commit lock');
      commitLockEstablished = true;
    } finally {
      if (!commitLockEstablished) {
        releaseCommit();
        await Promise.allSettled([commit]);
      }
    }
    let releaseCommitClaim!: () => void;
    const commitClaimRelease = new Promise<void>((resolve) => {
      releaseCommitClaim = resolve;
    });
    let commitClaimStarted!: () => void;
    const commitClaimHasStarted = new Promise<void>((resolve) => {
      commitClaimStarted = resolve;
    });
    const commitCleanup = cleanupExpiredUploadArtifacts(db, now, 100, {
      async artifactClaimStarted(artifactId) {
        if (artifactId !== commitWins.artifactId) return;
        commitClaimStarted();
        await commitClaimRelease;
      },
    });
    try {
      await waitForBarrier(commitClaimHasStarted, 'commit cleanup claim');
    } finally {
      releaseCommit();
      try {
        await commit;
      } finally {
        releaseCommitClaim();
      }
    }
    await expect(commitCleanup).resolves.toBe(0);
    await expect(
      repository.findJob(tenantId, organizationId, commitWins.jobId),
    ).resolves.toMatchObject({ status: 'committing' });

    const cleanupBeforeCommit = await fixture({ consumedDaysAgo: 31, jobStatus: 'ready' });
    let releaseCommitCleanup!: () => void;
    const commitCleanupRelease = new Promise<void>((resolve) => {
      releaseCommitCleanup = resolve;
    });
    let commitCleanupClaimed!: () => void;
    const commitCleanupHasClaim = new Promise<void>((resolve) => {
      commitCleanupClaimed = resolve;
    });
    const cleanupBlockingCommit = cleanupExpiredUploadArtifacts(db, now, 100, {
      async artifactClaimed(artifactId) {
        if (artifactId !== cleanupBeforeCommit.artifactId) return;
        commitCleanupClaimed();
        await commitCleanupRelease;
      },
    });
    let cleanupBeforeCommitResult: number | undefined;
    try {
      await waitForBarrier(commitCleanupHasClaim, 'cleanup-before-commit claim');
      await expect(
        repository.acquireMigrationArtifactsForState({
          tenantId,
          organizationId,
          jobId: cleanupBeforeCommit.jobId,
          artifactIds: [cleanupBeforeCommit.artifactId],
          targetState: 'committing',
          transition: true,
          now,
        }),
      ).rejects.toThrow('MIGRATION_ARTIFACT_NOT_AVAILABLE');
      await expect(
        repository.findJob(tenantId, organizationId, cleanupBeforeCommit.jobId),
      ).resolves.toMatchObject({ status: 'ready' });
    } finally {
      releaseCommitCleanup();
      cleanupBeforeCommitResult = await cleanupBlockingCommit;
    }
    expect(cleanupBeforeCommitResult).toBe(1);

    const acquisitionDrifts = [
      { label: 'checksum', values: { sha256: 'e'.repeat(64) } },
      { label: 'byte size', values: { byte_size: 11 } },
      { label: 'media type', values: { media_type: 'application/json' } },
      { label: 'status', values: { status: 'rejected' } },
    ] as const;
    for (const drift of acquisitionDrifts) {
      const candidate = await fixture({ consumedDaysAgo: 31 });
      const before = await db
        .selectFrom('upload_artifacts')
        .select('expires_at')
        .where('id', '=', candidate.artifactId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('import_job_files')
        .set(drift.values)
        .where('id', '=', candidate.fileId)
        .execute();
      await expect(
        repository.acquireMigrationArtifactsForState({
          tenantId,
          organizationId,
          jobId: candidate.jobId,
          artifactIds: [candidate.artifactId],
          targetState: 'preparing',
          transition: true,
          now,
        }),
        drift.label,
      ).rejects.toThrow('MIGRATION_ARTIFACT_NOT_REGISTERED_WITH_JOB');
      await expect(
        repository.findJob(tenantId, organizationId, candidate.jobId),
      ).resolves.toMatchObject({ status: 'pending' });
      await expect(
        db
          .selectFrom('upload_artifacts')
          .select('expires_at')
          .where('id', '=', candidate.artifactId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ expires_at: before.expires_at });
      if (drift.label === 'status') {
        await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
        await expect(
          db
            .selectFrom('upload_artifacts')
            .select('status')
            .where('id', '=', candidate.artifactId)
            .executeTakeFirstOrThrow(),
        ).resolves.toMatchObject({ status: 'retention_hold' });
      }
    }

    const duplicateFile = await fixture({ consumedDaysAgo: 31 });
    const duplicateEvidence = await db
      .selectFrom('import_job_files')
      .select(['object_key', 'original_name', 'media_type', 'byte_size', 'sha256'])
      .where('id', '=', duplicateFile.fileId)
      .executeTakeFirstOrThrow();
    await expect(
      repository.addFile({
        tenantId,
        organizationId,
        jobId: duplicateFile.jobId,
        objectKey: duplicateEvidence.object_key,
        originalName: duplicateEvidence.original_name,
        mediaType: duplicateEvidence.media_type,
        byteSize: Number(duplicateEvidence.byte_size),
        sha256: duplicateEvidence.sha256,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/23505|ER_DUP_ENTRY/u) });
    const crossJob = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'v2',
      mode: 'dry-run',
      idempotencyKey: `cleanup-cross-job-${ulid()}`,
      requestedBy: 'usr_cleanup',
      configuration: {},
    });
    await repository.addFile({
      tenantId,
      organizationId,
      jobId: crossJob.id,
      objectKey: duplicateEvidence.object_key,
      originalName: duplicateEvidence.original_name,
      mediaType: duplicateEvidence.media_type,
      byteSize: Number(duplicateEvidence.byte_size),
      sha256: duplicateEvidence.sha256,
    });
    for (const jobId of [duplicateFile.jobId, crossJob.id]) {
      await expect(
        repository.acquireMigrationArtifactsForState({
          tenantId,
          organizationId,
          jobId,
          artifactIds: [duplicateFile.artifactId],
          targetState: 'preparing',
          transition: true,
          now,
        }),
      ).rejects.toThrow('MIGRATION_ARTIFACT_NOT_REGISTERED_WITH_JOB');
      await expect(repository.findJob(tenantId, organizationId, jobId)).resolves.toMatchObject({
        status: 'pending',
      });
    }
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select('status')
        .where('id', '=', duplicateFile.artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'retention_hold' });

    const linkageDrift = await fixture({ consumedDaysAgo: 31 });
    await db
      .updateTable('import_job_files')
      .set({ sha256: 'f'.repeat(64) })
      .where('id', '=', linkageDrift.fileId)
      .execute();
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select(['status', 'scan_result'])
        .where('id', '=', linkageDrift.artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      status: 'retention_hold',
      scan_result: 'Migration import retention linkage is inconsistent',
    });

    const maximumAge = await fixture({ consumedDaysAgo: 91, jobStatus: 'preparing' });
    const maximumAgeBefore = await db
      .selectFrom('upload_artifacts')
      .select('expires_at')
      .where('id', '=', maximumAge.artifactId)
      .executeTakeFirstOrThrow();
    await expect(
      repository.acquireMigrationArtifactsForState({
        tenantId,
        organizationId,
        jobId: maximumAge.jobId,
        artifactIds: [maximumAge.artifactId],
        targetState: 'preparing',
        transition: true,
        now,
      }),
    ).rejects.toThrow('MIGRATION_ARTIFACT_RETENTION_EXPIRED');
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select('expires_at')
        .where('id', '=', maximumAge.artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ expires_at: maximumAgeBefore.expires_at });
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(1);
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select('status')
        .where('id', '=', maximumAge.artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: 'cleanup_complete' });

    const commitMaximumAge = await fixture({ consumedDaysAgo: 91, jobStatus: 'ready' });
    await expect(
      repository.acquireMigrationArtifactsForState({
        tenantId,
        organizationId,
        jobId: commitMaximumAge.jobId,
        artifactIds: [commitMaximumAge.artifactId],
        targetState: 'committing',
        transition: true,
        now,
      }),
    ).rejects.toThrow('MIGRATION_ARTIFACT_RETENTION_EXPIRED');
    await expect(
      repository.findJob(tenantId, organizationId, commitMaximumAge.jobId),
    ).resolves.toMatchObject({ status: 'ready' });
  });
});
