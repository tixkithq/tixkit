import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOrderDetail } from '@/lib/api';
import { OrderDetailView, attendeeDisplayName } from './order-detail-view';

const orderState = vi.hoisted(() => ({
  data: undefined as unknown,
  loading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  });
}

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: () => orderState,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

vi.mock('@/components/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('./refund-dialog', () => ({
  RefundDialog: () => null,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    adminApi: {
      getOrder: vi.fn(),
      cancelOrder: vi.fn(),
    },
  };
});

function makeOrder(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  return {
    id: 'ord_1',
    eventId: 'evt_1',
    eventTitle: 'Launch Night',
    buyerName: 'Alice Buyer',
    buyerEmail: 'alice@example.test',
    status: 'partially_refunded',
    totalCents: 12_000,
    refundedCents: 3_000,
    currency: 'USD',
    attendeeCount: 2,
    paymentProvider: 'stripe',
    createdAt: '2026-01-01T10:00:00.000Z',
    paidAt: '2026-01-01T10:05:00.000Z',
    refundedAt: '2026-01-02T10:00:00.000Z',
    lineItems: [
      {
        id: 'oli_1',
        orderId: 'ord_1',
        ticketTypeId: 'tt_vip',
        description: 'VIP Ticket',
        quantity: 2,
        unitPriceCents: 6_000,
        subtotalCents: 12_000,
        discountCents: 1_000,
        taxCents: 800,
        feeCents: 400,
        totalCents: 12_200,
        currency: 'USD',
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:00.000Z',
      },
    ],
    attendees: [
      {
        id: 'att_1',
        orderId: 'ord_1',
        eventId: 'evt_1',
        ticketTypeId: 'tt_vip',
        ticketId: 'tkt_1',
        firstName: '',
        lastName: '',
        name: '',
        email: 'fallback@example.test',
        ticketTypeName: 'VIP',
        status: 'confirmed',
        createdAt: '2026-01-01T10:00:00.000Z',
      },
      {
        id: 'att_2',
        orderId: 'ord_1',
        eventId: 'evt_1',
        ticketTypeId: 'tt_vip',
        ticketId: 'tkt_2',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        ticketTypeName: 'VIP',
        status: 'checked_in',
        createdAt: '2026-01-01T10:00:00.000Z',
      },
    ],
    checkoutAnswers: {
      buyerFields: {
        Company: 'Analytical Engine LLC',
      },
      attendeeFields: {
        'Meal preference': ['Vegetarian', 'Gluten free'],
      },
    },
    consentSnapshots: {
      Photography: {
        consentText: 'I agree to event photography.',
        consentVersion: 'v2',
      },
    },
    refunds: [
      {
        id: 'ref_1',
        orderId: 'ord_1',
        amountCents: 3_000,
        currency: 'USD',
        status: 'succeeded',
        reason: 'partial refund',
        createdAt: '2026-01-02T10:00:00.000Z',
        updatedAt: '2026-01-02T10:00:00.000Z',
      },
    ],
    timeline: [
      {
        id: 'otl_1',
        orderId: 'ord_1',
        type: 'order.paid',
        description: 'Payment captured',
        createdAt: '2026-01-01T10:05:00.000Z',
      },
    ],
    deliveryStatus: {
      email: 'sent',
      tickets: 'issued',
    },
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  orderState.data = undefined;
  orderState.loading = false;
  orderState.error = null;
  orderState.refetch.mockClear();
  permissionsMock.can.mockReturnValue(true);
});

describe('attendeeDisplayName', () => {
  it('uses a non-empty explicit attendee name', () => {
    expect(
      attendeeDisplayName({ id: 'att_1', name: ' Ada Lovelace ', email: 'ada@example.test' }),
    ).toBe('Ada Lovelace');
  });

  it('falls back from empty names to first and last name', () => {
    expect(
      attendeeDisplayName({
        id: 'att_1',
        name: '',
        firstName: ' Grace ',
        lastName: ' Hopper ',
        email: 'grace@example.test',
      }),
    ).toBe('Grace Hopper');
  });

  it('falls back from empty name parts to email and then id', () => {
    expect(
      attendeeDisplayName({
        id: 'att_1',
        name: '',
        firstName: '',
        lastName: '',
        email: ' buyer@example.test ',
      }),
    ).toBe('buyer@example.test');
    expect(
      attendeeDisplayName({ id: 'att_2', name: '', firstName: '', lastName: '', email: '' }),
    ).toBe('att_2');
  });
});

describe('OrderDetailView', () => {
  it('renders buyer, attendee, line item, answer, consent, refund, delivery, and timeline panels', () => {
    orderState.data = makeOrder();

    render(React.createElement(OrderDetailView, { orderId: 'ord_1' }));

    expect(screen.getByText('Alice Buyer')).toBeInTheDocument();
    expect(screen.getByText('alice@example.test')).toBeInTheDocument();
    expect(screen.getByText('fallback@example.test')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('VIP Ticket')).toBeInTheDocument();
    expect(screen.getByText(/Qty 2/)).toBeInTheDocument();
    expect(screen.getByText(/Discount/)).toBeInTheDocument();
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('Analytical Engine LLC')).toBeInTheDocument();
    expect(screen.getByText('Meal preference')).toBeInTheDocument();
    expect(screen.getByText('["Vegetarian","Gluten free"]')).toBeInTheDocument();
    expect(screen.getByText('Photography')).toBeInTheDocument();
    expect(
      screen.getByText('{"consentText":"I agree to event photography.","consentVersion":"v2"}'),
    ).toBeInTheDocument();
    expect(screen.getByText('partial refund')).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    expect(screen.getByText('issued')).toBeInTheDocument();
    expect(screen.getByText('Payment captured')).toBeInTheDocument();
    expect(screen.getByText('Refund Processed')).toBeInTheDocument();
  });

  it('renders empty-state fallbacks for sparse order details', () => {
    orderState.data = makeOrder({
      buyerName: undefined,
      status: 'pending',
      refundedCents: 0,
      paymentProvider: undefined,
      attendees: [],
      lineItems: [],
      checkoutAnswers: { buyerFields: {}, attendeeFields: {} },
      consentSnapshots: {},
      refunds: [],
      timeline: [],
      deliveryStatus: {
        email: 'not_applicable',
        tickets: 'pending',
      },
    });

    render(React.createElement(OrderDetailView, { orderId: 'ord_1' }));

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('No attendee details available.')).toBeInTheDocument();
    expect(screen.getByText('No line items available.')).toBeInTheDocument();
    expect(screen.getAllByText('No answers captured.')).toHaveLength(2);
    expect(screen.getByText('No consent snapshots captured.')).toBeInTheDocument();
    expect(screen.getByText('No refunds recorded.')).toBeInTheDocument();
    expect(screen.getByText('not applicable')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('Order Created')).toBeInTheDocument();
  });

  it('keeps long order detail text inside responsive row containers', () => {
    const longOrderId = 'ord_very_long_mobile_reference_1234567890abcdef1234567890abcdef';
    const longEmail =
      'extremely.long.attendee.email.address.with.no.breaks.1234567890@example-subdomain-with-long-name.test';
    const longLineItem =
      'VIP table package with a very long merchandise bundle description and operational fulfillment notes';
    const longRefundReason =
      'Refund requested after a very long support escalation reference that should wrap inside the ledger row';

    orderState.data = makeOrder({
      id: longOrderId,
      buyerEmail: longEmail,
      status: 'paid',
      lineItems: [
        {
          id: 'oli_long',
          orderId: longOrderId,
          ticketTypeId: 'tt_vip',
          description: longLineItem,
          quantity: 1,
          unitPriceCents: 12_000,
          subtotalCents: 12_000,
          discountCents: 1_000,
          taxCents: 800,
          feeCents: 400,
          totalCents: 12_200,
          currency: 'USD',
          createdAt: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-01T10:00:00.000Z',
        },
      ],
      attendees: [
        {
          id: 'att_long',
          orderId: longOrderId,
          eventId: 'evt_1',
          ticketTypeId: 'tt_vip',
          ticketId: 'tkt_1',
          firstName: '',
          lastName: '',
          name: '',
          email: longEmail,
          ticketTypeName: 'VIP table package with a long ticket type name',
          status: 'checked_in',
          createdAt: '2026-01-01T10:00:00.000Z',
        },
      ],
      refunds: [
        {
          id: 'ref_long',
          orderId: longOrderId,
          amountCents: 3_000,
          currency: 'USD',
          status: 'succeeded',
          reason: longRefundReason,
          createdAt: '2026-01-02T10:00:00.000Z',
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
      timeline: [
        {
          id: 'otl_long',
          orderId: longOrderId,
          type: 'order.paid',
          description:
            'Payment captured after a long gateway authorization reference that should wrap cleanly',
          createdAt: '2026-01-01T10:05:00.000Z',
        },
      ],
    });

    const { container } = render(React.createElement(OrderDetailView, { orderId: longOrderId }));

    expect(container.firstElementChild).toHaveClass('overflow-x-hidden');
    expect(screen.getByRole('heading', { name: longOrderId })).toHaveClass('break-all');
    expect(screen.getByRole('button', { name: 'Refund' }).parentElement).toHaveClass(
      'w-full',
      'flex-wrap',
      'sm:w-auto',
    );
    const longEmailNodes = screen.getAllByText(longEmail, { selector: 'p' });
    expect(longEmailNodes).toHaveLength(2);
    expect(longEmailNodes[0]).toHaveClass('break-all');
    expect(longEmailNodes[1]).toHaveClass('break-words');
    expect(screen.getByText(longLineItem)).toHaveClass('break-words');
    expect(screen.getByText(longLineItem).closest('div[class*="rounded-lg"]')).toHaveClass(
      'flex-col',
      'sm:flex-row',
    );
    expect(screen.getByText(longRefundReason)).toHaveClass('break-words');
    expect(screen.getByText(longRefundReason).closest('div[class*="rounded-lg"]')).toHaveClass(
      'flex-col',
      'sm:flex-row',
    );
    expect(screen.getByText('checked_in')).toHaveClass('w-fit', 'shrink-0', 'break-all');
    expect(screen.getByText('$122.00')).toHaveClass('shrink-0', 'self-start');
    expect(screen.getByText('sent')).toHaveClass('w-fit', 'shrink-0', 'break-all');
    expect(container.querySelectorAll('.min-w-0').length).toBeGreaterThanOrEqual(6);
  });

  it('hides cancel and refund actions when the user only has read access', () => {
    permissionsMock.can.mockReturnValue(false);
    orderState.data = makeOrder({ status: 'paid' });

    render(React.createElement(OrderDetailView, { orderId: 'ord_1' }));

    expect(screen.getByText('Alice Buyer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });

  it('requires separate refund permission for refund actions', () => {
    permissionsMock.can.mockImplementation((permission?: string) => permission === 'orders.write');
    orderState.data = makeOrder({ status: 'paid' });

    render(React.createElement(OrderDetailView, { orderId: 'ord_1' }));

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
  });
});
