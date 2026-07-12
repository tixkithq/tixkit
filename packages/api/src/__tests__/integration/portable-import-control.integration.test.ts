import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  ImportRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import { PortableImportPreflightsMigration } from '@tixkit/db/migrations';
import {
  buildPortableLogicalExport,
  canonicalPortableJson,
  createPortableConfigurationPayloadPolicies,
  portableManifestSha256,
  verifyAndPreflightPortableImport,
} from '@tixkit/portability';
import { attestPortableDryRun } from '../../services/portable-import-control.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const cases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (item) => item.url && (!requestedDriver || item.driver === requestedDriver),
) as DriverCase[];
if (cases.length === 0)
  it.skip('portable import control integration (database URLs not configured)', () => {});

describe.sequential.each(cases)('portable import control: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (await new TenantRepository(db).create({ name: `Portable control ${driver}` })).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Portable control ${driver}`,
        slug: `portable-control-${driver}`,
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  it('persists and exactly replays a signed receipt bound to preflight and staged input', async () => {
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const dryRunKeys = generateKeyPairSync('ed25519');
    const policies = createPortableConfigurationPayloadPolicies();
    const built = buildPortableLogicalExport({
      bundleId: `bundle_control_${driver}`,
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: `deployment_source_${driver}`,
        tenantId: `tenant_source_${driver}`,
        exportSequence: 1,
        changeCursor:
          'snapshot-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0070',
      exportedAt: '2026-07-12T20:00:00.000Z',
      currentTime: '2026-07-12T20:00:00.000Z',
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0069',
        maximumDataSchemaVersion: '0070',
        requiredCapabilities: ['portable-bundle-v1'],
        requiredEntitlements: [],
      },
      sections: new Map([
        [
          'organizations',
          [
            {
              portableId: 'organization_source_01',
              attributes: {
                name: 'Source',
                slug: 'source',
                status: 'active',
                boxOfficeSettings: {
                  enabled: true,
                  allowedTenderTypes: ['cash'],
                  requireBuyerEmail: false,
                  receiptMode: 'email',
                },
                eventDefaults: {},
              },
            },
          ],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
      payloadPolicies: policies,
    });
    const policy = policies.get('organizations')!;
    const destination = {
      deploymentId: `deployment_destination_${driver}`,
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0070',
      capabilities: ['portable-bundle-v1'],
      entitlements: [],
      availableStorageBytes: 1024 * 1024,
      acceptedSourceOperatingModels: ['self-hosted' as const],
    };
    const preflight = verifyAndPreflightPortableImport(
      built.envelope,
      destination,
      new Map([['bundle_key_01', bundleKeys.publicKey]]),
      new Map([['payload_key_01', payloadKeys.publicKey]]),
      new Map([
        [
          'organizations',
          {
            schemaId: policy.schemaId,
            schemaSha256: policy.schemaSha256,
            policySha256: policy.policySha256,
            scannerId: policy.scannerId,
            keyId: 'payload_key_01',
          },
        ],
      ]),
      new Map(),
      new Map(),
    );
    const repository = new ImportRepository(db);
    const job = await repository.createJob({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v1',
      mode: 'dry-run',
      idempotencyKey: 'portable-control-receipt',
      requestedBy: 'user_control',
      configuration: { sourceMode: 'official-export', artifactIds: ['upl_control_01'] },
    });
    await repository.addFile({
      tenantId,
      organizationId,
      jobId: job.id,
      objectKey: `portable-control/${job.id}.json`,
      originalName: 'portable-control.json',
      mediaType: 'application/vnd.tixkit.portable+json',
      byteSize: 1,
      sha256: 'b'.repeat(64),
    });
    await repository.recordPortablePreflight({
      tenantId,
      organizationId,
      jobId: job.id,
      operationId: preflight.operationId,
      bundleId: built.envelope.manifest.bundleId,
      manifestSha256: portableManifestSha256(built.envelope.manifest),
      artifactSha256: 'b'.repeat(64),
      sourceDeploymentId: built.envelope.manifest.source.deploymentId,
      sourceChangeCursor: built.envelope.manifest.lineage.toChangeCursor,
      destinationId: destination.deploymentId,
      manifestJson: canonicalPortableJson(built.envelope.manifest),
      preflightJson: canonicalPortableJson(preflight),
      expectedCounts: canonicalPortableJson(built.envelope.manifest.entityCounts),
      expectedAssets: canonicalPortableJson([]),
      requiredRebindings: canonicalPortableJson(preflight.requiredRebindings),
    });
    const request = {
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      inputSha256: 'c'.repeat(64),
      createdBy: 'user_control',
      attestation: {
        keyId: 'dry_run_key_01',
        privateKey: dryRunKeys.privateKey,
        trustedPublicKeys: new Map([['dry_run_key_01', dryRunKeys.publicKey]]),
      },
      checkedAt: '2026-07-12T21:00:00.000Z',
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        attestPortableDryRun({ ...request, createdBy: `user_control_${index}` }),
      ),
    );
    const first = concurrent[0]!;
    expect(
      concurrent.every((candidate) => JSON.stringify(candidate) === JSON.stringify(first)),
    ).toBe(true);
    const replay = await attestPortableDryRun({
      ...request,
      checkedAt: '2026-07-13T21:00:00.000Z',
    });
    expect(replay).toEqual(first);
    const rotatedKeys = generateKeyPairSync('ed25519');
    await expect(
      attestPortableDryRun({
        ...request,
        attestation: {
          keyId: 'dry_run_key_02',
          privateKey: rotatedKeys.privateKey,
          trustedPublicKeys: new Map([
            ['dry_run_key_01', dryRunKeys.publicKey],
            ['dry_run_key_02', rotatedKeys.publicKey],
          ]),
        },
      }),
    ).resolves.toEqual(first);
    await expect(
      attestPortableDryRun({
        ...request,
        attestation: {
          keyId: 'dry_run_key_02',
          privateKey: rotatedKeys.privateKey,
          trustedPublicKeys: new Map([['dry_run_key_02', rotatedKeys.publicKey]]),
        },
      }),
    ).rejects.toThrow(/RECEIPT_INVALID/u);
    expect(first.receipt).toMatchObject({
      operationId: preflight.operationId,
      manifestSha256: portableManifestSha256(built.envelope.manifest),
      destinationId: destination.deploymentId,
      sourceChangeCursor: built.envelope.manifest.lineage.toChangeCursor,
      inputSha256: request.inputSha256,
      artifactSha256: 'b'.repeat(64),
      compatible: true,
      attestationKeyId: 'dry_run_key_01',
    });
    await expect(attestPortableDryRun({ ...request, inputSha256: 'd'.repeat(64) })).rejects.toThrow(
      /INPUT_CHANGED/u,
    );
    await expect(
      db
        .updateTable('portable_import_preflights')
        .set({ manifest_sha256: 'e'.repeat(64) })
        .where('import_job_id', '=', job.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .updateTable('portable_import_dry_run_receipts')
        .set({ input_sha256: 'e'.repeat(64) })
        .where('import_job_id', '=', job.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .deleteFrom('portable_import_dry_run_receipts')
        .where('import_job_id', '=', job.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await truncateAllData(db);
    await PortableImportPreflightsMigration.down!(db);
    await PortableImportPreflightsMigration.up(db);
    await expect(
      db.selectFrom('portable_import_preflights').selectAll().execute(),
    ).resolves.toEqual([]);
  });
});
