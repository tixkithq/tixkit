import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  OrganizationRepository,
  OrganizationMemberRepository,
  BrandRepository,
  PaymentAccountRepository,
  AuditLogRepository,
} from '@tixkit/db';
import type { CreateOrganizationInput, CreateBrandInput, AddBrandDomainInput } from '@tixkit/domain';
import { ValidationError } from '@tixkit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import { parseBody, updateBrandSchema } from '../../http/schemas.js';
import Stripe from 'stripe';

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
  created_at: Date;
  updated_at: Date;
};

function parseJsonObject(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boolValue(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
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
    createdAt: account.created_at instanceof Date ? account.created_at.toISOString() : account.created_at,
    updatedAt: account.updated_at instanceof Date ? account.updated_at.toISOString() : account.updated_at,
    ...(onboardingUrl ? { onboardingUrl } : {}),
  };
}

function stripeConnectReturnUrl(organizationId: string): string {
  const baseUrl = process.env.ADMIN_DASHBOARD_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3001';
  return `${baseUrl.replace(/\/$/, '')}/settings/payments?organizationId=${encodeURIComponent(organizationId)}&stripeConnect=return`;
}

function stripeConnectRefreshUrl(organizationId: string): string {
  const baseUrl = process.env.ADMIN_DASHBOARD_URL ?? process.env.API_BASE_URL ?? 'http://localhost:3001';
  return `${baseUrl.replace(/\/$/, '')}/settings/payments?organizationId=${encodeURIComponent(organizationId)}&stripeConnect=refresh`;
}

function stripeAccountStatus(account: Stripe.Account): 'active' | 'pending' | 'restricted' {
  if (account.charges_enabled && account.payouts_enabled) return 'active';
  if ((account.requirements?.disabled_reason ?? null) !== null) return 'restricted';
  return 'pending';
}

function stripeAccountState(account: Stripe.Account) {
  return {
    status: stripeAccountStatus(account),
    defaultCurrency: account.default_currency?.toUpperCase() ?? 'USD',
    detailsSubmitted: Boolean(account.details_submitted),
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    requirements: account.requirements ? account.requirements as unknown as Record<string, unknown> : {},
    disabledReason: account.requirements?.disabled_reason ?? null,
  };
}

function stripeAccountLinkType(status: string): 'account_onboarding' | 'account_update' {
  return status === 'active' ? 'account_update' : 'account_onboarding';
}

function stripeClientFromContext(context: unknown): Pick<Stripe, 'accounts' | 'accountLinks'> | null {
  const injected = (context as { stripe?: Pick<Stripe, 'accounts' | 'accountLinks'> }).stripe;
  if (injected) return injected;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const connectClientId = process.env.STRIPE_CONNECT_CLIENT_ID;
  if (!secretKey || !connectClientId) return null;
  return new Stripe(secretKey);
}

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const audit = () => new AuditLogRepository(db);

  app.post('/organizations', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const body = request.body as CreateOrganizationInput;

    const repo = new OrganizationRepository(db);
    const org = await repo.create({
      tenantId: principal.tenantId,
      name: body.name,
      slug: body.slug,
      clerkOrganizationId: body.clerkOrganizationId,
    });

    return reply.status(201).send(org);
  });

  app.get('/organizations', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const repo = new OrganizationRepository(db);
    const orgs = await repo.findByTenant(principal.tenantId);
    // Filter by principal's organizations to prevent cross-org data exposure
    // within the same tenant. System principals see all orgs.
    if (principal.type === 'system') return orgs;
    return orgs.filter((org) => principal.organizationIds.includes(org.id));
  });

  app.patch('/organizations/:organizationId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { organizationId } = request.params as { organizationId: string };
    const current = await new OrganizationRepository(db).findById(organizationId);
    if (!current) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, current, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const body = request.body as {
      name?: string;
      slug?: string;
      clerkOrganizationId?: string | null;
    };
    const updated = await new OrganizationRepository(db).update(organizationId, {
      ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
      ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
      ...(body.clerkOrganizationId !== undefined ? { clerk_organization_id: body.clerkOrganizationId } : {}),
    });
    await writeAuditLog(audit(), request, principal, {
      action: 'organization.updated',
      organizationId,
      resourceType: 'Organization',
      resourceId: organizationId,
      diffSummary: {
        ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
        ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
        ...(body.clerkOrganizationId !== undefined ? { clerkOrganizationId: body.clerkOrganizationId } : {}),
      },
    });
    return updated;
  });

  app.get('/organizations/:organizationId/members', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const rows = await new OrganizationMemberRepository(db).findByOrganization(principal.tenantId, organizationId);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
      email: row.email,
      role: row.role,
      status: row.accepted_at ? row.user_status : 'invited',
      invitedAt: row.invited_at,
      joinedAt: row.accepted_at,
    }));
  });

  app.post('/organizations/:organizationId/members/invitations', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const body = request.body as { email?: string; role?: string };
    const email = body.email?.trim().toLowerCase();
    if (!email) throw new ValidationError('Email is required');
    const role = ['owner', 'admin', 'organizer', 'viewer'].includes(body.role ?? '') ? body.role! : 'viewer';

    const member = await new OrganizationMemberRepository(db).invite({
      tenantId: principal.tenantId,
      organizationId,
      email,
      role,
    });

    await writeAuditLog(audit(), request, principal, {
      action: 'organization_member.invited',
      organizationId,
      resourceType: 'Organization',
      resourceId: organizationId,
      diffSummary: { email, role },
    });

    return reply.status(201).send({
      id: member.id,
      organizationId: member.organization_id,
      name: email.split('@')[0] || email,
      email,
      role: member.role,
      status: 'invited',
      invitedAt: member.invited_at,
      joinedAt: member.accepted_at,
    });
  });

  app.post('/brands', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const body = request.body as CreateBrandInput;

    const organization = await new OrganizationRepository(db).findById(body.organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', body.organizationId);
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
      diffSummary: { name: body.name, slug: body.slug, organizationId: body.organizationId },
    });

    return reply.status(201).send(brand);
  });

  app.patch('/brands/:brandId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { brandId } = request.params as { brandId: string };
    const body = parseBody(updateBrandSchema, request.body);

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
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
      ClerkAuthService.requireResourceTenant(principal, paymentAccount, 'PaymentAccount', paymentAccount.id);
      if (paymentAccount.organization_id !== brand.organization_id) {
        throw new ValidationError('Payment account does not belong to the brand\'s organization');
      }
    }

    const updated = await brandRepo.update(brandId, {
      ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
      ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(body.theme !== undefined ? { theme: JSON.stringify(body.theme) } : {}),
      ...(body.whiteLabel !== undefined ? { white_label: Boolean(body.whiteLabel) } : {}),
      ...(body.legalUrls !== undefined ? { legal_urls: JSON.stringify(body.legalUrls) } : {}),
      ...(body.paymentAccountId !== undefined ? { payment_account_id: body.paymentAccountId ?? null } : {}),
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
        ...(body.whiteLabel !== undefined ? { whiteLabel: Boolean(body.whiteLabel) } : {}),
        ...(body.legalUrls !== undefined ? { legalUrls: body.legalUrls } : {}),
        ...(body.paymentAccountId !== undefined ? { paymentAccountId: body.paymentAccountId ?? null } : {}),
      },
    });
    return updated;
  });

  app.post('/brands/:brandId/domains', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { brandId } = request.params as { brandId: string };
    const body = request.body as AddBrandDomainInput;

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
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
    return reply.status(201).send(domain);
  });

  app.get('/brands', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const brandRepo = new BrandRepository(db);
    const brands = await brandRepo.findByTenant(principal.tenantId);
    // Filter by principal's organizations to prevent cross-org data exposure.
    // System principals see all brands.
    if (principal.type === 'system') return brands;
    return brands.filter((brand) => principal.organizationIds.includes(brand.organization_id));
  });

  app.get('/organizations/:organizationId/payment-accounts', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const accounts = await new PaymentAccountRepository(db).findByOrganization(organizationId);
    return accounts.map((account) => serializePaymentAccount(account));
  });

  app.post('/organizations/:organizationId/payment-accounts/stripe-connect', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const paymentAccounts = new PaymentAccountRepository(db);
    const existing = await paymentAccounts.findByOrganization(organizationId);
    const activeStripe = existing.find((account) => account.provider === 'stripe_connect' || account.provider === 'stripe');
    const stripe = stripeClientFromContext(app.context);
    if (!stripe) {
      if (activeStripe) return reply.status(200).send(serializePaymentAccount(activeStripe));
      throw new ValidationError('Stripe Connect onboarding is not configured for this environment');
    }

    let account = activeStripe;
    if (!account) {
      const stripeAccount = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        business_profile: {
          name: organization.name,
        },
        metadata: {
          tenantId: organization.tenant_id,
          organizationId: organization.id,
        },
      });
      const stripeState = stripeAccountState(stripeAccount);
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

    const accountLink = await stripe.accountLinks.create({
      account: account.provider_account_id,
      type: stripeAccountLinkType(account.status),
      refresh_url: stripeConnectRefreshUrl(organizationId),
      return_url: stripeConnectReturnUrl(organizationId),
    });

    return reply.status(activeStripe ? 200 : 201).send(serializePaymentAccount(account, accountLink.url));
  });

  app.post('/organizations/:organizationId/payment-accounts/:paymentAccountId/stripe-connect/refresh', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId, paymentAccountId } = request.params as { organizationId: string; paymentAccountId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const paymentAccounts = new PaymentAccountRepository(db);
    const account = await paymentAccounts.findById(paymentAccountId);
    if (!account) throw new ValidationError('Payment account not found');
    ClerkAuthService.requireResourceTenant(principal, account, 'PaymentAccount', paymentAccountId);
    if (account.organization_id !== organizationId) {
      throw new ValidationError('Payment account does not belong to the organization');
    }
    if (account.provider !== 'stripe_connect' && account.provider !== 'stripe') {
      throw new ValidationError('Payment account is not a Stripe Connect account');
    }

    const stripe = stripeClientFromContext(app.context);
    if (!stripe) {
      throw new ValidationError('Stripe Connect status refresh is not configured for this environment');
    }

    const previousStatus = account.status;
    const previousDefaultCurrency = account.default_currency;
    const stripeAccount = await stripe.accounts.retrieve(account.provider_account_id) as Stripe.Account;
    const stripeState = stripeAccountState(stripeAccount);
    const updated = await paymentAccounts.update(account.id, {
      status: stripeState.status,
      default_currency: stripeState.defaultCurrency ?? account.default_currency,
      details_submitted: stripeState.detailsSubmitted,
      charges_enabled: stripeState.chargesEnabled,
      payouts_enabled: stripeState.payoutsEnabled,
      requirements: JSON.stringify(stripeState.requirements),
      disabled_reason: stripeState.disabledReason,
    });

    if (updated.status !== previousStatus || updated.default_currency !== previousDefaultCurrency) {
      await writeAuditLog(audit(), request, principal, {
        action: 'payment_account.refreshed',
        organizationId,
        resourceType: 'PaymentAccount',
        resourceId: updated.id,
        diffSummary: {
          providerAccountId: updated.provider_account_id,
          previousStatus,
          status: updated.status,
          previousDefaultCurrency,
          defaultCurrency: updated.default_currency,
        },
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: updated.provider_account_id,
      type: stripeAccountLinkType(updated.status),
      refresh_url: stripeConnectRefreshUrl(organizationId),
      return_url: stripeConnectReturnUrl(organizationId),
    });

    return serializePaymentAccount(updated, accountLink.url);
  });

  app.get('/organizations/:organizationId/billing', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const tenant = await db
      .selectFrom('tenants')
      .selectAll()
      .where('id', '=', principal.tenantId)
      .executeTakeFirst();
    const ticketStats = await db
      .selectFrom('tickets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('tenant_id', '=', principal.tenantId)
      .executeTakeFirst();

    return {
      organizationId,
      plan: tenant?.plan ?? 'free',
      status: tenant?.status ?? 'active',
      ticketsThisMonth: Number(ticketStats?.count ?? 0),
    };
  });
};
