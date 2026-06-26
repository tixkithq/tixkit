/**
 * AdminApi client for the GateKit admin dashboard.
 *
 * Calls the backend at `/v1/...`.
 *
 * Runtime fixture fallback is intentionally disabled. Local development uses
 * the real local API from `.env.local`; tests may still use the fixture helpers
 * below as test doubles.
 *
 * Function signatures match the final AdminApi contract from the
 * implementation plan. View-model types match the GateKit Domain Contracts.
 */

import { hasClerkKey } from '@/lib/auth'

declare global {
  interface Window {
    Clerk?: {
      loaded?: boolean
      load?: () => Promise<void>
      session?: {
        getToken: () => Promise<string | null>
      }
    }
  }
}

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
// View-model types (GateKit Domain Contracts)
// ---------------------------------------------------------------------------

export type EventStatus = 'draft' | 'published' | 'paused' | 'archived'

export type AdminEventListItem = {
  id: string
  title: string
  slug?: string
  status: EventStatus
  startsAt: string
  endsAt?: string
  timezone: string
  venueName?: string
  city?: string
  currency: string
  grossSalesCents: number
  ticketsSold: number
  capacity?: number
  checkIns: number
  updatedAt: string
}

export type TicketTypeStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'sold_out'
  | 'hidden'
  | 'archived'

export type AdminTicketType = {
  id: string
  eventId: string
  name: string
  status: TicketTypeStatus
  priceCents: number
  currency: string
  quantityTotal?: number
  quantitySold: number
  salesStartAt?: string
  salesEndAt?: string
  requiresAccessCode: boolean
  inventoryPoolId?: string
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
      attendee: AdminAttendeeListItem
      scannedAt: string
    }
  | {
      status: 'duplicate' | 'invalid' | 'revoked' | 'wrong_event'
      message: string
      attendee?: AdminAttendeeListItem
      scannedAt: string
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
  queuedCount: number
  sentCount: number
  deliveredCount: number
  failedCount: number
  suppressedCount: number
  scheduledAt?: string
  createdAt: string
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

function normalizeMessageCampaign(campaign: BackendMessageCampaign): AdminMessageCampaign {
  const queuedCount = Number(campaign.queuedEmailJobs ?? 0) + Number(campaign.queuedSmsJobs ?? 0)
  const sentCount = Number(campaign.sentCount ?? (campaign.status === 'sent' ? queuedCount : 0))
  const deliveredCount = Number(campaign.deliveredCount ?? 0)
  const failedCount = Number(campaign.failedCount ?? (campaign.status === 'failed' ? queuedCount : 0))
  const suppressedCount = Number(campaign.suppressedRecipients ?? 0)
  return {
    id: campaign.id,
    eventId: campaign.eventId,
    name: campaign.templateKey ?? campaign.id,
    channel: campaign.channel,
    status: campaign.status,
    audience: 'all_attendees',
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
  widgetViews: number | null
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
 * GateKit principal resolved after Clerk authentication.
 * Returned by `GET /v1/me`. Permissions drive route/nav gating.
 */
export type GateKitPrincipal = {
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
  endsAt?: string
  timezone: string
  venueName?: string
  address?: string
  currency: string
}

export type UpdateEventInput = Partial<CreateEventInput> & {
  status?: EventStatus
}

export type CreateTicketTypeInput = {
  name: string
  description?: string
  kind?: 'free' | 'paid' | 'donation'
  inventoryPoolId?: string
  priceCents: number
  currency: string
  quantityTotal?: number
  salesStartAt?: string
  salesEndAt?: string
  requiresAccessCode?: boolean
}

export type CreateInventoryPoolInput = {
  name: string
  totalCapacity: number
  holdTtlSeconds?: number
}

export type UpdateTicketTypeInput = Partial<CreateTicketTypeInput> & {
  status?: TicketTypeStatus
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
  /** Resolves the authenticated GateKit principal + permissions (`GET /v1/me`). */
  getPrincipal(token?: string): Promise<ApiResult<GateKitPrincipal>>

  listOrganizations(): Promise<ApiResult<AdminOrganization[]>>
  updateOrganization(organizationId: string, input: UpdateOrganizationInput): Promise<ApiResult<AdminOrganization>>
  listBrands(): Promise<ApiResult<AdminBrand[]>>
  updateBrand(brandId: string, input: UpdateBrandInput): Promise<ApiResult<AdminBrand>>
  addBrandDomain(brandId: string, domain: string, isPrimary?: boolean): Promise<ApiResult<AdminBrandDomain>>
  listTeamMembers(organizationId: string): Promise<ApiResult<AdminTeamMember[]>>
  inviteTeamMember(organizationId: string, input: InviteTeamMemberInput): Promise<ApiResult<AdminTeamMember>>
  listPaymentAccounts(organizationId: string): Promise<ApiResult<AdminPaymentAccount[]>>
  createStripeConnectAccount(organizationId: string): Promise<ApiResult<AdminPaymentAccount>>
  getBillingOverview(organizationId: string): Promise<ApiResult<AdminBillingOverview>>

  listEvents(input?: PageCursor): Promise<ApiResult<PageResult<AdminEventListItem>>>
  getEvent(eventId: string): Promise<ApiResult<AdminEventListItem>>
  createEvent(input: CreateEventInput): Promise<ApiResult<AdminEventListItem>>
  updateEvent(eventId: string, input: UpdateEventInput): Promise<ApiResult<AdminEventListItem>>
  publishEvent(eventId: string): Promise<ApiResult<AdminEventListItem>>
  pauseEvent(eventId: string): Promise<ApiResult<AdminEventListItem>>
  archiveEvent(eventId: string): Promise<ApiResult<AdminEventListItem>>

  listTicketTypes(eventId: string): Promise<ApiResult<AdminTicketType[]>>
  createTicketType(eventId: string, input: CreateTicketTypeInput): Promise<ApiResult<AdminTicketType>>
  updateTicketType(ticketTypeId: string, input: UpdateTicketTypeInput): Promise<ApiResult<AdminTicketType>>
  createInventoryPool(eventId: string, input: CreateInventoryPoolInput): Promise<ApiResult<AdminInventoryPool>>
  listCheckoutQuestions(eventId: string): Promise<ApiResult<AdminCheckoutQuestion[]>>
  createCheckoutQuestion(eventId: string, input: CreateCheckoutQuestionInput): Promise<ApiResult<AdminCheckoutQuestion>>
  updateCheckoutQuestion(questionId: string, input: UpdateCheckoutQuestionInput): Promise<ApiResult<AdminCheckoutQuestion>>
  deleteCheckoutQuestion(questionId: string): Promise<ApiResult<void>>

  listOrders(input?: PageCursor & { eventId?: string }): Promise<ApiResult<PageResult<AdminOrderListItem>>>
  getOrder(orderId: string): Promise<ApiResult<AdminOrderDetail>>
  cancelOrder(orderId: string): Promise<ApiResult<AdminOrderListItem>>
  refundOrder(orderId: string, input: RefundOrderInput): Promise<ApiResult<RefundOrderResult>>

  listAttendees(input: PageCursor & { eventId?: string }): Promise<ApiResult<PageResult<AdminAttendeeListItem>>>
  updateAttendee(attendeeId: string, input: UpdateAttendeeInput): Promise<ApiResult<AdminAttendeeListItem>>
  listCheckInLists(eventId: string): Promise<ApiResult<AdminCheckInList[]>>
  scanTicket(input: ScanTicketInput): Promise<ApiResult<CheckInScanResult>>

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

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://localhost:4000'
).replace(/\/$/, '')
const DEFAULT_TIMEOUT_MS = 15_000
const CLERK_TOKEN_WAIT_MS = 5_000
const FIXTURES_ALLOWED = process.env.NODE_ENV === 'test'

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

async function getClerkToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null

  // When no Clerk publishable key is configured, skip polling entirely.
  // This prevents the 5-second wait on every request in local dev mode.
  if (!hasClerkKey()) return null

  // Clerk is configured. Wait briefly for it to load if it hasn't yet.
  const startedAt = Date.now()
  while (!window.Clerk && Date.now() - startedAt < CLERK_TOKEN_WAIT_MS) {
    // Intentional sequential wait: we need Clerk to load before proceeding.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }

  const clerk = window.Clerk
  if (!clerk) return null

  if (!clerk.loaded && typeof clerk.load === 'function') {
    const timeout = new Promise<void>((resolve) => {
      window.setTimeout(resolve, CLERK_TOKEN_WAIT_MS)
    })
    await Promise.race([clerk.load().catch(() => undefined), timeout])
  }

  return clerk.session?.getToken() ?? null
}

export function getAdminApiBaseUrl(): string {
  return API_BASE_URL
}

export async function getAdminApiAuthHeaders(
  headers: Record<string, string> = {}
): Promise<Record<string, string>> {
  const resolvedHeaders = { ...headers }
  if (!resolvedHeaders.Authorization && typeof window !== 'undefined') {
    const clerkToken = await getClerkToken()
    if (clerkToken) {
      resolvedHeaders.Authorization = `Bearer ${clerkToken}`
    }
  }
  return resolvedHeaders
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const url = `${API_BASE_URL}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    }

    if (!headers.Authorization && typeof window !== 'undefined') {
      const clerkToken = await getClerkToken()
      if (clerkToken) {
        headers.Authorization = `Bearer ${clerkToken}`
      }
    }

    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      credentials: 'include',
    })

    clearTimeout(timeout)

    if (res.status === 204) {
      return ok(undefined as T)
    }

    const json = await res.json().catch(() => null)

    if (!res.ok) {
      const body = json as { error?: { code?: string; message?: string; details?: unknown } } | null
      return err<T>(
        apiError(
          body?.error?.code ?? 'http_error',
          body?.error?.message ?? `Request failed with status ${res.status}`,
          res.status,
          body?.error?.details
        )
      )
    }

    return ok(json as T)
  } catch (e) {
    clearTimeout(timeout)
    if (e instanceof Error) {
      if (e.name === 'AbortError') {
        return err<T>(apiError('timeout', 'The request timed out'))
      }
      return err<T>(apiError('network_error', e.message))
    }
    return err<T>(apiError('unknown', 'An unknown error occurred'))
  }
}

/**
 * Uses fixture providers only under the test runner. Browser/runtime code must
 * call the configured API and surface real failures.
 */
async function withFixture<T>(
  call: () => Promise<ApiResult<T>>,
  fixture: () => Promise<ApiResult<T>> | ApiResult<T>
): Promise<ApiResult<T>> {
  if (FIXTURES_ALLOWED) {
    return Promise.resolve(fixture()).then((f) => f)
  }
  return call()
}


function unwrapPage<T>(value: PageResult<T> | T[]): PageResult<T> {
  return Array.isArray(value) ? { items: value, total: value.length } : value
}

function unwrapItems<T>(value: PageResult<T> | T[]): T[] {
  return Array.isArray(value) ? value : value.items
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
    name: stringValue(value.name, email.split('@')[0] || 'Team member'),
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

function normalizeEvent(value: Partial<AdminEventListItem> & Record<string, unknown>): AdminEventListItem {
  const venue = value.venue as { name?: unknown; city?: unknown } | undefined
  return {
    id: String(value.id),
    title: String(value.title ?? 'Untitled event'),
    slug: typeof value.slug === 'string' ? value.slug : undefined,
    status: (value.status as EventStatus | undefined) ?? 'draft',
    startsAt: String(value.startsAt ?? value.createdAt ?? new Date(0).toISOString()),
    endsAt: typeof value.endsAt === 'string' ? value.endsAt : undefined,
    timezone: String(value.timezone ?? 'UTC'),
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
    currency: typeof value.currency === 'string' ? value.currency : 'USD',
    grossSalesCents: finiteNumber(value.grossSalesCents),
    ticketsSold: finiteNumber(value.ticketsSold),
    capacity: value.capacity == null ? undefined : finiteNumber(value.capacity),
    checkIns: finiteNumber(value.checkIns),
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
      ? `${API_BASE_URL}${downloadUrl}`
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

const fixtureEvents: AdminEventListItem[] = [
  {
    id: 'evt_demo_001',
    title: 'Summer Music Festival 2026',
    slug: 'summer-music-festival-2026',
    status: 'published',
    startsAt: daysFromNow(14),
    endsAt: daysFromNow(15),
    timezone: 'America/New_York',
    venueName: 'Riverside Amphitheater',
    city: 'Austin',
    currency: 'USD',
    grossSalesCents: 482_500,
    ticketsSold: 193,
    capacity: 500,
    checkIns: 0,
    updatedAt: iso(-3_600_000),
  },
  {
    id: 'evt_demo_002',
    title: 'TechConf 2026',
    slug: 'techconf-2026',
    status: 'published',
    startsAt: daysFromNow(30),
    endsAt: daysFromNow(32),
    timezone: 'America/Los_Angeles',
    venueName: 'Moscone Center',
    city: 'San Francisco',
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
    startsAt: daysFromNow(45),
    timezone: 'Europe/London',
    venueName: 'Borough Market',
    city: 'London',
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
    startsAt: daysFromNow(-7),
    endsAt: daysFromNow(-6),
    timezone: 'Asia/Tokyo',
    venueName: 'Akihabara Hall',
    city: 'Tokyo',
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
    startsAt: daysFromNow(-90),
    endsAt: daysFromNow(-90),
    timezone: 'America/Chicago',
    venueName: 'Grand Ballroom',
    city: 'Chicago',
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
    keyPrefix: 'gk_live_ab',
    scopes: [],
    lastUsedAt: iso(-3_600_000),
    expiresAt: undefined,
    createdAt: iso(-2_592_000_000),
  },
  {
    id: 'key_002',
    name: 'CI/CD Pipeline',
    keyPrefix: 'gk_test_cd',
    scopes: [],
    lastUsedAt: iso(-86_400_000),
    expiresAt: undefined,
    createdAt: iso(-1_296_000_000),
  },
]

const fixtureWebhooks: AdminWebhookEndpoint[] = [
  {
    id: 'wh_001',
    url: 'https://example.com/webhooks/gatekit',
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
const fixturePrincipal: GateKitPrincipal = {
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
    name: 'GateKit',
    slug: 'gatekit',
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
    name: 'GateKit',
    slug: 'gatekit',
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
    widgetViews: checkoutStarted,
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
      () => request<GateKitPrincipal>('/v1/me', {
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
        if (!organization) return err<AdminOrganization>(apiError('not_found', 'Organization not found', 404))
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

  async getBillingOverview(organizationId) {
    return withFixture(
      async () => {
        const result = await request<AdminBillingOverview>(`/v1/organizations/${organizationId}/billing`, { method: 'GET' })
        return result.ok ? ok(normalizeBillingOverview(asRecord(result.data), organizationId)) : result
      },
      () => ok({ ...fixtureBillingOverview, organizationId })
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
        const result = await request<AdminEventListItem>(`/v1/events/${eventId}`, { method: 'GET' })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventListItem>(apiError('not_found', 'Event not found', 404))
        return ok(event)
      }
    )
  },

  async createEvent(input) {
    return withFixture(
      async () => {
        if (!input.organizationId || !input.brandId) {
          return Promise.resolve(err<AdminEventListItem>(apiError(
            'missing_scope',
            'organizationId and brandId are required to create events. These are provided by the admin bootstrap context.',
            400
          )))
        }
        const organizationId = input.organizationId
        const brandId = input.brandId
        const result = await request<AdminEventListItem>('/v1/events', {
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
            venue: {
              name: input.venueName,
              address: input.address,
            },
          }),
        })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const newEvent: AdminEventListItem = {
          id: `evt_${Math.random().toString(36).slice(2, 11)}`,
          title: input.title,
          slug: input.slug ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          status: 'draft',
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          timezone: input.timezone,
          venueName: input.venueName,
          city: undefined,
          currency: input.currency,
          grossSalesCents: 0,
          ticketsSold: 0,
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
        if (input.status !== undefined) body.status = input.status

        const result = await request<AdminEventListItem>(`/v1/events/${eventId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
        return result.ok ? ok(normalizeEvent(result.data)) : result
      },
      () => {
        const event = fixtureEvents.find((e) => e.id === eventId)
        if (!event) return err<AdminEventListItem>(apiError('not_found', 'Event not found', 404))
        const updated = { ...event, ...input, updatedAt: iso(0) }
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

  // ---- Ticket Types ----
  async listTicketTypes(eventId) {
    return withFixture(
      async () => {
        const result = await request<PageResult<AdminTicketType> | AdminTicketType[]>(`/v1/events/${eventId}/ticket-types`, { method: 'GET' })
        return result.ok ? ok(unwrapItems(result.data)) : result
      },
      () => ok(fixtureTicketTypes[eventId] ?? [])
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
            kind: input.kind ?? (input.priceCents > 0 ? 'paid' : 'free'),
            currency: input.currency,
            priceCents: input.priceCents,
            inventoryPoolId: input.inventoryPoolId,
            salesStartAt: input.salesStartAt,
            salesEndAt: input.salesEndAt,
            requiresAccessCode: input.requiresAccessCode,
          }),
        })
      },
      () => {
        const newTt: AdminTicketType = {
          id: `tt_${Math.random().toString(36).slice(2, 11)}`,
          eventId,
          name: input.name,
          status: 'draft',
          priceCents: input.priceCents,
          currency: input.currency,
          quantityTotal: input.quantityTotal,
          quantitySold: 0,
          salesStartAt: input.salesStartAt,
          salesEndAt: input.salesEndAt,
          requiresAccessCode: input.requiresAccessCode ?? false,
          inventoryPoolId: input.inventoryPoolId,
        }
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
        return ok(found)
      }
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
      () => {
        if (!input.checkInListId) {
          return Promise.resolve(err<CheckInScanResult>(apiError(
            'missing_check_in_list',
            'checkInListId is required to scan tickets against the live API.',
            400
          )))
        }
        return request<CheckInScanResult>('/v1/check-ins/scan', {
          method: 'POST',
          body: JSON.stringify({
            checkInListId: input.checkInListId,
            qrPayload: input.qrPayload,
            scannedAt: input.scannedAt ?? new Date().toISOString(),
            deviceId: input.deviceId,
          }),
        })
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
        const secret = `gk_live_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
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

export { hasClerkKey }
