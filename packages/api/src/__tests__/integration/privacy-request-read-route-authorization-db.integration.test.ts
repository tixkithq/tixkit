import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { privacyRoutes } from '../../routes/modules/privacy.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { PRIVACY_REQUEST_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const readContract = (() => {
  const contract = PRIVACY_REQUEST_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'getPrivacyRequestsByRequestId',
  );
  if (!contract) throw new Error('Missing privacy-request read authorization contract');
  return contract;
})();

const suffix = ulid().slice(-8).toLowerCase();
const tenantA = `tnt_prr_a_${suffix}`;
const tenantB = `tnt_prr_b_${suffix}`;
const organizationA = `org_prr_a_${suffix}`;
const organizationOther = `org_prr_o_${suffix}`;
const organizationB = `org_prr_b_${suffix}`;
const brandA = `brd_prr_a_${suffix}`;
const brandOther = `brd_prr_o_${suffix}`;
const brandOrganizationOther = `brd_prr_g_${suffix}`;
const brandB = `brd_prr_b_${suffix}`;
const requestA = `prv_prr_a_${suffix}`;
const requestOrganizationWide = `prv_prr_w_${suffix}`;
const requestOtherOrganization = `prv_prr_o_${suffix}`;
const requestB = `prv_prr_b_${suffix}`;
const unknownRequest = `prv_prr_x_${suffix}`;
const actorId = `usr_prr_${suffix}`;
const createdAt = new Date('2026-07-21T03:04:05.000Z');
const completedAt = new Date('2026-07-21T03:14:15.000Z');

type SeedPrivacyRequest = Readonly<{
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string | null;
  subjectId: string;
  subjectEmail: string;
}>;

describeWithIntegrationDatabase(
  `privacy-request read route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let previousDriver: string | undefined;
    let activePrincipal: Principal;

    const basePrincipal = (): Principal => ({
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: ['settings.write'],
    });

    async function insertTenant(id: string): Promise<void> {
      await db
        .insertInto('tenants')
        .values({
          id,
          name: id,
          status: 'active',
          plan: 'test',
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
    }

    async function insertOrganization(id: string, tenantId: string): Promise<void> {
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
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
    }

    async function insertBrand(
      id: string,
      tenantId: string,
      organizationId: string,
    ): Promise<void> {
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
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
    }

    async function insertPrivacyRequest(input: SeedPrivacyRequest): Promise<void> {
      await db
        .insertInto('privacy_requests')
        .values({
          id: input.id,
          tenant_id: input.tenantId,
          organization_id: input.organizationId,
          brand_id: input.brandId,
          request_type: 'export',
          subject_type: 'buyer',
          subject_id: input.subjectId,
          subject_email: input.subjectEmail,
          status: 'completed',
          requested_by: actorId,
          result: JSON.stringify({ exportedRecords: 7, downloadReady: true }),
          error: null,
          created_at: createdAt,
          completed_at: completedAt,
        })
        .execute();
    }

    async function privacySnapshot() {
      return db
        .selectFrom('privacy_requests')
        .selectAll()
        .where('id', 'in', [requestA, requestOrganizationWide, requestOtherOrganization, requestB])
        .orderBy('id', 'asc')
        .execute();
    }

    function invoke(requestId: string) {
      return app.inject({
        method: readContract.method,
        url: readContract.path.replace('{requestId}', requestId),
      });
    }

    async function invokeReadOnly(requestId: string) {
      const before = await privacySnapshot();
      const response = await invoke(requestId);
      expect(await privacySnapshot()).toEqual(before);
      return response;
    }

    function errorCode(response: Awaited<ReturnType<typeof invoke>>) {
      return (response.json() as { error: { code: string } }).error.code;
    }

    function errorMessage(response: Awaited<ReturnType<typeof invoke>>) {
      return (response.json() as { error: { message: string } }).error.message;
    }

    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());

      await insertTenant(tenantA);
      await insertTenant(tenantB);
      await insertOrganization(organizationA, tenantA);
      await insertOrganization(organizationOther, tenantA);
      await insertOrganization(organizationB, tenantB);
      await insertBrand(brandA, tenantA, organizationA);
      await insertBrand(brandOther, tenantA, organizationA);
      await insertBrand(brandOrganizationOther, tenantA, organizationOther);
      await insertBrand(brandB, tenantB, organizationB);
      await insertPrivacyRequest({
        id: requestA,
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        subjectId: `buyer_a_${suffix}`,
        subjectEmail: `buyer-a-${suffix}@example.test`,
      });
      await insertPrivacyRequest({
        id: requestOrganizationWide,
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: null,
        subjectId: `buyer_w_${suffix}`,
        subjectEmail: `buyer-wide-${suffix}@example.test`,
      });
      await insertPrivacyRequest({
        id: requestOtherOrganization,
        tenantId: tenantA,
        organizationId: organizationOther,
        brandId: brandOrganizationOther,
        subjectId: `buyer_o_${suffix}`,
        subjectEmail: `buyer-other-${suffix}@example.test`,
      });
      await insertPrivacyRequest({
        id: requestB,
        tenantId: tenantB,
        organizationId: organizationB,
        brandId: brandB,
        subjectId: `buyer_b_${suffix}`,
        subjectEmail: `buyer-foreign-${suffix}@example.test`,
      });

      activePrincipal = basePrincipal();
      app = Fastify({ logger: false });
      app.decorate('context', { db } as AppContext);
      app.addHook('onRequest', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(privacyRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(() => {
      activePrincipal = basePrincipal();
    });

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };

      if (app) await cleanup(() => app.close());
      if (db) {
        await cleanup(() =>
          db
            .deleteFrom('privacy_requests')
            .where('id', 'in', [
              requestA,
              requestOrganizationWide,
              requestOtherOrganization,
              requestB,
            ])
            .execute(),
        );
        for (const brandId of [brandA, brandOther, brandOrganizationOther, brandB]) {
          await cleanup(() => db.deleteFrom('brands').where('id', '=', brandId).execute());
        }
        for (const organizationId of [organizationA, organizationOther, organizationB]) {
          await cleanup(() =>
            db.deleteFrom('organizations').where('id', '=', organizationId).execute(),
          );
        }
        for (const tenantId of [tenantA, tenantB]) {
          await cleanup(() => db.deleteFrom('tenants').where('id', '=', tenantId).execute());
        }
        await cleanup(() => db.destroy());
      }
      try {
        restoreDatabaseDriver(previousDriver);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up privacy-request read proof');
      }
    }, 120_000);

    it('binds the immutable privacy-request read denial contract to this DB proof', () => {
      expect(Object.isFrozen(PRIVACY_REQUEST_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)).toBe(true);
      expect(Object.isFrozen(readContract)).toBe(true);
      expect(readContract).toMatchObject({
        authorizedControl: { required: true, status: 200 },
        denialResponse: { code: 'NOT_FOUND', status: 404 },
        deniedBoundaries: ['tenant', 'organization', 'brand'],
        method: 'GET',
        operationId: 'getPrivacyRequestsByRequestId',
        path: '/privacy/requests/{requestId}',
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
        policyDeniedBoundaries: ['event'],
        policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
        resourceParameters: ['requestId'],
        sideEffectAssertions: [],
        source: 'privacy-request-read-route-authorization-db.integration.test.ts',
      });
    });

    it('returns the exact serialized brand request to an authorized organization-wide user', async () => {
      const response = await invokeReadOnly(requestA);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id: requestA,
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        requestType: 'export',
        subjectType: 'buyer',
        subjectId: `buyer_a_${suffix}`,
        subjectEmail: `buyer-a-${suffix}@example.test`,
        status: 'completed',
        requestedBy: actorId,
        result: { exportedRecords: 7, downloadReady: true },
        error: null,
        createdAt: createdAt.toISOString(),
        completedAt: completedAt.toISOString(),
      });
      expect(response.json()).not.toHaveProperty('tenant_id');
      expect(response.json()).not.toHaveProperty('organization_id');
      expect(response.json()).not.toHaveProperty('subject_email');
    });

    it('allows an exact brand-scoped API key and returns no row from another scope', async () => {
      activePrincipal = {
        type: 'api_key',
        id: `ak_prr_${suffix}`,
        tenantId: tenantA,
        organizationIds: [organizationA],
        brandIds: [brandA],
        scopes: ['settings.write'],
      };

      const response = await invokeReadOnly(requestA);
      const organizationWide = await invokeReadOnly(requestOrganizationWide);
      expect(response.statusCode).toBe(200);
      expect(organizationWide.statusCode).toBe(404);
      expect(errorCode(organizationWide)).toBe('NOT_FOUND');
      expect(response.json()).toMatchObject({
        id: requestA,
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
      });
    });

    it('denies principals missing settings.write before returning a request', async () => {
      activePrincipal = { ...basePrincipal(), scopes: [] };

      const response = await invokeReadOnly(requestA);
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('FORBIDDEN');
    });

    it('denies event-scoped principals identically for existing and unknown request IDs', async () => {
      activePrincipal = { ...basePrincipal(), eventIds: [`evt_prr_${suffix}`] };

      const existing = await invokeReadOnly(requestA);
      const unknown = await invokeReadOnly(unknownRequest);
      expect(existing.statusCode).toBe(403);
      expect(unknown.statusCode).toBe(403);
      expect(errorCode(existing)).toBe('FORBIDDEN');
      expect(errorCode(unknown)).toBe('FORBIDDEN');
      expect(errorMessage(existing)).toBe(errorMessage(unknown));
    });

    it('conceals a request outside the principal organization', async () => {
      activePrincipal = {
        ...basePrincipal(),
        organizationIds: [organizationOther],
      };

      const response = await invokeReadOnly(requestA);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('conceals a request outside the principal brand', async () => {
      activePrincipal = {
        ...basePrincipal(),
        brandIds: [brandOther],
      };

      const response = await invokeReadOnly(requestA);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('conceals organization-wide rows from brand-scoped principals', async () => {
      activePrincipal = {
        ...basePrincipal(),
        brandIds: [brandA],
      };

      const response = await invokeReadOnly(requestOrganizationWide);
      expect(response.statusCode).toBe(404);
      expect(errorCode(response)).toBe('NOT_FOUND');
    });

    it('makes cross-tenant and unknown request IDs indistinguishable', async () => {
      const crossTenant = await invokeReadOnly(requestB);
      const unknown = await invokeReadOnly(unknownRequest);

      expect(crossTenant.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(errorCode(crossTenant)).toBe('NOT_FOUND');
      expect(errorCode(unknown)).toBe('NOT_FOUND');
      expect(errorMessage(crossTenant).replace(requestB, '<request-id>')).toBe(
        errorMessage(unknown).replace(unknownRequest, '<request-id>'),
      );
    });

    it('keeps tenant, organization, and brand isolation exact across all seeded rows', async () => {
      activePrincipal = {
        ...basePrincipal(),
        brandIds: [brandA],
      };

      const allowed = await invokeReadOnly(requestA);
      const wrongBrand = await invokeReadOnly(requestOtherOrganization);
      const crossTenant = await invokeReadOnly(requestB);
      expect(allowed.statusCode).toBe(200);
      expect(wrongBrand.statusCode).toBe(404);
      expect(crossTenant.statusCode).toBe(404);
      expect(allowed.json().id).toBe(requestA);
    });

    it('leaves every complete privacy row unchanged after the full read and denial matrix', async () => {
      const before = await privacySnapshot();

      await invoke(requestA);
      activePrincipal = { ...basePrincipal(), scopes: [] };
      await invoke(requestA);
      activePrincipal = { ...basePrincipal(), eventIds: [`evt_prr_${suffix}`] };
      await invoke(unknownRequest);
      activePrincipal = basePrincipal();
      await invoke(requestB);

      expect(await privacySnapshot()).toEqual(before);
      expect(before).toHaveLength(4);
      for (const row of before) {
        expect(row).toMatchObject({
          status: 'completed',
          request_type: 'export',
          subject_type: 'buyer',
          requested_by: actorId,
          completed_at: completedAt,
        });
      }
    });
  },
);
