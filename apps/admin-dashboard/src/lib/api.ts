/**
 * AdminApi client for the Tixkit admin dashboard.
 *
 * Calls the backend at `/v1/...`.
 *
 * Runtime fixture fallback is intentionally disabled. Local development uses
 * the real local API from `.env.local`; tests may still use the fixture helpers
 * below as test doubles.
 *
 * Function signatures match the final AdminApi contract from the
 * implementation plan. View-model types match the Tixkit Domain Contracts.
 */

import { getAdminApiBaseUrl, request, withFixture } from './api-http'
export { getAdminApiAuthHeaders, getAdminApiBaseUrl } from './api-http'
export { hasClerkKey } from '@/lib/auth'

// ---------------------------------------------------------------------------
// Result / pagination envelopes
// ---------------------------------------------------------------------------

export type AdminApiError = {
  code: string
  message: string
  status?: number
  details?: unknown
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AdminApiError }

function apiError(
  code: string,
  message: string,
  status?: number,
  details?: unknown
): AdminApiError {
  return { code, message, status, details }
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data }
}

function err<T>(error: AdminApiError): ApiResult<T> {
  return { ok: false, error }
}

async function putUploadBytes(ticket: UploadArtifactTicket, file: File): Promise<ApiResult<void>> {
  try {
    const response = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: ticket.uploadHeaders,
      body: file,
    })
    if (!response.ok) {
      return err(apiError('upload_failed', `Upload failed with status ${response.status}`, response.status))
    }
    return ok(undefined)
  } catch (error) {
    return err(apiError('upload_failed', error instanceof Error ? error.message : 'Upload failed'))
  }
}

export type PageCursor = {
  limit?: number
  cursor?: string
}

export type PageResult<T> = {
  items: T[]
  nextCursor?: string
  total?: number
}

// ---------------------------------------------------------------------------
// View-model types (Tixkit Domain Contracts)
// ---------------------------------------------------------------------------

export type EventStatus = 'draft' | 'published' | 'paused' | 'archived'
export type EventVisibility = 'public' | 'unlisted' | 'private'

export type AdminEventSeo = {
  title?: string
  description?: string
  imageUrl?: string
}

export type AdminEventVenue = {
  name?: string
  address?: string
  city?: string
  region?: string
  postalCode?: string
  country?: string
}

export type AdminEventListItem = {
  id: string
  title: string
  slug?: string
  status: EventStatus
  startsAt: string
  endsAt?: string
  timezone: string
  venueName?: string
  venue?: AdminEventVenue | null
  city?: string
  description?: string
  visibility: EventVisibility
  seo: AdminEventSeo
  currency: string
  grossSalesCents: number
  ticketsSold: number
  capacity?: number | null
  coverImageUrl?: string | null
  externalUrl?: string | null
  checkIns: number
  updatedAt: string
}

export type AdminEventDetail = AdminEventListItem & {
  tenantId?: string
  organizationId?: string
  brandId?: string
  createdAt?: string
}

export type AdminEventOccurrence = {
  id: string
  eventId: string
  title: string
  startsAt: string
  endsAt: string
  timezone: string
  venue?: AdminEventListItem['venue'] | null
  capacity?: number | null
  sortOrder: number
  status: 'scheduled' | 'cancelled' | 'completed'
  createdAt?: string
  updatedAt?: string
}

export type AdminMarketingIntegrationProvider = 'ga4' | 'meta_pixel' | 'generic_tag'

export type AdminMarketingIntegration = {
  id: string
  tenantId?: string
  organizationId?: string
  brandId?: string
  eventId?: string
  provider: AdminMarketingIntegrationProvider
  config: Record<string, unknown>
  consentRequired: boolean
  status: 'active' | 'disabled'
  createdAt?: string
  updatedAt?: string
}

export type TicketTypeStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'sold_out'
  | 'ended'

export type AdminTicketType = {
  id: string
  eventId: string
  name: string
  description?: string
  kind?: 'free' | 'paid' | 'donation'
  visibility?: 'public' | 'hidden' | 'locked'
  status: TicketTypeStatus
  priceCents: number
  minimumPriceCents?: number | null
  currency: string
  quantityTotal?: number
  quantitySold: number
  salesStartAt?: string
  salesEndAt?: string
  minPerOrder?: number
  maxPerOrder?: number
  requiresAccessCode: boolean
  accessCodeHint?: string | null
  inventoryPoolId?: string
  eventOccurrenceId?: string | null
  sortOrder?: number
}

export type AdminWaitlistEntry = {
  id: string
  eventId: string
  ticketTypeId: string
  email: string
  firstName?: string
  lastName?: string
  phone?: string
  quantity: number
  status: 'joined' | 'offered' | 'claimed' | 'cancelled' | 'expired'
  offerExpiresAt?: string
  offeredAt?: string
  claimedAt?: string
  cancelledAt?: string
  createdAt: string
  updatedAt: string
}

export type AdminWaitlistOffer = {
  entry: AdminWaitlistEntry
  claimToken: string
  claimUrl?: string
}

export type AdminWaitlistSettings = {
  autoOfferEnabled: boolean
  offerTtlMinutes: number
}

export type AdminInventoryPool = {
  id: string
  eventId: string
  name: string
  totalCapacity: number
  reservedCount: number
  soldCount: number
  holdTtlSeconds?: number
  createdAt?: string
  updatedAt?: string
}

export type AdminAccessRule = {
  id: string
  ticketTypeId: string
  type: 'code' | 'email_domain'
  value: string
  maxUses?: number
  usesCount: number
  expiresAt?: string
  createdAt?: string
  updatedAt?: string
}

export type AdminProductCategory = {
  id: string
  eventId: string
  name: string
  sortOrder: number
  createdAt?: string
  updatedAt?: string
}

export type AdminProduct = {
  id: string
  eventId: string
  name: string
  description?: string
  priceCents: number
  currency: string
  categoryId?: string
  maxPerOrder: number
  availableFrom?: string
  availableUntil?: string
  status: 'active' | 'inactive'
  sortOrder: number
  createdAt?: string
  updatedAt?: string
}

export type AdminCheckInList = {
  id: string
  eventId: string
  name: string
  ticketTypeIds: string[]
  status: 'active' | 'paused' | 'closed'
  createdAt?: string
  updatedAt?: string
}

export type AdminQuestionType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'select'
  | 'multiselect'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'waiver'

export type AdminQuestionScope = 'buyer' | 'attendee' | 'both'

export type AdminQuestionCondition = {
  field: string
  operator: 'equals' | 'not_equals' | 'contains'
  value: string
}

export type AdminCheckoutQuestion = {
  id: string
  eventId: string
  ticketTypeId?: string
  type: AdminQuestionType
  label: string
  description?: string
  required: boolean
  appliesTo: AdminQuestionScope
  options?: string[]
  placeholder?: string
  validationPattern?: string
  conditionalVisibility?: AdminQuestionCondition
  sortOrder: number
  isConsentField: boolean
  consentText?: string
  consentVersion?: string
  createdAt?: string
  updatedAt?: string
}

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'

export type AdminOrderListItem = {
  id: string
  eventId: string
  eventTitle: string
  buyerName?: string
  buyerEmail: string
  status: OrderStatus
  totalCents: number
  refundedCents: number
  currency: string
  attendeeCount: number
  paymentProvider?: 'stripe' | 'free' | 'manual'
  createdAt: string
  /** Timestamp the order transitioned to paid (if it has). */
  paidAt?: string
  /** Timestamp of the most recent refund (if any). */
  refundedAt?: string
  /** Timestamp the order was cancelled (if applicable). */
  cancelledAt?: string
}

export type AdminOrderLineItem = {
  id: string
  orderId: string
  ticketTypeId?: string
  eventOccurrenceId?: string
  attendeeId?: string
  description: string
  quantity: number
  unitPriceCents: number
  subtotalCents: number
  discountCents: number
  taxCents: number
  feeCents: number
  totalCents: number
  currency: string
  createdAt: string
  updatedAt: string
}

export type AdminTaxSnapshot = {
  id: string
  orderId: string
  orderLineItemId: string
  eventId: string
  taxRuleId?: string
  taxRuleName: string
  rate: number
  type: string
  appliedTo: string
  taxableAmountCents: number
  taxCents: number
  currency: string
  inclusive: boolean
  provider: string
  createdAt: string
}

export type AdminInvoice = {
  id: string
  orderId: string
  invoiceNumber: string
  status: string
  currency: string
  subtotalCents: number
  discountCents: number
  taxCents: number
  feeCents: number
  totalCents: number
  refundedCents: number
  buyerEmail: string
  buyerName?: string
  buyerTaxId?: string
  sellerName: string
  sellerTaxId?: string
  reverseCharge: boolean
  issuedAt: string
}

export type AdminOrderRefund = {
  id: string
  orderId: string
  amountCents: number
  currency: string
  status: string
  reason: string
  createdAt: string
  updatedAt: string
}

export type AdminOrderTimelineItem = {
  id: string
  orderId: string
  type: string
  description: string
  metadata?: Record<string, unknown>
  actorId?: string
  createdAt: string
}

export type AdminOrderAttendee = {
  id: string
  orderId: string
  eventId: string
  ticketTypeId?: string
  ticketId?: string
  firstName?: string
  lastName?: string
  name?: string
  email?: string
  ticketTypeName?: string
  status: string
  checkInStatus?: string
  customAnswers?: Record<string, unknown>
  createdAt: string
  updatedAt?: string
}

export type AdminOrderDetail = AdminOrderListItem & {
  lineItems: AdminOrderLineItem[]
  attendees: AdminOrderAttendee[]
  invoice?: AdminInvoice
  taxSnapshots?: AdminTaxSnapshot[]
  checkoutAnswers: {
    buyerFields: Record<string, unknown>
    attendeeFields: Record<string, unknown>
  }
  consentSnapshots: Record<string, unknown>
  refunds: AdminOrderRefund[]
  timeline: AdminOrderTimelineItem[]
  deliveryStatus: {
    email: string
    tickets: string
  }
}

export type AttendeeStatus = 'active' | 'cancelled' | 'refunded' | 'transferred'
export type CheckInStatus = 'not_checked_in' | 'checked_in' | 'duplicate' | 'revoked'

export type AdminAttendeeListItem = {
  id: string
  eventId: string
  eventTitle: string
  orderId: string
  ticketId: string
  ticketTypeName: string
  name: string
  email?: string
  status: AttendeeStatus
  checkInStatus: CheckInStatus
  checkedInAt?: string
  createdAt: string
}

export type CheckInScanResult =
  | {
      status: 'accepted'
      message?: string
      attendee?: AdminAttendeeListItem
      scannedAt: string
    }
  | {
      status: 'duplicate' | 'invalid' | 'revoked' | 'wrong_event'
      message: string
      attendee?: AdminAttendeeListItem
      scannedAt: string
    }

export type LiveCheckInScanResponse = {
  outcome: CheckInScanResult['status'] | 'not_found'
  ticketId?: string
  message?: string
}

export type MessageChannel = 'email' | 'sms' | 'both'
export type MessageStatus =
  | 'draft'
  | 'scheduled'
  | 'queued'
  | 'processing'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled'
  | 'suppressed'
  | 'no_recipients'

export type AdminMessageCampaign = {
  id: string
  eventId: string
  name: string
  channel: MessageChannel
  status: MessageStatus
  audience:
    | 'all_attendees'
    | 'checked_in'
    | 'not_checked_in'
    | 'ticket_type'
    | 'custom'
  audienceKey?: SendMessageInput['audience']
  audienceAttendeeIds?: string[]
  audienceLabel: string
  queuedCount: number
  sentCount: number
  deliveredCount: number
  failedCount: number
  suppressedCount: number
  scheduledAt?: string
  createdAt: string
}

export type MessageRecipientPreview = {
  audience: AdminMessageCampaign['audience']
  audienceCount: number
  eligibleCount: number
  suppressedRecipients: number
  consentExclusions: number
  skippedRecipients: number
  recipients: Array<{
    id: string
    name: string
    email?: string
    phone?: string
    status: string
  }>
}

export type AdminMessageCampaignDetail = AdminMessageCampaign & {
  updatedAt?: string
  templateKey: string
  queuedEmailJobs: number
  queuedSmsJobs: number
  suppressedRecipients: number
  consentExclusions: number
  skippedRecipients: number
  emailJobs: unknown[]
  smsJobs: unknown[]
  emailDeliveries: unknown[]
  smsDeliveries: unknown[]
}

export type AdminMessageJob = {
  channel: MessageChannel
  campaignId: string
  eventId: string
  job: Record<string, unknown>
}

export type AdminMessageDeliveryLog = {
  channel: MessageChannel
  campaignId: string
  eventId: string
  delivery: Record<string, unknown>
}

export type AdminMessageProviderEvent = {
  channel: MessageChannel
  campaignId: string
  eventId: string
  event: Record<string, unknown>
}

type BackendMessageCampaign = {
  id: string
  eventId: string
  templateKey?: string
  channel: MessageChannel
  status: MessageStatus
  audience?: AdminMessageCampaign['audience']
  audienceKey?: SendMessageInput['audience']
  audienceAttendeeIds?: string[]
  audienceLabel?: string
  audienceCount?: number
  queuedEmailJobs?: number
  queuedSmsJobs?: number
  sentCount?: number
  deliveredCount?: number
  failedCount?: number
  suppressedRecipients?: number
  consentExclusions?: number
  skippedRecipients?: number
  createdAt?: string
  updatedAt?: string
  emailJobs?: unknown[]
  smsJobs?: unknown[]
  emailDeliveries?: unknown[]
  smsDeliveries?: unknown[]
}

type BackendMessageList = {
  items: BackendMessageCampaign[]
}

function messageAudienceLabel(audience: AdminMessageCampaign['audience'], attendeeIds: string[] = []) {
  if (audience === 'checked_in') return 'Checked in'
  if (audience === 'not_checked_in') return 'Not checked in'
  if (audience === 'custom') {
    return attendeeIds.length === 1 ? 'Custom (1 attendee)' : `Custom (${attendeeIds.length} attendees)`
  }
  if (audience === 'ticket_type') return 'Ticket type'
  return 'All attendees'
}

function normalizeMessageCampaign(campaign: BackendMessageCampaign): AdminMessageCampaign {
  const queuedCount = Number(campaign.queuedEmailJobs ?? 0) + Number(campaign.queuedSmsJobs ?? 0)
  const sentCount = Number(campaign.sentCount ?? (campaign.status === 'sent' ? queuedCount : 0))
  const deliveredCount = Number(campaign.deliveredCount ?? 0)
  const failedCount = Number(campaign.failedCount ?? (campaign.status === 'failed' ? queuedCount : 0))
  const suppressedCount = Number(campaign.suppressedRecipients ?? 0)
  const audience = campaign.audience ?? 'all_attendees'
  const audienceAttendeeIds = campaign.audienceAttendeeIds ?? []
  return {
    id: campaign.id,
    eventId: campaign.eventId,
    name: campaign.templateKey ?? campaign.id,
    channel: campaign.channel,
    status: campaign.status,
    audience,
    audienceKey: campaign.audienceKey,
    audienceAttendeeIds,
    audienceLabel: campaign.audienceLabel ?? messageAudienceLabel(audience, audienceAttendeeIds),
    queuedCount,
    sentCount,
    deliveredCount,
    failedCount,
    suppressedCount,
    createdAt: campaign.createdAt ?? new Date().toISOString(),
  }
}

function normalizeMessageCampaignDetail(campaign: BackendMessageCampaign): AdminMessageCampaignDetail {
  return {
    ...normalizeMessageCampaign(campaign),
    updatedAt: campaign.updatedAt,
    templateKey: campaign.templateKey ?? campaign.id,
    queuedEmailJobs: Number(campaign.queuedEmailJobs ?? 0),
    queuedSmsJobs: Number(campaign.queuedSmsJobs ?? 0),
    suppressedRecipients: Number(campaign.suppressedRecipients ?? 0),
    consentExclusions: Number(campaign.consentExclusions ?? 0),
    skippedRecipients: Number(campaign.skippedRecipients ?? 0),
    emailJobs: campaign.emailJobs ?? [],
    smsJobs: campaign.smsJobs ?? [],
    emailDeliveries: campaign.emailDeliveries ?? [],
    smsDeliveries: campaign.smsDeliveries ?? [],
  }
}

export type AdminSalesReportSummary = {
  eventId: string
  currency: string
  grossSalesCents: number
  netRevenueCents: number
  feesCents: number
  taxCents: number
  refundsCents: number
  ordersCount: number
  paidOrdersCount: number
  ticketsSold: number
  checkIns: number
  conversionRate?: number
  range: {
    from: string
    to: string
  }
}

export type AdminTaxReport = {
  eventId: string
  currency: string
  totalTaxCollectedCents: number
  breakdown: Array<{
    taxRuleName: string
    rate: number | null
    taxableAmountCents: number
    taxCollectedCents: number
  }>
}

export type AdminAttendanceReport = {
  eventId: string
  totalAttendees: number
  checkedIn: number
  notCheckedIn: number
  checkInRate: number
  breakdownByTicketType: Array<{
    ticketTypeId: string
    ticketTypeName: string
    total: number
    checkedIn: number
  }>
}

export type AdminPromoReport = {
  eventId: string
  discountCodes: Array<{
    code: string
    usesCount: number
    discountAmountCents: number
    revenueAttributedCents: number
  }>
}

export type AdminConversionReport = {
  eventId: string
  widgetViews: number
  checkoutStarted: number
  checkoutCompleted: number
  conversionRate: number
}

export type AdminAffiliateReport = {
  organizationId: string
  affiliates: Array<{
    affiliateId: string
    code: string
    name: string
    referralsCount: number
    revenueAttributedCents: number
    commissionCents: number
  }>
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired'

export type AdminApiKey = {
  id: string
  name: string
  keyPrefix: string
  lastUsedAt?: string
  createdAt: string
  expiresAt?: string
  revokedAt?: string
  /**
   * The full secret key. Only returned once on creation by the backend
   * (`POST /v1/api-keys`). Never persisted or re-exposed by the API.
   * Displayed in the one-time-secret reveal dialog.
   */
  apiKey?: string
  /** Scopes assigned to the key (returned by the API when available). */
  scopes?: string[]
}

export type WebhookEndpointStatus = 'active' | 'paused' | 'disabled'

export type AdminWebhookEndpoint = {
  id: string
  url: string
  description?: string
  events: string[]
  status: WebhookEndpointStatus
  failureCount: number
  lastDeliveryAt?: string
  createdAt: string
}

export type WebhookDeliveryStatus =
  | 'succeeded'
  | 'failed'
  | 'pending'
  | 'retrying'

export type AdminWebhookEvent = {
  id: string
  endpointId: string
  eventType: string
  status: WebhookDeliveryStatus
  statusCode?: number
  attemptCount: number
  deliveredAt?: string
  createdAt: string
}

/**
 * Tixkit principal resolved after Clerk authentication.
 * Returned by `GET /v1/me`. Permissions drive route/nav gating.
 */
export type TixkitPrincipal = {
  permissions: string[]
  tenantId: string
  organizationIds: string[]
}

export type AdminOrganization = {
  id: string
  tenantId: string
  name: string
  slug: string
  status: 'active' | 'suspended'
  clerkOrganizationId?: string
  createdAt?: string
  updatedAt?: string
}

export type AdminBrandDomain = {
  id: string
  brandId: string
  domain: string
  isPrimary: boolean
  isVerified: boolean
  sslStatus: 'pending' | 'active' | 'failed'
  createdAt?: string
  updatedAt?: string
}

export type AdminBrand = {
  id: string
  tenantId: string
  organizationId: string
  name: string
  slug: string
  status: 'draft' | 'active' | 'suspended'
  theme: {
    primaryColor?: string
    logoUrl?: string
    [key: string]: unknown
  }
  domains: AdminBrandDomain[]
  whiteLabel: boolean
  paymentAccountId?: string | null
  createdAt?: string
  updatedAt?: string
}

export type TeamMemberRole = 'owner' | 'admin' | 'organizer' | 'viewer'
export type TeamMemberStatus = 'active' | 'invited' | 'disabled'

export type AdminTeamMember = {
  id: string
  organizationId: string
  name: string
  email: string
  role: TeamMemberRole
  status: TeamMemberStatus
  invitedAt?: string
  joinedAt?: string
}

export type PaymentAccountStatus = 'pending' | 'active' | 'restricted'

export type AdminPaymentAccount = {
  id: string
  organizationId: string
  provider: 'stripe' | 'stripe_connect' | 'mock'
  providerAccountId: string
  status: PaymentAccountStatus
  defaultCurrency: string
  onboardingUrl?: string
  createdAt?: string
  updatedAt?: string
}

export type AdminBillingOverview = {
  organizationId: string
  plan?: string
  status?: string
  ticketsThisMonth?: number
  ticketLimit?: number
  nextBillingDate?: string
  paymentMethodLabel?: string
}

export type AdminExportType = 'attendees' | 'orders' | 'scan_logs' | 'sales' | 'tax' | 'tickets'
export type AdminExportFormat = 'csv' | 'xlsx' | 'json'

export type AdminExportJob = {
  exportId: string
  eventId?: string
  type?: AdminExportType
  format?: AdminExportFormat
  status: 'pending' | 'processing' | 'completed' | 'failed'
  fileUrl?: string
  downloadUrl?: string
  createdAt?: string
  completedAt?: string
}

// ---------------------------------------------------------------------------
// Form input types
// ---------------------------------------------------------------------------

export type CreateEventInput = {
  organizationId?: string
  brandId?: string
  title: string
  slug?: string
  description?: string
  startsAt: string
  endsAt?: string | null
  timezone: string
  venue?: AdminEventVenue | null
  venueName?: string
  address?: string
  visibility?: EventVisibility
  seo?: AdminEventSeo
  capacity?: number | null
  coverImageUrl?: string | null
  externalUrl?: string | null
  currency: string
}

export type UpdateEventInput = Partial<CreateEventInput> & {
  status?: EventStatus
}

export type CreateTicketTypeInput = {
  name: string
  description?: string
  kind: 'free' | 'paid' | 'donation'
  visibility?: 'public' | 'hidden' | 'locked'
  inventoryPoolId?: string
  priceCents: number
  minimumPriceCents?: number | null
  currency: string
  quantityTotal?: number
  salesStartAt?: string
  salesEndAt?: string
  minPerOrder?: number
  maxPerOrder?: number
  requiresAccessCode?: boolean
  accessCodeHint?: string | null
  eventOccurrenceId?: string | null
}

export type CreateEventOccurrenceInput = {
  title: string
  startsAt: string
  endsAt: string
  timezone: string
  venue?: AdminEventListItem['venue'] | null
  capacity?: number | null
  sortOrder?: number
  status?: AdminEventOccurrence['status']
}

export type UpdateEventOccurrenceInput = Partial<CreateEventOccurrenceInput>

export type UpsertMarketingIntegrationInput = {
  provider: AdminMarketingIntegrationProvider
  config: Record<string, unknown>
  consentRequired?: boolean
  status?: AdminMarketingIntegration['status']
}

export type CreateInventoryPoolInput = {
  name: string
  totalCapacity: number
  holdTtlSeconds?: number
}

export type UpdateTicketTypeInput = Partial<CreateTicketTypeInput> & {
  status?: TicketTypeStatus
}

export type CreateAccessRuleInput = {
  type: AdminAccessRule['type']
  value: string
  maxUses?: number | null
  expiresAt?: string | null
}

export type SaveTicketTypeResult = {
  ticketType: AdminTicketType
  accessRules: AdminAccessRule[]
}

export type CreateTicketTypeBatchInput = {
  ticketType: CreateTicketTypeInput
  inventoryPool?: CreateInventoryPoolInput
  accessRules?: CreateAccessRuleInput[]
}

export type UpdateTicketTypeBatchInput = {
  ticketType: UpdateTicketTypeInput
  accessRules?: CreateAccessRuleInput[]
}

export type CreateProductCategoryInput = {
  name: string
  sortOrder?: number
}

export type CreateProductInput = {
  name: string
  description?: string
  priceCents: number
  currency: string
  categoryId?: string
  maxPerOrder?: number
  availableFrom?: string
  availableUntil?: string
  status?: AdminProduct['status']
  sortOrder?: number
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'description' | 'categoryId' | 'availableFrom' | 'availableUntil'>> & {
  description?: string | null
  categoryId?: string | null
  availableFrom?: string | null
  availableUntil?: string | null
}

export type CreateCheckoutQuestionInput = {
  ticketTypeId?: string
  type: AdminQuestionType
  label: string
  description?: string
  required?: boolean
  appliesTo?: AdminQuestionScope
  options?: string[]
  placeholder?: string
  validationPattern?: string
  conditionalVisibility?: AdminQuestionCondition
  sortOrder?: number
  isConsentField?: boolean
  consentText?: string
  consentVersion?: string
}

export type UpdateCheckoutQuestionInput = Partial<CreateCheckoutQuestionInput>

export type RefundOrderInput = {
  amountCents?: number
  reason?: string
  voidTickets?: boolean
  restoreInventory?: boolean
}

export type RefundOrderResult = {
  orderId: string
  refundAmount: number
  status: 'pending'
  message: string
}

export type UpdateAttendeeInput = {
  name?: string
  email?: string
  status?: AttendeeStatus
}

export type ScanTicketInput = {
  eventId: string
  checkInListId?: string
  qrPayload: string
  scannedAt?: string
  deviceId?: string
}

export type SendMessageInput = {
  channel: 'email' | 'sms' | 'both'
  templateKey: string
  audience: 'all' | 'checked_in' | 'not_checked_in' | 'specific'
  attendeeIds?: string[]
  variables?: Record<string, unknown>
}

export type CreateApiKeyInput = {
  organizationId?: string
  name: string
  scopes?: string[]
}

export type CreateWebhookEndpointInput = {
  organizationId?: string
  url: string
  description?: string
  events: string[]
}

export type UpdateWebhookEndpointInput = Partial<CreateWebhookEndpointInput> & {
  status?: WebhookEndpointStatus
}

export type UpdateOrganizationInput = {
  name?: string
  slug?: string
  defaultCurrency?: string
  description?: string
}

export type UpdateBrandInput = {
  name?: string
  slug?: string
  theme?: AdminBrand['theme']
  whiteLabel?: boolean
  paymentAccountId?: string | null
}

export type AdminUploadPurpose = 'checkout_answer' | 'brand_logo' | 'user_avatar'

export type CreateUploadArtifactInput = {
  purpose: AdminUploadPurpose
  fileName: string
  contentType: string
  sizeBytes: number
  brandId?: string
  eventId?: string
  metadata?: Record<string, unknown>
}

export type UploadArtifactTicket = {
  artifactId: string
  uploadUrl: string
  uploadHeaders: Record<string, string>
  completeUrl: string
  completeToken?: string
  expiresAt: string
}

export type CompletedUploadArtifact = {
  artifactId: string
  status: string
  scanStatus: string
  downloadUrl?: string
}

export type InviteTeamMemberInput = {
  email: string
  role: TeamMemberRole
}

// ---------------------------------------------------------------------------
// AdminApi type
// ---------------------------------------------------------------------------

export type ReportDateRange = {
  from?: string
  to?: string
}

export type AdminApi = {
  /** Resolves the authenticated Tixkit principal + permissions (`GET /v1/me`). */
  getPrincipal(token?: string): Promise<ApiResult<TixkitPrincipal>>

  listOrganizations(): Promise<ApiResult<AdminOrganization[]>>
  updateOrganization(organizationId: string, input: UpdateOrganizationInput): Promise<ApiResult<AdminOrganization>>
  listBrands(): Promise<ApiResult<AdminBrand[]>>
  updateBrand(brandId: string, input: UpdateBrandInput): Promise<ApiResult<AdminBrand>>
  addBrandDomain(brandId: string, domain: string, isPrimary?: boolean): Promise<ApiResult<AdminBrandDomain>>
  listTeamMembers(organizationId: string): Promise<ApiResult<AdminTeamMember[]>>
  inviteTeamMember(organizationId: string, input: InviteTeamMemberInput): Promise<ApiResult<AdminTeamMember>>
  listPaymentAccounts(organizationId: string): Promise<ApiResult<AdminPaymentAccount[]>>
  createStripeConnectAccount(organizationId: string): Promise<ApiResult<AdminPaymentAccount>>
  refreshStripeConnectAccount(organizationId: string, paymentAccountId: string): Promise<ApiResult<AdminPaymentAccount>>
  getBillingOverview(organizationId: string): Promise<ApiResult<AdminBillingOverview>>
  uploadArtifact(input: {
    purpose: AdminUploadPurpose
    file: File
    brandId?: string
    eventId?: string
    metadata?: Record<string, unknown>
  }): Promise<ApiResult<CompletedUploadArtifact>>

  listEvents(input?: PageCursor): Promise<ApiResult<PageResult<AdminEventListItem>>>
  getEvent(eventId: string): Promise<ApiResult<AdminEventDetail>>
  createEvent(input: CreateEventInput): Promise<ApiResult<AdminEventDetail>>
  updateEvent(eventId: string, input: UpdateEventInput): Promise<ApiResult<AdminEventDetail>>
  publishEvent(eventId: string): Promise<ApiResult<AdminEventDetail>>
  pauseEvent(eventId: string): Promise<ApiResult<AdminEventDetail>>
  archiveEvent(eventId: string): Promise<ApiResult<AdminEventDetail>>
  listEventOccurrences(eventId: string): Promise<ApiResult<AdminEventOccurrence[]>>
  createEventOccurrence(eventId: string, input: CreateEventOccurrenceInput): Promise<ApiResult<AdminEventOccurrence>>
  updateEventOccurrence(eventId: string, occurrenceId: string, input: UpdateEventOccurrenceInput): Promise<ApiResult<AdminEventOccurrence>>
  listMarketingIntegrations(eventId: string): Promise<ApiResult<AdminMarketingIntegration[]>>
  upsertMarketingIntegration(eventId: string, input: UpsertMarketingIntegrationInput): Promise<ApiResult<AdminMarketingIntegration>>

  listTicketTypes(eventId: string): Promise<ApiResult<AdminTicketType[]>>
  createTicketType(eventId: string, input: CreateTicketTypeInput): Promise<ApiResult<AdminTicketType>>
  updateTicketType(ticketTypeId: string, input: UpdateTicketTypeInput): Promise<ApiResult<AdminTicketType>>
  createTicketTypeBatch(eventId: string, input: CreateTicketTypeBatchInput): Promise<ApiResult<SaveTicketTypeResult>>
  updateTicketTypeBatch(ticketTypeId: string, input: UpdateTicketTypeBatchInput): Promise<ApiResult<SaveTicketTypeResult>>
  listWaitlist(eventId: string): Promise<ApiResult<{ items: AdminWaitlistEntry[]; settings: AdminWaitlistSettings }>>
  offerWaitlistEntry(eventId: string, entryId: string, input?: { expiresInMinutes?: number }): Promise<ApiResult<AdminWaitlistOffer>>
  updateWaitlistSettings(eventId: string, input: AdminWaitlistSettings): Promise<ApiResult<AdminWaitlistSettings>>
  listAccessRules(ticketTypeId: string): Promise<ApiResult<AdminAccessRule[]>>
  createAccessRule(ticketTypeId: string, input: CreateAccessRuleInput): Promise<ApiResult<AdminAccessRule>>
  deleteAccessRule(accessRuleId: string): Promise<ApiResult<void>>
  listInventoryPools(eventId: string): Promise<ApiResult<AdminInventoryPool[]>>
  createInventoryPool(eventId: string, input: CreateInventoryPoolInput): Promise<ApiResult<AdminInventoryPool>>
  listProductCategories(eventId: string): Promise<ApiResult<AdminProductCategory[]>>
  createProductCategory(eventId: string, input: CreateProductCategoryInput): Promise<ApiResult<AdminProductCategory>>
  listProducts(eventId: string): Promise<ApiResult<AdminProduct[]>>
  createProduct(eventId: string, input: CreateProductInput): Promise<ApiResult<AdminProduct>>
  updateProduct(productId: string, input: UpdateProductInput): Promise<ApiResult<AdminProduct>>
  listCheckoutQuestions(eventId: string): Promise<ApiResult<AdminCheckoutQuestion[]>>
  createCheckoutQuestion(eventId: string, input: CreateCheckoutQuestionInput): Promise<ApiResult<AdminCheckoutQuestion>>
  updateCheckoutQuestion(questionId: string, input: UpdateCheckoutQuestionInput): Promise<ApiResult<AdminCheckoutQuestion>>
  reorderCheckoutQuestions(eventId: string, questions: Array<{ id: string; sortOrder: number }>): Promise<ApiResult<AdminCheckoutQuestion[]>>
  deleteCheckoutQuestion(questionId: string): Promise<ApiResult<void>>

  listOrders(input?: PageCursor & { eventId?: string }): Promise<ApiResult<PageResult<AdminOrderListItem>>>
  getOrder(orderId: string): Promise<ApiResult<AdminOrderDetail>>
  cancelOrder(orderId: string): Promise<ApiResult<AdminOrderListItem>>
  refundOrder(orderId: string, input: RefundOrderInput): Promise<ApiResult<RefundOrderResult>>

  listAttendees(input: PageCursor & { eventId?: string }): Promise<ApiResult<PageResult<AdminAttendeeListItem>>>
  updateAttendee(attendeeId: string, input: UpdateAttendeeInput): Promise<ApiResult<AdminAttendeeListItem>>
  listCheckInLists(eventId: string): Promise<ApiResult<AdminCheckInList[]>>
  scanTicket(input: ScanTicketInput): Promise<ApiResult<CheckInScanResult>>

  previewMessageRecipients(
    eventId: string,
    input: Pick<SendMessageInput, 'audience' | 'attendeeIds' | 'channel' | 'templateKey'>
  ): Promise<ApiResult<MessageRecipientPreview>>
  sendMessage(eventId: string, input: SendMessageInput): Promise<ApiResult<AdminMessageCampaign>>
  listMessages(eventId: string): Promise<ApiResult<AdminMessageCampaign[]>>
  getMessage(eventId: string, campaignId: string): Promise<ApiResult<AdminMessageCampaignDetail>>
  listMessageJobs(eventId: string, campaignId: string): Promise<ApiResult<AdminMessageJob[]>>
  getMessageJob(eventId: string, campaignId: string, channel: MessageChannel, jobId: string): Promise<ApiResult<AdminMessageJob>>
  listMessageDeliveryLogs(eventId: string, campaignId: string): Promise<ApiResult<AdminMessageDeliveryLog[]>>
  getMessageDeliveryLog(eventId: string, campaignId: string, channel: MessageChannel, deliveryId: string): Promise<ApiResult<AdminMessageDeliveryLog>>
  listMessageProviderEvents(eventId: string, campaignId: string): Promise<ApiResult<AdminMessageProviderEvent[]>>
  getMessageProviderEvent(eventId: string, campaignId: string, providerEventId: string): Promise<ApiResult<AdminMessageProviderEvent>>
  getSalesReport(eventId: string, range?: ReportDateRange): Promise<ApiResult<AdminSalesReportSummary>>
  getTaxReport(eventId: string, range?: ReportDateRange): Promise<ApiResult<AdminTaxReport>>
  getAttendanceReport(eventId: string): Promise<ApiResult<AdminAttendanceReport>>
  getPromoReport(eventId: string): Promise<ApiResult<AdminPromoReport>>
  getConversionReport(eventId: string): Promise<ApiResult<AdminConversionReport>>
  getAffiliateReport(organizationId: string): Promise<ApiResult<AdminAffiliateReport>>
  createExport(input: {
    eventId?: string
    type: AdminExportType
    format: AdminExportFormat
    filters?: Record<string, unknown>
  }): Promise<ApiResult<AdminExportJob>>
  getExport(exportId: string): Promise<ApiResult<AdminExportJob>>

  listApiKeys(): Promise<ApiResult<AdminApiKey[]>>
  createApiKey(input: CreateApiKeyInput): Promise<ApiResult<AdminApiKey>>
  revokeApiKey(apiKeyId: string): Promise<ApiResult<AdminApiKey>>

  listWebhookEndpoints(): Promise<ApiResult<AdminWebhookEndpoint[]>>
  createWebhookEndpoint(input: CreateWebhookEndpointInput): Promise<ApiResult<AdminWebhookEndpoint>>
  updateWebhookEndpoint(webhookId: string, input: UpdateWebhookEndpointInput): Promise<ApiResult<AdminWebhookEndpoint>>
  /** Lists recent webhook delivery events for an endpoint. */
  listWebhookEvents(endpointId: string): Promise<ApiResult<AdminWebhookEvent[]>>
  replayWebhookEvent(eventId: string): Promise<ApiResult<{ queued: true }>>
}

function unwrapPage<T>(value: PageResult<T> | T[]): PageResult<T> {
  return Array.isArray(value) ? { items: value, total: value.length } : value
}

function unwrapItems<T>(value: PageResult<T> | T[]): T[] {
  return Array.isArray(value) ? value : value.items
}

export function normalizeLiveCheckInScanResult(
  value: LiveCheckInScanResponse,
  scannedAt?: string
): CheckInScanResult {
  const status = value.outcome === 'not_found' ? 'invalid' : value.outcome
  const timestamp = scannedAt ?? new Date().toISOString()
  if (status === 'accepted') {
    return {
      status,
      message: value.message ?? 'Check-in successful',
      scannedAt: timestamp,
    }
  }

  return {
    status,
    message: value.message ?? `Check-in ${status.replace('_', ' ')}`,
    scannedAt: timestamp,
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string
function stringValue(value: unknown, fallback: string): string
function stringValue(value: unknown, fallback: undefined): string | undefined
function stringValue(value: unknown, fallback = ''): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object') return asRecord(value)
  if (typeof value !== 'string') return {}
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return {}
  }
}

function newIdempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function normalizeOrganization(value: Record<string, unknown>): AdminOrganization {
  return {
    id: String(value.id),
    tenantId: String(value.tenantId ?? value.tenant_id ?? ''),
    name: stringValue(value.name, 'Untitled organization'),
    slug: stringValue(value.slug, ''),
    status: value.status === 'suspended' ? 'suspended' : 'active',
    clerkOrganizationId: stringValue(value.clerkOrganizationId ?? value.clerk_organization_id, undefined),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeBrandDomain(value: Record<string, unknown>): AdminBrandDomain {
  const sslStatus = value.sslStatus ?? value.ssl_status
  return {
    id: String(value.id),
    brandId: String(value.brandId ?? value.brand_id ?? ''),
    domain: stringValue(value.domain, ''),
    isPrimary: Boolean(value.isPrimary ?? value.is_primary),
    isVerified: Boolean(value.isVerified ?? value.is_verified),
    sslStatus: sslStatus === 'active' || sslStatus === 'failed' ? sslStatus : 'pending',
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeBrand(value: Record<string, unknown>): AdminBrand {
  const status = value.status === 'active' || value.status === 'suspended' ? value.status : 'draft'
  const domains = Array.isArray(value.domains)
    ? value.domains.map((domain) => normalizeBrandDomain(asRecord(domain)))
    : []
  return {
    id: String(value.id),
    tenantId: String(value.tenantId ?? value.tenant_id ?? ''),
    organizationId: String(value.organizationId ?? value.organization_id ?? ''),
    name: stringValue(value.name, 'Untitled brand'),
    slug: stringValue(value.slug, ''),
    status,
    theme: parseJsonRecord(value.theme),
    domains,
    whiteLabel: Boolean(value.whiteLabel ?? value.white_label),
    paymentAccountId: stringValue(value.paymentAccountId ?? value.payment_account_id, undefined) ?? null,
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeTeamMember(value: Record<string, unknown>, organizationId: string): AdminTeamMember {
  const role = value.role === 'owner' || value.role === 'admin' || value.role === 'organizer'
    ? value.role
    : 'viewer'
  const status = value.status === 'active' || value.status === 'disabled' ? value.status : 'invited'
  const email = stringValue(value.email, '')
  return {
    id: String(value.id),
    organizationId: String(value.organizationId ?? value.organization_id ?? organizationId),
    name: stringValue(value.name, email.split('@')[0] || 'Member'),
    email,
    role,
    status,
    invitedAt: stringValue(value.invitedAt ?? value.invited_at, undefined),
    joinedAt: stringValue(value.joinedAt ?? value.joined_at, undefined),
  }
}

function normalizePaymentAccount(value: Record<string, unknown>, organizationId: string): AdminPaymentAccount {
  const provider = value.provider === 'stripe' || value.provider === 'mock' ? value.provider : 'stripe_connect'
  const status = value.status === 'active' || value.status === 'restricted' ? value.status : 'pending'
  return {
    id: String(value.id),
    organizationId: String(value.organizationId ?? value.organization_id ?? organizationId),
    provider,
    providerAccountId: String(value.providerAccountId ?? value.provider_account_id ?? ''),
    status,
    defaultCurrency: stringValue(value.defaultCurrency ?? value.default_currency, 'USD'),
    onboardingUrl: stringValue(value.onboardingUrl ?? value.onboarding_url, undefined),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeBillingOverview(value: Record<string, unknown>, organizationId: string): AdminBillingOverview {
  return {
    organizationId: String(value.organizationId ?? value.organization_id ?? organizationId),
    plan: stringValue(value.plan, undefined),
    status: stringValue(value.status, undefined),
    ticketsThisMonth: typeof value.ticketsThisMonth === 'number' ? value.ticketsThisMonth : undefined,
    ticketLimit: typeof value.ticketLimit === 'number' ? value.ticketLimit : undefined,
    nextBillingDate: stringValue(value.nextBillingDate ?? value.next_billing_date, undefined),
    paymentMethodLabel: stringValue(value.paymentMethodLabel ?? value.payment_method_label, undefined),
  }
}

function normalizeEvent(value: Partial<AdminEventDetail> & Record<string, unknown>): AdminEventDetail {
  const venue = asRecord(value.venue)
  const seo = asRecord(value.seo)
  const visibility =
    value.visibility === 'unlisted' || value.visibility === 'private'
      ? value.visibility
      : 'public'
  return {
    id: String(value.id),
    tenantId: stringValue(value.tenantId ?? value.tenant_id, undefined),
    organizationId: stringValue(value.organizationId ?? value.organization_id, undefined),
    brandId: stringValue(value.brandId ?? value.brand_id, undefined),
    title: String(value.title ?? 'Untitled event'),
    slug: typeof value.slug === 'string' ? value.slug : undefined,
    status: (value.status as EventStatus | undefined) ?? 'draft',
    startsAt: String(value.startsAt ?? value.createdAt ?? new Date(0).toISOString()),
    endsAt: typeof value.endsAt === 'string' ? value.endsAt : undefined,
    timezone: String(value.timezone ?? 'UTC'),
    description: stringValue(value.description, undefined),
    venue:
      venue && Object.keys(venue).length > 0
        ? {
            name: stringValue(venue.name, undefined),
            address: stringValue(venue.address, undefined),
            city: stringValue(venue.city, undefined),
            region: stringValue(venue.region, undefined),
            postalCode: stringValue(venue.postalCode ?? venue.postal_code, undefined),
            country: stringValue(venue.country, undefined),
          }
        : null,
    venueName:
      typeof value.venueName === 'string'
        ? value.venueName
        : typeof venue?.name === 'string'
          ? venue.name
          : undefined,
    city:
      typeof value.city === 'string'
        ? value.city
        : typeof venue?.city === 'string'
          ? venue.city
          : undefined,
    visibility,
    seo: {
      title: stringValue(seo?.title, undefined),
      description: stringValue(seo?.description, undefined),
      imageUrl: stringValue(seo?.imageUrl ?? seo?.image_url, undefined),
    },
    currency: typeof value.currency === 'string' ? value.currency : 'USD',
    grossSalesCents: finiteNumber(value.grossSalesCents),
    ticketsSold: finiteNumber(value.ticketsSold),
    capacity: value.capacity == null ? undefined : finiteNumber(value.capacity),
    coverImageUrl: stringValue(value.coverImageUrl ?? value.cover_image_url, undefined),
    externalUrl: stringValue(value.externalUrl ?? value.external_url, undefined),
    checkIns: finiteNumber(value.checkIns),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: String(value.updatedAt ?? value.createdAt ?? new Date(0).toISOString()),
  }
}

function normalizeEventPage(
  value: PageResult<AdminEventListItem> | AdminEventListItem[]
): PageResult<AdminEventListItem> {
  const page = unwrapPage(value)
  return {
    ...page,
    items: page.items.map((item) => normalizeEvent(item)),
  }
}

function normalizeQuestion(value: Partial<AdminCheckoutQuestion> & Record<string, unknown>): AdminCheckoutQuestion {
  const type = [
    'text',
    'textarea',
    'email',
    'phone',
    'select',
    'multiselect',
    'checkbox',
    'date',
    'file',
    'waiver',
  ].includes(String(value.type))
    ? (value.type as AdminQuestionType)
    : 'text'
  const appliesTo =
    value.appliesTo === 'buyer' || value.appliesTo === 'both'
      ? value.appliesTo
      : 'attendee'
  const condition = asRecord(value.conditionalVisibility ?? value.conditional_visibility)
  const hasCondition =
    typeof condition.field === 'string' &&
    typeof condition.operator === 'string' &&
    typeof condition.value === 'string'

  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    ticketTypeId: stringValue(value.ticketTypeId ?? value.ticket_type_id, undefined),
    type,
    label: stringValue(value.label, 'Untitled field'),
    description: stringValue(value.description, undefined),
    required: Boolean(value.required),
    appliesTo,
    options: Array.isArray(value.options)
      ? value.options.map((option) => String(option)).filter(Boolean)
      : undefined,
    placeholder: stringValue(value.placeholder, undefined),
    validationPattern: stringValue(value.validationPattern ?? value.validation_pattern, undefined),
    conditionalVisibility: hasCondition
      ? {
          field: String(condition.field),
          operator:
            condition.operator === 'not_equals' || condition.operator === 'contains'
              ? condition.operator
              : 'equals',
          value: String(condition.value),
        }
      : undefined,
    sortOrder: finiteNumber(value.sortOrder ?? value.sort_order),
    isConsentField: Boolean(value.isConsentField ?? value.is_consent_field),
    consentText: stringValue(value.consentText ?? value.consent_text, undefined),
    consentVersion: stringValue(value.consentVersion ?? value.consent_version, undefined),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeTicketType(value: Partial<AdminTicketType> & Record<string, unknown>): AdminTicketType {
  const minimumPrice = value.minimumPriceCents ?? value.minimum_price_cents
  const quantityTotal = value.quantityTotal ?? value.quantity_total
  const minPerOrder = value.minPerOrder ?? value.min_per_order
  const maxPerOrder = value.maxPerOrder ?? value.max_per_order
  const sortOrder = value.sortOrder ?? value.sort_order
  const kind = value.kind === 'donation' || value.kind === 'free' || value.kind === 'paid'
    ? value.kind
    : finiteNumber(value.priceCents ?? value.price_cents) > 0
      ? 'paid'
      : 'free'
  const visibility =
    value.visibility === 'hidden' || value.visibility === 'locked'
      ? value.visibility
      : 'public'
  const statusValues: TicketTypeStatus[] = ['draft', 'active', 'paused', 'sold_out', 'ended']
  const status = statusValues.includes(value.status as TicketTypeStatus)
    ? (value.status as TicketTypeStatus)
    : 'active'
  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    name: stringValue(value.name, 'Untitled ticket'),
    description: stringValue(value.description, undefined),
    kind,
    visibility,
    status,
    priceCents: finiteNumber(value.priceCents ?? value.price_cents),
    minimumPriceCents: minimumPrice == null ? null : finiteNumber(minimumPrice),
    currency: stringValue(value.currency, 'USD'),
    quantityTotal: quantityTotal == null ? undefined : finiteNumber(quantityTotal),
    quantitySold: finiteNumber(value.quantitySold ?? value.quantity_sold),
    salesStartAt: stringValue(value.salesStartAt ?? value.sales_start_at, undefined),
    salesEndAt: stringValue(value.salesEndAt ?? value.sales_end_at, undefined),
    minPerOrder: minPerOrder == null ? 1 : finiteNumber(minPerOrder),
    maxPerOrder: maxPerOrder == null ? 10 : finiteNumber(maxPerOrder),
    requiresAccessCode: Boolean(value.requiresAccessCode ?? value.requires_access_code),
    accessCodeHint: stringValue(value.accessCodeHint ?? value.access_code_hint, undefined),
    inventoryPoolId: stringValue(value.inventoryPoolId ?? value.inventory_pool_id, undefined),
    eventOccurrenceId: stringValue(value.eventOccurrenceId ?? value.event_occurrence_id, undefined),
    sortOrder: sortOrder == null ? undefined : finiteNumber(sortOrder),
  }
}

function normalizeEventOccurrence(value: Partial<AdminEventOccurrence> & Record<string, unknown>): AdminEventOccurrence {
  const statusValues: AdminEventOccurrence['status'][] = ['scheduled', 'cancelled', 'completed']
  const status = statusValues.includes(value.status as AdminEventOccurrence['status'])
    ? (value.status as AdminEventOccurrence['status'])
    : 'scheduled'
  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    title: stringValue(value.title, 'Occurrence'),
    startsAt: stringValue(value.startsAt ?? value.starts_at, ''),
    endsAt: stringValue(value.endsAt ?? value.ends_at, ''),
    timezone: stringValue(value.timezone, 'UTC'),
    venue: (value.venue as AdminEventListItem['venue'] | null | undefined) ?? null,
    capacity: value.capacity == null ? null : finiteNumber(value.capacity),
    sortOrder: finiteNumber(value.sortOrder ?? value.sort_order),
    status,
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeMarketingIntegration(value: Partial<AdminMarketingIntegration> & Record<string, unknown>): AdminMarketingIntegration {
  const providers: AdminMarketingIntegrationProvider[] = ['ga4', 'meta_pixel', 'generic_tag']
  const provider = providers.includes(value.provider as AdminMarketingIntegrationProvider)
    ? (value.provider as AdminMarketingIntegrationProvider)
    : 'generic_tag'
  const status = value.status === 'disabled' ? 'disabled' : 'active'
  const rawConfig = value.config
  return {
    id: String(value.id ?? `${provider}:${value.eventId ?? value.event_id ?? ''}`),
    tenantId: stringValue(value.tenantId ?? value.tenant_id, undefined),
    organizationId: stringValue(value.organizationId ?? value.organization_id, undefined),
    brandId: stringValue(value.brandId ?? value.brand_id, undefined),
    eventId: stringValue(value.eventId ?? value.event_id, undefined),
    provider,
    config: rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {},
    consentRequired: Boolean(value.consentRequired ?? value.consent_required ?? true),
    status,
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeWaitlistEntry(value: Partial<AdminWaitlistEntry> & Record<string, unknown>): AdminWaitlistEntry {
  const statusValues: AdminWaitlistEntry['status'][] = ['joined', 'offered', 'claimed', 'cancelled', 'expired']
  const status = statusValues.includes(value.status as AdminWaitlistEntry['status'])
    ? (value.status as AdminWaitlistEntry['status'])
    : 'joined'
  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    ticketTypeId: String(value.ticketTypeId ?? value.ticket_type_id ?? ''),
    email: stringValue(value.email ?? value.buyerEmail ?? value.buyer_email, ''),
    firstName: stringValue(value.firstName ?? value.buyerFirstName ?? value.buyer_first_name, undefined),
    lastName: stringValue(value.lastName ?? value.buyerLastName ?? value.buyer_last_name, undefined),
    phone: stringValue(value.phone ?? value.buyerPhone ?? value.buyer_phone, undefined),
    quantity: finiteNumber(value.quantity, 1),
    status,
    offerExpiresAt: stringValue(value.offerExpiresAt ?? value.offer_expires_at, undefined),
    offeredAt: stringValue(value.offeredAt ?? value.offered_at, undefined),
    claimedAt: stringValue(value.claimedAt ?? value.claimed_at, undefined),
    cancelledAt: stringValue(value.cancelledAt ?? value.cancelled_at, undefined),
    createdAt: stringValue(value.createdAt ?? value.created_at, new Date(0).toISOString()),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, new Date(0).toISOString()),
  }
}

function normalizeWaitlistSettings(value: Partial<AdminWaitlistSettings> & Record<string, unknown>): AdminWaitlistSettings {
  return {
    autoOfferEnabled: Boolean(value.autoOfferEnabled ?? value.auto_offer_enabled ?? true),
    offerTtlMinutes: finiteNumber(value.offerTtlMinutes ?? value.offer_ttl_minutes, 1440),
  }
}

function normalizeAccessRule(value: Partial<AdminAccessRule> & Record<string, unknown>): AdminAccessRule {
  const maxUses = value.maxUses ?? value.max_uses
  return {
    id: String(value.id),
    ticketTypeId: String(value.ticketTypeId ?? value.ticket_type_id ?? ''),
    type: value.type === 'email_domain' ? 'email_domain' : 'code',
    value: stringValue(value.value, ''),
    maxUses: maxUses == null ? undefined : finiteNumber(maxUses),
    usesCount: finiteNumber(value.usesCount ?? value.uses_count),
    expiresAt: stringValue(value.expiresAt ?? value.expires_at, undefined),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function firstDuplicateAccessRule(rules: CreateAccessRuleInput[]) {
  const seen = new Set<string>()
  for (const rule of rules) {
    const key = `${rule.type}:${rule.value.trim().toLowerCase()}`
    if (seen.has(key)) return rule.value
    seen.add(key)
  }
  return undefined
}

function createFixtureAccessRules(ticketTypeId: string, rules: CreateAccessRuleInput[]) {
  const created = rules.map((input) => normalizeAccessRule({
    id: `acr_${Math.random().toString(36).slice(2, 11)}`,
    ticketTypeId,
    type: input.type,
    value: input.value.trim(),
    maxUses: input.maxUses ?? undefined,
    usesCount: 0,
    expiresAt: input.expiresAt ?? undefined,
    createdAt: iso(0),
    updatedAt: iso(0),
  }))
  if (created.length > 0) {
    if (!fixtureAccessRules[ticketTypeId]) fixtureAccessRules[ticketTypeId] = []
    fixtureAccessRules[ticketTypeId].push(...created)
  }
  return created
}

function normalizeProductCategory(value: Partial<AdminProductCategory> & Record<string, unknown>): AdminProductCategory {
  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    name: stringValue(value.name, 'Untitled category'),
    sortOrder: finiteNumber(value.sortOrder ?? value.sort_order),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

function normalizeProduct(value: Partial<AdminProduct> & Record<string, unknown>): AdminProduct {
  const status = value.status === 'inactive' ? 'inactive' : 'active'
  const description = value.description
  const categoryId = value.categoryId ?? value.category_id
  const availableFrom = value.availableFrom ?? value.available_from
  const availableUntil = value.availableUntil ?? value.available_until
  return {
    id: String(value.id),
    eventId: String(value.eventId ?? value.event_id ?? ''),
    name: stringValue(value.name, 'Untitled product'),
    description: typeof description === 'string' && description.length > 0 ? description : undefined,
    priceCents: finiteNumber(value.priceCents ?? value.price_cents),
    currency: stringValue(value.currency, 'USD'),
    categoryId: typeof categoryId === 'string' && categoryId.length > 0 ? categoryId : undefined,
    maxPerOrder: finiteNumber(value.maxPerOrder ?? value.max_per_order, 10),
    availableFrom: typeof availableFrom === 'string' && availableFrom.length > 0 ? availableFrom : undefined,
    availableUntil: typeof availableUntil === 'string' && availableUntil.length > 0 ? availableUntil : undefined,
    status,
    sortOrder: finiteNumber(value.sortOrder ?? value.sort_order),
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    updatedAt: stringValue(value.updatedAt ?? value.updated_at, undefined),
  }
}

export function normalizeExportJob(value: Partial<AdminExportJob> & Record<string, unknown>): AdminExportJob {
  const status =
    value.status === 'processing' ||
    value.status === 'completed' ||
    value.status === 'failed'
      ? value.status
      : 'pending'
  const type = ['attendees', 'orders', 'scan_logs', 'sales', 'tax', 'tickets'].includes(String(value.type))
    ? (value.type as AdminExportType)
    : undefined
  const format = ['csv', 'xlsx', 'json'].includes(String(value.format))
    ? (value.format as AdminExportFormat)
    : undefined
  const downloadUrl = stringValue(value.downloadUrl ?? value.download_url, undefined)
  return {
    exportId: String(value.exportId ?? value.export_id ?? value.id),
    eventId: stringValue(value.eventId ?? value.event_id, undefined),
    type,
    format,
    status,
    fileUrl: stringValue(value.fileUrl ?? value.file_url, undefined),
    downloadUrl: downloadUrl?.startsWith('/v1/')
      ? `${getAdminApiBaseUrl()}${downloadUrl}`
      : downloadUrl,
    createdAt: stringValue(value.createdAt ?? value.created_at, undefined),
    completedAt: stringValue(value.completedAt ?? value.completed_at, undefined),
  }
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const daysFromNow = (d: number) => iso(d * 86_400_000)

const fixtureEvents: AdminEventDetail[] = [
  {
    id: 'evt_demo_001',
    title: 'Summer Music Festival 2026',
    slug: 'summer-music-festival-2026',
    status: 'published',
    description: 'Outdoor music festival with general admission and VIP access.',
    startsAt: daysFromNow(14),
    endsAt: daysFromNow(15),
    timezone: 'America/New_York',
    venue: {
      name: 'Riverside Amphitheater',
      address: '100 River Walk',
      city: 'Austin',
      region: 'TX',
      country: 'US',
    },
    venueName: 'Riverside Amphitheater',
    city: 'Austin',
    visibility: 'public',
    seo: {
      title: 'Summer Music Festival 2026',
      description: 'Reserve tickets for Summer Music Festival 2026.',
    },
    currency: 'USD',
    grossSalesCents: 482_500,
    ticketsSold: 193,
    capacity: 500,
    coverImageUrl: 'https://cdn.example.test/events/summer-festival.jpg',
    externalUrl: 'https://tickets.example.test/summer-music-festival-2026',
    checkIns: 0,
    updatedAt: iso(-3_600_000),
  },
  {
    id: 'evt_demo_002',
    title: 'TechConf 2026',
    slug: 'techconf-2026',
    status: 'published',
    description: 'Conference for engineering leaders and product teams.',
    startsAt: daysFromNow(30),
    endsAt: daysFromNow(32),
    timezone: 'America/Los_Angeles',
    venue: {
      name: 'Moscone Center',
      address: '747 Howard St',
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
    },
    venueName: 'Moscone Center',
    city: 'San Francisco',
    visibility: 'public',
    seo: {},
    currency: 'USD',
    grossSalesCents: 1_240_000,
    ticketsSold: 248,
    capacity: 800,
    checkIns: 0,
    updatedAt: iso(-7_200_000),
  },
  {
    id: 'evt_demo_003',
    title: 'Local Food Tasting',
    slug: 'local-food-tasting',
    status: 'draft',
    description: 'Small tasting event for local vendors.',
    startsAt: daysFromNow(45),
    timezone: 'Europe/London',
    venue: {
      name: 'Borough Market',
      city: 'London',
      country: 'GB',
    },
    venueName: 'Borough Market',
    city: 'London',
    visibility: 'unlisted',
    seo: {},
    currency: 'GBP',
    grossSalesCents: 0,
    ticketsSold: 0,
    capacity: 120,
    checkIns: 0,
    updatedAt: iso(-86_400_000),
  },
  {
    id: 'evt_demo_004',
    title: 'Indie Game Showcase',
    slug: 'indie-game-showcase',
    status: 'paused',
    description: 'Showcase floor for independent game studios.',
    startsAt: daysFromNow(-7),
    endsAt: daysFromNow(-6),
    timezone: 'Asia/Tokyo',
    venue: {
      name: 'Akihabara Hall',
      city: 'Tokyo',
      country: 'JP',
    },
    venueName: 'Akihabara Hall',
    city: 'Tokyo',
    visibility: 'private',
    seo: {},
    currency: 'JPY',
    grossSalesCents: 340_000,
    ticketsSold: 85,
    capacity: 200,
    checkIns: 78,
    updatedAt: iso(-172_800_000),
  },
  {
    id: 'evt_demo_005',
    title: 'Annual Charity Gala',
    slug: 'annual-charity-gala',
    status: 'archived',
    description: 'Archived gala event with historical sales and check-in data.',
    startsAt: daysFromNow(-90),
    endsAt: daysFromNow(-90),
    timezone: 'America/Chicago',
    venue: {
      name: 'Grand Ballroom',
      city: 'Chicago',
      region: 'IL',
      country: 'US',
    },
    venueName: 'Grand Ballroom',
    city: 'Chicago',
    visibility: 'public',
    seo: {},
    currency: 'USD',
    grossSalesCents: 875_000,
    ticketsSold: 350,
    capacity: 400,
    checkIns: 342,
    updatedAt: iso(-7_776_000_000),
  },
]

const fixtureTicketTypes: Record<string, AdminTicketType[]> = {
  evt_demo_001: [
    {
      id: 'tt_001',
      eventId: 'evt_demo_001',
      name: 'General Admission',
      status: 'active',
      priceCents: 2_500,
      currency: 'USD',
      quantityTotal: 400,
      quantitySold: 160,
      requiresAccessCode: false,
    },
    {
      id: 'tt_002',
      eventId: 'evt_demo_001',
      name: 'VIP Pit Access',
      status: 'active',
      priceCents: 7_500,
      currency: 'USD',
      quantityTotal: 100,
      quantitySold: 33,
      requiresAccessCode: false,
    },
    {
      id: 'tt_003',
      eventId: 'evt_demo_001',
      name: 'Early Bird',
      status: 'sold_out',
      priceCents: 1_500,
      currency: 'USD',
      quantityTotal: 50,
      quantitySold: 50,
      salesEndAt: daysFromNow(-10),
      requiresAccessCode: false,
    },
  ],
  evt_demo_002: [
    {
      id: 'tt_010',
      eventId: 'evt_demo_002',
      name: 'Standard Pass',
      status: 'active',
      priceCents: 5_000,
      currency: 'USD',
      quantityTotal: 600,
      quantitySold: 200,
      requiresAccessCode: false,
    },
    {
      id: 'tt_011',
      eventId: 'evt_demo_002',
      name: 'VIP Pass',
      status: 'active',
      priceCents: 12_000,
      currency: 'USD',
      quantityTotal: 200,
      quantitySold: 48,
      requiresAccessCode: false,
    },
  ],
}

const fixtureCheckoutQuestions: Record<string, AdminCheckoutQuestion[]> = {
  evt_demo_001: [
    {
      id: 'q_demo_buyer_company',
      eventId: 'evt_demo_001',
      type: 'text',
      label: 'Company',
      description: 'Shown on the buyer step.',
      required: false,
      appliesTo: 'buyer',
      placeholder: 'Acme Co.',
      sortOrder: 10,
      isConsentField: false,
      createdAt: iso(-604_800_000),
      updatedAt: iso(-604_800_000),
    },
    {
      id: 'q_demo_attendee_meal',
      eventId: 'evt_demo_001',
      ticketTypeId: 'tt_001',
      type: 'select',
      label: 'Meal preference',
      required: true,
      appliesTo: 'attendee',
      options: ['Standard', 'Vegetarian', 'Gluten-free'],
      sortOrder: 20,
      isConsentField: false,
      createdAt: iso(-604_800_000),
      updatedAt: iso(-604_800_000),
    },
    {
      id: 'q_demo_waiver',
      eventId: 'evt_demo_001',
      type: 'waiver',
      label: 'Photography consent',
      required: true,
      appliesTo: 'both',
      sortOrder: 30,
      isConsentField: true,
      consentText: 'I agree that event photography may include me.',
      consentVersion: '1',
      createdAt: iso(-604_800_000),
      updatedAt: iso(-604_800_000),
    },
  ],
}

const fixtureCheckInLists: Record<string, AdminCheckInList[]> = {
  evt_demo_001: [
    {
      id: 'cil_demo_001',
      eventId: 'evt_demo_001',
      name: 'Main Entrance',
      ticketTypeIds: [],
      status: 'active',
      createdAt: iso(-86_400_000),
      updatedAt: iso(-86_400_000),
    },
  ],
  evt_demo_002: [
    {
      id: 'cil_demo_002',
      eventId: 'evt_demo_002',
      name: 'Conference Registration',
      ticketTypeIds: [],
      status: 'active',
      createdAt: iso(-172_800_000),
      updatedAt: iso(-172_800_000),
    },
  ],
  evt_demo_004: [
    {
      id: 'cil_demo_003',
      eventId: 'evt_demo_004',
      name: 'Show Floor Entrance',
      ticketTypeIds: [],
      status: 'active',
      createdAt: iso(-604_800_000),
      updatedAt: iso(-604_800_000),
    },
  ],
}

const fixtureInventoryPools: Record<string, AdminInventoryPool[]> = {}
const fixtureAccessRules: Record<string, AdminAccessRule[]> = {}
const fixtureProductCategories: Record<string, AdminProductCategory[]> = {}
const fixtureProducts: Record<string, AdminProduct[]> = {}

const fixtureOrders: AdminOrderListItem[] = [
  {
    id: 'ord_001',
    eventId: 'evt_demo_001',
    eventTitle: 'Summer Music Festival 2026',
    buyerName: 'Alice Johnson',
    buyerEmail: 'alice@example.com',
    status: 'paid',
    totalCents: 5_000,
    refundedCents: 0,
    currency: 'USD',
    attendeeCount: 2,
    paymentProvider: 'stripe',
    createdAt: iso(-86_400_000),
    paidAt: iso(-86_000_000),
  },
  {
    id: 'ord_002',
    eventId: 'evt_demo_002',
    eventTitle: 'TechConf 2026',
    buyerName: 'Bob Smith',
    buyerEmail: 'bob@example.com',
    status: 'paid',
    totalCents: 12_000,
    refundedCents: 0,
    currency: 'USD',
    attendeeCount: 1,
    paymentProvider: 'stripe',
    createdAt: iso(-172_800_000),
    paidAt: iso(-172_400_000),
  },
  {
    id: 'ord_003',
    eventId: 'evt_demo_001',
    eventTitle: 'Summer Music Festival 2026',
    buyerName: 'Carol Davis',
    buyerEmail: 'carol@example.com',
    status: 'pending',
    totalCents: 2_500,
    refundedCents: 0,
    currency: 'USD',
    attendeeCount: 1,
    paymentProvider: 'stripe',
    createdAt: iso(-3_600_000),
  },
  {
    id: 'ord_004',
    eventId: 'evt_demo_004',
    eventTitle: 'Indie Game Showcase',
    buyerName: 'Dan Lee',
    buyerEmail: 'dan@example.com',
    status: 'refunded',
    totalCents: 4_000,
    refundedCents: 4_000,
    currency: 'JPY',
    attendeeCount: 2,
    paymentProvider: 'stripe',
    createdAt: iso(-604_800_000),
    paidAt: iso(-604_400_000),
    refundedAt: iso(-600_000_000),
  },
  {
    id: 'ord_005',
    eventId: 'evt_demo_002',
    eventTitle: 'TechConf 2026',
    buyerEmail: 'eve@example.com',
    status: 'cancelled',
    totalCents: 5_000,
    refundedCents: 0,
    currency: 'USD',
    attendeeCount: 1,
    createdAt: iso(-259_200_000),
    cancelledAt: iso(-258_800_000),
  },
]

const fixtureAttendees: AdminAttendeeListItem[] = [
  {
    id: 'att_001',
    eventId: 'evt_demo_001',
    eventTitle: 'Summer Music Festival 2026',
    orderId: 'ord_001',
    ticketId: 'tkt_001',
    ticketTypeName: 'General Admission',
    name: 'Alice Johnson',
    email: 'alice@example.com',
    status: 'active',
    checkInStatus: 'not_checked_in',
    createdAt: iso(-86_400_000),
  },
  {
    id: 'att_002',
    eventId: 'evt_demo_001',
    eventTitle: 'Summer Music Festival 2026',
    orderId: 'ord_001',
    ticketId: 'tkt_002',
    ticketTypeName: 'General Admission',
    name: 'James Johnson',
    email: 'james@example.com',
    status: 'active',
    checkInStatus: 'not_checked_in',
    createdAt: iso(-86_400_000),
  },
  {
    id: 'att_003',
    eventId: 'evt_demo_002',
    eventTitle: 'TechConf 2026',
    orderId: 'ord_002',
    ticketId: 'tkt_003',
    ticketTypeName: 'VIP Pass',
    name: 'Bob Smith',
    email: 'bob@example.com',
    status: 'active',
    checkInStatus: 'not_checked_in',
    createdAt: iso(-172_800_000),
  },
  {
    id: 'att_004',
    eventId: 'evt_demo_004',
    eventTitle: 'Indie Game Showcase',
    orderId: 'ord_004',
    ticketId: 'tkt_004',
    ticketTypeName: 'Standard',
    name: 'Dan Lee',
    email: 'dan@example.com',
    status: 'refunded',
    checkInStatus: 'revoked',
    createdAt: iso(-604_800_000),
  },
]

const fixtureApiKeys: AdminApiKey[] = [
  {
    id: 'key_001',
    name: 'Production Server',
    keyPrefix: 'tk_live_ab',
    scopes: [],
    lastUsedAt: iso(-3_600_000),
    expiresAt: undefined,
    createdAt: iso(-2_592_000_000),
  },
  {
    id: 'key_002',
    name: 'CI/CD Pipeline',
    keyPrefix: 'tk_test_cd',
    scopes: [],
    lastUsedAt: iso(-86_400_000),
    expiresAt: undefined,
    createdAt: iso(-1_296_000_000),
  },
]

const fixtureWebhooks: AdminWebhookEndpoint[] = [
  {
    id: 'wh_001',
    url: 'https://example.com/webhooks/tixkit',
    description: 'Production webhook handler',
    events: ['order.created', 'order.paid', 'order.refunded'],
    status: 'active',
    failureCount: 0,
    lastDeliveryAt: iso(-3_600_000),
    createdAt: iso(-2_592_000_000),
  },
  {
    id: 'wh_002',
    url: 'https://staging.example.com/hooks',
    description: 'Staging webhook handler',
    events: ['ticket.issued', 'ticket.checked_in'],
    status: 'paused',
    failureCount: 3,
    lastDeliveryAt: iso(-604_800_000),
    createdAt: iso(-1_296_000_000),
  },
]

const fixtureWebhookEvents: AdminWebhookEvent[] = [
  {
    id: 'whe_001',
    endpointId: 'wh_001',
    eventType: 'order.created',
    status: 'succeeded',
    statusCode: 200,
    attemptCount: 1,
    deliveredAt: iso(-3_600_000),
    createdAt: iso(-3_600_000),
  },
  {
    id: 'whe_002',
    endpointId: 'wh_001',
    eventType: 'order.paid',
    status: 'succeeded',
    statusCode: 200,
    attemptCount: 1,
    deliveredAt: iso(-7_200_000),
    createdAt: iso(-7_200_000),
  },
  {
    id: 'whe_003',
    endpointId: 'wh_001',
    eventType: 'order.refunded',
    status: 'failed',
    statusCode: 500,
    attemptCount: 3,
    deliveredAt: iso(-10_800_000),
    createdAt: iso(-10_800_000),
  },
  {
    id: 'whe_004',
    endpointId: 'wh_002',
    eventType: 'ticket.issued',
    status: 'succeeded',
    statusCode: 200,
    attemptCount: 1,
    deliveredAt: iso(-604_800_000),
    createdAt: iso(-604_800_000),
  },
]

/**
 * Local-dev principal grants all permissions so the UI is fully functional
 * without a backend. In production this is overridden by `GET /v1/me`.
 */
const fixturePrincipal: TixkitPrincipal = {
  permissions: [
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
    'messages.write',
    'reports.read',
    'settings.write',
    'developers.write',
    'billing.write',
  ],
  tenantId: 'tenant_demo',
  organizationIds: ['org_demo'],
}

const fixtureOrganizations: AdminOrganization[] = [
  {
    id: 'org_demo',
    tenantId: 'tenant_demo',
    name: 'Tixkit',
    slug: 'tixkit',
    status: 'active',
    createdAt: iso(-30),
    updatedAt: iso(0),
  },
]

const fixtureBrandDomains: AdminBrandDomain[] = [
  {
    id: 'bdom_demo',
    brandId: 'brd_demo',
    domain: 'events.localhost',
    isPrimary: true,
    isVerified: false,
    sslStatus: 'pending',
    createdAt: iso(-7),
    updatedAt: iso(0),
  },
]

const fixtureBrands: AdminBrand[] = [
  {
    id: 'brd_demo',
    tenantId: 'tenant_demo',
    organizationId: 'org_demo',
    name: 'Tixkit',
    slug: 'tixkit',
    status: 'draft',
    theme: { primaryColor: '#222222' },
    domains: fixtureBrandDomains,
    whiteLabel: false,
    createdAt: iso(-30),
    updatedAt: iso(0),
  },
]

const fixtureTeamMembers: AdminTeamMember[] = []
const fixturePaymentAccounts: AdminPaymentAccount[] = []

const fixtureBillingOverview: AdminBillingOverview = {
  organizationId: 'org_demo',
}

const fixtureExportJobs: AdminExportJob[] = []

const fixtureMessages: AdminMessageCampaign[] = [
  {
    id: 'msg_001',
    eventId: 'evt_demo_001',
    name: 'Welcome email - Summer Festival',
    channel: 'email',
    status: 'sent',
    audience: 'all_attendees',
    audienceKey: 'all',
    audienceAttendeeIds: [],
    audienceLabel: 'All attendees',
    queuedCount: 0,
    sentCount: 193,
    deliveredCount: 187,
    failedCount: 0,
    suppressedCount: 0,
    createdAt: iso(-604_800_000),
  },
  {
    id: 'msg_002',
    eventId: 'evt_demo_002',
    name: 'Check-in reminder',
    channel: 'sms',
    status: 'scheduled',
    audience: 'not_checked_in',
    audienceKey: 'not_checked_in',
    audienceAttendeeIds: [],
    audienceLabel: 'Not checked in',
    queuedCount: 0,
    sentCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    suppressedCount: 0,
    scheduledAt: daysFromNow(1),
    createdAt: iso(-86_400_000),
  },
]

function fixtureSalesReport(
  eventId: string,
  range?: ReportDateRange,
): AdminSalesReportSummary {
  const orders = fixtureOrders.filter((o) => o.eventId === eventId)
  const gross = orders
    .filter((o) => o.status === 'paid')
    .reduce((sum, o) => sum + o.totalCents, 0)
  const refunds = orders.reduce((sum, o) => sum + o.refundedCents, 0)
  const attendees = fixtureAttendees.filter((a) => a.eventId === eventId)
  const event = fixtureEvents.find((e) => e.id === eventId)

  return {
    eventId,
    currency: event?.currency ?? 'USD',
    grossSalesCents: gross,
    netRevenueCents: gross - refunds - Math.round(gross * 0.03),
    feesCents: Math.round(gross * 0.03),
    taxCents: Math.round(gross * 0.08),
    refundsCents: refunds,
    ordersCount: orders.length,
    paidOrdersCount: orders.filter((o) => o.status === 'paid').length,
    ticketsSold: attendees.length,
    checkIns: attendees.filter((a) => a.checkInStatus === 'checked_in').length,
    conversionRate: 0.68,
    range: {
      from: range?.from ?? iso(-30 * 86_400_000),
      to: range?.to ?? iso(0),
    },
  }
}

function fixtureTaxReport(eventId: string, range?: ReportDateRange): AdminTaxReport {
  const sales = fixtureSalesReport(eventId, range)
  return {
    eventId,
    currency: sales.currency,
    totalTaxCollectedCents: sales.taxCents,
    breakdown: sales.taxCents > 0
      ? [{
          taxRuleName: 'Actual collected tax',
          rate: null,
          taxableAmountCents: sales.grossSalesCents - sales.refundsCents,
          taxCollectedCents: sales.taxCents,
        }]
      : [],
  }
}

function fixtureAttendanceReport(eventId: string): AdminAttendanceReport {
  const attendees = fixtureAttendees.filter((a) => a.eventId === eventId)
  const checkedIn = attendees.filter((a) => a.checkInStatus === 'checked_in').length
  return {
    eventId,
    totalAttendees: attendees.length,
    checkedIn,
    notCheckedIn: Math.max(0, attendees.length - checkedIn),
    checkInRate: attendees.length > 0 ? checkedIn / attendees.length : 0,
    breakdownByTicketType: [],
  }
}

function fixturePromoReport(eventId: string): AdminPromoReport {
  const sales = fixtureSalesReport(eventId)
  return {
    eventId,
    discountCodes: [
      {
        code: 'PROMO10',
        usesCount: Math.max(1, Math.round(sales.paidOrdersCount / 3)),
        discountAmountCents: Math.round(sales.grossSalesCents * 0.1),
        revenueAttributedCents: Math.round(sales.grossSalesCents * 0.35),
      },
    ],
  }
}

function fixtureConversionReport(eventId: string): AdminConversionReport {
  const sales = fixtureSalesReport(eventId)
  const checkoutStarted = Math.max(sales.paidOrdersCount, Math.round(sales.paidOrdersCount / 0.68))
  return {
    eventId,
    widgetViews: 0,
    checkoutStarted,
    checkoutCompleted: sales.paidOrdersCount,
    conversionRate: checkoutStarted > 0 ? sales.paidOrdersCount / checkoutStarted : 0,
  }
}

function fixtureAffiliateReport(organizationId: string): AdminAffiliateReport {
  return {
    organizationId,
    affiliates: [
      {
        affiliateId: 'aff_demo_001',
        code: 'ADA',
        name: 'Ada Partners',
        referralsCount: 12,
        revenueAttributedCents: 124_000,
        commissionCents: 12_400,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// AdminApi implementation
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], cursor?: string, limit?: number): PageResult<T> {
  if (!limit) return { items, total: items.length }
  const startIndex = cursor ? parseInt(cursor, 10) : 0
  const endIndex = startIndex + limit
  const sliced = items.slice(startIndex, endIndex)
  return {
    items: sliced,
    nextCursor: endIndex < items.length ? String(endIndex) : undefined,
    total: items.length,
  }
}

function adminIdempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export const adminApi: AdminApi = {
  // ---- Principal / permissions ----
  async getPrincipal(token?: string) {
    return withFixture(
      () => request<TixkitPrincipal>('/v1/me', {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      }),
      () => ok(fixturePrincipal)
    )
  },

  // ---- Tenant / settings ----
  async listOrganizations() {
    return withFixture(
      async () => {
        const result = await request<AdminOrganization[]>('/v1/organizations', { method: 'GET' })
        return result.ok ? ok(result.data.map((org) => normalizeOrganization(asRecord(org)))) : result
      },
      () => ok(fixtureOrganizations)
    )
  },

  async updateOrganization(organizationId, input) {
    return withFixture(
      () =>
        request<AdminOrganization>(`/v1/organizations/${organizationId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      () => {
        const organization = fixtureOrganizations.find((org) => org.id === organizationId)
        if (!organization) return err<AdminOrganization>(apiError('not_found', 'Workspace not found', 404))
        Object.assign(organization, input, { updatedAt: iso(0) })
        return ok(organization)
      }
    )
  },

  async listBrands() {
    return withFixture(
      async () => {
        const result = await request<AdminBrand[]>('/v1/brands', { method: 'GET' })
        return result.ok ? ok(result.data.map((brand) => normalizeBrand(asRecord(brand)))) : result
      },
      () => ok(fixtureBrands)
    )
  },

  async updateBrand(brandId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminBrand>(`/v1/brands/${brandId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeBrand(asRecord(result.data))) : result
      },
      () => {
        const brand = fixtureBrands.find((item) => item.id === brandId)
        if (!brand) return err<AdminBrand>(apiError('not_found', 'Brand not found', 404))
        Object.assign(brand, input, { updatedAt: iso(0) })
        return ok(brand)
      }
    )
  },

  async addBrandDomain(brandId, domain, isPrimary = false) {
    return withFixture(
      async () => {
        const result = await request<AdminBrandDomain>(`/v1/brands/${brandId}/domains`, {
          method: 'POST',
          body: JSON.stringify({ domain, isPrimary }),
        })
        return result.ok ? ok(normalizeBrandDomain(asRecord(result.data))) : result
      },
      () => {
        const brand = fixtureBrands.find((item) => item.id === brandId)
        if (!brand) return err<AdminBrandDomain>(apiError('not_found', 'Brand not found', 404))
        const brandDomain: AdminBrandDomain = {
          id: `bdom_${Math.random().toString(36).slice(2, 11)}`,
          brandId,
          domain,
          isPrimary,
          isVerified: false,
          sslStatus: 'pending',
          createdAt: iso(0),
          updatedAt: iso(0),
        }
        fixtureBrandDomains.unshift(brandDomain)
        brand.domains = [brandDomain, ...brand.domains]
        return ok(brandDomain)
      }
    )
  },

  async listTeamMembers(organizationId) {
    return withFixture(
      async () => {
        const result = await request<AdminTeamMember[]>(`/v1/organizations/${organizationId}/members`, { method: 'GET' })
        return result.ok ? ok(result.data.map((member) => normalizeTeamMember(asRecord(member), organizationId))) : result
      },
      () => ok(fixtureTeamMembers.filter((member) => member.organizationId === organizationId))
    )
  },

  async inviteTeamMember(organizationId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminTeamMember>(`/v1/organizations/${organizationId}/members/invitations`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeTeamMember(asRecord(result.data), organizationId)) : result
      },
      () => {
        const member: AdminTeamMember = {
          id: `tm_${Math.random().toString(36).slice(2, 11)}`,
          organizationId,
          name: input.email.split('@')[0] || 'Invited member',
          email: input.email,
          role: input.role,
          status: 'invited',
          invitedAt: iso(0),
        }
        fixtureTeamMembers.unshift(member)
        return ok(member)
      }
    )
  },

  async listPaymentAccounts(organizationId) {
    return withFixture(
      async () => {
        const result = await request<AdminPaymentAccount[]>(`/v1/organizations/${organizationId}/payment-accounts`, { method: 'GET' })
        return result.ok ? ok(result.data.map((account) => normalizePaymentAccount(asRecord(account), organizationId))) : result
      },
      () => ok(fixturePaymentAccounts.filter((account) => account.organizationId === organizationId))
    )
  },

  async createStripeConnectAccount(organizationId) {
    return withFixture(
      async () => {
        const result = await request<AdminPaymentAccount>(`/v1/organizations/${organizationId}/payment-accounts/stripe-connect`, {
          method: 'POST',
        })
        return result.ok ? ok(normalizePaymentAccount(asRecord(result.data), organizationId)) : result
      },
      () => {
        const account: AdminPaymentAccount = {
          id: `pa_${Math.random().toString(36).slice(2, 11)}`,
          organizationId,
          provider: 'stripe_connect',
          providerAccountId: `acct_${Math.random().toString(36).slice(2, 14)}`,
          status: 'pending',
          defaultCurrency: 'USD',
          createdAt: iso(0),
          updatedAt: iso(0),
        }
        fixturePaymentAccounts.unshift(account)
        return ok(account)
      }
    )
  },

  async refreshStripeConnectAccount(organizationId, paymentAccountId) {
    return withFixture(
      async () => {
        const result = await request<AdminPaymentAccount>(
          `/v1/organizations/${organizationId}/payment-accounts/${paymentAccountId}/stripe-connect/refresh`,
          { method: 'POST' }
        )
        return result.ok ? ok(normalizePaymentAccount(asRecord(result.data), organizationId)) : result
      },
      () => {
        const account = fixturePaymentAccounts.find((candidate) => candidate.id === paymentAccountId && candidate.organizationId === organizationId)
        if (!account) {
          return err<AdminPaymentAccount>(apiError('payment_account_not_found', 'Payment account not found', 404))
        }
        const updated = {
          ...account,
          status: account.status === 'pending' ? 'active' : account.status,
          updatedAt: new Date().toISOString(),
        } satisfies AdminPaymentAccount
        Object.assign(account, updated)
        return ok(updated)
      }
    )
  },

  async getBillingOverview(organizationId) {
    return withFixture(
      async () => {
        const result = await request<AdminBillingOverview>(`/v1/organizations/${organizationId}/billing`, { method: 'GET' })
        return result.ok ? ok(normalizeBillingOverview(asRecord(result.data), organizationId)) : result
      },
      () => ok({ ...fixtureBillingOverview, organizationId })
    )
  },

  async uploadArtifact(input) {
    return withFixture(
      async () => {
        const createResult = await request<UploadArtifactTicket>('/v1/upload-artifacts', {
          method: 'POST',
          body: JSON.stringify({
            purpose: input.purpose,
            fileName: input.file.name,
            contentType: input.file.type || 'application/octet-stream',
            sizeBytes: input.file.size,
            brandId: input.brandId,
            eventId: input.eventId,
            metadata: input.metadata,
          } satisfies CreateUploadArtifactInput),
        })
        if (!createResult.ok) return createResult

        const uploadResult = await putUploadBytes(createResult.data, input.file)
        if (!uploadResult.ok) return uploadResult

        const completeResult = await request<CompletedUploadArtifact>(createResult.data.completeUrl, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        if (!completeResult.ok) return completeResult

        const downloadResult = await request<{ downloadUrl: string }>(
          `/v1/upload-artifacts/${completeResult.data.artifactId}/download`,
          { method: 'GET' }
        )
        return ok({
          ...completeResult.data,
          downloadUrl: downloadResult.ok ? downloadResult.data.downloadUrl : undefined,
        })
      },
      () =>
        ok({
          artifactId: `upl_${Math.random().toString(36).slice(2, 11)}`,
          status: 'uploaded',
          scanStatus: 'clean',
          downloadUrl: URL.createObjectURL(input.file),
        })
    )
  },

  // ---- Events ----
  async listEvents(input) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminEventListItem> | AdminEventListItem[]>('/v1/events', {
          method: 'GET',
        })
        return result.ok ? ok(normalizeEventPage(result.data)) : result
      },
      () =>
        ok(paginate(fixtureEvents, input?.cursor, input?.limit))
    )
  },

  async getEvent(eventId) {
    return withFixture(
      async () => {
        const result = await request<AdminEventDetail>(`/v1/events/${eventId}`, { method: 'GET' })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventDetail>(apiError('not_found', 'Event not found', 404))
        return ok(event)
      }
    )
  },

  async createEvent(input) {
    return withFixture(
      async () => {
        if (!input.organizationId || !input.brandId) {
          return Promise.resolve(err<AdminEventDetail>(apiError(
            'missing_scope',
            'organizationId and brandId are required to create events. These are provided by the admin bootstrap context.',
            400
          )))
        }
        const organizationId = input.organizationId
        const brandId = input.brandId
        const venue = input.venue ?? {
          name: input.venueName,
          address: input.address,
        }
        const result = await request<AdminEventDetail>('/v1/events', {
          method: 'POST',
          body: JSON.stringify({
            organizationId,
            brandId,
            slug: input.slug ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            title: input.title,
            description: input.description,
            currency: input.currency,
            timezone: input.timezone,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            venue: Object.values(venue).some(Boolean) ? venue : undefined,
            visibility: input.visibility,
            seo: input.seo,
            capacity: input.capacity,
            coverImageUrl: input.coverImageUrl,
            externalUrl: input.externalUrl,
          }),
        })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const venue = input.venue ?? { name: input.venueName, address: input.address }
        const newEvent: AdminEventDetail = {
          id: `evt_${Math.random().toString(36).slice(2, 11)}`,
          title: input.title,
          slug: input.slug ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          status: 'draft',
          startsAt: input.startsAt,
          endsAt: input.endsAt ?? undefined,
          timezone: input.timezone,
          description: input.description,
          venue: Object.values(venue).some(Boolean) ? venue : null,
          venueName: input.venueName ?? input.venue?.name,
          city: input.venue?.city,
          visibility: input.visibility ?? 'public',
          seo: input.seo ?? {},
          currency: input.currency,
          grossSalesCents: 0,
          ticketsSold: 0,
          capacity: input.capacity ?? undefined,
          coverImageUrl: input.coverImageUrl ?? undefined,
          externalUrl: input.externalUrl ?? undefined,
          checkIns: 0,
          updatedAt: iso(0),
        }
        fixtureEvents.unshift(newEvent)
        return ok(newEvent)
      }
    )
  },

  async updateEvent(eventId, input) {
    return withFixture(
      async () => {
        const body: Record<string, unknown> = {}
        if (input.title !== undefined) body.title = input.title
        if (input.description !== undefined) body.description = input.description
        if (input.currency !== undefined) body.currency = input.currency
        if (input.timezone !== undefined) body.timezone = input.timezone
        if (input.startsAt !== undefined) body.startsAt = input.startsAt
        if (input.endsAt !== undefined) body.endsAt = input.endsAt
        if (input.venue !== undefined || input.venueName !== undefined || input.address !== undefined) {
          const venue = input.venue ?? { name: input.venueName, address: input.address }
          body.venue = Object.values(venue).some(Boolean) ? venue : null
        }
        if (input.visibility !== undefined) body.visibility = input.visibility
        if (input.seo !== undefined) body.seo = input.seo
        if (input.capacity !== undefined) body.capacity = input.capacity
        if (input.coverImageUrl !== undefined) body.coverImageUrl = input.coverImageUrl
        if (input.externalUrl !== undefined) body.externalUrl = input.externalUrl
        if (input.status !== undefined) body.status = input.status

        const result = await request<AdminEventDetail>(`/v1/events/${eventId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventDetail>(apiError('not_found', 'Event not found', 404))
        const updated = normalizeEvent({ ...event, ...input, updatedAt: iso(0) } as Record<string, unknown>)
        const idx = fixtureEvents.indexOf(event)
        fixtureEvents[idx] = updated
        return ok(updated)
      }
    )
  },

  async publishEvent(eventId) {
    return withFixture(
      async () => {
        const result = await request<AdminEventListItem>(`/v1/events/${eventId}/publish`, { method: 'POST' })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventListItem>(apiError('not_found', 'Event not found', 404))
        event.status = 'published'
        event.updatedAt = iso(0)
        return ok(event)
      }
    )
  },

  async pauseEvent(eventId) {
    return withFixture(
      async () => {
        const result = await request<AdminEventListItem>(`/v1/events/${eventId}/pause`, { method: 'POST' })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventListItem>(apiError('not_found', 'Event not found', 404))
        event.status = 'paused'
        event.updatedAt = iso(0)
        return ok(event)
      }
    )
  },

  async archiveEvent(eventId) {
    return withFixture(
      async () => {
        const result = await request<AdminEventListItem>(`/v1/events/${eventId}/archive`, { method: 'POST' })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventListItem>(apiError('not_found', 'Event not found', 404))
        event.status = 'archived'
        event.updatedAt = iso(0)
        return ok(event)
      }
    )
  },

  async listEventOccurrences(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminEventOccurrence> | AdminEventOccurrence[]>(
          `/v1/events/${eventId}/occurrences`,
          { method: 'GET' }
        )
        return result.ok ? ok(unwrapItems(result.data).map((occurrence) => normalizeEventOccurrence(asRecord(occurrence)))) : result
      },
      () => ok([])
    )
  },

  async createEventOccurrence(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminEventOccurrence>(`/v1/events/${eventId}/occurrences`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeEventOccurrence(asRecord(result.data))) : result
      },
      () => err<AdminEventOccurrence>(apiError('fixture_unavailable', 'Event occurrences require the live API.', 400))
    )
  },

  async updateEventOccurrence(eventId, occurrenceId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminEventOccurrence>(`/v1/events/${eventId}/occurrences/${occurrenceId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeEventOccurrence(asRecord(result.data))) : result
      },
      () => err<AdminEventOccurrence>(apiError('fixture_unavailable', 'Event occurrences require the live API.', 400))
    )
  },

  async listMarketingIntegrations(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminMarketingIntegration> | AdminMarketingIntegration[]>(
          `/v1/events/${eventId}/marketing-integrations`,
          { method: 'GET' }
        )
        return result.ok
          ? ok(unwrapItems(result.data).map((integration) => normalizeMarketingIntegration(asRecord(integration))))
          : result
      },
      () => ok([])
    )
  },

  async upsertMarketingIntegration(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminMarketingIntegration>(
          `/v1/events/${eventId}/marketing-integrations/${input.provider}`,
          {
            method: 'PUT',
            body: JSON.stringify(input),
          }
        )
        return result.ok ? ok(normalizeMarketingIntegration(asRecord(result.data))) : result
      },
      () => err<AdminMarketingIntegration>(apiError('fixture_unavailable', 'Marketing integrations require the live API.', 400))
    )
  },

  // ---- Ticket Types ----
  async listTicketTypes(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminTicketType> | AdminTicketType[]>(`/v1/events/${eventId}/ticket-types`, { method: 'GET' })
        return result.ok ? ok(unwrapItems(result.data).map((ticketType) => normalizeTicketType(asRecord(ticketType)))) : result
      },
      () => ok((fixtureTicketTypes[eventId] ?? []).map((ticketType) => normalizeTicketType(ticketType)))
    )
  },

  async createTicketType(eventId, input) {
    return withFixture(
      () => {
        if (!input.inventoryPoolId) {
          return Promise.resolve(err<AdminTicketType>(apiError(
            'missing_inventory_pool',
            'inventoryPoolId is required to create ticket types against the live API.',
            400
          )))
        }
        return request<AdminTicketType>(`/v1/events/${eventId}/ticket-types`, {
          method: 'POST',
          body: JSON.stringify({
            name: input.name,
            description: input.description,
            kind: input.kind,
            visibility: input.visibility,
            currency: input.currency,
            priceCents: input.priceCents,
            minimumPriceCents: input.minimumPriceCents,
            inventoryPoolId: input.inventoryPoolId,
            salesStartAt: input.salesStartAt,
            salesEndAt: input.salesEndAt,
            minPerOrder: input.minPerOrder,
            maxPerOrder: input.maxPerOrder,
            requiresAccessCode: input.requiresAccessCode,
            accessCodeHint: input.accessCodeHint,
            eventOccurrenceId: input.eventOccurrenceId,
          }),
        })
      },
      () => {
        const newTt = normalizeTicketType({
          id: `tt_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.name,
          description: input.description,
          kind: input.kind,
          visibility: input.visibility,
          status: 'active',
          priceCents: input.priceCents,
          minimumPriceCents: input.minimumPriceCents,
          currency: input.currency,
          quantityTotal: input.quantityTotal,
          quantitySold: 0,
          salesStartAt: input.salesStartAt,
          salesEndAt: input.salesEndAt,
          minPerOrder: input.minPerOrder,
          maxPerOrder: input.maxPerOrder,
          requiresAccessCode: input.requiresAccessCode ?? false,
          accessCodeHint: input.accessCodeHint,
          inventoryPoolId: input.inventoryPoolId,
          eventOccurrenceId: input.eventOccurrenceId,
        })
        if (!fixtureTicketTypes[eventId]) fixtureTicketTypes[eventId] = []
        fixtureTicketTypes[eventId].push(newTt)
        return ok(newTt)
      }
    )
  },

  async updateTicketType(ticketTypeId, input) {
    return withFixture(
      () =>
        request<AdminTicketType>(`/v1/ticket-types/${ticketTypeId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      () => {
        let found: AdminTicketType | undefined
        for (const eventId of Object.keys(fixtureTicketTypes)) {
          const tt = fixtureTicketTypes[eventId].find((t) => t.id === ticketTypeId)
          if (tt) {
            found = tt
            break
          }
        }
        if (!found)
          return err<AdminTicketType>(apiError('not_found', 'Ticket type not found', 404))
        Object.assign(found, input)
        return ok(normalizeTicketType(found))
      }
    )
  },

  async createTicketTypeBatch(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<{ ticketType: AdminTicketType; accessRules: AdminAccessRule[] }>(
          `/v1/events/${eventId}/ticket-types/batch`,
          {
            method: 'POST',
            body: JSON.stringify(input),
          }
        )
        return result.ok
          ? ok({
              ticketType: normalizeTicketType(asRecord(result.data.ticketType)),
              accessRules: result.data.accessRules.map((rule) => normalizeAccessRule(asRecord(rule))),
            })
          : result
      },
      () => {
        let inventoryPoolId = input.ticketType.inventoryPoolId
        if (!inventoryPoolId && input.inventoryPool) {
          const pool: AdminInventoryPool = {
            id: `ip_${Math.random().toString(36).slice(2, 11)}`,
            eventId,
            name: input.inventoryPool.name,
            totalCapacity: input.inventoryPool.totalCapacity,
            reservedCount: 0,
            soldCount: 0,
            holdTtlSeconds: input.inventoryPool.holdTtlSeconds,
            createdAt: iso(0),
            updatedAt: iso(0),
          }
          if (!fixtureInventoryPools[eventId]) fixtureInventoryPools[eventId] = []
          fixtureInventoryPools[eventId].push(pool)
          inventoryPoolId = pool.id
        }
        if (!inventoryPoolId) {
          return err<SaveTicketTypeResult>(apiError('missing_inventory_pool', 'Choose or create an inventory pool', 400))
        }
        const duplicate = firstDuplicateAccessRule(input.accessRules ?? [])
        if (duplicate) {
          return err<SaveTicketTypeResult>(apiError('duplicate_access_rule', `Duplicate access rule value: ${duplicate}`, 400))
        }
        const newTt = normalizeTicketType({
          id: `tt_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          ...input.ticketType,
          inventoryPoolId,
          status: 'active',
          quantitySold: 0,
        })
        if (!fixtureTicketTypes[eventId]) fixtureTicketTypes[eventId] = []
        fixtureTicketTypes[eventId].push(newTt)
        const rules = createFixtureAccessRules(newTt.id, input.accessRules ?? [])
        return ok({ ticketType: newTt, accessRules: rules })
      }
    )
  },

  async updateTicketTypeBatch(ticketTypeId, input) {
    return withFixture(
      async () => {
        const result = await request<{ ticketType: AdminTicketType; accessRules: AdminAccessRule[] }>(
          `/v1/ticket-types/${ticketTypeId}/batch`,
          {
            method: 'PATCH',
            body: JSON.stringify(input),
          }
        )
        return result.ok
          ? ok({
              ticketType: normalizeTicketType(asRecord(result.data.ticketType)),
              accessRules: result.data.accessRules.map((rule) => normalizeAccessRule(asRecord(rule))),
            })
          : result
      },
      () => {
        let found: AdminTicketType | undefined
        for (const eventId of Object.keys(fixtureTicketTypes)) {
          const tt = fixtureTicketTypes[eventId].find((t) => t.id === ticketTypeId)
          if (tt) {
            found = tt
            break
          }
        }
        if (!found) {
          return err<SaveTicketTypeResult>(apiError('not_found', 'Ticket type not found', 404))
        }
        const duplicate = firstDuplicateAccessRule(input.accessRules ?? [])
        if (duplicate) {
          return err<SaveTicketTypeResult>(apiError('duplicate_access_rule', `Duplicate access rule value: ${duplicate}`, 400))
        }
        const existingRules = fixtureAccessRules[ticketTypeId] ?? []
        const existingKeys = new Set(existingRules.map((rule) => `${rule.type}:${rule.value.trim().toLowerCase()}`))
        const existingDuplicate = (input.accessRules ?? []).find((rule) =>
          existingKeys.has(`${rule.type}:${rule.value.trim().toLowerCase()}`)
        )
        if (existingDuplicate) {
          return err<SaveTicketTypeResult>(apiError('duplicate_access_rule', `Access rule already exists: ${existingDuplicate.value}`, 400))
        }
        Object.assign(found, input.ticketType)
        const newRules = createFixtureAccessRules(ticketTypeId, input.accessRules ?? [])
        return ok({ ticketType: normalizeTicketType(found), accessRules: [...existingRules, ...newRules] })
      }
    )
  },

  async listWaitlist(eventId) {
    return withFixture(
      async () => {
        const result = await request<{ items: AdminWaitlistEntry[]; settings?: AdminWaitlistSettings } | AdminWaitlistEntry[]>(`/v1/events/${eventId}/waitlist`, { method: 'GET' })
        if (!result.ok) return result
        if (Array.isArray(result.data)) {
          return ok({ items: result.data.map((entry) => normalizeWaitlistEntry(asRecord(entry))), settings: { autoOfferEnabled: true, offerTtlMinutes: 1440 } })
        }
        const data = asRecord(result.data)
        return ok({
          items: unwrapItems(data as PageResult<AdminWaitlistEntry>).map((entry) => normalizeWaitlistEntry(asRecord(entry))),
          settings: normalizeWaitlistSettings(asRecord(data.settings)),
        })
      },
      () => ok({ items: [], settings: { autoOfferEnabled: true, offerTtlMinutes: 1440 } })
    )
  },

  async offerWaitlistEntry(eventId, entryId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminWaitlistOffer>(`/v1/events/${eventId}/waitlist/${entryId}/offer`, {
          method: 'POST',
          body: JSON.stringify(input ?? {}),
        })
        if (!result.ok) return result
        const data = asRecord(result.data)
        return ok({
          entry: normalizeWaitlistEntry(asRecord(data.entry)),
          claimToken: stringValue(data.claimToken, ''),
          claimUrl: stringValue(data.claimUrl, undefined),
        })
      },
      () => err<AdminWaitlistOffer>(apiError('fixture_unavailable', 'Waitlist offers require the live API.', 400))
    )
  },

  async updateWaitlistSettings(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminWaitlistSettings>(`/v1/events/${eventId}/waitlist/settings`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeWaitlistSettings(asRecord(result.data))) : result
      },
      () => ok(input)
    )
  },

  async listAccessRules(ticketTypeId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminAccessRule> | AdminAccessRule[]>(
          `/v1/ticket-types/${ticketTypeId}/access-rules`,
          { method: 'GET' }
        )
        return result.ok ? ok(unwrapItems(result.data).map((rule) => normalizeAccessRule(asRecord(rule)))) : result
      },
      () => ok(fixtureAccessRules[ticketTypeId] ?? [])
    )
  },

  async createAccessRule(ticketTypeId, input) {
    return withFixture(
      () =>
        request<AdminAccessRule>(`/v1/ticket-types/${ticketTypeId}/access-rules`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      () => {
        const rule: AdminAccessRule = {
          id: `acr_${Math.random().toString(36).slice(2, 11)}`,
          ticketTypeId,
          type: input.type,
          value: input.value,
          maxUses: input.maxUses ?? undefined,
          usesCount: 0,
          expiresAt: input.expiresAt ?? undefined,
          createdAt: iso(0),
          updatedAt: iso(0),
        }
        if (!fixtureAccessRules[ticketTypeId]) fixtureAccessRules[ticketTypeId] = []
        fixtureAccessRules[ticketTypeId].push(rule)
        return ok(rule)
      }
    )
  },

  async deleteAccessRule(accessRuleId) {
    return withFixture(
      async () => {
        const result = await request<void>(`/v1/access-rules/${accessRuleId}`, { method: 'DELETE' })
        return result.ok ? ok(undefined) : result
      },
      () => {
        for (const ticketTypeId of Object.keys(fixtureAccessRules)) {
          fixtureAccessRules[ticketTypeId] = fixtureAccessRules[ticketTypeId].filter((rule) => rule.id !== accessRuleId)
        }
        return ok(undefined)
      }
    )
  },

  async listInventoryPools(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminInventoryPool> | AdminInventoryPool[]>(
          `/v1/events/${eventId}/inventory-pools`,
          { method: 'GET' }
        )
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureInventoryPools[eventId] ?? [])
    )
  },

  async createInventoryPool(eventId, input) {
    return withFixture(
      () =>
        request<AdminInventoryPool>(`/v1/events/${eventId}/inventory-pools`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      () => {
        const pool: AdminInventoryPool = {
          id: `ip_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.name,
          totalCapacity: input.totalCapacity,
          reservedCount: 0,
          soldCount: 0,
          holdTtlSeconds: input.holdTtlSeconds,
          createdAt: iso(0),
          updatedAt: iso(0),
        }
        if (!fixtureInventoryPools[eventId]) fixtureInventoryPools[eventId] = []
        fixtureInventoryPools[eventId].push(pool)
        return ok(pool)
      }
    )
  },

  async listProductCategories(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminProductCategory> | AdminProductCategory[]>(
          `/v1/events/${eventId}/product-categories`,
          { method: 'GET' }
        )
        return result.ok
          ? ok(unwrapItems(result.data).map((category) => normalizeProductCategory(asRecord(category))))
          : result
      },
      // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread; ES2023 toSorted is outside this app's TS lib target.
      () => ok([...(fixtureProductCategories[eventId] ?? [])].sort((a, b) => a.sortOrder - b.sortOrder))
    )
  },

  async createProductCategory(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminProductCategory>(`/v1/events/${eventId}/product-categories`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeProductCategory(asRecord(result.data))) : result
      },
      () => {
        const category = normalizeProductCategory({
          id: `pcat_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.name,
          sortOrder: input.sortOrder ?? (fixtureProductCategories[eventId]?.length ?? 0),
          createdAt: iso(0),
          updatedAt: iso(0),
        })
        if (!fixtureProductCategories[eventId]) fixtureProductCategories[eventId] = []
        fixtureProductCategories[eventId].push(category)
        return ok(category)
      }
    )
  },

  async listProducts(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminProduct> | AdminProduct[]>(
          `/v1/events/${eventId}/products`,
          { method: 'GET' }
        )
        return result.ok
          ? ok(unwrapItems(result.data).map((product) => normalizeProduct(asRecord(product))))
          : result
      },
      // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread; ES2023 toSorted is outside this app's TS lib target.
      () => ok([...(fixtureProducts[eventId] ?? [])].sort((a, b) => a.sortOrder - b.sortOrder))
    )
  },

  async createProduct(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminProduct>(`/v1/events/${eventId}/products`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeProduct(asRecord(result.data))) : result
      },
      () => {
        const product = normalizeProduct({
          id: `prd_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.name,
          description: input.description,
          priceCents: input.priceCents,
          currency: input.currency,
          categoryId: input.categoryId,
          maxPerOrder: input.maxPerOrder ?? 10,
          availableFrom: input.availableFrom,
          availableUntil: input.availableUntil,
          status: input.status ?? 'active',
          sortOrder: input.sortOrder ?? (fixtureProducts[eventId]?.length ?? 0),
          createdAt: iso(0),
          updatedAt: iso(0),
        })
        if (!fixtureProducts[eventId]) fixtureProducts[eventId] = []
        fixtureProducts[eventId].push(product)
        return ok(product)
      }
    )
  },

  async updateProduct(productId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminProduct>(`/v1/products/${productId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeProduct(asRecord(result.data))) : result
      },
      () => {
        for (const eventId of Object.keys(fixtureProducts)) {
          const index = fixtureProducts[eventId].findIndex((product) => product.id === productId)
          if (index === -1) continue

          const existing = fixtureProducts[eventId][index]
          const updated = normalizeProduct({
            ...existing,
            ...input,
            description: input.description === null ? undefined : input.description ?? existing.description,
            categoryId: input.categoryId === null ? undefined : input.categoryId ?? existing.categoryId,
            availableFrom: input.availableFrom === null ? undefined : input.availableFrom ?? existing.availableFrom,
            availableUntil: input.availableUntil === null ? undefined : input.availableUntil ?? existing.availableUntil,
            updatedAt: iso(0),
          })
          fixtureProducts[eventId][index] = updated
          return ok(updated)
        }
        return err<AdminProduct>(apiError('not_found', 'Product not found', 404))
      }
    )
  },

  // ---- Checkout Questions ----
  async listCheckoutQuestions(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminCheckoutQuestion> | AdminCheckoutQuestion[]>(
          `/v1/events/${eventId}/questions`,
          { method: 'GET' }
        )
        return result.ok
          ? ok(unwrapItems(result.data).map((question) => normalizeQuestion(asRecord(question))))
          : result
      },
      // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread
      () => ok([...(fixtureCheckoutQuestions[eventId] ?? [])].sort((a, b) => a.sortOrder - b.sortOrder))
    )
  },

  async createCheckoutQuestion(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminCheckoutQuestion>(`/v1/events/${eventId}/questions`, {
          method: 'POST',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeQuestion(asRecord(result.data))) : result
      },
      () => {
        const question = normalizeQuestion({
          ...input,
          id: `q_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          required: input.required ?? false,
          appliesTo: input.appliesTo ?? 'attendee',
          sortOrder: input.sortOrder ?? (fixtureCheckoutQuestions[eventId]?.length ?? 0) * 10,
          isConsentField: input.isConsentField ?? false,
          createdAt: iso(0),
          updatedAt: iso(0),
        })
        if (!fixtureCheckoutQuestions[eventId]) fixtureCheckoutQuestions[eventId] = []
        fixtureCheckoutQuestions[eventId].push(question)
        // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread
        fixtureCheckoutQuestions[eventId] = [...fixtureCheckoutQuestions[eventId]].sort((a, b) => a.sortOrder - b.sortOrder)
        return ok(question)
      }
    )
  },

  async updateCheckoutQuestion(questionId, input) {
    return withFixture(
      async () => {
        const result = await request<AdminCheckoutQuestion>(`/v1/questions/${questionId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeQuestion(asRecord(result.data))) : result
      },
      () => {
        for (const eventId of Object.keys(fixtureCheckoutQuestions)) {
          const questions = fixtureCheckoutQuestions[eventId]
          const index = questions.findIndex((question) => question.id === questionId)
          if (index >= 0) {
            const updated = normalizeQuestion({
              ...questions[index],
              ...input,
              updatedAt: iso(0),
            })
            questions[index] = updated
            // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread
            fixtureCheckoutQuestions[eventId] = [...questions].sort((a, b) => a.sortOrder - b.sortOrder)
            return ok(updated)
          }
        }
        return err<AdminCheckoutQuestion>(apiError('not_found', 'Question not found', 404))
      }
    )
  },

  async reorderCheckoutQuestions(eventId, questions) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminCheckoutQuestion> | AdminCheckoutQuestion[]>(
          `/v1/events/${eventId}/questions/reorder`,
          {
            method: 'POST',
            body: JSON.stringify({ questions }),
          }
        )
        return result.ok
          ? ok(unwrapItems(result.data).map((question) => normalizeQuestion(asRecord(question))))
          : result
      },
      () => {
        const existing = fixtureCheckoutQuestions[eventId] ?? []
        const orderById = new Map(questions.map((question) => [question.id, question.sortOrder]))
        for (const question of existing) {
          const sortOrder = orderById.get(question.id)
          if (sortOrder !== undefined) question.sortOrder = sortOrder
        }
        // eslint-disable-next-line unicorn/no-array-sort -- creates a new array via spread
        fixtureCheckoutQuestions[eventId] = [...existing].sort((a, b) => a.sortOrder - b.sortOrder)
        return ok(fixtureCheckoutQuestions[eventId])
      }
    )
  },

  async deleteCheckoutQuestion(questionId) {
    return withFixture(
      () =>
        request<void>(`/v1/questions/${questionId}`, {
          method: 'DELETE',
        }),
      () => {
        for (const eventId of Object.keys(fixtureCheckoutQuestions)) {
          const questions = fixtureCheckoutQuestions[eventId]
          const index = questions.findIndex((question) => question.id === questionId)
          if (index >= 0) {
            questions.splice(index, 1)
            return ok(undefined)
          }
        }
        return err<void>(apiError('not_found', 'Question not found', 404))
      }
    )
  },

  // ---- Orders ----
  async listOrders(input) {
    return withFixture(
      () => {
        const params = new URLSearchParams()
        if (input?.cursor) params.set('cursor', input.cursor)
        if (input?.limit) params.set('limit', String(input.limit))
        if (input?.eventId) params.set('eventId', input.eventId)
        const qs = params.toString()
        return request<PageResult<AdminOrderListItem>>(
          `/v1/orders${qs ? `?${qs}` : ''}`,
          { method: 'GET' }
        )
      },
      () => {
        let orders = fixtureOrders
        if (input?.eventId) orders = orders.filter((o) => o.eventId === input.eventId)
        return ok(paginate(orders, input?.cursor, input?.limit))
      }
    )
  },

  async getOrder(orderId) {
    return withFixture(
      () => request<AdminOrderDetail>(`/v1/orders/${orderId}`, { method: 'GET' }),
      () => {
        const order = fixtureOrders.find((o) => o.id === orderId)
        if (!order) return err<AdminOrderDetail>(apiError('not_found', 'Order not found', 404))
        return ok({
          ...order,
          lineItems: [],
          attendees: fixtureAttendees.filter((attendee) => attendee.orderId === orderId),
          checkoutAnswers: { buyerFields: {}, attendeeFields: {} },
          consentSnapshots: {},
          refunds: [],
          timeline: [],
          deliveryStatus: { email: order.buyerEmail ? 'pending' : 'not_applicable', tickets: 'issued' },
        })
      }
    )
  },

  async cancelOrder(orderId) {
    return withFixture(
      () => request<AdminOrderListItem>(`/v1/orders/${orderId}/cancel`, { method: 'POST' }),
      () => {
        const order = fixtureOrders.find((o) => o.id === orderId)
        if (!order) return err<AdminOrderListItem>(apiError('not_found', 'Order not found', 404))
        order.status = 'cancelled'
        order.cancelledAt = iso(0)
        return ok(order)
      }
    )
  },

  async refundOrder(orderId, input) {
    return withFixture(
      () =>
        request<RefundOrderResult>(`/v1/orders/${orderId}/refunds`, {
          method: 'POST',
          headers: { 'Idempotency-Key': adminIdempotencyKey(`refund_${orderId}`) },
          body: JSON.stringify({
            ...input,
            reason: input.reason?.trim() || 'Requested from admin dashboard',
          }),
        }),
      () => {
        const order = fixtureOrders.find((o) => o.id === orderId)
        if (!order) return err<RefundOrderResult>(apiError('not_found', 'Order not found', 404))
        const refundAmount = input.amountCents ?? order.totalCents - order.refundedCents
        order.refundedCents += refundAmount
        order.status = order.refundedCents >= order.totalCents ? 'refunded' : 'partially_refunded'
        order.refundedAt = iso(0)
        return ok({
          orderId,
          refundAmount,
          status: 'pending',
          message: 'Refund workflow started',
        })
      }
    )
  },

  // ---- Attendees ----
  async listAttendees(input) {
    return withFixture(
      () => {
        const params = new URLSearchParams()
        if (input.cursor) params.set('cursor', input.cursor)
        if (input.limit) params.set('limit', String(input.limit))
        if (input.eventId) params.set('eventId', input.eventId)
        const qs = params.toString()
        const path = input.eventId
          ? `/v1/events/${input.eventId}/attendees`
          : '/v1/attendees'
        return request<PageResult<AdminAttendeeListItem>>(
          `${path}${qs ? `?${qs}` : ''}`,
          { method: 'GET' }
        )
      },
      () => {
        let attendees = fixtureAttendees
        if (input.eventId) attendees = attendees.filter((a) => a.eventId === input.eventId)
        return ok(paginate(attendees, input.cursor, input.limit))
      }
    )
  },

  async updateAttendee(attendeeId, input) {
    return withFixture(
      () =>
        request<AdminAttendeeListItem>(`/v1/attendees/${attendeeId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      () => {
        const attendee = fixtureAttendees.find((a) => a.id === attendeeId)
        if (!attendee)
          return err<AdminAttendeeListItem>(apiError('not_found', 'Attendee not found', 404))
        Object.assign(attendee, input)
        return ok(attendee)
      }
    )
  },

  async listCheckInLists(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminCheckInList> | AdminCheckInList[]>(
          `/v1/events/${eventId}/check-in-lists`,
          { method: 'GET' }
        )
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureCheckInLists[eventId] ?? [])
    )
  },

  async scanTicket(input) {
    return withFixture(
      async () => {
        if (!input.checkInListId) {
          return Promise.resolve(err<CheckInScanResult>(apiError(
            'missing_check_in_list',
            'checkInListId is required to scan tickets against the live API.',
            400
          )))
        }
        const result = await request<LiveCheckInScanResponse>('/v1/check-ins/scan', {
          method: 'POST',
          body: JSON.stringify({
            checkInListId: input.checkInListId,
            qrPayload: input.qrPayload,
            scannedAt: input.scannedAt ?? new Date().toISOString(),
            deviceId: input.deviceId,
          }),
        })
        return result.ok
          ? ok(normalizeLiveCheckInScanResult(result.data, input.scannedAt))
          : result
      },
      () => {
        // Simulate scan: find attendee by ticket id in qrPayload
        const attendee = fixtureAttendees.find(
          (a) => a.eventId === input.eventId && a.ticketId === input.qrPayload
        )
        if (!attendee) {
          return ok<CheckInScanResult>({
            status: 'invalid',
            message: 'No matching ticket found for this QR code.',
            scannedAt: iso(0),
          })
        }
        if (attendee.checkInStatus === 'checked_in') {
          return ok<CheckInScanResult>({
            status: 'duplicate',
            message: `${attendee.name} was already checked in.`,
            attendee,
            scannedAt: iso(0),
          })
        }
        if (attendee.status === 'refunded' || attendee.checkInStatus === 'revoked') {
          return ok<CheckInScanResult>({
            status: 'revoked',
            message: 'This ticket has been refunded or revoked.',
            attendee,
            scannedAt: iso(0),
          })
        }
        attendee.checkInStatus = 'checked_in'
        attendee.checkedInAt = iso(0)
        return ok<CheckInScanResult>({
          status: 'accepted',
          attendee,
          scannedAt: iso(0),
        })
      }
    )
  },

  // ---- Messages ----
  async listMessages(eventId) {
    return withFixture(
      async () => {
        const result = await request<BackendMessageList>(`/v1/events/${eventId}/messages`, { method: 'GET' })
        if (!result.ok) return result
        return ok(result.data.items.map(normalizeMessageCampaign))
      },
      () => ok(fixtureMessages.filter((m) => m.eventId === eventId))
    )
  },

  async previewMessageRecipients(eventId, input) {
    return withFixture(
      async () =>
        request<MessageRecipientPreview>(`/v1/events/${eventId}/messages/preview`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      () => {
        const attendees = fixtureAttendees
          .filter((attendee) => attendee.eventId === eventId)
          .filter((attendee) => attendee.status === 'active')
          .filter((attendee) => {
            if (input.audience === 'checked_in') return attendee.checkInStatus === 'checked_in'
            if (input.audience === 'not_checked_in') return attendee.checkInStatus !== 'checked_in'
            if (input.audience === 'specific') return new Set(input.attendeeIds ?? []).has(attendee.id)
            return true
          })
        return ok({
          audience: input.audience === 'all' ? 'all_attendees' : input.audience === 'specific' ? 'custom' : input.audience,
          audienceCount: attendees.length,
          eligibleCount: attendees.length,
          suppressedRecipients: 0,
          consentExclusions: 0,
          skippedRecipients: 0,
          recipients: attendees.slice(0, 25).map((attendee) => ({
            id: attendee.id,
            name: attendee.name,
            email: attendee.email,
            status: attendee.status,
          })),
        })
      }
    )
  },

  async sendMessage(eventId, input) {
    return withFixture(
      async () => {
        const result = await request<BackendMessageCampaign>(`/v1/events/${eventId}/messages`, {
          method: 'POST',
          headers: { 'Idempotency-Key': adminIdempotencyKey(`message_${eventId}`) },
          body: JSON.stringify(input),
        })
        if (!result.ok) return result
        return ok(normalizeMessageCampaign(result.data))
      },
      () => {
        const campaign: AdminMessageCampaign = {
          id: `msg_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.templateKey,
          channel: input.channel === 'both' ? 'email' : input.channel,
          status: 'sent',
          audience: input.audience === 'all' ? 'all_attendees' : input.audience === 'specific' ? 'custom' : input.audience,
          audienceKey: input.audience,
          audienceAttendeeIds: input.attendeeIds ?? [],
          audienceLabel: messageAudienceLabel(
            input.audience === 'all' ? 'all_attendees' : input.audience === 'specific' ? 'custom' : input.audience,
            input.attendeeIds ?? []
          ),
          queuedCount: fixtureAttendees.filter((a) => a.eventId === eventId).length,
          sentCount: 0,
          deliveredCount: 0,
          failedCount: 0,
          suppressedCount: 0,
          createdAt: iso(0),
        }
        fixtureMessages.unshift(campaign)
        return ok(campaign)
      }
    )
  },

  async getMessage(eventId, campaignId) {
    return withFixture(
      async () => {
        const result = await request<BackendMessageCampaign>(`/v1/events/${eventId}/messages/${campaignId}`, { method: 'GET' })
        if (!result.ok) return result
        return ok(normalizeMessageCampaignDetail(result.data))
      },
      () => {
        const campaign = fixtureMessages.find((m) => m.eventId === eventId && m.id === campaignId)
        if (!campaign) return err(apiError('not_found', 'Message campaign not found', 404))
        return ok({
          ...campaign,
          templateKey: campaign.name,
          queuedEmailJobs: campaign.channel === 'email' ? campaign.queuedCount : 0,
          queuedSmsJobs: campaign.channel === 'sms' ? campaign.queuedCount : 0,
          suppressedRecipients: campaign.suppressedCount,
          consentExclusions: 0,
          skippedRecipients: 0,
          emailJobs: [],
          smsJobs: [],
          emailDeliveries: [],
          smsDeliveries: [],
        })
      }
    )
  },

  async listMessageJobs(eventId, campaignId) {
    return withFixture(
      async () => {
        const result = await request<{ items: AdminMessageJob[] }>(`/v1/events/${eventId}/messages/${campaignId}/jobs`, { method: 'GET' })
        if (!result.ok) return result
        return ok(result.data.items)
      },
      () => ok([])
    )
  },

  async getMessageJob(eventId, campaignId, channel, jobId) {
    return withFixture(
      () => request<AdminMessageJob>(`/v1/events/${eventId}/messages/${campaignId}/jobs/${channel}/${jobId}`, { method: 'GET' }),
      () => err(apiError('not_found', 'Message job not found', 404))
    )
  },

  async listMessageDeliveryLogs(eventId, campaignId) {
    return withFixture(
      async () => {
        const result = await request<{ items: AdminMessageDeliveryLog[] }>(`/v1/events/${eventId}/messages/${campaignId}/delivery-logs`, { method: 'GET' })
        if (!result.ok) return result
        return ok(result.data.items)
      },
      () => ok([])
    )
  },

  async getMessageDeliveryLog(eventId, campaignId, channel, deliveryId) {
    return withFixture(
      () => request<AdminMessageDeliveryLog>(`/v1/events/${eventId}/messages/${campaignId}/delivery-logs/${channel}/${deliveryId}`, { method: 'GET' }),
      () => err(apiError('not_found', 'Message delivery log not found', 404))
    )
  },

  async listMessageProviderEvents(eventId, campaignId) {
    return withFixture(
      async () => {
        const result = await request<{ items: AdminMessageProviderEvent[] }>(`/v1/events/${eventId}/messages/${campaignId}/provider-events`, { method: 'GET' })
        if (!result.ok) return result
        return ok(result.data.items)
      },
      () => ok([])
    )
  },

  async getMessageProviderEvent(eventId, campaignId, providerEventId) {
    return withFixture(
      () => request<AdminMessageProviderEvent>(`/v1/events/${eventId}/messages/${campaignId}/provider-events/${providerEventId}`, { method: 'GET' }),
      () => err(apiError('not_found', 'Message provider event not found', 404))
    )
  },

  // ---- Reports ----
  async getSalesReport(eventId, range) {
    const params = new URLSearchParams()
    if (range?.from) params.set('from', range.from)
    if (range?.to) params.set('to', range.to)
    const qs = params.toString()
    return withFixture(
      () => request<AdminSalesReportSummary>(`/v1/events/${eventId}/reports/sales${qs ? `?${qs}` : ''}`, { method: 'GET' }),
      () => ok(fixtureSalesReport(eventId, range))
    )
  },

  async getTaxReport(eventId, range) {
    const params = new URLSearchParams()
    if (range?.from) params.set('from', range.from)
    if (range?.to) params.set('to', range.to)
    const qs = params.toString()
    return withFixture(
      () => request<AdminTaxReport>(`/v1/events/${eventId}/reports/tax${qs ? `?${qs}` : ''}`, { method: 'GET' }),
      () => ok(fixtureTaxReport(eventId, range))
    )
  },

  async getAttendanceReport(eventId) {
    return withFixture(
      () => request<AdminAttendanceReport>(`/v1/events/${eventId}/reports/attendance`, { method: 'GET' }),
      () => ok(fixtureAttendanceReport(eventId))
    )
  },

  async getPromoReport(eventId) {
    return withFixture(
      () => request<AdminPromoReport>(`/v1/events/${eventId}/reports/promo`, { method: 'GET' }),
      () => ok(fixturePromoReport(eventId))
    )
  },

  async getConversionReport(eventId) {
    return withFixture(
      () => request<AdminConversionReport>(`/v1/events/${eventId}/reports/conversion`, { method: 'GET' }),
      () => ok(fixtureConversionReport(eventId))
    )
  },

  async getAffiliateReport(organizationId) {
    return withFixture(
      () => request<AdminAffiliateReport>(`/v1/organizations/${organizationId}/reports/affiliate`, { method: 'GET' }),
      () => ok(fixtureAffiliateReport(organizationId))
    )
  },

  async createExport(input) {
    return withFixture(
      async () => {
        const result = await request<AdminExportJob>('/v1/exports', {
          method: 'POST',
          headers: {
            'Idempotency-Key': newIdempotencyKey('export'),
          },
          body: JSON.stringify(input),
        })
        return result.ok ? ok(normalizeExportJob(result.data)) : result
      },
      () => {
        const job = normalizeExportJob({
          exportId: `exp_${Math.random().toString(36).slice(2, 11)}`,
          eventId: input.eventId,
          type: input.type,
          format: input.format,
          status: 'pending',
          createdAt: iso(0),
        })
        fixtureExportJobs.unshift(job)
        return ok(job)
      }
    )
  },

  async getExport(exportId) {
    return withFixture(
      async () => {
        const result = await request<AdminExportJob>(`/v1/exports/${exportId}`, { method: 'GET' })
        return result.ok ? ok(normalizeExportJob(result.data)) : result
      },
      () => {
        const job = fixtureExportJobs.find((item) => item.exportId === exportId)
        if (!job) return err<AdminExportJob>(apiError('not_found', 'Export job not found', 404))
        return ok(job)
      }
    )
  },

  // ---- API Keys ----
  async listApiKeys() {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminApiKey> | AdminApiKey[]>('/v1/api-keys', { method: 'GET' })
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureApiKeys)
    )
  },

  async createApiKey(input) {
    return withFixture(
      () => {
        if (!input.organizationId) {
          return Promise.resolve(err<AdminApiKey>(apiError(
            'missing_scope',
            'organizationId is required to create API keys. This is provided by the admin bootstrap context.',
            400
          )))
        }
        const organizationId = input.organizationId
        return request<AdminApiKey>('/v1/api-keys', {
          method: 'POST',
          body: JSON.stringify({
            organizationId,
            name: input.name,
            scopes: input.scopes ?? ['events.read', 'orders.read'],
          }),
        })
      },
      () => {
        const secret = `tk_live_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
        const scopes = input.scopes ?? ['events:read', 'events:write', 'orders:read']
        const key: AdminApiKey = {
          id: `key_${Math.random().toString(36).slice(2, 11)}`,
          name: input.name,
          keyPrefix: secret.slice(0, 10),
          createdAt: iso(0),
          // The full secret is returned once on creation by the backend.
          apiKey: secret,
          scopes,
        }
        fixtureApiKeys.unshift(key)
        return ok(key)
      }
    )
  },

  async revokeApiKey(apiKeyId) {
    return withFixture(
      () => request<AdminApiKey>(`/v1/api-keys/${apiKeyId}`, { method: 'DELETE' }),
      () => {
        const index = fixtureApiKeys.findIndex((k) => k.id === apiKeyId)
        if (index === -1) return err<AdminApiKey>(apiError('not_found', 'API key not found', 404))
        const [key] = fixtureApiKeys.splice(index, 1)
        return ok(key)
      }
    )
  },

  // ---- Webhooks ----
  async listWebhookEndpoints() {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminWebhookEndpoint> | AdminWebhookEndpoint[]>('/v1/webhook-endpoints', { method: 'GET' })
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureWebhooks)
    )
  },

  async createWebhookEndpoint(input) {
    return withFixture(
      () => {
        if (!input.organizationId) {
          return Promise.resolve(err<AdminWebhookEndpoint>(apiError(
            'missing_scope',
            'organizationId is required to create webhook endpoints. This is provided by the admin bootstrap context.',
            400
          )))
        }
        const organizationId = input.organizationId
        return request<AdminWebhookEndpoint>('/v1/webhook-endpoints', {
          method: 'POST',
          body: JSON.stringify({
            organizationId,
            url: input.url,
            events: input.events,
            description: input.description,
          }),
        })
      },
      () => {
        const endpoint: AdminWebhookEndpoint = {
          id: `wh_${Math.random().toString(36).slice(2, 11)}`,
          url: input.url,
          description: input.description,
          events: input.events,
          status: 'active',
          failureCount: 0,
          createdAt: iso(0),
        }
        fixtureWebhooks.unshift(endpoint)
        return ok(endpoint)
      }
    )
  },

  async updateWebhookEndpoint(webhookId, input) {
    return withFixture(
      () =>
        request<AdminWebhookEndpoint>(`/v1/webhook-endpoints/${webhookId}`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      () => {
        const endpoint = fixtureWebhooks.find((w) => w.id === webhookId)
        if (!endpoint)
          return err<AdminWebhookEndpoint>(apiError('not_found', 'Webhook endpoint not found', 404))
        Object.assign(endpoint, input)
        return ok(endpoint)
      }
    )
  },

  async listWebhookEvents(endpointId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminWebhookEvent> | AdminWebhookEvent[]>(
          `/v1/webhook-endpoints/${endpointId}/events`,
          { method: 'GET' }
        )
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureWebhookEvents.filter((e) => e.endpointId === endpointId))
    )
  },

  async replayWebhookEvent(eventId) {
    return withFixture(
      () => request<{ queued: true }>(`/v1/webhook-events/${eventId}/replay`, { method: 'POST' }),
      () => ok({ queued: true as const })
    )
  },
}

// ---------------------------------------------------------------------------
// React hook for permission-aware API access in client components
// ---------------------------------------------------------------------------
