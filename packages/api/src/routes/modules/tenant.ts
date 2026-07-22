import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import type { AppContext } from '../../app.js';
import type { Permission, Principal } from '@tixkit/domain';
import {
  OrganizationRepository,
  OrganizationMemberRepository,
  BrandSenderIdentityRepository,
  BrandRepository,
  PaymentAccountRepository,
  PaymentAccountCleanupCommandRepository,
  PermissionGrantRepository,
  AuditLogRepository,
  EventRepository,
  ContentRepository,
  EmailJobRepository,
} from '@tixkit/db';
import type { Database } from '@tixkit/db';
import {
  ForbiddenError,
  ConflictError,
  NotFoundError,
  ValidationError,
  isDoorOnlyPermissionSet,
  permissionsForRole,
} from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import {
  addBrandDomainSchema,
  createOrganizationInvitationSchema,
  createBrandSchema,
  createOrganizationSchema,
  parseBody,
  updateBrandSchema,
  updateOrganizationMemberSchema,
  updateOrganizationSchema,
} from '../../http/schemas.js';
import {
  serializeBrand,
  serializeBrandDomain,
  serializeBrandSenderIdentity,
  serializeOrganization,
} from '../../http/contracts.js';
import { observeApiPaymentProviderAttempt } from '../../observability.js';
import {
  ProviderOperationError,
  StripeSdkGateway,
  type StripeConnectAccount,
  type StripeGateway,
  type ProviderTelemetryEvent,
} from '@tixkit/provider-clients';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';
import { ulid } from 'ulid';

type PaymentAccountRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  provider: string;
  provider_account_id: string;
  status: string;
  default_currency: string;
  details_submitted?: boolean | number | null;
  charges_enabled?: boolean | number | null;
  payouts_enabled?: boolean | number | null;
  requirements?: string | Record<string, unknown> | null;
  disabled_reason?: string | null;
  refresh_generation: number;
  created_at: Date;
  updated_at: Date;
};

function parseJsonObject(
  value: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function boolValue(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function requireAnyPermission(principal: Principal, permissions: Permission[]): void {
  if (!permissions.some((permission) => ClerkAuthService.hasPermission(principal, permission))) {
    throw new ForbiddenError(`Missing required permission: ${permissions.join(' or ')}`);
  }
}

function requireBootstrapEventScope(principal: Principal): void {
  // Door-only event staff need the exact event-derived organization and brand
  // to render their shell. Other dashboard principals remain brand-wide.
  if (!isDoorOnlyPermissionSet(principal.scopes)) {
    ClerkAuthService.requireNoEventScope(principal, 'brand-wide dashboard context');
  }
}

function requireOrganizationCreationPrincipal(principal: Principal): void {
  if (principal.brandIds?.length || principal.eventIds?.length) {
    throw new ForbiddenError('Scoped principals cannot create tenant organizations');
  }
}

function requireBrandCreationPrincipal(principal: Principal): void {
  if (principal.brandIds?.length || principal.eventIds?.length) {
    throw new ForbiddenError('Scoped principals cannot create brands');
  }
}

async function requireOrganizationScopedPermission(
  db: Database,
  principal: Principal,
  organizationId: string,
  permission: Permission,
  options?: { lock?: boolean },
): Promise<void> {
  ClerkAuthService.requirePermission(principal, permission);
  ClerkAuthService.requireOrganizationScope(principal, organizationId);
  if (principal.type === 'system') return;
  if (principal.type !== 'user') {
    throw new ForbiddenError('This organization-wide operation requires a user principal');
  }
  let grantQuery = db
    .selectFrom('permission_grants')
    .select('id')
    .where('tenant_id', '=', principal.tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', principal.id)
    .where('permission', '=', permission)
    .where('scope_type', '=', 'organization')
    .where('scope_id', '=', organizationId);
  if (options?.lock) grantQuery = grantQuery.forUpdate();
  const grant = await grantQuery.executeTakeFirst();
  if (grant) return;
  // Legacy/unscoped principals have no resource filters and are organization-wide.
  // For mixed multi-org principals, the exact DB grant above is authoritative.
  if (
    !principal.brandIds?.length &&
    !principal.eventIds?.length &&
    principal.organizationIds.length === 1 &&
    principal.organizationIds[0] === organizationId
  ) {
    return;
  }
  throw new ForbiddenError(
    `Organization-scoped ${permission} permission is required for this operation`,
  );
}

async function requireLiveOrganizationMemberPermission(
  db: Database,
  principal: Principal,
  organizationId: string,
  permission: Permission,
): Promise<void> {
  ClerkAuthService.requirePermission(principal, permission);
  ClerkAuthService.requireOrganizationScope(principal, organizationId);
  if (principal.type === 'system') return;
  if (principal.type !== 'user') {
    throw new ForbiddenError('Organization membership administration requires a user principal');
  }
  const membership = await db
    .selectFrom('organization_members')
    .select('id')
    .where('tenant_id', '=', principal.tenantId)
    .where('organization_id', '=', organizationId)
    .where('user_id', '=', principal.id)
    .where('accepted_at', 'is not', null)
    .forUpdate()
    .executeTakeFirst();
  const grant = await db
    .selectFrom('permission_grants')
    .select('id')
    .where('tenant_id', '=', principal.tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', principal.id)
    .where('permission', '=', permission)
    .where('scope_type', '=', 'organization')
    .where('scope_id', '=', organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!membership || !grant) {
    throw new ForbiddenError(
      `Live organization membership and ${permission} authority are required for this operation`,
    );
  }
}

const dashboardContextPermissions: Permission[] = [
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
  'box_office.write',
  'messages.write',
  'reports.read',
  'settings.write',
  'developers.write',
  'billing.write',
];

type BootstrapScope = Readonly<{
  brands: Array<Record<string, unknown>>;
  organizations: Array<Record<string, unknown>>;
  settingsBrandIds: ReadonlySet<string>;
  settingsOrganizationIds: ReadonlySet<string>;
}>;

function adminDashboardOrigin(): string {
  return (
    process.env.ADMIN_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN ??
    'http://localhost:3001'
  ).replace(/\/$/, '');
}

async function queueOrganizationInvitationEmail(input: {
  db: Database;
  tenantId: string;
  organizationName: string;
  brandId: string;
  email: string;
  idempotencyKey: string;
  returnTo?: string;
}) {
  const signUpUrl = new URL('/sign-up', adminDashboardOrigin());
  if (input.returnTo) signUpUrl.searchParams.set('redirect_url', input.returnTo);
  const inviteUrl = signUpUrl.toString();
  const publishedTemplate = await new ContentRepository(input.db).findPublishedEmailTemplate({
    tenantId: input.tenantId,
    brandId: input.brandId,
    key: 'organization-member-invited',
  });
  const emailRepo = new EmailJobRepository(input.db);
  const existing = await emailRepo.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
  if (existing) return existing;
  return emailRepo.create({
    tenantId: input.tenantId,
    brandId: input.brandId,
    templateKey: 'organization-member-invited',
    templateVersionId: publishedTemplate?.version.id ?? 'system_org_member_invited_v1',
    toEmail: input.email,
    variables: {
      recipient: { name: input.email.split('@')[0] || input.email },
      brand: { name: input.organizationName },
      dashboard: { url: inviteUrl },
      notificationType: 'staff',
    },
    providerRouteId: 'system_default',
    priority: 'high',
    idempotencyKey: input.idempotencyKey,
  });
}

function serializePaymentAccount(account: PaymentAccountRow, onboardingUrl?: string) {
  return {
    id: account.id,
    tenantId: account.tenant_id,
    organizationId: account.organization_id,
    provider: account.provider,
    providerAccountId: account.provider_account_id,
    status: account.status,
    defaultCurrency: account.default_currency,
    detailsSubmitted: boolValue(account.details_submitted),
    chargesEnabled: boolValue(account.charges_enabled),
    payoutsEnabled: boolValue(account.payouts_enabled),
    requirements: parseJsonObject(account.requirements),
    disabledReason: account.disabled_reason ?? null,
    createdAt:
      account.created_at instanceof Date ? account.created_at.toISOString() : account.created_at,
    updatedAt:
      account.updated_at instanceof Date ? account.updated_at.toISOString() : account.updated_at,
    ...(onboardingUrl ? { onboardingUrl } : {}),
  };
}

function paymentAccountMaterialState(account: PaymentAccountRow) {
  return {
    status: account.status,
    defaultCurrency: account.default_currency,
    detailsSubmitted: boolValue(account.details_submitted),
    chargesEnabled: boolValue(account.charges_enabled),
    payoutsEnabled: boolValue(account.payouts_enabled),
    requirements: parseJsonObject(account.requirements),
    disabledReason: account.disabled_reason ?? null,
  };
}

function serializeBootstrapOrganization(row: Record<string, unknown>, includeSettings: boolean) {
  if (includeSettings) return serializeOrganization(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
  };
}

function serializeBootstrapBrand(row: Record<string, unknown>, includeSettings: boolean) {
  if (includeSettings) return serializeBrand(row);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    theme: {},
    domains: [],
    whiteLabel: false,
  };
}

function stripeConnectReturnUrl(organizationId: string): string {
  const baseUrl =
    process.env.ADMIN_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN ??
    'http://localhost:3001';
  return `${baseUrl.replace(/\/$/, '')}/settings/payments?organizationId=${encodeURIComponent(organizationId)}&stripeConnect=return`;
}

function stripeConnectRefreshUrl(organizationId: string): string {
  const baseUrl =
    process.env.ADMIN_DASHBOARD_URL ??
    process.env.NEXT_PUBLIC_ADMIN_ORIGIN ??
    'http://localhost:3001';
  return `${baseUrl.replace(/\/$/, '')}/settings/payments?organizationId=${encodeURIComponent(organizationId)}&stripeConnect=refresh`;
}

function stripeAccountStatus(account: StripeConnectAccount): 'active' | 'pending' | 'restricted' {
  if (account.chargesEnabled && account.payoutsEnabled) return 'active';
  if (account.disabledReason !== null) return 'restricted';
  return 'pending';
}

function stripeAccountState(account: StripeConnectAccount) {
  return {
    status: stripeAccountStatus(account),
    defaultCurrency: account.defaultCurrency ?? 'USD',
    detailsSubmitted: account.detailsSubmitted,
    chargesEnabled: account.chargesEnabled,
    payoutsEnabled: account.payoutsEnabled,
    requirements: account.requirements,
    disabledReason: account.disabledReason,
  };
}

const mssqlDuplicateInsertErrorNumbers = new Set([2601, 2627]);

function getErrorNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function isDuplicateInsert(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: string;
    errno?: string | number;
    message?: string;
    number?: string | number;
    originalError?: { number?: string | number };
  };
  const mssqlNumber = getErrorNumber(record.number) ?? getErrorNumber(record.originalError?.number);
  return (
    record.code === '23505' ||
    record.code === 'ER_DUP_ENTRY' ||
    record.errno === 1062 ||
    record.errno === '1062' ||
    (record.code === 'EREQUEST' &&
      mssqlNumber !== undefined &&
      mssqlDuplicateInsertErrorNumbers.has(mssqlNumber)) ||
    /duplicate|unique/i.test(record.message ?? '')
  );
}

function isRetryableOrganizationUpdateConflict(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0 && visited.size < 20) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    const databaseError = current as {
      cause?: unknown;
      code?: string;
      errno?: number;
      number?: number;
      originalError?: unknown;
    };
    if (
      databaseError.code === '40001' ||
      databaseError.code === '40P01' ||
      databaseError.code === 'ER_LOCK_DEADLOCK' ||
      databaseError.code === 'ER_LOCK_WAIT_TIMEOUT' ||
      databaseError.errno === 1213 ||
      databaseError.errno === 1205 ||
      databaseError.number === 1205
    ) {
      return true;
    }
    pending.push(databaseError.cause, databaseError.originalError);
  }
  return false;
}

async function executeOrganizationUpdateWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableOrganizationUpdateConflict(error) || attempt === maximumAttempts) throw error;
    }
  }
  throw new Error('ORGANIZATION_UPDATE_TRANSACTION_RETRY_EXHAUSTED');
}

async function executeBrandUpdateWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableOrganizationUpdateConflict(error) || attempt === maximumAttempts) throw error;
    }
  }
  throw new Error('BRAND_UPDATE_TRANSACTION_RETRY_EXHAUSTED');
}

function organizationAuditSnapshot(row: Record<string, unknown>) {
  const organization = serializeOrganization(row);
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    clerkOrganizationId: organization.clerkOrganizationId ?? null,
    boxOfficeSettings: organization.boxOfficeSettings,
    eventDefaults: organization.eventDefaults,
  };
}

function organizationUpdateAuditDiff(
  before: ReturnType<typeof organizationAuditSnapshot>,
  after: ReturnType<typeof organizationAuditSnapshot>,
) {
  const changedFields = (
    ['name', 'slug', 'clerkOrganizationId', 'boxOfficeSettings', 'eventDefaults'] as const
  ).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  return { before, after, changedFields, noOp: changedFields.length === 0 };
}

function brandAuditSnapshot(row: Record<string, unknown>) {
  const brand = serializeBrand(row);
  return {
    id: brand.id,
    organizationId: brand.organizationId,
    name: brand.name,
    slug: brand.slug,
    status: brand.status,
    theme: brand.theme,
    paymentAccountId: brand.paymentAccountId ?? null,
    supportUrl: brand.supportUrl ?? null,
    legalUrls: brand.legalUrls,
    whiteLabel: brand.whiteLabel,
  };
}

function brandUpdateAuditDiff(
  before: ReturnType<typeof brandAuditSnapshot>,
  after: ReturnType<typeof brandAuditSnapshot>,
) {
  const changedFields = (
    [
      'name',
      'slug',
      'status',
      'theme',
      'paymentAccountId',
      'supportUrl',
      'legalUrls',
      'whiteLabel',
    ] as const
  ).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
  return { before, after, changedFields, noOp: changedFields.length === 0 };
}

async function requireUniqueClerkOrganizationId(
  db: AppContext['db'],
  clerkOrganizationId: string | null | undefined,
  currentOrganizationId?: string,
): Promise<void> {
  if (clerkOrganizationId == null) return;
  const trimmed = clerkOrganizationId.trim();
  if (trimmed === '') return;

  let query = db
    .selectFrom('organizations')
    .select(['id'])
    .where('clerk_organization_id', '=', trimmed);
  if (currentOrganizationId) {
    query = query.where('id', '!=', currentOrganizationId);
  }
  const existing = await query.executeTakeFirst();
  if (existing) {
    throw new ValidationError('Clerk organization ID is already assigned to another organization');
  }
}

function stripeGatewayFromContext(
  context: unknown,
  onTelemetry: (event: Readonly<ProviderTelemetryEvent>) => void,
  incidentScope: { tenantId: string; organizationId: string },
): StripeGateway | null {
  const injected = (context as { stripeGateway?: StripeGateway }).stripeGateway;
  if (injected) return injected;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const connectClientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!secretKey || !connectClientId) return null;
  const providerClientRuntime = (context as AppContext).providerClientRuntime;
  const options = {
    onTelemetry,
    onExactRequestId: providerClientRuntime?.onExactRequestId,
    incidentScope,
  };
  return (
    (context as AppContext).stripeGatewayFactory?.(secretKey, options) ??
    new StripeSdkGateway(secretKey, options)
  );
}

function requireStripeConnectIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new ValidationError(
      'Idempotency-Key header is required and must not exceed 128 characters',
    );
  }
  return value.trim();
}

function stripeConnectProviderError(error: unknown): never {
  if (!(error instanceof ProviderOperationError)) throw error;
  if (!error.retryable && error.deliveryState === 'rejected') {
    throw new ValidationError('Stripe Connect rejected the provider operation');
  }
  const unavailable = Object.assign(new Error('Stripe Connect is temporarily unavailable'), {
    code: 'STRIPE_CONNECT_UNAVAILABLE',
    statusCode: 503,
    expose: true,
  });
  throw unavailable;
}

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const audit = () => new AuditLogRepository(db);

  async function scopedOrganizationsFor(principal: Principal) {
    const orgs = await new OrganizationRepository(db).findByTenant(principal.tenantId);
    return principal.type === 'system'
      ? orgs
      : orgs.filter((org) => principal.organizationIds.includes(org.id));
  }

  async function scopedBrandsFor(principal: Principal) {
    const brands = await new BrandRepository(db).findByTenant(principal.tenantId);
    if (principal.type === 'system') return brands;

    let allowedBrandIds = principal.brandIds;
    // Event-scoped door staff have eventIds but may not have brandIds. Derive
    // allowed brands from those events so bootstrap does not leak every org brand.
    if ((!allowedBrandIds || allowedBrandIds.length === 0) && principal.eventIds?.length) {
      const eventRows = await db
        .selectFrom('events')
        .select(['id', 'brand_id'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', 'in', principal.eventIds)
        .execute();
      allowedBrandIds = [
        ...new Set(
          eventRows
            .map((row) => row.brand_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ] as Principal['brandIds'];
    }

    return brands.filter(
      (brand) =>
        principal.organizationIds.includes(brand.organization_id) &&
        (!allowedBrandIds || allowedBrandIds.length === 0 || allowedBrandIds.includes(brand.id)),
    );
  }

  async function bootstrapScopeFor(principal: Principal): Promise<BootstrapScope> {
    const [organizations, brands] = await Promise.all([
      new OrganizationRepository(db).findByTenant(principal.tenantId),
      new BrandRepository(db).findByTenant(principal.tenantId),
    ]);
    const organizationById = new Map(
      organizations.map((organization) => [String(organization.id), organization]),
    );
    const brandById = new Map(brands.map((brand) => [String(brand.id), brand]));
    const allOrganizationIds = new Set(organizationById.keys());
    const allBrandIds = new Set(brandById.keys());
    const hasSettings = ClerkAuthService.hasPermission(principal, 'settings.write');

    if (principal.type === 'system') {
      return {
        organizations,
        brands,
        settingsOrganizationIds: hasSettings ? allOrganizationIds : new Set<string>(),
        settingsBrandIds: hasSettings ? allBrandIds : new Set<string>(),
      };
    }

    const principalOrganizationIds = new Set(
      principal.organizationIds.filter((id) => organizationById.has(id)),
    );

    if (principal.type === 'api_key') {
      const explicitBrandIds = new Set(
        (principal.brandIds ?? []).filter((id) => brandById.has(id)),
      );
      const eventIds = principal.eventIds ?? [];
      if (eventIds.length > 0) {
        const eventRows = await db
          .selectFrom('events')
          .select(['brand_id'])
          .where('tenant_id', '=', principal.tenantId)
          .where('id', 'in', eventIds)
          .execute();
        for (const event of eventRows) {
          if (typeof event.brand_id === 'string' && brandById.has(event.brand_id)) {
            explicitBrandIds.add(event.brand_id);
          }
        }
      }
      const isResourceRestricted = (principal.brandIds?.length ?? 0) > 0 || eventIds.length > 0;
      const visibleBrands = brands.filter(
        (brand) =>
          principalOrganizationIds.has(String(brand.organization_id)) &&
          (!isResourceRestricted || explicitBrandIds.has(String(brand.id))),
      );
      const visibleOrganizationIds = new Set(
        visibleBrands.map((brand) => String(brand.organization_id)),
      );
      if (!isResourceRestricted) {
        for (const id of principalOrganizationIds) visibleOrganizationIds.add(id);
      }
      const settingsBrandIds = new Set<string>();
      const settingsOrganizationIds = new Set<string>();
      if (hasSettings && !isResourceRestricted) {
        for (const id of visibleOrganizationIds) settingsOrganizationIds.add(id);
        for (const brand of visibleBrands) settingsBrandIds.add(String(brand.id));
      } else if (hasSettings && (principal.brandIds?.length ?? 0) > 0) {
        const visibleBrandIds = new Set(visibleBrands.map((brand) => String(brand.id)));
        for (const id of principal.brandIds ?? []) {
          if (explicitBrandIds.has(id) && visibleBrandIds.has(id)) settingsBrandIds.add(id);
        }
      }
      return {
        organizations: organizations.filter((organization) =>
          visibleOrganizationIds.has(String(organization.id)),
        ),
        brands: visibleBrands,
        settingsOrganizationIds,
        settingsBrandIds,
      };
    }

    const grants = (
      await new PermissionGrantRepository(db).findByPrincipal(
        principal.tenantId,
        principal.type,
        principal.id,
      )
    ).filter(
      (grant) =>
        dashboardContextPermissions.includes(grant.permission as Permission) &&
        principal.scopes.includes(grant.permission as Permission),
    );
    const eventGrantIds = grants
      .filter((grant) => grant.scope_type === 'event' && typeof grant.scope_id === 'string')
      .map((grant) => grant.scope_id as string);
    const eventRows =
      eventGrantIds.length > 0
        ? await db
            .selectFrom('events')
            .select(['id', 'organization_id', 'brand_id'])
            .where('tenant_id', '=', principal.tenantId)
            .where('id', 'in', eventGrantIds)
            .execute()
        : [];
    const eventById = new Map(eventRows.map((event) => [String(event.id), event]));
    const visibleOrganizationIds = new Set<string>();
    const visibleBrandIds = new Set<string>();
    const settingsOrganizationIds = new Set<string>();
    const settingsBrandIds = new Set<string>();

    const includeOrganization = (organizationId: string): boolean => {
      if (!principalOrganizationIds.has(organizationId)) return false;
      visibleOrganizationIds.add(organizationId);
      return true;
    };
    const includeBrand = (brandId: string): boolean => {
      const brand = brandById.get(brandId);
      if (!brand || !includeOrganization(String(brand.organization_id))) return false;
      visibleBrandIds.add(brandId);
      return true;
    };

    for (const grant of grants) {
      const scopeId = typeof grant.scope_id === 'string' ? grant.scope_id : null;
      const isSettingsGrant = grant.permission === 'settings.write';
      if (grant.scope_type === 'tenant') {
        for (const organizationId of principalOrganizationIds) {
          includeOrganization(organizationId);
          if (isSettingsGrant) settingsOrganizationIds.add(organizationId);
        }
        for (const brand of brands) {
          const brandId = String(brand.id);
          if (includeBrand(brandId) && isSettingsGrant) settingsBrandIds.add(brandId);
        }
      } else if (grant.scope_type === 'organization' && scopeId) {
        if (!includeOrganization(scopeId)) continue;
        if (isSettingsGrant) settingsOrganizationIds.add(scopeId);
        for (const brand of brands) {
          if (String(brand.organization_id) !== scopeId) continue;
          const brandId = String(brand.id);
          visibleBrandIds.add(brandId);
          if (isSettingsGrant) settingsBrandIds.add(brandId);
        }
      } else if (grant.scope_type === 'brand' && scopeId) {
        if (includeBrand(scopeId) && isSettingsGrant) settingsBrandIds.add(scopeId);
      } else if (grant.scope_type === 'event' && scopeId) {
        const event = eventById.get(scopeId);
        if (event && typeof event.brand_id === 'string') includeBrand(event.brand_id);
      }
    }

    return {
      organizations: organizations.filter((organization) =>
        visibleOrganizationIds.has(String(organization.id)),
      ),
      brands: brands.filter((brand) => visibleBrandIds.has(String(brand.id))),
      settingsOrganizationIds,
      settingsBrandIds,
    };
  }

  app.post('/organizations', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    requireOrganizationCreationPrincipal(principal);
    const body = parseBody(createOrganizationSchema, request.body);
    await requireUniqueClerkOrganizationId(db, body.clerkOrganizationId);

    const repo = new OrganizationRepository(db);
    const createInput = {
      tenantId: principal.tenantId,
      name: body.name,
      slug: body.slug,
      clerkOrganizationId: body.clerkOrganizationId,
      boxOfficeSettings: body.boxOfficeSettings,
    };
    let org;
    try {
      org = await repo.create(createInput);
    } catch (err) {
      if (isDuplicateInsert(err)) {
        throw new ValidationError(
          'Clerk organization ID is already assigned to another organization',
        );
      }
      throw err;
    }

    return reply.status(201).send(serializeOrganization(org));
  });

  app.get('/organizations', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const scopedOrganizations = await scopedOrganizationsFor(principal);
    return scopedOrganizations.map(serializeOrganization);
  });

  app.get('/bootstrap-context', async (request) => {
    const principal = request.principal;
    // Authentication owns the response when credentials are rejected. Avoid
    // continuing into asynchronous scope resolution after that reply is sent.
    if (!principal) return;
    requireAnyPermission(principal, dashboardContextPermissions);
    requireBootstrapEventScope(principal);
    const scope = await bootstrapScopeFor(principal);
    const brandIds = [...scope.settingsBrandIds];
    const domains =
      brandIds.length > 0
        ? await db
            .selectFrom('brand_domains')
            .selectAll()
            .where('brand_id', 'in', brandIds)
            .execute()
        : [];
    const domainsByBrandId = new Map<string, Array<Record<string, unknown>>>();
    for (const domain of domains) {
      const brandId = String(domain.brand_id);
      const current = domainsByBrandId.get(brandId) ?? [];
      current.push(domain);
      domainsByBrandId.set(brandId, current);
    }

    return {
      organizations: scope.organizations.map((organization) =>
        serializeBootstrapOrganization(
          organization,
          scope.settingsOrganizationIds.has(String(organization.id)),
        ),
      ),
      brands: scope.brands.map((brand) => {
        const includeBrandSettings = scope.settingsBrandIds.has(String(brand.id));
        const serialized = serializeBootstrapBrand(brand, includeBrandSettings);
        return includeBrandSettings
          ? Object.assign(serialized, {
              domains: (domainsByBrandId.get(String(brand.id)) ?? []).map(serializeBrandDomain),
            })
          : serialized;
      }),
    };
  });

  app.patch('/organizations/:organizationId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    if (principal.type !== 'user') {
      throw new ForbiddenError('Organization updates require a user principal');
    }
    const { organizationId } = request.params as { organizationId: string };
    try {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Organization', 'concealed');
      throw error;
    }
    const body = parseBody(updateOrganizationSchema, request.body);
    try {
      const updated = await executeOrganizationUpdateWithRetry(() =>
        db
          .transaction()
          .setIsolationLevel('serializable')
          .execute(async (trx) => {
            const transactionDb = trx as Database;
            await app.context.organizationUpdateCheckpoint?.({
              stage: 'before_lock',
              organizationId,
            });
            const current = await trx
              .selectFrom('organizations')
              .selectAll()
              .where('id', '=', organizationId)
              .where('tenant_id', '=', principal.tenantId)
              .forUpdate()
              .executeTakeFirst();
            if (!current) throw new NotFoundError('Organization', 'concealed');
            await app.context.organizationUpdateCheckpoint?.({
              stage: 'after_lock',
              organizationId,
            });
            ClerkAuthService.requireResourceTenant(
              principal,
              current,
              'Organization',
              organizationId,
            );
            await requireOrganizationScopedPermission(
              transactionDb,
              principal,
              organizationId,
              'settings.write',
              { lock: true },
            );
            await requireUniqueClerkOrganizationId(
              transactionDb,
              body.clerkOrganizationId,
              organizationId,
            );
            const before = organizationAuditSnapshot(current as unknown as Record<string, unknown>);
            if (body.eventDefaults?.defaultVenueId) {
              const defaultVenue = await trx
                .selectFrom('venues')
                .select('id')
                .where('id', '=', body.eventDefaults.defaultVenueId)
                .where('tenant_id', '=', principal.tenantId)
                .where('organization_id', '=', organizationId)
                .forUpdate()
                .executeTakeFirst();
              if (!defaultVenue)
                throw new ValidationError('Default venue must belong to this workspace');
            }
            const updated = await new OrganizationRepository(transactionDb).update(organizationId, {
              ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
              ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
              ...(body.clerkOrganizationId !== undefined
                ? { clerk_organization_id: body.clerkOrganizationId }
                : {}),
              ...(body.boxOfficeSettings !== undefined
                ? { box_office_settings: JSON.stringify(body.boxOfficeSettings) }
                : {}),
              ...(body.eventDefaults !== undefined
                ? { event_defaults: JSON.stringify(body.eventDefaults) }
                : {}),
            });
            const after = organizationAuditSnapshot(updated as unknown as Record<string, unknown>);
            await writeAuditLog(
              new AuditLogRepository(transactionDb),
              request,
              principal,
              {
                action: 'organization.updated',
                organizationId,
                resourceType: 'Organization',
                resourceId: organizationId,
                diffSummary: organizationUpdateAuditDiff(before, after),
              },
              { failClosed: true },
            );
            return updated;
          }),
      );
      return serializeOrganization(updated);
    } catch (err) {
      if (isDuplicateInsert(err)) {
        throw new ValidationError(
          'Clerk organization ID is already assigned to another organization',
        );
      }
      throw err;
    }
  });

  app.get('/organizations/:organizationId/members', async (request) => {
    const principal = request.principal!;
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');
    return db.transaction().execute(async (transaction) => {
      const transactionDb = transaction as Database;
      const organization = await transactionDb
        .selectFrom('organizations')
        .selectAll()
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirst();
      if (!organization) throw new NotFoundError('Organization', organizationId);
      ClerkAuthService.requireResourceTenant(
        principal,
        organization,
        'Organization',
        organizationId,
      );
      await requireLiveOrganizationMemberPermission(
        transactionDb,
        principal,
        organizationId,
        'settings.write',
      );

      const rows = await new OrganizationMemberRepository(transactionDb).findByOrganization(
        principal.tenantId,
        organizationId,
      );
      const userIds = rows.map((row) => row.user_id);
      const [organizationBrands, organizationEvents, grants] = await Promise.all([
        transactionDb
          .selectFrom('brands')
          .select('id')
          .where('tenant_id', '=', principal.tenantId)
          .where('organization_id', '=', organizationId)
          .execute(),
        transactionDb
          .selectFrom('events')
          .select('id')
          .where('tenant_id', '=', principal.tenantId)
          .where('organization_id', '=', organizationId)
          .execute(),
        userIds.length > 0
          ? transactionDb
              .selectFrom('permission_grants')
              .select(['principal_id', 'scope_type', 'scope_id'])
              .where('tenant_id', '=', principal.tenantId)
              .where('principal_type', '=', 'user')
              .where('principal_id', 'in', userIds)
              .execute()
          : Promise.resolve([]),
      ]);
      const organizationBrandIds = new Set(organizationBrands.map((brand) => brand.id));
      const organizationEventIds = new Set(organizationEvents.map((event) => event.id));

      return rows.map((row) => {
        const memberGrants = grants.filter((grant) => grant.principal_id === row.user_id);
        const brandIds = [
          ...new Set(
            memberGrants
              .filter(
                (grant) =>
                  grant.scope_type === 'brand' &&
                  grant.scope_id &&
                  organizationBrandIds.has(grant.scope_id),
              )
              .map((grant) => grant.scope_id as string),
          ),
        ];
        const eventIds = [
          ...new Set(
            memberGrants
              .filter(
                (grant) =>
                  grant.scope_type === 'event' &&
                  grant.scope_id &&
                  organizationEventIds.has(grant.scope_id),
              )
              .map((grant) => grant.scope_id as string),
          ),
        ];
        return {
          id: row.id,
          organizationId: row.organization_id,
          name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
          email: row.email,
          role: row.role,
          status: row.accepted_at ? row.user_status : 'invited',
          invitedAt: row.invited_at,
          joinedAt: row.accepted_at,
          brandIds,
          eventIds,
        };
      });
    });
  });

  app.post('/organizations/:organizationId/members/invitations', async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user') {
      throw new ForbiddenError('Organization member invitations require a user principal');
    }
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');

    const body = parseBody(createOrganizationInvitationSchema, request.body);
    const { email, role, brandIds, eventIds, returnTo } = body;
    const rawIdempotencyKey = request.headers['idempotency-key'];
    if (
      typeof rawIdempotencyKey !== 'string' ||
      rawIdempotencyKey.length < 16 ||
      rawIdempotencyKey.length > 255 ||
      rawIdempotencyKey.trim() !== rawIdempotencyKey
    ) {
      throw new ValidationError(
        'Idempotency-Key must contain 16-255 characters with no surrounding whitespace',
      );
    }

    if (brandIds?.length) {
      const brandRepo = new BrandRepository(db);
      for (const brandId of brandIds) {
        const brand = await brandRepo.findById(brandId);
        if (!brand || brand.organization_id !== organizationId) {
          throw new NotFoundError('Brand', brandId);
        }
        ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
        ClerkAuthService.requireBrandScope(principal, brandId);
      }
    }

    const eventBrandIds = new Set<string>();
    if (eventIds?.length) {
      const eventRepo = new EventRepository(db);
      for (const eventId of eventIds) {
        const event = await eventRepo.findById(eventId);
        if (!event || event.organization_id !== organizationId) {
          throw new NotFoundError('Event', eventId);
        }
        ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
        ClerkAuthService.requireEventScope(principal, eventId);
        ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
        if (event.brand_id) eventBrandIds.add(String(event.brand_id));
      }
      if (eventBrandIds.size > 1) {
        throw new ValidationError('Event-scoped invitations must target events from one brand');
      }
    }

    const permissions = permissionsForRole(role);
    const idempotencyKey = `organization-member-invite:${hashRequest({
      key: rawIdempotencyKey,
    })}`;
    const emailJobKey = `organization-invitation:${hashRequest({
      idempotencyKey: rawIdempotencyKey,
    })}`;
    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR'],
        requestHash: hashRequest({
          operation: 'organization-member.invite',
          actorId: principal.id,
          organizationId,
          body,
        }),
      },
      async ({ completeInTransaction }) =>
        db.transaction().execute(async (trx) => {
          const transactionDb = trx as Database;
          await transactionDb
            .selectFrom('tenants')
            .select('id')
            .where('id', '=', principal.tenantId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const lockedOrganization = await transactionDb
            .selectFrom('organizations')
            .selectAll()
            .where('tenant_id', '=', principal.tenantId)
            .where('id', '=', organizationId)
            .forUpdate()
            .executeTakeFirst();
          if (!lockedOrganization) throw new NotFoundError('Organization', organizationId);
          await requireLiveOrganizationMemberPermission(
            transactionDb,
            principal,
            organizationId,
            'settings.write',
          );

          const lockedEventBrandIds = new Set<string>();
          for (const brandId of brandIds ?? []) {
            const brand = await transactionDb
              .selectFrom('brands')
              .selectAll()
              .where('tenant_id', '=', principal.tenantId)
              .where('id', '=', brandId)
              .forUpdate()
              .executeTakeFirst();
            if (!brand || brand.organization_id !== organizationId) {
              throw new NotFoundError('Brand', brandId);
            }
            ClerkAuthService.requireBrandScope(principal, brandId);
          }
          for (const eventId of eventIds ?? []) {
            const event = await transactionDb
              .selectFrom('events')
              .selectAll()
              .where('tenant_id', '=', principal.tenantId)
              .where('id', '=', eventId)
              .forUpdate()
              .executeTakeFirst();
            if (!event || event.organization_id !== organizationId) {
              throw new NotFoundError('Event', eventId);
            }
            ClerkAuthService.requireEventScope(principal, eventId);
            ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
            if (event.brand_id) lockedEventBrandIds.add(String(event.brand_id));
          }
          if (lockedEventBrandIds.size > 1) {
            throw new ValidationError('Event-scoped invitations must target events from one brand');
          }
          const fallbackBrand =
            brandIds?.[0] || [...lockedEventBrandIds][0]
              ? undefined
              : await transactionDb
                  .selectFrom('brands')
                  .select('id')
                  .where('tenant_id', '=', principal.tenantId)
                  .where('organization_id', '=', organizationId)
                  .orderBy('created_at', 'asc')
                  .orderBy('id', 'asc')
                  .forUpdate()
                  .executeTakeFirst();
          const invitationBrandId =
            brandIds?.[0] ?? [...lockedEventBrandIds][0] ?? fallbackBrand?.id;
          if (!invitationBrandId) {
            throw new ValidationError('An invitation email requires at least one workspace brand');
          }

          const memberRepo = new OrganizationMemberRepository(transactionDb);
          const invited = await memberRepo.invite({
            tenantId: principal.tenantId,
            organizationId,
            email,
            role,
            updateExistingRole: false,
          });
          const lockedMember = await memberRepo.findByIdForUpdate(
            principal.tenantId,
            organizationId,
            invited.id,
          );
          if (!lockedMember) throw new NotFoundError('OrganizationMember', invited.id);
          if (lockedMember.accepted_at) {
            throw new ConflictError(
              'This person is already a member. Use Edit member to change their role or scope.',
            );
          }
          const updatedMember =
            lockedMember.role === role
              ? lockedMember
              : await memberRepo.updateRole(invited.id, role);
          await new PermissionGrantRepository(transactionDb).replaceRoleGrants({
            tenantId: principal.tenantId,
            principalId: lockedMember.user_id as string,
            organizationId,
            organizationMemberId: lockedMember.id,
            permissions,
            brandIds,
            eventIds,
          });
          const queuedEmail = await queueOrganizationInvitationEmail({
            db: transactionDb,
            tenantId: principal.tenantId,
            organizationName: String(lockedOrganization.name),
            brandId: String(invitationBrandId),
            email,
            idempotencyKey: emailJobKey,
            returnTo,
          });
          const response = {
            status: 201,
            body: {
              id: updatedMember.id,
              organizationId: updatedMember.organization_id,
              name: email.split('@')[0] || email,
              email,
              role: updatedMember.role,
              status: 'invited',
              invitedAt: updatedMember.invited_at,
              joinedAt: updatedMember.accepted_at,
              brandIds: brandIds ?? [],
              eventIds: eventIds ?? [],
              invitationDelivery: 'queued',
              invitationProvider: 'temporal',
            },
          };
          await writeAuditLog(
            new AuditLogRepository(transactionDb),
            request,
            principal,
            {
              action: 'organization_member.invited',
              organizationId,
              resourceType: 'Organization',
              resourceId: organizationId,
              diffSummary: {
                email,
                role,
                brandIds,
                eventIds,
                permissions,
                emailJobId: queuedEmail.id,
              },
            },
            { failClosed: true },
          );
          await completeInTransaction(transactionDb, response);
          return response;
        }),
    );

    const emailJob = await new EmailJobRepository(db).findByIdempotencyKey(
      principal.tenantId,
      emailJobKey,
    );
    if (!emailJob) throw new Error('Durable invitation delivery job is missing');
    if (!emailJob.workflow_id && ['queued', 'start_failed'].includes(emailJob.status)) {
      try {
        const workflowHandle = await app.context.temporalClient.startNotificationDelivery({
          jobId: emailJob.id,
          tenantId: principal.tenantId,
          brandId: emailJob.brand_id,
          templateKey: 'organization-member-invited',
          templateVersionId: emailJob.template_version_id,
          toEmail: emailJob.to_email,
          variables: parseJsonObject(emailJob.variables),
          providerRouteId: emailJob.provider_route_id,
          notificationType: 'staff',
        });
        await new EmailJobRepository(db).update(emailJob.id, {
          status: 'queued',
          workflow_id:
            workflowHandle && typeof workflowHandle.workflowId === 'string'
              ? workflowHandle.workflowId
              : `notification:${emailJob.id}`,
        });
      } catch (error) {
        await new EmailJobRepository(db).update(emailJob.id, {
          status: 'start_failed',
          workflow_id: null,
        });
        throw new Error('Invitation was queued but delivery could not be started', {
          cause: error,
        });
      }
    }

    return reply.status(result.status).send(result.body);
  });

  app.patch('/organizations/:organizationId/members/:memberId', async (request) => {
    const principal = request.principal!;
    if (principal.type !== 'user') {
      throw new ForbiddenError('Organization member updates require a user principal');
    }

    const { organizationId, memberId } = request.params as {
      organizationId: string;
      memberId: string;
    };
    const body = parseBody(updateOrganizationMemberSchema, request.body);
    const { role, brandIds, eventIds } = body;
    const rawIdempotencyKey = request.headers['idempotency-key'];
    if (
      typeof rawIdempotencyKey !== 'string' ||
      rawIdempotencyKey.length < 16 ||
      rawIdempotencyKey.length > 255 ||
      rawIdempotencyKey.trim() !== rawIdempotencyKey
    ) {
      throw new ValidationError(
        'Idempotency-Key must contain 16-255 characters with no surrounding whitespace',
      );
    }
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');
    const idempotencyKey = `organization-member-update:${hashRequest({
      key: rawIdempotencyKey,
    })}`;
    const permissions = permissionsForRole(role);
    const response = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        discardErrorCodes: ['FORBIDDEN', 'NOT_FOUND', 'VALIDATION_ERROR'],
        requestHash: hashRequest({
          operation: 'organization-member.update',
          actorId: principal.id,
          organizationId,
          memberId,
          body,
        }),
      },
      async ({ completeInTransaction }) => {
        const result = await db.transaction().execute(async (trx) => {
          const transactionDb = trx as Database;
          const organization = await transactionDb
            .selectFrom('organizations')
            .selectAll()
            .where('id', '=', organizationId)
            .forUpdate()
            .executeTakeFirst();
          if (!organization) throw new NotFoundError('Organization', organizationId);
          ClerkAuthService.requireResourceTenant(
            principal,
            organization,
            'Organization',
            organizationId,
          );
          await requireLiveOrganizationMemberPermission(
            transactionDb,
            principal,
            organizationId,
            'settings.write',
          );

          for (const brandId of brandIds ?? []) {
            const brand = await transactionDb
              .selectFrom('brands')
              .selectAll()
              .where('tenant_id', '=', principal.tenantId)
              .where('id', '=', brandId)
              .forUpdate()
              .executeTakeFirst();
            if (!brand || brand.organization_id !== organizationId) {
              throw new NotFoundError('Brand', brandId);
            }
            ClerkAuthService.requireBrandScope(principal, brandId);
          }

          for (const eventId of eventIds ?? []) {
            const event = await transactionDb
              .selectFrom('events')
              .selectAll()
              .where('tenant_id', '=', principal.tenantId)
              .where('id', '=', eventId)
              .forUpdate()
              .executeTakeFirst();
            if (!event || event.organization_id !== organizationId) {
              throw new NotFoundError('Event', eventId);
            }
            ClerkAuthService.requireEventScope(principal, eventId);
            ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
          }

          const transactionMembers = new OrganizationMemberRepository(transactionDb);
          const existing = await transactionMembers.findByIdForUpdate(
            principal.tenantId,
            organizationId,
            memberId,
          );
          if (!existing) throw new NotFoundError('OrganizationMember', memberId);
          if (existing.role === 'owner') {
            throw new ValidationError('Owner role cannot be changed through this endpoint');
          }
          if (
            existing.user_id === principal.id &&
            (role !== 'admin' || (brandIds?.length ?? 0) > 0 || (eventIds?.length ?? 0) > 0)
          ) {
            throw new ValidationError('You cannot remove or scope down your own admin access');
          }

          await transactionMembers.updateRole(memberId, role);
          await new PermissionGrantRepository(transactionDb).replaceRoleGrants({
            tenantId: principal.tenantId,
            principalId: existing.user_id as string,
            organizationId,
            organizationMemberId: existing.id,
            permissions,
            brandIds,
            eventIds,
          });
          const updated = await transactionMembers.findById(
            principal.tenantId,
            organizationId,
            memberId,
          );
          if (!updated) throw new NotFoundError('OrganizationMember', memberId);
          const responseBody = {
            id: updated.id,
            organizationId: updated.organization_id,
            name:
              [updated.first_name, updated.last_name].filter(Boolean).join(' ') || updated.email,
            email: updated.email,
            role: updated.role,
            status: updated.accepted_at ? updated.user_status : 'invited',
            invitedAt: updated.invited_at,
            joinedAt: updated.accepted_at,
            brandIds: brandIds ?? [],
            eventIds: eventIds ?? [],
          };
          await writeAuditLog(
            new AuditLogRepository(transactionDb),
            request,
            principal,
            {
              action: 'organization_member.role_updated',
              organizationId,
              resourceType: 'OrganizationMember',
              resourceId: memberId,
              diffSummary: {
                previousRole: existing.role,
                role,
                brandIds,
                eventIds,
                permissions,
                userId: updated.user_id,
              },
            },
            { failClosed: true },
          );
          const idempotentResponse = { status: 200, body: responseBody };
          await completeInTransaction(transactionDb, idempotentResponse);
          return idempotentResponse;
        });
        return result;
      },
    );
    return response.body;
  });

  app.post('/brands', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    requireBrandCreationPrincipal(principal);
    const body = parseBody(createBrandSchema, request.body);

    const organization = await new OrganizationRepository(db).findById(body.organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(
      principal,
      organization,
      'Organization',
      body.organizationId,
    );
    ClerkAuthService.requireOrganizationScope(principal, body.organizationId);

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.create({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      name: body.name,
      slug: body.slug,
      theme: body.theme,
      whiteLabel: body.whiteLabel,
    });

    await writeAuditLog(audit(), request, principal, {
      action: 'brand.created',
      organizationId: body.organizationId,
      brandId: brand.id,
      resourceType: 'Brand',
      resourceId: brand.id,
      diffSummary: {
        name: body.name,
        slug: body.slug,
        organizationId: body.organizationId,
      },
    });

    return reply.status(201).send(serializeBrand(brand));
  });

  app.patch('/brands/:brandId', async (request) => {
    const principal = request.principal!;
    const { brandId } = request.params as { brandId: string };
    const rawBody = request.body;
    const isPaymentAccountBindingOnly =
      rawBody !== null &&
      typeof rawBody === 'object' &&
      !Array.isArray(rawBody) &&
      Object.keys(rawBody).length === 1 &&
      Object.prototype.hasOwnProperty.call(rawBody, 'paymentAccountId');

    if (isPaymentAccountBindingOnly) {
      requireAnyPermission(principal, ['settings.write', 'billing.write']);
    } else {
      ClerkAuthService.requirePermission(principal, 'settings.write');
    }
    ClerkAuthService.requireNoEventScope(principal, 'brand settings');
    const body = parseBody(updateBrandSchema, rawBody);
    const paymentAccountBindingId =
      body.paymentAccountId !== undefined && body.paymentAccountId !== null
        ? body.paymentAccountId
        : undefined;
    const brandPreflight = await db
      .selectFrom('brands')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .where('id', '=', brandId)
      .executeTakeFirst();
    if (!brandPreflight) throw new NotFoundError('Brand', 'concealed');
    try {
      ClerkAuthService.requireResourceTenant(principal, brandPreflight, 'Brand', brandId);
      ClerkAuthService.requireBrandScope(principal, brandId);
      ClerkAuthService.requireOrganizationScope(principal, brandPreflight.organization_id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Brand', 'concealed');
      throw error;
    }
    if (paymentAccountBindingId) {
      const accountPreflight = await db
        .selectFrom('payment_accounts')
        .select('id')
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', paymentAccountBindingId)
        .executeTakeFirst();
      if (!accountPreflight) throw new ValidationError('Payment account not found');
    }
    const updated = await executeBrandUpdateWithRetry(() =>
      db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (trx) => {
          const transactionDb = trx as Database;
          await app.context.brandUpdateCheckpoint?.({
            stage: 'before_brand_lock',
            brandId,
            ...(body.paymentAccountId !== undefined
              ? { paymentAccountId: body.paymentAccountId }
              : {}),
          });
          const brand = await trx
            .selectFrom('brands')
            .selectAll()
            .where('tenant_id', '=', principal.tenantId)
            .where('id', '=', brandId)
            .forUpdate()
            .executeTakeFirst();
          if (!brand) throw new NotFoundError('Brand', 'concealed');
          await app.context.brandUpdateCheckpoint?.({
            stage: 'after_brand_lock',
            brandId,
            ...(body.paymentAccountId !== undefined
              ? { paymentAccountId: body.paymentAccountId }
              : {}),
          });
          try {
            ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
            ClerkAuthService.requireBrandScope(principal, brandId);
            ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
          } catch (error) {
            if (error instanceof NotFoundError) throw new NotFoundError('Brand', 'concealed');
            throw error;
          }

          if (paymentAccountBindingId) {
            const paymentAccount = await trx
              .selectFrom('payment_accounts')
              .selectAll()
              .where('tenant_id', '=', principal.tenantId)
              .where('id', '=', paymentAccountBindingId)
              .forUpdate()
              .executeTakeFirst();
            if (!paymentAccount) throw new ValidationError('Payment account not found');
            ClerkAuthService.requireResourceTenant(
              principal,
              paymentAccount,
              'PaymentAccount',
              paymentAccount.id,
            );
            if (paymentAccount.organization_id !== brand.organization_id) {
              throw new ValidationError(
                "Payment account does not belong to the brand's organization",
              );
            }
            await app.context.brandUpdateCheckpoint?.({
              stage: 'after_account_lock',
              brandId,
              paymentAccountId: paymentAccountBindingId,
            });
          }

          const before = brandAuditSnapshot(brand as unknown as Record<string, unknown>);
          const updated = await new BrandRepository(transactionDb).update(brandId, {
            ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
            ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
            ...(typeof body.status === 'string' ? { status: body.status } : {}),
            ...(body.theme !== undefined ? { theme: JSON.stringify(body.theme) } : {}),
            ...(body.supportUrl !== undefined ? { support_url: body.supportUrl } : {}),
            ...(body.whiteLabel !== undefined ? { white_label: Boolean(body.whiteLabel) } : {}),
            ...(body.legalUrls !== undefined ? { legal_urls: JSON.stringify(body.legalUrls) } : {}),
            ...(body.paymentAccountId !== undefined
              ? { payment_account_id: body.paymentAccountId ?? null }
              : {}),
          });
          const after = brandAuditSnapshot(updated as unknown as Record<string, unknown>);
          await writeAuditLog(
            new AuditLogRepository(transactionDb),
            request,
            principal,
            {
              action: 'brand.updated',
              organizationId: brand.organization_id,
              brandId,
              resourceType: 'Brand',
              resourceId: brandId,
              diffSummary: brandUpdateAuditDiff(before, after),
            },
            { failClosed: true },
          );
          return updated;
        }),
    );
    return serializeBrand(updated);
  });

  app.post('/brands/:brandId/domains', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    ClerkAuthService.requireNoEventScope(principal, 'brand domains');
    const { brandId } = request.params as { brandId: string };
    const brandPreflight = await db
      .selectFrom('brands')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .where('id', '=', brandId)
      .executeTakeFirst();
    if (!brandPreflight) throw new NotFoundError('Brand', 'concealed');
    try {
      ClerkAuthService.requireResourceTenant(principal, brandPreflight, 'Brand', brandId);
      ClerkAuthService.requireBrandScope(principal, brandId);
      ClerkAuthService.requireOrganizationScope(principal, brandPreflight.organization_id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Brand', 'concealed');
      throw error;
    }

    // Do not parse the request until permissions and the addressed Brand are authorized.
    // That keeps malformed payloads from becoming an authorization/resource oracle.
    const body = parseBody(addBrandDomainSchema, request.body);
    const domain = await executeBrandUpdateWithRetry(() =>
      db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (trx) => {
          const transactionDb = trx as Database;
          await app.context.brandDomainCreateCheckpoint?.({
            stage: 'before_brand_lock',
            brandId,
            domain: body.domain,
          });
          const brand = await trx
            .selectFrom('brands')
            .selectAll()
            .where('tenant_id', '=', principal.tenantId)
            .where('id', '=', brandId)
            .forUpdate()
            .executeTakeFirst();
          if (!brand) throw new NotFoundError('Brand', 'concealed');
          await app.context.brandDomainCreateCheckpoint?.({
            stage: 'after_brand_lock',
            brandId,
            domain: body.domain,
          });
          ClerkAuthService.requirePermission(principal, 'settings.write');
          ClerkAuthService.requireNoEventScope(principal, 'brand domains');
          try {
            ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
            ClerkAuthService.requireBrandScope(principal, brandId);
            ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
          } catch (error) {
            if (error instanceof NotFoundError) throw new NotFoundError('Brand', 'concealed');
            throw error;
          }

          // This lookup deliberately exposes no owning Brand. The unique index remains
          // authoritative under concurrent inserts; its error is normalized below.
          const existingDomain = await trx
            .selectFrom('brand_domains')
            .select('id')
            .where('domain', '=', body.domain)
            .executeTakeFirst();
          if (existingDomain) throw new ConflictError('Domain is already assigned');

          await app.context.brandDomainCreateCheckpoint?.({
            stage: 'before_domain_insert',
            brandId,
            domain: body.domain,
          });
          const demotedPrimaries = body.isPrimary
            ? await trx
                .selectFrom('brand_domains')
                .select(['id', 'domain'])
                .where('brand_id', '=', brandId)
                .where('is_primary', '=', true)
                .orderBy('id')
                .execute()
            : [];
          if (body.isPrimary) {
            await trx
              .updateTable('brand_domains')
              .set({ is_primary: false, updated_at: new Date() })
              .where('brand_id', '=', brandId)
              .where('is_primary', '=', true)
              .execute();
          }
          const id = `bdom_${ulid()}`;
          const now = new Date();
          try {
            await trx
              .insertInto('brand_domains')
              .values({
                id,
                brand_id: brandId,
                domain: body.domain,
                is_primary: body.isPrimary ?? false,
                is_verified: false,
                ssl_status: 'pending',
                created_at: now,
                updated_at: now,
              })
              .execute();
          } catch (error) {
            if (isDuplicateInsert(error)) throw new ConflictError('Domain is already assigned');
            throw error;
          }
          const persisted = await trx
            .selectFrom('brand_domains')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst();
          if (!persisted) throw new Error('BRAND_DOMAIN_INSERT_NOT_PERSISTED');
          await writeAuditLog(
            new AuditLogRepository(transactionDb),
            request,
            principal,
            {
              action: 'brand_domain.created',
              organizationId: brand.organization_id,
              brandId,
              resourceType: 'BrandDomain',
              resourceId: id,
              diffSummary: {
                after: {
                  brandId,
                  domain: persisted.domain,
                  isPrimary: boolValue(persisted.is_primary),
                  demotedPrimaries: demotedPrimaries.map((primary) => ({
                    id: primary.id,
                    domain: primary.domain,
                  })),
                },
              },
            },
            { failClosed: true },
          );
          return persisted;
        }),
    );
    return reply.status(201).send(serializeBrandDomain(domain));
  });

  app.get('/brands/:brandId/email-sender-identities', async (request) => {
    const principal = request.principal!;
    requireAnyPermission(principal, ['settings.write', 'messages.write']);
    ClerkAuthService.requireNoEventScope(principal, 'brand sender identities');
    const { brandId } = request.params as { brandId: string };

    const brand = await new BrandRepository(db).findById(brandId);
    if (!brand) throw new NotFoundError('Brand', brandId);
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
    ClerkAuthService.requireBrandScope(principal, brandId);
    ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);

    const identities = await new BrandSenderIdentityRepository(db).findByBrand(
      principal.tenantId,
      brandId,
    );
    return identities.map((identity) =>
      serializeBrandSenderIdentity(identity as Record<string, unknown>),
    );
  });

  app.get('/brands', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    ClerkAuthService.requireNoEventScope(principal, 'brand settings');
    const scopedBrands = await scopedBrandsFor(principal);
    const brandIds = scopedBrands.map((brand) => String(brand.id));
    const domains =
      brandIds.length > 0
        ? await db
            .selectFrom('brand_domains')
            .selectAll()
            .where('brand_id', 'in', brandIds)
            .execute()
        : [];
    const domainsByBrandId = new Map<string, Array<Record<string, unknown>>>();
    for (const domain of domains) {
      const brandId = String(domain.brand_id);
      const current = domainsByBrandId.get(brandId) ?? [];
      current.push(domain);
      domainsByBrandId.set(brandId, current);
    }

    return scopedBrands.map((brand) =>
      Object.assign(serializeBrand(brand), {
        domains: (domainsByBrandId.get(String(brand.id)) ?? []).map(serializeBrandDomain),
      }),
    );
  });

  app.get('/organizations/:organizationId/payment-accounts', async (request) => {
    const principal = request.principal!;
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'billing.write');

    const accounts = await new PaymentAccountRepository(db).findByOrganization(organizationId);
    return accounts.map((account) => serializePaymentAccount(account));
  });

  app.post(
    '/organizations/:organizationId/payment-accounts/stripe-connect',
    async (request, reply) => {
      const principal = request.principal!;
      const { organizationId } = request.params as { organizationId: string };
      const organization = await new OrganizationRepository(db).findById(organizationId);
      if (!organization) throw new ValidationError('Organization not found');
      ClerkAuthService.requireResourceTenant(
        principal,
        organization,
        'Organization',
        organizationId,
      );
      await requireOrganizationScopedPermission(db, principal, organizationId, 'billing.write');
      const requestIdempotencyKey = requireStripeConnectIdempotencyKey(
        request.headers['idempotency-key'],
      );

      const paymentAccounts = new PaymentAccountRepository(db);
      const activeStripe = await paymentAccounts.findByOrganizationAndProvider(
        organizationId,
        'stripe_connect',
      );
      const stripe = stripeGatewayFromContext(
        app.context,
        (event) => observeApiPaymentProviderAttempt(app.observability.metrics, event),
        { tenantId: organization.tenant_id, organizationId },
      );
      if (!stripe) {
        if (activeStripe) return reply.status(200).send(serializePaymentAccount(activeStripe));
        throw new ValidationError(
          'Stripe Connect onboarding is not configured for this environment',
        );
      }

      let account = activeStripe;
      let wasCreated = false;
      if (!account) {
        const stripeAccount = await stripe
          .createConnectAccount({
            country: 'US',
            businessName: organization.name,
            metadata: {
              tenantId: organization.tenant_id,
              organizationId: organization.id,
            },
            idempotencyKey: `stripe-connect-account:${organization.tenant_id}:${organization.id}`,
          })
          .catch(stripeConnectProviderError);
        const stripeState = stripeAccountState(stripeAccount);
        try {
          account = await paymentAccounts.create({
            tenantId: organization.tenant_id,
            organizationId,
            provider: 'stripe_connect',
            providerAccountId: stripeAccount.id,
            status: stripeState.status,
            defaultCurrency: stripeState.defaultCurrency,
            detailsSubmitted: stripeState.detailsSubmitted,
            chargesEnabled: stripeState.chargesEnabled,
            payoutsEnabled: stripeState.payoutsEnabled,
            requirements: stripeState.requirements,
            disabledReason: stripeState.disabledReason,
          });
          wasCreated = true;
        } catch (error) {
          if (!isDuplicateInsert(error)) throw error;
          account = await db
            .selectFrom('payment_accounts')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('provider', '=', 'stripe_connect')
            .executeTakeFirst();
          if (!account) throw error;
          if (stripeAccount.id !== account.provider_account_id) {
            await new PaymentAccountCleanupCommandRepository(db).enqueue({
              tenantId: organization.tenant_id,
              organizationId: organization.id,
              provider: 'stripe_connect',
              providerAccountId: stripeAccount.id,
              idempotencyKey: `stripe-connect-cleanup:${organization.tenant_id}:${organization.id}:${stripeAccount.id}`,
              reason: 'concurrent_create_loser',
            });
          }
        }

        if (wasCreated) {
          await writeAuditLog(audit(), request, principal, {
            action: 'payment_account.created',
            organizationId,
            resourceType: 'PaymentAccount',
            resourceId: account.id,
            diffSummary: {
              provider: 'stripe_connect',
              providerAccountId: stripeAccount.id,
              organizationId,
            },
          });
        }
      }

      const accountLink = await stripe
        .createAccountLink({
          accountId: account.provider_account_id,
          refreshUrl: stripeConnectRefreshUrl(organizationId),
          returnUrl: stripeConnectReturnUrl(organizationId),
          idempotencyKey: `${requestIdempotencyKey}:account-link:${account.provider_account_id}`,
        })
        .catch(stripeConnectProviderError);

      return reply
        .status(wasCreated ? 201 : 200)
        .send(serializePaymentAccount(account, accountLink.url));
    },
  );

  app.post(
    '/organizations/:organizationId/payment-accounts/:paymentAccountId/stripe-connect/refresh',
    async (request) => {
      const principal = request.principal!;
      const { organizationId, paymentAccountId } = request.params as {
        organizationId: string;
        paymentAccountId: string;
      };
      const organization = await new OrganizationRepository(db).findById(organizationId);
      if (!organization) throw new NotFoundError('Organization', organizationId);
      ClerkAuthService.requireResourceTenant(
        principal,
        organization,
        'Organization',
        organizationId,
      );
      await requireOrganizationScopedPermission(db, principal, organizationId, 'billing.write');
      const requestIdempotencyKey = requireStripeConnectIdempotencyKey(
        request.headers['idempotency-key'],
      );

      const paymentAccounts = new PaymentAccountRepository(db);
      const account = await paymentAccounts.reserveRefreshGeneration({
        id: paymentAccountId,
        tenantId: principal.tenantId,
        organizationId,
        provider: 'stripe_connect',
      });
      if (!account) {
        throw new NotFoundError('PaymentAccount', paymentAccountId);
      }

      const stripe = stripeGatewayFromContext(
        app.context,
        (event) => observeApiPaymentProviderAttempt(app.observability.metrics, event),
        { tenantId: organization.tenant_id, organizationId },
      );
      if (!stripe) {
        throw new ValidationError(
          'Stripe Connect status refresh is not configured for this environment',
        );
      }

      const stripeAccount = await stripe
        .retrieveConnectAccount(account.provider_account_id)
        .catch(stripeConnectProviderError);
      const stripeState = stripeAccountState(stripeAccount);
      const updated = await db.transaction().execute(async (trx) => {
        const transactionalAccounts = new PaymentAccountRepository(trx);
        const completionClaim = {
          id: account.id,
          tenantId: principal.tenantId,
          organizationId,
          provider: 'stripe_connect',
          refreshGeneration: account.refresh_generation,
        };
        const persistedAccount =
          await transactionalAccounts.claimRefreshCompletion(completionClaim);
        if (!persistedAccount) {
          throw new ConflictError('A newer payment account refresh superseded this response');
        }
        const previousState = paymentAccountMaterialState(account);
        const persistedState = paymentAccountMaterialState(persistedAccount);
        if (hashRequest(persistedState) !== hashRequest(previousState)) {
          throw new ConflictError(
            'Payment account changed while Stripe status was being refreshed',
          );
        }
        const nextState = {
          status: stripeState.status,
          defaultCurrency: stripeState.defaultCurrency ?? persistedAccount.default_currency,
          detailsSubmitted: stripeState.detailsSubmitted,
          chargesEnabled: stripeState.chargesEnabled,
          payoutsEnabled: stripeState.payoutsEnabled,
          requirements: stripeState.requirements,
          disabledReason: stripeState.disabledReason,
        };
        if (hashRequest(nextState) === hashRequest(persistedState)) {
          return persistedAccount;
        }
        const refreshedAccount = await transactionalAccounts.completeRefreshGeneration(
          completionClaim,
          nextState,
        );
        if (!refreshedAccount) {
          throw new ConflictError('A newer payment account refresh superseded this response');
        }

        await writeAuditLog(
          new AuditLogRepository(trx),
          request,
          principal,
          {
            action: 'payment_account.refreshed',
            organizationId,
            resourceType: 'PaymentAccount',
            resourceId: refreshedAccount.id,
            diffSummary: {
              providerAccountId: refreshedAccount.provider_account_id,
              before: persistedState,
              after: paymentAccountMaterialState(refreshedAccount),
            },
          },
          { failClosed: true },
        );
        return refreshedAccount;
      });

      const accountLink = await stripe
        .createAccountLink({
          accountId: updated.provider_account_id,
          refreshUrl: stripeConnectRefreshUrl(organizationId),
          returnUrl: stripeConnectReturnUrl(organizationId),
          idempotencyKey: `${requestIdempotencyKey}:account-link:${updated.provider_account_id}`,
        })
        .catch(stripeConnectProviderError);

      return serializePaymentAccount(updated, accountLink.url);
    },
  );

  app.get('/organizations/:organizationId/billing', async (request) => {
    const principal = request.principal!;
    const { organizationId } = request.params as { organizationId: string };
    await requireOrganizationScopedPermission(db, principal, organizationId, 'billing.write');
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new NotFoundError('Organization', organizationId);
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);

    const tenant = await db
      .selectFrom('tenants')
      .select(['plan', 'status'])
      .where('id', '=', principal.tenantId)
      .executeTakeFirst();
    const now = new Date();
    const billingMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const billingMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const ticketStats = await db
      .selectFrom('tickets')
      .innerJoin('events', 'events.id', 'tickets.event_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tickets.tenant_id', '=', principal.tenantId)
      .where('events.tenant_id', '=', principal.tenantId)
      .where('events.organization_id', '=', organizationId)
      .where('tickets.created_at', '>=', billingMonthStart)
      .where('tickets.created_at', '<', billingMonthEnd)
      .executeTakeFirst();

    return {
      organizationId,
      plan: tenant?.plan ?? 'free',
      status: tenant?.status ?? 'active',
      ticketsThisMonth: Number(ticketStats?.count ?? 0),
    };
  });
};
