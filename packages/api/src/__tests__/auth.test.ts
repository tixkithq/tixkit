import { describe, it, expect } from 'vitest';
import { ClerkAuthService } from '../auth/clerk.js';
import { ForbiddenError, NotFoundError } from '@gatekit/domain';
import type { Principal, Permission } from '@gatekit/domain';
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
      expect(() => ClerkAuthService.requirePermission(principal, 'billing.write')).toThrow(ForbiddenError);
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
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_other')).toThrow(NotFoundError);
    });

    it('throws NotFoundError when principal has no organizations (fail-closed)', () => {
      const principal = makePrincipal({ organizationIds: [] });
      expect(() => ClerkAuthService.requireOrganizationScope(principal, 'org_any')).toThrow(NotFoundError);
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
      expect(() => ClerkAuthService.requireBrandScope(principal, 'brd_other')).toThrow(NotFoundError);
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
      expect(() => ClerkAuthService.requireEventScope(principal, 'evt_other')).toThrow(NotFoundError);
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
      expect(() => requireAssignableScopes(principal, ['events.read', 'refunds.write'])).toThrow(ForbiddenError);
    });
  });
});
