import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDb, TenantRepository, type Database } from '@tixkit/db';
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

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const suffix = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({ name: `Upload cleanup ${suffix}` });
    tenantId = tenant.id;
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
});
