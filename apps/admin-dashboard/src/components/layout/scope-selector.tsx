'use client'

import type { ComponentType, SVGProps } from 'react'
import { Building2, Store } from 'lucide-react'
import { useBootstrap } from '@/context/bootstrap-provider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type ScopePillProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  value?: string
}

function ScopePill({ icon: Icon, label, value }: ScopePillProps) {
  return (
    <div className='flex h-8 min-w-44 max-w-72 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 text-sm'>
      <Icon aria-hidden='true' className='size-4 shrink-0 text-muted-foreground' />
      <span className='shrink-0 text-xs font-medium text-muted-foreground'>
        {label}
      </span>
      <span className='truncate font-medium'>{value ?? 'None'}</span>
    </div>
  )
}

export function ScopeSelector() {
  const {
    organizations,
    availableBrands,
    organizationId,
    brandId,
    setOrganizationId,
    setBrandId,
    loading,
    error,
  } = useBootstrap()

  if (loading) {
    return <div className='text-xs text-muted-foreground'>Loading workspace...</div>
  }

  if (error) {
    return <div className='text-xs text-destructive'>{error}</div>
  }

  if (organizations.length === 0) {
    return <div className='text-xs text-muted-foreground'>No organizations available</div>
  }

  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId
  )
  const selectedBrand = availableBrands.find((brand) => brand.id === brandId)
  const canSwitchOrganizations = organizations.length > 1
  const canSwitchBrands = availableBrands.length > 1

  return (
    <nav
      aria-label='Workspace scope'
      className='flex min-h-12 flex-wrap items-center justify-end gap-2 border-b bg-background px-4 py-2'
    >
      {canSwitchOrganizations ? (
        <Select value={organizationId} onValueChange={setOrganizationId}>
          <SelectTrigger aria-label='Select organization' size='sm' className='min-w-56'>
            <Building2 className='size-4' />
            <span className='text-xs font-medium text-muted-foreground'>Org</span>
            <SelectValue placeholder='Select organization' />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((organization) => (
              <SelectItem key={organization.id} value={organization.id}>
                {organization.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <ScopePill
          icon={Building2}
          label='Org'
          value={selectedOrganization?.name}
        />
      )}

      {canSwitchBrands ? (
        <Select
          value={brandId}
          onValueChange={setBrandId}
          disabled={!organizationId || availableBrands.length === 0}
        >
          <SelectTrigger aria-label='Select brand' size='sm' className='min-w-56'>
            <Store className='size-4' />
            <span className='text-xs font-medium text-muted-foreground'>Brand</span>
            <SelectValue placeholder={organizationId ? 'Select brand' : 'Select organization first'} />
          </SelectTrigger>
          <SelectContent>
            {availableBrands.map((brand) => (
              <SelectItem key={brand.id} value={brand.id}>
                {brand.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <ScopePill icon={Store} label='Brand' value={selectedBrand?.name} />
      )}
    </nav>
  )
}
