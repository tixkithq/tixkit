import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AttendeeRepository,
  CheckInListRepository,
  CheckoutSessionRepository,
  createDb,
  OrderRepository,
  TicketRepository,
  type Database,
} from '@tixkit/db';
import { QrService, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const scanContract = CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.operationId === 'postCheckInsScan',
);
if (!scanContract) throw new Error('Missing check-in scan authorization contract');

const runId = ulid().slice(-10).toLowerCase();
const tenantId = `tnt_scan_auth_${runId}`;
const organizationId = `org_scan_auth_${runId}`;
const brandId = `brd_scan_auth_${runId}`;
const eventId = `evt_scan_auth_${runId}`;
const poolId = `pool_scan_auth_${runId}`;
const ticketTypeId = `tt_scan_auth_${runId}`;
const ticketId = `tkt_scan_auth_${runId}`;
const principalId = `usr_scan_auth_${runId}`;
const idempotencyKeyPrefix = `scan-auth-${runId}`;
const qrService = new QrService(`scan-authorization-${runId}`);

let attendeeId: string;
let checkInListId: string;
let db: Database;
let previousDriver: string | undefined;
let qrPayload: string;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: principalId,
    tenantId,
    organizationIds: [organizationId],
    brandIds: [brandId],
    eventIds: [eventId],
    scopes: ['checkins.write'],
    ...overrides,
  };
}

async function buildApp(
  activePrincipal: Principal,
  database: Database = db,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('context', { db: database, qrService } as AppContext);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(checkInRoutes);
  return app;
}

function failRootIdempotencyCompletionUpdates(failureCount: number): {
  database: Database;
  attempts: () => number;
} {
  let attempts = 0;
  const wrapCompletionQuery = (query: object): object =>
    new Proxy(query, {
      get(target, property, receiver) {
        if (property === 'execute') {
          return async () => {
            attempts += 1;
            if (attempts <= failureCount) {
              throw new Error('injected outer idempotency completion failure');
            }
            return Reflect.get(target, property, receiver).call(target);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args) as unknown;
          return typeof result === 'object' && result !== null
            ? wrapCompletionQuery(result)
            : result;
        };
      },
    });

  const database = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'updateTable') {
        return (table: string) => {
          const query = target.updateTable(table as never);
          return table === 'idempotency_records' ? wrapCompletionQuery(query) : query;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;

  return { database, attempts: () => attempts };
}

async function seedFixture(): Promise<void> {
  const now = new Date('2026-07-16T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: `Check-in scan authorization ${runId}`,
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: organizationId,
      tenant_id: tenantId,
      name: `Check-in scan authorization ${runId}`,
      slug: `scan-auth-${runId}`,
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
      id: brandId,
      tenant_id: tenantId,
      organization_id: organizationId,
      name: `Check-in scan authorization ${runId}`,
      slug: `scan-auth-${runId}`,
      status: 'active',
      theme: '{}',
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
      id: eventId,
      tenant_id: tenantId,
      organization_id: organizationId,
      brand_id: brandId,
      slug: `scan-auth-${runId}`,
      title: 'Check-in scan authorization',
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
      event_id: eventId,
      name: 'Check-in scan authorization inventory',
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
      event_id: eventId,
      name: 'General admission',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 2_500,
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

  const checkout = await new CheckoutSessionRepository(db).create({
    tenantId,
    eventId,
    brandId,
    currency: 'USD',
    cart: { items: [{ ticketTypeId, quantity: 1 }] },
    buyer: { email: 'grace@example.test' },
    quote: { totalCents: 2_500 },
    expiresAt: new Date('2027-01-01T17:00:00.000Z'),
    idempotencyKey: `${idempotencyKeyPrefix}-checkout`,
  });
  const order = await new OrderRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    eventId,
    checkoutSessionId: checkout.id,
    orderNumber: `SCAN-AUTH-${runId}`,
    status: 'paid',
    currency: 'USD',
    subtotalCents: 2_500,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 2_500,
    buyerEmail: 'grace@example.test',
  });
  const attendee = await new AttendeeRepository(db).create({
    tenantId,
    orderId: order.id,
    eventId,
    ticketTypeId,
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@example.test',
  });
  attendeeId = attendee.id;
  const generatedQr = qrService.generate(ticketId);
  qrPayload = generatedQr.payload;
  await new TicketRepository(db).create({
    id: ticketId,
    tenantId,
    orderId: order.id,
    attendeeId,
    eventId,
    ticketTypeId,
    code: generatedQr.code,
    qrPayload: generatedQr.payload,
    qrHash: generatedQr.hash,
  });
  await db
    .updateTable('attendees')
    .set({ ticket_id: ticketId, status: 'confirmed', updated_at: now })
    .where('id', '=', attendeeId)
    .execute();
  const list = await new CheckInListRepository(db).create({
    eventId,
    name: 'Authorization proof doors',
    ticketTypeIds: [ticketTypeId],
  });
  checkInListId = list.id;
}

async function cleanupFixture(): Promise<void> {
  await db
    .deleteFrom('idempotency_records')
    .where('tenant_id', '=', tenantId)
    .where('key', 'like', `${idempotencyKeyPrefix}%`)
    .execute();
  await db.deleteFrom('scan_logs').where('tenant_id', '=', tenantId).execute();
  await db.deleteFrom('check_in_lists').where('event_id', '=', eventId).execute();
  await db
    .updateTable('attendees')
    .set({ ticket_id: null })
    .where('event_id', '=', eventId)
    .execute();
  await db.deleteFrom('tickets').where('id', '=', ticketId).execute();
  await db.deleteFrom('attendees').where('event_id', '=', eventId).execute();
  await db.deleteFrom('orders').where('event_id', '=', eventId).execute();
  await db.deleteFrom('checkout_sessions').where('event_id', '=', eventId).execute();
  await db.deleteFrom('ticket_types').where('id', '=', ticketTypeId).execute();
  await db.deleteFrom('inventory_pools').where('id', '=', poolId).execute();
  await db.deleteFrom('events').where('id', '=', eventId).execute();
  await db.deleteFrom('brands').where('id', '=', brandId).execute();
  await db.deleteFrom('organizations').where('id', '=', organizationId).execute();
  await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
}

async function persistedState() {
  const [attendee, ticket, list, scanLogs, idempotencyRecords] = await Promise.all([
    db.selectFrom('attendees').selectAll().where('id', '=', attendeeId).executeTakeFirstOrThrow(),
    db.selectFrom('tickets').selectAll().where('id', '=', ticketId).executeTakeFirstOrThrow(),
    db
      .selectFrom('check_in_lists')
      .selectAll()
      .where('id', '=', checkInListId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('scan_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('idempotency_records')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('key', 'like', `${idempotencyKeyPrefix}%`)
      .orderBy('key')
      .execute(),
  ]);
  return { attendee, ticket, list, scanLogs, idempotencyRecords };
}

function scanPayload(scannedAt = '2026-07-16T12:01:00.000Z') {
  return { checkInListId, qrPayload, scannedAt, offline: false };
}

const deniedPrincipals = {
  tenant: () => principal({ tenantId: `tnt_scan_denied_${runId}` }),
  organization: () => principal({ organizationIds: [`org_scan_denied_${runId}`] }),
  brand: () => principal({ brandIds: [`brd_scan_denied_${runId}`] }),
  event: () => principal({ eventIds: [`evt_scan_denied_${runId}`] }),
} as const;
type ScanDeniedBoundary = keyof typeof deniedPrincipals;
const scanDeniedBoundaries = scanContract.deniedBoundaries.map((boundary) => {
  if (!(boundary in deniedPrincipals)) {
    throw new Error(`Unsupported check-in scan denial boundary: ${boundary}`);
  }
  return boundary as ScanDeniedBoundary;
});

describeWithIntegrationDatabase(
  `check-in scan route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
    }, 120_000);

    afterAll(async () => {
      try {
        if (db) {
          try {
            await cleanupFixture();
          } finally {
            await db.destroy();
          }
        }
      } finally {
        restoreDatabaseDriver(previousDriver);
      }
    }, 120_000);

    beforeEach(async () => {
      await cleanupFixture();
      await seedFixture();
    }, 120_000);

    it('binds the executable matrix to the formal check-in scan contract', () => {
      expect(scanContract).toMatchObject({
        method: 'POST',
        operationId: 'postCheckInsScan',
        path: '/check-ins/scan',
        sideEffectAssertions: ['persistence'],
      });
      expect(scanDeniedBoundaries).toEqual(Object.keys(deniedPrincipals));
    });

    it('accepts an authorized scan and persists the linked ticket, attendee, list, and audit state', async () => {
      const app = await buildApp(principal());
      const key = `${idempotencyKeyPrefix}-authorized`;
      try {
        const response = await app.inject({
          method: scanContract.method,
          url: scanContract.path,
          headers: { 'idempotency-key': key },
          payload: scanPayload(),
        });
        expect(response.statusCode, response.body).toBe(scanContract.authorizedControl.status);
        expect(response.json()).toMatchObject({ outcome: 'accepted', ticketId });
        const state = await persistedState();
        expect(state.ticket).toMatchObject({
          status: 'checked_in',
          checked_in_at: new Date('2026-07-16T12:01:00.000Z'),
          checked_in_by_device_id: principalId,
        });
        expect(state.attendee).toMatchObject({
          status: 'checked_in',
          checked_in_at: new Date('2026-07-16T12:01:00.000Z'),
          check_in_device_id: principalId,
        });
        expect(Number(state.list.next_activity_sequence)).toBe(1);
        expect(state.scanLogs).toHaveLength(1);
        expect(state.scanLogs[0]).toMatchObject({
          tenant_id: tenantId,
          check_in_list_id: checkInListId,
          ticket_id: ticketId,
          device_id: principalId,
          outcome: 'accepted',
        });
        expect(Number(state.scanLogs[0]!.activity_sequence)).toBe(1);
        expect(state.idempotencyRecords).toHaveLength(1);
        expect(state.idempotencyRecords[0]).toMatchObject({
          key,
          tenant_id: tenantId,
          response_status: 200,
          status: 'completed',
        });
      } finally {
        await app.close();
      }
    });

    it('rejects a missing idempotency key without persistence mutation', async () => {
      const before = await persistedState();
      const app = await buildApp(principal());
      try {
        const response = await app.inject({
          method: scanContract.method,
          url: scanContract.path,
          payload: scanPayload(),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        expect(await persistedState()).toEqual(before);
      } finally {
        await app.close();
      }
    });

    it('replays an authorized idempotent scan without a second mutation', async () => {
      const app = await buildApp(principal());
      const key = `${idempotencyKeyPrefix}-replay`;
      try {
        const request = {
          method: scanContract.method,
          url: scanContract.path,
          headers: { 'idempotency-key': key },
          payload: scanPayload(),
        } as const;
        const first = await app.inject(request);
        const afterFirst = await persistedState();
        const replay = await app.inject(request);
        expect(first.statusCode, first.body).toBe(200);
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(await persistedState()).toEqual(afterFirst);
        expect(afterFirst.scanLogs).toHaveLength(1);
        expect(afterFirst.idempotencyRecords).toHaveLength(1);
        expect(afterFirst.idempotencyRecords[0]).toMatchObject({
          key,
          tenant_id: tenantId,
          response_status: 200,
          status: 'completed',
        });
      } finally {
        await app.close();
      }
    });

    it('replays the transactionally completed response when every outer completion write fails', async () => {
      const key = `${idempotencyKeyPrefix}-ambiguous-completion`;
      const injected = failRootIdempotencyCompletionUpdates(3);
      const app = await buildApp(principal(), injected.database);
      try {
        const request = {
          method: scanContract.method,
          url: scanContract.path,
          headers: { 'idempotency-key': key },
          payload: scanPayload(),
        } as const;
        const first = await app.inject(request);
        const afterFirst = await persistedState();
        const replay = await app.inject(request);

        expect(first.statusCode, first.body).toBe(200);
        expect(first.json()).toMatchObject({ outcome: 'accepted', ticketId });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(injected.attempts()).toBe(3);
        expect(await persistedState()).toEqual(afterFirst);
        expect(afterFirst.ticket).toMatchObject({ status: 'checked_in' });
        expect(afterFirst.attendee).toMatchObject({ status: 'checked_in' });
        expect(Number(afterFirst.list.next_activity_sequence)).toBe(1);
        expect(afterFirst.scanLogs).toHaveLength(1);
        expect(afterFirst.scanLogs[0]).toMatchObject({ outcome: 'accepted', ticket_id: ticketId });
        expect(afterFirst.idempotencyRecords).toHaveLength(1);
        expect(afterFirst.idempotencyRecords[0]).toMatchObject({
          key,
          status: 'completed',
          response_status: 200,
        });
      } finally {
        await app.close();
      }
    });

    it('serializes concurrent same-ticket scans into one accepted and one duplicate audit outcome', async () => {
      const app = await buildApp(principal());
      try {
        const responses = await Promise.all(
          ['concurrent-a', 'concurrent-b'].map((suffix) =>
            app.inject({
              method: scanContract.method,
              url: scanContract.path,
              headers: { 'idempotency-key': `${idempotencyKeyPrefix}-${suffix}` },
              payload: scanPayload(),
            }),
          ),
        );
        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        expect(responses.map((response) => response.json().outcome).sort()).toEqual([
          'accepted',
          'duplicate',
        ]);
        const state = await persistedState();
        expect(state.ticket).toMatchObject({ status: 'checked_in' });
        expect(state.attendee).toMatchObject({ status: 'checked_in' });
        expect(state.scanLogs.map((row) => row.outcome).sort()).toEqual(['accepted', 'duplicate']);
        expect(state.scanLogs.map((row) => Number(row.activity_sequence)).sort()).toEqual([1, 2]);
        expect(Number(state.list.next_activity_sequence)).toBe(2);
        expect(state.idempotencyRecords).toHaveLength(2);
      } finally {
        await app.close();
      }
    });

    it('denies missing permission without ticket, attendee, list, scan, or idempotency mutation', async () => {
      const before = await persistedState();
      const app = await buildApp(principal({ scopes: [] }));
      try {
        const response = await app.inject({
          method: scanContract.method,
          url: scanContract.path,
          headers: { 'idempotency-key': `${idempotencyKeyPrefix}-permission-denied` },
          payload: scanPayload(),
        });
        expect(response.statusCode).toBe(scanContract.permissionDenialResponse?.status);
        expect(response.json()).toMatchObject({
          error: { code: scanContract.permissionDenialResponse?.code },
        });
        expect(await persistedState()).toEqual(before);
      } finally {
        await app.close();
      }
    });

    it.each(
      scanDeniedBoundaries.map((boundary) => [boundary, deniedPrincipals[boundary]()] as const),
    )(
      'denies the %s boundary without ticket, attendee, list, scan, or idempotency mutation',
      async (boundary, deniedPrincipal) => {
        const before = await persistedState();
        const app = await buildApp(deniedPrincipal);
        try {
          const response = await app.inject({
            method: scanContract.method,
            url: scanContract.path,
            headers: { 'idempotency-key': `${idempotencyKeyPrefix}-${boundary}-denied` },
            payload: scanPayload(),
          });
          expect(response.statusCode).toBe(scanContract.denialResponse.status);
          expect(response.json()).toMatchObject({
            error: { code: scanContract.denialResponse.code },
          });
          expect(await persistedState()).toEqual(before);
        } finally {
          await app.close();
        }
      },
      120_000,
    );
  },
);
