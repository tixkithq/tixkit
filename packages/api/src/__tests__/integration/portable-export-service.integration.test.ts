import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
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
} from '../../services/portable-export.js';

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
