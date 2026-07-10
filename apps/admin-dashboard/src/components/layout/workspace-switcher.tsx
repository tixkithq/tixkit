'use client';

import * as React from 'react';
import {
  Building2,
  Check,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Store,
} from 'lucide-react';
import { useBootstrap } from '@/context/bootstrap-provider';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';

/**
 * Sidebar-header switcher for the active workspace (organization) and brand.
 *
 * Replaces the previous top-header ScopeSelector and the static AppTitle. The
 * trigger shows the current brand logo plus the workspace and brand names; the
 * dropdown lists every workspace and, for the active workspace, every brand.
 */
export function WorkspaceSwitcher() {
  const { isMobile, state, toggleSidebar } = useSidebar();
  const isCollapsed = state === 'collapsed' && !isMobile;
  const ToggleIcon = isCollapsed ? ChevronRight : ChevronLeft;
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

  const selectedOrganization = organizations.find((org) => org.id === organizationId);
  const selectedBrand = availableBrands.find((brand) => brand.id === brandId);
  const iconUrl = selectedBrand?.theme?.iconUrl;
  const hasSwitcherMenu = organizations.length > 0 || availableBrands.length > 0;

  const triggerLabel = `${selectedOrganization?.name ?? 'No workspace'} / ${selectedBrand?.name ?? 'No brand'}`;

  const logo = (
    <span className="flex aspect-square size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#fbfaf7] p-1.5 text-sidebar-accent-foreground ring-1 ring-black/10">
      {iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={iconUrl} alt="" className="size-full object-contain" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/brand/tixkit-symbol.svg" alt="" className="size-5 object-contain" />
      )}
    </span>
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-2',
            isCollapsed && 'flex-col justify-center px-0',
          )}
        >
          {hasSwitcherMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Switch workspace and brand. Current: ${triggerLabel}`}
                  disabled={loading}
                  className={cn(
                    'flex min-w-0 items-center gap-3 rounded-md text-start text-sm leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                    isCollapsed ? 'flex-none justify-center px-0' : 'flex-1',
                  )}
                >
                  {logo}
                  {isCollapsed ? null : (
                    <>
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate font-bold">
                          {loading
                            ? 'Loading workspace...'
                            : (selectedOrganization?.name ?? 'No workspace')}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {loading ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                              Loading
                            </span>
                          ) : error ? (
                            'Workspace unavailable'
                          ) : (
                            (selectedBrand?.name ?? 'No brand')
                          )}
                        </span>
                      </span>
                      <ChevronsUpDown
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-64"
                side={isMobile ? 'bottom' : 'right'}
                align="start"
                sideOffset={4}
              >
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                {organizations.map((org) => (
                  <DropdownMenuItem key={org.id} onClick={() => setOrganizationId(org.id)}>
                    <Building2 aria-hidden="true" className="size-4" />
                    <span className="truncate">{org.name}</span>
                    {org.id === organizationId ? (
                      <Check aria-hidden="true" className="ml-auto size-4" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                {availableBrands.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Brands</DropdownMenuLabel>
                    {availableBrands.map((brand) => (
                      <DropdownMenuItem key={brand.id} onClick={() => setBrandId(brand.id)}>
                        <Store aria-hidden="true" className="size-4" />
                        <span className="truncate">{brand.name}</span>
                        {brand.id === brandId ? (
                          <Check aria-hidden="true" className="ml-auto size-4" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div
              className={cn(
                'flex min-w-0 items-center gap-3 rounded-md text-sm leading-tight',
                isCollapsed ? 'flex-none justify-center px-0' : 'flex-1',
              )}
              aria-label={`Current workspace: ${triggerLabel}`}
            >
              {logo}
              {isCollapsed ? null : (
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-bold">
                    {loading
                      ? 'Loading workspace...'
                      : (selectedOrganization?.name ?? 'No workspace')}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {loading ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                        Loading
                      </span>
                    ) : error ? (
                      'Workspace unavailable'
                    ) : (
                      (selectedBrand?.name ?? 'No brand')
                    )}
                  </span>
                </span>
              )}
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('size-8 shrink-0', isCollapsed && 'mx-auto')}
            onClick={toggleSidebar}
          >
            <ToggleIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
