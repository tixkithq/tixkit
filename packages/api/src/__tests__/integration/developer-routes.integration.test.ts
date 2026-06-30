import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../../app.js';
import { ClerkAuthService } from '../../auth/clerk.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';

function createApiKeyListDb(rows: Record<string, unknown>[]) {
  return {
    selectFrom(table: string) {
      expect(table).toBe('api_keys');
      const query = {
        select() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        execute() {
          return Promise.resolve(rows);
        },
      };
      return query;
    },
  };
}

type QueryPredicate = (row: Record<string, unknown>) => boolean;
type QueryCondition = { column: string; operator: string; value: unknown };
type ExpressionBuilder = {
  (column: string, operator: string, value: unknown): QueryPredicate;
  and(predicates: QueryPredicate[]): QueryPredicate;
  or(predicates: QueryPredicate[]): QueryPredicate;
};

function matchesScannerLifecycleRow(
  row: Record<string, unknown>,
  conditions: QueryCondition[],
): boolean {
  return conditions.every(({ column, operator, value }) => {
    if (operator === '=') return row[column] === value;
    if (operator === 'is') return row[column] === value;
    throw new Error(`Unsupported scanner lifecycle test operator: ${operator}`);
  });
}

function createScannerDeviceLifecycleDb() {
  const tables: Record<string, Record<string, unknown>[]> = {
    scanner_devices: [],
    audit_logs: [],
  };
  const rowsFor = (table: string) => {
    tables[table] ??= [];
    return tables[table];
  };

  return {
    tables,
    db: {
      insertInto(table: string) {
        return {
          values(values: Record<string, unknown>) {
            const insert = {
              returningAll() {
                return insert;
              },
              async executeTakeFirstOrThrow() {
                rowsFor(table).push(values);
                return values;
              },
              async execute() {
                rowsFor(table).push(values);
                return [];
              },
            };
            return insert;
          },
        };
      },
      selectFrom(table: string) {
        const conditions: QueryCondition[] = [];
        const query = {
          selectAll() {
            return query;
          },
          where(column: string, operator: string, value: unknown) {
            conditions.push({ column, operator, value });
            return query;
          },
          async executeTakeFirst() {
            return rowsFor(table).find((row) => matchesScannerLifecycleRow(row, conditions));
          },
        };
        return query;
      },
      updateTable(table: string) {
        const conditions: QueryCondition[] = [];
        let values: Record<string, unknown> = {};
        const update = {
          set(nextValues: Record<string, unknown>) {
            values = nextValues;
            return update;
          },
          where(column: string, operator: string, value: unknown) {
            conditions.push({ column, operator, value });
            return update;
          },
          async execute() {
            for (const row of rowsFor(table).filter((candidate) =>
              matchesScannerLifecycleRow(candidate, conditions),
            )) {
              Object.assign(row, values);
            }
            return [];
          },
        };
        return update;
      },
    },
  };
}

function createWebhookDb(tables: Record<string, Record<string, unknown>[]>) {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- this resolver is scoped to the joined-row shape in this mock DB.
  const resolveColumn = (row: Record<string, unknown>, column: string) => {
    const event = row['__event'] as Record<string, unknown> | undefined;
    const delivery = row['__delivery'] as Record<string, unknown> | undefined;
    if (column.startsWith('webhook_events.'))
      return event?.[column.slice('webhook_events.'.length)];
    if (column.startsWith('webhook_deliveries.'))
      return delivery?.[column.slice('webhook_deliveries.'.length)];
    return row[column];
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- comparison semantics are specific to this mock DB.
  const comparable = (value: unknown, other?: unknown) => {
    if (value instanceof Date) return value.getTime();
    if (other instanceof Date && typeof value === 'string') return new Date(value).getTime();
    return value;
  };
  const compareValues = (left: unknown, operator: string, right: unknown) => {
    const normalizedLeft = comparable(left, right);
    const normalizedRight = comparable(right, left);
    switch (operator) {
      case '=':
        return normalizedLeft === normalizedRight;
      case '<':
        return (normalizedLeft as string | number) < (normalizedRight as string | number);
      case '>':
        return (normalizedLeft as string | number) > (normalizedRight as string | number);
      case 'in':
        return Array.isArray(normalizedRight) && normalizedRight.includes(normalizedLeft);
      default:
        throw new Error(`Unsupported test query operator: ${operator}`);
    }
  };
  const makeExpressionBuilder = (): ExpressionBuilder => {
    const eb = ((column: string, operator: string, value: unknown) => {
      return (row: Record<string, unknown>) =>
        compareValues(resolveColumn(row, column), operator, value);
    }) as ExpressionBuilder;
    eb.and = (predicates) => (row) => predicates.every((predicate) => predicate(row));
    eb.or = (predicates) => (row) => predicates.some((predicate) => predicate(row));
    return eb;
  };
  const selectRows = (rows: Record<string, unknown>[], columns?: string[]) => {
    if (!columns) return rows;
    return rows.map((row) => {
      const selected: Record<string, unknown> = {};
      for (const column of columns) {
        const match = column.match(/^(.+?)\s+as\s+(.+)$/i);
        const source = match?.[1] ?? column;
        const alias = match?.[2] ?? source.split('.').at(-1) ?? source;
        selected[alias] = resolveColumn(row, source);
      }
      return selected;
    });
  };
  const baseRows = (table: string) => {
    if (table !== 'webhook_deliveries') return [...(tables[table] ?? [])];
    return (tables.webhook_deliveries ?? []).flatMap((delivery) => {
      const event = (tables.webhook_events ?? []).find(
        (candidate) => candidate.id === delivery.event_id,
      );
      return event ? [{ __delivery: delivery, __event: event }] : [];
    });
  };

  return {
    selectFrom(table: string) {
      const predicates: QueryPredicate[] = [];
      const orderBy: Array<{ column: string; direction: 'asc' | 'desc' }> = [];
      let selectedColumns: string[] | undefined;
      let rowLimit: number | undefined;
      const query = {
        select(columns: string[]) {
          selectedColumns = columns;
          return query;
        },
        selectAll() {
          selectedColumns = undefined;
          return query;
        },
        innerJoin() {
          return query;
        },
        where(
          columnOrBuilder: string | ((eb: ExpressionBuilder) => QueryPredicate),
          operator?: string,
          value?: unknown,
        ) {
          if (typeof columnOrBuilder === 'function') {
            predicates.push(columnOrBuilder(makeExpressionBuilder()));
          } else if (operator) {
            predicates.push((row) =>
              compareValues(resolveColumn(row, columnOrBuilder), operator, value),
            );
          }
          return query;
        },
        orderBy(column: string, direction: 'asc' | 'desc') {
          orderBy.push({ column, direction });
          return query;
        },
        limit(limit: number) {
          rowLimit = limit;
          return query;
        },
        execute() {
          const rows = baseRows(table)
            .filter((row) => predicates.every((predicate) => predicate(row)))
            // eslint-disable-next-line unicorn/no-array-sort -- this is a fresh filtered array and sorting models SQL orderBy.
            .sort((left, right) => {
              for (const order of orderBy) {
                const leftValue = comparable(resolveColumn(left, order.column));
                const rightValue = comparable(resolveColumn(right, order.column));
                if (leftValue === rightValue) continue;
                const result =
                  (leftValue as string | number) < (rightValue as string | number) ? -1 : 1;
                return order.direction === 'asc' ? result : -result;
              }
              return 0;
            });
          const limitedRows = rowLimit === undefined ? rows : rows.slice(0, rowLimit);
          return Promise.resolve(selectRows(limitedRows, selectedColumns));
        },
        async executeTakeFirst() {
          const rows = await query.execute();
          return rows[0];
        },
      };
      return query;
    },
  };
}

function createWebhookEndpointListDb(rows: Record<string, unknown>[]) {
  return {
    selectFrom(table: string) {
      expect(table).toBe('webhook_endpoints');
      const query = {
        select(columns: string[]) {
          expect(columns).not.toContain('secret');
          return query;
        },
        selectAll() {
          throw new Error('Webhook endpoint list must not select secret material');
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        execute() {
          return Promise.resolve(rows);
        },
      };
      return query;
    },
  };
}

const scopedOAuthAppManagementMessage =
  'Scoped principals cannot manage organization-wide OAuth applications';

function createOAuthApplicationAccessGuardDb() {
  return {
    insertInto: vi.fn(() => {
      throw new Error('OAuth application insert must not run for scoped principals');
    }),
    selectFrom: vi.fn(() => {
      throw new Error('OAuth application select must not run for scoped principals');
    }),
    updateTable: vi.fn(() => {
      throw new Error('OAuth application update must not run for scoped principals');
    }),
  };
}

async function setupDeveloperRouteApp(principal: Principal, db: unknown) {
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
  await app.register(developerRoutes);
  return app;
}

async function setupWebhookRouteApp(principal: Principal, db: unknown) {
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
  await app.register(webhookRoutes);
  return app;
}

describe('developer routes integration', () => {
  it('lists API keys as a paginated public contract without secret material', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: createApiKeyListDb([
        {
          id: 'ak_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'Server key',
          key_prefix: 'tk_1234',
          hashed_key: 'must-not-leak',
          scopes: JSON.stringify(['events.read']),
          brand_ids: JSON.stringify(['brd_1']),
          event_ids: null,
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'ak_2',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'Next page',
          key_prefix: 'tk_5678',
          hashed_key: 'must-not-leak-either',
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: null,
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: new Date('2026-06-02T00:00:00Z'),
          updated_at: new Date('2026-06-02T00:00:00Z'),
        },
      ]) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({ method: 'GET', url: '/api-keys?limit=1' });
    const body = response.json() as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(response.statusCode).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('ak_1');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'ak_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      keyPrefix: 'tk_1234',
      scopes: ['events.read'],
      brandIds: ['brd_1'],
    });
    expect(body.items[0]).not.toHaveProperty('hashed_key');
    expect(body.items[0]).not.toHaveProperty('hashedKey');

    await app.close();
  });

  it('lists webhook endpoints without selecting or serializing secrets', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookEndpointListDb([
        {
          id: 'wh_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          url: 'https://example.com/webhooks',
          events: JSON.stringify(['order.paid']),
          status: 'active',
          description: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        },
      ]) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      temporalClient: {},
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const res = await app.inject({ method: 'GET', url: '/webhook-endpoints' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].secret).toBeUndefined();
    await app.close();
  });

  it('rejects invalid webhook endpoint event subscriptions before creating an endpoint', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const db = {
      insertInto: vi.fn(() => {
        throw new Error('Invalid webhook endpoint payload must not be persisted');
      }),
    };
    const app = await setupWebhookRouteApp(principal, db);

    const response = await app.inject({
      method: 'POST',
      url: '/webhook-endpoints',
      payload: {
        organizationId: 'org_1',
        url: 'https://hooks.example.com/tixkit',
        events: ['order.paidd'],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(db.insertInto).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects invalid webhook endpoint event subscription updates before loading the endpoint', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const db = {
      selectFrom: vi.fn(() => {
        throw new Error('Invalid webhook endpoint update must not load from the database');
      }),
      updateTable: vi.fn(() => {
        throw new Error('Invalid webhook endpoint update must not be persisted');
      }),
    };
    const app = await setupWebhookRouteApp(principal, db);

    const response = await app.inject({
      method: 'PATCH',
      url: '/webhook-endpoints/wh_1',
      payload: {
        events: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(db.updateTable).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks event-scoped API keys from minting unscoped API keys', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write', 'events.read'],
      eventIds: ['evt_1'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: {} as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: {
        organizationId: 'org_1',
        name: 'Escalated key',
        scopes: ['events.read'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Event-scoped principals must create event-scoped credentials',
    });

    await app.close();
  });

  it('blocks scoped principals from creating unscoped scanner devices', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
      brandIds: ['brd_1'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: {} as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: {
        organizationId: 'org_1',
        name: 'Unscoped scanner',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Scoped principals must bind scanner devices to explicit events',
    });

    await app.close();
  });

  it('blocks principals from minting scanner device scopes they do not hold before insert', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write', 'checkins.read'],
    };
    const db = {
      insertInto: vi.fn(() => {
        throw new Error('Scanner device insert must not run for scope escalation');
      }),
    };
    const app = await setupDeveloperRouteApp(principal, db);

    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: {
        organizationId: 'org_1',
        name: 'Escalated scanner',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Cannot grant scope the principal does not have: checkins.write',
    });
    expect(db.insertInto).not.toHaveBeenCalled();

    await app.close();
  });

  it('creates read-only scanner credentials that authenticate without write scope', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write', 'checkins.read'],
    };
    const { db, tables } = createScannerDeviceLifecycleDb();
    const app = await setupDeveloperRouteApp(principal, db);

    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: {
        organizationId: 'org_1',
        name: 'Read-only gate scanner',
        scopes: ['checkins.read'],
      },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json() as { deviceId: string; secret: string; scopes: string[] };
    expect(created.scopes).toEqual(['checkins.read']);
    expect(tables.scanner_devices[0]).toMatchObject({
      organization_id: 'org_1',
      scopes: JSON.stringify(['checkins.read']),
      status: 'active',
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateScannerDevice({
      headers: {
        'x-device-id': created.deviceId,
        'x-device-secret': created.secret,
      },
    } as never);

    expect(result.principal).toMatchObject({
      type: 'mobile_device',
      id: created.deviceId,
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.read'],
    });
    expect(result.principal.scopes).not.toContain('checkins.write');

    await app.close();
  });

  it('blocks event-scoped principals from creating organization-wide OAuth applications before insert', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
      eventIds: ['evt_1'],
    };
    const db = createOAuthApplicationAccessGuardDb();
    const app = await setupDeveloperRouteApp(principal, db);

    const response = await app.inject({
      method: 'POST',
      url: '/oauth-applications',
      payload: {
        organizationId: 'org_1',
        name: 'Scoped OAuth app',
        redirectUris: ['https://example.com/oauth/callback'],
        scopes: ['events.read'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: scopedOAuthAppManagementMessage,
    });
    expect(db.insertInto).not.toHaveBeenCalled();

    await app.close();
  });

  it('blocks brand-scoped principals from listing organization-wide OAuth applications before exposure', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
      brandIds: ['brd_1'],
    };
    const db = createOAuthApplicationAccessGuardDb();
    const app = await setupDeveloperRouteApp(principal, db);

    const response = await app.inject({ method: 'GET', url: '/oauth-applications' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: scopedOAuthAppManagementMessage,
    });
    expect(db.selectFrom).not.toHaveBeenCalled();

    await app.close();
  });

  it('blocks scoped principals from revoking organization-wide OAuth applications before update', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
      eventIds: ['evt_1'],
    };
    const db = createOAuthApplicationAccessGuardDb();
    const app = await setupDeveloperRouteApp(principal, db);

    const response = await app.inject({
      method: 'DELETE',
      url: '/oauth-applications/oapp_1',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: scopedOAuthAppManagementMessage,
    });
    expect(db.updateTable).not.toHaveBeenCalled();

    await app.close();
  });

  it('paginates webhook delivery events in newest-first delivery order', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const endpointCreatedAt = new Date('2026-06-01T00:00:00Z');
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_events: [
          {
            id: 'whe_z_new',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_new' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:01Z'),
          },
          {
            id: 'whe_a_middle',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_middle' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:02Z'),
          },
          {
            id: 'whe_m_old',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_old' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:03Z'),
          },
          {
            id: 'whe_b_oldest',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_oldest' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:04Z'),
          },
          {
            id: 'whe_wrong_requested_endpoint',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_wrong_requested_endpoint' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:05Z'),
          },
        ],
        webhook_endpoints: [
          {
            id: 'wh_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://example.com/webhooks',
            secret: 'secret',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: endpointCreatedAt,
            updated_at: endpointCreatedAt,
          },
        ],
        webhook_deliveries: [
          {
            id: 'whd_1',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_z_new',
            status: 'delivered',
            status_code: 200,
            attempt: 1,
            delivered_at: new Date('2026-06-01T00:10:10Z'),
            created_at: new Date('2026-06-01T00:10:00Z'),
          },
          {
            id: 'whd_2',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_1',
            delivery_key: 'replay:rpl_1',
            event_id: 'whe_z_new',
            status: 'failed',
            status_code: 502,
            attempt: 1,
            delivered_at: new Date('2026-06-01T00:10:30Z'),
            created_at: new Date('2026-06-01T00:10:30Z'),
          },
          {
            id: 'whd_3',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_a_middle',
            status: 'failed',
            status_code: 500,
            attempt: 2,
            delivered_at: new Date('2026-06-01T00:09:10Z'),
            created_at: new Date('2026-06-01T00:09:00Z'),
          },
          {
            id: 'whd_4',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_m_old',
            status: 'pending',
            status_code: null,
            attempt: 1,
            delivered_at: null,
            created_at: new Date('2026-06-01T00:09:00Z'),
          },
          {
            id: 'whd_5',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_b_oldest',
            status: 'pending',
            status_code: null,
            attempt: 1,
            delivered_at: null,
            created_at: new Date('2026-06-01T00:08:00Z'),
          },
          {
            id: 'whd_wrong_requested_endpoint',
            endpoint_id: 'wh_1',
            requested_endpoint_id: 'wh_2',
            delivery_key: 'live',
            event_id: 'whe_wrong_requested_endpoint',
            status: 'pending',
            status_code: null,
            attempt: 1,
            delivered_at: null,
            created_at: new Date('2026-06-01T00:11:00Z'),
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const returnedItems: Array<{
      id: string;
      eventId: string;
      deliveryId: string;
      endpointId: string | null;
      requestedEndpointId: string;
      deliveryKey: string;
      eventType: string;
      status: string;
      statusCode?: number;
      attemptCount: number;
      deliveredAt?: string;
      createdAt: string;
    }> = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- cursor pagination must request each page after reading the previous cursor.
      const response = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/wh_1/events?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      });
      const body = response.json() as {
        items: Array<(typeof returnedItems)[number]>;
        nextCursor: string | null;
        hasMore: boolean;
      };

      expect(response.statusCode).toBe(200);
      expect(body.items).toHaveLength(1);
      returnedItems.push(body.items[0]);
      if (body.nextCursor) cursors.push(body.nextCursor);
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }

    const returnedIds = returnedItems.map((item) => item.id);
    const returnedEventIds = returnedItems.map((item) => item.eventId);
    const returnedDeliveryIds = returnedItems.map((item) => item.deliveryId);
    expect(returnedIds).toEqual([
      'whe_z_new',
      'whe_z_new',
      'whe_m_old',
      'whe_a_middle',
      'whe_b_oldest',
    ]);
    expect(returnedEventIds).toEqual(returnedIds);
    expect(returnedDeliveryIds).toEqual(['whd_2', 'whd_1', 'whd_4', 'whd_3', 'whd_5']);
    expect(new Set(returnedDeliveryIds).size).toBe(5);
    expect(cursors).toHaveLength(4);
    expect(cursors.some((value) => returnedDeliveryIds.includes(value))).toBe(false);
    expect(returnedItems).toEqual([
      {
        id: 'whe_z_new',
        eventId: 'whe_z_new',
        deliveryId: 'whd_2',
        endpointId: 'wh_1',
        requestedEndpointId: 'wh_1',
        deliveryKey: 'replay:rpl_1',
        eventType: 'order.paid',
        status: 'failed',
        statusCode: 502,
        attemptCount: 1,
        deliveredAt: '2026-06-01T00:10:30.000Z',
        createdAt: '2026-06-01T00:10:30.000Z',
      },
      {
        id: 'whe_z_new',
        eventId: 'whe_z_new',
        deliveryId: 'whd_1',
        endpointId: 'wh_1',
        requestedEndpointId: 'wh_1',
        deliveryKey: 'live',
        eventType: 'order.paid',
        status: 'delivered',
        statusCode: 200,
        attemptCount: 1,
        deliveredAt: '2026-06-01T00:10:10.000Z',
        createdAt: '2026-06-01T00:10:00.000Z',
      },
      {
        id: 'whe_m_old',
        eventId: 'whe_m_old',
        deliveryId: 'whd_4',
        endpointId: 'wh_1',
        requestedEndpointId: 'wh_1',
        deliveryKey: 'live',
        eventType: 'order.paid',
        status: 'pending',
        attemptCount: 1,
        createdAt: '2026-06-01T00:09:00.000Z',
      },
      {
        id: 'whe_a_middle',
        eventId: 'whe_a_middle',
        deliveryId: 'whd_3',
        endpointId: 'wh_1',
        requestedEndpointId: 'wh_1',
        deliveryKey: 'live',
        eventType: 'order.paid',
        status: 'failed',
        statusCode: 500,
        attemptCount: 2,
        deliveredAt: '2026-06-01T00:09:10.000Z',
        createdAt: '2026-06-01T00:09:00.000Z',
      },
      {
        id: 'whe_b_oldest',
        eventId: 'whe_b_oldest',
        deliveryId: 'whd_5',
        endpointId: 'wh_1',
        requestedEndpointId: 'wh_1',
        deliveryKey: 'live',
        eventType: 'order.paid',
        status: 'pending',
        attemptCount: 1,
        createdAt: '2026-06-01T00:08:00.000Z',
      },
    ]);
    expect(cursor).toBeNull();

    await app.close();
  });

  it('returns missing-endpoint dead letters by requested endpoint id', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_events: [
          {
            id: 'whe_missing_endpoint',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_missing_endpoint' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:01Z'),
          },
          {
            id: 'whe_other_org',
            tenant_id: 'tnt_1',
            organization_id: 'org_other',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_other' }),
            status: 'pending',
            created_at: new Date('2026-06-01T00:00:02Z'),
          },
        ],
        webhook_endpoints: [],
        webhook_deliveries: [
          {
            id: 'whd_missing',
            endpoint_id: null,
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_missing_endpoint',
            status: 'dead_lettered',
            status_code: null,
            attempt: 1,
            delivered_at: null,
            created_at: new Date('2026-06-01T00:10:00Z'),
          },
          {
            id: 'whd_other_org',
            endpoint_id: null,
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_other_org',
            status: 'dead_lettered',
            status_code: null,
            attempt: 1,
            delivered_at: null,
            created_at: new Date('2026-06-01T00:11:00Z'),
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/webhook-endpoints/wh_1/events?limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          id: 'whe_missing_endpoint',
          eventId: 'whe_missing_endpoint',
          deliveryId: 'whd_missing',
          endpointId: null,
          requestedEndpointId: 'wh_1',
          deliveryKey: 'live',
          eventType: 'order.paid',
          status: 'dead_lettered',
          attemptCount: 1,
          createdAt: '2026-06-01T00:10:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
    });

    await app.close();
  });

  it('returns queued true when replaying a webhook event', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const startWebhookDelivery = vi.fn(async () => undefined);
    const createdAt = new Date('2026-06-01T00:00:00Z');
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_events: [
          {
            id: 'whe_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_1' }),
            status: 'pending',
            created_at: createdAt,
          },
        ],
        webhook_endpoints: [
          {
            id: 'wh_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://example.com/webhooks',
            secret: 'secret',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: { startWebhookDelivery },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const response = await app.inject({ method: 'POST', url: '/webhook-events/whe_1/replay' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ queued: true, eventId: 'whe_1', endpoints: 1 });
    expect(startWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(startWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        apiVersion: '2026-01-01',
        endpointId: 'wh_1',
        eventId: 'whe_1',
        eventType: 'order.paid',
        maxAttempts: 5,
        payload: { orderId: 'ord_1' },
        replayNonce: expect.any(String),
      }),
    );
    const [replayInput] = startWebhookDelivery.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(replayInput).not.toHaveProperty('secret');

    await app.close();
  });

  it('queues only the requested endpoint for endpoint-scoped webhook replay', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const startWebhookDelivery = vi.fn(async () => undefined);
    const createdAt = new Date('2026-06-01T00:00:00Z');
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_events: [
          {
            id: 'whe_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_1' }),
            status: 'pending',
            created_at: createdAt,
          },
        ],
        webhook_endpoints: [
          {
            id: 'wh_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://primary.example.com/webhooks',
            secret: 'secret_1',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
          {
            id: 'wh_2',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://secondary.example.com/webhooks',
            secret: 'secret_2',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
        webhook_deliveries: [
          {
            id: 'whd_dead_lettered',
            endpoint_id: null,
            requested_endpoint_id: 'wh_1',
            delivery_key: 'live',
            event_id: 'whe_1',
            attempt: 3,
            status_code: 500,
            response: 'gone',
            status: 'dead_lettered',
            delivered_at: null,
            next_retry_at: null,
            created_at: new Date('2026-06-01T00:10:00Z'),
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: { startWebhookDelivery },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/webhook-endpoints/wh_1/events/whe_1/replay',
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ queued: true, eventId: 'whe_1', endpointId: 'wh_1' });
    expect(startWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(startWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        apiVersion: '2026-01-01',
        endpointId: 'wh_1',
        eventId: 'whe_1',
        eventType: 'order.paid',
        maxAttempts: 5,
        payload: { orderId: 'ord_1' },
        replayNonce: expect.any(String),
      }),
    );

    await app.close();
  });
});
