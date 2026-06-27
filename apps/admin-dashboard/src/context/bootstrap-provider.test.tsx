import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BootstrapProvider, useBootstrap } from '@/context/bootstrap-provider'
import { adminApi } from '@/lib/api'

function wrapper({ children }: { children: React.ReactNode }) {
  return <BootstrapProvider>{children}</BootstrapProvider>
}

function useBootstrapHook() {
  return useBootstrap()
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('BootstrapProvider', () => {
  it('does not silently select the first organization or brand when multiple choices exist', async () => {
    vi.spyOn(adminApi, 'listOrganizations').mockResolvedValue({
      ok: true,
      data: [
        { id: 'org_1', tenantId: 'tnt_1', name: 'Org One', slug: 'one', status: 'active' },
        { id: 'org_2', tenantId: 'tnt_1', name: 'Org Two', slug: 'two', status: 'active' },
      ],
    })
    vi.spyOn(adminApi, 'listBrands').mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'brd_1',
          tenantId: 'tnt_1',
          organizationId: 'org_1',
          name: 'Brand One',
          slug: 'brand-one',
          status: 'active',
          theme: {},
          domains: [],
          whiteLabel: false,
        },
        {
          id: 'brd_2',
          tenantId: 'tnt_1',
          organizationId: 'org_2',
          name: 'Brand Two',
          slug: 'brand-two',
          status: 'active',
          theme: {},
          domains: [],
          whiteLabel: false,
        },
      ],
    })

    const { result } = renderHook(useBootstrapHook, { wrapper })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.organizationId).toBeUndefined()
    expect(result.current.brandId).toBeUndefined()

    act(() => result.current.setOrganizationId('org_2'))
    await waitFor(() => expect(result.current.organizationId).toBe('org_2'))
    expect(result.current.availableBrands.map((brand) => brand.id)).toEqual(['brd_2'])
    await waitFor(() => expect(result.current.brandId).toBe('brd_2'))
    expect(window.localStorage.getItem('tixkit:selected-organization-id')).toBe('org_2')
    expect(window.localStorage.getItem('tixkit:selected-brand-id')).toBe('brd_2')
  })
})
