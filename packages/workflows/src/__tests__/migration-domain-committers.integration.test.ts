import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  createDb,
  BrandRepository,
  EventRepository,
  ImportRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import {
  eventbriteApiV3Fixture,
  GenericCsvMigrationAdapter,
  SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
  SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
  ticketTailorApiV1Fixture,
  migrationAdapter,
  prepareTixkitPortableUpload,
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  portableSectionForMigrationEntity,
  sortEntitiesByDependency,
  TixkitPortableMigrationAdapter,
  type MigrationAdapter,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import {
  buildPortableLogicalExport,
  createPortableConfigurationPayloadPolicies,
  portableManifestSha256,
  scanPortablePayload,
  signPortableManifest,
  type PortableBundleManifest,
} from '@tixkit/portability';
import { MIGRATION_COMMIT_STAGES, MIGRATION_SIDE_EFFECT_POLICY } from '../activities/migration.js';
import {
  createProductionMigrationCommitters,
  processMigrationMediaCleanupJobs,
  type MigrationMediaObjectStore,
  type MigrationPortableAssetResolver,
} from '../activities/migration-domain-committers.js';
import {
  createRepositoryMigrationActivityService,
  portableReconciliationReport,
} from '../activities/migration-repository-service.js';
import { createMigrationPreparationService } from '../activities/migration-preparation.js';
import {
  loadPortableConfigurationSections,
  loadPortableHistoricalSections,
} from '../activities/portable-export.js';

const integrationDriver = process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
const url =
  integrationDriver === 'mysql'
    ? (process.env.DATABASE_URL_MYSQL ?? '')
    : (process.env.DATABASE_URL ?? '');
const describeDatabase = url ? describe.sequential : describe.skip;

const attributes: Record<MigrationEntityType, Record<string, unknown>> = {
  organization: {
    name: 'Imported organization',
    slug: 'imported-organization',
    status: 'active',
    boxOfficeSettings: {
      enabled: true,
      allowedTenderTypes: ['cash', 'manual_card'],
      requireBuyerEmail: true,
      receiptMode: 'email',
    },
    eventDefaults: { timezone: 'America/Chicago' },
  },
  brand: {
    name: 'Imported brand',
    slug: 'imported-brand',
    status: 'active',
    theme: { primaryColor: '#123456' },
    supportUrl: 'https://support.example.test',
    legalUrls: { privacy: 'https://example.test/privacy' },
    whiteLabel: true,
  },
  venue: { name: 'Imported venue', address: '123 Main St', timezone: 'America/Chicago' },
  event: {
    title: 'Imported event',
    currency: 'USD',
    timezone: 'America/Chicago',
    slug: 'imported-event',
    description: 'Portable event description',
    status: 'published',
    startsAt: '2026-10-01T18:00:00Z',
    endsAt: '2026-10-01T22:00:00Z',
    visibility: 'public',
    capacity: 321,
    minimumAge: 18,
    codeFormat: { symbology: 'qr', payloadFormat: 'compact_v2' },
  },
  occurrence: {
    startsAt: '2026-10-01T18:00:00Z',
    endsAt: '2026-10-01T20:00:00Z',
    timezone: 'America/Chicago',
    title: 'Evening session',
    capacity: 200,
    status: 'active',
    sortOrder: 7,
  },
  'inventory-pool': { name: 'General', totalCapacity: 100, holdTtlSeconds: 1200 },
  'ticket-type': {
    name: 'General admission',
    currency: 'USD',
    priceMinor: 2500,
    description: 'Portable admission',
    kind: 'paid',
    status: 'active',
    visibility: 'visible',
    minimumPriceMinor: 1500,
    salesStartAt: '2026-01-01T00:00:00Z',
    salesEndAt: '2026-09-30T00:00:00Z',
    minPerOrder: 2,
    maxPerOrder: 8,
    sortOrder: 4,
    requiresAccessCode: true,
  },
  product: {
    name: 'Poster',
    description: 'Limited poster',
    currency: 'USD',
    priceMinor: 1000,
    maxPerOrder: 3,
    availableFrom: '2026-01-01T00:00:00Z',
    availableUntil: '2026-10-01T00:00:00Z',
    status: 'active',
    sortOrder: 5,
  },
  question: {
    label: 'Dietary requirements',
    type: 'select',
    description: 'Choose one',
    required: true,
    appliesTo: 'attendee',
    options: ['vegan', 'none'],
    placeholder: 'Choose',
    sortOrder: 6,
    isConsentField: true,
    consentText: 'I consent',
    consentVersion: 'v2',
  },
  discount: {
    code: 'SAVE10',
    type: 'percentage',
    value: 10,
    currency: 'USD',
    maxUses: 25,
    validFrom: '2026-01-01T00:00:00Z',
    validUntil: '2026-09-30T00:00:00Z',
    minOrderMinor: 2000,
    maxDiscountMinor: 5000,
    status: 'active',
  },
  'access-code': { code: 'LOCKED', type: 'code', maxUses: 5, expiresAt: '2026-09-30T00:00:00Z' },
  buyer: { email: 'buyer@example.test' },
  attendee: { email: 'attendee@example.test' },
  'historical-order': {
    orderNumber: 'OLD-1',
    currency: 'USD',
    totalMinor: 2500,
    buyerEmail: 'buyer@example.test',
  },
  ticket: { code: 'OLD-TICKET-1' },
  'historical-payment': {},
  'historical-refund': {},
  'check-in': { occurredAt: '2026-10-01T18:30:00Z' },
};

function entity(type: MigrationEntityType, index: number): NormalizedMigrationEntity {
  const financialSnapshot =
    type === 'historical-payment' || type === 'historical-refund'
      ? {
          kind: type,
          amountMinor: type === 'historical-payment' ? 2500 : 500,
          currency: 'USD',
          occurredAt: '2026-10-01T18:00:00Z',
          provenance: {
            sourceSystem: 'generic-csv',
            sourceExternalId: `${type}-1`,
            importedAt: '2026-10-02T00:00:00Z',
          },
          reconciliationStatus: 'unreconciled' as const,
          sideEffects: 'suppressed' as const,
        }
      : undefined;
  return {
    entityType: type,
    externalId: `${type}-1`,
    sourcePosition: `fixture:${index + 1}`,
    attributes: attributes[type],
    dependencies: MIGRATION_ENTITY_DEPENDENCY_ORDER.slice(0, index).map((entityType) => ({
      entityType,
      externalId: `${entityType}-1`,
    })),
    ...(financialSnapshot ? { financialSnapshot } : {}),
  };
}

describeDatabase('production migration committers', () => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;
  let brandId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER = integrationDriver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (
      await new TenantRepository(db).create({
        name: 'Migration committer test',
      })
    ).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: 'Migration organization',
        slug: 'migration-organization',
      })
    ).id;
    brandId = (
      await new BrandRepository(db).create({
        tenantId,
        organizationId,
        name: 'Existing migration target brand',
        slug: 'existing-migration-target-brand',
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  it('persists verified portable event media through the destination object store', async () => {
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: `portable-media-${integrationDriver}`,
      requestedBy: 'test-user',
    });
    await repository.recordExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      entityType: 'brand',
      externalId: 'source_brand_media',
      tixkitId: brandId,
      importJobId: job.id,
      createdByJob: false,
    });
    const mediaBytes = await sharp(randomBytes(1200 * 800 * 3), {
      raw: { width: 1200, height: 800, channels: 3 },
    })
      .webp()
      .toBuffer();
    expect(mediaBytes.byteLength).toBeGreaterThan(64 * 1024);
    const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
    const writes: Array<{ objectKey: string; sha256: string; bytes: Uint8Array }> = [];
    const deletedKeys: string[] = [];
    const mediaStore: MigrationMediaObjectStore = {
      bucket: 'destination-media',
      async putVerified(input) {
        writes.push({
          objectKey: input.objectKey,
          sha256: input.sha256,
          bytes: Uint8Array.from(input.bytes),
        });
      },
      async verify(input) {
        const stored = writes.find(({ objectKey }) => objectKey === input.objectKey);
        if (
          !stored ||
          stored.bytes.byteLength !== input.bytes ||
          stored.sha256 !== input.sha256 ||
          createHash('sha256').update(stored.bytes).digest('hex') !== input.sha256
        )
          throw new Error('test media object verification failed');
      },
      async delete(objectKey) {
        deletedKeys.push(objectKey);
      },
    };
    const resolvedAssets = new Map([[sha256, mediaBytes]]);
    const resolver: MigrationPortableAssetResolver = {
      async resolve(input) {
        const bytes = resolvedAssets.get(input.sha256);
        if (!bytes) throw new Error('test asset missing');
        expect(input).toMatchObject({ portableId: 'source_media_cover', mediaType: 'image/webp' });
        expect(input.bytes).toBe(bytes.byteLength);
        return bytes;
      },
    };
    const committer = createProductionMigrationCommitters(db, mediaStore, resolver).get('event')!;
    const portableEvent = (asset: { bytes: Buffer; sha256: string; altText: string }) => ({
      entityType: 'event' as const,
      externalId: 'source_event_media',
      sourcePosition: 'data/events.jsonl:1',
      dependencies: [{ entityType: 'brand' as const, externalId: 'source_brand_media' }],
      attributes: {
        title: 'Imported media event',
        slug: `imported-media-${integrationDriver}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-01-01T00:00:00.000Z',
        mediaAssets: [
          {
            portableId: 'source_media_cover',
            role: 'cover',
            altText: asset.altText,
            focalPoint: { x: 0.5, y: 0.4 },
            sha256: asset.sha256,
            bytes: asset.bytes.byteLength,
            mediaType: 'image/webp',
            width: 1200,
            height: 800,
          },
        ],
      },
    });
    const initialEntity = portableEvent({
      bytes: mediaBytes,
      sha256,
      altText: 'Imported purple cover',
    });
    const outcome = await committer.commit({
      tenantId,
      organizationId,
      jobId: job.id,
      entity: initialEntity,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(outcome.disposition).toBe('created');
    await repository.recordExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      entityType: 'event',
      externalId: initialEntity.externalId,
      tixkitId: outcome.tixkitId!,
      importJobId: job.id,
      createdByJob: true,
    });
    await expect(
      committer.assessReconciled({
        tenantId,
        organizationId,
        jobId: job.id,
        tixkitId: outcome.tixkitId!,
        externalId: initialEntity.externalId,
        entity: initialEntity,
      }),
    ).resolves.toEqual({ reconciled: true });
    expect(writes).toEqual([
      expect.objectContaining({ sha256, bytes: Uint8Array.from(mediaBytes) }),
    ]);
    const asset = await db
      .selectFrom('event_media_assets')
      .innerJoin(
        'event_media_renditions as rendition',
        'rendition.asset_id',
        'event_media_assets.id',
      )
      .select([
        'event_media_assets.event_id',
        'event_media_assets.role',
        'event_media_assets.alt_text',
        'rendition.checksum_sha256',
      ])
      .where('event_media_assets.event_id', '=', outcome.tixkitId!)
      .executeTakeFirstOrThrow();
    expect(asset).toMatchObject({
      event_id: outcome.tixkitId,
      role: 'cover',
      alt_text: 'Imported purple cover',
      checksum_sha256: sha256,
    });
    const provenance = await db
      .selectFrom('imported_domain_entities')
      .select('attributes')
      .where('id', '=', outcome.tixkitId!)
      .executeTakeFirstOrThrow();
    expect(provenance.attributes.length).toBeLessThan(4_000);
    expect(provenance.attributes).not.toContain(mediaBytes.toString('base64').slice(0, 100));

    const replacementBytes = await sharp(randomBytes(1200 * 800 * 3), {
      raw: { width: 1200, height: 800, channels: 3 },
    })
      .webp()
      .toBuffer();
    const replacementSha256 = createHash('sha256').update(replacementBytes).digest('hex');
    resolvedAssets.set(replacementSha256, replacementBytes);
    const updated = await committer.commit({
      tenantId,
      organizationId,
      jobId: job.id,
      entity: portableEvent({
        bytes: replacementBytes,
        sha256: replacementSha256,
        altText: 'Updated portable cover',
      }),
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(updated.disposition).toBe('updated');
    const updatedEntity = portableEvent({
      bytes: replacementBytes,
      sha256: replacementSha256,
      altText: 'Updated portable cover',
    });
    const reconciliationInput = {
      tenantId,
      organizationId,
      jobId: job.id,
      tixkitId: updated.tixkitId!,
      externalId: updatedEntity.externalId,
      entity: updatedEntity,
    };
    await expect(committer.assessReconciled(reconciliationInput)).resolves.toEqual({
      reconciled: true,
    });
    const replacementWrite = writes.find(
      ({ sha256: candidate }) => candidate === replacementSha256,
    )!;
    const originalByte = replacementWrite.bytes[0]!;
    replacementWrite.bytes[0] = originalByte ^ 0xff;
    await expect(committer.assessReconciled(reconciliationInput)).resolves.toMatchObject({
      reconciled: false,
      reason: 'test media object verification failed',
    });
    replacementWrite.bytes[0] = originalByte;
    const rendition = await db
      .selectFrom('event_media_renditions')
      .selectAll()
      .where('checksum_sha256', '=', replacementSha256)
      .executeTakeFirstOrThrow();
    await db.deleteFrom('event_media_renditions').where('id', '=', rendition.id).execute();
    await expect(committer.assessReconciled(reconciliationInput)).resolves.toMatchObject({
      reconciled: false,
      reason: 'Canonical entity differs from the committed import evidence',
    });
    await db.insertInto('event_media_renditions').values(rendition).execute();
    await expect(committer.assessReconciled(reconciliationInput)).resolves.toEqual({
      reconciled: true,
    });
    await expect(
      committer.commit({
        tenantId,
        organizationId,
        jobId: job.id,
        entity: updatedEntity,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).resolves.toMatchObject({ disposition: 'skipped', tixkitId: updated.tixkitId });
    await expect(committer.assessReconciled(reconciliationInput)).resolves.toEqual({
      reconciled: true,
    });
    await expect(
      processMigrationMediaCleanupJobs(db, mediaStore, new Date(Date.now() + 1_000)),
    ).resolves.toEqual({
      completed: 1,
      retained: 0,
      failed: 0,
    });
    expect(deletedKeys).toEqual([expect.stringContaining(sha256)]);
  });

  it('durably retries media cleanup when storage succeeds and the database commit fails', async () => {
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: `portable-media-failure-${integrationDriver}`,
      requestedBy: 'test-user',
    });
    await repository.recordExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      entityType: 'brand',
      externalId: 'source_brand_media_failure',
      tixkitId: brandId,
      importJobId: job.id,
      createdByJob: false,
    });
    const mediaBytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#dc2626' },
    })
      .webp()
      .toBuffer();
    const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
    const portableId = 'source_media_failure';
    const identity = createHash('sha256')
      .update(`${tenantId}:${portableId}`)
      .digest('hex')
      .slice(0, 26);
    const collisionEvent = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `media-collision-${integrationDriver}`,
      title: 'Collision event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T00:00:00Z'),
    });
    const now = new Date();
    await db
      .insertInto('upload_artifacts')
      .values({
        id: `upl_${identity}`,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: collisionEvent.id,
        created_by_user_id: null,
        purpose: 'event_cover',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'collision fixture',
        bucket: 'destination-media',
        object_key: `event-media/${collisionEvent.id}/collision.webp`,
        file_name: 'collision.webp',
        content_type: 'image/webp',
        size_bytes: 1,
        checksum_sha256: 'f'.repeat(64),
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('2028-01-01T00:00:00Z'),
        created_at: now,
        updated_at: now,
      })
      .execute();
    let failDelete = true;
    const deleted: string[] = [];
    const store: MigrationMediaObjectStore = {
      bucket: 'destination-media',
      async putVerified() {},
      async verify() {},
      async delete(objectKey) {
        if (failDelete) throw new Error('simulated cleanup outage');
        deleted.push(objectKey);
      },
    };
    const resolver: MigrationPortableAssetResolver = {
      async resolve() {
        return mediaBytes;
      },
    };
    await expect(
      createProductionMigrationCommitters(db, store, resolver)
        .get('event')!
        .commit({
          tenantId,
          organizationId,
          jobId: job.id,
          entity: {
            entityType: 'event',
            externalId: 'source_event_media_failure',
            sourcePosition: 'data/events.jsonl:1',
            dependencies: [{ entityType: 'brand', externalId: 'source_brand_media_failure' }],
            attributes: {
              title: 'Failed media event',
              slug: `failed-media-${integrationDriver}`,
              currency: 'USD',
              timezone: 'UTC',
              startsAt: '2027-01-01T00:00:00.000Z',
              mediaAssets: [
                {
                  portableId,
                  role: 'cover',
                  altText: 'Failure fixture',
                  focalPoint: { x: 0.5, y: 0.5 },
                  sha256,
                  bytes: mediaBytes.byteLength,
                  mediaType: 'image/webp',
                  width: 100,
                  height: 100,
                },
              ],
            },
          },
          sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
        }),
    ).rejects.toThrow();
    const cleanup = await db
      .selectFrom('media_object_cleanup_jobs')
      .selectAll()
      .where('reason', '=', 'portable-media-commit-failed')
      .executeTakeFirstOrThrow();
    expect(cleanup.status).toBe('pending');
    await expect(
      processMigrationMediaCleanupJobs(db, store, new Date(Date.now() + 1_000)),
    ).resolves.toEqual({ completed: 0, retained: 0, failed: 1 });
    failDelete = false;
    await expect(
      processMigrationMediaCleanupJobs(db, store, new Date(Date.now() + 3 * 60_000)),
    ).resolves.toEqual({ completed: 1, retained: 0, failed: 0 });
    expect(deleted).toEqual([expect.stringContaining(sha256)]);
  });

  async function importChain(idempotencyKey: string) {
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey,
      requestedBy: 'test-user',
    });
    const entities = MIGRATION_ENTITY_DEPENDENCY_ORDER.map(entity);
    await repository.addRows(
      tenantId,
      organizationId,
      job.id,
      entities.map((normalized, index) => ({
        entityType: normalized.entityType,
        externalId: normalized.externalId,
        rowNumber: index + 1,
        sourceData: normalized.attributes,
        normalizedData: normalized,
        status: 'validated',
      })),
    );
    await repository.transitionJob({
      tenantId,
      organizationId,
      jobId: job.id,
      from: ['pending'],
      to: 'ready',
    });
    const service = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const context = {
      tenantId,
      organizationId,
      jobId: job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    await service.beginCommit(context);
    let processed = 0;
    for (const [stageIndex, stage] of MIGRATION_COMMIT_STAGES.entries()) {
      const stageInput = {
        stage,
        claimOwner: `test-owner:${stage}`,
        chunkSize: 100,
      };
      const result = await service.processStage(context, stageInput);
      await expect(service.processStage(context, stageInput)).resolves.toEqual(result);
      processed += result.processed;
      await service.recordProgress(context, {
        stage,
        stageIndex,
        stageCount: MIGRATION_COMMIT_STAGES.length,
        processed,
        created: processed,
        updated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
      });
    }
    await service.reconcile(context);
    await service.completeCommit(context);
    return job;
  }

  let singleOrganizationJobSequence = 0;
  async function createSingleOrganizationJob(
    idempotencyKey: string,
    externalId: string,
    rowCount = 1,
  ) {
    singleOrganizationJobSequence += 1;
    const scopedTenantId = (
      await new TenantRepository(db).create({
        name: `Row ledger tenant ${singleOrganizationJobSequence}`,
      })
    ).id;
    const scopedOrganizationId = (
      await new OrganizationRepository(db).create({
        tenantId: scopedTenantId,
        name: `Row ledger organization ${singleOrganizationJobSequence}`,
        slug: `row-ledger-${integrationDriver}-${singleOrganizationJobSequence}`,
      })
    ).id;
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId: scopedTenantId,
      organizationId: scopedOrganizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey,
      requestedBy: 'test-user',
    });
    const normalized = Array.from({ length: rowCount }, (_, index) => ({
      ...entity('organization', index),
      externalId: `${externalId}-${index + 1}`,
      dependencies: [],
      attributes: {
        ...attributes.organization,
        name: `Recovered organization ${externalId} ${index + 1}`,
        slug: `recovered-${externalId}-${index + 1}`,
      },
    }));
    await repository.addRows(
      scopedTenantId,
      scopedOrganizationId,
      job.id,
      normalized.map((row, index) => ({
        entityType: row.entityType,
        externalId: row.externalId,
        rowNumber: index + 1,
        sourceData: row.attributes,
        normalizedData: row,
        status: 'validated',
      })),
    );
    await repository.transitionJob({
      tenantId: scopedTenantId,
      organizationId: scopedOrganizationId,
      jobId: job.id,
      from: ['pending'],
      to: 'ready',
    });
    return { job, tenantId: scopedTenantId, organizationId: scopedOrganizationId };
  }

  it('reconstructs a completed chunk after row persistence but before the chunk checkpoint', async () => {
    const repository = new ImportRepository(db);
    const claimOwner = `row-ledger-recovery:${integrationDriver}`;
    const scoped = await createSingleOrganizationJob(
      `row-ledger-recovery:${integrationDriver}`,
      `row-ledger-recovery-${integrationDriver}`,
    );
    const context = {
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    const stageInput = {
      stage: MIGRATION_COMMIT_STAGES[0]!,
      claimOwner,
      chunkSize: 1,
    };
    const crashingService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      undefined,
      {
        afterRowCompletion() {
          throw new Error('SIMULATED_PROCESS_EXIT_BEFORE_CHUNK_CHECKPOINT');
        },
      },
    );
    await crashingService.beginCommit(context);
    await expect(crashingService.processStage(context, stageInput)).rejects.toThrow(
      'SIMULATED_PROCESS_EXIT_BEFORE_CHUNK_CHECKPOINT',
    );
    const beforeRecovery = await repository.listEvents(
      scoped.tenantId,
      scoped.organizationId,
      scoped.job.id,
    );
    expect(
      beforeRecovery.filter((event) => event.type === 'commit.stage.row.completed'),
    ).toHaveLength(1);
    expect(beforeRecovery.filter((event) => event.type === 'commit.stage.completed')).toHaveLength(
      0,
    );

    const recoveryService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const recovered = await recoveryService.processStage(context, stageInput);
    expect(recovered).toEqual({
      processed: 1,
      created: 0,
      updated: 1,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      complete: false,
      nextCursor: expect.any(String),
    });
    const afterRecovery = await repository.listEvents(
      scoped.tenantId,
      scoped.organizationId,
      scoped.job.id,
    );
    expect(afterRecovery.filter((event) => event.type === 'commit.stage.completed')).toHaveLength(
      1,
    );
    expect(JSON.stringify(afterRecovery)).not.toContain(claimOwner);
    const rowLedger = afterRecovery.find((event) => event.type === 'commit.stage.row.completed')!;
    await expect(
      repository.appendIdempotentEvent({
        tenantId: scoped.tenantId,
        organizationId: scoped.organizationId,
        jobId: scoped.job.id,
        eventKey: rowLedger.event_key,
        type: rowLedger.type,
        severity: rowLedger.severity as 'info',
        message: rowLedger.message,
        data: { tampered: true },
      }),
    ).rejects.toThrow('IMPORT_EVENT_IDEMPOTENCY_CONFLICT');

    const secondScope = await createSingleOrganizationJob(
      `row-ledger-scope:${integrationDriver}`,
      `row-ledger-scope-${integrationDriver}`,
    );
    const secondContext = {
      ...context,
      tenantId: secondScope.tenantId,
      organizationId: secondScope.organizationId,
      jobId: secondScope.job.id,
    };
    await recoveryService.beginCommit(secondContext);
    await expect(recoveryService.processStage(secondContext, stageInput)).resolves.toMatchObject({
      processed: 1,
      updated: 1,
    });
  });

  it('does not report a stage complete while the same logical chunk is still active', async () => {
    const scoped = await createSingleOrganizationJob(
      `row-ledger-overlap:${integrationDriver}`,
      `row-ledger-overlap-${integrationDriver}`,
    );
    const productionCommitters = createProductionMigrationCommitters(db);
    const organizationCommitter = productionCommitters.get('organization')!;
    let releaseCommit!: () => void;
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const committers = new Map(productionCommitters);
    committers.set('organization', {
      assessReconciled: (input) => organizationCommitter.assessReconciled(input),
      assessUntouched: (input) => organizationCommitter.assessUntouched(input),
      deleteUntouched: (input) => organizationCommitter.deleteUntouched(input),
      async commit(input) {
        markCommitStarted();
        await commitReleased;
        return organizationCommitter.commit(input);
      },
    });
    const service = createRepositoryMigrationActivityService(db, committers);
    const context = {
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    const stageInput = {
      stage: MIGRATION_COMMIT_STAGES[0]!,
      claimOwner: `row-ledger-overlap:${integrationDriver}`,
      chunkSize: 1,
    };
    await service.beginCommit(context);
    const first = service.processStage(context, stageInput);
    await commitStarted;
    await expect(service.processStage(context, stageInput)).rejects.toThrow(
      'MIGRATION_STAGE_CLAIM_IN_PROGRESS',
    );
    releaseCommit();
    await expect(first).resolves.toMatchObject({ processed: 1, updated: 1 });
  });

  it('reclaims an expired chunk when the worker exits before completing its first row', async () => {
    const scoped = await createSingleOrganizationJob(
      `row-ledger-before-first:${integrationDriver}`,
      `row-ledger-before-first-${integrationDriver}`,
    );
    const context = {
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    const stageInput = {
      stage: MIGRATION_COMMIT_STAGES[0]!,
      claimOwner: `row-ledger-before-first:${integrationDriver}`,
      chunkSize: 1,
    };
    const crashingService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      undefined,
      {
        claimLeaseMs: 1_100,
        afterRowsClaimed() {
          throw new Error('SIMULATED_PROCESS_EXIT_BEFORE_FIRST_ROW');
        },
      },
    );
    await crashingService.beginCommit(context);
    await expect(crashingService.processStage(context, stageInput)).rejects.toThrow(
      'SIMULATED_PROCESS_EXIT_BEFORE_FIRST_ROW',
    );
    await db
      .updateTable('import_job_rows')
      .set({ claim_expires_at: new Date(Date.now() - 1_000) })
      .where('tenant_id', '=', scoped.tenantId)
      .where('organization_id', '=', scoped.organizationId)
      .where('import_job_id', '=', scoped.job.id)
      .where('claim_owner', '=', stageInput.claimOwner)
      .execute();
    const recoveryService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      undefined,
      { claimLeaseMs: 1_100 },
    );
    await expect(recoveryService.processStage(context, stageInput)).resolves.toMatchObject({
      processed: 1,
      updated: 1,
    });
  });

  it('reconstructs a partial multi-row ledger after the remaining claim expires', async () => {
    const scoped = await createSingleOrganizationJob(
      `row-ledger-partial:${integrationDriver}`,
      `row-ledger-partial-${integrationDriver}`,
      3,
    );
    const context = {
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    };
    const stageInput = {
      stage: MIGRATION_COMMIT_STAGES[0]!,
      claimOwner: `row-ledger-partial:${integrationDriver}`,
      chunkSize: 2,
    };
    let completedRows = 0;
    const crashingService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      undefined,
      {
        claimLeaseMs: 1_100,
        afterRowCompletion() {
          completedRows += 1;
          if (completedRows === 1) throw new Error('SIMULATED_PROCESS_EXIT_AFTER_FIRST_ROW');
        },
      },
    );
    await crashingService.beginCommit(context);
    await expect(crashingService.processStage(context, stageInput)).rejects.toThrow(
      'SIMULATED_PROCESS_EXIT_AFTER_FIRST_ROW',
    );
    await db
      .updateTable('import_job_rows')
      .set({ claim_expires_at: new Date(Date.now() - 1_000) })
      .where('tenant_id', '=', scoped.tenantId)
      .where('organization_id', '=', scoped.organizationId)
      .where('import_job_id', '=', scoped.job.id)
      .where('claim_owner', '=', stageInput.claimOwner)
      .execute();
    const repository = new ImportRepository(db);
    const rowsBeforeRecovery = await repository.listRows({
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      limit: 10,
    });
    expect(rowsBeforeRecovery.map((row) => row.status)).toEqual([
      'updated',
      'committing',
      'validated',
    ]);
    await expect(
      repository.releaseExpiredClaimsByOwner({
        tenantId: scoped.tenantId,
        organizationId: scoped.organizationId,
        jobId: scoped.job.id,
        claimedStatus: 'committing',
        returnToStatus: 'validated',
        ownerToken: stageInput.claimOwner,
        now: new Date(),
      }),
    ).resolves.toBe(1);
    await repository.claimRowsByIds({
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      rowIds: [rowsBeforeRecovery[1]!.id],
      fromStatus: 'validated',
      claimStatus: 'committing',
      ownerToken: `competing-owner:${integrationDriver}`,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    const recoveryService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      undefined,
      { claimLeaseMs: 1_100 },
    );
    await expect(recoveryService.processStage(context, stageInput)).rejects.toThrow(
      'MIGRATION_STAGE_CLAIM_IN_PROGRESS',
    );
    await expect(
      repository.claimRowsByIds({
        tenantId: scoped.tenantId,
        organizationId: scoped.organizationId,
        jobId: scoped.job.id,
        rowIds: [rowsBeforeRecovery[2]!.id, rowsBeforeRecovery[1]!.id],
        fromStatus: 'validated',
        claimStatus: 'committing',
        ownerToken: `rollback-probe:${integrationDriver}`,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      }),
    ).rejects.toThrow('IMPORT_ROW_EXACT_CLAIM_CONFLICT');
    const rowsAfterConflict = await repository.listRows({
      tenantId: scoped.tenantId,
      organizationId: scoped.organizationId,
      jobId: scoped.job.id,
      limit: 10,
    });
    expect(rowsAfterConflict[1]).toMatchObject({
      status: 'committing',
      claim_owner: `competing-owner:${integrationDriver}`,
    });
    expect(rowsAfterConflict[2]).toMatchObject({
      status: 'validated',
      claim_owner: null,
      claim_attempt: rowsBeforeRecovery[2]!.claim_attempt,
    });
    await db
      .updateTable('import_job_rows')
      .set({ claim_expires_at: new Date(Date.now() - 1_000) })
      .where('tenant_id', '=', scoped.tenantId)
      .where('organization_id', '=', scoped.organizationId)
      .where('import_job_id', '=', scoped.job.id)
      .where('claim_owner', '=', `competing-owner:${integrationDriver}`)
      .execute();
    await expect(recoveryService.processStage(context, stageInput)).resolves.toEqual({
      processed: 2,
      created: 0,
      updated: 2,
      skipped: 0,
      conflicts: 0,
      failed: 0,
      complete: false,
      nextCursor: expect.any(String),
    });
  });

  it('imports the canonical dependency chain idempotently without commerce side effects', async () => {
    const firstJob = await importChain('chain:first');
    const imports = new ImportRepository(db);
    const firstRows = await imports.listRows({
      tenantId,
      organizationId,
      jobId: firstJob.id,
      limit: 100,
    });
    const expectedCounts = Object.fromEntries(
      MIGRATION_ENTITY_DEPENDENCY_ORDER.map((entityType) => [
        portableSectionForMigrationEntity(entityType)!,
        1,
      ]),
    );
    const reconciliationRepository = {
      findPortablePreflight: vi.fn(async () => ({
        expected_counts: JSON.stringify(expectedCounts),
        expected_assets: '[]',
        manifest_json: JSON.stringify({ lineage: { kind: 'full' } }),
        required_rebindings: '[]',
      })),
      listPortableImportRebindings: vi.fn(async () => []),
    } as unknown as ImportRepository;
    const reportInput = {
      db,
      repository: reconciliationRepository,
      context: { tenantId, organizationId, jobId: firstJob.id },
      rows: firstRows,
      unresolvedRows: [],
      committers: createProductionMigrationCommitters(db),
    };
    const initialReport = await portableReconciliationReport(reportInput);
    expect(initialReport, JSON.stringify(initialReport)).toMatchObject({ ready: true });
    const paymentSnapshot = await db
      .selectFrom('historical_financial_snapshots')
      .select(['id', 'amount_minor'])
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('kind', '=', 'historical-payment')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('historical_financial_snapshots')
      .set({ amount_minor: String(BigInt(paymentSnapshot.amount_minor) + 1n) })
      .where('id', '=', paymentSnapshot.id)
      .execute();
    const financialMismatch = await portableReconciliationReport(reportInput);
    expect(financialMismatch.ready).toBe(false);
    expect(financialMismatch.financialMismatches).toHaveLength(1);
    await db
      .updateTable('historical_financial_snapshots')
      .set({ amount_minor: paymentSnapshot.amount_minor })
      .where('id', '=', paymentSnapshot.id)
      .execute();
    await expect(portableReconciliationReport(reportInput)).resolves.toMatchObject({ ready: true });
    const eventReference = await imports.findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      entityType: 'event',
      externalId: 'event-1',
    });
    const eventBefore = await db
      .selectFrom('events')
      .select(['updated_at'])
      .where('id', '=', eventReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    await importChain('chain:reimport');
    const lifecycleEvents = await imports.listEvents(tenantId, organizationId, firstJob.id);
    expect(lifecycleEvents.map((event) => event.sequence)).toEqual(
      lifecycleEvents.map((_event, index) => index + 1),
    );
    expect(lifecycleEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'commit.begin',
        'commit.progress',
        'commit.reconciled',
        'commit.completed',
      ]),
    );
    const eventAfter = await db
      .selectFrom('events')
      .select(['updated_at'])
      .where('id', '=', eventReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    expect(new Date(eventAfter.updated_at).toISOString()).toBe(
      new Date(eventBefore.updated_at).toISOString(),
    );
    await db
      .updateTable('events')
      .set({ title: 'Edited after import', updated_at: eventAfter.updated_at })
      .where('id', '=', eventReference!.tixkit_id)
      .execute();
    await expect(
      createProductionMigrationCommitters(db).get('event')!.deleteUntouched({
        tenantId,
        organizationId,
        jobId: firstJob.id,
        tixkitId: eventReference!.tixkit_id,
      }),
    ).resolves.toBe(false);

    expect(
      Number(
        (
          await db
            .selectFrom('imported_domain_entities')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', tenantId)
            .where('created_by_import_job_id', '=', firstJob.id)
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(MIGRATION_ENTITY_DEPENDENCY_ORDER.length);
    const snapshots = await db
      .selectFrom('imported_domain_entities')
      .select(['entity_type', 'side_effects_suppressed', 'financial_snapshot'])
      .where('tenant_id', '=', tenantId)
      .where('entity_type', 'in', ['historical-payment', 'historical-refund'])
      .execute();
    expect(snapshots).toHaveLength(2);
    expect(
      snapshots.every(
        (snapshot) => snapshot.side_effects_suppressed && snapshot.financial_snapshot,
      ),
    ).toBe(true);
    const ticketReference = await imports.findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      entityType: 'ticket',
      externalId: 'ticket-1',
    });
    expect(ticketReference).toBeDefined();
    const ticketBeforeEdit = await db
      .selectFrom('tickets')
      .select(['updated_at', 'status', 'code', 'qr_payload', 'qr_hash'])
      .where('id', '=', ticketReference!.tixkit_id)
      .executeTakeFirstOrThrow();
    expect(ticketBeforeEdit).toMatchObject({
      status: 'void',
      code: expect.stringMatching(/^historical_[a-f0-9]{39}$/u),
      qr_payload: expect.stringMatching(/^historical_[a-f0-9]{39}$/u),
      qr_hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      await db
        .selectFrom('attendees')
        .select('status')
        .where('tenant_id', '=', tenantId)
        .where(
          'id',
          '=',
          (await imports.findExternalReference({
            tenantId,
            organizationId,
            sourceSystem: 'generic-csv',
            entityType: 'attendee',
            externalId: 'attendee-1',
          }))!.tixkit_id,
        )
        .execute(),
    ).toEqual([expect.objectContaining({ status: 'historical' })]);
    const liveSourceTicketCode = 'LIVE_SOURCE_BEARER_TICKET_01';
    await db
      .updateTable('tickets')
      .set({
        code: liveSourceTicketCode,
        qr_payload: liveSourceTicketCode,
        qr_hash: createHash('sha256').update(liveSourceTicketCode).digest('hex'),
      })
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'void')
      .execute();
    const historicalSections = await loadPortableHistoricalSections(db, {
      tenantId,
      organizationId,
    });
    expect(
      Object.fromEntries([...historicalSections].map(([section, rows]) => [section, rows.length])),
    ).toMatchObject({
      buyers: 1,
      attendees: 1,
      orders: 1,
      payments: 1,
      refunds: 1,
      tickets: 1,
      scans: 1,
    });
    const historicalJson = JSON.stringify(Object.fromEntries(historicalSections));
    expect(historicalJson).not.toContain(liveSourceTicketCode);
    expect(historicalJson).not.toMatch(/providerReference(?!Sha256)/u);
    expect(historicalSections.get('tickets')?.[0]?.attributes).toMatchObject({
      status: 'void',
      codeSha256: createHash('sha256').update(liveSourceTicketCode).digest('hex'),
    });
    expect(
      Number(
        (
          await db
            .selectFrom('payment_events')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db
            .selectFrom('webhook_deliveries')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(0);

    await db
      .updateTable('tickets')
      .set({
        code: 'same-timestamp-edit',
        updated_at: ticketBeforeEdit.updated_at,
      })
      .where('id', '=', ticketReference!.tixkit_id)
      .execute();
    await expect(
      createProductionMigrationCommitters(db).get('ticket')!.assessUntouched({
        tenantId,
        organizationId,
        jobId: firstJob.id,
        tixkitId: ticketReference!.tixkit_id,
      }),
    ).resolves.toMatchObject({
      eligible: false,
      reason: 'Authoritative domain activity or canonical edit detected',
    });
    await imports.markRollbackBlocked({
      tenantId,
      organizationId,
      entityType: 'ticket',
      tixkitId: ticketReference!.tixkit_id,
      reason: 'scan recorded after import',
    });
    const eligibility = await imports.getRollbackEligibility(tenantId, organizationId, firstJob.id);
    expect(eligibility).toMatchObject({
      eligible: false,
      mode: 'corrective-plan',
    });
    const rollbackService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const assessment = await rollbackService.assessRollback({
      tenantId,
      organizationId,
      jobId: firstJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(assessment).toMatchObject({
      eligible: false,
      mode: 'corrective_plan',
    });
    const correctivePlan = (await imports.listEvents(tenantId, organizationId, firstJob.id)).find(
      (event) => event.type === 'rollback.corrective-plan',
    );
    expect(correctivePlan?.id).toBe(assessment.eligible ? undefined : assessment.correctivePlanId);
    expect(JSON.parse(correctivePlan!.data!)).toMatchObject({
      immutable: true,
      blockers: [{ reason: 'scan recorded after import' }],
      safeActions: expect.arrayContaining([expect.stringContaining('corrective')]),
    });
    const replayedAssessment = await rollbackService.assessRollback({
      tenantId,
      organizationId,
      jobId: firstJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(replayedAssessment).toEqual(assessment);

    const changedSnapshotJob = await imports.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: 'financial:changed',
      requestedBy: 'test-user',
    });
    const changedPayment = entity(
      'historical-payment',
      MIGRATION_ENTITY_DEPENDENCY_ORDER.indexOf('historical-payment'),
    );
    changedPayment.financialSnapshot = {
      ...changedPayment.financialSnapshot!,
      amountMinor: changedPayment.financialSnapshot!.amountMinor + 1,
    };
    await expect(
      createProductionMigrationCommitters(db).get('historical-payment')!.commit({
        tenantId,
        organizationId,
        jobId: changedSnapshotJob.id,
        entity: changedPayment,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
  });

  it('loads an organization-scoped configuration bundle from production tables', async () => {
    await importChain('portable-export:source');
    const sourceBrandReference = await new ImportRepository(db).findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'generic-csv',
      entityType: 'brand',
      externalId: 'brand-1',
    });
    await db
      .updateTable('brands')
      .set({
        theme: JSON.stringify({
          primaryColor: '#123456',
          secondaryColor: '#234567',
          accentColor: '#345678',
          backgroundColor: '#ffffff',
          textColor: '#111111',
          fontFamily: 'Inter, sans-serif',
          borderRadius: 8,
          logoArtifactId: 'upl_local_logo',
          iconArtifactId: 'upl_local_icon',
          logoUrl: '/v1/public/brand-logos/upl_local_logo',
          iconUrl: '/v1/public/brand-logos/upl_local_icon',
          faviconUrl: 'https://source.example.test/favicon.ico',
          customCss: 'body { color: red; }',
        }),
      })
      .where('id', '=', sourceBrandReference!.tixkit_id)
      .execute();
    const suffix = Date.now().toString(36);
    const otherOrganization = await new OrganizationRepository(db).create({
      tenantId,
      name: `Other ${suffix}`,
      slug: `other-${suffix}`,
    });
    const otherBrand = await new BrandRepository(db).create({
      tenantId,
      organizationId: otherOrganization.id,
      name: `Other ${suffix}`,
      slug: `other-${suffix}`,
    });
    const otherEvent = await new EventRepository(db).create({
      tenantId,
      organizationId: otherOrganization.id,
      brandId: otherBrand.id,
      slug: `other-${suffix}`,
      title: 'Other event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    const sections = await loadPortableConfigurationSections(db, { tenantId, organizationId });
    expect(sections.get('organizations')).toHaveLength(1);
    expect(sections.get('events')?.length).toBeGreaterThan(0);
    expect(sections.get('ticket_types')?.length).toBeGreaterThan(0);
    expect(sections.get('products')?.length).toBeGreaterThan(0);
    expect(sections.get('checkout_questions')?.length).toBeGreaterThan(0);
    expect(sections.get('discounts')?.length).toBeGreaterThan(0);
    expect(sections.get('access_codes')?.length).toBeGreaterThan(0);
    expect(
      sections
        .get('brands')!
        .find(({ portableId }) => portableId === sourceBrandReference!.tixkit_id)!.attributes.theme,
    ).toEqual({
      primaryColor: '#123456',
      secondaryColor: '#234567',
      accentColor: '#345678',
      backgroundColor: '#ffffff',
      textColor: '#111111',
      fontFamily: 'Inter, sans-serif',
      borderRadius: 8,
    });
    expect(sections.get('events')?.some(({ portableId }) => portableId === otherEvent.id)).toBe(
      false,
    );

    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const payloadPolicies = createPortableConfigurationPayloadPolicies();
    const build = (selectedSections: typeof sections) =>
      buildPortableLogicalExport({
        bundleId: `bundle_${suffix}`,
        mode: 'configuration',
        source: {
          operatingModel: 'self-hosted',
          deploymentId: 'integration_source',
          tenantId,
          organizationId,
          exportSequence: 1,
          changeCursor: `cursor_${suffix}`,
        },
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0067',
        exportedAt: '2026-07-12T20:00:00.000Z',
        currentTime: '2026-07-12T20:00:00.000Z',
        compatibility: {
          minimumApiVersion: '2026-01-01',
          maximumApiVersion: '2026-12-31',
          minimumDataSchemaVersion: '0064',
          maximumDataSchemaVersion: '0069',
          requiredCapabilities: ['portable-bundle-v1'],
          requiredEntitlements: [],
        },
        sections: selectedSections,
        bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
        payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
        payloadPolicies,
      });
    const built = build(sections);
    expect(built.envelope.manifest.files).toHaveLength(sections.size);
    expect(built.transport.byteLength).toBeGreaterThan(0);
    const transportText = new TextDecoder().decode(built.transport);
    expect(transportText).not.toMatch(
      /logoArtifactId|iconArtifactId|logoUrl|iconUrl|faviconUrl|customCss|upl_local_/u,
    );

    const destinationTenant = await new TenantRepository(db).create({
      name: `Portable destination ${suffix}`,
    });
    const destinationOrganization = await new OrganizationRepository(db).create({
      tenantId: destinationTenant.id,
      name: `Portable destination ${suffix}`,
      slug: `portable-destination-${suffix}`,
    });
    await db
      .updateTable('organizations')
      .set({
        box_office_settings: JSON.stringify({
          enabled: false,
          allowedTenderTypes: ['comp'],
          requireBuyerEmail: false,
          receiptMode: 'print',
        }),
        event_defaults: JSON.stringify({ currency: 'CAD', country: 'CA' }),
      })
      .where('tenant_id', '=', destinationTenant.id)
      .where('id', '=', destinationOrganization.id)
      .execute();
    const destinationOrganizationBefore = (
      await loadPortableConfigurationSections(db, {
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
      })
    ).get('organizations')![0]!.attributes;
    const configuration = prepareTixkitPortableUpload(built.transport, {
      destination: {
        deploymentId: 'integration_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0067',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 64 * 1024 * 1024,
        acceptedSourceOperatingModels: ['self-hosted'],
      },
      trustedBundleKeys: new Map([['bundle_key_01', bundleKeys.publicKey]]),
      trustedPayloadKeys: new Map([['payload_key_01', payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map(
        [...payloadPolicies].map(([section, policy]) => [
          section,
          {
            schemaId: policy.schemaId,
            schemaSha256: policy.schemaSha256,
            policySha256: policy.policySha256,
            scannerId: policy.scannerId,
            keyId: 'payload_key_01',
          },
        ]),
      ),
      trustedMediaKeys: new Map(),
      trustedMediaPolicies: new Map(),
      destinationTenantId: destinationTenant.id,
      destinationOrganizationId: destinationOrganization.id,
    });
    const adapter = new TixkitPortableMigrationAdapter();
    const context = {
      tenantId: destinationTenant.id,
      organizationId: destinationOrganization.id,
    };
    const discovery = await adapter.discover(configuration, context);
    const normalized: NormalizedMigrationEntity[] = [];
    let cursor: string | undefined;
    do {
      const page = await adapter.extract({
        configuration,
        discovery,
        cursor,
        limit: 5,
        context,
      });
      for (const row of page.rows) normalized.push(await adapter.normalize(row, context));
      cursor = page.nextCursor;
    } while (cursor);
    expect(normalized).toHaveLength(
      [...sections.values()].reduce((count, records) => count + records.length, 0),
    );

    const destinationJob = await new ImportRepository(db).createJob({
      tenantId: destinationTenant.id,
      organizationId: destinationOrganization.id,
      sourceSystem: 'tixkit-portable',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: `portable-roundtrip:${suffix}`,
      requestedBy: 'test-user',
    });
    const committers = createProductionMigrationCommitters(db);
    const imports = new ImportRepository(db);
    for (const item of sortEntitiesByDependency(normalized)) {
      const outcome = await committers.get(item.entityType)!.commit({
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
        jobId: destinationJob.id,
        entity: item,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      });
      await imports.recordExternalReference({
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
        sourceSystem: 'tixkit-portable',
        entityType: item.entityType,
        externalId: item.externalId,
        tixkitId: outcome.tixkitId!,
        importJobId: destinationJob.id,
        createdByJob: outcome.disposition === 'created',
      });
      if (item.entityType === 'event') {
        const stagedEvent = await db
          .selectFrom('events')
          .innerJoin('brands', 'brands.id', 'events.brand_id')
          .select(['events.status', 'events.visibility', 'brands.status as brand_status'])
          .where('events.id', '=', outcome.tixkitId!)
          .executeTakeFirstOrThrow();
        expect(stagedEvent).toEqual({
          status: 'draft',
          visibility: 'private',
          brand_status: 'draft',
        });
      }
    }
    const destinationId = async (entityType: MigrationEntityType, externalId: string) =>
      (await imports.findExternalReference({
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
        sourceSystem: 'tixkit-portable',
        entityType,
        externalId,
      }))!.tixkit_id;
    const sectionEntityType = new Map([
      ['organizations', 'organization'],
      ['brands', 'brand'],
      ['venues', 'venue'],
      ['events', 'event'],
      ['occurrences', 'occurrence'],
      ['inventory', 'inventory-pool'],
      ['ticket_types', 'ticket-type'],
      ['products', 'product'],
      ['checkout_questions', 'question'],
      ['discounts', 'discount'],
      ['access_codes', 'access-code'],
    ] as const);
    const destinationSections = await loadPortableConfigurationSections(db, {
      tenantId: destinationTenant.id,
      organizationId: destinationOrganization.id,
    });
    const inertStateOverrides = new Map([
      ['brands', { status: 'draft' }],
      ['events', { status: 'draft', visibility: 'private' }],
      ['occurrences', { status: 'cancelled' }],
      ['ticket_types', { status: 'draft', visibility: 'hidden' }],
      ['products', { status: 'inactive' }],
      ['discounts', { status: 'inactive' }],
    ] as const);
    for (const [section, sourceRecords] of sections) {
      const entityType = sectionEntityType.get(section as never);
      expect(entityType, `missing entity mapping for ${section}`).toBeDefined();
      for (const sourceRecord of sourceRecords) {
        const mappedId = await destinationId(entityType!, sourceRecord.portableId);
        const destinationRecord = destinationSections
          .get(section)
          ?.find(({ portableId }) => portableId === mappedId);
        expect(destinationRecord?.attributes, `${section}:${sourceRecord.portableId}`).toEqual({
          ...(section === 'organizations'
            ? destinationOrganizationBefore
            : sourceRecord.attributes),
          ...inertStateOverrides.get(section as never),
        });
        const staged = await db
          .selectFrom('imported_domain_entities')
          .select('attributes')
          .where('tenant_id', '=', destinationTenant.id)
          .where('organization_id', '=', destinationOrganization.id)
          .where('id', '=', mappedId)
          .executeTakeFirstOrThrow();
        expect(JSON.parse(staged.attributes)).toEqual(sourceRecord.attributes);
      }
    }
    const sourceEvent = sections.get('events')![0]!;
    const sourceBrandId = sourceEvent.dependencies!.find(
      ({ section }) => section === 'brands',
    )!.portableId;
    const sourceMediaAssetIds = (
      await db
        .selectFrom('event_media_assets')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', sourceEvent.portableId)
        .execute()
    ).map(({ id }) => id);
    if (sourceMediaAssetIds.length > 0) {
      await db
        .deleteFrom('event_media_renditions')
        .where('asset_id', 'in', sourceMediaAssetIds)
        .execute();
      await db.deleteFrom('event_media_assets').where('id', 'in', sourceMediaAssetIds).execute();
    }
    await db
      .updateTable('events')
      .set({ brand_id: otherBrand.id })
      .where('id', '=', sourceEvent.portableId)
      .execute();
    try {
      const corruptSections = await loadPortableConfigurationSections(db, {
        tenantId,
        organizationId,
      });
      expect(() => build(corruptSections)).toThrow(/dependency identity is absent/u);
    } finally {
      await db
        .updateTable('events')
        .set({ brand_id: sourceBrandId })
        .where('id', '=', sourceEvent.portableId)
        .execute();
    }
    const originalEventDefaults = sections.get('organizations')![0]!.attributes.eventDefaults;
    await db
      .updateTable('organizations')
      .set({ event_defaults: JSON.stringify({ nested: { apiKey: 'must-not-export' } }) })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    try {
      const secretSections = await loadPortableConfigurationSections(db, {
        tenantId,
        organizationId,
      });
      expect(() => build(secretSections)).toThrow(/forbidden field/u);
    } finally {
      await db
        .updateTable('organizations')
        .set({ event_defaults: JSON.stringify(originalEventDefaults) })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', organizationId)
        .execute();
    }
  });

  it('cannot resolve dependencies from another organization in the same tenant', async () => {
    await importChain('org-isolation:source');
    const otherOrganization = await new OrganizationRepository(db).create({
      tenantId,
      name: 'Other migration organization',
      slug: 'other-migration-organization',
    });
    const imports = new ImportRepository(db);
    const job = await imports.createJob({
      tenantId,
      organizationId: otherOrganization.id,
      sourceSystem: 'generic-csv',
      adapterVersion: '1',
      mode: 'commit',
      idempotencyKey: 'org-isolation:target',
      requestedBy: 'test',
    });
    const brand = createProductionMigrationCommitters(db).get('brand')!;
    await expect(
      brand.commit({
        tenantId,
        organizationId: otherOrganization.id,
        jobId: job.id,
        entity: {
          entityType: 'brand',
          externalId: 'cross-org-brand',
          sourcePosition: 'fixture:cross-org',
          attributes: { name: 'Cross org' },
          dependencies: [{ entityType: 'organization', externalId: 'organization-1' }],
        },
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow('MIGRATION_DEPENDENCY_UNRESOLVED:organization:organization-1');
  });

  it('resolves a live scoped credential before commit and sanitizes resolver failures', async () => {
    const imports = new ImportRepository(db);
    const credential = await imports.createCredential({
      tenantId,
      organizationId,
      sourceSystem: 'pretix',
      secretReference: 'vault://migrations/pretix/test',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: 'test',
    });
    const createJob = async (key: string) => {
      const job = await imports.createJob({
        tenantId,
        organizationId,
        sourceSystem: 'pretix',
        adapterVersion: '1',
        mode: 'commit',
        idempotencyKey: key,
        requestedBy: 'test',
        configuration: { credentialId: credential.id },
      });
      await imports.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ['pending'],
        to: 'ready',
      });
      return job;
    };
    const failedJob = await createJob('credential:failure');
    const rejectingResolver = {
      resolve: vi.fn(async () => {
        throw new Error('vault token and secret details');
      }),
    };
    const failingService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      rejectingResolver,
    );
    await expect(
      failingService.beginCommit({
        tenantId,
        organizationId,
        jobId: failedJob.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow('MIGRATION_CREDENTIAL_UNAVAILABLE');
    expect((await imports.findJob(tenantId, organizationId, failedJob.id))?.status).toBe('ready');

    const liveJob = await createJob('credential:success');
    const liveResolver = {
      resolve: vi.fn(async () => ({
        material: 'ephemeral',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })),
    };
    const liveService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
      liveResolver,
    );
    await liveService.beginCommit({
      tenantId,
      organizationId,
      jobId: liveJob.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect(liveResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        organizationId,
        sourceSystem: 'pretix',
        secretReference: 'vault://migrations/pretix/test',
      }),
      {},
    );
    expect((await imports.findJob(tenantId, organizationId, liveJob.id))?.status).toBe(
      'committing',
    );
  });

  it.each([
    {
      sourceSystem: 'generic-csv' as const,
      configuration: {
        documents: [
          {
            name: 'events.csv',
            content:
              'external_id,brand_external_id,name,starts_at,ends_at,timezone,currency\nevent-prod,brand-existing,Production import,2027-07-10T18:00:00Z,2027-07-10T22:00:00Z,UTC,USD\n',
          },
        ],
      },
    },
    {
      sourceSystem: 'pretix' as const,
      configuration: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: 'hi-events' as const,
      configuration: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: 'eventbrite' as const,
      configuration: eventbriteApiV3Fixture,
    },
    {
      sourceSystem: 'ticket-tailor' as const,
      configuration: ticketTailorApiV1Fixture,
    },
  ])(
    'persists the $sourceSystem official corpus through durable production rows and resumes at the exact cursor',
    async ({ sourceSystem, configuration }) => {
      const adapter =
        sourceSystem === 'generic-csv'
          ? (new GenericCsvMigrationAdapter() as MigrationAdapter<unknown, string>)
          : (migrationAdapter(sourceSystem) as MigrationAdapter<unknown, string>);
      const context = { tenantId, organizationId };
      const discovery = await adapter.discover(configuration, context);
      const sourceEntities: NormalizedMigrationEntity[] = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.extract({
          configuration,
          discovery,
          cursor,
          limit: 2,
          context,
        });
        for (const row of page.rows) sourceEntities.push(await adapter.normalize(row, context));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sourceEntities.length).toBeGreaterThan(0);
      const entities = sortEntitiesByDependency(sourceEntities);
      const sourceKeys = new Set(
        sourceEntities.map((item) => `${item.entityType}:${item.externalId}`),
      );

      const repository = new ImportRepository(db);
      const job = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: 'commit',
        idempotencyKey: `production-corpus-${sourceSystem}`,
        requestedBy: 'test-user',
      });
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ['pending'],
        to: 'preparing',
      });
      const split = Math.max(1, Math.floor(entities.length / 2));
      const persist = async (
        selected: readonly NormalizedMigrationEntity[],
        startRowNumber: number,
        cursorKey: string,
        completed: boolean,
      ) =>
        repository.persistPreparationChunk({
          tenantId,
          organizationId,
          jobId: job.id,
          startRowNumber,
          cursorKey,
          nextCursor: completed ? undefined : `${sourceSystem}:resume:${split}`,
          completed,
          rows: await Promise.all(
            selected.map(async (normalized) => ({
              entityType: normalized.entityType,
              externalId: normalized.externalId,
              sourceData: { sourcePosition: normalized.sourcePosition },
              normalizedData: normalized,
              issues: sourceKeys.has(`${normalized.entityType}:${normalized.externalId}`)
                ? (await adapter.validate(normalized, context)).map(
                    ({ code, severity, message }) => ({
                      code,
                      severity,
                      message,
                    }),
                  )
                : [],
            })),
          ),
        });
      await persist(entities.slice(0, split), 0, `${sourceSystem}:first`, false);
      const recovered = await repository.preparationProgress(tenantId, organizationId, job.id);
      expect(recovered).toEqual({
        cursor: `${sourceSystem}:resume:${split}`,
        rowNumber: split,
        completed: false,
      });
      await persist(entities.slice(split), recovered.rowNumber, `${sourceSystem}:second`, true);
      await persist(entities.slice(split), recovered.rowNumber, `${sourceSystem}:second`, true);
      const rows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: job.id,
        limit: 500,
      });
      expect(rows).toHaveLength(entities.length);
      expect(rows.every((row) => row.normalized_data !== null)).toBe(true);
      expect((await repository.findJob(tenantId, organizationId, job.id))?.status).toBe('prepared');
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: job.id,
        from: ['prepared'],
        to: 'ready',
      });
      const committers = createRepositoryMigrationActivityService(
        db,
        createProductionMigrationCommitters(db),
      );
      const entityKeys = new Set(entities.map((item) => `${item.entityType}:${item.externalId}`));
      for (const item of entities) {
        for (const dependency of item.dependencies ?? []) {
          if (dependency.entityType !== 'brand' || entityKeys.has(`brand:${dependency.externalId}`))
            continue;
          await repository.recordExternalReference({
            tenantId,
            organizationId,
            sourceSystem,
            entityType: 'brand',
            externalId: dependency.externalId,
            tixkitId: brandId,
            importJobId: job.id,
            createdByJob: false,
          });
        }
      }
      const commitJob = async (jobId: string) => {
        const scope = {
          tenantId,
          organizationId,
          jobId,
          sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
        };
        await committers.beginCommit(scope);
        const totals = { created: 0, updated: 0, skipped: 0, conflicts: 0 };
        for (const stage of MIGRATION_COMMIT_STAGES) {
          let stageCursor: string | undefined;
          for (;;) {
            const result = await committers.processStage(scope, {
              stage,
              cursor: stageCursor,
              claimOwner: `${jobId}:${stage}:${stageCursor ?? 'first'}`,
              chunkSize: 2,
            });
            totals.created += result.created;
            totals.updated += result.updated;
            totals.skipped += result.skipped;
            totals.conflicts += result.conflicts;
            if (result.complete) break;
            stageCursor = result.nextCursor;
          }
          if (stage === 'events_occurrences') {
            const missingPools = new Map<string, string>();
            for (const item of entities) {
              const eventDependency = item.dependencies?.find(
                ({ entityType }) => entityType === 'event',
              );
              for (const dependency of item.dependencies ?? []) {
                if (
                  dependency.entityType === 'inventory-pool' &&
                  !entityKeys.has(`inventory-pool:${dependency.externalId}`) &&
                  eventDependency
                )
                  missingPools.set(dependency.externalId, eventDependency.externalId);
              }
            }
            for (const [poolExternalId, eventExternalId] of missingPools) {
              const existingPool = await repository.findExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: 'inventory-pool',
                externalId: poolExternalId,
              });
              if (existingPool) continue;
              const eventReference = await repository.findExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: 'event',
                externalId: eventExternalId,
              });
              if (!eventReference) throw new Error('TEST_EVENT_MAPPING_REQUIRED');
              const poolId = `pool_${sourceSystem.replaceAll('-', '_')}_${missingPools.size}`;
              await db
                .insertInto('inventory_pools')
                .values({
                  id: poolId,
                  event_id: eventReference.tixkit_id,
                  name: 'Existing mapped capacity',
                  total_capacity: 10_000,
                  reserved_count: 0,
                  sold_count: 0,
                  hold_ttl_seconds: 900,
                  created_at: new Date(),
                  updated_at: new Date(),
                })
                .execute();
              await repository.recordExternalReference({
                tenantId,
                organizationId,
                sourceSystem,
                entityType: 'inventory-pool',
                externalId: poolExternalId,
                tixkitId: poolId,
                importJobId: jobId,
                createdByJob: false,
              });
            }
          }
        }
        await committers.completeCommit(scope);
        return totals;
      };
      const firstCommit = await commitJob(job.id);
      expect(firstCommit.conflicts).toBe(0);
      expect(firstCommit.created + firstCommit.updated + firstCommit.skipped).toBe(entities.length);

      const replay = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: 'commit',
        idempotencyKey: `production-corpus-replay-${sourceSystem}`,
        requestedBy: 'test-user',
      });
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: replay.id,
        from: ['pending'],
        to: 'preparing',
      });
      await repository.persistPreparationChunk({
        tenantId,
        organizationId,
        jobId: replay.id,
        startRowNumber: 0,
        cursorKey: `${sourceSystem}:replay`,
        completed: true,
        rows: entities.map((normalized) => ({
          entityType: normalized.entityType,
          externalId: normalized.externalId,
          sourceData: { sourcePosition: normalized.sourcePosition },
          normalizedData: normalized,
          issues: [],
        })),
      });
      const replayRows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: replay.id,
        limit: 500,
      });
      expect(replayRows.map(({ normalized_data }) => normalized_data)).toEqual(
        rows.map(({ normalized_data }) => normalized_data),
      );
      await repository.transitionJob({
        tenantId,
        organizationId,
        jobId: replay.id,
        from: ['prepared'],
        to: 'ready',
      });
      const secondCommit = await commitJob(replay.id);
      expect(secondCommit).toMatchObject({
        created: 0,
        updated: 0,
        skipped: entities.length,
        conflicts: 0,
      });
    },
    30_000,
  );

  it.each([
    {
      sourceSystem: 'pretix' as const,
      configuration: {
        sourceMode: 'official-api' as const,
        sourceSystem: 'pretix' as const,
        organizerSlug: 'sample-organizer',
        eventSlugs: ['sample-event'],
      },
      fixture: SANITIZED_PRETIX_OFFICIAL_API_FIXTURE,
    },
    {
      sourceSystem: 'hi-events' as const,
      configuration: {
        sourceMode: 'official-api' as const,
        sourceSystem: 'hi-events' as const,
        accountId: 'sample-account',
        eventIds: ['event-1'],
      },
      fixture: SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE,
    },
  ])(
    'acquires native $sourceSystem multi-resource API pages with exact durable resume',
    async ({ sourceSystem, configuration, fixture }) => {
      const repository = new ImportRepository(db);
      const credential = await repository.createCredential({
        tenantId,
        organizationId,
        sourceSystem,
        secretReference: `vault://migrations/${sourceSystem}/native-fixture`,
        expiresAt: new Date(Date.now() + 60_000),
        createdBy: 'test-user',
      });
      const adapter = migrationAdapter(sourceSystem);
      const job = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem,
        adapterVersion: adapter.supportedVersions[0]!,
        mode: 'commit',
        idempotencyKey: `native-api-preparation-${sourceSystem}`,
        requestedBy: 'test-user',
        configuration: { ...configuration, credentialId: credential.id },
      });
      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const page of fixture.pages) {
        for (const raw of page.records as readonly unknown[]) {
          const record = raw as {
            resource?: string;
            collection?: string;
            body: Record<string, unknown>;
          };
          const key = String(record.resource ?? record.collection);
          const values = grouped.get(key) ?? [];
          values.push(structuredClone(record.body));
          grouped.set(key, values);
        }
      }
      const order = grouped.get('orders')?.[0];
      if (order) {
        order.payments = grouped.get('payments') ?? [];
        order.refunds = grouped.get('refunds') ?? [];
        if (sourceSystem === 'pretix') {
          const positions = order.positions as Array<Record<string, unknown>>;
          for (const position of positions) delete position.checkins;
        }
      }
      const requested: string[] = [];
      const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        requested.push(url.href);
        let key: string;
        if (sourceSystem === 'pretix') {
          if (url.pathname.endsWith('/checkinlists/7/positions/')) {
            const checkins = grouped.get('checkins') ?? [];
            const continuation = url.searchParams.get('continuation');
            return new Response(
              JSON.stringify({
                results: continuation
                  ? [
                      {
                        id: String(
                          ((order?.positions as Array<Record<string, unknown>> | undefined)?.[0]
                            ?.id as string | number | undefined) ?? 'position-100',
                        ),
                        checkins,
                      },
                    ]
                  : [{ id: 'position-empty', checkins: [] }],
                ...(!continuation
                  ? { pagination: { continuation: 'checkin-position-page-2' } }
                  : {}),
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.pathname.endsWith('/checkinlists/')) {
            return new Response(JSON.stringify({ results: [{ id: 7, name: 'Default' }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          const match = /\/(quotas|items|questions|vouchers|orders)\//u.exec(url.pathname);
          key = match?.[1] ?? (url.pathname.endsWith('/events/') ? 'events' : 'organizers');
        } else {
          const match =
            /\/(capacity-assignments|products|questions|promo-codes|orders|check-ins)$/u.exec(
              url.pathname,
            );
          key =
            match?.[1] ??
            (url.pathname === '/api/account'
              ? 'accounts'
              : url.pathname === '/api/venues'
                ? 'venues'
                : 'events');
        }
        const bodies = grouped.get(key) ?? [];
        const continuation = url.searchParams.get('continuation');
        const paginate = (key === 'items' || key === 'products') && bodies.length > 1;
        const results = paginate
          ? continuation === 'native-page-2'
            ? bodies.slice(1)
            : bodies.slice(0, 1)
          : bodies;
        return new Response(
          JSON.stringify({
            results,
            ...(paginate && !continuation ? { pagination: { continuation: 'native-page-2' } } : {}),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const runtime = {
        fetch: fetcher as typeof fetch,
        resolveHost: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) as never,
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        cursorEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
      };
      const resolver = {
        resolve: vi.fn(async () => ({
          material: 'ephemeral-native-fixture-token',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        })),
      };
      const firstWorker = createMigrationPreparationService(db, resolver, runtime);
      const first = await firstWorker.prepare({
        tenantId,
        organizationId,
        jobId: job.id,
        chunkSize: 100,
      });
      expect(first.completed).toBe(false);
      const recoveredWorker = createMigrationPreparationService(db, resolver, runtime);
      let result = await recoveredWorker.prepare({
        tenantId,
        organizationId,
        jobId: job.id,
        chunkSize: 100,
      });
      while (!result.completed) {
        result = await recoveredWorker.prepare({
          tenantId,
          organizationId,
          jobId: job.id,
          chunkSize: 100,
        });
      }
      const rows = await repository.listRows({
        tenantId,
        organizationId,
        jobId: job.id,
        limit: 500,
      });
      expect(rows).toHaveLength(18);
      const types = new Set(rows.map(({ entity_type }) => entity_type));
      expect(types.has('historical-payment')).toBe(true);
      expect(types.has('historical-refund')).toBe(true);
      expect(types.has('check-in')).toBe(true);
      expect(requested.some((url) => url.includes('continuation=native-page-2'))).toBe(true);
      if (sourceSystem === 'pretix') {
        expect(requested.some((url) => url.includes('/checkinlists/7/positions/'))).toBe(true);
        expect(
          requested.some(
            (url) =>
              url.includes('/checkinlists/7/positions/') &&
              url.includes('continuation=checkin-position-page-2'),
          ),
        ).toBe(true);
      }
      expect(
        (await repository.preparationProgress(tenantId, organizationId, job.id)).completed,
      ).toBe(true);
      expect(resolver.resolve).toHaveBeenCalled();
    },
    30_000,
  );

  it('persists a trusted portable upload once and resumes from the durable completed checkpoint', async () => {
    const repository = new ImportRepository(db);
    const payload = Buffer.from(
      [
        JSON.stringify({
          portableId: 'organization-portable-1',
          attributes: { name: 'Portable organization 1' },
        }),
        JSON.stringify({
          portableId: 'organization-portable-2',
          attributes: { name: 'Portable organization 2' },
        }),
        '',
      ].join('\n'),
    );
    const file = {
      path: 'data/organizations.jsonl',
      section: 'organizations' as const,
      sha256: createHash('sha256').update(payload).digest('hex'),
      bytes: payload.byteLength,
      records: 2,
      contentType: 'application/jsonl' as const,
    };
    const payloadKeys = generateKeyPairSync('ed25519');
    const receipt = scanPortablePayload(
      file,
      payload,
      {
        schemaId: 'organizations_schema_01',
        schemaSha256: '1'.repeat(64),
        policySha256: '2'.repeat(64),
        scannerId: 'payload_scanner_01',
        validateRecord: (section, record) =>
          section === 'organizations' && Boolean(record && typeof record === 'object'),
      },
      'payload_key_01',
      payloadKeys.privateKey,
    );
    const manifest: PortableBundleManifest = {
      schemaVersion: 1,
      format: 'tixkit-portable-bundle-v1',
      bundleId: 'bundle_workflow_integration_01',
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: 'deployment_source',
        tenantId,
        exportSequence: 1,
        changeCursor: 'cursor_01',
      },
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0067',
      exportedAt: '2026-07-12T18:00:00.000Z',
      lineage: { kind: 'full', toChangeCursor: 'cursor_01' },
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0064',
        maximumDataSchemaVersion: '0069',
        requiredCapabilities: ['portable-bundle-v1'],
        requiredEntitlements: [],
      },
      entityCounts: { organizations: 2 },
      files: [file],
      payloadSafety: {
        policyVersion: 'tixkit-portable-secret-policy-v1',
        scannedFiles: [receipt],
        findings: 0,
      },
      assetSafety: {
        policyVersion: 'tixkit-portable-media-policy-v1',
        scannedFiles: [],
        findings: 0,
      },
      assets: [],
      identity: { namespace: tenantId, preserveSafeIds: true, mappingRequired: true },
      dependencies: [{ section: 'organizations', dependsOn: [] }],
      rebindings: [],
    };
    const bundleKeys = generateKeyPairSync('ed25519');
    const rogueBundleKeys = generateKeyPairSync('ed25519');
    let activeBundlePublicKey = bundleKeys.publicKey;
    const envelope = {
      manifest,
      signature: signPortableManifest(manifest, 'bundle_key_01', bundleKeys.privateKey),
    };
    const upload = Buffer.from(
      JSON.stringify({
        envelope,
        payloads: { [file.path]: payload.toString('base64') },
      }),
    );
    const artifactId = `upl_portable_${Date.now()}`;
    const objectKey = `uploads/${tenantId}/${artifactId}.json`;
    const checksum = createHash('sha256').update(upload).digest('hex');
    await db
      .insertInto('upload_artifacts')
      .values({
        id: artifactId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: null,
        event_id: null,
        created_by_user_id: null,
        purpose: 'migration_import',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: null,
        bucket: 'tixkit',
        object_key: objectKey,
        file_name: 'portable-bundle.json',
        content_type: 'application/vnd.tixkit.portable+json',
        size_bytes: upload.byteLength,
        checksum_sha256: checksum,
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v1',
      mode: 'dry-run',
      idempotencyKey: 'portable-workflow-integration',
      requestedBy: 'test-user',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: [artifactId],
      },
    });
    await repository.addFile({
      tenantId,
      organizationId,
      jobId: job.id,
      objectKey,
      originalName: 'portable-bundle.json',
      mediaType: 'application/vnd.tixkit.portable+json',
      byteSize: upload.byteLength,
      sha256: checksum,
    });
    const portableTrust = ({
      tenantId: destinationTenantId,
      organizationId: destinationOrganizationId,
    }: {
      tenantId: string;
      organizationId: string;
    }) => ({
      destination: {
        deploymentId: 'deployment_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0067',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 1024 * 1024,
        acceptedSourceOperatingModels: ['self-hosted' as const],
      },
      trustedBundleKeys: new Map([['bundle_key_01', activeBundlePublicKey]]),
      trustedPayloadKeys: new Map([['payload_key_01', payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map([
        [
          'organizations' as const,
          {
            schemaId: receipt.schemaId,
            schemaSha256: receipt.schemaSha256,
            policySha256: receipt.policySha256,
            scannerId: receipt.scannerId,
            keyId: receipt.keyId,
          },
        ],
      ]),
      trustedMediaKeys: new Map(),
      trustedMediaPolicies: new Map(),
      destinationTenantId,
      destinationOrganizationId,
    });
    const service = createMigrationPreparationService(
      db,
      { resolve: vi.fn() },
      {
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        cursorEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
        createS3Client: () =>
          ({
            send: vi.fn(async () => ({
              Body: (async function* () {
                yield upload;
              })(),
            })),
          }) as never,
        portableTrust,
      },
    );
    await expect(
      service.prepare({ tenantId, organizationId, jobId: job.id, chunkSize: 1 }),
    ).resolves.toEqual({ processed: 1, completed: false });
    await expect(
      repository.findPortablePreflight(tenantId, organizationId, job.id),
    ).resolves.toMatchObject({
      bundle_id: manifest.bundleId,
      manifest_sha256: portableManifestSha256(manifest),
      artifact_sha256: checksum,
      source_deployment_id: manifest.source.deploymentId,
      source_change_cursor: manifest.lineage.toChangeCursor,
      destination_id: 'deployment_destination',
      expected_counts: JSON.stringify(manifest.entityCounts),
      expected_assets: '[]',
      required_rebindings: '[]',
    });
    activeBundlePublicKey = rogueBundleKeys.publicKey;
    await expect(
      service.prepare({ tenantId, organizationId, jobId: job.id, chunkSize: 1 }),
    ).rejects.toThrow(/signature/u);
    activeBundlePublicKey = bundleKeys.publicKey;
    await expect(
      service.prepare({ tenantId, organizationId, jobId: job.id, chunkSize: 1 }),
    ).resolves.toEqual({ processed: 1, completed: true });
    await expect(
      service.prepare({ tenantId, organizationId, jobId: job.id, chunkSize: 1 }),
    ).resolves.toEqual({ processed: 0, completed: true });
    const rows = await repository.listRows({ tenantId, organizationId, jobId: job.id, limit: 10 });
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.normalized_data!)).toMatchObject({
      entityType: 'organization',
      externalId: 'organization-portable-1',
      attributes: { name: 'Portable organization 1' },
    });
    expect(rows[0]?.status).toBe('validated');

    const deltaManifest: PortableBundleManifest = {
      ...manifest,
      bundleId: 'bundle_workflow_integration_delta_01',
      source: {
        ...manifest.source,
        exportSequence: 7,
        changeCursor: 'cursor_02',
      },
      exportedAt: '2026-07-12T18:05:00.000Z',
      lineage: {
        kind: 'delta',
        fromChangeCursor: manifest.lineage.toChangeCursor,
        toChangeCursor: 'cursor_02',
        parentBundleId: manifest.bundleId,
        parentManifestSha256: portableManifestSha256(manifest),
      },
    };
    const deltaEnvelope = {
      manifest: deltaManifest,
      signature: signPortableManifest(deltaManifest, 'bundle_key_01', bundleKeys.privateKey),
    };
    const deltaUpload = Buffer.from(
      JSON.stringify({
        envelope: deltaEnvelope,
        parentEnvelope: envelope,
        payloads: { [file.path]: payload.toString('base64') },
      }),
    );
    const deltaArtifactId = `upl_portable_delta_${Date.now()}`;
    const deltaObjectKey = `uploads/${tenantId}/${deltaArtifactId}.json`;
    const deltaChecksum = createHash('sha256').update(deltaUpload).digest('hex');
    await db
      .insertInto('upload_artifacts')
      .values({
        id: deltaArtifactId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: null,
        event_id: null,
        created_by_user_id: null,
        purpose: 'migration_import',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: null,
        bucket: 'tixkit',
        object_key: deltaObjectKey,
        file_name: 'portable-delta-bundle.json',
        content_type: 'application/vnd.tixkit.portable+json',
        size_bytes: deltaUpload.byteLength,
        checksum_sha256: deltaChecksum,
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: new Date(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const deltaJob = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v1',
      mode: 'dry-run',
      idempotencyKey: 'portable-workflow-delta-integration',
      requestedBy: 'test-user',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: [deltaArtifactId],
      },
    });
    await repository.addFile({
      tenantId,
      organizationId,
      jobId: deltaJob.id,
      objectKey: deltaObjectKey,
      originalName: 'portable-delta-bundle.json',
      mediaType: 'application/vnd.tixkit.portable+json',
      byteSize: deltaUpload.byteLength,
      sha256: deltaChecksum,
    });
    const deltaService = createMigrationPreparationService(
      db,
      { resolve: vi.fn() },
      {
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        cursorEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
        createS3Client: () =>
          ({
            send: vi.fn(async () => ({
              Body: (async function* () {
                yield deltaUpload;
              })(),
            })),
          }) as never,
        portableTrust,
      },
    );
    await expect(
      deltaService.prepare({ tenantId, organizationId, jobId: deltaJob.id, chunkSize: 1 }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_PARENT_NOT_ACTIVATED');
    await repository.advancePortableImportLineageCheckpoint({
      tenantId,
      organizationId,
      jobId: job.id,
      destinationId: 'deployment_destination',
      sourceDeploymentId: manifest.source.deploymentId,
      sourceTenantId: manifest.source.tenantId,
      lineageKind: 'full',
      bundleId: manifest.bundleId,
      manifestSha256: portableManifestSha256(manifest),
      changeCursor: manifest.lineage.toChangeCursor,
      exportSequence: manifest.source.exportSequence,
      activatedAt: new Date('2026-07-12T18:04:00.000Z'),
    });
    await expect(
      deltaService.prepare({ tenantId, organizationId, jobId: deltaJob.id, chunkSize: 1 }),
    ).resolves.toEqual({ processed: 1, completed: false });
    await expect(
      repository.findPortablePreflight(tenantId, organizationId, deltaJob.id),
    ).resolves.toMatchObject({
      bundle_id: deltaManifest.bundleId,
      manifest_sha256: portableManifestSha256(deltaManifest),
      source_change_cursor: deltaManifest.lineage.toChangeCursor,
    });
    await repository.advancePortableImportLineageCheckpoint({
      tenantId,
      organizationId,
      jobId: deltaJob.id,
      destinationId: 'deployment_destination',
      sourceDeploymentId: deltaManifest.source.deploymentId,
      sourceTenantId: deltaManifest.source.tenantId,
      lineageKind: 'delta',
      bundleId: deltaManifest.bundleId,
      manifestSha256: portableManifestSha256(deltaManifest),
      changeCursor: deltaManifest.lineage.toChangeCursor,
      exportSequence: deltaManifest.source.exportSequence,
      parentBundleId: manifest.bundleId,
      parentManifestSha256: portableManifestSha256(manifest),
      fromChangeCursor: manifest.lineage.toChangeCursor,
      cutoverFrozenAt: new Date('2026-07-12T18:06:00.000Z'),
      activatedAt: new Date('2026-07-12T18:07:00.000Z'),
    });
    await expect(
      deltaService.prepare({ tenantId, organizationId, jobId: deltaJob.id, chunkSize: 1 }),
    ).rejects.toThrow('PORTABLE_IMPORT_LINEAGE_CUTOVER_FINALIZED');

    const unauthorizedCommitJob = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v1',
      mode: 'commit',
      idempotencyKey: 'portable-unauthorized-commit-integration',
      requestedBy: 'test-user',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: [artifactId],
      },
    });
    await expect(
      service.prepare({
        tenantId,
        organizationId,
        jobId: unauthorizedCommitJob.id,
        chunkSize: 1,
      }),
    ).rejects.toThrow('PORTABILITY_COMMIT_AUTHORIZATION_UNAVAILABLE');
    await expect(
      createRepositoryMigrationActivityService(
        db,
        createProductionMigrationCommitters(db),
      ).beginCommit({
        tenantId,
        organizationId,
        jobId: unauthorizedCommitJob.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow('PORTABILITY_COMMIT_AUTHORIZATION_REQUIRED');
  });
});
