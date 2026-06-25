import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  OrganizationRepository,
  OrganizationMemberRepository,
  BrandRepository,
  PaymentAccountRepository,
} from '@gatekit/db';
import type { CreateOrganizationInput, CreateBrandInput, AddBrandDomainInput } from '@gatekit/domain';
import { ValidationError } from '@gatekit/domain';

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

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
    return repo.findByTenant(principal.tenantId);
  });

  app.patch('/organizations/:organizationId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { organizationId } = request.params as { organizationId: string };
    const current = await new OrganizationRepository(db).findById(organizationId);
    if (!current) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, current, 'Organization', organizationId);

    const body = request.body as {
      name?: string;
      slug?: string;
      clerkOrganizationId?: string | null;
    };
    return new OrganizationRepository(db).update(organizationId, {
      ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
      ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
      ...(body.clerkOrganizationId !== undefined ? { clerk_organization_id: body.clerkOrganizationId } : {}),
    });
  });

  app.get('/organizations/:organizationId/members', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);

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

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.create({
      tenantId: principal.tenantId,
      organizationId: body.organizationId,
      name: body.name,
      slug: body.slug,
      theme: body.theme,
      whiteLabel: body.whiteLabel,
    });

    return reply.status(201).send(brand);
  });

  app.patch('/brands/:brandId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'settings.write');
    const { brandId } = request.params as { brandId: string };
    const body = request.body as Record<string, unknown>;

    const brandRepo = new BrandRepository(db);
    const brand = await brandRepo.findById(brandId);
    if (!brand) throw new ValidationError('Brand not found');
    ClerkAuthService.requireResourceTenant(principal, brand, 'Brand', brandId);
    return brandRepo.update(brandId, {
      ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
      ...(typeof body.slug === 'string' ? { slug: body.slug.trim() } : {}),
      ...(typeof body.status === 'string' ? { status: body.status } : {}),
      ...(body.theme !== undefined ? { theme: JSON.stringify(body.theme) } : {}),
      ...(body.whiteLabel !== undefined ? { white_label: Boolean(body.whiteLabel) } : {}),
      ...(body.legalUrls !== undefined ? { legal_urls: JSON.stringify(body.legalUrls) } : {}),
    });
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
    const domain = await brandRepo.addDomain(brandId, body.domain, body.isPrimary);
    return reply.status(201).send(domain);
  });

  app.get('/brands', async (request) => {
    const principal = request.principal!;
    const brandRepo = new BrandRepository(db);
    return brandRepo.findByTenant(principal.tenantId);
  });

  app.get('/organizations/:organizationId/payment-accounts', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);

    return new PaymentAccountRepository(db).findByOrganization(organizationId);
  });

  app.post('/organizations/:organizationId/payment-accounts/stripe-connect', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'billing.write');
    const { organizationId } = request.params as { organizationId: string };
    const organization = await new OrganizationRepository(db).findById(organizationId);
    if (!organization) throw new ValidationError('Organization not found');
    ClerkAuthService.requireResourceTenant(principal, organization, 'Organization', organizationId);

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
