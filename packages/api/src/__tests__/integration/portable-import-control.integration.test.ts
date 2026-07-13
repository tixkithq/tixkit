import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, WorkflowClient } from '@temporalio/client';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@tixkit/domain';
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
import { PortableImportApprovalsMigration } from '@tixkit/db/migrations';
import { PortableImportRebindingsMigration } from '@tixkit/db/migrations';
import { PortableImportCommitAuthorizationsMigration } from '@tixkit/db/migrations';
import { PortableImportCutoverProofsMigration } from '@tixkit/db/migrations';
import { ImportEventImmutabilityMigration } from '@tixkit/db/migrations';
import {
  buildPortableLogicalExport,
  canonicalPortableJson,
  createPortableCutoverProof,
  createPortableConfigurationPayloadPolicies,
  portableManifestSha256,
  verifyAndPreflightPortableImport,
  verifyPortableDryRunReceipt,
  type PortableDryRunReceipt,
} from '@tixkit/portability';
import {
  approvePortableImport,
  attestPortableDryRun,
  authorizePortableImportCommit,
  bindPortableImportDestination,
  createLocalPortableDryRunAttestation,
  portableImportCurrentInputHash,
  revokePortableImportApproval,
  validatePortableImportApproval,
} from '../../services/portable-import-control.js';
import { registerErrorHandler } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import { uploadRoutes } from '../../routes/modules/uploads.js';
import {
  createProductionMigrationCommitters,
  createMigrationPreparationService,
  createRepositoryMigrationActivityService,
  validatePortableCommitCutoverEvidence,
  MIGRATION_COMMIT_STAGES,
  MIGRATION_SIDE_EFFECT_POLICY,
  migrationCommitWorkflow,
} from '@tixkit/workflows';

type MigrationProcessWorker = {
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function errorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'number') return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function startMigrationProcessWorker(input: {
  driver: 'postgres' | 'mysql';
  databaseUrl: string;
  taskQueue: string;
  crashAfterStage?: string;
}): MigrationProcessWorker {
  const fixture = fileURLToPath(
    new URL(
      '../../../../workflows/src/__tests__/fixtures/migration-process-worker.ts',
      import.meta.url,
    ),
  );
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fixture], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_DRIVER: input.driver,
      TIXKIT_TEST_DATABASE_URL: input.databaseUrl,
      TIXKIT_MIGRATION_TASK_QUEUE: input.taskQueue,
      ...(input.crashAfterStage
        ? { TIXKIT_MIGRATION_CRASH_AFTER_ROW_STAGE: input.crashAfterStage }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-65_536);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let spawnError: Error | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitForExit = async (timeoutMs: number) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Migration worker pid ${child.pid ?? 'unknown'} did not exit`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  return {
    async waitFor(text, timeoutMs = 20_000) {
      const startedAt = Date.now();
      while (!output.includes(text)) {
        if (spawnError)
          throw new Error(`Migration worker failed to spawn\n${output}`, { cause: spawnError });
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Migration worker exited before ${text}\n${output}`);
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for ${text}\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null)
        return { code: child.exitCode, signal: child.signalCode };
      if (spawnError) throw spawnError;
      child.kill(signal);
      try {
        return await waitForExit(10_000);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try {
          return await waitForExit(5_000);
        } catch (forcedExitError) {
          throw new Error(
            `Migration worker pid ${child.pid ?? 'unknown'} could not be stopped after graceful wait failed: ${String(error)}`,
            { cause: forcedExitError },
          );
        }
      }
    },
  };
}

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };

function testObjectStore(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    },
  });
}

async function ensureTestObjectStoreBucket(client: S3Client): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'tixkit' }));
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
  }
}

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
    tenantId = (
      await new TenantRepository(db).create({
        name: `Portable control ${driver}`,
      })
    ).id;
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
    const cutoverKeys = generateKeyPairSync('ed25519');
    const policies = createPortableConfigurationPayloadPolicies();
    const built = buildPortableLogicalExport({
      bundleId: `bundle_control_${driver}`,
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: `deployment_source_${driver}`,
        tenantId: `tenant_source_${driver}`,
        organizationId: `organization_source_${driver}`,
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
      rebindings: [
        {
          kind: 'provider_account',
          portableId: 'provider_stripe',
          required: true,
        },
        {
          kind: 'email_delivery_route',
          portableId: 'email_route_optional',
          required: false,
        },
      ],
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
      bundleSigning: {
        keyId: 'bundle_key_01',
        privateKey: bundleKeys.privateKey,
      },
      payloadSigning: {
        keyId: 'payload_key_01',
        privateKey: payloadKeys.privateKey,
      },
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
      configuration: {
        sourceMode: 'official-export',
        artifactIds: ['upl_control_01'],
      },
    });
    const controlObjectKey = `portable-control/${job.id}.json`;
    const controlNow = new Date();
    await db
      .insertInto('upload_artifacts')
      .values({
        id: 'upl_control_01',
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: null,
        event_id: null,
        created_by_user_id: 'user_control',
        purpose: 'migration_import',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: null,
        bucket: 'tixkit',
        object_key: controlObjectKey,
        file_name: 'portable-control.json',
        content_type: 'application/vnd.tixkit.portable+json',
        size_bytes: 1,
        checksum_sha256: 'b'.repeat(64),
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: controlNow,
        expires_at: new Date(controlNow.getTime() + 30 * 24 * 60 * 60 * 1000),
        created_at: controlNow,
        updated_at: controlNow,
      })
      .execute();
    await repository.addFile({
      tenantId,
      organizationId,
      jobId: job.id,
      objectKey: controlObjectKey,
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
      requiredRebindings: canonicalPortableJson(preflight.rebindings),
    });
    await repository.addRows(tenantId, organizationId, job.id, [
      {
        entityType: 'organization',
        externalId: 'organization_source_01',
        rowNumber: 1,
        status: 'validated',
        sourceData: { portableId: 'organization_source_01' },
        normalizedData: {
          entityType: 'organization',
          externalId: 'organization_source_01',
          attributes: { name: 'Source' },
        },
      },
    ]);
    const currentInputSha256 = await portableImportCurrentInputHash({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      sourceSystem: 'tixkit-portable',
    });
    const request = {
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      inputSha256: currentInputSha256,
      createdBy: 'user_control',
      attestation: createLocalPortableDryRunAttestation({
        keyId: 'dry_run_key_01',
        privateKey: dryRunKeys.privateKey,
        trustedPublicKeys: new Map([['dry_run_key_01', dryRunKeys.publicKey]]),
      }),
      checkedAt: '2026-07-12T21:00:00.000Z',
    };
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        attestPortableDryRun({
          ...request,
          createdBy: `user_control_${index}`,
        }),
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
        attestation: createLocalPortableDryRunAttestation({
          keyId: 'dry_run_key_02',
          privateKey: rotatedKeys.privateKey,
          trustedPublicKeys: new Map([
            ['dry_run_key_01', dryRunKeys.publicKey],
            ['dry_run_key_02', rotatedKeys.publicKey],
          ]),
        }),
      }),
    ).resolves.toEqual(first);
    await expect(
      attestPortableDryRun({
        ...request,
        attestation: createLocalPortableDryRunAttestation({
          keyId: 'dry_run_key_02',
          privateKey: rotatedKeys.privateKey,
          trustedPublicKeys: new Map([['dry_run_key_02', rotatedKeys.publicKey]]),
        }),
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
    await repository.transitionJob({
      tenantId,
      organizationId,
      jobId: job.id,
      from: ['pending'],
      to: 'ready',
      summary: { accepted: true, inputHash: request.inputSha256 },
    });
    const approvalRequest = {
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      approvedBy: 'user_approver',
      idempotencyKey: 'portable-approval-01',
      confirmation: `approve:${job.id}:${first.receiptSha256}`,
      attestation: request.attestation,
      now: new Date('2026-07-12T21:05:00.000Z'),
    };
    await db
      .updateTable('import_jobs')
      .set({ configuration: JSON.stringify({ changed: true }) })
      .where('id', '=', job.id)
      .execute();
    await expect(approvePortableImport(approvalRequest)).rejects.toThrow(/APPROVAL_INPUT_CHANGED/u);
    await db
      .updateTable('import_jobs')
      .set({ configuration: job.configuration })
      .where('id', '=', job.id)
      .execute();
    await expect(approvePortableImport(approvalRequest)).rejects.toThrow(
      /PORTABLE_IMPORT_REBINDINGS_REQUIRED/u,
    );
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'acct_revoked_before_approval',
      registeredBy: 'system_test',
    });
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'destination_email_route_01',
      registeredBy: 'system_test',
    });
    await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_revoked_before_approval',
      boundBy: 'user_approver',
    });
    expect(
      await repository.revokePortableDestinationResource({
        tenantId,
        organizationId,
        kind: 'provider_account',
        resourceId: 'acct_revoked_before_approval',
      }),
    ).toBe(true);
    await expect(approvePortableImport(approvalRequest)).rejects.toThrow(
      /REBINDING_DESTINATION_NOT_FOUND/u,
    );
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'acct_destination_01',
      registeredBy: 'system_test',
    });
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'acct_destination_changed',
      registeredBy: 'system_test',
    });
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'acct_authorization_lock_race',
      registeredBy: 'system_test',
    });
    let releaseAuthorizationLock!: () => void;
    const authorizationMayFinish = new Promise<void>((resolve) => {
      releaseAuthorizationLock = resolve;
    });
    let authorizationLocked!: () => void;
    const authorizationHasLock = new Promise<void>((resolve) => {
      authorizationLocked = resolve;
    });
    const authorization = db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (transaction) => {
        const locked = await new ImportRepository(
          transaction as Database,
        ).findPortableDestinationResource({
          tenantId,
          organizationId,
          kind: 'provider_account',
          resourceId: 'acct_authorization_lock_race',
          lockForAuthorization: true,
        });
        expect(locked?.resource_id).toBe('acct_authorization_lock_race');
        authorizationLocked();
        await authorizationMayFinish;
      });
    await authorizationHasLock;
    let revocationCompleted = false;
    const concurrentRevocation = repository
      .revokePortableDestinationResource({
        tenantId,
        organizationId,
        kind: 'provider_account',
        resourceId: 'acct_authorization_lock_race',
      })
      .then((revoked) => {
        revocationCompleted = true;
        return revoked;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationCompleted).toBe(false);
    releaseAuthorizationLock();
    await authorization;
    await expect(concurrentRevocation).resolves.toBe(true);
    const otherOrganizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Portable control other ${driver}`,
        slug: `portable-control-other-${driver}`,
      })
    ).id;
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId: otherOrganizationId,
      kind: 'provider_account',
      resourceId: 'acct_other_tenant_scope',
      registeredBy: 'system_test',
    });
    await expect(
      bindPortableImportDestination({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        portableId: 'provider_stripe',
        destinationReference: 'acct_other_tenant_scope',
        boundBy: 'user_approver',
      }),
    ).rejects.toThrow(/DESTINATION_NOT_FOUND/u);
    await expect(
      bindPortableImportDestination({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        portableId: 'provider_stripe',
        destinationReference: 'sk_live_secret_material',
        boundBy: 'user_approver',
      }),
    ).rejects.toThrow(/REFERENCE_INVALID/u);
    const binding = await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_destination_01',
      boundBy: 'user_approver',
      now: new Date('2026-07-12T21:04:00.000Z'),
    });
    expect(binding.kind).toBe('provider_account');
    await expect(
      bindPortableImportDestination({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        portableId: 'provider_unknown',
        destinationReference: 'acct_destination_02',
        boundBy: 'user_approver',
      }),
    ).rejects.toThrow(/REBINDING_NOT_REQUIRED/u);
    const concurrentApprovals = await Promise.all(
      Array.from({ length: 4 }, () => approvePortableImport(approvalRequest)),
    );
    const approval = concurrentApprovals[0]!;
    expect(concurrentApprovals.every((candidate) => candidate.id === approval.id)).toBe(true);
    await expect(
      approvePortableImport({
        ...approvalRequest,
        now: new Date('2026-07-12T21:06:00.000Z'),
      }),
    ).resolves.toEqual(approval);
    await expect(
      approvePortableImport({ ...approvalRequest, approvedBy: 'user_other' }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/u);
    const concurrentDifferentKeys = await Promise.all(
      ['portable-approval-parallel-a', 'portable-approval-parallel-b'].map((idempotencyKey) =>
        approvePortableImport({
          ...approvalRequest,
          idempotencyKey,
          now: new Date('2026-07-12T21:05:30.000Z'),
        }),
      ),
    );
    expect(concurrentDifferentKeys[0]!.id).toBe(concurrentDifferentKeys[1]!.id);
    const commitConfirmation = `commit:${job.id}:${approval.id}:${approval.approval_digest}`;
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: commitConfirmation,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:06:00.000Z'),
      }),
    ).resolves.toEqual(approval);
    await expect(
      bindPortableImportDestination({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        portableId: 'email_route_optional',
        destinationReference: 'destination_email_route_01',
        boundBy: 'user_approver',
      }),
    ).rejects.toThrow(/DESTINATION_NOT_FOUND/u);
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'email_delivery_route',
      resourceId: 'destination_email_route_01',
      registeredBy: 'system_test',
    });
    await expect(
      bindPortableImportDestination({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        portableId: 'email_route_optional',
        destinationReference: 'destination_email_route_01',
        boundBy: 'user_approver',
      }),
    ).resolves.toMatchObject({ kind: 'email_delivery_route' });
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: commitConfirmation,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:06:00.000Z'),
      }),
    ).rejects.toThrow(/APPROVAL_INPUT_CHANGED/u);
    await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_destination_changed',
      boundBy: 'user_approver',
    });
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: commitConfirmation,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:06:00.000Z'),
      }),
    ).rejects.toThrow(/APPROVAL_INPUT_CHANGED/u);
    await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_destination_01',
      boundBy: 'user_approver',
    });
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: 'commit:substituted',
        attestation: request.attestation,
        now: new Date('2026-07-12T21:06:00.000Z'),
      }),
    ).rejects.toThrow(/CONFIRMATION_INVALID/u);
    await revokePortableImportApproval({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      approvalId: approval.id,
      revokedBy: 'user_approver',
      reason: 'Operator cancelled cutover',
      now: new Date('2026-07-12T21:06:00.000Z'),
    });
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: commitConfirmation,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:07:00.000Z'),
      }),
    ).rejects.toThrow(/APPROVAL_REQUIRED/u);
    const renewed = await approvePortableImport({
      ...approvalRequest,
      idempotencyKey: 'portable-approval-02',
      now: new Date('2026-07-12T21:07:00.000Z'),
    });
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: `commit:${job.id}:${renewed.id}:${renewed.approval_digest}`,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:18:00.000Z'),
      }),
    ).rejects.toThrow(/APPROVAL_REQUIRED/u);
    await expect(
      db
        .updateTable('portable_import_approvals')
        .set({ approval_digest: 'f'.repeat(64) })
        .where('id', '=', approval.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .deleteFrom('portable_import_approval_revocations')
        .where('approval_id', '=', approval.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await repository.registerPortableDestinationResource({
      tenantId,
      organizationId,
      kind: 'provider_account',
      resourceId: 'acct_revoked_after_approval',
      registeredBy: 'system_test',
    });
    await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_revoked_after_approval',
      boundBy: 'user_approver',
    });
    const destinationRevocationApproval = await approvePortableImport({
      ...approvalRequest,
      idempotencyKey: 'portable-approval-destination-revocation',
      now: new Date('2026-07-12T21:07:00.000Z'),
    });
    expect(
      await repository.revokePortableDestinationResource({
        tenantId,
        organizationId,
        kind: 'provider_account',
        resourceId: 'acct_revoked_after_approval',
      }),
    ).toBe(true);
    await expect(
      validatePortableImportApproval({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: `commit:${job.id}:${destinationRevocationApproval.id}:${destinationRevocationApproval.approval_digest}`,
        attestation: request.attestation,
        now: new Date('2026-07-12T21:08:00.000Z'),
      }),
    ).rejects.toThrow(/REBINDING_DESTINATION_NOT_FOUND/u);
    await bindPortableImportDestination({
      db,
      tenantId,
      organizationId,
      jobId: job.id,
      portableId: 'provider_stripe',
      destinationReference: 'acct_destination_01',
      boundBy: 'user_approver',
    });
    let activePrincipal: Principal = {
      type: 'user',
      id: 'user_route_approver',
      tenantId,
      organizationIds: [organizationId],
      scopes: ['migrations.commit'],
    };
    const cutoverIssuedAt = new Date();
    const cutoverProof = createPortableCutoverProof(
      {
        tenantId: built.envelope.manifest.source.tenantId,
        deploymentId: built.envelope.manifest.source.deploymentId,
        sourceChangeCursor: built.envelope.manifest.lineage.toChangeCursor,
        observedAt: cutoverIssuedAt.toISOString(),
        sourceFrozen: true,
        bundleId: built.envelope.manifest.bundleId,
        manifestSha256: portableManifestSha256(built.envelope.manifest),
        destinationId: destination.deploymentId,
        operationId: preflight.operationId,
        issuedAt: cutoverIssuedAt.toISOString(),
        expiresAt: new Date(cutoverIssuedAt.getTime() + 5 * 60_000).toISOString(),
        nonce: `cutover_route_${driver}_01`,
      },
      'cutover_key_01',
      cutoverKeys.privateKey,
    );
    const startedCommits: string[] = [];
    const routeErrors: Error[] = [];
    const app = Fastify();
    app.decorate('context', {
      db,
      portableDryRunAttestation: request.attestation,
      portableCutoverTrust: {
        trustedPublicKeys: new Map([['cutover_key_01', cutoverKeys.publicKey]]),
      },
      temporalClient: {
        startMigrationCommit: async ({ jobId: startedJobId }: { jobId: string }) => {
          startedCommits.push(startedJobId);
        },
      },
    } as never);
    app.addHook('preHandler', async (fastifyRequest) => {
      fastifyRequest.principal = activePrincipal;
    });
    app.addHook('onError', async (_request, _reply, error) => {
      routeErrors.push(error);
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    const routeHeaders = {
      'idempotency-key': 'portable-approval-route-01',
      'x-tixkit-confirmation': `approve:${job.id}:${first.receiptSha256}`,
    };
    activePrincipal = { ...activePrincipal, scopes: ['migrations.read'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/portable-approval`,
          headers: routeHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    activePrincipal = {
      ...activePrincipal,
      scopes: ['migrations.commit'],
      eventIds: ['event_scoped_route_01'],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/portable-approval`,
          headers: routeHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    activePrincipal = {
      ...activePrincipal,
      eventIds: undefined,
      organizationIds: ['organization_outside_scope'],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/portable-approval`,
          headers: routeHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    activePrincipal = {
      ...activePrincipal,
      organizationIds: [organizationId],
    };
    activePrincipal = { ...activePrincipal, scopes: ['migrations.read'] };
    const rebindingStatus = await app.inject({
      method: 'GET',
      url: `/migration-jobs/${job.id}/portable-rebindings`,
    });
    expect(rebindingStatus.statusCode, rebindingStatus.body).toBe(200);
    expect(rebindingStatus.json()).toMatchObject({ complete: true });
    activePrincipal = { ...activePrincipal, scopes: ['migrations.write'] };
    const routeRebinding = await app.inject({
      method: 'PUT',
      url: `/migration-jobs/${job.id}/portable-rebindings/provider_stripe`,
      payload: { destinationReference: 'acct_destination_01' },
    });
    expect(routeRebinding.statusCode, routeRebinding.body).toBe(200);
    expect(routeRebinding.json()).toMatchObject({
      portableId: 'provider_stripe',
      destinationReference: 'acct_destination_01',
    });
    activePrincipal = { ...activePrincipal, scopes: ['migrations.commit'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/portable-approval`,
          headers: routeHeaders,
          payload: [],
        })
      ).statusCode,
    ).toBe(400);
    const approvedResponse = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/portable-approval`,
      headers: routeHeaders,
      payload: {},
    });
    expect(approvedResponse.statusCode, approvedResponse.body).toBe(201);
    const approvedBody = approvedResponse.json<{
      approvalId: string;
      approvalDigest: string;
      commitConfirmation: string;
    }>();
    const replayResponse = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/portable-approval`,
      headers: routeHeaders,
      payload: {},
    });
    expect(replayResponse.statusCode).toBe(201);
    expect(replayResponse.json()).toEqual(approvedResponse.json());
    const persistedApproval = await repository.findPortableImportApproval({
      tenantId,
      organizationId,
      jobId: job.id,
      approvalId: approvedBody.approvalId,
    });
    expect(persistedApproval).toBeDefined();
    const proveWorkerCutoverGate = async (proofJson?: string) => {
      await expect(
        db
          .transaction()
          .setIsolationLevel('serializable')
          .execute(async (transaction) => {
            const transactionDatabase = transaction as Database;
            const transactionRepository = new ImportRepository(transactionDatabase);
            if (proofJson)
              await transactionRepository.recordPortableImportCutoverProof({
                tenantId,
                organizationId,
                jobId: job.id,
                keyId: cutoverProof.keyId,
                nonce: cutoverProof.nonce,
                receiptSha256: cutoverProof.receiptSha256,
                proofJson,
                validatedBy: activePrincipal.id,
                validatedAt: new Date(),
              });
            await transactionRepository.authorizePortableImportCommit({
              tenantId,
              organizationId,
              jobId: job.id,
              approvalId: persistedApproval!.id,
              approvalDigest: persistedApproval!.approval_digest,
              inputSha256: persistedApproval!.input_sha256,
              rebindingsSha256: persistedApproval!.rebindings_sha256,
              authorizedBy: persistedApproval!.approved_by,
              authorizedAt: new Date(persistedApproval!.created_at),
            });
            await expect(
              validatePortableCommitCutoverEvidence(transactionRepository, {
                tenantId,
                organizationId,
                jobId: job.id,
              }),
            ).rejects.toThrow(
              proofJson
                ? /PORTABILITY_COMMIT_CUTOVER_PROOF_INVALID/u
                : /PORTABILITY_COMMIT_CUTOVER_PROOF_REQUIRED/u,
            );
            throw new Error('ROLLBACK_WORKER_CUTOVER_GATE_PROOF');
          }),
      ).rejects.toThrow('ROLLBACK_WORKER_CUTOVER_GATE_PROOF');
    };
    await proveWorkerCutoverGate();
    await proveWorkerCutoverGate(
      canonicalPortableJson({
        ...cutoverProof,
        destinationId: 'deployment_wrong_destination',
      }),
    );
    await expect(
      authorizePortableImportCommit({
        db,
        tenantId,
        organizationId,
        jobId: job.id,
        confirmation: approvedBody.commitConfirmation,
        attestation: request.attestation,
        cutoverProof,
        cutoverTrust: {
          trustedPublicKeys: new Map([['cutover_key_01', cutoverKeys.publicKey]]),
        },
        authorizedBy: activePrincipal.id,
        checkpoint: () => {
          throw new Error('FORCED_FAILURE_AFTER_CUTOVER_PROOF');
        },
      }),
    ).rejects.toThrow('FORCED_FAILURE_AFTER_CUTOVER_PROOF');
    expect(
      await repository.findPortableImportCutoverProof(tenantId, organizationId, job.id),
    ).toBeUndefined();
    expect(
      await repository.findPortableImportCommitAuthorization(tenantId, organizationId, job.id),
    ).toBeUndefined();
    expect((await repository.findJob(tenantId, organizationId, job.id))?.mode).toBe('dry-run');
    const untrustedRouteKeys = generateKeyPairSync('ed25519');
    app.context.portableDryRunAttestation = createLocalPortableDryRunAttestation({
      keyId: 'route_untrusted_key',
      privateKey: untrustedRouteKeys.privateKey,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/commit`,
          headers: {
            'x-tixkit-confirmation': approvedBody.commitConfirmation,
          },
          payload: { cutoverProof },
        })
      ).statusCode,
    ).toBe(503);
    app.context.portableDryRunAttestation = request.attestation;
    const previousCutoverTrust = process.env.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS;
    delete process.env.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS;
    app.context.portableCutoverTrust = undefined;
    const missingCutoverTrust = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
      payload: { cutoverProof },
    });
    expect(missingCutoverTrust.statusCode, missingCutoverTrust.body).toBe(503);
    if (previousCutoverTrust === undefined)
      delete process.env.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS;
    else process.env.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS = previousCutoverTrust;
    app.context.portableCutoverTrust = {
      trustedPublicKeys: new Map([['cutover_key_01', cutoverKeys.publicKey]]),
    };
    const invalidCutover = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
      payload: {
        cutoverProof: {
          ...cutoverProof,
          destinationId: 'deployment_wrong_destination',
        },
      },
    });
    expect(invalidCutover.statusCode, invalidCutover.body).toBe(409);
    const authorizedCommits = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/commit`,
          headers: {
            'x-tixkit-confirmation': approvedBody.commitConfirmation,
          },
          payload: { cutoverProof },
        }),
      ),
    );
    for (const validCommit of authorizedCommits) {
      expect(
        validCommit.statusCode,
        `${validCommit.body}\n${routeErrors.map((error) => error.stack ?? error.message).join('\n')}`,
      ).toBe(202);
      expect(validCommit.json()).toMatchObject({
        jobId: job.id,
        status: 'committing',
      });
    }
    expect(startedCommits).toEqual([job.id, job.id]);
    const authorizationCount = await db
      .selectFrom('portable_import_commit_authorizations')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(authorizationCount.count)).toBe(1);
    const cutoverCount = await db
      .selectFrom('portable_import_cutover_proofs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(Number(cutoverCount.count)).toBe(1);
    const createNonceProbeJob = async (suffix: string) => {
      const probe = await repository.createJob({
        tenantId,
        organizationId,
        sourceSystem: 'tixkit-portable',
        adapterVersion: 'tixkit-portable-bundle-v1',
        mode: 'dry-run',
        idempotencyKey: `portable-cutover-nonce-${driver}-${suffix}`,
        requestedBy: 'user_route_approver',
        configuration: {
          sourceMode: 'official-export',
          artifactIds: [`upl_${suffix}`],
        },
      });
      await repository.recordPortablePreflight({
        tenantId,
        organizationId,
        jobId: probe.id,
        operationId: `operation_nonce_${driver}_${suffix}`,
        bundleId: built.envelope.manifest.bundleId,
        manifestSha256: portableManifestSha256(built.envelope.manifest),
        artifactSha256: 'd'.repeat(64),
        sourceDeploymentId: built.envelope.manifest.source.deploymentId,
        sourceChangeCursor: built.envelope.manifest.lineage.toChangeCursor,
        destinationId: destination.deploymentId,
        manifestJson: canonicalPortableJson(built.envelope.manifest),
        preflightJson: canonicalPortableJson(preflight),
        expectedCounts: canonicalPortableJson(built.envelope.manifest.entityCounts),
        expectedAssets: canonicalPortableJson([]),
        requiredRebindings: canonicalPortableJson(preflight.rebindings),
      });
      return probe;
    };
    const duplicateNonceJob = await createNonceProbeJob('duplicate');
    await expect(
      repository.recordPortableImportCutoverProof({
        tenantId,
        organizationId,
        jobId: duplicateNonceJob.id,
        keyId: cutoverProof.keyId,
        nonce: cutoverProof.nonce,
        receiptSha256: cutoverProof.receiptSha256,
        proofJson: canonicalPortableJson(cutoverProof),
        validatedBy: 'user_route_approver',
        validatedAt: new Date(),
      }),
    ).rejects.toThrow(/CUTOVER_PROOF_ALREADY_CONSUMED/u);
    const {
      keyId: _keyId,
      receiptSha256: _receipt,
      signature: _signature,
      ...unsignedProof
    } = cutoverProof;
    const aliasProof = createPortableCutoverProof(
      unsignedProof,
      'cutover_key_alias',
      cutoverKeys.privateKey,
    );
    const aliasNonceJob = await createNonceProbeJob('alias');
    await expect(
      repository.recordPortableImportCutoverProof({
        tenantId,
        organizationId,
        jobId: aliasNonceJob.id,
        keyId: aliasProof.keyId,
        nonce: aliasProof.nonce,
        receiptSha256: aliasProof.receiptSha256,
        proofJson: canonicalPortableJson(aliasProof),
        validatedBy: 'user_route_approver',
        validatedAt: new Date(),
      }),
    ).resolves.toMatchObject({
      key_id: 'cutover_key_alias',
      nonce: cutoverProof.nonce,
    });
    await expect(
      db.deleteFrom('portable_import_cutover_proofs').where('import_job_id', '=', job.id).execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .updateTable('portable_import_commit_authorizations')
        .set({ approval_digest: 'f'.repeat(64) })
        .where('import_job_id', '=', job.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .deleteFrom('portable_import_commit_authorizations')
        .where('import_job_id', '=', job.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    const workerService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    await db
      .updateTable('import_jobs')
      .set({
        configuration: JSON.stringify({ changedAfterAuthorization: true }),
      })
      .where('id', '=', job.id)
      .execute();
    await expect(
      workerService.beginCommit({
        tenantId,
        organizationId,
        jobId: job.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).rejects.toThrow(/PORTABILITY_COMMIT_INPUT_CHANGED/u);
    await db
      .updateTable('import_jobs')
      .set({ configuration: job.configuration })
      .where('id', '=', job.id)
      .execute();
    await workerService.beginCommit({
      tenantId,
      organizationId,
      jobId: job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect((await repository.findJob(tenantId, organizationId, job.id))?.status).toBe('committing');
    for (const stage of MIGRATION_COMMIT_STAGES) {
      const result = await workerService.processStage(
        {
          tenantId,
          organizationId,
          jobId: job.id,
          sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
        },
        { stage, claimOwner: `portable-round-trip:${stage}`, chunkSize: 100 },
      );
      expect(result.complete).toBe(true);
    }
    const organizationReference = await repository.findExternalReference({
      tenantId,
      organizationId,
      sourceSystem: 'tixkit-portable',
      entityType: 'organization',
      externalId: 'organization_source_01',
    });
    expect(organizationReference).toBeDefined();
    await db
      .updateTable('external_references')
      .set({ tixkit_id: 'organization_alias_collision' })
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', organizationReference!.id)
      .execute();
    await expect(
      workerService.reconcile({
        tenantId,
        organizationId,
        jobId: job.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).resolves.toEqual({ repaired: 0, unresolved: 1 });
    await db
      .updateTable('external_references')
      .set({ tixkit_id: organizationReference!.tixkit_id })
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', organizationReference!.id)
      .execute();
    const committedOrganization = await db
      .selectFrom('organizations')
      .select('name')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('organizations')
      .set({ name: 'Tampered before reconciliation' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    await expect(
      workerService.reconcile({
        tenantId,
        organizationId,
        jobId: job.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).resolves.toEqual({ repaired: 0, unresolved: 1 });
    await db
      .updateTable('organizations')
      .set({ name: committedOrganization.name })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    await expect(
      workerService.reconcile({
        tenantId,
        organizationId,
        jobId: job.id,
        sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
      }),
    ).resolves.toEqual({ repaired: 0, unresolved: 0 });
    await workerService.completeCommit({
      tenantId,
      organizationId,
      jobId: job.id,
      sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
    });
    expect((await repository.findJob(tenantId, organizationId, job.id))?.status).toBe('committed');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/activate`,
          headers: { 'x-tixkit-confirmation': 'activate:wrong' },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    await db
      .updateTable('organizations')
      .set({ name: 'Tampered after green reconciliation' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    const staleActivation = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/activate`,
      headers: { 'x-tixkit-confirmation': `activate:${job.id}` },
      payload: {},
    });
    expect(staleActivation.statusCode, staleActivation.body).toBe(409);
    await db
      .updateTable('organizations')
      .set({ name: committedOrganization.name })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    const initialActivations = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/activate`,
          headers: { 'x-tixkit-confirmation': `activate:${job.id}` },
          payload: {},
        }),
      ),
    );
    const activation = initialActivations[0]!;
    for (const response of initialActivations) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ jobId: job.id, status: 'activated' });
    }
    const activationEventCount = await db
      .selectFrom('import_job_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('import_job_id', '=', job.id)
      .where('event_key', '=', 'commit:activated')
      .executeTakeFirstOrThrow();
    expect(Number(activationEventCount.count)).toBe(1);
    await db
      .updateTable('organizations')
      .set({ name: 'Legitimate post-activation edit' })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    const activationRetry = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/activate`,
      headers: { 'x-tixkit-confirmation': `activate:${job.id}` },
      payload: {},
    });
    expect(activationRetry.statusCode, activationRetry.body).toBe(200);
    expect(activationRetry.json()).toEqual(activation.json());
    const concurrentActivationRetries = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({
          method: 'POST',
          url: `/migration-jobs/${job.id}/activate`,
          headers: { 'x-tixkit-confirmation': `activate:${job.id}` },
          payload: {},
        }),
      ),
    );
    for (const retry of concurrentActivationRetries) {
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toEqual(activation.json());
    }
    await expect(
      db
        .updateTable('import_job_events')
        .set({ message: 'tampered activation evidence' })
        .where('import_job_id', '=', job.id)
        .where('event_key', '=', 'commit:activated')
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db
        .deleteFrom('import_job_events')
        .where('import_job_id', '=', job.id)
        .where('event_key', '=', 'commit:activated')
        .execute(),
    ).rejects.toThrow(/immutable/u);
    const lostResponseRetry = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
      payload: { cutoverProof },
    });
    expect(lostResponseRetry.statusCode, lostResponseRetry.body).toBe(202);
    expect(lostResponseRetry.json()).toEqual({
      jobId: job.id,
      status: 'activated',
    });
    expect(startedCommits).toEqual([job.id, job.id]);
    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/portable-approvals/${approvedBody.approvalId}/revoke`,
      headers: {
        'x-tixkit-confirmation': `revoke:${approvedBody.approvalId}`,
      },
      payload: { reason: 'Route lifecycle proof' },
    });
    expect(revokeResponse.statusCode, revokeResponse.body).toBe(409);
    expect(revokeResponse.json()).toMatchObject({
      error: { message: expect.stringMatching(/after execution starts/u) },
    });
    await expect(
      repository.revokePortableDestinationResource({
        tenantId,
        organizationId,
        kind: 'provider_account',
        resourceId: 'acct_destination_01',
      }),
    ).rejects.toThrow(/EXECUTION_STARTED/u);
    const auditCount = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('resource_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(Number(auditCount.count)).toBeGreaterThanOrEqual(3);
    await app.close();
    await truncateAllData(db);
    await ImportEventImmutabilityMigration.down!(db);
    await PortableImportCommitAuthorizationsMigration.down!(db);
    await PortableImportCutoverProofsMigration.down!(db);
    await PortableImportRebindingsMigration.down!(db);
    await PortableImportApprovalsMigration.down!(db);
    await PortableImportPreflightsMigration.down!(db);
    await PortableImportPreflightsMigration.up(db);
    await PortableImportApprovalsMigration.up(db);
    await PortableImportRebindingsMigration.up(db);
    await PortableImportCommitAuthorizationsMigration.up(db);
    await PortableImportCutoverProofsMigration.up(db);
    await ImportEventImmutabilityMigration.up(db);
    await expect(
      db.selectFrom('portable_import_preflights').selectAll().execute(),
    ).resolves.toEqual([]);
  }, 30_000);

  it('routes a signed portable artifact through preparation, commit, reconciliation, and activation', async () => {
    const intakeTenantId = (
      await new TenantRepository(db).create({ name: `Portable intake ${driver}` })
    ).id;
    const intakeOrganizationId = (
      await new OrganizationRepository(db).create({
        tenantId: intakeTenantId,
        name: `Portable intake ${driver}`,
        slug: `portable-intake-${driver}`,
      })
    ).id;
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const dryRunKeys = generateKeyPairSync('ed25519');
    const cutoverKeys = generateKeyPairSync('ed25519');
    const policies = createPortableConfigurationPayloadPolicies();
    const built = buildPortableLogicalExport({
      bundleId: `bundle_routed_intake_${driver}`,
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: `deployment_routed_source_${driver}`,
        tenantId: `tenant_routed_source_${driver}`,
        organizationId: `organization_routed_source_${driver}`,
        exportSequence: 1,
        changeCursor:
          'snapshot-sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0080',
      exportedAt: '2026-07-13T12:00:00.000Z',
      currentTime: '2026-07-13T12:00:00.000Z',
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0080',
        maximumDataSchemaVersion: '0080',
        requiredCapabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
        requiredEntitlements: [],
      },
      rebindings: [],
      sections: new Map([
        [
          'organizations',
          [
            {
              portableId: 'organization-routed-source-01',
              attributes: {
                name: 'Routed source organization',
                slug: `routed-source-${driver}`,
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
      bundleSigning: { keyId: 'bundle_routed_key', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_routed_key', privateKey: payloadKeys.privateKey },
      payloadPolicies: policies,
    });
    expect(built.envelope.manifest).toMatchObject({
      format: 'tixkit-portable-bundle-v2',
      schemaVersion: 2,
      dataSchemaVersion: '0080',
      compatibility: {
        minimumDataSchemaVersion: '0080',
        maximumDataSchemaVersion: '0080',
        requiredCapabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
      },
    });
    const checksum = createHash('sha256').update(built.transport).digest('hex');
    const objectStore = testObjectStore();
    await ensureTestObjectStoreBucket(objectStore);
    const policy = policies.get('organizations')!;
    const destination = {
      deploymentId: `deployment_routed_destination_${driver}`,
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0080',
      capabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
      entitlements: [],
      availableStorageBytes: 1024 * 1024,
      acceptedSourceOperatingModels: ['self-hosted' as const],
    };
    const objectReads: Array<{ input?: { Bucket?: string; Key?: string } }> = [];
    const preparation = createMigrationPreparationService(
      db,
      { resolve: async () => Promise.reject(new Error('CREDENTIAL_RESOLUTION_NOT_EXPECTED')) },
      {
        signal: new AbortController().signal,
        heartbeat: () => undefined,
        cursorEncryptionKey: Buffer.alloc(32, 9).toString('base64'),
        createS3Client: () =>
          ({
            send: async (command: { input?: { Bucket?: string; Key?: string } }) => {
              objectReads.push(command);
              return objectStore.send(command as never);
            },
          }) as never,
        portableTrust: ({ tenantId: scopedTenantId, organizationId: scopedOrganizationId }) => ({
          destination,
          trustedBundleKeys: new Map([['bundle_routed_key', bundleKeys.publicKey]]),
          trustedPayloadKeys: new Map([['payload_routed_key', payloadKeys.publicKey]]),
          trustedPayloadPolicies: new Map([
            [
              'organizations',
              {
                schemaId: policy.schemaId,
                schemaSha256: policy.schemaSha256,
                policySha256: policy.policySha256,
                scannerId: policy.scannerId,
                keyId: 'payload_routed_key',
              },
            ],
          ]),
          trustedMediaKeys: new Map(),
          trustedMediaPolicies: new Map(),
          destinationTenantId: scopedTenantId,
          destinationOrganizationId: scopedOrganizationId,
        }),
      },
    );
    const principal: Principal = {
      type: 'user',
      id: `user_routed_intake_${driver}`,
      tenantId: intakeTenantId,
      organizationIds: [intakeOrganizationId],
      scopes: ['migrations.read', 'migrations.write', 'migrations.commit'],
    };
    const attestation = createLocalPortableDryRunAttestation({
      keyId: 'dry_run_routed_key',
      privateKey: dryRunKeys.privateKey,
      trustedPublicKeys: new Map([['dry_run_routed_key', dryRunKeys.publicKey]]),
    });
    const commitService = createRepositoryMigrationActivityService(
      db,
      createProductionMigrationCommitters(db),
    );
    const useProcessRecovery = process.env.TIXKIT_TEMPORAL_PROCESS_RECOVERY === '1';
    let processRecoveryResult: Awaited<ReturnType<typeof migrationCommitWorkflow>> | undefined;
    let processRecoveryCrashObserved = false;
    let processRecoveryExitSignal: NodeJS.Signals | null | undefined;
    let processRecoveryFailure: string | undefined;
    const startedCommits: string[] = [];
    const app = Fastify();
    app.decorate('context', {
      db,
      portableDryRunAttestation: attestation,
      portableCutoverTrust: {
        trustedPublicKeys: new Map([['cutover_routed_key', cutoverKeys.publicKey]]),
      },
      temporalClient: {
        startMigrationPreparation: async (input: {
          tenantId: string;
          organizationId: string;
          jobId: string;
        }) => {
          for (;;) {
            const chunk = await preparation.prepare({ ...input, chunkSize: 100 });
            if (chunk.completed) return;
          }
        },
        startMigrationCommit: async (input: {
          tenantId: string;
          organizationId: string;
          jobId: string;
        }) => {
          startedCommits.push(input.jobId);
          if (useProcessRecovery) {
            const temporalAddress = process.env.TEMPORAL_ADDRESS;
            if (!temporalAddress)
              throw new Error('TEMPORAL_ADDRESS is required for process recovery');
            const taskQueue = `portable-process-recovery-${driver}-${input.jobId}`;
            const workflowId = `portable-process-recovery:${driver}:${input.jobId}`;
            const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
            const connection = await Connection.connect({ address: temporalAddress });
            const client = new WorkflowClient({ connection, namespace });
            const firstWorker = startMigrationProcessWorker({
              driver,
              databaseUrl: url,
              taskQueue,
              crashAfterStage: MIGRATION_COMMIT_STAGES[0],
            });
            let replacementWorker: MigrationProcessWorker | undefined;
            let handle: Awaited<ReturnType<typeof client.start>> | undefined;
            let executionError: unknown;
            try {
              await firstWorker.waitFor('TIXKIT_MIGRATION_PROCESS_WORKER_READY');
              handle = await client.start(migrationCommitWorkflow, {
                taskQueue,
                workflowId,
                workflowExecutionTimeout: '75 seconds',
                args: [{ version: 1, ...input, chunkSize: 1 }],
              });
              await firstWorker.waitFor(
                `TIXKIT_MIGRATION_CRASH_POINT stage=${MIGRATION_COMMIT_STAGES[0]}`,
                30_000,
              );
              processRecoveryCrashObserved = true;
              processRecoveryExitSignal = (await firstWorker.stop('SIGKILL')).signal;
              if (processRecoveryExitSignal !== 'SIGKILL')
                throw new Error(
                  `PORTABLE_PROCESS_RECOVERY_WRONG_EXIT_SIGNAL:${processRecoveryExitSignal ?? 'none'}`,
                );
              replacementWorker = startMigrationProcessWorker({
                driver,
                databaseUrl: url,
                taskQueue,
              });
              await replacementWorker.waitFor('TIXKIT_MIGRATION_PROCESS_WORKER_READY');
              const result = await handle.result();
              processRecoveryResult = result;
              if (
                result.status !== 'completed' ||
                result.progress.processed !== 1 ||
                result.progress.failed !== 0 ||
                result.progress.conflicts !== 0
              ) {
                throw new Error(
                  `PORTABLE_PROCESS_RECOVERY_RESULT_INVALID:${JSON.stringify(result)}`,
                );
              }
            } catch (error) {
              processRecoveryFailure = error instanceof Error ? error.stack : String(error);
              executionError = error;
            } finally {
              const cleanupErrors: unknown[] = [];
              await firstWorker.stop().catch((error: unknown) => cleanupErrors.push(error));
              await replacementWorker?.stop().catch((error: unknown) => cleanupErrors.push(error));
              try {
                try {
                  await connection.workflowService.deleteWorkflowExecution({
                    namespace,
                    workflowExecution: {
                      workflowId,
                      ...(handle ? { runId: handle.firstExecutionRunId } : {}),
                    },
                  });
                } catch (error) {
                  cleanupErrors.push(error);
                }
              } finally {
                await Promise.resolve(connection.close()).catch((error: unknown) =>
                  cleanupErrors.push(error),
                );
              }
              if (cleanupErrors.length > 0)
                executionError = new AggregateError(
                  executionError ? [executionError, ...cleanupErrors] : cleanupErrors,
                  `Portable process-recovery cleanup failed: ${cleanupErrors
                    .map((error) =>
                      error instanceof Error
                        ? `${error.name}:${error.message}:code=${errorCode(error) ?? 'none'}`
                        : String(error),
                    )
                    .join('; ')}`,
                  executionError ? { cause: executionError } : undefined,
                );
            }
            if (executionError) {
              processRecoveryFailure =
                executionError instanceof Error ? executionError.stack : String(executionError);
              throw executionError;
            }
            return;
          }
          const scope = { ...input, sideEffects: MIGRATION_SIDE_EFFECT_POLICY };
          await commitService.beginCommit(scope);
          for (const stage of MIGRATION_COMMIT_STAGES) {
            const result = await commitService.processStage(scope, {
              stage,
              claimOwner: `routed-intake:${stage}`,
              chunkSize: 100,
            });
            if (!result.complete) throw new Error(`ROUTED_COMMIT_STAGE_INCOMPLETE:${stage}`);
          }
          const reconciliation = await commitService.reconcile(scope);
          if (reconciliation.unresolved !== 0) {
            throw new Error(`ROUTED_COMMIT_RECONCILIATION_FAILED:${reconciliation.unresolved}`);
          }
          await commitService.completeCommit(scope);
        },
      },
    } as never);
    app.addHook('preHandler', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    await app.register(uploadRoutes);
    const uploadBundle = async (contentType: string, fileName: string) => {
      const ticketResponse = await app.inject({
        method: 'POST',
        url: '/upload-artifacts',
        payload: {
          purpose: 'migration_import',
          organizationId: intakeOrganizationId,
          fileName,
          contentType,
          sizeBytes: built.transport.byteLength,
        },
      });
      expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
      const ticket = ticketResponse.json<{
        artifactId: string;
        uploadUrl: string;
        uploadHeaders: Record<string, string>;
      }>();
      const upload = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        headers: {
          ...ticket.uploadHeaders,
          'Content-Length': String(built.transport.byteLength),
        },
        body: built.transport,
      });
      expect(upload.status, await upload.text()).toBe(200);
      const completed = await app.inject({
        method: 'POST',
        url: `/upload-artifacts/${ticket.artifactId}/complete`,
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const artifact = await db
        .selectFrom('upload_artifacts')
        .selectAll()
        .where('id', '=', ticket.artifactId)
        .executeTakeFirstOrThrow();
      expect(artifact).toMatchObject({
        tenant_id: intakeTenantId,
        organization_id: intakeOrganizationId,
        purpose: 'migration_import',
        status: 'uploaded',
        scan_status: 'clean',
        content_type: contentType,
        size_bytes: built.transport.byteLength,
        checksum_sha256: checksum,
      });
      expect(artifact.object_key).toContain(`/migration-imports/${intakeOrganizationId}/final/`);
      return artifact;
    };
    const artifact = await uploadBundle(
      'application/vnd.tixkit.portable+json',
      'portable-routed-intake.json',
    );
    const wrongMediaArtifact = await uploadBundle(
      'application/json',
      'portable-routed-intake-wrong-media.json',
    );
    const mismatchedVersionArtifact = await uploadBundle(
      'application/vnd.tixkit.portable+json',
      'portable-routed-intake-version-mismatch.json',
    );
    const registrationRaceArtifact = await uploadBundle(
      'application/vnd.tixkit.portable+json',
      'portable-routed-intake-registration-race.json',
    );
    const artifactId = artifact.id;
    const wrongMediaArtifactId = wrongMediaArtifact.id;
    const objectKey = artifact.object_key;
    const createPayload = {
      organizationId: intakeOrganizationId,
      sourceSystem: 'tixkit-portable',
      adapterVersion: 'tixkit-portable-bundle-v2',
      mode: 'dry-run',
      configuration: {
        sourceMode: 'official-export',
        sourceSystem: 'tixkit-portable',
        artifactIds: [artifactId],
      },
    };
    const genericRoute = await app.inject({
      method: 'POST',
      url: '/migration-jobs',
      headers: { 'idempotency-key': `generic-routed-intake-${driver}` },
      payload: createPayload,
    });
    expect(genericRoute.statusCode, genericRoute.body).toBe(400);
    expect(genericRoute.json()).toMatchObject({
      error: { message: 'Portable imports must use POST /portable-migration-jobs' },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/portable-migration-jobs',
      headers: { 'idempotency-key': `routed-intake-${driver}` },
      payload: createPayload,
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdBody = created.json<{ id: string; status: string }>();
    expect(createdBody.status).toBe('pending');
    const replay = await app.inject({
      method: 'POST',
      url: '/portable-migration-jobs',
      headers: { 'idempotency-key': `routed-intake-${driver}` },
      payload: createPayload,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(created.json());
    const raceJobIds: string[] = [];
    for (const contender of ['a', 'b']) {
      const response = await app.inject({
        method: 'POST',
        url: '/portable-migration-jobs',
        headers: { 'idempotency-key': `routed-intake-registration-race-${driver}-${contender}` },
        payload: {
          ...createPayload,
          configuration: {
            ...createPayload.configuration,
            artifactIds: [registrationRaceArtifact.id],
          },
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      raceJobIds.push(response.json<{ id: string }>().id);
    }
    const racedRegistrations = await Promise.all(
      raceJobIds.map((raceJobId) =>
        app.inject({
          method: 'POST',
          url: `/migration-jobs/${raceJobId}/files`,
          payload: { uploadArtifactId: registrationRaceArtifact.id },
        }),
      ),
    );
    expect(racedRegistrations.map(({ statusCode }) => statusCode).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const winningRaceJobId =
      raceJobIds[racedRegistrations.findIndex(({ statusCode }) => statusCode === 201)]!;
    const racedArtifact = await db
      .selectFrom('upload_artifacts')
      .select(['consumed_at', 'metadata'])
      .where('id', '=', registrationRaceArtifact.id)
      .executeTakeFirstOrThrow();
    expect(racedArtifact.consumed_at).not.toBeNull();
    expect(
      typeof racedArtifact.metadata === 'string'
        ? JSON.parse(racedArtifact.metadata)
        : racedArtifact.metadata,
    ).toMatchObject({ migrationImport: { jobId: winningRaceJobId } });
    const racedFiles = await db
      .selectFrom('import_job_files')
      .select(['import_job_id', 'object_key'])
      .where('object_key', '=', registrationRaceArtifact.object_key)
      .execute();
    expect(racedFiles).toEqual([expect.objectContaining({ import_job_id: winningRaceJobId })]);
    const racedAudit = await db
      .selectFrom('audit_logs')
      .select(['resource_id', 'action'])
      .where('resource_id', 'in', raceJobIds)
      .where('action', '=', 'migration_job.file_registered')
      .execute();
    expect(racedAudit).toEqual([expect.objectContaining({ resource_id: winningRaceJobId })]);
    const wrongArtifactForJob = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/files`,
      payload: { uploadArtifactId: wrongMediaArtifactId },
    });
    expect(wrongArtifactForJob.statusCode, wrongArtifactForJob.body).toBe(400);
    expect(wrongArtifactForJob.json()).toMatchObject({
      error: { message: 'Portable migrations accept only their configured upload artifact' },
    });
    const wrongMediaJob = await app.inject({
      method: 'POST',
      url: '/portable-migration-jobs',
      headers: { 'idempotency-key': `routed-intake-wrong-media-${driver}` },
      payload: {
        ...createPayload,
        configuration: {
          ...createPayload.configuration,
          artifactIds: [wrongMediaArtifactId],
        },
      },
    });
    expect(wrongMediaJob.statusCode, wrongMediaJob.body).toBe(201);
    const wrongMediaRegistration = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${wrongMediaJob.json<{ id: string }>().id}/files`,
      payload: { uploadArtifactId: wrongMediaArtifactId },
    });
    expect(wrongMediaRegistration.statusCode, wrongMediaRegistration.body).toBe(400);
    expect(wrongMediaRegistration.json()).toMatchObject({
      error: {
        message: 'Portable migration uploads require application/vnd.tixkit.portable+json',
      },
    });
    expect(objectReads).toHaveLength(0);
    const mismatchedVersionJob = await app.inject({
      method: 'POST',
      url: '/portable-migration-jobs',
      headers: { 'idempotency-key': `routed-intake-version-mismatch-${driver}` },
      payload: {
        ...createPayload,
        adapterVersion: 'tixkit-portable-bundle-v1',
        configuration: {
          ...createPayload.configuration,
          artifactIds: [mismatchedVersionArtifact.id],
        },
      },
    });
    expect(mismatchedVersionJob.statusCode, mismatchedVersionJob.body).toBe(201);
    const mismatchedVersionJobId = mismatchedVersionJob.json<{ id: string }>().id;
    const mismatchedVersionRegistration = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${mismatchedVersionJobId}/files`,
      payload: { uploadArtifactId: mismatchedVersionArtifact.id },
    });
    expect(mismatchedVersionRegistration.statusCode, mismatchedVersionRegistration.body).toBe(201);
    const mismatchedVersionPreparation = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${mismatchedVersionJobId}/prepare`,
      payload: {},
    });
    expect(mismatchedVersionPreparation.statusCode, mismatchedVersionPreparation.body).toBe(500);
    expect(objectReads).toHaveLength(1);
    expect(
      await db
        .selectFrom('import_job_rows')
        .select('id')
        .where('import_job_id', '=', mismatchedVersionJobId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('portable_import_preflights')
        .select('import_job_id')
        .where('import_job_id', '=', mismatchedVersionJobId)
        .execute(),
    ).toEqual([]);
    const domainStateBefore = {
      organizations: await db
        .selectFrom('organizations')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
      importedEntities: await db
        .selectFrom('imported_domain_entities')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
      externalReferences: await db
        .selectFrom('external_references')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
    };
    const auditFailure = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/files`,
      headers: { 'user-agent': 'x'.repeat(513) },
      payload: { uploadArtifactId: artifactId },
    });
    expect(auditFailure.statusCode, auditFailure.body).toBe(500);
    expect(
      await db
        .selectFrom('upload_artifacts')
        .select('consumed_at')
        .where('id', '=', artifactId)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ consumed_at: null });
    expect(
      await db
        .selectFrom('import_job_files')
        .select('id')
        .where('import_job_id', '=', createdBody.id)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('resource_id', '=', createdBody.id)
        .where('action', '=', 'migration_job.file_registered')
        .execute(),
    ).toEqual([]);
    const sameJobRegistrationRace = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/migration-jobs/${createdBody.id}/files`,
        payload: { uploadArtifactId: artifactId },
      }),
      app.inject({
        method: 'POST',
        url: `/migration-jobs/${createdBody.id}/files`,
        payload: { uploadArtifactId: artifactId },
      }),
    ]);
    expect(
      sameJobRegistrationRace.map(({ statusCode }) => statusCode).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    const registered = sameJobRegistrationRace.find(({ statusCode }) => statusCode === 201)!;
    expect(registered.statusCode, registered.body).toBe(201);
    expect(registered.json()).toMatchObject({
      jobId: createdBody.id,
      sha256: checksum,
      status: 'ready',
    });
    expect(Number(registered.json<{ byteSize: number | string }>().byteSize)).toBe(
      built.transport.byteLength,
    );
    const consumedArtifact = await db
      .selectFrom('upload_artifacts')
      .select(['consumed_at', 'expires_at', 'metadata'])
      .where('id', '=', artifactId)
      .executeTakeFirstOrThrow();
    expect(consumedArtifact.consumed_at).not.toBeNull();
    expect(new Date(consumedArtifact.expires_at).getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );
    expect(
      typeof consumedArtifact.metadata === 'string'
        ? JSON.parse(consumedArtifact.metadata)
        : consumedArtifact.metadata,
    ).toMatchObject({
      migrationImport: { jobId: createdBody.id, registeredAt: expect.any(String) },
    });
    const duplicateRegistration = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/files`,
      payload: { uploadArtifactId: artifactId },
    });
    expect(duplicateRegistration.statusCode, duplicateRegistration.body).toBe(409);
    const prepared = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/prepare`,
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(202);
    expect(prepared.json()).toEqual({ jobId: createdBody.id, status: 'preparing' });
    expect(objectReads).toHaveLength(2);
    expect(objectReads[1]?.input).toMatchObject({ Bucket: 'tixkit', Key: objectKey });
    const persistedJob = await new ImportRepository(db).findJob(
      intakeTenantId,
      intakeOrganizationId,
      createdBody.id,
    );
    expect(persistedJob?.status).toBe('prepared');
    const dryRun = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/dry-run`,
      payload: {},
    });
    expect(dryRun.statusCode, dryRun.body).toBe(200);
    const dryRunBody = dryRun.json<{
      status: string;
      domainWrites: number;
      report: { accepted: boolean; counts: Record<string, number> };
      portableDryRunReceipt: PortableDryRunReceipt;
      portableDryRunReceiptSha256: string;
    }>();
    expect(dryRunBody).toMatchObject({
      status: 'ready',
      domainWrites: 0,
      report: { accepted: true, counts: { create: 1 } },
      portableDryRunReceipt: {
        manifestSha256: portableManifestSha256(built.envelope.manifest),
        destinationId: destination.deploymentId,
        artifactSha256: checksum,
        compatible: true,
        attestationKeyId: 'dry_run_routed_key',
      },
    });
    expect(
      verifyPortableDryRunReceipt(dryRunBody.portableDryRunReceipt, dryRunKeys.publicKey),
    ).toBe(true);
    const rows = await app.inject({
      method: 'GET',
      url: `/migration-jobs/${createdBody.id}/rows`,
    });
    expect(rows.statusCode, rows.body).toBe(200);
    const rowBody = rows.json<{ items: Array<{ entityType: string; status: string }> }>();
    expect(rowBody.items).toHaveLength(1);
    expect(rowBody.items[0]).toMatchObject({ entityType: 'organization', status: 'validated' });
    const intakeRepository = new ImportRepository(db);
    const stagedRows = await intakeRepository.listRows({
      tenantId: intakeTenantId,
      organizationId: intakeOrganizationId,
      jobId: createdBody.id,
      limit: 10,
    });
    expect(stagedRows).toHaveLength(1);
    expect(stagedRows[0]).toMatchObject({
      entity_type: 'organization',
      external_id: 'organization-routed-source-01',
      status: 'validated',
    });
    expect(JSON.parse(stagedRows[0]!.source_data)).toMatchObject({
      portableId: 'organization-routed-source-01',
      attributes: { name: 'Routed source organization', slug: `routed-source-${driver}` },
    });
    expect(JSON.parse(stagedRows[0]!.normalized_data!)).toMatchObject({
      entityType: 'organization',
      externalId: 'organization-routed-source-01',
      attributes: { name: 'Routed source organization', slug: `routed-source-${driver}` },
    });
    const preflight = await intakeRepository.findPortablePreflight(
      intakeTenantId,
      intakeOrganizationId,
      createdBody.id,
    );
    expect(preflight).toMatchObject({
      bundle_id: built.envelope.manifest.bundleId,
      manifest_sha256: portableManifestSha256(built.envelope.manifest),
      artifact_sha256: checksum,
      destination_id: destination.deploymentId,
    });
    const persistedReceipt = await intakeRepository.findPortableDryRunReceipt(
      intakeTenantId,
      intakeOrganizationId,
      createdBody.id,
    );
    expect(persistedReceipt).toMatchObject({
      input_sha256: dryRunBody.portableDryRunReceipt.inputSha256,
      receipt_sha256: dryRunBody.portableDryRunReceiptSha256,
    });
    expect(JSON.parse(persistedReceipt!.receipt_json)).toEqual(dryRunBody.portableDryRunReceipt);
    expect({
      organizations: await db
        .selectFrom('organizations')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
      importedEntities: await db
        .selectFrom('imported_domain_entities')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
      externalReferences: await db
        .selectFrom('external_references')
        .selectAll()
        .where('tenant_id', '=', intakeTenantId)
        .orderBy('id')
        .execute(),
    }).toEqual(domainStateBefore);
    const approval = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/portable-approval`,
      headers: {
        'idempotency-key': `routed-approval-${driver}`,
        'x-tixkit-confirmation': `approve:${createdBody.id}:${dryRunBody.portableDryRunReceiptSha256}`,
      },
      payload: {},
    });
    if (approval.statusCode !== 201) {
      const failedJob = await intakeRepository.findJob(
        intakeTenantId,
        intakeOrganizationId,
        createdBody.id,
      );
      const failedReceipt = await intakeRepository.findPortableDryRunReceipt(
        intakeTenantId,
        intakeOrganizationId,
        createdBody.id,
      );
      const failedInputHash = await portableImportCurrentInputHash({
        db,
        tenantId: intakeTenantId,
        organizationId: intakeOrganizationId,
        jobId: createdBody.id,
        sourceSystem: 'tixkit-portable',
      });
      throw new Error(
        `PORTABLE_APPROVAL_FAILED:${JSON.stringify({
          response: approval.json(),
          status: failedJob?.status,
          summary: failedJob?.summary ? JSON.parse(failedJob.summary) : null,
          receiptInputSha256: failedReceipt?.input_sha256,
          currentInputSha256: failedInputHash,
        })}`,
      );
    }
    const approvalBody = approval.json<{ commitConfirmation: string }>();
    const issuedAt = new Date();
    const cutoverProof = createPortableCutoverProof(
      {
        tenantId: built.envelope.manifest.source.tenantId,
        deploymentId: built.envelope.manifest.source.deploymentId,
        sourceChangeCursor: built.envelope.manifest.lineage.toChangeCursor,
        observedAt: issuedAt.toISOString(),
        sourceFrozen: true,
        bundleId: built.envelope.manifest.bundleId,
        manifestSha256: portableManifestSha256(built.envelope.manifest),
        destinationId: destination.deploymentId,
        operationId: preflight!.operation_id,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
        nonce: `cutover_routed_${driver}`,
      },
      'cutover_routed_key',
      cutoverKeys.privateKey,
    );
    const committed = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvalBody.commitConfirmation },
      payload: { cutoverProof },
    });
    expect(committed.statusCode, processRecoveryFailure ?? committed.body).toBe(202);
    expect(startedCommits).toEqual([createdBody.id]);
    if (useProcessRecovery) {
      expect(processRecoveryCrashObserved).toBe(true);
      expect(processRecoveryExitSignal).toBe('SIGKILL');
      expect(processRecoveryResult).toMatchObject({
        status: 'completed',
        progress: { processed: 1, failed: 0, conflicts: 0 },
      });
      const recoveryEvents = await intakeRepository.listEvents(
        intakeTenantId,
        intakeOrganizationId,
        createdBody.id,
      );
      const checkpoints = recoveryEvents.filter((event) => event.type === 'commit.stage.completed');
      expect(checkpoints).toHaveLength(1);
      expect(
        recoveryEvents.filter((event) => event.type === 'commit.stage.row.completed'),
      ).toHaveLength(1);
      expect(JSON.stringify(recoveryEvents)).not.toContain(
        `${createdBody.id}:${MIGRATION_COMMIT_STAGES[0]}:initial`,
      );
      const checkpoint = JSON.parse(checkpoints[0]!.data!) as {
        claimOwnerSha256: string;
        result: {
          processed: number;
          created: number;
          updated: number;
          skipped: number;
          conflicts: number;
          failed: number;
          complete: boolean;
        };
      };
      expect(checkpoint).toMatchObject({
        version: 1,
        stage: MIGRATION_COMMIT_STAGES[0],
        result: { processed: 1, complete: false },
      });
      expect(checkpoint.claimOwnerSha256).toMatch(/^[a-f0-9]{64}$/u);
      const routedEvents = await app.inject({
        method: 'GET',
        url: `/migration-jobs/${createdBody.id}/events`,
      });
      expect(routedEvents.statusCode, routedEvents.body).toBe(200);
      const routedCheckpoint = routedEvents
        .json<{
          items: Array<{ type: string; data?: { claimOwnerSha256?: string } }>;
        }>()
        .items.find((event) => event.type === 'commit.stage.completed');
      expect(routedCheckpoint?.data?.claimOwnerSha256).toBe(checkpoint.claimOwnerSha256);
      expect(processRecoveryResult!.progress).toMatchObject({
        processed: checkpoint.result.processed,
        created: checkpoint.result.created,
        updated: checkpoint.result.updated,
        skipped: checkpoint.result.skipped,
        conflicts: checkpoint.result.conflicts,
        failed: checkpoint.result.failed,
      });
    }
    expect(
      (await intakeRepository.findJob(intakeTenantId, intakeOrganizationId, createdBody.id))
        ?.status,
    ).toBe('committed');
    expect(
      await intakeRepository.findExternalReference({
        tenantId: intakeTenantId,
        organizationId: intakeOrganizationId,
        sourceSystem: 'tixkit-portable',
        entityType: 'organization',
        externalId: 'organization-routed-source-01',
      }),
    ).toMatchObject({ tixkit_id: intakeOrganizationId });
    await expect(
      db
        .selectFrom('organizations')
        .select(['name', 'slug'])
        .where('tenant_id', '=', intakeTenantId)
        .where('id', '=', intakeOrganizationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      name: `Portable intake ${driver}`,
      slug: `portable-intake-${driver}`,
    });
    const committedEntity = await intakeRepository.findImportedEntity(
      intakeTenantId,
      intakeOrganizationId,
      intakeOrganizationId,
    );
    expect(committedEntity).toMatchObject({ entity_type: 'organization' });
    expect(JSON.parse(committedEntity!.attributes)).toMatchObject({
      name: 'Routed source organization',
      slug: `routed-source-${driver}`,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${createdBody.id}/activate`,
      headers: { 'x-tixkit-confirmation': `activate:${createdBody.id}` },
      payload: {},
    });
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toEqual({ jobId: createdBody.id, status: 'activated' });
    await app.close();
  }, 180_000);
});
