import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfirmationClient from '@/app/checkout/confirmation/confirmation-client';
import {
  checkoutApi,
  publicApi,
  type CheckoutSession,
  type CheckoutWalletPassTicket,
} from '@/lib/api';
import { storeSessionToken } from '@/lib/session-token';

const navigationState = vi.hoisted(() => ({
  searchParams: new URLSearchParams('sessionId=cs_1&orderId=ord_1&orderNumber=TK-1001'),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/lib/use-brand', () => ({
  useResolvedBrand: () => ({
    id: 'brand_platform',
    name: 'Tixkit',
    legalUrls: {},
    theme: {},
    whiteLabel: false,
    fallback: true,
  }),
}));

vi.mock('@/lib/api', () => ({
  checkoutApi: {
    getSession: vi.fn(),
    getWalletPasses: vi.fn(),
    createResaleListing: vi.fn(),
  },
  publicApi: {
    getEvent: vi.fn(),
  },
  userFacingMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'Something went wrong. Please try again.',
}));

const checkoutApiMock = checkoutApi as unknown as {
  getSession: ReturnType<typeof vi.fn>;
  getWalletPasses: ReturnType<typeof vi.fn>;
  createResaleListing: ReturnType<typeof vi.fn>;
};

const publicApiMock = publicApi as unknown as {
  getEvent: ReturnType<typeof vi.fn>;
};

const confirmedSession: CheckoutSession = {
  id: 'cs_1',
  eventId: 'evt_1',
  brandId: 'brand_platform',
  status: 'completed',
  currency: 'USD',
  quote: {
    subtotalCents: 5000,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 5000,
  },
  expiresAt: '2026-07-01T00:00:00.000Z',
  orderId: 'ord_1',
};

const resaleTicket: CheckoutWalletPassTicket = {
  ticketId: 'tkt_1',
  ticketCode: 'TK-1001-A',
  faceValueCents: 5000,
  currency: 'USD',
  resaleEnabled: true,
  resaleMaxPriceCents: 6000,
};

describe('ConfirmationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    navigationState.searchParams = new URLSearchParams(
      'sessionId=cs_1&orderId=ord_1&orderNumber=TK-1001',
    );
    storeSessionToken('cs_1', 'tok_1');
    checkoutApiMock.getSession.mockResolvedValue(confirmedSession);
    checkoutApiMock.getWalletPasses.mockResolvedValue({ tickets: [resaleTicket] });
    checkoutApiMock.createResaleListing.mockResolvedValue({
      id: 'lst_1',
      eventId: 'evt_1',
      ticketId: 'tkt_1',
      status: 'listed',
      priceCents: 5000,
      currency: 'USD',
      faceValueCents: 5000,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    publicApiMock.getEvent.mockResolvedValue({
      id: 'evt_1',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brand_platform',
    });
  });

  it('associates invalid resale price errors with the price input and announces them', async () => {
    render(<ConfirmationClient />);

    fireEvent.click(await screen.findByRole('button', { name: 'List for resale' }));
    const priceInput = screen.getByLabelText('Resale price');

    expect(priceInput).toHaveAttribute('aria-describedby', 'resale-help-tkt_1');
    expect(priceInput).not.toHaveAttribute('aria-invalid');

    fireEvent.change(priceInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create listing' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveAttribute('id', 'resale-error-tkt_1');
    expect(error).toHaveTextContent('Enter a valid resale price.');
    expect(priceInput).toHaveAttribute('aria-invalid', 'true');
    expect(priceInput).toHaveAttribute('aria-describedby', 'resale-help-tkt_1 resale-error-tkt_1');

    await waitFor(() => {
      expect(checkoutApiMock.createResaleListing).not.toHaveBeenCalled();
    });
  });

  it('renders confirmed order content when a completed session returns with redirect_status=failed', async () => {
    navigationState.searchParams = new URLSearchParams(
      'sessionId=cs_1&orderId=ord_1&orderNumber=TK-1001&redirect_status=failed',
    );

    render(<ConfirmationClient />);

    expect(await screen.findByText('What happens next')).toBeInTheDocument();
    expect(screen.queryByText('Payment failed')).not.toBeInTheDocument();
  });

  it('shows the loaded session order reference when tokenless confirmation has no order query params', async () => {
    navigationState.searchParams = new URLSearchParams(
      'sessionId=cs_1&payment_intent_client_secret=pi_secret_1&redirect_status=succeeded',
    );

    render(<ConfirmationClient />);

    expect(await screen.findByText('ord_1')).toBeInTheDocument();
  });
});
