import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const bootstrapState = vi.hoisted(() => ({
  value: {
    organizations: [
      { id: 'org_1', name: 'GateKit Dev' },
    ],
    brands: [
      { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
    ],
    availableBrands: [
      { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
    ],
    organizationId: 'org_1',
    brandId: 'brd_1',
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  },
}))

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
}))

import { ScopeSelector } from './scope-selector'

describe('ScopeSelector', () => {
  beforeEach(() => {
    bootstrapState.value = {
      organizations: [
        { id: 'org_1', name: 'GateKit Dev' },
      ],
      brands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
      ],
      availableBrands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
      ],
      organizationId: 'org_1',
      brandId: 'brd_1',
      setOrganizationId: vi.fn(),
      setBrandId: vi.fn(),
      loading: false,
      error: null,
    }
  })

  it('renders single organization and brand as labeled static scope pills', () => {
    render(<ScopeSelector />)

    expect(screen.getByText('Org')).toBeInTheDocument()
    expect(screen.getByText('Brand')).toBeInTheDocument()
    expect(screen.getAllByText('GateKit Dev')).toHaveLength(2)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('renders dropdowns only when there are multiple choices', () => {
    bootstrapState.value = {
      ...bootstrapState.value,
      organizations: [
        { id: 'org_1', name: 'GateKit Dev' },
        { id: 'org_2', name: 'Tour Ops' },
      ],
      brands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand' },
      ],
      availableBrands: [
        { id: 'brd_1', organizationId: 'org_1', name: 'GateKit Dev' },
        { id: 'brd_2', organizationId: 'org_1', name: 'Festival Brand' },
      ],
    }

    render(<ScopeSelector />)

    expect(
      screen.getByRole('combobox', { name: 'Select organization' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: 'Select brand' }),
    ).toBeInTheDocument()
  })
})
