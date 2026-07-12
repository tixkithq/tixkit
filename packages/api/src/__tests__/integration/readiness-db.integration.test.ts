import { afterAll, beforeAll, expect, it } from 'vitest';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';
import {
  BrandRepository,
  createDb,
  EventRepository,
  EventReadinessAcknowledgementRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  TenantRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import { humanAcknowledgementStepVersions } from '@tixkit/domain';
import { ulid } from 'ulid';
import {
  EVENT_READINESS_QUERY_BUDGET,
  WORKSPACE_READINESS_QUERY_BUDGET,
  ReadinessService,
} from '../../services/readiness.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('readiness service query and isolation budget', () => {
  let db: Database;
  let previousDriver: string | undefined;

  beforeAll(() => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
  });

  afterAll(async () => {
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('uses a bounded statement count and enforces the full event hierarchy', async () => {
    const runId = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({
      name: `Readiness ${runId}`,
    });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Readiness ${runId}`,
      slug: `readiness-${runId}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      name: `Readiness ${runId}`,
      slug: `readiness-${runId}`,
    });
    const event = await new EventRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `readiness-${runId}`,
      title: 'Readiness integration event',
      description: 'Authoritative readiness test',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
    });
    const pool = await new InventoryPoolRepository(db).create({
      eventId: event.id,
      name: 'Free RSVP inventory',
      totalCapacity: 50,
    });
    await new TicketTypeRepository(db).create({
      eventId: event.id,
      inventoryPoolId: pool.id,
      name: 'Free RSVP',
      kind: 'free',
      status: 'active',
      currency: 'USD',
      priceCents: 0,
    });

    let statementCount = 0;
    const countingPlugin: KyselyPlugin = {
      transformQuery(args: PluginTransformQueryArgs) {
        statementCount += 1;
        return args.node;
      },
      async transformResult(args: PluginTransformResultArgs) {
        return args.result;
      },
    };
    const countingDb = db.withPlugin(countingPlugin);
    const service = new ReadinessService(countingDb, 'capture');
    const permissions = new Set([
      'events.read',
      'events.write',
      'tickets.write',
      'orders.write',
      'messages.write',
      'billing.write',
      'checkins.write',
    ] as const);

    const readiness = await service.getEventLaunchReadiness({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventId: event.id,
      permissions,
    });

    expect(statementCount).toBeLessThanOrEqual(EVENT_READINESS_QUERY_BUDGET);
    expect(readiness.steps.find((step) => step.id === 'payment_readiness')).toMatchObject({
      status: 'not_applicable',
      reasonCodes: ['payment_not_required'],
    });
    statementCount = 0;
    const workspace = await service.getWorkspaceReadiness({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      permissions,
    });
    expect(statementCount).toBeLessThanOrEqual(WORKSPACE_READINESS_QUERY_BUDGET);
    expect(workspace.organizationId).toBe(organization.id);
    const scope = {
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventId: event.id,
    };
    const previewFingerprint = await service.acknowledgementSubject({
      ...scope,
      stepId: 'preview_review',
    });
    await new EventReadinessAcknowledgementRepository(db).acknowledge(scope, {
      stepId: 'preview_review',
      stepVersion: humanAcknowledgementStepVersions.preview_review,
      subjectFingerprint: previewFingerprint,
      actorId: 'usr_readiness_integration',
    });
    const acknowledged = await service.getEventLaunchReadiness({
      ...scope,
      permissions,
    });
    expect(acknowledged.steps.find((step) => step.id === 'preview_review')).toMatchObject({
      status: 'complete',
      reasonCodes: ['preview_reviewed'],
      acknowledgementValid: true,
    });
    await db
      .updateTable('events')
      .set({ title: 'Changed after preview' })
      .where('id', '=', event.id)
      .execute();
    const stale = await service.getEventLaunchReadiness({ ...scope, permissions });
    expect(stale.steps.find((step) => step.id === 'preview_review')).toMatchObject({
      status: 'incomplete',
      reasonCodes: ['acknowledgement_stale'],
      acknowledgementValid: false,
    });
    await expect(
      service.getEventLaunchReadiness({
        tenantId: `wrong_${tenant.id}`,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        permissions,
      }),
    ).rejects.toThrow('Event readiness scope was not found');
  });

  it('requires a current successful test order before completing test checkout readiness', async () => {
    const runId = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({ name: `Test order ${runId}` });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Test order ${runId}`,
      slug: `test-order-${runId}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      name: `Test order ${runId}`,
      slug: `test-order-${runId}`,
    });
    const event = await new EventRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `test-order-${runId}`,
      title: 'Test order readiness',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
    });
    const permissions = new Set([
      'events.read',
      'events.write',
      'tickets.write',
      'orders.write',
      'messages.write',
      'billing.write',
      'checkins.write',
    ] as const);
    const service = new ReadinessService(db, 'capture');

    const insertTestOrder = async (status: string, createdAt: Date) => {
      const suffix = `${status}_${ulid().slice(-8).toLowerCase()}`;
      const checkoutSessionId = `cs_${suffix}`;
      const orderId = `ord_${suffix}`;
      await db
        .insertInto('checkout_sessions')
        .values({
          id: checkoutSessionId,
          tenant_id: tenant.id,
          event_id: event.id,
          brand_id: brand.id,
          status: status === 'paid' ? 'completed' : 'failed',
          hold_id: null,
          currency: 'USD',
          cart: '{}',
          buyer: JSON.stringify({ email: 'test-order@example.test' }),
          quote: JSON.stringify({ totalCents: 0 }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date(createdAt.getTime() + 60_000),
          idempotency_key: `readiness-${suffix}`,
          client_token: `token-${suffix}`,
          is_test: true,
          created_at: createdAt,
          updated_at: createdAt,
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
          checkout_session_id: checkoutSessionId,
          order_number: `TK-${suffix}`,
          status,
          currency: 'USD',
          subtotal_cents: 0,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: 0,
          refunded_cents: 0,
          buyer_email: 'test-order@example.test',
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: true,
          paid_at: status === 'paid' ? createdAt : null,
          refunded_at: null,
          cancelled_at: status === 'cancelled' ? createdAt : null,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .execute();
    };
    const readiness = () =>
      service.getEventLaunchReadiness({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        permissions,
      });

    await insertTestOrder('cancelled', new Date());
    expect((await readiness()).steps.find((step) => step.id === 'test_order')).toMatchObject({
      status: 'incomplete',
      reasonCodes: ['test_order_recommended'],
    });

    const successfulAt = new Date(Date.now() + 1_000);
    await insertTestOrder('paid', successfulAt);
    expect((await readiness()).steps.find((step) => step.id === 'test_order')).toMatchObject({
      status: 'complete',
      reasonCodes: ['test_order_complete'],
    });

    await db
      .updateTable('events')
      .set({ checkout_configuration_updated_at: new Date(successfulAt.getTime() + 1_000) })
      .where('id', '=', event.id)
      .execute();
    expect((await readiness()).steps.find((step) => step.id === 'test_order')).toMatchObject({
      status: 'incomplete',
      reasonCodes: ['test_order_stale'],
    });
  });
});
