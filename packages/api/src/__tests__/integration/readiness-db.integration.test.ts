import { afterAll, beforeAll, expect, it } from 'vitest';
import type { KyselyPlugin, PluginTransformQueryArgs, PluginTransformResultArgs } from 'kysely';
import {
  BrandRepository,
  CheckInListRepository,
  createDb,
  EventRepository,
  EventReadinessAcknowledgementRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  TenantRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import { humanAcknowledgementStepVersions, type DashboardAction } from '@tixkit/domain';
import { ulid } from 'ulid';
import {
  EVENT_READINESS_QUERY_BUDGET,
  WORKSPACE_READINESS_QUERY_BUDGET,
  ReadinessService,
} from '../../services/readiness.js';
import {
  DASHBOARD_ACTION_QUERY_BUDGET,
  DashboardActionService,
  compareDashboardActions,
} from '../../services/dashboard-actions.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('readiness service query and isolation budget', () => {
  const dashboardCursorSigningKey = 'integration-dashboard-cursor-signing-key';
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
    expect(workspace.steps.find((step) => step.id === 'workspace_selection')).toMatchObject({
      requiredPermission: 'settings.write',
    });
    expect(workspace.actionFeed).toEqual(
      [...workspace.actionFeed].sort((left, right) => {
        const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
        return order[left.severity] - order[right.severity];
      }),
    );
    expect(workspace.actionFeed.find((action) => action.stepId === 'brand_identity')).toMatchObject(
      {
        id: 'workspace:brand_identity',
        severity: 'high',
        owner: 'marketing',
        deadlineAt: null,
        actionId: null,
        requiredPermission: 'settings.write',
        reasonCodes: ['brand_identity_incomplete', 'permission_required'],
      },
    );
    statementCount = 0;
    const dashboardFeed = await new DashboardActionService(
      countingDb,
      dashboardCursorSigningKey,
    ).getFeed({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      permissions,
      now: new Date('2026-12-31T18:00:00.000Z'),
    });
    expect(statementCount).toBeLessThanOrEqual(DASHBOARD_ACTION_QUERY_BUDGET);
    const currentEvent = await new EventRepository(db).findById(event.id);
    expect(currentEvent).toBeDefined();
    expect(
      dashboardFeed.actions.find((action) => action.id === `event:${event.id}:unpublished`),
    ).toMatchObject({
      sourceType: 'event_launch',
      reasonCode: 'event_unpublished',
      resource: { type: 'event', eventId: event.id, eventVersion: Number(currentEvent?.version) },
      remediation: { id: 'continue_event_setup', canRemediate: true },
      staleness: {
        state: 'current',
        consistency: 'repeatable_read',
        sourceVersion: Number(currentEvent?.version),
      },
    });
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

  it('paginates more than fifty actionable events without old-event starvation and removes resolved actions', async () => {
    const runId = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({ name: `Action feed ${runId}` });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Action feed ${runId}`,
      slug: `action-feed-${runId}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      name: `Action feed ${runId}`,
      slug: `action-feed-${runId}`,
    });
    const events = new EventRepository(db);
    for (let index = 0; index < 51; index += 1) {
      const oldEvent = await events.create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `old-${index}-${runId}`,
        title: `Old published event ${index}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date(`2025-01-${String((index % 28) + 1).padStart(2, '0')}T18:00:00.000Z`),
      });
      await events.updateStatus(oldEvent.id, 'published');
    }
    const expectedDraftIds = new Set<string>();
    let mutableDraftId = '';
    for (let index = 0; index < 53; index += 1) {
      const draft = await events.create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `draft-${index}-${runId}`,
        title: `Future draft ${index}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date(`2027-02-${String((index % 28) + 1).padStart(2, '0')}T18:00:00.000Z`),
      });
      if (index === 0) mutableDraftId = draft.id;
      expectedDraftIds.add(`event:${draft.id}:unpublished`);
    }
    const configuredEvent = await events.create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `configured-${runId}`,
      title: 'Configured door operations',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-02T18:00:00.000Z'),
    });
    await events.updateStatus(configuredEvent.id, 'published');
    await new CheckInListRepository(db).create({
      eventId: configuredEvent.id,
      name: 'Main entrance',
      ticketTypeIds: [],
    });
    const unresolvedEvent = await events.create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `unresolved-${runId}`,
      title: 'Unresolved operations',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
    });
    await events.updateStatus(unresolvedEvent.id, 'published');
    const exportId = `exp_${ulid()}`;
    await db
      .insertInto('export_jobs')
      .values({
        id: exportId,
        tenant_id: tenant.id,
        event_id: unresolvedEvent.id,
        type: 'attendees',
        format: 'csv',
        status: 'failed',
        file_url: null,
        requested_by: 'usr_action_feed_integration',
        filters: JSON.stringify({}),
        created_at: new Date('2026-01-01T12:00:00.000Z'),
        completed_at: null,
      })
      .execute();

    let statementCount = 0;
    let statementRowCounts: number[] = [];
    const countingDb = db.withPlugin({
      transformQuery(args: PluginTransformQueryArgs) {
        statementCount += 1;
        return args.node;
      },
      async transformResult(args: PluginTransformResultArgs) {
        statementRowCounts.push(args.result.rows.length);
        return args.result;
      },
    });
    const service = new DashboardActionService(countingDb, dashboardCursorSigningKey);
    const permissions = new Set([
      'events.read',
      'events.write',
      'checkins.write',
      'reports.read',
    ] as const);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const observedIds: string[] = [];
    const observedActions: DashboardAction[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      statementCount = 0;
      statementRowCounts = [];
      const page = await service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
        now,
        limit: 7,
        cursor,
      });
      expect(statementCount).toBeLessThanOrEqual(DASHBOARD_ACTION_QUERY_BUDGET);
      expect(Math.max(...statementRowCounts)).toBeLessThanOrEqual(8);
      observedActions.push(...page.actions);
      observedIds.push(...page.actions.map((action) => action.id));
      cursor = page.nextCursor ?? undefined;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    expect(new Set(observedIds).size).toBe(observedIds.length);
    expect(observedIds).toEqual(
      [...observedActions].sort(compareDashboardActions).map((action) => action.id),
    );
    expect(observedIds).toHaveLength(expectedDraftIds.size + 2);
    for (const id of expectedDraftIds) expect(observedIds).toContain(id);
    expect(observedIds).toContain(`event:${unresolvedEvent.id}:check-in`);
    expect(observedIds).toContain(`event:${unresolvedEvent.id}:failed-exports`);
    expect(observedIds).not.toContain(`event:${configuredEvent.id}:check-in`);
    const eventScoped = await service.getFeed({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventIds: [unresolvedEvent.id],
      permissions,
      now,
      limit: 50,
    });
    expect(eventScoped.actions.map((action) => action.id).sort()).toEqual(
      [`event:${unresolvedEvent.id}:check-in`, `event:${unresolvedEvent.id}:failed-exports`].sort(),
    );

    const mutationPage = await service.getFeed({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      permissions,
      now,
      limit: 1,
    });
    expect(mutationPage.nextCursor).not.toBeNull();
    const mutationCursor = mutationPage.nextCursor ?? '';
    const signatureStart = mutationCursor.lastIndexOf('.') + 1;
    const signatureFirstCharacter = mutationCursor[signatureStart] ?? '';
    const tamperedCursor = `${mutationCursor.slice(0, signatureStart)}${
      signatureFirstCharacter === 'x' ? 'y' : 'x'
    }${mutationCursor.slice(signatureStart + 1)}`;
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
        now,
        limit: 1,
        cursor: tamperedCursor,
      }),
    ).rejects.toThrow('Dashboard action cursor is invalid');
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventIds: [unresolvedEvent.id],
        permissions,
        now,
        limit: 1,
        cursor: mutationCursor,
      }),
    ).rejects.toThrow('Dashboard action cursor does not match the requested scope');
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: `other_${brand.id}`,
        permissions,
        now,
        limit: 1,
        cursor: mutationCursor,
      }),
    ).rejects.toThrow('Dashboard action cursor does not match the requested scope');
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
        now: new Date('2026-01-01T00:05:00.001Z'),
        limit: 1,
        cursor: mutationCursor,
      }),
    ).rejects.toThrow('Dashboard action cursor has expired');
    await events.update(mutableDraftId, { title: 'Changed during pagination' });
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
        now,
        limit: 1,
        cursor: mutationCursor,
      }),
    ).rejects.toThrow('Dashboard action snapshot changed');

    const exportSwapEvents = [];
    for (const label of ['a', 'b', 'c']) {
      const event = await events.create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `export-swap-${label}-${runId}`,
        title: `Export swap ${label.toUpperCase()}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date('2027-03-01T18:00:00.000Z'),
      });
      await events.updateStatus(event.id, 'published');
      await new CheckInListRepository(db).create({
        eventId: event.id,
        name: `Export swap ${label.toUpperCase()} entrance`,
        ticketTypeIds: [],
      });
      exportSwapEvents.push(event);
    }
    const [swapEventA, swapEventB, swapEventC] = exportSwapEvents;
    if (!swapEventA || !swapEventB || !swapEventC) throw new Error('Export swap setup failed');
    const swapExportA = `exp_${ulid()}`;
    const swapExportB = `exp_${ulid()}`;
    const swapExportC = `exp_${ulid()}`;
    await db
      .insertInto('export_jobs')
      .values([
        {
          id: swapExportA,
          tenant_id: tenant.id,
          event_id: swapEventA.id,
          type: 'attendees',
          format: 'csv',
          status: 'failed',
          file_url: null,
          requested_by: 'usr_action_feed_integration',
          filters: JSON.stringify({}),
          created_at: new Date('2026-01-01T10:00:00.000Z'),
          completed_at: null,
        },
        {
          id: swapExportB,
          tenant_id: tenant.id,
          event_id: swapEventB.id,
          type: 'attendees',
          format: 'csv',
          status: 'completed',
          file_url: null,
          requested_by: 'usr_action_feed_integration',
          filters: JSON.stringify({}),
          created_at: new Date('2026-01-01T11:00:00.000Z'),
          completed_at: new Date('2026-01-01T11:01:00.000Z'),
        },
        {
          id: swapExportC,
          tenant_id: tenant.id,
          event_id: swapEventC.id,
          type: 'attendees',
          format: 'csv',
          status: 'failed',
          file_url: null,
          requested_by: 'usr_action_feed_integration',
          filters: JSON.stringify({}),
          created_at: new Date('2026-01-01T12:00:00.000Z'),
          completed_at: null,
        },
      ])
      .execute();
    const exportSwapPage = await service.getFeed({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      permissions,
      now,
      limit: 1,
    });
    expect(exportSwapPage.nextCursor).not.toBeNull();
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('export_jobs')
        .set({ status: 'completed', completed_at: new Date('2026-01-01T13:00:00.000Z') })
        .where('id', '=', swapExportA)
        .execute();
      await trx
        .updateTable('export_jobs')
        .set({ status: 'failed', completed_at: null })
        .where('id', '=', swapExportB)
        .execute();
    });
    await expect(
      service.getFeed({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        permissions,
        now,
        limit: 1,
        cursor: exportSwapPage.nextCursor ?? '',
      }),
    ).rejects.toThrow('Dashboard action snapshot changed');

    await new CheckInListRepository(db).create({
      eventId: unresolvedEvent.id,
      name: 'Resolved entrance',
      ticketTypeIds: [],
    });
    await db
      .updateTable('export_jobs')
      .set({ status: 'completed', completed_at: new Date('2026-01-01T13:00:00.000Z') })
      .where('id', '=', exportId)
      .execute();
    const resolved = await service.getFeed({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      permissions,
      now,
      limit: 50,
    });
    expect(resolved.actions.map((action) => action.id)).not.toContain(
      `event:${unresolvedEvent.id}:check-in`,
    );
    expect(resolved.actions.map((action) => action.id)).not.toContain(
      `event:${unresolvedEvent.id}:failed-exports`,
    );
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
      reasonCodes: ['test_order_recommended'],
    });
  });
});
