import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthProvider, AuthProviderName, AuthProviderResult } from '@tixkit/shared';
import type { Database } from '@tixkit/db';
import type { Permission, Principal, Ulid } from '@tixkit/domain';
import { ForbiddenError, UnauthorizedError } from '@tixkit/domain';
import { ClerkAuthService, createLocalDevPrincipal } from './clerk.js';

export type AuthProviderConfig = {
  provider: AuthProviderName;
  nodeEnv: string;
  clerkSecretKey: string;
  oidcIssuerUrl?: string;
  oidcAudience?: string;
};

type OidcClaims = {
  sub?: string;
  email?: string;
  org_id?: string;
  organization_id?: string;
};

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

export class ClerkAdapter implements AuthProvider<FastifyRequest> {
  readonly name: AuthProviderName = 'clerk';

  constructor(private readonly clerk: ClerkAuthService) {}

  isLocalDevMode(): boolean {
    return this.clerk.isLocalDevMode();
  }

  authenticateUser(request: FastifyRequest): Promise<AuthProviderResult> {
    return this.clerk.authenticateRequest(request);
  }

  authenticateApiKey(request: FastifyRequest): Promise<AuthProviderResult> {
    return this.clerk.authenticateApiKey(request);
  }

  authenticateOAuthAccessToken(request: FastifyRequest): Promise<AuthProviderResult> {
    return this.clerk.authenticateOAuthAccessToken(request);
  }

  authenticateScannerDevice(request: FastifyRequest): Promise<AuthProviderResult> {
    return this.clerk.authenticateScannerDevice(request);
  }

  authenticateLocalDev(): Promise<AuthProviderResult> {
    return this.clerk.authenticateLocalDev();
  }
}

export class DevAdapter extends ClerkAdapter {
  readonly name = 'dev' as const;

  constructor(clerk: ClerkAuthService, nodeEnv: string) {
    super(clerk);
    if (nodeEnv !== 'development') {
      throw new Error('AUTH_PROVIDER=dev is only allowed when NODE_ENV=development');
    }
  }

  override isLocalDevMode(): boolean {
    return true;
  }

  override authenticateUser(): Promise<AuthProviderResult> {
    return this.authenticateLocalDev();
  }

  override async authenticateLocalDev(): Promise<AuthProviderResult> {
    return { principal: createLocalDevPrincipal() };
  }
}

export class OIDCAdapter extends ClerkAdapter {
  readonly name = 'oidc' as const;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    clerk: ClerkAuthService,
    private readonly db: Database,
    input: { issuerUrl?: string; audience?: string },
  ) {
    super(clerk);
    if (!input.issuerUrl || !input.audience) {
      throw new Error('AUTH_PROVIDER=oidc requires OIDC_ISSUER_URL and OIDC_AUDIENCE');
    }
    this.issuer = input.issuerUrl.replace(/\/$/, '');
    this.audience = input.audience;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  override isLocalDevMode(): boolean {
    return false;
  }

  override async authenticateUser(request: FastifyRequest): Promise<AuthProviderResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
    });
    const claims = payload as OidcClaims;
    if (!claims.sub) {
      throw new UnauthorizedError('OIDC token missing subject');
    }

    const externalSubject = `oidc:${this.issuer}:${claims.sub}`;
    const profiles = await this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('clerk_user_id', '=', externalSubject)
      .execute();

    if (profiles.length === 0) {
      throw new UnauthorizedError('OIDC user profile not found. Identity sync may be pending.');
    }

    const requestedOrg = claims.org_id ?? claims.organization_id;
    let userProfile = profiles[0];
    if (requestedOrg) {
      const membership = await this.db
        .selectFrom('organization_members')
        .selectAll()
        .where('organization_id', '=', requestedOrg)
        .where(
          'user_id',
          'in',
          profiles.map((profile) => profile.id),
        )
        .executeTakeFirst();
      const matchedProfile = membership
        ? profiles.find((profile) => profile.id === membership.user_id)
        : undefined;
      if (!matchedProfile) {
        throw new UnauthorizedError('Active OIDC organization does not map to Tixkit membership');
      }
      userProfile = matchedProfile;
    } else if (profiles.length > 1) {
      const headerTenant = request.headers['x-tenant-id'];
      const matchedProfile =
        typeof headerTenant === 'string'
          ? profiles.find((profile) => profile.tenant_id === headerTenant)
          : undefined;
      if (!matchedProfile) {
        throw new UnauthorizedError('Ambiguous tenant for OIDC user; specify X-Tenant-Id header');
      }
      userProfile = matchedProfile;
    }

    if (userProfile.status === 'suspended') {
      throw new ForbiddenError('User account is suspended');
    }

    const [grants, memberships] = await Promise.all([
      this.db
        .selectFrom('permission_grants')
        .selectAll()
        .where('tenant_id', '=', userProfile.tenant_id)
        .where('principal_type', '=', 'user')
        .where('principal_id', '=', userProfile.id)
        .execute(),
      this.db
        .selectFrom('organization_members')
        .selectAll()
        .where('user_id', '=', userProfile.id)
        .execute(),
    ]);

    const principal: Principal = {
      type: 'user',
      id: userProfile.id,
      clerkUserId: externalSubject,
      tenantId: userProfile.tenant_id,
      organizationIds: memberships.map((membership) => membership.organization_id as Ulid),
      scopes: grants.map((grant) => grant.permission as Permission),
      brandIds: grantScopeIds(grants, 'brand'),
      eventIds: grantScopeIds(grants, 'event'),
    };

    return { principal, externalUserId: externalSubject };
  }
}

export function createAuthProvider(
  config: AuthProviderConfig,
  db: Database,
): AuthProvider<FastifyRequest> {
  const clerk = new ClerkAuthService(config.clerkSecretKey, db);
  if (config.provider === 'dev') return new DevAdapter(clerk, config.nodeEnv);
  if (config.provider === 'oidc') {
    return new OIDCAdapter(clerk, db, {
      issuerUrl: config.oidcIssuerUrl,
      audience: config.oidcAudience,
    });
  }
  return new ClerkAdapter(clerk);
}
