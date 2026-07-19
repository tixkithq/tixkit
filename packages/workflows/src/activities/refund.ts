import { sql, type Database } from '@tixkit/db';
import {
  EmailJobRepository,
  OrderRepository,
  PaymentIntentRepository,
  RefundRepository,
  ContentRepository,
} from '@tixkit/db';
import { ProviderOperationError, StripeSdkGateway } from '@tixkit/provider-clients';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import { paymentProviderTelemetry } from '../observability.js';
import { buildTransactionalMergeTagContext } from './messaging-context.js';
import {
  durablyStartNotificationDeliveryWorkflow,
  getActivityDb,
  getActivityProviderClientRuntime,
  restartQueuedNotificationDeliveryWorkflow,
} from './activity-clients.js';

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function serializedJsonValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type RefundRow = {
  id: string;
  order_id: string;
  provider: string;
  provider_refund_id: string;
  request_idempotency_key?: string | null;
  request_nonce?: string | null;
  amount_cents: number | string | bigint;
  currency: string;
  status: string;
  reason?: string;
  metadata?: unknown;
};

type RefundActivityValue = { providerRefundId: string; status: string };

type RefundLedgerMetadata = {
  providerRefundId: string;
  provider: string;
  requestIdempotencyKey: string;
  requestNonce: string;
  refundReservationStatus: 'succeeded';
  currency: string;
  grossRefundCents: number;
  taxRefundCents: number;
  feeRefundCents: number;
  refundCents: number;
  netRevenueDeltaCents: number;
  entries: Array<{
    account: string;
    direction: 'debit' | 'credit';
    amountCents: number;
  }>;
  balanced: true;
  normalizationVersion?: typeof REFUND_LEDGER_NORMALIZATION_VERSION;
};

type RefundReservation =
  | { action: 'return'; result: WorkflowActivityResult<RefundActivityValue> }
  | {
      action: 'call-provider';
      order: {
        id: string;
        tenantId: string;
        organizationId: string;
        totalCents: number;
        currency: string;
      };
      paymentIntent: {
        id: string;
        provider: string | null;
        providerIntentId: string | null;
      };
      paymentAccountProvider?: string;
      pendingProviderRefundId: string;
    };

const CAPACITY_REFUND_STATUSES = new Set(['pending', 'succeeded']);
const REFUND_LEDGER_NORMALIZATION_VERSION = 'legacy-head-refund-ledger-v1';

class RefundLedgerHistoryError extends Error {}

function strictRecord(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function exactLegacyWebhookRefund(refund: RefundRow): boolean {
  const metadata = strictRecord(refund.metadata);
  const expectedKey = `provider:${refund.provider}:${refund.provider_refund_id}`;
  if (!metadata) return false;
  const metadataKeys = Object.keys(metadata).sort();
  const allowedShapes = [
    [],
    ['voidedTicketIds'],
    ['inventoryRestored', 'inventoryRestoredByType', 'inventoryRestoredCount'],
    ['inventoryRestored', 'inventoryRestoredByTicketType', 'inventoryRestoredCount'],
    ['inventoryRestored', 'inventoryRestoredByType', 'inventoryRestoredCount', 'voidedTicketIds'],
    [
      'inventoryRestored',
      'inventoryRestoredByTicketType',
      'inventoryRestoredCount',
      'voidedTicketIds',
    ],
  ];
  if (!allowedShapes.some((shape) => shape.join('|') === metadataKeys.join('|'))) return false;
  if (metadata.voidedTicketIds !== undefined) {
    if (
      !Array.isArray(metadata.voidedTicketIds) ||
      metadata.voidedTicketIds.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(metadata.voidedTicketIds).size !== metadata.voidedTicketIds.length
    ) {
      return false;
    }
  }
  if (metadata.inventoryRestored !== undefined) {
    const restoredByType = strictRecord(
      metadata.inventoryRestoredByTicketType ?? metadata.inventoryRestoredByType,
    );
    if (
      metadata.inventoryRestored !== true ||
      !isSafeNonnegativeInteger(metadata.inventoryRestoredCount) ||
      !restoredByType ||
      Object.entries(restoredByType).some(
        ([ticketTypeId, count]) => ticketTypeId.length === 0 || !isSafeNonnegativeInteger(count),
      ) ||
      Object.values(restoredByType).reduce<number>((sum, count) => sum + Number(count), 0) !==
        metadata.inventoryRestoredCount
    ) {
      return false;
    }
  }
  return (
    refund.status === 'succeeded' &&
    refund.provider === 'stripe' &&
    refund.reason === 'Stripe webhook' &&
    refund.request_nonce == null &&
    refund.request_idempotency_key === expectedKey &&
    metadata !== undefined
  );
}

function normalizeLegacyWebhookRefund(refund: RefundRow): RefundRow {
  const requestIdempotencyKey = `provider:${refund.provider}:${refund.provider_refund_id}`;
  const requestNonce = `legacy-webhook-v1:${refund.id}`;
  const legacyMetadata = strictRecord(refund.metadata) ?? {};
  return {
    ...refund,
    request_idempotency_key: requestIdempotencyKey,
    request_nonce: requestNonce,
    metadata: JSON.stringify({
      ...legacyMetadata,
      refundReservationStatus: 'succeeded',
      stripeRefundId: refund.provider_refund_id,
      stripeIdempotencyKey: requestIdempotencyKey,
      refundNonce: requestNonce,
      ledgerNormalizationVersion: REFUND_LEDGER_NORMALIZATION_VERSION,
    }),
  };
}

function parseLegacyRefundLedgerMetadata(value: unknown): Record<string, unknown> | undefined {
  const metadata = strictRecord(value);
  if (!metadata) return undefined;
  const expectedKeys = [
    'balanced',
    'currency',
    'entries',
    'feeRefundCents',
    'grossRefundCents',
    'netRevenueDeltaCents',
    'providerRefundId',
    'refundCents',
    'taxRefundCents',
  ];
  if (Object.keys(metadata).sort().join('|') !== expectedKeys.join('|')) return undefined;
  const validated = parseRefundLedgerMetadata({
    ...metadata,
    provider: 'legacy-validation',
    requestIdempotencyKey: 'legacy-validation',
    requestNonce: 'legacy-validation',
    refundReservationStatus: 'succeeded',
  });
  return validated ? metadata : undefined;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseRefundLedgerMetadata(value: unknown): RefundLedgerMetadata | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const metadata = parsed as Record<string, unknown>;
  const requiredStrings = [
    metadata.providerRefundId,
    metadata.provider,
    metadata.requestIdempotencyKey,
    metadata.requestNonce,
    metadata.currency,
  ];
  if (requiredStrings.some((item) => typeof item !== 'string' || item.length === 0)) {
    return undefined;
  }
  if (metadata.refundReservationStatus !== 'succeeded' || metadata.balanced !== true) {
    return undefined;
  }
  if (
    metadata.normalizationVersion !== undefined &&
    metadata.normalizationVersion !== REFUND_LEDGER_NORMALIZATION_VERSION
  ) {
    return undefined;
  }
  const allocations = [
    metadata.grossRefundCents,
    metadata.taxRefundCents,
    metadata.feeRefundCents,
    metadata.refundCents,
  ];
  if (allocations.some((amount) => !isSafeNonnegativeInteger(amount))) return undefined;
  if (
    !Number.isSafeInteger(metadata.netRevenueDeltaCents) ||
    Number(metadata.netRevenueDeltaCents) > 0
  ) {
    return undefined;
  }
  if (!Array.isArray(metadata.entries) || metadata.entries.length !== 2) return undefined;
  const entries = metadata.entries as unknown[];
  const normalizedEntries: RefundLedgerMetadata['entries'] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.account !== 'string' ||
      (candidate.direction !== 'debit' && candidate.direction !== 'credit') ||
      !isSafeNonnegativeInteger(candidate.amountCents)
    ) {
      return undefined;
    }
    normalizedEntries.push({
      account: candidate.account,
      direction: candidate.direction,
      amountCents: candidate.amountCents,
    });
  }
  const refundCents = Number(metadata.refundCents);
  const debitCents = normalizedEntries
    .filter((entry) => entry.direction === 'debit')
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const creditCents = normalizedEntries
    .filter((entry) => entry.direction === 'credit')
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  if (
    debitCents !== refundCents ||
    creditCents !== refundCents ||
    !normalizedEntries.some(
      (entry) =>
        entry.account === 'refunds' &&
        entry.direction === 'debit' &&
        entry.amountCents === refundCents,
    ) ||
    !normalizedEntries.some(
      (entry) =>
        entry.account === 'cash' &&
        entry.direction === 'credit' &&
        entry.amountCents === refundCents,
    )
  ) {
    return undefined;
  }
  const taxRefundCents = Number(metadata.taxRefundCents);
  const feeRefundCents = Number(metadata.feeRefundCents);
  const grossRefundCents = Number(metadata.grossRefundCents);
  if (
    grossRefundCents + taxRefundCents + feeRefundCents !== refundCents ||
    Number(metadata.netRevenueDeltaCents) !== -Math.max(0, refundCents - taxRefundCents)
  ) {
    return undefined;
  }
  return {
    providerRefundId: String(metadata.providerRefundId),
    provider: String(metadata.provider),
    requestIdempotencyKey: String(metadata.requestIdempotencyKey),
    requestNonce: String(metadata.requestNonce),
    refundReservationStatus: 'succeeded',
    currency: String(metadata.currency),
    grossRefundCents,
    taxRefundCents,
    feeRefundCents,
    refundCents,
    netRevenueDeltaCents: Number(metadata.netRevenueDeltaCents),
    entries: normalizedEntries,
    balanced: true,
    ...(metadata.normalizationVersion === REFUND_LEDGER_NORMALIZATION_VERSION
      ? { normalizationVersion: REFUND_LEDGER_NORMALIZATION_VERSION }
      : {}),
  };
}

function updatedRowCount(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  return result.reduce((count, entry) => {
    if (!entry || typeof entry !== 'object') return count;
    const value =
      (entry as { numUpdatedRows?: unknown; numChangedRows?: unknown }).numUpdatedRows ??
      (entry as { numChangedRows?: unknown }).numChangedRows;
    if (typeof value === 'bigint') return count + Number(value);
    if (typeof value === 'number') return count + value;
    return count;
  }, 0);
}

function refundMatchesRequest(refund: RefundRow, requestKey: string, nonce: string): boolean {
  if (refund.request_idempotency_key === requestKey || refund.request_nonce === nonce) {
    return true;
  }
  const metadata = parseMetadata(refund.metadata);
  return metadata.stripeIdempotencyKey === requestKey || metadata.refundNonce === nonce;
}

function sumRefundsForCapacity(refunds: RefundRow[]): number {
  return refunds
    .filter((refund) => CAPACITY_REFUND_STATUSES.has(refund.status))
    .reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
}

function sumSucceededRefunds(refunds: RefundRow[]): number {
  return refunds
    .filter((refund) => refund.status === 'succeeded')
    .reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
}

function refundRequestConflicts(
  refund: RefundRow,
  input: { amountCents: number },
  currency: string,
): boolean {
  return Number(refund.amount_cents) !== input.amountCents || refund.currency !== currency;
}

function buildRefundMetadata(input: {
  stripeIdempotencyKey: string;
  stripeRefundId: string;
  nonce: string;
  status: 'pending' | 'succeeded' | 'superseded';
  supersededByProviderRefundId?: string;
}): Record<string, string> {
  return {
    stripeIdempotencyKey: input.stripeIdempotencyKey,
    stripeRefundId: input.stripeRefundId,
    refundNonce: input.nonce,
    refundReservationStatus: input.status,
    ...(input.supersededByProviderRefundId
      ? { supersededByProviderRefundId: input.supersededByProviderRefundId }
      : {}),
  };
}

export async function processRefundActivity(input: {
  orderId: string;
  amountCents: number;
  reason: string;
  idempotencyKey?: string;
  nonce: string;
}): Promise<WorkflowActivityResult<{ providerRefundId: string; status: string }>> {
  const db = getActivityDb();
  try {
    const callerKey = input.idempotencyKey ?? `refund-${input.orderId}`;
    const stripeIdempotencyKey = `${callerKey}:${input.nonce}`;
    const stripeSecretKey =
      process.env.TIXKIT_RUNTIME_MODE === 'sandbox' ? undefined : process.env.STRIPE_SECRET_KEY;
    const pendingProviderRefundId = `pending-refund:${input.orderId}:${input.nonce}`;

    const reservation = await db.transaction().execute(async (trx): Promise<RefundReservation> => {
      const orderRepo = new OrderRepository(trx as Database);
      const piRepo = new PaymentIntentRepository(trx as Database);
      const refundRepo = new RefundRepository(trx as Database);

      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) {
        return {
          action: 'return',
          result: errResult('ORDER_NOT_FOUND', 'Order not found', false),
        };
      }

      const dbPi = order.payment_intent_id ? await piRepo.findById(order.payment_intent_id) : null;
      const existingRefunds = (await trx
        .selectFrom('refunds')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute()) as RefundRow[];
      const existingForKey = existingRefunds.find((refund) =>
        refundMatchesRequest(refund, stripeIdempotencyKey, input.nonce),
      );

      const repairAndReturn = async (providerRefundId: string): Promise<RefundReservation> => {
        const allRefunds = (await trx
          .selectFrom('refunds')
          .selectAll()
          .where('order_id', '=', order.id)
          .execute()) as RefundRow[];
        const totalRefunded = sumSucceededRefunds(allRefunds);
        const newStatus =
          totalRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
        await orderRepo.update(order.id, {
          refunded_cents: totalRefunded,
          status: newStatus,
          refunded_at: new Date(),
        });
        await trx
          .updateTable('invoices')
          .set({ refunded_cents: totalRefunded, updated_at: new Date() })
          .where('order_id', '=', order.id)
          .execute();

        return {
          action: 'return',
          result: okResult({ providerRefundId, status: 'succeeded' }),
        };
      };

      if (existingForKey) {
        if (refundRequestConflicts(existingForKey, input, order.currency)) {
          return {
            action: 'return',
            result: errResult(
              'REFUND_IDEMPOTENCY_CONFLICT',
              'Refund idempotency key was already used for a different refund request',
              false,
            ),
          };
        }

        if (existingForKey.status === 'succeeded') {
          return repairAndReturn(existingForKey.provider_refund_id);
        }

        if (existingForKey.status === 'superseded') {
          const metadata = parseMetadata(existingForKey.metadata);
          const supersededBy = metadata.supersededByProviderRefundId;
          const providerRefundId =
            typeof supersededBy === 'string' ? supersededBy : existingForKey.provider_refund_id;
          return repairAndReturn(providerRefundId);
        }

        if (existingForKey.status !== 'pending') {
          await refundRepo.update(existingForKey.id, {
            status: 'pending',
            provider_refund_id: pendingProviderRefundId,
            request_idempotency_key: stripeIdempotencyKey,
            request_nonce: input.nonce,
            metadata: JSON.stringify(
              buildRefundMetadata({
                stripeIdempotencyKey,
                stripeRefundId: pendingProviderRefundId,
                nonce: input.nonce,
                status: 'pending',
              }),
            ),
          });
        }

        let paymentAccountProvider: string | undefined;
        if (dbPi?.payment_account_id) {
          const connectedPaymentAccount = await trx
            .selectFrom('payment_accounts')
            .select(['provider'])
            .where('id', '=', dbPi.payment_account_id)
            .executeTakeFirst();
          paymentAccountProvider = connectedPaymentAccount?.provider;
        }

        return {
          action: 'call-provider',
          order: {
            id: order.id,
            tenantId: order.tenant_id,
            organizationId: order.organization_id,
            totalCents: Number(order.total_cents),
            currency: order.currency,
          },
          paymentIntent: {
            id: dbPi?.id ?? '',
            provider: dbPi?.provider ?? null,
            providerIntentId: dbPi?.provider_intent_id ?? null,
          },
          paymentAccountProvider,
          pendingProviderRefundId,
        };
      }

      const reservedOrRefunded = sumRefundsForCapacity(existingRefunds);
      if (reservedOrRefunded + input.amountCents > Number(order.total_cents)) {
        return {
          action: 'return',
          result: errResult('REFUND_EXCEEDS_TOTAL', 'Refund amount exceeds order total', false),
        };
      }

      await refundRepo.create({
        tenantId: order.tenant_id,
        orderId: order.id,
        paymentIntentId: dbPi?.id,
        provider: dbPi?.provider ?? 'stripe',
        providerRefundId: pendingProviderRefundId,
        requestIdempotencyKey: stripeIdempotencyKey,
        requestNonce: input.nonce,
        amountCents: input.amountCents,
        currency: order.currency,
        reason: input.reason,
        metadata: buildRefundMetadata({
          stripeIdempotencyKey,
          stripeRefundId: pendingProviderRefundId,
          nonce: input.nonce,
          status: 'pending',
        }),
        status: 'pending',
      });

      let paymentAccountProvider: string | undefined;
      if (dbPi?.payment_account_id) {
        const connectedPaymentAccount = await trx
          .selectFrom('payment_accounts')
          .select(['provider'])
          .where('id', '=', dbPi.payment_account_id)
          .executeTakeFirst();
        paymentAccountProvider = connectedPaymentAccount?.provider;
      }

      return {
        action: 'call-provider',
        order: {
          id: order.id,
          tenantId: order.tenant_id,
          organizationId: order.organization_id,
          totalCents: Number(order.total_cents),
          currency: order.currency,
        },
        paymentIntent: {
          id: dbPi?.id ?? '',
          provider: dbPi?.provider ?? null,
          providerIntentId: dbPi?.provider_intent_id ?? null,
        },
        paymentAccountProvider,
        pendingProviderRefundId,
      };
    });

    if (reservation.action === 'return') {
      return reservation.result;
    }

    let providerRefundId: string;
    const paymentProvider =
      reservation.paymentIntent.provider ?? reservation.paymentAccountProvider ?? null;
    const requiresStripeRefund =
      paymentProvider === 'stripe' ||
      paymentProvider === 'stripe_connect' ||
      reservation.paymentAccountProvider === 'stripe_connect';
    const isDevelopmentCapture =
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') &&
      process.env.E2E_PAID_CAPTURE_MODE === '1';
    const isSandboxCapture =
      paymentProvider === 'stripe_capture' &&
      (process.env.TIXKIT_RUNTIME_MODE === 'sandbox' || isDevelopmentCapture);

    if (requiresStripeRefund && (!stripeSecretKey || !reservation.paymentIntent.providerIntentId)) {
      return errResult(
        'REFUND_PROVIDER_CONFIGURATION_INVALID',
        'Stripe refund configuration or provider payment reference is unavailable',
        false,
      );
    }

    if (requiresStripeRefund && stripeSecretKey && reservation.paymentIntent.providerIntentId) {
      const stripe = new StripeSdkGateway(stripeSecretKey, {
        onTelemetry: paymentProviderTelemetry,
        onExactRequestId: getActivityProviderClientRuntime().onExactRequestId,
        incidentScope: {
          tenantId: reservation.order.tenantId,
          organizationId: reservation.order.organizationId,
        },
      });
      const stripeRefund = await stripe.createRefund({
        paymentIntentId: reservation.paymentIntent.providerIntentId,
        amount: input.amountCents,
        reason: 'requested_by_customer',
        reverseTransfer: reservation.paymentAccountProvider === 'stripe_connect',
        refundApplicationFee: reservation.paymentAccountProvider === 'stripe_connect',
        idempotencyKey: stripeIdempotencyKey,
      });
      providerRefundId = stripeRefund.id;
    } else if (isSandboxCapture) {
      providerRefundId = `local-refund:${input.orderId}:${input.nonce}`;
    } else {
      return errResult(
        'REFUND_PROVIDER_UNSUPPORTED',
        'The payment provider does not support automatic refunds',
        false,
      );
    }

    return await db.transaction().execute(async (trx) => {
      const orderRepo = new OrderRepository(trx as Database);
      const refundRepo = new RefundRepository(trx as Database);

      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) {
        return errResult('ORDER_NOT_FOUND', 'Order not found', false);
      }

      const existingRefunds = (await trx
        .selectFrom('refunds')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute()) as RefundRow[];
      const requestRefund = existingRefunds.find((refund) =>
        refundMatchesRequest(refund, stripeIdempotencyKey, input.nonce),
      );
      const providerRefund = existingRefunds.find(
        (refund) => refund.provider_refund_id === providerRefundId,
      );

      let createdTimelineEvent = false;
      if (requestRefund?.status === 'succeeded') {
        providerRefundId = requestRefund.provider_refund_id;
      } else if (providerRefund && providerRefund.id !== requestRefund?.id) {
        if (requestRefund) {
          await refundRepo.update(requestRefund.id, {
            status: 'superseded',
            metadata: JSON.stringify(
              buildRefundMetadata({
                stripeIdempotencyKey,
                stripeRefundId: providerRefundId,
                nonce: input.nonce,
                status: 'superseded',
                supersededByProviderRefundId: providerRefundId,
              }),
            ),
          });
        }
      } else if (requestRefund) {
        try {
          await refundRepo.update(requestRefund.id, {
            provider_refund_id: providerRefundId,
            status: 'succeeded',
            metadata: JSON.stringify(
              buildRefundMetadata({
                stripeIdempotencyKey,
                stripeRefundId: providerRefundId,
                nonce: input.nonce,
                status: 'succeeded',
              }),
            ),
          });
          createdTimelineEvent = true;
        } catch (err) {
          const refreshedRefunds = (await trx
            .selectFrom('refunds')
            .selectAll()
            .where('order_id', '=', order.id)
            .execute()) as RefundRow[];
          const racedProviderRefund = refreshedRefunds.find(
            (refund) => refund.provider_refund_id === providerRefundId,
          );
          if (!racedProviderRefund) {
            throw err;
          }
          await refundRepo.update(requestRefund.id, {
            status: 'superseded',
            metadata: JSON.stringify(
              buildRefundMetadata({
                stripeIdempotencyKey,
                stripeRefundId: providerRefundId,
                nonce: input.nonce,
                status: 'superseded',
                supersededByProviderRefundId: providerRefundId,
              }),
            ),
          });
        }
      } else {
        const reservedOrRefunded = sumRefundsForCapacity(existingRefunds);
        if (reservedOrRefunded + input.amountCents > Number(order.total_cents)) {
          return errResult('REFUND_EXCEEDS_TOTAL', 'Refund amount exceeds order total', false);
        }
        await refundRepo.create({
          tenantId: order.tenant_id,
          orderId: order.id,
          paymentIntentId: order.payment_intent_id,
          provider: 'stripe',
          providerRefundId,
          requestIdempotencyKey: stripeIdempotencyKey,
          requestNonce: input.nonce,
          amountCents: input.amountCents,
          currency: order.currency,
          reason: input.reason,
          metadata: buildRefundMetadata({
            stripeIdempotencyKey,
            stripeRefundId: providerRefundId,
            nonce: input.nonce,
            status: 'succeeded',
          }),
          status: 'succeeded',
        });
        createdTimelineEvent = true;
      }

      const allRefunds = (await trx
        .selectFrom('refunds')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute()) as RefundRow[];
      const totalRefunded = sumSucceededRefunds(allRefunds);
      const newStatus =
        totalRefunded >= Number(order.total_cents) ? 'refunded' : 'partially_refunded';
      await orderRepo.update(order.id, {
        refunded_cents: totalRefunded,
        status: newStatus,
        refunded_at: new Date(),
      });
      await trx
        .updateTable('invoices')
        .set({ refunded_cents: totalRefunded, updated_at: new Date() })
        .where('order_id', '=', order.id)
        .execute();

      if (createdTimelineEvent) {
        await orderRepo.addTimelineEvent(
          order.id,
          'order.refunded',
          `Refunded ${input.amountCents} cents: ${input.reason}`,
          { refundId: providerRefundId },
        );
      }

      return okResult({ providerRefundId, status: 'succeeded' });
    });
  } catch (err) {
    if (err instanceof ProviderOperationError) {
      if (err.retryable) throw err.forRetry();
      return errResult('REFUND_PROVIDER_REJECTED', err.message, false);
    }
    return errResult('REFUND_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  }
}
export async function updateLedgerActivity(input: {
  orderId: string;
  refundAmountCents: number;
  providerRefundId: string;
}): Promise<WorkflowActivityResult<{ balanced: boolean }>> {
  const db = getActivityDb();
  try {
    return await db.transaction().execute(async (trx) => {
      const orderRepo = new OrderRepository(trx as Database);
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) {
        return errResult('ORDER_NOT_FOUND', 'Order not found', false);
      }

      const orderRefunds = (await trx
        .selectFrom('refunds')
        .selectAll()
        .where('order_id', '=', input.orderId)
        .forUpdate()
        .execute()) as RefundRow[];
      const refundNormalizations = orderRefunds
        .filter(exactLegacyWebhookRefund)
        .map((legacyRefund) => ({
          original: legacyRefund,
          normalized: normalizeLegacyWebhookRefund(legacyRefund),
        }));
      const normalizedOrderRefunds = orderRefunds.map(
        (candidate) =>
          refundNormalizations.find((item) => item.original.id === candidate.id)?.normalized ??
          candidate,
      );
      const matchingSucceededRefunds = normalizedOrderRefunds.filter(
        (candidate) =>
          candidate.provider_refund_id === input.providerRefundId &&
          candidate.status === 'succeeded',
      );
      if (matchingSucceededRefunds.length !== 1) {
        return errResult(
          'REFUND_LEDGER_SOURCE_INVALID',
          'Ledger entries require a persisted succeeded refund for the same order',
          false,
        );
      }
      const [refund] = matchingSucceededRefunds;
      const refundMetadata = parseMetadata(refund.metadata);
      if (
        !refund.provider ||
        !refund.provider_refund_id ||
        !refund.request_idempotency_key ||
        !refund.request_nonce ||
        !refund.currency ||
        refund.currency !== order.currency ||
        refundMetadata.refundReservationStatus !== 'succeeded' ||
        refundMetadata.stripeRefundId !== refund.provider_refund_id ||
        refundMetadata.stripeIdempotencyKey !== refund.request_idempotency_key ||
        refundMetadata.refundNonce !== refund.request_nonce ||
        !isSafeNonnegativeInteger(Number(refund.amount_cents)) ||
        Number(refund.amount_cents) === 0 ||
        !isSafeNonnegativeInteger(input.refundAmountCents)
      ) {
        return errResult(
          'REFUND_LEDGER_SOURCE_INVALID',
          'Ledger entries require a persisted succeeded refund for the same order',
          false,
        );
      }
      if (Number(refund.amount_cents) !== input.refundAmountCents) {
        return errResult(
          'REFUND_LEDGER_AMOUNT_CONFLICT',
          'Ledger refund amount does not match the persisted provider refund',
          false,
        );
      }

      const refunded = Number(order.refunded_cents);
      const total = Number(order.total_cents);
      const taxSnapshots = await trx
        .selectFrom('order_tax_snapshots')
        .select(['tax_cents'])
        .where('order_id', '=', input.orderId)
        .execute();
      const taxSnapshotAmounts = taxSnapshots.map((snapshot) => Number(snapshot.tax_cents));
      const persistedTaxCents = taxSnapshotAmounts.reduce((sum, amount) => sum + amount, 0);
      const taxBasisCents = persistedTaxCents > 0 ? persistedTaxCents : Number(order.tax_cents);
      const feeBasisCents = Number(order.fee_cents);
      const timeline = await trx
        .selectFrom('order_timeline_events')
        .selectAll()
        .where('order_id', '=', input.orderId)
        .orderBy('created_at', 'asc')
        .forUpdate()
        .execute();
      const ledgerEvents = timeline.filter((event) => event.type === 'ledger.refund');
      const ledgerNormalizations: Array<{
        id: string;
        originalMetadata: unknown;
        metadata: RefundLedgerMetadata;
      }> = [];
      const invalidHistory = () =>
        errResult(
          'REFUND_LEDGER_HISTORY_INVALID',
          'Persisted refund ledger history is malformed or inconsistent',
          false,
        );
      if (
        !isSafeNonnegativeInteger(total) ||
        !isSafeNonnegativeInteger(refunded) ||
        !isSafeNonnegativeInteger(taxBasisCents) ||
        !isSafeNonnegativeInteger(feeBasisCents) ||
        taxSnapshotAmounts.some((amount) => !isSafeNonnegativeInteger(amount))
      ) {
        return invalidHistory();
      }

      const ledgerMetadata: RefundLedgerMetadata[] = [];
      const boundProviderRefundIds = new Set<string>();
      let validatedRefundCents = 0;
      let validatedTaxRefundCents = 0;
      let validatedFeeRefundCents = 0;
      for (const event of ledgerEvents) {
        let metadata = parseRefundLedgerMetadata(event.metadata);
        if (!metadata) {
          const legacyMetadata = parseLegacyRefundLedgerMetadata(event.metadata);
          if (legacyMetadata) {
            const legacyBindings = normalizedOrderRefunds.filter(
              (candidate) =>
                candidate.status === 'succeeded' &&
                candidate.provider_refund_id === legacyMetadata.providerRefundId &&
                Number(candidate.amount_cents) === legacyMetadata.refundCents &&
                candidate.currency === legacyMetadata.currency,
            );
            if (legacyBindings.length !== 1 || typeof event.id !== 'string') {
              return invalidHistory();
            }
            const [legacyBinding] = legacyBindings;
            if (!legacyBinding.request_idempotency_key || !legacyBinding.request_nonce) {
              return invalidHistory();
            }
            metadata = parseRefundLedgerMetadata({
              ...legacyMetadata,
              provider: legacyBinding.provider,
              requestIdempotencyKey: legacyBinding.request_idempotency_key,
              requestNonce: legacyBinding.request_nonce,
              refundReservationStatus: 'succeeded',
              normalizationVersion: REFUND_LEDGER_NORMALIZATION_VERSION,
            });
            if (metadata) {
              ledgerNormalizations.push({
                id: event.id,
                originalMetadata: event.metadata,
                metadata,
              });
            }
          }
        }
        if (!metadata || boundProviderRefundIds.has(metadata.providerRefundId)) {
          return invalidHistory();
        }
        const boundRefunds = normalizedOrderRefunds.filter(
          (candidate) =>
            candidate.status === 'succeeded' &&
            candidate.provider_refund_id === metadata.providerRefundId &&
            candidate.provider === metadata.provider,
        );
        if (boundRefunds.length !== 1) return invalidHistory();
        const [boundRefund] = boundRefunds;
        const boundRefundMetadata = parseMetadata(boundRefund.metadata);
        if (
          !boundRefund.request_idempotency_key ||
          !boundRefund.request_nonce ||
          Number(boundRefund.amount_cents) !== metadata.refundCents ||
          boundRefund.currency !== metadata.currency ||
          metadata.currency !== order.currency ||
          boundRefund.request_idempotency_key !== metadata.requestIdempotencyKey ||
          boundRefund.request_nonce !== metadata.requestNonce ||
          boundRefundMetadata.refundReservationStatus !== 'succeeded' ||
          boundRefundMetadata.stripeRefundId !== metadata.providerRefundId ||
          boundRefundMetadata.stripeIdempotencyKey !== metadata.requestIdempotencyKey ||
          boundRefundMetadata.refundNonce !== metadata.requestNonce
        ) {
          return invalidHistory();
        }
        validatedRefundCents += metadata.refundCents;
        validatedTaxRefundCents += metadata.taxRefundCents;
        validatedFeeRefundCents += metadata.feeRefundCents;
        if (
          !Number.isSafeInteger(validatedRefundCents) ||
          !Number.isSafeInteger(validatedTaxRefundCents) ||
          !Number.isSafeInteger(validatedFeeRefundCents) ||
          validatedRefundCents > total ||
          validatedTaxRefundCents > taxBasisCents ||
          validatedFeeRefundCents > feeBasisCents
        ) {
          return invalidHistory();
        }
        boundProviderRefundIds.add(metadata.providerRefundId);
        ledgerMetadata.push(metadata);
      }

      for (const normalization of refundNormalizations) {
        const originalMetadata = serializedJsonValue(normalization.original.metadata);
        let update = trx
          .updateTable('refunds')
          .set({
            request_idempotency_key: normalization.normalized.request_idempotency_key ?? null,
            request_nonce: normalization.normalized.request_nonce ?? null,
            metadata: String(normalization.normalized.metadata),
            updated_at: new Date(),
          })
          .where('id', '=', normalization.original.id)
          .where('status', '=', 'succeeded')
          .where('request_nonce', 'is', null)
          .where(
            'request_idempotency_key',
            '=',
            String(normalization.original.request_idempotency_key),
          );
        update =
          process.env.DB_DRIVER === 'mysql'
            ? update.where(sql<boolean>`metadata = cast(${originalMetadata} as json)`)
            : update.where('metadata', '=', originalMetadata);
        const result = await update.execute();
        if (updatedRowCount(result) !== 1) throw new RefundLedgerHistoryError();
      }
      for (const normalization of ledgerNormalizations) {
        const originalMetadata = serializedJsonValue(normalization.originalMetadata);
        let update = trx
          .updateTable('order_timeline_events')
          .set({ metadata: JSON.stringify(normalization.metadata) })
          .where('id', '=', normalization.id)
          .where('order_id', '=', input.orderId)
          .where('type', '=', 'ledger.refund');
        update =
          process.env.DB_DRIVER === 'mysql'
            ? update.where(sql<boolean>`metadata = cast(${originalMetadata} as json)`)
            : update.where('metadata', '=', originalMetadata);
        const result = await update.execute();
        if (updatedRowCount(result) !== 1) throw new RefundLedgerHistoryError();
      }

      if (refunded > total) {
        return okResult({ balanced: false });
      }
      const existing = ledgerMetadata.find(
        (metadata) => metadata.providerRefundId === input.providerRefundId,
      );
      if (existing) {
        return Number(existing.refundCents) === input.refundAmountCents
          ? okResult({ balanced: true })
          : errResult(
              'REFUND_LEDGER_AMOUNT_CONFLICT',
              'Existing ledger entry does not match the persisted provider refund',
              false,
            );
      }

      const refundAmount = input.refundAmountCents;
      const priorRefundCents = validatedRefundCents;
      const priorTaxRefundCents = validatedTaxRefundCents;
      const priorFeeRefundCents = validatedFeeRefundCents;
      if (priorRefundCents + refundAmount > total) {
        return okResult({ balanced: false });
      }
      const cumulativeRefundCents = priorRefundCents + refundAmount;
      const cumulativeRatio = total > 0 ? cumulativeRefundCents / total : 0;
      const cumulativeTaxTarget = Math.min(
        taxBasisCents,
        Math.round(taxBasisCents * cumulativeRatio),
      );
      const cumulativeFeeTarget = Math.min(
        feeBasisCents,
        Math.round(feeBasisCents * cumulativeRatio),
      );
      const taxRefundCents = Math.max(
        0,
        Math.min(taxBasisCents - priorTaxRefundCents, cumulativeTaxTarget - priorTaxRefundCents),
      );
      const feeRefundCents = Math.max(
        0,
        Math.min(feeBasisCents - priorFeeRefundCents, cumulativeFeeTarget - priorFeeRefundCents),
      );
      const grossRefundCents = Math.max(0, refundAmount - taxRefundCents - feeRefundCents);
      const netRevenueDeltaCents = -Math.max(0, refundAmount - taxRefundCents);

      const debitCents = refundAmount;
      const creditCents = refundAmount;
      await orderRepo.addTimelineEvent(
        input.orderId,
        'ledger.refund',
        `Ledger refund entry for ${refundAmount} cents`,
        {
          providerRefundId: input.providerRefundId,
          provider: refund.provider,
          requestIdempotencyKey: refund.request_idempotency_key ?? null,
          requestNonce: refund.request_nonce ?? null,
          refundReservationStatus: refundMetadata.refundReservationStatus ?? null,
          currency: order.currency,
          grossRefundCents,
          taxRefundCents,
          feeRefundCents,
          refundCents: refundAmount,
          netRevenueDeltaCents,
          entries: [
            { account: 'refunds', direction: 'debit', amountCents: debitCents },
            { account: 'cash', direction: 'credit', amountCents: creditCents },
          ],
          balanced: debitCents === creditCents,
        },
      );

      return okResult({ balanced: debitCents === creditCents });
    });
  } catch (err) {
    if (err instanceof RefundLedgerHistoryError) {
      return errResult(
        'REFUND_LEDGER_HISTORY_INVALID',
        'Persisted refund ledger history is malformed or inconsistent',
        false,
      );
    }
    return errResult(
      'LEDGER_UPDATE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function voidTicketsActivity(input: {
  orderId: string;
  amountCents: number;
  isFullRefund: boolean;
  providerRefundId?: string;
}): Promise<WorkflowActivityResult<{ voidedCount: number; voidedTicketIds: string[] }>> {
  const db = getActivityDb();
  try {
    const voidedTicketIds = await db.transaction().execute(async (trx) => {
      const orderRepo = new OrderRepository(trx as Database);
      const order = await trx
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', input.orderId)
        .forUpdate()
        .executeTakeFirst();
      if (!order) {
        throw new Error('ORDER_NOT_FOUND');
      }

      const refund = input.providerRefundId
        ? await trx
            .selectFrom('refunds')
            .selectAll()
            .where('provider_refund_id', '=', input.providerRefundId)
            .forUpdate()
            .executeTakeFirst()
        : null;
      const refundMetadata = parseMetadata(refund?.metadata);
      const existingVoidedTicketIds = stringArray(refundMetadata.voidedTicketIds);
      if (existingVoidedTicketIds.length > 0) {
        return existingVoidedTicketIds;
      }

      const validTickets = await trx
        .selectFrom('tickets')
        .selectAll()
        .where('order_id', '=', input.orderId)
        .where('status', '=', 'valid')
        .orderBy('id', 'asc')
        .forUpdate()
        .execute();

      let ticketsToVoid: typeof validTickets;

      if (input.isFullRefund) {
        ticketsToVoid = validTickets;
      } else {
        const lineItems = await orderRepo.getLineItems(input.orderId);
        if (lineItems.length === 0) {
          ticketsToVoid = [];
        } else {
          const validByType = new Map<string, typeof validTickets>();
          for (const ticket of validTickets) {
            const list = validByType.get(ticket.ticket_type_id) ?? [];
            list.push(ticket);
            validByType.set(ticket.ticket_type_id, list);
          }

          // eslint-disable-next-line unicorn/no-array-sort -- sorting a copied line-item list preserves deterministic refund allocation.
          const sortedLines = [...lineItems].sort(
            (a, b) => Number(b.unit_price_cents) - Number(a.unit_price_cents),
          );

          let remainingAmount = input.amountCents;
          ticketsToVoid = [];

          for (const line of sortedLines) {
            if (!line.ticket_type_id) continue;
            if (remainingAmount <= 0) break;
            const quantity = Math.max(1, Number(line.quantity));
            const lineTotalCents = Number(line.total_cents ?? 0);
            const unitPriceCents = Number(line.unit_price_cents ?? 0);
            const perTicketPriceCents = Math.max(
              0,
              Math.round(lineTotalCents > 0 ? lineTotalCents / quantity : unitPriceCents),
            );
            if (perTicketPriceCents <= 0) continue;

            const ticketsOfType = validByType.get(line.ticket_type_id) ?? [];
            const voidableFromType = Math.floor(remainingAmount / perTicketPriceCents);
            const voidCount = Math.min(voidableFromType, ticketsOfType.length);

            for (let i = 0; i < voidCount; i += 1) {
              ticketsToVoid.push(ticketsOfType[i]);
            }
            remainingAmount -= voidCount * perTicketPriceCents;
            validByType.set(line.ticket_type_id, ticketsOfType.slice(voidCount));
          }
        }
      }

      const wonTicketIds: string[] = [];
      const now = new Date();
      for (const ticket of ticketsToVoid) {
        // eslint-disable-next-line no-await-in-loop -- each conditional update establishes the exact tickets this refund won under concurrency.
        const updateResult = await trx
          .updateTable('tickets')
          .set({ status: 'void', updated_at: now })
          .where('id', '=', ticket.id)
          .where('status', '=', 'valid')
          .execute();
        if (updatedRowCount(updateResult) > 0) {
          wonTicketIds.push(ticket.id);
        }
      }

      if (wonTicketIds.length > 0) {
        await trx
          .updateTable('wallet_passes')
          .set({ status: 'revoked', revoked_at: now, updated_at: now })
          .where('ticket_id', 'in', wonTicketIds)
          .where('status', '=', 'active')
          .execute();
      }

      if (refund) {
        await trx
          .updateTable('refunds')
          .set({
            metadata: JSON.stringify({
              ...refundMetadata,
              voidedTicketIds: wonTicketIds,
            }),
            updated_at: now,
          })
          .where('id', '=', refund.id)
          .execute();
      }

      await orderRepo.addTimelineEvent(
        input.orderId,
        'tickets.voided',
        `Voided ${wonTicketIds.length} tickets`,
        { voidedTicketIds: wonTicketIds },
      );

      return wonTicketIds;
    });

    return okResult({ voidedCount: voidedTicketIds.length, voidedTicketIds });
  } catch (err) {
    if (err instanceof Error && err.message === 'ORDER_NOT_FOUND') {
      return errResult('ORDER_NOT_FOUND', 'Order not found', false);
    }
    return errResult(
      'VOID_TICKETS_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function restoreInventoryActivity(input: {
  orderId: string;
  amountCents: number;
  isFullRefund: boolean;
  providerRefundId?: string;
  voidedTicketIds?: string[];
}): Promise<WorkflowActivityResult<{ restored: number }>> {
  const db = getActivityDb();
  try {
    const restored = await db.transaction().execute(async (trx) => {
      const refund = input.providerRefundId
        ? await trx
            .selectFrom('refunds')
            .selectAll()
            .where('provider_refund_id', '=', input.providerRefundId)
            .forUpdate()
            .executeTakeFirst()
        : null;
      const refundMetadata = parseMetadata(refund?.metadata);
      if (refundMetadata.inventoryRestored === true) {
        return Number(refundMetadata.inventoryRestoredCount ?? 0);
      }

      const order = await trx
        .selectFrom('orders')
        .select(['checkout_session_id', 'total_cents'])
        .where('id', '=', input.orderId)
        .executeTakeFirst();
      if (!order) return 0;

      // Read pool IDs without lock first, then lock pools in sorted order
      // before locking holds. This matches the finalize activity's lock
      // ordering (pools -> holds) to prevent deadlocks under concurrent
      // finalize/refund operations.
      const candidateHolds = await trx
        .selectFrom('checkout_holds')
        .selectAll()
        .where('checkout_session_id', '=', order.checkout_session_id)
        .where('status', '=', 'converted')
        .execute();
      // eslint-disable-next-line unicorn/no-array-sort -- sorted lock acquisition order prevents inventory-pool deadlocks.
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
        .where('checkout_session_id', '=', order.checkout_session_id)
        .where('status', '=', 'converted')
        .forUpdate()
        .execute();

      const now = new Date();
      let count = 0;
      const restoredByTicketType = new Map<string, number>();
      const previousRefunds = await trx
        .selectFrom('refunds')
        .select(['provider_refund_id', 'metadata'])
        .where('order_id', '=', input.orderId)
        .where('status', '=', 'succeeded')
        .execute();
      const previouslyRestoredByTicketType = new Map<string, number>();
      for (const previousRefund of previousRefunds) {
        if (previousRefund.provider_refund_id === input.providerRefundId) continue;
        const metadata = parseMetadata(previousRefund.metadata);
        const byType = parseMetadata(metadata.inventoryRestoredByTicketType);
        for (const [ticketTypeId, quantity] of Object.entries(byType)) {
          previouslyRestoredByTicketType.set(
            ticketTypeId,
            (previouslyRestoredByTicketType.get(ticketTypeId) ?? 0) + Number(quantity),
          );
        }
      }
      const consumePreviouslyRestored = (ticketTypeId: string, quantity: number) => {
        const restoredBudget = previouslyRestoredByTicketType.get(ticketTypeId) ?? 0;
        const consumed = Math.min(quantity, restoredBudget);
        const remainingBudget = restoredBudget - consumed;
        if (remainingBudget > 0) {
          previouslyRestoredByTicketType.set(ticketTypeId, remainingBudget);
        } else {
          previouslyRestoredByTicketType.delete(ticketTypeId);
        }
        return quantity - consumed;
      };

      if (input.isFullRefund) {
        // Full refund: restore each hold's remaining quantity after any prior
        // partial refunds recorded on earlier refund metadata.
        for (const hold of holds) {
          const remainingQuantity = consumePreviouslyRestored(
            hold.ticket_type_id,
            Number(hold.quantity),
          );
          if (remainingQuantity === 0) continue;
          // eslint-disable-next-line no-await-in-loop -- full-refund restoration updates each hold before adjusting its inventory pool.
          await trx
            .updateTable('checkout_holds')
            .set({
              status: 'restored',
              updated_at: now,
            })
            .where('id', '=', hold.id)
            .execute();
          // eslint-disable-next-line no-await-in-loop -- pool sold counts are restored immediately after the corresponding hold row.
          await trx
            .updateTable('inventory_pools')
            .set((eb) => ({
              sold_count: eb('sold_count', '-', remainingQuantity),
              updated_at: now,
            }))
            .where('id', '=', hold.inventory_pool_id)
            .execute();
          count += remainingQuantity;
          restoredByTicketType.set(
            hold.ticket_type_id,
            (restoredByTicketType.get(hold.ticket_type_id) ?? 0) + remainingQuantity,
          );
        }
      } else {
        // Partial refunds only restore inventory for tickets actually voided by
        // this refund. The refund metadata is the idempotency boundary because
        // checkout_holds do not model partially restored quantities.
        const voidedTicketIds = input.voidedTicketIds?.length
          ? input.voidedTicketIds
          : stringArray(refundMetadata.voidedTicketIds);
        if (voidedTicketIds.length > 0) {
          const voidedTickets = await trx
            .selectFrom('tickets')
            .select(['ticket_type_id'])
            .where('id', 'in', voidedTicketIds)
            .execute();
          const restoreByTicketType = new Map<string, number>();
          for (const ticket of voidedTickets) {
            restoreByTicketType.set(
              ticket.ticket_type_id,
              (restoreByTicketType.get(ticket.ticket_type_id) ?? 0) + 1,
            );
          }

          for (const [ticketTypeId, quantity] of restoreByTicketType) {
            let remaining = quantity;
            const matchingHolds = holds.filter((hold) => hold.ticket_type_id === ticketTypeId);
            for (const hold of matchingHolds) {
              if (remaining <= 0) break;
              const remainingHoldQuantity = consumePreviouslyRestored(
                hold.ticket_type_id,
                Number(hold.quantity),
              );
              if (remainingHoldQuantity === 0) continue;
              const restoreQty = Math.min(remainingHoldQuantity, remaining);
              // eslint-disable-next-line no-await-in-loop -- partial refund restoration walks matching holds in order until the voided quantity is restored.
              await trx
                .updateTable('inventory_pools')
                .set((eb) => ({
                  sold_count: eb('sold_count', '-', restoreQty),
                  updated_at: now,
                }))
                .where('id', '=', hold.inventory_pool_id)
                .execute();
              count += restoreQty;
              restoredByTicketType.set(
                ticketTypeId,
                (restoredByTicketType.get(ticketTypeId) ?? 0) + restoreQty,
              );
              remaining -= restoreQty;
            }
          }
        }
      }

      if (refund) {
        await trx
          .updateTable('refunds')
          .set({
            metadata: JSON.stringify({
              ...refundMetadata,
              inventoryRestored: true,
              inventoryRestoredCount: count,
              inventoryRestoredByTicketType: Object.fromEntries(restoredByTicketType),
            }),
            updated_at: now,
          })
          .where('id', '=', refund.id)
          .execute();
      }

      return count;
    });

    return okResult({ restored });
  } catch (err) {
    return errResult(
      'RESTORE_INVENTORY_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function notifyRefundActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
  providerRefundId?: string;
}): Promise<WorkflowActivityResult<{ notified: boolean; jobId?: string }>> {
  const db = getActivityDb();
  try {
    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(input.orderId);
    if (!order) {
      return errResult('ORDER_NOT_FOUND', 'Order not found for refund notification', false);
    }

    // Include the providerRefundId (or a fallback nonce) in the idempotency key
    // so subsequent partial refund notifications are not skipped as duplicates.
    const refundNonce = input.providerRefundId ?? `rfd-${Date.now()}`;
    const idempotencyKey = `order-refunded:${input.orderId}:${refundNonce}`;

    // Check for existing email job to avoid duplicates.
    const existingJob = await db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existingJob) {
      await restartQueuedNotificationDeliveryWorkflow(db, existingJob);
      return okResult({ notified: true, jobId: existingJob.id });
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
      eventId: order.event_id,
      key: 'order-refunded',
    });

    if (!route || !publishedTemplate) {
      // No route or template configured; skip gracefully.
      return okResult({ notified: false });
    }

    const [event, brand, refundRow] = await Promise.all([
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
      input.providerRefundId
        ? db
            .selectFrom('refunds')
            .select(['amount_cents', 'currency', 'status', 'created_at'])
            .where('provider_refund_id', '=', input.providerRefundId)
            .executeTakeFirst()
        : Promise.resolve(undefined),
    ]);
    const context = buildTransactionalMergeTagContext({
      order,
      event,
      brand,
      refund: refundRow,
    });

    const job = await new EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-refunded',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
        orderId: input.orderId,
        orderNumber: order.order_number,
        refundedCents: Number(order.refunded_cents),
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      priority: 'high',
      idempotencyKey,
    });

    await durablyStartNotificationDeliveryWorkflow(db, {
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-refunded',
      templateVersionId: publishedTemplate.version.id,
      toEmail: input.toEmail,
      variables: {
        ...context,
        orderId: input.orderId,
        orderNumber: order.order_number,
        refundedCents: Number(order.refunded_cents),
        refundNonce,
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      notificationType: 'transactional',
    });

    return okResult({ notified: true, jobId: job.id });
  } catch (err) {
    return errResult(
      'REFUND_NOTIFY_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}
