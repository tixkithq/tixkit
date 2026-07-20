import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { eventRoutes } from '../../routes/modules/events.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('saved venue route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let checkpoint: AppContext['savedVenueCheckpoint'];

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_venue_a_${suffix}`;
  const tenantB = `tnt_venue_b_${suffix}`;
  const organizationA = `org_venue_a_${suffix}`;
  const organizationAScoped = `org_venue_scope_${suffix}`;
  const organizationB = `org_venue_b_${suffix}`;
  const venueA = `ven_auth_a_${suffix}`;
  const venueAScoped = `ven_auth_scope_${suffix}`;
  const venueB = `ven_auth_b_${suffix}`;
  const idempotencyPrefix = `venue-auth-${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: `usr_venue_${suffix}`,
    tenantId: tenantA,
    organizationIds: [organizationA, organizationB],
    scopes: ['events.read', 'events.write'],
  };

  async function insertTenant(id: string): Promise<void> {
    const now = new Date();
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

  async function insertOrganization(id: string, tenantId: string): Promise<void> {
    const now = new Date();
    await db
      .insertInto('organizations')
      .values({
        id,
        tenant_id: tenantId,
        name: id,
        slug: `${id}-slug`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        event_defaults: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function upsertVenue(id: string, tenantId: string, organizationId: string): Promise<void> {
    const now = new Date();
    await db.deleteFrom('venues').where('id', '=', id).execute();
    await db
      .insertInto('venues')
      .values({
        id,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: id,
        address: JSON.stringify({ city: 'Chicago', country: 'US' }),
        timezone: 'America/Chicago',
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function snapshot() {
    const [venues, audits, idempotencyRecords] = await Promise.all([
      db
        .selectFrom('venues')
        .select(['id', 'tenant_id', 'organization_id', 'name', 'address', 'timezone'])
        .where('tenant_id', 'in', [tenantA, tenantB])
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['action', 'actor_id', 'resource_id', 'diff_summary'])
        .where('tenant_id', '=', tenantA)
        .where('resource_type', '=', 'SavedVenue')
        .orderBy('id')
        .execute(),
      db
        .selectFrom('idempotency_records')
        .select(['key', 'request_hash', 'response_status'])
        .where('tenant_id', '=', tenantA)
        .orderBy('key')
        .execute(),
    ]);
    return { venues, audits, idempotencyRecords };
  }

  const venuePayload = (organizationId: string, name = 'Authorized venue') => ({
    organizationId,
    name,
    address: { city: 'Chicago', region: 'IL', country: 'US' },
    timezone: 'America/Chicago',
  });

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    await insertTenant(tenantA);
    await insertTenant(tenantB);
    await insertOrganization(organizationA, tenantA);
    await insertOrganization(organizationAScoped, tenantA);
    await insertOrganization(organizationB, tenantB);
    await upsertVenue(venueA, tenantA, organizationA);
    await upsertVenue(venueAScoped, tenantA, organizationAScoped);
    await upsertVenue(venueB, tenantB, organizationB);
    principal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      savedVenueCheckpoint: (
        input: Parameters<NonNullable<AppContext['savedVenueCheckpoint']>>[0],
      ) => checkpoint?.(input),
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = basePrincipal;
    checkpoint = undefined;
    await db
      .deleteFrom('audit_logs')
      .where('tenant_id', '=', tenantA)
      .where('resource_type', '=', 'SavedVenue')
      .execute();
    await db.deleteFrom('idempotency_records').where('tenant_id', '=', tenantA).execute();
    await db
      .deleteFrom('venues')
      .where('tenant_id', '=', tenantA)
      .where('id', 'not in', [venueA, venueAScoped])
      .execute();
    await upsertVenue(venueA, tenantA, organizationA);
    await upsertVenue(venueAScoped, tenantA, organizationAScoped);
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
      await attempt(() =>
        db.deleteFrom('audit_logs').where('tenant_id', 'in', [tenantA, tenantB]).execute(),
      );
      await attempt(() =>
        db.deleteFrom('idempotency_records').where('tenant_id', 'in', [tenantA, tenantB]).execute(),
      );
      await attempt(() =>
        db.deleteFrom('venues').where('tenant_id', 'in', [tenantA, tenantB]).execute(),
      );
      for (const id of [organizationA, organizationAScoped, organizationB]) {
        await attempt(() => db.deleteFrom('organizations').where('id', '=', id).execute());
      }
      for (const id of [tenantA, tenantB]) {
        await attempt(() => db.deleteFrom('tenants').where('id', '=', id).execute());
      }
      await attempt(() => db.destroy());
    }
    restoreDatabaseDriver(previousDriver);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to clean saved venue fixtures');
  });

  it('lists only venues in the requested tenant and organization scope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/venues?organizationId=${organizationA}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().map((venue: { id: string }) => venue.id)).toEqual([venueA]);
    expect(response.body).not.toContain(venueAScoped);
    expect(response.body).not.toContain(venueB);
  });

  it('denies all four operations without permission and produces zero side effects', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, scopes: [] };
    const requests = [
      {
        method: 'GET' as const,
        url: `/venues?organizationId=${organizationA}`,
      },
      {
        method: 'POST' as const,
        url: '/venues',
        headers: { 'idempotency-key': `${idempotencyPrefix}-permission` },
        payload: venuePayload(organizationA),
      },
      {
        method: 'PATCH' as const,
        url: `/venues/${venueA}`,
        payload: { name: 'Denied' },
      },
      { method: 'DELETE' as const, url: `/venues/${venueA}` },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('returns no rows for a cross-tenant selector and conceals cross-tenant write resources', async () => {
    const before = await snapshot();
    const listResponse = await app.inject({
      method: 'GET',
      url: `/venues?organizationId=${organizationB}`,
    });
    expect(listResponse.statusCode, listResponse.body).toBe(200);
    expect(listResponse.json()).toEqual([]);
    const requests = [
      {
        method: 'POST' as const,
        url: '/venues',
        headers: { 'idempotency-key': `${idempotencyPrefix}-foreign` },
        payload: venuePayload(organizationB),
      },
      {
        method: 'PATCH' as const,
        url: `/venues/${venueB}`,
        payload: { name: 'Denied' },
      },
      { method: 'DELETE' as const, url: `/venues/${venueB}` },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('denies unscoped same-tenant organization access with zero side effects', async () => {
    const before = await snapshot();
    const requests = [
      {
        method: 'GET' as const,
        url: `/venues?organizationId=${organizationAScoped}`,
      },
      {
        method: 'POST' as const,
        url: '/venues',
        headers: { 'idempotency-key': `${idempotencyPrefix}-scope` },
        payload: venuePayload(organizationAScoped),
      },
      {
        method: 'PATCH' as const,
        url: `/venues/${venueAScoped}`,
        payload: { name: 'Denied' },
      },
      { method: 'DELETE' as const, url: `/venues/${venueAScoped}` },
    ];
    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it('creates once under concurrent replay, scopes raw keys by principal, and audits exactly once per venue', async () => {
    const key = `${idempotencyPrefix}-concurrent`;
    const request = {
      method: 'POST' as const,
      url: '/venues',
      headers: { 'idempotency-key': key },
      payload: venuePayload(organizationA),
    };
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json().id).toBe(second.json().id);

    principal = { ...basePrincipal, id: `${basePrincipal.id}_peer` };
    const peer = await app.inject(request);
    expect(peer.statusCode, peer.body).toBe(201);
    expect(peer.json().id).not.toBe(first.json().id);

    const state = await snapshot();
    expect(state.idempotencyRecords).toHaveLength(2);
    expect(state.audits).toHaveLength(2);
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'saved_venue.created',
      'saved_venue.created',
    ]);
  });

  it('rejects changed idempotent payloads and rolls back venue plus idempotency when audit-stage work fails', async () => {
    const key = `${idempotencyPrefix}-conflict`;
    const first = await app.inject({
      method: 'POST',
      url: '/venues',
      headers: { 'idempotency-key': key },
      payload: venuePayload(organizationA, 'First'),
    });
    expect(first.statusCode, first.body).toBe(201);
    const conflict = await app.inject({
      method: 'POST',
      url: '/venues',
      headers: { 'idempotency-key': key },
      payload: venuePayload(organizationA, 'Changed'),
    });
    expect(conflict.statusCode, conflict.body).toBe(409);

    const beforeFailure = await snapshot();
    checkpoint = ({ stage, operation }) => {
      if (stage === 'before_audit' && operation === 'create') throw new Error('audit unavailable');
    };
    const failed = await app.inject({
      method: 'POST',
      url: '/venues',
      headers: { 'idempotency-key': `${idempotencyPrefix}-rollback` },
      payload: venuePayload(organizationA, 'Rollback'),
    });
    expect(failed.statusCode).toBe(500);
    expect(await snapshot()).toEqual(beforeFailure);
  });

  it('updates and deletes under a lock with atomic privacy-safe audits', async () => {
    const updated = await app.inject({
      method: 'PATCH',
      url: `/venues/${venueA}`,
      payload: {
        name: 'Updated venue',
        address: { city: 'Evanston', country: 'US' },
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      id: venueA,
      name: 'Updated venue',
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/venues/${venueA}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    const state = await snapshot();
    expect(state.venues.some((venue) => venue.id === venueA)).toBe(false);
    expect(state.audits.map((audit) => audit.action)).toEqual([
      'saved_venue.updated',
      'saved_venue.deleted',
    ]);
    expect(JSON.stringify(state.audits)).not.toContain('Evanston');
  });

  it('returns NOT_FOUND rather than a fabricated success when a venue disappears before the lock', async () => {
    checkpoint = async ({ stage, operation, venueId }) => {
      if (stage === 'before_transaction' && operation === 'update' && venueId === venueA) {
        await db.deleteFrom('venues').where('id', '=', venueA).execute();
      }
    };
    const response = await app.inject({
      method: 'PATCH',
      url: `/venues/${venueA}`,
      payload: { name: 'Must not succeed' },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect((await snapshot()).audits).toEqual([]);
  });
});
