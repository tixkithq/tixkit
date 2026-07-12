import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, runMigrations, truncateAllData } from '../../migrate.js';
import { PortableExportBuildLeasesMigration } from '../../migrations/0069_portable_export_build_leases.js';
import {
  OrganizationRepository,
  PortableExportRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const cases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (item) => item.url && (!requestedDriver || item.driver === requestedDriver),
) as DriverCase[];
if (cases.length === 0)
  it.skip('portable export repository integration (database URLs not configured)', () => {});

describe.sequential.each(cases)('portable export evidence: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (
      await new TenantRepository(db).create({
        name: `Portable export ${driver}`,
      })
    ).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Portable export ${driver}`,
        slug: `portable-export-${driver}`,
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  const input = (idempotencyKey: string, requestFingerprint = '1'.repeat(64)) => ({
    tenantId,
    organizationId,
    requestedBy: 'user_exporter',
    idempotencyKey,
    requestFingerprint,
  });

  it('allocates monotonic scoped sequences and converges concurrent idempotent starts', async () => {
    const repository = new PortableExportRepository(db);
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) => repository.begin(input(`unique-${index}`))),
    );
    expect(concurrent.map((job) => Number(job.export_sequence)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_, index) => index + 1),
    );
    expect(new Set(concurrent.map(({ bundle_id: bundleId }) => bundleId)).size).toBe(8);

    const replays = await Promise.all(
      Array.from({ length: 8 }, () => repository.begin(input('same-request'))),
    );
    expect(new Set(replays.map(({ id }) => id))).toEqual(new Set([replays[0]!.id]));
    expect(Number(replays[0]!.export_sequence)).toBe(9);
    const afterReplay = await repository.begin(input('after-same-request'));
    expect(Number(afterReplay.export_sequence)).toBe(10);
    await expect(repository.begin(input('same-request', '2'.repeat(64)))).rejects.toThrow(
      /IDEMPOTENCY_CONFLICT/u,
    );
  });

  it('records immutable exact artifact evidence and rejects conflicting completion', async () => {
    const repository = new PortableExportRepository(db);
    const job = await repository.begin(input('complete-request'));
    const ownerSha256 = 'd'.repeat(64);
    const now = new Date();
    await expect(
      repository.claimBuild({
        tenantId,
        organizationId,
        jobId: job.id,
        ownerSha256,
        now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe(true);
    await repository.recordSnapshotCursor({
      tenantId,
      organizationId,
      jobId: job.id,
      ownerSha256,
      sourceChangeCursor: `snapshot-sha256:${'e'.repeat(64)}`,
      now,
    });
    const completion = {
      tenantId,
      organizationId,
      jobId: job.id,
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      artifactBytes: 1234,
      ownerSha256,
    };
    await repository.complete(completion);
    await expect(repository.complete(completion)).resolves.toBeUndefined();
    await expect(
      repository.complete({ ...completion, artifactSha256: 'c'.repeat(64) }),
    ).rejects.toThrow(/COMPLETION_CONFLICT/u);
    const persisted = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(persisted).toMatchObject({
      status: 'completed',
      manifest_sha256: completion.manifestSha256,
      artifact_sha256: completion.artifactSha256,
    });
    expect(Number(persisted.artifact_bytes)).toBe(completion.artifactBytes);
    const event = await db
      .selectFrom('portable_export_events')
      .selectAll()
      .where('export_job_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      manifest_sha256: completion.manifestSha256,
      artifact_sha256: completion.artifactSha256,
    });
    await expect(
      db
        .updateTable('portable_export_events')
        .set({ artifact_sha256: 'c'.repeat(64) })
        .where('id', '=', event.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.deleteFrom('portable_export_events').where('id', '=', event.id).execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(repository.complete({ ...completion, artifactBytes: 0 })).rejects.toThrow(
      /COMPLETION_INVALID/u,
    );
    await expect(
      repository.complete({
        ...completion,
        artifactBytes: 50 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(/COMPLETION_INVALID/u);
    await expect(
      repository.complete({ ...completion, manifestSha256: 'not-a-digest' }),
    ).rejects.toThrow(/COMPLETION_INVALID/u);
  });

  it('fences concurrent and expired build owners from snapshot and completion evidence', async () => {
    const repository = new PortableExportRepository(db);
    const job = await repository.begin(input('lease-fencing-request'));
    const firstOwner = '1'.repeat(64);
    const secondOwner = '2'.repeat(64);
    const now = new Date();
    await expect(
      repository.claimBuild({
        tenantId,
        organizationId,
        jobId: job.id,
        ownerSha256: firstOwner,
        now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claimBuild({
        tenantId,
        organizationId,
        jobId: job.id,
        ownerSha256: secondOwner,
        now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toBe(false);
    await repository.recordSnapshotCursor({
      tenantId,
      organizationId,
      jobId: job.id,
      ownerSha256: firstOwner,
      sourceChangeCursor: `snapshot-sha256:${'3'.repeat(64)}`,
      now,
    });
    await db
      .updateTable('portable_export_jobs')
      .set({ build_lease_expires_at: new Date(0) })
      .where('id', '=', job.id)
      .execute();
    await expect(
      repository.claimBuild({
        tenantId,
        organizationId,
        jobId: job.id,
        ownerSha256: secondOwner,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).resolves.toBe(true);
    const completion = {
      tenantId,
      organizationId,
      jobId: job.id,
      manifestSha256: '4'.repeat(64),
      artifactSha256: '5'.repeat(64),
      artifactBytes: 42,
    };
    await expect(repository.complete({ ...completion, ownerSha256: firstOwner })).rejects.toThrow(
      /COMPLETION_CONFLICT/u,
    );
    await repository.recordSnapshotCursor({
      tenantId,
      organizationId,
      jobId: job.id,
      ownerSha256: secondOwner,
      sourceChangeCursor: `snapshot-sha256:${'6'.repeat(64)}`,
      now: new Date(),
    });
    await expect(
      repository.complete({ ...completion, ownerSha256: secondOwner }),
    ).resolves.toBeUndefined();
  });

  it('fails closed on malformed requests and scopes sequences by organization', async () => {
    const repository = new PortableExportRepository(db);
    await expect(repository.begin(input('', 'bad'))).rejects.toThrow(/REQUEST_INVALID/u);
    const otherOrganization = await new OrganizationRepository(db).create({
      tenantId,
      name: `Other portable export ${driver}`,
      slug: `other-portable-export-${driver}`,
    });
    const other = await repository.begin({
      ...input('other-scope'),
      organizationId: otherOrganization.id,
    });
    expect(Number(other.export_sequence)).toBe(1);
    const otherTenant = await new TenantRepository(db).create({
      name: `Other tenant ${driver}`,
    });
    await expect(
      db
        .insertInto('portable_export_sequences')
        .values({
          tenant_id: otherTenant.id,
          organization_id: organizationId,
          next_sequence: 1,
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rolls 0069 down to the seeded 0068 shape and reapplies it without losing evidence', async () => {
    const before = await db
      .selectFrom('portable_export_events')
      .select(['export_job_id', 'artifact_sha256'])
      .execute();
    await PortableExportBuildLeasesMigration.down!(db);
    await expect(
      db.selectFrom('portable_export_jobs').select('build_owner_sha256').limit(1).execute(),
    ).rejects.toThrow();
    await PortableExportBuildLeasesMigration.down!(db);
    await PortableExportBuildLeasesMigration.up(db);
    await PortableExportBuildLeasesMigration.up(db);
    const after = await db
      .selectFrom('portable_export_events')
      .select(['export_job_id', 'artifact_sha256', 'bundle_id', 'source_change_cursor'])
      .execute();
    expect(
      after.map(({ export_job_id: jobId, artifact_sha256: digest }) => [jobId, digest]),
    ).toEqual(before.map(({ export_job_id: jobId, artifact_sha256: digest }) => [jobId, digest]));
    expect(after.every(({ bundle_id: bundleId }) => Boolean(bundleId))).toBe(true);
    expect(after.every(({ source_change_cursor: cursor }) => Boolean(cursor))).toBe(true);
  });

  it('can reset and migrate PostgreSQL repeatedly without leaked trigger functions', async () => {
    if (driver !== 'postgres') return;
    await dropAllTables(db);
    await runMigrations(url);
    await dropAllTables(db);
    await runMigrations(url);
  });
});
