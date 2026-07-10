import type { ReactNode } from 'react';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout';
import { Main } from '@/components/layout/main';
import { Search } from '@/components/search';
import { ThemeSwitch } from '@/components/theme-switch';
import { ConfigDrawer } from '@/components/config-drawer';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { NavigationProgress } from '@/components/navigation-progress';
import { hasClerkKey, usesLocalDevAuth } from '@/lib/auth';

type PrincipalError = {
  code: string;
  message: string;
  status?: number;
};

function isApiUnavailable(error: PrincipalError): boolean {
  return (
    error.status === undefined &&
    (error.code === 'network_error' || error.code === 'timeout' || error.code === 'unknown')
  );
}

function ApiUnavailableState({ apiBaseUrl, message }: { apiBaseUrl: string; message: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Tixkit API unavailable</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Dashboard cannot reach the local API
          </h1>
          <p className="text-sm text-muted-foreground">
            The admin session is signed in, but the API health check failed at{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{apiBaseUrl}</code>.
          </p>
        </div>
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function AuthUnavailableState() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">Authentication unavailable</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Dashboard authentication is not configured
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure a valid Clerk publishable key before using the production admin dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const clerkEnabled = hasClerkKey();
  if (!clerkEnabled && !usesLocalDevAuth()) {
    return <AuthUnavailableState />;
  }

  if (clerkEnabled) {
    const { userId, getToken } = await auth();
    if (!userId) redirect('/sign-in');

    const token = await getToken();
    const { adminApi, getAdminApiBaseUrl } = await import('@/lib/api');
    const principalRes = await adminApi.getPrincipal(token ?? undefined);

    if (!principalRes.ok) {
      console.error('Failed to fetch Tixkit principal:', principalRes.error);
      if (isApiUnavailable(principalRes.error)) {
        return (
          <ApiUnavailableState
            apiBaseUrl={getAdminApiBaseUrl()}
            message={principalRes.error.message}
          />
        );
      }
      redirect('/sign-in?error=unauthorized');
    }

    const { isDoorOnlyPermissionSet } = await import('@/lib/permissions');
    const permissions = (principalRes.data.permissions ?? []).filter(
      (permission): permission is import('@/lib/permissions').TixkitPermission =>
        typeof permission === 'string',
    );
    if (isDoorOnlyPermissionSet(permissions)) {
      const { routes } = await import('@/lib/routes');
      redirect(routes.kiosk);
    }
  }

  return (
    <AuthenticatedLayout
      headerActions={
        <>
          <Search />
          <ThemeSwitch />
          <ConfigDrawer />
          <ProfileDropdown />
        </>
      }
    >
      <NavigationProgress />
      <Main id="content">{children}</Main>
    </AuthenticatedLayout>
  );
}
