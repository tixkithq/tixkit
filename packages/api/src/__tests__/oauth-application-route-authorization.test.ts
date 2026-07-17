import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import { registerErrorHandler } from '../app.js';
import { developerRoutes } from '../routes/modules/developer.js';
import { OAUTH_APPLICATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './integration/route-authorization-contracts.js';

const { writeAuditLog } = vi.hoisted(() => ({
  writeAuditLog: vi.fn(async (..._arguments: unknown[]) => undefined),
}));

vi.mock('../auth/audit.js', () => ({ writeAuditLog }));

const tenantId = 'tenant_oauth_application_auth_01';
const organizationId = 'org_oauth_application_auth_01';
const appId = 'oapp_oauth_application_auth_01';
const now = new Date('2026-07-17T12:00:00.000Z');
const payload = {
  organizationId,
  name: 'Organizer integration',
  redirectUris: ['https://example.com/oauth/callback'],
  scopes: ['events.read'],
};

type Row = Record<string, unknown>;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'user_oauth_application_admin',
    tenantId,
    organizationIds: [organizationId],
    scopes: ['developers.write', 'events.read'],
    ...overrides,
  };
}

function oauthApplication(overrides: Row = {}): Row {
  return {
    id: appId,
    tenant_id: tenantId,
    organization_id: organizationId,
    name: payload.name,
    client_id: 'tk_oauth_existing',
    client_secret_hash: 'f'.repeat(64),
    redirect_uris: JSON.stringify(payload.redirectUris),
    scopes: JSON.stringify(payload.scopes),
    subject_type: 'resource_owner',
    agent_principal_id: null,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function database(input: { applications?: Row[]; organizations?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    oauth_applications: input.applications ?? [oauthApplication()],
    organizations: input.organizations ?? [{ id: organizationId, tenant_id: tenantId }],
  };
  const transaction = vi.fn(() => ({
    execute: <T>(operation: (database: typeof db) => Promise<T>) => operation(db),
  }));
  const insertInto = vi.fn((table: string) => ({
    values(row: Row) {
      return {
        async execute() {
          (tables[table] ??= []).push({ ...row });
        },
      };
    },
  }));
  const updateTable = vi.fn((table: string) => {
    let changes: Row = {};
    const predicates: Array<[string, string, unknown]> = [];
    const query = {
      set(values: Row) {
        changes = values;
        return query;
      },
      where(column: string, operator: string, value: unknown) {
        predicates.push([column, operator, value]);
        return query;
      },
      async executeTakeFirst() {
        const matches = (tables[table] ?? []).filter((row) =>
          predicates.every(([column, operator, value]) =>
            operator === 'in'
              ? Array.isArray(value) && value.includes(row[column])
              : row[column] === value,
          ),
        );
        for (const row of matches) Object.assign(row, changes);
        return { numUpdatedRows: BigInt(matches.length) };
      },
    };
    return query;
  });
  const db = {
    transaction,
    insertInto,
    updateTable,
    selectFrom(table: string) {
      const predicates: Array<[string, string, unknown]> = [];
      const query = {
        selectAll() {
          return query;
        },
        where(column: string, operator: string, value: unknown) {
          predicates.push([column, operator, value]);
          return query;
        },
        forUpdate() {
          return query;
        },
        async executeTakeFirst() {
          return (tables[table] ?? []).find((row) =>
            predicates.every(([column, operator, value]) =>
              operator === 'in'
                ? Array.isArray(value) && value.includes(row[column])
                : row[column] === value,
            ),
          );
        },
      };
      return query;
    },
  };
  return { db, insertInto, tables, transaction, updateTable };
}

async function testApp(activePrincipal: Principal, databaseState = database()) {
  const app = Fastify();
  app.decorate('context', { db: databaseState.db } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(developerRoutes);
  return { app, databaseState };
}

describe('OAuth application route authorization contract', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    writeAuditLog.mockClear();
  });

  it('is the exact executable source for the immutable C-123 contracts', () => {
    expect(OAUTH_APPLICATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toEqual([
      expect.objectContaining({
        method: 'POST',
        operationId: 'postOauthApplications',
        path: '/oauth-applications',
        deniedBoundaries: ['organization'],
        policyDeniedBoundaries: ['brand', 'event'],
      }),
      expect.objectContaining({
        method: 'DELETE',
        operationId: 'deleteOauthApplicationsByAppId',
        path: '/oauth-applications/{appId}',
        deniedBoundaries: ['tenant', 'organization'],
        policyDeniedBoundaries: ['brand', 'event'],
      }),
    ]);
  });

  it.each(OAUTH_APPLICATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS)(
    'returns the declared permission denial before persistence or audit for $method $path',
    async (contract) => {
      const { app, databaseState } = await testApp(principal({ scopes: ['events.read'] }));
      const response = await app.inject(
        contract.method === 'POST'
          ? { method: 'POST', url: '/oauth-applications', payload }
          : { method: 'DELETE', url: `/oauth-applications/${appId}` },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(databaseState.transaction).not.toHaveBeenCalled();
      expect(databaseState.insertInto).not.toHaveBeenCalled();
      expect(databaseState.updateTable).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it.each([
    ['brand', { brandIds: ['brand_oauth_application_auth_01'] }],
    ['event', { eventIds: ['event_oauth_application_auth_01'] }],
  ])('returns 403 for a %s-scoped principal before any effect', async (_scope, bounds) => {
    for (const request of [
      { method: 'POST' as const, url: '/oauth-applications', payload },
      { method: 'DELETE' as const, url: `/oauth-applications/${appId}` },
    ]) {
      const { app, databaseState } = await testApp(principal(bounds));
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('FORBIDDEN');
      expect(databaseState.transaction).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('returns indistinguishable 404s for foreign organization and tenant resources', async () => {
    const foreignOrganization = await testApp(principal({ organizationIds: ['org_foreign'] }));
    const create = await foreignOrganization.app.inject({
      method: 'POST',
      url: '/oauth-applications',
      payload,
    });
    expect(create.statusCode).toBe(404);
    expect(create.json().error.code).toBe('NOT_FOUND');
    expect(foreignOrganization.databaseState.transaction).not.toHaveBeenCalled();
    await foreignOrganization.app.close();

    for (const actor of [
      principal({ tenantId: 'tenant_foreign' }),
      principal({ organizationIds: ['org_foreign'] }),
    ]) {
      const state = database();
      const { app } = await testApp(actor, state);
      const revoke = await app.inject({ method: 'DELETE', url: `/oauth-applications/${appId}` });
      expect(revoke.statusCode).toBe(404);
      expect(revoke.json().error.code).toBe('NOT_FOUND');
      expect(state.updateTable).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('creates and revokes authorized applications without exposing secret material to audit', async () => {
    const state = database({ applications: [] });
    const { app } = await testApp(principal(), state);
    const created = await app.inject({ method: 'POST', url: '/oauth-applications', payload });
    expect(created.statusCode, created.body).toBe(201);
    const result = created.json() as { clientSecret: string; id: string };
    expect(result.clientSecret).toMatch(/^tk_secret_/);
    expect(state.tables.oauth_applications).toHaveLength(1);
    const persistedHash = String(state.tables.oauth_applications[0]?.client_secret_hash);
    expect(persistedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(result.clientSecret);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(persistedHash);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/oauth-applications/${result.id}`,
    });
    expect(revoked.statusCode, revoked.body).toBe(204);
    expect(state.tables.oauth_applications[0]?.status).toBe('revoked');
    expect(writeAuditLog).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(result.clientSecret);
    expect(JSON.stringify(writeAuditLog.mock.calls)).not.toContain(persistedHash);
    await app.close();
  });
});
