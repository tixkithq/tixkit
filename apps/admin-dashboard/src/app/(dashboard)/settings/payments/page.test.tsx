import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PaymentsPage from './page';
import { toast } from 'sonner';

const adminApiMock = vi.hoisted(() => ({
  listPaymentAccounts: vi.fn(),
  createStripeConnectAccount: vi.fn(),
  refreshStripeConnectAccount: vi.fn(),
  updateBrand: vi.fn(),
}));

const navigationMock = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
}));

const useBootstrapMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: useBootstrapMock,
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/payments',
  useRouter: () => ({ replace: navigationMock.replace }),
  useSearchParams: () => navigationMock.searchParams,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const organization = {
  id: 'org_1',
  tenantId: 'tenant_1',
  name: 'Acme Events',
  slug: 'acme',
  status: 'active' as const,
  boxOfficeSettings: {
    enabled: true,
    allowedTenderTypes: ['cash'],
    requireBuyerEmail: false,
    receiptMode: 'email' as const,
  },
};

const brand = {
  id: 'brand_1',
  organizationId: organization.id,
  name: 'Acme',
  slug: 'acme',
  domain: null,
  theme: {},
  domains: [],
  whiteLabel: false,
  paymentAccountId: 'acct_1',
};

const unboundBrand = {
  ...brand,
  paymentAccountId: null,
};

const pendingAccount = {
  id: 'acct_1',
  organizationId: organization.id,
  provider: 'stripe_connect' as const,
  providerAccountId: 'acct_stripe_1',
  status: 'pending' as const,
  defaultCurrency: 'USD',
  detailsSubmitted: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  requirements: {},
  disabledReason: null,
};

const activeAccount = {
  ...pendingAccount,
  status: 'active' as const,
  detailsSubmitted: true,
  chargesEnabled: true,
  payoutsEnabled: true,
};

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function mockBootstrap() {
  useBootstrapMock.mockReturnValue({
    organizations: [organization],
    organizationId: organization.id,
    availableBrands: [brand],
    brandId: brand.id,
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  });
}

function setSearchParams(value: string) {
  navigationMock.searchParams = new URLSearchParams(value);
}

beforeEach(() => {
  mockBootstrap();
  setSearchParams('');
  adminApiMock.listPaymentAccounts.mockResolvedValue(ok([pendingAccount]));
  adminApiMock.refreshStripeConnectAccount.mockResolvedValue(ok(activeAccount));
  adminApiMock.updateBrand.mockResolvedValue(ok(brand));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PaymentsPage brand payment routing', () => {
  it('keeps the saved payment account binding selected on load', async () => {
    render(<PaymentsPage />);

    expect(await screen.findByText('stripe_connect - acct_stripe_1 (pending)')).toBeVisible();
    expect(adminApiMock.updateBrand).not.toHaveBeenCalled();
  });

  it('automatically persists the only payment account for an unbound brand', async () => {
    useBootstrapMock.mockReturnValue({
      organizations: [organization],
      organizationId: organization.id,
      availableBrands: [unboundBrand],
      brandId: unboundBrand.id,
      setBrandId: vi.fn(),
      loading: false,
      error: null,
    });
    adminApiMock.updateBrand.mockResolvedValue(
      ok({
        ...unboundBrand,
        paymentAccountId: pendingAccount.id,
      }),
    );

    render(<PaymentsPage />);

    await waitFor(() => {
      expect(adminApiMock.updateBrand).toHaveBeenCalledWith(unboundBrand.id, {
        paymentAccountId: pendingAccount.id,
      });
    });
    expect(await screen.findByText('stripe_connect - acct_stripe_1 (pending)')).toBeVisible();
    expect(toast.success).toHaveBeenCalledWith('Payment account binding updated');
  });
});

describe('PaymentsPage Stripe Connect return handling', () => {
  it('refreshes a returned Stripe Connect account and clears handled query parameters', async () => {
    setSearchParams('organizationId=org_1&stripeConnect=return&tab=payments');

    render(<PaymentsPage />);

    await waitFor(() => {
      expect(adminApiMock.refreshStripeConnectAccount).toHaveBeenCalledWith('org_1', 'acct_1');
    });
    expect(
      await screen.findByText('Stripe account active after onboarding refresh.'),
    ).toBeVisible();
    expect(toast.success).toHaveBeenCalledWith('Stripe account active after onboarding refresh.');
    expect(navigationMock.replace).toHaveBeenCalledWith('/settings/payments?tab=payments', {
      scroll: false,
    });
  });

  it('does not refresh when the return organization does not match the selected workspace', async () => {
    setSearchParams('organizationId=org_other&stripeConnect=return');

    render(<PaymentsPage />);

    await screen.findByText('Stripe pending');
    expect(adminApiMock.refreshStripeConnectAccount).not.toHaveBeenCalled();
    expect(navigationMock.replace).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a recoverable return message when no connected account exists', async () => {
    setSearchParams('organizationId=org_1&stripeConnect=return');
    adminApiMock.listPaymentAccounts.mockResolvedValue(ok([]));

    render(<PaymentsPage />);

    const message =
      'Stripe returned to this workspace, but no connected payment account was found. Start Connect again or contact support.';
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(adminApiMock.refreshStripeConnectAccount).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(message);
    expect(navigationMock.replace).toHaveBeenCalledWith('/settings/payments', { scroll: false });
  });
});
