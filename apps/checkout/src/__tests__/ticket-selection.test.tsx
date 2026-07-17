import './test-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TicketSelection } from '@/components/checkout/ticket-selection';
import type { AvailabilityItem } from '@/lib/api';

afterEach(cleanup);

describe('TicketSelection', () => {
  it('associates donation minimum errors with the amount input', () => {
    const itemId = 'ticket:ticket_donation:event';
    const donation: AvailabilityItem = {
      ticketTypeId: 'ticket_donation',
      name: 'Supporter donation',
      kind: 'donation',
      currency: 'USD',
      priceCents: 500,
      minimumPriceCents: 500,
      available: 100,
      minPerOrder: 1,
      maxPerOrder: 10,
      status: 'available',
    };
    const view = render(
      <TicketSelection
        tickets={[donation]}
        quantities={{ [itemId]: 0 }}
        donationAmounts={{ [itemId]: 100 }}
        loading={false}
        onDecrease={() => {}}
        onIncrease={() => {}}
      />,
    );

    const input = view.getByRole('spinbutton', {
      name: 'Donation amount for Supporter donation',
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Minimum $5.00');
    expect(view.getByText('Minimum $5.00').tagName).toBe('OUTPUT');

    view.rerender(
      <TicketSelection
        tickets={[donation]}
        quantities={{ [itemId]: 0 }}
        donationAmounts={{ [itemId]: 500 }}
        loading={false}
        onDecrease={() => {}}
        onIncrease={() => {}}
      />,
    );
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(view.queryByText('Minimum $5.00')).not.toBeInTheDocument();
  });
});
