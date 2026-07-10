import type { ReactNode } from 'react';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { PermissionProvider } from '@/context/permission-provider';
import { BootstrapProvider } from '@/context/bootstrap-provider';
import { hasClerkKey, usesLocalDevAuth } from '@/lib/auth';
import { routes } from '@/lib/routes';

export default async function KioskLayout({ children }: { children: ReactNode }) {
  const clerkEnabled = hasClerkKey();
  if (!clerkEnabled && !usesLocalDevAuth()) {
    redirect(routes.signIn);
  }

  if (clerkEnabled) {
    const { userId, getToken } = await auth();
    if (!userId) redirect(routes.signIn);

    const token = await getToken();
    const { adminApi } = await import('@/lib/api');
    const principalRes = await adminApi.getPrincipal(token ?? undefined);
    if (!principalRes.ok) {
      redirect(routes.signIn);
    }
    const permissions = principalRes.data.permissions ?? [];
    const canKiosk =
      permissions.includes('checkins.write') ||
      permissions.includes('checkins.read') ||
      permissions.includes('box_office.write') ||
      permissions.includes('orders.write');
    if (!canKiosk) {
      redirect(routes.dashboard);
    }
  }

  return (
    <PermissionProvider>
      <BootstrapProvider>
        <div className="min-h-svh bg-background text-foreground">{children}</div>
      </BootstrapProvider>
    </PermissionProvider>
  );
}
