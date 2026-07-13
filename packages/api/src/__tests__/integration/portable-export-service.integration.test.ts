import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  BrandRepository,
  EventRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import {
  parsePortableJson,
  portableManifestSha256,
  type SignedPortableBundle,
} from '@tixkit/portability';
import {
  createPortableExportService,
  type PortableExportArtifactStore,
  type PortableExportMediaStore,
} from '../../services/portable-export.js';
import { loadPublicEventMedia } from '../../routes/modules/public.js';
import { removeEventMedia } from '../../services/event-media.js';
import { parseUploadArtifactMetadata } from '../../services/uploads.js';
import sharp from 'sharp';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const cases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (item) => item.url && (!requestedDriver || item.driver === requestedDriver),
) as DriverCase[];
if (cases.length === 0)
  it.skip('portable export service integration (database URLs not configured)', () => {});

describe.sequential.each(cases)('portable export service: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;
  const objects = new Map<string, Uint8Array>();
  const store: PortableExportArtifactStore = {
    async putIfAbsent(key, bytes) {
      if (objects.has(key)) return 'exists';
      objects.set(key, Uint8Array.from(bytes));
      return 'created';
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error('missing test artifact');
      return Uint8Array.from(value);
    },
  };
  const bundleKeys = generateKeyPairSync('ed25519');
  const payloadKeys = generateKeyPairSync('ed25519');

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (
      await new TenantRepository(db).create({
        name: `Portable API ${driver}`,
      })
    ).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Portable API ${driver}`,
        slug: `portable-api-${driver}`,
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  it('builds, persists, and exactly replays one signed organization artifact', async () => {
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-replay',
    };
    const first = await service.exportConfiguration(request);
    const replay = await service.exportConfiguration(request);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.bundleId).toBe(first.bundleId);
    expect(replay.bytes).toEqual(first.bytes);

    const transport = parsePortableJson(new TextDecoder().decode(first.bytes)) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };
    expect(transport.envelope.manifest).toMatchObject({
      bundleId: first.bundleId,
      mode: 'configuration',
      source: {
        tenantId,
        deploymentId: `deployment_${driver}_01`,
        exportSequence: 1,
      },
    });
    expect(transport.envelope.manifest.source.changeCursor).toMatch(
      /^snapshot-sha256:[a-f0-9]{64}$/u,
    );
    const job = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('id', '=', first.jobId)
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({
      status: 'completed',
      manifest_sha256: portableManifestSha256(transport.envelope.manifest),
      artifact_sha256: createHash('sha256').update(first.bytes).digest('hex'),
    });
    expect(Number(job.artifact_bytes)).toBe(first.bytes.byteLength);
    expect(Object.keys(transport.payloads)).toContain('data/organizations.jsonl');

    await db
      .updateTable('portable_export_jobs')
      .set({ bundle_id: 'bundle_mutated_identity_01' })
      .where('id', '=', first.jobId)
      .execute();
    await expect(service.exportConfiguration(request)).rejects.toThrow(/IMMUTABLE_EVIDENCE/u);
    await db
      .updateTable('portable_export_jobs')
      .set({ bundle_id: first.bundleId })
      .where('id', '=', first.jobId)
      .execute();

    const [key, stored] = [...objects].find(([key]) => key.endsWith(`${first.jobId}.json`))!;
    objects.set(key, Uint8Array.from([...stored.slice(0, -1), stored.at(-1)! ^ 1]));
    await expect(service.exportConfiguration(request)).rejects.toThrow(/EVIDENCE_MISMATCH/u);
  });

  it('exports owned event media as sanitized signed binary assets', async () => {
    const brand = await new BrandRepository(db).create({
      tenantId,
      organizationId,
      name: `Portable media ${driver}`,
      slug: `portable-media-${driver}`,
    });
    const event = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId: brand.id,
      slug: `portable-media-${driver}`,
      title: 'Portable media event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T00:00:00Z'),
    });
    const original = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: '#7c3aed' },
    })
      .jpeg()
      .withMetadata({ orientation: 1 })
      .toBuffer();
    const checksum = createHash('sha256').update(original).digest('hex');
    const now = new Date();
    const uploadId = `upl_media_${driver}`;
    const assetId = `ema_media_${driver}`;
    await db
      .insertInto('upload_artifacts')
      .values({
        id: uploadId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brand.id,
        event_id: event.id,
        created_by_user_id: null,
        purpose: 'event_cover',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'clean',
        bucket: 'media',
        object_key: `uploads/${event.id}/final/${uploadId}.jpg/${checksum}`,
        file_name: 'cover.jpg',
        content_type: 'image/jpeg',
        size_bytes: original.byteLength,
        checksum_sha256: checksum,
        client_token_hash: null,
        metadata: JSON.stringify({ image: { width: 1600, height: 1000, format: 'jpeg' } }),
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('2028-01-01T00:00:00Z'),
        created_at: now,
        updated_at: now,
      })
      .execute();
    const persistedUpload = await db
      .selectFrom('upload_artifacts')
      .select('metadata')
      .where('id', '=', uploadId)
      .executeTakeFirstOrThrow();
    expect(parseUploadArtifactMetadata(persistedUpload.metadata)).toEqual({
      image: { width: 1600, height: 1000, format: 'jpeg' },
    });
    await db
      .insertInto('event_media_assets')
      .values({
        id: assetId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brand.id,
        event_id: event.id,
        upload_artifact_id: uploadId,
        role: 'cover',
        width: 1600,
        height: 1000,
        format: 'jpeg',
        checksum_sha256: checksum,
        size_bytes: original.byteLength,
        focal_x: '0.5',
        focal_y: '0.5',
        alt_text: 'Purple event cover',
        created_by: 'usr_exporter',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_renditions')
      .values({
        id: `emr_media_${driver}`,
        asset_id: assetId,
        variant: 'page',
        width: 1600,
        height: 900,
        format: 'webp',
        content_type: 'image/webp',
        bucket: 'media',
        object_key: `event-media/${event.id}/${assetId}/page.webp`,
        checksum_sha256: 'b'.repeat(64),
        size_bytes: 1024,
        created_at: now,
      })
      .execute();
    expect(await loadPublicEventMedia(db, event.id)).toEqual([
      {
        role: 'cover',
        altText: 'Purple event cover',
        focalPoint: { x: 0.5, y: 0.5 },
        renditions: [
          {
            variant: 'page',
            width: 1600,
            height: 900,
            url: `/v1/public/event-media/renditions/emr_media_${driver}`,
          },
        ],
      },
    ]);
    const mediaStore: PortableExportMediaStore = {
      async read(bucket, objectKey, maximumBytes) {
        expect({ bucket, objectKey, maximumBytes }).toEqual({
          bucket: 'media',
          objectKey: `uploads/${event.id}/final/${uploadId}.jpg/${checksum}`,
          maximumBytes: original.byteLength,
        });
        return original;
      },
    };
    const service = createPortableExportService({
      db,
      store,
      mediaStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const exported = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: `portable-media-${driver}`,
    });
    const transport = parsePortableJson(new TextDecoder().decode(exported.bytes)) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };
    expect(transport.envelope.manifest.assets).toEqual([
      expect.objectContaining({
        portableId: assetId,
        mediaType: 'image/webp',
        role: `event-media:${event.id}:cover:original`,
      }),
    ]);
    const asset = transport.envelope.manifest.assets[0]!;
    const sanitized = Buffer.from(transport.payloads[asset.path]!, 'base64');
    expect(createHash('sha256').update(sanitized).digest('hex')).toBe(asset.sha256);
    const metadata = await sharp(sanitized).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 1600, height: 1000 });
    expect(metadata.exif).toBeUndefined();
    await expect(
      removeEventMedia({
        db,
        tenantId,
        organizationId,
        brandId: brand.id,
        eventId: event.id,
        role: 'cover',
      }),
    ).resolves.toBe(true);
    expect(
      await db
        .selectFrom('media_object_cleanup_jobs')
        .select(['object_key', 'checksum_sha256', 'reason', 'status'])
        .where('reason', '=', 'event-media-removed')
        .execute(),
    ).toEqual([
      expect.objectContaining({
        object_key: `event-media/${event.id}/${assetId}/page.webp`,
        checksum_sha256: 'b'.repeat(64),
        reason: 'event-media-removed',
        status: 'pending',
      }),
    ]);
    await db.deleteFrom('upload_artifacts').where('id', '=', uploadId).execute();
    await db.deleteFrom('events').where('id', '=', event.id).execute();
    await db.deleteFrom('brands').where('id', '=', brand.id).execute();
  });

  it('recovers a verified immutable object after a crash before database completion', async () => {
    let failFirstRead = true;
    const crashStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        if (objects.has(key)) return 'exists';
        objects.set(key, Uint8Array.from(bytes));
        return 'created';
      },
      async get(key) {
        if (failFirstRead) {
          failFirstRead = false;
          throw new Error('simulated crash after immutable put');
        }
        const value = objects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
    };
    const service = createPortableExportService({
      db,
      store: crashStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-crash-recovery',
    };
    await expect(service.exportConfiguration(request)).rejects.toThrow(/simulated crash/u);
    const building = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('portable_export_jobs')
      .set({ build_lease_expires_at: new Date(0) })
      .where('id', '=', building.id)
      .execute();
    await db
      .updateTable('organizations')
      .set({ name: `Changed after crash ${driver}` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();

    const recovered = await service.exportConfiguration(request);
    expect(recovered.jobId).toBe(building.id);
    const completed = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('id', '=', building.id)
      .executeTakeFirstOrThrow();
    expect(completed.status).toBe('completed');
    const transport = parsePortableJson(new TextDecoder().decode(recovered.bytes)) as {
      envelope: SignedPortableBundle;
    };
    expect(completed.source_change_cursor).toBe(transport.envelope.manifest.source.changeCursor);
  });

  it('fences a concurrent same-key builder before any duplicate immutable write', async () => {
    let releasePut!: () => void;
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let putCount = 0;
    const blockedStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        putCount += 1;
        markPutStarted();
        await putReleased;
        if (objects.has(key)) return 'exists';
        objects.set(key, Uint8Array.from(bytes));
        return 'created';
      },
      async get(key) {
        const value = objects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
    };
    const service = createPortableExportService({
      db,
      store: blockedStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-concurrent-build',
    };
    const first = service.exportConfiguration(request);
    await putStarted;
    await expect(service.exportConfiguration(request)).rejects.toThrow(/IN_PROGRESS/u);
    releasePut();
    await expect(first).resolves.toMatchObject({ bundleId: expect.stringMatching(/^bundle_/u) });
    expect(putCount).toBe(1);
  });

  it('exports one repeatable-read snapshot while a concurrent source mutation commits', async () => {
    const before = await db
      .selectFrom('organizations')
      .select('name')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    const changedName = `Concurrent mutation ${driver}`;
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
      async afterSnapshotRead() {
        await db
          .updateTable('organizations')
          .set({ name: changedName })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', organizationId)
          .execute();
      },
    });
    const result = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-repeatable-read',
    });
    const snapshotTransport = parsePortableJson(new TextDecoder().decode(result.bytes)) as {
      payloads: Record<string, string>;
    };
    const organizationRecord = JSON.parse(
      Buffer.from(snapshotTransport.payloads['data/organizations.jsonl']!, 'base64')
        .toString('utf8')
        .trim(),
    ) as { attributes: { name: string } };
    expect(organizationRecord.attributes.name).toBe(before.name);
    expect(organizationRecord.attributes.name).not.toBe(changedName);
    await expect(
      db
        .selectFrom('organizations')
        .select('name')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', organizationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ name: changedName });
  });
});
