import { createDb, type Database } from '@tixkit/db';
import { EmailJobRepository, PaymentIntentRepository, OrderRepository } from '@tixkit/db';
import { ulid } from 'ulid';
import { QrService } from '@tixkit/domain/tickets';
import { isConsentAccepted, isConsentAnswerSnapshot } from '@tixkit/domain';
import { withSpan } from '@tixkit/shared';
import Stripe from 'stripe';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import { Connection, Client } from '@temporalio/client';
import { notificationDeliveryWorkflow } from '../workflows/notification.js';
import type { NotificationDeliveryWorkflowInput } from '../workflows/notification.js';
import { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } from '../shared/types.js';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import {
  generateAppleWalletPass,
  generateGoogleWalletPass,
  loadWalletPassConfig,
  type WalletPassArtifact,
} from '../wallet-passes.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit';

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

type FinalizePaymentIntentValidationResult =
  | { ok: true; paymentIntent?: { id: string; provider: string } }
  | { ok: false; errorCode: string; message: string; retryable: boolean };

type TicketPdfInput = {
  ticket: {
    id: string;
    code: string;
    qr_payload: string;
    ticket_type_id: string;
    attendee_id: string | null;
  };
  ticketType?: { id: string; name: string } | null;
  attendee?: { id: string; email: string | null; first_name: string | null; last_name: string | null } | null;
  order?: { id: string; order_number: string; currency: string } | null;
  event?: {
    id: string;
    title: string;
    starts_at: Date | string;
    timezone: string;
    venue: unknown;
  } | null;
  brand?: { id: string; name: string; theme: unknown } | null;
};

type TicketWalletPassLink = {
  ticketId: string;
  ticketCode: string;
  provider: 'apple' | 'google';
  passUrl: string;
};

type BrandTheme = {
  primary?: string;
  primaryColor?: string;
  accent?: string;
};

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
        taskQueue: TEMPORAL_TASK_QUEUE,
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

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? '');
  const errno = String(record.errno ?? '');
  const message = String(record.message ?? '').toLowerCase();
  return code === '23505' || code === 'SQLITE_CONSTRAINT' || code === 'ER_DUP_ENTRY' || errno === '1062' || message.includes('unique constraint') || message.includes('duplicate entry');
}

async function findReusablePaymentIntent(input: {
  db: Database;
  checkoutSessionId: string;
  tenantId: string;
  provider: string;
  providerIntentId: string;
  amountCents: number;
  currency: string;
  clientSecret?: string;
  paymentAccountId: string | null;
}) {
  const existing = await input.db
    .selectFrom('payment_intents')
    .select([
      'id',
      'tenant_id',
      'checkout_session_id',
      'provider',
      'provider_intent_id',
      'amount_cents',
      'currency',
      'client_secret',
      'payment_account_id',
    ])
    .where('checkout_session_id', '=', input.checkoutSessionId)
    .where('provider', '=', input.provider)
    .where('provider_intent_id', '=', input.providerIntentId)
    .executeTakeFirst();

  if (!existing) return null;

  const existingClientSecret = existing.client_secret ?? undefined;
  const expectedClientSecret = input.clientSecret ?? undefined;
  const isMatch =
    existing.tenant_id === input.tenantId &&
    Number(existing.amount_cents) === input.amountCents &&
    existing.currency.toUpperCase() === input.currency.toUpperCase() &&
    existingClientSecret === expectedClientSecret &&
    (existing.payment_account_id ?? null) === input.paymentAccountId;

  return isMatch ? existing : null;
}

async function pointCheckoutSessionAtPaymentIntent(db: Database, checkoutSessionId: string, paymentIntentId: string): Promise<boolean> {
  const result = await db
    .updateTable('checkout_sessions')
    .set({ payment_intent_id: paymentIntentId, status: 'pending_payment', updated_at: new Date() })
    .where('id', '=', checkoutSessionId)
    .where('status', 'in', ['open', 'pending_payment'])
    .where((eb) =>
      eb.or([
        eb('payment_intent_id', 'is', null),
        eb('payment_intent_id', '=', paymentIntentId),
      ]),
    )
    .execute();
  if (Number((result[0] as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0) > 0) {
    return true;
  }

  const session = await db
    .selectFrom('checkout_sessions')
    .select(['status', 'payment_intent_id'])
    .where('id', '=', checkoutSessionId)
    .executeTakeFirst();
  return session?.payment_intent_id === paymentIntentId && ['open', 'pending_payment'].includes(session.status);
}

function validateHeldCartItems(input: {
  cartItems: { ticketTypeId?: string; productId?: string; quantity: number }[];
  holds: CheckoutHoldRow[];
  now: Date;
}): { ok: true } | { ok: false; expiredHoldIds: string[]; message: string } {
  const expectedByTicketType = new Map<string, number>();
  for (const item of input.cartItems) {
    if (!item.ticketTypeId) continue;
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

async function validateFinalizePaymentIntent(input: {
  db: Database;
  checkoutSessionId: string;
  tenantId: string;
  providerIntentId?: string;
  amountCents: number;
  currency: string;
}): Promise<FinalizePaymentIntentValidationResult> {
  if (input.amountCents <= 0) return { ok: true };

  if (!input.providerIntentId) {
    return {
      ok: false,
      errorCode: 'PAYMENT_INTENT_UNTRUSTED',
      message: 'Paid checkout requires a trusted payment intent',
      retryable: false,
    };
  }

  const paymentIntent = await input.db
    .selectFrom('payment_intents')
    .select([
      'id',
      'provider',
      'provider_intent_id',
      'checkout_session_id',
      'tenant_id',
      'amount_cents',
      'currency',
    ])
    .where('provider_intent_id', '=', input.providerIntentId)
    .executeTakeFirst();

  if (!paymentIntent) {
    return {
      ok: false,
      errorCode: 'PAYMENT_INTENT_UNTRUSTED',
      message: 'Paid checkout payment intent does not match the checkout session',
      retryable: false,
    };
  }

  const isTrustedPaymentIntent =
    paymentIntent.provider_intent_id === input.providerIntentId &&
    paymentIntent.checkout_session_id === input.checkoutSessionId &&
    paymentIntent.tenant_id === input.tenantId &&
    Number(paymentIntent.amount_cents) === input.amountCents &&
    String(paymentIntent.currency).toUpperCase() === input.currency.toUpperCase();

  if (!isTrustedPaymentIntent) {
    return {
      ok: false,
      errorCode: 'PAYMENT_INTENT_UNTRUSTED',
      message: 'Paid checkout payment intent does not match the checkout session',
      retryable: false,
    };
  }

  return {
    ok: true,
    paymentIntent: {
      id: paymentIntent.id,
      provider: paymentIntent.provider,
    },
  };
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
      if (process.env.NODE_ENV === 'production') {
        return errResult('STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured', false);
      }

      const piRepo = new PaymentIntentRepository(db);
      const providerIntentId = `pi_capture_${input.checkoutSessionId}`;
      const clientSecret = `${providerIntentId}_secret`;
      const provider = 'stripe_capture';
      let createdPaymentIntent = await findReusablePaymentIntent({
        db,
        checkoutSessionId: input.checkoutSessionId,
        tenantId: input.tenantId,
        provider,
        providerIntentId,
        amountCents: input.amountCents,
        currency: input.currency,
        clientSecret,
        paymentAccountId: null,
      });

      if (!createdPaymentIntent) {
        try {
          createdPaymentIntent = await piRepo.create({
            tenantId: input.tenantId,
            checkoutSessionId: input.checkoutSessionId,
            provider,
            providerIntentId,
            amountCents: input.amountCents,
            currency: input.currency,
            status: 'succeeded',
            clientSecret,
            metadata: {
              checkoutSessionId: input.checkoutSessionId,
              tenantId: input.tenantId,
              brandId: input.brandId,
              captureMode: 'true',
            },
            paymentAccountId: null,
          });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
          createdPaymentIntent = await findReusablePaymentIntent({
            db,
            checkoutSessionId: input.checkoutSessionId,
            tenantId: input.tenantId,
            provider,
            providerIntentId,
            amountCents: input.amountCents,
            currency: input.currency,
            clientSecret,
            paymentAccountId: null,
          });
          if (!createdPaymentIntent) throw err;
        }
      }

      const attached = await pointCheckoutSessionAtPaymentIntent(db, input.checkoutSessionId, createdPaymentIntent.id);
      if (!attached) {
        return errResult(
          'CHECKOUT_SESSION_NOT_PAYABLE',
          `Checkout session ${input.checkoutSessionId} cannot accept payment intent ${createdPaymentIntent.id}`,
          false,
        );
      }

      return okResult({ providerIntentId, clientSecret });
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

    const paymentIntent = await withSpan(
      'provider.stripe.payment_intent.create',
      {
        'tixkit.provider': 'stripe',
        'tixkit.provider.operation': 'payment_intent.create',
        'tixkit.tenant_id': input.tenantId,
        'tixkit.brand_id': input.brandId,
        'tixkit.checkout_session_id': input.checkoutSessionId,
        'tixkit.payment_account_id': paymentAccountId ?? undefined,
      },
      async (span) => {
        const created = await stripe.paymentIntents.create(
          createParams,
          {
            idempotencyKey: input.checkoutSessionId,
          },
        );
        span.setAttribute('tixkit.provider.intent_id', created.id);
        span.setAttribute('tixkit.provider.intent_status', created.status);
        return created;
      },
    );

    const piRepo = new PaymentIntentRepository(db);
    const provider = connectedAccountId ? 'stripe_connect' : 'stripe';
    const clientSecret = paymentIntent.client_secret ?? undefined;
    let createdPaymentIntent = await findReusablePaymentIntent({
      db,
      checkoutSessionId: input.checkoutSessionId,
      tenantId: input.tenantId,
      provider,
      providerIntentId: paymentIntent.id,
      amountCents: input.amountCents,
      currency: input.currency,
      clientSecret,
      paymentAccountId,
    });

    if (!createdPaymentIntent) {
      try {
        createdPaymentIntent = await piRepo.create({
          tenantId: input.tenantId,
          checkoutSessionId: input.checkoutSessionId,
          provider,
          providerIntentId: paymentIntent.id,
          amountCents: input.amountCents,
          currency: input.currency,
          status: paymentIntent.status,
          clientSecret,
          metadata: { checkoutSessionId: input.checkoutSessionId, tenantId: input.tenantId, brandId: input.brandId },
          paymentAccountId,
        });
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        createdPaymentIntent = await findReusablePaymentIntent({
          db,
          checkoutSessionId: input.checkoutSessionId,
          tenantId: input.tenantId,
          provider,
          providerIntentId: paymentIntent.id,
          amountCents: input.amountCents,
          currency: input.currency,
          clientSecret,
          paymentAccountId,
        });
        if (!createdPaymentIntent) throw err;
      }
    }

    const attached = await pointCheckoutSessionAtPaymentIntent(db, input.checkoutSessionId, createdPaymentIntent.id);
    if (!attached) {
      return errResult(
        'CHECKOUT_SESSION_NOT_PAYABLE',
        `Checkout session ${input.checkoutSessionId} cannot accept payment intent ${createdPaymentIntent.id}`,
        false,
      );
    }

    return okResult({
      providerIntentId: paymentIntent.id,
      clientSecret,
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
        type?: 'ticket' | 'product';
        ticketTypeId?: string;
        productId?: string;
        eventOccurrenceId?: string;
        name: string;
        quantity: number;
        unitPriceCents: number;
        subtotalCents: number;
        discountCents: number;
        taxCents: number;
        taxBreakdown?: Array<{
          taxRuleId?: string;
          taxRuleName: string;
          rate: number;
          type: string;
          appliedTo: string;
          taxableAmountCents: number;
          taxCents: number;
          jurisdictionCountry?: string;
          jurisdictionRegion?: string;
          provider?: string;
          providerCalculationId?: string;
        }>;
        feeCents: number;
        totalCents: number;
      }>;
    }>(session.quote);
    const cart = parseStoredJson<{
      items: {
        ticketTypeId?: string;
        occurrenceId?: string;
        productId?: string;
        quantity: number;
        attendeeFields?: Record<string, unknown>[];
      }[];
      buyerFields?: Record<string, unknown>;
      attendeeFields?: Record<string, unknown[]>;
      discountCode?: string;
    }>(session.cart);
    const buyer = parseStoredJson<{ email?: string; firstName?: string; lastName?: string; phone?: string }>(session.buyer);

    const event = await db.selectFrom('events').selectAll().where('id', '=', session.event_id).executeTakeFirstOrThrow();
    const paymentIntentValidation = await validateFinalizePaymentIntent({
      db,
      checkoutSessionId: input.checkoutSessionId,
      tenantId: input.tenantId,
      providerIntentId: input.paymentIntentId,
      amountCents: quote.totalCents,
      currency: session.currency,
    });
    if (!paymentIntentValidation.ok) {
      return errResult(paymentIntentValidation.errorCode, paymentIntentValidation.message, paymentIntentValidation.retryable);
    }
    const paymentIntent = paymentIntentValidation.paymentIntent;

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
      const [brand, organization] = await Promise.all([
        trx.selectFrom('brands').select(['name']).where('id', '=', session.brand_id).executeTakeFirst(),
        trx.selectFrom('organizations').select(['name']).where('id', '=', event.organization_id).executeTakeFirst(),
      ]);
      await trx.insertInto('orders').values({
        id: orderId,
        tenant_id: input.tenantId,
        organization_id: event.organization_id,
        brand_id: session.brand_id,
        event_id: session.event_id,
        checkout_session_id: input.checkoutSessionId,
        order_number: `TK-${orderId.replace(/^ord_/, '').toUpperCase()}`,
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
        // eslint-disable-next-line no-await-in-loop -- each hold conversion and pool increment is ordered inside the finalize transaction.
        await trx
          .updateTable('checkout_holds')
          .set({ status: 'converted', updated_at: now })
          .where('id', '=', hold.id)
          .execute();
        // eslint-disable-next-line no-await-in-loop -- inventory counts are updated immediately after the matching hold conversion.
        await trx
          .updateTable('inventory_pools')
          .set((eb) => ({ sold_count: eb('sold_count', '+', hold.quantity), updated_at: now }))
          .where('id', '=', hold.inventory_pool_id)
          .execute();
      }

      for (const line of quote.lineItems ?? []) {
        const lineItemId = `oli_${ulid()}`;
        // eslint-disable-next-line no-await-in-loop -- order line items are inserted serially within the order finalization transaction.
        await trx.insertInto('order_line_items').values({
          id: lineItemId,
          order_id: orderId,
          ticket_type_id: line.ticketTypeId ?? null,
          event_occurrence_id: line.eventOccurrenceId ?? null,
          product_id: line.productId ?? null,
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

        for (const tax of line.taxBreakdown ?? []) {
          if (tax.taxCents === 0 && tax.taxableAmountCents === 0) continue;
          // eslint-disable-next-line no-await-in-loop -- snapshots must be tied to the just-created line item.
          await trx.insertInto('order_tax_snapshots').values({
            id: `ots_${ulid()}`,
            order_id: orderId,
            order_line_item_id: lineItemId,
            event_id: session.event_id,
            tax_rule_id: tax.taxRuleId ?? null,
            tax_rule_name: tax.taxRuleName,
            rate: tax.rate,
            type: tax.type,
            applied_to: tax.appliedTo,
            jurisdiction_country: tax.jurisdictionCountry ?? null,
            jurisdiction_region: tax.jurisdictionRegion ?? null,
            taxable_amount_cents: tax.taxableAmountCents,
            tax_cents: tax.taxCents,
            currency: session.currency,
            inclusive: tax.type === 'inclusive',
            provider: tax.provider ?? 'tixkit_rules',
            provider_calculation_id: tax.providerCalculationId ?? null,
            metadata: JSON.stringify({ source: 'checkout_quote' }),
            created_at: now,
          }).execute();
        }
      }

      const buyerFields = cart.buyerFields && typeof cart.buyerFields === 'object'
        ? cart.buyerFields as Record<string, unknown>
        : {};
      const buyerTaxId = typeof buyerFields.taxId === 'string'
        ? buyerFields.taxId
        : typeof buyerFields.vatId === 'string'
          ? buyerFields.vatId
          : undefined;
      const sellerName = brand?.name ?? organization?.name ?? 'Tixkit';
      await trx.insertInto('invoices').values({
        id: `inv_${ulid()}`,
        order_id: orderId,
        tenant_id: input.tenantId,
        organization_id: event.organization_id,
        brand_id: session.brand_id,
        event_id: session.event_id,
        invoice_number: `INV-${orderId.replace(/^ord_/, '').toUpperCase()}`,
        status: 'issued',
        currency: session.currency,
        subtotal_cents: quote.subtotalCents,
        discount_cents: quote.discountCents,
        tax_cents: quote.taxCents,
        fee_cents: quote.feeCents,
        total_cents: quote.totalCents,
        refunded_cents: 0,
        buyer_email: buyer.email ?? '',
        buyer_name: [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || null,
        buyer_tax_id: buyerTaxId ?? null,
        seller_name: sellerName,
        seller_tax_id: null,
        reverse_charge: false,
        issued_at: now,
        voided_at: null,
        metadata: JSON.stringify({ taxProvider: 'tixkit_rules' }),
        created_at: now,
        updated_at: now,
      }).execute();

      // Create attendees and tickets with canonical signed QR payloads.
      const qrService = new QrService();
      for (const item of cart.items) {
        if (!item.ticketTypeId) continue;
        const itemAttendeeFields = item.attendeeFields ?? cart.attendeeFields?.[item.ticketTypeId] ?? [];
        for (let i = 0; i < item.quantity; i++) {
          const customAnswers = itemAttendeeFields[i] ?? null;
          const attendeeId = `att_${ulid()}`;
          // eslint-disable-next-line no-await-in-loop -- attendee rows must exist before consent snapshots and tickets link to them.
          await trx.insertInto('attendees').values({
            id: attendeeId,
            tenant_id: input.tenantId,
            order_id: orderId,
            event_id: session.event_id,
            ticket_type_id: item.ticketTypeId,
            event_occurrence_id: item.occurrenceId ?? null,
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
            // eslint-disable-next-line no-await-in-loop -- consent snapshots are tied to the attendee being created in this loop iteration.
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

          // eslint-disable-next-line no-await-in-loop -- ticket issuance depends on the attendee id and generated QR payload for this iteration.
          await trx.insertInto('tickets').values({
            id: ticketId,
            tenant_id: input.tenantId,
            order_id: orderId,
            attendee_id: attendeeId,
            event_id: session.event_id,
            ticket_type_id: item.ticketTypeId,
            event_occurrence_id: item.occurrenceId ?? null,
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
          // eslint-disable-next-line no-await-in-loop -- attendee linkage must follow the ticket insert that generated this ticket id.
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
          .where('tenant_id', '=', session.tenant_id)
          .where('organization_id', '=', event.organization_id)
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
  checkoutSessionStatus?: 'cancelled' | 'expired';
}): Promise<WorkflowActivityResult<{ released: boolean }>> {
  const db = createDb();
  try {
    if (input.checkoutSessionStatus && !input.checkoutSessionId) {
      return errResult('HOLD_RELEASE_FAILED', 'checkoutSessionId required when updating checkout session status', false);
    }

    const now = new Date();
    if (!input.checkoutSessionId && !input.holdId) {
      return errResult('HOLD_RELEASE_FAILED', 'holdId or checkoutSessionId required', false);
    }

    await db.transaction().execute(async (trx) => {
      let query = trx
        .updateTable('checkout_holds')
        .set({ status: 'released', updated_at: now })
        .where('status', '=', 'active');
      if (input.checkoutSessionId) {
        query = query.where('checkout_session_id', '=', input.checkoutSessionId);
      } else {
        query = query.where('id', '=', input.holdId!);
      }
      await query.execute();

      if (input.checkoutSessionStatus) {
        await trx
          .updateTable('checkout_sessions')
          .set({ status: input.checkoutSessionStatus, updated_at: now })
          .where('id', '=', input.checkoutSessionId!)
          .where('status', '!=', 'completed')
          .execute();
      }
    });

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

    const order = await new OrderRepository(db).findById(input.orderId);
    const [event, brand] = await Promise.all([
      order
        ? db
            .selectFrom('events')
            .select(['id', 'title', 'starts_at', 'timezone', 'venue'])
            .where('id', '=', order.event_id)
            .executeTakeFirst()
        : undefined,
      db
        .selectFrom('brands')
        .select(['id', 'name', 'theme'])
        .where('id', '=', input.brandId)
        .executeTakeFirst(),
    ]);

    const ticketTypeIds = [...new Set(tickets.map((ticket) => ticket.ticket_type_id as string))];
    const attendeeIds = tickets
      .map((ticket) => ticket.attendee_id)
      .filter((attendeeId): attendeeId is string => typeof attendeeId === 'string' && attendeeId.length > 0);
    const [ticketTypes, attendees] = await Promise.all([
      ticketTypeIds.length > 0
        ? db
            .selectFrom('ticket_types')
            .select(['id', 'name'])
            .where('id', 'in', ticketTypeIds)
            .execute()
        : Promise.resolve([]),
      attendeeIds.length > 0
        ? db
            .selectFrom('attendees')
            .select(['id', 'email', 'first_name', 'last_name'])
            .where('id', 'in', attendeeIds)
            .execute()
        : Promise.resolve([]),
    ]);
    const ticketTypesById = new Map(ticketTypes.map((ticketType) => [ticketType.id, ticketType]));
    const attendeesById = new Map(attendees.map((attendee) => [attendee.id, attendee]));
    const walletPassLinks = await ensureWalletPassesForTickets(db, {
      tickets,
      ticketTypesById,
      attendeesById,
      order,
      event,
      brand,
      tenantId: input.tenantId,
    });

    const pdfAttachments = await Promise.all(tickets.map(async (ticket) => {
      const pdfContent = await generateTicketPdf({
        ticket,
        ticketType: ticketTypesById.get(ticket.ticket_type_id) ?? null,
        attendee: ticket.attendee_id ? attendeesById.get(ticket.attendee_id) ?? null : null,
        order,
        event,
        brand,
      });
      return {
        filename: `ticket-${ticket.code}.pdf`,
        contentType: 'application/pdf',
        content: pdfContent,
        contentEncoding: 'base64' as const,
      };
    }));

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
        walletPasses: walletPassLinks,
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

async function ensureWalletPassesForTickets(
  db: Database,
  input: {
    tickets: Array<{
      id: string;
      tenant_id: string;
      code: string;
      qr_payload: string;
      ticket_type_id: string;
      attendee_id: string | null;
    }>;
    ticketTypesById: Map<string, { id: string; name: string }>;
    attendeesById: Map<string, { id: string; email: string | null; first_name: string | null; last_name: string | null }>;
    order?: { id: string; order_number: string; currency: string; event_id: string } | null;
    event?: {
      id: string;
      title: string;
      starts_at: Date | string;
      timezone: string;
      venue: unknown;
    } | null;
    brand?: { id: string; name: string; theme: unknown } | null;
    tenantId: string;
  },
): Promise<TicketWalletPassLink[]> {
  const config = loadWalletPassConfig();
  if (!config.apple && !config.google) return [];
  if (!input.order || !input.event) {
    throw new Error('Wallet pass generation requires a persisted order and event');
  }

  const ticketIds = input.tickets.map((ticket) => ticket.id);
  if (ticketIds.length === 0) return [];

  const existingPasses = await db
    .selectFrom('wallet_passes')
    .selectAll()
    .where('ticket_id', 'in', ticketIds)
    .execute();
  const existingKeys = new Set(existingPasses.map((pass) => `${pass.ticket_id}:${pass.provider}`));
  const links: TicketWalletPassLink[] = [];
  const brandTheme = parseBrandTheme(input.brand?.theme);
  const brandColor = brandTheme.primaryColor ?? brandTheme.primary ?? brandTheme.accent;

  for (const ticket of input.tickets) {
    const ticketType = input.ticketTypesById.get(ticket.ticket_type_id);
    const attendee = ticket.attendee_id ? input.attendeesById.get(ticket.attendee_id) : undefined;
    const commonInput = {
      ticketId: ticket.id,
      ticketCode: ticket.code,
      ticketTypeName: ticketType?.name ?? 'Ticket',
      attendeeName: attendeeName(attendee ?? null),
      qrPayload: ticket.qr_payload,
      eventId: input.event.id,
      eventTitle: input.event.title,
      startsAt: input.event.starts_at,
      timezone: input.event.timezone,
      venueName: venueLabel(input.event.venue),
      brandName: input.brand?.name ?? 'Tixkit',
      brandColor,
    };

    const artifacts: Array<{ id: string; artifact: WalletPassArtifact }> = [];
    if (config.apple && !existingKeys.has(`${ticket.id}:apple`)) {
      const id = `wps_${ulid()}`;
      artifacts.push({
        id,
        // eslint-disable-next-line no-await-in-loop -- pass signing is tied to this ticket/provider id before persistence.
        artifact: await generateAppleWalletPass({ ...commonInput, passId: id }, config.apple, config.apiBaseUrl),
      });
    }
    if (config.google && !existingKeys.has(`${ticket.id}:google`)) {
      const id = `wps_${ulid()}`;
      artifacts.push({
        id,
        artifact: generateGoogleWalletPass({ ...commonInput, passId: id }, config.google),
      });
    }

    for (const { id, artifact } of artifacts) {
      const now = new Date();
      // eslint-disable-next-line no-await-in-loop -- inserts update the per-ticket/provider idempotency set before the next provider is considered.
      await db
        .insertInto('wallet_passes')
        .values({
          id,
          tenant_id: input.tenantId,
          ticket_id: ticket.id,
          provider: artifact.provider,
          status: 'active',
          serial_number: artifact.serialNumber,
          pass_url: artifact.passUrl,
          access_token_hash: artifact.accessTokenHash ?? null,
          content_type: artifact.contentType ?? null,
          artifact_base64: artifact.artifactBase64 ?? null,
          metadata: JSON.stringify(artifact.metadata),
          revoked_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      existingKeys.add(`${ticket.id}:${artifact.provider}`);
      existingPasses.push({
        id,
        tenant_id: input.tenantId,
        ticket_id: ticket.id,
        provider: artifact.provider,
        status: 'active',
        serial_number: artifact.serialNumber,
        pass_url: artifact.passUrl,
        access_token_hash: artifact.accessTokenHash ?? null,
        content_type: artifact.contentType ?? null,
        artifact_base64: artifact.artifactBase64 ?? null,
        metadata: JSON.stringify(artifact.metadata),
        revoked_at: null,
        created_at: now,
        updated_at: now,
      });
      if (artifact.provider === 'apple') {
        // eslint-disable-next-line no-await-in-loop -- the ticket points at the persisted Apple pass id created in this iteration.
        await db.updateTable('tickets').set({ wallet_pass_id: id, updated_at: now }).where('id', '=', ticket.id).execute();
      }
    }
  }

  for (const pass of existingPasses) {
    if (pass.status !== 'active') continue;
    if (pass.provider !== 'apple' && pass.provider !== 'google') continue;
    const ticket = input.tickets.find((candidate) => candidate.id === pass.ticket_id);
    if (!ticket) continue;
    links.push({
      ticketId: ticket.id,
      ticketCode: ticket.code,
      provider: pass.provider,
      passUrl: pass.pass_url,
    });
  }

  return links;
}

/**
 * Generates a branded ticket PDF with a scannable QR code.
 * Returns a base64-encoded string suitable for email attachment.
 */
async function generateTicketPdf(input: TicketPdfInput): Promise<string> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Tixkit ticket ${input.ticket.code}`);
  pdfDoc.setSubject(`${input.event?.title ?? 'Event ticket'} / ${input.order?.order_number ?? input.order?.id ?? 'Order'}`);
  pdfDoc.setKeywords([input.ticket.id, input.ticket.code, input.ticket.qr_payload]);
  pdfDoc.setProducer('Tixkit');

  const page = pdfDoc.addPage([612, 792]);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const primary = parsePdfColor(parseBrandTheme(input.brand?.theme).primaryColor ?? parseBrandTheme(input.brand?.theme).primary ?? parseBrandTheme(input.brand?.theme).accent);

  page.drawRectangle({ x: 0, y: 688, width: 612, height: 104, color: primary });
  page.drawText(pdfText(input.brand?.name ?? 'Tixkit'), {
    x: 48,
    y: 746,
    size: 16,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(pdfText(input.event?.title ?? 'Event Ticket'), {
    x: 48,
    y: 712,
    size: 24,
    font: bold,
    color: rgb(1, 1, 1),
  });

  const qrDataUrl = await QRCode.toDataURL(input.ticket.qr_payload, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 2,
    width: 260,
    color: {
      dark: '#111111',
      light: '#FFFFFFFF',
    },
  });
  const qrPng = Buffer.from(qrDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  const qrImage = await pdfDoc.embedPng(qrPng);
  page.drawRectangle({ x: 352, y: 382, width: 212, height: 212, color: rgb(1, 1, 1), borderColor: rgb(0.82, 0.84, 0.87), borderWidth: 1 });
  page.drawImage(qrImage, { x: 368, y: 398, width: 180, height: 180 });
  drawField(page, bold, regular, 'Ticket Code', input.ticket.code, 48, 620);
  drawField(page, bold, regular, 'Ticket Type', input.ticketType?.name ?? 'Ticket', 48, 552);
  drawField(page, bold, regular, 'Attendee', attendeeName(input.attendee), 48, 484);
  drawField(page, bold, regular, 'Order', input.order?.order_number ?? input.order?.id ?? 'Order pending', 48, 416);
  drawField(page, bold, regular, 'Date', formatEventDate(input.event?.starts_at, input.event?.timezone), 48, 348);
  drawField(page, bold, regular, 'Venue', venueLabel(input.event?.venue), 48, 280);

  page.drawText('Scan the QR code at entry. This ticket is tenant-scoped and cryptographically signed.', {
    x: 48,
    y: 132,
    size: 10,
    font: regular,
    color: rgb(0.36, 0.39, 0.44),
  });
  page.drawText(pdfText(`Ticket ID: ${input.ticket.id}`), {
    x: 48,
    y: 108,
    size: 9,
    font: regular,
    color: rgb(0.45, 0.48, 0.52),
  });

  const bytes = await pdfDoc.save({ useObjectStreams: false });
  return Buffer.from(bytes).toString('base64');
}

function drawField(
  page: ReturnType<PDFDocument['addPage']>,
  bold: PDFFont,
  regular: PDFFont,
  label: string,
  value: string,
  x: number,
  y: number,
): void {
  page.drawText(label.toUpperCase(), { x, y, size: 9, font: bold, color: rgb(0.42, 0.45, 0.5) });
  page.drawText(pdfText(value), { x, y: y - 26, size: 16, font: regular, color: rgb(0.08, 0.09, 0.11), maxWidth: 270 });
}

function parseBrandTheme(value: unknown): BrandTheme {
  if (!value) return {};
  if (typeof value === 'object') return value as BrandTheme;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as BrandTheme : {};
  } catch {
    return {};
  }
}

function parsePdfColor(value: unknown): ReturnType<typeof rgb> {
  if (typeof value !== 'string') return rgb(0.12, 0.13, 0.15);
  const hex = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  const full = /^#([0-9a-f]{6})$/i.exec(hex);
  const normalized = short
    ? short[1].split('').map((part) => `${part}${part}`).join('')
    : full?.[1];
  if (!normalized) return rgb(0.12, 0.13, 0.15);
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255;
  return rgb(red, green, blue);
}

function attendeeName(attendee: TicketPdfInput['attendee']): string {
  if (!attendee) return 'Guest';
  const name = [attendee.first_name, attendee.last_name].filter(Boolean).join(' ').trim();
  return name || attendee.email || 'Guest';
}

function formatEventDate(value: Date | string | undefined, timezone = 'UTC'): string {
  if (!value) return 'Date to be announced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date to be announced';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(date);
}

function venueLabel(value: unknown): string {
  const venue = parseStoredJson<Record<string, unknown> | null>(value ?? null);
  if (!venue) return 'Venue to be announced';
  const parts = [
    stringValue(venue.name),
    stringValue(venue.address),
    [stringValue(venue.city), stringValue(venue.region), stringValue(venue.postalCode ?? venue.postal_code)]
      .filter(Boolean)
      .join(', '),
    stringValue(venue.country),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'Venue to be announced';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pdfText(value: string): string {
  return value.replace(/[^\u0020-\u007e]/g, '?').slice(0, 500);
}
