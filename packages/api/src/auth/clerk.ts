import type { FastifyReply, FastifyRequest } from 'fastify';
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { AuthProvider } from '@tixkit/shared';
import type { Principal, Permission, Ulid } from '@tixkit/domain';
import {
  ALL_PERMISSIONS as DOMAIN_ALL_PERMISSIONS,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
} from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { AGENT_PROTOCOL_VERSION } from '@tixkit/agent-protocol';

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

/** Strip inline `#` comments/quotes from env values (common .env.local footgun). */
function sanitizeEnvText(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .split('#')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
  return cleaned || fallback;
}

function sanitizeEnvEmail(value: string | undefined, fallback: string): string {
  const cleaned = sanitizeEnvText(value, fallback).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned : fallback;
}

export const ALL_PERMISSIONS: Permission[] = [...DOMAIN_ALL_PERMISSIONS];
const API_KEY_PERMISSIONS = new Set<Permission>(ALL_PERMISSIONS);
const DEFAULT_SCANNER_DEVICE_SCOPES: Permission[] = ['checkins.read', 'checkins.write'];
const SCANNER_DEVICE_PERMISSIONS = new Set<Permission>(DEFAULT_SCANNER_DEVICE_SCOPES);

function parsePersistedArray(value: unknown, fieldName: string, subject = 'API key'): unknown[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) {
      throw new UnauthorizedError(`Invalid ${subject} ${fieldName}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError(`Invalid ${subject} ${fieldName}`);
  }
}

function parseApiKeyScopes(value: unknown): Permission[] {
  return parsePersistedArray(value, 'scopes').filter(
    (scope): scope is Permission =>
      typeof scope === 'string' && API_KEY_PERMISSIONS.has(scope as Permission),
  );
}

export function parseOAuthScopes(value: unknown): Permission[] {
  const parsed = parsePersistedArray(value, 'scopes', 'OAuth token');
  if (!parsed.every((scope) => typeof scope === 'string')) {
    throw new UnauthorizedError('Invalid OAuth token scopes');
  }
  if (!parsed.every((scope) => API_KEY_PERMISSIONS.has(scope as Permission))) {
    throw new UnauthorizedError('Invalid OAuth token scopes');
  }
  return parsed as Permission[];
}

function parseApiKeyResourceIds(value: unknown, fieldName: string): Ulid[] | undefined {
  if (value == null || value === '') return undefined;
  const parsed = parsePersistedArray(value, fieldName);
  if (!parsed.every((id) => typeof id === 'string')) {
    throw new UnauthorizedError(`Invalid API key ${fieldName}`);
  }
  return parsed.length > 0 ? (parsed as Ulid[]) : undefined;
}

function parseScannerDeviceScopes(value: unknown): Permission[] {
  if (value == null || value === '') return [...DEFAULT_SCANNER_DEVICE_SCOPES];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    const scopes = parsed.filter(
      (scope): scope is Permission =>
        typeof scope === 'string' && SCANNER_DEVICE_PERMISSIONS.has(scope as Permission),
    );
    return scopes;
  } catch {
    return [];
  }
}

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

  private async resolveVerifiedSessionEmail(
    claims: ClerkSessionClaims,
  ): Promise<string | undefined> {
    if (!this.config.secretKey) return undefined;

    const user = await createClerkClient({
      secretKey: this.config.secretKey,
    }).users.getUser(claims.sub);
    const verifiedAddresses = user.emailAddresses.filter(
      (emailAddress) => emailAddress.verification?.status === 'verified',
    );
    const claimedEmail = (claims.email ?? claims.email_address)?.trim().toLowerCase();
    if (claimedEmail) {
      return verifiedAddresses
        .find((emailAddress) => emailAddress.emailAddress.trim().toLowerCase() === claimedEmail)
        ?.emailAddress.trim()
        .toLowerCase();
    }
    const primary = verifiedAddresses.find(
      (emailAddress) => emailAddress.id === user.primaryEmailAddressId,
    );
    return (primary ?? verifiedAddresses[0])?.emailAddress.trim().toLowerCase();
  }

  private async acceptPendingInvitations(claims: ClerkSessionClaims): Promise<void> {
    const existingProfiles = await this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('clerk_user_id', '=', claims.sub)
      .execute();
    const claimedEmail = (claims.email ?? claims.email_address)?.trim().toLowerCase();
    let verifiedEmail: string | undefined;
    const knownEmail = claimedEmail ?? existingProfiles[0]?.email?.trim().toLowerCase();
    if (!knownEmail) verifiedEmail = await this.resolveVerifiedSessionEmail(claims);
    const email = knownEmail ?? verifiedEmail;

    const invitedProfiles = email
      ? await this.db.selectFrom('user_profiles').selectAll().where('email', '=', email).execute()
      : [];
    const hasPlaceholderInvitation = invitedProfiles.some(
      (profile) => profile.clerk_user_id === `invited:${profile.email}`,
    );
    if (hasPlaceholderInvitation && !verifiedEmail) {
      verifiedEmail = await this.resolveVerifiedSessionEmail(claims);
    }
    const verifiedInvitedProfiles = verifiedEmail && verifiedEmail === email ? invitedProfiles : [];
    const candidates = new Map(
      [...existingProfiles, ...verifiedInvitedProfiles].map((profile) => [profile.id, profile]),
    );
    if (candidates.size === 0) return;

    const claimable: Array<(typeof existingProfiles)[number]> = [];
    for (const profile of candidates.values()) {
      if (
        profile.clerk_user_id !== claims.sub &&
        profile.clerk_user_id !== `invited:${profile.email}`
      ) {
        continue;
      }
      const pendingMembership = await this.db
        .selectFrom('organization_members')
        .select('id')
        .where('user_id', '=', profile.id)
        .where('accepted_at', 'is', null)
        .executeTakeFirst();
      if (profile.clerk_user_id !== claims.sub || pendingMembership) claimable.push(profile);
    }
    if (claimable.length === 0) return;

    const now = new Date();
    await this.db.transaction().execute(async (trx) => {
      for (const profile of claimable) {
        await trx
          .updateTable('user_profiles')
          .set({ clerk_user_id: claims.sub, status: 'active', updated_at: now })
          .where('id', '=', profile.id)
          .execute();
        await trx
          .updateTable('organization_members')
          .set({ accepted_at: now, updated_at: now })
          .where('user_id', '=', profile.id)
          .where('tenant_id', '=', profile.tenant_id)
          .where('accepted_at', 'is', null)
          .execute();
      }
    });
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
          box_office_settings: JSON.stringify({
            enabled: true,
            allowedTenderTypes: ['cash', 'manual_card', 'comp'],
            requireBuyerEmail: false,
            receiptMode: 'email',
          }),
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
          theme: JSON.stringify({ primaryColor: '#4f46e5' }),
          legal_urls: JSON.stringify({}),
          white_label: false,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    await this.ensureDevResendProviderRoute();
  }

  /**
   * When RESEND_API_KEY is present in local dev, seed a verified sender identity
   * and an active smoke-verified Resend provider route so Content Studio test
   * sends and transactional workflows can deliver real mail.
   */
  private async ensureDevResendProviderRoute(): Promise<void> {
    if (!process.env.RESEND_API_KEY?.trim()) return;

    const fromEmail = sanitizeEnvEmail(process.env.RESEND_FROM_EMAIL, 'onboarding@resend.dev');
    const fromName = sanitizeEnvText(process.env.RESEND_FROM_NAME, 'Tixkit Dev');
    const senderDomain = fromEmail.includes('@')
      ? fromEmail.split('@')[1]!.toLowerCase()
      : 'resend.dev';
    const now = new Date();

    const existingById = await this.db
      .selectFrom('brand_sender_identities')
      .selectAll()
      .where('id', '=', 'bsi_dev_resend')
      .executeTakeFirst();
    const existingByEmail = existingById
      ? undefined
      : await this.db
          .selectFrom('brand_sender_identities')
          .selectAll()
          .where('tenant_id', '=', DEV_TENANT_ID)
          .where('brand_id', '=', DEV_BRAND_ID)
          .where('email', '=', fromEmail)
          .executeTakeFirst();
    const existingSender = existingById ?? existingByEmail;

    if (!existingSender) {
      await this.db
        .insertInto('brand_sender_identities')
        .values({
          id: 'bsi_dev_resend',
          tenant_id: DEV_TENANT_ID,
          brand_id: DEV_BRAND_ID,
          email: fromEmail,
          name: fromName,
          reply_to_email: fromEmail,
          verified: true,
          verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } else {
      // Always re-sync email/name/verified so polluted env values or stale
      // tickets@example.test rows cannot stick around across restarts.
      await this.db
        .updateTable('brand_sender_identities')
        .set({
          brand_id: DEV_BRAND_ID,
          tenant_id: DEV_TENANT_ID,
          email: fromEmail,
          name: fromName,
          reply_to_email: fromEmail,
          verified: true,
          verified_at: existingSender.verified_at ?? now,
          updated_at: now,
        })
        .where('id', '=', existingSender.id)
        .execute();
    }

    const existingRoute = await this.db
      .selectFrom('email_provider_routes')
      .selectAll()
      .where('brand_id', '=', DEV_BRAND_ID)
      .where('provider_type', '=', 'resend')
      .executeTakeFirst();

    if (!existingRoute) {
      await this.db
        .insertInto('email_provider_routes')
        .values({
          id: 'epr_dev_resend',
          tenant_id: DEV_TENANT_ID,
          brand_id: DEV_BRAND_ID,
          provider_type: 'resend',
          credentials_ref: 'RESEND_API_KEY',
          sender_domain: senderDomain,
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['transactional', 'bulk', 'staff', 'system']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return;
    }

    // Always keep the active Resend route aligned with the current from-domain.
    await this.db
      .updateTable('email_provider_routes')
      .set({
        status: 'active',
        smoke_send_verified: true,
        sender_domain: senderDomain,
        credentials_ref: 'RESEND_API_KEY',
        updated_at: now,
      })
      .where('id', '=', existingRoute.id)
      .execute();
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

      await this.acceptPendingInvitations(claims);

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
        const organizations = await this.db
          .selectFrom('organizations')
          .selectAll()
          .where('clerk_organization_id', '=', org_id)
          .limit(2)
          .execute();
        if (organizations.length > 1) {
          throw new UnauthorizedError('Active organization maps to multiple Tixkit tenants');
        }
        const org = organizations[0];
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
        .where('tenant_id', '=', userProfile.tenant_id)
        .where('user_id', '=', userProfile.id)
        .where('accepted_at', 'is not', null)
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
      const result = await verifyToken(token, {
        secretKey: this.config.secretKey,
      });
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

    const scopes = parseApiKeyScopes(apiKey.scopes);
    const brandIds = parseApiKeyResourceIds(apiKey.brand_ids, 'brand_ids');
    const eventIds = parseApiKeyResourceIds(apiKey.event_ids, 'event_ids');

    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', apiKey.id)
      .execute();

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

    const scopes = parseOAuthScopes(accessToken.scopes);
    await this.db
      .updateTable('oauth_access_tokens')
      .set({ updated_at: new Date() })
      .where('id', '=', accessToken.token_id)
      .execute();

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

  async authenticateAgentAccessToken(request: FastifyRequest): Promise<AuthResult> {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer tk_aat_')) {
      throw new UnauthorizedError('Missing or invalid agent access token');
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
      .innerJoin('agent_principals', (join) =>
        join
          .onRef('agent_principals.id', '=', 'oauth_access_tokens.subject_id')
          .onRef('agent_principals.tenant_id', '=', 'oauth_access_tokens.tenant_id'),
      )
      .select([
        'oauth_access_tokens.id as token_id',
        'oauth_access_tokens.tenant_id as token_tenant_id',
        'oauth_access_tokens.subject_id as token_subject_id',
        'oauth_access_tokens.subject_type as token_subject_type',
        'oauth_access_tokens.revoked_at as token_revoked_at',
        'oauth_applications.tenant_id as app_tenant_id',
        'oauth_applications.subject_type as app_subject_type',
        'oauth_applications.agent_principal_id as app_agent_principal_id',
        'oauth_applications.status as app_status',
        'agent_principals.id as agent_principal_id',
        'agent_principals.tenant_id as agent_tenant_id',
        'agent_principals.state as agent_state',
        'agent_principals.protocol_version as agent_protocol_version',
      ])
      .where('oauth_access_tokens.token_hash', '=', tokenHash)
      .where('oauth_access_tokens.expires_at', '>', sql<Date>`current_timestamp`)
      .executeTakeFirst();

    if (
      !accessToken ||
      accessToken.token_revoked_at ||
      accessToken.token_subject_type !== 'agent' ||
      accessToken.app_subject_type !== 'agent' ||
      accessToken.app_status !== 'active' ||
      accessToken.agent_state !== 'active' ||
      accessToken.agent_protocol_version !== AGENT_PROTOCOL_VERSION ||
      !accessToken.token_subject_id ||
      accessToken.token_subject_id !== accessToken.app_agent_principal_id ||
      accessToken.token_subject_id !== accessToken.agent_principal_id ||
      accessToken.token_tenant_id !== accessToken.app_tenant_id ||
      accessToken.token_tenant_id !== accessToken.agent_tenant_id
    ) {
      throw new UnauthorizedError('Invalid, expired, or revoked agent access token');
    }

    await this.db
      .updateTable('oauth_access_tokens')
      .set({ updated_at: sql<Date>`current_timestamp` })
      .where('id', '=', accessToken.token_id)
      .where('revoked_at', 'is', null)
      .execute();

    return {
      principal: {
        type: 'agent',
        id: accessToken.agent_principal_id,
        tenantId: accessToken.agent_tenant_id,
        organizationIds: [],
        scopes: [],
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
    const scopes = parseScannerDeviceScopes(device.scopes);

    const principal: Principal = {
      type: 'mobile_device',
      id: device.device_id,
      tenantId: device.tenant_id,
      organizationIds: [device.organization_id],
      scopes,
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
   * Requires any one of the listed permissions (used for dual-accept migrations
   * such as box_office.write alongside legacy orders.write).
   */
  static requireAnyPermission(principal: Principal, permissions: Permission[]): void {
    if (!permissions.some((permission) => ClerkAuthService.hasPermission(principal, permission))) {
      throw new ForbiddenError(`Missing required permission: ${permissions.join(' or ')}`);
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
   * Requires the principal not to be limited to specific events before using
   * organization-wide or brand-wide surfaces that do not derive brand scope
   * from event IDs.
   */
  static requireNoEventScope(principal: Principal, resourceName: string): void {
    if (principal.eventIds && principal.eventIds.length > 0) {
      throw new ForbiddenError(`Event-scoped principals cannot access ${resourceName}`);
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
  return (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void) => {
    const authHeader = request.headers.authorization;

    const authenticate = async (): Promise<void> => {
      if (request.headers['x-device-id']) {
        const result = await authService.authenticateScannerDevice(request);
        request.principal = result.principal;
      } else if (authHeader?.startsWith('Bearer tk_aat_')) {
        const result = await authService.authenticateAgentAccessToken(request);
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
    };

    void authenticate().then(
      () => done(),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : 'Authentication failed';
        const isUnauthorized = err instanceof UnauthorizedError;
        const authError =
          err instanceof UnauthorizedError || err instanceof ForbiddenError
            ? err
            : new ForbiddenError(message);
        void reply.status(isUnauthorized ? 401 : 403).send({
          error: {
            code: isUnauthorized ? 'UNAUTHORIZED' : 'FORBIDDEN',
            message: authError.message,
            requestId: request.id,
          },
        });
        // Deliberately do not call done after sending: callback-style hooks stop
        // the lifecycle here, so no protected handler can run after auth denial.
      },
    );
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}
