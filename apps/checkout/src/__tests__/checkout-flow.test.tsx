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

function renderCheckoutFlow() {
  return render(
    React.createElement(CheckoutFlow, {
      initialEventId: 'evt_checkout',
      initialSessionId: '',
      initialSessionToken: '',
    }),
  );
}

describe('CheckoutFlow buyer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue(availability);
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
});
