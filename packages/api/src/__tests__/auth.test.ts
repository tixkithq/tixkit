import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClerkAuthService, DEV_TENANT_ID, DEV_ORG_ID } from '../auth/clerk.js';
import { ALL_PERMISSIONS, ForbiddenError, NotFoundError, UnauthorizedError } from '@tixkit/domain';
import type { Principal, Permission } from '@tixkit/domain';
import { requireAssignableScopes } from '../http/contracts.js';

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    clerkUserId: 'clerk_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1', 'org_2'],
    scopes: ['events.read', 'events.write', 'orders.read'] as Permission[],
    ...overrides,
  };
}

// Mock database for dev seed tests
function makeMockDb() {
  const tables: Record<string, Map<string, Record<string, unknown>>> = {};
  return {
    selectFrom(table: string) {
      return {
        selectAll() {
          return {
            where(col: string, _op: string, val: unknown) {
              return {
                executeTakeFirst: async () => {
                  const t = tables[table];
                  if (!t) return undefined;
                  for (const row of t.values()) {
                    if (row[col] === val) return row;
                  }
                  return undefined;
                },
                execute: async () => {
                  const t = tables[table];
                  if (!t) return [];
                  return Array.from(t.values()).filter((r) => r[col] === val);
                },
              };
            },
          };
        },
      };
    },
    insertInto(table: string) {
      return {
        values(data: Record<string, unknown>) {
          return {
            execute: async () => {
              if (!tables[table]) tables[table] = new Map();
              const id = (data as { id?: string }).id ?? `row_${Date.now()}`;
              tables[table].set(id, data);
              return undefined;
            },
          };
        },
      };
    },
  };
}

describe('ClerkAuthService static helpers', () => {
  describe('hasPermission', () => {
    it('returns true when principal has the permission', () => {
      const principal = makePrincipal();
      expect(ClerkAuthService.hasPermission(principal, 'events.read')).toBe(true);
    });

    it('returns false when principal lacks the permission', () => {
      const principal = makePrincipal();
      expect(ClerkAuthService.hasPermission(principal, 'refunds.write')).toBe(false);
    });
  });

  describe('requirePermission', () => {
    it('does not throw when principal has the permission', () => {
      const principal = makePrincipal();
      expect(() => ClerkAuthService.requirePermission(principal, 'events.write')).not.toThrow();
    });

    it('throws ForbiddenError when principal lacks the permission', () => {
      const principal = makePrincipal();
      expect(() => ClerkAuthService.requirePermission(principal, 'billing.write')).toThrow(
        ForbiddenError,
      );
    });
  });

  describe('requireTenant', () => {
    it('does not throw when tenant matches', () => {
      const principal = makePrincipal({ tenantId: 'tnt_1' });
      expect(() => ClerkAuthService.requireTenant(principal, 'tnt_1')).not.toThrow();
    });

    it('throws NotFoundError when tenant does not match', () => {
      const principal = makePrincipal({ tenantId: 'tnt_1' });
      expect(() => ClerkAuthService.requireTenant(principal, 'tnt_other')).toThrow(NotFoundError);
    });
  });

  describe('requireOrganizationScope', () => {
    it('does not throw when organization is in scope', () => {
      const principal = makePrincipal({ organizationIds: ['org_1', 'org_2'] });
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_1')).not.toThrow();
    });

    it('does not throw when organizationId is undefined', () => {
      const principal = makePrincipal();
      expect(() => ClerkAuthService.requireOrganizationScope(principal, undefined)).not.toThrow();
    });

    it('throws NotFoundError when organization is not in scope', () => {
      const principal = makePrincipal({ organizationIds: ['org_1'] });
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_other')).toThrow(
        NotFoundError,
      );
    });

    it('throws NotFoundError when principal has no organizations (fail-closed)', () => {
      const principal = makePrincipal({ organizationIds: [] });
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_any')).toThrow(
        NotFoundError,
      );
    });

    it('does not throw for system principal with no organizations', () => {
      const principal = makePrincipal({ organizationIds: [], type: 'system' });
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_any')).not.toThrow();
    });
  });

  describe('requireBrandScope', () => {
    it('does not throw when brand is in scope', () => {
      const principal = makePrincipal({ brandIds: ['brd_1', 'brd_2'] });
      expect(() => ClerkAuthService.requireBrandScope(principal, 'brd_1')).not.toThrow();
    });

    it('does not throw when brandId is undefined', () => {
      const principal = makePrincipal();
      expect(() => ClerkAuthService.requireBrandScope(principal, undefined)).not.toThrow();
    });

    it('throws NotFoundError when brand is not in scope', () => {
      const principal = makePrincipal({ brandIds: ['brd_1'] });
      expect(() => ClerkAuthService.requireBrandScope(principal, 'brd_other')).toThrow(
        NotFoundError,
      );
    });

    it('does not throw when principal has no brand restrictions', () => {
      const principal = makePrincipal({ brandIds: undefined });
      expect(() => ClerkAuthService.requireBrandScope(principal, 'brd_any')).not.toThrow();
    });
  });

  describe('requireEventScope', () => {
    it('does not throw when event is in scope', () => {
      const principal = makePrincipal({ eventIds: ['evt_1', 'evt_2'] });
      expect(() => ClerkAuthService.requireEventScope(principal, 'evt_1')).not.toThrow();
    });

    it('does not throw when eventId is undefined', () => {
      const principal = makePrincipal();
      expect(() => ClerkAuthService.requireEventScope(principal, undefined)).not.toThrow();
    });

    it('throws NotFoundError when event is not in scope', () => {
      const principal = makePrincipal({ eventIds: ['evt_1'] });
      expect(() => ClerkAuthService.requireEventScope(principal, 'evt_other')).toThrow(
        NotFoundError,
      );
    });
  });

  describe('requireResourceTenant', () => {
    it('does not throw when resource belongs to principal tenant', () => {
      const principal = makePrincipal({ tenantId: 'tnt_1' });
      const resource = { tenant_id: 'tnt_1' };
      expect(() =>
        ClerkAuthService.requireResourceTenant(principal, resource, 'Event', 'evt_1'),
      ).not.toThrow();
    });

    it('throws NotFoundError when resource belongs to different tenant', () => {
      const principal = makePrincipal({ tenantId: 'tnt_1' });
      const resource = { tenant_id: 'tnt_other' };
      expect(() =>
        ClerkAuthService.requireResourceTenant(principal, resource, 'Event', 'evt_1'),
      ).toThrow(NotFoundError);
    });

    it('throws NotFoundError when resource has no tenant_id', () => {
      const principal = makePrincipal({ tenantId: 'tnt_1' });
      const resource = { tenant_id: null };
      expect(() =>
        ClerkAuthService.requireResourceTenant(principal, resource, 'Event', 'evt_1'),
      ).toThrow(NotFoundError);
    });
  });

  describe('requireAssignableScopes', () => {
    it('allows delegating only scopes already held by the principal', () => {
      const principal = makePrincipal({ scopes: ['events.read', 'orders.read'] });
      expect(() => requireAssignableScopes(principal, ['events.read'])).not.toThrow();
    });

    it('rejects API key creation with escalated scopes', () => {
      const principal = makePrincipal({ scopes: ['events.read'] });
      expect(() => requireAssignableScopes(principal, ['events.read', 'refunds.write'])).toThrow(
        ForbiddenError,
      );
    });
  });
});

describe('ClerkAuthService local dev mode', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecretKey = process.env.CLERK_SECRET_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalSecretKey !== undefined) {
      process.env.CLERK_SECRET_KEY = originalSecretKey;
    } else {
      delete process.env.CLERK_SECRET_KEY;
    }
  });

  it('isLocalDevMode returns true when NODE_ENV is development and no Clerk secret key', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CLERK_SECRET_KEY;
    const service = new ClerkAuthService('', makeMockDb() as never);
    expect(service.isLocalDevMode()).toBe(true);
  });

  it('isLocalDevMode returns false when Clerk secret key is configured', () => {
    process.env.NODE_ENV = 'development';
    process.env.CLERK_SECRET_KEY = 'sk_test_example';
    const service = new ClerkAuthService('sk_test_example', makeMockDb() as never);
    expect(service.isLocalDevMode()).toBe(false);
  });

  it('isLocalDevMode returns false when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.CLERK_SECRET_KEY;
    const service = new ClerkAuthService('', makeMockDb() as never);
    expect(service.isLocalDevMode()).toBe(false);
  });

  it('isLocalDevMode returns false when NODE_ENV is production with Clerk key', () => {
    process.env.NODE_ENV = 'production';
    process.env.CLERK_SECRET_KEY = 'sk_live_example';
    const service = new ClerkAuthService('sk_live_example', makeMockDb() as never);
    expect(service.isLocalDevMode()).toBe(false);
  });

  it('authenticateLocalDev returns a principal with all permissions in dev mode', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CLERK_SECRET_KEY;
    const service = new ClerkAuthService('', makeMockDb() as never);
    const result = await service.authenticateLocalDev();
    expect(result.principal.type).toBe('user');
    expect(result.principal.tenantId).toBe(DEV_TENANT_ID);
    expect(result.principal.organizationIds).toEqual([DEV_ORG_ID]);
    expect(result.principal.scopes).toHaveLength(ALL_PERMISSIONS.length);
    expect(result.principal.scopes).toContain('events.read');
    expect(result.principal.scopes).toContain('events.write');
    expect(result.principal.scopes).toContain('refunds.write');
    expect(result.principal.scopes).toContain('billing.write');
  });

  it('authenticateLocalDev throws when not in dev mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CLERK_SECRET_KEY = 'sk_live_example';
    const service = new ClerkAuthService('sk_live_example', makeMockDb() as never);
    await expect(service.authenticateLocalDev()).rejects.toThrow(UnauthorizedError);
  });

  it('authenticateLocalDev throws when Clerk secret key is set even in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.CLERK_SECRET_KEY = 'sk_test_example';
    const service = new ClerkAuthService('sk_test_example', makeMockDb() as never);
    await expect(service.authenticateLocalDev()).rejects.toThrow(UnauthorizedError);
  });

  it('dev principal has correct deterministic IDs', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CLERK_SECRET_KEY;
    const service = new ClerkAuthService('', makeMockDb() as never);
    const result = await service.authenticateLocalDev();
    expect(result.principal.tenantId).toBe('tnt_dev_local');
    expect(result.principal.organizationIds).toEqual(['org_dev_local']);
    expect(result.principal.id).toBe('usr_dev_local');
  });

  it('ensureDevSeed is a no-op when not in dev mode', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CLERK_SECRET_KEY = 'sk_live_example';
    const mockDb = makeMockDb();
    const service = new ClerkAuthService('sk_live_example', mockDb as never);
    await service.ensureDevSeed();
    // Should not throw and should not insert anything
  });

  it('ensureDevSeed creates tenant, org, and brand when in dev mode', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CLERK_SECRET_KEY;
    const mockDb = makeMockDb();
    const service = new ClerkAuthService('', mockDb as never);
    await service.ensureDevSeed();
    // Running again should be idempotent
    await service.ensureDevSeed();
  });

  it('dev principal passes tenant isolation checks', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CLERK_SECRET_KEY;
    const service = new ClerkAuthService('', makeMockDb() as never);
    const { principal } = await service.authenticateLocalDev();

    // Dev principal should pass tenant check for its own tenant
    expect(() => ClerkAuthService.requireTenant(principal, DEV_TENANT_ID)).not.toThrow();

    // Dev principal should fail tenant check for a different tenant
    expect(() => ClerkAuthService.requireTenant(principal, 'tnt_other')).toThrow(NotFoundError);

    // Dev principal should have all permissions
    expect(() => ClerkAuthService.requirePermission(principal, 'events.write')).not.toThrow();
    expect(() => ClerkAuthService.requirePermission(principal, 'refunds.write')).not.toThrow();
    expect(() => ClerkAuthService.requirePermission(principal, 'billing.write')).not.toThrow();
  });
});
