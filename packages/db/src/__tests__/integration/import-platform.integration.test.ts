import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  ImportRepository,
  OrganizationRepository,
  TenantRepository,
} from '../../repositories/index.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
];
const driverCases = allDriverCases.filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
);

if (driverCases.length === 0) {
  it.skip('import platform integration (database URLs are not configured)', () => {});
}

describe.sequential.each(driverCases)('import platform: $driver', ({ driver, url }) => {
  let db: Database;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('atomically refuses dry-run and non-ready jobs at the commit boundary', async () => {
    const tenant = await new TenantRepository(db).create({
      name: `Commit boundary ${driver}`,
    });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Commit boundary ${driver}`,
      slug: `commit-boundary-${driver}`,
    });
    const imports = new ImportRepository(db);
    const dryRun = await imports.createJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'generic-csv',
      adapterVersion: '1',
      mode: 'dry-run',
      idempotencyKey: `dry-run-${driver}`,
      requestedBy: 'test',
    });
    await imports.transitionJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: dryRun.id,
      from: ['pending'],
      to: 'ready',
    });
    await expect(
      imports.beginCommit({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: dryRun.id,
      }),
    ).rejects.toThrow('MIGRATION_DRY_RUN_CANNOT_COMMIT');
    expect((await imports.findJob(tenant.id, organization.id, dryRun.id))?.status).toBe('ready');

    const commit = await imports.createJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'generic-csv',
      adapterVersion: '1',
      mode: 'commit',
      idempotencyKey: `commit-${driver}`,
      requestedBy: 'test',
    });
    await expect(
      imports.beginCommit({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: commit.id,
      }),
    ).rejects.toThrow('MIGRATION_JOB_NOT_READY:pending');
    await imports.transitionJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: commit.id,
      from: ['pending'],
      to: 'ready',
    });
    await expect(
      imports.beginCommit({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: commit.id,
      }),
    ).resolves.toBeUndefined();
    expect((await imports.findJob(tenant.id, organization.id, commit.id))?.status).toBe(
      'committing',
    );
  });

  it('isolates durable jobs and external IDs by tenant and preserves idempotency', async () => {
    const tenants = new TenantRepository(db);
    const tenantA = await tenants.create({ name: 'Import tenant A' });
    const tenantB = await tenants.create({ name: 'Import tenant B' });
    const organizations = new OrganizationRepository(db);
    const organizationA = await organizations.create({
      tenantId: tenantA.id,
      name: 'Import org A',
      slug: 'import-org-a',
    });
    const organizationA2 = await organizations.create({
      tenantId: tenantA.id,
      name: 'Import org A2',
      slug: 'import-org-a2',
    });
    const organizationB = await organizations.create({
      tenantId: tenantB.id,
      name: 'Import org B',
      slug: 'import-org-b',
    });
    const imports = new ImportRepository(db);
    const createInput = {
      sourceSystem: 'generic-csv',
      adapterVersion: '1.0.0',
      mode: 'commit' as const,
      idempotencyKey: 'upload-sha256:abc',
      requestedBy: 'usr_importer',
    };

    const jobA = await imports.createJob({
      tenantId: tenantA.id,
      organizationId: organizationA.id,
      ...createInput,
    });
    const replayA = await imports.createJob({
      tenantId: tenantA.id,
      organizationId: organizationA.id,
      ...createInput,
    });
    const jobB = await imports.createJob({
      tenantId: tenantB.id,
      organizationId: organizationB.id,
      ...createInput,
    });
    await expect(
      imports.createJob({
        tenantId: tenantA.id,
        organizationId: organizationB.id,
        ...createInput,
        idempotencyKey: 'cross-tenant-org-must-fail',
      }),
    ).rejects.toThrow();
    expect(replayA.id).toBe(jobA.id);
    expect(jobB.id).not.toBe(jobA.id);
    await expect(imports.findJob(tenantB.id, organizationB.id, jobA.id)).resolves.toBeUndefined();
    await expect(imports.findJob(tenantA.id, organizationA2.id, jobA.id)).resolves.toBeUndefined();

    const referenceA = await imports.recordExternalReference({
      tenantId: tenantA.id,
      organizationId: organizationA.id,
      sourceSystem: 'generic-csv',
      entityType: 'event',
      externalId: 'event-1',
      tixkitId: 'evt_a',
      importJobId: jobA.id,
      createdByJob: true,
    });
    const referenceB = await imports.recordExternalReference({
      tenantId: tenantB.id,
      organizationId: organizationB.id,
      sourceSystem: 'generic-csv',
      entityType: 'event',
      externalId: 'event-1',
      tixkitId: 'evt_b',
      importJobId: jobB.id,
      createdByJob: true,
    });
    expect(referenceA.tixkit_id).toBe('evt_a');
    expect(referenceB.tixkit_id).toBe('evt_b');
    const jobA2 = await imports.createJob({
      tenantId: tenantA.id,
      organizationId: organizationA2.id,
      sourceSystem: 'generic-csv',
      adapterVersion: '1',
      mode: 'commit',
      idempotencyKey: 'same-tenant-other-org',
      requestedBy: 'test',
    });
    await expect(
      imports.recordExternalReference({
        tenantId: tenantA.id,
        organizationId: organizationA2.id,
        sourceSystem: 'generic-csv',
        entityType: 'event',
        externalId: 'event-1',
        tixkitId: 'evt_other_org',
        importJobId: jobA2.id,
        createdByJob: true,
      }),
    ).rejects.toThrow('belongs to another organization');
    await expect(
      imports.recordExternalReference({
        tenantId: tenantA.id,
        organizationId: organizationA.id,
        sourceSystem: 'generic-csv',
        entityType: 'event',
        externalId: 'event-1',
        tixkitId: 'evt_other',
        importJobId: jobA.id,
        createdByJob: false,
      }),
    ).rejects.toThrow('different Tixkit entity');
  });

  it('persists ordered progress and fails rollback closed after downstream activity', async () => {
    const tenant = await new TenantRepository(db).create({
      name: 'Rollback tenant',
    });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: 'Rollback org',
      slug: 'rollback-org',
    });
    const imports = new ImportRepository(db);
    const job = await imports.createJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'pretix',
      adapterVersion: '1.0.0',
      mode: 'commit',
      idempotencyKey: 'pretix:run-1',
      requestedBy: 'usr_importer',
    });
    await imports.addRows(tenant.id, organization.id, job.id, [
      {
        entityType: 'event',
        externalId: 'event-1',
        rowNumber: 1,
        sourceData: { name: 'Imported event' },
        normalizedData: { title: 'Imported event' },
        status: 'validated',
      },
    ]);
    const claimed = await imports.claimRows({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      entityTypes: ['event'],
      fromStatus: 'validated',
      claimStatus: 'committing',
      ownerToken: 'test-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.claim_attempt).toBe(1);
    await expect(
      imports.claimRows({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
        entityTypes: ['event'],
        fromStatus: 'validated',
        claimStatus: 'committing',
        ownerToken: 'other-owner',
        leaseExpiresAt: new Date(Date.now() + 60_000),
        limit: 10,
      }),
    ).resolves.toHaveLength(0);
    await db
      .updateTable('import_job_rows')
      .set({ claim_expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', claimed[0]!.id)
      .execute();
    const reclaimed = await imports.claimRows({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      entityTypes: ['event'],
      fromStatus: 'validated',
      claimStatus: 'committing',
      ownerToken: 'recovery-owner',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.claim_attempt).toBe(2);
    await expect(
      imports.completeRowWithExternalReference({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
        rowId: reclaimed[0]!.id,
        claimedStatus: 'committing',
        ownerToken: 'wrong-owner',
        outcome: 'created',
        sourceSystem: 'pretix',
        entityType: 'event',
        externalId: 'event-1',
        tixkitId: 'evt_imported',
        createdEntity: true,
      }),
    ).rejects.toThrow('claim was lost');
    await expect(
      imports.completeRowWithExternalReference({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
        rowId: reclaimed[0]!.id,
        claimedStatus: 'committing',
        ownerToken: 'recovery-owner',
        outcome: 'created',
        sourceSystem: 'pretix',
        entityType: 'event',
        externalId: 'event-1',
        tixkitId: 'evt_imported',
        createdEntity: true,
      }),
    ).resolves.toBeUndefined();
    await imports.appendEvent({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      sequence: 1,
      type: 'validation.completed',
      severity: 'info',
      message: 'Validated',
    });
    await imports.appendEvent({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      sequence: 2,
      type: 'commit.completed',
      severity: 'info',
      message: 'Committed',
    });
    await expect(imports.listEvents(tenant.id, organization.id, job.id)).resolves.toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
    ]);
    const progress = await imports.appendIdempotentEvent({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      eventKey: 'commit:progress:event:1',
      type: 'commit.progress',
      severity: 'info',
      message: 'Processed one row',
      data: { processed: 1 },
    });
    const replay = await imports.appendIdempotentEvent({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      eventKey: 'commit:progress:event:1',
      type: 'commit.progress',
      severity: 'info',
      message: 'Processed one row',
      data: { processed: 1 },
    });
    const reconciled = await imports.appendIdempotentEvent({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      eventKey: 'commit:reconciled',
      type: 'commit.reconciled',
      severity: 'info',
      message: 'Reconciled',
    });
    expect(replay.id).toBe(progress.id);
    expect(replay.message).toBe('Processed one row');
    expect([progress.sequence, reconciled.sequence]).toEqual([3, 4]);
    expect(
      await imports.transitionJob({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
        from: ['pending'],
        to: 'committed',
      }),
    ).toBe(true);
    await imports.recordExternalReference({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'pretix',
      entityType: 'ticket',
      externalId: 'ticket-1',
      tixkitId: 'tkt_imported',
      importJobId: job.id,
      createdByJob: true,
    });
    await expect(
      imports.getRollbackEligibility(tenant.id, organization.id, job.id),
    ).resolves.toMatchObject({
      eligible: true,
      mode: 'delete-created',
    });
    await imports.markRollbackBlocked({
      tenantId: tenant.id,
      organizationId: organization.id,
      entityType: 'ticket',
      tixkitId: 'tkt_imported',
      reason: 'Ticket was scanned after activation',
    });
    await expect(
      imports.getRollbackEligibility(tenant.id, organization.id, job.id),
    ).resolves.toMatchObject({
      eligible: false,
      mode: 'corrective-plan',
      blockers: [{ reason: 'Ticket was scanned after activation' }],
    });
  });

  it('scopes expiring credential references and rejects revoked or expired credentials', async () => {
    const tenant = await new TenantRepository(db).create({ name: 'Credential tenant' });
    const organizations = new OrganizationRepository(db);
    const organization = await organizations.create({
      tenantId: tenant.id,
      name: 'Credential organization',
      slug: 'credential-organization',
    });
    const otherOrganization = await organizations.create({
      tenantId: tenant.id,
      name: 'Other credential organization',
      slug: 'other-credential-organization',
    });
    const imports = new ImportRepository(db);
    const active = await imports.createCredential({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'generic-csv',
      secretReference: 'secret://migrations/generic-csv',
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: 'usr_credential',
    });
    expect(
      await imports.findActiveCredential({
        tenantId: tenant.id,
        organizationId: organization.id,
        credentialId: active.id,
        sourceSystem: 'generic-csv',
      }),
    ).toBeDefined();
    expect(
      await imports.findActiveCredential({
        tenantId: tenant.id,
        organizationId: otherOrganization.id,
        credentialId: active.id,
        sourceSystem: 'generic-csv',
      }),
    ).toBeUndefined();
    expect(
      await imports.revokeCredential({
        tenantId: tenant.id,
        organizationId: organization.id,
        credentialId: active.id,
      }),
    ).toBe(true);
    expect(
      await imports.findActiveCredential({
        tenantId: tenant.id,
        organizationId: organization.id,
        credentialId: active.id,
        sourceSystem: 'generic-csv',
      }),
    ).toBeUndefined();
    const expired = await imports.createCredential({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'generic-csv',
      secretReference: 'vault://migrations/expired',
      // MySQL DATETIME stores whole seconds, so keep the fixture outside its
      // rounding window while still exercising repository expiry enforcement.
      expiresAt: new Date(Date.now() - 2_000),
      createdBy: 'usr_credential',
    });
    expect(
      await imports.findActiveCredential({
        tenantId: tenant.id,
        organizationId: organization.id,
        credentialId: expired.id,
        sourceSystem: 'generic-csv',
      }),
    ).toBeUndefined();
  });

  it('persists preparation rows, conflicts, and cursors atomically and idempotently', async () => {
    const tenant = await new TenantRepository(db).create({ name: `Preparation ${driver}` });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Preparation ${driver}`,
      slug: `preparation-${driver}`,
    });
    const imports = new ImportRepository(db);
    const job = await imports.createJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      sourceSystem: 'generic-csv',
      adapterVersion: 'rfc4180-v1',
      mode: 'commit',
      idempotencyKey: `preparation-${driver}`,
      requestedBy: 'test',
    });
    await imports.transitionJob({
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      from: ['pending'],
      to: 'preparing' as never,
    });
    const chunk = {
      tenantId: tenant.id,
      organizationId: organization.id,
      jobId: job.id,
      cursorKey: 'artifact-sha:first',
      nextCursor: 'cursor-2',
      startRowNumber: 0,
      completed: false,
      rows: [
        {
          entityType: 'event',
          externalId: 'event-1',
          sourceData: { id: 'event-1', secret: undefined },
          normalizedData: {
            entityType: 'event',
            externalId: 'event-1',
            sourcePosition: 'events.csv:2',
            attributes: { title: 'Event', currency: 'USD', timezone: 'UTC' },
          },
          issues: [
            {
              code: 'TIMEZONE_REVIEW',
              severity: 'warning',
              message: 'Review timezone',
            },
          ],
        },
      ],
    };
    await expect(imports.persistPreparationChunk(chunk)).resolves.toEqual({
      inserted: 1,
      rowNumber: 1,
    });
    await expect(imports.persistPreparationChunk(chunk)).resolves.toEqual({
      inserted: 0,
      rowNumber: 1,
    });
    await expect(imports.preparationProgress(tenant.id, organization.id, job.id)).resolves.toEqual({
      cursor: 'cursor-2',
      rowNumber: 1,
      completed: false,
    });
    expect(
      await imports.listRows({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
      }),
    ).toHaveLength(1);
    expect(
      await imports.listConflicts({
        tenantId: tenant.id,
        organizationId: organization.id,
        jobId: job.id,
      }),
    ).toHaveLength(1);
    await imports.persistPreparationChunk({
      ...chunk,
      cursorKey: 'artifact-sha:cursor-2',
      nextCursor: undefined,
      startRowNumber: 1,
      completed: true,
      rows: [],
    });
    expect((await imports.findJob(tenant.id, organization.id, job.id))?.status).toBe('prepared');
  });
});
