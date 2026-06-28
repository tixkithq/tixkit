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
  compensations: [] as Record<string, unknown>[],
  updates: [] as Array<{ table: string; id: string; input: Record<string, unknown> }>,
  timeline: [] as Array<{ orderId: string; type: string; description: string }>,
}));

vi.mock('../activities/checkout.js', () => ({
  compensateOrphanPaymentActivity: async (input: Record<string, unknown>) => {
    mockState.compensations.push(input);
    return { ok: true, value: { status: 'succeeded', action: 'refund', compensationId: 'pcmp_1' } };
  },
}));

vi.mock('@tixkit/db', () => ({
  createDb: () => mockState.db,
  PaymentIntentRepository: class {
    async findByProviderAndIntentId() {
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
      mockState.order = { ...(mockState.order ?? {}), ...input };
      return mockState.order;
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
        status: input.status ?? 'pending',
        reason: input.reason,
      };
      mockState.refunds.push(refund);
      return refund;
    }
  },
}));

import {
  reconcilePaymentActivity,
  reconcileRefundActivity,
} from '../activities/payment-reconciliation.js';

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
    mockState.compensations = [];
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

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'requires_payment_method' },
    });
    expect(mockState.updates).toContainEqual({
      table: 'payment_intents',
      id: 'pi_db_1',
      input: { status: 'requires_payment_method' },
    });
    expect(
      mockState.updates.some(
        (update) => update.table === 'orders' && update.input.status === 'paid',
      ),
    ).toBe(false);
    expect(mockState.timeline).toContainEqual({
      orderId: 'ord_1',
      type: 'payment.failed',
      description: 'Payment failed via Stripe',
    });
  });

  it('marks an order paid for a succeeded payment intent', async () => {
    mockState.order = {
      ...(mockState.order ?? {}),
      status: 'pending_payment',
    };

    const result = await reconcilePaymentActivity({
      providerEventId: 'evt_success',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_provider_1', status: 'succeeded' },
    });

    expect(result).toMatchObject({ ok: true, value: { orderId: 'ord_1', status: 'paid' } });
    expect(
      mockState.updates.some(
        (update) => update.table === 'orders' && update.input.status === 'paid',
      ),
    ).toBe(true);
    expect(mockState.updates).toContainEqual({
      table: 'orders',
      id: 'ord_1',
      input: { status: 'paid', paid_at: expect.any(Date) },
    });
    expect(mockState.timeline).toContainEqual({
      orderId: 'ord_1',
      type: 'order.paid',
      description: 'Payment confirmed via Stripe',
    });
  });

  it.each(['refunded', 'partially_refunded', 'cancelled', 'expired', 'disputed'])(
    'does not move a %s order back to paid for a succeeded payment intent',
    async (status) => {
      mockState.order = {
        ...(mockState.order ?? {}),
        status,
        paid_at: new Date('2026-01-01T00:00:00.000Z'),
      };

      const result = await reconcilePaymentActivity({
        providerEventId: `evt_success_${status}`,
        provider: 'stripe',
        eventType: 'payment_intent.succeeded',
        data: { id: 'pi_provider_1', status: 'succeeded' },
      });

      expect(result).toMatchObject({
        ok: true,
        value: { orderId: 'ord_1', status: 'succeeded' },
      });
      expect(mockState.updates).toContainEqual({
        table: 'payment_intents',
        id: 'pi_db_1',
        input: { status: 'succeeded' },
      });
      expect(mockState.updates.some((update) => update.table === 'orders')).toBe(false);
      expect(mockState.timeline.some((event) => event.type === 'order.paid')).toBe(false);
    },
  );

  it('does not add a duplicate paid timeline entry for an already paid order', async () => {
    mockState.order = {
      ...(mockState.order ?? {}),
      status: 'paid',
      paid_at: new Date('2026-01-01T00:00:00.000Z'),
    };

    const result = await reconcilePaymentActivity({
      providerEventId: 'evt_success_paid',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_provider_1', status: 'succeeded' },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'succeeded' },
    });
    expect(mockState.updates).toContainEqual({
      table: 'payment_intents',
      id: 'pi_db_1',
      input: { status: 'succeeded' },
    });
    expect(mockState.updates.some((update) => update.table === 'orders')).toBe(false);
    expect(mockState.timeline.some((event) => event.type === 'order.paid')).toBe(false);
  });

  it('compensates a succeeded payment intent when no order is attached', async () => {
    mockState.paymentIntent = {
      id: 'pi_db_1',
      tenant_id: 'tnt_1',
      order_id: null,
      checkout_session_id: 'cs_1',
      provider: 'stripe',
      provider_intent_id: 'pi_provider_1',
      amount_cents: 10000,
      currency: 'USD',
      status: 'requires_payment_method',
    };

    const result = await reconcilePaymentActivity({
      providerEventId: 'evt_orphan_success',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_provider_1', status: 'succeeded' },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: undefined, status: 'compensated:succeeded' },
    });
    expect(mockState.compensations).toContainEqual({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_provider_1',
      amountCents: 10000,
      currency: 'USD',
      reason: 'Successful provider payment has no durable order attached',
      providerEventId: 'evt_orphan_success',
      eventType: 'payment_intent.succeeded',
      providerStatus: 'succeeded',
      source: 'payment_reconciliation',
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
    mockState.compensations = [];
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
      eventType: 'refund.created',
      data: { id: 're_1', payment_intent: 'pi_provider_1', amount: 5000 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'partially_refunded' },
    });
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

  it.each(['failed', 'pending'])(
    'does not record a %s refund payload as a successful refund',
    async (status) => {
      const result = await reconcileRefundActivity({
        providerEventId: `evt_refund_${status}`,
        provider: 'stripe',
        eventType: 'refund.updated',
        data: { id: `re_${status}`, payment_intent: 'pi_provider_1', amount: 5000, status },
      });

      expect(result).toMatchObject({
        ok: true,
        value: { orderId: 'ord_1', status: 'paid' },
      });
      expect(mockState.createdRefunds).toHaveLength(0);
      expect(
        mockState.updates.some(
          (update) =>
            update.table === 'orders' && 'refunded_cents' in update.input,
        ),
      ).toBe(false);
      expect(mockState.updates.some((update) => update.table === 'invoices')).toBe(false);
      expect(mockState.timeline.some((event) => event.type === 'order.refunded')).toBe(false);
    },
  );

  it('does not record a failed refund event with no payload status as a successful refund', async () => {
    const result = await reconcileRefundActivity({
      providerEventId: 'evt_refund_failed_no_status',
      provider: 'stripe',
      eventType: 'refund.failed',
      data: { id: 're_failed_no_status', payment_intent: 'pi_provider_1', amount: 5000 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'paid' },
    });
    expect(mockState.createdRefunds).toHaveLength(0);
    expect(
      mockState.updates.some(
        (update) => update.table === 'orders' && 'refunded_cents' in update.input,
      ),
    ).toBe(false);
    expect(mockState.updates.some((update) => update.table === 'invoices')).toBe(false);
    expect(mockState.timeline.some((event) => event.type === 'order.refunded')).toBe(false);
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
      eventType: 'charge.refunded',
      data: { id: 'ch_1', payment_intent: 'pi_provider_1', amount_refunded: 5000 },
    });

    expect(result).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'partially_refunded' },
    });
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

  it('does not double count a refund object after a cumulative charge refund event', async () => {
    const chargeResult = await reconcileRefundActivity({
      providerEventId: 'evt_charge_refunded_first',
      provider: 'stripe',
      eventType: 'charge.refunded',
      data: { id: 'ch_1', payment_intent: 'pi_provider_1', amount_refunded: 5000 },
    });

    expect(chargeResult).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'partially_refunded' },
    });
    expect(mockState.createdRefunds).toHaveLength(0);
    expect(mockState.refunds).toHaveLength(0);
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

    const refundResult = await reconcileRefundActivity({
      providerEventId: 'evt_refund_object_after_charge',
      provider: 'stripe',
      eventType: 'refund.created',
      data: { id: 're_1', payment_intent: 'pi_provider_1', amount: 5000, status: 'succeeded' },
    });

    expect(refundResult).toMatchObject({
      ok: true,
      value: { orderId: 'ord_1', status: 'partially_refunded' },
    });
    expect(mockState.createdRefunds).toHaveLength(1);
    expect(mockState.createdRefunds).toContainEqual(
      expect.objectContaining({
        providerRefundId: 're_1',
        amountCents: 5000,
        status: 'succeeded',
      }),
    );
    expect(mockState.refunds).toHaveLength(1);
    expect(mockState.order).toMatchObject({
      refunded_cents: 5000,
      status: 'partially_refunded',
    });
    expect(
      mockState.updates
        .filter((update) => update.table === 'orders')
        .map((update) => update.input.refunded_cents),
    ).not.toContain(10000);
    expect(mockState.timeline).toContainEqual({
      orderId: 'ord_1',
      type: 'order.refunded',
      description: 'Refunded 5000 cents via Stripe',
    });
  });
});
