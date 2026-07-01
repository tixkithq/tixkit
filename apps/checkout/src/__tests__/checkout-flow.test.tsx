import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import CheckoutFlow from '@/app/checkout/checkout-flow';
import { publicApi, checkoutApi, type AvailabilityItem, type PublicEvent } from '@/lib/api';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => {
  return {
    publicApi: {
      getEvent: vi.fn(),
      getAvailability: vi.fn(),
      getResaleListings: vi.fn(),
      getQuestions: vi.fn(),
      getBrand: vi.fn(),
    },
    checkoutApi: {
      createSession: vi.fn(),
      getSession: vi.fn(),
      confirmSession: vi.fn(),
    },
  };
});

const publicApiMock = publicApi as unknown as {
  getEvent: ReturnType<typeof vi.fn>;
  getAvailability: ReturnType<typeof vi.fn>;
  getResaleListings: ReturnType<typeof vi.fn>;
  getQuestions: ReturnType<typeof vi.fn>;
  getBrand: ReturnType<typeof vi.fn>;
};
const checkoutApiMock = checkoutApi as unknown as {
  createSession: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
});

const event: PublicEvent = {
  id: 'evt_checkout',
  title: 'All Access Chicago',
  status: 'published',
  timezone: 'America/Chicago',
  startsAt: '2026-07-17T19:00:00.000Z',
  brandId: 'brd_1',
};

const availability: AvailabilityItem[] = [
  {
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
  },
];

function renderCheckoutFlow(props: Partial<React.ComponentProps<typeof CheckoutFlow>> = {}) {
  return render(
    React.createElement(CheckoutFlow, {
      initialEventId: 'evt_checkout',
      initialSessionId: '',
      initialSessionToken: '',
      ...props,
    }),
  );
}

describe('CheckoutFlow buyer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue(availability);
    publicApiMock.getResaleListings.mockResolvedValue({ items: [] });
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [],
      attendeeQuestions: [],
    });
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
  });

  it('keeps Continue disabled until a ticket is selected', async () => {
    const view = renderCheckoutFlow();

    const continueButton = await view.findByRole('button', { name: 'Continue' });

    await waitFor(() => {
      expect(view.getByText('General Admission')).toBeInTheDocument();
    });
    expect(continueButton).toBeDisabled();
  });

  it('lets buyers submit a selected cart to reveal inline email errors', async () => {
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));

    const continueButton = view.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeEnabled();

    fireEvent.click(continueButton);

    expect(await view.findByText('Email is required to continue.')).toBeInTheDocument();
    expect(view.getByLabelText(/Email/)).toHaveAttribute('aria-describedby', 'email_feedback');
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('directs buyers to the missing required checkbox question', async () => {
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [
        {
          id: 'q_ack',
          label: 'I agree to the photo policy',
          type: 'checkbox',
          required: true,
          appliesTo: 'buyer',
        },
      ],
      attendeeQuestions: [],
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    expect(await view.findByText('Please check I agree to the photo policy.')).toBeInTheDocument();
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('creates a resale checkout session for a selected public listing', async () => {
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getResaleListings.mockResolvedValue({
      items: [
        {
          id: 'lst_1',
          eventId: 'evt_checkout',
          ticketTypeId: 'tt_general',
          ticketTypeName: 'General Admission',
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    checkoutApiMock.createSession.mockResolvedValue({
      id: 'cs_1',
      eventId: 'evt_checkout',
      brandId: 'brd_1',
      status: 'open',
      currency: 'USD',
      clientToken: 'token_1',
      quote: {
        subtotalCents: 5500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5500,
      },
      expiresAt: '2026-06-01T00:10:00.000Z',
    });
    const view = renderCheckoutFlow({ resaleListingId: 'lst_1' });

    expect(await view.findAllByText('Resale ticket - General Admission')).not.toHaveLength(0);
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(checkoutApiMock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_checkout',
          items: [{ resaleListingId: 'lst_1', quantity: 1 }],
          buyer: expect.objectContaining({ email: 'buyer@example.com' }),
          discountCode: undefined,
          accessCode: undefined,
          waitlistClaimToken: undefined,
        }),
      );
    });
  });
});
