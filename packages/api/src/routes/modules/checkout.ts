import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import {
  EventRepository,
  TicketTypeRepository,
  CheckoutSessionRepository,
  OrderRepository,
  DiscountCodeRepository,
  TaxRuleRepository,
  FeeRuleRepository,
  AccessRuleRepository,
  ProductRepository,
  EventOccurrenceRepository,
  PaymentCompensationRepository,
} from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
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
  CheckoutExpiredError,
  validateTicketPurchase,
  validateAnswers,
  normalizeQuestionAnswers,
  validateBoxOfficeOrder,
  BoxOfficeError,
} from '@tixkit/domain';
import type { Question } from '@tixkit/domain';
import { parseJsonValue, pickAllowedFields, serializeOrder } from '../../http/contracts.js';
import {
  createCheckoutSessionSchema,
  createBoxOfficeOrderSchema,
  updateCheckoutSessionSchema,
  confirmCheckoutSchema,
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
    clientToken: session.client_token,
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
      quantity: number;
      unitAmountCents?: number;
      attendeeFields?: Record<string, unknown>[];
    }
  >();

  for (const item of items) {
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

function toDomainQuestion(q: QuestionRow): Question {
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
    options: q.options ? (JSON.parse(q.options) as string[]) : undefined,
    placeholder: q.placeholder ?? undefined,
    validationPattern: q.validation_pattern ?? undefined,
    conditionalVisibility: q.conditional_visibility
      ? (JSON.parse(q.conditional_visibility) as Question['conditionalVisibility'])
      : undefined,
    sortOrder: q.sort_order,
    isConsentField: q.is_consent_field,
    consentText: q.consent_text ?? undefined,
    consentVersion: q.consent_version ?? undefined,
  };
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
  if (input.buyerEmail && input.buyerEmail.trim().toLowerCase() !== entry.buyer_email) {
    throw new ValidationError('Waitlist offer email does not match the checkout buyer');
  }
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

function toIsoString(value: Date | string | null): string | undefined {
  if (value == null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
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

  app.post('/events/:eventId/box-office/orders', async (request, reply) => {
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
          occurrenceIds.length > 0 ? await new EventOccurrenceRepository(db).findByEvent(eventId) : [];
        const occurrenceById = new Map(
          occurrenceRows.map((occurrence) => [occurrence.id, occurrence]),
        );
        const eventQuestions: Question[] = (
          (await db
            .selectFrom('questions')
            .selectAll()
            .where('event_id', '=', eventId)
            .execute()) as QuestionRow[]
        )
          .filter(isVisibleCheckoutQuestion)
          .map((question) => toDomainQuestion(question));
        const answeredAt = new Date().toISOString();
        const buyerFields = normalizeValidAnswers(
          applicableQuestions(eventQuestions, 'buyer'),
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
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
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
            quantity: item.quantity,
          });
        }

        const [discounts, taxRules, feeRules] = await Promise.all([
          new DiscountCodeRepository(db).findByEvent(eventId),
          new TaxRuleRepository(db).findByEvent(eventId),
          new FeeRuleRepository(db).findByEvent(eventId),
        ]);
        const attendeeFieldsByTicketType: Record<string, unknown[]> = {};
        for (const item of body.items) {
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
          if (itemQuestions.length === 0) continue;
          const fields = Array.from({ length: item.quantity }, (_, attendeeIndex) =>
            normalizeQuestionAnswers(
              itemQuestions,
              item.attendeeFields?.[attendeeIndex] ?? {},
              answeredAt,
            ),
          );
          if (fields.some((fieldSet) => Object.keys(fieldSet).length > 0)) {
            attendeeFieldsByTicketType[item.ticketTypeId] = fields;
          }
        }
        const cart: CartInput = {
          items: normalizedItems.map((item) => ({
            ticketTypeId: item.ticketTypeId,
            occurrenceId: item.occurrenceId,
            quantity: item.quantity,
            attendeeFields: item.attendeeFields,
          })),
          buyerFields,
          attendeeFields: attendeeFieldsByTicketType,
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
        const sessionId = `cs_${ulid()}`;
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
        const workflowResult = await handle.result();
        if (workflowResult.status !== 'completed' || !workflowResult.orderId) {
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
      },
    );

    return reply.status(result.status).send(result.body);
  });

  // Public buyer-facing checkout. No admin principal is required; tenancy is
  // resolved from the (published) event being purchased. Session IDs are
  // unguessable ULIDs, so retrieval/confirmation by ID is safe to expose.
  app.post('/checkout/sessions', async (request, reply) => {
    const isDev = process.env.NODE_ENV === 'development';
    const body = parseBody(createCheckoutSessionSchema(isDev), request.body);
    const idempotencyKey = requireIdempotencyKey(request);

    if (!body.items || body.items.length === 0) {
      throw new ValidationError('Checkout requires at least one item');
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
        requestHash: hashRequest(body),
      },
      async () => {
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
          assertWaitlistOfferUsable(waitlistEntry, {
            eventId: body.eventId,
            items: body.items,
            buyerEmail: body.buyer?.email,
          });
        }

        // Load the event's custom questions and validate attendee answers.
        const questionRows = await db
          .selectFrom('questions')
          .selectAll()
          .where('event_id', '=', body.eventId)
          .execute();
        const eventQuestions: Question[] = (questionRows as QuestionRow[])
          .filter(isVisibleCheckoutQuestion)
          .map((q) => toDomainQuestion(q));

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

        const normalizedItems = normalizeCartItems(body.items, ttById, productById);
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
        const accessRulesRows = await accessRuleRepo.findByTicketTypes(
          ticketItems.map((i) => i.ticketTypeId),
        );
        const rulesByTicket = new Map<string, AccessRuleRecord[]>();
        for (const row of accessRulesRows) {
          const list = rulesByTicket.get(row.ticket_type_id) ?? [];
          list.push({
            type: row.type as AccessRuleRecord['type'],
            value: row.value,
            maxUses: row.max_uses,
            usesCount: row.uses_count,
            expiresAt: row.expires_at,
          });
          rulesByTicket.set(row.ticket_type_id, list);
        }

        // Validate every line item before reserving inventory.
        const reservationItems: CartReservationItem[] = [];
        for (const item of ticketItems) {
          const ttRecord = ttById.get(item.ticketTypeId);
          if (!ttRecord) throw new NotFoundError('TicketType', item.ticketTypeId);
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
            buyerEmail: body.buyer?.email,
            accessRules: rulesByTicket.get(item.ticketTypeId),
          });
          reservationItems.push({
            inventoryPoolId: ttRecord.inventory_pool_id,
            ticketTypeId: ttRecord.id,
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

        // Build a map of ticketTypeId → attendeeFields for persistence.
        const attendeeFieldsByTicketType: Record<string, unknown[]> = {};
        for (const item of body.items) {
          if (!item.ticketTypeId) continue;
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
          if (itemQuestions.length > 0) {
            const fields = Array.from({ length: item.quantity }, (_, attendeeIndex) =>
              normalizeQuestionAnswers(
                itemQuestions,
                item.attendeeFields?.[attendeeIndex] ?? {},
                answeredAt,
              ),
            );
            if (fields.some((fieldSet) => Object.keys(fieldSet).length > 0)) {
              attendeeFieldsByTicketType[item.ticketTypeId] = fields;
            }
          }
        }

        const cart: CartInput = {
          items: normalizedItems.map((i) => ({
            ticketTypeId: i.ticketTypeId,
            occurrenceId: i.occurrenceId,
            productId: i.productId,
            quantity: i.quantity,
            unitAmountCents: i.unitAmountCents,
            attendeeFields: i.attendeeFields,
          })),
          discountCode: body.discountCode,
          affiliateCode: body.affiliateCode,
          trackingId: body.trackingId,
          buyerFields,
          attendeeFields: attendeeFieldsByTicketType,
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
        const sessionId = `cs_${ulid()}`;
        const reservation =
          reservationItems.length > 0
            ? await inventoryService.reserveCart({
                items: reservationItems,
                checkoutSessionId: sessionId,
              })
            : { primaryHoldId: null, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };

        const session = await sessionRepo.create({
          id: sessionId,
          tenantId: event.tenant_id,
          eventId: body.eventId,
          brandId: event.brand_id,
          holdId: reservation.primaryHoldId ?? undefined,
          currency: quote.currency,
          cart: cart as Record<string, unknown>,
          buyer: (body.buyer as Record<string, unknown>) ?? {},
          quote: quote as Record<string, unknown>,
          expiresAt: reservation.expiresAt,
          idempotencyKey,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
        });

        return { status: 201, body: publicCheckoutSession(session) };
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
    if (typeof clientToken === 'string') {
      assertCheckoutSessionToken(session, clientToken);
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
    return publicCheckoutSession(session, compensation);
  });

  app.get('/checkout/sessions/:sessionId/wallet-passes', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const repo = new CheckoutSessionRepository(db);
    const session = await repo.findById(sessionId);
    if (!session) throw new NotFoundError('CheckoutSession', sessionId);

    const clientToken = request.headers['x-checkout-session-token'];
    if (typeof clientToken === 'string') {
      assertCheckoutSessionToken(session, clientToken);
    } else if (session.status !== 'completed') {
      throw new ValidationError('X-Checkout-Session-Token header is required');
    }

    if (!session.order_id) return { tickets: [] };

    const rows = await db
      .selectFrom('wallet_passes')
      .innerJoin('tickets', 'tickets.id', 'wallet_passes.ticket_id')
      .select([
        'wallet_passes.ticket_id as ticket_id',
        'wallet_passes.provider as provider',
        'wallet_passes.pass_url as pass_url',
        'tickets.code as ticket_code',
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
        appleUrl?: string;
        googleUrl?: string;
      }
    >();
    for (const row of rows) {
      const current = tickets.get(row.ticket_id) ?? {
        ticketId: row.ticket_id,
        ticketCode: row.ticket_code,
      };
      if (row.provider === 'apple') current.appleUrl = row.pass_url;
      if (row.provider === 'google') current.googleUrl = row.pass_url;
      tickets.set(row.ticket_id, current);
    }

    return { tickets: [...tickets.values()] };
  });

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
    if (updateData.buyer) updateData.buyer = JSON.stringify(updateData.buyer);
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
        if (session.status === 'completed') {
          const order = await orderRepo.findById(session.order_id!);
          if (!order) throw new NotFoundError('Order', session.order_id!);
          return { status: 200, body: { order, sessionId, status: 'completed' } };
        }

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
          const order = await orderRepo.findById(workflowResult.orderId!);
          if (!order) throw new NotFoundError('Order', workflowResult.orderId!);
          return { status: 200, body: { order, sessionId, status: workflowResult.status } };
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
