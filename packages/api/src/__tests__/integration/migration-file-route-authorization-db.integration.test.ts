import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, ImportRepository, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { migrationRoutes } from '../../routes/modules/migrations.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { MIGRATION_FILE_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

describeWithIntegrationDatabase('migration file write authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const actorId = `usr_mfile_${suffix}`;
  const tenantA = `tnt_mfile_a_${suffix}`;
  const tenantB = `tnt_mfile_b_${suffix}`;
  const organizationA = `org_mfile_a_${suffix}`;
  const organizationAScoped = `org_mfile_scope_${suffix}`;
  const organizationB = `org_mfile_b_${suffix}`;
  const artifactA = `upl_mfile_a_${suffix}`;
  const artifactRace = `upl_mfile_race_${suffix}`;
  const artifactAuditFailure = `upl_mfile_audit_${suffix}`;
  const artifactForeignTenant = `upl_mfile_foreign_${suffix}`;
  const artifactWrongOrganization = `upl_mfile_org_${suffix}`;
  const artifactWrongPurpose = `upl_mfile_purpose_${suffix}`;
  const artifactNotUploaded = `upl_mfile_status_${suffix}`;
  const artifactNotClean = `upl_mfile_scan_${suffix}`;
  const artifactExpired = `upl_mfile_expired_${suffix}`;
  const artifactOversize = `upl_mfile_oversize_${suffix}`;
  const artifactMissingChecksum = `upl_mfile_nohash_${suffix}`;
  const artifactInvalidChecksum = `upl_mfile_badhash_${suffix}`;
  const artifactIds = [
    artifactA,
    artifactRace,
    artifactAuditFailure,
    artifactForeignTenant,
    artifactWrongOrganization,
    artifactWrongPurpose,
    artifactNotUploaded,
    artifactNotClean,
    artifactExpired,
    artifactOversize,
    artifactMissingChecksum,
    artifactInvalidChecksum,
  ];
  let jobA: string;
  let jobAScoped: string;
  let jobB: string;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    scopes: ['migrations.write'],
  };

  async function insertTenant(id: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('organizations')
      .values({
        id,
        tenant_id: tenantId,
        name,
        slug: `${id}-slug`,
        clerk_organization_id: null,
        box_office_settings: JSON.stringify({
          enabled: true,
          allowedTenderTypes: ['cash', 'manual_card', 'comp'],
          requireBuyerEmail: false,
          receiptMode: 'email',
        }),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function createJob(tenantId: string, organizationId: string, label: string) {
    return (
      await new ImportRepository(db).createJob({
        tenantId,
        organizationId,
        sourceSystem: 'generic-csv',
        adapterVersion: 'rfc4180-v1',
        mode: 'dry-run',
        idempotencyKey: `mfile-${label}-${suffix}`,
        requestedBy: actorId,
        configuration: {
          sourceMode: 'official-export',
          sourceSystem: 'generic-csv',
          artifactIds: [`upl_mfile_config_${label}_${suffix}`],
        },
      })
    ).id;
  }

  async function insertArtifact(
    id: string,
    kind:
      | 'valid'
      | 'foreign-tenant'
      | 'wrong-organization'
      | 'wrong-purpose'
      | 'not-uploaded'
      | 'not-clean'
      | 'expired'
      | 'oversize'
      | 'missing-checksum'
      | 'invalid-checksum' = 'valid',
  ): Promise<void> {
    const now = new Date();
    await db
      .insertInto('upload_artifacts')
      .values({
        id,
        tenant_id: kind === 'foreign-tenant' ? tenantB : tenantA,
        organization_id:
          kind === 'foreign-tenant'
            ? organizationB
            : kind === 'wrong-organization'
              ? organizationAScoped
              : organizationA,
        brand_id: null,
        event_id: null,
        created_by_user_id: actorId,
        purpose: kind === 'wrong-purpose' ? 'event_media' : 'migration_import',
        status: kind === 'not-uploaded' ? 'pending' : 'uploaded',
        scan_status: kind === 'not-clean' ? 'pending' : 'clean',
        scan_result: null,
        bucket: 'tixkit',
        object_key: `migration/${id}.csv`,
        file_name: `${id}.csv`,
        content_type: 'text/csv',
        size_bytes: kind === 'oversize' ? 50 * 1024 * 1024 + 1 : 128,
        checksum_sha256:
          kind === 'missing-checksum'
            ? null
            : kind === 'invalid-checksum'
              ? 'not-a-sha256'
              : 'a'.repeat(64),
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        expires_at: new Date(now.getTime() + (kind === 'expired' ? -60 * 1000 : 60 * 60 * 1000)),
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function snapshot() {
    const files = await db
      .selectFrom('import_job_files')
      .selectAll()
      .where('tenant_id', '=', tenantA)
      .where('organization_id', '=', organizationA)
      .orderBy('id')
      .execute();
    const audits = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'migration_job.file_registered')
      .orderBy('id')
      .execute();
    const artifacts = await db
      .selectFrom('upload_artifacts')
      .select(['id', 'metadata', 'consumed_at', 'expires_at'])
      .where('id', 'in', artifactIds)
      .orderBy('id')
      .execute();
    return { files, audits, artifacts };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA, 'Migration file tenant A');
    await insertTenant(tenantB, 'Migration file tenant B');
    await insertOrganization(organizationA, tenantA, 'Migration file organization A');
    await insertOrganization(organizationAScoped, tenantA, 'Migration file scoped organization');
    await insertOrganization(organizationB, tenantB, 'Migration file organization B');
    jobA = await createJob(tenantA, organizationA, 'authorized');
    jobAScoped = await createJob(tenantA, organizationAScoped, 'scoped');
    jobB = await createJob(tenantB, organizationB, 'foreign');
    await insertArtifact(artifactA);
    await insertArtifact(artifactRace);
    await insertArtifact(artifactAuditFailure);
    await insertArtifact(artifactForeignTenant, 'foreign-tenant');
    await insertArtifact(artifactWrongOrganization, 'wrong-organization');
    await insertArtifact(artifactWrongPurpose, 'wrong-purpose');
    await insertArtifact(artifactNotUploaded, 'not-uploaded');
    await insertArtifact(artifactNotClean, 'not-clean');
    await insertArtifact(artifactExpired, 'expired');
    await insertArtifact(artifactOversize, 'oversize');
    await insertArtifact(artifactMissingChecksum, 'missing-checksum');
    await insertArtifact(artifactInvalidChecksum, 'invalid-checksum');

    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(migrationRoutes);
    await app.ready();
  });

  beforeEach(() => {
    principal = basePrincipal;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    if (db) {
      await db
        .deleteFrom('audit_logs')
        .where('actor_id', '=', actorId)
        .where('action', '=', 'migration_job.file_registered')
        .execute();
      await db
        .deleteFrom('import_job_files')
        .where('tenant_id', 'in', [tenantA, tenantB])
        .execute();
      await db.deleteFrom('upload_artifacts').where('id', 'in', artifactIds).execute();
      await db.deleteFrom('import_jobs').where('requested_by', '=', actorId).execute();
      for (const id of [organizationA, organizationAScoped, organizationB]) {
        await db.deleteFrom('organizations').where('id', '=', id).execute();
      }
      for (const id of [tenantA, tenantB]) {
        await db.deleteFrom('tenants').where('id', '=', id).execute();
      }
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  function invoke(jobId: string, uploadArtifactId: string, organizationId?: string) {
    return app.inject({
      method: 'POST',
      url: `/migration-jobs/${jobId}/files${organizationId ? `?organizationId=${organizationId}` : ''}`,
      payload: { uploadArtifactId },
    });
  }

  it('registers one authorized artifact, file and audit atomically', async () => {
    const before = await snapshot();
    const response = await invoke(jobA, artifactA);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      jobId: jobA,
      mediaType: 'text/csv',
      byteSize: 128,
      sha256: 'a'.repeat(64),
      status: 'ready',
    });
    expect(response.json()).not.toHaveProperty('object_key');
    expect(response.json()).not.toHaveProperty('original_name');
    const after = await snapshot();
    expect(after.files).toHaveLength(before.files.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    const consumed = after.artifacts.find(({ id }) => id === artifactA)!;
    expect(consumed.consumed_at).not.toBeNull();
    const metadata =
      typeof consumed.metadata === 'string' ? JSON.parse(consumed.metadata) : consumed.metadata;
    expect(metadata).toMatchObject({ migrationImport: { jobId: jobA } });
    const registeredAt = new Date(metadata.migrationImport.registeredAt).getTime();
    expect(Number.isFinite(registeredAt)).toBe(true);
    expect(Math.abs(new Date(consumed.consumed_at!).getTime() - registeredAt)).toBeLessThan(1000);
    expect(
      Math.abs(new Date(consumed.expires_at).getTime() - registeredAt - 30 * 24 * 60 * 60 * 1000),
    ).toBeLessThan(1000);
    expect(after.audits.at(-1)).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      actor_id: actorId,
      resource_id: jobA,
    });
  });

  it('allows exactly one concurrent registration winner', async () => {
    const before = await snapshot();
    const responses = await Promise.all([invoke(jobA, artifactRace), invoke(jobA, artifactRace)]);
    expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
    const after = await snapshot();
    expect(after.files).toHaveLength(before.files.length + 1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.artifacts.find(({ id }) => id === artifactRace)?.consumed_at).not.toBeNull();
  });

  it('rolls artifact consumption and file persistence back when audit fails', async () => {
    const before = await snapshot();
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('injected file audit failure'),
    );
    const response = await invoke(jobA, artifactAuditFailure);
    expect(response.statusCode, response.body).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects every ineligible artifact state without extending retention', async () => {
    const cases = [
      { id: artifactForeignTenant, status: 404 },
      { id: artifactWrongOrganization, status: 404 },
      { id: artifactWrongPurpose, status: 404 },
      { id: artifactNotUploaded, status: 404 },
      { id: artifactNotClean, status: 404 },
      { id: artifactExpired, status: 404 },
      { id: artifactOversize, status: 400 },
      { id: artifactMissingChecksum, status: 404 },
      { id: artifactInvalidChecksum, status: 404 },
    ] as const;
    for (const candidate of cases) {
      const before = await snapshot();
      const response = await invoke(jobA, candidate.id);
      expect(response.statusCode, response.body).toBe(candidate.status);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('denies every file-write boundary before artifact mutation', async () => {
    const contract = MIGRATION_FILE_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
    const cases: Array<{
      principal: Principal;
      jobId: string;
      organizationId?: string;
      status: 403 | 404;
      code: 'FORBIDDEN' | 'NOT_FOUND';
    }> = [
      {
        principal: { ...basePrincipal, scopes: ['migrations.read'] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, brandIds: [`brd_mfile_${suffix}`] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        principal: { ...basePrincipal, eventIds: [`evt_mfile_${suffix}`] },
        jobId: jobA,
        status: 403,
        code: 'FORBIDDEN',
      },
      { principal: basePrincipal, jobId: jobAScoped, status: 404, code: 'NOT_FOUND' },
      {
        principal: basePrincipal,
        jobId: jobB,
        organizationId: organizationB,
        status: 404,
        code: 'NOT_FOUND',
      },
    ];
    for (const denial of cases) {
      principal = denial.principal;
      const before = await snapshot();
      const response = await invoke(denial.jobId, artifactAuditFailure, denial.organizationId);
      expect(response.statusCode, response.body).toBe(denial.status);
      expect(response.json()).toMatchObject({ error: { code: denial.code } });
      expect(await snapshot()).toEqual(before);
    }
    expect(contract.operationId).toBe('registerMigrationJobFile');
  });
});
