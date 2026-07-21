import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { BULK_SYNC_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const statusContract = BULK_SYNC_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.operationId === 'getCheckInsBulkSyncJobsByJobId',
);
const chunksContract = BULK_SYNC_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.operationId === 'getCheckInsBulkSyncJobsByJobIdChunks',
);
if (!statusContract || !chunksContract) throw new Error('Missing bulk-sync read contracts');

describeWithIntegrationDatabase(
  `bulk-sync job read authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let previousDriver: string | undefined;
    let activePrincipal: Principal;

    const suffix = ulid().slice(-8).toLowerCase();
    const tenantA = `tnt_bsr_a_${suffix}`;
    const tenantB = `tnt_bsr_b_${suffix}`;
    const organizationA = `org_bsr_a_${suffix}`;
    const organizationOther = `org_bsr_o_${suffix}`;
    const organizationB = `org_bsr_b_${suffix}`;
    const brandA = `brd_bsr_a_${suffix}`;
    const brandOther = `brd_bsr_o_${suffix}`;
    const brandOrgOther = `brd_bsr_g_${suffix}`;
    const brandB = `brd_bsr_b_${suffix}`;
    const eventA = `evt_bsr_a_${suffix}`;
    const eventOther = `evt_bsr_e_${suffix}`;
    const eventBrandOther = `evt_bsr_r_${suffix}`;
    const eventOrgOther = `evt_bsr_o_${suffix}`;
    const eventB = `evt_bsr_b_${suffix}`;
    const deviceA = `sd_bsr_a_${suffix}`;
    const deviceOther = `sd_bsr_o_${suffix}`;
    const jobA = `bcs_bsr_a_${suffix}`;
    const jobEligible = `bcs_bsr_q_${suffix}`;
    const jobEventOther = `bcs_bsr_e_${suffix}`;
    const jobBrandOther = `bcs_bsr_r_${suffix}`;
    const jobOrgOther = `bcs_bsr_o_${suffix}`;
    const jobB = `bcs_bsr_b_${suffix}`;
    const eventIds = [eventA, eventOther, eventBrandOther, eventOrgOther, eventB] as const;
    const jobIds = [jobA, jobEligible, jobEventOther, jobBrandOther, jobOrgOther, jobB] as const;
    const listByEvent = new Map<string, string>();
    const chunkIds = [`bch_bsr_1_${suffix}`, `bch_bsr_2_${suffix}`, `bch_bsr_x_${suffix}`] as const;

    const basePrincipal = (): Principal => ({
      type: 'user',
      id: `usr_bsr_${suffix}`,
      tenantId: tenantA,
      organizationIds: [organizationA],
      brandIds: [brandA],
      eventIds: [eventA],
      scopes: ['checkins.read'],
    });

    async function insertTenant(id: string): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      await db
        .insertInto('tenants')
        .values({ id, name: id, status: 'active', plan: 'test', created_at: now, updated_at: now })
        .execute();
    }

    async function insertOrganization(id: string, tenantId: string): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      await db
        .insertInto('organizations')
        .values({
          id,
          tenant_id: tenantId,
          name: id,
          slug: `${id}-slug`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertBrand(
      id: string,
      tenantId: string,
      organizationId: string,
    ): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      await db
        .insertInto('brands')
        .values({
          id,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: id,
          slug: `${id}-slug`,
          status: 'active',
          theme: '{}',
          support_url: null,
          legal_urls: '{}',
          white_label: false,
          payment_account_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertEvent(
      id: string,
      tenantId: string,
      organizationId: string,
      brandId: string,
    ): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      await db
        .insertInto('events')
        .values({
          id,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brandId,
          slug: `${id}-slug`,
          title: id,
          description: null,
          status: 'published',
          currency: 'USD',
          timezone: 'UTC',
          starts_at: new Date('2027-01-01T18:00:00.000Z'),
          ends_at: null,
          venue: null,
          visibility: 'private',
          seo: '{}',
          capacity: null,
          cover_image_url: null,
          external_url: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const listId = `cil_${id.slice(4)}`;
      await db
        .insertInto('check_in_lists')
        .values({
          id: listId,
          event_id: id,
          name: `${id} doors`,
          ticket_type_ids: '[]',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      listByEvent.set(id, listId);
    }

    async function insertJob(
      id: string,
      tenantId: string,
      eventId: string,
      deviceId: string,
      eligible = true,
    ): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      const listId = listByEvent.get(eventId);
      if (!listId) throw new Error(`Missing check-in list for ${eventId}`);
      await db
        .insertInto('offline_check_in_sync_jobs')
        .values({
          id,
          tenant_id: tenantId,
          event_id: eventId,
          check_in_list_id: listId,
          device_id: deviceId,
          requested_by_principal_id: deviceId,
          total_chunks: eligible ? 1 : 2,
          total_scans: eligible ? 1 : 2,
          chunks_received: eligible ? 1 : 2,
          chunks_processed: eligible ? 0 : 2,
          accepted_count: eligible ? 0 : 1,
          duplicate_count: 0,
          invalid_count: eligible ? 0 : 1,
          sample_errors: eligible
            ? JSON.stringify([])
            : JSON.stringify([
                { sequence: 2, scanIndex: 0, qrHash: 'secret-job-qr', outcome: 'not_found' },
              ]),
          status: eligible ? 'receiving' : 'completed',
          failure_message: null,
          attempt_count: 0,
          lease_owner: null,
          leased_until: null,
          next_attempt_at: null,
          last_attempted_at: null,
          last_heartbeat_at: null,
          processing_started_at: null,
          processing_completed_at: eligible ? null : now,
          processing_duration_ms: eligible ? 0 : 7,
          transaction_duration_ms: eligible ? 0 : 5,
          lock_wait_ms: 0,
          scan_log_insert_duration_ms: eligible ? 0 : 2,
          ticket_update_duration_ms: 0,
          attendee_update_duration_ms: 0,
          rows_processed: eligible ? 0 : 2,
          clock_warning_count: 0,
          created_at: now,
          updated_at: now,
          completed_at: eligible ? null : now,
        })
        .execute();
    }

    async function insertChunk(id: string, tenantId: string, sequence: number): Promise<void> {
      const now = new Date('2026-07-21T02:00:00.000Z');
      await db
        .insertInto('offline_check_in_sync_chunks')
        .values({
          id,
          tenant_id: tenantId,
          job_id: jobA,
          sequence,
          scan_count: 1,
          payload_hash: `secret-hash-${sequence}`,
          payload: JSON.stringify([{ qrHash: `secret-qr-${sequence}` }]),
          accepted_count: sequence === 1 ? 1 : 0,
          duplicate_count: 0,
          invalid_count: sequence === 2 ? 1 : 0,
          sample_errors:
            sequence === 2
              ? JSON.stringify([
                  { sequence, scanIndex: 0, qrHash: 'secret-chunk-qr', outcome: 'not_found' },
                ])
              : JSON.stringify([]),
          clock_warning_count: 0,
          status: 'processed',
          attempt_count: 1,
          failure_message: null,
          locked_at: null,
          processed_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function seedFixture(): Promise<void> {
      await insertTenant(tenantA);
      await insertTenant(tenantB);
      await insertOrganization(organizationA, tenantA);
      await insertOrganization(organizationOther, tenantA);
      await insertOrganization(organizationB, tenantB);
      await insertBrand(brandA, tenantA, organizationA);
      await insertBrand(brandOther, tenantA, organizationA);
      await insertBrand(brandOrgOther, tenantA, organizationOther);
      await insertBrand(brandB, tenantB, organizationB);
      await insertEvent(eventA, tenantA, organizationA, brandA);
      await insertEvent(eventOther, tenantA, organizationA, brandA);
      await insertEvent(eventBrandOther, tenantA, organizationA, brandOther);
      await insertEvent(eventOrgOther, tenantA, organizationOther, brandOrgOther);
      await insertEvent(eventB, tenantB, organizationB, brandB);
      await insertJob(jobA, tenantA, eventA, deviceA, false);
      await insertJob(jobEligible, tenantA, eventA, deviceA);
      await insertJob(jobEventOther, tenantA, eventOther, deviceA);
      await insertJob(jobBrandOther, tenantA, eventBrandOther, deviceA);
      await insertJob(jobOrgOther, tenantA, eventOrgOther, deviceA);
      await insertJob(jobB, tenantB, eventB, deviceA);
      await insertChunk(chunkIds[1], tenantA, 2);
      await insertChunk(chunkIds[0], tenantA, 1);
      await insertChunk(chunkIds[2], tenantB, 3);
    }

    async function cleanupFixture(): Promise<void> {
      if (!db) return;
      await db
        .deleteFrom('offline_check_in_sync_chunks')
        .where('job_id', 'in', [...jobIds])
        .execute();
      await db
        .deleteFrom('offline_check_in_sync_jobs')
        .where('id', 'in', [...jobIds])
        .execute();
      await db
        .deleteFrom('check_in_lists')
        .where('event_id', 'in', [...eventIds])
        .execute();
      await db
        .deleteFrom('events')
        .where('id', 'in', [...eventIds])
        .execute();
      await db
        .deleteFrom('brands')
        .where('id', 'in', [brandA, brandOther, brandOrgOther, brandB])
        .execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationOther, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
      listByEvent.clear();
    }

    async function snapshot(): Promise<unknown> {
      const [jobs, chunks] = await Promise.all([
        db
          .selectFrom('offline_check_in_sync_jobs')
          .selectAll()
          .where('id', 'in', [...jobIds])
          .orderBy('id', 'asc')
          .execute(),
        db
          .selectFrom('offline_check_in_sync_chunks')
          .selectAll()
          .where('job_id', 'in', [...jobIds])
          .orderBy('id', 'asc')
          .execute(),
      ]);
      return { jobs, chunks };
    }

    async function invokeBoth(jobId: string) {
      return Promise.all([
        app.inject({ method: 'GET', url: `/check-ins/bulk-sync-jobs/${jobId}` }),
        app.inject({ method: 'GET', url: `/check-ins/bulk-sync-jobs/${jobId}/chunks` }),
      ]);
    }

    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await seedFixture();
      activePrincipal = basePrincipal();
      app = Fastify({ logger: false });
      app.decorate('context', { db } as AppContext);
      app.addHook('preHandler', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(checkInRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(() => {
      activePrincipal = basePrincipal();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      try {
        if (app) await app.close();
      } finally {
        try {
          if (db) await cleanupFixture();
        } finally {
          if (db) await db.destroy();
          restoreDatabaseDriver(previousDriver);
        }
      }
    }, 120_000);

    it('binds both executable contracts including the status persistence side effect', () => {
      expect(statusContract).toMatchObject({
        method: 'GET',
        path: '/check-ins/bulk-sync-jobs/{jobId}',
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event', 'owner'],
        sideEffectAssertions: ['persistence'],
      });
      expect(chunksContract).toMatchObject({
        method: 'GET',
        path: '/check-ins/bulk-sync-jobs/{jobId}/chunks',
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event', 'owner'],
        sideEffectAssertions: [],
      });
    });

    it.each(['user', 'api_key'] as const)(
      'returns exact completed status to an authorized %s without scheduling',
      async (type) => {
        activePrincipal = { ...basePrincipal(), type };
        const before = await snapshot();
        const timer = vi.spyOn(globalThis, 'setTimeout');

        const response = await app.inject({
          method: statusContract.method,
          url: `/check-ins/bulk-sync-jobs/${jobA}`,
        });

        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          id: jobA,
          tenantId: tenantA,
          eventId: eventA,
          deviceId: deviceA,
          totalChunks: 2,
          chunksReceived: 2,
          chunksProcessed: 2,
          status: 'completed',
          accepted: 1,
          invalid: 1,
          sampleErrors: [{ sequence: 2, scanIndex: 0, outcome: 'not_found' }],
        });
        expect(response.body).not.toContain('secret-job-qr');
        expect(timer.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
      },
    );

    it('returns ordered redacted chunk summaries and excludes a mismatched-tenant child', async () => {
      const before = await snapshot();
      const response = await app.inject({
        method: chunksContract.method,
        url: `/check-ins/bulk-sync-jobs/${jobA}/chunks`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        total: 2,
        items: [
          { id: chunkIds[0], sequence: 1, accepted: 1, invalid: 0, sampleErrors: [] },
          {
            id: chunkIds[1],
            sequence: 2,
            accepted: 0,
            invalid: 1,
            sampleErrors: [{ sequence: 2, scanIndex: 0, outcome: 'not_found' }],
          },
        ],
      });
      expect(response.body).not.toContain(chunkIds[2]);
      expect(response.body).not.toContain('secret-qr');
      expect(response.body).not.toContain('secret-hash');
      expect(await snapshot()).toEqual(before);
    });

    it('allows only the owning mobile device to read its exact job and chunks', async () => {
      activePrincipal = { ...basePrincipal(), type: 'mobile_device', id: deviceA };
      const [status, chunks] = await invokeBoth(jobA);
      expect(status.statusCode, status.body).toBe(200);
      expect(chunks.statusCode, chunks.body).toBe(200);
      expect(status.json().id).toBe(jobA);
      expect(chunks.json().items).toHaveLength(2);
    });

    it('denies both reads without permission before scheduling or disclosure', async () => {
      activePrincipal = { ...basePrincipal(), scopes: [] };
      const before = await snapshot();
      const timer = vi.spyOn(globalThis, 'setTimeout');
      const responses = await invokeBoth(jobEligible);
      for (const response of responses) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(response.body).not.toContain(jobEligible);
      }
      expect(timer.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
    });

    it.each([
      [
        'tenant',
        () => ({
          ...basePrincipal(),
          organizationIds: [organizationB],
          brandIds: [brandB],
          eventIds: [eventB],
        }),
        jobB,
      ],
      [
        'organization',
        () => ({
          ...basePrincipal(),
          brandIds: [brandOrgOther],
          eventIds: [eventOrgOther],
        }),
        jobOrgOther,
      ],
      ['brand', () => ({ ...basePrincipal(), eventIds: [eventBrandOther] }), jobBrandOther],
      ['event', () => basePrincipal(), jobEventOther],
      [
        'owner',
        () => ({ ...basePrincipal(), type: 'mobile_device' as const, id: deviceOther }),
        jobEligible,
      ],
    ] as const)(
      'denies both reads across the %s boundary before scheduling',
      async (_boundary, principalFactory, targetJobId) => {
        activePrincipal = principalFactory();
        const before = await snapshot();
        const timer = vi.spyOn(globalThis, 'setTimeout');
        const responses = await invokeBoth(targetJobId);
        for (const response of responses) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        }
        expect(timer.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0);
        expect(await snapshot()).toEqual(before);
      },
    );

    it('keeps unknown jobs concealed and side-effect free', async () => {
      const unknownJobId = `bcs_missing_${suffix}`;
      const before = await snapshot();
      const timer = vi.spyOn(globalThis, 'setTimeout');
      const responses = await invokeBoth(unknownJobId);
      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
      expect(timer.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(0);
      expect(await snapshot()).toEqual(before);
    });

    it('schedules eligible work exactly once and only after complete authorization', async () => {
      const before = await snapshot();
      const timer = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation(
          ((..._args: Parameters<typeof setTimeout>) =>
            0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
        );

      const response = await app.inject({
        method: statusContract.method,
        url: `/check-ins/bulk-sync-jobs/${jobEligible}`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: jobEligible, status: 'receiving' });
      expect(timer.mock.calls.filter(([, delay]) => delay === 0)).toHaveLength(1);
      expect(await snapshot()).toEqual(before);
    });
  },
);
