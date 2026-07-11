// Tixkit JavaScript SDK
// Works in Node.js and browsers with separate entry points.
// Never exposes secret API keys in browser bundles.

export const TIXKIT_API_VERSION = '2026-01-01';
export const MAX_OFFLINE_SYNC_SCANS = 100_000;
export const MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS = 50_000;
export const MAX_OFFLINE_MANIFEST_TICKETS = 50_000;

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
  minimumAge: number | null;
  coverImageUrl?: string;
  externalUrl?: string;
  version: number;
  lastSetupSection?: string;
  coverImageAlt?: string;
  seoUseCoverImage: boolean;
  resalePolicy: ResalePolicy;
  grossSalesCents: number;
  ticketsSold: number;
  checkIns: number;
  createdAt: string;
  updatedAt: string;
};

export type DuplicateEventInput = {
  startsAt: string;
  title?: string;
  copy: {
    basicsVenue: boolean;
    ticketTypes: boolean;
    products: boolean;
    checkoutQuestions: boolean;
    feeResalePolicies: boolean;
    eventPageContent: boolean;
    lifecycleContent: boolean;
    marketingIntegrations: boolean;
  };
};

export type ReadinessStatus = 'complete' | 'incomplete' | 'blocked' | 'not_applicable';
export type ReadinessPriority = 'required' | 'recommended';
export type Permission =
  | 'events.read'
  | 'events.write'
  | 'tickets.write'
  | 'orders.read'
  | 'orders.write'
  | 'refunds.write'
  | 'attendees.read'
  | 'attendees.write'
  | 'checkins.read'
  | 'checkins.write'
  | 'box_office.write'
  | 'messages.write'
  | 'reports.read'
  | 'settings.write'
  | 'developers.write'
  | 'billing.write';
export type ReadinessStepId =
  | 'workspace_selection'
  | 'brand_identity'
  | 'payment_path'
  | 'team_access'
  | 'legal_configuration'
  | 'sender_identity'
  | 'basics_schedule'
  | 'sellable_tickets'
  | 'currency_coherence'
  | 'fee_pricing'
  | 'checkout_consent'
  | 'public_content'
  | 'confirmation_content'
  | 'payment_readiness'
  | 'preview_review'
  | 'test_order'
  | 'check_in_configuration'
  | 'publishability'
  | 'publication_status';
export type ReadinessActionId =
  | 'select_workspace'
  | 'configure_brand'
  | 'configure_payments'
  | 'manage_team'
  | 'configure_legal'
  | 'configure_sender'
  | 'edit_event_basics'
  | 'manage_tickets'
  | 'manage_products'
  | 'review_fees'
  | 'review_checkout'
  | 'edit_event_content'
  | 'edit_confirmation_content'
  | 'review_preview'
  | 'run_test_order'
  | 'configure_check_in'
  | 'publish_event'
  | 'view_event';
export type ReadinessReasonCode =
  | 'workspace_selected'
  | 'organization_inactive'
  | 'brand_inactive'
  | 'brand_identity_configured'
  | 'brand_identity_incomplete'
  | 'payment_capture_mode'
  | 'payment_capture_mode_paid_unsupported'
  | 'payment_path_ready'
  | 'payment_path_missing'
  | 'payment_account_inactive'
  | 'payment_charges_disabled'
  | 'payment_currency_mismatch'
  | 'team_access_configured'
  | 'team_access_single_member'
  | 'legal_configuration_complete'
  | 'legal_configuration_missing'
  | 'sender_identity_verified'
  | 'sender_identity_missing'
  | 'event_basics_valid'
  | 'event_title_missing'
  | 'event_schedule_invalid'
  | 'event_start_invalid'
  | 'event_timezone_missing'
  | 'sellable_ticket_available'
  | 'sellable_ticket_missing'
  | 'ticket_inventory_unavailable'
  | 'inventory_invalid'
  | 'sales_window_invalid'
  | 'currency_coherent'
  | 'ticket_currency_mismatch'
  | 'product_currency_mismatch'
  | 'pricing_valid'
  | 'pricing_invalid'
  | 'checkout_reviewed'
  | 'checkout_review_required'
  | 'public_content_published'
  | 'public_content_missing'
  | 'confirmation_content_valid'
  | 'confirmation_content_missing'
  | 'payment_not_required'
  | 'payment_ready'
  | 'preview_reviewed'
  | 'preview_review_required'
  | 'test_order_complete'
  | 'test_order_recommended'
  | 'test_order_not_applicable'
  | 'check_in_configured'
  | 'check_in_configuration_missing'
  | 'required_steps_complete'
  | 'required_steps_incomplete'
  | 'event_published'
  | 'event_unpublished'
  | 'acknowledgement_stale'
  | 'permission_required';
export type ReadinessStep = {
  id: ReadinessStepId;
  status: ReadinessStatus;
  priority: ReadinessPriority;
  reasonCodes: ReadinessReasonCode[];
  actionId: ReadinessActionId | null;
  requiredPermission: Permission | null;
  updatedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgementValid: boolean | null;
};
export type WorkspaceReadiness = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  generatedAt: string;
  paymentMode: 'capture' | 'provider_test' | 'provider';
  complete: boolean;
  steps: ReadinessStep[];
};
export type EventLaunchReadiness = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  eventVersion: number;
  generatedAt: string;
  paymentMode: 'capture' | 'provider_test' | 'provider';
  launchable: boolean;
  published: boolean;
  requiredBlockers: ReadinessStep[];
  recommendedWarnings: ReadinessStep[];
  steps: ReadinessStep[];
};
export type LaunchReadinessFailureDetails = {
  requiredBlockers: ReadinessStep[];
  recommendedWarnings: ReadinessStep[];
};

const readinessStatuses = new Set(['complete', 'incomplete', 'blocked', 'not_applicable']);
const readinessPriorities = new Set(['required', 'recommended']);
const readinessStepIds = new Set([
  'workspace_selection',
  'brand_identity',
  'payment_path',
  'team_access',
  'legal_configuration',
  'sender_identity',
  'basics_schedule',
  'sellable_tickets',
  'currency_coherence',
  'fee_pricing',
  'checkout_consent',
  'public_content',
  'confirmation_content',
  'payment_readiness',
  'preview_review',
  'test_order',
  'check_in_configuration',
  'publishability',
  'publication_status',
]);
const readinessActionIds = new Set([
  'select_workspace',
  'configure_brand',
  'configure_payments',
  'manage_team',
  'configure_legal',
  'configure_sender',
  'edit_event_basics',
  'manage_tickets',
  'manage_products',
  'review_fees',
  'review_checkout',
  'edit_event_content',
  'edit_confirmation_content',
  'review_preview',
  'run_test_order',
  'configure_check_in',
  'publish_event',
  'view_event',
]);
const readinessPermissions = new Set([
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
]);
const readinessReasonCodeValues = new Set<ReadinessReasonCode>([
  'workspace_selected',
  'organization_inactive',
  'brand_inactive',
  'brand_identity_configured',
  'brand_identity_incomplete',
  'payment_capture_mode',
  'payment_capture_mode_paid_unsupported',
  'payment_path_ready',
  'payment_path_missing',
  'payment_account_inactive',
  'payment_charges_disabled',
  'payment_currency_mismatch',
  'team_access_configured',
  'team_access_single_member',
  'legal_configuration_complete',
  'legal_configuration_missing',
  'sender_identity_verified',
  'sender_identity_missing',
  'event_basics_valid',
  'event_title_missing',
  'event_schedule_invalid',
  'event_start_invalid',
  'event_timezone_missing',
  'sellable_ticket_available',
  'sellable_ticket_missing',
  'ticket_inventory_unavailable',
  'inventory_invalid',
  'sales_window_invalid',
  'currency_coherent',
  'ticket_currency_mismatch',
  'product_currency_mismatch',
  'pricing_valid',
  'pricing_invalid',
  'checkout_reviewed',
  'checkout_review_required',
  'public_content_published',
  'public_content_missing',
  'confirmation_content_valid',
  'confirmation_content_missing',
  'payment_not_required',
  'payment_ready',
  'preview_reviewed',
  'preview_review_required',
  'test_order_complete',
  'test_order_recommended',
  'test_order_not_applicable',
  'check_in_configured',
  'check_in_configuration_missing',
  'required_steps_complete',
  'required_steps_incomplete',
  'event_published',
  'event_unpublished',
  'acknowledgement_stale',
  'permission_required',
]);

function isReadinessStep(value: unknown): value is ReadinessStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.id === 'string' &&
    readinessStepIds.has(step.id) &&
    typeof step.status === 'string' &&
    readinessStatuses.has(step.status) &&
    typeof step.priority === 'string' &&
    readinessPriorities.has(step.priority) &&
    Array.isArray(step.reasonCodes) &&
    step.reasonCodes.length > 0 &&
    step.reasonCodes.every(
      (reason) =>
        typeof reason === 'string' && readinessReasonCodeValues.has(reason as ReadinessReasonCode),
    ) &&
    (step.actionId === null ||
      (typeof step.actionId === 'string' && readinessActionIds.has(step.actionId))) &&
    (step.requiredPermission === null ||
      (typeof step.requiredPermission === 'string' &&
        readinessPermissions.has(step.requiredPermission))) &&
    (step.updatedAt === null || typeof step.updatedAt === 'string') &&
    (step.acknowledgedAt === null || typeof step.acknowledgedAt === 'string') &&
    (step.acknowledgementValid === null || typeof step.acknowledgementValid === 'boolean')
  );
}

export function isLaunchReadinessFailure(
  error: unknown,
): error is TixkitApiError & { details: LaunchReadinessFailureDetails } {
  if (!(error instanceof TixkitApiError) || error.code !== 'launch_readiness_failed') return false;
  const details = error.details;
  return Boolean(
    details &&
    Array.isArray(details.requiredBlockers) &&
    details.requiredBlockers.every(isReadinessStep) &&
    Array.isArray(details.recommendedWarnings) &&
    details.recommendedWarnings.every(isReadinessStep),
  );
}

export type StaleEventVersionDetails = {
  expectedVersion: number;
  currentVersion: number;
};

export function isStaleEventVersionFailure(
  error: unknown,
): error is TixkitApiError & { details: StaleEventVersionDetails } {
  if (!(error instanceof TixkitApiError) || error.code !== 'stale_event_version') return false;
  const details = error.details as Partial<StaleEventVersionDetails> | undefined;
  return Boolean(
    details &&
    Number.isInteger(details.expectedVersion) &&
    Number.isInteger(details.currentVersion),
  );
}

export function isArchivedEventFailure(error: unknown): error is TixkitApiError {
  return error instanceof TixkitApiError && error.code === 'event_archived';
}
export type ReadinessAcknowledgement = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  stepId: 'checkout_consent' | 'preview_review';
  stepVersion: number;
  subjectFingerprint: string;
  actorId: string;
  acknowledgedAt: string;
};

export type PublicMarketingIntegration = {
  provider: 'ga4' | 'meta_pixel' | 'generic_tag';
  config: Record<string, unknown>;
  consentRequired: boolean;
  status: 'active' | 'disabled' | string;
};

export type PublicEvent = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: string;
  timezone: string;
  startsAt: string;
  endsAt: string | null;
  venue: Record<string, unknown> | null;
  brandId: string;
  coverImageUrl?: string;
  minimumAge: number | null;
  marketingIntegrations: PublicMarketingIntegration[];
};

export type ResalePolicy = {
  enabled: boolean;
  maxMultiplier: number;
  maxAbsoluteCents?: number;
};

export type FeeRule = {
  id?: string;
  eventId?: string;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
  appliedTo: 'per_ticket' | 'per_order';
  absorbIntoPrice: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type EventFeePolicy = {
  eventId: string;
  eventVersion: number;
  passFeesToBuyer: boolean;
  rules: FeeRule[];
};

export type UpdateEventFeePolicyInput = {
  expectedVersion: number;
  passFeesToBuyer: boolean;
  rules: Array<{
    id?: string;
    name: string;
    type: 'percentage' | 'fixed';
    value: number;
    appliedTo: 'per_ticket' | 'per_order';
  }>;
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
    buyerFeeCents?: number;
    organizerAbsorbedFeeCents?: number;
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
  faceValueCents: number;
  currency: string;
  resaleEnabled: boolean;
  resaleMaxPriceCents: number;
  activeResaleListing?: TicketListing;
  appleUrl?: string;
  googleUrl?: string;
};

export type CheckoutWalletPasses = {
  tickets: CheckoutWalletPassTicket[];
};

export type UploadPurpose =
  | 'checkout_answer'
  | 'brand_logo'
  | 'user_avatar'
  | 'content_email_image'
  | 'content_event_page_image'
  | 'event_cover'
  | 'event_seo_image';

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
  questionId: string;
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
  durable?: boolean;
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

export type CheckoutCreateItem =
  | {
      ticketTypeId: string;
      occurrenceId?: string;
      quantity: number;
      unitAmountCents?: number;
      attendeeFields?: Array<Record<string, unknown> & { dateOfBirth?: string }>;
    }
  | { productId: string; quantity: number }
  | { resaleListingId: string; quantity: 1 };

export type BoxOfficeOrderInput = {
  tenderType: 'comp' | 'cash' | 'manual_card';
  amountCents: number;
  items: {
    ticketTypeId: string;
    occurrenceId?: string;
    quantity: number;
    attendeeFields?: Array<Record<string, unknown> & { dateOfBirth?: string }>;
  }[];
  buyer: {
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    dateOfBirth?: string;
  };
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
  outputType: 'preview' | 'test_send' | 'send';
  artifactRef: string;
  checksum: string;
  createdAt: string;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[];

export type PuckComponentData = {
  type: string;
  props: Record<string, JsonValue>;
};

export type PuckRootData = {
  props: Record<string, JsonValue>;
};

export type PuckData = {
  content: PuckComponentData[];
  root: PuckRootData;
  zones?: Record<string, PuckComponentData[]>;
};

export type EventPageDocumentV2 = {
  schemaVersion: 2;
  editor: {
    provider: '@puckeditor/core';
    data: PuckData;
  };
  settings?: Record<string, JsonValue>;
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
    publishedAt?: string;
  };
  page: {
    provider: '@puckeditor/core';
    puckData: PuckData;
    settings?: Record<string, JsonValue>;
    discovery: PublicEventDiscoveryCard;
  };
};

export type PublicQuestionsResponse = {
  buyerQuestions: Question[];
  attendeeQuestions: Question[];
};

export type PublicTicketListingPage = {
  items: PublicTicketListing[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

export type PublicCheckoutBootstrap = {
  event: PublicEvent;
  availability: PublicAvailabilityItem[];
  questions: PublicQuestionsResponse;
  resaleListing: PublicTicketListing | null;
};

export type PublicEventPageBootstrap = {
  event: PublicEvent;
  contentPage: PublicContentPage | null;
  availability: PublicAvailabilityItem[];
  resaleListings: PublicTicketListingPage;
};

export type PublicEventRevision = {
  revision: string | null;
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

export type PublicAvailabilityTicketItem = {
  ticketTypeId: string;
  eventOccurrenceId?: string;
  name: string;
  kind: 'free' | 'paid' | 'donation';
  priceCents: number;
  currency: string;
  minimumPriceCents?: number;
  minPerOrder: number;
  maxPerOrder: number;
  available: number;
  status: string;
  requiresAccessCode: boolean;
  accessCodeHint?: string;
  description?: string;
  salesStartAt?: string;
  salesEndAt?: string;
};

export type PublicAvailabilityProductItem = {
  type: 'product';
  productId: string;
  name: string;
  kind: 'product';
  priceCents: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
  available: number;
  status: string;
  requiresAccessCode: false;
  description?: string;
  salesStartAt?: string;
  salesEndAt?: string;
};

export type PublicAvailabilityItem = PublicAvailabilityTicketItem | PublicAvailabilityProductItem;

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

export type UpdateContentDocumentInput = {
  name: string;
};

export type ContentDocumentListParams = {
  limit?: number;
  channel?: ContentChannel;
  brandId?: string;
  eventId?: string;
};

export type DuplicateContentDocumentInput = {
  key?: string;
  name?: string;
};

export type SaveContentVersionInput = {
  subject?: string;
  previewText?: string;
  contentJson?: EmailTemplateDocument | SmsTemplateDocument | Record<string, unknown>;
  renderedHtml?: string;
  renderedText?: string;
};

export type EmailTemplateCategory = 'transactional' | 'bulk' | 'staff' | 'system';

export type EmailTemplateSender = {
  fromEmail?: string;
  fromName?: string;
  replyToEmail?: string;
};

export type EmailTemplateDocument = {
  schemaVersion: 1;
  editor: {
    provider: '@react-email/editor';
    contentHtml: string;
    contentText?: string;
    contentJson?: Record<string, unknown>;
  };
  settings: {
    templateKey: string;
    subject: string;
    previewText?: string;
    locale: string;
    category: EmailTemplateCategory;
    sender: EmailTemplateSender;
  };
  blocks: EmailTemplateBlock[];
};

export type EmailTemplateBlock =
  | {
      type: 'event_hero';
      headline: string;
      body?: string;
      imageUrl?: string;
      imageAlt?: string;
      ctaLabel?: string;
      ctaUrl?: string;
    }
  | {
      type: 'ticket_summary';
      title: string;
      body: string;
    }
  | {
      type: 'order_summary';
      title: string;
      rows: Array<{ label: string; value: string }>;
    }
  | {
      type: 'qr_code';
      title: string;
      imageUrl: string;
      imageAlt?: string;
    }
  | {
      type: 'calendar_button';
      label: string;
      url: string;
    }
  | {
      type: 'venue_block';
      title: string;
      address: string;
      mapUrl?: string;
    }
  | {
      type: 'social_links';
      links: Array<{ label: string; url: string }>;
    }
  | {
      type: 'unsubscribe_footer';
      body: string;
      unsubscribeUrl: string;
    }
  | {
      type: 'raw_html';
      html: string;
      safe: boolean;
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
  resaleListingId?: string;
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

export type OrderDetail = Order & {
  lineItems: OrderLineItem[];
  attendees: Attendee[];
  timeline: OrderTimelineEvent[];
  invoice?: Invoice;
  taxSnapshots: TaxSnapshot[];
  checkoutAnswers: {
    buyerFields: Record<string, unknown>;
    attendeeFields: Record<string, unknown>;
  };
  consentSnapshots: Record<string, unknown>;
  refunds: Refund[];
  deliveryStatus: {
    email: 'pending' | 'not_applicable';
    tickets: 'issued' | 'not_issued';
  };
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
  boxOfficeSettings: BoxOfficeSettings;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationMemberRole =
  | 'owner'
  | 'admin'
  | 'organizer'
  | 'viewer'
  | 'door_staff'
  | 'door_staff_sales';

export type OrganizationMember = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: OrganizationMemberRole;
  status: string;
  invitedAt: string;
  joinedAt: string | null;
  brandIds: string[];
  eventIds: string[];
};

type OrganizationMemberScopeInput =
  | { brandIds?: string[]; eventIds?: never }
  | { brandIds?: never; eventIds?: string[] };

export type UpdateOrganizationMemberInput = OrganizationMemberScopeInput & {
  role: Exclude<OrganizationMemberRole, 'owner'>;
};

export type InviteOrganizationMemberInput = OrganizationMemberScopeInput & {
  email: string;
  role?: Exclude<OrganizationMemberRole, 'owner'>;
  returnTo?: string;
};

export type OrganizationInvitation = OrganizationMember & {
  invitationDelivery: 'queued';
  invitationProvider: string;
};

export type BoxOfficeSettings = {
  enabled: boolean;
  allowedTenderTypes: Array<'cash' | 'manual_card' | 'comp'>;
  requireBuyerEmail: boolean;
  receiptMode: 'print' | 'email' | 'both';
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

export type BrandSenderIdentity = {
  id: string;
  tenantId: string;
  brandId: string;
  email: string;
  name: string;
  replyToEmail?: string;
  verified: boolean;
  verifiedAt?: string;
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

export type ApiKeyCreated = ApiKey & {
  apiKey: string;
};

export type ScannerDevice = {
  id: string;
  tenantId: string;
  organizationId: string;
  name: string;
  deviceId: string;
  eventIds: string[];
  scopes: string[];
  status: string;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
  secret?: string;
};

export type ScannerDeviceCreated = ScannerDevice & {
  secret: string;
};

export type WebhookEventType =
  | 'order.created'
  | 'order.paid'
  | 'order.refunded'
  | 'order.disputed'
  | 'ticket.issued'
  | 'ticket.checked_in'
  | 'attendee.updated'
  | 'event.published'
  | 'event.cancelled';

export type WebhookEndpoint = {
  id: string;
  tenantId: string;
  organizationId: string;
  url: string;
  secret?: string;
  events: WebhookEventType[];
  status: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type WebhookEndpointCreated = WebhookEndpoint & {
  secret: string;
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

export type CheckInActivityItem = {
  id: string;
  checkInListId: string;
  ticketId: string | null;
  deviceId: string;
  outcome: string;
  scannedAt: string;
  offline: boolean;
  attendeeName: string | null;
  attendeeEmail: string | null;
  ticketTypeId: string | null;
};

export type CheckInActivitySummary = {
  checkedIn: number;
  remaining: number;
  total: number;
  acceptedScans: number;
};

export type CheckInActivityPage = {
  items: CheckInActivityItem[];
  summary: CheckInActivitySummary;
  nextCursor?: string;
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
    eventOccurrenceId?: string;
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

export type OfflineSyncScan = {
  qrHash: string;
  scannedAt: string;
  offline: boolean;
};

export type BulkSyncErrorSample = {
  sequence: number;
  scanIndex: number;
  outcome: string;
  metadata?: Record<string, unknown>;
};

export type BulkSyncProcessingMetrics = {
  processingDurationMs: number;
  transactionDurationMs: number;
  lockWaitMs: number;
  scanLogInsertDurationMs: number;
  ticketUpdateDurationMs: number;
  attendeeUpdateDurationMs: number;
  rowsProcessed: number;
  clockWarnings: number;
};

export type BulkSyncJob = {
  id: string;
  tenantId: string;
  eventId: string;
  checkInListId: string;
  deviceId: string;
  totalChunks: number;
  totalScans: number | null;
  chunksReceived: number;
  chunksProcessed: number;
  status: 'pending' | 'receiving' | 'processing' | 'completed' | 'failed' | string;
  attemptCount: number;
  nextAttemptAt?: string | null;
  leasedUntil?: string | null;
  lastAttemptedAt?: string | null;
  processingStartedAt?: string | null;
  processingCompletedAt?: string | null;
  accepted: number;
  duplicates: number;
  invalid: number;
  processingMetrics: BulkSyncProcessingMetrics;
  sampleErrors: BulkSyncErrorSample[];
  failureMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
};

export type BulkSyncChunk = {
  id: string;
  jobId: string;
  sequence: number;
  scanCount: number;
  status: 'uploaded' | 'processing' | 'processed' | 'failed' | string;
  accepted: number;
  duplicates: number;
  invalid: number;
  clockWarnings: number;
  sampleErrors: BulkSyncErrorSample[];
  attemptCount: number;
  failureMessage?: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt?: string | null;
};

export type BulkSyncChunkList = {
  items: BulkSyncChunk[];
  total: number;
};

export type BulkSyncBacklogResult =
  | { mode: 'sync'; result: SyncScanResult }
  | { mode: 'async'; job: BulkSyncJob; chunks: BulkSyncChunk[] };

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
    rate: number | null;
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
  emailTemplateKey?: string;
  smsTemplateKey?: string;
  channel: string;
  status: string;
  audienceCount: number;
  queuedEmailJobs: number;
  queuedSmsJobs: number;
  suppressedRecipients: number;
  consentExclusions: number;
  skippedRecipients: number;
  scheduledAt?: string;
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

export type TicketListing = {
  id: string;
  tenantId: string;
  eventId: string;
  ticketId: string;
  sellerId: string;
  status: 'listed' | 'delisted' | 'sold' | 'expired' | string;
  priceCents: number;
  currency: string;
  faceValueCents: number;
  soldToId?: string;
  expiresAt?: string;
  soldAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicTicketListing = {
  id: string;
  eventId: string;
  ticketTypeId?: string;
  ticketTypeName?: string;
  status: 'listed' | string;
  priceCents: number;
  currency: string;
  faceValueCents: number;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TicketResaleCompletion = {
  listing: TicketListing;
  sellerTicket: Ticket;
  buyerTicket: Ticket;
  buyerAttendee: Attendee;
};

export type RefundQueued = {
  orderId: string;
  refundAmount: number;
  status: 'pending' | string;
  message: string;
};

export type Refund = {
  id: string;
  tenantId?: string;
  orderId: string;
  paymentIntentId?: string;
  provider?: string;
  providerRefundId?: string;
  status: string;
  reason: string;
  currency: string;
  amountCents: number;
  createdAt?: string;
  updatedAt?: string;
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
  tenantId: string;
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

type PrivacyRequestSubjectIdentifier =
  | {
      subjectId: string;
      subjectEmail?: string;
    }
  | {
      subjectId?: string;
      subjectEmail: string;
    };

export type PrivacyRequestInput = {
  organizationId: string;
  brandId?: string;
  subjectType: 'buyer' | 'attendee';
} & PrivacyRequestSubjectIdentifier;

export type MessageCampaign = {
  id: string;
  eventId: string;
  tenantId?: string;
  brandId?: string;
  templateKey?: string;
  emailTemplateKey?: string;
  smsTemplateKey?: string;
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

export type MessageRenderPreviewInput = {
  channel: 'email' | 'sms';
  subjectTemplate?: string;
  htmlTemplate?: string;
  textTemplate?: string;
  context?: Record<string, unknown>;
  optOutToken?: string;
};

export type MessageRenderPreview = {
  channel: 'email' | 'sms';
  subject: string;
  html: string;
  text?: string;
  segments?: {
    segments: number;
    encoding: 'gsm' | 'unicode';
    charsPerSegment: number;
    unitsUsed: number;
    remaining: number;
  };
  validation: {
    valid: boolean;
    unknownTags: string[];
  };
};

export type SendMessageAudience = 'all' | 'checked_in' | 'not_checked_in' | 'specific';
export type SendMessageBaseInput = {
  audience: SendMessageAudience;
  attendeeIds?: string[];
  variables?: Record<string, unknown>;
  scheduledAt?: string;
} & IdempotencyOptions;
export type SendEmailMessageInput = SendMessageBaseInput & {
  channel: 'email';
  emailTemplateKey: string;
};
export type SendSmsMessageInput = SendMessageBaseInput & {
  channel: 'sms';
  smsTemplateKey: string;
};
export type SendBothMessageInput = SendMessageBaseInput & {
  channel: 'both';
  emailTemplateKey: string;
  smsTemplateKey: string;
};
export type SendMessageInput = SendEmailMessageInput | SendSmsMessageInput | SendBothMessageInput;

export type MessageJobRecord = {
  id: string;
  tenant_id?: string;
  brand_id?: string;
  template_key?: string;
  template_version_id?: string;
  provider_route_id?: string;
  status: string;
  priority?: string;
  scheduled_at?: string | null;
  workflow_id?: string | null;
  recipient?: string;
  created_at?: string;
  updated_at?: string;
};

export type MessageJob = {
  channel: string;
  campaignId: string;
  eventId: string;
  job: MessageJobRecord;
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
  event: {
    id: string;
    tenant_id?: string | null;
    provider?: string;
    provider_event_id?: string;
    event_type?: string;
    provider_message_id?: string | null;
    processed_at?: string | null;
    created_at?: string;
  };
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

export type AdminTableSortDirection = 'asc' | 'desc';
export type AdminTableCursorDirection = 'next' | 'prev';

export type AdminTableSort = {
  field: string;
  direction: AdminTableSortDirection;
};

export type AdminTableFilterValue =
  | { type: 'text'; value: string }
  | { type: 'select'; values: string[] }
  | { type: 'boolean'; value: boolean }
  | { type: 'date_range'; from?: string; to?: string }
  | { type: 'number_range'; min?: number; max?: number };

export type AdminTableFacetRow = {
  value: string | number | boolean;
  total: number;
};

export type AdminTableFacet = {
  rows?: AdminTableFacetRow[];
  total?: number;
  min?: number;
  max?: number;
};

export type AdminTablePage<T> = {
  items: T[];
  nextCursor?: string | null;
  prevCursor?: string | null;
  total?: number;
  filterTotal?: number;
  facets?: Record<string, AdminTableFacet>;
  applied?: {
    search?: string;
    sort: AdminTableSort[];
    filters: Record<string, AdminTableFilterValue>;
    rejectedFilters?: string[];
    rejectedSort?: string[];
  };
};

export type ItemList<T> = {
  items: T[];
};

export type PaginationParams = {
  cursor?: string;
  limit?: number;
};

export type AdminTableQueryParams = PaginationParams & {
  direction?: AdminTableCursorDirection;
  search?: string;
  sort?: string;
  includeTotal?: boolean;
  includeFacets?: boolean;
};

export type CheckInListListParams = PaginationParams & {
  headers?: Record<string, string>;
};

export type CheckInActivityListParams = {
  since?: string;
  afterId?: string;
  limit?: number;
  headers?: Record<string, string>;
};

export type CheckInActivityStreamOptions = {
  lastEventId?: string;
  headers?: Record<string, string>;
};

export type CheckoutSessionGetOptions = {
  clientToken?: string;
  paymentIntentClientSecret?: string;
};

export type EventListParams = AdminTableQueryParams & {
  status?: string;
  startsAtFrom?: string;
  startsAtTo?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type OrderListParams = AdminTableQueryParams & {
  organizationId?: string;
  eventId?: string;
  status?: string;
  salesChannel?: string;
  paymentProvider?: string;
  refundState?: boolean;
  totalCentsMin?: number;
  totalCentsMax?: number;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type AttendeeListParams = AdminTableQueryParams & {
  status?: string;
  checkInStatus?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  checkedInAtFrom?: string;
  checkedInAtTo?: string;
};

export type AttendeeListAllParams = AttendeeListParams & {
  eventId?: string;
};

export type AuditLogListParams = AdminTableQueryParams & {
  organizationId?: string;
  brandId?: string;
  action?: string;
  resourceType?: string;
  actorId?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
};

export type PrivacyRequestListParams = AdminTableQueryParams & {
  organizationId?: string;
  brandId?: string;
  requestType?: 'export' | 'erasure';
  status?: 'pending' | 'processing' | 'completed' | 'failed';
  subjectType?: string;
  createdAtFrom?: string;
  createdAtTo?: string;
  completedAtFrom?: string;
  completedAtTo?: string;
};

export type IdempotencyOptions = {
  idempotencyKey: string;
};

export type CreateRefundInput = {
  amountCents?: number;
  reason: string;
  voidTickets?: boolean;
  restoreInventory?: boolean;
} & IdempotencyOptions;

export type MigrationJob = {
  id: string;
  tenant_id: string;
  organization_id: string;
  source_system: string;
  adapter_version: string;
  mode: 'dry-run' | 'commit';
  status: string;
  configurationHash: string;
  credentialConfigured: boolean;
  summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
export type CreateMigrationJobInput = {
  organizationId: string;
  sourceSystem: string;
  adapterVersion: string;
  mode?: 'dry-run' | 'commit';
  configuration?: Record<string, unknown>;
  credentialId?: string;
} & IdempotencyOptions;
export type CreateMigrationCredentialInput = {
  organizationId: string;
  sourceSystem: string;
  secretReference: string;
  expiresAt: string;
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
  readonly migrations: MigrationResource;
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
    this.migrations = new MigrationResource(this);
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

    const hasBody = options?.body !== undefined;
    const headers: Record<string, string> = {
      'X-Tixkit-Version': this.apiVersion,
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
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
            body: hasBody ? JSON.stringify(options.body) : undefined,
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
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          // eslint-disable-next-line no-await-in-loop -- retry backoff is intentionally sequential between attempts.
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }

  async requestRaw(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string>;
      idempotencyKey?: string;
      headers?: Record<string, string>;
      successStatuses?: number[];
    },
  ): Promise<Response> {
    const url = new URL(`${this.apiBaseUrl}/v1${path}`);

    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const hasBody = options?.body !== undefined;
    const headers: Record<string, string> = {
      'X-Tixkit-Version': this.apiVersion,
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
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
    const successStatuses = new Set(options?.successStatuses ?? []);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        let response: Response;
        try {
          // eslint-disable-next-line no-await-in-loop -- retries must run sequentially so backoff and previous response state are respected.
          response = await fetch(url.toString(), {
            method,
            headers,
            body: hasBody ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (!response.ok && !successStatuses.has(response.status)) {
          // eslint-disable-next-line no-await-in-loop -- each retry attempt must consume its own error response before deciding whether to retry.
          const responseText = await response.text();
          throw createApiErrorFromResponse(response.status, parseErrorResponse(responseText));
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (!retryableRequest) {
          throw err;
        }

        if (err instanceof TixkitApiError) {
          if (err.statusCode >= 400 && err.statusCode < 500) {
            throw err;
          }
        }

        if (attempt < attempts - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          // eslint-disable-next-line no-await-in-loop -- retry backoff is intentionally sequential between attempts.
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw lastError ?? new Error('Request failed');
  }
}

function isBrowserRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    window?: unknown;
    document?: unknown;
  };
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

function clampChunkSize(value: number | undefined): number {
  if (value === undefined) return MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS) {
    throw new Error(
      `chunkSize must be an integer between 1 and ${MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS}`,
    );
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIdempotencyKey(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return `${prefix}-${cryptoApi.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

class CheckoutResource {
  constructor(private client: TixkitClient) {}

  async create(
    input: {
      eventId: string;
      items: CheckoutCreateItem[];
      discountCode?: string;
      affiliateCode?: string;
      trackingId?: string;
      buyerFields?: Record<string, unknown>;
      buyer: {
        email: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        dateOfBirth?: string;
      };
      successUrl?: string;
      cancelUrl?: string;
      accessCode?: string;
      waitlistClaimToken?: string;
      testOrder?: boolean;
    } & IdempotencyOptions,
  ): Promise<CheckoutSession> {
    const { idempotencyKey, testOrder, ...body } = input;
    return this.client.request('POST', '/checkout/sessions', {
      body,
      idempotencyKey,
      headers: testOrder ? { 'X-Tixkit-Test-Order': '1' } : undefined,
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

  async walletPasses(sessionId: string, clientToken: string): Promise<CheckoutWalletPasses> {
    return this.client.request('GET', `/checkout/sessions/${sessionId}/wallet-passes`, {
      headers: { 'X-Checkout-Session-Token': clientToken },
    });
  }

  async createTicketResaleListing(
    sessionId: string,
    ticketId: string,
    input: {
      clientToken: string;
      priceCents: number;
      expiresAt?: string;
    } & IdempotencyOptions,
  ): Promise<TicketListing> {
    const { idempotencyKey, clientToken, ...body } = input;
    return this.client.request(
      'POST',
      `/checkout/sessions/${sessionId}/tickets/${ticketId}/resale-listing`,
      {
        body,
        idempotencyKey,
        headers: { 'X-Checkout-Session-Token': clientToken },
      },
    );
  }

  async update(
    sessionId: string,
    input: {
      clientToken: string;
      buyer?: {
        email?: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        dateOfBirth?: string;
      };
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
    input: {
      paymentMethodId?: string;
      clientToken: string;
    } & IdempotencyOptions,
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

  async list(params?: EventListParams): Promise<AdminTablePage<Event>> {
    return this.client.request('GET', '/events', {
      params: paginationParams(params),
    });
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
    minimumAge?: number | null;
  }): Promise<Event> {
    return this.client.request('POST', '/events', { body: input });
  }

  async publish(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/publish`);
  }

  async duplicate(eventId: string, input: DuplicateEventInput): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/duplicate`, {
      body: input,
    });
  }

  async launchReadiness(eventId: string): Promise<EventLaunchReadiness> {
    return this.client.request('GET', `/events/${eventId}/launch-readiness`);
  }

  async acknowledgeReadinessStep(
    eventId: string,
    stepId: ReadinessAcknowledgement['stepId'],
  ): Promise<ReadinessAcknowledgement> {
    return this.client.request('POST', `/events/${eventId}/readiness-acknowledgements/${stepId}`);
  }

  async removeReadinessAcknowledgement(
    eventId: string,
    stepId: ReadinessAcknowledgement['stepId'],
  ): Promise<void> {
    await this.client.requestRaw(
      'DELETE',
      `/events/${eventId}/readiness-acknowledgements/${stepId}`,
      { successStatuses: [204] },
    );
  }

  async update(
    eventId: string,
    input: Partial<
      Pick<
        Event,
        | 'title'
        | 'description'
        | 'currency'
        | 'timezone'
        | 'startsAt'
        | 'endsAt'
        | 'visibility'
        | 'capacity'
        | 'minimumAge'
        | 'coverImageUrl'
        | 'externalUrl'
        | 'venue'
        | 'seo'
        | 'coverImageAlt'
        | 'seoUseCoverImage'
        | 'lastSetupSection'
      >
    > & { expectedVersion: number },
  ): Promise<Event> {
    return this.client.request('PATCH', `/events/${eventId}`, { body: input });
  }

  async pause(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/pause`);
  }

  async archive(eventId: string): Promise<Event> {
    return this.client.request('POST', `/events/${eventId}/archive`);
  }

  async getResalePolicy(eventId: string): Promise<ResalePolicy> {
    return this.client.request('GET', `/events/${eventId}/resale-policy`);
  }

  async updateResalePolicy(eventId: string, input: ResalePolicy): Promise<ResalePolicy> {
    return this.client.request('PUT', `/events/${eventId}/resale-policy`, {
      body: input,
    });
  }

  async getFeePolicy(eventId: string): Promise<EventFeePolicy> {
    return this.client.request('GET', `/events/${eventId}/fee-policy`);
  }

  async updateFeePolicy(
    eventId: string,
    input: UpdateEventFeePolicyInput,
  ): Promise<EventFeePolicy> {
    return this.client.request('PUT', `/events/${eventId}/fee-policy`, {
      body: input,
    });
  }

  async listResaleListings(
    eventId: string,
    params?: PaginationParams,
  ): Promise<PageResult<TicketListing>> {
    return this.client.request('GET', `/events/${eventId}/resale-listings`, {
      params: paginationParams(params),
    });
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
    return this.client.request('POST', `/events/${eventId}/occurrences`, {
      body: input,
    });
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

  async list(params?: OrderListParams): Promise<AdminTablePage<Order>> {
    return this.client.request('GET', '/orders', {
      params: paginationParams(params),
    });
  }

  async get(orderId: string): Promise<OrderDetail> {
    return this.client.request('GET', `/orders/${orderId}`);
  }

  async invoice(orderId: string): Promise<InvoiceDocument> {
    return this.client.request('GET', `/orders/${orderId}/invoice`);
  }

  async downloadInvoice(orderId: string): Promise<InvoiceDocument> {
    return this.client.request('GET', `/orders/${orderId}/invoice/download`);
  }

  async cancel(orderId: string, options: IdempotencyOptions): Promise<Order> {
    return this.client.request('POST', `/orders/${orderId}/cancel`, {
      idempotencyKey: options.idempotencyKey,
    });
  }

  async refund(orderId: string, input: CreateRefundInput): Promise<RefundQueued> {
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
    input: { toEmail: string; dateOfBirth?: string } & IdempotencyOptions,
  ): Promise<Ticket> {
    const { idempotencyKey, toEmail, dateOfBirth } = input;
    return this.client.request('POST', `/tickets/${ticketId}/transfer`, {
      body: { toEmail, ...(dateOfBirth === undefined ? {} : { dateOfBirth }) },
      idempotencyKey,
    });
  }

  async createResaleListing(
    ticketId: string,
    input: { priceCents: number; expiresAt?: string } & IdempotencyOptions,
  ): Promise<TicketListing> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/tickets/${ticketId}/resale-listings`, {
      body,
      idempotencyKey,
    });
  }

  async delistResaleListing(listingId: string, input: IdempotencyOptions): Promise<TicketListing> {
    return this.client.request('POST', `/ticket-listings/${listingId}/delist`, {
      body: {},
      idempotencyKey: input.idempotencyKey,
    });
  }

  async completeResaleListing(
    listingId: string,
    input: {
      buyerId: string;
      buyerEmail: string;
      buyerDateOfBirth?: string;
      buyerFirstName?: string | null;
      buyerLastName?: string | null;
      buyerPhone?: string | null;
      externalPaymentReference?: string | null;
    } & IdempotencyOptions,
  ): Promise<TicketResaleCompletion> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/ticket-listings/${listingId}/complete`, {
      body,
      idempotencyKey,
    });
  }
}

class OrganizationResource {
  constructor(private client: TixkitClient) {}
  async list(): Promise<Organization[]> {
    return this.client.request('GET', '/organizations');
  }
  async readiness(organizationId: string, brandId: string): Promise<WorkspaceReadiness> {
    return this.client.request('GET', `/organizations/${organizationId}/readiness`, {
      params: { brandId },
    });
  }
  async create(input: {
    name: string;
    slug: string;
    clerkOrganizationId?: string;
    boxOfficeSettings?: BoxOfficeSettings;
  }): Promise<Organization> {
    return this.client.request('POST', '/organizations', { body: input });
  }
  async update(
    organizationId: string,
    input: Partial<Pick<Organization, 'name' | 'slug' | 'status' | 'boxOfficeSettings'>>,
  ): Promise<Organization> {
    return this.client.request('PATCH', `/organizations/${organizationId}`, {
      body: input,
    });
  }
  async updateMember(
    organizationId: string,
    memberId: string,
    input: UpdateOrganizationMemberInput,
  ): Promise<OrganizationMember> {
    return this.client.request('PATCH', `/organizations/${organizationId}/members/${memberId}`, {
      body: input,
    });
  }
  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.client.request('GET', `/organizations/${organizationId}/members`);
  }
  async inviteMember(
    organizationId: string,
    input: InviteOrganizationMemberInput & IdempotencyOptions,
  ): Promise<OrganizationInvitation> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/organizations/${organizationId}/members/invitations`, {
      body,
      idempotencyKey,
    });
  }
}

class BrandResource {
  constructor(private client: TixkitClient) {}
  async list(): Promise<Brand[]> {
    return this.client.request('GET', '/brands');
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
    return this.client.request('POST', `/brands/${brandId}/domains`, {
      body: input,
    });
  }
  async listSenderIdentities(brandId: string): Promise<BrandSenderIdentity[]> {
    return this.client.request('GET', `/brands/${brandId}/email-sender-identities`);
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
    return this.client.request('POST', `/events/${eventId}/ticket-types`, {
      body: input,
    });
  }
  async update(ticketTypeId: string, input: Record<string, unknown>): Promise<TicketType> {
    return this.client.request('PATCH', `/ticket-types/${ticketTypeId}`, {
      body: input,
    });
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
    return this.client.request('PATCH', `/ticket-types/${ticketTypeId}/batch`, {
      body: input,
    });
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
    return this.client.request('POST', `/events/${eventId}/inventory-pools`, {
      body: input,
    });
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
    return this.client.request('POST', `/events/${eventId}/products`, {
      body: input,
    });
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
    return this.client.request('PATCH', `/products/${productId}`, {
      body: input,
    });
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
  async list(eventId: string, params?: AttendeeListParams): Promise<AdminTablePage<Attendee>> {
    return this.client.request('GET', `/events/${eventId}/attendees`, {
      params: paginationParams(params),
    });
  }
  async listAll(params?: AttendeeListAllParams): Promise<AdminTablePage<Attendee>> {
    const query = paginationParams(params);
    return this.client.request('GET', '/attendees', {
      params: query,
    });
  }
  async update(
    attendeeId: string,
    input: Partial<Pick<Attendee, 'firstName' | 'lastName' | 'email' | 'phone' | 'status'>>,
  ): Promise<Attendee> {
    return this.client.request('PATCH', `/attendees/${attendeeId}`, {
      body: input,
    });
  }
}

class CheckInListResource {
  constructor(private client: TixkitClient) {}
  async list(eventId: string, params?: CheckInListListParams): Promise<PageResult<CheckInList>> {
    const { headers, ...queryParams } = params ?? {};
    return this.client.request('GET', `/events/${eventId}/check-in-lists`, {
      params: paginationParams(queryParams),
      headers,
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
  async listActivity(
    eventId: string,
    checkInListId: string,
    params?: CheckInActivityListParams,
  ): Promise<CheckInActivityPage> {
    const { headers, ...filters } = params ?? {};
    const query: Record<string, string> = {};
    if (filters.since) query.since = filters.since;
    if (filters.afterId) query.afterId = filters.afterId;
    if (filters.limit !== undefined) query.limit = String(filters.limit);
    return this.client.request(
      'GET',
      `/events/${eventId}/check-in-lists/${checkInListId}/activity`,
      { params: Object.keys(query).length > 0 ? query : undefined, headers },
    );
  }
  async getActivityStream(
    eventId: string,
    checkInListId: string,
    options?: CheckInActivityStreamOptions,
  ): Promise<Response> {
    return this.client.requestRaw(
      'GET',
      `/events/${eventId}/check-in-lists/${checkInListId}/activity/stream`,
      {
        headers: {
          ...options?.headers,
          Accept: 'text/event-stream',
          ...(options?.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
        },
      },
    );
  }
}

class CheckInResource {
  constructor(private client: TixkitClient) {}
  async scan(
    input: {
      checkInListId: string;
      qrPayload: string;
      scannedAt: string;
      offline?: boolean;
    } & {
      headers: Record<string, string>;
    },
  ): Promise<ScanResult> {
    const { headers, ...body } = input;
    return this.client.request('POST', '/check-ins/scan', { body, headers });
  }
  async sync(
    input: {
      checkInListId: string;
      scans: OfflineSyncScan[];
    } & IdempotencyOptions & { headers: Record<string, string> },
  ): Promise<SyncScanResult> {
    const { idempotencyKey, headers, ...body } = input;
    return this.client.request('POST', '/check-ins/sync', {
      body,
      idempotencyKey,
      headers,
    });
  }

  async createBulkSyncJob(
    input: {
      checkInListId: string;
      deviceId?: string;
      totalChunks: number;
      totalScans?: number;
    } & IdempotencyOptions & { headers: Record<string, string> },
  ): Promise<BulkSyncJob> {
    const { idempotencyKey, headers, ...body } = input;
    return this.client.request('POST', '/check-ins/bulk-sync-jobs', {
      body,
      idempotencyKey,
      headers,
    });
  }

  async uploadBulkSyncChunk(
    jobId: string,
    sequence: number,
    input: { scans: OfflineSyncScan[] } & IdempotencyOptions & {
        headers: Record<string, string>;
      },
  ): Promise<BulkSyncChunk> {
    const { idempotencyKey, headers, ...body } = input;
    return this.client.request('PUT', `/check-ins/bulk-sync-jobs/${jobId}/chunks/${sequence}`, {
      body,
      idempotencyKey,
      headers,
    });
  }

  async getBulkSyncJob(
    jobId: string,
    input: { headers: Record<string, string> },
  ): Promise<BulkSyncJob> {
    return this.client.request('GET', `/check-ins/bulk-sync-jobs/${jobId}`, {
      headers: input.headers,
    });
  }

  async listBulkSyncChunks(
    jobId: string,
    input: { headers: Record<string, string> },
  ): Promise<BulkSyncChunkList> {
    return this.client.request('GET', `/check-ins/bulk-sync-jobs/${jobId}/chunks`, {
      headers: input.headers,
    });
  }

  async pollBulkSyncJob(
    jobId: string,
    input: {
      headers: Record<string, string>;
      initialDelayMs?: number;
      maxDelayMs?: number;
      timeoutMs?: number;
    },
  ): Promise<BulkSyncJob> {
    const startedAt = Date.now();
    let delayMs = input.initialDelayMs ?? 500;
    const maxDelayMs = input.maxDelayMs ?? 10_000;
    const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;

    while (true) {
      // eslint-disable-next-line no-await-in-loop -- polling must observe one server status before scheduling the next request.
      const job = await this.getBulkSyncJob(jobId, { headers: input.headers });
      if (job.status === 'completed' || job.status === 'failed') return job;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for bulk sync job ${jobId}`);
      }
      // eslint-disable-next-line no-await-in-loop -- polling must wait between status checks.
      await delay(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }

  async syncBacklog(
    input: {
      checkInListId: string;
      deviceId?: string;
      scans: OfflineSyncScan[];
      forceAsync?: boolean;
      chunkSize?: number;
      poll?: boolean;
      pollInitialDelayMs?: number;
      pollMaxDelayMs?: number;
      pollTimeoutMs?: number;
    } & IdempotencyOptions & { headers: Record<string, string> },
  ): Promise<BulkSyncBacklogResult> {
    const {
      idempotencyKey,
      headers,
      checkInListId,
      deviceId,
      scans,
      forceAsync,
      chunkSize,
      poll,
      pollInitialDelayMs,
      pollMaxDelayMs,
      pollTimeoutMs,
    } = input;

    if (!forceAsync && scans.length <= MAX_OFFLINE_SYNC_SCANS) {
      return {
        mode: 'sync',
        result: await this.sync({
          checkInListId,
          scans,
          idempotencyKey,
          headers,
        }),
      };
    }

    const safeChunkSize = clampChunkSize(chunkSize);
    const totalChunks = Math.ceil(scans.length / safeChunkSize);
    const baseIdempotencyKey = idempotencyKey ?? randomIdempotencyKey(`bulk-sync-${checkInListId}`);
    const job = await this.createBulkSyncJob({
      checkInListId,
      deviceId,
      totalChunks,
      totalScans: scans.length,
      idempotencyKey: `${baseIdempotencyKey}:job`,
      headers,
    });
    const chunks: BulkSyncChunk[] = [];
    for (let offset = 0; offset < scans.length; offset += safeChunkSize) {
      const sequence = Math.floor(offset / safeChunkSize) + 1;
      const chunkScans = scans.slice(offset, offset + safeChunkSize);
      // eslint-disable-next-line no-await-in-loop -- chunk uploads are sequential to keep device replay state simple and bounded.
      const chunk = await this.uploadBulkSyncChunk(job.id, sequence, {
        scans: chunkScans,
        idempotencyKey: `${baseIdempotencyKey}:chunk:${sequence}`,
        headers,
      });
      chunks.push(chunk);
    }

    const finalJob =
      poll === false
        ? job
        : await this.pollBulkSyncJob(job.id, {
            headers,
            initialDelayMs: pollInitialDelayMs,
            maxDelayMs: pollMaxDelayMs,
            timeoutMs: pollTimeoutMs,
          });

    return { mode: 'async', job: finalJob, chunks };
  }
}

class ApiKeyResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<ApiKey>> {
    return this.client.request('GET', '/api-keys', {
      params: paginationParams(params),
    });
  }
  async create(input: {
    organizationId: string;
    name: string;
    scopes: string[];
    brandIds?: string[];
    eventIds?: string[];
    expiresAt?: string;
  }): Promise<ApiKeyCreated> {
    return this.client.request('POST', '/api-keys', { body: input });
  }
  async revoke(keyId: string): Promise<void> {
    return this.client.request('DELETE', `/api-keys/${keyId}`);
  }
}

class ScannerDeviceResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<ScannerDevice>> {
    return this.client.request('GET', '/scanner-devices', {
      params: paginationParams(params),
    });
  }
  async create(input: {
    organizationId: string;
    name: string;
    eventIds?: string[];
    scopes?: Array<'checkins.read' | 'checkins.write'>;
  }): Promise<ScannerDeviceCreated> {
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
  async tax(eventId: string, params?: { from?: string; to?: string }): Promise<TaxReport> {
    const query: Record<string, string> = {};
    if (params?.from) query.from = params.from;
    if (params?.to) query.to = params.to;
    return this.client.request('GET', `/events/${eventId}/reports/tax`, {
      params: Object.keys(query).length > 0 ? query : undefined,
    });
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
  async getEvents(exportId: string, options?: { lastEventId?: string }): Promise<Response> {
    return this.client.requestRaw('GET', `/exports/${exportId}/events`, {
      headers: {
        Accept: 'text/event-stream',
        ...(options?.lastEventId ? { 'Last-Event-ID': options.lastEventId } : {}),
      },
    });
  }
  async download(exportId: string): Promise<Response> {
    return this.client.requestRaw('GET', `/exports/${exportId}/download`, {
      successStatuses: [302],
    });
  }
}

class PrivacyResource {
  constructor(private client: TixkitClient) {}

  async listAuditLogs(params?: AuditLogListParams): Promise<AdminTablePage<AuditLog>> {
    return this.client.request('GET', '/audit-logs', {
      params: paginationParams(params),
    });
  }

  async listRequests(params?: PrivacyRequestListParams): Promise<AdminTablePage<PrivacyRequest>> {
    return this.client.request('GET', '/privacy/requests', {
      params: paginationParams(params),
    });
  }

  async getRequest(requestId: string): Promise<PrivacyRequest> {
    return this.client.request('GET', `/privacy/requests/${requestId}`);
  }

  async createDataExport(input: PrivacyRequestInput & IdempotencyOptions): Promise<PrivacyRequest> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/privacy/data-exports', {
      body,
      idempotencyKey,
    });
  }

  async createErasure(input: PrivacyRequestInput & IdempotencyOptions): Promise<PrivacyRequest> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/privacy/erasures', {
      body,
      idempotencyKey,
    });
  }
}

class ContentResource {
  constructor(private client: TixkitClient) {}

  async list(params?: ContentDocumentListParams): Promise<PageResult<ContentDocument>> {
    const query: Record<string, string> = {};
    if (params?.limit !== undefined) query.limit = String(params.limit);
    if (params?.channel) query.channel = params.channel;
    if (params?.brandId) query.brandId = params.brandId;
    if (params?.eventId) query.eventId = params.eventId;

    return this.client.request('GET', '/content-documents', {
      params: Object.keys(query).length > 0 ? query : undefined,
    });
  }

  async create(input: CreateContentDocumentInput): Promise<ContentDocument> {
    return this.client.request('POST', '/content-documents', { body: input });
  }

  async get(documentId: string): Promise<ContentDocument> {
    return this.client.request('GET', `/content-documents/${documentId}`);
  }

  async update(documentId: string, input: UpdateContentDocumentInput): Promise<ContentDocument> {
    return this.client.request('PATCH', `/content-documents/${documentId}`, {
      body: input,
    });
  }

  async duplicate(
    documentId: string,
    input: DuplicateContentDocumentInput = {},
  ): Promise<{
    document: ContentDocument;
    versions: ContentDocumentVersion[];
  }> {
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
  async send(eventId: string, input: SendMessageInput): Promise<MessageQueued> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', `/events/${eventId}/messages`, {
      body,
      idempotencyKey,
    });
  }
  async previewRecipients(
    eventId: string,
    input: { audience: string; attendeeIds?: string[]; channel: string },
  ): Promise<MessageRecipientPreview> {
    return this.client.request('POST', `/events/${eventId}/messages/preview`, {
      body: input,
    });
  }
  async renderPreview(
    eventId: string,
    input: MessageRenderPreviewInput,
  ): Promise<MessageRenderPreview> {
    return this.client.request('POST', `/events/${eventId}/messages/render-preview`, {
      body: input,
    });
  }
  async list(eventId: string): Promise<ItemList<MessageCampaign>> {
    return this.client.request('GET', `/events/${eventId}/messages`);
  }
  async getCampaign(eventId: string, campaignId: string): Promise<MessageCampaign> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}`);
  }
  async jobs(eventId: string, campaignId: string): Promise<ItemList<MessageJob>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/jobs`);
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
  async deliveryLogs(eventId: string, campaignId: string): Promise<ItemList<MessageDeliveryLog>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/delivery-logs`);
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
  ): Promise<ItemList<MessageProviderEvent>> {
    return this.client.request('GET', `/events/${eventId}/messages/${campaignId}/provider-events`);
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

class MigrationResource {
  constructor(private client: TixkitClient) {}
  createCredential(input: CreateMigrationCredentialInput): Promise<{ id: string; organizationId: string; sourceSystem: string; status: string; expiresAt: string }> {
    return this.client.request('POST', '/migration-credentials', { body: input });
  }
  revokeCredential(credentialId: string, organizationId: string): Promise<void> {
    return this.client.request('DELETE', `/migration-credentials/${credentialId}`, { params: { organizationId } });
  }
  list(params?: {
    organizationId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: MigrationJob[] }> {
    return this.client.request('GET', '/migration-jobs', {
      params: params
        ? Object.fromEntries(
            Object.entries(params)
              .filter((entry) => entry[1] !== undefined)
              .map(([key, value]) => [key, String(value)]),
          )
        : undefined,
    });
  }
  get(jobId: string): Promise<MigrationJob> {
    return this.client.request('GET', `/migration-jobs/${jobId}`);
  }
  create(input: CreateMigrationJobInput): Promise<MigrationJob> {
    const { idempotencyKey, ...body } = input;
    return this.client.request('POST', '/migration-jobs', { body, idempotencyKey });
  }
  registerFile(
    jobId: string,
    input: { uploadArtifactId: string },
  ): Promise<Record<string, unknown>> {
    return this.client.request('POST', `/migration-jobs/${jobId}/files`, { body: input });
  }
  rows(
    jobId: string,
    params?: { limit?: number; entityType?: string; status?: string },
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.client.request('GET', `/migration-jobs/${jobId}/rows`, {
      params: params
        ? Object.fromEntries(
            Object.entries(params)
              .filter((entry) => entry[1] !== undefined)
              .map(([key, value]) => [key, String(value)]),
          )
        : undefined,
    });
  }
  conflicts(
    jobId: string,
    params?: PaginationParams,
  ): Promise<{ items: Record<string, unknown>[] }> {
    return this.client.request('GET', `/migration-jobs/${jobId}/conflicts`, {
      params: paginationParams(params),
    });
  }
  events(jobId: string, afterSequence?: number): Promise<{ items: Record<string, unknown>[] }> {
    return this.client.request('GET', `/migration-jobs/${jobId}/events`, {
      params: afterSequence === undefined ? undefined : { afterSequence: String(afterSequence) },
    });
  }
  dryRun(
    jobId: string,
  ): Promise<{ status: 'ready' | 'failed'; report: Record<string, unknown>; domainWrites: 0 }> {
    return this.client.request('POST', `/migration-jobs/${jobId}/dry-run`);
  }
  report(jobId: string): Promise<Record<string, unknown>> {
    return this.client.request('GET', `/migration-jobs/${jobId}/report`);
  }
  commit(jobId: string): Promise<{ jobId: string; status: 'committing' }> {
    return this.client.request('POST', `/migration-jobs/${jobId}/commit`, {
      headers: { 'x-tixkit-confirmation': `commit:${jobId}` },
    });
  }
  pause(jobId: string) {
    return this.action(jobId, 'pause');
  }
  resume(jobId: string) {
    return this.action(jobId, 'resume');
  }
  cancel(jobId: string) {
    return this.action(jobId, 'cancel');
  }
  rollback(jobId: string) {
    return this.action(jobId, 'rollback');
  }
  rollbackAssessment(
    jobId: string,
  ): Promise<{ eligible: boolean; mode: string; blockers: Array<Record<string, unknown>> }> {
    return this.client.request('GET', `/migration-jobs/${jobId}/rollback-assessment`);
  }
  private action(jobId: string, action: string): Promise<{ accepted: true }> {
    return this.client.request('POST', `/migration-jobs/${jobId}/${action}`, {
      headers: action === 'rollback' ? { 'x-tixkit-confirmation': `rollback:${jobId}` } : undefined,
    });
  }
}

class WebhookEndpointResource {
  constructor(private client: TixkitClient) {}
  async list(params?: PaginationParams): Promise<PageResult<WebhookEndpoint>> {
    return this.client.request('GET', '/webhook-endpoints', {
      params: paginationParams(params),
    });
  }
  async create(input: {
    organizationId: string;
    url: string;
    events: WebhookEventType[];
    description?: string;
  }): Promise<WebhookEndpointCreated> {
    return this.client.request('POST', '/webhook-endpoints', { body: input });
  }
  async update(
    endpointId: string,
    input: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'status' | 'description'>>,
  ): Promise<WebhookEndpoint> {
    return this.client.request('PATCH', `/webhook-endpoints/${endpointId}`, {
      body: input,
    });
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
  async sendTest(endpointId: string): Promise<{
    queued: true;
    test: true;
    eventId: string;
    endpointId: string;
  }> {
    return this.client.request('POST', `/webhook-endpoints/${endpointId}/test`);
  }
  async replay(eventId: string): Promise<{ queued: true; eventId: string; endpoints: number }> {
    return this.client.request('POST', `/webhook-events/${eventId}/replay`);
  }
}

class PaymentAccountResource {
  constructor(private client: TixkitClient) {}
  async list(organizationId: string): Promise<PaymentAccount[]> {
    return this.client.request('GET', `/organizations/${organizationId}/payment-accounts`);
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
    return this.client.request('POST', `/events/${eventId}/questions`, {
      body: input,
    });
  }
  async update(questionId: string, input: UpdateQuestionInput): Promise<Question> {
    return this.client.request('PATCH', `/questions/${questionId}`, {
      body: input,
    });
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
    return this.client.request('GET', '/oauth-applications', {
      params: paginationParams(params),
    });
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
  async getEvent(eventId: string): Promise<PublicEvent> {
    return this.client.request('GET', `/public/events/${eventId}`);
  }
  async getEventBySlug(slug: string, params: { host: string }): Promise<PublicEvent> {
    return this.client.request('GET', `/public/events/by-slug/${slug}`, {
      params: { host: params.host },
    });
  }
  async getEventRevision(eventId: string): Promise<PublicEventRevision> {
    return this.client.request('GET', `/public/events/${eventId}/revision`);
  }
  async getEventPage(eventId: string, params?: { locale?: string }): Promise<PublicContentPage> {
    return this.client.request('GET', `/public/events/${eventId}/page`, {
      params: params?.locale ? { locale: params.locale } : undefined,
    });
  }
  async getContentPage(eventId: string, params?: { locale?: string }): Promise<PublicContentPage> {
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
  async getCheckoutBootstrap(
    eventId: string,
    params?: { products?: string | string[]; resaleListingId?: string },
  ): Promise<PublicCheckoutBootstrap> {
    const products = Array.isArray(params?.products) ? params.products.join(',') : params?.products;
    return this.client.request('GET', `/public/events/${eventId}/bootstrap`, {
      params: {
        ...(products ? { products } : {}),
        ...(params?.resaleListingId ? { resaleListingId: params.resaleListingId } : {}),
      },
    });
  }
  async getEventPageBootstrap(
    eventId: string,
    params?: { locale?: string },
  ): Promise<PublicEventPageBootstrap> {
    return this.client.request('GET', `/public/events/${eventId}/page-bootstrap`, {
      params: params?.locale ? { locale: params.locale } : undefined,
    });
  }
  async getEventPageBootstrapBySlug(
    slug: string,
    params: { host: string; locale?: string },
  ): Promise<PublicEventPageBootstrap> {
    return this.client.request('GET', `/public/events/by-slug/${slug}/page-bootstrap`, {
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
  async getAvailability(eventId: string, products?: string[]): Promise<PublicAvailabilityItem[]> {
    return this.client.request('GET', `/public/events/${eventId}/availability`, {
      params: products?.length ? { products: products.join(',') } : undefined,
    });
  }
  async listResaleListings(
    eventId: string,
    params?: PaginationParams,
  ): Promise<PageResult<PublicTicketListing>> {
    return this.client.request('GET', `/public/events/${eventId}/resale-listings`, {
      params: paginationParams(params),
    });
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
    return this.client.request('POST', `/public/events/${eventId}/waitlist`, {
      body: input,
    });
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
