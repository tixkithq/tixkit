import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type Database } from '@tixkit/db';
import type { Principal, PrincipalType } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { uploadRoutes } from '../../routes/modules/uploads.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://storage.example.test/signed'),
}));

const contracts = new Map(
  UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map((contract) => [
    contract.operationId,
    contract,
  ]),
);
const createContract = contracts.get('postUploadArtifacts');
const completeContract = contracts.get('postUploadArtifactsByArtifactIdComplete');
const downloadContract = contracts.get('getUploadArtifactsByArtifactIdDownload');
if (!createContract || !completeContract || !downloadContract) {
  throw new Error('Missing upload artifact lifecycle authorization contracts');
}

const runId = ulid().slice(-10).toLowerCase();
const ownerTenantId = `tnt_upl_auth_${runId}`;
const otherTenantId = `tnt_upl_other_${runId}`;
const ownerId = `usr_upl_owner_${runId}`;
const otherOwnerId = `usr_upl_other_${runId}`;
const crossTenantOwnerId = `usr_upl_cross_${runId}`;
const ownedArtifactId = `upl_auth_${runId}`;

let activePrincipal: Principal;
let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;

const signedUrl = vi.mocked(getSignedUrl);
let s3Send: ReturnType<typeof vi.spyOn>;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: ownerId,
    tenantId: ownerTenantId,
    organizationIds: [],
    scopes: [],
    ...overrides,
  };
}

function avatarCreatePayload() {
  return {
    purpose: 'user_avatar',
    fileName: 'avatar.png',
    contentType: 'image/png',
    sizeBytes: 1_024,
  } as const;
}

async function seedTenantAndUser(tenantId: string, userId: string, suffix: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: `Upload authorization ${suffix}`,
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('user_profiles')
    .values({
      id: userId,
      tenant_id: tenantId,
      clerk_user_id: `clerk_${suffix}_${runId}`,
      email: `${suffix}-${runId}@example.test`,
      first_name: null,
      last_name: null,
      avatar_url: null,
      status: 'active',
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedOwnedCleanArtifact(): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('upload_artifacts')
    .values({
      id: ownedArtifactId,
      tenant_id: ownerTenantId,
      organization_id: null,
      brand_id: null,
      event_id: null,
      created_by_user_id: ownerId,
      purpose: 'user_avatar',
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: 'No malware detected',
      bucket: 'tixkit-test',
      object_key: `uploads/${ownerTenantId}/avatars/${ownerId}/final/${ownedArtifactId}.png`,
      file_name: 'avatar.png',
      content_type: 'image/png',
      size_bytes: 1_024,
      checksum_sha256: 'a'.repeat(64),
      client_token_hash: null,
      metadata: '{}',
      consumed_by_checkout_session_id: null,
      consumed_at: null,
      completion_owner_token: null,
      completion_started_at: null,
      expires_at: new Date('2027-07-17T12:00:00.000Z'),
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function artifactSnapshot() {
  return db
    .selectFrom('upload_artifacts')
    .selectAll()
    .where('tenant_id', 'in', [ownerTenantId, otherTenantId])
    .orderBy('id')
    .execute();
}

async function expectDeniedWithoutMutation(
  expectedStatus: 403 | 404,
  inject: () => Promise<{ json(): unknown; statusCode: number }>,
): Promise<void> {
  const before = await artifactSnapshot();
  const signedBefore = signedUrl.mock.calls.length;
  const s3Before = s3Send.mock.calls.length;
  const response = await inject();

  expect(response.statusCode).toBe(expectedStatus);
  expect(response.json()).toMatchObject({
    error: { code: expectedStatus === 403 ? 'FORBIDDEN' : 'NOT_FOUND' },
  });
  await expect(artifactSnapshot()).resolves.toEqual(before);
  expect(signedUrl).toHaveBeenCalledTimes(signedBefore);
  expect(s3Send).toHaveBeenCalledTimes(s3Before);
}

describeWithIntegrationDatabase('upload artifact route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await seedTenantAndUser(ownerTenantId, ownerId, 'owner');
    await seedTenantAndUser(otherTenantId, crossTenantOwnerId, 'cross');
    await db
      .insertInto('user_profiles')
      .values({
        id: otherOwnerId,
        tenant_id: ownerTenantId,
        clerk_user_id: `clerk_other_${runId}`,
        email: `other-${runId}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: new Date('2026-07-17T12:00:00.000Z'),
        updated_at: new Date('2026-07-17T12:00:00.000Z'),
      })
      .execute();

    activePrincipal = principal();
    app = Fastify({ logger: false });
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(uploadRoutes);

    s3Send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('S3 must not be called by this authorization proof'));
  });

  beforeEach(async () => {
    await db
      .deleteFrom('upload_artifacts')
      .where('tenant_id', 'in', [ownerTenantId, otherTenantId])
      .execute();
    await seedOwnedCleanArtifact();
    activePrincipal = principal();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    s3Send?.mockRestore();
    if (db) {
      await db
        .deleteFrom('upload_artifacts')
        .where('tenant_id', 'in', [ownerTenantId, otherTenantId])
        .execute();
      await db
        .deleteFrom('user_profiles')
        .where('id', 'in', [ownerId, otherOwnerId, crossTenantOwnerId])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [ownerTenantId, otherTenantId]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('binds all three formal upload lifecycle contracts to this executable proof', () => {
    expect(createContract).toMatchObject({
      authorizedControl: { status: 201 },
      source: 'upload-artifact-route-authorization-db.integration.test.ts',
    });
    for (const contract of [completeContract, downloadContract]) {
      expect(contract).toMatchObject({
        authorizedControl: { status: 200 },
        source: 'upload-artifact-route-authorization-db.integration.test.ts',
      });
    }
  });

  it('allows a human owner to create, complete, and download avatar artifacts', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: avatarCreatePayload(),
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json<{ artifactId: string }>();
    await expect(
      db
        .selectFrom('upload_artifacts')
        .select(['tenant_id', 'created_by_user_id', 'purpose', 'status', 'scan_status'])
        .where('id', '=', created.artifactId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      tenant_id: ownerTenantId,
      created_by_user_id: ownerId,
      purpose: 'user_avatar',
      status: 'pending',
      scan_status: 'pending',
    });

    const completeResponse = await app.inject({
      method: 'POST',
      url: `/upload-artifacts/${ownedArtifactId}/complete`,
    });
    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json()).toEqual({
      artifactId: ownedArtifactId,
      status: 'uploaded',
      scanStatus: 'clean',
    });

    const downloadResponse = await app.inject({
      method: 'GET',
      url: `/upload-artifacts/${ownedArtifactId}/download`,
    });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.json()).toEqual({
      downloadUrl: 'https://storage.example.test/signed',
    });
    expect(signedUrl).toHaveBeenCalledTimes(2);
    expect(s3Send).not.toHaveBeenCalled();
  });

  it.each(['api_key', 'agent', 'mobile_device', 'system'] satisfies PrincipalType[])(
    'denies a zero-scope %s principal before avatar create, complete, download, signing, scanning, or storage mutation',
    async (type) => {
      activePrincipal = principal({ type, scopes: [] });
      await expectDeniedWithoutMutation(403, () =>
        app.inject({ method: 'POST', url: '/upload-artifacts', payload: avatarCreatePayload() }),
      );
      await expectDeniedWithoutMutation(403, () =>
        app.inject({ method: 'POST', url: `/upload-artifacts/${ownedArtifactId}/complete` }),
      );
      await expectDeniedWithoutMutation(403, () =>
        app.inject({ method: 'GET', url: `/upload-artifacts/${ownedArtifactId}/download` }),
      );
    },
  );

  it('returns not-found without mutations for a different human owner', async () => {
    activePrincipal = principal({ id: otherOwnerId });
    await expectDeniedWithoutMutation(404, () =>
      app.inject({ method: 'POST', url: `/upload-artifacts/${ownedArtifactId}/complete` }),
    );
    await expectDeniedWithoutMutation(404, () =>
      app.inject({ method: 'GET', url: `/upload-artifacts/${ownedArtifactId}/download` }),
    );
  });

  it('returns not-found without mutations across the tenant boundary', async () => {
    activePrincipal = principal({
      id: ownerId,
      tenantId: otherTenantId,
    });
    await expectDeniedWithoutMutation(404, () =>
      app.inject({ method: 'POST', url: `/upload-artifacts/${ownedArtifactId}/complete` }),
    );
    await expectDeniedWithoutMutation(404, () =>
      app.inject({ method: 'GET', url: `/upload-artifacts/${ownedArtifactId}/download` }),
    );
  });

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
