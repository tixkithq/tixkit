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

  it('requires acknowledgement when quote components change without changing the total', () => {
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
        subtotalCents: 2400,
        discountCents: 0,
        taxCents: 0,
        feeCents: 100,
        totalCents: 2500,
      },
    });

    expect(plan.requiresAcknowledgement).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        kind: 'quote_changed',
        previousTotalCents: 2500,
        nextTotalCents: 2500,
      }),
    );
  });

  it('does not flag unchanged server quote lines merely because a local preview omitted components', () => {
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1 },
      availability: [general],
      previousQuote: {
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 2500,
        lineItems: [
          {
            ticketTypeId: 'tt_general',
            description: 'General Admission',
            quantity: 1,
            unitPriceCents: 2500,
            totalCents: 2500,
          },
        ],
      },
      nextQuote: {
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 2500,
        lineItems: [
          {
            ticketTypeId: 'tt_general',
            description: 'General Admission',
            quantity: 1,
            unitPriceCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
            buyerFeeCents: 0,
            organizerAbsorbedFeeCents: 0,
            totalCents: 2500,
          },
        ],
      },
    });

    expect(plan.requiresAcknowledgement).toBe(false);
    expect(plan.changes).toEqual([]);
  });

  it('still flags equal-total component drift when both real quote lines provide the components', () => {
    const baseQuote = {
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
    };
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1 },
      availability: [general],
      previousQuote: {
        ...baseQuote,
        lineItems: [
          {
            ticketTypeId: 'tt_general',
            description: 'General Admission',
            quantity: 1,
            unitPriceCents: 2500,
            subtotalCents: 2500,
            feeCents: 0,
            totalCents: 2500,
          },
        ],
      },
      nextQuote: {
        ...baseQuote,
        lineItems: [
          {
            ticketTypeId: 'tt_general',
            description: 'General Admission',
            quantity: 1,
            unitPriceCents: 2500,
            subtotalCents: 2400,
            feeCents: 100,
            totalCents: 2500,
          },
        ],
      },
    });

    expect(plan.requiresAcknowledgement).toBe(true);
    expect(plan.changes).toContainEqual(expect.objectContaining({ kind: 'quote_changed' }));
  });

  it('does not treat reordered equivalent quote lines as a change', () => {
    const previousQuote = {
      subtotalCents: 10000,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 10000,
      lineItems: [
        {
          ticketTypeId: 'tt_general',
          description: 'General Admission',
          quantity: 1,
          unitPriceCents: 2500,
          subtotalCents: 2500,
          totalCents: 2500,
        },
        {
          ticketTypeId: 'tt_vip',
          description: 'VIP',
          quantity: 1,
          unitPriceCents: 7500,
          subtotalCents: 7500,
          totalCents: 7500,
        },
      ],
    };
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1, 'ticket:tt_vip:event': 1 },
      availability: [general, vip],
      previousQuote,
      nextQuote: {
        ...previousQuote,
        lineItems: [
          { ...previousQuote.lineItems[1]!, description: 'VIP ticket' },
          { ...previousQuote.lineItems[0]!, description: 'General ticket' },
        ],
      },
    });

    expect(plan.requiresAcknowledgement).toBe(false);
    expect(plan.changes).toEqual([]);
  });

  it('reports a selected item price change from its prior quote line', () => {
    const quote = {
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
      lineItems: [
        {
          ticketTypeId: 'tt_general',
          description: 'General Admission',
          quantity: 1,
          unitPriceCents: 2500,
          totalCents: 2500,
        },
      ],
    };
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1 },
      availability: [{ ...general, priceCents: 2600 }],
      previousQuote: quote,
      nextQuote: quote,
    });

    expect(plan.requiresAcknowledgement).toBe(true);
    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        kind: 'price_changed',
        itemId: 'ticket:tt_general:event',
        previousPriceCents: 2500,
        nextPriceCents: 2600,
      }),
    );
  });

  it('matches a price change to its exact occurrence before using legacy ticket-type fallback', () => {
    const firstOccurrence = { ...general, eventOccurrenceId: 'occ_1', priceCents: 2500 };
    const secondOccurrence = { ...general, eventOccurrenceId: 'occ_2', priceCents: 3200 };
    const plan = planInventoryRecovery({
      quantities: {
        'ticket:tt_general:occ_1': 1,
        'ticket:tt_general:occ_2': 1,
      },
      availability: [firstOccurrence, secondOccurrence],
      previousQuote: {
        subtotalCents: 5000,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5000,
        lineItems: [
          {
            ticketTypeId: 'tt_general',
            eventOccurrenceId: 'occ_1',
            description: 'First performance',
            quantity: 1,
            unitPriceCents: 2500,
            totalCents: 2500,
          },
          {
            ticketTypeId: 'tt_general',
            eventOccurrenceId: 'occ_2',
            description: 'Second performance',
            quantity: 1,
            unitPriceCents: 2500,
            totalCents: 2500,
          },
        ],
      },
      nextQuote: {
        subtotalCents: 5000,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5000,
      },
    });

    expect(plan.changes).toContainEqual(
      expect.objectContaining({
        kind: 'price_changed',
        itemId: 'ticket:tt_general:occ_2',
        previousPriceCents: 2500,
        nextPriceCents: 3200,
      }),
    );
    expect(plan.changes).not.toContainEqual(
      expect.objectContaining({ kind: 'price_changed', itemId: 'ticket:tt_general:occ_1' }),
    );
  });

  it('leaves an unchanged quote unacknowledged', () => {
    const quote = {
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
      lineItems: [
        {
          ticketTypeId: 'tt_general',
          description: 'General Admission',
          quantity: 1,
          unitPriceCents: 2500,
          totalCents: 2500,
        },
      ],
    };
    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_general:event': 1 },
      availability: [general],
      previousQuote: quote,
      nextQuote: { ...quote, lineItems: [...quote.lineItems] },
    });

    expect(plan.requiresAcknowledgement).toBe(false);
    expect(plan.changes).toEqual([]);
  });

  it('does not misclassify a buyer-selected donation amount as a price change', () => {
    const donation = { ...general, ticketTypeId: 'tt_donation', kind: 'donation' as const };
    const quote = {
      subtotalCents: 5000,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 5000,
      lineItems: [
        {
          ticketTypeId: 'tt_donation',
          description: 'Donation',
          quantity: 1,
          unitAmountCents: 5000,
          totalCents: 5000,
        },
      ],
    };

    const plan = planInventoryRecovery({
      quantities: { 'ticket:tt_donation:event': 1 },
      availability: [donation],
      previousQuote: quote,
      nextQuote: quote,
    });

    expect(plan.requiresAcknowledgement).toBe(false);
    expect(plan.changes).toEqual([]);
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

  it('fails closed when occurrence-less details match multiple selected performances', () => {
    const plan = planFromInventoryErrorDetails(
      { ticketTypeId: 'tt_general', requested: 1, available: 0 },
      {
        'ticket:tt_general:occ_1': 1,
        'ticket:tt_general:occ_2': 1,
      },
      [
        { ...general, eventOccurrenceId: 'occ_1' },
        { ...general, eventOccurrenceId: 'occ_2' },
      ],
    );

    expect(plan?.requiresAcknowledgement).toBe(true);
    expect(plan?.focusItemId).toBe('ticket:tt_general:occ_1');
    expect(plan?.proposedQuantities).toEqual({
      'ticket:tt_general:occ_1': 0,
      'ticket:tt_general:occ_2': 0,
    });
    expect(plan?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'occurrence_invalid',
          itemId: 'ticket:tt_general:occ_1',
          nextQuantity: 0,
        }),
        expect.objectContaining({
          kind: 'occurrence_invalid',
          itemId: 'ticket:tt_general:occ_2',
          nextQuantity: 0,
        }),
      ]),
    );
  });

  it.each(['pool_shared', 'occ_1'])(
    'returns null for backend ticket identifier %s with no selected cart match',
    (ticketTypeId) => {
      const quantities = {
        'ticket:tt_general:occ_1': 1,
        'ticket:tt_vip:occ_2': 1,
      };
      const plan = planFromInventoryErrorDetails(
        { ticketTypeId, requested: 1, available: 0 },
        quantities,
        [
          { ...general, eventOccurrenceId: 'occ_1' },
          { ...vip, eventOccurrenceId: 'occ_2' },
        ],
      );

      expect(plan).toBeNull();
      expect(quantities).toEqual({
        'ticket:tt_general:occ_1': 1,
        'ticket:tt_vip:occ_2': 1,
      });
    },
  );
});

describe('isInventoryConflictCode', () => {
  it('recognizes inventory and selection conflict codes', () => {
    expect(isInventoryConflictCode('INVENTORY_EXHAUSTED')).toBe(true);
    expect(isInventoryConflictCode('HOLD_EXPIRED')).toBe(true);
    expect(isInventoryConflictCode('CONFLICT')).toBe(true);
    expect(isInventoryConflictCode('PAYMENT_FAILED')).toBe(false);
  });
});
