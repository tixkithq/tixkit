'use client'

import { Building2, Store } from 'lucide-react'
import { useBootstrap } from '@/context/bootstrap-provider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

  return (
    <div className='flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2'>
      <Select value={organizationId} onValueChange={setOrganizationId}>
        <SelectTrigger aria-label='Select organization' size='sm' className='min-w-48'>
          <Building2 className='size-4' />
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

      <Select
        value={brandId}
        onValueChange={setBrandId}
        disabled={!organizationId || availableBrands.length === 0}
      >
        <SelectTrigger aria-label='Select brand' size='sm' className='min-w-48'>
          <Store className='size-4' />
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
    </div>
  )
}
