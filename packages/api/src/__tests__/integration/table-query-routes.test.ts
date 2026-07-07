import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../../app.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';

// Mock executeTableQuery to capture config and return controlled results
const executeTableQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@tixkit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tixkit/db')>();
  return {
    ...actual,
    executeTableQuery: executeTableQueryMock,
  };
});

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['orders.read', 'attendees.read', 'events.read', 'orders.write', 'refunds.write'],
    brandIds: [],
    eventIds: [],
    ...overrides,
  };
}

function createMockDb() {
  const events = new Map<string, { id: string; title: string }>();
  const ticketTypes = new Map<string, { id: string; name: string }>();
  const eventRows = new Map<string, Record<string, unknown>>();

  return {
    selectFrom: vi.fn((table: string) => {
      const query = {
        select: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(() => query),
        execute: vi.fn(async () => {
          if (table === 'events') return Array.from(events.values());
          if (table === 'ticket_types') return Array.from(ticketTypes.values());
          return [];
        }),
        executeTakeFirst: vi.fn(async () => {
          if (table === 'events') return Array.from(eventRows.values())[0];
          return undefined;
        }),
      };
      return query;
    }),
    updateTable: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ execute: vi.fn(async () => []) })) })),
    })),
    insertInto: vi.fn(() => ({
      values: vi.fn(() => ({ returningAll: vi.fn(() => ({ executeTakeFirstOrThrow: vi.fn() })) })),
    })),
    transaction: vi.fn(() => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn({}),
    })),
    destroy: vi.fn(),
    events,
    ticketTypes,
    eventRows,
  };
}

async function setupOrdersApp(principal: Principal, db: unknown) {
  const app = Fastify();
  app.decorate('context', {
    db: db as Database,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = err.statusCode ?? 500;
    const code = err.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
    return reply.status(statusCode).send({ error: { code, message: err.message } });
  });
  await app.register(orderRoutes);
  return app;
}

async function setupCheckinApp(principal: Principal, db: unknown) {
  const app = Fastify();
  app.decorate('context', {
    db: db as Database,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    const statusCode = err.statusCode ?? 500;
    const code = err.code ?? (statusCode >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
    return reply.status(statusCode).send({ error: { code, message: err.message } });
  });
  await app.register(checkInRoutes);
  return app;
}

describe('orders table query route', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    db.events.set('evt_1', { id: 'evt_1', title: 'Summer Showcase' });
  });

  it('passes search param to executeTableQuery', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [{ id: 'ord_1', eventId: 'evt_1' }],
      nextCursor: undefined,
      total: 1,
      filterTotal: 1,
      facets: undefined,
      applied: { search: 'alice', sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders?search=alice' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].eventTitle).toBe('Summer Showcase');

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.search).toBe('alice');
    await app.close();
  });

  it('passes sort param to executeTableQuery', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [{ field: 'createdAt', direction: 'asc' }], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/orders?sort=createdAt:asc' });

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.sort).toEqual([{ field: 'createdAt', direction: 'asc' }]);
    await app.close();
  });

  it('passes status filter to executeTableQuery', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: { status: { type: 'select', values: ['paid'] } } },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/orders?status=paid' });

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.filters).toBeDefined();
    expect(queryArg.filters.status).toEqual({ type: 'select', values: ['paid'] });
    await app.close();
  });

  it('passes refundState boolean filter to executeTableQuery', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: { refundState: { type: 'boolean', value: true } } },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/orders?refundState=true' });

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.filters?.refundState).toEqual({ type: 'boolean', value: true });
    await app.close();
  });

  it('passes includeFacets and returns facets in response', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [{ id: 'ord_1', eventId: 'evt_1' }],
      nextCursor: undefined,
      total: 1,
      filterTotal: 1,
      facets: {
        status: { rows: [{ value: 'paid', total: 1 }] },
        refundState: { rows: [{ value: false, total: 1 }] },
      },
      applied: { sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders?includeFacets=true' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facets).toBeDefined();
    expect(body.facets.status.rows).toEqual([{ value: 'paid', total: 1 }]);
    expect(body.facets.refundState.rows).toEqual([{ value: false, total: 1 }]);

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.includeFacets).toBe(true);
    await app.close();
  });

  it('passes cursor and direction for pagination', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: 'next_cursor_value',
      prevCursor: 'prev_cursor_value',
      total: 10,
      filterTotal: 5,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({
      method: 'GET',
      url: '/orders?cursor=abc123&direction=next&limit=25',
    });

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.cursor).toBe('abc123');
    expect(queryArg.direction).toBe('next');
    expect(queryArg.limit).toBe(25);
    await app.close();
  });

  it('enables strictValidation in config', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/orders' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.strictValidation).toBe(true);
    await app.close();
  });

  it('passes customFilters and customFacets for refundState', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/orders?includeFacets=true' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.customFilters).toBeDefined();
    expect(configArg.customFilters.refundState).toBeDefined();
    expect(configArg.customFacets).toBeDefined();
    expect(configArg.customFacets.refundState).toBeDefined();
    await app.close();
  });

  it('returns 400 when strict validation rejects an unknown filter', async () => {
    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders?badField=test' });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toContain('badField');
    expect(executeTableQueryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when strict validation rejects a malformed boolean filter', async () => {
    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders?refundState=yes' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('refundState');
    expect(executeTableQueryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when strict validation rejects a malformed select filter', async () => {
    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders?status=paid,bogus' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('status');
    expect(executeTableQueryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('enriches items with event titles', async () => {
    db.events.set('evt_1', { id: 'evt_1', title: 'Summer Showcase' });
    db.events.set('evt_2', { id: 'evt_2', title: 'Winter Gala' });

    executeTableQueryMock.mockResolvedValue({
      items: [
        { id: 'ord_1', eventId: 'evt_1' },
        { id: 'ord_2', eventId: 'evt_2' },
        { id: 'ord_3', eventId: 'evt_unknown' },
      ],
      nextCursor: undefined,
      total: 3,
      filterTotal: 3,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupOrdersApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/orders' });

    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items[0].eventTitle).toBe('Summer Showcase');
    expect(items[1].eventTitle).toBe('Winter Gala');
    expect(items[2].eventTitle).toBe('');
    await app.close();
  });

  it('builds scope from principal org/brand/event restrictions', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const principal = makePrincipal({
      organizationIds: ['org_1', 'org_2'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
    });
    const app = await setupOrdersApp(principal, db);
    await app.inject({ method: 'GET', url: '/orders' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.scope.organization_id).toEqual(['org_1', 'org_2']);
    expect(configArg.scope.brand_id).toEqual(['brd_1']);
    expect(configArg.scope.event_id).toEqual(['evt_1']);
    await app.close();
  });

  it('overrides scope with explicit organizationId param', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const principal = makePrincipal({ organizationIds: ['org_1', 'org_2'] });
    const app = await setupOrdersApp(principal, db);
    await app.inject({ method: 'GET', url: '/orders?organizationId=org_1' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.scope.organization_id).toBe('org_1');
    await app.close();
  });
});

describe('attendees table query route', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    db.events.set('evt_1', { id: 'evt_1', title: 'Summer Showcase' });
    db.ticketTypes.set('tt_1', { id: 'tt_1', name: 'General Admission' });
    db.eventRows.set('evt_1', {
      id: 'evt_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
    });
  });

  it('passes search param for attendees', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [{ id: 'att_1', eventId: 'evt_1', ticketTypeId: 'tt_1' }],
      nextCursor: undefined,
      total: 1,
      filterTotal: 1,
      facets: undefined,
      applied: { search: 'alice', sort: [], filters: {} },
    });

    const app = await setupCheckinApp(makePrincipal(), db);
    const res = await app.inject({
      method: 'GET',
      url: '/attendees?search=alice',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].eventTitle).toBe('Summer Showcase');
    expect(body.items[0].ticketTypeName).toBe('General Admission');

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.search).toBe('alice');
    await app.close();
  });

  it('passes status filter for attendees', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: { status: { type: 'select', values: ['active'] } } },
    });

    const app = await setupCheckinApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/attendees?status=active' });

    const [, , queryArg] = executeTableQueryMock.mock.calls[0];
    expect(queryArg.filters?.status).toEqual({ type: 'select', values: ['active'] });
    await app.close();
  });

  it('enables strictValidation for attendees', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupCheckinApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/attendees' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.strictValidation).toBe(true);
    await app.close();
  });

  it('passes customFilters and customFacets for checkInStatus', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [],
      nextCursor: undefined,
      total: 0,
      filterTotal: 0,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupCheckinApp(makePrincipal(), db);
    await app.inject({ method: 'GET', url: '/attendees?includeFacets=true' });

    const [, configArg] = executeTableQueryMock.mock.calls[0];
    expect(configArg.customFilters).toBeDefined();
    expect(configArg.customFilters.checkInStatus).toBeDefined();
    expect(configArg.customFacets).toBeDefined();
    expect(configArg.customFacets.checkInStatus).toBeDefined();
    await app.close();
  });

  it('returns 400 for unknown attendee filter in strict mode', async () => {
    const app = await setupCheckinApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/attendees?badField=test' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('badField');
    expect(executeTableQueryMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('enriches attendees with event titles and ticket type names', async () => {
    executeTableQueryMock.mockResolvedValue({
      items: [
        { id: 'att_1', eventId: 'evt_1', ticketTypeId: 'tt_1' },
        { id: 'att_2', eventId: 'evt_unknown', ticketTypeId: 'tt_unknown' },
      ],
      nextCursor: undefined,
      total: 2,
      filterTotal: 2,
      facets: undefined,
      applied: { sort: [], filters: {} },
    });

    const app = await setupCheckinApp(makePrincipal(), db);
    const res = await app.inject({ method: 'GET', url: '/attendees' });

    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items[0].eventTitle).toBe('Summer Showcase');
    expect(items[0].ticketTypeName).toBe('General Admission');
    expect(items[1].eventTitle).toBe('');
    expect(items[1].ticketTypeName).toBe('Ticket');
    await app.close();
  });
});
