import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createDb,
  ImportRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from '../../index.js';
import { PortableImportLineageCheckpointsMigration } from '../../migrations/0080_portable_import_lineage_checkpoints.js';

const integrationDriver = process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
const url =
  integrationDriver === 'mysql'
    ? (process.env.DATABASE_URL_MYSQL ?? '')
    : (process.env.DATABASE_URL ?? '');
const describeDatabase = url ? describe.sequential : describe.skip;

describeDatabase(`portable import lineage checkpoints (${integrationDriver})`, () => {
  let db: Database;
  let repository: ImportRepository;
  let tenantId: string;
  let organizationId: string;

  beforeAll(async () => {
    await runMigrations(url);
    db = createDb(url);
    await PortableImportLineageCheckpointsMigration.up!(db);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: 'Lineage tenant' })).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: 'Lineage organization',
        slug: `lineage-${integrationDriver}`,
      })
    ).id;
    repository = new ImportRepository(db);
  });

  afterAll(async () => db?.destroy());

  async function job(sequence: number) {
    return repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v2',
      mode: 'commit',
      idempotencyKey: `lineage:${integrationDriver}:${sequence}`,
      requestedBy: 'lineage-test',
    });
  }

  const scope = () => ({
    tenantId,
    organizationId,
    destinationId: `destination_${integrationDriver}`,
    sourceDeploymentId: 'source_deployment',
    sourceTenantId: 'source_tenant',
    sourceOrganizationId: 'source_organization',
  });

  const migrateDown = () =>
    integrationDriver === 'mysql'
      ? PortableImportLineageCheckpointsMigration.down!(db)
      : db
          .transaction()
          .execute((transaction) =>
            PortableImportLineageCheckpointsMigration.down!(transaction as Database),
          );

  it('requires an activated exact parent and advances one delta at a time', async () => {
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'delta',
        exportSequence: 2,
        parentBundleId: 'bundle_1',
        parentManifestSha256: '1'.repeat(64),
        fromChangeCursor: 'cursor_1',
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_PARENT_NOT_ACTIVATED');

    const fullJob = await job(1);
    await repository.advancePortableImportLineageCheckpoint({
      ...scope(),
      jobId: fullJob.id,
      lineageKind: 'full',
      bundleId: 'bundle_1',
      manifestSha256: '1'.repeat(64),
      changeCursor: 'cursor_1',
      exportSequence: 1,
      activatedAt: new Date('2026-07-12T01:01:00Z'),
    });
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'delta',
        exportSequence: 2,
        parentBundleId: 'bundle_1',
        parentManifestSha256: '1'.repeat(64),
        fromChangeCursor: 'cursor_1',
      }),
    ).resolves.toBeUndefined();
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'delta',
        exportSequence: 2,
        parentBundleId: 'bundle_wrong',
        parentManifestSha256: '1'.repeat(64),
        fromChangeCursor: 'cursor_1',
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_PARENT_NOT_ACTIVATED');

    const firstDeltaJob = await job(2);
    const firstDelta = {
      ...scope(),
      jobId: firstDeltaJob.id,
      lineageKind: 'delta' as const,
      bundleId: 'bundle_2',
      manifestSha256: '2'.repeat(64),
      changeCursor: 'cursor_2',
      exportSequence: 2,
      parentBundleId: 'bundle_1',
      parentManifestSha256: '1'.repeat(64),
      fromChangeCursor: 'cursor_1',
      activatedAt: new Date('2026-07-12T01:02:00Z'),
    };
    await repository.advancePortableImportLineageCheckpoint(firstDelta);
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'delta',
        exportSequence: 10,
        parentBundleId: 'bundle_2',
        parentManifestSha256: '2'.repeat(64),
        fromChangeCursor: 'cursor_2',
      }),
    ).resolves.toBeUndefined();
    const staleSiblingJob = await job(20);
    await expect(
      repository.advancePortableImportLineageCheckpoint({
        ...firstDelta,
        jobId: staleSiblingJob.id,
        bundleId: 'bundle_2_sibling',
        manifestSha256: '3'.repeat(64),
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_STALE');
    const checkpoint = await repository.findPortableImportLineageCheckpoint(scope());
    expect(checkpoint).toMatchObject({
      last_bundle_id: 'bundle_2',
      last_manifest_sha256: '2'.repeat(64),
      last_change_cursor: 'cursor_2',
      last_export_sequence: 2,
      last_import_job_id: firstDeltaJob.id,
    });

    const firstFullRaceJob = await job(30);
    const secondFullRaceJob = await job(31);
    const raceScope = { ...scope(), destinationId: `${scope().destinationId}_race` };
    const activateFirstFull = (jobId: string, bundleId: string) =>
      db.transaction().execute((transaction) =>
        new ImportRepository(transaction as Database).advancePortableImportLineageCheckpoint({
          ...raceScope,
          jobId,
          lineageKind: 'full',
          bundleId,
          manifestSha256: createHash('sha256').update(bundleId).digest('hex'),
          changeCursor: 'race_cursor_1',
          exportSequence: 1,
          activatedAt: new Date('2026-07-12T01:03:00Z'),
        }),
      );
    const race = await Promise.allSettled([
      activateFirstFull(firstFullRaceJob.id, 'bundle_race_1'),
      activateFirstFull(secondFullRaceJob.id, 'bundle_race_2'),
    ]);
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = race.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    expect(
      rejected?.status === 'rejected' &&
        ['PORTABLE_IMPORT_LINEAGE_STALE', 'PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED'].includes(
          rejected.reason instanceof Error ? rejected.reason.message : '',
        ),
    ).toBe(true);
    expect(await repository.findPortableImportLineageCheckpoint(raceScope)).toMatchObject({
      last_export_sequence: 1,
    });

    for (const scopeOverride of [
      { tenantId: `${tenantId}_other` },
      { organizationId: `${organizationId}_other` },
      { destinationId: `${scope().destinationId}_other` },
      { sourceDeploymentId: 'source_deployment_other' },
      { sourceTenantId: 'source_tenant_other' },
      { sourceOrganizationId: 'source_organization_other' },
    ]) {
      await expect(
        repository.assertPortableImportLineageEligible({
          ...scope(),
          ...scopeOverride,
          lineageKind: 'delta',
          exportSequence: 3,
          parentBundleId: 'bundle_2',
          parentManifestSha256: '2'.repeat(64),
          fromChangeCursor: 'cursor_2',
        }),
      ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_PARENT_NOT_ACTIVATED');
    }

    const rebaselineJob = await job(40);
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'full',
        exportSequence: 10,
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED');
    await expect(
      repository.advancePortableImportLineageCheckpoint({
        ...scope(),
        jobId: rebaselineJob.id,
        lineageKind: 'full',
        bundleId: 'bundle_rebaseline',
        manifestSha256: '4'.repeat(64),
        changeCursor: 'cursor_rebaseline',
        exportSequence: 10,
        activatedAt: new Date('2026-07-12T01:04:00Z'),
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_REBASE_REQUIRED');

    const finalDeltaJob = await job(41);
    await repository.advancePortableImportLineageCheckpoint({
      ...scope(),
      jobId: finalDeltaJob.id,
      lineageKind: 'delta',
      bundleId: 'bundle_final',
      manifestSha256: '5'.repeat(64),
      changeCursor: 'cursor_final',
      exportSequence: 10,
      parentBundleId: 'bundle_2',
      parentManifestSha256: '2'.repeat(64),
      fromChangeCursor: 'cursor_2',
      cutoverFrozenAt: new Date('2026-07-12T01:05:00Z'),
      activatedAt: new Date('2026-07-12T01:06:00Z'),
    });
    expect(await repository.findPortableImportLineageCheckpoint(scope())).toMatchObject({
      last_bundle_id: 'bundle_final',
      last_export_sequence: 10,
      cutover_frozen_at: expect.any(Date),
    });
    await expect(
      repository.assertPortableImportLineageEligible({
        ...scope(),
        lineageKind: 'delta',
        exportSequence: 11,
        parentBundleId: 'bundle_final',
        parentManifestSha256: '5'.repeat(64),
        fromChangeCursor: 'cursor_final',
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED');
    const postCutoverJob = await job(42);
    await expect(
      repository.advancePortableImportLineageCheckpoint({
        ...scope(),
        jobId: postCutoverJob.id,
        lineageKind: 'delta',
        bundleId: 'bundle_after_final',
        manifestSha256: '6'.repeat(64),
        changeCursor: 'cursor_after_final',
        exportSequence: 11,
        parentBundleId: 'bundle_final',
        parentManifestSha256: '5'.repeat(64),
        fromChangeCursor: 'cursor_final',
        activatedAt: new Date('2026-07-12T01:07:00Z'),
      }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED');

    await expect(migrateDown()).rejects.toThrow(
      'PORTABLE_IMPORT_LINEAGE_ROLLBACK_REQUIRES_EMPTY_TABLE',
    );
    await db.deleteFrom('portable_import_lineage_checkpoints').execute();
    await migrateDown();
    await PortableImportLineageCheckpointsMigration.up!(db);
    await PortableImportLineageCheckpointsMigration.up!(db);
  });
});
