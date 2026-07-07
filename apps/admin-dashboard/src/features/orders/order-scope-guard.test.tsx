import { render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderScopeGuard } from './order-scope-guard';

const useAdminDataMock = vi.hoisted(() => vi.fn());
const useBootstrapMock = vi.hoisted(() => ({
  organizationId: 'org_other' as string | undefined,
  brandId: 'brd_other' as string | undefined,
  setOrganizationId: vi.fn(),
  setBrandId: vi.fn(),
}));
const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('@/hooks/use-admin-table-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-admin-table-data')>();
  return {
    ...actual,
    useAdminQuery: useAdminDataMock,
  };
});

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => useBootstrapMock,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

function makeOrder(overrides: Partial<{ organizationId: string; brandId: string }> = {}) {
  return {
    id: 'ord_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    eventId: 'evt_1',
    eventTitle: 'Launch Night',
    buyerEmail: 'a@b.com',
    status: 'paid' as const,
    totalCents: 5000,
    refundedCents: 0,
    currency: 'USD',
    attendeeCount: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    lineItems: [],
    attendees: [],
    checkoutAnswers: { buyerFields: {}, attendeeFields: {} },
    consentSnapshots: {},
    refunds: [],
    timeline: [],
    deliveryStatus: { email: 'pending', tickets: 'issued' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useBootstrapMock.organizationId = 'org_other';
  useBootstrapMock.brandId = 'brd_other';
  useBootstrapMock.setOrganizationId.mockImplementation((id: string | undefined) => {
    useBootstrapMock.organizationId = id;
  });
  useBootstrapMock.setBrandId.mockImplementation((id: string | undefined) => {
    useBootstrapMock.brandId = id;
  });
  routerMock.replace.mockReset();
});

describe('OrderScopeGuard', () => {
  it('renders children while the order is loading', () => {
    useAdminDataMock.mockReturnValue({
      data: undefined,
      loading: true,
      error: undefined,
      refetch: vi.fn(),
    });

    const { getByText } = render(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    expect(getByText('page content')).toBeInTheDocument();
  });

  it('auto-aligns scope to the order brand when it differs', async () => {
    const order = makeOrder();
    useAdminDataMock.mockReturnValue({
      data: order,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

    render(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    await waitFor(() => {
      expect(useBootstrapMock.setOrganizationId).toHaveBeenCalledWith('org_1');
      expect(useBootstrapMock.setBrandId).toHaveBeenCalledWith('brd_1');
    });
  });

  it('does not call setters when scope already matches', () => {
    useBootstrapMock.organizationId = 'org_1';
    useBootstrapMock.brandId = 'brd_1';
    const order = makeOrder();
    useAdminDataMock.mockReturnValue({
      data: order,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

    render(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    expect(useBootstrapMock.setOrganizationId).not.toHaveBeenCalled();
    expect(useBootstrapMock.setBrandId).not.toHaveBeenCalled();
  });

  it('redirects to /orders when the scope is manually switched to a mismatched brand', async () => {
    const order = makeOrder();
    useAdminDataMock.mockReturnValue({
      data: order,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

    const { rerender } = render(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    await waitFor(() => {
      expect(useBootstrapMock.setBrandId).toHaveBeenCalledWith('brd_1');
    });
    useBootstrapMock.organizationId = 'org_1';
    useBootstrapMock.brandId = 'brd_1';

    rerender(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    expect(routerMock.replace).not.toHaveBeenCalled();

    useBootstrapMock.brandId = 'brd_other';
    rerender(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith('/orders');
    });
  });

  it('does not redirect when the order lacks organization/brand ids', () => {
    const order = makeOrder({ organizationId: undefined, brandId: undefined });
    useAdminDataMock.mockReturnValue({
      data: order,
      loading: false,
      error: undefined,
      refetch: vi.fn(),
    });

    render(
      <OrderScopeGuard orderId="ord_1">
        <p>page content</p>
      </OrderScopeGuard>,
    );

    expect(useBootstrapMock.setOrganizationId).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
