import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxOfficeOrderPanel } from './box-office-order-panel';

const adminApiMock = vi.hoisted(() => ({
  createBoxOfficeOrder: vi.fn(),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const ticketTypes = [
  {
    id: 'tt_ga',
    eventId: 'evt_1',
    eventOccurrenceId: 'occ_friday',
    name: 'Door GA',
    description: undefined,
    kind: 'paid' as const,
    status: 'active' as const,
    visibility: 'public' as const,
    currency: 'USD',
    priceCents: 2500,
    quantityTotal: 20,
    quantitySold: 4,
    minimumPriceCents: null,
    salesStartAt: undefined,
    salesEndAt: undefined,
    minPerOrder: 1,
    maxPerOrder: 4,
    inventoryPoolId: 'pool_1',
    requiresAccessCode: false,
    accessCodeHint: null,
    sortOrder: 0,
  },
];

const occurrences = [
  {
    id: 'occ_friday',
    eventId: 'evt_1',
    title: 'Friday night',
    startsAt: '2026-08-15T23:00:00.000Z',
    endsAt: '2026-08-16T03:00:00.000Z',
    timezone: 'America/New_York',
    venue: null,
    capacity: 500,
    sortOrder: 0,
    status: 'scheduled' as const,
  },
];

function renderPanel(
  onOrderCreated = vi.fn(),
  panelTicketTypes: typeof ticketTypes = ticketTypes,
  panelOccurrences: typeof occurrences = occurrences,
) {
  render(
    <BoxOfficeOrderPanel
      eventId="evt_1"
      ticketTypes={panelTicketTypes}
      occurrences={panelOccurrences}
      onOrderCreated={onOrderCreated}
    />,
  );
  return { onOrderCreated };
}

function fillBuyerAndAttendee() {
  fireEvent.change(screen.getByLabelText('Buyer first name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Buyer last name'), { target: { value: 'Lovelace' } });
  fireEvent.change(screen.getByLabelText('Buyer email'), {
    target: { value: 'ada@example.test' },
  });
  fireEvent.change(screen.getByLabelText('Attendee 1 first name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Attendee 1 last name'), {
    target: { value: 'Lovelace' },
  });
  fireEvent.change(screen.getByLabelText('Attendee 1 email'), {
    target: { value: 'ada@example.test' },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('BoxOfficeOrderPanel', () => {
  it('rejects cash tender when the entered amount does not match the ticket total', async () => {
    renderPanel();
    fillBuyerAndAttendee();
    fireEvent.change(screen.getByLabelText('Tender amount'), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue door order' }));

    expect(await screen.findByText('Tender amount must match $25.00.')).toBeInTheDocument();
    expect(adminApiMock.createBoxOfficeOrder).not.toHaveBeenCalled();
  });

  it('creates a cash door order with attendee fields and an admin API idempotency key', async () => {
    adminApiMock.createBoxOfficeOrder.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'cs_box',
        status: 'completed',
        order: {
          id: 'ord_box',
          eventId: 'evt_1',
          status: 'paid',
          totalCents: 2500,
          currency: 'USD',
        },
      },
    });
    const { onOrderCreated } = renderPanel();
    fillBuyerAndAttendee();
    fireEvent.change(screen.getByLabelText('Operator notes'), {
      target: { value: 'Drawer A cash sale' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue door order' }));

    await waitFor(() => {
      expect(adminApiMock.createBoxOfficeOrder).toHaveBeenCalledWith('evt_1', {
        idempotencyKey: expect.stringMatching(/^box_office_evt_1_/),
        tenderType: 'cash',
        amountCents: 2500,
        items: [
          {
            ticketTypeId: 'tt_ga',
            occurrenceId: 'occ_friday',
            quantity: 1,
            attendeeFields: [{ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' }],
          },
        ],
        buyer: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.test',
          phone: undefined,
        },
        notes: 'Drawer A cash sale',
      });
    });
    expect(onOrderCreated).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Order issued')).toBeInTheDocument();
    expect(screen.getByText('Order: ord_box')).toBeInTheDocument();
    expect(screen.getByText('Session: cs_box')).toBeInTheDocument();
  });

  it('omits blank occurrence ids from box-office order payloads', async () => {
    adminApiMock.createBoxOfficeOrder.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'cs_box',
        status: 'completed',
        order: {
          id: 'ord_box',
          eventId: 'evt_1',
          status: 'paid',
          totalCents: 2500,
          currency: 'USD',
        },
      },
    });
    renderPanel(vi.fn(), [{ ...ticketTypes[0], eventOccurrenceId: '' }], []);
    fillBuyerAndAttendee();
    fireEvent.click(screen.getByRole('button', { name: 'Issue door order' }));

    await waitFor(() => {
      expect(adminApiMock.createBoxOfficeOrder).toHaveBeenCalledWith(
        'evt_1',
        expect.objectContaining({
          items: [
            expect.not.objectContaining({
              occurrenceId: '',
            }),
          ],
        }),
      );
    });
  });

  it('issues comp orders with a zero amount and rendered result actions', async () => {
    adminApiMock.createBoxOfficeOrder.mockResolvedValue({
      ok: true,
      data: {
        sessionId: 'cs_comp',
        status: 'completed',
        order: {
          id: 'ord_comp',
          eventId: 'evt_1',
          status: 'paid',
          totalCents: 0,
          currency: 'USD',
        },
      },
    });
    renderPanel();
    fillBuyerAndAttendee();
    fireEvent.change(screen.getByLabelText('Tender'), { target: { value: 'comp' } });
    expect(screen.getByLabelText('Tender amount')).toHaveValue('0.00');
    fireEvent.click(screen.getByRole('button', { name: 'Issue door order' }));

    await waitFor(() => {
      expect(adminApiMock.createBoxOfficeOrder).toHaveBeenCalledWith(
        'evt_1',
        expect.objectContaining({
          tenderType: 'comp',
          amountCents: 0,
        }),
      );
    });
    expect(screen.getByRole('link', { name: 'Open order' })).toHaveAttribute(
      'href',
      '/orders/ord_comp',
    );
    expect(screen.getByRole('button', { name: 'Print receipt' })).toBeVisible();
  });
});
