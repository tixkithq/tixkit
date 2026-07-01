import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminApiError, AdminPaymentCompensation, PageResult } from '@/lib/api';
import { PaymentCompensationsPanel } from './payment-compensations-panel';

type PaymentCompensationState = {
  data: PageResult<AdminPaymentCompensation> | undefined;
  loading: boolean;
  error: AdminApiError | undefined;
  refetch: ReturnType<typeof vi.fn>;
};

const compensationState = vi.hoisted<PaymentCompensationState>(() => ({
  data: undefined,
  loading: false,
  error: undefined,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: () => compensationState,
}));

function makeCompensation(
  overrides: Partial<AdminPaymentCompensation> = {},
): AdminPaymentCompensation {
  return {
    id: 'pc_1',
    tenantId: 'ten_1',
    checkoutSessionId: 'cs_1',
    paymentIntentId: 'pi_1',
    provider: 'stripe',
    providerIntentId: 'pi_1',
    amountCents: 12_500,
    currency: 'USD',
    action: 'issue_tickets',
    status: 'manual_review',
    providerCompensationId: null,
    attempts: 2,
    reason: 'Payment succeeded after checkout finalization failed.',
    lastError: 'Order creation timed out.',
    metadata: {},
    createdAt: '2026-07-01T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  compensationState.data = undefined;
  compensationState.loading = false;
  compensationState.error = undefined;
  compensationState.refetch.mockClear();
});

describe('PaymentCompensationsPanel', () => {
  it('renders a stable loading skeleton while the review queue is loading', () => {
    compensationState.loading = true;

    const { container } = render(<PaymentCompensationsPanel />);

    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
    expect(screen.queryByText('Payment compensation needs review')).not.toBeInTheDocument();
  });

  it('renders nothing after a successful empty manual-review queue response', () => {
    compensationState.data = { items: [] };

    const { container } = render(<PaymentCompensationsPanel />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a retryable error when manual-review compensations cannot be loaded', () => {
    compensationState.error = {
      code: 'network_error',
      message: 'Failed to load payment compensations',
      status: 503,
    };

    render(<PaymentCompensationsPanel />);

    expect(screen.getByText('Payment compensation review unavailable')).toBeVisible();
    expect(screen.getByText('Failed to load payment compensations')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(compensationState.refetch).toHaveBeenCalledTimes(1);
  });

  it('renders manual-review compensation rows with the existing refresh action', () => {
    compensationState.data = { items: [makeCompensation()] };

    render(<PaymentCompensationsPanel />);

    expect(screen.getByText('Payment compensation needs review')).toBeVisible();
    expect(screen.getByText('$125.00')).toBeVisible();
    expect(screen.getByText('manual_review')).toBeVisible();
    expect(screen.getByText('Payment succeeded after checkout finalization failed.')).toBeVisible();
    expect(screen.getByText('Order creation timed out.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(compensationState.refetch).toHaveBeenCalledTimes(1);
  });
});
