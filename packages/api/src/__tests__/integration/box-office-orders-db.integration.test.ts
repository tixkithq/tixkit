import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  CheckInListRepository,
  createDb,
  ImportRepository,
  OrganizationRepository,
  ScanLogRepository,
  TenantRepository,
  TicketRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import { QrService, type Principal } from '@tixkit/domain';
import {
  prepareTixkitPortableUpload,
  sortEntitiesByDependency,
  TixkitPortableMigrationAdapter,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import {
  buildPortableLogicalExport,
  createPortableConfigurationPayloadPolicies,
} from '@tixkit/portability';
import {
  createProductionMigrationCommitters,
  finalizeOrderActivity,
  loadPortableConfigurationSections,
  MIGRATION_SIDE_EFFECT_POLICY,
} from '@tixkit/workflows';
import { generateKeyPairSync } from 'node:crypto';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { InventoryService } from '../../services/inventory.js';
import { PricingEngine } from '../../services/pricing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const boxOfficeAuthorizationContract = BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.operationId === 'postEventsByEventIdBoxOfficeOrders',
);
if (!boxOfficeAuthorizationContract) {
  throw new Error('Missing box-office order authorization contract');
}

type TemporalStartInput = {
  checkoutSessionId: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  currency: string;
  amountCents: number;
  salesChannel?: 'online' | 'box_office';
  operatorId?: string;
  tenderType?: 'comp' | 'cash' | 'manual_card';
};

const RUN_ID = ulid().slice(-10).toLowerCase();
const TENANT_ID = `tnt_pos_${RUN_ID}`;
const ORG_ID = `org_pos_${RUN_ID}`;
const BRAND_ID = `brd_pos_${RUN_ID}`;
const EVENT_ID = `evt_pos_${RUN_ID}`;
const OPERATOR_ID = `usr_pos_${RUN_ID}`;

let db: Database;
let app: FastifyInstance;
let inventoryService: InventoryService;
let previousDbDriver: string | undefined;
let finalizedOrderCount = 0;

type RouteIdentity = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  operatorId: string;
};

const defaultIdentity: RouteIdentity = {
  tenantId: TENANT_ID,
  organizationId: ORG_ID,
  brandId: BRAND_ID,
  eventId: EVENT_ID,
  operatorId: OPERATOR_ID,
};

function makePrincipal(identity: RouteIdentity, overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: identity.operatorId,
    tenantId: identity.tenantId,
    organizationIds: [identity.organizationId],
    brandIds: [identity.brandId],
    eventIds: [identity.eventId],
    scopes: ['events.read', 'orders.read', 'orders.write', 'checkins.write'],
    ...overrides,
  };
}

async function seedTenantGraph(database: Database): Promise<void> {
  const now = new Date();
  await database.transaction().execute(async (trx) => {
    await trx
      .insertInto('tenants')
      .values({
        id: TENANT_ID,
        name: `POS DB ${RUN_ID}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('organizations')
      .values({
        id: ORG_ID,
        tenant_id: TENANT_ID,
        name: `POS DB ${RUN_ID}`,
        slug: `pos-db-${RUN_ID}`,
        clerk_organization_id: null,
        box_office_settings: JSON.stringify({
          enabled: true,
          allowedTenderTypes: ['cash', 'manual_card', 'comp'],
          requireBuyerEmail: false,
          receiptMode: 'email',
        }),
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('brands')
      .values({
        id: BRAND_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        name: `POS DB ${RUN_ID}`,
        slug: `pos-db-${RUN_ID}`,
        status: 'active',
        theme: JSON.stringify({}),
        legal_urls: JSON.stringify({}),
        white_label: false,
        payment_account_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await trx
      .insertInto('events')
      .values({
        id: EVENT_ID,
        tenant_id: TENANT_ID,
        organization_id: ORG_ID,
        brand_id: BRAND_ID,
        slug: `pos-db-${RUN_ID}`,
        title: 'POS DB Event',
        description: null,
        status: 'published',
        currency: 'USD',
        timezone: 'UTC',
        starts_at: new Date(now.getTime() + 86_400_000),
        ends_at: null,
        visibility: 'private',
        seo: JSON.stringify({}),
        capacity: null,
        cover_image_url: null,
        external_url: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  });
}

async function cleanupAll(database: Database): Promise<void> {
  await truncateAllData(database);
}

async function resetMutableState(database: Database): Promise<void> {
  await truncateAllData(database);
  await seedTenantGraph(database);
  finalizedOrderCount = 0;
}

async function createPool(database: Database, capacity: number): Promise<string> {
  const poolId = `pool_pos_${ulid().slice(-10).toLowerCase()}`;
  await database
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: EVENT_ID,
      name: `POS Pool ${poolId}`,
      total_capacity: capacity,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: 300,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return poolId;
}

async function createTicketType(
  database: Database,
  poolId: string,
  priceCents: number,
): Promise<string> {
  const ticketTypeId = `tt_pos_${ulid().slice(-10).toLowerCase()}`;
  await database
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: EVENT_ID,
      name: `POS Ticket ${ticketTypeId}`,
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: priceCents,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return ticketTypeId;
}

async function setupRouteApp(
  database: Database,
  identity: RouteIdentity = defaultIdentity,
  principalOverrides: Partial<Principal> = {},
): Promise<FastifyInstance> {
  const routeApp = Fastify();
  const pricingEngine = new PricingEngine();
  inventoryService = new InventoryService(database);
  routeApp.decorate('context', {
    db: database,
    pricingEngine,
    inventoryService,
    qrService: new QrService(),
    authService: {
      isLocalDevMode: vi.fn(() => true),
      authenticateLocalDev: vi.fn(async () => ({
        principal: makePrincipal(identity, principalOverrides),
      })),
    },
    temporalClient: {
      startCheckoutSession: async (input: TemporalStartInput) => {
        const finalized = await finalizeOrderActivity({
          checkoutSessionId: input.checkoutSessionId,
          tenantId: input.tenantId,
          paymentMode: 'offline',
          salesChannel: input.salesChannel,
          operatorId: input.operatorId,
          tenderType: input.tenderType,
        });
        if (!finalized.ok) throw new Error(finalized.errorCode);
        finalizedOrderCount += 1;
        return {
          workflowId: `checkout-session:${input.checkoutSessionId}`,
          result: async () => ({ status: 'completed' as const, orderId: finalized.value.orderId }),
        };
      },
    },
  } as unknown as AppContext);
  routeApp.addHook('preHandler', async (request) => {
    request.principal = makePrincipal(identity, principalOverrides);
  });
  registerErrorHandler(routeApp);
  await routeApp.register(checkoutRoutes);
  await routeApp.register(checkInRoutes);
  return routeApp;
}

describeWithIntegrationDatabase(
  `box-office order route DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDbDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await cleanupAll(db);
      app = await setupRouteApp(db);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      if (db) {
        await cleanupAll(db);
        await db.destroy();
      }
      restoreDatabaseDriver(previousDbDriver);
    }, 120_000);

    beforeEach(async () => {
      await resetMutableState(db);
    });

    it('binds real PostgreSQL/MySQL persistence controls to the box-office authorization contract', async () => {
      expect(boxOfficeAuthorizationContract).toMatchObject({
        operationId: 'postEventsByEventIdBoxOfficeOrders',
        persistenceSource: 'box-office-orders-db.integration.test.ts',
        sideEffectAssertions: ['persistence', 'workflow'],
      });
    });

    it('denies every declared box-office boundary with zero real persistence or workflow effects', async () => {
      const cases: Array<{
        boundary: string;
        code: 'FORBIDDEN' | 'NOT_FOUND';
        principal: Partial<Principal>;
        status: 403 | 404;
      }> = [
        {
          boundary: 'permission',
          code: 'FORBIDDEN',
          principal: { scopes: ['events.read', 'orders.read'] },
          status: 403,
        },
        {
          boundary: 'tenant',
          code: 'NOT_FOUND',
          principal: { tenantId: `tnt_other_${RUN_ID}` },
          status: 404,
        },
        {
          boundary: 'organization',
          code: 'NOT_FOUND',
          principal: { organizationIds: [`org_other_${RUN_ID}`] },
          status: 404,
        },
        {
          boundary: 'brand',
          code: 'NOT_FOUND',
          principal: { brandIds: [`brd_other_${RUN_ID}`] },
          status: 404,
        },
        {
          boundary: 'event',
          code: 'NOT_FOUND',
          principal: { eventIds: [`evt_other_${RUN_ID}`] },
          status: 404,
        },
      ];

      for (const testCase of cases) {
        await resetMutableState(db);
        const poolId = await createPool(db, 3);
        const ticketTypeId = await createTicketType(db, poolId, 2500);
        const denialApp = await setupRouteApp(db, defaultIdentity, testCase.principal);
        const before = await db.transaction().execute(async (trx) => ({
          checkoutSessions: await trx.selectFrom('checkout_sessions').selectAll().execute(),
          idempotencyRecords: await trx.selectFrom('idempotency_records').selectAll().execute(),
          inventoryPools: await trx.selectFrom('inventory_pools').selectAll().execute(),
          orders: await trx.selectFrom('orders').selectAll().execute(),
        }));

        try {
          const response = await denialApp.inject({
            method: 'POST',
            url: `/events/${EVENT_ID}/box-office/orders`,
            headers: { 'Idempotency-Key': `pos_db_denial_${testCase.boundary}_${RUN_ID}` },
            payload: {
              tenderType: 'manual_card',
              amountCents: 2500,
              items: [{ ticketTypeId, quantity: 1 }],
            },
          });

          expect(response.statusCode).toBe(testCase.status);
          expect(response.json().error.code).toBe(testCase.code);
          expect(
            await db.transaction().execute(async (trx) => ({
              checkoutSessions: await trx.selectFrom('checkout_sessions').selectAll().execute(),
              idempotencyRecords: await trx.selectFrom('idempotency_records').selectAll().execute(),
              inventoryPools: await trx.selectFrom('inventory_pools').selectAll().execute(),
              orders: await trx.selectFrom('orders').selectAll().execute(),
            })),
          ).toEqual(before);
          expect(finalizedOrderCount).toBe(0);
        } finally {
          await denialApp.close();
        }
      }
    }, 30_000);

    it('persists an authenticated manual-card POS order with real DB idempotency and inventory conversion', async () => {
      const poolId = await createPool(db, 3);
      const ticketTypeId = await createTicketType(db, poolId, 2500);
      const payload = {
        tenderType: 'manual_card',
        amountCents: 2500,
        buyer: { email: 'manual-db@example.com', firstName: 'Manual', lastName: 'Buyer' },
        items: [{ ticketTypeId, quantity: 1 }],
      };

      const first = await app.inject({
        method: 'POST',
        url: `/events/${EVENT_ID}/box-office/orders`,
        headers: { 'Idempotency-Key': `pos_db_manual_${RUN_ID}` },
        payload,
      });
      const replay = await app.inject({
        method: 'POST',
        url: `/events/${EVENT_ID}/box-office/orders`,
        headers: { 'Idempotency-Key': `pos_db_manual_${RUN_ID}` },
        payload,
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(finalizedOrderCount).toBe(1);

      const orders = await db
        .selectFrom('orders')
        .selectAll()
        .where('tenant_id', '=', TENANT_ID)
        .execute();
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({
        sales_channel: 'box_office',
        operator_id: OPERATOR_ID,
        tender_type: 'manual_card',
      });
      expect(Number(orders[0].total_cents)).toBe(2500);

      const tickets = await new TicketRepository(db).findByOrder(orders[0].id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]).toMatchObject({
        event_id: EVENT_ID,
        ticket_type_id: ticketTypeId,
        status: 'valid',
      });
      const attendees = await db
        .selectFrom('attendees')
        .selectAll()
        .where('order_id', '=', orders[0].id)
        .execute();
      expect(attendees).toHaveLength(1);
      expect(attendees[0]).toMatchObject({ ticket_id: tickets[0]!.id, status: 'confirmed' });

      const checkInList = await new CheckInListRepository(db).create({
        eventId: EVENT_ID,
        name: 'Portable destination doors',
        ticketTypeIds: [ticketTypeId],
      });
      const scanPayload = {
        checkInListId: checkInList.id,
        qrPayload: tickets[0]!.qr_payload,
        deviceId: 'device_portable_destination',
        scannedAt: new Date().toISOString(),
        offline: false,
      };
      await expect(
        new TicketRepository(db).checkInIfValidInTransaction(
          tickets[0]!.id,
          'unsafe-non-transactional-device',
          new Date(),
        ),
      ).rejects.toThrow('CHECK_IN_TRANSACTION_REQUIRED');
      await expect(
        new ScanLogRepository(db).createInTransaction({
          tenantId: TENANT_ID,
          checkInListId: checkInList.id,
          deviceId: 'unsafe-non-transactional-device',
          ticketId: tickets[0]!.id,
          qrHash: tickets[0]!.qr_hash,
          outcome: 'accepted',
          scannedAt: new Date(),
          offline: false,
        }),
      ).rejects.toThrow('CHECK_IN_TRANSACTION_REQUIRED');
      await expect(new CheckInListRepository(db).findByIdForUpdate(checkInList.id)).rejects.toThrow(
        'CHECK_IN_TRANSACTION_REQUIRED',
      );
      await db
        .updateTable('check_in_lists')
        .set({ next_activity_sequence: '9223372036854775807' })
        .where('id', '=', checkInList.id)
        .execute();
      const failedAuditScan = await app.inject({
        method: 'POST',
        url: '/check-ins/scan',
        headers: { 'Idempotency-Key': `pos-scan-audit-failure-${RUN_ID}` },
        payload: scanPayload,
      });
      expect(failedAuditScan.statusCode).toBe(500);
      await expect(new TicketRepository(db).findById(tickets[0]!.id)).resolves.toMatchObject({
        status: 'valid',
        checked_in_at: null,
      });
      await expect(
        db
          .selectFrom('attendees')
          .selectAll()
          .where('ticket_id', '=', tickets[0]!.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ status: 'confirmed', checked_in_at: null });
      expect(await new ScanLogRepository(db).findByList(checkInList.id)).toHaveLength(0);
      const persistedSequence = await db
        .selectFrom('check_in_lists')
        .select(sql<string>`concat('', next_activity_sequence)`.as('next_activity_sequence_exact'))
        .where('id', '=', checkInList.id)
        .executeTakeFirstOrThrow();
      expect(BigInt(persistedSequence.next_activity_sequence_exact)).toBe(9223372036854775807n);
      expect(
        await db
          .selectFrom('idempotency_records')
          .select('id')
          .where('tenant_id', '=', TENANT_ID)
          .where('key', '=', `pos-scan-audit-failure-${RUN_ID}`)
          .executeTakeFirst(),
      ).toBeUndefined();
      await db
        .updateTable('check_in_lists')
        .set({ next_activity_sequence: 0 })
        .where('id', '=', checkInList.id)
        .execute();
      const acceptedScan = await app.inject({
        method: 'POST',
        url: '/check-ins/scan',
        headers: { 'Idempotency-Key': `pos-scan-audit-failure-${RUN_ID}` },
        payload: scanPayload,
      });
      const acceptedReplay = await app.inject({
        method: 'POST',
        url: '/check-ins/scan',
        headers: { 'Idempotency-Key': `pos-scan-audit-failure-${RUN_ID}` },
        payload: scanPayload,
      });
      const duplicateScan = await app.inject({
        method: 'POST',
        url: '/check-ins/scan',
        headers: { 'Idempotency-Key': `pos-scan-duplicate-${RUN_ID}` },
        payload: scanPayload,
      });
      expect(acceptedScan).toMatchObject({ statusCode: 200 });
      expect(acceptedScan.json()).toMatchObject({ outcome: 'accepted', ticketId: tickets[0]!.id });
      expect(acceptedReplay.json()).toEqual(acceptedScan.json());
      expect(duplicateScan.json()).toMatchObject({
        outcome: 'duplicate',
        ticketId: tickets[0]!.id,
      });
      const scans = await new ScanLogRepository(db).findByList(checkInList.id);
      expect(scans).toHaveLength(2);
      expect(scans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcome: 'duplicate', ticket_id: tickets[0]!.id }),
          expect.objectContaining({ outcome: 'accepted', ticket_id: tickets[0]!.id }),
        ]),
      );
      await expect(new TicketRepository(db).findById(tickets[0]!.id)).resolves.toMatchObject({
        status: 'checked_in',
        checked_in_by_device_id: OPERATOR_ID,
      });

      const pool = await db
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(Number(pool.sold_count)).toBe(1);

      const activeHolds = await db
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('inventory_pool_id', '=', poolId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      expect(Number(activeHolds.count)).toBe(0);
    });

    it('prevents oversell when concurrent POS cash orders exceed capacity', async () => {
      const capacity = 2;
      const burst = 6;
      const poolId = await createPool(db, capacity);
      const ticketTypeId = await createTicketType(db, poolId, 1000);
      const responses = await Promise.all(
        Array.from({ length: burst }, (_, index) =>
          app.inject({
            method: 'POST',
            url: `/events/${EVENT_ID}/box-office/orders`,
            headers: { 'Idempotency-Key': `pos_db_burst_${RUN_ID}_${index}` },
            payload: {
              tenderType: 'cash',
              amountCents: 1000,
              buyer: { email: `cash-${index}@example.com` },
              items: [{ ticketTypeId, quantity: 1 }],
            },
          }),
        ),
      );

      const successes = responses.filter((response) => response.statusCode === 201);
      const failures = responses.filter((response) => response.statusCode !== 201);
      expect(successes).toHaveLength(capacity);
      expect(failures).toHaveLength(burst - capacity);
      expect(failures.every((response) => response.statusCode < 500)).toBe(true);

      const pool = await db
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(Number(pool.sold_count)).toBe(capacity);

      const held = await db
        .selectFrom('checkout_holds')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('inventory_pool_id', '=', poolId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      expect(Number(held.count)).toBe(0);

      const orderCount = await db
        .selectFrom('orders')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', TENANT_ID)
        .where('sales_channel', '=', 'box_office')
        .executeTakeFirstOrThrow();
      expect(Number(orderCount.count)).toBe(capacity);
    });

    it('continues a verified same-process portable data-plane import through replay, sale, fulfillment, and routed check-in', async () => {
      const sourcePoolId = await createPool(db, 5);
      await createTicketType(db, sourcePoolId, 1800);
      const sections = await loadPortableConfigurationSections(db, {
        tenantId: TENANT_ID,
        organizationId: ORG_ID,
      });
      const bundleKeys = generateKeyPairSync('ed25519');
      const payloadKeys = generateKeyPairSync('ed25519');
      const payloadPolicies = createPortableConfigurationPayloadPolicies();
      const built = buildPortableLogicalExport({
        bundleId: `bundle_pos_roundtrip_${RUN_ID}`,
        mode: 'configuration',
        source: {
          operatingModel: 'self-hosted',
          deploymentId: `self_hosted_source_${RUN_ID}`,
          tenantId: TENANT_ID,
          organizationId: ORG_ID,
          exportSequence: 1,
          changeCursor: `snapshot-sha256:${'a'.repeat(64)}`,
        },
        apiVersion: '2026-07-17',
        dataSchemaVersion: '0080',
        exportedAt: '2026-07-13T12:00:00.000Z',
        currentTime: '2026-07-13T12:00:00.000Z',
        compatibility: {
          minimumApiVersion: '2026-07-17',
          maximumApiVersion: '2026-07-17',
          minimumDataSchemaVersion: '0080',
          maximumDataSchemaVersion: '0080',
          requiredCapabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
          requiredEntitlements: [],
        },
        sections,
        bundleSigning: { keyId: 'bundle_key_pos_01', privateKey: bundleKeys.privateKey },
        payloadSigning: { keyId: 'payload_key_pos_01', privateKey: payloadKeys.privateKey },
        payloadPolicies,
      });

      const destinationTenant = await new TenantRepository(db).create({
        name: `Portable POS destination ${RUN_ID}`,
      });
      const destinationOrganization = await new OrganizationRepository(db).create({
        tenantId: destinationTenant.id,
        name: `Portable POS destination ${RUN_ID}`,
        slug: `portable-pos-destination-${RUN_ID}`,
      });
      const configuration = prepareTixkitPortableUpload(built.transport, {
        destination: {
          deploymentId: `self_hosted_destination_${RUN_ID}`,
          apiVersion: '2026-07-17',
          dataSchemaVersion: '0080',
          capabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
          entitlements: [],
          availableStorageBytes: 64 * 1024 * 1024,
          acceptedSourceOperatingModels: ['self-hosted'],
        },
        trustedBundleKeys: new Map([['bundle_key_pos_01', bundleKeys.publicKey]]),
        trustedPayloadKeys: new Map([['payload_key_pos_01', payloadKeys.publicKey]]),
        trustedPayloadPolicies: new Map(
          [...payloadPolicies].map(([section, policy]) => [
            section,
            {
              schemaId: policy.schemaId,
              schemaSha256: policy.schemaSha256,
              policySha256: policy.policySha256,
              scannerId: policy.scannerId,
              keyId: 'payload_key_pos_01',
            },
          ]),
        ),
        trustedMediaKeys: new Map(),
        trustedMediaPolicies: new Map(),
        destinationTenantId: destinationTenant.id,
        destinationOrganizationId: destinationOrganization.id,
      });
      const adapter = new TixkitPortableMigrationAdapter();
      const context = {
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
      };
      const discovery = await adapter.discover(configuration, context);
      const normalized: NormalizedMigrationEntity[] = [];
      let cursor: string | undefined;
      do {
        const page = await adapter.extract({
          configuration,
          discovery,
          cursor,
          limit: 25,
          context,
        });
        for (const row of page.rows) normalized.push(await adapter.normalize(row, context));
        cursor = page.nextCursor;
      } while (cursor);
      expect(normalized.length).toBeGreaterThan(0);

      const imports = new ImportRepository(db);
      const committers = createProductionMigrationCommitters(db);
      const commit = async (idempotencyKey: string, persistReferences: boolean) => {
        const job = await imports.createJob({
          tenantId: destinationTenant.id,
          organizationId: destinationOrganization.id,
          sourceSystem: 'tixkit-portable',
          adapterVersion: 'tixkit-portable-bundle-v2',
          mode: 'commit',
          idempotencyKey,
          requestedBy: 'portable-pos-test',
        });
        const dispositions: string[] = [];
        for (const entity of sortEntitiesByDependency(normalized)) {
          const outcome = await committers.get(entity.entityType)!.commit({
            tenantId: destinationTenant.id,
            organizationId: destinationOrganization.id,
            jobId: job.id,
            entity,
            sideEffects: MIGRATION_SIDE_EFFECT_POLICY,
          });
          dispositions.push(outcome.disposition);
          if (persistReferences) {
            await imports.recordExternalReference({
              tenantId: destinationTenant.id,
              organizationId: destinationOrganization.id,
              sourceSystem: 'tixkit-portable',
              entityType: entity.entityType,
              externalId: entity.externalId,
              tixkitId: outcome.tixkitId!,
              importJobId: job.id,
              createdByJob: outcome.disposition === 'created',
            });
          }
        }
        return dispositions;
      };
      await commit(`portable-pos-roundtrip-${RUN_ID}`, true);
      const entityCountBeforeReplay = await db
        .selectFrom('external_references')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', destinationTenant.id)
        .where('organization_id', '=', destinationOrganization.id)
        .where('source_system', '=', 'tixkit-portable')
        .executeTakeFirstOrThrow();
      const replayDispositions = await commit(`portable-pos-roundtrip-replay-${RUN_ID}`, false);
      expect(replayDispositions).toHaveLength(normalized.length);
      expect(replayDispositions.every((disposition) => disposition === 'skipped')).toBe(true);
      const entityCountAfterReplay = await db
        .selectFrom('external_references')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('tenant_id', '=', destinationTenant.id)
        .where('organization_id', '=', destinationOrganization.id)
        .where('source_system', '=', 'tixkit-portable')
        .executeTakeFirstOrThrow();
      expect(Number(entityCountAfterReplay.count)).toBe(Number(entityCountBeforeReplay.count));

      const destinationId = async (entityType: string, externalId: string) =>
        (await imports.findExternalReference({
          tenantId: destinationTenant.id,
          organizationId: destinationOrganization.id,
          sourceSystem: 'tixkit-portable',
          entityType,
          externalId,
        }))!.tixkit_id;
      const destinationBrandId = await destinationId('brand', BRAND_ID);
      const destinationEventId = await destinationId('event', EVENT_ID);
      const sourceTicketTypeId = sections.get('ticket_types')![0]!.portableId;
      const destinationTicketTypeId = await destinationId('ticket-type', sourceTicketTypeId);
      const destinationPoolId = await destinationId('inventory-pool', sourcePoolId);
      await db
        .updateTable('organizations')
        .set({
          box_office_settings: JSON.stringify({
            enabled: true,
            allowedTenderTypes: ['manual_card'],
            requireBuyerEmail: true,
            receiptMode: 'email',
          }),
        })
        .where('tenant_id', '=', destinationTenant.id)
        .where('id', '=', destinationOrganization.id)
        .execute();
      await db
        .updateTable('brands')
        .set({ status: 'active' })
        .where('id', '=', destinationBrandId)
        .execute();
      await db
        .updateTable('events')
        .set({ status: 'published', visibility: 'public' })
        .where('id', '=', destinationEventId)
        .execute();
      await db
        .updateTable('ticket_types')
        .set({ status: 'active', visibility: 'public' })
        .where('id', '=', destinationTicketTypeId)
        .execute();

      const destinationApp = await setupRouteApp(db, {
        tenantId: destinationTenant.id,
        organizationId: destinationOrganization.id,
        brandId: destinationBrandId,
        eventId: destinationEventId,
        operatorId: `usr_portable_pos_${RUN_ID}`,
      });
      try {
        const sale = await destinationApp.inject({
          method: 'POST',
          url: `/events/${destinationEventId}/box-office/orders`,
          headers: { 'Idempotency-Key': `portable-pos-sale-${RUN_ID}` },
          payload: {
            tenderType: 'manual_card',
            amountCents: 1800,
            buyer: { email: 'portable-buyer@example.com' },
            items: [{ ticketTypeId: destinationTicketTypeId, quantity: 1 }],
          },
        });
        expect(sale.statusCode).toBe(201);
        const orderId = sale.json<{ order: { id: string } }>().order.id;
        const destinationOrder = await db
          .selectFrom('orders')
          .selectAll()
          .where('id', '=', orderId)
          .executeTakeFirstOrThrow();
        expect(destinationOrder).toMatchObject({
          tenant_id: destinationTenant.id,
          organization_id: destinationOrganization.id,
          event_id: destinationEventId,
          status: 'paid',
          sales_channel: 'box_office',
          operator_id: `usr_portable_pos_${RUN_ID}`,
          tender_type: 'manual_card',
        });
        expect(Number(destinationOrder.total_cents)).toBe(1800);
        const tickets = await new TicketRepository(db).findByOrder(orderId);
        expect(tickets).toHaveLength(1);
        expect(tickets[0]).toMatchObject({
          tenant_id: destinationTenant.id,
          event_id: destinationEventId,
          ticket_type_id: destinationTicketTypeId,
          status: 'valid',
        });
        await expect(
          db
            .selectFrom('attendees')
            .selectAll()
            .where('order_id', '=', orderId)
            .executeTakeFirstOrThrow(),
        ).resolves.toMatchObject({ ticket_id: tickets[0]!.id, status: 'confirmed' });
        const destinationPool = await db
          .selectFrom('inventory_pools')
          .select('sold_count')
          .where('id', '=', destinationPoolId)
          .executeTakeFirstOrThrow();
        expect(Number(destinationPool.sold_count)).toBe(1);
        expect(
          Number(
            (
              await db
                .selectFrom('checkout_holds')
                .select(({ fn }) => fn.countAll<number>().as('count'))
                .where('inventory_pool_id', '=', destinationPoolId)
                .where('status', '=', 'active')
                .executeTakeFirstOrThrow()
            ).count,
          ),
        ).toBe(0);
        const list = await new CheckInListRepository(db).create({
          eventId: destinationEventId,
          name: 'Destination doors',
          ticketTypeIds: [destinationTicketTypeId],
        });
        const ticketRepository = new TicketRepository(db);
        const scanPayload = {
          checkInListId: list.id,
          deviceId: 'portable-door-device',
          qrPayload: tickets[0]!.qr_payload,
          scannedAt: new Date().toISOString(),
          offline: false,
        };
        const acceptedScan = await destinationApp.inject({
          method: 'POST',
          url: '/check-ins/scan',
          headers: { 'Idempotency-Key': `portable-scan-${RUN_ID}` },
          payload: scanPayload,
        });
        const acceptedReplay = await destinationApp.inject({
          method: 'POST',
          url: '/check-ins/scan',
          headers: { 'Idempotency-Key': `portable-scan-${RUN_ID}` },
          payload: scanPayload,
        });
        const duplicateScan = await destinationApp.inject({
          method: 'POST',
          url: '/check-ins/scan',
          headers: { 'Idempotency-Key': `portable-scan-duplicate-${RUN_ID}` },
          payload: scanPayload,
        });
        expect(acceptedScan.json()).toMatchObject({
          outcome: 'accepted',
          ticketId: tickets[0]!.id,
        });
        expect(acceptedReplay.json()).toEqual(acceptedScan.json());
        expect(duplicateScan.json()).toMatchObject({
          outcome: 'duplicate',
          ticketId: tickets[0]!.id,
        });
        const liveCountsBeforeReplay = await Promise.all([
          db
            .selectFrom('orders')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('tickets')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('scan_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
        ]);
        const liveReplayDispositions = await commit(
          `portable-pos-roundtrip-live-replay-${RUN_ID}`,
          false,
        );
        expect(liveReplayDispositions.every((disposition) => disposition !== 'created')).toBe(true);
        const liveCountsAfterReplay = await Promise.all([
          db
            .selectFrom('orders')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('tickets')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('scan_logs')
            .select(({ fn }) => fn.countAll<number>().as('count'))
            .where('tenant_id', '=', destinationTenant.id)
            .executeTakeFirstOrThrow(),
        ]);
        expect(liveCountsAfterReplay.map(({ count }) => Number(count))).toEqual(
          liveCountsBeforeReplay.map(({ count }) => Number(count)),
        );
        await expect(ticketRepository.findById(tickets[0]!.id)).resolves.toMatchObject({
          status: 'checked_in',
          checked_in_by_device_id: `usr_portable_pos_${RUN_ID}`,
        });
      } finally {
        await destinationApp.close();
      }
    });
  },
);
