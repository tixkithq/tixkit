import { generateKeyPairSync } from 'node:crypto';
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
import {
  buildPortableLogicalExport,
  canonicalPortableJson,
  createPortableConfigurationPayloadPolicies,
  portableManifestSha256,
  verifyAndPreflightPortableImport,
} from '@tixkit/portability';
import {
  approvePortableImport,
  attestPortableDryRun,
  bindPortableImportDestination,
  createLocalPortableDryRunAttestation,
  portableImportCurrentInputHash,
  revokePortableImportApproval,
  validatePortableImportApproval,
} from '../../services/portable-import-control.js';
import { registerErrorHandler } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';

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
      rebindings: [{ kind: 'provider_account', portableId: 'provider_stripe', required: true }],
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
    let activePrincipal: Principal = {
      type: 'user',
      id: 'user_route_approver',
      tenantId,
      organizationIds: [organizationId],
      scopes: ['migrations.commit'],
    };
    const app = Fastify();
    app.decorate('context', {
      db,
      portableDryRunAttestation: request.attestation,
      temporalClient: {},
    } as never);
    app.addHook('preHandler', async (fastifyRequest) => {
      fastifyRequest.principal = activePrincipal;
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
    activePrincipal = { ...activePrincipal, organizationIds: [organizationId] };
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
          headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
        })
      ).statusCode,
    ).toBe(503);
    app.context.portableDryRunAttestation = request.attestation;
    const validCommit = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
    });
    expect(validCommit.statusCode, validCommit.body).toBe(409);
    expect(validCommit.json()).toMatchObject({
      error: { message: expect.stringMatching(/rebindings/u) },
    });
    const revokeResponse = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/portable-approvals/${approvedBody.approvalId}/revoke`,
      headers: { 'x-tixkit-confirmation': `revoke:${approvedBody.approvalId}` },
      payload: { reason: 'Route lifecycle proof' },
    });
    expect(revokeResponse.statusCode, revokeResponse.body).toBe(200);
    const revokedCommit = await app.inject({
      method: 'POST',
      url: `/migration-jobs/${job.id}/commit`,
      headers: { 'x-tixkit-confirmation': approvedBody.commitConfirmation },
    });
    expect(revokedCommit.statusCode).toBe(409);
    expect(revokedCommit.json()).toMatchObject({
      error: { message: expect.stringMatching(/fresh, unrevoked/u) },
    });
    const auditCount = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('resource_id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(Number(auditCount.count)).toBeGreaterThanOrEqual(3);
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
    await app.close();
    await truncateAllData(db);
    await PortableImportRebindingsMigration.down!(db);
    await PortableImportApprovalsMigration.down!(db);
    await PortableImportPreflightsMigration.down!(db);
    await PortableImportPreflightsMigration.up(db);
    await PortableImportApprovalsMigration.up(db);
    await PortableImportRebindingsMigration.up(db);
    await expect(
      db.selectFrom('portable_import_preflights').selectAll().execute(),
    ).resolves.toEqual([]);
  });
});
