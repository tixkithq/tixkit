import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Principal, Permission } from '@tixkit/domain';
import type { AuthProvider } from '@tixkit/shared';
import { ForbiddenError, UnauthorizedError } from '@tixkit/domain';
import {
  ClerkAuthService,
  createAuthMiddleware,
  DEV_ORG_ID,
  DEV_TENANT_ID,
} from '../auth/clerk.js';
import { createAuthProvider, OIDCAdapter } from '../auth/providers.js';
import { authRoutes } from '../routes/modules/auth.js';

const clerkGetUser = vi.hoisted(() => vi.fn());

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(),
  createClerkClient: () => ({ users: { getUser: clerkGetUser } }),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(),
}));

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
const ACCEPTED_ORGANIZATION_MEMBER_AT = '2026-01-01T00:00:00.000Z';

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    clerkUserId: 'clerk_user_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read', 'orders.read'] as Permission[],
    ...overrides,
  };
}

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function columnKey(column: string): string {
  return column.split('.').at(-1) ?? column;
}

function organizationMember(userId: string, organizationId: string, tenantId = 'tnt_1'): Row {
  return {
    id: `member_${tenantId}_${organizationId}_${userId}`,
    tenant_id: tenantId,
    organization_id: organizationId,
    user_id: userId,
    role: 'member',
    accepted_at: ACCEPTED_ORGANIZATION_MEMBER_AT,
  };
}

function createAuthDb(initialTables: Tables) {
  const tables = initialTables;
  const updates: Array<{ table: string; values: Row; ids: string[] }> = [];

  const rowsFor = (table: string): Row[] => {
    if (!tables[table]) tables[table] = [];
    return tables[table];
  };

  const matches = (
    row: Row,
    conditions: Array<{ column: string; operator: string; value: unknown }>,
  ): boolean =>
    conditions.every(({ column, operator, value }) => {
      const actual = row[columnKey(column)];
      if (operator === '=') return actual === value;
      if (operator === '!=') return actual !== value;
      if (operator === 'is') return value === null ? actual === null : actual === value;
      if (operator === 'is not') return value === null ? actual !== null : actual !== value;
      if (operator === 'in') return Array.isArray(value) && value.includes(actual);
      if (operator === '>' && actual instanceof Date) return actual.getTime() > Date.now();
      return false;
    });

  function createQuery(table: string) {
    const conditions: Array<{ column: string; operator: string; value: unknown }> = [];
    const query = {
      selectAll: () => query,
      select: () => query,
      innerJoin: () => query,
      where(column: string, operator: string, value: unknown) {
        conditions.push({ column, operator, value });
        return query;
      },
      limit: () => query,
      async execute() {
        return rowsFor(table).filter((row) => matches(row, conditions));
      },
      async executeTakeFirst() {
        return rowsFor(table).find((row) => matches(row, conditions));
      },
      async executeTakeFirstOrThrow() {
        const row = rowsFor(table).find((item) => matches(item, conditions));
        if (!row) throw new Error(`No row found for ${table}`);
        return row;
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    const state = {
      values: {} as Row,
      conditions: [] as Array<{ column: string; operator: string; value: unknown }>,
    };
    const update = {
      set(values: Row) {
        state.values = values;
        return update;
      },
      where(column: string, operator: string, value: unknown) {
        state.conditions.push({ column, operator, value });
        return update;
      },
      async execute() {
        const affected = rowsFor(table).filter((row) => matches(row, state.conditions));
        for (const row of affected) {
          Object.assign(row, state.values);
        }
        updates.push({
          table,
          values: state.values,
          ids: affected.map((row) => String(row.id)),
        });
        return [];
      },
    };
    return update;
  }

  function createInsert(table: string) {
    return {
      values(values: Row) {
        return {
          async execute() {
            rowsFor(table).push(values);
            return [];
          },
        };
      },
    };
  }

  const db = {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
    transaction: () => ({
      execute: async <T>(callback: (transactionDb: unknown) => Promise<T>) => callback(db),
    }),
  };

  return {
    db,
    tables,
    updates,
  };
}

async function setupAuthRouteApp(authService: ClerkAuthService | AuthProvider<FastifyRequest>) {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', createAuthMiddleware(authService));
  await app.register(authRoutes, { prefix: '/v1' });
  return app;
}

describe('ClerkAuthService signed-in user auth', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.mocked(verifyToken).mockReset();
    clerkGetUser.mockReset();
    clerkGetUser.mockResolvedValue({ emailAddresses: [], primaryEmailAddressId: null });
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('maps a signed-in Clerk user to a Tixkit principal with permissions and org membership', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_1',
          permission: 'events.read',
        },
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_1',
          permission: 'orders.read',
        },
      ],
      organization_members: [organizationMember('usr_1', 'org_1')],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(verifyToken).toHaveBeenCalledWith('clerk_session_token', {
      secretKey: 'sk_test_auth',
    });
    expect(result.principal).toMatchObject({
      type: 'user',
      id: 'usr_1',
      clerkUserId: 'clerk_user_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read', 'orders.read'],
    });
  });

  it('activates a pending email invitation on the invited user first sign-in', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_door_user',
      email: 'door@example.com',
    } as never);
    clerkGetUser.mockResolvedValue({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [
        {
          id: 'email_1',
          emailAddress: 'door@example.com',
          verification: { status: 'verified' },
        },
      ],
    });
    const { db, tables } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_invited',
          tenant_id: 'tnt_1',
          clerk_user_id: 'invited:door@example.com',
          email: 'door@example.com',
          status: 'invited',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_invited',
          permission: 'checkins.read',
        },
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_invited',
          permission: 'checkins.write',
        },
      ],
      organization_members: [
        {
          ...organizationMember('usr_invited', 'org_1'),
          accepted_at: null,
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(tables.user_profiles[0]).toMatchObject({
      clerk_user_id: 'clerk_door_user',
      status: 'active',
    });
    expect(tables.organization_members[0]?.accepted_at).toBeInstanceOf(Date);
    expect(result.principal).toMatchObject({
      id: 'usr_invited',
      organizationIds: ['org_1'],
      scopes: ['checkins.read', 'checkins.write'],
    });
  });

  it.each([
    { name: 'unverified', address: 'door@example.com', status: 'unverified' },
    { name: 'mismatched', address: 'someone-else@example.com', status: 'verified' },
  ])('does not claim an invitation from a $name Clerk email', async ({ address, status }) => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_unverified_user',
      email: 'door@example.com',
    } as never);
    clerkGetUser.mockResolvedValue({
      primaryEmailAddressId: 'email_1',
      emailAddresses: [
        {
          id: 'email_1',
          emailAddress: address,
          verification: { status },
        },
      ],
    });
    const { db, tables } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_invited',
          tenant_id: 'tnt_1',
          clerk_user_id: 'invited:door@example.com',
          email: 'door@example.com',
          status: 'invited',
        },
      ],
      organization_members: [{ ...organizationMember('usr_invited', 'org_1'), accepted_at: null }],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow('User profile not found');
    expect(tables.user_profiles[0]).toMatchObject({
      clerk_user_id: 'invited:door@example.com',
      status: 'invited',
    });
    expect(tables.organization_members[0]?.accepted_at).toBeNull();
  });

  it('accepts pending invitations while excluding cross-tenant memberships', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      permission_grants: [],
      organization_members: [
        organizationMember('usr_1', 'org_accepted', 'tnt_1'),
        {
          ...organizationMember('usr_1', 'org_pending', 'tnt_1'),
          accepted_at: null,
        },
        organizationMember('usr_1', 'org_other_tenant', 'tnt_2'),
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(result.principal.organizationIds).toEqual(['org_accepted', 'org_pending']);
    expect(result.principal.organizationIds).not.toContain('org_other_tenant');
  });

  it('maps event-scoped Clerk user permission grants to principal eventIds', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_1',
          permission: 'events.read',
          scope_type: 'event',
          scope_id: 'evt_A',
        },
      ],
      organization_members: [organizationMember('usr_1', 'org_1')],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(result.principal).toMatchObject({
      id: 'usr_1',
      scopes: ['events.read'],
      eventIds: ['evt_A'],
    });
    expect(result.principal.eventIds).toEqual(['evt_A']);
    expect(() => ClerkAuthService.requireEventScope(result.principal, 'evt_other')).toThrow();
  });

  it('maps brand-scoped Clerk user permission grants to principal brandIds', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_1',
          permission: 'events.write',
          scope_type: 'brand',
          scope_id: 'brd_A',
        },
      ],
      organization_members: [organizationMember('usr_1', 'org_1')],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(result.principal).toMatchObject({
      id: 'usr_1',
      scopes: ['events.write'],
      brandIds: ['brd_A'],
    });
  });

  it('fails closed when Clerk login succeeds but the Tixkit user profile has not synced', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_missing' } as never);
    const { db } = createAuthDb({
      user_profiles: [],
      permission_grants: [],
      organization_members: [],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow('User profile not found. Identity sync may be pending.');
  });

  it('auto-provisions a verified Clerk user in development when webhook identity sync has not run', async () => {
    process.env.NODE_ENV = 'development';
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_dev_user_1',
      email: 'dev@example.test',
      first_name: 'Dev',
      last_name: 'Organizer',
    } as never);
    const { db, tables } = createAuthDb({
      tenants: [],
      organizations: [],
      brands: [],
      user_profiles: [],
      permission_grants: [],
      organization_members: [],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(tables.tenants).toHaveLength(1);
    expect(tables.organizations).toHaveLength(1);
    expect(tables.brands).toHaveLength(1);
    expect(tables.user_profiles).toHaveLength(1);
    expect(tables.organization_members).toHaveLength(1);
    expect(tables.permission_grants).toHaveLength(20);
    expect(result.principal).toMatchObject({
      type: 'user',
      clerkUserId: 'clerk_dev_user_1',
      tenantId: DEV_TENANT_ID,
      organizationIds: [DEV_ORG_ID],
    });
    expect(result.principal.scopes).toContain('billing.write');
    expect(tables.user_profiles[0]).toMatchObject({
      email: 'dev@example.test',
      first_name: 'Dev',
      last_name: 'Organizer',
    });
  });

  it('uses the active Clerk organization claim to choose the matching tenant profile', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_user_1',
      org_id: 'clerk_org_2',
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
        {
          id: 'usr_2',
          tenant_id: 'tnt_2',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      organizations: [
        {
          id: 'org_2',
          tenant_id: 'tnt_2',
          clerk_organization_id: 'clerk_org_2',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_2',
          principal_type: 'user',
          principal_id: 'usr_2',
          permission: 'settings.write',
        },
      ],
      organization_members: [organizationMember('usr_2', 'org_2', 'tnt_2')],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({ authorization: 'Bearer clerk_session_token' }),
    );

    expect(result.principal).toMatchObject({
      id: 'usr_2',
      tenantId: 'tnt_2',
      organizationIds: ['org_2'],
      scopes: ['settings.write'],
      clerkOrganizationId: 'clerk_org_2',
    });
  });

  it('rejects active Clerk organization claims mapped to multiple tenants', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_user_1',
      org_id: 'clerk_org_shared',
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
        {
          id: 'usr_2',
          tenant_id: 'tnt_2',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          clerk_organization_id: 'clerk_org_shared',
        },
        {
          id: 'org_2',
          tenant_id: 'tnt_2',
          clerk_organization_id: 'clerk_org_shared',
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow('Active organization maps to multiple Tixkit tenants');
  });

  it('uses X-Tenant-Id to disambiguate multi-tenant users without an active Clerk org', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
        {
          id: 'usr_2',
          tenant_id: 'tnt_2',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_2',
          principal_type: 'user',
          principal_id: 'usr_2',
          permission: 'reports.read',
        },
      ],
      organization_members: [organizationMember('usr_2', 'org_2', 'tnt_2')],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateRequest(
      request({
        authorization: 'Bearer clerk_session_token',
        'x-tenant-id': 'tnt_2',
      }),
    );

    expect(result.principal).toMatchObject({
      id: 'usr_2',
      tenantId: 'tnt_2',
      organizationIds: ['org_2'],
      scopes: ['reports.read'],
    });
  });

  it('rejects ambiguous multi-tenant users without an org claim or tenant header', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
        {
          id: 'usr_2',
          tenant_id: 'tnt_2',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow(
      'Ambiguous tenant for user; specify an active organization or X-Tenant-Id header',
    );
  });

  it('rejects multi-tenant users when the active Clerk org does not map to a Tixkit tenant', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_user_1',
      org_id: 'clerk_org_unknown',
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
        {
          id: 'usr_2',
          tenant_id: 'tnt_2',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      organizations: [],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow('Active organization does not map to a Tixkit tenant');
  });

  it('rejects single-tenant users when the active Clerk org does not map to a Tixkit tenant', async () => {
    vi.mocked(verifyToken).mockResolvedValue({
      sub: 'clerk_user_1',
      org_id: 'clerk_org_unknown',
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'active',
        },
      ],
      organizations: [],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow('Active organization does not map to a Tixkit tenant');
  });

  it('rejects suspended Tixkit users after successful Clerk verification', async () => {
    vi.mocked(verifyToken).mockResolvedValue({ sub: 'clerk_user_1' } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'clerk_user_1',
          status: 'suspended',
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer clerk_session_token' })),
    ).rejects.toThrow(ForbiddenError);
  });

  it('rejects invalid Clerk tokens', async () => {
    vi.mocked(verifyToken).mockRejectedValue(new Error('bad jwt'));
    const { db } = createAuthDb({});
    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateRequest(request({ authorization: 'Bearer invalid' })),
    ).rejects.toThrow('Token verification failed');
  });
});

function createOidcAdapter(db: unknown): OIDCAdapter {
  return new OIDCAdapter(new ClerkAuthService('sk_test_auth', db as never), db as never, {
    issuerUrl: 'https://issuer.example.test/',
    audience: 'tixkit-api',
  });
}

describe('OIDCAdapter signed-in user auth', () => {
  beforeEach(() => {
    vi.mocked(jwtVerify).mockReset();
  });

  it('rejects a single-profile user when requested organization does not map to membership', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'oidc_user_1',
        organization_id: 'org_unknown',
      },
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'oidc:https://issuer.example.test:oidc_user_1',
          status: 'active',
        },
      ],
      organization_members: [organizationMember('usr_1', 'org_1')],
    });

    await expect(
      createOidcAdapter(db).authenticateUser(request({ authorization: 'Bearer oidc_token' })),
    ).rejects.toThrow('Active OIDC organization does not map to Tixkit membership');
  });

  it('accepts a single-profile user when requested organization maps to membership', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'oidc_user_1',
        org_id: 'org_1',
      },
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'oidc:https://issuer.example.test:oidc_user_1',
          status: 'active',
        },
      ],
      permission_grants: [
        {
          tenant_id: 'tnt_1',
          principal_type: 'user',
          principal_id: 'usr_1',
          permission: 'events.read',
        },
      ],
      organization_members: [organizationMember('usr_1', 'org_1')],
    });

    await expect(
      createOidcAdapter(db).authenticateUser(request({ authorization: 'Bearer oidc_token' })),
    ).resolves.toMatchObject({
      principal: {
        type: 'user',
        id: 'usr_1',
        tenantId: 'tnt_1',
        organizationIds: ['org_1'],
        scopes: ['events.read'],
      },
    });
  });

  it('excludes pending and cross-tenant organization memberships from OIDC principals', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'oidc_user_1',
      },
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'oidc:https://issuer.example.test:oidc_user_1',
          status: 'active',
        },
      ],
      permission_grants: [],
      organization_members: [
        organizationMember('usr_1', 'org_accepted', 'tnt_1'),
        {
          ...organizationMember('usr_1', 'org_pending', 'tnt_1'),
          accepted_at: null,
        },
        organizationMember('usr_1', 'org_other_tenant', 'tnt_2'),
      ],
    });

    await expect(
      createOidcAdapter(db).authenticateUser(request({ authorization: 'Bearer oidc_token' })),
    ).resolves.toMatchObject({
      principal: {
        organizationIds: ['org_accepted'],
      },
    });
  });

  it('rejects requested OIDC organizations when membership is still pending', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        sub: 'oidc_user_1',
        org_id: 'org_pending',
      },
    } as never);
    const { db } = createAuthDb({
      user_profiles: [
        {
          id: 'usr_1',
          tenant_id: 'tnt_1',
          clerk_user_id: 'oidc:https://issuer.example.test:oidc_user_1',
          status: 'active',
        },
      ],
      organization_members: [
        {
          ...organizationMember('usr_1', 'org_pending', 'tnt_1'),
          accepted_at: null,
        },
      ],
    });

    await expect(
      createOidcAdapter(db).authenticateUser(request({ authorization: 'Bearer oidc_token' })),
    ).rejects.toThrow('Active OIDC organization does not map to Tixkit membership');
  });
});

describe('ClerkAuthService API key auth', () => {
  it('authenticates valid API keys, scopes them, and records last use', async () => {
    const rawKey = 'tk_valid_key';
    const { db, tables } = createAuthDb({
      api_keys: [
        {
          id: 'key_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          hashed_key: hash(rawKey),
          scopes: JSON.stringify(['events.read', 'orders.read']),
          brand_ids: JSON.stringify(['brd_1']),
          event_ids: JSON.stringify(['evt_1']),
          expires_at: new Date(Date.now() + 60_000),
          revoked_at: null,
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateApiKey(request({ authorization: `Bearer ${rawKey}` }));

    expect(result.principal).toMatchObject({
      type: 'api_key',
      id: 'key_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read', 'orders.read'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
    });
    expect(tables.api_keys[0].last_used_at).toBeInstanceOf(Date);
  });

  it('filters unknown API key permissions before constructing the principal', async () => {
    const rawKey = 'tk_filtered_scopes';
    const { db, tables } = createAuthDb({
      api_keys: [
        {
          id: 'key_filtered',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          hashed_key: hash(rawKey),
          scopes: JSON.stringify(['events.read', 'unknown.permission', 123, 'orders.write']),
          brand_ids: null,
          event_ids: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateApiKey(request({ authorization: `Bearer ${rawKey}` }));

    expect(result.principal.scopes).toEqual(['events.read', 'orders.write']);
    expect(tables.api_keys[0].last_used_at).toBeInstanceOf(Date);
  });

  it('rejects malformed persisted API key principal fields before recording use', async () => {
    const cases = [
      {
        name: 'malformed scopes JSON',
        row: { scopes: '{not-json', brand_ids: null, event_ids: null },
        message: 'Invalid API key scopes',
      },
      {
        name: 'non-array scopes JSON',
        row: { scopes: JSON.stringify('events.read'), brand_ids: null, event_ids: null },
        message: 'Invalid API key scopes',
      },
      {
        name: 'malformed brand_ids JSON',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: '{not-json',
          event_ids: null,
        },
        message: 'Invalid API key brand_ids',
      },
      {
        name: 'non-array brand_ids JSON',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: JSON.stringify('brd_1'),
          event_ids: null,
        },
        message: 'Invalid API key brand_ids',
      },
      {
        name: 'non-string brand_ids entry',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: JSON.stringify(['brd_1', 123]),
          event_ids: null,
        },
        message: 'Invalid API key brand_ids',
      },
      {
        name: 'malformed event_ids JSON',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: '{not-json',
        },
        message: 'Invalid API key event_ids',
      },
      {
        name: 'non-array event_ids JSON',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: JSON.stringify({ id: 'evt_1' }),
        },
        message: 'Invalid API key event_ids',
      },
      {
        name: 'non-string event_ids entry',
        row: {
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: JSON.stringify(['evt_1', false]),
        },
        message: 'Invalid API key event_ids',
      },
    ];

    for (const testCase of cases) {
      const keySuffix = testCase.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const rawKey = `tk_${keySuffix}`;
      const { db, tables } = createAuthDb({
        api_keys: [
          {
            id: `key_${keySuffix}`,
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            hashed_key: hash(rawKey),
            expires_at: null,
            revoked_at: null,
            ...testCase.row,
          },
        ],
      });
      const service = new ClerkAuthService('sk_test_auth', db as never);

      await expect(
        service.authenticateApiKey(request({ authorization: `Bearer ${rawKey}` })),
      ).rejects.toThrow(testCase.message);
      expect(tables.api_keys[0].last_used_at).toBeUndefined();
    }
  });

  it('rejects a previously valid API key immediately after revocation', async () => {
    const rawKey = 'tk_revoke_after_use';
    const { db, tables } = createAuthDb({
      api_keys: [
        {
          id: 'key_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          hashed_key: hash(rawKey),
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: null,
          expires_at: null,
          revoked_at: null,
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateApiKey(request({ authorization: `Bearer ${rawKey}` })),
    ).resolves.toMatchObject({
      principal: {
        type: 'api_key',
        id: 'key_1',
        scopes: ['events.read'],
      },
    });

    tables.api_keys[0].revoked_at = new Date();

    await expect(
      service.authenticateApiKey(request({ authorization: `Bearer ${rawKey}` })),
    ).rejects.toThrow('Invalid or revoked API key');
  });

  it('rejects missing, revoked, and expired API keys', async () => {
    const { db } = createAuthDb({
      api_keys: [
        {
          id: 'key_revoked',
          hashed_key: hash('tk_revoked'),
          revoked_at: new Date(),
          expires_at: null,
          scopes: '[]',
        },
        {
          id: 'key_expired',
          hashed_key: hash('tk_expired'),
          revoked_at: null,
          expires_at: new Date(Date.now() - 60_000),
          scopes: '[]',
        },
      ],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateApiKey(request({ authorization: 'Bearer bad_key' })),
    ).rejects.toThrow('Missing or invalid API key');
    await expect(
      service.authenticateApiKey(request({ authorization: 'Bearer tk_missing' })),
    ).rejects.toThrow('Invalid or revoked API key');
    await expect(
      service.authenticateApiKey(request({ authorization: 'Bearer tk_revoked' })),
    ).rejects.toThrow('Invalid or revoked API key');
    await expect(
      service.authenticateApiKey(request({ authorization: 'Bearer tk_expired' })),
    ).rejects.toThrow('API key has expired');
  });
});

describe('ClerkAuthService OAuth access-token auth', () => {
  it('authenticates valid OAuth access tokens and records use', async () => {
    const rawToken = 'tk_oat_valid';
    const { db, tables } = createAuthDb({
      oauth_access_tokens: [
        {
          id: 'oat_1',
          token_id: 'oat_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          oauth_application_id: 'oapp_1',
          token_hash: hash(rawToken),
          scopes: JSON.stringify(['events.read', 'orders.read']),
          expires_at: new Date(Date.now() + 60_000),
          revoked_at: null,
          app_status: 'active',
        },
      ],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);

    const result = await service.authenticateOAuthAccessToken(
      request({ authorization: `Bearer ${rawToken}` }),
    );

    expect(result.principal).toMatchObject({
      type: 'api_key',
      id: 'oat_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read', 'orders.read'],
    });
    expect(tables.oauth_access_tokens[0].updated_at).toBeInstanceOf(Date);
  });

  it('rejects malformed persisted OAuth access-token scopes before recording use', async () => {
    const cases = [
      { name: 'malformed JSON', scopes: '{not-json' },
      { name: 'JSON string', scopes: JSON.stringify('billing.write') },
      { name: 'JSON object', scopes: JSON.stringify({ scope: 'billing.write' }) },
      { name: 'non-string entry', scopes: JSON.stringify(['events.read', 123]) },
      { name: 'unknown permission', scopes: JSON.stringify(['events.read', 'unknown.permission']) },
    ];

    for (const testCase of cases) {
      const tokenSuffix = testCase.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      const rawToken = `tk_oat_${tokenSuffix}`;
      const { db, tables } = createAuthDb({
        oauth_access_tokens: [
          {
            id: `oat_${tokenSuffix}`,
            token_id: `oat_${tokenSuffix}`,
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            oauth_application_id: 'oapp_1',
            token_hash: hash(rawToken),
            scopes: testCase.scopes,
            expires_at: new Date(Date.now() + 60_000),
            revoked_at: null,
            app_status: 'active',
          },
        ],
      });
      const service = new ClerkAuthService('sk_test_auth', db as never);

      await expect(
        service.authenticateOAuthAccessToken(request({ authorization: `Bearer ${rawToken}` })),
      ).rejects.toThrow('Invalid OAuth token scopes');
      expect(tables.oauth_access_tokens[0].updated_at).toBeUndefined();
    }
  });
});

describe('ClerkAuthService agent access-token auth', () => {
  function joinedAgentToken(rawToken: string, overrides: Row = {}): Row {
    return {
      id: 'oat_agent_1',
      token_id: 'oat_agent_1',
      token_hash: hash(rawToken),
      expires_at: new Date(Date.now() + 60_000),
      token_tenant_id: 'tnt_1',
      token_subject_id: 'agt_1',
      token_subject_type: 'agent',
      token_revoked_at: null,
      app_tenant_id: 'tnt_1',
      app_subject_type: 'agent',
      app_agent_principal_id: 'agt_1',
      app_status: 'active',
      agent_principal_id: 'agt_1',
      agent_tenant_id: 'tnt_1',
      agent_state: 'active',
      ...overrides,
    };
  }

  it('maps the explicit agent subject without sponsor permissions or organization authority', async () => {
    const rawToken = 'tk_aat_valid';
    const { db, updates } = createAuthDb({
      oauth_access_tokens: [joinedAgentToken(rawToken)],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);

    const result = await service.authenticateAgentAccessToken(
      request({ authorization: `Bearer ${rawToken}` }),
    );

    expect(result.principal).toEqual({
      type: 'agent',
      id: 'agt_1',
      tenantId: 'tnt_1',
      organizationIds: [],
      scopes: [],
    });
    expect(updates).toHaveLength(1);
  });

  it.each([
    ['revoked token', { token_revoked_at: new Date() }],
    ['revoked app', { app_status: 'revoked' }],
    ['revoked principal', { agent_state: 'revoked' }],
    ['subject substitution', { app_agent_principal_id: 'agt_other' }],
    ['cross-tenant app', { app_tenant_id: 'tnt_other' }],
  ])('rejects an agent token after %s', async (_name, overrides) => {
    const rawToken = `tk_aat_${_name.replace(/\s+/gu, '_')}`;
    const { db, updates } = createAuthDb({
      oauth_access_tokens: [joinedAgentToken(rawToken, overrides)],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateAgentAccessToken(request({ authorization: `Bearer ${rawToken}` })),
    ).rejects.toThrow('Invalid, expired, or revoked agent access token');
    expect(updates).toHaveLength(0);
  });

  it('rejects an expired agent token using the database-time predicate', async () => {
    const rawToken = 'tk_aat_expired';
    const { db, updates } = createAuthDb({
      oauth_access_tokens: [
        joinedAgentToken(rawToken, { expires_at: new Date(Date.now() - 60_000) }),
      ],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);
    await expect(
      service.authenticateAgentAccessToken(request({ authorization: `Bearer ${rawToken}` })),
    ).rejects.toThrow('Invalid, expired, or revoked agent access token');
    expect(updates).toHaveLength(0);
  });
});

describe('ClerkAuthService scanner device auth', () => {
  it('authenticates active scanner devices and records last seen', async () => {
    const { db, tables, updates } = createAuthDb({
      scanner_devices: [
        {
          id: 'sd_internal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          device_id: 'sd_public',
          hashed_secret: hash('scanner_secret'),
          status: 'active',
          event_ids: JSON.stringify(['evt_1']),
          scopes: JSON.stringify(['checkins.read']),
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateScannerDevice(
      request({
        'x-device-id': 'sd_public',
        'x-device-secret': 'scanner_secret',
      }),
    );

    expect(result.principal).toMatchObject({
      type: 'mobile_device',
      id: 'sd_public',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['checkins.read'],
      eventIds: ['evt_1'],
    });
    expect(tables.scanner_devices[0].last_seen_at).toBeInstanceOf(Date);
    expect(updates).toEqual([
      {
        table: 'scanner_devices',
        values: { last_seen_at: tables.scanner_devices[0].last_seen_at },
        ids: ['sd_internal'],
      },
    ]);
  });

  it('defaults legacy scanner device rows without scopes to read/write', async () => {
    const { db } = createAuthDb({
      scanner_devices: [
        {
          id: 'sd_internal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          device_id: 'sd_public',
          hashed_secret: hash('scanner_secret'),
          status: 'active',
          event_ids: JSON.stringify(['evt_1']),
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateScannerDevice(
      request({
        'x-device-id': 'sd_public',
        'x-device-secret': 'scanner_secret',
      }),
    );

    expect(result.principal.scopes).toEqual(['checkins.read', 'checkins.write']);
  });

  it('fail-closes present malformed scanner device scopes', async () => {
    const { db } = createAuthDb({
      scanner_devices: [
        {
          id: 'sd_internal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          device_id: 'sd_public',
          hashed_secret: hash('scanner_secret'),
          status: 'active',
          event_ids: JSON.stringify(['evt_1']),
          scopes: 'not-json',
        },
      ],
    });

    const service = new ClerkAuthService('sk_test_auth', db as never);
    const result = await service.authenticateScannerDevice(
      request({
        'x-device-id': 'sd_public',
        'x-device-secret': 'scanner_secret',
      }),
    );

    expect(result.principal.scopes).toEqual([]);
    expect(result.principal.eventIds).toEqual(['evt_1']);
  });

  it('rejects missing, invalid, and revoked scanner devices', async () => {
    const { db } = createAuthDb({
      scanner_devices: [
        {
          id: 'sd_1',
          device_id: 'device_1',
          hashed_secret: hash('scanner_secret'),
          status: 'active',
        },
        {
          id: 'sd_revoked',
          device_id: 'device_revoked',
          hashed_secret: hash('scanner_secret'),
          status: 'revoked',
        },
      ],
    });
    const service = new ClerkAuthService('sk_test_auth', db as never);

    await expect(
      service.authenticateScannerDevice(request({ 'x-device-id': 'device_1' })),
    ).rejects.toThrow('Missing scanner device credentials');
    await expect(
      service.authenticateScannerDevice(
        request({ 'x-device-id': 'missing', 'x-device-secret': 'scanner_secret' }),
      ),
    ).rejects.toThrow('Invalid scanner device credentials');
    await expect(
      service.authenticateScannerDevice(
        request({ 'x-device-id': 'device_1', 'x-device-secret': 'wrong_secret' }),
      ),
    ).rejects.toThrow('Invalid scanner device credentials');
    await expect(
      service.authenticateScannerDevice(
        request({ 'x-device-id': 'device_revoked', 'x-device-secret': 'scanner_secret' }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe('authenticated /v1/me route dispatch', () => {
  it.each([
    ['staging', 'staging'],
    ['test', 'test'],
    ['preview', 'preview'],
    ['unset', undefined],
    ['production', 'production'],
  ])('rejects AUTH_PROVIDER=dev when nodeEnv is %s', (_, nodeEnv) => {
    const { db } = createAuthDb({});

    expect(() =>
      createAuthProvider(
        {
          provider: 'dev',
          nodeEnv: nodeEnv as string,
          clerkSecretKey: '',
        },
        db as never,
      ),
    ).toThrow('AUTH_PROVIDER=dev is only allowed when NODE_ENV=development');
  });

  it('returns 401 when no supported credentials are present outside local dev mode', async () => {
    const { db } = createAuthDb({});
    const service = new ClerkAuthService('sk_test_auth', db as never);
    const app = await setupAuthRouteApp(service);

    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('returns 401 outside development even if AUTH_PROVIDER=dev is set', async () => {
    const { db } = createAuthDb({});
    const service = new ClerkAuthService('', db as never);
    const originalNodeEnv = process.env.NODE_ENV;
    const originalAuthProvider = process.env.AUTH_PROVIDER;
    process.env.NODE_ENV = 'test';
    process.env.AUTH_PROVIDER = 'dev';
    const app = await setupAuthRouteApp(service);

    try {
      const response = await app.inject({ method: 'GET', url: '/v1/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalAuthProvider === undefined) {
        delete process.env.AUTH_PROVIDER;
      } else {
        process.env.AUTH_PROVIDER = originalAuthProvider;
      }
      await app.close();
    }
  });

  it('rejects cookie-only browser requests so admin mutations are not cookie-CSRF authenticated', async () => {
    const authService = {
      isLocalDevMode: vi.fn(() => false),
      authenticateLocalDev: vi.fn(),
      authenticateRequest: vi.fn(),
      authenticateApiKey: vi.fn(),
      authenticateScannerDevice: vi.fn(),
    } as unknown as ClerkAuthService;
    const app = await setupAuthRouteApp(authService);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        cookie: '__session=clerk_session_cookie; tixkit_csrf=csrf_cookie',
        origin: 'https://attacker.example.test',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect(authService.authenticateRequest).not.toHaveBeenCalled();
    expect(authService.authenticateApiKey).not.toHaveBeenCalled();
    expect(authService.authenticateScannerDevice).not.toHaveBeenCalled();
    expect(authService.authenticateLocalDev).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the deterministic principal in local dev mode without credentials', async () => {
    const { db } = createAuthDb({});
    const service = new ClerkAuthService('', db as never);
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const app = await setupAuthRouteApp(service);

    try {
      const response = await app.inject({ method: 'GET', url: '/v1/me' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: 'usr_dev_local',
        tenantId: DEV_TENANT_ID,
        organizationIds: [DEV_ORG_ID],
      });
      expect(response.json().permissions).toContain('billing.write');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      await app.close();
    }
  });

  it('returns the deterministic principal with AUTH_PROVIDER=dev even when Clerk keys are configured', async () => {
    const { db } = createAuthDb({});
    const service = createAuthProvider(
      {
        provider: 'dev',
        nodeEnv: 'development',
        clerkSecretKey: 'sk_test_auth',
      },
      db as never,
    );
    const app = await setupAuthRouteApp(service);

    try {
      const response = await app.inject({ method: 'GET', url: '/v1/me' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: 'usr_dev_local',
        tenantId: DEV_TENANT_ID,
        organizationIds: [DEV_ORG_ID],
      });
      expect(response.json().permissions).toContain('billing.write');
    } finally {
      await app.close();
    }
  });

  it('routes user, API key, OAuth, agent, and scanner credentials to the correct authenticator', async () => {
    const authService = {
      isLocalDevMode: vi.fn(() => false),
      authenticateLocalDev: vi.fn(),
      authenticateRequest: vi.fn(async () => ({
        principal: makePrincipal({ id: 'usr_clerk' }),
      })),
      authenticateApiKey: vi.fn(async () => ({
        principal: makePrincipal({ type: 'api_key', id: 'key_1' }),
      })),
      authenticateOAuthAccessToken: vi.fn(async () => ({
        principal: makePrincipal({ type: 'api_key', id: 'oat_1' }),
      })),
      authenticateAgentAccessToken: vi.fn(async () => ({
        principal: makePrincipal({
          type: 'agent',
          id: 'agt_1',
          organizationIds: [],
          scopes: [],
        }),
      })),
      authenticateScannerDevice: vi.fn(async () => ({
        principal: makePrincipal({
          type: 'mobile_device',
          id: 'sd_1',
          scopes: ['checkins.read', 'checkins.write'],
        }),
      })),
    } as unknown as ClerkAuthService;
    const app = await setupAuthRouteApp(authService);

    const clerk = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer clerk_session' },
    });
    const apiKey = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer tk_raw_key' },
    });
    const oauth = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer tk_oat_token' },
    });
    const agent = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer tk_aat_token' },
    });
    const scanner = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        'x-device-id': 'device_1',
        'x-device-secret': 'scanner_secret',
      },
    });

    expect(clerk.json().id).toBe('usr_clerk');
    expect(apiKey.json().id).toBe('key_1');
    expect(oauth.json().id).toBe('oat_1');
    expect(agent.json().id).toBe('agt_1');
    expect(scanner.json().id).toBe('sd_1');
    expect(authService.authenticateRequest).toHaveBeenCalledTimes(1);
    expect(authService.authenticateApiKey).toHaveBeenCalledTimes(1);
    expect(authService.authenticateOAuthAccessToken).toHaveBeenCalledTimes(1);
    expect(authService.authenticateAgentAccessToken).toHaveBeenCalledTimes(1);
    expect(authService.authenticateScannerDevice).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('preserves auth error messages from the selected authenticator', async () => {
    const authService = {
      isLocalDevMode: vi.fn(() => false),
      authenticateLocalDev: vi.fn(),
      authenticateRequest: vi.fn(async () => {
        throw new UnauthorizedError('User profile not found. Identity sync may be pending.');
      }),
      authenticateApiKey: vi.fn(),
      authenticateScannerDevice: vi.fn(),
    } as unknown as ClerkAuthService;
    const app = await setupAuthRouteApp(authService);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer clerk_session' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'User profile not found. Identity sync may be pending.',
    });
    await app.close();
  });
});
