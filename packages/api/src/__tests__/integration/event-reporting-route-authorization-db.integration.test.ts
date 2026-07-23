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

type ReportRoute = 'tax' | 'attendance' | 'promo' | 'conversion';

type EventScope = Readonly<{
  brandId: string;
  eventId: string;
  organizationId: string;
  tenantId: string;
}>;

const reportRoutes: readonly ReportRoute[] = ['tax', 'attendance', 'promo', 'conversion'];
const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_rep_a_${suffix}`;
const tenantB = `tnt_rep_b_${suffix}`;
const authorized: EventScope = {
  tenantId: tenantA,
  organizationId: `org_rep_a_${suffix}`,
  brandId: `brd_rep_a_${suffix}`,
  eventId: `evt_rep_a_${suffix}`,
};
const sameTenantOtherOrganization: EventScope = {
  tenantId: tenantA,
  organizationId: `org_rep_o_${suffix}`,
  brandId: `brd_rep_o_${suffix}`,
  eventId: `evt_rep_o_${suffix}`,
};
const sameTenantDifferentBrand: EventScope = {
  tenantId: tenantA,
  organizationId: authorized.organizationId,
  brandId: `brd_rep_sibling_${suffix}`,
  eventId: authorized.eventId,
};
const foreignTenant: EventScope = {
  tenantId: tenantB,
  organizationId: `org_rep_b_${suffix}`,
  brandId: `brd_rep_b_${suffix}`,
  eventId: `evt_rep_b_${suffix}`,
};
const scopes = [authorized, sameTenantOtherOrganization, foreignTenant] as const;
const crossEventId = `evt_rep_cross_${suffix}`;
const taxFallbackEventId = `evt_rep_tax_fallback_${suffix}`;
const now = new Date('2026-07-23T12:00:00.000Z');

describeWithIntegrationDatabase(
  `event reporting route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let previousDriver: string | undefined;
    let activePrincipal: Principal;

    function principal(overrides: Partial<Principal> = {}): Principal {
      return {
        type: 'user',
        id: `usr_rep_${suffix}`,
        tenantId: tenantA,
        organizationIds: [authorized.organizationId],
        brandIds: [authorized.brandId],
        eventIds: [authorized.eventId],
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

    async function insertScope(scope: EventScope, marker: string): Promise<void> {
      const poolId = `pool_${marker}`;
      const ticketTypeId = `tt_${marker}`;
      const checkoutId = `cs_${marker}`;
      const orderId = `ord_${marker}`;
      const attendeeId = `att_${marker}`;
      const lineItemId = `oli_${marker}`;

      await db
        .insertInto('organizations')
        .values({
          id: scope.organizationId,
          tenant_id: scope.tenantId,
          name: `Reporting ${marker}`,
          slug: `reporting-${marker}`,
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
          name: `Reporting ${marker}`,
          slug: `reporting-${marker}`,
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
          slug: `reporting-${marker}`,
          title: `Reporting ${marker}`,
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
      await db
        .insertInto('inventory_pools')
        .values({
          id: poolId,
          event_id: scope.eventId,
          name: `Pool ${marker}`,
          total_capacity: 10,
          reserved_count: 0,
          sold_count: 1,
          hold_ttl_seconds: 300,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('ticket_types')
        .values({
          id: ticketTypeId,
          event_id: scope.eventId,
          name: `Ticket ${marker}`,
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 1_000,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 10,
          inventory_pool_id: poolId,
          sort_order: 0,
          requires_access_code: false,
          access_code_hint: null,
          event_occurrence_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('checkout_sessions')
        .values({
          id: checkoutId,
          tenant_id: scope.tenantId,
          event_id: scope.eventId,
          brand_id: scope.brandId,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: JSON.stringify({ discountCode: `CODE-${marker}` }),
          buyer: JSON.stringify({ email: `${marker}@example.test` }),
          quote: JSON.stringify({ totalCents: 900 }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2026-07-23T13:00:00.000Z'),
          idempotency_key: `report-${marker}`,
          client_token: `token-${marker}`,
          is_test: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          brand_id: scope.brandId,
          event_id: scope.eventId,
          checkout_session_id: checkoutId,
          order_number: `REP-${marker}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: 1_000,
          discount_cents: 100,
          tax_cents: 80,
          fee_cents: 0,
          total_cents: 980,
          refunded_cents: 0,
          buyer_email: `${marker}@example.test`,
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: false,
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('attendees')
        .values({
          id: attendeeId,
          tenant_id: scope.tenantId,
          order_id: orderId,
          event_id: scope.eventId,
          event_occurrence_id: null,
          ticket_type_id: ticketTypeId,
          ticket_id: null,
          first_name: 'Report',
          last_name: marker,
          email: `${marker}@example.test`,
          phone: null,
          date_of_birth: null,
          status: 'checked_in',
          custom_answers: null,
          checked_in_at: now,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('tickets')
        .values({
          id: `tkt_${marker}`,
          tenant_id: scope.tenantId,
          order_id: orderId,
          attendee_id: attendeeId,
          event_id: scope.eventId,
          event_occurrence_id: null,
          ticket_type_id: ticketTypeId,
          status: 'checked_in',
          code: `REP-${marker}`,
          qr_payload: `payload-${marker}`,
          qr_hash: `hash-${marker}`,
          transferred_to_email: null,
          transferred_at: null,
          checked_in_at: now,
          checked_in_by_device_id: null,
          wallet_pass_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('order_line_items')
        .values({
          id: lineItemId,
          order_id: orderId,
          ticket_type_id: ticketTypeId,
          product_id: null,
          event_occurrence_id: null,
          resale_listing_id: null,
          attendee_id: attendeeId,
          description: `Line ${marker}`,
          quantity: 1,
          unit_price_cents: 1_000,
          subtotal_cents: 1_000,
          discount_cents: 100,
          tax_cents: 80,
          fee_cents: 0,
          total_cents: 980,
          currency: 'USD',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('order_tax_snapshots')
        .values({
          id: `ots_${marker}`,
          order_id: orderId,
          order_line_item_id: lineItemId,
          event_id: scope.eventId,
          tax_rule_id: null,
          tax_rule_name: `Tax ${marker}`,
          rate: 8,
          type: 'percentage',
          applied_to: 'ticket',
          jurisdiction_country: 'US',
          jurisdiction_region: null,
          taxable_amount_cents: 900,
          tax_cents: 80,
          currency: 'USD',
          inclusive: false,
          provider: 'tixkit_rules',
          provider_calculation_id: null,
          metadata: null,
          created_at: now,
        })
        .execute();
      await db
        .insertInto('discount_codes')
        .values({
          id: `dc_${marker}`,
          event_id: scope.eventId,
          code: `CODE-${marker}`,
          type: 'fixed',
          value: 100,
          currency: 'USD',
          max_uses: 10,
          uses_count: 1,
          valid_from: null,
          valid_until: null,
          min_order_cents: null,
          max_discount_cents: null,
          ticket_type_ids: null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('widget_impressions')
        .values({
          id: `wim_${marker}`,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          brand_id: scope.brandId,
          event_id: scope.eventId,
          visitor_hash: `visitor-${marker}`,
          impression_date: '2026-07-23',
          source: 'widget',
          tracking_id: null,
          affiliate_code: null,
          host: null,
          page_url: null,
          referrer: null,
          created_at: now,
        })
        .execute();
    }

    async function insertDenormalizedReportRows(
      scope: EventScope,
      marker: string,
      includeAttendance: boolean,
    ): Promise<void> {
      const checkoutId = `cs_denorm_${marker}`;
      const orderId = `ord_denorm_${marker}`;
      const lineItemId = `oli_denorm_${marker}`;
      const authorizedTicketTypeId = `tt_a_${suffix}`;

      // Every foreign key targets an existing row. The tenant, organization, and brand columns are
      // deliberately denormalized against the authorized event to prove report query containment.
      await db
        .insertInto('checkout_sessions')
        .values({
          id: checkoutId,
          tenant_id: scope.tenantId,
          event_id: authorized.eventId,
          brand_id: scope.brandId,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: JSON.stringify({ discountCode: `CODE-A_${suffix}` }),
          buyer: JSON.stringify({ email: `denorm-${marker}@example.test` }),
          quote: JSON.stringify({ totalCents: 9_000 }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2026-07-23T13:00:00.000Z'),
          idempotency_key: `denorm-${marker}`,
          client_token: `denorm-token-${marker}`,
          is_test: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          brand_id: scope.brandId,
          event_id: authorized.eventId,
          checkout_session_id: checkoutId,
          order_number: `REP-DENORM-${marker}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: 9_000,
          discount_cents: 900,
          tax_cents: 720,
          fee_cents: 0,
          total_cents: 8_820,
          refunded_cents: 0,
          buyer_email: `denorm-${marker}@example.test`,
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: false,
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('order_line_items')
        .values({
          id: lineItemId,
          order_id: orderId,
          ticket_type_id: authorizedTicketTypeId,
          product_id: null,
          event_occurrence_id: null,
          resale_listing_id: null,
          attendee_id: null,
          description: `Denormalized ${marker}`,
          quantity: 1,
          unit_price_cents: 9_000,
          subtotal_cents: 9_000,
          discount_cents: 900,
          tax_cents: 720,
          fee_cents: 0,
          total_cents: 8_820,
          currency: 'USD',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('order_tax_snapshots')
        .values({
          id: `ots_denorm_${marker}`,
          order_id: orderId,
          order_line_item_id: lineItemId,
          event_id: authorized.eventId,
          tax_rule_id: null,
          tax_rule_name: `Tax denormalized ${marker}`,
          rate: 8,
          type: 'percentage',
          applied_to: 'ticket',
          jurisdiction_country: 'US',
          jurisdiction_region: null,
          taxable_amount_cents: 8_100,
          tax_cents: 720,
          currency: 'USD',
          inclusive: false,
          provider: 'tixkit_rules',
          provider_calculation_id: null,
          metadata: null,
          created_at: now,
        })
        .execute();
      await db
        .insertInto('widget_impressions')
        .values({
          id: `wim_denorm_${marker}`,
          tenant_id: scope.tenantId,
          organization_id: scope.organizationId,
          brand_id: scope.brandId,
          event_id: authorized.eventId,
          visitor_hash: `denorm-visitor-${marker}`,
          impression_date: '2026-07-23',
          source: 'widget',
          tracking_id: null,
          affiliate_code: null,
          host: null,
          page_url: null,
          referrer: null,
          created_at: now,
        })
        .execute();

      if (!includeAttendance) return;
      const attendeeId = `att_denorm_${marker}`;
      await db
        .insertInto('attendees')
        .values({
          id: attendeeId,
          tenant_id: scope.tenantId,
          order_id: orderId,
          event_id: authorized.eventId,
          event_occurrence_id: null,
          ticket_type_id: authorizedTicketTypeId,
          ticket_id: null,
          first_name: 'Denormalized',
          last_name: marker,
          email: `denorm-${marker}@example.test`,
          phone: null,
          date_of_birth: null,
          status: 'checked_in',
          custom_answers: null,
          checked_in_at: now,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('tickets')
        .values({
          id: `tkt_denorm_${marker}`,
          tenant_id: scope.tenantId,
          order_id: orderId,
          attendee_id: attendeeId,
          event_id: authorized.eventId,
          event_occurrence_id: null,
          ticket_type_id: authorizedTicketTypeId,
          status: 'checked_in',
          code: `DENORM-${marker}`,
          qr_payload: `denorm-payload-${marker}`,
          qr_hash: `denorm-hash-${marker}`,
          transferred_to_email: null,
          transferred_at: null,
          checked_in_at: now,
          checked_in_by_device_id: null,
          wallet_pass_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertTaxFallbackRows(): Promise<void> {
      const checkoutId = `cs_tax_fallback_${suffix}`;
      const orderId = `ord_tax_fallback_${suffix}`;
      await db
        .insertInto('events')
        .values({
          id: taxFallbackEventId,
          tenant_id: authorized.tenantId,
          organization_id: authorized.organizationId,
          brand_id: authorized.brandId,
          slug: `reporting-tax-fallback-${suffix}`,
          title: 'Tax fallback fixture',
          description: null,
          status: 'published',
          currency: 'USD',
          timezone: 'UTC',
          starts_at: new Date('2027-01-03T18:00:00.000Z'),
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
      await db
        .insertInto('checkout_sessions')
        .values({
          id: checkoutId,
          tenant_id: authorized.tenantId,
          event_id: taxFallbackEventId,
          brand_id: authorized.brandId,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: '{}',
          buyer: JSON.stringify({ email: `fallback-${suffix}@example.test` }),
          quote: JSON.stringify({ totalCents: 1_080 }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2026-07-23T13:00:00.000Z'),
          idempotency_key: `tax-fallback-${suffix}`,
          client_token: `tax-fallback-token-${suffix}`,
          is_test: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: authorized.tenantId,
          organization_id: authorized.organizationId,
          brand_id: authorized.brandId,
          event_id: taxFallbackEventId,
          checkout_session_id: checkoutId,
          order_number: `REP-TAX-FALLBACK-${suffix}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: 1_000,
          discount_cents: 100,
          tax_cents: 80,
          fee_cents: 0,
          total_cents: 980,
          refunded_cents: 0,
          buyer_email: `fallback-${suffix}@example.test`,
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: false,
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('order_line_items')
        .values({
          id: `oli_tax_fallback_${suffix}`,
          order_id: orderId,
          ticket_type_id: `tt_a_${suffix}`,
          product_id: null,
          event_occurrence_id: null,
          resale_listing_id: null,
          attendee_id: null,
          description: 'Tax fallback line',
          quantity: 1,
          unit_price_cents: 1_000,
          subtotal_cents: 1_000,
          discount_cents: 100,
          tax_cents: 80,
          fee_cents: 0,
          total_cents: 980,
          currency: 'USD',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function cleanup(): Promise<void> {
      const tenantIds = [tenantA, tenantB];
      await db.deleteFrom('widget_impressions').where('tenant_id', 'in', tenantIds).execute();
      await db
        .deleteFrom('order_tax_snapshots')
        .where('event_id', 'in', [
          ...scopes.map((scope) => scope.eventId),
          crossEventId,
          taxFallbackEventId,
        ])
        .execute();
      await db.deleteFrom('order_line_items').where('id', 'like', `%${suffix}`).execute();
      await db.deleteFrom('tickets').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('attendees').where('tenant_id', 'in', tenantIds).execute();
      await db
        .deleteFrom('discount_codes')
        .where('event_id', 'in', [
          ...scopes.map((scope) => scope.eventId),
          crossEventId,
          taxFallbackEventId,
        ])
        .execute();
      await db.deleteFrom('orders').where('tenant_id', 'in', tenantIds).execute();
      await db.deleteFrom('checkout_sessions').where('tenant_id', 'in', tenantIds).execute();
      await db
        .deleteFrom('ticket_types')
        .where('event_id', 'in', [
          ...scopes.map((scope) => scope.eventId),
          crossEventId,
          taxFallbackEventId,
        ])
        .execute();
      await db
        .deleteFrom('inventory_pools')
        .where('event_id', 'in', [
          ...scopes.map((scope) => scope.eventId),
          crossEventId,
          taxFallbackEventId,
        ])
        .execute();
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
      await insertScope(authorized, `a_${suffix}`);
      await insertScope(sameTenantOtherOrganization, `o_${suffix}`);
      await insertScope(foreignTenant, `b_${suffix}`);
      await db
        .insertInto('brands')
        .values({
          id: sameTenantDifferentBrand.brandId,
          tenant_id: sameTenantDifferentBrand.tenantId,
          organization_id: sameTenantDifferentBrand.organizationId,
          name: 'Reporting sibling brand',
          slug: `reporting-sibling-${suffix}`,
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
      await insertDenormalizedReportRows(foreignTenant, `tenant_${suffix}`, true);
      await insertDenormalizedReportRows(sameTenantOtherOrganization, `scope_${suffix}`, false);
      await insertDenormalizedReportRows(sameTenantDifferentBrand, `brand_${suffix}`, false);
      await insertTaxFallbackRows();
      await db
        .insertInto('events')
        .values({
          id: crossEventId,
          tenant_id: authorized.tenantId,
          organization_id: authorized.organizationId,
          brand_id: authorized.brandId,
          slug: `reporting-cross-${suffix}`,
          title: 'Cross-event checkout fixture',
          description: null,
          status: 'published',
          currency: 'USD',
          timezone: 'UTC',
          starts_at: new Date('2027-01-02T18:00:00.000Z'),
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
      await db
        .insertInto('checkout_sessions')
        .values({
          id: `cs_cross_${suffix}`,
          tenant_id: authorized.tenantId,
          event_id: crossEventId,
          brand_id: authorized.brandId,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: JSON.stringify({ discountCode: `CODE-CROSS_${suffix}` }),
          buyer: JSON.stringify({ email: `cross-${suffix}@example.test` }),
          quote: JSON.stringify({ totalCents: 5_000 }),
          payment_intent_id: null,
          order_id: `ord_cross_${suffix}`,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2026-07-23T13:00:00.000Z'),
          idempotency_key: `report-cross-${suffix}`,
          client_token: `token-cross-${suffix}`,
          is_test: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: `ord_cross_${suffix}`,
          tenant_id: authorized.tenantId,
          organization_id: authorized.organizationId,
          brand_id: authorized.brandId,
          event_id: authorized.eventId,
          checkout_session_id: `cs_cross_${suffix}`,
          order_number: `REP-CROSS-${suffix}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: 5_000,
          discount_cents: 500,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: 4_500,
          refunded_cents: 0,
          buyer_email: `cross-${suffix}@example.test`,
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: false,
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('discount_codes')
        .values({
          id: `dc_cross_${suffix}`,
          event_id: authorized.eventId,
          code: `CODE-CROSS_${suffix}`,
          type: 'fixed',
          value: 500,
          currency: 'USD',
          max_uses: 10,
          uses_count: 1,
          valid_from: null,
          valid_until: null,
          min_order_cents: null,
          max_discount_cents: null,
          ticket_type_ids: null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
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
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean reporting fixtures');
    }, 120_000);

    it('returns exact safe aggregates for every authorized reporting route without cross-scope data', async () => {
      const excludedMarkers = [
        `o_${suffix}`,
        `b_${suffix}`,
        `Tax denormalized tenant_${suffix}`,
        `Tax denormalized scope_${suffix}`,
        `Tax denormalized brand_${suffix}`,
      ];
      const expectedPromoCodes = [
        {
          code: `CODE-A_${suffix.toUpperCase()}`,
          usesCount: 1,
          discountAmountCents: 100,
          revenueAttributedCents: 980,
        },
        {
          code: `CODE-CROSS_${suffix.toUpperCase()}`,
          usesCount: 1,
          discountAmountCents: 0,
          revenueAttributedCents: 0,
        },
      ];
      const expected: Record<ReportRoute, unknown> = {
        tax: {
          eventId: authorized.eventId,
          currency: 'USD',
          totalTaxCollectedCents: 80,
          breakdown: [
            {
              taxRuleName: `Tax a_${suffix}`,
              rate: 8,
              taxableAmountCents: 900,
              taxCollectedCents: 80,
            },
          ],
        },
        attendance: {
          eventId: authorized.eventId,
          totalAttendees: 1,
          checkedIn: 1,
          notCheckedIn: 0,
          checkInRate: 1,
          breakdownByTicketType: [
            {
              ticketTypeId: `tt_a_${suffix}`,
              ticketTypeName: `Ticket a_${suffix}`,
              total: 1,
              checkedIn: 1,
            },
          ],
        },
        promo: {
          eventId: authorized.eventId,
          discountCodes: expectedPromoCodes,
        },
        conversion: {
          eventId: authorized.eventId,
          widgetViews: 1,
          checkoutStarted: 1,
          checkoutCompleted: 1,
          conversionRate: 1,
        },
      };

      for (const route of reportRoutes) {
        const response = await app.inject({
          method: 'GET',
          url: `/events/${authorized.eventId}/reports/${route}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        if (route === 'promo') {
          const body = response.json();
          expect(body).toMatchObject({ eventId: authorized.eventId });
          expect(body.discountCodes).toHaveLength(2);
          expect(body.discountCodes).toEqual(expect.arrayContaining(expectedPromoCodes));
        } else {
          expect(response.json()).toEqual(expected[route]);
        }
        for (const marker of excludedMarkers) expect(response.body).not.toContain(marker);
      }
    });

    it('uses the scoped line-item fallback when no tax snapshots exist', async () => {
      activePrincipal = principal({ eventIds: [authorized.eventId, taxFallbackEventId] });
      const response = await app.inject({
        method: 'GET',
        url: `/events/${taxFallbackEventId}/reports/tax`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        eventId: taxFallbackEventId,
        currency: 'USD',
        totalTaxCollectedCents: 80,
        breakdown: [
          {
            taxRuleName: 'Actual collected tax',
            rate: null,
            taxableAmountCents: 900,
            taxCollectedCents: 80,
          },
        ],
      });
    });

    it('rejects an inverted tax date range before reading report data', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/events/${authorized.eventId}/reports/tax?from=2026-07-24&to=2026-07-23`,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', message: 'from must not be after to' },
      });
      expect(response.body).not.toContain(`Tax a_${suffix}`);
    });

    it('denies reports.read before returning every report aggregate', async () => {
      activePrincipal = principal({ scopes: [] });
      for (const eventId of [authorized.eventId, foreignTenant.eventId]) {
        for (const route of reportRoutes) {
          const response = await app.inject({
            method: 'GET',
            url: `/events/${eventId}/reports/${route}`,
          });
          expect(response.statusCode, response.body).toBe(403);
          expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
          expect(response.body).not.toContain(`CODE-A_${suffix}`);
          expect(response.body).not.toContain(foreignTenant.organizationId);
          expect(response.body).not.toContain(foreignTenant.brandId);
        }
      }
    });

    it('conceals foreign-tenant and same-tenant foreign-organization report data on every route', async () => {
      for (const scope of [foreignTenant, sameTenantOtherOrganization]) {
        for (const route of reportRoutes) {
          const response = await app.inject({
            method: 'GET',
            url: `/events/${scope.eventId}/reports/${route}`,
          });
          expect(response.statusCode, response.body).toBe(404);
          expect(response.json()).toMatchObject({
            error: {
              code: 'NOT_FOUND',
              message: `Event not found: ${scope.eventId}`,
              details: { resource: 'Event', id: scope.eventId },
              requestId: expect.any(String),
            },
          });
          expect(response.body).not.toContain(`CODE-${scope.eventId.slice(4).toUpperCase()}`);
          expect(response.body).not.toContain(scope.organizationId);
          expect(response.body).not.toContain(scope.brandId);
        }
      }
    });

    it('conceals an independent wrong-brand scope on every route', async () => {
      activePrincipal = principal({
        brandIds: [sameTenantOtherOrganization.brandId],
        eventIds: [authorized.eventId],
      });
      for (const route of reportRoutes) {
        const response = await app.inject({
          method: 'GET',
          url: `/events/${authorized.eventId}/reports/${route}`,
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `Event not found: ${authorized.eventId}`,
            details: { resource: 'Event', id: authorized.eventId },
            requestId: expect.any(String),
          },
        });
        expect(response.body).not.toContain(sameTenantOtherOrganization.organizationId);
        expect(response.body).not.toContain(sameTenantOtherOrganization.brandId);
      }
    });

    it('conceals an independent wrong-event scope on every route', async () => {
      activePrincipal = principal({
        brandIds: [authorized.brandId],
        eventIds: [sameTenantOtherOrganization.eventId],
      });
      for (const route of reportRoutes) {
        const response = await app.inject({
          method: 'GET',
          url: `/events/${authorized.eventId}/reports/${route}`,
        });
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toMatchObject({
          error: {
            code: 'NOT_FOUND',
            message: `Event not found: ${authorized.eventId}`,
            details: { resource: 'Event', id: authorized.eventId },
            requestId: expect.any(String),
          },
        });
        expect(response.body).not.toContain(sameTenantOtherOrganization.organizationId);
        expect(response.body).not.toContain(sameTenantOtherOrganization.brandId);
      }
    });

    it('permits an organization-wide principal for the exact event reports', async () => {
      activePrincipal = principal({ brandIds: undefined, eventIds: undefined });
      for (const route of reportRoutes) {
        const response = await app.inject({
          method: 'GET',
          url: `/events/${authorized.eventId}/reports/${route}`,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().eventId).toBe(authorized.eventId);
      }
    });

    it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
      expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
    });
  },
);
