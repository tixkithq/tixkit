import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

type BoxOfficeSettings = {
  enabled: boolean;
  allowedTenderTypes: Array<'cash' | 'manual_card' | 'comp'>;
  requireBuyerEmail: boolean;
  receiptMode: 'print' | 'email' | 'both';
};

const defaultBoxOfficeSettings: BoxOfficeSettings = {
  enabled: true,
  allowedTenderTypes: ['cash', 'manual_card', 'comp'],
  requireBuyerEmail: false,
  receiptMode: 'email',
};

export class TenantRepository extends BaseRepository {
  async create(input: { name: string; plan?: string }) {
    const id = `tnt_${ulid()}`;
    const now = new Date();
    const result = await this.insertReturning(
      'tenants',
      {
        id,
        name: input.name,
        status: 'active',
        plan: input.plan ?? 'free',
        created_at: now,
        updated_at: now,
      },
      id,
    );
    return result;
  }

  async findById(id: string) {
    return this.db.selectFrom('tenants').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findAll(limit = 50) {
    return this.db.selectFrom('tenants').selectAll().limit(limit).execute();
  }
}

export class OrganizationRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    name: string;
    slug: string;
    clerkOrganizationId?: string;
    boxOfficeSettings?: BoxOfficeSettings;
  }) {
    const id = `org_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'organizations',
      {
        id,
        tenant_id: input.tenantId,
        name: input.name,
        slug: input.slug,
        clerk_organization_id: input.clerkOrganizationId ?? null,
        box_office_settings: JSON.stringify(input.boxOfficeSettings ?? defaultBoxOfficeSettings),
        status: 'active',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('organizations').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByTenant(tenantId: string) {
    return this.db
      .selectFrom('organizations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('organizations', id, { ...input, updated_at: new Date() });
  }
}

export class OrganizationMemberRepository extends BaseRepository {
  async findByOrganization(tenantId: string, organizationId: string) {
    return this.db
      .selectFrom('organization_members')
      .innerJoin('user_profiles', 'user_profiles.id', 'organization_members.user_id')
      .select([
        'organization_members.id as id',
        'organization_members.tenant_id as tenant_id',
        'organization_members.organization_id as organization_id',
        'organization_members.role as role',
        'organization_members.invited_at as invited_at',
        'organization_members.accepted_at as accepted_at',
        'organization_members.created_at as created_at',
        'organization_members.updated_at as updated_at',
        'user_profiles.email as email',
        'user_profiles.first_name as first_name',
        'user_profiles.last_name as last_name',
        'user_profiles.status as user_status',
      ])
      .where('organization_members.tenant_id', '=', tenantId)
      .where('organization_members.organization_id', '=', organizationId)
      .execute();
  }

  async invite(input: { tenantId: string; organizationId: string; email: string; role: string }) {
    const userId = `usr_${ulid()}`;
    const memberId = `mem_${ulid()}`;
    const now = new Date();
    const normalizedEmail = input.email.trim().toLowerCase();
    const existingUser = await this.db
      .selectFrom('user_profiles')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('email', '=', normalizedEmail)
      .executeTakeFirst();

    const user =
      existingUser ??
      (await this.insertReturning(
        'user_profiles',
        {
          id: userId,
          tenant_id: input.tenantId,
          clerk_user_id: `invited:${normalizedEmail}`,
          email: normalizedEmail,
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'invited',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
        userId,
      ));

    return this.insertReturning(
      'organization_members',
      {
        id: memberId,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        user_id: user.id,
        role: input.role,
        invited_at: now,
        accepted_at: null,
        created_at: now,
        updated_at: now,
      },
      memberId,
    );
  }
}

export class BrandRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    name: string;
    slug: string;
    theme?: Record<string, unknown>;
    whiteLabel?: boolean;
  }) {
    const id = `brd_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'brands',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        slug: input.slug,
        status: 'draft',
        theme: JSON.stringify(input.theme ?? {}),
        legal_urls: JSON.stringify({}),
        white_label: input.whiteLabel ?? false,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('brands').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByTenant(tenantId: string) {
    return this.db.selectFrom('brands').selectAll().where('tenant_id', '=', tenantId).execute();
  }

  async findByOrganization(orgId: string) {
    return this.db.selectFrom('brands').selectAll().where('organization_id', '=', orgId).execute();
  }

  async findByDomain(domain: string) {
    const brandDomain = await this.db
      .selectFrom('brand_domains')
      .selectAll()
      .where('domain', '=', domain)
      .executeTakeFirst();

    if (!brandDomain) return null;

    return this.db
      .selectFrom('brands')
      .selectAll()
      .where('id', '=', brandDomain.brand_id)
      .executeTakeFirst();
  }

  async findByActiveDomain(domain: string) {
    const brandDomain = await this.db
      .selectFrom('brand_domains')
      .selectAll()
      .where('domain', '=', domain)
      .where('is_verified', '=', true)
      .where('ssl_status', '=', 'active')
      .executeTakeFirst();

    if (!brandDomain) return null;

    return this.db
      .selectFrom('brands')
      .selectAll()
      .where('id', '=', brandDomain.brand_id)
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('brands', id, { ...input, updated_at: new Date() });
  }

  async addDomain(brandId: string, domain: string, isPrimary = false) {
    const id = `bdom_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'brand_domains',
      {
        id,
        brand_id: brandId,
        domain,
        is_primary: isPrimary,
        is_verified: false,
        ssl_status: 'pending',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }
}

export class PaymentAccountRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    provider: string;
    providerAccountId: string;
    status?: string;
    defaultCurrency?: string;
    detailsSubmitted?: boolean;
    chargesEnabled?: boolean;
    payoutsEnabled?: boolean;
    requirements?: Record<string, unknown>;
    disabledReason?: string | null;
  }) {
    const id = `pa_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'payment_accounts',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        provider: input.provider,
        provider_account_id: input.providerAccountId,
        status: input.status ?? 'pending',
        default_currency: input.defaultCurrency ?? 'USD',
        details_submitted: input.detailsSubmitted ?? false,
        charges_enabled: input.chargesEnabled ?? false,
        payouts_enabled: input.payoutsEnabled ?? false,
        requirements: JSON.stringify(input.requirements ?? {}),
        disabled_reason: input.disabledReason ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('payment_accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByOrganization(orgId: string) {
    return this.db
      .selectFrom('payment_accounts')
      .selectAll()
      .where('organization_id', '=', orgId)
      .execute();
  }

  async findByProviderAccountId(provider: string, providerAccountId: string) {
    return this.db
      .selectFrom('payment_accounts')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_account_id', '=', providerAccountId)
      .executeTakeFirst();
  }

  async findByOrganizationAndProvider(organizationId: string, provider: string) {
    return this.db
      .selectFrom('payment_accounts')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('provider', '=', provider)
      .executeTakeFirst();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('payment_accounts', id, { ...input, updated_at: new Date() });
  }
}
