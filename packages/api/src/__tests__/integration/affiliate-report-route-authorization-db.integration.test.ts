import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type Scope = Readonly<{
  brandId: string;
  eventId: string;
  organizationId: string;
  tenantId: string;
}>;

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_aff_a_${suffix}`;
const tenantB = `tnt_aff_b_${suffix}`;
const primary: Scope = {
  tenantId: tenantA,
  organizationId: `org_aff_a_${suffix}`,
  brandId: `brd_aff_a_${suffix}`,
  eventId: `evt_aff_a_${suffix}`,
};
const sameTenantOtherOrganization: Scope = {
  tenantId: tenantA,
  organizationId: `org_aff_o_${suffix}`,
  brandId: `brd_aff_o_${suffix}`,
  eventId: `evt_aff_o_${suffix}`,
};
const foreignTenant: Scope = {
  tenantId: tenantB,
  organizationId: `org_aff_b_${suffix}`,
  brandId: `brd_aff_b_${suffix}`,
  eventId: `evt_aff_b_${suffix}`,
};
const now = new Date('2026-07-23T12:00:00.000Z');

describeWithIntegrationDatabase(
  `affiliate reporting route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let cancelledOrderId: string;
    let foreignTenantOrderId: string;
    let fullyPaidOrderId: string;
    let otherOrganizationOrderId: string;
    let overRefundedOrderId: string;
    let pendingOrderId: string;
    let previousDriver: string | undefined;
    let testOrderId: string;
    let activePrincipal: Principal;

    function principal(overrides: Partial<Principal> = {}): Principal {
      return {
        type: 'user',
        id: `usr_aff_${suffix}`,
        tenantId: tenantA,
        organizationIds: [primary.organizationId],
        scopes: ['reports.read'],
        ...overrides,
      };
    }

    async function insertTenant(id: string): Promise<void> {
      await db
        .insertInto('tenants')
        .values({
          id,
          name: id,
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertScope(scope: Scope, marker: string): Promise<void> {
      await db
        .insertInto('organizations')
        .values({
          id: scope.organizationId,
          tenant_id: scope.tenantId,
          name: `Affiliate ${marker}`,
          slug: `affiliate-${marker}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('brands')
        .values({
          id: scope.brandId,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          name: `Affiliate ${marker}`,
          slug: `affiliate-${marker}`,
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
      await db
        .insertInto('events')
        .values({
          id: scope.eventId,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          brand_id: scope.brandId,
          slug: `affiliate-${marker}`,
          title: `Affiliate ${marker}`,
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
    }

    async function insertOrder(input: {
      marker: string;
      isTest?: boolean;
      organizationId?: string;
      refundedCents: number;
      scope: Scope;
      status?: 'cancelled' | 'paid' | 'partially_refunded' | 'pending' | 'refunded';
      totalCents: number;
    }): Promise<string> {
      const key = input.marker.replaceAll(/[^a-z]/g, '').slice(0, 6);
      const orderId = `ord_aff_${key}_${suffix}`;
      const checkoutId = `cs_aff_${key}_${suffix}`;
      await db
        .insertInto('checkout_sessions')
        .values({
          id: checkoutId,
          tenant_id: input.scope.tenantId,
          event_id: input.scope.eventId,
          brand_id: input.scope.brandId,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: '{}',
          buyer: JSON.stringify({
            email: `buyer-${input.marker}@private.example`,
          }),
          quote: JSON.stringify({ totalCents: input.totalCents }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2026-07-23T13:00:00.000Z'),
          idempotency_key: `affiliate-${key}-${suffix}`,
          client_token: `affiliate-token-${key}-${suffix}`,
          is_test: input.isTest ?? false,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: input.scope.tenantId,
          organization_id: input.organizationId ?? input.scope.organizationId,
          brand_id: input.scope.brandId,
          event_id: input.scope.eventId,
          checkout_session_id: checkoutId,
          order_number: `AFF-${key}-${suffix}`,
          status:
            input.status ??
            (input.refundedCents >= input.totalCents
              ? 'refunded'
              : input.refundedCents > 0
                ? 'partially_refunded'
                : 'paid'),
          currency: 'USD',
          subtotal_cents: input.totalCents,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: input.totalCents,
          refunded_cents: input.refundedCents,
          buyer_email: `buyer-${input.marker}@private.example`,
          buyer_first_name: 'Private',
          buyer_last_name: 'Buyer',
          buyer_phone: '+15555550123',
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: input.isTest ?? false,
          paid_at: now,
          refunded_at: input.refundedCents > 0 ? now : null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return orderId;
    }

    async function insertAttribution(input: {
      affiliateId: string;
      commissionCents: number;
      id: string;
      orderId: string;
    }): Promise<void> {
      await db
        .insertInto('attributions')
        .values({
          id: input.id,
          order_id: input.orderId,
          affiliate_id: input.affiliateId,
          affiliate_code: 'PRIMARY',
          commission_cents: input.commissionCents,
          attributed_at: now,
          created_at: now,
        })
        .execute();
    }

    async function cleanup(): Promise<void> {
      const tenantIds = [tenantA, tenantB];
      await db.deleteFrom('attributions').where('id', 'like', `%${suffix}`).execute();
      await db.deleteFrom('orders').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('checkout_sessions').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('affiliates').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('events').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('brands').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('organizations').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('tenants').where('id', 'in', tenantIds).execute();
    }

    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await insertTenant(tenantA);
      await insertTenant(tenantB);
      await insertScope(primary, `a-${suffix}`);
      await insertScope(sameTenantOtherOrganization, `o-${suffix}`);
      await insertScope(foreignTenant, `b-${suffix}`);

      const paidOrderId = await insertOrder({
        scope: primary,
        marker: 'paid',
        totalCents: 10_000,
        refundedCents: 2_000,
      });
      const refundedOrderId = await insertOrder({
        scope: primary,
        marker: 'refunded',
        totalCents: 5_000,
        refundedCents: 5_000,
      });
      fullyPaidOrderId = await insertOrder({
        scope: primary,
        marker: 'paid-full',
        totalCents: 7_000,
        refundedCents: 0,
      });
      overRefundedOrderId = await insertOrder({
        scope: primary,
        marker: 'over-refund',
        totalCents: 4_000,
        refundedCents: 5_000,
      });
      otherOrganizationOrderId = await insertOrder({
        scope: sameTenantOtherOrganization,
        marker: 'other-org',
        totalCents: 9_000,
        refundedCents: 0,
      });
      foreignTenantOrderId = await insertOrder({
        scope: foreignTenant,
        organizationId: primary.organizationId,
        marker: 'foreign-tenant',
        totalCents: 11_000,
        refundedCents: 0,
      });
      testOrderId = await insertOrder({
        scope: primary,
        marker: 'test',
        totalCents: 20_000,
        refundedCents: 0,
        isTest: true,
      });
      pendingOrderId = await insertOrder({
        scope: primary,
        marker: 'pending',
        totalCents: 30_000,
        refundedCents: 0,
        status: 'pending',
      });
      cancelledOrderId = await insertOrder({
        scope: primary,
        marker: 'cancelled',
        totalCents: 40_000,
        refundedCents: 0,
        status: 'cancelled',
      });

      const primaryAffiliateId = `aff_primary_${suffix}`;
      await db
        .insertInto('affiliates')
        .values([
          {
            id: primaryAffiliateId,
            tenant_id: tenantA,
            organization_id: primary.organizationId,
            code: 'PRIMARY',
            name: 'Primary Affiliate',
            commission_percentage: 1_000,
            status: 'active',
            created_at: now,
            updated_at: now,
          },
          {
            id: `aff_zero_${suffix}`,
            tenant_id: tenantA,
            organization_id: primary.organizationId,
            code: 'ZERO',
            name: 'Zero Attribution Affiliate',
            commission_percentage: 1_000,
            status: 'active',
            created_at: now,
            updated_at: now,
          },
          {
            id: `aff_other_${suffix}`,
            tenant_id: tenantA,
            organization_id: sameTenantOtherOrganization.organizationId,
            code: 'OTHER-ORG',
            name: 'Other Organization Affiliate',
            commission_percentage: 1_000,
            status: 'active',
            created_at: now,
            updated_at: now,
          },
          {
            id: `aff_foreign_${suffix}`,
            tenant_id: tenantB,
            organization_id: foreignTenant.organizationId,
            code: 'FOREIGN',
            name: 'Foreign Affiliate',
            commission_percentage: 1_000,
            status: 'active',
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();
      await Promise.all([
        insertAttribution({
          id: `att_paid_a_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: paidOrderId,
          commissionCents: 1_000,
        }),
        insertAttribution({
          id: `att_paid_b_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: paidOrderId,
          commissionCents: 250,
        }),
        insertAttribution({
          id: `att_refunded_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: refundedOrderId,
          commissionCents: 500,
        }),
        insertAttribution({
          id: `att_paid_full_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: fullyPaidOrderId,
          commissionCents: 700,
        }),
        insertAttribution({
          id: `att_over_refund_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: overRefundedOrderId,
          commissionCents: 400,
        }),
        insertAttribution({
          id: `att_other_org_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: otherOrganizationOrderId,
          commissionCents: 900,
        }),
        insertAttribution({
          id: `att_foreign_tenant_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: foreignTenantOrderId,
          commissionCents: 1_100,
        }),
        insertAttribution({
          id: `att_test_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: testOrderId,
          commissionCents: 2_000,
        }),
        insertAttribution({
          id: `att_pending_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: pendingOrderId,
          commissionCents: 3_000,
        }),
        insertAttribution({
          id: `att_cancelled_${suffix}`,
          affiliateId: primaryAffiliateId,
          orderId: cancelledOrderId,
          commissionCents: 4_000,
        }),
      ]);

      activePrincipal = principal();
      app = Fastify({ logger: false });
      app.decorate('context', { db } as unknown as AppContext);
      app.addHook('onRequest', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(reportingRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(() => {
      activePrincipal = principal();
    });

    afterAll(async () => {
      const errors: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      if (app) await attempt(() => app.close());
      if (db) {
        await attempt(cleanup);
        await attempt(() => db.destroy());
      }
      restoreDatabaseDriver(previousDriver);
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean affiliate fixtures');
    }, 120_000);

    it('returns only exact tenant and organization aggregate data with paid and refund-clamped revenue', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${primary.organizationId}/reports/affiliate`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        organizationId: primary.organizationId,
        affiliates: [
          {
            affiliateId: `aff_primary_${suffix}`,
            code: 'PRIMARY',
            name: 'Primary Affiliate',
            referralsCount: 4,
            revenueAttributedCents: 15_000,
            commissionCents: 2_850,
          },
          {
            affiliateId: `aff_zero_${suffix}`,
            code: 'ZERO',
            name: 'Zero Attribution Affiliate',
            referralsCount: 0,
            revenueAttributedCents: 0,
            commissionCents: 0,
          },
        ],
      });
      for (const value of [
        'buyer-paid@private.example',
        'buyer-paid-full@private.example',
        'buyer-refunded@private.example',
        'buyer-over-refund@private.example',
        'buyer-other-org@private.example',
        'buyer-foreign-tenant@private.example',
        'Other Organization Affiliate',
        'Foreign Affiliate',
        otherOrganizationOrderId,
        foreignTenantOrderId,
        fullyPaidOrderId,
        overRefundedOrderId,
        testOrderId,
        pendingOrderId,
        cancelledOrderId,
      ]) {
        expect(response.body).not.toContain(value);
      }
    });

    it('denies reports.read before organization scope or aggregate access', async () => {
      activePrincipal = principal({ scopes: [] });
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${foreignTenant.organizationId}/reports/affiliate`,
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({
        error: {
          code: 'FORBIDDEN',
          message: 'Missing required permission: reports.read',
        },
      });
      expect(response.body).not.toContain('Primary Affiliate');
      expect(response.body).not.toContain(foreignTenant.tenantId);
    });

    it.each([
      ['same-tenant foreign', sameTenantOtherOrganization.organizationId, principal()],
      [
        'foreign-tenant claimed',
        foreignTenant.organizationId,
        principal({ organizationIds: [foreignTenant.organizationId] }),
      ],
      [
        'unknown',
        `org_aff_unknown_${suffix}`,
        principal({ organizationIds: [`org_aff_unknown_${suffix}`] }),
      ],
      [
        'system foreign-tenant',
        primary.organizationId,
        principal({
          type: 'system',
          id: `sys_aff_foreign_${suffix}`,
          tenantId: tenantB,
          organizationIds: [],
          brandIds: undefined,
          eventIds: undefined,
        }),
      ],
      [
        'system unknown',
        `org_aff_system_unknown_${suffix}`,
        principal({
          type: 'system',
          id: `sys_aff_unknown_${suffix}`,
          organizationIds: [],
          brandIds: undefined,
          eventIds: undefined,
        }),
      ],
    ] as const)(
      'conceals the %s organization as only the requested organization',
      async (_kind, id, actor) => {
        activePrincipal = actor;
        const response = await app.inject({
          method: 'GET',
          url: `/organizations/${id}/reports/affiliate`,
        });

        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `Organization not found: ${id}`,
            details: { resource: 'Organization', id },
            requestId: expect.any(String),
          },
        });
        expect(response.body).not.toContain('Primary Affiliate');
        expect(response.body).not.toContain(primary.tenantId);
        expect(response.body).not.toContain(foreignTenant.tenantId);
      },
    );

    const resourceScopedPrincipals: Array<
      [string, Principal['type'], Pick<Principal, 'brandIds' | 'eventIds'>]
    > = [
      ['user brand', 'user', { brandIds: [primary.brandId] }],
      ['user event', 'user', { eventIds: [primary.eventId] }],
      ['API key brand', 'api_key', { brandIds: [primary.brandId] }],
      ['API key event', 'api_key', { eventIds: [primary.eventId] }],
      ['agent brand', 'agent', { brandIds: [primary.brandId] }],
      ['agent event', 'agent', { eventIds: [primary.eventId] }],
      ['mobile brand', 'mobile_device', { brandIds: [primary.brandId] }],
      ['mobile event', 'mobile_device', { eventIds: [primary.eventId] }],
    ];

    it.each(resourceScopedPrincipals)(
      'denies %s resource-scoped non-system principals before querying aggregate data',
      async (_kind, type, scope) => {
        activePrincipal = principal({ type, ...scope });
        const response = await app.inject({
          method: 'GET',
          url: `/organizations/${primary.organizationId}/reports/affiliate`,
        });

        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toMatchObject({
          error: {
            code: 'FORBIDDEN',
            message: 'Resource-scoped principals cannot access organization-wide reports',
          },
        });
        expect(response.body).not.toContain('Primary Affiliate');
      },
    );

    it('permits unscoped user, API-key, and system principals', async () => {
      for (const actor of [
        principal({ brandIds: undefined, eventIds: undefined }),
        principal({
          type: 'api_key',
          id: `ak_aff_${suffix}`,
          brandIds: undefined,
          eventIds: undefined,
        }),
        principal({
          type: 'system',
          id: `sys_aff_${suffix}`,
          organizationIds: [],
          brandIds: undefined,
          eventIds: undefined,
        }),
      ]) {
        activePrincipal = actor;
        const response = await app.inject({
          method: 'GET',
          url: `/organizations/${primary.organizationId}/reports/affiliate`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({
          organizationId: primary.organizationId,
        });
      }
    });

    it('denies a scoped system principal before querying aggregate data', async () => {
      activePrincipal = principal({
        type: 'system',
        id: `sys_aff_scoped_${suffix}`,
        organizationIds: [],
        brandIds: [primary.brandId],
      });
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${primary.organizationId}/reports/affiliate`,
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(response.body).not.toContain('Primary Affiliate');
    });

    it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
      expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
    });
  },
);
