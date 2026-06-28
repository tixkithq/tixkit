import { createDb, type Database } from '@tixkit/db';
import { OrderRepository, PaymentIntentRepository, RefundRepository } from '@tixkit/db';
import { withSpan } from '@tixkit/shared';
import { Connection, Client } from '@temporalio/client';
import Stripe from 'stripe';
import { notificationDeliveryWorkflow } from '../workflows/notification.js';
import type { NotificationDeliveryWorkflowInput } from '../workflows/notification.js';
import { notificationWorkflowId, NOTIFICATION_WORKFLOW_VERSION } from '../shared/types.js';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
const TEMPORAL_TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit';

let cachedClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
  if (!cachedClient) {
    const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
    cachedClient = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  }
  return cachedClient;
}

async function startNotificationWorkflow(
  input: Omit<NotificationDeliveryWorkflowInput, 'version'>,
): Promise<void> {
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
      if (
        !(
          err instanceof Error &&
          (err.name === 'WorkflowExecutionAlreadyStartedError' ||
            err.message.includes('already started'))
        )
      ) {
        throw err;
      }
    }
  } catch {
    // Non-fatal: email job row is queued for later drainage.
  }
}

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

type RefundRow = {
  id: string;
  order_id: string;
  provider_refund_id: string;
  request_idempotency_key?: string | null;
  request_nonce?: string | null;
  amount_cents: number | string | bigint;
  currency: string;
  status: string;
  metadata?: unknown;
};

type RefundActivityValue = { providerRefundId: string; status: string };

type RefundReservation =
  | { action: 'return'; result: WorkflowActivityResult<RefundActivityValue> }
  | {
      action: 'call-provider';
      order: {
        id: string;
        tenantId: string;
        totalCents: number;
        currency: string;
      };
      paymentIntent: { id: string; providerIntentId: string | null };
      paymentAccountProvider?: string;
      pendingProviderRefundId: string;
    };

const CAPACITY_REFUND_STATUSES = new Set(['pending', 'succeeded']);

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
  const db = createDb();
  try {
    const callerKey = input.idempotencyKey ?? `refund-${input.orderId}`;
    const stripeIdempotencyKey = `${callerKey}:${input.nonce}`;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
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
        return { action: 'return', result: errResult('ORDER_NOT_FOUND', 'Order not found', false) };
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

        return { action: 'return', result: okResult({ providerRefundId, status: 'succeeded' }) };
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
            totalCents: Number(order.total_cents),
            currency: order.currency,
          },
          paymentIntent: {
            id: dbPi?.id ?? '',
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
        provider: 'stripe',
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
          totalCents: Number(order.total_cents),
          currency: order.currency,
        },
        paymentIntent: {
          id: dbPi?.id ?? '',
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
    if (stripeSecretKey && reservation.paymentIntent.providerIntentId) {
      const stripe = new Stripe(stripeSecretKey);
      const refundOpts: Stripe.RefundCreateParams = {
        payment_intent: reservation.paymentIntent.providerIntentId,
        amount: input.amountCents,
        reason: 'requested_by_customer',
      };
      if (reservation.paymentAccountProvider === 'stripe_connect') {
        refundOpts.reverse_transfer = true;
        refundOpts.refund_application_fee = true;
      }

      const stripeRefund = await withSpan(
        'provider.stripe.refund.create',
        {
          'tixkit.provider': 'stripe',
          'tixkit.provider.operation': 'refund.create',
          'tixkit.tenant_id': reservation.order.tenantId,
          'tixkit.order_id': input.orderId,
          'tixkit.payment_intent_id': reservation.paymentIntent.id,
        },
        async (span) => {
          const created = await stripe.refunds.create(refundOpts, {
            idempotencyKey: stripeIdempotencyKey,
          });
          span.setAttribute('tixkit.provider.refund_id', created.id);
          span.setAttribute('tixkit.provider.refund_status', created.status ?? 'unknown');
          return created;
        },
      );
      providerRefundId = stripeRefund.id;
    } else {
      providerRefundId = `local-refund:${input.orderId}:${input.nonce}`;
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
    return errResult('REFUND_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  } finally {
    await db.destroy();
  }
}

export async function updateLedgerActivity(input: {
  orderId: string;
  refundAmountCents: number;
  providerRefundId: string;
}): Promise<WorkflowActivityResult<{ balanced: boolean }>> {
  const db = createDb();
  try {
    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(input.orderId);
    if (!order) {
      return errResult('ORDER_NOT_FOUND', 'Order not found', false);
    }
    const refunded = Number(order.refunded_cents);
    const total = Number(order.total_cents);
    if (refunded > total) {
      return okResult({ balanced: false });
    }

    const timeline = await orderRepo.getTimeline(input.orderId);
    const existing = timeline.find((event) => {
      if (event.type !== 'ledger.refund') return false;
      const metadata = parseMetadata(event.metadata);
      return metadata.providerRefundId === input.providerRefundId;
    });
    if (existing) {
      return okResult({ balanced: true });
    }

    const refundAmount = input.refundAmountCents;
    const ratio = total > 0 ? refundAmount / total : 0;
    const taxSnapshots = await db
      .selectFrom('order_tax_snapshots')
      .select(['tax_cents'])
      .where('order_id', '=', input.orderId)
      .execute();
    const persistedTaxCents = taxSnapshots.reduce(
      (sum, snapshot) => sum + Number(snapshot.tax_cents),
      0,
    );
    const taxBasisCents = persistedTaxCents > 0 ? persistedTaxCents : Number(order.tax_cents);
    const taxRefundCents = Math.min(taxBasisCents, Math.round(taxBasisCents * ratio));
    const feeRefundCents = Math.min(
      Number(order.fee_cents),
      Math.round(Number(order.fee_cents) * ratio),
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
  } catch (err) {
    return errResult(
      'LEDGER_UPDATE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function voidTicketsActivity(input: {
  orderId: string;
  amountCents: number;
  isFullRefund: boolean;
  providerRefundId?: string;
}): Promise<WorkflowActivityResult<{ voidedCount: number; voidedTicketIds: string[] }>> {
  const db = createDb();
  try {
    const orderRepo = new OrderRepository(db);
    const order = await orderRepo.findById(input.orderId);
    if (!order) {
      return errResult('ORDER_NOT_FOUND', 'Order not found', false);
    }

    const refund = input.providerRefundId
      ? await db
          .selectFrom('refunds')
          .selectAll()
          .where('provider_refund_id', '=', input.providerRefundId)
          .executeTakeFirst()
      : null;
    const refundMetadata = parseMetadata(refund?.metadata);
    const existingVoidedTicketIds = stringArray(refundMetadata.voidedTicketIds);
    if (existingVoidedTicketIds.length > 0) {
      return okResult({
        voidedCount: existingVoidedTicketIds.length,
        voidedTicketIds: existingVoidedTicketIds,
      });
    }

    const tickets = await db
      .selectFrom('tickets')
      .selectAll()
      .where('order_id', '=', input.orderId)
      .orderBy('id', 'asc')
      .execute();

    // Only void `valid` tickets; never re-void already-voided tickets.
    const validTickets = tickets.filter((t) => t.status === 'valid');

    let ticketsToVoid: typeof validTickets;

    if (input.isFullRefund) {
      // Full refund: void all remaining valid tickets.
      ticketsToVoid = validTickets;
    } else {
      // Partial refund: compute the proportional number of tickets to void
      // using per-line-item prices. Void tickets from line items in order of
      // descending unit price (conservative: voids the most expensive tickets
      // first). Select tickets by ticket_type_id so multi-ticket-type orders
      // void the correct ticket types.
      const lineItems = await orderRepo.getLineItems(input.orderId);
      if (lineItems.length === 0) {
        ticketsToVoid = [];
      } else {
        // Group valid tickets by ticket_type_id for targeted voiding.
        const validByType = new Map<string, typeof validTickets>();
        for (const t of validTickets) {
          const list = validByType.get(t.ticket_type_id) ?? [];
          list.push(t);
          validByType.set(t.ticket_type_id, list);
        }

        // Sort line items by unit price descending so we void expensive tickets first.
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

          for (let i = 0; i < voidCount; i++) {
            ticketsToVoid.push(ticketsOfType[i]);
          }
          remainingAmount -= voidCount * perTicketPriceCents;
          // Remove voided tickets from the map so they aren't voided twice.
          validByType.set(line.ticket_type_id, ticketsOfType.slice(voidCount));
        }
      }
    }

    const voidedTicketIds: string[] = [];
    const now = new Date();
    await Promise.all(
      ticketsToVoid.map((ticket) =>
        db
          .updateTable('tickets')
          .set({ status: 'void', updated_at: now })
          .where('id', '=', ticket.id)
          .execute(),
      ),
    );
    voidedTicketIds.push(...ticketsToVoid.map((ticket) => ticket.id));
    if (voidedTicketIds.length > 0) {
      await db
        .updateTable('wallet_passes')
        .set({ status: 'revoked', revoked_at: now, updated_at: now })
        .where('ticket_id', 'in', voidedTicketIds)
        .where('status', '=', 'active')
        .execute();
    }

    if (refund) {
      await db
        .updateTable('refunds')
        .set({
          metadata: JSON.stringify({ ...refundMetadata, voidedTicketIds }),
          updated_at: now,
        })
        .where('id', '=', refund.id)
        .execute();
    }

    await orderRepo.addTimelineEvent(
      input.orderId,
      'tickets.voided',
      `Voided ${voidedTicketIds.length} tickets`,
      { voidedTicketIds },
    );
    return okResult({ voidedCount: voidedTicketIds.length, voidedTicketIds });
  } catch (err) {
    return errResult(
      'VOID_TICKETS_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  } finally {
    await db.destroy();
  }
}

export async function restoreInventoryActivity(input: {
  orderId: string;
  amountCents: number;
  isFullRefund: boolean;
  providerRefundId?: string;
  voidedTicketIds?: string[];
}): Promise<WorkflowActivityResult<{ restored: number }>> {
  const db = createDb();
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
                .set((eb) => ({ sold_count: eb('sold_count', '-', restoreQty), updated_at: now }))
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
  } finally {
    await db.destroy();
  }
}

export async function notifyRefundActivity(input: {
  orderId: string;
  toEmail: string;
  tenantId: string;
  brandId: string;
  providerRefundId?: string;
}): Promise<WorkflowActivityResult<{ notified: boolean; jobId?: string }>> {
  const db = createDb();
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
      .select(['id', 'status'])
      .where('tenant_id', '=', input.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existingJob) {
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

    const templateVersion = await db
      .selectFrom('notification_templates as template')
      .innerJoin('notification_template_versions as version', 'version.template_id', 'template.id')
      .select(['version.id'])
      .where('template.tenant_id', '=', input.tenantId)
      .where('template.key', '=', 'order-refunded')
      .where('version.is_default', '=', true)
      .executeTakeFirst();

    if (!route || !templateVersion) {
      // No route or template configured; skip gracefully.
      return okResult({ notified: false });
    }

    const job = await new (
      await import('@tixkit/db')
    ).EmailJobRepository(db).create({
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-refunded',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
        orderId: input.orderId,
        orderNumber: order.order_number,
        refundedCents: Number(order.refunded_cents),
        notificationType: 'transactional',
      },
      providerRouteId: route.id,
      priority: 'high',
      idempotencyKey,
    });

    // Start the notification delivery workflow to actually send the email.
    await startNotificationWorkflow({
      jobId: job.id,
      tenantId: input.tenantId,
      brandId: input.brandId,
      templateKey: 'order-refunded',
      templateVersionId: templateVersion.id,
      toEmail: input.toEmail,
      variables: {
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
  } finally {
    await db.destroy();
  }
}
