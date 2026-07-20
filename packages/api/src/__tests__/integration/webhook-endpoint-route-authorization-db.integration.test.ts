import {
  AuditLogRepository,
  createDb,
  OrganizationRepository,
  TenantRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
  WebhookEventRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';
import { hashRequest } from '../../services/idempotency.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { WEBHOOK_ENDPOINT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const suffix = ulid().slice(-10).toLowerCase();
const actorId = `usr_whe_auth_${suffix}`;
let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let tenantA: string;
let tenantB: string;
let organizationA: string;
let organizationASibling: string;
let organizationB: string;
let endpointA: string;
let endpointB: string;
let endpointMismatchedTenantOrganization: string;
let eventA: string;
let retainedMismatchedEndpointId: string;
let createRequestSequence = 0;

const checkpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; operation: 'update'; endpointId: string }) =>
    undefined,
);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA],
    scopes: ['developers.write'],
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function scopedCreateIdempotencyKey(rawKey: string, actor = activePrincipal): string {
  return hashRequest({
    operation: 'webhook_endpoint.create',
    principal: { type: actor.type, id: actor.id },
    key: rawKey,
  });
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function storedEvents(value: unknown): string[] {
  return (typeof value === 'string' ? JSON.parse(value) : value) as string[];
}

async function managementSnapshot() {
  const [endpoints, audits] = await Promise.all([
    db
      .selectFrom('webhook_endpoints')
      .select(['id', 'tenant_id', 'organization_id', 'url', 'events', 'status', 'description'])
      .where('id', 'in', [endpointA, endpointB, endpointMismatchedTenantOrganization])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .select([
        'tenant_id',
        'organization_id',
        'actor_id',
        'action',
        'resource_type',
        'resource_id',
        'diff_summary',
      ])
      .where('actor_id', '=', actorId)
      .where('resource_type', '=', 'WebhookEndpoint')
      .orderBy('id')
      .execute(),
  ]);
  return { endpoints, audits };
}

async function endpointCountForOrganization(organizationId: string): Promise<number> {
  const row = await db
    .selectFrom('webhook_endpoints')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function clearFixture(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('tenant_id', 'in', [tenantA, tenantB])
    .where('resource_type', '=', 'WebhookEndpoint')
    .execute();
  const events = await db
    .selectFrom('webhook_events')
    .select('id')
    .where('tenant_id', 'in', [tenantA, tenantB])
    .execute();
  if (events.length > 0) {
    await db
      .deleteFrom('webhook_deliveries')
      .where(
        'event_id',
        'in',
        events.map((event) => event.id),
      )
      .execute();
    await db
      .deleteFrom('webhook_events')
      .where(
        'id',
        'in',
        events.map((event) => event.id),
      )
      .execute();
  }
  await db.deleteFrom('webhook_endpoints').where('tenant_id', 'in', [tenantA, tenantB]).execute();
  await db.deleteFrom('idempotency_records').where('tenant_id', 'in', [tenantA, tenantB]).execute();
}

async function seedFixture(): Promise<void> {
  const endpointAllowed = await new WebhookEndpointRepository(db).create({
    tenantId: tenantA,
    organizationId: organizationA,
    url: 'https://allowed-webhook.example.test/original',
    events: ['order.paid'],
    description: 'Allowed endpoint',
  });
  const endpointForeign = await new WebhookEndpointRepository(db).create({
    tenantId: tenantB,
    organizationId: organizationB,
    url: 'https://foreign-webhook.example.test/original',
    events: ['order.paid'],
    description: 'Foreign endpoint',
  });
  const endpointMismatched = await new WebhookEndpointRepository(db).create({
    tenantId: tenantA,
    organizationId: organizationB,
    url: 'https://mismatched-webhook.example.test/original',
    events: ['order.paid'],
    description: 'Mismatched endpoint',
  });
  const event = await new WebhookEventRepository(db).create({
    tenantId: tenantA,
    organizationId: organizationA,
    type: 'order.paid',
    payload: { orderId: `ord_whe_auth_${suffix}` },
  });
  await new WebhookDeliveryRepository(db).create({
    endpointId: endpointAllowed.id,
    eventId: event.id,
    attempt: 1,
    status: 'delivered',
    statusCode: 200,
    deliveredAt: new Date('2026-07-20T12:00:00.000Z'),
  });
  const mismatchedEvent = await new WebhookEventRepository(db).create({
    tenantId: tenantA,
    organizationId: organizationB,
    type: 'order.paid',
    payload: { orderId: `ord_whe_mismatched_${suffix}` },
  });
  retainedMismatchedEndpointId = `wh_retained_mismatch_${suffix}`;
  await new WebhookDeliveryRepository(db).create({
    endpointId: null,
    requestedEndpointId: retainedMismatchedEndpointId,
    eventId: mismatchedEvent.id,
    attempt: 1,
    status: 'delivered',
    statusCode: 200,
    deliveredAt: new Date('2026-07-20T12:00:00.000Z'),
  });
  endpointA = endpointAllowed.id;
  endpointB = endpointForeign.id;
  endpointMismatchedTenantOrganization = endpointMismatched.id;
  eventA = event.id;
}

function createEndpoint(
  organizationId = organizationA,
  options: {
    idempotencyKey?: string | null;
    payload?: Partial<{ description: string; events: string[]; url: string }>;
  } = {},
) {
  createRequestSequence += 1;
  const idempotencyKey =
    options.idempotencyKey === undefined
      ? `webhook-endpoint-create-${suffix}-${createRequestSequence}`
      : options.idempotencyKey;
  return app.inject({
    method: 'POST',
    url: '/webhook-endpoints',
    ...(idempotencyKey === null ? {} : { headers: { 'idempotency-key': idempotencyKey } }),
    payload: {
      organizationId,
      url:
        options.payload?.url ??
        'https://created-webhook.example.test/orders?credential=never-audit-this',
      events: options.payload?.events ?? ['order.paid', 'order.refunded'],
      description: options.payload?.description ?? 'Created endpoint description',
    },
  });
}

function updateEndpoint(
  endpointId = endpointA,
  payload: Partial<{
    description: string;
    events: string[];
    status: 'active' | 'disabled';
    url: string;
  }> = {},
) {
  return app.inject({
    method: 'PATCH',
    url: `/webhook-endpoints/${endpointId}`,
    payload: {
      url:
        payload.url ??
        'https://updated-webhook.example.test/orders?credential=never-audit-this-either',
      events: payload.events ?? ['order.refunded'],
      status: payload.status ?? 'disabled',
      description: payload.description ?? 'Updated endpoint description',
    },
  });
}

describeWithIntegrationDatabase('webhook endpoint management route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const createdTenantA = await new TenantRepository(db).create({
      name: `Webhook endpoint authorization A ${suffix}`,
    });
    const createdTenantB = await new TenantRepository(db).create({
      name: `Webhook endpoint authorization B ${suffix}`,
    });
    tenantA = createdTenantA.id;
    tenantB = createdTenantB.id;
    organizationA = (
      await new OrganizationRepository(db).create({
        tenantId: tenantA,
        name: `Webhook endpoint allowed ${suffix}`,
        slug: `webhook-endpoint-allowed-${suffix}`,
      })
    ).id;
    organizationASibling = (
      await new OrganizationRepository(db).create({
        tenantId: tenantA,
        name: `Webhook endpoint sibling ${suffix}`,
        slug: `webhook-endpoint-sibling-${suffix}`,
      })
    ).id;
    organizationB = (
      await new OrganizationRepository(db).create({
        tenantId: tenantB,
        name: `Webhook endpoint foreign ${suffix}`,
        slug: `webhook-endpoint-foreign-${suffix}`,
      })
    ).id;

    app = Fastify();
    app.decorate('context', {
      db,
      webhookEndpointCheckpoint: checkpoint,
    } as unknown as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(webhookRoutes);
  });

  beforeEach(async () => {
    activePrincipal = principal();
    checkpoint.mockReset();
    await clearFixture();
    await seedFixture();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await clearFixture();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationASibling, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  describe('POST /webhook-endpoints', () => {
    it('tenant-authorizes the organization and commits the endpoint with a hash-only audit', async () => {
      const beforeCount = await endpointCountForOrganization(organizationA);
      const response = await createEndpoint();
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        organizationId: organizationA,
        url: 'https://created-webhook.example.test/orders?credential=never-audit-this',
        events: ['order.paid', 'order.refunded'],
        status: 'active',
      });
      expect(typeof body.secret).toBe('string');
      await expect(endpointCountForOrganization(organizationA)).resolves.toBe(beforeCount + 1);

      const audit = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', actorId)
        .where('resource_id', '=', body.id)
        .executeTakeFirstOrThrow();
      expect(audit).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        action: 'webhook_endpoint.created',
        resource_type: 'WebhookEndpoint',
      });
      expect(auditDiff(audit.diff_summary)).toEqual({
        after: {
          urlSha256: sha256(body.url),
          events: ['order.paid', 'order.refunded'],
          status: 'active',
          descriptionSha256: sha256('Created endpoint description'),
        },
      });
      expect(JSON.stringify(audit)).not.toContain(body.url);
      expect(JSON.stringify(audit)).not.toContain(body.secret);
      expect(JSON.stringify(audit)).not.toContain('Created endpoint description');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.pragma).toBe('no-cache');
    });

    it('replays the identical secret-bearing response sequentially from one atomic completion', async () => {
      const key = `webhook-create-sequential-${suffix}`;
      const first = await createEndpoint(organizationA, { idempotencyKey: key });
      const replay = await createEndpoint(organizationA, { idempotencyKey: key });

      expect(first.statusCode, first.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['cache-control']).toBe('private, no-store');
      expect(replay.headers.pragma).toBe('no-cache');

      const [endpointRows, auditRows, record] = await Promise.all([
        db.selectFrom('webhook_endpoints').selectAll().where('id', '=', first.json().id).execute(),
        db
          .selectFrom('audit_logs')
          .selectAll()
          .where('actor_id', '=', actorId)
          .where('resource_id', '=', first.json().id)
          .execute(),
        db
          .selectFrom('idempotency_records')
          .selectAll()
          .where('tenant_id', '=', tenantA)
          .where('key', '=', scopedCreateIdempotencyKey(key))
          .executeTakeFirstOrThrow(),
      ]);
      expect(endpointRows).toHaveLength(1);
      expect(auditRows).toHaveLength(1);
      expect(record.status).toBe('completed');
      expect(record.key).toBe(scopedCreateIdempotencyKey(key));
      expect(record.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.key).not.toContain(key);
      expect(JSON.parse(record.response_body)).toEqual(first.json());
      const retentionMs =
        new Date(record.expires_at).getTime() - new Date(record.created_at).getTime();
      expect(retentionMs).toBeGreaterThanOrEqual(86_399_000);
      expect(retentionMs).toBeLessThanOrEqual(86_401_000);
    });

    it('collapses concurrent identical creation onto one endpoint, audit and secret response', async () => {
      const key = `webhook-create-concurrent-${suffix}`;
      const [first, replay] = await Promise.all([
        createEndpoint(organizationA, { idempotencyKey: key }),
        createEndpoint(organizationA, { idempotencyKey: key }),
      ]);
      expect(first.statusCode, first.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(first.headers['cache-control']).toBe('private, no-store');
      expect(replay.headers['cache-control']).toBe('private, no-store');

      const [endpointRows, auditRows, idempotencyRows] = await Promise.all([
        db.selectFrom('webhook_endpoints').selectAll().where('id', '=', first.json().id).execute(),
        db
          .selectFrom('audit_logs')
          .selectAll()
          .where('actor_id', '=', actorId)
          .where('resource_id', '=', first.json().id)
          .execute(),
        db
          .selectFrom('idempotency_records')
          .selectAll()
          .where('tenant_id', '=', tenantA)
          .where('key', '=', scopedCreateIdempotencyKey(key))
          .execute(),
      ]);
      expect(endpointRows).toHaveLength(1);
      expect(auditRows).toHaveLength(1);
      expect(idempotencyRows).toHaveLength(1);
      expect(idempotencyRows[0]).toMatchObject({ status: 'completed' });
    });

    it('isolates the same raw key across tenant peers and other operation scopes', async () => {
      const rawKey = `shared-raw-key-${suffix}`;
      const originalPrincipal = activePrincipal;
      const first = await createEndpoint(organizationA, { idempotencyKey: rawKey });
      activePrincipal = principal({ id: `usr_whe_peer_${suffix}` });
      const peerPrincipal = activePrincipal;
      const peer = await createEndpoint(organizationA, { idempotencyKey: rawKey });
      expect(first.statusCode).toBe(201);
      expect(peer.statusCode).toBe(201);
      expect(peer.json().id).not.toBe(first.json().id);
      expect(peer.json().secret).not.toBe(first.json().secret);

      const crossOperationKey = hashRequest({
        operation: 'saved_venue.create',
        principal: { type: originalPrincipal.type, id: originalPrincipal.id },
        key: rawKey,
      });
      await db
        .insertInto('idempotency_records')
        .values({
          id: `idm_cross_operation_${suffix}`,
          key: crossOperationKey,
          tenant_id: tenantA,
          request_hash: hashRequest({ operation: 'saved_venue.create', body: {} }),
          response_status: 201,
          response_body: JSON.stringify({ id: `ven_cross_operation_${suffix}` }),
          status: 'completed',
          created_at: new Date(),
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute();
      activePrincipal = originalPrincipal;
      const replay = await createEndpoint(organizationA, { idempotencyKey: rawKey });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());

      const records = await db
        .selectFrom('idempotency_records')
        .select(['key'])
        .where('tenant_id', '=', tenantA)
        .execute();
      expect(records.map((record) => record.key).sort()).toEqual(
        [
          scopedCreateIdempotencyKey(rawKey, originalPrincipal),
          scopedCreateIdempotencyKey(rawKey, peerPrincipal),
          crossOperationKey,
        ].sort(),
      );
      expect(records.every((record) => record.key !== rawKey)).toBe(true);
    });

    it('scrubs an expired secret replay into an indefinite nonsecret tombstone', async () => {
      const key = `webhook-create-expired-${suffix}`;
      const created = await createEndpoint(organizationA, { idempotencyKey: key });
      const scopedKey = scopedCreateIdempotencyKey(key);
      await db
        .updateTable('idempotency_records')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('tenant_id', '=', tenantA)
        .where('key', '=', scopedKey)
        .execute();

      const expired = await createEndpoint(organizationA, { idempotencyKey: key });
      expect(expired.statusCode).toBe(409);
      expect(expired.json()).toMatchObject({
        error: { code: 'WEBHOOK_ENDPOINT_SECRET_REPLAY_EXPIRED' },
      });
      expect(expired.body).not.toContain(created.json().secret);
      const record = await db
        .selectFrom('idempotency_records')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .where('key', '=', scopedKey)
        .executeTakeFirstOrThrow();
      expect(new Date(record.expires_at).getTime()).toBeLessThan(Date.now());
      expect(record.response_status).toBe(409);
      expect(record.response_body).not.toContain(created.json().secret);

      const changed = await createEndpoint(organizationA, {
        idempotencyKey: key,
        payload: { url: 'https://changed-after-expiry.example.test/events' },
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      const afterConflict = await db
        .selectFrom('idempotency_records')
        .select('response_body')
        .where('key', '=', scopedKey)
        .executeTakeFirstOrThrow();
      expect(afterConflict.response_body).not.toContain(created.json().secret);
    });

    it('never discloses the old secret during concurrent expiry scrubbing', async () => {
      const key = `webhook-create-expiry-race-${suffix}`;
      const created = await createEndpoint(organizationA, { idempotencyKey: key });
      const scopedKey = scopedCreateIdempotencyKey(key);
      await db
        .updateTable('idempotency_records')
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where('key', '=', scopedKey)
        .execute();
      const responses = await Promise.all([
        createEndpoint(organizationA, { idempotencyKey: key }),
        createEndpoint(organizationA, { idempotencyKey: key }),
        createEndpoint(organizationA, { idempotencyKey: key }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: { code: 'WEBHOOK_ENDPOINT_SECRET_REPLAY_EXPIRED' },
        });
        expect(response.body).not.toContain(created.json().secret);
      }
      const record = await db
        .selectFrom('idempotency_records')
        .selectAll()
        .where('key', '=', scopedKey)
        .executeTakeFirstOrThrow();
      expect(new Date(record.expires_at).getTime()).toBeLessThan(Date.now());
      expect(record.response_body).not.toContain(created.json().secret);
    });

    it('rejects missing, malformed and body-conflicting idempotency keys', async () => {
      const missing = await createEndpoint(organizationA, { idempotencyKey: null });
      const oversized = await createEndpoint(organizationA, { idempotencyKey: 'x'.repeat(129) });
      expect(missing.statusCode).toBe(400);
      expect(oversized.statusCode).toBe(400);

      const key = `webhook-create-conflict-${suffix}`;
      const first = await createEndpoint(organizationA, { idempotencyKey: key });
      const conflict = await createEndpoint(organizationA, {
        idempotencyKey: key,
        payload: { url: 'https://different-webhook.example.test/events' },
      });
      expect(first.statusCode).toBe(201);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
      const audits = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', actorId)
        .where('action', '=', 'webhook_endpoint.created')
        .execute();
      expect(audits).toHaveLength(1);
    });

    it('rolls back endpoint creation when the required audit cannot be persisted', async () => {
      const before = await endpointCountForOrganization(organizationA);
      const auditFailure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('forced audit failure'));
      const response = await createEndpoint();
      auditFailure.mockRestore();
      expect(response.statusCode).toBe(500);
      await expect(endpointCountForOrganization(organizationA)).resolves.toBe(before);
      const records = await db
        .selectFrom('idempotency_records')
        .selectAll()
        .where('tenant_id', '=', tenantA)
        .execute();
      expect(records).toHaveLength(0);
    });

    it('denies permission, organization, tenant and narrow-scope principals without effects', async () => {
      const scenarios: Array<[Partial<Principal>, string, number]> = [
        [{ scopes: [] }, organizationA, 403],
        [{ organizationIds: [] }, organizationA, 404],
        [{ tenantId: tenantA, organizationIds: [organizationB] }, organizationB, 404],
        [{ brandIds: [`brd_whe_${suffix}`] }, organizationA, 403],
        [{ eventIds: [eventA] }, organizationA, 403],
      ];
      for (const [overrides, organizationId, expectedStatus] of scenarios) {
        activePrincipal = principal(overrides);
        const before = await managementSnapshot();
        const response = await createEndpoint(organizationId);
        expect(response.statusCode, response.body).toBe(expectedStatus);
        await expect(managementSnapshot()).resolves.toEqual(before);
      }
    });
  });

  describe('PATCH /webhook-endpoints/:endpointId', () => {
    it('locks and reauthorizes the endpoint and records truthful hash-safe before/after state', async () => {
      const response = await updateEndpoint();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: endpointA,
        url: 'https://updated-webhook.example.test/orders?credential=never-audit-this-either',
        events: ['order.refunded'],
        status: 'disabled',
      });
      expect(checkpoint).toHaveBeenCalledWith({
        stage: 'before_transaction',
        operation: 'update',
        endpointId: endpointA,
      });
      const audit = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', actorId)
        .where('action', '=', 'webhook_endpoint.updated')
        .executeTakeFirstOrThrow();
      expect(auditDiff(audit.diff_summary)).toEqual({
        changedFields: ['url', 'events', 'status', 'description'],
        before: {
          urlSha256: sha256('https://allowed-webhook.example.test/original'),
          events: ['order.paid'],
          status: 'active',
          descriptionSha256: sha256('Allowed endpoint'),
        },
        after: {
          urlSha256: sha256(
            'https://updated-webhook.example.test/orders?credential=never-audit-this-either',
          ),
          events: ['order.refunded'],
          status: 'disabled',
          descriptionSha256: sha256('Updated endpoint description'),
        },
      });
      expect(JSON.stringify(audit)).not.toContain('allowed-webhook.example.test');
      expect(JSON.stringify(audit)).not.toContain('updated-webhook.example.test');
    });

    it('rechecks organization authority after the deterministic checkpoint', async () => {
      checkpoint.mockImplementationOnce(async () => {
        await db
          .updateTable('webhook_endpoints')
          .set({ organization_id: organizationASibling })
          .where('id', '=', endpointA)
          .execute();
      });
      const response = await updateEndpoint();
      expect(response.statusCode).toBe(404);
      const endpoint = await db
        .selectFrom('webhook_endpoints')
        .select(['organization_id', 'url', 'status'])
        .where('id', '=', endpointA)
        .executeTakeFirstOrThrow();
      expect(endpoint).toEqual({
        organization_id: organizationASibling,
        url: 'https://allowed-webhook.example.test/original',
        status: 'active',
      });
      await expect(
        db
          .selectFrom('audit_logs')
          .select(({ fn }) => fn.countAll().as('count'))
          .where('actor_id', '=', actorId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ count: expect.anything() });
      const audits = await db
        .selectFrom('audit_logs')
        .select('id')
        .where('actor_id', '=', actorId)
        .execute();
      expect(audits).toHaveLength(0);
    });

    it('rolls back the update when its required audit fails', async () => {
      const before = await managementSnapshot();
      const auditFailure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('forced audit failure'));
      const response = await updateEndpoint();
      auditFailure.mockRestore();
      expect(response.statusCode).toBe(500);
      await expect(managementSnapshot()).resolves.toEqual(before);
    });

    it('rejects an endpoint whose organization belongs to a different tenant', async () => {
      activePrincipal = principal({ organizationIds: [organizationB] });
      const before = await managementSnapshot();
      const response = await updateEndpoint(endpointMismatchedTenantOrganization);
      expect(response.statusCode).toBe(404);
      await expect(managementSnapshot()).resolves.toEqual(before);
    });

    it('serializes concurrent updates into a complete audit chain matching final state', async () => {
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      checkpoint.mockImplementation(async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      });

      const [left, right] = await Promise.all([
        updateEndpoint(endpointA, {
          url: 'https://concurrent-left.example.test/events',
          events: ['order.paid'],
          status: 'active',
          description: 'Concurrent left',
        }),
        updateEndpoint(endpointA, {
          url: 'https://concurrent-right.example.test/events',
          events: ['order.refunded'],
          status: 'disabled',
          description: 'Concurrent right',
        }),
      ]);
      expect([left.statusCode, right.statusCode]).toEqual([200, 200]);

      const [endpoint, audits] = await Promise.all([
        db
          .selectFrom('webhook_endpoints')
          .selectAll()
          .where('id', '=', endpointA)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('audit_logs')
          .selectAll()
          .where('actor_id', '=', actorId)
          .where('action', '=', 'webhook_endpoint.updated')
          .execute(),
      ]);
      expect(audits).toHaveLength(2);
      const diffs = audits.map((audit) => auditDiff(audit.diff_summary));
      const first = diffs.find(
        (diff) =>
          (diff.before as Record<string, unknown>).urlSha256 ===
          sha256('https://allowed-webhook.example.test/original'),
      );
      expect(first).toBeDefined();
      const second = diffs.find((diff) => diff !== first)!;
      expect(second.before).toEqual(first!.after);
      expect(second.after).toEqual({
        urlSha256: sha256(endpoint.url),
        events: storedEvents(endpoint.events),
        status: endpoint.status,
        descriptionSha256: sha256(endpoint.description!),
      });
    });

    it('rolls back one contending update when its audit fails and preserves one truthful winner', async () => {
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      checkpoint.mockImplementation(async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await gate;
      });
      const auditFailure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('forced contended audit failure'));
      const responses = await Promise.all([
        updateEndpoint(endpointA, {
          url: 'https://contention-left.example.test/events',
          description: 'Contention left',
        }),
        updateEndpoint(endpointA, {
          url: 'https://contention-right.example.test/events',
          description: 'Contention right',
        }),
      ]);
      auditFailure.mockRestore();
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 500]);
      const [endpoint, audits] = await Promise.all([
        db
          .selectFrom('webhook_endpoints')
          .selectAll()
          .where('id', '=', endpointA)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('audit_logs')
          .selectAll()
          .where('actor_id', '=', actorId)
          .where('action', '=', 'webhook_endpoint.updated')
          .execute(),
      ]);
      expect(audits).toHaveLength(1);
      const diff = auditDiff(audits[0]!.diff_summary);
      expect(diff.before).toMatchObject({
        urlSha256: sha256('https://allowed-webhook.example.test/original'),
      });
      expect(diff.after).toEqual({
        urlSha256: sha256(endpoint.url),
        events: storedEvents(endpoint.events),
        status: endpoint.status,
        descriptionSha256: sha256(endpoint.description!),
      });
    });

    it('denies permission, tenant, organization and narrow-scope principals without effects', async () => {
      const scenarios: Array<[Partial<Principal>, string, number]> = [
        [{ scopes: [] }, endpointA, 403],
        [{ tenantId: tenantB, organizationIds: [organizationB] }, endpointA, 404],
        [{ organizationIds: [organizationASibling] }, endpointA, 404],
        [{ brandIds: [`brd_whe_${suffix}`] }, endpointA, 403],
        [{ eventIds: [eventA] }, endpointA, 403],
      ];
      for (const [overrides, endpointId, expectedStatus] of scenarios) {
        activePrincipal = principal(overrides);
        const before = await managementSnapshot();
        const response = await updateEndpoint(endpointId);
        expect(response.statusCode, response.body).toBe(expectedStatus);
        await expect(managementSnapshot()).resolves.toEqual(before);
      }
    });
  });

  describe('GET endpoint surfaces', () => {
    it('lists only selected authorized organization endpoints', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints?organizationId=${organizationA}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items.map((item: { id: string }) => item.id)).toEqual([endpointA]);
    });

    it('denies list permission, foreign selected organizations and narrow-scope principals', async () => {
      const scenarios: Array<[Partial<Principal>, string, number]> = [
        [{ scopes: [] }, organizationA, 403],
        [{ organizationIds: [] }, organizationA, 404],
        [{ tenantId: tenantA, organizationIds: [organizationB] }, organizationB, 404],
        [{ brandIds: [`brd_whe_${suffix}`] }, organizationA, 403],
        [{ eventIds: [eventA] }, organizationA, 403],
      ];
      for (const [overrides, organizationId, expectedStatus] of scenarios) {
        activePrincipal = principal(overrides);
        const before = await managementSnapshot();
        const response = await app.inject({
          method: 'GET',
          url: `/webhook-endpoints?organizationId=${organizationId}`,
        });
        expect(response.statusCode, response.body).toBe(expectedStatus);
        await expect(managementSnapshot()).resolves.toEqual(before);
      }
    });

    it('returns scoped delivery history for a live endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/${endpointA}/events`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items).toEqual([
        expect.objectContaining({
          eventId: eventA,
          endpointId: endpointA,
          requestedEndpointId: endpointA,
          status: 'delivered',
        }),
      ]);
    });

    it('excludes hostile endpoint and retained-event organization/tenant mismatches', async () => {
      activePrincipal = principal({ organizationIds: [organizationA, organizationB] });
      const list = await app.inject({ method: 'GET', url: '/webhook-endpoints' });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([endpointA]);

      const liveMismatch = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/${endpointMismatchedTenantOrganization}/events`,
      });
      expect(liveMismatch.statusCode).toBe(404);

      const retainedMismatch = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/${retainedMismatchedEndpointId}/events`,
      });
      expect(retainedMismatch.statusCode, retainedMismatch.body).toBe(200);
      expect(retainedMismatch.json()).toMatchObject({
        items: [],
        hasMore: false,
        nextCursor: null,
      });
    });

    it('retains deleted-endpoint history for its organization without leaking it cross-org', async () => {
      await db
        .updateTable('webhook_deliveries')
        .set({ endpoint_id: null })
        .where('requested_endpoint_id', '=', endpointA)
        .execute();
      await db.deleteFrom('webhook_endpoints').where('id', '=', endpointA).execute();
      const allowed = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/${endpointA}/events`,
      });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json().items).toEqual([
        expect.objectContaining({
          eventId: eventA,
          endpointId: null,
          requestedEndpointId: endpointA,
        }),
      ]);

      activePrincipal = principal({ organizationIds: [organizationASibling] });
      const denied = await app.inject({
        method: 'GET',
        url: `/webhook-endpoints/${endpointA}/events`,
      });
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.json()).toMatchObject({ items: [], hasMore: false, nextCursor: null });
    });

    it('denies live endpoint history across permission, tenant, organization and narrow scopes', async () => {
      const scenarios: Array<[Partial<Principal>, number]> = [
        [{ scopes: [] }, 403],
        [{ tenantId: tenantB, organizationIds: [organizationB] }, 404],
        [{ organizationIds: [organizationASibling] }, 404],
        [{ brandIds: [`brd_whe_${suffix}`] }, 403],
        [{ eventIds: [eventA] }, 403],
      ];
      for (const [overrides, expectedStatus] of scenarios) {
        activePrincipal = principal(overrides);
        const before = await managementSnapshot();
        const response = await app.inject({
          method: 'GET',
          url: `/webhook-endpoints/${endpointA}/events`,
        });
        expect(response.statusCode, response.body).toBe(expectedStatus);
        await expect(managementSnapshot()).resolves.toEqual(before);
      }
    });
  });

  it('binds executable denial contracts to all four management operations', () => {
    expect(
      WEBHOOK_ENDPOINT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map(
        ({ method, path }) => `${method} ${path}`,
      ),
    ).toEqual([
      'GET /webhook-endpoints',
      'POST /webhook-endpoints',
      'PATCH /webhook-endpoints/{endpointId}',
      'GET /webhook-endpoints/{endpointId}/events',
    ]);
  });
});
