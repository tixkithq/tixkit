import { describe, expect, it } from 'vitest';
import type { AdminTicketType } from '@/lib/api';
import {
  buildFeePolicyExamples,
  feePolicyFormSchema,
  feePolicyToValues,
  feePolicyValuesToInput,
} from './event-fee-policy-card';

const ticketTypes: AdminTicketType[] = [
  {
    id: 'tt_ga',
    eventId: 'evt_1',
    name: 'General Admission',
    kind: 'paid',
    status: 'active',
    visibility: 'public',
    currency: 'USD',
    priceCents: 5000,
    quantityTotal: 100,
    quantitySold: 10,
    minPerOrder: 1,
    maxPerOrder: 8,
    inventoryPoolId: 'pool_1',
    requiresAccessCode: false,
    sortOrder: 0,
  },
];

describe('feePolicyFormSchema', () => {
  it('accepts buyer-paid percentage fee rules', () => {
    const result = feePolicyFormSchema.safeParse({
      passFeesToBuyer: true,
      rules: [
        {
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects percentage rules over 100%', () => {
    const result = feePolicyFormSchema.safeParse({
      passFeesToBuyer: true,
      rules: [
        {
          name: 'Service fee',
          type: 'percentage',
          value: 10_001,
          appliedTo: 'per_ticket',
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('value'))).toBe(true);
    }
  });

  it('converts saved policy rows into update input without absorbIntoPrice', () => {
    const values = feePolicyToValues({
      eventId: 'evt_1',
      eventVersion: 1,
      passFeesToBuyer: false,
      rules: [
        {
          id: 'fee_1',
          eventId: 'evt_1',
          name: 'Organizer fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
          absorbIntoPrice: true,
        },
      ],
    });

    expect(feePolicyValuesToInput(values)).toEqual({
      expectedVersion: 1,
      passFeesToBuyer: false,
      rules: [
        {
          id: 'fee_1',
          name: 'Organizer fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
        },
      ],
    });
  });
});

describe('buildFeePolicyExamples', () => {
  it('adds buyer-paid fees to the buyer total', () => {
    expect(
      buildFeePolicyExamples(ticketTypes, {
        passFeesToBuyer: true,
        rules: [
          {
            name: 'Service fee',
            type: 'percentage',
            value: 500,
            appliedTo: 'per_ticket',
          },
          {
            name: 'Order fee',
            type: 'fixed',
            value: 125,
            appliedTo: 'per_order',
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        ticketTypeId: 'tt_ga',
        priceCents: 5000,
        platformFeeCents: 175,
        serviceFeeCents: 375,
        totalFeeCents: 550,
        buyerFeeCents: 550,
        organizerAbsorbedFeeCents: 0,
        buyerTotalCents: 5550,
        organizerNetCents: 5000,
      }),
    ]);
  });

  it('keeps organizer-absorbed fees out of the buyer total', () => {
    expect(
      buildFeePolicyExamples(ticketTypes, {
        passFeesToBuyer: false,
        rules: [
          {
            name: 'Service fee',
            type: 'percentage',
            value: 500,
            appliedTo: 'per_ticket',
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        platformFeeCents: 175,
        serviceFeeCents: 250,
        totalFeeCents: 425,
        buyerFeeCents: 0,
        organizerAbsorbedFeeCents: 425,
        buyerTotalCents: 5000,
        organizerNetCents: 4575,
      }),
    ]);
  });
});
