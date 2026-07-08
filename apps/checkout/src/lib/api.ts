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

import type { ResolvedEventPage } from '@tixkit/content-event-page';

export type PublicEvent = {
  id: string;
  slug?: string;
  title: string;
  description?: string | null;
  status: string;
  timezone: string;
  startsAt: string;
  endsAt?: string | null;
  venue?: {
    name?: string;
    addressLine1?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  } | null;
  brandId?: string;
  coverImageUrl?: string;
  marketingIntegrations?: MarketingIntegration[];
};

export type MarketingIntegration = {
  provider: 'ga4' | 'meta_pixel' | 'generic_tag';
  config: Record<string, unknown>;
  consentRequired: boolean;
  status: string;
};

export type AvailabilityItem = {
  type?: 'ticket' | 'product' | 'resale';
  ticketTypeId?: string;
  eventOccurrenceId?: string;
  productId?: string;
  resaleListingId?: string;
  name: string;
  description?: string;
  kind: 'free' | 'paid' | 'donation' | 'product' | 'resale';
  priceCents: number;
  currency: string;
  minimumPriceCents?: number;
  minPerOrder: number;
  maxPerOrder: number;
  available: number;
  status: string;
  requiresAccessCode?: boolean;
  accessCodeHint?: string;
  salesStartAt?: string;
  salesEndAt?: string;
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
    renderModel?: ResolvedEventPage;
    discovery: PublicEventDiscoveryCard;
  };
};

export type DraftPreviewPage = {
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
    status: string;
    subject?: string;
    previewText?: string;
  };
  contentJson: unknown;
  context: Record<string, unknown>;
  renderModel?: ResolvedEventPage;
  validation: { valid: boolean; severity: string; issues: unknown[] };
};

export type CheckoutQuote = {
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  buyerFeeCents?: number;
  organizerAbsorbedFeeCents?: number;
  lineItems?: Array<{
    type?: string;
    ticketTypeId?: string;
    productId?: string;
    resaleListingId?: string;
    description: string;
    name?: string;
    quantity: number;
    unitPriceCents?: number;
    unitAmountCents?: number;
    subtotalCents?: number;
    discountCents?: number;
    taxCents?: number;
    feeCents?: number;
    buyerFeeCents?: number;
    organizerAbsorbedFeeCents?: number;
    totalCents: number;
  }>;
};

export type CheckoutSession = {
  id: string;
  eventId: string;
  brandId?: string;
  status: string;
  currency: string;
  clientToken?: string;
  quote: CheckoutQuote;
  expiresAt: string;
  successUrl?: string | null;
  cancelUrl?: string | null;
  orderId?: string | null;
  paymentCompensation?: CheckoutPaymentCompensation;
};

export type CheckoutPaymentCompensation = {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'manual_review' | 'already_ordered' | string;
  action: string;
  provider: string;
  providerIntentId: string;
  providerCompensationId?: string | null;
  attempts: number;
  reason: string;
  lastError?: string | null;
  updatedAt: string;
};

export type CheckoutWalletPassTicket = {
  ticketId: string;
  ticketCode: string;
  faceValueCents: number;
  currency: string;
  resaleEnabled: boolean;
  resaleMaxPriceCents: number;
  activeResaleListing?: CheckoutResaleListing;
  appleUrl?: string;
  googleUrl?: string;
};

export type CheckoutWalletPasses = {
  tickets: CheckoutWalletPassTicket[];
};

export type CheckoutResaleListing = {
  id: string;
  eventId: string;
  tenantId?: string;
  ticketId: string;
  ticketTypeId?: string;
  ticketTypeName?: string;
  sellerId?: string;
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

export type CheckoutPublicResaleListing = {
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

export type CheckoutResaleListingsResponse = {
  items: CheckoutPublicResaleListing[];
  nextCursor?: string | null;
  hasMore?: boolean;
};

export type UploadArtifact = {
  artifactId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeUrl: string;
  completeToken?: string;
  expiresAt: string;
};

export type OrderSummary = {
  id: string;
  orderNumber?: string;
  status: string;
  currency: string;
  totalCents: number;
  buyerEmail?: string;
  buyerFirstName?: string;
  buyerLastName?: string;
};

export type ConfirmResult =
  | { order: OrderSummary; sessionId: string; status: string }
  | {
      sessionId: string;
      status: string;
      paymentIntentId: string;
      clientSecret?: string;
      totalCents: number;
      currency: string;
    };

export type Buyer = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
};

export type CartItem = {
  ticketTypeId?: string;
  occurrenceId?: string;
  productId?: string;
  resaleListingId?: string;
  quantity: number;
  unitAmountCents?: number;
  attendeeFields?: Record<string, unknown>[];
};

export type PublicEventOccurrence = {
  id: string;
  eventId: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  timezone: string;
  venue?: PublicEvent['venue'];
  capacity?: number | null;
  sortOrder: number;
  status: string;
};

export type CheckoutQuestion = {
  id: string;
  label: string;
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
    | 'file';
  required: boolean;
  options?: string[];
  placeholder?: string;
  description?: string;
  appliesTo: 'buyer' | 'attendee' | 'both';
  ticketTypeId?: string;
  conditionalVisibility?: {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains';
    value: string;
  };
  isConsentField?: boolean;
  consentText?: string;
  consentVersion?: string;
  validationPattern?: string;
};

export type QuestionsResponse = {
  buyerQuestions: CheckoutQuestion[];
  attendeeQuestions: CheckoutQuestion[];
};

export type PublicCheckoutBootstrap = {
  event: PublicEvent;
  availability: AvailabilityItem[];
  questions: QuestionsResponse;
  resaleListing?: CheckoutPublicResaleListing | null;
};

export type PublicEventPageBootstrap = {
  event: PublicEvent;
  contentPage: PublicContentPage | null;
  availability: AvailabilityItem[];
  resaleListings: CheckoutResaleListingsResponse;
};

export type AccessCodeValidationResponse = {
  valid: true;
  ticketTypeIds: string[];
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
  status: string;
  offerExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type BrandViewModel = {
  id: string;
  name: string;
  slug?: string;
  status: string;
  theme: Record<string, string>;
  supportUrl?: string;
  legalUrls: {
    terms?: string;
    privacy?: string;
    refundPolicy?: string;
  };
  whiteLabel: boolean;
};

export class CheckoutApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'CheckoutApiError';
  }
}

const DEFAULT_API_BASE_URL = 'http://localhost:4000/v1';

export function apiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_TIXKIT_API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
}

function idempotencyKey(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizeQuestionsResponse(value: unknown): QuestionsResponse {
  if (Array.isArray(value)) {
    const questions = value as CheckoutQuestion[];
    return {
      buyerQuestions: questions
        .filter((question) => question.appliesTo === 'buyer' || question.appliesTo === 'both')
        .map((question) => Object.assign({}, question, { appliesTo: 'buyer' as const })),
      attendeeQuestions: questions
        .filter((question) => question.appliesTo === 'attendee' || question.appliesTo === 'both')
        .map((question) => Object.assign({}, question, { appliesTo: 'attendee' as const })),
    };
  }

  const response = value as Partial<QuestionsResponse> | null;
  return {
    buyerQuestions: Array.isArray(response?.buyerQuestions) ? response.buyerQuestions : [],
    attendeeQuestions: Array.isArray(response?.attendeeQuestions) ? response.attendeeQuestions : [],
  };
}

function parseApiResponseBody(text: string, status: number): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (status >= 400) return null;
    throw new CheckoutApiError(
      'INVALID_RESPONSE',
      'Checkout service returned an invalid response. Please try again.',
      status,
    );
  }
}

export function newCheckoutIdempotencyKey(): string {
  return idempotencyKey('checkout');
}

export function newConfirmIdempotencyKey(): string {
  return idempotencyKey('confirm');
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit & { idempotencyKey?: string; sessionToken?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };
  if (init?.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  if (init?.sessionToken) headers['X-Checkout-Session-Token'] = init.sessionToken;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers,
      signal: init?.signal,
    });
  } catch (err) {
    throw new CheckoutApiError(
      'NETWORK_ERROR',
      err instanceof Error
        ? `Could not reach the checkout service: ${err.message}`
        : 'Could not reach the checkout service',
      0,
    );
  }

  const text = await response.text();
  const data = parseApiResponseBody(text, response.status);

  if (!response.ok) {
    const error = (data ?? {}) as {
      error?: { code?: string; message?: string; requestId?: string };
    };
    throw new CheckoutApiError(
      error.error?.code ?? 'REQUEST_FAILED',
      error.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error.error?.requestId,
    );
  }

  return data as T;
}

export const publicApi = {
  async getEvent(eventId: string, signal?: AbortSignal): Promise<PublicEvent> {
    return apiRequest<PublicEvent>(`/public/events/${encodeURIComponent(eventId)}`, { signal });
  },

  async getEventBySlug(slug: string, host: string, signal?: AbortSignal): Promise<PublicEvent> {
    const params = new URLSearchParams({ host });
    return apiRequest<PublicEvent>(
      `/public/events/by-slug/${encodeURIComponent(slug)}?${params.toString()}`,
      { signal },
    );
  },

  async getEventPage(
    eventId: string,
    signal?: AbortSignal,
    locale?: string,
  ): Promise<PublicContentPage> {
    const params = new URLSearchParams();
    if (locale) params.set('locale', locale);
    const query = params.toString();
    return apiRequest<PublicContentPage>(
      `/public/events/${encodeURIComponent(eventId)}/page${query ? `?${query}` : ''}`,
      { signal },
    );
  },

  async getEventPageBySlug(
    slug: string,
    host: string,
    signal?: AbortSignal,
    locale?: string,
  ): Promise<PublicContentPage> {
    const params = new URLSearchParams({ host });
    if (locale) params.set('locale', locale);
    return apiRequest<PublicContentPage>(
      `/public/events/by-slug/${encodeURIComponent(slug)}/page?${params.toString()}`,
      { signal },
    );
  },

  async getEventPageBootstrap(
    eventId: string,
    signal?: AbortSignal,
    locale?: string,
  ): Promise<PublicEventPageBootstrap> {
    const params = new URLSearchParams();
    if (locale) params.set('locale', locale);
    const query = params.toString();
    const response = await apiRequest<{
      event: PublicEvent;
      contentPage?: PublicContentPage | null;
      availability?: AvailabilityItem[];
      resaleListings?: CheckoutResaleListingsResponse;
    }>(`/public/events/${encodeURIComponent(eventId)}/page-bootstrap${query ? `?${query}` : ''}`, {
      signal,
    });
    return {
      event: response.event,
      contentPage: response.contentPage ?? null,
      availability: Array.isArray(response.availability) ? response.availability : [],
      resaleListings: response.resaleListings ?? { items: [], nextCursor: null, hasMore: false },
    };
  },

  async getEventPageBootstrapBySlug(
    slug: string,
    host: string,
    signal?: AbortSignal,
    locale?: string,
  ): Promise<PublicEventPageBootstrap> {
    const params = new URLSearchParams({ host });
    if (locale) params.set('locale', locale);
    const response = await apiRequest<{
      event: PublicEvent;
      contentPage?: PublicContentPage | null;
      availability?: AvailabilityItem[];
      resaleListings?: CheckoutResaleListingsResponse;
    }>(`/public/events/by-slug/${encodeURIComponent(slug)}/page-bootstrap?${params.toString()}`, {
      signal,
    });
    return {
      event: response.event,
      contentPage: response.contentPage ?? null,
      availability: Array.isArray(response.availability) ? response.availability : [],
      resaleListings: response.resaleListings ?? { items: [], nextCursor: null, hasMore: false },
    };
  },

  async getDraftPreview(
    eventId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<DraftPreviewPage> {
    const params = new URLSearchParams({ token });
    return apiRequest<DraftPreviewPage>(
      `/public/events/${encodeURIComponent(eventId)}/draft-preview?${params.toString()}`,
      { signal },
    );
  },

  async getAvailability(
    eventId: string,
    signal?: AbortSignal,
    products?: string,
  ): Promise<AvailabilityItem[]> {
    const params = new URLSearchParams();
    if (products) params.set('products', products);
    const query = params.toString();
    return apiRequest<AvailabilityItem[]>(
      `/public/events/${encodeURIComponent(eventId)}/availability${query ? `?${query}` : ''}`,
      { signal },
    );
  },

  async getCheckoutBootstrap(
    eventId: string,
    signal?: AbortSignal,
    input?: { products?: string; resaleListingId?: string },
  ): Promise<PublicCheckoutBootstrap> {
    const params = new URLSearchParams();
    if (input?.products) params.set('products', input.products);
    if (input?.resaleListingId) params.set('resaleListingId', input.resaleListingId);
    const query = params.toString();
    const response = await apiRequest<{
      event: PublicEvent;
      availability?: AvailabilityItem[];
      questions?: unknown;
      resaleListing?: CheckoutPublicResaleListing | null;
    }>(`/public/events/${encodeURIComponent(eventId)}/bootstrap${query ? `?${query}` : ''}`, {
      signal,
    });
    return {
      event: response.event,
      availability: Array.isArray(response.availability) ? response.availability : [],
      questions: normalizeQuestionsResponse(response.questions),
      resaleListing: response.resaleListing ?? null,
    };
  },

  async getResaleListings(
    eventId: string,
    signal?: AbortSignal,
    params?: { cursor?: string | null; limit?: number },
  ): Promise<CheckoutResaleListingsResponse> {
    const queryParams = new URLSearchParams();
    if (params?.cursor) queryParams.set('cursor', params.cursor);
    if (params?.limit) queryParams.set('limit', String(params.limit));
    const query = queryParams.toString();
    return apiRequest<CheckoutResaleListingsResponse>(
      `/public/events/${encodeURIComponent(eventId)}/resale-listings${query ? `?${query}` : ''}`,
      { signal },
    );
  },

  async getOccurrences(eventId: string, signal?: AbortSignal): Promise<PublicEventOccurrence[]> {
    const response = await apiRequest<
      { items?: PublicEventOccurrence[] } | PublicEventOccurrence[]
    >(`/public/events/${encodeURIComponent(eventId)}/occurrences`, { signal });
    return Array.isArray(response) ? response : (response.items ?? []);
  },

  async getMarketingIntegrations(
    eventId: string,
    signal?: AbortSignal,
  ): Promise<MarketingIntegration[]> {
    const response = await apiRequest<{ items?: MarketingIntegration[] } | MarketingIntegration[]>(
      `/public/events/${encodeURIComponent(eventId)}/marketing-integrations`,
      { signal },
    );
    return Array.isArray(response) ? response : (response.items ?? []);
  },

  async getQuestions(eventId: string, signal?: AbortSignal): Promise<QuestionsResponse> {
    const response = await apiRequest<unknown>(
      `/public/events/${encodeURIComponent(eventId)}/questions`,
      { signal },
    );
    return normalizeQuestionsResponse(response);
  },

  async getEventRevision(eventId: string, signal?: AbortSignal): Promise<string | null> {
    const response = await apiRequest<{ revision: string | null }>(
      `/public/events/${encodeURIComponent(eventId)}/revision`,
      { signal },
    );
    return response.revision;
  },

  async uploadCheckoutArtifact(
    eventId: string,
    file: File,
    questionId: string,
  ): Promise<{ artifactId: string; fileName: string; contentType: string; sizeBytes: number }> {
    const artifact = await apiRequest<UploadArtifact>(
      `/public/events/${encodeURIComponent(eventId)}/upload-artifacts`,
      {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          questionId,
        }),
      },
    );
    const uploadResponse = await fetch(artifact.uploadUrl, {
      method: 'PUT',
      headers: artifact.uploadHeaders,
      body: file,
    });
    if (!uploadResponse.ok) {
      throw new CheckoutApiError('UPLOAD_FAILED', 'File upload failed', uploadResponse.status);
    }
    await apiRequest(artifact.completeUrl.replace(/^\/v1/, ''), {
      method: 'POST',
      body: JSON.stringify({ token: artifact.completeToken }),
    });
    return {
      artifactId: artifact.artifactId,
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    };
  },

  async validateAccessCode(
    eventId: string,
    input: {
      ticketTypeIds: string[];
      accessCode: string;
      buyerEmail?: string;
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
    );
  },

  async joinWaitlist(
    eventId: string,
    input: {
      ticketTypeId: string;
      email: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      quantity?: number;
    },
    signal?: AbortSignal,
  ): Promise<WaitlistEntry> {
    return apiRequest<WaitlistEntry>(`/public/events/${encodeURIComponent(eventId)}/waitlist`, {
      method: 'POST',
      signal,
      body: JSON.stringify(input),
    });
  },

  async getWaitlistClaim(token: string, signal?: AbortSignal): Promise<WaitlistEntry> {
    return apiRequest<WaitlistEntry>(`/public/waitlist/claims/${encodeURIComponent(token)}`, {
      signal,
    });
  },

  async getBrand(brandId: string, signal?: AbortSignal): Promise<BrandViewModel> {
    return apiRequest<BrandViewModel>(`/public/brands/${encodeURIComponent(brandId)}`, { signal });
  },
};

export const checkoutApi = {
  async createSession(input: {
    eventId: string;
    items: CartItem[];
    buyer: Partial<Buyer>;
    buyerFields?: Record<string, unknown>;
    discountCode?: string;
    affiliateCode?: string;
    trackingId?: string;
    accessCode?: string;
    waitlistClaimToken?: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>('/checkout/sessions', {
      method: 'POST',
      idempotencyKey: newCheckoutIdempotencyKey(),
      body: JSON.stringify(input),
    });
  },

  async getSession(
    sessionId: string,
    sessionToken?: string,
    paymentIntentClientSecret?: string,
  ): Promise<CheckoutSession> {
    const query = paymentIntentClientSecret
      ? `?payment_intent_client_secret=${encodeURIComponent(paymentIntentClientSecret)}`
      : '';
    return apiRequest<CheckoutSession>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}${query}`,
      sessionToken ? { sessionToken } : undefined,
    );
  },

  async getWalletPasses(sessionId: string, sessionToken: string): Promise<CheckoutWalletPasses> {
    return apiRequest<CheckoutWalletPasses>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/wallet-passes`,
      { sessionToken },
    );
  },

  async createResaleListing(
    sessionId: string,
    ticketId: string,
    sessionToken: string,
    input: { priceCents: number; expiresAt?: string; idempotencyKey: string },
  ): Promise<CheckoutResaleListing> {
    return apiRequest<CheckoutResaleListing>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/tickets/${encodeURIComponent(
        ticketId,
      )}/resale-listing`,
      {
        method: 'POST',
        sessionToken,
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({
          priceCents: input.priceCents,
          expiresAt: input.expiresAt,
        }),
      },
    );
  },

  async updateSession(
    sessionId: string,
    sessionToken: string,
    input: {
      buyer?: Partial<Buyer>;
      successUrl?: string;
      cancelUrl?: string;
    },
  ): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      sessionToken,
      body: JSON.stringify(input),
    });
  },

  async confirmSession(sessionId: string, sessionToken: string): Promise<ConfirmResult> {
    return apiRequest<ConfirmResult>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/confirm`,
      {
        method: 'POST',
        idempotencyKey: newConfirmIdempotencyKey(),
        sessionToken,
        body: JSON.stringify({}),
      },
    );
  },
};

export function isRetryable(error: unknown): boolean {
  if (error instanceof CheckoutApiError) {
    return (
      error.status === 0 ||
      error.status >= 500 ||
      error.code === 'NETWORK_ERROR' ||
      error.code === 'INVALID_RESPONSE' ||
      error.code === 'SERVICE_UNAVAILABLE'
    );
  }
  return false;
}

export function userFacingMessage(error: unknown): string {
  if (error instanceof CheckoutApiError) {
    if (error.code === 'PAYMENT_FAILED') {
      return 'Payment could not be started. Please try again or use a different card.';
    }
    if (error.code === 'SERVICE_UNAVAILABLE') {
      return 'Checkout is preparing your payment. Please wait a moment and try again.';
    }
    if (error.code === 'CHECKOUT_EXPIRED') {
      return 'Your checkout session expired. Please start a new order.';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
