'use client';

import { getCookie } from '@/lib/cookies';
import { cn } from '@/lib/utils';
import { LayoutProvider } from '@/context/layout-provider';
import { SearchProvider } from '@/context/search-provider';
import { PermissionProvider } from '@/context/permission-provider';
import { BootstrapProvider } from '@/context/bootstrap-provider';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { SkipToMain } from '@/components/skip-to-main';

type AuthenticatedLayoutProps = {
  children?: React.ReactNode;
  headerActions?: React.ReactNode;
};

export function AuthenticatedLayout({ children, headerActions }: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false';
  return (
    <PermissionProvider>
      <BootstrapProvider>
        <SearchProvider>
          <LayoutProvider>
            <SidebarProvider defaultOpen={defaultOpen}>
              <SkipToMain />
              <AppSidebar />
              <SidebarInset
                className={cn(
                  '@container/content',
                  'has-data-[layout=fixed]:h-svh',
                  'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]',
                )}
              >
                <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                  <div className="flex min-h-16 w-full items-center gap-3 px-4 py-3">
                    <SidebarTrigger className="shrink-0 md:hidden" />
                    {headerActions ? (
                      <div className="ml-auto flex shrink-0 items-center justify-end gap-3 sm:gap-4">
                        {headerActions}
                      </div>
                    ) : null}
                  </div>
                </header>
                {children}
              </SidebarInset>
            </SidebarProvider>
          </LayoutProvider>
        </SearchProvider>
      </BootstrapProvider>
    </PermissionProvider>
  );
}
