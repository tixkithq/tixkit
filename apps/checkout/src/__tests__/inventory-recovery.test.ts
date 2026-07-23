import { describe, expect, it } from 'vitest';
import type { AvailabilityItem } from '@/lib/api';
import {
  isInventoryConflictCode,
  planFromInventoryErrorDetails,
  planInventoryRecovery,
} from '@/lib/inventory-recovery';

const general: AvailabilityItem = {
  type: 'ticket',
  ticketTypeId: 'tt_general',
  name: 'General Admission',
  kind: 'paid',
  priceCents: 2500,
  currency: 'USD',
  minPerOrder: 1,
  maxPerOrder: 4,
  available: 12,
  status: 'active',
};

const vip: AvailabilityItem = {
  type: 'ticket',
  ticketTypeId: 'tt_vip',
  name: 'VIP',
  kind: 'paid',
  priceCents: 7500,
  currency: 'USD',
  minPerOrder: 1,
  maxPerOrder: 2,
  available: 2,
  status: 'active',
};

describe('planInventoryRecovery', () => {
  it('flags a sold-out item without mutating other selections', () => {
    const plan = planInventoryRecovery({
      quantities: {
        'ticket:tt_general:event': 2,
        'ticket:tt_vip:event': 1,
      },
      availability: [general, { ...vip, status: 'sold_out', available: 0 }],
    });

    expect(plan.requiresAcknowledgement).toBe(true);
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unavailable',
          itemId: 'ticket:tt_vip:event',
          nextQuantity: 0,
        }),
      ]),
    );
    expect(plan.proposedQuantities['ticket:tt_general:event']).toBe(2);
    expect(plan.proposedQuantities['ticket:tt_vip:event']).toBe(0);
  });

  it('reduces quantity when availability shrinks', () => {
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 4 },
      availability: [{ ...general, available: 1 }],
    });

    expect(plan.changes[0]).toMatchObject({
      kind: 'quantity_reduced',
      previousQuantity: 4,
      nextQuantity: 1,
    });
    expect(plan.proposedQuantities['ticket:tt_general:event']).toBe(1);
  });

  it('requires acknowledgement when the quote total changes', () => {
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1 },
      availability: [general],
      previousQuote: {
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 2500,
      },
      nextQuote: {
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 200,
        feeCents: 100,
        totalCents: 2800,
      },
    });

    expect(plan.requiresAcknowledgement).toBe(true);
    expect(plan.changes.some((c) => c.kind === 'quote_changed')).toBe(true);
    expect(plan.proposedQuantities['ticket:tt_general:event']).toBe(1);
  });

  it('marks invalid occurrence-bound items', () => {
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:occ_1': 1 },
      availability: [
        {
          ...general,
          eventOccurrenceId: 'occ_1',
          status: 'unavailable',
        },
      ],
    });

    expect(
      plan.changes.some((c) => c.kind === 'occurrence_invalid' || c.kind === 'unavailable'),
    ).toBe(true);
    expect(plan.proposedQuantities['ticket:tt_general:occ_1']).toBe(0);
  });
});

describe('planFromInventoryErrorDetails', () => {
  it('maps structured inventory details onto the matching cart line', () => {
    const plan = planFromInventoryErrorDetails(
      { ticketTypeId: 'tt_general', requested: 3, available: 1 },
      { 'ticket:tt_general:event': 3, 'ticket:tt_vip:event': 1 },
      [general, vip],
    );

    expect(plan?.focusItemId).toBe('ticket:tt_general:event');
    expect(plan?.proposedQuantities['ticket:tt_general:event']).toBe(1);
    expect(plan?.proposedQuantities['ticket:tt_vip:event']).toBe(1);
  });
});

describe('isInventoryConflictCode', () => {
  it('recognizes inventory and selection conflict codes', () => {
    expect(isInventoryConflictCode('INVENTORY_EXHAUSTED')).toBe(true);
    expect(isInventoryConflictCode('HOLD_EXPIRED')).toBe(true);
    expect(isInventoryConflictCode('CONFLICT')).toBe(true);
    expect(isInventoryConflictCode('PAYMENT_FAILED')).toBe(false);
  });
});
