import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../../app.js';
import { registerErrorHandler, registerJsonBodyParser } from '../../app.js';
import { publicRoutes } from '../../routes/modules/public.js';

type Row = Record<string, unknown>;
type WhereClause = { column: string; op: string; value: unknown };

function matches(row: Row, wheres: WhereClause[]): boolean {
  return wheres.every((where) => {
    const actual = row[where.column];
    if (where.op === '=') return actual === where.value;
    if (where.op === 'in') return Array.isArray(where.value) && where.value.includes(actual);
    return true;
  });
}

function createQuery(table: string, tables: Record<string, Row[]>) {
  const wheres: WhereClause[] = [];
  const query = {
    selectAll() {
      return query;
    },
    select() {
      return query;
    },
    where(column: string, op: string, value: unknown) {
      wheres.push({ column, op, value });
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    async execute() {
      return (tables[table] ?? []).filter((row) => matches(row, wheres));
    },
    async executeTakeFirst() {
      return (tables[table] ?? []).find((row) => matches(row, wheres));
    },
  };
  return query;
}

function createMockDb(tables: Record<string, Row[]>): Database {
  return {
    selectFrom(table: string) {
      return createQuery(table, tables);
    },
  } as unknown as Database;
}

function eventRow(id: string): Row {
  return {
    id,
    tenant_id: `tnt_${id}`,
    organization_id: `org_${id}`,
    brand_id: `brd_${id}`,
    slug: id,
    title: `Event ${id}`,
    status: 'published',
    visibility: 'public',
    timezone: 'UTC',
    starts_at: new Date('2026-06-01T00:00:00.000Z'),
    ends_at: null,
    seo: '{}',
    capacity: null,
    description: null,
    venue: null,
    cover_image_url: null,
    external_url: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function ticketTypeRow(id: string, eventId: string): Row {
  return {
    id,
    tenant_id: `tnt_${eventId}`,
    event_id: eventId,
    name: `Ticket ${id}`,
    status: 'active',
    type: 'paid',
    price_cents: 1000,
    currency: 'USD',
    capacity: 100,
    sold_count: 0,
    sort_order: 0,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function accessRuleRow(ticketTypeId: string, value: string): Row {
  return {
    id: `acr_${ticketTypeId}`,
    ticket_type_id: ticketTypeId,
    type: 'access_code',
    value,
    max_uses: null,
    uses_count: 0,
    expires_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

async function buildRateLimitedPublicApp() {
  const app = Fastify({ logger: false, trustProxy: true });
  const db = createMockDb({
    events: [eventRow('evt_alpha'), eventRow('evt_beta')],
    ticket_types: [ticketTypeRow('tt_alpha', 'evt_alpha'), ticketTypeRow('tt_beta', 'evt_beta')],
    access_rules: [accessRuleRow('tt_alpha', 'ALPHA'), accessRuleRow('tt_beta', 'BETA')],
  });

  app.decorate('context', {
    db,
    inventoryService: {},
    pricingEngine: {},
    qrService: {},
    authService: {},
    temporalClient: {},
    emailTransport: {},
    smsTransport: {},
  } as AppContext);

  registerErrorHandler(app);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  registerJsonBodyParser(app);
  await app.register(publicRoutes);
  await app.ready();
  return app;
}

function accessCodePayload(ticketTypeId: string, accessCode: string) {
  return {
    ticketTypeIds: [ticketTypeId],
    accessCode,
  };
}

describe('public access-code abuse rate limiting', () => {
  let apps: Array<Awaited<ReturnType<typeof buildRateLimitedPublicApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()));
    apps = [];
  });

  it('isolates brute-force buckets by event under burst load', async () => {
    const app = await buildRateLimitedPublicApp();
    apps.push(app);

    const firstInvalidResponse = await app.inject({
      method: 'POST',
      url: '/public/events/evt_alpha/access-code',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: accessCodePayload('tt_alpha', 'WRONG-WARMUP'),
    });

    const abuseStatuses = await Promise.all(
      Array.from({ length: 11 }, async (_, attempt) => {
        const response = await app.inject({
          method: 'POST',
          url: '/public/events/evt_alpha/access-code',
          headers: { 'x-forwarded-for': '203.0.113.10' },
          payload: accessCodePayload('tt_alpha', `WRONG-${attempt}`),
        });
        return response.statusCode;
      }),
    );

    const otherEventResponse = await app.inject({
      method: 'POST',
      url: '/public/events/evt_beta/access-code',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: accessCodePayload('tt_beta', 'WRONG-SAME-IP'),
    });

    const blockedAlphaResponse = await app.inject({
      method: 'POST',
      url: '/public/events/evt_alpha/access-code',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: accessCodePayload('tt_alpha', 'ALPHA'),
    });

    expect(firstInvalidResponse.statusCode).toBe(400);
    expect(abuseStatuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(1);
    expect(otherEventResponse.statusCode).toBe(400);
    expect(blockedAlphaResponse.statusCode).toBe(429);
  });

  it('isolates brute-force buckets by requester for the same event', async () => {
    const app = await buildRateLimitedPublicApp();
    apps.push(app);

    const firstInvalidResponse = await app.inject({
      method: 'POST',
      url: '/public/events/evt_alpha/access-code',
      headers: { 'x-forwarded-for': '203.0.113.20' },
      payload: accessCodePayload('tt_alpha', 'MISS-WARMUP'),
    });

    const abusiveRequesterStatuses = await Promise.all(
      Array.from({ length: 11 }, async (_, attempt) => {
        const response = await app.inject({
          method: 'POST',
          url: '/public/events/evt_alpha/access-code',
          headers: { 'x-forwarded-for': '203.0.113.20' },
          payload: accessCodePayload('tt_alpha', `MISS-${attempt}`),
        });
        return response.statusCode;
      }),
    );

    const separateRequesterResponse = await app.inject({
      method: 'POST',
      url: '/public/events/evt_alpha/access-code',
      headers: { 'x-forwarded-for': '203.0.113.21' },
      payload: accessCodePayload('tt_alpha', 'MISS-SEPARATE-REQUESTER'),
    });

    expect(firstInvalidResponse.statusCode).toBe(400);
    expect(
      abusiveRequesterStatuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(1);
    expect(separateRequesterResponse.statusCode).toBe(400);
  });
});
