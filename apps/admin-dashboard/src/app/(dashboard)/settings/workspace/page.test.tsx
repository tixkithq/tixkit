import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
  const organizationFixture = {
    id: 'org_1',
    tenantId: 'tnt_1',
    name: 'Tixkit',
    slug: 'tixkit',
    status: 'active' as const,
    boxOfficeSettings: {
      enabled: true,
      allowedTenderTypes: ['cash', 'manual_card', 'comp'] as Array<'cash' | 'manual_card' | 'comp'>,
      requireBuyerEmail: false,
      receiptMode: 'email' as const,
    },
  };
  return {
    organizationFixture,
    bootstrapState: {
      value: {
        organizations: [organizationFixture],
        organizationId: 'org_1',
        loading: false,
        error: null,
      },
    },
  };
});

const apiMock = vi.hoisted(() => ({
  updateOrganization: vi.fn(),
  listSavedVenues: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const guardMock = vi.hoisted(() => ({
  allowed: true,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => testState.bootstrapState.value,
}));

vi.mock('@/lib/api', () => ({
  adminApi: apiMock,
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ children }: { children: React.ReactNode }) =>
    guardMock.allowed ? <>{children}</> : <div>Access denied</div>,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

import WorkspacePage from './page';

describe('WorkspacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardMock.allowed = true;
  });

  it('does not mount workspace settings when settings permission is denied', () => {
    guardMock.allowed = false;

    render(<WorkspacePage />);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace Name')).not.toBeInTheDocument();
    expect(apiMock.updateOrganization).not.toHaveBeenCalled();
  });

  it('saves workspace identity and box-office policy together', async () => {
    apiMock.updateOrganization.mockResolvedValue({
      ok: true,
      data: {
        ...testState.organizationFixture,
        name: 'Festival Ops',
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash', 'comp'],
          requireBuyerEmail: true,
          receiptMode: 'email',
        },
      },
    });

    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: 'Festival Ops' },
    });
    fireEvent.click(screen.getByLabelText('Manual Card'));
    fireEvent.click(screen.getByText('Require buyer email for at-door orders'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalledTimes(1));
    expect(apiMock.updateOrganization).toHaveBeenCalledWith('org_1', {
      name: 'Festival Ops',
      slug: 'tixkit',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'email',
      },
      eventDefaults: {},
    });
    expect(toastMock.success).toHaveBeenCalledWith('Workspace settings saved');
  });

  it('requires a non-empty workspace name before saving', async () => {
    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(apiMock.updateOrganization).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Workspace name is required');
  });
});
