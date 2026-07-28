import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { dropAllTables, runMigrations, truncateAllData } from '../../migrate.js';
import { PortableExportBuildLeasesMigration } from '../../migrations/0069_portable_export_build_leases.js';
import { PortableExportAuthorizationsMigration } from '../../migrations/0078_portable_export_authorizations.js';
import { PortableRebindingAuthoritiesMigration } from '../../migrations/0079_portable_rebinding_authorities.js';
import {
  BrandRepository,
  OrganizationRepository,
  PortableExportAuthorizationRepository,
  PortableExportRepository,
  TaxRegistrationRepository,
  TenantRepository,
  WalletCredentialRepository,
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
    mode: 'configuration' as const,
    requestedBy: 'user_exporter',
    idempotencyKey,
    requestFingerprint,
  });

  const rollbackRebindingAuthorities = () =>
    db
      .connection()
      .execute((connection) =>
        driver === 'mysql'
          ? PortableRebindingAuthoritiesMigration.down!(connection)
          : connection
              .transaction()
              .execute((transaction) => PortableRebindingAuthoritiesMigration.down!(transaction)),
      );

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

  it('durably grants, revokes, and single-job consumes historical export authorization', async () => {
    const authorizations = new PortableExportAuthorizationRepository(db);
    const exports = new PortableExportRepository(db);
    const now = new Date();
    const authorization = await authorizations.grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: 'user_owner',
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    const job = await exports.begin({
      ...input('historical-consume'),
      mode: 'historical',
      historicalAuthorizationId: authorization.id,
    });
    const consumed = await Promise.all(
      Array.from({ length: 4 }, () =>
        authorizations.consume({
          tenantId,
          organizationId,
          authorizationId: authorization.id,
          exportJobId: job.id,
          actorPrincipalId: 'user_owner',
        }),
      ),
    );
    expect(consumed.every((row) => row.consumed_at)).toBe(true);
    const events = await db
      .selectFrom('portable_export_authorization_events')
      .select(['event_type', 'export_job_id'])
      .where('authorization_id', '=', authorization.id)
      .execute();
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'granted', export_job_id: null }),
        expect.objectContaining({ event_type: 'consumed', export_job_id: job.id }),
      ]),
    );
    await expect(
      authorizations.revoke({
        tenantId,
        organizationId,
        authorizationId: authorization.id,
        revokedByPrincipalId: 'user_owner',
      }),
    ).rejects.toThrow(/ALREADY_CONSUMED/u);

    const secondJob = await exports.begin({
      ...input('historical-second-job'),
      mode: 'historical',
      historicalAuthorizationId: authorization.id,
    });
    await expect(
      authorizations.consume({
        tenantId,
        organizationId,
        authorizationId: authorization.id,
        exportJobId: secondJob.id,
        actorPrincipalId: 'user_owner',
      }),
    ).rejects.toThrow(/ALREADY_CONSUMED/u);

    const principalBound = await authorizations.grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: 'user_owner',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const principalBoundJob = await exports.begin({
      ...input('historical-principal-bound'),
      mode: 'historical',
      historicalAuthorizationId: principalBound.id,
    });
    await expect(
      authorizations.consume({
        tenantId,
        organizationId,
        authorizationId: principalBound.id,
        exportJobId: principalBoundJob.id,
        actorPrincipalId: 'user_different',
      }),
    ).rejects.toThrow(/PRINCIPAL_MISMATCH/u);
  });

  it('makes revocation idempotent, rejects expired grants, and keeps lifecycle evidence immutable', async () => {
    const authorizations = new PortableExportAuthorizationRepository(db);
    const exports = new PortableExportRepository(db);
    const now = new Date();
    const invalidAuthorization = {
      tenant_id: tenantId,
      organization_id: organizationId,
      granted_by_principal_id: 'user_admin',
      granted_at: now,
      revoked_by_principal_id: null,
      revoked_at: null,
      consumed_at: null,
    };
    await expect(
      db
        .insertInto('portable_export_authorizations')
        .values({
          ...invalidAuthorization,
          id: `pexa_invalid_scope_${driver}`,
          scope: 'wrong-scope',
          expires_at: new Date(now.getTime() + 60_000),
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('portable_export_authorizations')
        .values({
          ...invalidAuthorization,
          id: `pexa_invalid_lifetime_${driver}`,
          scope: 'tenant-historical-portability',
          expires_at: new Date(now.getTime() + 25 * 60 * 60_000),
        })
        .execute(),
    ).rejects.toThrow();
    const revoked = await authorizations.grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: 'user_admin',
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const revokedRows = await Promise.all(
      Array.from({ length: 4 }, () =>
        authorizations.revoke({
          tenantId,
          organizationId,
          authorizationId: revoked.id,
          revokedByPrincipalId: 'user_admin',
        }),
      ),
    );
    expect(revokedRows.every((row) => row.revoked_at)).toBe(true);
    const revokedJob = await exports.begin({
      ...input('historical-revoked'),
      mode: 'historical',
      historicalAuthorizationId: revoked.id,
    });
    await expect(
      authorizations.consume({
        tenantId,
        organizationId,
        authorizationId: revoked.id,
        exportJobId: revokedJob.id,
        actorPrincipalId: 'user_admin',
      }),
    ).rejects.toThrow(/REVOKED/u);

    const expiring = await authorizations.grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: 'user_owner',
      expiresAt: new Date(Date.now() + 2_500),
    });
    await expect(
      db
        .updateTable('portable_export_authorizations')
        .set({ expires_at: new Date(Date.now() + 60_000) })
        .where('id', '=', expiring.id)
        .execute(),
    ).rejects.toThrow(/transition|invalid/u);
    const expiredJob = await exports.begin({
      ...input('historical-expired'),
      mode: 'historical',
      historicalAuthorizationId: expiring.id,
    });
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const releaseRequested = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const lockTransaction = db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('portable_export_authorizations')
        .select('id')
        .where('id', '=', expiring.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      markLocked();
      await releaseRequested;
    });
    await locked;
    const blockedConsumption = expect(
      authorizations.consume({
        tenantId,
        organizationId,
        authorizationId: expiring.id,
        exportJobId: expiredJob.id,
        actorPrincipalId: 'user_owner',
      }),
    ).rejects.toThrow(/EXPIRED/u);
    const expiresAt = new Date(expiring.expires_at).getTime();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(100, expiresAt - Date.now() + 250)),
    );
    releaseLock();
    await lockTransaction;
    await blockedConsumption;

    const event = await db
      .selectFrom('portable_export_authorization_events')
      .select('id')
      .where('authorization_id', '=', revoked.id)
      .where('event_type', '=', 'revoked')
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('portable_export_authorization_events')
        .set({ actor_principal_id: 'tampered' })
        .where('id', '=', event.id)
        .execute(),
    ).rejects.toThrow(/immutable/u);
    await expect(
      db.deleteFrom('portable_export_authorization_events').where('id', '=', event.id).execute(),
    ).rejects.toThrow(/immutable/u);

    await expect(
      db
        .updateTable('portable_export_authorizations')
        .set({ consumed_at: new Date() })
        .where('id', '=', revoked.id)
        .execute(),
    ).rejects.toThrow();
    const configurationJob = await db
      .selectFrom('portable_export_jobs')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('mode', '=', 'configuration')
      .executeTakeFirstOrThrow();
    await expect(
      db
        .updateTable('portable_export_jobs')
        .set({ historical_authorization_id: revoked.id })
        .where('id', '=', configurationJob.id)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('portable_export_authorization_events')
        .values({
          id: `peae_invalid_shape_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          authorization_id: revoked.id,
          event_type: 'consumed',
          actor_principal_id: 'user_admin',
          export_job_id: null,
          occurred_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('portable_export_authorization_events')
        .values({
          id: `peae_wrong_job_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          authorization_id: expiring.id,
          event_type: 'consumed',
          actor_principal_id: 'user_owner',
          export_job_id: revokedJob.id,
          occurred_at: new Date(),
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

  it('rolls the historical authorization schema down and reapplies it cleanly', async () => {
    await expect(PortableExportAuthorizationsMigration.down!(db)).rejects.toThrow(
      /ROLLBACK_UNSAFE/u,
    );
    await truncateAllData(db);
    await PortableExportAuthorizationsMigration.down!(db);
    await expect(
      db.selectFrom('portable_export_authorizations').select('id').limit(1).execute(),
    ).rejects.toThrow();
    await expect(
      db
        .selectFrom('portable_export_jobs')
        .select('historical_authorization_id')
        .limit(1)
        .execute(),
    ).rejects.toThrow();
    await PortableExportAuthorizationsMigration.up(db);
    await expect(
      db.selectFrom('portable_export_authorizations').select('id').limit(1).execute(),
    ).resolves.toEqual([]);
  });

  it('scopes rebinding authorities and refuses a destructive rollback', async () => {
    const authorityTenant = await new TenantRepository(db).create({
      name: `Rebinding authority ${driver}`,
    });
    const authorityOrganization = await new OrganizationRepository(db).create({
      tenantId: authorityTenant.id,
      name: `Rebinding authority ${driver}`,
      slug: `rebinding-authority-${driver}`,
    });
    const otherOrganization = await new OrganizationRepository(db).create({
      tenantId: authorityTenant.id,
      name: `Other rebinding authority ${driver}`,
      slug: `other-rebinding-authority-${driver}`,
    });
    const isolatedTenant = await new TenantRepository(db).create({
      name: `Isolated rebinding authority ${driver}`,
    });
    const isolatedOrganization = await new OrganizationRepository(db).create({
      tenantId: isolatedTenant.id,
      name: `Isolated rebinding authority ${driver}`,
      slug: `isolated-rebinding-authority-${driver}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: authorityTenant.id,
      organizationId: authorityOrganization.id,
      name: 'Authority brand',
      slug: `authority-brand-${driver}`,
    });
    const tax = await new TaxRegistrationRepository(db).create({
      tenantId: authorityTenant.id,
      organizationId: authorityOrganization.id,
      provider: 'managed_tax',
      jurisdictionCode: 'US-IL',
      registrationType: 'sales_tax',
      custodyReference: 'secret://tax/registration',
      status: 'active',
    });
    const wallet = await new WalletCredentialRepository(db).create({
      tenantId: authorityTenant.id,
      organizationId: authorityOrganization.id,
      brandId: brand.id,
      provider: 'apple_wallet',
      credentialType: 'pass_signing',
      custodyReference: 'secret://wallet/signing',
      status: 'active',
    });
    expect(
      await new TaxRegistrationRepository(db).findByOrganization(
        authorityTenant.id,
        otherOrganization.id,
      ),
    ).toEqual([]);
    expect(
      await new TaxRegistrationRepository(db).findByOrganization(
        authorityTenant.id,
        authorityOrganization.id,
      ),
    ).toEqual([tax]);
    expect(
      await new WalletCredentialRepository(db).findByOrganization(
        authorityTenant.id,
        authorityOrganization.id,
      ),
    ).toEqual([wallet]);
    expect(
      await new WalletCredentialRepository(db).findByOrganization(
        authorityTenant.id,
        otherOrganization.id,
      ),
    ).toEqual([]);
    expect(
      await new TaxRegistrationRepository(db).findByOrganization(
        isolatedTenant.id,
        isolatedOrganization.id,
      ),
    ).toEqual([]);
    await expect(
      new TaxRegistrationRepository(db).create({
        tenantId: authorityTenant.id,
        organizationId: authorityOrganization.id,
        provider: 'managed_tax',
        jurisdictionCode: 'US-WI',
        registrationType: 'sales_tax',
        custodyReference: 'plaintext-secret',
      }),
    ).rejects.toThrow(/opaque URI/u);
    await expect(
      new TaxRegistrationRepository(db).create({
        tenantId: authorityTenant.id,
        organizationId: authorityOrganization.id,
        provider: 'managed_tax',
        jurisdictionCode: 'US-WI',
        registrationType: 'sales_tax',
        custodyReference: 'https://user:password@example.test/registration',
      }),
    ).rejects.toThrow(/opaque URI/u);
    await expect(
      new WalletCredentialRepository(db).create({
        tenantId: authorityTenant.id,
        organizationId: authorityOrganization.id,
        brandId: brand.id,
        provider: '   ',
        credentialType: 'pass_signing',
        custodyReference: 'secret://wallet/invalid',
      }),
    ).rejects.toThrow(/non-empty printable/u);
    await expect(
      db
        .insertInto('tax_registrations')
        .values({
          ...tax,
          id: `txr_blank_${driver}`,
          provider: ' ',
          jurisdiction_code: 'US-IN',
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('tax_registrations')
        .values({
          ...tax,
          id: `txr_cross_tenant_${driver}`,
          organization_id: isolatedOrganization.id,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .insertInto('wallet_credentials')
        .values({
          ...wallet,
          id: `wcr_invalid_${driver}`,
          organization_id: otherOrganization.id,
        })
        .execute(),
    ).rejects.toThrow();
    await expect(rollbackRebindingAuthorities()).rejects.toThrow(/ROLLBACK_UNSAFE/u);
    await db.deleteFrom('wallet_credentials').execute();
    await db.deleteFrom('tax_registrations').execute();
    await PortableRebindingAuthoritiesMigration.up(db);
    await db.schema.dropTable('wallet_credentials').execute();
    await PortableRebindingAuthoritiesMigration.up(db);
    await expect(
      db.selectFrom('wallet_credentials').select('id').limit(1).execute(),
    ).resolves.toEqual([]);
    const [rollbackRace, insertRace] = await Promise.allSettled([
      rollbackRebindingAuthorities(),
      new TaxRegistrationRepository(db).create({
        tenantId: authorityTenant.id,
        organizationId: authorityOrganization.id,
        provider: 'managed_tax',
        jurisdictionCode: 'US-MI',
        registrationType: 'sales_tax',
        custodyReference: 'secret://tax/concurrent-rollback',
      }),
    ]);
    expect(
      rollbackRace.status === 'fulfilled' && insertRace.status === 'fulfilled',
      'rollback and concurrent authority insert must never both succeed',
    ).toBe(false);
    if (insertRace.status === 'fulfilled') {
      expect(rollbackRace).toMatchObject({ status: 'rejected' });
      await db.deleteFrom('tax_registrations').execute();
      await rollbackRebindingAuthorities();
    } else {
      expect(rollbackRace).toMatchObject({ status: 'fulfilled' });
    }
    await expect(
      db.selectFrom('tax_registrations').select('id').limit(1).execute(),
    ).rejects.toThrow();
    await PortableRebindingAuthoritiesMigration.up(db);
  });

  it('can reset and migrate PostgreSQL repeatedly without leaked trigger functions', async () => {
    if (driver !== 'postgres') return;
    await dropAllTables(db);
    await runMigrations(url);
    await dropAllTables(db);
    await runMigrations(url);
  }, 30_000);
});
