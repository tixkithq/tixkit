import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  OrganizationRepository,
  OrganizationMemberRepository,
  BrandRepository,
  PaymentAccountRepository,
  AuditLogRepository,
} from '@gatekit/db';
import type { CreateOrganizationInput, CreateBrandInput, AddBrandDomainInput } from '@gatekit/domain';
import { ValidationError } from '@gatekit/domain';
import { writeAuditLog } from '../../auth/audit.js';
import { parseBody, updateBrandSchema } from '../../http/schemas.js';

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
      resourceType: 'Brand',
      resourceId: brandId,
      diffSummary: { domain: body.domain, isPrimary: body.isPrimary },
    });
    return reply.status(201).send(domain);
  });

  app.get('/brands', async (request) => {
    const principal = request.principal!;
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

    return new PaymentAccountRepository(db).findByOrganization(organizationId);
  });

  app.post('/organizations/:organizationId/payment-accounts/stripe-connect', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);
    ClerkAuthService.requireOrganizationScope(principal, organizationId);

    const existing = await new PaymentAccountRepository(db).findByOrganization(organizationId);
    const activeStripe = existing.find((account) => account.provider === 'stripe_connect' || account.provider === 'stripe');
    if (activeStripe) return reply.status(200).send(activeStripe);

    throw new ValidationError('Stripe Connect onboarding is not configured for this environment');
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
