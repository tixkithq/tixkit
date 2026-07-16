import type { Database } from '@tixkit/db';
import {
  EmailJobRepository,
  PaymentCompensationRepository,
  PaymentIntentRepository,
  OrderRepository,
  ContentRepository,
} from '@tixkit/db';
import { ulid } from 'ulid';
import { QrService } from '@tixkit/domain/tickets';
import type { BoxOfficeTenderType, SalesChannel } from '@tixkit/domain';
import { isConsentAccepted, isConsentAnswerSnapshot } from '@tixkit/domain';
import {
  ProviderOperationError,
  StripeSdkGateway,
  type CreateStripeRefundInput,
} from '@tixkit/provider-clients';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import {
  generateAppleWalletPass,
  generateGoogleWalletPass,
  loadWalletPassConfig,
  type WalletPassArtifact,
} from '../wallet-passes.js';
import { buildTransactionalMergeTagContext } from './messaging-context.js';
import {
  durablyStartNotificationDeliveryWorkflow,
  getActivityDb,
  restartQueuedNotificationDeliveryWorkflow,
} from './activity-clients.js';

const e2eTicketIssueFailures = new Set<string>();
const DEFAULT_TICKET_PDF_GENERATION_CONCURRENCY = 4;
const DEFAULT_WALLET_PASS_GENERATION_CONCURRENCY = 2;

function parsePositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name]?.trim();
  if (!value) return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        // eslint-disable-next-line no-await-in-loop -- workers intentionally consume bounded concurrent work one item at a time.
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );

  return results;
}

function normalizeDiscountCode(code: string): string {
  return code.trim().toUpperCase();
}

async function releasePendingDiscountReservation(
  db: Database,
  checkoutSessionId: string,
  now: Date,
): Promise<void> {
  const redemption = await db
    .selectFrom('discount_redemptions')
    .select(['id', 'discount_code_id'])
    .where('checkout_session_id', '=', checkoutSessionId)
    .where('order_id', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!redemption) return;

  await db.deleteFrom('discount_redemptions').where('id', '=', redemption.id).execute();
  await db
    .updateTable('discount_codes')
    .set((eb) => ({
      uses_count: eb('uses_count', '-', 1),
      updated_at: now,
    }))
    .where('id', '=', redemption.discount_code_id)
    .where('uses_count', '>', 0)
    .execute();
}

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

type OrphanPaymentCompensationAction = 'cancel' | 'refund' | 'local_noop';
type OrphanPaymentCompensationStatus = 'succeeded' | 'failed' | 'manual_review' | 'already_ordered';
type CompensablePaymentIntentLookup =
  | { paymentIntent?: PaymentIntentRow; mismatchMessage?: undefined }
  | { paymentIntent?: undefined; mismatchMessage: string };

class WaitlistOfferUnavailableError extends Error {
  constructor() {
    super('Waitlist offer is no longer available');
    this.name = 'WaitlistOfferUnavailableError';
  }
}

type PaymentIntentRow = NonNullable<Awaited<ReturnType<PaymentIntentRepository['findById']>>>;
type PaymentCompensationRow = NonNullable<
  Awaited<ReturnType<PaymentCompensationRepository['findByProviderIntent']>>
>;

type TicketPdfInput = {
  ticket: {
    id: string;
    code: string;
    qr_payload: string;
    ticket_type_id: string;
    attendee_id: string | null;
  };
  ticketType?: { id: string; name: string } | null;
  attendee?: {
    id: string;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  } | null;
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

function parseStoredJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

function failTicketIssueActivityOnceForE2e(input: { orderId: string; toEmail: string }): void {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE !== '1'
  ) {
    return;
  }

  const key = process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE_KEY?.trim() || input.toEmail;
  if (!input.toEmail.includes(key) && input.orderId !== key) return;
  if (e2eTicketIssueFailures.has(key)) return;
  e2eTicketIssueFailures.add(key);
  throw new Error(`E2E injected ticket issue activity failure for ${key}`);
}

function isRetryableDbConcurrencyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? '');
  const errno = String(record.errno ?? '');
  return (
    code === '40P01' ||
    code === '40001' ||
    code === 'ER_LOCK_DEADLOCK' ||
    code === 'ER_LOCK_WAIT_TIMEOUT' ||
    errno === '1213' ||
    errno === '1205'
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code ?? '');
  const errno = String(record.errno ?? '');
  const message = String(record.message ?? '').toLowerCase();
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT' ||
    code === 'ER_DUP_ENTRY' ||
    errno === '1062' ||
    message.includes('unique constraint') ||
    message.includes('duplicate entry')
  );
}

function isStripePaymentProvider(provider: string): boolean {
  return provider === 'stripe' || provider === 'stripe_connect';
}

function stripeCompensationIdempotencyKey(input: {
  action: OrphanPaymentCompensationAction;
  provider: string;
  providerIntentId: string;
  checkoutSessionId: string;
}): string {
  return `orphan-payment:${input.action}:${input.provider}:${input.providerIntentId}:${input.checkoutSessionId}`;
}

function stripePaymentIntentIsCancelable(status: string): boolean {
  return [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'requires_capture',
    'processing',
  ].includes(status);
}

function stripeOrphanRefundParams(input: {
  provider: string;
  providerIntentId: string;
  amount: number;
}): Omit<CreateStripeRefundInput, 'idempotencyKey' | 'reason'> {
  const params: Omit<CreateStripeRefundInput, 'idempotencyKey' | 'reason'> = {
    paymentIntentId: input.providerIntentId,
    amount: input.amount,
  };
  if (input.provider === 'stripe_connect') {
    params.reverseTransfer = true;
    params.refundApplicationFee = true;
  }
  return params;
}

function providerIntentMetadata(input: {
  reason: string;
  providerEventId?: string;
  eventType?: string;
  providerStatus?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...input.metadata,
    reason: input.reason,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    providerStatus: input.providerStatus,
    source: input.source,
  };
}

async function findCompensablePaymentIntent(input: {
  repo: PaymentIntentRepository;
  checkoutSessionId: string;
  provider?: string;
  providerIntentId?: string;
}): Promise<CompensablePaymentIntentLookup> {
  if (input.providerIntentId) {
    const sessionScoped = await input.repo.findByCheckoutSessionAndProviderIntentId(
      input.checkoutSessionId,
      input.providerIntentId,
    );
    if (sessionScoped) {
      if (input.provider && sessionScoped.provider !== input.provider) {
        return {
          mismatchMessage: 'Payment intent provider does not match the checkout provider',
        };
      }
      return { paymentIntent: sessionScoped };
    }

    const anyProviderIntent = await input.repo.findByProviderIntentId(input.providerIntentId);
    if (anyProviderIntent) {
      return {
        mismatchMessage: 'Provider payment intent does not match the checkout session',
      };
    }
    return {};
  }

  const latest = await input.repo.findLatestByCheckoutSession(input.checkoutSessionId);
  if (latest && input.provider && latest.provider !== input.provider) {
    return {
      mismatchMessage: 'Payment intent provider does not match the checkout provider',
    };
  }
  return { paymentIntent: latest };
}

async function releaseOrphanCheckoutResources(
  db: Database,
  checkoutSessionId: string,
): Promise<void> {
  const now = new Date();
  await db.transaction().execute(async (trx) => {
    const session = await trx
      .selectFrom('checkout_sessions')
      .select(['tenant_id', 'cart'])
      .where('id', '=', checkoutSessionId)
      .executeTakeFirst();
    if (session) {
      const cart = parseStoredJson<{
        items?: Array<{ resaleListingId?: string }>;
      }>(session.cart);
      const resaleListingIds = [
        ...new Set(
          (cart.items ?? [])
            .map((item) => item.resaleListingId)
            .filter((listingId): listingId is string => Boolean(listingId)),
        ),
      ];
      if (resaleListingIds.length > 0) {
        await trx
          .updateTable('ticket_listings')
          .set({
            reserved_checkout_session_id: null,
            reserved_until: null,
            updated_at: now,
          })
          .where('tenant_id', '=', session.tenant_id)
          .where('id', 'in', resaleListingIds)
          .where('reserved_checkout_session_id', '=', checkoutSessionId)
          .where('status', '=', 'listed')
          .execute();
      }
    }

    await trx
      .updateTable('checkout_holds')
      .set({ status: 'released', updated_at: now })
      .where('checkout_session_id', '=', checkoutSessionId)
      .where('status', '=', 'active')
      .execute();

    await releasePendingDiscountReservation(trx, checkoutSessionId, now);

    await trx
      .updateTable('checkout_sessions')
      .set({ status: 'expired', updated_at: now })
      .where('id', '=', checkoutSessionId)
      .where('status', '!=', 'completed')
      .execute();
  });
}

async function createOrLoadPaymentCompensation(input: {
  repo: PaymentCompensationRepository;
  tenantId: string;
  checkoutSessionId: string;
  paymentIntentId?: string | null;
  provider: string;
  providerIntentId: string;
  amountCents: number;
  currency: string;
  action: OrphanPaymentCompensationAction;
  reason: string;
  metadata: Record<string, unknown>;
}): Promise<PaymentCompensationRow> {
  const existing = await input.repo.findByProviderIntent(
    input.provider,
    input.providerIntentId,
    input.checkoutSessionId,
  );
  if (existing) return existing;

  try {
    return await input.repo.create({
      tenantId: input.tenantId,
      checkoutSessionId: input.checkoutSessionId,
      paymentIntentId: input.paymentIntentId,
      provider: input.provider,
      providerIntentId: input.providerIntentId,
      amountCents: input.amountCents,
      currency: input.currency,
      action: input.action,
      status: 'pending',
      reason: input.reason,
      metadata: input.metadata,
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const replayed = await input.repo.findByProviderIntent(
      input.provider,
      input.providerIntentId,
      input.checkoutSessionId,
    );
    if (!replayed) throw err;
    return replayed;
  }
}

async function completePaymentCompensation(input: {
  repo: PaymentCompensationRepository;
  compensation: PaymentCompensationRow;
  action: OrphanPaymentCompensationAction;
  status: OrphanPaymentCompensationStatus;
  providerCompensationId?: string | null;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<PaymentCompensationRow> {
  return input.repo.update(input.compensation.id, {
    action: input.action,
    status: input.status,
    provider_compensation_id: input.providerCompensationId ?? null,
    attempts: Number(input.compensation.attempts) + 1,
    last_error: input.lastError ?? null,
    metadata: JSON.stringify(input.metadata ?? {}),
  });
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

async function pointCheckoutSessionAtPaymentIntent(
  db: Database,
  checkoutSessionId: string,
  paymentIntentId: string,
): Promise<boolean> {
  const result = await db
    .updateTable('checkout_sessions')
    .set({
      payment_intent_id: paymentIntentId,
      status: 'pending_payment',
      updated_at: new Date(),
    })
    .where('id', '=', checkoutSessionId)
    .where('status', 'in', ['open', 'pending_payment'])
    .where((eb) =>
      eb.or([eb('payment_intent_id', 'is', null), eb('payment_intent_id', '=', paymentIntentId)]),
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
  return (
    session?.payment_intent_id === paymentIntentId &&
    ['open', 'pending_payment'].includes(session.status)
  );
}

function validateHeldCartItems(input: {
  cartItems: { ticketTypeId?: string; productId?: string; quantity: number }[];
  holds: CheckoutHoldRow[];
  now: Date;
}): { ok: true } | { ok: false; expiredHoldIds: string[]; message: string } {
  const expectedByTicketType = new Map<string, number>();
  for (const item of input.cartItems) {
    if (!item.ticketTypeId) continue;
    expectedByTicketType.set(
      item.ticketTypeId,
      (expectedByTicketType.get(item.ticketTypeId) ?? 0) + item.quantity,
    );
  }

  const heldByTicketType = new Map<string, number>();
  const expiredHoldIds: string[] = [];
  for (const hold of input.holds) {
    if (new Date(hold.expires_at) <= input.now) {
      expiredHoldIds.push(hold.id);
      continue;
    }
    heldByTicketType.set(
      hold.ticket_type_id,
      (heldByTicketType.get(hold.ticket_type_id) ?? 0) + Number(hold.quantity),
    );
  }

  if (expiredHoldIds.length > 0) {
    return {
      ok: false,
      expiredHoldIds,
      message: `Checkout hold ${expiredHoldIds[0]} has expired`,
    };
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
    if (
      !expectedByTicketType.has(ticketTypeId) ||
      expectedByTicketType.get(ticketTypeId) !== held
    ) {
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
  paymentMode?: 'online' | 'offline' | 'free';
  salesChannel?: SalesChannel;
  tenderType?: BoxOfficeTenderType;
  isTest?: boolean;
  amountCents: number;
  currency: string;
}): Promise<FinalizePaymentIntentValidationResult> {
  if (input.amountCents <= 0) return { ok: true };

  if (!input.providerIntentId) {
    const isTrustedOfflineBoxOfficeTender =
      input.paymentMode === 'offline' &&
      input.salesChannel === 'box_office' &&
      (input.tenderType === 'cash' || input.tenderType === 'manual_card');
    if (isTrustedOfflineBoxOfficeTender) return { ok: true };

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
    .where('checkout_session_id', '=', input.checkoutSessionId)
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

async function compensateCreatedPaymentIntentAfterAttachFailure(input: {
  checkoutSessionId: string;
  tenantId: string;
  brandId: string;
  provider: string;
  providerIntentId: string;
  paymentIntentRowId: string;
  amountCents: number;
  currency: string;
}): Promise<WorkflowActivityResult<never> | undefined> {
  const reason = `Checkout session ${input.checkoutSessionId} cannot accept payment intent ${input.paymentIntentRowId}`;
  const compensationResult = await compensateOrphanPaymentActivity({
    checkoutSessionId: input.checkoutSessionId,
    tenantId: input.tenantId,
    provider: input.provider,
    providerIntentId: input.providerIntentId,
    amountCents: input.amountCents,
    currency: input.currency,
    reason,
    source: 'checkout_payment_intent_attach_failed',
    metadata: {
      brandId: input.brandId,
      paymentIntentRowId: input.paymentIntentRowId,
    },
  });

  if (compensationResult.ok) {
    if (['succeeded', 'already_ordered'].includes(compensationResult.value.status)) {
      return undefined;
    }

    return errResult(
      'PAYMENT_INTENT_COMPENSATION_BLOCKED',
      `Created payment intent ${input.providerIntentId} compensation blocked with status ${compensationResult.value.status}`,
      false,
    );
  }

  return errResult(
    'PAYMENT_INTENT_COMPENSATION_FAILED',
    `Created payment intent ${input.providerIntentId} could not be compensated after checkout session attachment failed: ${compensationResult.message}`,
    compensationResult.retryable,
  );
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
}): Promise<
  WorkflowActivityResult<{
    providerIntentId: string;
    clientSecret?: string;
    provider?: string;
  }>
> {
  const db = getActivityDb();
  try {
    const stripeSecretKey =
      process.env.TIXKIT_RUNTIME_MODE === 'sandbox' ? undefined : process.env.STRIPE_SECRET_KEY;
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

      const attached = await pointCheckoutSessionAtPaymentIntent(
        db,
        input.checkoutSessionId,
        createdPaymentIntent.id,
      );
      if (!attached) {
        const compensationError = await compensateCreatedPaymentIntentAfterAttachFailure({
          checkoutSessionId: input.checkoutSessionId,
          tenantId: input.tenantId,
          brandId: input.brandId,
          provider,
          providerIntentId,
          paymentIntentRowId: createdPaymentIntent.id,
          amountCents: input.amountCents,
          currency: input.currency,
        });
        if (compensationError) return compensationError;

        return errResult(
          'CHECKOUT_SESSION_NOT_PAYABLE',
          `Checkout session ${input.checkoutSessionId} cannot accept payment intent ${createdPaymentIntent.id}`,
          false,
        );
      }

      return okResult({ providerIntentId, clientSecret, provider });
    }

    const stripe = new StripeSdkGateway(stripeSecretKey);

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

      if (
        paymentAccount &&
        paymentAccount.status === 'active' &&
        paymentAccount.provider === 'stripe_connect'
      ) {
        connectedAccountId = paymentAccount.provider_account_id;
        paymentAccountId = paymentAccount.id;
      }
    }

    // Use a Stripe Connect destination charge: create the PaymentIntent on the
    // platform account and route funds to the connected account via
    // transfer_data. Do not also pass stripeAccount, which would create a
    // direct charge and conflict with transfer_data/application_fee_amount.
    const paymentIntent = await stripe.createPaymentIntent({
      amount: input.amountCents,
      currency: input.currency,
      description: input.description,
      metadata: {
        checkoutSessionId: input.checkoutSessionId,
        tenantId: input.tenantId,
        brandId: input.brandId,
      },
      connectedAccountId,
      applicationFeeAmount: input.feeCents,
      idempotencyKey: input.checkoutSessionId,
    });

    const piRepo = new PaymentIntentRepository(db);
    const provider = connectedAccountId ? 'stripe_connect' : 'stripe';
    const clientSecret = paymentIntent.clientSecret;
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
          metadata: {
            checkoutSessionId: input.checkoutSessionId,
            tenantId: input.tenantId,
            brandId: input.brandId,
          },
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

    const attached = await pointCheckoutSessionAtPaymentIntent(
      db,
      input.checkoutSessionId,
      createdPaymentIntent.id,
    );
    if (!attached) {
      const compensationError = await compensateCreatedPaymentIntentAfterAttachFailure({
        checkoutSessionId: input.checkoutSessionId,
        tenantId: input.tenantId,
        brandId: input.brandId,
        provider,
        providerIntentId: paymentIntent.id,
        paymentIntentRowId: createdPaymentIntent.id,
        amountCents: input.amountCents,
        currency: input.currency,
      });
      if (compensationError) return compensationError;

      return errResult(
        'CHECKOUT_SESSION_NOT_PAYABLE',
        `Checkout session ${input.checkoutSessionId} cannot accept payment intent ${createdPaymentIntent.id}`,
        false,
      );
    }

    return okResult({
      providerIntentId: paymentIntent.id,
      clientSecret,
      provider,
    });
  } catch (err) {
    if (err instanceof ProviderOperationError) {
      if (err.retryable) throw err.forRetry();
      return errResult('PAYMENT_INTENT_PROVIDER_REJECTED', err.message, false);
    }
    return errResult(
      'PAYMENT_INTENT_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function compensateOrphanPaymentActivity(input: {
  checkoutSessionId: string;
  tenantId: string;
  provider?: string;
  providerIntentId?: string;
  amountCents?: number;
  currency?: string;
  reason: string;
  providerEventId?: string;
  eventType?: string;
  providerStatus?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<
  WorkflowActivityResult<{
    status: OrphanPaymentCompensationStatus;
    action: OrphanPaymentCompensationAction;
    compensationId?: string;
    providerCompensationId?: string;
  }>
> {
  const db = getActivityDb();
  let compensationRepo: PaymentCompensationRepository | undefined;
  let compensation: PaymentCompensationRow | undefined;
  let attemptedAction: OrphanPaymentCompensationAction = 'refund';
  let compensationMetadata: Record<string, unknown> = {};
  let providerCompensationCompleted = false;
  try {
    const piRepo = new PaymentIntentRepository(db);
    compensationRepo = new PaymentCompensationRepository(db);
    const paymentIntentLookup = await findCompensablePaymentIntent({
      repo: piRepo,
      checkoutSessionId: input.checkoutSessionId,
      provider: input.provider,
      providerIntentId: input.providerIntentId,
    });
    if (paymentIntentLookup.mismatchMessage) {
      return errResult(
        'PAYMENT_COMPENSATION_UNTRUSTED',
        paymentIntentLookup.mismatchMessage,
        false,
      );
    }
    const paymentIntent = paymentIntentLookup.paymentIntent;

    const existingOrder = await db
      .selectFrom('orders')
      .select(['id'])
      .where('checkout_session_id', '=', input.checkoutSessionId)
      .executeTakeFirst();
    if (paymentIntent?.order_id || existingOrder) {
      return okResult({ status: 'already_ordered', action: 'local_noop' });
    }

    const session = await db
      .selectFrom('checkout_sessions')
      .select(['id', 'tenant_id', 'currency'])
      .where('id', '=', input.checkoutSessionId)
      .executeTakeFirst();
    if (!session) {
      return errResult(
        'PAYMENT_COMPENSATION_UNTRUSTED',
        'Payment compensation checkout session was not found',
        false,
      );
    }

    if (session.tenant_id !== input.tenantId) {
      return errResult(
        'PAYMENT_COMPENSATION_TENANT_MISMATCH',
        'Checkout session tenant does not match compensation tenant',
        false,
      );
    }
    if (paymentIntent && paymentIntent.tenant_id !== session.tenant_id) {
      return errResult(
        'PAYMENT_COMPENSATION_TENANT_MISMATCH',
        'Payment intent tenant does not match checkout session tenant',
        false,
      );
    }
    const tenantId = session.tenant_id;

    const provider = paymentIntent?.provider ?? input.provider;
    const providerIntentId = paymentIntent?.provider_intent_id ?? input.providerIntentId;
    if (!provider || !providerIntentId) {
      return errResult(
        'PAYMENT_COMPENSATION_UNTRUSTED',
        'Provider and provider intent are required',
        false,
      );
    }

    const amountCents = Number(paymentIntent?.amount_cents ?? input.amountCents ?? 0);
    const currency = String(
      paymentIntent?.currency ?? input.currency ?? session?.currency ?? 'USD',
    ).toUpperCase();
    const initialAction: OrphanPaymentCompensationAction =
      provider === 'stripe_capture' ? 'local_noop' : 'refund';
    const metadata = providerIntentMetadata({
      reason: input.reason,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      providerStatus: input.providerStatus ?? paymentIntent?.status,
      source: input.source,
      metadata: input.metadata,
    });
    compensationMetadata = metadata;
    compensation = await createOrLoadPaymentCompensation({
      repo: compensationRepo,
      tenantId,
      checkoutSessionId: input.checkoutSessionId,
      paymentIntentId: paymentIntent?.id,
      provider,
      providerIntentId,
      amountCents,
      currency,
      action: initialAction,
      reason: input.reason,
      metadata,
    });

    if (compensation.status === 'succeeded') {
      providerCompensationCompleted = true;
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return okResult({
        status: 'succeeded',
        action: compensation.action as OrphanPaymentCompensationAction,
        compensationId: compensation.id,
        providerCompensationId: compensation.provider_compensation_id ?? undefined,
      });
    }
    if (compensation.status === 'manual_review') {
      return okResult({
        status: 'manual_review',
        action: compensation.action as OrphanPaymentCompensationAction,
        compensationId: compensation.id,
        providerCompensationId: compensation.provider_compensation_id ?? undefined,
      });
    }

    if (provider === 'stripe_capture') {
      attemptedAction = 'local_noop';
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'local_noop',
        status: 'succeeded',
        providerCompensationId: `local:${providerIntentId}`,
        metadata,
      });
      compensation = updated;
      providerCompensationCompleted = true;
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return okResult({
        status: 'succeeded',
        action: 'local_noop',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    if (!isStripePaymentProvider(provider)) {
      attemptedAction = 'local_noop';
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'local_noop',
        status: 'manual_review',
        lastError: `Unsupported payment provider ${provider}`,
        metadata,
      });
      return okResult({
        status: 'manual_review',
        action: 'local_noop',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    const stripeSecretKey =
      process.env.TIXKIT_RUNTIME_MODE === 'sandbox' ? undefined : process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      attemptedAction = 'refund';
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'refund',
        status: 'manual_review',
        lastError: 'Stripe secret key is not configured',
        metadata,
      });
      return okResult({
        status: 'manual_review',
        action: 'refund',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    const stripe = new StripeSdkGateway(stripeSecretKey);
    const stripePaymentIntent = await stripe.retrievePaymentIntent(providerIntentId);

    if (paymentIntent) {
      await piRepo.update(paymentIntent.id, {
        status: stripePaymentIntent.status,
      });
    }

    if (stripePaymentIntent.status === 'succeeded') {
      attemptedAction = 'refund';
      const refundAmount =
        amountCents > 0
          ? amountCents
          : stripePaymentIntent.amountReceived || stripePaymentIntent.amount;
      const idempotencyKey = stripeCompensationIdempotencyKey({
        action: 'refund',
        provider,
        providerIntentId,
        checkoutSessionId: input.checkoutSessionId,
      });
      const refund = await stripe.createRefund({
        ...stripeOrphanRefundParams({
          provider,
          providerIntentId,
          amount: refundAmount,
        }),
        idempotencyKey,
      });
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'refund',
        status: 'succeeded',
        providerCompensationId: refund.id,
        metadata: {
          ...metadata,
          stripeIdempotencyKey: idempotencyKey,
          stripePaymentIntentStatus: stripePaymentIntent.status,
        },
      });
      compensation = updated;
      providerCompensationCompleted = true;
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return okResult({
        status: 'succeeded',
        action: 'refund',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    if (stripePaymentIntent.status === 'canceled') {
      attemptedAction = 'cancel';
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'cancel',
        status: 'succeeded',
        providerCompensationId: providerIntentId,
        metadata: {
          ...metadata,
          stripePaymentIntentStatus: stripePaymentIntent.status,
        },
      });
      compensation = updated;
      providerCompensationCompleted = true;
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return okResult({
        status: 'succeeded',
        action: 'cancel',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    if (stripePaymentIntentIsCancelable(stripePaymentIntent.status)) {
      attemptedAction = 'cancel';
      const idempotencyKey = stripeCompensationIdempotencyKey({
        action: 'cancel',
        provider,
        providerIntentId,
        checkoutSessionId: input.checkoutSessionId,
      });
      const cancelled = await stripe.cancelPaymentIntent(providerIntentId, idempotencyKey);
      const updated = await completePaymentCompensation({
        repo: compensationRepo,
        compensation,
        action: 'cancel',
        status: 'succeeded',
        providerCompensationId: cancelled.id,
        metadata: {
          ...metadata,
          stripeIdempotencyKey: idempotencyKey,
          stripePaymentIntentStatus: stripePaymentIntent.status,
        },
      });
      compensation = updated;
      providerCompensationCompleted = true;
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return okResult({
        status: 'succeeded',
        action: 'cancel',
        compensationId: updated.id,
        providerCompensationId: updated.provider_compensation_id ?? undefined,
      });
    }

    const updated = await completePaymentCompensation({
      repo: compensationRepo,
      compensation,
      action: 'refund',
      status: 'manual_review',
      lastError: `Stripe payment intent status ${stripePaymentIntent.status} is not automatically compensable`,
      metadata: {
        ...metadata,
        stripePaymentIntentStatus: stripePaymentIntent.status,
      },
    });
    return okResult({
      status: 'manual_review',
      action: 'refund',
      compensationId: updated.id,
      providerCompensationId: updated.provider_compensation_id ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (compensationRepo && compensation && !providerCompensationCompleted) {
      try {
        await completePaymentCompensation({
          repo: compensationRepo,
          compensation,
          action: attemptedAction,
          status: 'failed',
          lastError: message,
          metadata: compensationMetadata,
        });
      } catch {
        // Preserve the provider error as the activity failure; a retry can repair the compensation row.
      }
    }
    if (err instanceof ProviderOperationError) {
      if (err.retryable) throw err.forRetry();
      return errResult('PAYMENT_COMPENSATION_PROVIDER_REJECTED', err.message, false);
    }
    return errResult('PAYMENT_COMPENSATION_FAILED', message, true);
  }
}
// Activity: Finalize order - creates order, attendees, and tickets
export async function finalizeOrderActivity(input: {
  checkoutSessionId: string;
  tenantId: string;
  paymentIntentId?: string;
  paymentMode?: 'online' | 'offline' | 'free';
  affiliateCode?: string;
  salesChannel?: SalesChannel;
  operatorId?: string;
  tenderType?: BoxOfficeTenderType;
  isTest?: boolean;
}): Promise<WorkflowActivityResult<{ orderId: string }>> {
  const db = getActivityDb();
  try {
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
        type?: 'ticket' | 'product' | 'resale';
        ticketTypeId?: string;
        productId?: string;
        resaleListingId?: string;
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
        resaleListingId?: string;
        quantity: number;
        attendeeFields?: Record<string, unknown>[];
      }[];
      buyerFields?: Record<string, unknown>;
      attendeeFields?: Record<string, unknown[]>;
      discountCode?: string;
      accessRuleRedemptions?: Array<{
        accessRuleId?: string;
        ticketTypeId?: string;
      }>;
      waitlistEntryId?: string;
    }>(session.cart);
    const buyer = parseStoredJson<{
      email?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      dateOfBirth?: string;
    }>(session.buyer);

    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', session.event_id)
      .executeTakeFirstOrThrow();
    if (input.tenantId !== session.tenant_id || event.tenant_id !== session.tenant_id) {
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return errResult('TENANT_SCOPE_MISMATCH', 'Checkout tenant scope does not match', false);
    }
    const sessionIsTest = Boolean(session.is_test);
    if (Boolean(input.isTest) !== sessionIsTest) {
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return errResult('TEST_ORDER_MISMATCH', 'Checkout test-mode state does not match', false);
    }
    // Idempotency is evaluated only after validating the authoritative session
    // scope. This prevents a retry with mismatched tenant/test-mode input from
    // learning or accepting an order created in another scope.
    const existingOrder = await db
      .selectFrom('orders')
      .select(['id', 'tenant_id', 'is_test'])
      .where('checkout_session_id', '=', input.checkoutSessionId)
      .executeTakeFirst();
    if (existingOrder) {
      if (
        existingOrder.tenant_id !== session.tenant_id ||
        Boolean(existingOrder.is_test) !== sessionIsTest
      ) {
        return errResult(
          'ORDER_SCOPE_MISMATCH',
          'Existing order scope does not match checkout',
          false,
        );
      }
      return okResult({ orderId: existingOrder.id });
    }
    if (sessionIsTest) {
      const orderId = `ord_${ulid()}`;
      const now = new Date();
      await db.transaction().execute(async (trx) => {
        const holds = await trx
          .selectFrom('checkout_holds')
          .select(['id', 'inventory_pool_id', 'quantity'])
          .where('checkout_session_id', '=', input.checkoutSessionId)
          .where('status', '=', 'active')
          .forUpdate()
          .execute();
        for (const hold of holds) {
          // eslint-disable-next-line no-await-in-loop -- test holds are released atomically in stable transaction order.
          await trx
            .updateTable('checkout_holds')
            .set({ status: 'released', updated_at: now })
            .where('id', '=', hold.id)
            .where('status', '=', 'active')
            .execute();
        }
        const resaleListingIds = [
          ...new Set(
            cart.items
              .map((item) => item.resaleListingId)
              .filter((listingId): listingId is string => Boolean(listingId)),
          ),
        ];
        if (resaleListingIds.length > 0) {
          await trx
            .updateTable('ticket_listings')
            .set({
              reserved_checkout_session_id: null,
              reserved_until: null,
              updated_at: now,
            })
            .where('tenant_id', '=', session.tenant_id)
            .where('id', 'in', resaleListingIds)
            .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
            .where('status', '=', 'listed')
            .execute();
        }
        if (cart.waitlistEntryId) {
          await trx
            .updateTable('waitlist_entries')
            .set({
              status: 'offered',
              reserved_checkout_session_id: null,
              reserved_until: null,
              updated_at: now,
            })
            .where('id', '=', cart.waitlistEntryId)
            .where('tenant_id', '=', session.tenant_id)
            .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
            .where('status', '=', 'reserved')
            .execute();
        }
        await releasePendingDiscountReservation(trx, input.checkoutSessionId, now);
        await trx
          .insertInto('orders')
          .values({
            id: orderId,
            tenant_id: session.tenant_id,
            organization_id: event.organization_id,
            brand_id: session.brand_id,
            event_id: session.event_id,
            checkout_session_id: input.checkoutSessionId,
            order_number: `TEST-${orderId.replace(/^ord_/, '').toUpperCase()}`,
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
            buyer_date_of_birth: buyer.dateOfBirth ?? null,
            payment_intent_id: null,
            payment_provider: null,
            sales_channel: input.salesChannel ?? 'online',
            operator_id: input.operatorId ?? null,
            tender_type: input.tenderType ?? null,
            is_test: true,
            paid_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await trx
          .updateTable('checkout_sessions')
          .set({ status: 'completed', order_id: orderId, updated_at: now })
          .where('id', '=', input.checkoutSessionId)
          .execute();
        await trx
          .insertInto('order_timeline_events')
          .values({
            id: `ote_${ulid()}`,
            order_id: orderId,
            type: 'order.test_completed',
            description: 'Test checkout completed without payment or fulfillment',
            metadata: null,
            actor_id: input.operatorId ?? null,
            created_at: now,
          })
          .execute();
      });
      return okResult({ orderId });
    }
    if (event.status !== 'published') {
      await releaseOrphanCheckoutResources(db, input.checkoutSessionId);
      return errResult('EVENT_NOT_AVAILABLE', 'Event is not available for checkout', false);
    }
    const paymentIntentValidation = await validateFinalizePaymentIntent({
      db,
      checkoutSessionId: input.checkoutSessionId,
      tenantId: input.tenantId,
      providerIntentId: input.paymentIntentId,
      paymentMode: input.paymentMode,
      salesChannel: input.salesChannel,
      tenderType: input.tenderType,
      amountCents: quote.totalCents,
      currency: session.currency,
    });
    if (!paymentIntentValidation.ok) {
      return errResult(
        paymentIntentValidation.errorCode,
        paymentIntentValidation.message,
        paymentIntentValidation.retryable,
      );
    }
    const paymentIntent = paymentIntentValidation.paymentIntent;

    const orderId = `ord_${ulid()}`;
    const now = new Date();

    const consentQuestions = await db
      .selectFrom('questions')
      .select([
        'id',
        'applies_to',
        'ticket_type_id',
        'label',
        'is_consent_field',
        'consent_text',
        'consent_version',
      ])
      .where('event_id', '=', session.event_id)
      .where('is_consent_field', '=', true)
      .execute();

    const finalizeResult = await db
      .transaction()
      .execute(async (trx): Promise<FinalizeTransactionResult> => {
        const candidateHolds = (await trx
          .selectFrom('checkout_holds')
          .selectAll()
          .where('checkout_session_id', '=', input.checkoutSessionId)
          .where('status', '=', 'active')
          .execute()) as CheckoutHoldRow[];
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

        const holds = (await trx
          .selectFrom('checkout_holds')
          .selectAll()
          .where('checkout_session_id', '=', input.checkoutSessionId)
          .where('status', '=', 'active')
          .forUpdate()
          .execute()) as CheckoutHoldRow[];

        const heldCart = validateHeldCartItems({
          cartItems: cart.items,
          holds,
          now,
        });
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
          await trx
            .updateTable('checkout_sessions')
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

        const resaleListingIds = cart.items
          .map((item) => item.resaleListingId)
          .filter((listingId): listingId is string => Boolean(listingId));
        if (new Set(resaleListingIds).size !== resaleListingIds.length) {
          return {
            ok: false,
            errorCode: 'RESALE_LISTING_DUPLICATE',
            message: 'Checkout session contains duplicate resale listings',
            retryable: false,
          };
        }
        const resaleFulfillments: Array<{
          listing: {
            id: string;
            tenant_id: string;
            event_id: string;
            ticket_id: string;
            seller_id: string;
            status: string;
            expires_at: Date | string | null;
            reserved_checkout_session_id: string | null;
            reserved_until: Date | string | null;
          };
          sellerTicket: {
            id: string;
            tenant_id: string;
            order_id: string;
            attendee_id: string;
            event_id: string;
            event_occurrence_id: string | null;
            ticket_type_id: string;
            status: string;
          };
        }> = [];
        /* eslint-disable no-await-in-loop -- resale listing locks must be acquired and validated in order within the transaction. */
        for (const resaleListingId of resaleListingIds) {
          const listing = await trx
            .selectFrom('ticket_listings')
            .select([
              'id',
              'tenant_id',
              'event_id',
              'ticket_id',
              'seller_id',
              'status',
              'expires_at',
              'reserved_checkout_session_id',
              'reserved_until',
            ])
            .where('id', '=', resaleListingId)
            .where('tenant_id', '=', input.tenantId)
            .where('event_id', '=', session.event_id)
            .forUpdate()
            .executeTakeFirst();
          if (!listing || listing.status !== 'listed') {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_UNAVAILABLE',
              message: `Ticket listing ${resaleListingId} is not listed`,
              retryable: false,
            };
          }
          if (listing.expires_at && new Date(listing.expires_at) <= now) {
            await trx
              .updateTable('ticket_listings')
              .set({
                status: 'expired',
                active_listing_key: resaleListingId,
                reserved_checkout_session_id: null,
                reserved_until: null,
                updated_at: now,
              })
              .where('id', '=', resaleListingId)
              .execute();
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_EXPIRED',
              message: `Ticket listing ${resaleListingId} has expired`,
              retryable: false,
            };
          }
          if (
            listing.reserved_checkout_session_id !== input.checkoutSessionId ||
            !listing.reserved_until ||
            new Date(listing.reserved_until) <= now
          ) {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_RESERVATION_EXPIRED',
              message: `Ticket listing ${resaleListingId} reservation has expired`,
              retryable: false,
            };
          }

          const sellerTicket = await trx
            .selectFrom('tickets')
            .select([
              'id',
              'tenant_id',
              'order_id',
              'attendee_id',
              'event_id',
              'event_occurrence_id',
              'ticket_type_id',
              'status',
            ])
            .where('id', '=', listing.ticket_id)
            .where('tenant_id', '=', input.tenantId)
            .forUpdate()
            .executeTakeFirst();
          if (!sellerTicket || sellerTicket.event_id !== session.event_id) {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_INVALID_TICKET',
              message: `Ticket listing ${resaleListingId} is not attached to a valid ticket`,
              retryable: false,
            };
          }
          if (sellerTicket.status !== 'valid') {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_INVALID_TICKET',
              message: `Ticket status is ${sellerTicket.status}, cannot complete resale`,
              retryable: false,
            };
          }
          resaleFulfillments.push({ listing, sellerTicket });
        }
        /* eslint-enable no-await-in-loop */

        const accessRuleRedemptions = [
          ...new Map(
            (cart.accessRuleRedemptions ?? [])
              .filter(
                (
                  redemption,
                ): redemption is {
                  accessRuleId: string;
                  ticketTypeId: string;
                } => Boolean(redemption.accessRuleId) && Boolean(redemption.ticketTypeId),
              )
              .map((redemption) => [redemption.accessRuleId, redemption]),
          ).values(),
          // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh array gives deterministic lock order without mutating shared input.
        ].sort((left, right) => left.accessRuleId.localeCompare(right.accessRuleId));

        /* eslint-disable no-await-in-loop -- access rule rows are locked in deterministic order to enforce limited-use caps. */
        for (const redemption of accessRuleRedemptions) {
          const accessRule = await trx
            .selectFrom('access_rules')
            .selectAll()
            .where('id', '=', redemption.accessRuleId)
            .forUpdate()
            .executeTakeFirst();

          if (!accessRule || accessRule.ticket_type_id !== redemption.ticketTypeId) {
            return {
              ok: false,
              errorCode: 'ACCESS_RULE_INVALID',
              message: `Access rule ${redemption.accessRuleId} is not valid for this checkout`,
              retryable: false,
            };
          }

          const ticketType = await trx
            .selectFrom('ticket_types')
            .select(['id'])
            .where('id', '=', accessRule.ticket_type_id)
            .where('event_id', '=', session.event_id)
            .executeTakeFirst();

          if (!ticketType) {
            return {
              ok: false,
              errorCode: 'ACCESS_RULE_INVALID',
              message: `Access rule ${redemption.accessRuleId} is not valid for this event`,
              retryable: false,
            };
          }

          const existingRedemption = await trx
            .selectFrom('access_rule_redemptions')
            .select(['id'])
            .where('access_rule_id', '=', accessRule.id)
            .where('checkout_session_id', '=', input.checkoutSessionId)
            .executeTakeFirst();

          if (existingRedemption) continue;

          if (accessRule.expires_at && new Date(accessRule.expires_at) < now) {
            return {
              ok: false,
              errorCode: 'ACCESS_RULE_INVALID',
              message: `Access rule ${redemption.accessRuleId} has expired`,
              retryable: false,
            };
          }
          if (
            accessRule.max_uses != null &&
            Number(accessRule.uses_count) >= Number(accessRule.max_uses)
          ) {
            return {
              ok: false,
              errorCode: 'ACCESS_RULE_EXHAUSTED',
              message: `Access rule ${redemption.accessRuleId} max uses reached`,
              retryable: false,
            };
          }

          await trx
            .updateTable('access_rules')
            .set((eb) => ({
              uses_count: eb('uses_count', '+', 1),
              updated_at: now,
            }))
            .where('id', '=', accessRule.id)
            .execute();

          await trx
            .insertInto('access_rule_redemptions')
            .values({
              id: `ared_${ulid()}`,
              access_rule_id: accessRule.id,
              ticket_type_id: accessRule.ticket_type_id,
              event_id: session.event_id,
              checkout_session_id: input.checkoutSessionId,
              order_id: orderId,
              tenant_id: input.tenantId,
              created_at: now,
            })
            .execute();
        }
        /* eslint-enable no-await-in-loop */

        // Discount capacity is reserved before payment when the checkout session
        // is created. Finalization only attaches that pending reservation to the
        // committed order; it must not consume capacity after payment.
        if (cart.discountCode && quote.discountCents > 0) {
          const canonicalDiscountCode = normalizeDiscountCode(cart.discountCode);
          const reservedRedemption = await trx
            .selectFrom('discount_redemptions')
            .select(['id', 'discount_code_id', 'order_id', 'event_id', 'tenant_id'])
            .where('checkout_session_id', '=', input.checkoutSessionId)
            .forUpdate()
            .executeTakeFirst();

          if (!reservedRedemption) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_NOT_RESERVED',
              message: `Discount code ${cart.discountCode} was not reserved before payment`,
              retryable: false,
            };
          }
          const reservedDiscount = await trx
            .selectFrom('discount_codes')
            .select(['code'])
            .where('id', '=', reservedRedemption.discount_code_id)
            .executeTakeFirst();
          if (
            reservedRedemption.event_id !== session.event_id ||
            reservedRedemption.tenant_id !== input.tenantId ||
            !reservedDiscount ||
            normalizeDiscountCode(String(reservedDiscount.code)) !== canonicalDiscountCode
          ) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_INVALID',
              message: `Discount code ${cart.discountCode} reservation is not valid for this checkout`,
              retryable: false,
            };
          }
          if (reservedRedemption.order_id && reservedRedemption.order_id !== orderId) {
            return {
              ok: false,
              errorCode: 'DISCOUNT_INVALID',
              message: `Discount code ${cart.discountCode} reservation is already attached to an order`,
              retryable: false,
            };
          }
          if (!reservedRedemption.order_id) {
            await trx
              .updateTable('discount_redemptions')
              .set({
                order_id: orderId,
              })
              .where('id', '=', reservedRedemption.id)
              .where('order_id', 'is', null)
              .execute();
          }
        }

        if (cart.waitlistEntryId) {
          const waitlistClaim = await trx
            .updateTable('waitlist_entries')
            .set({
              status: 'claimed',
              reserved_checkout_session_id: null,
              reserved_until: null,
              claimed_at: now,
              updated_at: now,
            })
            .where('id', '=', cart.waitlistEntryId)
            .where('tenant_id', '=', input.tenantId)
            .where('event_id', '=', session.event_id)
            .where('status', '=', 'reserved')
            .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
            .executeTakeFirst();
          const changedRows = Number(
            (waitlistClaim as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0,
          );
          if (changedRows === 0) {
            throw new WaitlistOfferUnavailableError();
          }
        }

        // Create order
        const [brand, organization] = await Promise.all([
          trx
            .selectFrom('brands')
            .select(['name'])
            .where('id', '=', session.brand_id)
            .executeTakeFirst(),
          trx
            .selectFrom('organizations')
            .select(['name'])
            .where('id', '=', event.organization_id)
            .executeTakeFirst(),
        ]);
        await trx
          .insertInto('orders')
          .values({
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
            buyer_date_of_birth: buyer.dateOfBirth ?? null,
            payment_intent_id: paymentIntent?.id ?? null,
            payment_provider: paymentIntent?.provider ?? null,
            sales_channel: input.salesChannel ?? 'online',
            operator_id: input.operatorId ?? null,
            tender_type: input.tenderType ?? null,
            is_test: input.isTest ?? false,
            paid_at: now,
            created_at: now,
            updated_at: now,
          })
          .execute();

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
            .set((eb) => ({
              sold_count: eb('sold_count', '+', hold.quantity),
              updated_at: now,
            }))
            .where('id', '=', hold.inventory_pool_id)
            .execute();
        }

        for (const line of quote.lineItems ?? []) {
          const lineItemId = `oli_${ulid()}`;
          // eslint-disable-next-line no-await-in-loop -- order line items are inserted serially within the order finalization transaction.
          await trx
            .insertInto('order_line_items')
            .values({
              id: lineItemId,
              order_id: orderId,
              ticket_type_id: line.ticketTypeId ?? null,
              event_occurrence_id: line.eventOccurrenceId ?? null,
              product_id: line.productId ?? null,
              resale_listing_id: line.resaleListingId ?? null,
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
            })
            .execute();

          for (const tax of line.taxBreakdown ?? []) {
            if (tax.taxCents === 0 && tax.taxableAmountCents === 0) continue;
            // eslint-disable-next-line no-await-in-loop -- snapshots must be tied to the just-created line item.
            await trx
              .insertInto('order_tax_snapshots')
              .values({
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
              })
              .execute();
          }
        }

        /* eslint-disable no-await-in-loop -- resale fulfillment mutates buyer, seller, listing, and timeline rows in a fixed transaction order. */
        for (const fulfillment of resaleFulfillments) {
          const buyerAttendeeId = `att_${ulid()}`;
          await trx
            .insertInto('attendees')
            .values({
              id: buyerAttendeeId,
              tenant_id: input.tenantId,
              order_id: orderId,
              event_id: fulfillment.sellerTicket.event_id,
              ticket_type_id: fulfillment.sellerTicket.ticket_type_id,
              event_occurrence_id: fulfillment.sellerTicket.event_occurrence_id ?? null,
              ticket_id: null,
              first_name: buyer.firstName ?? null,
              last_name: buyer.lastName ?? null,
              email: buyer.email ?? '',
              phone: buyer.phone ?? null,
              date_of_birth: buyer.dateOfBirth ?? null,
              status: 'confirmed',
              custom_answers: JSON.stringify({
                resaleListingId: fulfillment.listing.id,
                resaleSellerOrderId: fulfillment.sellerTicket.order_id,
                resaleSellerTicketId: fulfillment.sellerTicket.id,
                checkoutSessionId: input.checkoutSessionId,
              }),
              checked_in_at: null,
              check_in_device_id: null,
              created_at: now,
              updated_at: now,
            })
            .execute();

          const buyerTicketId = `tkt_${ulid()}`;
          const qr = new QrService().generate(buyerTicketId);
          await trx
            .insertInto('tickets')
            .values({
              id: buyerTicketId,
              tenant_id: input.tenantId,
              order_id: orderId,
              attendee_id: buyerAttendeeId,
              event_id: fulfillment.sellerTicket.event_id,
              ticket_type_id: fulfillment.sellerTicket.ticket_type_id,
              event_occurrence_id: fulfillment.sellerTicket.event_occurrence_id ?? null,
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
            })
            .execute();

          await trx
            .updateTable('attendees')
            .set({ ticket_id: buyerTicketId, updated_at: now })
            .where('id', '=', buyerAttendeeId)
            .execute();

          const sellerTransfer = await trx
            .updateTable('tickets')
            .set({
              status: 'transferred',
              transferred_to_email: buyer.email ?? '',
              transferred_at: now,
              updated_at: now,
            })
            .where('id', '=', fulfillment.sellerTicket.id)
            .where('status', '=', 'valid')
            .executeTakeFirst();
          if (Number(sellerTransfer.numUpdatedRows ?? 0) !== 1) {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_INVALID_TICKET',
              message: `Ticket status changed before resale completion`,
              retryable: true,
            };
          }

          await trx
            .updateTable('wallet_passes')
            .set({ status: 'revoked', revoked_at: now, updated_at: now })
            .where('ticket_id', '=', fulfillment.sellerTicket.id)
            .where('status', '=', 'active')
            .execute();

          const soldListing = await trx
            .updateTable('ticket_listings')
            .set({
              status: 'sold',
              sold_to_id: orderId,
              sold_at: now,
              active_listing_key: fulfillment.listing.id,
              reserved_checkout_session_id: null,
              reserved_until: null,
              updated_at: now,
            })
            .where('id', '=', fulfillment.listing.id)
            .where('status', '=', 'listed')
            .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
            .executeTakeFirst();
          if (Number(soldListing.numUpdatedRows ?? 0) !== 1) {
            return {
              ok: false,
              errorCode: 'RESALE_LISTING_UNAVAILABLE',
              message: `Ticket listing ${fulfillment.listing.id} could not be sold`,
              retryable: true,
            };
          }

          await trx
            .insertInto('order_timeline_events')
            .values({
              id: `ote_${ulid()}`,
              order_id: orderId,
              type: 'ticket.resale_purchased',
              description: `Resale ticket ${buyerTicketId} issued`,
              metadata: JSON.stringify({
                listingId: fulfillment.listing.id,
                sellerOrderId: fulfillment.sellerTicket.order_id,
                sellerTicketId: fulfillment.sellerTicket.id,
                buyerTicketId,
                buyerAttendeeId,
              }),
              actor_id: null,
              created_at: now,
            })
            .execute();
          await trx
            .insertInto('order_timeline_events')
            .values({
              id: `ote_${ulid()}`,
              order_id: fulfillment.sellerTicket.order_id,
              type: 'ticket.resale_completed',
              description: `Ticket ${fulfillment.sellerTicket.id} resold to ${buyer.email ?? 'buyer'}`,
              metadata: JSON.stringify({
                listingId: fulfillment.listing.id,
                buyerOrderId: orderId,
                buyerTicketId,
                buyerAttendeeId,
              }),
              actor_id: null,
              created_at: now,
            })
            .execute();
        }
        /* eslint-enable no-await-in-loop */

        const buyerFields =
          cart.buyerFields && typeof cart.buyerFields === 'object'
            ? (cart.buyerFields as Record<string, unknown>)
            : {};
        const buyerTaxId =
          typeof buyerFields.taxId === 'string'
            ? buyerFields.taxId
            : typeof buyerFields.vatId === 'string'
              ? buyerFields.vatId
              : undefined;
        const sellerName = brand?.name ?? organization?.name ?? 'Tixkit';
        await trx
          .insertInto('invoices')
          .values({
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
          })
          .execute();

        // Create attendees and tickets with canonical signed QR payloads.
        const qrService = new QrService();
        for (const item of cart.items) {
          if (!item.ticketTypeId) continue;
          const itemAttendeeFields =
            item.attendeeFields ?? cart.attendeeFields?.[item.ticketTypeId] ?? [];
          for (let i = 0; i < item.quantity; i++) {
            const attendeeFields = (itemAttendeeFields[i] ?? {}) as Record<string, unknown>;
            const { firstName, lastName, email, phone, dateOfBirth, ...customAnswers } =
              attendeeFields;
            const attendeeEmail = typeof email === 'string' ? email : (buyer.email ?? '');
            const attendeePhone = typeof phone === 'string' ? phone : (buyer.phone ?? null);
            const attendeeId = `att_${ulid()}`;
            // eslint-disable-next-line no-await-in-loop -- attendee rows must exist before consent snapshots and tickets link to them.
            await trx
              .insertInto('attendees')
              .values({
                id: attendeeId,
                tenant_id: input.tenantId,
                order_id: orderId,
                event_id: session.event_id,
                ticket_type_id: item.ticketTypeId,
                event_occurrence_id: item.occurrenceId ?? null,
                ticket_id: null,
                first_name: typeof firstName === 'string' ? firstName : (buyer.firstName ?? null),
                last_name: typeof lastName === 'string' ? lastName : (buyer.lastName ?? null),
                email: attendeeEmail,
                phone: attendeePhone,
                date_of_birth: typeof dateOfBirth === 'string' ? dateOfBirth : null,
                status: 'confirmed',
                custom_answers:
                  Object.keys(customAnswers).length > 0 ? JSON.stringify(customAnswers) : null,
                checked_in_at: null,
                check_in_device_id: null,
                created_at: now,
                updated_at: now,
              })
              .execute();

            const consentAnswers = {
              ...cart.buyerFields,
              ...customAnswers,
            } as Record<string, unknown>;
            for (const question of consentQuestions) {
              const appliesToAttendee =
                question.applies_to === 'buyer' ||
                question.applies_to === 'attendee' ||
                question.applies_to === 'both';
              const ticketMatches =
                !question.ticket_type_id || question.ticket_type_id === item.ticketTypeId;
              const consentAnswer = consentAnswers[question.id];
              if (!appliesToAttendee || !ticketMatches || !isConsentAccepted(consentAnswer))
                continue;
              const snapshot = isConsentAnswerSnapshot(consentAnswer) ? consentAnswer : undefined;
              const consentEmail =
                question.applies_to === 'buyer' ? (buyer.email ?? '') : attendeeEmail;
              const consentPhone =
                question.applies_to === 'buyer' ? (buyer.phone ?? null) : attendeePhone;
              // eslint-disable-next-line no-await-in-loop -- consent snapshots are tied to the attendee being created in this loop iteration.
              await trx
                .insertInto('message_consents')
                .values({
                  id: `mc_${ulid()}`,
                  tenant_id: input.tenantId,
                  attendee_id: attendeeId,
                  email: consentEmail,
                  phone: consentPhone,
                  email_opt_in: true,
                  sms_opt_in: false,
                  consent_text: snapshot?.consentText ?? question.consent_text ?? question.label,
                  consent_version: snapshot?.consentVersion ?? question.consent_version ?? '1',
                  consented_at: snapshot?.consentedAt ? new Date(snapshot.consentedAt) : now,
                  revoked_at: null,
                  created_at: now,
                })
                .execute();
            }

            const ticketId = `tkt_${ulid()}`;
            const qr = qrService.generate(ticketId);

            // eslint-disable-next-line no-await-in-loop -- ticket issuance depends on the attendee id and generated QR payload for this iteration.
            await trx
              .insertInto('tickets')
              .values({
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
              })
              .execute();

            // Link ticket to attendee
            // eslint-disable-next-line no-await-in-loop -- attendee linkage must follow the ticket insert that generated this ticket id.
            await trx
              .updateTable('attendees')
              .set({ ticket_id: ticketId, updated_at: now })
              .where('id', '=', attendeeId)
              .execute();
          }
        }

        // Update session
        await trx
          .updateTable('checkout_sessions')
          .set({ status: 'completed', order_id: orderId, updated_at: now })
          .where('id', '=', input.checkoutSessionId)
          .execute();

        // Add timeline event
        await trx
          .insertInto('order_timeline_events')
          .values({
            id: `ote_${ulid()}`,
            order_id: orderId,
            type: 'order.paid',
            description: 'Order confirmed and paid',
            metadata: null,
            actor_id: null,
            created_at: now,
          })
          .execute();

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
            const commissionCents = Math.round(
              (quote.totalCents * affiliate.commission_percentage) / 10000,
            );
            await trx
              .insertInto('attributions')
              .values({
                id: `attr_${ulid()}`,
                order_id: orderId,
                affiliate_id: affiliate.id,
                affiliate_code: affiliate.code,
                commission_cents: commissionCents,
                attributed_at: now,
                created_at: now,
              })
              .execute();
          }
        }
        return { ok: true };
      });

    if (!finalizeResult.ok) {
      const committed = await db
        .selectFrom('orders')
        .select(['id'])
        .where('checkout_session_id', '=', input.checkoutSessionId)
        .where('tenant_id', '=', input.tenantId)
        .executeTakeFirst();
      if (committed) {
        return okResult({ orderId: committed.id });
      }
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
    if (err instanceof WaitlistOfferUnavailableError) {
      return errResult('WAITLIST_OFFER_UNAVAILABLE', err.message, false);
    }
    const retryable = isRetryableDbConcurrencyError(err);
    if (retryable) {
      throw err;
    }
    return errResult(
      'ORDER_FINALIZE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      false,
    );
  }
}

// Activity: Send confirmation email
export async function sendConfirmationEmailActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
}): Promise<WorkflowActivityResult<{ jobId?: string; status: 'queued' | 'skipped' }>> {
  const db = getActivityDb();
  try {
    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(input.orderId);
    if (!order) {
      return errResult('ORDER_NOT_FOUND', 'Order not found for confirmation email', false);
    }

    const existingJob = await db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', `order-confirmed:${input.orderId}`)
      .executeTakeFirst();
    if (existingJob) {
      await restartQueuedNotificationDeliveryWorkflow(db, existingJob);
      return okResult({ jobId: existingJob.id, status: 'queued' });
    }

    const route = await db
      .selectFrom('email_provider_routes')
      .select(['id'])
      .where('tenant_id', '=', input.tenantId)
      .where('brand_id', '=', input.brandId)
      .where('status', '=', 'active')
      .where('smoke_send_verified', '=', true)
      .orderBy('priority', 'asc')
      .executeTakeFirst();

    const publishedTemplate = await new ContentRepository(db).findPublishedEmailTemplate({
      tenantId: input.tenantId,
      brandId: input.brandId,
      eventId: order.event_id,
      key: 'order-confirmed',
    });
    if (!publishedTemplate) {
      return okResult({ status: 'skipped' });
    }
    if (!route) {
      return okResult({ status: 'skipped' });
    }

    const [event, brand] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'title', 'starts_at', 'timezone', 'venue'])
        .where('id', '=', order.event_id)
        .executeTakeFirst(),
      db
        .selectFrom('brands')
        .select(['id', 'name', 'theme'])
        .where('id', '=', input.brandId)
        .executeTakeFirst(),
    ]);
    const context = buildTransactionalMergeTagContext({ order, event, brand });

    const job = await new EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-confirmed',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
        orderNumber: order.order_number,
        orderId: input.orderId,
        eventId: order.event_id,
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      priority: 'high',
      idempotencyKey: `order-confirmed:${input.orderId}`,
    });

    await durablyStartNotificationDeliveryWorkflow(db, {
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-confirmed',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
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
    return errResult(
      'EMAIL_QUEUE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

// Activity: Release all active holds for a checkout session
export async function releaseHoldActivity(input: {
  holdId?: string;
  checkoutSessionId?: string;
  checkoutSessionStatus?: 'cancelled' | 'expired';
}): Promise<WorkflowActivityResult<{ released: boolean }>> {
  const db = getActivityDb();
  try {
    if (input.checkoutSessionStatus && !input.checkoutSessionId) {
      return errResult(
        'HOLD_RELEASE_FAILED',
        'checkoutSessionId required when updating checkout session status',
        false,
      );
    }

    const now = new Date();
    if (!input.checkoutSessionId && !input.holdId) {
      return errResult('HOLD_RELEASE_FAILED', 'holdId or checkoutSessionId required', false);
    }

    await db.transaction().execute(async (trx) => {
      if (input.checkoutSessionId) {
        const session = await trx
          .selectFrom('checkout_sessions')
          .select(['tenant_id', 'cart'])
          .where('id', '=', input.checkoutSessionId)
          .executeTakeFirst();
        if (session) {
          const cart = parseStoredJson<{
            items?: Array<{ resaleListingId?: string }>;
            waitlistEntryId?: string;
          }>(session.cart);
          const resaleListingIds = [
            ...new Set(
              (cart.items ?? [])
                .map((item) => item.resaleListingId)
                .filter((listingId): listingId is string => Boolean(listingId)),
            ),
          ];
          if (resaleListingIds.length > 0) {
            await trx
              .updateTable('ticket_listings')
              .set({
                reserved_checkout_session_id: null,
                reserved_until: null,
                updated_at: now,
              })
              .where('tenant_id', '=', session.tenant_id)
              .where('id', 'in', resaleListingIds)
              .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
              .where('status', '=', 'listed')
              .execute();
          }
          if (cart.waitlistEntryId) {
            await trx
              .updateTable('waitlist_entries')
              .set({
                status: 'offered',
                reserved_checkout_session_id: null,
                reserved_until: null,
                updated_at: now,
              })
              .where('id', '=', cart.waitlistEntryId)
              .where('tenant_id', '=', session.tenant_id)
              .where('reserved_checkout_session_id', '=', input.checkoutSessionId)
              .where('status', '=', 'reserved')
              .execute();
          }
          await releasePendingDiscountReservation(trx, input.checkoutSessionId, now);
        }
      }

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
    return errResult(
      'HOLD_RELEASE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      false,
    );
  }
}

// Activity: Issue tickets - generate PDF and send tickets-issued email
export async function issueTicketsActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
}): Promise<WorkflowActivityResult<{ issued: number; jobId?: string }>> {
  failTicketIssueActivityOnceForE2e(input);

  const db = getActivityDb();
  try {
    const tickets = await db
      .selectFrom('tickets')
      .selectAll()
      .where('order_id', '=', input.orderId)
      .execute();
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
      .filter(
        (attendeeId): attendeeId is string =>
          typeof attendeeId === 'string' && attendeeId.length > 0,
      );
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
    let walletPassLinks: TicketWalletPassLink[] = [];
    try {
      walletPassLinks = await ensureWalletPassesForTickets(db, {
        tickets,
        ticketTypesById,
        attendeesById,
        order,
        event,
        brand,
        tenantId: input.tenantId,
      });
    } catch {
      // Wallet passes are optional; ticket PDFs and transactional email remain authoritative.
      walletPassLinks = [];
    }

    const pdfAttachments = await mapWithConcurrency(
      tickets,
      parsePositiveIntegerEnv(
        'TICKET_PDF_GENERATION_CONCURRENCY',
        DEFAULT_TICKET_PDF_GENERATION_CONCURRENCY,
      ),
      async (ticket) => {
        const pdfContent = await generateTicketPdf({
          ticket,
          ticketType: ticketTypesById.get(ticket.ticket_type_id) ?? null,
          attendee: ticket.attendee_id ? (attendeesById.get(ticket.attendee_id) ?? null) : null,
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
      },
    );

    // Check for existing email job to avoid duplicates.
    const existingJob = await db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', `tickets-issued:${input.orderId}`)
      .executeTakeFirst();
    if (existingJob) {
      await restartQueuedNotificationDeliveryWorkflow(db, existingJob);
      return okResult({ issued: tickets.length, jobId: existingJob.id });
    }

    // Resolve the provider route and template version.
    const route = await db
      .selectFrom('email_provider_routes')
      .select(['id'])
      .where('tenant_id', '=', input.tenantId)
      .where('brand_id', '=', input.brandId)
      .where('status', '=', 'active')
      .where('smoke_send_verified', '=', true)
      .orderBy('priority', 'asc')
      .executeTakeFirst();

    const publishedTemplate = await new ContentRepository(db).findPublishedEmailTemplate({
      tenantId: input.tenantId,
      brandId: input.brandId,
      eventId: order?.event_id,
      key: 'tickets-issued',
    });

    if (!route || !publishedTemplate) {
      // No route or template configured; skip email but mark tickets as issued.
      return okResult({ issued: tickets.length });
    }

    const firstTicket = tickets[0];
    const context = order
      ? buildTransactionalMergeTagContext({
          order,
          event,
          brand,
          ticket: firstTicket,
          ticketTypeName: firstTicket
            ? (ticketTypesById.get(firstTicket.ticket_type_id ?? '')?.name ?? null)
            : null,
          walletPassLinks,
        })
      : {};

    const job = await new EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'tickets-issued',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
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

    await durablyStartNotificationDeliveryWorkflow(db, {
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'tickets-issued',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
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
    return errResult(
      'TICKET_ISSUE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
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
    attendeesById: Map<
      string,
      {
        id: string;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }
    >;
    order?: {
      id: string;
      order_number: string;
      currency: string;
      event_id: string;
    } | null;
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
  const artifactJobs: Array<
    () => Promise<{
      ticketId: string;
      id: string;
      artifact: WalletPassArtifact;
    }>
  > = [];

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

    const appleConfig = config.apple;
    if (appleConfig && !existingKeys.has(`${ticket.id}:apple`)) {
      const id = `wps_${ulid()}`;
      artifactJobs.push(async () => ({
        ticketId: ticket.id,
        id,
        artifact: await generateAppleWalletPass(
          { ...commonInput, passId: id },
          appleConfig,
          config.apiBaseUrl,
        ),
      }));
    }
    const googleConfig = config.google;
    if (googleConfig && !existingKeys.has(`${ticket.id}:google`)) {
      const id = `wps_${ulid()}`;
      artifactJobs.push(async () => ({
        ticketId: ticket.id,
        id,
        artifact: generateGoogleWalletPass({ ...commonInput, passId: id }, googleConfig),
      }));
    }
  }

  const generatedArtifacts = await mapWithConcurrency(
    artifactJobs,
    parsePositiveIntegerEnv(
      'WALLET_PASS_GENERATION_CONCURRENCY',
      DEFAULT_WALLET_PASS_GENERATION_CONCURRENCY,
    ),
    async (generate) => generate(),
  );

  for (const { ticketId, id, artifact } of generatedArtifacts) {
    const now = new Date();
    // eslint-disable-next-line no-await-in-loop -- persistence stays sequential to preserve per-ticket/provider idempotency updates.
    await db
      .insertInto('wallet_passes')
      .values({
        id,
        tenant_id: input.tenantId,
        ticket_id: ticketId,
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
    existingKeys.add(`${ticketId}:${artifact.provider}`);
    existingPasses.push({
      id,
      tenant_id: input.tenantId,
      ticket_id: ticketId,
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
      await db
        .updateTable('tickets')
        .set({ wallet_pass_id: id, updated_at: now })
        .where('id', '=', ticketId)
        .execute();
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
  pdfDoc.setSubject(
    `${input.event?.title ?? 'Event ticket'} / ${input.order?.order_number ?? input.order?.id ?? 'Order'}`,
  );
  pdfDoc.setKeywords([input.ticket.id, input.ticket.code]);
  pdfDoc.setProducer('Tixkit');

  const page = pdfDoc.addPage([612, 792]);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const primary = parsePdfColor(
    parseBrandTheme(input.brand?.theme).primaryColor ??
      parseBrandTheme(input.brand?.theme).primary ??
      parseBrandTheme(input.brand?.theme).accent,
  );

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
  page.drawRectangle({
    x: 352,
    y: 382,
    width: 212,
    height: 212,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.82, 0.84, 0.87),
    borderWidth: 1,
  });
  page.drawImage(qrImage, { x: 368, y: 398, width: 180, height: 180 });
  drawField(page, bold, regular, 'Ticket Code', input.ticket.code, 48, 620);
  drawField(page, bold, regular, 'Ticket Type', input.ticketType?.name ?? 'Ticket', 48, 552);
  drawField(page, bold, regular, 'Attendee', attendeeName(input.attendee), 48, 484);
  drawField(
    page,
    bold,
    regular,
    'Order',
    input.order?.order_number ?? input.order?.id ?? 'Order pending',
    48,
    416,
  );
  drawField(
    page,
    bold,
    regular,
    'Date',
    formatEventDate(input.event?.starts_at, input.event?.timezone),
    48,
    348,
  );
  drawField(page, bold, regular, 'Venue', venueLabel(input.event?.venue), 48, 280);

  page.drawText(
    'Scan the QR code at entry. This ticket is tenant-scoped and cryptographically signed.',
    {
      x: 48,
      y: 132,
      size: 10,
      font: regular,
      color: rgb(0.36, 0.39, 0.44),
    },
  );
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
  page.drawText(label.toUpperCase(), {
    x,
    y,
    size: 9,
    font: bold,
    color: rgb(0.42, 0.45, 0.5),
  });
  page.drawText(pdfText(value), {
    x,
    y: y - 26,
    size: 16,
    font: regular,
    color: rgb(0.08, 0.09, 0.11),
    maxWidth: 270,
  });
}

function parseBrandTheme(value: unknown): BrandTheme {
  if (!value) return {};
  if (typeof value === 'object') return value as BrandTheme;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as BrandTheme) : {};
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
    ? short[1]
        .split('')
        .map((part) => `${part}${part}`)
        .join('')
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
    [
      stringValue(venue.city),
      stringValue(venue.region),
      stringValue(venue.postalCode ?? venue.postal_code),
    ]
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
