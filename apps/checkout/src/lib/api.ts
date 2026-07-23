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

import type { EventPagePuckData } from '@tixkit/content-event-page-react/puck';
import { getBrowserRuntimeConfig } from './runtime-config-browser';

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
  mediaAssets?: PublicEventMediaAsset[];
  minimumAge?: number | null;
  marketingIntegrations?: MarketingIntegration[];
};

export type PublicEventMediaAsset = {
  role: 'poster' | 'cover' | 'social';
  altText: string;
  focalPoint: { x: number; y: number };
  renditions: Array<{
    variant: 'thumbnail' | 'card' | 'page' | 'social';
    width: number;
    height: number;
    url: string;
  }>;
};

export type MarketingIntegration = {
  provider: 'ga4' | 'meta_pixel' | 'generic_tag';
  config: Record<string, unknown>;
  consentRequired: boolean;
  status: string;
};

export const CURRENT_RESALE_TERMS_ACCEPTANCE = {
  accepted: true,
  termsVersion: '2026-07-16',
  settlementModel: 'organizer_managed',
  refundModel: 'manual_coordinated_resolution',
} as const;

export type ResaleTermsAcceptance = typeof CURRENT_RESALE_TERMS_ACCEPTANCE;

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
    publishedAt?: string;
  };
  page: {
    provider: '@puckeditor/core';
    puckData: EventPagePuckData | null;
    settings?: Record<string, unknown>;
    discovery: PublicEventDiscoveryCard;
  };
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
  eventOccurrenceId?: string;
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
  eventOccurrenceId?: string;
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
  dateOfBirth?: string;
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
  occurrences?: PublicEventOccurrence[];
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
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CheckoutApiError';
  }
}

export function apiBaseUrl(): string {
  return getBrowserRuntimeConfig().platformApiBaseUrl;
}

function hasUnsafeUrlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 32 || codePoint === 127 || character === '\\';
  });
}

export function issueCheckoutApiUrl(path: string): string {
  const { platformApiBaseUrl } = getBrowserRuntimeConfig();
  if (
    !path ||
    path.length > 4_096 ||
    path !== path.trim() ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('@') ||
    /%(?:2e|2f|5c)/iu.test(path) ||
    hasUnsafeUrlCharacter(path)
  ) {
    throw new CheckoutApiError('INVALID_API_PATH', 'The checkout API path is invalid', 0);
  }
  const base = new URL(platformApiBaseUrl);
  const resolved = new URL(`/v1${path}`, `${base.origin}/`);
  if (
    resolved.origin !== base.origin ||
    resolved.username ||
    resolved.password ||
    !resolved.pathname.startsWith('/v1/')
  ) {
    throw new CheckoutApiError('INVALID_API_PATH', 'The checkout API path is invalid', 0);
  }
  return resolved.toString();
}

export function issueCheckoutUploadUrl(candidate: string): string {
  const { mediaOrigin } = getBrowserRuntimeConfig();
  if (
    !candidate ||
    candidate.length > 8_192 ||
    candidate !== candidate.trim() ||
    hasUnsafeUrlCharacter(candidate)
  ) {
    throw new CheckoutApiError('INVALID_UPLOAD_URL', 'The upload target is invalid', 0);
  }
  const allowed = new URL(mediaOrigin);
  const resolved = new URL(candidate);
  if (
    resolved.origin !== allowed.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    (resolved.protocol !== 'https:' && resolved.protocol !== 'http:')
  ) {
    throw new CheckoutApiError('INVALID_UPLOAD_URL', 'The upload target is invalid', 0);
  }
  return resolved.toString();
}

export function issueCheckoutUploadCompletionUrl(candidate: string): string {
  const { platformApiBaseUrl } = getBrowserRuntimeConfig();
  if (
    !candidate ||
    candidate.length > 2_048 ||
    candidate !== candidate.trim() ||
    candidate.startsWith('//') ||
    candidate.includes('@') ||
    hasUnsafeUrlCharacter(candidate)
  ) {
    throw new CheckoutApiError(
      'INVALID_UPLOAD_COMPLETION_URL',
      'The upload completion target is invalid',
      0,
    );
  }
  const base = new URL(platformApiBaseUrl);
  const resolved = new URL(candidate, `${base.origin}/`);
  if (
    resolved.origin !== base.origin ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash ||
    !/^\/v1\/public\/upload-artifacts\/[A-Za-z0-9_-]+\/complete$/u.test(resolved.pathname)
  ) {
    throw new CheckoutApiError(
      'INVALID_UPLOAD_COMPLETION_URL',
      'The upload completion target is invalid',
      0,
    );
  }
  return resolved.toString();
}

function normalizePublicEvent(event: PublicEvent): PublicEvent {
  const origin = new URL(apiBaseUrl()).origin;
  return {
    ...event,
    mediaAssets: event.mediaAssets?.map((asset) => ({
      ...asset,
      renditions: asset.renditions.map((rendition) => ({
        ...rendition,
        url: rendition.url.startsWith('/') ? `${origin}${rendition.url}` : rendition.url,
      })),
    })),
  };
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
    const timeoutSignal = AbortSignal.timeout(15_000);
    response = await fetch(issueCheckoutApiUrl(path), {
      ...init,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal,
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

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new CheckoutApiError(
      'NETWORK_ERROR',
      err instanceof Error
        ? `Checkout response was interrupted: ${err.message}`
        : 'Checkout response was interrupted',
      0,
    );
  }
  const data = parseApiResponseBody(text, response.status);

  if (!response.ok) {
    const error = (data ?? {}) as {
      error?: {
        code?: string;
        message?: string;
        requestId?: string;
        details?: Record<string, unknown>;
      };
    };
    throw new CheckoutApiError(
      error.error?.code ?? 'REQUEST_FAILED',
      error.error?.message ?? `Request failed with status ${response.status}`,
      response.status,
      error.error?.requestId,
      error.error?.details && typeof error.error.details === 'object'
        ? error.error.details
        : undefined,
    );
  }

  return data as T;
}

export const publicApi = {
  async getEvent(eventId: string, signal?: AbortSignal): Promise<PublicEvent> {
    return normalizePublicEvent(
      await apiRequest<PublicEvent>(`/public/events/${encodeURIComponent(eventId)}`, { signal }),
    );
  },

  async getEventBySlug(slug: string, host: string, signal?: AbortSignal): Promise<PublicEvent> {
    const params = new URLSearchParams({ host });
    return normalizePublicEvent(
      await apiRequest<PublicEvent>(
        `/public/events/by-slug/${encodeURIComponent(slug)}?${params.toString()}`,
        { signal },
      ),
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
      event: normalizePublicEvent(response.event),
      contentPage: response.contentPage ?? null,
      availability: Array.isArray(response.availability) ? response.availability : [],
      resaleListings: response.resaleListings ?? {
        items: [],
        nextCursor: null,
        hasMore: false,
      },
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
      event: normalizePublicEvent(response.event),
      contentPage: response.contentPage ?? null,
      availability: Array.isArray(response.availability) ? response.availability : [],
      resaleListings: response.resaleListings ?? {
        items: [],
        nextCursor: null,
        hasMore: false,
      },
    };
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
      occurrences?: PublicEventOccurrence[];
    }>(`/public/events/${encodeURIComponent(eventId)}/bootstrap${query ? `?${query}` : ''}`, {
      signal,
    });
    return {
      event: response.event,
      availability: Array.isArray(response.availability) ? response.availability : [],
      questions: normalizeQuestionsResponse(response.questions),
      resaleListing: response.resaleListing ?? null,
      occurrences: Array.isArray(response.occurrences) ? response.occurrences : [],
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
      {
        signal,
      },
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
  ): Promise<{
    artifactId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }> {
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
    const uploadUrl = issueCheckoutUploadUrl(artifact.uploadUrl);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: artifact.uploadHeaders,
      body: file,
    });
    if (!uploadResponse.ok) {
      throw new CheckoutApiError('UPLOAD_FAILED', 'File upload failed', uploadResponse.status);
    }
    const completeUrl = new URL(issueCheckoutUploadCompletionUrl(artifact.completeUrl));
    await apiRequest(completeUrl.pathname.replace(/^\/v1/u, ''), {
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

export type CreateCheckoutSessionInput = {
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
  resaleTermsAcceptance?: ResaleTermsAcceptance;
};

export const checkoutApi = {
  async createSession(
    input: CreateCheckoutSessionInput,
    idempotencyKey = newCheckoutIdempotencyKey(),
  ): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>('/checkout/sessions', {
      method: 'POST',
      idempotencyKey,
      body: JSON.stringify(input),
    });
  },

  async getSession(
    sessionId: string,
    sessionToken?: string,
    paymentIntentClientSecret?: string,
  ): Promise<CheckoutSession> {
    const params = new URLSearchParams();
    if (paymentIntentClientSecret) {
      params.set('payment_intent_client_secret', paymentIntentClientSecret);
    }
    const query = params.size ? `?${params.toString()}` : '';
    return apiRequest<CheckoutSession>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}${query}`,
      sessionToken ? { sessionToken } : undefined,
    );
  },

  async exchangeHandoff(sessionId: string, handoff: string): Promise<CheckoutSession> {
    return apiRequest<CheckoutSession>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/handoff/exchange`,
      { method: 'POST', body: JSON.stringify({ handoff }) },
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
    input: {
      priceCents: number;
      expiresAt?: string;
      idempotencyKey: string;
      termsAcceptance: ResaleTermsAcceptance;
    },
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
          termsAcceptance: input.termsAcceptance,
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

  async confirmSession(
    sessionId: string,
    sessionToken: string,
    idempotencyKey = newConfirmIdempotencyKey(),
  ): Promise<ConfirmResult> {
    return apiRequest<ConfirmResult>(
      `/checkout/sessions/${encodeURIComponent(sessionId)}/confirm`,
      {
        method: 'POST',
        idempotencyKey,
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
    if (error.code === 'INVENTORY_EXHAUSTED') {
      const available =
        typeof error.details?.available === 'number' ? error.details.available : undefined;
      if (available === 0) {
        return 'One or more selected items are sold out. Review your selection to continue.';
      }
      if (typeof available === 'number') {
        return `Only ${available} remaining for one of your selected items. Review your selection to continue.`;
      }
      return 'Inventory changed for your selection. Review your tickets to continue.';
    }
    if (error.code === 'HOLD_EXPIRED') {
      return 'Your ticket hold expired. Start a new order to reserve tickets again.';
    }
    if (error.code === 'NETWORK_ERROR') {
      return 'We could not reach checkout. Check your connection and try again.';
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
