// Tixkit JavaScript SDK
// Works in Node.js and browsers with separate entry points.
// Never exposes secret API keys in browser bundles.

export const TIXKIT_API_VERSION = '2026-01-01';

export type TixkitConfig = {
  apiKey?: string;
  apiBaseUrl?: string;
  apiVersion?: string;
  timeout?: number;
  maxRetries?: number;
};

export type TixkitError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};

export class TixkitApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly requestId: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TixkitApiError';
  }
}

// Resource types - aligned with packages/api/src/http/contracts.ts serializers
export type Event = {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  slug: string;
  title: string;
  description?: string;
  status: string;
  currency: string;
  timezone: string;
  startsAt: string;
  endsAt?: string;
  venue?: Record<string, unknown> | null;
  visibility: string;
  seo: Record<string, unknown>;
  capacity?: number;
  coverImageUrl?: string;
  externalUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketType = {
  id: string;
  eventId: string;
  eventOccurrenceId?: string;
  name: string;
  description?: string;
  kind: 'free' | 'paid' | 'donation';
  status: 'draft' | 'active' | 'paused' | 'sold_out' | 'ended';
  visibility: 'public' | 'hidden' | 'locked';
  currency: string;
  priceCents: number;
  minimumPriceCents?: number;
  salesStartAt?: string;
  salesEndAt?: string;
  minPerOrder: number;
  maxPerOrder: number;
  inventoryPoolId: string;
  sortOrder: number;
  requiresAccessCode: boolean;
  accessCodeHint?: string;
  createdAt: string;
  updatedAt: string;
};

export type EventOccurrence = {
  id: string;
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  venue?: Record<string, unknown> | null;
  capacity?: number | null;
  sortOrder: number;
  status: 'scheduled' | 'cancelled' | 'completed' | string;
  createdAt?: string;
  updatedAt?: string;
};

export type MarketingIntegration = {
  id?: string;
  tenantId?: string;
  organizationId?: string;
  brandId?: string;
  eventId?: string;
  provider: 'ga4' | 'meta_pixel' | 'generic_tag';
  config: Record<string, unknown>;
  consentRequired: boolean;
  status: 'active' | 'disabled' | string;
  createdAt?: string;
  updatedAt?: string;
};

export type AccessRule = {
  id: string;
  ticketTypeId: string;
  type: 'code' | 'email_domain';
  value: string;
  maxUses?: number;
  usesCount: number;
  expiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InventoryPool = {
  id: string;
  eventId: string;
  name: string;
  totalCapacity: number;
  reservedCount: number;
  soldCount: number;
  holdTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateInventoryPoolInput = {
  name: string;
  totalCapacity: number;
  holdTtlSeconds?: number;
};

export type CreateAccessRuleInput = {
  type: AccessRule['type'];
  value: string;
  maxUses?: number | null;
  expiresAt?: string | null;
};

export type TicketTypeBatchResult = {
  ticketType: TicketType;
  accessRules: AccessRule[];
};

export type CreateTicketTypeBatchInput = {
  ticketType: Record<string, unknown>;
  inventoryPool?: CreateInventoryPoolInput;
  accessRules?: CreateAccessRuleInput[];
};

export type UpdateTicketTypeBatchInput = {
  ticketType: Record<string, unknown>;
  accessRules?: CreateAccessRuleInput[];
};

export type ProductCategory = {
  id: string;
  eventId: string;
  name: string;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
};

export type Product = {
  id: string;
  eventId: string;
  name: string;
  description?: string;
  priceCents: number;
  currency: string;
  categoryId?: string;
  maxPerOrder: number;
  availableFrom?: string;
  availableUntil?: string;
  status: 'active' | 'inactive';
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
};

export type CheckoutSession = {
  id: string;
  eventId: string;
  brandId: string;
  status: string;
  currency: string;
  clientToken?: string;
  quote: {
    totalCents: number;
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    lineItems?: unknown[];
  };
  successUrl?: string;
  cancelUrl?: string;
  orderId?: string;
  expiresAt: string;
  paymentCompensation?: PaymentCompensation;
};

export type CheckoutWalletPassTicket = {
  ticketId: string;
  ticketCode: string;
  appleUrl?: string;
  googleUrl?: string;
};

export type CheckoutWalletPasses = {
  tickets: CheckoutWalletPassTicket[];
};

export type UploadPurpose = 'checkout_answer' | 'brand_logo' | 'user_avatar';

export type CreateUploadArtifactInput = {
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  brandId?: string;
  eventId?: string;
  metadata?: Record<string, unknown>;
};

export type PublicCreateUploadArtifactInput = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  questionId?: string;
};

export type UploadArtifactTicket = {
  artifactId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeUrl: string;
  completeToken?: string;
  expiresAt: string;
};

export type CompletedUploadArtifact = {
  artifactId: string;
  status: string;
  scanStatus: string;
};

export type UploadArtifactDownload = {
  downloadUrl: string;
};

export type WidgetImpressionInput = {
  visitorId?: string;
  instanceId?: string;
  trackingId?: string;
  affiliateCode?: string;
  host?: string;
  pageUrl?: string;
  referrer?: string;
};

export type WidgetImpressionResult = {
  tracked: boolean;
  deduped: boolean;
};

export type WaitlistEntry = {
  id: string;
  eventId: string;
  ticketTypeId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  quantity: number;
  status: 'joined' | 'offered' | 'claimed' | 'expired' | 'cancelled' | string;
  offerExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type JoinWaitlistInput = {
  ticketTypeId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  quantity?: number;
};

export type WaitlistSettings = {
  autoOfferEnabled: boolean;
  offerTtlMinutes: number;
};

export type WaitlistOffer = {
  entry: WaitlistEntry;
  claimToken: string;
};

export type CheckoutConfirmCompleted = {
  order: Order;
  sessionId: string;
  status: 'completed';
};

export type CheckoutConfirmPending = {
  sessionId: string;
  status: 'pending_payment';
  paymentIntentId: string;
  clientSecret?: string;
  totalCents: number;
  currency: string;
};

export type CheckoutConfirmResult = CheckoutConfirmCompleted | CheckoutConfirmPending;

export type BoxOfficeOrderInput = {
  tenderType: 'comp' | 'cash' | 'manual_card';
  amountCents: number;
  items: {
    ticketTypeId: string;
    occurrenceId?: string;
    quantity: number;
    attendeeFields?: Record<string, unknown>[];
  }[];
  buyer?: { email?: string; firstName?: string; lastName?: string; phone?: string };
  buyerFields?: Record<string, unknown>;
  notes?: string;
} & IdempotencyOptions;

export type BoxOfficeOrderResult = {
  order: Order;
  sessionId: string;
  status: 'completed';
};

export type PaymentCompensation = {
  id: string;
  tenantId?: string;
  checkoutSessionId?: string;
  paymentIntentId?: string | null;
  provider: string;
  providerIntentId: string;
  amountCents?: number;
  currency?: string;
  action: string;
  status: 'pending' | 'succeeded' | 'failed' | 'manual_review' | 'already_ordered' | string;
  providerCompensationId?: string | null;
  attempts: number;
  reason: string;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt: string;
};

export type ContentChannel = 'event_page' | 'email' | 'sms' | 'imessage' | 'social_invite';
export type ContentDocumentStatus = 'draft' | 'published' | 'archived';
export type ContentVersionStatus = 'draft' | 'published' | 'superseded';

export type ContentValidationIssue = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  field?: string;
};

export type ContentValidationResult = {
  valid: boolean;
  severity: 'error' | 'warning';
  issues: ContentValidationIssue[];
};

export type ContentDocument = {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId?: string;
  channel: ContentChannel;
  key: string;
  name: string;
  status: ContentDocumentStatus;
  locale: string;
  currentDraftVersionId?: string;
  publishedVersionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ContentDocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  status: ContentVersionStatus;
  schemaVersion: number;
  subject?: string;
  previewText?: string;
  contentJson: unknown;
  renderedHtml?: string;
  renderedText?: string;
  variables: Array<{ key: string; required: boolean; description?: string }>;
  validation: ContentValidationResult;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
};

export type ContentRenderOutput = {
  subject?: string;
  html?: string;
  text?: string;
  segments?: number;
};

export type ContentPreview = {
  channel: ContentChannel;
  output: ContentRenderOutput;
  validation: ContentValidationResult;
  renderArtifact?: ContentRenderArtifact;
};

export type ContentRenderArtifact = {
  id: string;
  tenantId: string;
  documentId: string;
  versionId: string;
  channel: ContentChannel;
  outputType: 'preview' | 'test_send';
  artifactRef: string;
  checksum: string;
  createdAt: string;
};

export type PublicContentPage = {
  document: {
    eventId: string;
    channel: 'event_page';
    key: string;
    name: string;
    locale: string;
    updatedAt: string;
  };
  version: {
    versionNumber: number;
    subject?: string;
    previewText?: string;
    renderedHtml?: string;
    renderedText?: string;
    publishedAt?: string;
  };
  page: {
    html: string;
    text: string;
    headless: PublicEventPageBlock[];
    discovery: PublicEventDiscoveryCard;
  };
};

export type PublicEventPageBlock = {
  type: string;
  id: string;
  title?: string;
  text?: string;
  html?: string;
  imageUrl?: string;
  imageAlt?: string;
  links?: Array<{ label: string; url: string }>;
  items?: unknown[];
};

export type PublicEventDiscoveryCard = {
  title: string;
  summary: string;
  category?: string;
  tags: string[];
  imageUrl?: string;
  startsAt?: string;
  venueName?: string;
  publicPath?: string;
};

export type ContentTestSend = {
  id: string;
  tenantId: string;
  documentId: string;
  versionId: string;
  channel: ContentChannel;
  recipient: string;
  status: 'captured' | 'failed';
  renderedSubject?: string;
  renderedHtml?: string;
  renderedText?: string;
  error?: string;
  createdAt: string;
};

export type CreateContentDocumentInput = {
  organizationId: string;
  brandId: string;
  eventId?: string;
  channel: ContentChannel;
  key: string;
  name: string;
  locale?: string;
};

export type DuplicateContentDocumentInput = {
  key?: string;
  name?: string;
};

export type SaveContentVersionInput = {
  subject?: string;
  previewText?: string;
  contentJson?: unknown | SmsTemplateDocument;
  renderedHtml?: string;
  renderedText?: string;
};

export type SmsTemplateDocument = {
  schemaVersion: 1;
  editor: {
    provider: '@tixkit/content-message/sms-composer';
    body: string;
  };
  settings: {
    templateKey: string;
    locale: string;
    category: 'transactional' | 'bulk' | 'staff' | 'system';
    consentCategory: 'transactional' | 'marketing' | 'staff' | 'system';
    segmentLimit: number;
    estimatedCostPerSegmentCents: number;
    optOutText?: string;
  };
  shortLinks: Array<{
    originalUrl: string;
    reason: 'long_url' | 'unsafe_url';
    field: string;
  }>;
};

export type Order = {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  checkoutSessionId: string;
  orderNumber: string;
  status: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  refundedCents: number;
  buyerEmail: string;
  buyerFirstName?: string;
  buyerLastName?: string;
  buyerPhone?: string;
  paymentIntentId?: string;
  paymentProvider?: string;
  salesChannel?: 'online' | 'box_office';
  operatorId?: string;
  tenderType?: 'comp' | 'cash' | 'manual_card';
  paidAt?: string;
  refundedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  lineItems?: OrderLineItem[];
  invoice?: Invoice;
  taxSnapshots?: TaxSnapshot[];
  timeline?: OrderTimelineEvent[];
};

export type OrderLineItem = {
  id: string;
  orderId: string;
  ticketTypeId?: string;
  eventOccurrenceId?: string;
  productId?: string;
  attendeeId?: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
};

export type TaxSnapshot = {
  id: string;
  orderId: string;
  orderLineItemId: string;
  eventId: string;
  taxRuleId?: string;
  taxRuleName: string;
  rate: number;
  type: string;
  appliedTo: string;
  taxableAmountCents: number;
  taxCents: number;
  currency: string;
  inclusive: boolean;
  provider: string;
  createdAt: string;
};

export type Invoice = {
  id: string;
  orderId: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  refundedCents: number;
  buyerEmail: string;
  buyerName?: string;
  buyerTaxId?: string;
  sellerName: string;
  sellerTaxId?: string;
  reverseCharge: boolean;
  issuedAt: string;
};

export type InvoiceDocument = {
  invoice: Invoice;
  order: Order;
  lineItems: OrderLineItem[];
  taxSnapshots: TaxSnapshot[];
};

export type OrderTimelineEvent = {
  id: string;
  orderId: string;
  type: string;
  description: string;
  metadata?: Record<string, unknown>;
  actorId?: string;
  createdAt: string;
};

export type Attendee = {
  id: string;
  tenantId: string;
  orderId: string;
  eventId: string;
  ticketTypeId: string;
  ticketId?: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  status: string;
  customAnswers?: Record<string, unknown>;
  checkedInAt?: string;
  checkInDeviceId?: string;
  createdAt: string;
  updatedAt: string;
};

export type Organization = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  clerkOrganizationId?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type Brand = {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  slug: string;
  status: string;
  theme: Record<string, unknown>;
  emailIdentityId?: string;
  smsIdentityId?: string;
  paymentAccountId?: string;
  supportUrl?: string;
  legalUrls: Record<string, unknown>;
  whiteLabel: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BrandDomain = {
  id: string;
  brandId: string;
  domain: string;
  isPrimary: boolean;
  isVerified: boolean;
  verificationToken?: string;
  sslStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiKey = {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  brandIds?: string[];
  eventIds?: string[];
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
  apiKey?: string;
};

export type ScannerDevice = {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  deviceId: string;
  eventIds: string[];
  status: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
  secret?: string;
};

export type WebhookEndpoint = {
  id: string;
  tenantId: string;
  organizationId: string;
  url: string;
  secret?: string;
  events: string[];
  status: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type CheckInList = {
  id: string;
  eventId: string;
  name: string;
  ticketTypeIds: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OfflineManifest = {
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  tickets: {
    ticketId: string;
    ticketTypeId: string;
    attendeeName: string;
    qrHash: string;
    status: string;
  }[];
};

export type ScanResult = {
  outcome: string;
  ticketId?: string;
  message: string;
};

export type SyncScanResult = {
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { qrHash: string; outcome: string }[];
};

export type SalesReport = {
  eventId: string;
  currency: string;
  grossSalesCents: number;
  grossSalesByChannelCents: {
    online: number;
    boxOffice: number;
  };
  netRevenueCents: number;
  refundsCents: number;
  feesCents: number;
  taxCents: number;
  ticketsSold: number;
  checkIns: number;
  ordersCount: number;
  paidOrdersCount: number;
  range: { from: string; to: string };
};

export type TaxReport = {
  eventId: string;
  currency: string;
  totalTaxCollectedCents: number;
  breakdown: {
    taxRuleName: string;
    rate: number;
    taxableAmountCents: number;
    taxCollectedCents: number;
  }[];
};

export type AttendanceReport = {
  eventId: string;
  totalAttendees: number;
  checkedIn: number;
  notCheckedIn: number;
  checkInRate: number;
  breakdownByTicketType: Array<{
    ticketTypeId: string;
    ticketTypeName: string;
    total: number;
    checkedIn: number;
  }>;
};

export type PromoReport = {
  eventId: string;
  discountCodes: Array<{
    code: string;
    usesCount: number;
    discountAmountCents: number;
    revenueAttributedCents: number;
  }>;
};

export type ConversionReport = {
  eventId: string;
  widgetViews: number;
  checkoutStarted: number;
  checkoutCompleted: number;
  conversionRate: number;
};

export type AffiliateReport = {
  organizationId: string;
  affiliates: Array<{
    affiliateId: string;
    code: string;
    name: string;
    referralsCount: number;
    revenueAttributedCents: number;
    commissionCents: number;
  }>;
};

export type ExportJobQueued = {
  exportId: string;
  status: string;
};

export type MessageQueued = {
  campaignId: string;
  eventId: string;
  templateKey: string;
  channel: string;
  status: string;
  audienceCount: number;
  queuedEmailJobs: number;
  queuedSmsJobs: number;
  suppressedRecipients: number;
  consentExclusions: number;
  skippedRecipients: number;
  emailJobIds: string[];
  smsJobIds: string[];
};

export type Ticket = {
  id: string;
  tenantId: string;
  orderId: string;
  attendeeId: string;
  eventId: string;
  ticketTypeId: string;
  status: string;
  code: string;
  qrPayload: string;
  qrHash: string;
  transferredToEmail?: string;
  transferredAt?: string;
  checkedInAt?: string;
  checkedInByDeviceId?: string;
  walletPassId?: string;
  createdAt: string;
  updatedAt: string;
};

export type PaymentAccount = {
  id: string;
  tenantId: string;
  organizationId: string;
  provider: string;
  providerAccountId: string;
  status: string;
  defaultCurrency: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirements: Record<string, unknown>;
  disabledReason: string | null;
  onboardingUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type Question = {
  id: string;
  eventId: string;
  ticketTypeId?: string;
  label: string;
  type: string;
  description?: string;
  required: boolean;
  appliesTo: 'buyer' | 'attendee' | 'both';
  options?: string[];
  placeholder?: string;
  validationPattern?: string;
  conditionalVisibility?: {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains';
    value: string;
  };
  sortOrder: number;
  isConsentField: boolean;
  consentText?: string;
  consentVersion?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateQuestionInput = {
  ticketTypeId?: string;
  label: string;
  type: Question['type'];
  description?: string;
  required?: boolean;
  appliesTo?: Question['appliesTo'];
  options?: string[];
  placeholder?: string;
  validationPattern?: string;
  conditionalVisibility?: Question['conditionalVisibility'];
  sortOrder?: number;
  isConsentField?: boolean;
  consentText?: string;
  consentVersion?: string;
};

export type UpdateQuestionInput = Partial<CreateQuestionInput> & {
  ticketTypeId?: string | null;
  description?: string | null;
  options?: string[] | null;
  placeholder?: string | null;
  validationPattern?: string | null;
  conditionalVisibility?: Question['conditionalVisibility'] | null;
  consentText?: string | null;
  consentVersion?: string | null;
};

export type ReorderQuestionInput = {
  id: string;
  sortOrder: number;
};

export type OAuthApplication = {
  id: string;
  organizationId: string;
  name: string;
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  scopes: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  refresh_token?: string;
};

export type AuthMe = {
  userId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  organizationId?: string;
  role?: string;
  scopes?: string[];
};

export type ExportJob = {
  exportId: string;
  status: string;
  type: string;
  format: string;
  createdAt: string;
  completedAt?: string;
  downloadUrl?: string;
  error?: string;
};

export type AuditLog = {
  id: string;
  tenantId: string;
  organizationId: string | null;
  brandId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  diffSummary: Record<string, unknown> | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
};

export type PrivacyRequest = {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string | null;
  requestType: 'export' | 'erasure' | string;
  subjectType: 'buyer' | 'attendee' | string;
  subjectId: string | null;
  subjectEmail: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  requestedBy: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type PrivacyRequestInput = {
  organizationId: string;
  brandId?: string;
  subjectType: 'buyer' | 'attendee';
  subjectId?: string;
  subjectEmail?: string;
};

export type MessageCampaign = {
  id: string;
  eventId: string;
  tenantId?: string;
  brandId?: string;
  templateKey: string;
  channel: string;
  status: string;
  audience?: string;
  audienceKey?: 'all' | 'checked_in' | 'not_checked_in' | 'specific';
  audienceAttendeeIds?: string[];
  audienceLabel?: string;
  audienceCount: number;
  queuedEmailJobs: number;
  queuedSmsJobs: number;
  suppressedRecipients: number;
  consentExclusions: number;
  skippedRecipients: number;
  createdAt: string;
  updatedAt: string;
  emailJobs?: Array<Record<string, unknown>>;
  smsJobs?: Array<Record<string, unknown>>;
  emailDeliveries?: Array<Record<string, unknown>>;
  smsDeliveries?: Array<Record<string, unknown>>;
};

export type MessageRecipientPreview = {
  audience: string;
  audienceCount: number;
  eligibleCount: number;
  suppressedRecipients: number;
  consentExclusions: number;
  skippedRecipients: number;
  recipients: Array<{
    id: string;
    name: string;
    email?: string;
    phone?: string;
    status: string;
  }>;
};

export type MessageJob = {
  channel: string;
  campaignId: string;
  eventId: string;
  job: Record<string, unknown>;
};

export type MessageDeliveryLog = {
  channel: string;
  campaignId: string;
  eventId: string;
  delivery: Record<string, unknown>;
};

export type MessageProviderEvent = {
  channel: string;
  campaignId: string;
  eventId: string;
  event: Record<string, unknown>;
};

export type WebhookEvent = {
  id: string;
  eventId: string;
  deliveryId: string;
  endpointId: string | null;
  requestedEndpointId: string;
  deliveryKey: string;
  eventType: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  deliveredAt?: string;
  statusCode?: number;
};

export type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type PaginationParams = {
  cursor?: string;
  limit?: number;
};

export type CheckoutSessionGetOptions = {
  clientToken?: string;
  paymentIntentClientSecret?: string;
};

export type OrderListParams = PaginationParams & {
  organizationId?: string;
  eventId?: string;
};

export type IdempotencyOptions = {
  idempotencyKey: string;
};

export class TixkitClient {
  private readonly apiKey?: string;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  readonly checkout: CheckoutResource;
  readonly events: EventResource;
  readonly orders: OrderResource;
  readonly tickets: TicketResource;
  readonly organizations: OrganizationResource;
  readonly brands: BrandResource;
  readonly ticketTypes: TicketTypeResource;
  readonly inventoryPools: InventoryPoolResource;
  readonly products: ProductResource;
  readonly attendees: AttendeeResource;
  readonly checkInLists: CheckInListResource;
  readonly checkIns: CheckInResource;
  readonly apiKeys: ApiKeyResource;
  readonly scannerDevices: ScannerDeviceResource;
  readonly reports: ReportResource;
  readonly exports: ExportResource;
  readonly messages: MessageResource;
  readonly content: ContentResource;
  readonly webhookEndpoints: WebhookEndpointResource;
  readonly paymentAccounts: PaymentAccountResource;
  readonly questions: QuestionResource;
  readonly oauthApplications: OAuthApplicationResource;
  readonly uploads: UploadResource;
  readonly privacy: PrivacyResource;
  readonly public: PublicResource;
  readonly auth: AuthResource;

  constructor(config: TixkitConfig) {
    if (isBrowserRuntime() && config.apiKey && looksLikeSecretApiKey(config.apiKey)) {
      throw new Error('Secret Tixkit API keys are server-only and cannot be used in browser SDKs');
    }

    this.apiKey = config.apiKey;
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? 'https://api.tixkit.com');
    this.apiVersion = config.apiVersion ?? TIXKIT_API_VERSION;
    this.timeout = config.timeout ?? 30000;
    this.maxRetries = config.maxRetries ?? 3;

    this.checkout = new CheckoutResource(this);
    this.events = new EventResource(this);
    this.orders = new OrderResource(this);
    this.tickets = new TicketResource(this);
    this.organizations = new OrganizationResource(this);
    this.brands = new BrandResource(this);
    this.ticketTypes = new TicketTypeResource(this);
    this.inventoryPools = new InventoryPoolResource(this);
    this.products = new ProductResource(this);
    this.attendees = new AttendeeResource(this);
    this.checkInLists = new CheckInListResource(this);
    this.checkIns = new CheckInResource(this);
    this.apiKeys = new ApiKeyResource(this);
    this.scannerDevices = new ScannerDeviceResource(this);
    this.reports = new ReportResource(this);
    this.exports = new ExportResource(this);
    this.messages = new MessageResource(this);
    this.content = new ContentResource(this);
    this.webhookEndpoints = new WebhookEndpointResource(this);
    this.paymentAccounts = new PaymentAccountResource(this);
    this.questions = new QuestionResource(this);
    this.oauthApplications = new OAuthApplicationResource(this);
    this.uploads = new UploadResource(this);
    this.privacy = new PrivacyResource(this);
    this.public = new PublicResource(this);
    this.auth = new AuthResource(this);
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string>;
      idempotencyKey?: string;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}/v1${path}`);

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tixkit-Version': this.apiVersion,
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    if (options?.headers) {
      Object.assign(headers, options.headers);
    }

    let lastError: Error | null = null;
    const attempts = this.maxRetries + 1;
    const retryableRequest = isSafeMethod(method) || Boolean(options?.idempotencyKey);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        let response: Response;
        let responseText: string;
        try {
          // eslint-disable-next-line no-await-in-loop -- retries must run sequentially so backoff and previous response state are respected.
          response = await fetch(url.toString(), {
            method,
            headers,
            body: options?.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
          });

          // eslint-disable-next-line no-await-in-loop -- each retry attempt must consume its own response before deciding whether to retry.
          responseText = await response.text();
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok) {
          throw createApiErrorFromResponse(response.status, parseErrorResponse(responseText));
        }

        const data = responseText ? JSON.parse(responseText) : null;
        return data as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!retryableRequest) {
          throw err;
        }

        // Retry safe/idempotent operations on network failures and 5xx errors.
        if (err instanceof TixkitApiError) {
          if (err.statusCode >= 400 && err.statusCode < 500) {
            throw err; // Don't retry client errors
          }
        }

        if (attempt < attempts - 1) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          // eslint-disable-next-line no-await-in-loop -- retry backoff is intentionally sequential between attempts.
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }
}

function isBrowserRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & { window?: unknown; document?: unknown };
  return runtime.window !== undefined && runtime.document !== undefined;
}

function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function looksLikeSecretApiKey(value: string): boolean {
  return value.startsWith('tk_');
}

function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function parseErrorResponse(responseText: string): unknown {
  if (!responseText) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    return null;
  }
}

function createApiErrorFromResponse(statusCode: number, data: unknown): TixkitApiError {
  const error = isRecord(data) && isRecord(data.error) ? data.error : undefined;
  const code = typeof error?.code === 'string' && error.code ? error.code : `HTTP_${statusCode}`;
  const message =
    typeof error?.message === 'string' && error.message
      ? error.message
      : `Request failed with status ${statusCode}`;
  const requestId = typeof error?.requestId === 'string' ? error.requestId : '';
  const details = isRecord(error?.details) ? error.details : undefined;

  return new TixkitApiError(code, message, statusCode, requestId, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paginationParams(
  input?: PaginationParams & Record<string, string | number | boolean | undefined>,
): Record<string, string> | undefined {
  if (!input) return undefined;
  const params: Record<string, string> = {};
  if (input.cursor) params.cursor = input.cursor;
  if (input.limit !== undefined) params.limit = String(input.limit);
  for (const [key, value] of Object.entries(input)) {
    if (key === 'cursor' || key === 'limit' || value === undefined) continue;
    params[key] = String(value);
  }
  return Object.keys(params).length === 0 ? undefined : params;
}

class CheckoutResource {
  constructor(private client: TixkitClient) {}

  async create(
    input: {
      eventId: string;
      items: {
        ticketTypeId?: string;
        occurrenceId?: string;
        productId?: string;
        quantity: number;
        unitAmountCents?: number;
        attendeeFields?: Record<string, unknown>[];
      }[];
      discountCode?: string;
      affiliateCode?: string;
      trackingId?: string;
      buyerFields?: Record<string, unknown>;
      buyer?: { email?: string; firstName?: string; lastName?: string; phone?: string };
      successUrl?: string;
      cancelUrl?: string;
      accessCode?: string;
      waitlistClaimToken?: string;
    } & IdempotencyOptions,
  ): Promise<CheckoutSession> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/checkout/sessions', {
      body,
      idempotencyKey,
    });
  }

  async get(
    sessionId: string,
    options?: string | CheckoutSessionGetOptions,
  ): Promise<CheckoutSession> {
    const recovery = typeof options === 'string' ? { clientToken: options } : (options ?? {});
    return this.client.request('GET', `/checkout/sessions/${sessionId}`, {
      headers: recovery.clientToken
        ? { 'X-Checkout-Session-Token': recovery.clientToken }
        : undefined,
      params: recovery.paymentIntentClientSecret
        ? { payment_intent_client_secret: recovery.paymentIntentClientSecret }
        : undefined,
    });
  }

  async walletPasses(sessionId: string, clientToken?: string): Promise<CheckoutWalletPasses> {
    return this.client.request('GET', `/checkout/sessions/${sessionId}/wallet-passes`, {
      headers: clientToken ? { 'X-Checkout-Session-Token': clientToken } : undefined,
    });
  }

  async update(
    sessionId: string,
    input: {
      clientToken: string;
      buyer?: { email?: string; firstName?: string; lastName?: string; phone?: string };
      successUrl?: string;
      cancelUrl?: string;
    },
  ): Promise<CheckoutSession> {
    const { clientToken, ...body } = input;
    return this.client.request('PATCH', `/checkout/sessions/${sessionId}`, {
      body,
      headers: { 'X-Checkout-Session-Token': clientToken },
    });
  }

  async confirm(
    sessionId: string,
    input: { paymentMethodId?: string; clientToken: string } & IdempotencyOptions,
  ): Promise<CheckoutConfirmResult> {
    const { idempotencyKey, clientToken, ...body } = input;
    return this.client.request('POST', `/checkout/sessions/${sessionId}/confirm`, {
      body,
      idempotencyKey,
      headers: { 'X-Checkout-Session-Token': clientToken },
    });
  }

  async createBoxOfficeOrder(
    eventId: string,
    input: BoxOfficeOrderInput,
  ): Promise<BoxOfficeOrderResult> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/events/${eventId}/box-office/orders`, {
      body,
      idempotencyKey,
    });
  }
}

class UploadResource {
  constructor(private client: TixkitClient) {}

  async create(input: CreateUploadArtifactInput): Promise<UploadArtifactTicket> {
    return this.client.request('POST', '/upload-artifacts', { body: input });
  }

  async complete(artifactId: string): Promise<CompletedUploadArtifact> {
    return this.client.request('POST', `/upload-artifacts/${artifactId}/complete`, { body: {} });
  }

  async download(artifactId: string): Promise<UploadArtifactDownload> {
    return this.client.request('GET', `/upload-artifacts/${artifactId}/download`);
  }
}

class EventResource {
  constructor(private client: TixkitClient) {}

  async list(params?: PaginationParams): Promise<PageResult<Event>> {
    return this.client.request('GET', '/events', { params: paginationParams(params) });
  }

  async get(eventId: string): Promise<Event> {
    return this.client.request('GET', `/events/${eventId}`);
  }

  async create(input: {
    organizationId: string;
    brandId: string;
    slug: string;
    title: string;
    currency: string;
    timezone: string;
    startsAt: string;
    endsAt?: string;
    visibility?: string;
  }): Promise<Event> {
    return this.client.request('POST', '/events', { body: input });
  }

  async publish(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/publish`);
  }

  async update(
    eventId: string,
    input: Partial<
      Pick<
        Event,
        | 'title'
        | 'description'
        | 'currency'
        | 'status'
        | 'timezone'
        | 'startsAt'
        | 'endsAt'
        | 'visibility'
        | 'capacity'
        | 'coverImageUrl'
        | 'externalUrl'
        | 'venue'
        | 'seo'
      >
    >,
  ): Promise<Event> {
    return this.client.request('PATCH', `/events/${eventId}`, { body: input });
  }

  async pause(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/pause`);
  }

  async archive(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/archive`);
  }

  async getAvailability(eventId: string): Promise<
    PageResult<{
      ticketTypeId: string;
      eventOccurrenceId?: string;
      available: number;
      total: number;
      reserved: number;
      sold: number;
      status: string;
    }>
  > {
    return this.client.request<
      PageResult<{
        ticketTypeId: string;
        eventOccurrenceId?: string;
        available: number;
        total: number;
        reserved: number;
        sold: number;
        status: string;
      }>
    >('GET', `/events/${eventId}/availability`);
  }

  async listOccurrences(eventId: string): Promise<PageResult<EventOccurrence>> {
    return this.client.request('GET', `/events/${eventId}/occurrences`);
  }

  async createOccurrence(
    eventId: string,
    input: {
      title: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      venue?: Record<string, unknown> | null;
      capacity?: number | null;
      sortOrder?: number;
      status?: EventOccurrence['status'];
    },
  ): Promise<EventOccurrence> {
    return this.client.request('POST', `/events/${eventId}/occurrences`, { body: input });
  }

  async updateOccurrence(
    eventId: string,
    occurrenceId: string,
    input: Partial<{
      title: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      venue: Record<string, unknown> | null;
      capacity: number | null;
      sortOrder: number;
      status: EventOccurrence['status'];
    }>,
  ): Promise<EventOccurrence> {
    return this.client.request('PATCH', `/events/${eventId}/occurrences/${occurrenceId}`, {
      body: input,
    });
  }

  async listMarketingIntegrations(eventId: string): Promise<PageResult<MarketingIntegration>> {
    return this.client.request('GET', `/events/${eventId}/marketing-integrations`);
  }

  async upsertMarketingIntegration(
    eventId: string,
    provider: MarketingIntegration['provider'],
    input: {
      config: Record<string, unknown>;
      consentRequired?: boolean;
      status?: 'active' | 'disabled';
    },
  ): Promise<MarketingIntegration> {
    return this.client.request('PUT', `/events/${eventId}/marketing-integrations/${provider}`, {
      body: input,
    });
  }

  async listWaitlist(
    eventId: string,
  ): Promise<{ items: WaitlistEntry[]; settings: WaitlistSettings }> {
    return this.client.request('GET', `/events/${eventId}/waitlist`);
  }

  async offerWaitlistEntry(
    eventId: string,
    entryId: string,
    input?: { expiresInMinutes?: number },
  ): Promise<WaitlistOffer> {
    return this.client.request('POST', `/events/${eventId}/waitlist/${entryId}/offer`, {
      body: input ?? {},
    });
  }

  async updateWaitlistSettings(
    eventId: string,
    input: WaitlistSettings,
  ): Promise<WaitlistSettings> {
    return this.client.request('PATCH', `/events/${eventId}/waitlist/settings`, { body: input });
  }
}

class OrderResource {
  constructor(private client: TixkitClient) {}

  async list(params?: OrderListParams): Promise<PageResult<Order>> {
    return this.client.request('GET', '/orders', { params: paginationParams(params) });
  }

  async get(orderId: string): Promise<
    Order & {
      lineItems: OrderLineItem[];
      timeline: OrderTimelineEvent[];
      invoice?: Invoice;
      taxSnapshots?: TaxSnapshot[];
    }
  > {
    return this.client.request('GET', `/orders/${orderId}`);
  }

  async invoice(orderId: string): Promise<InvoiceDocument> {
    return this.client.request('GET', `/orders/${orderId}/invoice`);
  }

  async downloadInvoice(orderId: string): Promise<InvoiceDocument> {
    return this.client.request('GET', `/orders/${orderId}/invoice/download`);
  }

  async cancel(orderId: string): Promise<Order> {
    return this.client.request('POST', `/orders/${orderId}/cancel`);
  }

  async refund(
    orderId: string,
    input: { amountCents?: number; reason: string } & IdempotencyOptions,
  ): Promise<unknown> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/orders/${orderId}/refunds`, {
      body,
      idempotencyKey,
    });
  }

  async listPaymentCompensations(
    params?: PaginationParams & { status?: string; checkoutSessionId?: string },
  ): Promise<PageResult<PaymentCompensation>> {
    return this.client.request('GET', '/payment-compensations', {
      params: paginationParams(params),
    });
  }
}

class TicketResource {
  constructor(private client: TixkitClient) {}

  async transfer(
    ticketId: string,
    input: { toEmail: string } & IdempotencyOptions,
  ): Promise<Ticket> {
    const { idempotencyKey, toEmail } = input;
    return this.client.request('POST', `/tickets/${ticketId}/transfer`, {
      body: { toEmail },
      idempotencyKey,
    });
  }
}

class OrganizationResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<Organization>> {
    return this.client.request('GET', '/organizations', { params: paginationParams(params) });
  }
  async create(input: {
    name: string;
    slug: string;
    clerkOrganizationId?: string;
  }): Promise<Organization> {
    return this.client.request('POST', '/organizations', { body: input });
  }
  async update(
    organizationId: string,
    input: Partial<Pick<Organization, 'name' | 'slug' | 'status'>>,
  ): Promise<Organization> {
    return this.client.request('PATCH', `/organizations/${organizationId}`, { body: input });
  }
}

class BrandResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<Brand>> {
    return this.client.request('GET', '/brands', { params: paginationParams(params) });
  }
  async create(input: {
    organizationId: string;
    name: string;
    slug: string;
    theme?: Record<string, unknown>;
    whiteLabel?: boolean;
  }): Promise<Brand> {
    return this.client.request('POST', '/brands', { body: input });
  }
  async update(
    brandId: string,
    input: Partial<
      Pick<Brand, 'name' | 'slug' | 'status' | 'theme' | 'supportUrl' | 'legalUrls' | 'whiteLabel'>
    > & {
      paymentAccountId?: string | null;
    },
  ): Promise<Brand> {
    return this.client.request('PATCH', `/brands/${brandId}`, { body: input });
  }
  async addDomain(
    brandId: string,
    input: { domain: string; isPrimary?: boolean },
  ): Promise<BrandDomain> {
    return this.client.request('POST', `/brands/${brandId}/domains`, { body: input });
  }
}

class TicketTypeResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string, params?: PaginationParams): Promise<PageResult<TicketType>> {
    return this.client.request('GET', `/events/${eventId}/ticket-types`, {
      params: paginationParams(params),
    });
  }
  async create(eventId: string, input: Record<string, unknown>): Promise<TicketType> {
    return this.client.request('POST', `/events/${eventId}/ticket-types`, { body: input });
  }
  async update(ticketTypeId: string, input: Record<string, unknown>): Promise<TicketType> {
    return this.client.request('PATCH', `/ticket-types/${ticketTypeId}`, { body: input });
  }
  async createBatch(
    eventId: string,
    input: CreateTicketTypeBatchInput,
  ): Promise<TicketTypeBatchResult> {
    return this.client.request('POST', `/events/${eventId}/ticket-types/batch`, { body: input });
  }
  async updateBatch(
    ticketTypeId: string,
    input: UpdateTicketTypeBatchInput,
  ): Promise<TicketTypeBatchResult> {
    return this.client.request('PATCH', `/ticket-types/${ticketTypeId}/batch`, { body: input });
  }
  async listAccessRules(ticketTypeId: string): Promise<PageResult<AccessRule>> {
    return this.client.request('GET', `/ticket-types/${ticketTypeId}/access-rules`);
  }
  async createAccessRule(ticketTypeId: string, input: CreateAccessRuleInput): Promise<AccessRule> {
    return this.client.request('POST', `/ticket-types/${ticketTypeId}/access-rules`, {
      body: input,
    });
  }
  async deleteAccessRule(accessRuleId: string): Promise<void> {
    return this.client.request('DELETE', `/access-rules/${accessRuleId}`);
  }
}

class InventoryPoolResource {
  constructor(private client: TixkitClient) {}
  async create(eventId: string, input: CreateInventoryPoolInput): Promise<InventoryPool> {
    return this.client.request('POST', `/events/${eventId}/inventory-pools`, { body: input });
  }
}

class ProductResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string, params?: PaginationParams): Promise<PageResult<Product>> {
    return this.client.request('GET', `/events/${eventId}/products`, {
      params: paginationParams(params),
    });
  }
  async create(
    eventId: string,
    input: {
      name: string;
      description?: string;
      priceCents: number;
      currency: string;
      categoryId?: string;
      maxPerOrder?: number;
      availableFrom?: string;
      availableUntil?: string;
      status?: Product['status'];
      sortOrder?: number;
    },
  ): Promise<Product> {
    return this.client.request('POST', `/events/${eventId}/products`, { body: input });
  }
  async update(
    productId: string,
    input: Partial<{
      name: string;
      description: string | null;
      priceCents: number;
      currency: string;
      categoryId: string | null;
      maxPerOrder: number;
      availableFrom: string | null;
      availableUntil: string | null;
      status: Product['status'];
      sortOrder: number;
    }>,
  ): Promise<Product> {
    return this.client.request('PATCH', `/products/${productId}`, { body: input });
  }
  async listCategories(
    eventId: string,
    params?: PaginationParams,
  ): Promise<PageResult<ProductCategory>> {
    return this.client.request('GET', `/events/${eventId}/product-categories`, {
      params: paginationParams(params),
    });
  }
  async createCategory(
    eventId: string,
    input: { name: string; sortOrder?: number },
  ): Promise<ProductCategory> {
    return this.client.request('POST', `/events/${eventId}/product-categories`, { body: input });
  }
}

class AttendeeResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string, params?: PaginationParams): Promise<PageResult<Attendee>> {
    return this.client.request('GET', `/events/${eventId}/attendees`, {
      params: paginationParams(params),
    });
  }
  async listAll(
    params?: PaginationParams & { eventId?: string; status?: string },
  ): Promise<PageResult<Attendee>> {
    const query: Record<string, string> = {};
    if (params?.cursor) query.cursor = params.cursor;
    if (params?.limit !== undefined) query.limit = String(params.limit);
    if (params?.eventId) query.eventId = params.eventId;
    if (params?.status) query.status = params.status;
    return this.client.request('GET', '/attendees', {
      params: Object.keys(query).length > 0 ? query : undefined,
    });
  }
  async update(
    attendeeId: string,
    input: Partial<Pick<Attendee, 'firstName' | 'lastName' | 'email' | 'phone' | 'status'>>,
  ): Promise<Attendee> {
    return this.client.request('PATCH', `/attendees/${attendeeId}`, { body: input });
  }
}

class CheckInListResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string, params?: PaginationParams): Promise<PageResult<CheckInList>> {
    return this.client.request('GET', `/events/${eventId}/check-in-lists`, {
      params: paginationParams(params),
    });
  }
  async getManifest(
    eventId: string,
    checkInListId: string,
    headers: Record<string, string>,
  ): Promise<OfflineManifest> {
    return this.client.request(
      'GET',
      `/events/${eventId}/check-in-lists/${checkInListId}/manifest`,
      { headers },
    );
  }
}

class CheckInResource {
  constructor(private client: TixkitClient) {}
  async scan(
    input: { checkInListId: string; qrPayload: string; scannedAt: string; offline?: boolean } & {
      headers: Record<string, string>;
    },
  ): Promise<ScanResult> {
    const { headers, ...body } = input;
    return this.client.request('POST', '/check-ins/scan', { body, headers });
  }
  async sync(
    input: {
      checkInListId: string;
      scans: { qrHash: string; scannedAt: string; offline: boolean }[];
    } & IdempotencyOptions & { headers: Record<string, string> },
  ): Promise<SyncScanResult> {
    const { idempotencyKey, headers, ...body } = input;
    return this.client.request('POST', '/check-ins/sync', { body, idempotencyKey, headers });
  }
}

class ApiKeyResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<ApiKey>> {
    return this.client.request('GET', '/api-keys', { params: paginationParams(params) });
  }
  async create(input: {
    organizationId: string;
    name: string;
    scopes: string[];
    brandIds?: string[];
    eventIds?: string[];
    expiresAt?: string;
  }): Promise<ApiKey> {
    return this.client.request('POST', '/api-keys', { body: input });
  }
  async revoke(keyId: string): Promise<void> {
    return this.client.request('DELETE', `/api-keys/${keyId}`);
  }
}

class ScannerDeviceResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<ScannerDevice>> {
    return this.client.request('GET', '/scanner-devices', { params: paginationParams(params) });
  }
  async create(input: {
    organizationId: string;
    name: string;
    eventIds: string[];
  }): Promise<ScannerDevice> {
    return this.client.request('POST', '/scanner-devices', { body: input });
  }
  async revoke(deviceId: string): Promise<{ deviceId: string; status: string }> {
    return this.client.request('POST', `/scanner-devices/${deviceId}/revoke`);
  }
}

class ReportResource {
  constructor(private client: TixkitClient) {}
  async sales(eventId: string, params?: { from?: string; to?: string }): Promise<SalesReport> {
    const query: Record<string, string> = {};
    if (params?.from) query.from = params.from;
    if (params?.to) query.to = params.to;
    return this.client.request('GET', `/events/${eventId}/reports/sales`, {
      params: Object.keys(query).length > 0 ? query : undefined,
    });
  }
  async tax(eventId: string): Promise<TaxReport> {
    return this.client.request('GET', `/events/${eventId}/reports/tax`);
  }
  async attendance(eventId: string): Promise<AttendanceReport> {
    return this.client.request('GET', `/events/${eventId}/reports/attendance`);
  }
  async promo(eventId: string): Promise<PromoReport> {
    return this.client.request('GET', `/events/${eventId}/reports/promo`);
  }
  async conversion(eventId: string): Promise<ConversionReport> {
    return this.client.request('GET', `/events/${eventId}/reports/conversion`);
  }
  async affiliate(organizationId: string): Promise<AffiliateReport> {
    return this.client.request('GET', `/organizations/${organizationId}/reports/affiliate`);
  }
}

class ExportResource {
  constructor(private client: TixkitClient) {}
  async create(
    input: {
      eventId?: string;
      type: string;
      format: string;
      filters?: Record<string, unknown>;
    } & IdempotencyOptions,
  ): Promise<ExportJobQueued> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/exports', { body, idempotencyKey });
  }
  async get(exportId: string): Promise<ExportJob> {
    return this.client.request('GET', `/exports/${exportId}`);
  }
  async getEvents(exportId: string): Promise<unknown> {
    return this.client.request('GET', `/exports/${exportId}/events`);
  }
  async download(exportId: string): Promise<{ downloadUrl: string; expiresAt: string }> {
    return this.client.request('GET', `/exports/${exportId}/download`);
  }
}

class PrivacyResource {
  constructor(private client: TixkitClient) {}

  async listAuditLogs(
    params?: PaginationParams & {
      organizationId?: string;
      brandId?: string;
      action?: string;
      resourceType?: string;
      actorId?: string;
    },
  ): Promise<PageResult<AuditLog>> {
    return this.client.request('GET', '/audit-logs', { params: paginationParams(params) });
  }

  async listRequests(
    params?: PaginationParams & {
      organizationId?: string;
      brandId?: string;
      requestType?: 'export' | 'erasure';
      status?: 'pending' | 'processing' | 'completed' | 'failed';
    },
  ): Promise<PageResult<PrivacyRequest>> {
    return this.client.request('GET', '/privacy/requests', { params: paginationParams(params) });
  }

  async getRequest(requestId: string): Promise<PrivacyRequest> {
    return this.client.request('GET', `/privacy/requests/${requestId}`);
  }

  async createDataExport(input: PrivacyRequestInput & IdempotencyOptions): Promise<PrivacyRequest> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/privacy/data-exports', { body, idempotencyKey });
  }

  async createErasure(input: PrivacyRequestInput & IdempotencyOptions): Promise<PrivacyRequest> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/privacy/erasures', { body, idempotencyKey });
  }
}

class ContentResource {
  constructor(private client: TixkitClient) {}

  async list(
    params?: PaginationParams & {
      channel?: ContentChannel;
      brandId?: string;
      eventId?: string;
    },
  ): Promise<PageResult<ContentDocument>> {
    return this.client.request('GET', '/content-documents', {
      params: paginationParams(params),
    });
  }

  async create(input: CreateContentDocumentInput): Promise<ContentDocument> {
    return this.client.request('POST', '/content-documents', { body: input });
  }

  async get(documentId: string): Promise<ContentDocument> {
    return this.client.request('GET', `/content-documents/${documentId}`);
  }

  async duplicate(
    documentId: string,
    input: DuplicateContentDocumentInput = {},
  ): Promise<{ document: ContentDocument; versions: ContentDocumentVersion[] }> {
    return this.client.request('POST', `/content-documents/${documentId}/duplicate`, {
      body: input,
    });
  }

  async versions(documentId: string): Promise<PageResult<ContentDocumentVersion>> {
    return this.client.request('GET', `/content-documents/${documentId}/versions`);
  }

  async saveVersion(
    documentId: string,
    input: SaveContentVersionInput,
  ): Promise<ContentDocumentVersion> {
    return this.client.request('POST', `/content-documents/${documentId}/versions`, {
      body: input,
    });
  }

  async preview(
    documentId: string,
    input: SaveContentVersionInput & {
      versionId?: string;
      context?: Record<string, unknown>;
      optOutToken?: string;
    },
  ): Promise<ContentPreview> {
    return this.client.request('POST', `/content-documents/${documentId}/preview`, {
      body: input,
    });
  }

  async publish(
    documentId: string,
    versionId: string,
  ): Promise<{ document: ContentDocument; version: ContentDocumentVersion }> {
    return this.client.request(
      'POST',
      `/content-documents/${documentId}/versions/${versionId}/publish`,
    );
  }

  async archive(documentId: string): Promise<ContentDocument> {
    return this.client.request('POST', `/content-documents/${documentId}/archive`);
  }

  async testSend(
    documentId: string,
    input: {
      versionId: string;
      recipient: string;
      context?: Record<string, unknown>;
      optOutToken?: string;
    },
  ): Promise<{
    testSend: ContentTestSend;
    output: ContentRenderOutput;
    renderArtifact: ContentRenderArtifact;
  }> {
    return this.client.request('POST', `/content-documents/${documentId}/test-sends`, {
      body: input,
    });
  }
}

class MessageResource {
  constructor(private client: TixkitClient) {}
  async send(
    eventId: string,
    input: {
      templateKey: string;
      audience: string;
      attendeeIds?: string[];
      variables?: Record<string, unknown>;
      channel: string;
    } & IdempotencyOptions,
  ): Promise<MessageQueued> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/events/${eventId}/messages`, { body, idempotencyKey });
  }
  async previewRecipients(
    eventId: string,
    input: { templateKey: string; audience: string; attendeeIds?: string[]; channel: string },
  ): Promise<MessageRecipientPreview> {
    return this.client.request('POST', `/events/${eventId}/messages/preview`, { body: input });
  }
  async list(eventId: string, params?: PaginationParams): Promise<PageResult<MessageCampaign>> {
    return this.client.request('GET', `/events/${eventId}/messages`, {
      params: paginationParams(params),
    });
  }
  async getCampaign(eventId: string, campaignId: string): Promise<MessageCampaign> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}`);
  }
  async jobs(
    eventId: string,
    campaignId: string,
    params?: PaginationParams,
  ): Promise<PageResult<MessageJob>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/jobs`, {
      params: paginationParams(params),
    });
  }
  async job(
    eventId: string,
    campaignId: string,
    channel: string,
    jobId: string,
  ): Promise<MessageJob> {
    return this.client.request(
      'GET',
      `/events/${eventId}/messages/${campaignId}/jobs/${channel}/${jobId}`,
    );
  }
  async deliveryLogs(
    eventId: string,
    campaignId: string,
    params?: PaginationParams,
  ): Promise<PageResult<MessageDeliveryLog>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/delivery-logs`, {
      params: paginationParams(params),
    });
  }
  async deliveryLog(
    eventId: string,
    campaignId: string,
    channel: string,
    deliveryId: string,
  ): Promise<MessageDeliveryLog> {
    return this.client.request(
      'GET',
      `/events/${eventId}/messages/${campaignId}/delivery-logs/${channel}/${deliveryId}`,
    );
  }
  async providerEvents(
    eventId: string,
    campaignId: string,
    params?: PaginationParams,
  ): Promise<PageResult<MessageProviderEvent>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/provider-events`, {
      params: paginationParams(params),
    });
  }
  async providerEvent(
    eventId: string,
    campaignId: string,
    providerEventId: string,
  ): Promise<MessageProviderEvent> {
    return this.client.request(
      'GET',
      `/events/${eventId}/messages/${campaignId}/provider-events/${providerEventId}`,
    );
  }
}

class WebhookEndpointResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<WebhookEndpoint>> {
    return this.client.request('GET', '/webhook-endpoints', { params: paginationParams(params) });
  }
  async create(input: {
    organizationId: string;
    url: string;
    events: string[];
    description?: string;
  }): Promise<WebhookEndpoint> {
    return this.client.request('POST', '/webhook-endpoints', { body: input });
  }
  async update(
    endpointId: string,
    input: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'status' | 'description'>>,
  ): Promise<WebhookEndpoint> {
    return this.client.request('PATCH', `/webhook-endpoints/${endpointId}`, { body: input });
  }
  async listEvents(
    endpointId: string,
    params?: PaginationParams,
  ): Promise<PageResult<WebhookEvent>> {
    return this.client.request('GET', `/webhook-endpoints/${endpointId}/events`, {
      params: paginationParams(params),
    });
  }
  async replayEvent(
    endpointId: string,
    eventId: string,
  ): Promise<{ queued: true; eventId: string; endpointId: string }> {
    return this.client.request('POST', `/webhook-endpoints/${endpointId}/events/${eventId}/replay`);
  }
  async replay(eventId: string): Promise<{ message: string; eventId: string; endpoints: number }> {
    return this.client.request('POST', `/webhook-events/${eventId}/replay`);
  }
}

class PaymentAccountResource {
  constructor(private client: TixkitClient) {}
  async list(
    organizationId: string,
    params?: PaginationParams,
  ): Promise<PageResult<PaymentAccount>> {
    return this.client.request('GET', `/organizations/${organizationId}/payment-accounts`, {
      params: paginationParams(params),
    });
  }
  async createStripeConnect(organizationId: string): Promise<PaymentAccount> {
    return this.client.request(
      'POST',
      `/organizations/${organizationId}/payment-accounts/stripe-connect`,
    );
  }
  async refreshStripeConnect(
    organizationId: string,
    paymentAccountId: string,
  ): Promise<PaymentAccount> {
    return this.client.request(
      'POST',
      `/organizations/${organizationId}/payment-accounts/${paymentAccountId}/stripe-connect/refresh`,
    );
  }
}

class QuestionResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string): Promise<PageResult<Question>> {
    return this.client.request('GET', `/events/${eventId}/questions`);
  }
  async create(eventId: string, input: CreateQuestionInput): Promise<Question> {
    return this.client.request('POST', `/events/${eventId}/questions`, { body: input });
  }
  async update(questionId: string, input: UpdateQuestionInput): Promise<Question> {
    return this.client.request('PATCH', `/questions/${questionId}`, { body: input });
  }
  async reorder(eventId: string, questions: ReorderQuestionInput[]): Promise<PageResult<Question>> {
    return this.client.request('POST', `/events/${eventId}/questions/reorder`, {
      body: { questions },
    });
  }
  async delete(questionId: string): Promise<void> {
    return this.client.request('DELETE', `/questions/${questionId}`);
  }
}

class OAuthApplicationResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<OAuthApplication>> {
    return this.client.request('GET', '/oauth-applications', { params: paginationParams(params) });
  }
  async create(input: {
    organizationId: string;
    name: string;
    redirectUris: string[];
    scopes: string[];
  }): Promise<OAuthApplication> {
    return this.client.request('POST', '/oauth-applications', { body: input });
  }
  async delete(appId: string): Promise<void> {
    return this.client.request('DELETE', `/oauth-applications/${appId}`);
  }

  async token(input: {
    grantType: 'authorization_code' | 'refresh_token';
    clientId: string;
    clientSecret: string;
    code?: string;
    redirectUri?: string;
    refreshToken?: string;
  }): Promise<OAuthTokenResponse> {
    return this.client.request('POST', '/oauth/token', {
      body: {
        grant_type: input.grantType,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        refresh_token: input.refreshToken,
      },
    });
  }

  async revoke(input: {
    clientId: string;
    clientSecret: string;
    token: string;
  }): Promise<{ revoked: boolean }> {
    return this.client.request('POST', '/oauth/revoke', {
      body: {
        client_id: input.clientId,
        client_secret: input.clientSecret,
        token: input.token,
      },
    });
  }
}

class PublicResource {
  constructor(private client: TixkitClient) {}
  async getEvent(eventId: string): Promise<Event> {
    return this.client.request('GET', `/public/events/${eventId}`);
  }
  async getEventPage(
    eventId: string,
    params?: { locale?: string },
  ): Promise<PublicContentPage> {
    return this.client.request('GET', `/public/events/${eventId}/page`, {
      params: params?.locale ? { locale: params.locale } : undefined,
    });
  }
  async getContentPage(
    eventId: string,
    params?: { locale?: string },
  ): Promise<PublicContentPage> {
    return this.client.request('GET', `/public/events/${eventId}/content-page`, {
      params: params?.locale ? { locale: params.locale } : undefined,
    });
  }
  async getEventPageBySlug(
    slug: string,
    params: { host: string; locale?: string },
  ): Promise<PublicContentPage> {
    return this.client.request('GET', `/public/events/by-slug/${slug}/page`, {
      params: params.locale ? { host: params.host, locale: params.locale } : { host: params.host },
    });
  }
  async getEventDiscoveryCard(
    eventId: string,
    params?: { locale?: string },
  ): Promise<PublicEventDiscoveryCard> {
    return this.client.request('GET', `/public/events/${eventId}/discovery-card`, {
      params: params?.locale ? { locale: params.locale } : undefined,
    });
  }
  async getBrand(brandId: string): Promise<Brand> {
    return this.client.request('GET', `/public/brands/${brandId}`);
  }
  /**
   * Fetches ticket availability for a published event. Pass `products` to
   * filter/reveal hidden ticket types for direct-link or widget purchase flows.
   */
  async getAvailability(
    eventId: string,
    products?: string[],
  ): Promise<
    Array<{
      ticketTypeId: string;
      eventOccurrenceId?: string;
      name?: string;
      kind?: string;
      priceCents: number;
      currency: string;
      minimumPriceCents?: number;
      available: number;
      status: string;
      requiresAccessCode?: boolean;
      accessCodeHint?: string;
      description?: string;
      salesStartAt?: string;
      salesEndAt?: string;
      maxPerOrder?: number;
    }>
  > {
    const query = products?.length ? `?products=${products.join(',')}` : '';
    return this.client.request('GET', `/public/events/${eventId}/availability${query}`);
  }
  async listOccurrences(eventId: string): Promise<EventOccurrence[]> {
    const response = await this.client.request<PageResult<EventOccurrence> | EventOccurrence[]>(
      'GET',
      `/public/events/${eventId}/occurrences`,
    );
    return Array.isArray(response) ? response : response.items;
  }
  async listMarketingIntegrations(eventId: string): Promise<MarketingIntegration[]> {
    const response = await this.client.request<
      PageResult<MarketingIntegration> | MarketingIntegration[]
    >('GET', `/public/events/${eventId}/marketing-integrations`);
    return Array.isArray(response) ? response : response.items;
  }
  /**
   * Validates an access code or buyer email against locked ticket types.
   * The API requires `ticketTypeIds` and at least `accessCode` or `buyerEmail`.
   */
  async validateAccessCode(
    eventId: string,
    input: {
      ticketTypeIds: string[];
      accessCode?: string;
      buyerEmail?: string;
    },
  ): Promise<{ valid: boolean; ticketTypeIds?: string[] }> {
    return this.client.request('POST', `/public/events/${eventId}/access-code`, { body: input });
  }
  /**
   * Lists checkout questions for a published event, grouped by buyer and
   * attendee scope. Returns `{ buyerQuestions, attendeeQuestions }`.
   */
  async listQuestions(eventId: string): Promise<{
    buyerQuestions: Question[];
    attendeeQuestions: Question[];
  }> {
    return this.client.request('GET', `/public/events/${eventId}/questions`);
  }
  async createUploadArtifact(
    eventId: string,
    input: PublicCreateUploadArtifactInput,
  ): Promise<UploadArtifactTicket> {
    return this.client.request('POST', `/public/events/${eventId}/upload-artifacts`, {
      body: input,
    });
  }
  async completeUploadArtifact(
    artifactId: string,
    token: string,
  ): Promise<CompletedUploadArtifact> {
    return this.client.request('POST', `/public/upload-artifacts/${artifactId}/complete`, {
      body: { token },
    });
  }
  async recordWidgetImpression(
    eventId: string,
    input: WidgetImpressionInput,
  ): Promise<WidgetImpressionResult> {
    return this.client.request('POST', `/public/events/${eventId}/widget-impressions`, {
      body: input,
    });
  }
  async joinWaitlist(eventId: string, input: JoinWaitlistInput): Promise<WaitlistEntry> {
    return this.client.request('POST', `/public/events/${eventId}/waitlist`, { body: input });
  }
  async getWaitlistClaim(token: string): Promise<WaitlistEntry> {
    return this.client.request('GET', `/public/waitlist/claims/${encodeURIComponent(token)}`);
  }
}

class AuthResource {
  constructor(private client: TixkitClient) {}
  async me(): Promise<AuthMe> {
    return this.client.request('GET', '/me');
  }
}

// Default export
export default TixkitClient;
