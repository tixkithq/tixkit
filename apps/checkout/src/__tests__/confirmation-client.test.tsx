import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConfirmationClient from '@/app/checkout/confirmation/confirmation-client';
import {
  checkoutApi,
  isRetryable,
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
  isRetryable: vi.fn(),
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
const isRetryableMock = isRetryable as unknown as ReturnType<typeof vi.fn>;

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

const pendingSession: CheckoutSession = {
  ...confirmedSession,
  status: 'pending_payment',
};

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
  });
}

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
    isRetryableMock.mockReturnValue(false);
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

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'opener', { configurable: true, value: null });
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
  });

  it('captures then immediately removes the Stripe client secret from browser history', async () => {
    window.sessionStorage.clear();
    navigationState.searchParams = new URLSearchParams(
      'sessionId=cs_1&payment_intent_client_secret=pi_secret_sensitive&redirect_status=succeeded',
    );
    window.history.replaceState(
      {},
      '',
      '/checkout/confirmation?sessionId=cs_1&payment_intent_client_secret=pi_secret_sensitive&redirect_status=succeeded',
    );

    render(<ConfirmationClient />);

    expect(window.location.href).not.toContain('payment_intent_client_secret');
    expect(window.location.href).not.toContain('pi_secret_sensitive');
    await waitFor(() =>
      expect(checkoutApiMock.getSession).toHaveBeenCalledWith(
        'cs_1',
        undefined,
        'pi_secret_sensitive',
      ),
    );
    expect(window.location.href).not.toContain('pi_secret_sensitive');
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

  it('shows a retryable wallet action error and reloads actions after retry', async () => {
    checkoutApiMock.getWalletPasses
      .mockRejectedValueOnce(new Error('Wallet passes are temporarily unavailable'))
      .mockResolvedValueOnce({ tickets: [resaleTicket] });

    render(<ConfirmationClient />);

    expect(await screen.findByText('Wallet and resale actions could not load')).toBeVisible();
    expect(screen.getByText('Wallet passes are temporarily unavailable')).toBeVisible();
    expect(screen.queryByText('Add to Wallet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Add to Wallet')).toBeVisible();
    expect(screen.getByRole('button', { name: 'List for resale' })).toBeVisible();
    expect(checkoutApiMock.getWalletPasses).toHaveBeenCalledTimes(2);
  });

  it('shows original-browser guidance when confirmed wallet actions have no session token', async () => {
    window.sessionStorage.clear();

    render(<ConfirmationClient />);

    expect(await screen.findByText('What happens next')).toBeInTheDocument();
    expect(await screen.findByText('Wallet and resale actions unavailable')).toBeVisible();
    expect(
      screen.getByText(
        'Open this confirmation in the original checkout browser to access wallet passes and resale actions for these tickets.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Add to Wallet')).not.toBeInTheDocument();
    expect(checkoutApiMock.getWalletPasses).not.toHaveBeenCalled();
  });

  it('does not broadcast an identity-free completion message outside a v1 handshake', async () => {
    let resolveEvent!: (value: Awaited<ReturnType<typeof publicApi.getEvent>>) => void;
    publicApiMock.getEvent.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEvent = resolve;
      }),
    );
    const postMessageSpy = vi.fn();
    Object.defineProperty(window, 'opener', {
      configurable: true,
      value: { postMessage: postMessageSpy },
    });
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://merchant.example.test/tickets',
    });

    render(<ConfirmationClient />);

    resolveEvent({
      id: 'evt_1',
      title: 'All Access Chicago',
      status: 'published',
      timezone: 'America/Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      brandId: 'brand_platform',
    });

    await waitFor(() => {
      expect(screen.getByText('What happens next')).toBeInTheDocument();
    });
    await flushAsyncWork();

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('continues polling after one retryable confirmation load failure', async () => {
    vi.useFakeTimers();
    const transientError = new Error('temporary gateway failure');
    checkoutApiMock.getSession
      .mockResolvedValueOnce(pendingSession)
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(confirmedSession);
    isRetryableMock.mockReturnValue(true);

    render(<ConfirmationClient />);
    await flushAsyncWork();

    expect(screen.getByText('Processing your payment')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(isRetryableMock).toHaveBeenCalledWith(transientError);
    expect(screen.queryByText('Could not load order details')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.getByText('What happens next')).toBeInTheDocument();
    expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(3);
  });

  it('retries a retryable initial confirmation load failure before showing an error', async () => {
    vi.useFakeTimers();
    navigationState.searchParams = new URLSearchParams(
      'sessionId=cs_1&orderId=ord_1&orderNumber=TK-1001&redirect_status=succeeded',
    );
    const transientError = new Error('temporary gateway failure');
    checkoutApiMock.getSession
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(confirmedSession);
    isRetryableMock.mockReturnValue(true);

    render(<ConfirmationClient />);
    await flushAsyncWork();

    expect(isRetryableMock).toHaveBeenCalledWith(transientError);
    expect(screen.queryByText('Could not load order details')).not.toBeInTheDocument();
    expect(screen.getByText('Processing your payment')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByText('What happens next')).toBeInTheDocument();
    expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(2);
  });

  it('keeps non-retryable initial confirmation load failures terminal', async () => {
    const terminalError = new Error('Confirmation link is no longer valid');
    checkoutApiMock.getSession.mockRejectedValueOnce(terminalError);
    isRetryableMock.mockReturnValue(false);

    render(<ConfirmationClient />);

    expect(await screen.findByText('Could not load order details')).toBeVisible();
    expect(screen.getByText('Confirmation link is no longer valid')).toBeVisible();
    expect(isRetryableMock).toHaveBeenCalledWith(terminalError);
    expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(1);
  });
});
