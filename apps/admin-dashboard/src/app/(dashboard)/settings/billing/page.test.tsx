import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BillingPage from './page';

const adminApiMock = vi.hoisted(() => ({
  getBillingOverview: vi.fn(),
}));

const guardMock = vi.hoisted(() => ({
  allowed: true,
}));

const useBootstrapMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: useBootstrapMock,
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ children }: { children: React.ReactNode }) =>
    guardMock.allowed ? <>{children}</> : <div>Access denied</div>,
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

function ok<T>(data: T) {
  return { ok: true as const, data };
}

beforeEach(() => {
  guardMock.allowed = true;
  useBootstrapMock.mockReturnValue({
    organizations: [organization],
    organizationId: organization.id,
    loading: false,
    error: null,
  });
  adminApiMock.getBillingOverview.mockResolvedValue(
    ok({
      organizationId: organization.id,
      plan: 'Pro',
      status: 'active',
      ticketsThisMonth: 10,
      ticketLimit: 100,
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BillingPage permissions', () => {
  it('does not load billing data when billing permission is denied', () => {
    guardMock.allowed = false;

    render(<BillingPage />);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(adminApiMock.getBillingOverview).not.toHaveBeenCalled();
  });

  it('loads billing data when billing permission is allowed', async () => {
    render(<BillingPage />);

    await waitFor(() => {
      expect(adminApiMock.getBillingOverview).toHaveBeenCalledWith('org_1');
    });
    expect(await screen.findByText('Pro')).toBeVisible();
  });
});
