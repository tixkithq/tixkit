import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrapState = vi.hoisted(() => ({
  value: {
    organizations: [{ id: 'org_1', name: 'Tixkit Dev' }],
    brands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' }],
    availableBrands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' }],
    organizationId: 'org_1',
    brandId: 'brd_1',
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  },
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
}));

import { ScopeSelector } from './scope-selector';

describe('ScopeSelector', () => {
  beforeEach(() => {
    bootstrapState.value = {
      organizations: [{ id: 'org_1', name: 'Tixkit Dev' }],
      brands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' }],
      availableBrands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' }],
      organizationId: 'org_1',
      brandId: 'brd_1',
      setOrganizationId: vi.fn(),
      setBrandId: vi.fn(),
      loading: false,
      error: null,
    };
  });

  it('renders a single workspace as a borderless sidebar row and hides a same-name single brand', () => {
    render(<ScopeSelector />);

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.queryByText('Brand')).not.toBeInTheDocument();
    expect(screen.getAllByText('Tixkit Dev')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Workspace').closest('div')).not.toHaveClass('border');
  });

  it('shows a single brand when its name differs from the selected workspace', () => {
    bootstrapState.value = {
      ...bootstrapState.value,
      availableBrands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Festival Brand' }],
      brands: [{ id: 'brd_1', organizationId: 'org_1', name: 'Festival Brand' }],
    };

    render(<ScopeSelector />);

    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('Brand')).toBeInTheDocument();
    expect(screen.getByText('Tixkit Dev')).toBeInTheDocument();
    expect(screen.getByText('Festival Brand')).toBeInTheDocument();
    expect(screen.getByText('Brand').closest('div')).not.toHaveClass('border');
  });

  it('renders dropdowns only when there are multiple choices', () => {
    bootstrapState.value = {
      ...bootstrapState.value,
      organizations: [
        { id: 'org_1', name: 'Tixkit Dev' },
        { id: 'org_2', name: 'Tour Ops' },
      ],
      brands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand' },
      ],
      availableBrands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'Tixkit Dev' },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand' },
      ],
    };

    render(<ScopeSelector />);

    expect(screen.getByRole('combobox', { name: 'Select workspace' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Select brand' })).toBeInTheDocument();
  });
});
