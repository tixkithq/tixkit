'use client';

import type { ComponentType, SVGProps } from 'react';
import { Building2, Store } from 'lucide-react';
import { useBootstrap } from '@/context/bootstrap-provider';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type ScopePillProps = {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value?: string;
};

function ScopePill({ icon: Icon, label, value }: ScopePillProps) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-sidebar-foreground/70" />
      <span className="shrink-0 text-xs font-medium text-sidebar-foreground/70">{label}</span>
      <span className="truncate font-medium">{value ?? 'None'}</span>
    </div>
  );
}

type ScopeSelectorProps = {
  className?: string;
};

export function ScopeSelector({ className }: ScopeSelectorProps) {
  const {
    organizations,
    availableBrands,
    organizationId,
    brandId,
    setOrganizationId,
    setBrandId,
    loading,
    error,
  } = useBootstrap();

  if (loading) {
    return (
      <div className={cn('text-xs text-muted-foreground', className)}>Loading workspace...</div>
    );
  }

  if (error) {
    return <div className={cn('text-xs text-destructive', className)}>{error}</div>;
  }

  if (organizations.length === 0) {
    return (
      <div className={cn('text-xs text-muted-foreground', className)}>
        No organizations available
      </div>
    );
  }

  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  );
  const selectedBrand = availableBrands.find((brand) => brand.id === brandId);
  const canSwitchOrganizations = organizations.length > 1;
  const canSwitchBrands = availableBrands.length > 1;

  return (
    <nav
      aria-label="Workspace scope"
      className={cn('flex min-w-0 flex-col gap-1', className)}
    >
      {canSwitchOrganizations ? (
        <Select value={organizationId} onValueChange={setOrganizationId}>
          <SelectTrigger
            aria-label="Select organization"
            size="sm"
            className="h-7 w-full min-w-0 border-0 bg-transparent px-2 text-sidebar-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent dark:hover:bg-sidebar-accent [&_svg:not([class*='text-'])]:text-sidebar-foreground/70"
          >
            <Building2 className="size-4 text-sidebar-foreground/70" />
            <span className="text-xs font-medium text-sidebar-foreground/70">Org</span>
            <SelectValue placeholder="Select organization" />
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
        <ScopePill icon={Building2} label="Org" value={selectedOrganization?.name} />
      )}

      {canSwitchBrands ? (
        <Select
          value={brandId}
          onValueChange={setBrandId}
          disabled={!organizationId || availableBrands.length === 0}
        >
          <SelectTrigger
            aria-label="Select brand"
            size="sm"
            className="h-7 w-full min-w-0 border-0 bg-transparent px-2 text-sidebar-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent dark:hover:bg-sidebar-accent [&_svg:not([class*='text-'])]:text-sidebar-foreground/70"
          >
            <Store className="size-4 text-sidebar-foreground/70" />
            <span className="text-xs font-medium text-sidebar-foreground/70">Brand</span>
            <SelectValue
              placeholder={organizationId ? 'Select brand' : 'Select organization first'}
            />
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
        <ScopePill icon={Store} label="Brand" value={selectedBrand?.name} />
      )}
    </nav>
  );
}
