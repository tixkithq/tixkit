import { describe, expect, it } from 'vitest';

// Set the checkout base URL before importing the helper so the module-level
// constant resolves to a deterministic value.
process.env.CHECKOUT_URL = 'https://checkout.test';
const {
  buildEventContext,
  buildBrandContext,
  buildRecipientContext,
  buildOrderContext,
  buildRefundContext,
  buildTicketContext,
  buildTransactionalMergeTagContext,
} = await import('../activities/messaging-context.js');

const order = {
  id: 'ord_1',
  order_number: 'TK-1001',
  total_cents: 4500,
  refunded_cents: 2000,
  currency: 'USD',
  buyer_email: 'jordan@example.test',
  buyer_first_name: 'Jordan',
  buyer_last_name: 'Lee',
  buyer_phone: '+15551234567',
};

const event = {
  id: 'evt_1',
  title: 'Founders Summit',
  starts_at: new Date('2027-05-12T18:30:00.000Z'),
  timezone: 'America/New_York',
  venue: JSON.stringify({ name: 'Main Hall', city: 'New York' }),
};

describe('buildEventContext', () => {
  it('parses venue json and builds hosted checkout urls', () => {
    const ctx = buildEventContext(event);
    expect(ctx).toMatchObject({
      title: 'Founders Summit',
      venueName: 'Main Hall',
      venueCity: 'New York',
      timezone: 'America/New_York',
    });
    expect(ctx?.startsAt).toBe('2027-05-12T18:30:00.000Z');
    expect(ctx?.publicUrl).toBe('https://checkout.test/e/evt_1');
    expect(ctx?.checkoutUrl).toContain('eventId=evt_1');
  });

  it('returns undefined for a missing event', () => {
    expect(buildEventContext(null)).toBeUndefined();
    expect(buildEventContext(undefined)).toBeUndefined();
  });
});

describe('buildBrandContext', () => {
  it('reads the durable logo URL from an object theme', () => {
    expect(
      buildBrandContext({
        id: 'brd_1',
        name: 'Northstar Events',
        theme: { logoUrl: 'https://assets.example.test/northstar.png' },
      }),
    ).toEqual({
      name: 'Northstar Events',
      logoUrl: 'https://assets.example.test/northstar.png',
    });
  });

  it('accepts JSON database themes and ignores malformed themes', () => {
    expect(
      buildBrandContext({
        id: 'brd_1',
        name: 'Northstar Events',
        theme: '{"logoUrl":"https://assets.example.test/northstar.png"}',
      })?.logoUrl,
    ).toBe('https://assets.example.test/northstar.png');
    expect(
      buildBrandContext({ id: 'brd_1', name: 'Northstar Events', theme: '{' })?.logoUrl,
    ).toBeUndefined();
  });
});

describe('buildRecipientContext', () => {
  it('joins buyer first and last name', () => {
    expect(buildRecipientContext(order)).toEqual({
      name: 'Jordan Lee',
      email: 'jordan@example.test',
      phone: '+15551234567',
    });
  });

  it('leaves name undefined when no buyer names are stored', () => {
    const ctx = buildRecipientContext({
      ...order,
      buyer_first_name: null,
      buyer_last_name: null,
    });
    expect(ctx?.name).toBeUndefined();
    expect(ctx?.email).toBe('jordan@example.test');
  });
});

describe('buildOrderContext', () => {
  it('formats the order total and uses the human-readable order number', () => {
    expect(buildOrderContext(order)).toMatchObject({
      id: 'TK-1001',
      total: '$45.00',
      buyerName: 'Jordan Lee',
      buyerEmail: 'jordan@example.test',
    });
  });
});

describe('buildRefundContext', () => {
  it('uses the specific refund row amount and processed timestamp when succeeded', () => {
    expect(
      buildRefundContext(
        {
          amount_cents: 2000,
          currency: 'USD',
          status: 'succeeded',
          created_at: new Date('2027-01-15T10:00:00.000Z'),
        },
        order,
      ),
    ).toEqual({
      amount: '$20.00',
      processedAt: '2027-01-15T10:00:00.000Z',
    });
  });

  it('falls back to the order refunded_cents when no refund row is present', () => {
    expect(buildRefundContext(null, order)?.amount).toBe('$20.00');
  });

  it('returns undefined when there is no refund amount', () => {
    expect(buildRefundContext(null, { ...order, refunded_cents: 0 })).toBeUndefined();
    expect(
      buildRefundContext(
        { amount_cents: 0, currency: 'USD', status: 'pending', created_at: null },
        order,
      ),
    ).toBeUndefined();
  });
});

describe('buildTicketContext', () => {
  it('maps apple and google wallet pass urls for the matching ticket', () => {
    expect(
      buildTicketContext(
        { id: 'tkt_1', code: 'TK-ABC123', ticket_type_id: 'tt_1' },
        'General Admission',
        [
          {
            ticketId: 'tkt_1',
            provider: 'apple',
            passUrl: 'https://passes.test/apple/tkt_1.pkpass',
          },
          {
            ticketId: 'tkt_1',
            provider: 'google',
            passUrl: 'https://pay.google.com/gp/v/save/abc',
          },
          {
            ticketId: 'tkt_2',
            provider: 'apple',
            passUrl: 'https://passes.test/apple/tkt_2.pkpass',
          },
        ],
      ),
    ).toEqual({
      type: 'General Admission',
      code: 'TK-ABC123',
      walletAppleUrl: 'https://passes.test/apple/tkt_1.pkpass',
      walletGoogleUrl: 'https://pay.google.com/gp/v/save/abc',
    });
  });

  it('leaves wallet urls undefined when no pass links match', () => {
    const ctx = buildTicketContext(
      { id: 'tkt_1', code: 'TK-ABC123', ticket_type_id: 'tt_1' },
      'General Admission',
      [],
    );
    expect(ctx?.walletAppleUrl).toBeUndefined();
    expect(ctx?.walletGoogleUrl).toBeUndefined();
    expect(ctx?.code).toBe('TK-ABC123');
  });

  it('returns undefined for a missing ticket', () => {
    expect(buildTicketContext(null, 'GA', [])).toBeUndefined();
  });
});

describe('buildTransactionalMergeTagContext', () => {
  it('assembles event/brand/recipient/order/refund/ticket context', () => {
    expect(
      buildTransactionalMergeTagContext({
        order,
        event,
        brand: { id: 'brd_1', name: 'Northstar Events' },
        refund: {
          amount_cents: 2000,
          currency: 'USD',
          status: 'succeeded',
          created_at: new Date('2027-01-15T10:00:00.000Z'),
        },
        ticket: { id: 'tkt_1', code: 'TK-ABC123', ticket_type_id: 'tt_1' },
        ticketTypeName: 'General Admission',
        walletPassLinks: [
          { ticketId: 'tkt_1', provider: 'apple', passUrl: 'https://passes.test/a.pkpass' },
        ],
      }),
    ).toMatchObject({
      event: { title: 'Founders Summit', venueName: 'Main Hall' },
      brand: { name: 'Northstar Events' },
      recipient: { name: 'Jordan Lee' },
      order: { id: 'TK-1001', total: '$45.00' },
      refund: { amount: '$20.00' },
      ticket: {
        type: 'General Admission',
        code: 'TK-ABC123',
        walletAppleUrl: 'https://passes.test/a.pkpass',
      },
    });
  });
});
