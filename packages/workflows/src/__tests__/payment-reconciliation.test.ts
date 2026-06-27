import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  db: {
    destroy: async () => undefined,
    updateTable: (table: string) => ({
      set: (input: Record<string, unknown>) => ({
        where: (_column: string, _operator: string, id: string) => ({
          execute: async () => {
            mockState.updates.push({ table, id, input });
          },
        }),
      }),
    }),
  },
  paymentIntent: undefined as Record<string, unknown> | undefined,
  order: undefined as Record<string, unknown> | undefined,
  refunds: [] as Record<string, unknown>[],
  createdRefunds: [] as Record<string, unknown>[],
  updates: [] as Array<{ table: string; id: string; input: Record<string, unknown> }>,
  timeline: [] as Array<{ orderId: string; type: string; description: string }>,
}));

vi.mock('@tixkit/db', () => ({
  createDb: () => mockState.db,
  PaymentIntentRepository: class {
    async findByProviderIntentId() {
      return mockState.paymentIntent;
    }

    async update(id: string, input: Record<string, unknown>) {
      mockState.updates.push({ table: 'payment_intents', id, input });
      return { ...mockState.paymentIntent, ...input };
    }
  },
  OrderRepository: class {
    async findById() {
      return mockState.order;
    }

    async update(id: string, input: Record<string, unknown>) {
      mockState.updates.push({ table: 'orders', id, input });
      return { ...mockState.order, ...input };
    }

    async addTimelineEvent(orderId: string, type: string, description: string) {
      mockState.timeline.push({ orderId, type, description });
    }
  },
  RefundRepository: class {
    async findByOrder() {
      return mockState.refunds;
    }

    async create(input: Record<string, unknown>) {
      mockState.createdRefunds.push(input);
      const refund = {
        id: `ref_${mockState.createdRefunds.length}`,
        order_id: input.orderId,
        provider_refund_id: input.providerRefundId,
        amount_cents: input.amountCents,
        status: 'succeeded',
        reason: input.reason,
      };
      mockState.refunds.push(refund);
      return refund;
    }
  },
}));

import { reconcilePaymentActivity, reconcileRefundActivity } from '../activities/payment-reconciliation.js';

describe('reconcilePaymentActivity', () => {
  beforeEach(() => {
    mockState.paymentIntent = {
      id: 'pi_db_1',
      order_id: 'ord_1',
      status: 'requires_payment_method',
    };
    mockState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 0,
      currency: 'USD',
      status: 'pending_payment',
    };
    mockState.refunds = [];
    mockState.createdRefunds = [];
    mockState.updates = [];
    mockState.timeline = [];
  });

  it('does not mark an order paid for a failed payment intent', async () => {
    const result = await reconcilePaymentActivity({
      providerEventId: 'evt_fail',
      provider: 'stripe',
      eventType: 'payment_intent.payment_failed',
      data: { id: 'pi_provider_1', status: 'requires_payment_method' },
    });

    expect(result).toMatchObject({ ok: true, value: { orderId: 'ord_1', status: 'requires_payment_method' } });
    expect(mockState.updates).toContainEqual({
      table: 'payment_intents',
      id: 'pi_db_1',
      input: { status: 'requires_payment_method' },
    });
    expect(mockState.updates.some((update) => update.table === 'orders' && update.input.status === 'paid')).toBe(false);
    expect(mockState.timeline).toContainEqual({
      orderId: 'ord_1',
      type: 'payment.failed',
      description: 'Payment failed via Stripe',
    });
  });

  it('marks an order paid for a succeeded payment intent', async () => {
    const result = await reconcilePaymentActivity({
      providerEventId: 'evt_success',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_provider_1', status: 'succeeded' },
    });

    expect(result).toMatchObject({ ok: true, value: { orderId: 'ord_1', status: 'paid' } });
    expect(mockState.updates.some((update) => update.table === 'orders' && update.input.status === 'paid')).toBe(true);
    expect(mockState.timeline).toContainEqual({
      orderId: 'ord_1',
      type: 'order.paid',
      description: 'Payment confirmed via Stripe',
    });
  });
});

describe('reconcileRefundActivity', () => {
  beforeEach(() => {
    mockState.paymentIntent = {
      id: 'pi_db_1',
      order_id: 'ord_1',
      provider_intent_id: 'pi_provider_1',
      status: 'succeeded',
    };
    mockState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      total_cents: 10000,
      refunded_cents: 0,
      currency: 'USD',
      status: 'paid',
    };
    mockState.refunds = [];
    mockState.createdRefunds = [];
    mockState.updates = [];
    mockState.timeline = [];
  });

  it('deduplicates provider refund replay and repairs stale order refund totals', async () => {
    mockState.refunds = [
      {
        id: 'ref_existing',
        order_id: 'ord_1',
        provider_refund_id: 're_1',
        amount_cents: 5000,
        status: 'succeeded',
      },
    ];

    const result = await reconcileRefundActivity({
      providerEventId: 'evt_refund_1',
      provider: 'stripe',
      data: { id: 're_1', payment_intent: 'pi_provider_1', amount: 5000 },
    });

    expect(result).toMatchObject({ ok: true, value: { orderId: 'ord_1', status: 'partially_refunded' } });
    expect(mockState.createdRefunds).toHaveLength(0);
    expect(mockState.updates).toContainEqual({
      table: 'orders',
      id: 'ord_1',
      input: expect.objectContaining({ refunded_cents: 5000, status: 'partially_refunded' }),
    });
    expect(mockState.updates).toContainEqual({
      table: 'invoices',
      id: 'ord_1',
      input: expect.objectContaining({ refunded_cents: 5000 }),
    });
    expect(mockState.timeline).toHaveLength(0);
  });

  it('repairs cumulative charge refund replay when no new refund delta remains', async () => {
    mockState.refunds = [
      {
        id: 'ref_existing',
        order_id: 'ord_1',
        provider_refund_id: 'ch_1:5000',
        amount_cents: 5000,
        status: 'succeeded',
      },
    ];

    const result = await reconcileRefundActivity({
      providerEventId: 'evt_charge_refunded_1',
      provider: 'stripe',
      data: { id: 'ch_1', payment_intent: 'pi_provider_1', amount_refunded: 5000 },
    });

    expect(result).toMatchObject({ ok: true, value: { orderId: 'ord_1', status: 'partially_refunded' } });
    expect(mockState.createdRefunds).toHaveLength(0);
    expect(mockState.updates).toContainEqual({
      table: 'orders',
      id: 'ord_1',
      input: expect.objectContaining({ refunded_cents: 5000, status: 'partially_refunded' }),
    });
    expect(mockState.updates).toContainEqual({
      table: 'invoices',
      id: 'ord_1',
      input: expect.objectContaining({ refunded_cents: 5000 }),
    });
    expect(mockState.timeline).toHaveLength(0);
  });
});
