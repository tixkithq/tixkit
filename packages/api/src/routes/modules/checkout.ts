import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
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
} from '@gatekit/db';
import type { TicketTypeForPricing } from '../../services/pricing.js';
import type { CartReservationItem } from '../../services/inventory.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import type { CheckoutState } from '@gatekit/workflows';
import type {
  CreateCheckoutSessionInput,
  CartInput,
  AccessRuleRecord,
  DiscountCode,
  FeeRule,
  TaxRule,
} from '@gatekit/domain';
import {
  NotFoundError,
  ValidationError,
  CheckoutExpiredError,
  validateTicketPurchase,
  validateAnswers,
  normalizeQuestionAnswers,
} from '@gatekit/domain';
import type { Question } from '@gatekit/domain';
import { parseJsonValue, pickAllowedFields } from '../../http/contracts.js';
import {
  createCheckoutSessionSchema,
  updateCheckoutSessionSchema,
  confirmCheckoutSchema,
  parseBody,
} from '../../http/schemas.js';

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

function assertCheckoutSessionToken(session: { id: string; client_token: string }, clientToken: string) {
  if (session.client_token !== clientToken) {
    throw new NotFoundError('CheckoutSession', session.id);
  }
}

function publicCheckoutSession(session: {
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
}) {
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
  };
}

function normalizeCartItems(
  items: CreateCheckoutSessionInput['items'],
  ticketTypes: Map<string, { kind: string; price_cents: number }>,
): CartInput['items'] {
  const normalized = new Map<string, { ticketTypeId: string; quantity: number; unitAmountCents?: number }>();

  for (const item of items) {
    const ticketType = ticketTypes.get(item.ticketTypeId);
    if (!ticketType) throw new NotFoundError('TicketType', item.ticketTypeId);
    if (ticketType.kind !== 'donation' && item.unitAmountCents !== undefined) {
      throw new ValidationError(`unitAmountCents is only accepted for donation ticket ${item.ticketTypeId}`);
    }

    const existing = normalized.get(item.ticketTypeId);
    const unitAmountCents = ticketType.kind === 'donation' ? item.unitAmountCents : undefined;
    if (existing) {
      if (existing.unitAmountCents !== unitAmountCents) {
        throw new ValidationError(`Duplicate donation lines for ${item.ticketTypeId} must use the same amount`);
      }
      existing.quantity += item.quantity;
    } else {
      normalized.set(item.ticketTypeId, {
        ticketTypeId: item.ticketTypeId,
        quantity: item.quantity,
        unitAmountCents,
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
  sort_order: number;
  is_consent_field: boolean;
  consent_text: string | null;
  consent_version: string | null;
};

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

function assertValidAnswers(questions: Question[], answers: Record<string, unknown>, context: string): void {
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

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: event.tenant_id,
        requestHash: hashRequest({ eventId: body.eventId, items: body.items, buyer: body.buyer }),
      },
      async () => {
        const ttRepo = new TicketTypeRepository(db);
        const ticketTypes = await ttRepo.findByEvent(body.eventId);
        const ttById = new Map(ticketTypes.map((t) => [t.id, t]));

        // Load the event's custom questions and validate attendee answers.
        const questionRows = await db
          .selectFrom('questions')
          .selectAll()
          .where('event_id', '=', body.eventId)
          .execute();
        const eventQuestions: Question[] = questionRows.map((q) => toDomainQuestion(q));

        const answeredAt = new Date().toISOString();
        const buyerFields = normalizeValidAnswers(
          applicableQuestions(eventQuestions, 'buyer'),
          body.buyerFields ?? {},
          'Buyer question',
          answeredAt,
        );

        // Validate attendeeFields for each cart item against only questions
        // applicable to that attendee scope and ticket type.
        for (const item of body.items) {
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
          if (itemQuestions.length > 0) {
            for (let attendeeIndex = 0; attendeeIndex < item.quantity; attendeeIndex++) {
              assertValidAnswers(
                itemQuestions,
                item.attendeeFields?.[attendeeIndex] ?? {},
                'Attendee question',
              );
            }
          }
        }

        const normalizedItems = normalizeCartItems(body.items, ttById);
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

        // Load access rules for the requested ticket types only.
        const accessRuleRepo = new AccessRuleRepository(db);
        const accessRulesRows = await accessRuleRepo.findByTicketTypes(normalizedItems.map((i) => i.ticketTypeId));
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
        for (const item of normalizedItems) {
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
          const itemQuestions = applicableQuestions(eventQuestions, 'attendee', item.ticketTypeId);
          if (itemQuestions.length > 0) {
            const fields = Array.from({ length: item.quantity }, (_, attendeeIndex) =>
              normalizeQuestionAnswers(itemQuestions, item.attendeeFields?.[attendeeIndex] ?? {}, answeredAt),
            );
            if (fields.some((fieldSet) => Object.keys(fieldSet).length > 0)) {
              attendeeFieldsByTicketType[item.ticketTypeId] = fields;
            }
          }
        }

        const cart: CartInput = {
          items: normalizedItems.map((i) => ({
            ticketTypeId: i.ticketTypeId,
            quantity: i.quantity,
            unitAmountCents: i.unitAmountCents,
          })),
          discountCode: body.discountCode,
          affiliateCode: body.affiliateCode,
          buyerFields,
          attendeeFields: attendeeFieldsByTicketType,
        };

        const currency = ttById.get(body.items[0].ticketTypeId)?.currency ?? 'USD';
        const quote = pricingEngine.calculate({
          currency,
          cart,
          ticketTypes: ttMap,
          taxRules: (taxRules as TaxRuleRow[]).map(toDomainTaxRule),
          feeRules: (feeRules as FeeRuleRow[]).map(toDomainFeeRule),
          discountCodes: (discounts as DiscountCodeRow[]).map(toDomainDiscountCode),
        });

        // Reserve inventory across every pool the cart draws from.
        const sessionRepo = new CheckoutSessionRepository(db);
        const sessionId = `cs_${ulid()}`;
        const reservation = await inventoryService.reserveCart({
          items: reservationItems,
          checkoutSessionId: sessionId,
        });

        const session = await sessionRepo.create({
          id: sessionId,
          tenantId: event.tenant_id,
          eventId: body.eventId,
          brandId: event.brand_id,
          holdId: reservation.primaryHoldId,
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

    return publicCheckoutSession(session);
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
    const updateData = pickAllowedFields(body as Record<string, unknown>, ['buyer', 'successUrl', 'cancelUrl'], {
      successUrl: 'success_url',
      cancelUrl: 'cancel_url',
    });
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
          const state = await temporalClient.getCheckoutState(workflowId);
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
          if (state.status === 'failed') {
            return {
              status: 402,
              body: {
                error: {
                  code: 'PAYMENT_FAILED',
                  message: state.error ?? 'Payment failed',
                  requestId: request.id,
                },
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
          holdId: session.hold_id,
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
            state = await temporalClient.getCheckoutState(handle.workflowId);
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
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
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
