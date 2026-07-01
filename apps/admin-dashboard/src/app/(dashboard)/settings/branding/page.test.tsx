import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapState = vi.hoisted(() => ({
  value: {
    availableBrands: [
      {
        id: 'brd_1',
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        name: 'Tixkit Dev',
        slug: 'tixkit-dev',
        status: 'active',
        theme: { primaryColor: '#222222' },
        domains: [],
        whiteLabel: false,
      },
    ],
    brandId: 'brd_1',
    loading: false,
    error: null,
  },
}));

const apiMock = vi.hoisted(() => ({
  updateBrand: vi.fn(),
  addBrandDomain: vi.fn(),
  uploadArtifact: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const guardMock = vi.hoisted(() => ({
  allowed: true,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
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

import BrandingPage from './page';

describe('BrandingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardMock.allowed = true;
  });

  it('does not mount brand settings when settings permission is denied', () => {
    guardMock.allowed = false;

    render(<BrandingPage />);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Brand Name')).not.toBeInTheDocument();
    expect(apiMock.updateBrand).not.toHaveBeenCalled();
    expect(apiMock.addBrandDomain).not.toHaveBeenCalled();
    expect(apiMock.uploadArtifact).not.toHaveBeenCalled();
  });

  it('saves edited brand name with the brand settings payload', async () => {
    apiMock.updateBrand.mockResolvedValue({
      ok: true,
      data: {
        ...bootstrapState.value.availableBrands[0],
        name: 'Festival Ops',
        theme: { primaryColor: '#123456' },
      },
    });

    render(<BrandingPage />);

    expect(
      await screen.findByText(
        'Set the primary color for checkout pages, widgets, and wallet passes.',
      ),
    ).toBeInTheDocument();

    const nameInput = await screen.findByLabelText('Brand Name');
    fireEvent.change(nameInput, { target: { value: 'Festival Ops' } });
    fireEvent.change(screen.getByLabelText('Hex value'), { target: { value: '#123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiMock.updateBrand).toHaveBeenCalledTimes(1));
    expect(apiMock.updateBrand).toHaveBeenCalledWith('brd_1', {
      name: 'Festival Ops',
      theme: {
        primaryColor: '#123456',
      },
    });
    expect(toastMock.success).toHaveBeenCalledWith('Brand settings saved');
  });

  it('requires a brand name before saving', async () => {
    render(<BrandingPage />);

    const nameInput = await screen.findByLabelText('Brand Name');
    fireEvent.change(nameInput, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(apiMock.updateBrand).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Brand name is required');
  });
});
