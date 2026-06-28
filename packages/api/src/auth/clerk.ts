import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '@clerk/backend';
import type { AuthProvider } from '@tixkit/shared';
import type { Principal, Permission, Ulid } from '@tixkit/domain';
import { UnauthorizedError, ForbiddenError, NotFoundError } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthResult = {
  principal: Principal;
  clerkUserId?: string;
};

export type AuthConfig = {
  secretKey: string;
};

type ClerkSessionClaims = {
  sub: string;
  org_id?: string;
  email?: string;
  email_address?: string;
  first_name?: string;
  last_name?: string;
  given_name?: string;
  family_name?: string;
};

/**
 * Deterministic IDs for the local dev principal and seed data.
 * These are only used when NODE_ENV === 'development' and no Clerk secret
 * key is configured. Production never activates this path.
 */
export const DEV_TENANT_ID = 'tnt_dev_local';
export const DEV_ORG_ID = 'org_dev_local';
export const DEV_BRAND_ID = 'brd_dev_local';

export const ALL_PERMISSIONS: Permission[] = [
  'events.read',
  'events.write',
  'tickets.write',
  'orders.read',
  'orders.write',
  'refunds.write',
  'attendees.read',
  'attendees.write',
  'checkins.read',
  'checkins.write',
  'messages.write',
  'reports.read',
  'settings.write',
  'developers.write',
  'billing.write',
];

function grantScopeIds(
  grants: Array<{ scope_type?: unknown; scope_id?: unknown }>,
  scopeType: 'brand' | 'event',
): Ulid[] | undefined {
  const ids = [
    ...new Set(
      grants
        .filter((grant) => grant.scope_type === scopeType && typeof grant.scope_id === 'string')
        .map((grant) => grant.scope_id as Ulid),
    ),
  ];

  return ids.length > 0 ? ids : undefined;
}

export class ClerkAuthService {
  private config: AuthConfig;

  constructor(
    secretKey: string,
    private db: Database,
  ) {
    this.config = { secretKey };
  }

  private isDevelopmentMode(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  /**
   * Returns true when the API should allow unauthenticated local dev access.
   * This is only active when NODE_ENV is 'development' and no Clerk secret
   * key is configured. Production deployments with a Clerk secret key always
   * require real authentication.
   */
  isLocalDevMode(): boolean {
    return this.isDevelopmentMode() && !this.config.secretKey;
  }

  /**
   * Returns a deterministic dev principal with all permissions. Only callable
   * when `isLocalDevMode()` returns true.
   */
  async authenticateLocalDev(): Promise<AuthResult> {
    if (!this.isLocalDevMode()) {
      throw new UnauthorizedError('Local dev mode is not active');
    }

    return { principal: createLocalDevPrincipal() };
  }

  /**
   * Seeds a dev tenant, organization, and brand if they don't already exist.
   * Called at API startup in development so the admin dashboard has the
   * minimum context needed to create events, with or without Clerk enabled.
   */
  async ensureDevSeed(): Promise<void> {
    if (!this.isDevelopmentMode()) return;

    const existingTenant = await this.db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', DEV_TENANT_ID)
      .executeTakeFirst();

    if (!existingTenant) {
      const now = new Date();
      await this.db
        .insertInto('tenants')
        .values({
          id: DEV_TENANT_ID,
          name: 'Local Development',
          status: 'active',
          plan: 'free',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const existingOrg = await this.db
      .selectFrom('organizations')
      .selectAll()
      .where('id', '=', DEV_ORG_ID)
      .executeTakeFirst();

    if (!existingOrg) {
      const now = new Date();
      await this.db
        .insertInto('organizations')
        .values({
          id: DEV_ORG_ID,
          tenant_id: DEV_TENANT_ID,
          name: 'Tixkit Dev',
          slug: 'tixkit-dev',
          clerk_organization_id: null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const existingBrand = await this.db
      .selectFrom('brands')
      .selectAll()
      .where('id', '=', DEV_BRAND_ID)
      .executeTakeFirst();

    if (!existingBrand) {
      const now = new Date();
      await this.db
        .insertInto('brands')
        .values({
          id: DEV_BRAND_ID,
          tenant_id: DEV_TENANT_ID,
          organization_id: DEV_ORG_ID,
          name: 'Tixkit Dev',
          slug: 'tixkit-dev',
          status: 'active',
          theme: JSON.stringify({ primaryColor: '#6366f1' }),
          legal_urls: JSON.stringify({}),
          white_label: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  }

  /**
   * In local development with Clerk enabled, webhooks are often not configured.
   * If Clerk has already verified the session, auto-provision a deterministic
   * Tixkit profile so the dashboard does not depend on external webhook
   * delivery. Production still fails closed when identity sync is missing.
   */
  private async ensureDevelopmentClerkProfile(claims: ClerkSessionClaims) {
    if (!this.isDevelopmentMode()) {
      throw new UnauthorizedError('User profile not found. Identity sync may be pending.');
    }

    await this.ensureDevSeed();

    const suffix = createHash('sha256').update(claims.sub).digest('hex').slice(0, 16);
    const userId = `usr_dev_${suffix}`;
    const now = new Date();

    const existing = await this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('tenant_id', '=', DEV_TENANT_ID)
      .where('clerk_user_id', '=', claims.sub)
      .executeTakeFirst();

    if (existing) return existing;

    const email =
      claims.email ??
      claims.email_address ??
      `${claims.sub.replace(/[^a-zA-Z0-9._-]/g, '-')}@clerk.local`;

    await this.db
      .insertInto('user_profiles')
      .values({
        id: userId,
        tenant_id: DEV_TENANT_ID,
        clerk_user_id: claims.sub,
        email,
        first_name: claims.first_name ?? claims.given_name ?? null,
        last_name: claims.last_name ?? claims.family_name ?? null,
        avatar_url: null,
        status: 'active',
        last_seen_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await this.db
      .insertInto('organization_members')
      .values({
        id: `mem_dev_${suffix}`,
        tenant_id: DEV_TENANT_ID,
        organization_id: DEV_ORG_ID,
        user_id: userId,
        role: 'owner',
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await Promise.all(
      ALL_PERMISSIONS.map((permission) => {
        const grantSuffix = createHash('sha256')
          .update(`${userId}:${permission}`)
          .digest('hex')
          .slice(0, 20);
        return this.db
          .insertInto('permission_grants')
          .values({
            id: `pgr_${grantSuffix}`,
            tenant_id: DEV_TENANT_ID,
            principal_type: 'user',
            principal_id: userId,
            permission,
            scope_type: 'organization',
            scope_id: DEV_ORG_ID,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }),
    );

    return this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  }

  /**
   * Verifies a Clerk session JWT and maps it to a Tixkit Principal.
   */
  async authenticateRequest(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);

    try {
      const claims = await this.verifyToken(token);
      const { sub: clerkUserId, org_id } = claims;

      // Resolve tenant safely for users that may belong to multiple tenants.
      // Priority: active Clerk org -> mapped tenant; else explicit X-Tenant-Id
      // header; else the single profile if unambiguous.
      let profiles = await this.db
        .selectFrom('user_profiles')
        .selectAll()
        .where('clerk_user_id', '=', clerkUserId)
        .execute();

      if (profiles.length === 0) {
        const devProfile = await this.ensureDevelopmentClerkProfile(claims);
        profiles = devProfile ? [devProfile] : [];
      }

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
        } else {
          throw new UnauthorizedError('Active organization does not map to a Tixkit tenant');
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
      const brandIds = grantScopeIds(grants, 'brand');
      const eventIds = grantScopeIds(grants, 'event');

      const principal: Principal = {
        type: 'user',
        id: userProfile.id,
        clerkUserId,
        clerkOrganizationId: org_id,
        tenantId: userProfile.tenant_id,
        organizationIds,
        scopes,
        brandIds,
        eventIds,
      };

      return { principal, clerkUserId };
    } catch (err) {
      if (err instanceof UnauthorizedError || err instanceof ForbiddenError) throw err;
      throw new UnauthorizedError('Token verification failed');
    }
  }

  private async verifyToken(token: string): Promise<ClerkSessionClaims> {
    if (!this.config.secretKey) {
      throw new UnauthorizedError('Clerk secret key is not configured');
    }

    try {
      const result = await verifyToken(token, { secretKey: this.config.secretKey });
      const verified = result as Partial<ClerkSessionClaims> & {
        data?: Partial<ClerkSessionClaims>;
        errors?: Array<{ message: string }>;
      };
      if (verified.errors && verified.errors.length > 0) {
        throw new UnauthorizedError(verified.errors[0].message);
      }
      const payload = verified.data ?? verified;
      if (!payload || !payload.sub) {
        throw new UnauthorizedError('Token missing subject');
      }
      return { ...payload, sub: payload.sub };
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      throw new UnauthorizedError('Token verification failed');
    }
  }

  /**
   * Authenticates an API key and maps it to a Tixkit Principal.
   */
  async authenticateApiKey(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer tk_')) {
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
    const brandIds = apiKey.brand_ids
      ? (JSON.parse(apiKey.brand_ids as string) as Ulid[])
      : undefined;
    const eventIds = apiKey.event_ids
      ? (JSON.parse(apiKey.event_ids as string) as Ulid[])
      : undefined;

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

  async authenticateOAuthAccessToken(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer tk_oat_')) {
      throw new UnauthorizedError('Missing or invalid OAuth access token');
    }

    const rawToken = authHeader.substring(7);
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const accessToken = await this.db
      .selectFrom('oauth_access_tokens')
      .innerJoin(
        'oauth_applications',
        'oauth_applications.id',
        'oauth_access_tokens.oauth_application_id',
      )
      .select([
        'oauth_access_tokens.id as token_id',
        'oauth_access_tokens.tenant_id as tenant_id',
        'oauth_access_tokens.organization_id as organization_id',
        'oauth_access_tokens.scopes as scopes',
        'oauth_access_tokens.expires_at as expires_at',
        'oauth_access_tokens.revoked_at as revoked_at',
        'oauth_applications.status as app_status',
      ])
      .where('oauth_access_tokens.token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (!accessToken || accessToken.revoked_at || accessToken.app_status !== 'active') {
      throw new UnauthorizedError('Invalid or revoked OAuth access token');
    }
    if (new Date(accessToken.expires_at) <= new Date()) {
      throw new UnauthorizedError('OAuth access token has expired');
    }

    await this.db
      .updateTable('oauth_access_tokens')
      .set({ updated_at: new Date() })
      .where('id', '=', accessToken.token_id)
      .execute();

    const scopes = JSON.parse(accessToken.scopes as string) as Permission[];
    return {
      principal: {
        type: 'api_key',
        id: accessToken.token_id,
        tenantId: accessToken.tenant_id,
        organizationIds: [accessToken.organization_id],
        scopes,
      },
    };
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
      id: device.device_id,
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
    if (
      principal.brandIds &&
      principal.brandIds.length > 0 &&
      !principal.brandIds.includes(brandId as Ulid)
    ) {
      throw new NotFoundError('Brand', brandId);
    }
  }

  /**
   * Requires the principal to have access to the requested event.
   */
  static requireEventScope(principal: Principal, eventId?: string): void {
    if (!eventId) return;
    if (
      principal.eventIds &&
      principal.eventIds.length > 0 &&
      !principal.eventIds.includes(eventId as Ulid)
    ) {
      throw new NotFoundError('Event', eventId);
    }
  }

  /**
   * Verifies that a loaded resource belongs to the principal's tenant.
   */
  static requireResourceTenant(
    principal: Principal,
    resource: { tenant_id?: string | null },
    resourceName: string,
    resourceId: string,
  ): void {
    if (!resource.tenant_id || resource.tenant_id !== principal.tenantId) {
      throw new NotFoundError(resourceName, resourceId);
    }
  }
}

export function createLocalDevPrincipal(): Principal {
  return {
    type: 'user',
    id: 'usr_dev_local',
    clerkUserId: undefined,
    tenantId: DEV_TENANT_ID,
    organizationIds: [DEV_ORG_ID],
    scopes: ALL_PERMISSIONS,
  };
}

type AuthMiddlewareProvider =
  | AuthProvider<FastifyRequest>
  | (ClerkAuthService & {
      authenticateUser?: AuthProvider<FastifyRequest>['authenticateUser'];
    });

export function createAuthMiddleware(authService: AuthMiddlewareProvider) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;

    try {
      if (request.headers['x-device-id']) {
        const result = await authService.authenticateScannerDevice(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer tk_oat_')) {
        const result = await authService.authenticateOAuthAccessToken(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer tk_')) {
        const result = await authService.authenticateApiKey(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer ')) {
        const authenticateUser =
          authService.authenticateUser ??
          (
            authService as unknown as {
              authenticateRequest: AuthProvider<FastifyRequest>['authenticateUser'];
            }
          ).authenticateRequest;
        const result = await authenticateUser.call(authService, request);
        request.principal = result.principal;
      } else if (authService.isLocalDevMode()) {
        // Local dev mode: allow unauthenticated requests when no Clerk secret
        // key is configured and NODE_ENV is 'development'. Production never
        // reaches this branch because isLocalDevMode() returns false.
        const result = await authService.authenticateLocalDev();
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
