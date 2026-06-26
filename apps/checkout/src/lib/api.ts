/**
 * Public buyer-facing API adapter for hosted checkout/event surfaces.
 *
 * This wraps the public + checkout endpoints owned by packages/api without
 * coupling the UI to fetch plumbing. All errors are normalized into
 * `CheckoutApiError` so components can render consistent error states.
 *
 * Backend contracts consumed (owned by Agent 1):
 *   GET  /v1/public/events/:eventId
 *   GET  /v1/public/events/:eventId/availability
 *   POST /v1/checkout/sessions                  (Idempotency-Key required)
 *   GET  /v1/checkout/sessions/:sessionId       (X-Checkout-Session-Token)
 *   PATCH /v1/checkout/sessions/:sessionId      (X-Checkout-Session-Token)
 *   POST /v1/checkout/sessions/:sessionId/confirm (Idempotency-Key + token)
 *
 */

export type PublicEvent = {
  id: string
  slug?: string
  title: string
  description?: string | null
  status: string
  timezone: string
  startsAt: string
  endsAt?: string | null
  venue?: {
    name?: string
    addressLine1?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
  } | null
  brandId?: string
  coverImageUrl?: string
}

export type AvailabilityItem = {
  ticketTypeId: string
  name: string
  description?: string
  kind: 'free' | 'paid' | 'donation'
  priceCents: number
  currency: string
  minimumPriceCents?: number
  minPerOrder: number
  maxPerOrder: number
  available: number
  status: string
  requiresAccessCode?: boolean
  accessCodeHint?: string
  salesStartAt?: string
  salesEndAt?: string
}

export type CheckoutQuote = {
  totalCents: number
  subtotalCents: number
  discountCents: number
  taxCents: number
  feeCents: number
  lineItems?: Array<{
    ticketTypeId?: string
    description: string
    quantity: number
    unitAmountCents?: number
    subtotalCents?: number
    discountCents?: number
    taxCents?: number
    feeCents?: number
    totalCents: number
  }>
}

export type CheckoutSession = {
  id: string
  eventId: string
  brandId?: string
  status: string
  currency: string
  clientToken?: string
  quote: CheckoutQuote
  expiresAt: string
  successUrl?: string | null
  cancelUrl?: string | null
  orderId?: string | null
}

export type OrderSummary = {
  id: string
  orderNumber?: string
  status: string
  currency: string
  totalCents: number
  buyerEmail?: string
  buyerFirstName?: string
  buyerLastName?: string
}

export type ConfirmResult =
  | { order: OrderSummary; sessionId: string; status: string }
  | {
      sessionId: string
      status: string
      paymentIntentId: string
      clientSecret?: string
      totalCents: number
      currency: string
    }

export type Buyer = {
  email: string
  firstName: string
  lastName: string
  phone: string
}

export type CartItem = {
  ticketTypeId: string
  quantity: number
  unitAmountCents?: number
  attendeeFields?: Record<string, unknown>[]
}

export type CheckoutQuestion = {
  id: string
  label: string
  type:
    | 'text'
    | 'textarea'
    | 'email'
    | 'phone'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'date'
    | 'waiver'
    | 'file'
  required: boolean
  options?: string[]
  placeholder?: string
  description?: string
  appliesTo: 'buyer' | 'attendee' | 'both'
  ticketTypeId?: string
  conditionalVisibility?: {
    field: string
    operator: 'equals' | 'not_equals' | 'contains'
    value: string
  }
  isConsentField?: boolean
  consentText?: string
  consentVersion?: string
}

export type QuestionsResponse = {
  buyerQuestions: CheckoutQuestion[]
  attendeeQuestions: CheckoutQuestion[]
}

export type AccessCodeValidationResponse = {
  valid: true
  ticketTypeIds: string[]
}

export type BrandViewModel = {
  id: string
  name: string
  slug?: string
  status: string
  theme: Record<string, string>
  supportUrl?: string
  legalUrls: {
    terms?: string
    privacy?: string
    refundPolicy?: string
  }
  whiteLabel: boolean
}

export class CheckoutApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'CheckoutApiError'
  }
}

const DEFAULT_API_BASE_URL = 'http://localhost:4000/v1'

export function apiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_GATEKIT_API_BASE_URL ?? DEFAULT_API_BASE_URL
  ).replace(/\/$/, '')
}

function idempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

function normalizeQuestionsResponse(value: unknown): QuestionsResponse {
  if (Array.isArray(value)) {
    const questions = value as CheckoutQuestion[]
    return {
      buyerQuestions: questions
        .filter(
          (question) =>
            question.appliesTo === 'buyer' || question.appliesTo === 'both',
        )
        .map((question) => ({ ...question, appliesTo: 'buyer' })),
      attendeeQuestions: questions
        .filter(
          (question) =>
            question.appliesTo === 'attendee' || question.appliesTo === 'both',
        )
        .map((question) => ({ ...question, appliesTo: 'attendee' })),
    }
  }

  const response = value as Partial<QuestionsResponse> | null
  return {
    buyerQuestions: Array.isArray(response?.buyerQuestions)
      ? response.buyerQuestions
      : [],
    attendeeQuestions: Array.isArray(response?.attendeeQuestions)
      ? response.attendeeQuestions
      : [],
  }
}

export function newCheckoutIdempotencyKey(): string {
  return idempotencyKey('checkout')
}

export function newConfirmIdempotencyKey(): string {
  return idempotencyKey('confirm')
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string; sessionToken?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  }
  if (init?.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey
  if (init?.sessionToken)
    headers['X-Checkout-Session-Token'] = init.sessionToken

  let response: Response
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers,
      signal: init?.signal,
    })
  } catch (err) {
    throw new CheckoutApiError(
      'NETWORK_ERROR',
      err instanceof Error
        ? `Could not reach the checkout service: ${err.message}`
        : 'Could not reach the checkout service',
      0,
    )
  }

  const text = await response.text()
  const data = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const error = (data ?? {}) as {
      error?: { code?: string; message?: string; requestId?: string }
    }
    throw new CheckoutApiError(
      error.error?.code ?? 'REQUEST_FAILED',
      error.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error.error?.requestId,
    )
  }

  return data as T
}

export const publicApi = {
  async getEvent(eventId: string, signal?: AbortSignal): Promise<PublicEvent> {
    return apiRequest<PublicEvent>(
      `/public/events/${encodeURIComponent(eventId)}`,
      { signal },
    )
  },

  async getAvailability(
    eventId: string,
    signal?: AbortSignal,
    products?: string,
  ): Promise<AvailabilityItem[]> {
    const params = new URLSearchParams()
    if (products) params.set('products', products)
    const query = params.toString()
    return apiRequest<AvailabilityItem[]>(
      `/public/events/${encodeURIComponent(eventId)}/availability${query ? `?${query}` : ''}`,
      { signal },
    )
  },

  async getQuestions(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<QuestionsResponse> {
    const response = await apiRequest<unknown>(
      `/public/events/${encodeURIComponent(eventId)}/questions`,
      { signal },
    )
    return normalizeQuestionsResponse(response)
  },

  async validateAccessCode(
    eventId: string,
    input: {
      ticketTypeIds: string[]
      accessCode: string
      buyerEmail?: string
    },
    signal?: AbortSignal,
  ): Promise<AccessCodeValidationResponse> {
    return apiRequest<AccessCodeValidationResponse>(
      `/public/events/${encodeURIComponent(eventId)}/access-code`,
      {
        method: 'POST',
        signal,
        body: JSON.stringify(input),
      },
    )
  },

  async getBrand(
    brandId: string,
    signal?: AbortSignal,
  ): Promise<BrandViewModel> {
    return apiRequest<BrandViewModel>(
      `/public/brands/${encodeURIComponent(brandId)}`,
      { signal },
    )
  },
}

export const checkoutApi = {
  async createSession(input: {
    eventId: string
    items: CartItem[]
    buyer: Partial<Buyer>
    buyerFields?: Record<string, unknown>
    discountCode?: string
    affiliateCode?: string
    trackingId?: string
    accessCode?: string
    successUrl?: string
    cancelUrl?: string
  }): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>('/checkout/sessions', {
      method: 'POST',
      idempotencyKey: newCheckoutIdempotencyKey(),
      body: JSON.stringify(input),
    })
  },

  async getSession(
    sessionId: string,
    sessionToken?: string,
    paymentIntentClientSecret?: string,
  ): Promise<CheckoutSession> {
    const query = paymentIntentClientSecret
      ? `?payment_intent_client_secret=${encodeURIComponent(paymentIntentClientSecret)}`
      : ''
    return apiRequest<CheckoutSession>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}${query}`,
      sessionToken ? { sessionToken } : undefined,
    )
  },

  async updateSession(
    sessionId: string,
    sessionToken: string,
    input: {
      buyer?: Partial<Buyer>
      successUrl?: string
      cancelUrl?: string
    },
  ): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'PATCH', sessionToken, body: JSON.stringify(input) },
    )
  },

  async confirmSession(
    sessionId: string,
    sessionToken: string,
  ): Promise<ConfirmResult> {
    return apiRequest<ConfirmResult>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/confirm`,
      {
        method: 'POST',
        idempotencyKey: newConfirmIdempotencyKey(),
        sessionToken,
        body: JSON.stringify({}),
      },
    )
  },
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof CheckoutApiError) {
    return (
      error.status === 0 ||
      error.status >= 500 ||
      error.code === 'NETWORK_ERROR' ||
      error.code === 'SERVICE_UNAVAILABLE'
    )
  }
  return false
}

export function userFacingMessage(error: unknown): string {
  if (error instanceof CheckoutApiError) {
    if (error.code === 'PAYMENT_FAILED') {
      return 'Payment could not be started. Please try again or use a different card.'
    }
    if (error.code === 'SERVICE_UNAVAILABLE') {
      return 'Checkout is preparing your payment. Please wait a moment and try again.'
    }
    if (error.code === 'CHECKOUT_EXPIRED') {
      return 'Your checkout session expired. Please start a new order.'
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong. Please try again.'
}
