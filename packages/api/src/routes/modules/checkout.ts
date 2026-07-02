import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import {
  EventRepository,
  TicketTypeRepository,
  TicketRepository,
  TicketListingRepository,
  CheckoutSessionRepository,
  OrderRepository,
  DiscountCodeRepository,
  TaxRuleRepository,
  FeeRuleRepository,
  AccessRuleRepository,
  ProductRepository,
  EventOccurrenceRepository,
  PaymentCompensationRepository,
  OrganizationRepository,
  type Database,
} from '@tixkit/db';
import { ClerkAuthService, createAuthMiddleware } from '../../auth/clerk.js';
import type { ProductForPricing, TicketTypeForPricing } from '../../services/pricing.js';
import type { CartReservationItem } from '../../services/inventory.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import type { CheckoutState } from '@tixkit/workflows';
import { assertCompletedUploadArtifacts } from '../../services/uploads.js';
import type {
  CreateCheckoutSessionInput,
  CartInput,
  AccessRuleRecord,
  DiscountCode,
  FeeRule,
  TaxRule,
} from '@tixkit/domain';
import {
  NotFoundError,
  ValidationError,
  AccessCodeRequiredError,
  CheckoutExpiredError,
  ResaleError,
  accessRuleMatches,
  validateTicketPurchase,
  validateResalePrice,
  validateAnswers,
  normalizeQuestionAnswers,
  validateBoxOfficeOrder,
  BoxOfficeError,
} from '@tixkit/domain';
import type { Question } from '@tixkit/domain';
import {
  parseBoxOfficeSettings,
  parseJsonValue,
  pickAllowedFields,
  serializeOrder,
  serializeResalePolicy,
  serializeTicketListing,
} from '../../http/contracts.js';
import {
  createCheckoutSessionSchema,
  createBoxOfficeOrderSchema,
  updateCheckoutSessionSchema,
  confirmCheckoutSchema,
  createResaleListingSchema,
  parseBody,
} from '../../http/schemas.js';
import { hashWaitlistClaimToken } from './waitlist.js';

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (!key || typeof key !== 'string') {
    throw new ValidationError('Idempotency-Key header is required for this mutation');
  }
  return key;
}

function requireCheckoutSessionToken(request: FastifyRequest): string {
  const clientToken = request.headers['x-checkout-session-token'];
  if (typeof clientToken !== 'string') {
    throw new ValidationError('X-Checkout-Session-Token header is required');
  }
  return clientToken;
}

function assertCheckoutSessionToken(
  session: { id: string; client_token: string },
  clientToken: string,
) {
  if (session.client_token !== clientToken) {
    throw new NotFoundError('CheckoutSession', session.id);
  }
}

function walletPassTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenHashMatches(expected: string | null, candidate: string): boolean {
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const candidateBuffer = Buffer.from(walletPassTokenHash(candidate), 'hex');
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

function toResaleValidationError(error: unknown): never {
  if (error instanceof ResaleError) {
    throw new ValidationError(error.message);
  }
  throw error;
}

function isUniqueViolation(error: unknown): boolean {
  const record = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    record.code === '23505' ||
    record.code === 'ER_DUP_ENTRY' ||
    record.errno === 1062 ||
    record.errno === '1062' ||
    /duplicate|unique/i.test(String(record.message ?? ''))
  );
}

function publicCheckoutSession(
  session: {
    id: string;
    event_id: string;
    brand_id: string;
    status: string;
    currency: string;
    quote: unknown;
    expires_at: Date | string;
    success_url: string | null;
    cancel_url: string | null;
    order_id: string | null;
    client_token: string;
  },
  compensation?: {
    id: string;
    status: string;
    action: string;
    provider: string;
    provider_intent_id: string;
    provider_compensation_id: string | null;
    attempts: number;
    reason: string;
    last_error: string | null;
    updated_at: Date | string;
  },
  options: { includeClientToken?: boolean } = {},
) {
  return {
    id: session.id,
    eventId: session.event_id,
    brandId: session.brand_id,
    status: session.status,
    currency: session.currency,
    quote: parseJsonValue<Record<string, unknown>>(session.quote, {}),
    expiresAt: session.expires_at,
    successUrl: session.success_url,
    cancelUrl: session.cancel_url,
    orderId: session.order_id,
    ...(options.includeClientToken === false ? {} : { clientToken: session.client_token }),
    paymentCompensation: compensation
      ? {
          id: compensation.id,
          status: compensation.status,
          action: compensation.action,
          provider: compensation.provider,
          providerIntentId: compensation.provider_intent_id,
          providerCompensationId: compensation.provider_compensation_id,
          attempts: compensation.attempts,
          reason: compensation.reason,
          lastError: compensation.last_error,
          updatedAt: compensation.updated_at,
        }
      : undefined,
  };
}

function zeroCompQuote<T extends { lineItems?: Array<Record<string, unknown>> }>(
  quote: T & {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  },
) {
  return {
    ...quote,
    discountCents: quote.subtotalCents,
    taxCents: 0,
    feeCents: 0,
    totalCents: 0,
    lineItems: quote.lineItems?.map((line) => ({
      ...line,
      discountCents:
        typeof line.subtotalCents === 'number' ? line.subtotalCents : (line.discountCents ?? 0),
      taxCents: 0,
      feeCents: 0,
      totalCents: 0,
      taxBreakdown: [],
    })),
  };
}

function normalizeCartItems(
  items: CreateCheckoutSessionInput['items'],
  ticketTypes: Map<
    string,
    { kind: string; price_cents: number; event_occurrence_id?: string | null }
  >,
  products: Map<string, { price_cents: number }>,
): CartInput['items'] {
  const normalized = new Map<
    string,
    {
      ticketTypeId?: string;
      occurrenceId?: string;
      productId?: string;
      resaleListingId?: string;
      quantity: number;
      unitAmountCents?: number;
      attendeeFields?: Record<string, unknown>[];
    }
  >();

  for (const item of items) {
    if (item.resaleListingId) {
      if (item.quantity !== 1) {
        throw new ValidationError('Resale listing checkout items must have quantity 1');
      }
      const key = `resale:${item.resaleListingId}`;
      if (normalized.has(key)) {
        throw new ValidationError(`Duplicate resale listing ${item.resaleListingId}`);
      }
      normalized.set(key, { resaleListingId: item.resaleListingId, quantity: 1 });
      continue;
    }

    if (item.ticketTypeId) {
      const ticketType = ticketTypes.get(item.ticketTypeId);
      if (!ticketType) throw new NotFoundError('TicketType', item.ticketTypeId);
      if (ticketType.kind !== 'donation' && item.unitAmountCents !== undefined) {
        throw new ValidationError(
          `unitAmountCents is only accepted for donation ticket ${item.ticketTypeId}`,
        );
      }

      const occurrenceId = item.occurrenceId ?? ticketType.event_occurrence_id ?? undefined;
      const key = `ticket:${item.ticketTypeId}:${occurrenceId ?? 'event'}`;
      const existing = normalized.get(key);
      const unitAmountCents = ticketType.kind === 'donation' ? item.unitAmountCents : undefined;
      if (existing) {
        if (existing.unitAmountCents !== unitAmountCents) {
          throw new ValidationError(
            `Duplicate donation lines for ${item.ticketTypeId} must use the same amount`,
          );
        }
        existing.quantity += item.quantity;
        if (item.attendeeFields) {
          existing.attendeeFields = [...(existing.attendeeFields ?? []), ...item.attendeeFields];
        }
      } else {
        normalized.set(key, {
          ticketTypeId: item.ticketTypeId,
          occurrenceId,
          quantity: item.quantity,
          unitAmountCents,
          attendeeFields: item.attendeeFields,
        });
      }
      continue;
    }

    if (!item.productId) {
      throw new ValidationError('Cart item must include ticketTypeId or productId');
    }
    if (!products.has(item.productId)) throw new NotFoundError('Product', item.productId);
    const key = `product:${item.productId}`;
    const existing = normalized.get(key);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      normalized.set(key, {
        productId: item.productId,
        quantity: item.quantity,
      });
    }
  }

  return [...normalized.values()];
}

function assertCheckoutLineItemQuantityBounds(
  items: CartInput['items'],
  ticketTypes: Map<string, { id: string; min_per_order: number; max_per_order: number }>,
  products: Map<string, { id: string; max_per_order: number }>,
): void {
  for (const item of items) {
    if (item.ticketTypeId) {
      const ticketType = ticketTypes.get(item.ticketTypeId);
      if (!ticketType) throw new NotFoundError('TicketType', item.ticketTypeId);
      if (item.quantity < ticketType.min_per_order) {
        throw new ValidationError(
          `Ticket type ${ticketType.id} requires a minimum of ${ticketType.min_per_order} per order`,
        );
      }
      if (item.quantity > ticketType.max_per_order) {
        throw new ValidationError(
          `Ticket type ${ticketType.id} allows a maximum of ${ticketType.max_per_order} per order`,
        );
      }
      continue;
    }

    if (!item.productId) {
      throw new ValidationError('Cart item must include ticketTypeId or productId');
    }
    const product = products.get(item.productId);
    if (!product) throw new NotFoundError('Product', item.productId);
    if (item.quantity < 1 || item.quantity > product.max_per_order) {
      throw new ValidationError(
        `Product ${product.id} allows a maximum of ${product.max_per_order} per order`,
      );
    }
  }
}

function cartItemWithoutAttendeeFields(
  item: CartInput['items'][number],
): CartInput['items'][number] {
  return {
    ticketTypeId: item.ticketTypeId,
    occurrenceId: item.occurrenceId,
    productId: item.productId,
    quantity: item.quantity,
    unitAmountCents: item.unitAmountCents,
  };
}

function normalizeAttendeeFieldsForCartItems(
  items: CartInput['items'],
  eventQuestions: Question[],
  answeredAt: string,
): { items: CartInput['items']; attendeeFieldsByTicketType: Record<string, unknown[]> } {
  const attendeeFieldsByTicketType: Record<string, unknown[]> = {};
  const normalizedItems = items.map((item) => {
    if (!item.ticketTypeId) return item;

    const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
    if (itemQuestions.length === 0) {
      return cartItemWithoutAttendeeFields(item);
    }

    const fields = Array.from({ length: item.quantity }, (_, attendeeIndex) =>
      normalizeQuestionAnswers(
        itemQuestions,
        item.attendeeFields?.[attendeeIndex] ?? {},
        answeredAt,
      ),
    );
    if (!fields.some((fieldSet) => Object.keys(fieldSet).length > 0)) {
      return cartItemWithoutAttendeeFields(item);
    }

    attendeeFieldsByTicketType[item.ticketTypeId] = [
      ...(attendeeFieldsByTicketType[item.ticketTypeId] ?? []),
      ...fields,
    ];
    return { ...item, attendeeFields: fields };
  });

  return { items: normalizedItems, attendeeFieldsByTicketType };
}

async function claimCheckoutUploadArtifacts(
  db: Database,
  tenantId: string,
  eventId: string,
  cart: CartInput,
  checkoutSessionId: string,
): Promise<void> {
  const claimedArtifactIds = new Set<string>();
  await assertCompletedUploadArtifacts(db, tenantId, eventId, cart.buyerFields ?? {}, {
    checkoutSessionId,
    claimedArtifactIds,
  });

  for (const answerSets of Object.values(cart.attendeeFields ?? {})) {
    for (const answers of answerSets) {
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) continue;
      // eslint-disable-next-line no-await-in-loop -- claim ordering keeps duplicate artifact use deterministic.
      await assertCompletedUploadArtifacts(
        db,
        tenantId,
        eventId,
        answers as Record<string, unknown>,
        {
          checkoutSessionId,
          claimedArtifactIds,
        },
      );
    }
  }
}

async function releaseCheckoutUploadArtifactClaims(
  db: Database,
  checkoutSessionId: string,
): Promise<void> {
  await db
    .updateTable('upload_artifacts')
    .set({
      consumed_by_checkout_session_id: null,
      consumed_at: null,
      updated_at: new Date(),
    })
    .where('consumed_by_checkout_session_id', '=', checkoutSessionId)
    .execute();
}

async function compensateCheckoutSessionCreation(input: {
  db: Database;
  releaseHoldsForSession: (checkoutSessionId: string) => Promise<void>;
  checkoutSessionId: string;
  sessionCreated: boolean;
}): Promise<void> {
  await Promise.allSettled([
    releaseCheckoutUploadArtifactClaims(input.db, input.checkoutSessionId),
    input.releaseHoldsForSession(input.checkoutSessionId),
    input.sessionCreated
      ? input.db
          .updateTable('checkout_sessions')
          .set({ status: 'cancelled', updated_at: new Date() })
          .where('id', '=', input.checkoutSessionId)
          .where('status', '=', 'open')
          .execute()
      : Promise.resolve(),
  ]);
}

type QuestionRow = {
  id: string;
  event_id: string;
  ticket_type_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  type: string;
  label: string;
  description: string | null;
  required: boolean;
  applies_to: string;
  options: string | null;
  placeholder: string | null;
  validation_pattern: string | null;
  conditional_visibility: string | null;
  status?: string;
  is_hidden?: boolean | number | null;
  hidden_at?: Date | string | null;
  deleted_at?: Date | string | null;
  sort_order: number;
  is_consent_field: boolean;
  consent_text: string | null;
  consent_version: string | null;
};

function isVisibleCheckoutQuestion(q: QuestionRow): boolean {
  return q.status !== 'hidden' && !q.is_hidden && !q.hidden_at && !q.deleted_at;
}

function parseQuestionOptions(q: QuestionRow): string[] | undefined {
  const options = parseStringArray(q.options);
  if (options) return options;
  if ((q.type === 'select' || q.type === 'multiselect') && q.options) return [];
  return undefined;
}

function parseQuestionConditionalVisibility(
  value: string | null,
  visibleQuestionIds: ReadonlySet<string>,
): Question['conditionalVisibility'] | undefined {
  const parsed = parseJsonValue<unknown>(value, undefined);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const condition = parsed as Record<string, unknown>;
  if (
    typeof condition.field !== 'string' ||
    typeof condition.operator !== 'string' ||
    typeof condition.value !== 'string'
  ) {
    return undefined;
  }
  if (
    condition.operator !== 'equals' &&
    condition.operator !== 'not_equals' &&
    condition.operator !== 'contains'
  ) {
    return undefined;
  }
  if (!visibleQuestionIds.has(condition.field)) return undefined;

  return {
    field: condition.field,
    operator: condition.operator,
    value: condition.value,
  };
}

function toDomainQuestion(q: QuestionRow, visibleQuestionIds: ReadonlySet<string>): Question {
  return {
    id: q.id,
    eventId: q.event_id,
    ticketTypeId: q.ticket_type_id ?? undefined,
    createdAt: typeof q.created_at === 'string' ? q.created_at : q.created_at.toISOString(),
    updatedAt: typeof q.updated_at === 'string' ? q.updated_at : q.updated_at.toISOString(),
    type: q.type as Question['type'],
    label: q.label,
    description: q.description ?? undefined,
    required: q.required,
    appliesTo: q.applies_to as Question['appliesTo'],
    options: parseQuestionOptions(q),
    placeholder: q.placeholder ?? undefined,
    validationPattern: q.validation_pattern ?? undefined,
    conditionalVisibility: parseQuestionConditionalVisibility(
      q.conditional_visibility,
      visibleQuestionIds,
    ),
    sortOrder: q.sort_order,
    isConsentField: q.is_consent_field,
    consentText: q.consent_text ?? undefined,
    consentVersion: q.consent_version ?? undefined,
  };
}

function toVisibleDomainQuestions(rows: QuestionRow[]): Question[] {
  const visibleRows = rows.filter(isVisibleCheckoutQuestion);
  const visibleQuestionIds = new Set(visibleRows.map((row) => row.id));
  return visibleRows.map((row) => toDomainQuestion(row, visibleQuestionIds));
}

function applicableQuestions(
  questions: Question[],
  appliesTo: 'buyer' | 'attendee',
  ticketTypeId?: string,
): Question[] {
  return questions.filter((question) => {
    const scopeMatches = question.appliesTo === appliesTo || question.appliesTo === 'both';
    const ticketMatches = !question.ticketTypeId || question.ticketTypeId === ticketTypeId;
    return scopeMatches && ticketMatches;
  });
}

function assertValidAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
  context: string,
): void {
  const result = validateAnswers(questions, answers);
  if (!result.valid) {
    throw new ValidationError(
      `${context} validation failed: ${result.errors.map((e) => e.message).join(', ')}`,
    );
  }
}

function normalizeValidAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
  context: string,
  answeredAt: string,
): Record<string, unknown> {
  assertValidAnswers(questions, answers, context);
  return normalizeQuestionAnswers(questions, answers, answeredAt);
}

function assertWaitlistOfferUsable(
  entry: {
    status: string;
    offer_expires_at: Date | string | null;
    event_id: string;
    ticket_type_id: string;
    quantity: number;
    buyer_email: string;
  },
  input: {
    eventId: string;
    items: { ticketTypeId?: string; quantity: number }[];
    buyerEmail?: string;
  },
): void {
  if (entry.event_id !== input.eventId) {
    throw new ValidationError('Waitlist offer does not belong to this event');
  }
  if (entry.status !== 'offered') {
    throw new ValidationError('Waitlist offer is not available');
  }
  if (!entry.offer_expires_at || new Date(entry.offer_expires_at) <= new Date()) {
    throw new ValidationError('Waitlist offer has expired');
  }
  const claimedItem = input.items.find((item) => item.ticketTypeId === entry.ticket_type_id);
  if (!claimedItem) {
    throw new ValidationError('Waitlist offer ticket type is required in the checkout cart');
  }
  if (claimedItem.quantity > entry.quantity) {
    throw new ValidationError('Checkout quantity exceeds the waitlist offer quantity');
  }
  if (!input.buyerEmail) {
    throw new ValidationError('Waitlist offer requires the checkout buyer email');
  }
  if (input.buyerEmail.trim().toLowerCase() !== entry.buyer_email) {
    throw new ValidationError('Waitlist offer email does not match the checkout buyer');
  }
}

function normalizeCheckoutBuyer(
  buyer: CreateCheckoutSessionInput['buyer'],
): CreateCheckoutSessionInput['buyer'] | undefined {
  if (!buyer) return undefined;
  const normalizedEmail = buyer.email?.trim().toLowerCase();
  return {
    ...buyer,
    ...(normalizedEmail ? { email: normalizedEmail } : {}),
  };
}

async function releaseExpiredWaitlistReservation(input: {
  db: Database;
  entryId: string;
  tenantId: string;
  now: Date;
}): Promise<boolean> {
  const result = await input.db
    .updateTable('waitlist_entries')
    .set({
      status: 'offered',
      reserved_checkout_session_id: null,
      reserved_until: null,
      updated_at: input.now,
    })
    .where('id', '=', input.entryId)
    .where('tenant_id', '=', input.tenantId)
    .where('status', '=', 'reserved')
    .where('reserved_until', '<=', input.now)
    .executeTakeFirst();
  return Number((result as { numUpdatedRows?: bigint | number }).numUpdatedRows ?? 0) > 0;
}

async function reserveWaitlistOfferForCheckout(input: {
  db: Database;
  entryId: string;
  tenantId: string;
  eventId: string;
  checkoutSessionId: string;
  reservedUntil: Date;
  now: Date;
}): Promise<void> {
  await releaseExpiredWaitlistReservation(input);
  const result = await input.db
    .updateTable('waitlist_entries')
    .set({
      status: 'reserved',
      reserved_checkout_session_id: input.checkoutSessionId,
      reserved_until: input.reservedUntil,
      updated_at: input.now,
    })
    .where('id', '=', input.entryId)
    .where('tenant_id', '=', input.tenantId)
    .where('event_id', '=', input.eventId)
    .where('status', '=', 'offered')
    .executeTakeFirst();
  if (Number((result as { numUpdatedRows?: bigint | number }).numUpdatedRows ?? 0) === 0) {
    throw new ValidationError('Waitlist offer is already reserved');
  }
}

async function releaseWaitlistCheckoutReservation(input: {
  db: Database;
  entryId: string;
  tenantId: string;
  checkoutSessionId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await input.db
    .updateTable('waitlist_entries')
    .set({
      status: 'offered',
      reserved_checkout_session_id: null,
      reserved_until: null,
      updated_at: now,
    })
    .where('id', '=', input.entryId)
    .where('tenant_id', '=', input.tenantId)
    .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
    .where('status', '=', 'reserved')
    .execute();
}

async function updateWaitlistReservationExpiry(input: {
  db: Database;
  entryId: string;
  tenantId: string;
  checkoutSessionId: string;
  reservedUntil: Date;
  now: Date;
}): Promise<void> {
  await input.db
    .updateTable('waitlist_entries')
    .set({
      reserved_until: input.reservedUntil,
      updated_at: input.now,
    })
    .where('id', '=', input.entryId)
    .where('tenant_id', '=', input.tenantId)
    .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
    .where('status', '=', 'reserved')
    .execute();
}

type DiscountCodeRow = {
  id: string;
  event_id: string;
  code: string;
  type: string;
  value: number;
  currency: string;
  max_uses: number;
  uses_count: number;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  min_order_cents: number | null;
  max_discount_cents: number | null;
  ticket_type_ids: string | string[] | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type TaxRuleRow = {
  id: string;
  event_id: string;
  name: string;
  rate: number;
  type: string;
  applied_to: string;
  countries: string | string[] | null;
  regions: string | string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type FeeRuleRow = {
  id: string;
  event_id: string;
  name: string;
  type: string;
  value: number;
  applied_to: string;
  absorb_into_price: boolean | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type AccessRuleRow = {
  id: string;
  ticket_type_id: string;
  type: AccessRuleRecord['type'];
  value: string;
  max_uses: number | null;
  uses_count: number;
  expires_at: Date | string | null;
};

function toIsoString(value: Date | string | null): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function accessRuleRowMatches(
  row: AccessRuleRow,
  input: { accessCode?: string; buyerEmail?: string; now: Date },
): boolean {
  return accessRuleMatches(
    {
      type: row.type,
      value: row.value,
      maxUses: row.max_uses,
      usesCount: row.uses_count,
      expiresAt: row.expires_at,
    },
    input,
  );
}

function parseStringArray(value: string | string[] | null): string[] | undefined {
  if (Array.isArray(value)) return value;
  if (!value) return undefined;
  const parsed = parseJsonValue<unknown>(value, undefined);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function toDomainDiscountCode(row: DiscountCodeRow): DiscountCode {
  return {
    id: row.id,
    eventId: row.event_id,
    code: row.code,
    type: row.type as DiscountCode['type'],
    value: Number(row.value),
    currency: row.currency,
    maxUses: Number(row.max_uses),
    usesCount: Number(row.uses_count),
    validFrom: toIsoString(row.valid_from),
    validUntil: toIsoString(row.valid_until),
    minOrderCents: row.min_order_cents == null ? undefined : Number(row.min_order_cents),
    maxDiscountCents: row.max_discount_cents == null ? undefined : Number(row.max_discount_cents),
    ticketTypeIds: parseStringArray(row.ticket_type_ids),
    status: row.status as DiscountCode['status'],
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  };
}

function toDomainTaxRule(row: TaxRuleRow): TaxRule {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    rate: Number(row.rate),
    type: row.type as TaxRule['type'],
    appliedTo: row.applied_to as TaxRule['appliedTo'],
    countries: parseStringArray(row.countries),
    regions: parseStringArray(row.regions),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  };
}

function toDomainFeeRule(row: FeeRuleRow): FeeRule {
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    type: row.type as FeeRule['type'],
    value: Number(row.value),
    appliedTo: row.applied_to as FeeRule['appliedTo'],
    absorbIntoPrice: Boolean(row.absorb_into_price),
    createdAt: toIsoString(row.created_at)!,
    updatedAt: toIsoString(row.updated_at)!,
  };
}

export const checkoutRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;
  const pricingEngine = app.context.pricingEngine;
  const inventoryService = app.context.inventoryService;
  const temporalClient = app.context.temporalClient;
  const authenticateAdmin = createAuthMiddleware(app.context.authService);

  async function readDurablePendingPayment(input: {
    sessionId: string;
    tenantId: string;
    totalCents: number;
    currency: string;
  }) {
    const refreshedSession = await db
      .selectFrom('checkout_sessions')
      .select(['payment_intent_id', 'status'])
      .where('id', '=', input.sessionId)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();

    if (!refreshedSession?.payment_intent_id || refreshedSession.status !== 'pending_payment') {
      return undefined;
    }

    const paymentIntent = await db
      .selectFrom('payment_intents')
      .select(['provider_intent_id', 'amount_cents', 'currency', 'client_secret'])
      .where('id', '=', refreshedSession.payment_intent_id)
      .where('checkout_session_id', '=', input.sessionId)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();

    if (!paymentIntent?.provider_intent_id) return undefined;
    if (Number(paymentIntent.amount_cents) !== input.totalCents) return undefined;
    if (String(paymentIntent.currency).toUpperCase() !== input.currency.toUpperCase()) {
      return undefined;
    }

    return {
      sessionId: input.sessionId,
      status: 'pending_payment' as const,
      paymentIntentId: paymentIntent.provider_intent_id,
      clientSecret: paymentIntent.client_secret ?? undefined,
      totalCents: input.totalCents,
      currency: input.currency,
    };
  }

  app.post(
    '/events/:eventId/box-office/orders',
    { preHandler: authenticateAdmin },
    async (request, reply) => {
      const principal = request.principal!;
      ClerkAuthService.requirePermission(principal, 'orders.write');
      const { eventId } = request.params as { eventId: string };
      const body = parseBody(createBoxOfficeOrderSchema, request.body);
      const idempotencyKey = requireIdempotencyKey(request);

      const eventRepo = new EventRepository(db);
      const event = await eventRepo.findById(eventId);
      if (!event) throw new NotFoundError('Event', eventId);
      ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
      ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
      ClerkAuthService.requireBrandScope(principal, event.brand_id);
      ClerkAuthService.requireEventScope(principal, event.id);
      if (event.status !== 'published') {
        throw new ValidationError('Box-office sales require a published event');
      }
      const organization = await new OrganizationRepository(db).findById(event.organization_id);
      if (!organization) throw new NotFoundError('Organization', event.organization_id);
      ClerkAuthService.requireResourceTenant(
        principal,
        organization,
        'Organization',
        event.organization_id,
      );
      const boxOfficeSettings = parseBoxOfficeSettings(
        (organization as Record<string, unknown>).box_office_settings,
      );
      if (!boxOfficeSettings.enabled) {
        throw new ValidationError('Box-office sales are disabled for this organization');
      }
      if (!boxOfficeSettings.allowedTenderTypes.includes(body.tenderType)) {
        throw new ValidationError(
          `Box-office tender type ${body.tenderType} is not enabled for this organization`,
        );
      }
      if (boxOfficeSettings.requireBuyerEmail && !body.buyer?.email) {
        throw new ValidationError('Buyer email is required for box-office sales');
      }

      try {
        validateBoxOfficeOrder({
          eventId,
          tenantId: event.tenant_id,
          operatorId: principal.id,
          tenderType: body.tenderType,
          items: body.items.map((item) => ({
            ticketTypeId: item.ticketTypeId,
            quantity: item.quantity,
          })),
          buyerEmail: body.buyer?.email,
          amountCents: body.amountCents,
          currency: event.currency,
          notes: body.notes,
        });
      } catch (err) {
        if (err instanceof BoxOfficeError) {
          throw new ValidationError(err.message);
        }
        throw err;
      }

      const result = await withIdempotency(
        db,
        {
          key: idempotencyKey,
          tenantId: event.tenant_id,
          requestHash: hashRequest({ eventId, ...body, operatorId: principal.id }),
        },
        async () => {
          const ttRepo = new TicketTypeRepository(db);
          const ticketTypes = await ttRepo.findByEvent(eventId);
          const ttById = new Map(ticketTypes.map((ticketType) => [ticketType.id, ticketType]));
          const occurrenceIds = [
            ...new Set(
              body.items.map((item) => item.occurrenceId).filter((id): id is string => Boolean(id)),
            ),
          ];
          const occurrenceRows =
            occurrenceIds.length > 0
              ? await new EventOccurrenceRepository(db).findByEvent(eventId)
              : [];
          const occurrenceById = new Map(
            occurrenceRows.map((occurrence) => [occurrence.id, occurrence]),
          );
          const questionRows = (await db
            .selectFrom('questions')
            .selectAll()
            .where('event_id', '=', eventId)
            .execute()) as QuestionRow[];
          const visibleEventQuestions = toVisibleDomainQuestions(questionRows);
          const sessionId = `cs_${ulid()}`;
          const answeredAt = new Date().toISOString();
          const buyerFields = normalizeValidAnswers(
            applicableQuestions(visibleEventQuestions, 'buyer'),
            body.buyerFields ?? {},
            'Buyer question',
            answeredAt,
          );
          await assertCompletedUploadArtifacts(db, event.tenant_id, eventId, buyerFields);

          for (const item of body.items) {
            const ticketType = ttById.get(item.ticketTypeId);
            if (!ticketType) throw new NotFoundError('TicketType', item.ticketTypeId);
            if (item.occurrenceId && !occurrenceById.has(item.occurrenceId)) {
              throw new NotFoundError('EventOccurrence', item.occurrenceId);
            }
            if (
              ticketType.event_occurrence_id &&
              item.occurrenceId &&
              ticketType.event_occurrence_id !== item.occurrenceId
            ) {
              throw new ValidationError(
                'Ticket type does not belong to the requested event occurrence',
              );
            }
            const itemQuestions = applicableQuestions(
              visibleEventQuestions,
              'attendee',
              item.ticketTypeId,
            );
            if (itemQuestions.length === 0) continue;
            for (let attendeeIndex = 0; attendeeIndex < item.quantity; attendeeIndex++) {
              const attendeeAnswers = item.attendeeFields?.[attendeeIndex] ?? {};
              assertValidAnswers(itemQuestions, attendeeAnswers, 'Attendee question');
              // eslint-disable-next-line no-await-in-loop -- each attendee answer set is validated against scoped upload artifacts before session persistence.
              await assertCompletedUploadArtifacts(db, event.tenant_id, eventId, attendeeAnswers);
            }
          }

          const normalizedItems = normalizeCartItems(body.items, ttById, new Map());
          const ticketItems = normalizedItems.filter(
            (item): item is CartInput['items'][number] & { ticketTypeId: string } =>
              Boolean(item.ticketTypeId),
          );
          const reservationItems: CartReservationItem[] = [];
          const ttMap = new Map<string, TicketTypeForPricing>();
          for (const ticketType of ticketTypes) {
            ttMap.set(ticketType.id, {
              id: ticketType.id,
              name: ticketType.name,
              kind: ticketType.kind as 'free' | 'paid' | 'donation',
              priceCents: Number(ticketType.price_cents),
              minimumPriceCents: ticketType.minimum_price_cents
                ? Number(ticketType.minimum_price_cents)
                : undefined,
              currency: ticketType.currency,
              minPerOrder: ticketType.min_per_order,
              maxPerOrder: ticketType.max_per_order,
            });
          }
          for (const item of ticketItems) {
            const ttRecord = ttById.get(item.ticketTypeId);
            if (!ttRecord) throw new NotFoundError('TicketType', item.ticketTypeId);
            validateTicketPurchase({
              ticketType: {
                id: ttRecord.id,
                kind: ttRecord.kind as 'free' | 'paid' | 'donation',
                status: ttRecord.status as 'draft' | 'active' | 'paused' | 'sold_out' | 'ended',
                visibility: 'public',
                priceCents: Number(ttRecord.price_cents),
                minimumPriceCents: ttRecord.minimum_price_cents
                  ? Number(ttRecord.minimum_price_cents)
                  : null,
                salesStartAt: ttRecord.sales_start_at,
                salesEndAt: ttRecord.sales_end_at,
                minPerOrder: ttRecord.min_per_order,
                maxPerOrder: ttRecord.max_per_order,
                requiresAccessCode: false,
              },
              quantity: item.quantity,
              unitAmountCents: item.unitAmountCents,
            });
            reservationItems.push({
              inventoryPoolId: ttRecord.inventory_pool_id,
              ticketTypeId: ttRecord.id,
              ...(item.occurrenceId ? { occurrenceId: item.occurrenceId } : {}),
              quantity: item.quantity,
            });
          }

          const [discounts, taxRules, feeRules] = await Promise.all([
            new DiscountCodeRepository(db).findByEvent(eventId),
            new TaxRuleRepository(db).findByEvent(eventId),
            new FeeRuleRepository(db).findByEvent(eventId),
          ]);
          const attendeeFields = normalizeAttendeeFieldsForCartItems(
            normalizedItems,
            visibleEventQuestions,
            answeredAt,
          );
          const cart: CartInput = {
            items: attendeeFields.items.map((item) => ({
              ticketTypeId: item.ticketTypeId,
              occurrenceId: item.occurrenceId,
              quantity: item.quantity,
              attendeeFields: item.attendeeFields,
            })),
            buyerFields,
            attendeeFields: attendeeFields.attendeeFieldsByTicketType,
          };
          const baseQuote = pricingEngine.calculate({
            currency: event.currency,
            cart,
            ticketTypes: ttMap,
            products: new Map<string, ProductForPricing>(),
            taxRules: (taxRules as TaxRuleRow[]).map(toDomainTaxRule),
            feeRules: (feeRules as FeeRuleRow[]).map(toDomainFeeRule),
            discountCodes: (discounts as DiscountCodeRow[]).map(toDomainDiscountCode),
          });
          const quote = body.tenderType === 'comp' ? zeroCompQuote(baseQuote) : baseQuote;
          if (body.amountCents !== quote.totalCents) {
            throw new ValidationError(
              `Box-office tender amount ${body.amountCents} does not match server total ${quote.totalCents}`,
            );
          }
          const sessionRepo = new CheckoutSessionRepository(db);
          let sessionCreated = false;
          let shouldCompensate = true;
          let workflowStarted = false;
          try {
            const reservation = await inventoryService.reserveCart({
              items: reservationItems,
              checkoutSessionId: sessionId,
            });
            const session = await sessionRepo.create({
              id: sessionId,
              tenantId: event.tenant_id,
              eventId,
              brandId: event.brand_id,
              holdId: reservation.primaryHoldId,
              currency: quote.currency,
              cart: cart as Record<string, unknown>,
              buyer: (body.buyer as Record<string, unknown>) ?? {},
              quote: quote as Record<string, unknown>,
              expiresAt: reservation.expiresAt,
              idempotencyKey,
              successUrl: undefined,
              cancelUrl: undefined,
            });
            sessionCreated = true;
            await claimCheckoutUploadArtifacts(db, event.tenant_id, eventId, cart, sessionId);

            const handle = await temporalClient.startCheckoutSession({
              checkoutSessionId: session.id,
              tenantId: event.tenant_id,
              organizationId: event.organization_id,
              eventId,
              brandId: event.brand_id,
              holdId: session.hold_id ?? undefined,
              currency: session.currency,
              amountCents: quote.totalCents,
              feeCents: quote.feeCents,
              buyerEmail: body.buyer?.email ?? '',
              isFreeOrder: quote.totalCents === 0,
              paymentMode: body.tenderType === 'comp' ? 'free' : 'offline',
              salesChannel: 'box_office',
              operatorId: principal.id,
              tenderType: body.tenderType,
            });
            workflowStarted = true;
            const workflowResult = await handle.result();
            if (workflowResult.status !== 'completed' || !workflowResult.orderId) {
              await compensateCheckoutSessionCreation({
                db,
                releaseHoldsForSession: (id) => inventoryService.releaseHoldsForSession(id),
                checkoutSessionId: sessionId,
                sessionCreated,
              });
              shouldCompensate = false;
              return {
                status: 409,
                body: {
                  error: {
                    code: 'BOX_OFFICE_ORDER_FAILED',
                    message: 'Box-office order could not be finalized',
                    requestId: request.id,
                  },
                },
              };
            }
            shouldCompensate = false;
            const order = await new OrderRepository(db).findById(workflowResult.orderId);
            if (!order) throw new NotFoundError('Order', workflowResult.orderId);
            return {
              status: 201,
              body: {
                order: serializeOrder(order),
                sessionId: session.id,
                status: workflowResult.status,
              },
            };
          } catch (error) {
            if (shouldCompensate && !workflowStarted) {
              await compensateCheckoutSessionCreation({
                db,
                releaseHoldsForSession: (id) => inventoryService.releaseHoldsForSession(id),
                checkoutSessionId: sessionId,
                sessionCreated,
              });
            }
            throw error;
          }
        },
      );

      return reply.status(result.status).send(result.body);
    },
  );

  // Public buyer-facing checkout. No admin principal is required; tenancy is
  // resolved from the (published) event being purchased. Session IDs are
  // unguessable ULIDs, so retrieval/confirmation by ID is safe to expose.
  app.post('/checkout/sessions', async (request, reply) => {
    const isDev = process.env.NODE_ENV === 'development';
    const body = parseBody(createCheckoutSessionSchema(isDev), request.body);
    const checkoutBuyer = normalizeCheckoutBuyer(body.buyer);
    const idempotencyKey = requireIdempotencyKey(request);

    if (!body.items || body.items.length === 0) {
      throw new ValidationError('Checkout requires at least one item');
    }
    if (body.waitlistClaimToken && !checkoutBuyer?.email) {
      throw new ValidationError('Waitlist offer requires the checkout buyer email');
    }

    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(body.eventId);
    if (!event) throw new NotFoundError('Event', body.eventId);
    if (event.status !== 'published') {
      throw new ValidationError('Event is not published');
    }
    if (event.visibility === 'private') {
      throw new NotFoundError('Event', body.eventId);
    }

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: event.tenant_id,
        requestHash: hashRequest({ ...body, buyer: checkoutBuyer }),
      },
      async () => {
        const resaleItems = body.items.filter((item) => item.resaleListingId);
        if (resaleItems.length > 0) {
          if (body.items.length !== 1) {
            throw new ValidationError(
              'Resale checkout cannot be mixed with primary tickets or products',
            );
          }
          if (body.discountCode || body.accessCode || body.waitlistClaimToken) {
            throw new ValidationError(
              'Discount codes, access codes, and waitlist claims are not supported for resale checkout',
            );
          }

          const resaleItem = resaleItems[0]!;
          const listingId = resaleItem.resaleListingId!;
          const now = new Date();
          const listing = await db
            .selectFrom('ticket_listings')
            .innerJoin('tickets', 'tickets.id', 'ticket_listings.ticket_id')
            .innerJoin('ticket_types', 'ticket_types.id', 'tickets.ticket_type_id')
            .leftJoin('orders as seller_order', 'seller_order.id', 'tickets.order_id')
            .select([
              'ticket_listings.id as id',
              'ticket_listings.tenant_id as tenant_id',
              'ticket_listings.event_id as event_id',
              'ticket_listings.ticket_id as ticket_id',
              'ticket_listings.seller_id as seller_id',
              'ticket_listings.status as status',
              'ticket_listings.price_cents as price_cents',
              'ticket_listings.currency as currency',
              'ticket_listings.face_value_cents as face_value_cents',
              'ticket_listings.expires_at as expires_at',
              'ticket_listings.reserved_checkout_session_id as reserved_checkout_session_id',
              'ticket_listings.reserved_until as reserved_until',
              'tickets.order_id as ticket_order_id',
              'tickets.status as ticket_status',
              'tickets.ticket_type_id as ticket_type_id',
              'ticket_types.name as ticket_type_name',
              'seller_order.buyer_email as seller_buyer_email',
            ])
            .where('ticket_listings.id', '=', listingId)
            .where('ticket_listings.event_id', '=', body.eventId)
            .executeTakeFirst();

          if (!listing || listing.tenant_id !== event.tenant_id) {
            throw new NotFoundError('TicketListing', listingId);
          }
          if (!serializeResalePolicy(event).enabled) {
            throw new ValidationError('Resale is not enabled for this event');
          }
          if (listing.status !== 'listed') {
            throw new ValidationError(`Ticket listing ${listingId} is not listed`);
          }
          if (listing.ticket_status !== 'valid') {
            throw new ValidationError(
              `Ticket listing ${listingId} is attached to a ${listing.ticket_status} ticket`,
            );
          }
          if (listing.expires_at && new Date(listing.expires_at as Date | string) <= now) {
            await new TicketListingRepository(db).expire(listingId);
            throw new ValidationError(`Ticket listing ${listingId} has expired`);
          }
          if (
            listing.reserved_checkout_session_id &&
            listing.reserved_until &&
            new Date(listing.reserved_until as Date | string) > now
          ) {
            throw new ValidationError(`Ticket listing ${listingId} is already reserved`);
          }
          const buyerEmail = checkoutBuyer?.email;
          if (
            buyerEmail &&
            typeof listing.seller_buyer_email === 'string' &&
            listing.seller_buyer_email.toLowerCase() === buyerEmail
          ) {
            throw new ValidationError('Buyer cannot purchase their own resale listing');
          }

          const sessionId = `cs_${ulid()}`;
          const defaultReservationExpiry = new Date(Date.now() + 10 * 60 * 1000);
          const listingExpiry = listing.expires_at
            ? new Date(listing.expires_at as Date | string)
            : null;
          const reservedUntil =
            listingExpiry && listingExpiry < defaultReservationExpiry
              ? listingExpiry
              : defaultReservationExpiry;
          const eventQuestions = toVisibleDomainQuestions(
            (await db
              .selectFrom('questions')
              .selectAll()
              .where('event_id', '=', body.eventId)
              .execute()) as QuestionRow[],
          );
          const answeredAt = new Date().toISOString();
          const buyerFields = normalizeValidAnswers(
            applicableQuestions(eventQuestions, 'buyer'),
            body.buyerFields ?? {},
            'Buyer question',
            answeredAt,
          );
          await assertCompletedUploadArtifacts(db, event.tenant_id, body.eventId, buyerFields);

          const priceCents = Number(listing.price_cents);
          const quote = {
            id: `pq_${ulid()}`,
            currency: String(listing.currency).toUpperCase(),
            subtotalCents: priceCents,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
            totalCents: priceCents,
            lineItems: [
              {
                type: 'resale' as const,
                ticketTypeId: listing.ticket_type_id,
                resaleListingId: listingId,
                name: `Resale ticket - ${listing.ticket_type_name}`,
                quantity: 1,
                unitPriceCents: priceCents,
                subtotalCents: priceCents,
                discountCents: 0,
                taxCents: 0,
                taxBreakdown: [],
                feeCents: 0,
                totalCents: priceCents,
              },
            ],
            expiresAt: reservedUntil.toISOString(),
          };
          const cart: CartInput = {
            items: [{ resaleListingId: listingId, quantity: 1 }],
            affiliateCode: body.affiliateCode,
            trackingId: body.trackingId,
            buyerFields,
          };
          let sessionCreated = false;
          try {
            const session = await db.transaction().execute(async (trx) => {
              const reserved = await new TicketListingRepository(trx).reserveForCheckout({
                tenantId: event.tenant_id,
                listingId,
                checkoutSessionId: sessionId,
                reservedUntil,
                now,
              });
              if (!reserved) {
                throw new ValidationError(`Ticket listing ${listingId} is no longer available`);
              }
              const created = await new CheckoutSessionRepository(trx).create({
                id: sessionId,
                tenantId: event.tenant_id,
                eventId: body.eventId,
                brandId: event.brand_id,
                currency: quote.currency,
                cart: cart as Record<string, unknown>,
                buyer: (checkoutBuyer as Record<string, unknown>) ?? {},
                quote,
                expiresAt: reservedUntil,
                idempotencyKey,
                successUrl: body.successUrl,
                cancelUrl: body.cancelUrl,
              });
              sessionCreated = true;
              return created;
            });

            await claimCheckoutUploadArtifacts(db, event.tenant_id, body.eventId, cart, sessionId);

            return { status: 201, body: publicCheckoutSession(session) };
          } catch (err) {
            await Promise.allSettled([
              new TicketListingRepository(db).releaseCheckoutReservation({
                tenantId: event.tenant_id,
                listingId,
                checkoutSessionId: sessionId,
              }),
              compensateCheckoutSessionCreation({
                db,
                releaseHoldsForSession: async () => undefined,
                checkoutSessionId: sessionId,
                sessionCreated,
              }),
            ]);
            throw err;
          }
        }

        const ttRepo = new TicketTypeRepository(db);
        const productRepo = new ProductRepository(db);
        const [ticketTypes, products] = await Promise.all([
          ttRepo.findByEvent(body.eventId),
          productRepo.findByEvent(body.eventId),
        ]);
        const ttById = new Map(ticketTypes.map((t) => [t.id, t]));
        const productById = new Map(products.map((product) => [product.id, product]));
        const occurrenceIds = [
          ...new Set(
            body.items.map((item) => item.occurrenceId).filter((id): id is string => Boolean(id)),
          ),
        ];
        const occurrenceRows =
          occurrenceIds.length > 0
            ? await new EventOccurrenceRepository(db).findByEvent(body.eventId)
            : [];
        const occurrenceById = new Map(
          occurrenceRows.map((occurrence) => [occurrence.id, occurrence]),
        );
        for (const item of body.items) {
          if (!item.ticketTypeId) continue;
          const ticketType = ttById.get(item.ticketTypeId);
          if (!ticketType) continue;
          if (item.occurrenceId && !occurrenceById.has(item.occurrenceId)) {
            throw new NotFoundError('EventOccurrence', item.occurrenceId);
          }
          if (
            ticketType.event_occurrence_id &&
            item.occurrenceId &&
            ticketType.event_occurrence_id !== item.occurrenceId
          ) {
            throw new ValidationError(
              'Ticket type does not belong to the requested event occurrence',
            );
          }
        }
        const waitlistEntry = body.waitlistClaimToken
          ? await db
              .selectFrom('waitlist_entries')
              .selectAll()
              .where('claim_token_hash', '=', hashWaitlistClaimToken(body.waitlistClaimToken))
              .executeTakeFirst()
          : undefined;
        if (body.waitlistClaimToken && !waitlistEntry) {
          throw new NotFoundError('WaitlistOffer', 'claim');
        }
        if (waitlistEntry) {
          const now = new Date();
          if (
            waitlistEntry.status === 'reserved' &&
            waitlistEntry.reserved_until &&
            new Date(waitlistEntry.reserved_until) <= now
          ) {
            const released = await releaseExpiredWaitlistReservation({
              db,
              entryId: waitlistEntry.id,
              tenantId: event.tenant_id,
              now,
            });
            if (released) {
              waitlistEntry.status = 'offered';
              waitlistEntry.reserved_checkout_session_id = null;
              waitlistEntry.reserved_until = null;
            }
          }
          assertWaitlistOfferUsable(waitlistEntry, {
            eventId: body.eventId,
            items: body.items,
            buyerEmail: checkoutBuyer?.email,
          });
        }

        const normalizedItems = normalizeCartItems(body.items, ttById, productById);
        assertCheckoutLineItemQuantityBounds(normalizedItems, ttById, productById);

        // Load the event's custom questions and validate attendee answers.
        const questionRows = await db
          .selectFrom('questions')
          .selectAll()
          .where('event_id', '=', body.eventId)
          .execute();
        const eventQuestions = toVisibleDomainQuestions(questionRows as QuestionRow[]);
        const normalizedDiscountCode = body.discountCode
          ? normalizeDiscountCode(body.discountCode)
          : undefined;

        const sessionId = `cs_${ulid()}`;
        const answeredAt = new Date().toISOString();
        const buyerFields = normalizeValidAnswers(
          applicableQuestions(eventQuestions, 'buyer'),
          body.buyerFields ?? {},
          'Buyer question',
          answeredAt,
        );
        await assertCompletedUploadArtifacts(db, event.tenant_id, body.eventId, buyerFields);

        // Validate attendeeFields for each cart item against only questions
        // applicable to that attendee scope and ticket type.
        for (const item of body.items) {
          if (!item.ticketTypeId) continue;
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
          if (itemQuestions.length > 0) {
            for (let attendeeIndex = 0; attendeeIndex < item.quantity; attendeeIndex++) {
              const attendeeAnswers = item.attendeeFields?.[attendeeIndex] ?? {};
              assertValidAnswers(itemQuestions, attendeeAnswers, 'Attendee question');
              // eslint-disable-next-line no-await-in-loop -- each attendee answer set is validated against scoped upload artifacts before session persistence.
              await assertCompletedUploadArtifacts(
                db,
                event.tenant_id,
                body.eventId,
                attendeeAnswers,
              );
            }
          }
        }

        const ttMap = new Map<string, TicketTypeForPricing>();
        for (const tt of ticketTypes) {
          ttMap.set(tt.id, {
            id: tt.id,
            name: tt.name,
            kind: tt.kind as 'free' | 'paid' | 'donation',
            priceCents: Number(tt.price_cents),
            minimumPriceCents: tt.minimum_price_cents ? Number(tt.minimum_price_cents) : undefined,
            currency: tt.currency,
            minPerOrder: tt.min_per_order,
            maxPerOrder: tt.max_per_order,
          });
        }
        const productMap = new Map<string, ProductForPricing>();
        for (const product of products) {
          productMap.set(product.id, {
            id: product.id,
            name: product.name,
            priceCents: Number(product.price_cents),
            currency: product.currency,
            maxPerOrder: product.max_per_order,
            status: product.status as ProductForPricing['status'],
            availableFrom: toIsoString(product.available_from),
            availableUntil: toIsoString(product.available_until),
          });
        }

        // Load access rules for the requested ticket types only.
        const accessRuleRepo = new AccessRuleRepository(db);
        const ticketItems = normalizedItems.filter(
          (item): item is CartInput['items'][number] & { ticketTypeId: string } =>
            Boolean(item.ticketTypeId),
        );
        const accessRulesRows = (await accessRuleRepo.findByTicketTypes(
          ticketItems.map((i) => i.ticketTypeId),
        )) as unknown as AccessRuleRow[];
        const rulesByTicket = new Map<string, AccessRuleRow[]>();
        for (const row of accessRulesRows) {
          const list = rulesByTicket.get(row.ticket_type_id) ?? [];
          list.push(row);
          rulesByTicket.set(row.ticket_type_id, list);
        }
        const accessRuleValidationRecords = (rows?: AccessRuleRow[]): AccessRuleRecord[] =>
          (rows ?? []).map((row) => ({
            type: row.type as AccessRuleRecord['type'],
            value: row.value,
            maxUses: row.max_uses,
            usesCount: row.uses_count,
            expiresAt: row.expires_at,
          }));

        // Validate every line item before reserving inventory.
        const reservationItems: CartReservationItem[] = [];
        const accessRuleRedemptionsByRule = new Map<
          string,
          { accessRuleId: string; ticketTypeId: string }
        >();
        for (const item of ticketItems) {
          const ttRecord = ttById.get(item.ticketTypeId);
          if (!ttRecord) throw new NotFoundError('TicketType', item.ticketTypeId);
          const itemAccessRules = rulesByTicket.get(item.ticketTypeId);
          validateTicketPurchase({
            ticketType: {
              id: ttRecord.id,
              kind: ttRecord.kind as 'free' | 'paid' | 'donation',
              status: ttRecord.status as 'draft' | 'active' | 'paused' | 'sold_out' | 'ended',
              visibility: ttRecord.visibility as 'public' | 'hidden' | 'locked',
              priceCents: Number(ttRecord.price_cents),
              minimumPriceCents: ttRecord.minimum_price_cents
                ? Number(ttRecord.minimum_price_cents)
                : null,
              salesStartAt: ttRecord.sales_start_at,
              salesEndAt: ttRecord.sales_end_at,
              minPerOrder: ttRecord.min_per_order,
              maxPerOrder: ttRecord.max_per_order,
              requiresAccessCode: ttRecord.requires_access_code,
            },
            quantity: item.quantity,
            unitAmountCents: item.unitAmountCents,
            accessCode: body.accessCode,
            buyerEmail: checkoutBuyer?.email,
            accessRules: accessRuleValidationRecords(itemAccessRules),
          });
          if (ttRecord.visibility === 'locked' || ttRecord.requires_access_code) {
            const matchedAccessRule = itemAccessRules?.find((row) =>
              accessRuleRowMatches(row, {
                accessCode: body.accessCode,
                buyerEmail: checkoutBuyer?.email,
                now: new Date(answeredAt),
              }),
            );
            if (!matchedAccessRule) throw new AccessCodeRequiredError(item.ticketTypeId);
            accessRuleRedemptionsByRule.set(matchedAccessRule.id, {
              accessRuleId: matchedAccessRule.id,
              ticketTypeId: item.ticketTypeId,
            });
          }
          reservationItems.push({
            inventoryPoolId: ttRecord.inventory_pool_id,
            ticketTypeId: ttRecord.id,
            ...(item.occurrenceId ? { occurrenceId: item.occurrenceId } : {}),
            quantity: item.quantity,
          });
        }

        const discountRepo = new DiscountCodeRepository(db);
        const taxRepo = new TaxRuleRepository(db);
        const feeRepo = new FeeRuleRepository(db);
        const [discounts, taxRules, feeRules] = await Promise.all([
          discountRepo.findByEvent(body.eventId),
          taxRepo.findByEvent(body.eventId),
          feeRepo.findByEvent(body.eventId),
        ]);

        const attendeeFields = normalizeAttendeeFieldsForCartItems(
          normalizedItems,
          eventQuestions,
          answeredAt,
        );

        const cart: CartInput = {
          items: attendeeFields.items.map((i) => ({
            ticketTypeId: i.ticketTypeId,
            occurrenceId: i.occurrenceId,
            productId: i.productId,
            resaleListingId: i.resaleListingId,
            quantity: i.quantity,
            unitAmountCents: i.unitAmountCents,
            attendeeFields: i.attendeeFields,
          })),
          discountCode: normalizedDiscountCode,
          accessRuleRedemptions:
            accessRuleRedemptionsByRule.size > 0
              ? [...accessRuleRedemptionsByRule.values()]
              : undefined,
          affiliateCode: body.affiliateCode,
          trackingId: body.trackingId,
          buyerFields,
          attendeeFields: attendeeFields.attendeeFieldsByTicketType,
          waitlistEntryId: waitlistEntry?.id,
        };

        const firstItem = normalizedItems[0];
        const currency = firstItem.ticketTypeId
          ? (ttById.get(firstItem.ticketTypeId)?.currency ?? 'USD')
          : (productById.get(firstItem.productId!)?.currency ?? 'USD');
        const quote = pricingEngine.calculate({
          currency,
          cart,
          ticketTypes: ttMap,
          products: productMap,
          taxRules: (taxRules as TaxRuleRow[]).map(toDomainTaxRule),
          feeRules: (feeRules as FeeRuleRow[]).map(toDomainFeeRule),
          discountCodes: (discounts as DiscountCodeRow[]).map(toDomainDiscountCode),
        });
        // Reserve inventory across every pool the cart draws from.
        const sessionRepo = new CheckoutSessionRepository(db);
        let sessionCreated = false;
        let waitlistReserved = false;
        try {
          if (waitlistEntry) {
            await reserveWaitlistOfferForCheckout({
              db,
              entryId: waitlistEntry.id,
              tenantId: event.tenant_id,
              eventId: body.eventId,
              checkoutSessionId: sessionId,
              reservedUntil: new Date(Date.now() + 10 * 60 * 1000),
              now: new Date(answeredAt),
            });
            waitlistReserved = true;
          }

          const reservation =
            reservationItems.length > 0
              ? await inventoryService.reserveCart({
                  items: reservationItems,
                  checkoutSessionId: sessionId,
                })
              : { primaryHoldId: null, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };

          if (waitlistEntry) {
            await updateWaitlistReservationExpiry({
              db,
              entryId: waitlistEntry.id,
              tenantId: event.tenant_id,
              checkoutSessionId: sessionId,
              reservedUntil: reservation.expiresAt,
              now: new Date(),
            });
          }

          const session = await sessionRepo.create({
            id: sessionId,
            tenantId: event.tenant_id,
            eventId: body.eventId,
            brandId: event.brand_id,
            holdId: reservation.primaryHoldId ?? undefined,
            currency: quote.currency,
            cart: cart as Record<string, unknown>,
            buyer: (checkoutBuyer as Record<string, unknown>) ?? {},
            quote: quote as Record<string, unknown>,
            expiresAt: reservation.expiresAt,
            idempotencyKey,
            successUrl: body.successUrl,
            cancelUrl: body.cancelUrl,
          });
          sessionCreated = true;
          await claimCheckoutUploadArtifacts(db, event.tenant_id, body.eventId, cart, sessionId);

          return { status: 201, body: publicCheckoutSession(session) };
        } catch (error) {
          await compensateCheckoutSessionCreation({
            db,
            releaseHoldsForSession: (id) => inventoryService.releaseHoldsForSession(id),
            checkoutSessionId: sessionId,
            sessionCreated,
          });
          if (waitlistEntry && waitlistReserved) {
            await releaseWaitlistCheckoutReservation({
              db,
              entryId: waitlistEntry.id,
              tenantId: event.tenant_id,
              checkoutSessionId: sessionId,
            });
          }
          throw error;
        }
      },
    );

    return reply.status(result.status).send(result.body);
  });

  app.get('/checkout/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const { payment_intent_client_secret: paymentIntentClientSecret } = request.query as {
      payment_intent_client_secret?: string;
    };

    const repo = new CheckoutSessionRepository(db);
    const session = await repo.findById(sessionId);
    if (!session) throw new NotFoundError('CheckoutSession', sessionId);
    const clientToken = request.headers['x-checkout-session-token'];
    let includeClientToken = false;
    if (typeof clientToken === 'string') {
      assertCheckoutSessionToken(session, clientToken);
      includeClientToken = true;
    } else if (
      typeof paymentIntentClientSecret === 'string' &&
      paymentIntentClientSecret.length > 0 &&
      session.status === 'pending_payment'
    ) {
      const paymentIntent = await db
        .selectFrom('payment_intents')
        .select(['id'])
        .where('checkout_session_id', '=', sessionId)
        .where('client_secret', '=', paymentIntentClientSecret)
        .executeTakeFirst();
      if (!paymentIntent) {
        throw new ValidationError('X-Checkout-Session-Token header is required');
      }
    } else if (session.status !== 'completed') {
      throw new ValidationError('X-Checkout-Session-Token header is required');
    }

    const compensation = await new PaymentCompensationRepository(db).findLatestByCheckoutSession(
      sessionId,
    );
    return publicCheckoutSession(session, compensation, { includeClientToken });
  });

  app.get('/checkout/sessions/:sessionId/wallet-passes', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const repo = new CheckoutSessionRepository(db);
    const session = await repo.findById(sessionId);
    if (!session) throw new NotFoundError('CheckoutSession', sessionId);

    const clientToken = request.headers['x-checkout-session-token'];
    if (typeof clientToken !== 'string') {
      throw new ValidationError('X-Checkout-Session-Token header is required');
    }
    assertCheckoutSessionToken(session, clientToken);

    if (!session.order_id) return { tickets: [] };

    const rows = await db
      .selectFrom('wallet_passes')
      .innerJoin('tickets', 'tickets.id', 'wallet_passes.ticket_id')
      .innerJoin('ticket_types', 'ticket_types.id', 'tickets.ticket_type_id')
      .innerJoin('events', 'events.id', 'tickets.event_id')
      .select([
        'wallet_passes.ticket_id as ticket_id',
        'wallet_passes.provider as provider',
        'wallet_passes.pass_url as pass_url',
        'tickets.code as ticket_code',
        'ticket_types.price_cents as face_value_cents',
        'ticket_types.currency as currency',
        'events.resale_enabled as resale_enabled',
        'events.resale_max_multiplier as resale_max_multiplier',
        'events.resale_max_absolute_cents as resale_max_absolute_cents',
      ])
      .where('wallet_passes.tenant_id', '=', session.tenant_id)
      .where('tickets.order_id', '=', session.order_id)
      .where('wallet_passes.status', '=', 'active')
      .orderBy('tickets.id', 'asc')
      .execute();

    const tickets = new Map<
      string,
      {
        ticketId: string;
        ticketCode: string;
        faceValueCents: number;
        currency: string;
        resaleEnabled: boolean;
        resaleMaxPriceCents: number;
        activeResaleListing?: ReturnType<typeof serializeTicketListing>;
        appleUrl?: string;
        googleUrl?: string;
      }
    >();
    for (const row of rows) {
      const resalePolicy = serializeResalePolicy(row);
      const capByMultiplier = Math.round(Number(row.face_value_cents) * resalePolicy.maxMultiplier);
      const resaleMaxPriceCents =
        resalePolicy.maxAbsoluteCents === undefined
          ? capByMultiplier
          : Math.min(capByMultiplier, resalePolicy.maxAbsoluteCents);
      const current = tickets.get(row.ticket_id) ?? {
        ticketId: row.ticket_id,
        ticketCode: row.ticket_code,
        faceValueCents: Number(row.face_value_cents),
        currency: String(row.currency),
        resaleEnabled: resalePolicy.enabled,
        resaleMaxPriceCents,
      };
      if (row.provider === 'apple') current.appleUrl = row.pass_url;
      if (row.provider === 'google') current.googleUrl = row.pass_url;
      tickets.set(row.ticket_id, current);
    }

    const ticketIds = [...tickets.keys()];
    if (ticketIds.length > 0) {
      const listings = await db
        .selectFrom('ticket_listings')
        .selectAll()
        .where('tenant_id', '=', session.tenant_id)
        .where('ticket_id', 'in', ticketIds)
        .where('status', '=', 'listed')
        .execute();
      for (const listing of listings) {
        const ticket = tickets.get(listing.ticket_id);
        if (ticket) ticket.activeResaleListing = serializeTicketListing(listing);
      }
    }

    return { tickets: [...tickets.values()] };
  });

  app.post(
    '/checkout/sessions/:sessionId/tickets/:ticketId/resale-listing',
    async (request, reply) => {
      const { sessionId, ticketId } = request.params as { sessionId: string; ticketId: string };
      const clientToken = requireCheckoutSessionToken(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const body = parseBody(createResaleListingSchema, request.body);

      const sessionRepo = new CheckoutSessionRepository(db);
      const session = await sessionRepo.findById(sessionId);
      if (!session) throw new NotFoundError('CheckoutSession', sessionId);
      assertCheckoutSessionToken(session, clientToken);
      if (session.status !== 'completed' || !session.order_id) {
        throw new ValidationError('Only completed checkout sessions can list tickets for resale');
      }

      const ticketRepo = new TicketRepository(db);
      const ticket = await ticketRepo.findById(ticketId);
      if (
        !ticket ||
        ticket.tenant_id !== session.tenant_id ||
        ticket.order_id !== session.order_id ||
        ticket.event_id !== session.event_id
      ) {
        throw new NotFoundError('Ticket', ticketId);
      }
      if (ticket.status !== 'valid') {
        throw new ValidationError(`Ticket status is ${ticket.status}, cannot list for resale`);
      }

      const event = await new EventRepository(db).findById(ticket.event_id);
      if (!event || event.tenant_id !== session.tenant_id) {
        throw new NotFoundError('Event', ticket.event_id);
      }
      const ticketType = await new TicketTypeRepository(db).findById(ticket.ticket_type_id);
      if (!ticketType || ticketType.event_id !== ticket.event_id) {
        throw new NotFoundError('TicketType', ticket.ticket_type_id);
      }

      const requestHash = hashRequest({
        sessionId,
        ticketId,
        priceCents: body.priceCents,
        expiresAt: body.expiresAt ?? null,
      });

      const result = await withIdempotency(
        db,
        { key: idempotencyKey, tenantId: session.tenant_id, requestHash },
        async () => {
          const listingRepo = new TicketListingRepository(db);
          const active = await listingRepo.findActiveByTicket(session.tenant_id, ticketId);
          if (active) {
            throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
          }

          const faceValueCents = Number(ticketType.price_cents);
          try {
            validateResalePrice(body.priceCents, faceValueCents, serializeResalePolicy(event));
          } catch (error) {
            toResaleValidationError(error);
          }

          try {
            const listing = await listingRepo.create({
              tenantId: session.tenant_id,
              eventId: ticket.event_id,
              ticketId,
              sellerId: session.order_id as string,
              priceCents: body.priceCents,
              currency: String(ticketType.currency),
              faceValueCents,
              expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
            });
            return { status: 201, body: serializeTicketListing(listing) };
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new ValidationError(`Ticket ${ticketId} already has an active resale listing`);
            }
            throw error;
          }
        },
      );

      return reply.status(result.status).send(result.body);
    },
  );

  app.get('/wallet-passes/:passId/apple.pkpass', async (request, reply) => {
    const { passId } = request.params as { passId: string };
    const { token } = request.query as { token?: string };
    if (!token) {
      throw new NotFoundError('WalletPass', passId);
    }

    const pass = await db
      .selectFrom('wallet_passes')
      .selectAll()
      .where('id', '=', passId)
      .where('provider', '=', 'apple')
      .executeTakeFirst();
    if (
      !pass ||
      pass.status !== 'active' ||
      !tokenHashMatches(pass.access_token_hash, token) ||
      !pass.artifact_base64
    ) {
      throw new NotFoundError('WalletPass', passId);
    }

    const content = Buffer.from(pass.artifact_base64, 'base64');
    return reply
      .header('Content-Type', pass.content_type ?? 'application/vnd.apple.pkpass')
      .header('Content-Disposition', `attachment; filename="${pass.serial_number}.pkpass"`)
      .send(content);
  });

  app.patch('/checkout/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const clientToken = requireCheckoutSessionToken(request);
    const isDev = process.env.NODE_ENV === 'development';
    const body = parseBody(updateCheckoutSessionSchema(isDev), request.body);
    const repo = new CheckoutSessionRepository(db);
    const session = await repo.findById(sessionId);
    if (!session) throw new NotFoundError('CheckoutSession', sessionId);
    assertCheckoutSessionToken(session, clientToken);
    if (session.status !== 'open') {
      throw new ValidationError(`Checkout session is not editable: ${session.status}`);
    }
    if (session.payment_intent_id) {
      throw new ValidationError('Checkout session is not editable: payment is in progress');
    }
    const updateData = pickAllowedFields(
      body as Record<string, unknown>,
      ['buyer', 'successUrl', 'cancelUrl'],
      {
        successUrl: 'success_url',
        cancelUrl: 'cancel_url',
      },
    );
    if (updateData.buyer) {
      const cart = parseJsonValue<{ waitlistEntryId?: string }>(session.cart, {});
      const nextBuyer = normalizeCheckoutBuyer(
        updateData.buyer as CreateCheckoutSessionInput['buyer'],
      );
      if (cart.waitlistEntryId) {
        if (!nextBuyer?.email) {
          throw new ValidationError('Waitlist checkout buyer email cannot be removed');
        }
        const waitlistEntry = await db
          .selectFrom('waitlist_entries')
          .select(['buyer_email'])
          .where('id', '=', cart.waitlistEntryId)
          .where('tenant_id', '=', session.tenant_id)
          .executeTakeFirst();
        if (!waitlistEntry) throw new NotFoundError('WaitlistOffer', cart.waitlistEntryId);
        if (nextBuyer.email !== waitlistEntry.buyer_email) {
          throw new ValidationError('Waitlist checkout buyer email cannot be changed');
        }
      }
      updateData.buyer = JSON.stringify(nextBuyer ?? {});
    }
    const updated = await repo.update(sessionId, updateData);
    return publicCheckoutSession(updated);
  });

  app.post('/checkout/sessions/:sessionId/confirm', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = parseBody(confirmCheckoutSchema, request.body);
    const idempotencyKey = requireIdempotencyKey(request);
    const clientToken = requireCheckoutSessionToken(request);

    const sessionRepo = new CheckoutSessionRepository(db);
    const orderRepo = new OrderRepository(db);
    const eventRepo = new EventRepository(db);
    const session = await sessionRepo.findById(sessionId);
    if (!session) throw new NotFoundError('CheckoutSession', sessionId);
    assertCheckoutSessionToken(session, clientToken);
    const event = await eventRepo.findById(session.event_id);
    if (!event) throw new NotFoundError('Event', session.event_id);

    if (session.status === 'completed') {
      const order = await orderRepo.findById(session.order_id!);
      if (!order) throw new NotFoundError('Order', session.order_id!);
      return reply.status(200).send({ order, sessionId, status: 'completed' });
    }

    if (new Date(session.expires_at) < new Date()) {
      throw new CheckoutExpiredError(sessionId);
    }

    const quote = parseJsonValue<{ totalCents: number; feeCents: number }>(session.quote, {
      totalCents: 0,
      feeCents: 0,
    });
    const buyer = parseJsonValue<{ email?: string }>(session.buyer, {});
    const cart = parseJsonValue<{ affiliateCode?: string }>(session.cart, {});

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: session.tenant_id,
        requestHash: hashRequest({
          sessionId,
          paymentMethodId: body.paymentMethodId,
        }),
      },
      async () => {
        // Allow retry from pending_payment (buyer abandoned or the client lost
        // the response). A checkout workflow is keyed by session id, so a
        // second start would return the same workflow; return its active
        // PaymentIntent instead of pretending this is a new attempt.
        if (session.status !== 'open' && session.status !== 'pending_payment') {
          if (session.status === 'expired') {
            throw new CheckoutExpiredError(sessionId);
          }
          if (session.status === 'cancelled') {
            return {
              status: 409,
              body: {
                error: {
                  code: 'CHECKOUT_CANCELLED',
                  message: 'Checkout session has been cancelled',
                  requestId: request.id,
                },
              },
            };
          }
          throw new ValidationError(`Checkout session is not open: ${session.status}`);
        }

        if (session.status === 'pending_payment') {
          const workflowId = `checkout-session:${sessionId}`;
          let state: CheckoutState;
          try {
            state = await temporalClient.getCheckoutState(workflowId);
          } catch (err) {
            const durablePendingPayment = await readDurablePendingPayment({
              sessionId,
              tenantId: session.tenant_id,
              totalCents: quote.totalCents,
              currency: session.currency,
            });
            if (durablePendingPayment) {
              return { status: 200, body: durablePendingPayment };
            }

            return {
              status: 503,
              body: {
                error: {
                  code: 'SERVICE_UNAVAILABLE',
                  message: err instanceof Error ? err.message : 'Payment intent is being created',
                  requestId: request.id,
                },
              },
            };
          }
          if (state.status === 'completed' && state.orderId) {
            const order = await orderRepo.findById(state.orderId);
            if (!order) throw new NotFoundError('Order', state.orderId);
            return { status: 200, body: { order, sessionId, status: 'completed' } };
          }
          if (state.status === 'failed') {
            return {
              status: 402,
              body: {
                error: {
                  code: 'PAYMENT_RETRY_REQUIRED',
                  message: state.error ?? 'Payment failed. Retry checkout with a fresh session.',
                  requestId: request.id,
                },
              },
            };
          }
          if (state.status === 'cancelled') {
            return {
              status: 409,
              body: {
                error: {
                  code: 'CHECKOUT_CANCELLED',
                  message: 'Checkout session has been cancelled',
                  requestId: request.id,
                },
              },
            };
          }
          if (state.paymentIntentId) {
            return {
              status: 200,
              body: {
                sessionId,
                status: 'pending_payment',
                paymentIntentId: state.paymentIntentId,
                clientSecret: state.clientSecret,
                totalCents: quote.totalCents,
                currency: session.currency,
              },
            };
          }
        }

        const handle = await temporalClient.startCheckoutSession({
          checkoutSessionId: sessionId,
          tenantId: session.tenant_id,
          organizationId: event.organization_id,
          eventId: session.event_id,
          brandId: session.brand_id,
          holdId: session.hold_id ?? undefined,
          currency: session.currency,
          amountCents: quote.totalCents,
          feeCents: quote.feeCents,
          buyerEmail: buyer.email ?? '',
          isFreeOrder: quote.totalCents === 0,
          affiliateCode: cart.affiliateCode,
        });

        if (quote.totalCents === 0) {
          const workflowResult = await handle.result();
          if (workflowResult.status === 'completed' && workflowResult.orderId) {
            const order = await orderRepo.findById(workflowResult.orderId);
            if (!order) throw new NotFoundError('Order', workflowResult.orderId);
            return { status: 200, body: { order, sessionId, status: 'completed' } };
          }
          return {
            status: 409,
            body: {
              error: {
                code: 'CHECKOUT_FINALIZATION_FAILED',
                message: 'Checkout could not be finalized',
                requestId: request.id,
              },
            },
          };
        }

        // Poll the workflow until the payment intent is created or it fails.
        const deadline = Date.now() + 5000;
        let lastError: Error | null = null;
        let state: CheckoutState | undefined;
        while (Date.now() < deadline) {
          try {
            // eslint-disable-next-line no-await-in-loop -- checkout state polling must observe each Temporal state transition before deciding whether to retry.
            state = await temporalClient.getCheckoutState(handle.workflowId);
            if (state.status === 'completed' && state.orderId) {
              // eslint-disable-next-line no-await-in-loop -- a completed state exits the polling loop immediately after loading the finalized order.
              const order = await orderRepo.findById(state.orderId);
              if (!order) throw new NotFoundError('Order', state.orderId);
              return { status: 200, body: { order, sessionId, status: 'completed' } };
            }
            if (state.paymentIntentId) break;
            if (state.status === 'failed') {
              return {
                status: 402,
                body: {
                  error: {
                    code: 'PAYMENT_FAILED',
                    message: state.error ?? 'Payment intent creation failed',
                    requestId: request.id,
                  },
                },
              };
            }
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            // eslint-disable-next-line no-await-in-loop -- after a payment-intent creation failure, check for a durable pending payment before retrying.
            const durablePendingPayment = await readDurablePendingPayment({
              sessionId,
              tenantId: session.tenant_id,
              totalCents: quote.totalCents,
              currency: session.currency,
            });
            if (durablePendingPayment) {
              return { status: 200, body: durablePendingPayment };
            }
          }
          // eslint-disable-next-line no-await-in-loop -- retry delay intentionally spaces Temporal state reads until the payment intent appears or the deadline expires.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (state?.paymentIntentId?.startsWith('pi_capture_')) {
          const workflowResult = await handle.result();
          if (workflowResult.status === 'completed' && workflowResult.orderId) {
            const order = await orderRepo.findById(workflowResult.orderId);
            if (!order) throw new NotFoundError('Order', workflowResult.orderId);
            return { status: 200, body: { order, sessionId, status: 'completed' } };
          }
          if (workflowResult.status === 'failed') {
            return {
              status: 402,
              body: {
                error: {
                  code: 'PAYMENT_FAILED',
                  message: 'Payment failed',
                  requestId: request.id,
                },
              },
            };
          }
        }

        if (!state?.paymentIntentId) {
          return {
            status: 503,
            body: {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: lastError?.message ?? 'Payment intent is being created',
                requestId: request.id,
              },
            },
          };
        }

        await sessionRepo.update(sessionId, { status: 'pending_payment' });
        return {
          status: 200,
          body: {
            sessionId,
            status: 'pending_payment',
            paymentIntentId: state.paymentIntentId,
            clientSecret: state.clientSecret,
            totalCents: quote.totalCents,
            currency: session.currency,
          },
        };
      },
    );

    return reply.status(result.status).send(result.body);
  });
};
