import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '@clerk/backend';
import type { Principal, Permission, Ulid } from '@gatekit/domain';
import { UnauthorizedError, ForbiddenError, NotFoundError } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthResult = {
  principal: Principal;
  clerkUserId?: string;
};

export type AuthConfig = {
  secretKey: string;
};

export class ClerkAuthService {
  private config: AuthConfig;

  constructor(
    secretKey: string,
    private db: Database,
  ) {
    this.config = { secretKey };
  }

  /**
   * Verifies a Clerk session JWT and maps it to a GateKit Principal.
   */
  async authenticateRequest(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);

    try {
      const { sub: clerkUserId, org_id } = await this.verifyToken(token);

      // Resolve tenant safely for users that may belong to multiple tenants.
      // Priority: active Clerk org -> mapped tenant; else explicit X-Tenant-Id
      // header; else the single profile if unambiguous.
      const profiles = await this.db
        .selectFrom('user_profiles')
        .selectAll()
        .where('clerk_user_id', '=', clerkUserId)
        .execute();

      if (profiles.length === 0) {
        throw new UnauthorizedError('User profile not found. Identity sync may be pending.');
      }

      let userProfile = profiles[0];

      if (org_id) {
        const org = await this.db
          .selectFrom('organizations')
          .selectAll()
          .where('clerk_organization_id', '=', org_id)
          .executeTakeFirst();
        const match = org ? profiles.find((p) => p.tenant_id === org.tenant_id) : undefined;
        if (match) {
          userProfile = match;
        } else if (profiles.length > 1) {
          throw new UnauthorizedError('Active organization does not map to a GateKit tenant');
        }
      } else if (profiles.length > 1) {
        const headerTenant = request.headers['x-tenant-id'];
        const match =
          typeof headerTenant === 'string'
            ? profiles.find((p) => p.tenant_id === headerTenant)
            : undefined;
        if (!match) {
          throw new UnauthorizedError(
            'Ambiguous tenant for user; specify an active organization or X-Tenant-Id header',
          );
        }
        userProfile = match;
      }

      if (userProfile.status === 'suspended') {
        throw new ForbiddenError('User account is suspended');
      }

      // Get permission grants
      const grants = await this.db
        .selectFrom('permission_grants')
        .selectAll()
        .where('tenant_id', '=', userProfile.tenant_id)
        .where('principal_type', '=', 'user')
        .where('principal_id', '=', userProfile.id)
        .execute();

      const scopes = grants.map((g) => g.permission as Permission);

      // Get organizations the user belongs to
      const memberships = await this.db
        .selectFrom('organization_members')
        .selectAll()
        .where('user_id', '=', userProfile.id)
        .execute();

      const organizationIds = memberships.map((m) => m.organization_id as Ulid);

      const principal: Principal = {
        type: 'user',
        id: userProfile.id,
        clerkUserId,
        clerkOrganizationId: org_id,
        tenantId: userProfile.tenant_id,
        organizationIds,
        scopes,
      };

      return { principal, clerkUserId };
    } catch (err) {
      if (err instanceof UnauthorizedError || err instanceof ForbiddenError) throw err;
      throw new UnauthorizedError('Token verification failed');
    }
  }

  private async verifyToken(token: string): Promise<{
    sub: string;
    org_id?: string;
  }> {
    if (!this.config.secretKey) {
      throw new UnauthorizedError('Clerk secret key is not configured');
    }

    try {
      const result = await verifyToken(token, { secretKey: this.config.secretKey });
      const verified = result as { sub?: string; org_id?: string; data?: { sub?: string; org_id?: string }; errors?: Array<{ message: string }> };
      if (verified.errors && verified.errors.length > 0) {
        throw new UnauthorizedError(verified.errors[0].message);
      }
      const payload = verified.data ?? verified;
      if (!payload || !payload.sub) {
        throw new UnauthorizedError('Token missing subject');
      }
      return {
        sub: payload.sub,
        org_id: payload.org_id as string | undefined,
      };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      throw new UnauthorizedError('Token verification failed');
    }
  }

  /**
   * Authenticates an API key and maps it to a GateKit Principal.
   */
  async authenticateApiKey(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer gk_')) {
      throw new UnauthorizedError('Missing or invalid API key');
    }

    const rawKey = authHeader.substring(7);
    const hashedKey = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.db
      .selectFrom('api_keys')
      .selectAll()
      .where('hashed_key', '=', hashedKey)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    if (!apiKey) {
      throw new UnauthorizedError('Invalid or revoked API key');
    }

    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      throw new UnauthorizedError('API key has expired');
    }

    // Update last used
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', apiKey.id)
      .execute();

    const scopes = JSON.parse(apiKey.scopes as string) as Permission[];
    const brandIds = apiKey.brand_ids ? (JSON.parse(apiKey.brand_ids as string) as Ulid[]) : undefined;
    const eventIds = apiKey.event_ids ? (JSON.parse(apiKey.event_ids as string) as Ulid[]) : undefined;

    const principal: Principal = {
      type: 'api_key',
      id: apiKey.id,
      tenantId: apiKey.tenant_id,
      organizationIds: [apiKey.organization_id],
      scopes,
      brandIds,
      eventIds,
    };

    return { principal };
  }

  /**
   * Authenticates a mobile scanner device via the `X-Device-Id` /
   * `X-Device-Secret` headers and maps it to a check-in scoped Principal.
   * Revoked devices are rejected.
   */
  async authenticateScannerDevice(request: FastifyRequest): Promise<AuthResult> {
    const deviceId = request.headers['x-device-id'];
    const deviceSecret = request.headers['x-device-secret'];
    if (typeof deviceId !== 'string' || typeof deviceSecret !== 'string') {
      throw new UnauthorizedError('Missing scanner device credentials');
    }

    const hashedSecret = createHash('sha256').update(deviceSecret).digest('hex');
    const device = await this.db
      .selectFrom('scanner_devices')
      .selectAll()
      .where('device_id', '=', deviceId)
      .executeTakeFirst();

    if (!device) {
      throw new UnauthorizedError('Invalid scanner device credentials');
    }

    // Constant-time comparison to prevent timing side-channel attacks.
    const a = Buffer.from(device.hashed_secret, 'hex');
    const b = Buffer.from(hashedSecret, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedError('Invalid scanner device credentials');
    }
    if (device.status !== 'active') {
      throw new ForbiddenError('Scanner device has been revoked');
    }

    await this.db
      .updateTable('scanner_devices')
      .set({ last_seen_at: new Date() })
      .where('id', '=', device.id)
      .execute();

    const eventIds = device.event_ids
      ? (JSON.parse(device.event_ids as string) as Ulid[])
      : undefined;

    const principal: Principal = {
      type: 'mobile_device',
      id: device.id,
      tenantId: device.tenant_id,
      organizationIds: [device.organization_id],
      scopes: ['checkins.read', 'checkins.write'],
      eventIds: eventIds && eventIds.length > 0 ? eventIds : undefined,
    };

    return { principal };
  }

  /**
   * Checks if a principal has a specific permission.
   */
  static hasPermission(principal: Principal, permission: Permission): boolean {
    return principal.scopes.includes(permission);
  }

  /**
   * Requires a specific permission or throws.
   */
  static requirePermission(principal: Principal, permission: Permission): void {
    if (!ClerkAuthService.hasPermission(principal, permission)) {
      throw new ForbiddenError(`Missing required permission: ${permission}`);
    }
  }

  /**
   * Requires the principal to belong to the requested tenant.
   */
  static requireTenant(principal: Principal, tenantId: string): void {
    if (principal.tenantId !== tenantId) {
      throw new NotFoundError('Tenant', tenantId);
    }
  }

  /**
   * Requires the principal to have access to the requested organization.
   * Fails closed when the principal has no organization memberships, unless
   * the principal is a platform/system admin with an explicit platform scope.
   */
  static requireOrganizationScope(principal: Principal, organizationId?: string): void {
    if (!organizationId) return;

    // Platform/system admins with explicit platform scope bypass org checks.
    if (principal.type === 'system') return;

    // Fail closed: a principal with no org memberships cannot access any org.
    if (principal.organizationIds.length === 0) {
      throw new NotFoundError('Organization', organizationId);
    }

    if (!principal.organizationIds.includes(organizationId as Ulid)) {
      throw new NotFoundError('Organization', organizationId);
    }
  }

  /**
   * Requires the principal to have access to the requested brand.
   */
  static requireBrandScope(principal: Principal, brandId?: string): void {
    if (!brandId) return;
    if (principal.brandIds && principal.brandIds.length > 0 && !principal.brandIds.includes(brandId as Ulid)) {
      throw new NotFoundError('Brand', brandId);
    }
  }

  /**
   * Requires the principal to have access to the requested event.
   */
  static requireEventScope(principal: Principal, eventId?: string): void {
    if (!eventId) return;
    if (principal.eventIds && principal.eventIds.length > 0 && !principal.eventIds.includes(eventId as Ulid)) {
      throw new NotFoundError('Event', eventId);
    }
  }

  /**
   * Verifies that a loaded resource belongs to the principal's tenant.
   */
  static requireResourceTenant(principal: Principal, resource: { tenant_id?: string | null }, resourceName: string, resourceId: string): void {
    if (!resource.tenant_id || resource.tenant_id !== principal.tenantId) {
      throw new NotFoundError(resourceName, resourceId);
    }
  }
}

export function createAuthMiddleware(authService: ClerkAuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    try {
      if (request.headers['x-device-id']) {
        const result = await authService.authenticateScannerDevice(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer gk_')) {
        const result = await authService.authenticateApiKey(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer ')) {
        const result = await authService.authenticateRequest(request);
        request.principal = result.principal;
      } else {
        throw new UnauthorizedError();
      }
    } catch (err) {
      const error = err as Error;
      const code = err instanceof UnauthorizedError ? 'UNAUTHORIZED' : 'FORBIDDEN';
      const statusCode = err instanceof UnauthorizedError ? 401 : 403;
      return reply.status(statusCode).send({
        error: {
          code,
          message: error.message,
          requestId: request.id,
        },
      });
    }
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
