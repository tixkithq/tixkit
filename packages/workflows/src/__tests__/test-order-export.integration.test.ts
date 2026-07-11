import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrandRepository,
  createDb,
  EventRepository,
  OrganizationRepository,
  TenantRepository,
  type Database,
} from '@tixkit/db';
import { ulid } from 'ulid';
import { closeActivityClients } from '../activities/activity-clients.js';
import { generateExportActivity } from '../activities/export.js';

const driver = process.env.DB_INTEGRATION_DRIVER === 'mysql' ? 'mysql' : 'postgres';
const databaseUrl = driver === 'mysql' ? process.env.DATABASE_URL_MYSQL : process.env.DATABASE_URL;

(databaseUrl ? describe.sequential : describe.skip)(
  `test-order export exclusion (real ${driver})`,
  () => {
    let db: Database;
    let previousDriver: string | undefined;
    let exportId: string;
    let productionOrderNumber: string;
    let testOrderNumber: string;

    beforeAll(async () => {
      previousDriver = process.env.DB_DRIVER;
      process.env.DB_DRIVER = driver;
      await closeActivityClients();
      db = createDb(databaseUrl!);
      const suffix = ulid().slice(-10).toLowerCase();
      const tenant = await new TenantRepository(db).create({ name: `Export ${suffix}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Export ${suffix}`,
        slug: `export-${suffix}`,
      });
      const brand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        name: `Export ${suffix}`,
        slug: `export-${suffix}`,
      });
      const event = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `export-${suffix}`,
        title: 'Export exclusion',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
      });
      const now = new Date();
      productionOrderNumber = `TK-PROD-${suffix}`;
      testOrderNumber = `TK-TEST-${suffix}`;
      for (const [index, isTest] of [false, true].entries()) {
        const sessionId = `cs_export_${suffix}_${index}`;
        const orderId = `ord_export_${suffix}_${index}`;
        await db
          .insertInto('checkout_sessions')
          .values({
            id: sessionId,
            tenant_id: tenant.id,
            event_id: event.id,
            brand_id: brand.id,
            status: 'completed',
            hold_id: null,
            currency: 'USD',
            cart: '{}',
            buyer: JSON.stringify({ email: `export-${index}@example.test` }),
            quote: JSON.stringify({ totalCents: isTest ? 90_000 : 10_000 }),
            payment_intent_id: null,
            order_id: orderId,
            success_url: null,
            cancel_url: null,
            expires_at: new Date(now.getTime() + 60_000),
            idempotency_key: `export-${suffix}-${index}`,
            client_token: `token-${suffix}-${index}`,
            is_test: isTest,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await db
          .insertInto('orders')
          .values({
            id: orderId,
            tenant_id: tenant.id,
            organization_id: organization.id,
            brand_id: brand.id,
            event_id: event.id,
            checkout_session_id: sessionId,
            order_number: isTest ? testOrderNumber : productionOrderNumber,
            status: 'paid',
            currency: 'USD',
            subtotal_cents: isTest ? 90_000 : 10_000,
            discount_cents: 0,
            tax_cents: 0,
            fee_cents: 0,
            total_cents: isTest ? 90_000 : 10_000,
            refunded_cents: 0,
            buyer_email: `export-${index}@example.test`,
            buyer_first_name: null,
            buyer_last_name: null,
            buyer_phone: null,
            buyer_date_of_birth: null,
            payment_intent_id: null,
            payment_provider: null,
            sales_channel: 'online',
            operator_id: null,
            tender_type: null,
            is_test: isTest,
            paid_at: now,
            refunded_at: null,
            cancelled_at: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      exportId = `exp_${suffix}`;
      await db
        .insertInto('export_jobs')
        .values({
          id: exportId,
          tenant_id: tenant.id,
          event_id: event.id,
          type: 'orders',
          format: 'csv',
          status: 'pending',
          file_url: null,
          requested_by: `usr_${suffix}`,
          filters: null,
          created_at: now,
          completed_at: null,
        })
        .execute();
    }, 120_000);

    afterAll(async () => {
      await closeActivityClients();
      await db?.destroy();
      if (previousDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previousDriver;
    });

    it('excludes a persisted test order from generated order exports', async () => {
      const result = await generateExportActivity({
        exportId,
        type: 'orders',
        format: 'csv',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.rowCount).toBe(1);
      expect(String(result.value.data)).toContain(productionOrderNumber);
      expect(String(result.value.data)).not.toContain(testOrderNumber);
    });
  },
);
