import type { BaseEntity, ISO8601Date, Slug, TenantScopedEntity, Ulid } from '../shared/index.js';

export type ThemeTokens = {
  primaryColor: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  borderRadius?: number;
  fontFamily?: string;
  logoUrl?: string;
  faviconUrl?: string;
  customCss?: string;
};

export type BrandDomain = {
  id: Ulid;
  domain: string;
  isPrimary: boolean;
  isVerified: boolean;
  verificationToken?: string;
  sslStatus: 'pending' | 'active' | 'failed';
  createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
};

export type LegalUrls = {
  terms?: string;
  privacy?: string;
  refundPolicy?: string;
};

export type Brand = TenantScopedEntity & {
  organizationId: Ulid;
  name: string;
  slug: Slug;
  status: 'draft' | 'active' | 'suspended';
  domains: BrandDomain[];
  theme: ThemeTokens;
  emailIdentityId?: Ulid;
  smsIdentityId?: Ulid;
  paymentAccountId?: Ulid;
  supportUrl?: string;
  legalUrls: LegalUrls;
  whiteLabel: boolean;
};

export type Organization = TenantScopedEntity & {
  name: string;
  slug: Slug;
  clerkOrganizationId?: string;
  status: 'active' | 'suspended';
};

export type Tenant = BaseEntity & {
  name: string;
  status: 'active' | 'suspended';
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
};

export type SenderIdentity = TenantScopedEntity & {
  organizationId: Ulid;
  brandId: Ulid;
  email: string;
  name: string;
  verified: boolean;
  providerType: string;
};

export type PaymentAccount = TenantScopedEntity & {
  organizationId: Ulid;
  provider: 'stripe' | 'stripe_connect';
  providerAccountId: string;
  status: 'pending' | 'active' | 'restricted';
  defaultCurrency: string;
};

export type FeatureFlag = TenantScopedEntity & {
  key: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type CreateBrandInput = {
  organizationId: Ulid;
  name: string;
  slug: Slug;
  theme?: Partial<ThemeTokens>;
  whiteLabel?: boolean;
};

export type UpdateBrandInput = Partial<Pick<Brand, 'name' | 'slug' | 'status' | 'theme' | 'supportUrl' | 'legalUrls' | 'whiteLabel'>>;

export type CreateOrganizationInput = {
  name: string;
  slug: Slug;
  clerkOrganizationId?: string;
};

export type AddBrandDomainInput = {
  domain: string;
  isPrimary?: boolean;
};
