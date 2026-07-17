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
): Promise<void> {
  ClerkAuthService.requirePermission(principal, permission);
  ClerkAuthService.requireOrganizationScope(principal, organizationId);
  if (principal.type === 'system') return;
  if (principal.type !== 'user') {
    throw new ForbiddenError('This organization-wide operation requires a user principal');
  }
  const grant = await db
    .selectFrom('permission_grants')
    .select('id')
    .where('tenant_id', '=', principal.tenantId)
    .where('principal_type', '=', 'user')
    .where('principal_id', '=', principal.id)
    .where('permission', '=', permission)
    .where('scope_type', '=', 'organization')
    .where('scope_id', '=', organizationId)
    .executeTakeFirst();
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
    templateVersionId: publishedTemplate?.version.id ?? 'system_organization_member_invited_v1',
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
    const principal = request.principal!;
    requireAnyPermission(principal, dashboardContextPermissions);
    // Door-only / event-scoped staff still need org+brand context for the door shell.
    // Full dashboard surfaces continue to reject event-scoped principals.
    if (!isDoorOnlyPermissionSet(principal.scopes)) {
      ClerkAuthService.requireNoEventScope(principal, 'brand-wide dashboard context');
    }
    const includeSettings = ClerkAuthService.hasPermission(principal, 'settings.write');
    const [organizations, brands] = await Promise.all([
      scopedOrganizationsFor(principal),
      scopedBrandsFor(principal),
    ]);
    const brandIds = includeSettings ? brands.map((brand) => String(brand.id)) : [];
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
      organizations: organizations.map((organization) =>
        serializeBootstrapOrganization(organization, includeSettings),
      ),
      brands: brands.map((brand) => {
        const serialized = serializeBootstrapBrand(brand, includeSettings);
        return includeSettings
          ? Object.assign(serialized, {
              domains: (domainsByBrandId.get(String(brand.id)) ?? []).map(serializeBrandDomain),
            })
          : serialized;
      }),
    };
  });

  app.patch('/organizations/:organizationId', async (request) => {
    const principal = request.principal!;
    const { organizationId } = request.params as { organizationId: string };
    const current = await new OrganizationRepository(db).findById(organizationId);
    if (!current) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, current, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');

    const body = parseBody(updateOrganizationSchema, request.body);
    await requireUniqueClerkOrganizationId(db, body.clerkOrganizationId, organizationId);
    let updated;
    try {
      updated = await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('organizations')
          .select('id')
          .where('id', '=', organizationId)
          .where('tenant_id', '=', principal.tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
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
        return new OrganizationRepository(trx as typeof db).update(organizationId, {
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
      });
    } catch (err) {
      if (isDuplicateInsert(err)) {
        throw new ValidationError(
          'Clerk organization ID is already assigned to another organization',
        );
      }
      throw err;
    }
    await writeAuditLog(audit(), request, principal, {
      action: 'organization.updated',
      organizationId,
      resourceType: 'Organization',
      resourceId: organizationId,
      diffSummary: {
        ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
        ...(body.clerkOrganizationId !== undefined
          ? { clerkOrganizationId: body.clerkOrganizationId }
          : {}),
        ...(body.boxOfficeSettings !== undefined
          ? { boxOfficeSettings: body.boxOfficeSettings }
          : {}),
        ...(body.eventDefaults !== undefined ? { eventDefaults: body.eventDefaults } : {}),
      },
    });
    return serializeOrganization(updated);
  });

  app.get('/organizations/:organizationId/members', async (request) => {
    const principal = request.principal!;
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');

    const rows = await new OrganizationMemberRepository(db).findByOrganization(
      principal.tenantId,
      organizationId,
    );
    const userIds = rows.map((row) => row.user_id);
    const [organizationBrands, organizationEvents, grants] = await Promise.all([
      db
        .selectFrom('brands')
        .select('id')
        .where('tenant_id', '=', principal.tenantId)
        .where('organization_id', '=', organizationId)
        .execute(),
      db
        .selectFrom('events')
        .select('id')
        .where('tenant_id', '=', principal.tenantId)
        .where('organization_id', '=', organizationId)
        .execute(),
      userIds.length > 0
        ? db
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

  app.post('/organizations/:organizationId/members/invitations', async (request, reply) => {
    const principal = request.principal!;
    if (principal.type !== 'user') {
      throw new ForbiddenError('Organization member invitations require a user principal');
    }
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');

    const body = parseBody(createOrganizationInvitationSchema, request.body);
    const { email, role, brandIds, eventIds, returnTo } = body;
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new ValidationError('Idempotency-Key header is required for member invitations');
    }

    if (brandIds?.length) {
      const brandRepo = new BrandRepository(db);
      for (const brandId of brandIds) {
        const brand = await brandRepo.findById(brandId);
        if (!brand || brand.organization_id !== organizationId) {
          throw new ValidationError(`Brand ${brandId} is not part of this organization`);
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
          throw new ValidationError(`Event ${eventId} is not part of this organization`);
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

    const invitationBrandId =
      brandIds?.[0] ??
      [...eventBrandIds][0] ??
      (await new BrandRepository(db).findByOrganization(organizationId))[0]?.id;
    if (!invitationBrandId) {
      throw new ValidationError('An invitation email requires at least one workspace brand');
    }

    const permissions = permissionsForRole(role);
    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({ organizationId, ...body }),
      },
      async () => {
        const emailJobKey = `organization-invitation:${hashRequest({ organizationId, email, idempotencyKey })}`;
        // Resolve the conflict-prone user/member creation in autocommit mode.
        // PostgreSQL aborts an explicit transaction after a unique violation,
        // so the transaction below only performs locked, exception-free updates.
        const invited = await new OrganizationMemberRepository(db).invite({
          tenantId: principal.tenantId,
          organizationId,
          email,
          role,
          updateExistingRole: false,
        });
        const { member, emailJob } = await db.transaction().execute(async (trx) => {
          const transactionDb = trx as Database;
          const memberRepo = new OrganizationMemberRepository(transactionDb);
          const lockedMember = await memberRepo.findByIdForUpdate(
            principal.tenantId,
            organizationId,
            invited.id,
          );
          if (!lockedMember) throw new ValidationError('Organization member not found');
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
            permissions,
            brandIds,
            eventIds,
          });
          const queuedEmail = await queueOrganizationInvitationEmail({
            db: transactionDb,
            tenantId: principal.tenantId,
            organizationName: String(organization.name),
            brandId: String(invitationBrandId),
            email,
            idempotencyKey: emailJobKey,
            returnTo,
          });
          return { member: updatedMember, emailJob: queuedEmail };
        });

        const variables = {
          recipient: { name: email.split('@')[0] || email },
          brand: { name: String(organization.name) },
          dashboard: {
            url: (() => {
              const url = new URL('/sign-up', adminDashboardOrigin());
              if (returnTo) url.searchParams.set('redirect_url', returnTo);
              return url.toString();
            })(),
          },
          notificationType: 'staff' as const,
        };
        try {
          const workflowHandle = await app.context.temporalClient.startNotificationDelivery({
            jobId: emailJob.id,
            tenantId: principal.tenantId,
            brandId: String(invitationBrandId),
            templateKey: 'organization-member-invited',
            templateVersionId: emailJob.template_version_id,
            toEmail: email,
            variables,
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

        await writeAuditLog(audit(), request, principal, {
          action: 'organization_member.invited',
          organizationId,
          resourceType: 'Organization',
          resourceId: organizationId,
          diffSummary: { email, role, brandIds, eventIds, permissions, emailJobId: emailJob.id },
        });

        return {
          status: 201,
          body: {
            id: member.id,
            organizationId: member.organization_id,
            name: email.split('@')[0] || email,
            email,
            role: member.role,
            status: 'invited',
            invitedAt: member.invited_at,
            joinedAt: member.accepted_at,
            brandIds: brandIds ?? [],
            eventIds: eventIds ?? [],
            invitationDelivery: 'queued',
            invitationProvider: 'temporal',
          },
        };
      },
    );

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
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'settings.write');

    const body = parseBody(updateOrganizationMemberSchema, request.body);
    const { role, brandIds, eventIds } = body;

    if (brandIds?.length) {
      const brandRepo = new BrandRepository(db);
      for (const brandId of brandIds) {
        const brand = await brandRepo.findById(brandId);
        if (!brand || brand.organization_id !== organizationId) {
          throw new ValidationError(`Brand ${brandId} is not part of this organization`);
        }
        ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
        ClerkAuthService.requireBrandScope(principal, brandId);
      }
    }

    if (eventIds?.length) {
      const eventRepo = new EventRepository(db);
      for (const eventId of eventIds) {
        const event = await eventRepo.findById(eventId);
        if (!event || event.organization_id !== organizationId) {
          throw new ValidationError(`Event ${eventId} is not part of this organization`);
        }
        ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
        ClerkAuthService.requireEventScope(principal, eventId);
        ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
      }
    }

    const memberRepo = new OrganizationMemberRepository(db);
    const existing = await memberRepo.findById(principal.tenantId, organizationId, memberId);
    if (!existing) throw new ValidationError('Organization member not found');

    if (existing.role === 'owner') {
      throw new ValidationError('Owner role cannot be changed through this endpoint');
    }
    if (existing.user_id === principal.id && role !== 'admin') {
      throw new ValidationError('You cannot remove your own admin access');
    }

    const permissions = permissionsForRole(role);
    const previousRole = existing.role;
    const updated = await db.transaction().execute(async (trx) => {
      const transactionDb = trx as Database;
      const transactionMembers = new OrganizationMemberRepository(transactionDb);
      await transactionMembers.updateRole(memberId, role);
      await new PermissionGrantRepository(transactionDb).replaceRoleGrants({
        tenantId: principal.tenantId,
        principalId: existing.user_id as string,
        organizationId,
        permissions,
        brandIds,
        eventIds,
      });
      const result = await transactionMembers.findById(
        principal.tenantId,
        organizationId,
        memberId,
      );
      if (!result) throw new ValidationError('Organization member not found');
      return result;
    });

    await writeAuditLog(audit(), request, principal, {
      action: 'organization_member.role_updated',
      organizationId,
      resourceType: 'OrganizationMember',
      resourceId: memberId,
      diffSummary: {
        previousRole,
        role,
        brandIds,
        eventIds,
        permissions,
        userId: updated.user_id,
      },
    });

    return {
      id: updated.id,
      organizationId: updated.organization_id,
      name: [updated.first_name, updated.last_name].filter(Boolean).join(' ') || updated.email,
      email: updated.email,
      role: updated.role,
      status: updated.accepted_at ? updated.user_status : 'invited',
      invitedAt: updated.invited_at,
      joinedAt: updated.accepted_at,
      brandIds: brandIds ?? [],
      eventIds: eventIds ?? [],
    };
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
    const body = parseBody(updateBrandSchema, request.body);
    const isPaymentAccountBindingOnly =
      Object.keys(body).length === 1 &&
      Object.prototype.hasOwnProperty.call(body, 'paymentAccountId');

    if (isPaymentAccountBindingOnly) {
      requireAnyPermission(principal, ['settings.write', 'billing.write']);
    } else {
      ClerkAuthService.requirePermission(principal, 'settings.write');
    }
    ClerkAuthService.requireNoEventScope(principal, 'brand settings');

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
    ClerkAuthService.requireBrandScope(principal, brandId);
    ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);

    // Validate payment account belongs to the same tenant and organization
    // before binding it to the brand. Prevents cross-tenant/cross-org binding.
    if (body.paymentAccountId !== undefined && body.paymentAccountId !== null) {
      const paymentAccount = await new PaymentAccountRepository(db).findById(
        body.paymentAccountId as string,
      );
      if (!paymentAccount) {
        throw new ValidationError('Payment account not found');
      }
      ClerkAuthService.requireResourceTenant(
        principal,
        paymentAccount,
        'PaymentAccount',
        paymentAccount.id,
      );
      if (paymentAccount.organization_id !== brand.organization_id) {
        throw new ValidationError("Payment account does not belong to the brand's organization");
      }
    }

    const updated = await brandRepo.update(brandId, {
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
    await writeAuditLog(audit(), request, principal, {
      action: 'brand.updated',
      organizationId: brand.organization_id,
      brandId,
      resourceType: 'Brand',
      resourceId: brandId,
      diffSummary: {
        ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
        ...(typeof body.status === 'string' ? { status: body.status } : {}),
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.supportUrl !== undefined ? { supportUrl: body.supportUrl } : {}),
        ...(body.whiteLabel !== undefined ? { whiteLabel: Boolean(body.whiteLabel) } : {}),
        ...(body.legalUrls !== undefined ? { legalUrls: body.legalUrls } : {}),
        ...(body.paymentAccountId !== undefined
          ? { paymentAccountId: body.paymentAccountId ?? null }
          : {}),
      },
    });
    return serializeBrand(updated);
  });

  app.post('/brands/:brandId/domains', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    ClerkAuthService.requireNoEventScope(principal, 'brand domains');
    const { brandId } = request.params as { brandId: string };
    const body = parseBody(addBrandDomainSchema, request.body);

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
    ClerkAuthService.requireBrandScope(principal, brandId);
    ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
    const domain = await brandRepo.addDomain(brandId, body.domain, body.isPrimary);
    await writeAuditLog(audit(), request, principal, {
      action: 'brand_domain.created',
      organizationId: brand.organization_id,
      brandId,
      resourceType: 'Brand',
      resourceId: brandId,
      diffSummary: { domain: body.domain, isPrimary: body.isPrimary },
    });
    return reply.status(201).send(serializeBrandDomain(domain));
  });

  app.get('/brands/:brandId/email-sender-identities', async (request) => {
    const principal = request.principal!;
    requireAnyPermission(principal, ['settings.write', 'messages.write']);
    ClerkAuthService.requireNoEventScope(principal, 'brand sender identities');
    const { brandId } = request.params as { brandId: string };

    const brand = await new BrandRepository(db).findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
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
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    await requireOrganizationScopedPermission(db, principal, organizationId, 'billing.write');

    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', principal.tenantId)
      .executeTakeFirst();
    const ticketStats = await db
      .selectFrom('tickets')
      .innerJoin('events', 'events.id', 'tickets.event_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tickets.tenant_id', '=', principal.tenantId)
      .where('events.tenant_id', '=', principal.tenantId)
      .where('events.organization_id', '=', organizationId)
      .executeTakeFirst();

    return {
      organizationId,
      plan: tenant?.plan ?? 'free',
      status: tenant?.status ?? 'active',
      ticketsThisMonth: Number(ticketStats?.count ?? 0),
    };
  });
};
