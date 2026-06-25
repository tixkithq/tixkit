export type ISO8601Date = string;

export type Ulid = string;

export type CurrencyCode = string;

export type Money = {
  amountCents: number;
  currency: CurrencyCode;
};

export type Slug = string;

export type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type CursorParams = {
  cursor?: string;
  limit?: number;
};

export type IdempotencyKey = string;

export type ApiVersion = '2026-01-01';

export type Locale = string;

export type Timezone = string;

export type SortOrder = 'asc' | 'desc';

export type BaseEntity = {
  id: Ulid;
  createdAt: ISO8601Date;
  updatedAt: ISO8601Date;
};

export type TenantScopedEntity = BaseEntity & {
  tenantId: Ulid;
};

export type TenantOrgScopedEntity = TenantScopedEntity & {
  organizationId: Ulid;
};

export type BrandedId<T extends string> = string & { readonly __brand: T };

export type PrefixedId<T extends string> = `${T}_${string}`;

export const idPrefix = {
  tenant: 'tnt',
  org: 'org',
  brand: 'brd',
  brandDomain: 'bdom',
  theme: 'thm',
  event: 'evt',
  ticketType: 'tt',
  ticketTier: 'ttr',
  inventoryPool: 'inv',
  checkoutHold: 'hld',
  product: 'prod',
  productCategory: 'pcat',
  checkoutSession: 'cs',
  cart: 'crt',
  order: 'ord',
  orderLineItem: 'oli',
  attendee: 'att',
  ticket: 'tkt',
  checkInList: 'cil',
  checkInDevice: 'cid',
  scanLog: 'scan',
  walletPass: 'wp',
  priceQuote: 'pq',
  taxRule: 'tax',
  feeRule: 'fee',
  discountCode: 'dc',
  voucher: 'vch',
  affiliate: 'aff',
  attribution: 'attr',
  apiKey: 'key',
  oauthApp: 'oapp',
  scannerDevice: 'sd',
  auditLog: 'audit',
  userProfile: 'usr',
  webhookEndpoint: 'wh',
  webhookEvent: 'whe',
  webhookDelivery: 'whd',
  export: 'exp',
  notificationTemplate: 'ntmpl',
  notificationTemplateVersion: 'ntv',
  emailJob: 'emj',
  emailDelivery: 'emd',
  smsJob: 'smsj',
  smsDelivery: 'smsd',
  messageConsent: 'mc',
  emailSuppression: 'es',
  emailProviderRoute: 'epr',
  brandSenderIdentity: 'bsi',
  venue: 'ven',
  organizerProfile: 'orgp',
  eventPage: 'evpg',
  eventSchedule: 'evs',
  eventLocalization: 'evl',
  paymentAccount: 'pa',
  paymentIntent: 'pi',
  refund: 'ref',
  dispute: 'dsp',
  featureFlag: 'ff',
  role: 'role',
  permissionGrant: 'pg',
  organizationMember: 'om',
  clerkIdentityLink: 'cil',
  accessRule: 'ar',
  orderTimelineEvent: 'ote',
  ticketSecret: 'ts',
} as const;

export type IdPrefix = keyof typeof idPrefix;
