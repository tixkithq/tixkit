import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyRepository } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler } from '../app.js';
import { developerRoutes } from '../routes/modules/developer.js';
import { API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './integration/route-authorization-contracts.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (..._arguments: unknown[]) => undefined),
}));

vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

const tenantId = 'tenant_api_key_auth_01';
const organizationId = 'org_api_key_auth_01';
const keyId = 'key_api_key_auth_01';
const rawApiKey = `tk_${'a'.repeat(64)}`;

const storedKey = {
  id: keyId,
  tenant_id: tenantId,
  organization_id: organizationId,
  name: 'Event reader',
  key_prefix: rawApiKey.slice(0, 12),
  hashed_key: 'b'.repeat(64),
  scopes: JSON.stringify(['events.read']),
  brand_ids: null,
  event_ids: null,
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  created_at: new Date('2026-07-16T12:00:00.000Z'),
  updated_at: new Date('2026-07-16T12:00:00.000Z'),
};

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_api_key_admin',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['developers.write', 'events.read'],
    ...overrides,
  };
}

function database(row: Record<string, unknown> = storedKey) {
  const db = {
    transaction() {
      return { execute: <T>(operation: (database: typeof db) => Promise<T>) => operation(db) };
    },
    selectFrom(table: string) {
      const rows: Record<string, unknown>[] =
        table === 'api_keys'
          ? [row]
          : table === 'brands'
            ? [
                {
                  id: 'brand_other_01',
                  tenant_id: tenantId,
                  organization_id: organizationId,
                },
              ]
            : table === 'events'
              ? [
                  {
                    id: 'event_other_01',
                    tenant_id: tenantId,
                    organization_id: organizationId,
                    brand_id: 'brand_allowed_01',
                  },
                ]
              : [];
      const predicates: Array<[string, unknown]> = [];
      const query = {
        selectAll() {
          return query;
        },
        where(column: string, _operator: string, value: unknown) {
          predicates.push([column, value]);
          return query;
        },
        async executeTakeFirst() {
          return rows.find((candidate) =>
            predicates.every(([column, value]) => candidate[column] === value),
          );
        },
      };
      return query;
    },
  };
  return db;
}

async function testApp(activePrincipal: Principal, row: Record<string, unknown> = storedKey) {
  const app = Fastify();
  app.decorate('context', { db: database(row) } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(developerRoutes);
  return app;
}

describe('API key route authorization contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    writeAuditLog.mockClear();
    vi.spyOn(ApiKeyRepository.prototype, 'create').mockResolvedValue({
      apiKey: rawApiKey,
      record: storedKey,
    });
    vi.spyOn(ApiKeyRepository.prototype, 'revokeScoped').mockResolvedValue(1);
  });

  it('is the exact executable source for the immutable C-123 contracts', () => {
    expect(API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toEqual([
      expect.objectContaining({
        method: 'POST',
        operationId: 'postApiKeys',
        path: '/api-keys',
        deniedBoundaries: ['organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      }),
      expect.objectContaining({
        method: 'DELETE',
        operationId: 'deleteApiKeysByKeyId',
        path: '/api-keys/{keyId}',
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      }),
    ]);
  });

  it.each(API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns the declared permission denial before persistence or audit for $method $path',
    async (contract) => {
      const app = await testApp(principal({ scopes: ['events.read'] }));
      const response = await app.inject(
        contract.method === 'POST'
          ? {
              method: 'POST',
              url: '/api-keys',
              payload: { organizationId, name: 'Denied', scopes: ['events.read'] },
            }
          : { method: 'DELETE', url: `/api-keys/${keyId}` },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(ApiKeyRepository.prototype.create).not.toHaveBeenCalled();
      expect(ApiKeyRepository.prototype.revokeScoped).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('returns 404 for an out-of-scope create organization without mutation', async () => {
    const app = await testApp(principal({ organizationIds: ['org_unrelated_01'] }));
    const response = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: { organizationId, name: 'Denied', scopes: ['events.read'] },
    });

    expect(response.statusCode).toBe(404);
    expect(ApiKeyRepository.prototype.create).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['brand', { brandIds: ['brand_other_01'] }, { brandIds: ['brand_allowed_01'] }],
    ['event', { eventIds: ['event_other_01'] }, { eventIds: ['event_allowed_01'] }],
  ])(
    'returns 404 for an out-of-scope create %s without mutation',
    async (_boundary, payloadScope, principalScope) => {
      const app = await testApp(principal(principalScope));
      const response = await app.inject({
        method: 'POST',
        url: '/api-keys',
        payload: {
          organizationId,
          name: 'Denied',
          scopes: ['events.read'],
          ...payloadScope,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(ApiKeyRepository.prototype.create).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ['tenant', principal({ tenantId: 'tenant_alien_01' })],
    ['organization', principal({ organizationIds: ['org_alien_01'] })],
  ])('returns 404 for an out-of-scope %s key without mutation', async (_boundary, actor) => {
    const app = await testApp(actor);
    const response = await app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });

    expect(response.statusCode).toBe(404);
    expect(ApiKeyRepository.prototype.revokeScoped).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [
      'brand',
      { brand_ids: JSON.stringify(['brand_other_01']) },
      { brandIds: ['brand_allowed_01'] },
    ],
    [
      'event',
      { event_ids: JSON.stringify(['event_other_01']) },
      { eventIds: ['event_allowed_01'] },
    ],
  ])(
    'returns 404 for an out-of-scope %s-scoped key without mutation',
    async (_boundary, rowScope, principalScope) => {
      const app = await testApp(principal(principalScope), { ...storedKey, ...rowScope });
      const response = await app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });

      expect(response.statusCode).toBe(404);
      expect(ApiKeyRepository.prototype.revokeScoped).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it('creates and revokes authorized keys with exact scoped persistence and audit', async () => {
    const app = await testApp(principal());
    const created = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: { organizationId, name: 'Event reader', scopes: ['events.read'] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().apiKey).toBe(rawApiKey);
    expect(created.body).not.toContain(storedKey.hashed_key);

    const revoked = await app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });
    expect(revoked.statusCode, revoked.body).toBe(204);
    expect(ApiKeyRepository.prototype.revokeScoped).toHaveBeenCalledWith({
      id: keyId,
      tenantId,
      organizationId,
    });
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    expect(writeAuditLog.mock.calls.map((call) => call[4])).toEqual([
      { failClosed: true },
      { failClosed: true },
    ]);
    expect(writeAuditLog.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ action: 'api_key.created', organizationId, resourceId: keyId }),
      expect.objectContaining({ action: 'api_key.revoked', organizationId, resourceId: keyId }),
    ]);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(storedKey.hashed_key);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(rawApiKey);
    await app.close();
  });

  it('returns 404 without audit when the scoped active-state mutation loses a race', async () => {
    vi.mocked(ApiKeyRepository.prototype.revokeScoped).mockResolvedValueOnce(0);
    const app = await testApp(principal());
    const response = await app.inject({ method: 'DELETE', url: `/api-keys/${keyId}` });

    expect(response.statusCode).toBe(404);
    expect(writeAuditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
