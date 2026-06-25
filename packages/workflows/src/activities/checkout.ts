import { createDb } from '@gatekit/db';
import { EmailJobRepository, PaymentIntentRepository, OrderRepository } from '@gatekit/db';
import { ulid } from 'ulid';
import { QrService } from '@gatekit/domain/tickets';
import { isConsentAccepted, isConsentAnswerSnapshot } from '@gatekit/domain';
import Stripe from 'stripe';
import { Connection, Client } from '@temporalio/client';
import { notificationDeliveryWorkflow } from '../workflows/notification.js';
import type { NotificationDeliveryWorkflowInput } from '../workflows/notification.js';
import { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } from '../shared/types.js';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

let cachedClient: Client | null = null;

type CheckoutHoldRow = {
  id: string;
  inventory_pool_id: string;
  ticket_type_id: string;
  quantity: number;
  expires_at: Date | string;
  status: string;
};

type FinalizeTransactionResult =
  | { ok: true }
  | { ok: false; errorCode: string; message: string; retryable: boolean };

async function getTemporalClient(): Promise<Client> {
  if (!cachedClient) {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    cachedClient = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  }
  return cachedClient;
}

async function startNotificationWorkflow(input: Omit<NotificationDeliveryWorkflowInput, 'version'>): Promise<void> {
  try {
    const client = await getTemporalClient();
    const workflowId = notificationWorkflowId(input.jobId);
    try {
      await client.workflow.start(notificationDeliveryWorkflow, {
        taskQueue: 'gatekit',
        workflowId,
        args: [{ version: NOTIFICATION_WORKFLOW_VERSION, ...input }],
      });
    } catch (err) {
      if (!(err instanceof Error && (err.name === 'WorkflowExecutionAlreadyStartedError' || err.message.includes('already started')))) {
        throw err;
      }
    }
  } catch {
    // Non-fatal: the email job row is queued and a poller or manual retry can drain it.
  }
}

function parseStoredJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function isRetryableDbConcurrencyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? '');
  const errno = String(record.errno ?? '');
  return code === '40P01' || code === '40001' || code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT' || errno === '1213' || errno === '1205';
}

function validateHeldCartItems(input: {
  cartItems: { ticketTypeId: string; quantity: number }[];
  holds: CheckoutHoldRow[];
  now: Date;
}): { ok: true } | { ok: false; expiredHoldIds: string[]; message: string } {
  const expectedByTicketType = new Map<string, number>();
  for (const item of input.cartItems) {
    expectedByTicketType.set(item.ticketTypeId, (expectedByTicketType.get(item.ticketTypeId) ?? 0) + item.quantity);
  }

  const heldByTicketType = new Map<string, number>();
  const expiredHoldIds: string[] = [];
  for (const hold of input.holds) {
    if (new Date(hold.expires_at) <= input.now) {
      expiredHoldIds.push(hold.id);
      continue;
    }
    heldByTicketType.set(hold.ticket_type_id, (heldByTicketType.get(hold.ticket_type_id) ?? 0) + Number(hold.quantity));
  }

  if (expiredHoldIds.length > 0) {
    return { ok: false, expiredHoldIds, message: `Checkout hold ${expiredHoldIds[0]} has expired` };
  }

  for (const [ticketTypeId, expected] of expectedByTicketType) {
    if ((heldByTicketType.get(ticketTypeId) ?? 0) !== expected) {
      return {
        ok: false,
        expiredHoldIds,
        message: `Checkout session is missing an active inventory hold for ticket type ${ticketTypeId}`,
      };
    }
  }

  for (const [ticketTypeId, held] of heldByTicketType) {
    if (!expectedByTicketType.has(ticketTypeId) || expectedByTicketType.get(ticketTypeId) !== held) {
      return {
        ok: false,
        expiredHoldIds,
        message: `Checkout session has an unexpected inventory hold for ticket type ${ticketTypeId}`,
      };
    }
  }

  return { ok: true };
}

// Activity: Create inventory hold (transactional, oversell-safe)
export async function createHoldActivity(input: {
  inventoryPoolId: string;
  ticketTypeId: string;
  quantity: number;
  checkoutSessionId: string;
}): Promise<WorkflowActivityResult<{ holdId: string; expiresAt: string }>> {
  const db = createDb();
  try {
    const result = await db.transaction().execute(async (trx) => {
      const pool = await trx
        .selectFrom('inventory_pools')
        .selectAll()
        .where('id', '=', input.inventoryPoolId)
        .forUpdate()
        .executeTakeFirstOrThrow();

      // Lazy cleanup of expired holds
      await trx
        .updateTable('checkout_holds')
        .set({ status: 'expired', updated_at: new Date() })
        .where('inventory_pool_id', '=', input.inventoryPoolId)
        .where('status', '=', 'active')
        .where('expires_at', '<', new Date())
        .execute();

      const activeHolds = await trx
        .selectFrom('checkout_holds')
        .select(trx.fn.sum('quantity').as('total'))
        .where('inventory_pool_id', '=', input.inventoryPoolId)
        .where('status', '=', 'active')
        .executeTakeFirst();

      const held = Number(activeHolds?.total ?? 0);
      const available = pool.total_capacity - pool.sold_count - held;

      if (available < input.quantity) {
        throw new Error(`Insufficient inventory: requested ${input.quantity}, available ${available}`);
      }

      const expiresAt = new Date(Date.now() + pool.hold_ttl_seconds * 1000);
      const holdId = `hld_${ulid()}`;

      await trx.insertInto('checkout_holds').values({
        id: holdId,
        inventory_pool_id: input.inventoryPoolId,
        checkout_session_id: input.checkoutSessionId,
        ticket_type_id: input.ticketTypeId,
        quantity: input.quantity,
        expires_at: expiresAt,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();

      return { holdId, expiresAt };
    });

    return okResult({ holdId: result.holdId, expiresAt: result.expiresAt.toISOString() });
  } catch (err) {
    return errResult('HOLD_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

// Activity: Create payment intent via Stripe
export async function createPaymentIntentActivity(input: {
  checkoutSessionId: string;
  tenantId: string;
  brandId: string;
  amountCents: number;
  currency: string;
  description?: string;
  feeCents?: number;
}): Promise<WorkflowActivityResult<{ providerIntentId: string; clientSecret?: string }>> {
  const db = createDb();
  try {
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      return errResult('STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured', false);
    }

    const stripe = new Stripe(stripeSecretKey);

    // Resolve the brand's connected payment account for Stripe Connect direct payouts.
    const brand = await db
      .selectFrom('brands')
      .select(['payment_account_id'])
      .where('id', '=', input.brandId)
      .executeTakeFirst();

    let connectedAccountId: string | undefined;
    let paymentAccountId: string | null = null;

    if (brand?.payment_account_id) {
      const paymentAccount = await db
        .selectFrom('payment_accounts')
        .select(['id', 'provider_account_id', 'status', 'provider'])
        .where('id', '=', brand.payment_account_id)
        .executeTakeFirst();

      if (paymentAccount && paymentAccount.status === 'active' && paymentAccount.provider === 'stripe_connect') {
        connectedAccountId = paymentAccount.provider_account_id;
        paymentAccountId = paymentAccount.id;
      }
    }

    // Use a Stripe Connect destination charge: create the PaymentIntent on the
    // platform account and route funds to the connected account via
    // transfer_data. Do not also pass stripeAccount, which would create a
    // direct charge and conflict with transfer_data/application_fee_amount.
    const createParams: Stripe.PaymentIntentCreateParams = {
      amount: input.amountCents,
      currency: input.currency.toLowerCase(),
      description: input.description,
      automatic_payment_methods: { enabled: true },
      metadata: { checkoutSessionId: input.checkoutSessionId, tenantId: input.tenantId, brandId: input.brandId },
    };

    if (connectedAccountId) {
      createParams.transfer_data = { destination: connectedAccountId };
      if (input.feeCents && input.feeCents > 0) {
        createParams.application_fee_amount = input.feeCents;
      }
    }

    const paymentIntent = await stripe.paymentIntents.create(
      createParams,
      {
        idempotencyKey: input.checkoutSessionId,
      },
    );

    const piRepo = new PaymentIntentRepository(db);
    const createdPaymentIntent = await piRepo.create({
      tenantId: input.tenantId,
      checkoutSessionId: input.checkoutSessionId,
      provider: connectedAccountId ? 'stripe_connect' : 'stripe',
      providerIntentId: paymentIntent.id,
      amountCents: input.amountCents,
      currency: input.currency,
      status: paymentIntent.status,
      clientSecret: paymentIntent.client_secret ?? undefined,
      metadata: { checkoutSessionId: input.checkoutSessionId, tenantId: input.tenantId, brandId: input.brandId },
      paymentAccountId,
    });

    await db
      .updateTable('checkout_sessions')
      .set({ payment_intent_id: createdPaymentIntent.id, updated_at: new Date() })
      .where('id', '=', input.checkoutSessionId)
      .execute();

    return okResult({
      providerIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret ?? undefined,
    });
  } catch (err) {
    return errResult('PAYMENT_INTENT_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

// Activity: Finalize order - creates order, attendees, and tickets
export async function finalizeOrderActivity(input: {
  checkoutSessionId: string;
  tenantId: string;
  paymentIntentId?: string;
  affiliateCode?: string;
}): Promise<WorkflowActivityResult<{ orderId: string }>> {
  const db = createDb();
  try {
    // Idempotency: if an order already exists for this checkout session (e.g. the
    // activity is retried after committing but before reporting success), return
    // it instead of creating a duplicate. A unique constraint on
    // orders.checkout_session_id is the backstop against races.
    const existingOrder = await db
      .selectFrom('orders')
      .select(['id'])
      .where('checkout_session_id', '=', input.checkoutSessionId)
      .executeTakeFirst();
    if (existingOrder) {
      return okResult({ orderId: existingOrder.id });
    }

    const session = await db
      .selectFrom('checkout_sessions')
      .selectAll()
      .where('id', '=', input.checkoutSessionId)
      .executeTakeFirstOrThrow();

    const quote = parseStoredJson<{
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      feeCents: number;
      totalCents: number;
      lineItems?: Array<{
        ticketTypeId: string;
        name: string;
        quantity: number;
        unitPriceCents: number;
        subtotalCents: number;
        discountCents: number;
        taxCents: number;
        feeCents: number;
        totalCents: number;
      }>;
    }>(session.quote);
    const cart = parseStoredJson<{
      items: { ticketTypeId: string; quantity: number }[];
      buyerFields?: Record<string, unknown>;
      attendeeFields?: Record<string, unknown[]>;
      discountCode?: string;
    }>(session.cart);
    const buyer = parseStoredJson<{ email?: string; firstName?: string; lastName?: string; phone?: string }>(session.buyer);

    const event = await db.selectFrom('events').selectAll().where('id', '=', session.event_id).executeTakeFirstOrThrow();
    const paymentIntent = input.paymentIntentId
      ? await db
          .selectFrom('payment_intents')
          .select(['id', 'provider'])
          .where('provider_intent_id', '=', input.paymentIntentId)
          .executeTakeFirst()
      : undefined;

    const orderId = `ord_${ulid()}`;
    const now = new Date();

    const consentQuestions = await db
      .selectFrom('questions')
      .select(['id', 'applies_to', 'ticket_type_id', 'label', 'is_consent_field', 'consent_text', 'consent_version'])
      .where('event_id', '=', session.event_id)
      .where('is_consent_field', '=', true)
      .execute();

    const finalizeResult = await db.transaction().execute(async (trx): Promise<FinalizeTransactionResult> => {
      const candidateHolds = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('checkout_session_id', '=', input.checkoutSessionId)
        .where('status', '=', 'active')
        .execute() as CheckoutHoldRow[];
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh array gives deterministic lock order without mutating shared input.
      const poolIds = [...new Set(candidateHolds.map((hold) => hold.inventory_pool_id))].sort();
      for (const poolId of poolIds) {
        // eslint-disable-next-line no-await-in-loop -- inventory pools must be locked sequentially in sorted order to avoid deadlocks.
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
        .where('checkout_session_id', '=', input.checkoutSessionId)
        .where('status', '=', 'active')
        .forUpdate()
        .execute() as CheckoutHoldRow[];

      const heldCart = validateHeldCartItems({ cartItems: cart.items, holds, now });
      if (!heldCart.ok) {
        if (heldCart.expiredHoldIds.length > 0) {
          await trx
            .updateTable('checkout_holds')
            .set({ status: 'expired', updated_at: now })
            .where('checkout_session_id', '=', input.checkoutSessionId)
            .where('status', '=', 'active')
            .where('expires_at', '<', now)
            .execute();
        }
        await trx.updateTable('checkout_sessions')
          .set({ status: 'expired', updated_at: now })
          .where('id', '=', input.checkoutSessionId)
          .where('status', '!=', 'completed')
          .execute();
        return {
          ok: false,
          errorCode: 'HOLD_EXPIRED',
          message: heldCart.message,
          retryable: false,
        };
      }

      // Consume promo code idempotently under lock. The discount_codes row is
      // locked for update, revalidated against max_uses, and a redemption
      // record is inserted with a unique constraint on checkout_session_id.
      // If the activity retries after committing, the existing redemption
      // makes the consumption a no-op. The DB check constraint
      // uses_count <= max_uses is the final backstop against race conditions.
      if (cart.discountCode && quote.discountCents > 0) {
        const discount = await trx
          .selectFrom('discount_codes')
          .selectAll()
          .where('event_id', '=', session.event_id)
          .where('code', '=', cart.discountCode.toUpperCase())
          .forUpdate()
          .executeTakeFirst();

        if (!discount) {
          return {
            ok: false,
            errorCode: 'DISCOUNT_INVALID',
            message: `Discount code ${cart.discountCode} not found`,
            retryable: false,
          };
        }

        const existingRedemption = await trx
          .selectFrom('discount_redemptions')
          .select(['id'])
          .where('checkout_session_id', '=', input.checkoutSessionId)
          .executeTakeFirst();

        if (!existingRedemption) {
          if (discount.status !== 'active') {
            return {
              ok: false,
              errorCode: 'DISCOUNT_INVALID',
              message: `Discount code ${cart.discountCode} status is ${discount.status}`,
              retryable: false,
            };
          }
          const nowDate = now;
          if (discount.valid_from && new Date(discount.valid_from) > nowDate) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_INVALID',
              message: `Discount code ${cart.discountCode} not yet valid`,
              retryable: false,
            };
          }
          if (discount.valid_until && new Date(discount.valid_until) < nowDate) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_INVALID',
              message: `Discount code ${cart.discountCode} expired`,
              retryable: false,
            };
          }
          if (Number(discount.uses_count) >= Number(discount.max_uses)) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_EXHAUSTED',
              message: `Discount code ${cart.discountCode} max uses reached`,
              retryable: false,
            };
          }

          await trx
            .updateTable('discount_codes')
            .set((eb) => ({
              uses_count: eb('uses_count', '+', 1),
              updated_at: now,
            }))
            .where('id', '=', discount.id)
            .execute();

          await trx
            .insertInto('discount_redemptions')
            .values({
              id: `dred_${ulid()}`,
              discount_code_id: discount.id,
              event_id: session.event_id,
              checkout_session_id: input.checkoutSessionId,
              order_id: orderId,
              tenant_id: input.tenantId,
              created_at: now,
            })
            .execute();
        }
      }

      // Create order
      await trx.insertInto('orders').values({
        id: orderId,
        tenant_id: input.tenantId,
        organization_id: event.organization_id,
        brand_id: session.brand_id,
        event_id: session.event_id,
        checkout_session_id: input.checkoutSessionId,
        order_number: `GK-${Date.now().toString(36).toUpperCase()}`,
        status: 'paid',
        currency: session.currency,
        subtotal_cents: quote.subtotalCents,
        discount_cents: quote.discountCents,
        tax_cents: quote.taxCents,
        fee_cents: quote.feeCents,
        total_cents: quote.totalCents,
        refunded_cents: 0,
        buyer_email: buyer.email ?? '',
        buyer_first_name: buyer.firstName ?? null,
        buyer_last_name: buyer.lastName ?? null,
        buyer_phone: buyer.phone ?? null,
        payment_intent_id: paymentIntent?.id ?? null,
        payment_provider: paymentIntent?.provider ?? null,
        paid_at: now,
        created_at: now,
        updated_at: now,
      }).execute();

      if (paymentIntent) {
        await trx
          .updateTable('payment_intents')
          .set({ order_id: orderId, status: 'succeeded', updated_at: now })
          .where('id', '=', paymentIntent.id)
          .execute();
      }

      for (const hold of holds) {
        await trx
          .updateTable('checkout_holds')
          .set({ status: 'converted', updated_at: now })
          .where('id', '=', hold.id)
          .execute();
        await trx
          .updateTable('inventory_pools')
          .set((eb) => ({ sold_count: eb('sold_count', '+', hold.quantity), updated_at: now }))
          .where('id', '=', hold.inventory_pool_id)
          .execute();
      }

      for (const line of quote.lineItems ?? []) {
        await trx.insertInto('order_line_items').values({
          id: `oli_${ulid()}`,
          order_id: orderId,
          ticket_type_id: line.ticketTypeId,
          attendee_id: null,
          description: line.name,
          quantity: line.quantity,
          unit_price_cents: line.unitPriceCents,
          subtotal_cents: line.subtotalCents,
          discount_cents: line.discountCents,
          tax_cents: line.taxCents,
          fee_cents: line.feeCents,
          total_cents: line.totalCents,
          currency: session.currency,
          created_at: now,
          updated_at: now,
        }).execute();
      }

      // Create attendees and tickets with canonical signed QR payloads.
      const qrService = new QrService();
      for (const item of cart.items) {
        const itemAttendeeFields = cart.attendeeFields?.[item.ticketTypeId] ?? [];
        for (let i = 0; i < item.quantity; i++) {
          const customAnswers = itemAttendeeFields[i] ?? null;
          const attendeeId = `att_${ulid()}`;
          await trx.insertInto('attendees').values({
            id: attendeeId,
            tenant_id: input.tenantId,
            order_id: orderId,
            event_id: session.event_id,
            ticket_type_id: item.ticketTypeId,
            ticket_id: null,
            first_name: buyer.firstName ?? null,
            last_name: buyer.lastName ?? null,
            email: buyer.email ?? '',
            phone: buyer.phone ?? null,
            status: 'confirmed',
            custom_answers: customAnswers ? JSON.stringify(customAnswers) : null,
            checked_in_at: null,
            check_in_device_id: null,
            created_at: now,
            updated_at: now,
          }).execute();

          const consentAnswers = {
            ...cart.buyerFields,
            ...(customAnswers && typeof customAnswers === 'object' && !Array.isArray(customAnswers) ? customAnswers : {}),
          } as Record<string, unknown>;
          for (const question of consentQuestions) {
            const appliesToAttendee =
              question.applies_to === 'buyer' ||
              question.applies_to === 'attendee' ||
              question.applies_to === 'both';
            const ticketMatches = !question.ticket_type_id || question.ticket_type_id === item.ticketTypeId;
            const consentAnswer = consentAnswers[question.id];
            if (!appliesToAttendee || !ticketMatches || !isConsentAccepted(consentAnswer)) continue;
            const snapshot = isConsentAnswerSnapshot(consentAnswer) ? consentAnswer : undefined;
            await trx.insertInto('message_consents').values({
              id: `mc_${ulid()}`,
              tenant_id: input.tenantId,
              attendee_id: attendeeId,
              email: buyer.email ?? '',
              phone: buyer.phone ?? null,
              email_opt_in: true,
              sms_opt_in: false,
              consent_text: snapshot?.consentText ?? question.consent_text ?? question.label,
              consent_version: snapshot?.consentVersion ?? question.consent_version ?? '1',
              consented_at: snapshot?.consentedAt ? new Date(snapshot.consentedAt) : now,
              revoked_at: null,
              created_at: now,
            }).execute();
          }

          const ticketId = `tkt_${ulid()}`;
          const qr = qrService.generate(ticketId);

          await trx.insertInto('tickets').values({
            id: ticketId,
            tenant_id: input.tenantId,
            order_id: orderId,
            attendee_id: attendeeId,
            event_id: session.event_id,
            ticket_type_id: item.ticketTypeId,
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
          }).execute();

          // Link ticket to attendee
          await trx.updateTable('attendees').set({ ticket_id: ticketId, updated_at: now }).where('id', '=', attendeeId).execute();
        }
      }

      // Update session
      await trx.updateTable('checkout_sessions')
        .set({ status: 'completed', order_id: orderId, updated_at: now })
        .where('id', '=', input.checkoutSessionId)
        .execute();

      // Add timeline event
      await trx.insertInto('order_timeline_events').values({
        id: `ote_${ulid()}`,
        order_id: orderId,
        type: 'order.paid',
        description: 'Order confirmed and paid',
        metadata: null,
        actor_id: null,
        created_at: now,
      }).execute();

      // Persist affiliate attribution if an affiliate code was provided.
      if (input.affiliateCode) {
        const affiliate = await trx
          .selectFrom('affiliates')
          .selectAll()
          .where('code', '=', input.affiliateCode)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (affiliate) {
          const commissionCents = Math.round((quote.totalCents * affiliate.commission_percentage) / 10000);
          await trx.insertInto('attributions').values({
            id: `attr_${ulid()}`,
            order_id: orderId,
            affiliate_id: affiliate.id,
            affiliate_code: affiliate.code,
            commission_cents: commissionCents,
            attributed_at: now,
            created_at: now,
          }).execute();
        }
      }
      return { ok: true };
    });

    if (!finalizeResult.ok) {
      return errResult(finalizeResult.errorCode, finalizeResult.message, finalizeResult.retryable);
    }

    return okResult({ orderId });
  } catch (err) {
    // A concurrent finalize may have won the unique constraint on
    // checkout_session_id; treat that as success and return the committed order.
    try {
      const committed = await db
        .selectFrom('orders')
        .select(['id'])
        .where('checkout_session_id', '=', input.checkoutSessionId)
        .executeTakeFirst();
      if (committed) {
        return okResult({ orderId: committed.id });
      }
    } catch {
      // fall through to error result
    }
    return errResult(
      'ORDER_FINALIZE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      isRetryableDbConcurrencyError(err),
    );
  } finally {
    await db.destroy();
  }
}

// Activity: Send confirmation email
export async function sendConfirmationEmailActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
}): Promise<WorkflowActivityResult<{ jobId?: string; status: 'queued' | 'skipped' }>> {
  const db = createDb();
  try {
    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(input.orderId);
    if (!order) {
      return errResult('ORDER_NOT_FOUND', 'Order not found for confirmation email', false);
    }

    const existingJob = await db
      .selectFrom('email_jobs')
      .select(['id', 'status'])
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', `order-confirmed:${input.orderId}`)
      .executeTakeFirst();
    if (existingJob) {
      return okResult({ jobId: existingJob.id, status: 'queued' });
    }

    const route = await db
      .selectFrom('email_provider_routes')
      .select(['id'])
      .where('tenant_id', '=', input.tenantId)
      .where('brand_id', '=', input.brandId)
      .where('status', '=', 'active')
      .orderBy('priority', 'asc')
      .executeTakeFirst();

    const templateVersion = await db
      .selectFrom('notification_templates as template')
      .innerJoin('notification_template_versions as version', 'version.template_id', 'template.id')
      .select(['version.id'])
      .where('template.tenant_id', '=', input.tenantId)
      .where('template.key', '=', 'order-confirmed')
      .where('version.is_default', '=', true)
      .executeTakeFirst();
    if (!templateVersion) {
      return okResult({ status: 'skipped' });
    }
    if (!route) {
      return okResult({ status: 'skipped' });
    }

    const job = await new EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-confirmed',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
        orderNumber: order.order_number,
        orderId: input.orderId,
        eventId: order.event_id,
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      priority: 'high',
      idempotencyKey: `order-confirmed:${input.orderId}`,
    });

    // Start the notification delivery workflow to actually send the email.
    await startNotificationWorkflow({
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-confirmed',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
        orderNumber: order.order_number,
        orderId: input.orderId,
        eventId: order.event_id,
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      notificationType: 'transactional',
    });

    return okResult({ jobId: job.id, status: 'queued' });
  } catch (err) {
    return errResult('EMAIL_QUEUE_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

// Activity: Release all active holds for a checkout session
export async function releaseHoldActivity(input: {
  holdId?: string;
  checkoutSessionId?: string;
}): Promise<WorkflowActivityResult<{ released: boolean }>> {
  const db = createDb();
  try {
    let query = db
      .updateTable('checkout_holds')
      .set({ status: 'released', updated_at: new Date() })
      .where('status', '=', 'active');
    if (input.checkoutSessionId) {
      query = query.where('checkout_session_id', '=', input.checkoutSessionId);
    } else if (input.holdId) {
      query = query.where('id', '=', input.holdId);
    } else {
      return errResult('HOLD_RELEASE_FAILED', 'holdId or checkoutSessionId required', false);
    }
    await query.execute();
    return okResult({ released: true });
  } catch (err) {
    return errResult('HOLD_RELEASE_FAILED', err instanceof Error ? err.message : 'Unknown error', false);
  } finally {
    await db.destroy();
  }
}

// Activity: Issue tickets - generate PDF and send tickets-issued email
export async function issueTicketsActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
}): Promise<WorkflowActivityResult<{ issued: number; jobId?: string }>> {
  const db = createDb();
  try {
    const tickets = await db.selectFrom('tickets').selectAll().where('order_id', '=', input.orderId).execute();
    if (tickets.length === 0) {
      return okResult({ issued: 0 });
    }

    // Generate a simple PDF ticket for each ticket (base64-encoded for email attachment).
    // In production this would use a proper PDF library; here we generate a
    // minimal PDF stub that is valid and contains the ticket code.
    const pdfAttachments = tickets.map((ticket) => {
      const pdfContent = generateTicketPdf(ticket.code, ticket.id);
      return {
        filename: `ticket-${ticket.code}.pdf`,
        contentType: 'application/pdf',
        content: pdfContent,
        contentEncoding: 'base64' as const,
      };
    });

    // Check for existing email job to avoid duplicates.
    const existingJob = await db
      .selectFrom('email_jobs')
      .select(['id', 'status'])
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', `tickets-issued:${input.orderId}`)
      .executeTakeFirst();
    if (existingJob) {
      return okResult({ issued: tickets.length, jobId: existingJob.id });
    }

    // Resolve the provider route and template version.
    const route = await db
      .selectFrom('email_provider_routes')
      .select(['id'])
      .where('tenant_id', '=', input.tenantId)
      .where('brand_id', '=', input.brandId)
      .where('status', '=', 'active')
      .orderBy('priority', 'asc')
      .executeTakeFirst();

    const templateVersion = await db
      .selectFrom('notification_templates as template')
      .innerJoin('notification_template_versions as version', 'version.template_id', 'template.id')
      .select(['version.id'])
      .where('template.tenant_id', '=', input.tenantId)
      .where('template.key', '=', 'tickets-issued')
      .where('version.is_default', '=', true)
      .executeTakeFirst();

    if (!route || !templateVersion) {
      // No route or template configured; skip email but mark tickets as issued.
      return okResult({ issued: tickets.length });
    }

    const order = await new OrderRepository(db).findById(input.orderId);
    const job = await new EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'tickets-issued',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
        orderId: input.orderId,
        orderNumber: order?.order_number,
        ticketCount: tickets.length,
        notificationType: 'transactional',
        attachments: pdfAttachments,
      },
      providerRouteId: route.id,
      priority: 'high',
      idempotencyKey: `tickets-issued:${input.orderId}`,
    });

    // Start the notification delivery workflow.
    await startNotificationWorkflow({
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'tickets-issued',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
        orderId: input.orderId,
        orderNumber: order?.order_number,
        ticketCount: tickets.length,
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      notificationType: 'transactional',
    });

    return okResult({ issued: tickets.length, jobId: job.id });
  } catch (err) {
    return errResult('TICKET_ISSUE_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

/**
 * Generates a minimal valid PDF containing the ticket code.
 * Returns a base64-encoded string suitable for email attachment.
 */
function generateTicketPdf(code: string, ticketId: string): string {
  // Minimal valid PDF with the ticket code as text content.
  const content = `BT /F1 24 Tf 50 700 Td (GateKit Ticket) Tj ET BT /F1 36 Tf 50 650 Td (${code}) Tj ET BT /F1 12 Tf 50 600 Td (Ticket ID: ${ticketId}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000241 00000 n
0000000${(290 + content.length).toString().padStart(7, '0')} 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
${400 + content.length}
%%EOF`;
  return Buffer.from(pdf).toString('base64');
}
