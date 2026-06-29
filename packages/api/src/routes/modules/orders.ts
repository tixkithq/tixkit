import type { FastifyPluginAsync } from 'fastify';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AccessRuleRepository,
  AuditLogRepository,
  EventRepository,
  FeeRuleRepository,
  OrderRepository,
  PaymentCompensationRepository,
  TaxRuleRepository,
  TicketTypeRepository,
} from '@tixkit/db';
import {
  BoxOfficeError,
  NotFoundError,
  ValidationError,
  validateBoxOfficeOrder,
  validateTicketPurchase,
  type CartInput,
  type FeeRule,
  type PriceQuote,
  type TaxRule,
} from '@tixkit/domain';
import { ulid } from 'ulid';
import { writeAuditLog } from '../../auth/audit.js';
import { withIdempotency, hashRequest } from '../../services/idempotency.js';
import type { TicketTypeForPricing } from '../../services/pricing.js';
import {
  pageEnvelope,
  parsePagination,
  serializeOrder,
  serializeOrderLineItem,
  serializeAttendee,
  serializeRefund,
  serializeInvoice,
  serializeTaxSnapshot,
  serializeTimelineEvent,
  serializeTicket,
  parseJsonValue,
} from '../../http/contracts.js';
import { createBoxOfficeOrderSchema, refundSchema, parseBody } from '../../http/schemas.js';

type BoxOfficeOrderBody = ReturnType<typeof createBoxOfficeOrderSchema.parse>;

type TicketTypeRow = {
  id: string;
  event_id: string;
  event_occurrence_id: string | null;
  name: string;
  kind: string;
  status: string;
  visibility: string;
  currency: string;
  price_cents: number;
  minimum_price_cents: number | null;
  sales_start_at: Date | string | null;
  sales_end_at: Date | string | null;
  min_per_order: number;
  max_per_order: number;
  inventory_pool_id: string;
  requires_access_code: boolean;
};

type TaxRuleRow = {
  id: string;
  event_id: string;
  name: string;
  rate: number;
  type: string;
  applied_to: string;
  countries: string | null;
  regions: string | null;
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
  absorb_into_price: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function parseStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : undefined;
  } catch {
    return undefined;
  }
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
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
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
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function ticketTypeForPricing(row: TicketTypeRow): TicketTypeForPricing {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as TicketTypeForPricing['kind'],
    priceCents: Number(row.price_cents),
    minimumPriceCents: row.minimum_price_cents ? Number(row.minimum_price_cents) : undefined,
    currency: row.currency,
    minPerOrder: row.min_per_order,
    maxPerOrder: row.max_per_order,
  };
}

function zeroCompQuote(input: {
  currency: string;
  items: BoxOfficeOrderBody['items'];
  ticketTypes: Map<string, TicketTypeRow>;
}): PriceQuote {
  return {
    id: `pq_${ulid()}`,
    currency: input.currency,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 0,
    lineItems: input.items.map((item) => {
      const ticketType = input.ticketTypes.get(item.ticketTypeId)!;
      return {
        type: 'ticket',
        ticketTypeId: item.ticketTypeId,
        eventOccurrenceId: ticketType.event_occurrence_id ?? undefined,
        name: ticketType.name,
        quantity: item.quantity,
        unitPriceCents: 0,
        subtotalCents: 0,
        discountCents: 0,
        taxCents: 0,
        taxBreakdown: [],
        feeCents: 0,
        totalCents: 0,
      };
    }),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  };
}

function buyerValue(
  body: BoxOfficeOrderBody,
  field: 'email' | 'firstName' | 'lastName' | 'phone',
): string {
  return body.buyer?.[field] ?? '';
}

function serializePaymentCompensation(row: {
  id: string;
  tenant_id: string;
  checkout_session_id: string;
  payment_intent_id: string | null;
  provider: string;
  provider_intent_id: string;
  amount_cents: number;
  currency: string;
  action: string;
  status: string;
  provider_compensation_id: string | null;
  attempts: number;
  reason: string;
  last_error: string | null;
  metadata: string;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    checkoutSessionId: row.checkout_session_id,
    paymentIntentId: row.payment_intent_id,
    provider: row.provider,
    providerIntentId: row.provider_intent_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    action: row.action,
    status: row.status,
    providerCompensationId: row.provider_compensation_id,
    attempts: row.attempts,
    reason: row.reason,
    lastError: row.last_error,
    metadata: parseJsonValue<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/events/:eventId/box-office/orders', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createBoxOfficeOrderSchema, request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for box-office orders');
    }
    if (!principal.id) {
      throw new ValidationError('Authenticated operator attribution is required');
    }

    const event = await new EventRepository(db).findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
    ClerkAuthService.requireOrganizationScope(principal, event.organization_id);
    ClerkAuthService.requireBrandScope(principal, event.brand_id);
    ClerkAuthService.requireEventScope(principal, event.id);

    const ticketTypes = (await new TicketTypeRepository(db).findByEvent(eventId)) as TicketTypeRow[];
    const ticketTypeById = new Map(ticketTypes.map((ticketType) => [ticketType.id, ticketType]));
    const requestedTicketTypeIds = new Set(body.items.map((item) => item.ticketTypeId));
    for (const ticketTypeId of requestedTicketTypeIds) {
      if (!ticketTypeById.has(ticketTypeId)) {
        throw new NotFoundError('TicketType', ticketTypeId);
      }
    }

    const accessRulesRows = await new AccessRuleRepository(db).findByTicketTypes([
      ...requestedTicketTypeIds,
    ]);
    const rulesByTicket = new Map<
      string,
      Array<{
        type: 'access_code' | 'voucher' | 'allowlist';
        value: string;
        maxUses: number | null;
        usesCount: number;
        expiresAt: Date | string | null;
      }>
    >();
    for (const row of accessRulesRows) {
      const rules = rulesByTicket.get(row.ticket_type_id) ?? [];
      rules.push({
        type: row.type as 'access_code' | 'voucher' | 'allowlist',
        value: row.value,
        maxUses: row.max_uses,
        usesCount: row.uses_count,
        expiresAt: row.expires_at,
      });
      rulesByTicket.set(row.ticket_type_id, rules);
    }

    for (const item of body.items) {
      const ticketType = ticketTypeById.get(item.ticketTypeId)!;
      if (ticketType.kind === 'donation') {
        throw new ValidationError('Donation ticket types are not supported by box-office orders');
      }
      validateTicketPurchase({
        ticketType: {
          id: ticketType.id,
          kind: ticketType.kind as 'free' | 'paid' | 'donation',
          status: ticketType.status as 'draft' | 'active' | 'paused' | 'sold_out' | 'ended',
          visibility: ticketType.visibility as 'public' | 'hidden' | 'locked',
          priceCents: Number(ticketType.price_cents),
          minimumPriceCents: ticketType.minimum_price_cents
            ? Number(ticketType.minimum_price_cents)
            : null,
          salesStartAt: ticketType.sales_start_at,
          salesEndAt: ticketType.sales_end_at,
          minPerOrder: ticketType.min_per_order,
          maxPerOrder: ticketType.max_per_order,
          requiresAccessCode: ticketType.requires_access_code,
        },
        quantity: item.quantity,
        accessCode: body.accessCode,
        buyerEmail: body.buyer?.email,
        accessRules: rulesByTicket.get(item.ticketTypeId),
      });
    }

    const cart: CartInput = {
      items: body.items.map((item) => {
        const ticketType = ticketTypeById.get(item.ticketTypeId)!;
        return {
          ticketTypeId: item.ticketTypeId,
          occurrenceId: ticketType.event_occurrence_id ?? undefined,
          quantity: item.quantity,
        };
      }),
    };
    const quote =
      body.tenderType === 'comp'
        ? zeroCompQuote({ currency: event.currency, items: body.items, ticketTypes: ticketTypeById })
        : app.context.pricingEngine.calculate({
            currency: event.currency,
            cart,
            ticketTypes: new Map(
              [...requestedTicketTypeIds].map((ticketTypeId) => [
                ticketTypeId,
                ticketTypeForPricing(ticketTypeById.get(ticketTypeId)!),
              ]),
            ),
            taxRules: ((await new TaxRuleRepository(db).findByEvent(eventId)) as TaxRuleRow[]).map(
              toDomainTaxRule,
            ),
            feeRules: ((await new FeeRuleRepository(db).findByEvent(eventId)) as FeeRuleRow[]).map(
              toDomainFeeRule,
            ),
            discountCodes: [],
          });

    const submittedAmount = body.amountCents ?? (body.tenderType === 'comp' ? 0 : undefined);
    try {
      validateBoxOfficeOrder({
        eventId,
        tenantId: principal.tenantId,
        operatorId: principal.id,
        tenderType: body.tenderType,
        items: body.items.map((item) => ({
          ticketTypeId: item.ticketTypeId,
          quantity: item.quantity,
        })),
        buyerEmail: body.buyer?.email,
        amountCents: submittedAmount,
        currency: event.currency,
        notes: body.notes,
      });
    } catch (err) {
      if (err instanceof BoxOfficeError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
    if (body.tenderType !== 'comp' && body.amountCents !== quote.totalCents) {
      throw new ValidationError(
        `Tender amount ${body.amountCents ?? 'missing'} does not match quoted total ${quote.totalCents}`,
      );
    }

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          eventId,
          operatorId: principal.id,
          body,
          quotedTotalCents: quote.totalCents,
        }),
      },
      async () => {
        const existingSession = await db
          .selectFrom('checkout_sessions')
          .select(['id', 'order_id'])
          .where('tenant_id', '=', principal.tenantId)
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (existingSession?.order_id) {
          const [order, lineItems, attendees, tickets] = await Promise.all([
            new OrderRepository(db).findById(existingSession.order_id),
            db
              .selectFrom('order_line_items')
              .selectAll()
              .where('order_id', '=', existingSession.order_id)
              .execute(),
            db
              .selectFrom('attendees')
              .selectAll()
              .where('order_id', '=', existingSession.order_id)
              .execute(),
            db
              .selectFrom('tickets')
              .selectAll()
              .where('order_id', '=', existingSession.order_id)
              .execute(),
          ]);
          if (!order) throw new NotFoundError('Order', existingSession.order_id);
          return {
            status: 200,
            body: {
              order: {
                ...serializeOrder(order),
                lineItems: lineItems.map((lineItem) => serializeOrderLineItem(lineItem)),
                attendees: attendees.map((attendee) => serializeAttendee(attendee)),
              },
              tickets: tickets.map((ticket) => serializeTicket(ticket)),
            },
          };
        }

        const sessionId = `cs_${ulid()}`;
        const orderId = `ord_${ulid()}`;
        const reservation = await app.context.inventoryService.reserveCart({
          checkoutSessionId: sessionId,
          items: body.items.map((item) => ({
            inventoryPoolId: ticketTypeById.get(item.ticketTypeId)!.inventory_pool_id,
            ticketTypeId: item.ticketTypeId,
            quantity: item.quantity,
          })),
        });

        try {
          const created = await db.transaction().execute(async (trx) => {
            const now = new Date();
            await trx
              .insertInto('checkout_sessions')
              .values({
                id: sessionId,
                tenant_id: principal.tenantId,
                event_id: event.id,
                brand_id: event.brand_id,
                status: 'open',
                hold_id: reservation.primaryHoldId,
                currency: quote.currency,
                cart: JSON.stringify({
                  ...cart,
                  boxOffice: {
                    tenderType: body.tenderType,
                    operatorId: principal.id,
                    notes: body.notes,
                  },
                }),
                buyer: JSON.stringify(body.buyer ?? {}),
                quote: JSON.stringify(quote),
                payment_intent_id: null,
                order_id: null,
                success_url: null,
                cancel_url: null,
                expires_at: reservation.expiresAt,
                idempotency_key: idempotencyKey,
                client_token: `pos_${ulid()}`,
                created_at: now,
                updated_at: now,
              })
              .execute();

            const candidateHolds = await trx
              .selectFrom('checkout_holds')
              .selectAll()
              .where('checkout_session_id', '=', sessionId)
              .execute();
            const poolIds = [
              ...new Set(candidateHolds.map((hold) => String(hold.inventory_pool_id))),
            ];
            // oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array for deterministic lock order under ES2022.
            poolIds.sort();
            for (const poolId of poolIds) {
              // eslint-disable-next-line no-await-in-loop -- deterministic inventory lock order prevents reserve/finalize deadlocks.
              await trx
                .selectFrom('inventory_pools')
                .select(['id'])
                .where('id', '=', poolId)
                .forUpdate()
                .executeTakeFirstOrThrow();
            }
            const holds = await trx
              .selectFrom('checkout_holds')
              .selectAll()
              .where('checkout_session_id', '=', sessionId)
              .forUpdate()
              .execute();
            const expiredHold = holds.find(
              (hold) =>
                hold.status === 'expired' ||
                (hold.status === 'active' && new Date(hold.expires_at) <= now),
            );
            if (expiredHold) {
              await trx
                .updateTable('checkout_holds')
                .set({ status: 'expired', updated_at: now })
                .where('checkout_session_id', '=', sessionId)
                .where('status', '=', 'active')
                .where('expires_at', '<', now)
                .execute();
              throw new ValidationError('Box-office inventory hold expired before finalization');
            }

            await trx
              .insertInto('orders')
              .values({
                id: orderId,
                tenant_id: principal.tenantId,
                organization_id: event.organization_id,
                brand_id: event.brand_id,
                event_id: event.id,
                checkout_session_id: sessionId,
                order_number: `TK-${orderId.replace(/^ord_/, '').toUpperCase()}`,
                status: 'paid',
                currency: quote.currency,
                subtotal_cents: quote.subtotalCents,
                discount_cents: quote.discountCents,
                tax_cents: quote.taxCents,
                fee_cents: quote.feeCents,
                total_cents: quote.totalCents,
                refunded_cents: 0,
                buyer_email: body.buyer?.email ?? '',
                buyer_first_name: body.buyer?.firstName ?? null,
                buyer_last_name: body.buyer?.lastName ?? null,
                buyer_phone: body.buyer?.phone ?? null,
                payment_intent_id: null,
                payment_provider: 'manual',
                sales_channel: 'box_office',
                operator_id: principal.id,
                tender_type: body.tenderType,
                paid_at: now,
                created_at: now,
                updated_at: now,
              })
              .execute();

            for (const hold of holds.filter((candidate) => candidate.status === 'active')) {
              // eslint-disable-next-line no-await-in-loop -- each hold conversion and inventory increment must commit atomically with the POS order.
              await trx
                .updateTable('checkout_holds')
                .set({ status: 'converted', updated_at: now })
                .where('id', '=', hold.id)
                .execute();
              // eslint-disable-next-line no-await-in-loop -- sold_count increments are paired with converted holds in the same transaction.
              await trx
                .updateTable('inventory_pools')
                .set((eb) => ({ sold_count: eb('sold_count', '+', hold.quantity), updated_at: now }))
                .where('id', '=', hold.inventory_pool_id)
                .execute();
            }

            const lineItemRows: Record<string, unknown>[] = [];
            for (const line of quote.lineItems) {
              const lineItemId = `oli_${ulid()}`;
              // eslint-disable-next-line no-await-in-loop -- line item IDs are needed for tax snapshots immediately below.
              await trx
                .insertInto('order_line_items')
                .values({
                  id: lineItemId,
                  order_id: orderId,
                  ticket_type_id: line.ticketTypeId ?? null,
                  event_occurrence_id: line.eventOccurrenceId ?? null,
                  product_id: null,
                  attendee_id: null,
                  description: line.name,
                  quantity: line.quantity,
                  unit_price_cents: line.unitPriceCents,
                  subtotal_cents: line.subtotalCents,
                  discount_cents: line.discountCents,
                  tax_cents: line.taxCents,
                  fee_cents: line.feeCents,
                  total_cents: line.totalCents,
                  currency: quote.currency,
                  created_at: now,
                  updated_at: now,
                })
                .execute();
              lineItemRows.push({
                id: lineItemId,
                order_id: orderId,
                ticket_type_id: line.ticketTypeId ?? null,
                event_occurrence_id: line.eventOccurrenceId ?? null,
                product_id: null,
                attendee_id: null,
                description: line.name,
                quantity: line.quantity,
                unit_price_cents: line.unitPriceCents,
                subtotal_cents: line.subtotalCents,
                discount_cents: line.discountCents,
                tax_cents: line.taxCents,
                fee_cents: line.feeCents,
                total_cents: line.totalCents,
                currency: quote.currency,
                created_at: now,
                updated_at: now,
              });

              for (const tax of line.taxBreakdown ?? []) {
                if (tax.taxCents === 0 && tax.taxableAmountCents === 0) continue;
                // eslint-disable-next-line no-await-in-loop -- snapshots must reference the line item created in this loop.
                await trx
                  .insertInto('order_tax_snapshots')
                  .values({
                    id: `ots_${ulid()}`,
                    order_id: orderId,
                    order_line_item_id: lineItemId,
                    event_id: event.id,
                    tax_rule_id: tax.taxRuleId ?? null,
                    tax_rule_name: tax.taxRuleName,
                    rate: tax.rate,
                    type: tax.type,
                    applied_to: tax.appliedTo,
                    jurisdiction_country: tax.jurisdictionCountry ?? null,
                    jurisdiction_region: tax.jurisdictionRegion ?? null,
                    taxable_amount_cents: tax.taxableAmountCents,
                    tax_cents: tax.taxCents,
                    currency: quote.currency,
                    inclusive: tax.type === 'inclusive',
                    provider: tax.provider ?? 'tixkit_rules',
                    provider_calculation_id: tax.providerCalculationId ?? null,
                    metadata: JSON.stringify({ source: 'box_office_quote' }),
                    created_at: now,
                  })
                  .execute();
              }
            }

            const attendeeRows: Record<string, unknown>[] = [];
            const ticketRows: Record<string, unknown>[] = [];
            for (const item of body.items) {
              const ticketType = ticketTypeById.get(item.ticketTypeId)!;
              for (let index = 0; index < item.quantity; index++) {
                const attendeeInput = item.attendees?.[index] ?? {};
                const attendeeId = `att_${ulid()}`;
                const attendeeEmail = attendeeInput.email ?? buyerValue(body, 'email');
                const attendeeFirstName = attendeeInput.firstName ?? buyerValue(body, 'firstName');
                const attendeeLastName = attendeeInput.lastName ?? buyerValue(body, 'lastName');
                const attendeePhone = attendeeInput.phone ?? buyerValue(body, 'phone');
                const attendeeRow = {
                  id: attendeeId,
                  tenant_id: principal.tenantId,
                  order_id: orderId,
                  event_id: event.id,
                  ticket_type_id: item.ticketTypeId,
                  event_occurrence_id: ticketType.event_occurrence_id ?? null,
                  ticket_id: null,
                  first_name: attendeeFirstName || null,
                  last_name: attendeeLastName || null,
                  email: attendeeEmail,
                  phone: attendeePhone || null,
                  status: 'confirmed',
                  custom_answers: null,
                  checked_in_at: null,
                  check_in_device_id: null,
                  created_at: now,
                  updated_at: now,
                };
                // eslint-disable-next-line no-await-in-loop -- attendee rows are inserted before their matching ticket can reference them.
                await trx.insertInto('attendees').values(attendeeRow).execute();

                const ticketId = `tkt_${ulid()}`;
                const qr = app.context.qrService.generate(ticketId);
                const ticketRow = {
                  id: ticketId,
                  tenant_id: principal.tenantId,
                  order_id: orderId,
                  attendee_id: attendeeId,
                  event_id: event.id,
                  ticket_type_id: item.ticketTypeId,
                  event_occurrence_id: ticketType.event_occurrence_id ?? null,
                  status: 'valid',
                  code: qr.code,
                  qr_payload: qr.payload,
                  qr_hash: qr.hash,
                  transferred_to_email: null,
                  transferred_at: null,
                  checked_in_at: null,
                  checked_in_by_device_id: null,
                  wallet_pass_id: null,
                  created_at: now,
                  updated_at: now,
                };
                // eslint-disable-next-line no-await-in-loop -- ticket issuance depends on the generated QR payload for this attendee.
                await trx.insertInto('tickets').values(ticketRow).execute();
                // eslint-disable-next-line no-await-in-loop -- attendee linkage must follow the matching ticket insert.
                await trx
                  .updateTable('attendees')
                  .set({ ticket_id: ticketId, updated_at: now })
                  .where('id', '=', attendeeId)
                  .execute();
                attendeeRows.push({ ...attendeeRow, ticket_id: ticketId, updated_at: now });
                ticketRows.push(ticketRow);
              }
            }

            await trx
              .updateTable('checkout_sessions')
              .set({ status: 'completed', order_id: orderId, updated_at: now })
              .where('id', '=', sessionId)
              .execute();
            await trx
              .insertInto('order_timeline_events')
              .values({
                id: `ote_${ulid()}`,
                order_id: orderId,
                type: 'order.paid',
                description: 'Box-office order confirmed',
                metadata: JSON.stringify({
                  salesChannel: 'box_office',
                  tenderType: body.tenderType,
                  notes: body.notes,
                }),
                actor_id: principal.id,
                created_at: now,
              })
              .execute();

            const orderRow = {
              id: orderId,
              tenant_id: principal.tenantId,
              organization_id: event.organization_id,
              brand_id: event.brand_id,
              event_id: event.id,
              checkout_session_id: sessionId,
              order_number: `TK-${orderId.replace(/^ord_/, '').toUpperCase()}`,
              status: 'paid',
              currency: quote.currency,
              subtotal_cents: quote.subtotalCents,
              discount_cents: quote.discountCents,
              tax_cents: quote.taxCents,
              fee_cents: quote.feeCents,
              total_cents: quote.totalCents,
              refunded_cents: 0,
              buyer_email: body.buyer?.email ?? '',
              buyer_first_name: body.buyer?.firstName ?? null,
              buyer_last_name: body.buyer?.lastName ?? null,
              buyer_phone: body.buyer?.phone ?? null,
              payment_intent_id: null,
              payment_provider: 'manual',
              sales_channel: 'box_office',
              operator_id: principal.id,
              tender_type: body.tenderType,
              paid_at: now,
              refunded_at: null,
              cancelled_at: null,
              created_at: now,
              updated_at: now,
            };

            return {
              order: {
                ...serializeOrder(orderRow),
                lineItems: lineItemRows.map((lineItem) => serializeOrderLineItem(lineItem)),
                attendees: attendeeRows.map((attendee) => serializeAttendee(attendee)),
              },
              tickets: ticketRows.map((ticket) => serializeTicket(ticket)),
            };
          });

          await writeAuditLog(new AuditLogRepository(db), request, principal, {
            action: 'order.box_office.created',
            organizationId: event.organization_id,
            brandId: event.brand_id,
            resourceType: 'Order',
            resourceId: orderId,
            diffSummary: {
              eventId,
              tenderType: body.tenderType,
              totalCents: quote.totalCents,
              ticketCount: body.items.reduce((sum, item) => sum + item.quantity, 0),
            },
          });

          return { status: 201, body: created };
        } catch (err) {
          await app.context.inventoryService.releaseHoldsForSession(sessionId);
          throw err;
        }
      },
    );

    return reply.status(result.status).send(result.body);
  });

  app.get('/payment-compensations', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const pagination = parsePagination(request.query);
    const { status, checkoutSessionId } = request.query as {
      status?: string;
      checkoutSessionId?: string;
    };
    const repo = new PaymentCompensationRepository(db);
    const rows = await repo.listForTenant({
      tenantId: principal.tenantId,
      status,
      checkoutSessionId,
      limit: pagination.limit,
      cursor: pagination.cursor,
    });
    return pageEnvelope(
      rows.map((row) => serializePaymentCompensation(row)),
      pagination.limit,
    );
  });

  app.get('/orders', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const pagination = parsePagination(request.query);
    if (principal.type !== 'system' && principal.organizationIds.length === 0) {
      return pageEnvelope([], pagination.limit);
    }
    let query = db
      .selectFrom('orders')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);

    const { organizationId, eventId } = request.query as {
      organizationId?: string;
      eventId?: string;
    };
    if (organizationId) {
      ClerkAuthService.requireOrganizationScope(principal, organizationId);
      query = query.where('organization_id', '=', organizationId);
    }
    if (eventId) {
      query = query.where('event_id', '=', eventId);
    }
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    if (principal.brandIds && principal.brandIds.length > 0) {
      query = query.where('brand_id', 'in', principal.brandIds);
    }
    if (principal.eventIds && principal.eventIds.length > 0) {
      query = query.where('event_id', 'in', principal.eventIds);
    }
    if (principal.type !== 'system') {
      query = query.where('organization_id', 'in', principal.organizationIds);
    }
    const rows = await query.execute();
    return pageEnvelope(
      rows.map((row) => serializeOrder(row)),
      pagination.limit,
    );
  });

  app.get('/orders/:orderId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const repo = new OrderRepository(db);
    const order = await repo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const [lineItems, timeline, attendees, refunds, checkoutSession, invoice, taxSnapshots] =
      await Promise.all([
        repo.getLineItems(orderId),
        repo.getTimeline(orderId),
        db.selectFrom('attendees').selectAll().where('order_id', '=', orderId).execute(),
        db
          .selectFrom('refunds')
          .selectAll()
          .where('order_id', '=', orderId)
          .orderBy('created_at', 'asc')
          .execute(),
        order.checkout_session_id
          ? db
              .selectFrom('checkout_sessions')
              .selectAll()
              .where('id', '=', order.checkout_session_id)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
        db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
      ]);
    const cart = parseJsonValue(checkoutSession?.cart, {}) as Record<string, unknown>;
    const buyerFields =
      cart.buyerFields && typeof cart.buyerFields === 'object'
        ? (cart.buyerFields as Record<string, unknown>)
        : {};
    const attendeeFields =
      cart.attendeeFields && typeof cart.attendeeFields === 'object'
        ? (cart.attendeeFields as Record<string, unknown>)
        : {};
    const consentSnapshots = Object.fromEntries(
      Object.entries(buyerFields).filter(([, answer]) => {
        return Boolean(
          answer &&
          typeof answer === 'object' &&
          'consentText' in answer &&
          'consentVersion' in answer,
        );
      }),
    );

    return {
      ...serializeOrder(order),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      attendees: attendees.map((row) => serializeAttendee(row)),
      invoice: invoice ? serializeInvoice(invoice) : undefined,
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
      checkoutAnswers: {
        buyerFields,
        attendeeFields,
      },
      consentSnapshots,
      refunds: refunds.map((row) => serializeRefund(row)),
      timeline: timeline.map((row) => serializeTimelineEvent(row)),
      deliveryStatus: {
        email: order.buyer_email ? 'pending' : 'not_applicable',
        tickets: attendees.length > 0 ? 'issued' : 'not_issued',
      },
    };
  });

  app.get('/orders/:orderId/invoice', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const order = await new OrderRepository(db).findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    const [invoice, lineItems, taxSnapshots] = await Promise.all([
      db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_line_items').selectAll().where('order_id', '=', orderId).execute(),
      db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
    ]);
    if (!invoice) throw new NotFoundError('Invoice', orderId);
    return {
      invoice: serializeInvoice(invoice),
      order: serializeOrder(order),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
    };
  });

  app.get('/orders/:orderId/invoice/download', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.read');
    const { orderId } = request.params as { orderId: string };
    const order = await new OrderRepository(db).findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);
    const [invoice, lineItems, taxSnapshots] = await Promise.all([
      db.selectFrom('invoices').selectAll().where('order_id', '=', orderId).executeTakeFirst(),
      db.selectFrom('order_line_items').selectAll().where('order_id', '=', orderId).execute(),
      db.selectFrom('order_tax_snapshots').selectAll().where('order_id', '=', orderId).execute(),
    ]);
    if (!invoice) throw new NotFoundError('Invoice', orderId);
    const body = {
      invoice: serializeInvoice(invoice),
      order: serializeOrder(order),
      lineItems: lineItems.map((row) => serializeOrderLineItem(row)),
      taxSnapshots: taxSnapshots.map((row) => serializeTaxSnapshot(row)),
    };
    const filename = `${invoice.invoice_number}.json`;
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(JSON.stringify(body));
  });

  app.post('/orders/:orderId/cancel', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'orders.write');
    const { orderId } = request.params as { orderId: string };
    const repo = new OrderRepository(db);
    const order = await repo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    if (order.status === 'paid' || order.status === 'partially_refunded') {
      throw new ValidationError('Cannot cancel a paid order. Use refund instead.');
    }

    const updated = await repo.update(orderId, { status: 'cancelled', cancelled_at: new Date() });
    await repo.addTimelineEvent(
      orderId,
      'order.cancelled',
      'Order cancelled',
      undefined,
      principal.id,
    );
    await writeAuditLog(new AuditLogRepository(db), request, principal, {
      action: 'order.cancelled',
      organizationId: order.organization_id,
      brandId: order.brand_id,
      resourceType: 'Order',
      resourceId: orderId,
    });
    return serializeOrder(updated);
  });

  app.post('/orders/:orderId/refunds', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'refunds.write');
    const { orderId } = request.params as { orderId: string };
    const body = parseBody(refundSchema, request.body);
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      throw new ValidationError('Refund reason is required');
    }

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string') {
      throw new ValidationError('Idempotency-Key header is required for refunds');
    }

    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(orderId);
    if (!order) throw new NotFoundError('Order', orderId);
    ClerkAuthService.requireResourceTenant(principal, order, 'Order', orderId);
    ClerkAuthService.requireOrganizationScope(principal, order.organization_id);
    ClerkAuthService.requireBrandScope(principal, order.brand_id);
    ClerkAuthService.requireEventScope(principal, order.event_id);

    if (order.status !== 'paid' && order.status !== 'partially_refunded') {
      throw new ValidationError('Order is not in a refundable state');
    }

    const refundAmount =
      body.amountCents ?? Number(order.total_cents) - Number(order.refunded_cents);
    const alreadyRefunded = Number(order.refunded_cents);

    if (refundAmount <= 0) {
      throw new ValidationError('Refund amount must be positive');
    }
    if (alreadyRefunded + refundAmount > Number(order.total_cents)) {
      throw new ValidationError('Refund amount exceeds order total');
    }

    const result = await withIdempotency(
      db,
      {
        key: idempotencyKey,
        tenantId: principal.tenantId,
        requestHash: hashRequest({
          orderId,
          amountCents: refundAmount,
          reason: body.reason,
          voidTickets: body.voidTickets ?? true,
          restoreInventory: body.restoreInventory ?? false,
        }),
      },
      async () => {
        await app.context.temporalClient.startRefund({
          orderId: order.id,
          amountCents: refundAmount,
          reason: body.reason,
          buyerEmail: order.buyer_email,
          voidTickets: body.voidTickets ?? true,
          restoreInventory: body.restoreInventory ?? false,
          idempotencyKey,
          tenantId: order.tenant_id,
          brandId: order.brand_id,
          orderTotalCents: Number(order.total_cents),
          alreadyRefundedCents: alreadyRefunded,
          nonce: idempotencyKey,
        });

        await writeAuditLog(new AuditLogRepository(db), request, principal, {
          action: 'order.refund.requested',
          organizationId: order.organization_id,
          brandId: order.brand_id,
          resourceType: 'Order',
          resourceId: orderId,
          diffSummary: { amountCents: refundAmount, reason: body.reason },
        });

        return {
          status: 202,
          body: { orderId, refundAmount, status: 'pending', message: 'Refund workflow started' },
        };
      },
    );

    return reply.status(result.status).send(result.body);
  });
};
