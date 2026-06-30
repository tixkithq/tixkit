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
    <div className="flex h-8 min-w-0 max-w-56 flex-1 basis-0 items-center gap-2 rounded-md border bg-background px-2 text-sm text-foreground">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
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
      <div className={cn('text-xs text-muted-foreground', className)}>No workspaces available</div>
    );
  }

  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  );
  const selectedBrand = availableBrands.find((brand) => brand.id === brandId);
  const canSwitchOrganizations = organizations.length > 1;
  const canSwitchBrands = availableBrands.length > 1;
  const brandMatchesWorkspace =
    !!selectedBrand &&
    !!selectedOrganization &&
    selectedBrand.name.trim().toLowerCase() === selectedOrganization.name.trim().toLowerCase();
  const showBrandScope = canSwitchBrands || !brandMatchesWorkspace;

  return (
    <nav
      aria-label="Workspace scope"
      className={cn('flex min-w-0 flex-row items-center gap-2', className)}
    >
      {canSwitchOrganizations ? (
        <Select value={organizationId} onValueChange={setOrganizationId}>
          <SelectTrigger
            aria-label="Select workspace"
            size="sm"
            className="h-8 min-w-0 max-w-56 flex-1 basis-0 px-2 text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground"
          >
            <Building2 className="size-4 text-muted-foreground" />
            <span className="shrink-0 text-xs font-medium text-muted-foreground">Workspace</span>
            <SelectValue placeholder="Select workspace" />
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
        <ScopePill icon={Building2} label="Workspace" value={selectedOrganization?.name} />
      )}

      {showBrandScope && canSwitchBrands ? (
        <Select
          value={brandId}
          onValueChange={setBrandId}
          disabled={!organizationId || availableBrands.length === 0}
        >
          <SelectTrigger
            aria-label="Select brand"
            size="sm"
            className="h-8 min-w-0 max-w-56 flex-1 basis-0 px-2 text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground"
          >
            <Store className="size-4 text-muted-foreground" />
            <span className="shrink-0 text-xs font-medium text-muted-foreground">Brand</span>
            <SelectValue placeholder={organizationId ? 'Select brand' : 'Select workspace first'} />
          </SelectTrigger>
          <SelectContent>
            {availableBrands.map((brand) => (
              <SelectItem key={brand.id} value={brand.id}>
                {brand.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : showBrandScope ? (
        <ScopePill icon={Store} label="Brand" value={selectedBrand?.name} />
      ) : null}
    </nav>
  );
}
